//! Blender 项目目录的进程内授权核心。
//!
//! 只有创建 grant 的命令接收绝对项目路径；后续 Blender Job 只使用不透明 grant ID
//! 查表，并在真正访问前继续执行用途单一的复核。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime, State, Webview};

use super::job::BlenderJobCore;

const PROJECT_GRANT_ID_DOMAIN: &[u8] = b"ai-canvas/blender-project-grant/v1\0";
const PROJECT_GRANT_ID_PREFIX: &str = "blender-project-grant-v1-";
const MAX_PROJECT_ID_CHARS: usize = 256;
const MAX_PROJECT_ROOT_CHARS: usize = 32_768;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateProjectGrantRequest {
    project_id: String,
    project_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectGrantResponse {
    project_grant_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeProjectGrantRequest {
    project_grant_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeProjectGrantResponse {
    revoked: bool,
}

struct ProjectGrantRecord {
    project_id: String,
    canonical_root: PathBuf,
}

#[derive(Default)]
pub struct ProjectGrantState {
    grants: Mutex<HashMap<String, ProjectGrantRecord>>,
    sequence: AtomicU64,
}

fn valid_project_id(project_id: &str) -> bool {
    let count = project_id.chars().count();
    count > 0
        && count <= MAX_PROJECT_ID_CHARS
        && project_id.trim() == project_id
        && !project_id.chars().any(char::is_control)
}

fn valid_project_root_input(project_root: &str) -> bool {
    let count = project_root.chars().count();
    count > 0 && count <= MAX_PROJECT_ROOT_CHARS && !project_root.chars().any(char::is_control)
}

fn valid_grant_id(project_grant_id: &str) -> bool {
    let Some(digest) = project_grant_id.strip_prefix(PROJECT_GRANT_ID_PREFIX) else {
        return false;
    };
    digest.len() == 64 && digest.bytes().all(|value| value.is_ascii_hexdigit())
}

impl ProjectGrantState {
    fn next_grant_id(&self) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut hasher = Sha256::new();
        hasher.update(PROJECT_GRANT_ID_DOMAIN);
        hasher.update(std::process::id().to_le_bytes());
        hasher.update(timestamp.to_le_bytes());
        hasher.update(sequence.to_le_bytes());
        format!("{PROJECT_GRANT_ID_PREFIX}{:x}", hasher.finalize())
    }

    fn create(
        &self,
        jobs: &BlenderJobCore,
        project_id: String,
        canonical_root: PathBuf,
    ) -> Result<String, String> {
        let project_grant_id = self.next_grant_id();
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "Blender 项目授权状态不可用".to_string())?;

        // 固定锁顺序：ProjectGrantState -> BlenderJobCore。
        let stale_grants: Vec<_> = grants
            .iter()
            .filter(|(_, record)| record.project_id == project_id)
            .map(|(grant_id, _)| grant_id.clone())
            .collect();
        for grant_id in &stale_grants {
            jobs.revoke_project_grant(grant_id)
                .map_err(|error| error.public_message().to_string())?;
        }
        grants.retain(|_, record| record.project_id != project_id);
        grants.insert(
            project_grant_id.clone(),
            ProjectGrantRecord {
                project_id,
                canonical_root,
            },
        );
        Ok(project_grant_id)
    }

    fn revoke(&self, jobs: &BlenderJobCore, project_grant_id: &str) -> Result<bool, String> {
        if !valid_grant_id(project_grant_id) {
            return Ok(false);
        }
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "Blender 项目授权状态不可用".to_string())?;
        if !grants.contains_key(project_grant_id) {
            return Ok(false);
        }
        jobs.revoke_project_grant(project_grant_id)
            .map_err(|error| error.public_message().to_string())?;
        Ok(grants.remove(project_grant_id).is_some())
    }

    /// 后续 Job 必须同时提供项目 ID 和 grant ID，不能只把任一 ID 当作路径使用。
    pub(super) fn with_revalidated_project_root<R, T, F>(
        &self,
        app: &AppHandle<R>,
        project_id: &str,
        project_grant_id: &str,
        operation: F,
    ) -> Result<T, String>
    where
        R: Runtime,
        F: FnOnce(&Path) -> Result<T, String>,
    {
        if !valid_project_id(project_id) || !valid_grant_id(project_grant_id) {
            return Err("Blender 项目授权不存在或已失效".to_string());
        }
        let grants = self
            .grants
            .lock()
            .map_err(|_| "Blender 项目授权状态不可用".to_string())?;
        let record = grants
            .get(project_grant_id)
            .filter(|record| record.project_id == project_id)
            .ok_or_else(|| "Blender 项目授权不存在或已失效".to_string())?;
        let revalidated =
            crate::path_policy::reauthorize_existing_plain_directory(app, &record.canonical_root)?;
        if revalidated != record.canonical_root {
            return Err("Blender 项目授权不存在或已失效".to_string());
        }
        operation(&record.canonical_root)
    }
}

fn ensure_main_window(label: &str) -> Result<(), String> {
    if label != "main" {
        return Err("仅主窗口可以管理 Blender 项目授权".to_string());
    }
    Ok(())
}

fn create_project_grant(
    state: &ProjectGrantState,
    jobs: &BlenderJobCore,
    project_id: String,
    canonical_root: PathBuf,
) -> Result<CreateProjectGrantResponse, String> {
    if !valid_project_id(&project_id) {
        return Err("项目标识无效".to_string());
    }
    let project_grant_id = state.create(jobs, project_id, canonical_root)?;
    Ok(CreateProjectGrantResponse { project_grant_id })
}

#[tauri::command]
pub fn create_blender_project_grant(
    webview: Webview,
    state: State<'_, ProjectGrantState>,
    jobs: State<'_, BlenderJobCore>,
    request: CreateProjectGrantRequest,
) -> Result<CreateProjectGrantResponse, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_window(webview.label())?;
    if !valid_project_id(&request.project_id) || !valid_project_root_input(&request.project_root) {
        return Err("Blender 项目授权请求无效".to_string());
    }

    let canonical_root = crate::path_policy::authorize_existing_plain_directory(
        webview.app_handle(),
        &request.project_root,
    )?;
    create_project_grant(&state, &jobs, request.project_id, canonical_root)
}

#[tauri::command]
pub fn revoke_blender_project_grant(
    webview: Webview,
    state: State<'_, ProjectGrantState>,
    jobs: State<'_, BlenderJobCore>,
    request: RevokeProjectGrantRequest,
) -> Result<RevokeProjectGrantResponse, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_window(webview.label())?;
    let revoked = state.revoke(&jobs, &request.project_grant_id)?;
    Ok(RevokeProjectGrantResponse { revoked })
}
