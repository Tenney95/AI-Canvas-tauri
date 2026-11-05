//! Project-scoped S3 connection, capability and explicit manual sync boundary.

mod catalog;
mod client;
mod protocol;
mod journal;
mod transfer;
mod sync;

pub use sync::*;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State, Webview};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ErrorStage {
    HeadRead, RevisionRead, BlobCheck, StagingVerify,
    MultipartCreate, PartUpload, MultipartComplete, BlobVerify, RevisionWrite,
    MultipartAbort,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageError {
    pub(super) code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<ErrorStage>,
}

impl StorageError {
    pub(super) fn new(code: &'static str) -> Self { Self { code, stage: None } }
    pub(super) fn at_stage(mut self, stage: ErrorStage) -> Self {
        if self.stage.is_none() {
            eprintln!("[project-asset-sync] failure stage={stage:?} code={}", self.code);
            self.stage = Some(stage);
        }
        self
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConnectionInput {
    id: String,
    name: String,
    endpoint: String,
    region: String,
    bucket: String,
    root_prefix: String,
    path_style: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    #[serde(flatten)]
    input: ConnectionInput,
    revision: String,
    credentials_saved: bool,
    session_token_saved: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialUpdate {
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    session_token: Option<String>,
    #[serde(default)]
    clear_session_token: bool,
    #[serde(default)]
    clear_credentials: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveConnectionInput {
    connection: ConnectionInput,
    expected_revision: Option<String>,
    credentials: Option<CredentialUpdate>,
}

// Credentials and their binding never cross the native response boundary.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Credentials {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialEnvelope {
    connection_revision: String,
    config_hash: String,
    credentials: Credentials,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum CheckKind { List, ReadWrite, Multipart, ConditionalCreate, ConditionalUpdate }

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum CheckStatus { Passed, Failed, NotChecked }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CapabilityCheck {
    kind: CheckKind,
    status: CheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CapabilityReport {
    checks: Vec<CapabilityCheck>,
    checked_at: u64,
    cleanup_pending: bool,
    multiplayer_writable: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProjectBinding {
    owner_id: String,
    owner_name: String,
    connection_id: String,
    connection_revision: String,
    library_id: String,
    shared_project_id: String,
    project_prefix: String,
    capabilities: CapabilityReport,
    updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    connections: Vec<Connection>,
    bindings: Vec<ProjectBinding>,
    revision: u64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BindingMode { Create, Join }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindProjectInput {
    task_id: String,
    owner_id: String,
    owner_name: String,
    connection_id: String,
    connection_revision: String,
    mode: BindingMode,
    library_id: String,
    shared_project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeProjectInput { task_id: String, owner_id: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult { snapshot: Snapshot, report: CapabilityReport, bound: bool }

pub(super) struct RemoteProjectScope {
    library_id: String,
    shared_project_id: String,
    project_prefix: String,
}

#[derive(Default)]
struct Tasks {
    running: HashMap<String, RunningTask>,
    cancelled: HashSet<String>,
}

struct RunningTask { connection_id: String, owner_id: String, cancel: CancellationToken }

#[derive(Default)]
pub struct ObjectStorageState {
    tasks: Arc<Mutex<Tasks>>,
    // Held across the main-window IDB commit; OS locks disappear on process exit.
    apply_locks: Arc<Mutex<HashMap<String, std::fs::File>>>,
    cleanup_previews: Arc<Mutex<HashMap<String, CleanupPreviewSession>>>,
    asset_delete_previews: Arc<Mutex<HashMap<String, AssetDeletePreviewSession>>>,
}

#[derive(Clone)]
struct CleanupPreviewSession {
    context: protocol::Context,
    owner_revision: u64,
    mode: String,
    token_digest: String,
    expires_at: u64,
    objects: Vec<object_store::ObjectMeta>,
}

#[derive(Clone)]
struct AssetDeletePreviewSession {
    context: protocol::Context,
    owner_revision: u64,
    operation_id: String,
    head: protocol::Head,
    etag: String,
    token_digest: String,
    expires_at: u64,
}

struct TaskGuard { id: String, tasks: Arc<Mutex<Tasks>>, cancel: CancellationToken }

impl Drop for TaskGuard {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.tasks.lock() { tasks.running.remove(&self.id); }
        transfer::clear_progress(&self.id);
    }
}

impl ObjectStorageState {
    fn start(&self, id: &str, connection_id: &str, owner_id: &str) -> Result<TaskGuard, StorageError> {
        validate_id(id)?;
        let mut tasks = self.tasks.lock().map_err(|_| StorageError::new("unavailable"))?;
        if tasks.cancelled.contains(id) { return Err(StorageError::new("cancelled")); }
        if tasks.running.contains_key(id) || tasks.running.len() >= 8 { return Err(StorageError::new("busy")); }
        for task in tasks.running.values() {
            if task.owner_id == owner_id { task.cancel.cancel(); }
        }
        let cancel = CancellationToken::new();
        tasks.running.insert(id.to_string(), RunningTask {
            connection_id: connection_id.to_string(), owner_id: owner_id.to_string(), cancel: cancel.clone(),
        });
        Ok(TaskGuard { id: id.to_string(), tasks: Arc::clone(&self.tasks), cancel })
    }

    fn cancel_connection(&self, id: &str) {
        if let Ok(tasks) = self.tasks.lock() {
            for task in tasks.running.values().filter(|task| task.connection_id == id) { task.cancel.cancel(); }
        }
    }

    fn cancel_owner(&self, id: &str) {
        if let Ok(tasks) = self.tasks.lock() {
            for task in tasks.running.values().filter(|task| task.owner_id == id) { task.cancel.cancel(); }
        }
    }

    fn cancel(&self, id: String) -> Result<(), StorageError> {
        let mut tasks = self.tasks.lock().map_err(|_| StorageError::new("unavailable"))?;
        if let Some(task) = tasks.running.get(&id) { task.cancel.cancel(); }
        else {
            // Never forget an already accepted early cancellation to admit a later task.
            if tasks.cancelled.len() >= 256 { return Err(StorageError::new("busy")); }
            tasks.cancelled.insert(id);
        }
        Ok(())
    }
}

fn ensure_main(webview: &Webview) -> Result<(), StorageError> {
    crate::path_policy::ensure_trusted_caller(webview).map_err(|_| StorageError::new("permission_denied"))?;
    if webview.label() != "main" { return Err(StorageError::new("permission_denied")); }
    Ok(())
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(9_007_199_254_740_991) as u64
}

fn validate_id(id: &str) -> Result<(), StorageError> {
    if id.is_empty() || id.len() > 128 || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')) {
        return Err(StorageError::new("invalid_input"));
    }
    Ok(())
}

fn validate_text(value: &str, max: usize) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(StorageError::new("invalid_input"));
    }
    Ok(())
}

fn normalize_owner_name(value: &str) -> Result<String, StorageError> {
    let name: String = value.trim().chars().take(200).collect();
    validate_text(&name, 800)?;
    Ok(name)
}

fn normalize_connection(mut value: ConnectionInput) -> Result<ConnectionInput, StorageError> {
    validate_id(&value.id)?;
    if value.id.len() > 100 { return Err(StorageError::new("invalid_input")); }
    value.name = value.name.trim().to_string();
    if value.name.chars().count() > 160 { return Err(StorageError::new("invalid_input")); }
    validate_text(&value.name, 640)?;
    let url = url::Url::parse(&value.endpoint).map_err(|_| StorageError::new("invalid_input"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(StorageError::new("invalid_input"));
    }
    value.endpoint = url.origin().ascii_serialization();
    validate_text(&value.region, 64)?;
    if !value.region.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')) { return Err(StorageError::new("invalid_input")); }
    if value.bucket.len() < 3 || value.bucket.len() > 63
        || !value.bucket.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'.'))
        || value.bucket.starts_with('-') || value.bucket.starts_with('.') || value.bucket.ends_with('-') || value.bucket.ends_with('.')
        || value.bucket.contains("..") {
        return Err(StorageError::new("invalid_input"));
    }
    if value.root_prefix.len() > 500 || value.root_prefix.starts_with('/') || value.root_prefix.ends_with('/')
        || value.root_prefix.chars().any(|c| matches!(c, '\\' | '%' | '?' | '#') || c.is_control())
        || value.root_prefix.split('/').any(|part| part == "." || part == ".." || (part.is_empty() && !value.root_prefix.is_empty())) {
        return Err(StorageError::new("invalid_input"));
    }
    Ok(value)
}

fn config_hash(input: &ConnectionInput) -> String {
    let value = serde_json::json!([input.id, input.endpoint, input.region, input.bucket, input.root_prefix, input.path_style]);
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn secret_key(id: &str) -> String { format!("object-storage/{id}") }

fn raw_credentials(app: &AppHandle, id: &str) -> Result<Option<CredentialEnvelope>, StorageError> {
    let value = crate::secret_store::read_internal_secret_sync(app, &secret_key(id))
        .map_err(|_| StorageError::new("unavailable"))?;
    value.map(|value| serde_json::from_str(&value).map_err(|_| StorageError::new("unavailable"))).transpose()
}

fn current_credentials(app: &AppHandle, connection: &catalog::StoredConnection) -> Result<Option<Credentials>, StorageError> {
    Ok(raw_credentials(app, &connection.connection.id)?.filter(|value| {
        value.connection_revision == connection.revision && value.config_hash == config_hash(&connection.connection)
    }).map(|value| value.credentials))
}

fn snapshot_from(app: &AppHandle, catalog: &catalog::Catalog) -> Result<Snapshot, StorageError> {
    let mut connections = Vec::with_capacity(catalog.connections.len());
    for connection in &catalog.connections {
        let credentials = current_credentials(app, connection)?;
        connections.push(Connection {
            input: connection.connection.clone(), revision: connection.revision.clone(),
            credentials_saved: credentials.is_some(), session_token_saved: credentials.and_then(|value| value.session_token).is_some(),
        });
    }
    Ok(Snapshot { connections, bindings: catalog.bindings.clone(), revision: catalog.revision })
}

fn merge_credentials(previous: Option<Credentials>, update: CredentialUpdate) -> Result<Option<Credentials>, StorageError> {
    if update.clear_credentials {
        if update.access_key_id.is_some() || update.secret_access_key.is_some() || update.session_token.is_some() || update.clear_session_token {
            return Err(StorageError::new("invalid_input"));
        }
        return Ok(None);
    }
    if update.access_key_id.is_some() != update.secret_access_key.is_some() || (update.session_token.is_some() && update.clear_session_token) {
        return Err(StorageError::new("invalid_input"));
    }
    let mut next = match (update.access_key_id, update.secret_access_key) {
        (Some(access_key_id), Some(secret_access_key)) => {
            validate_text(&access_key_id, 1024)?;
            validate_text(&secret_access_key, 2048)?;
            Some(Credentials { access_key_id, secret_access_key, session_token: previous.as_ref().and_then(|value| value.session_token.clone()) })
        }
        _ => previous,
    };
    if update.session_token.is_some() || update.clear_session_token {
        let credentials = next.as_mut().ok_or_else(|| StorageError::new("credentials_missing"))?;
        if let Some(token) = &update.session_token { validate_text(token, 4096)?; }
        credentials.session_token = if update.clear_session_token { None } else { update.session_token };
    }
    Ok(next)
}

fn scope_for(connection: &ConnectionInput, library_id: &str, project_id: &str) -> Result<RemoteProjectScope, StorageError> {
    validate_id(library_id)?;
    validate_id(project_id)?;
    let suffix = format!("libraries/{library_id}/projects/{project_id}");
    Ok(RemoteProjectScope {
        library_id: library_id.to_string(), shared_project_id: project_id.to_string(),
        project_prefix: if connection.root_prefix.is_empty() { suffix } else { format!("{}/{suffix}", connection.root_prefix) },
    })
}

fn assert_current(cancel: &CancellationToken) -> Result<(), StorageError> {
    if cancel.is_cancelled() { Err(StorageError::new("cancelled")) } else { Ok(()) }
}

#[tauri::command]
pub async fn project_asset_storage_snapshot(app: AppHandle, webview: Webview) -> Result<Snapshot, StorageError> {
    ensure_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || catalog::access(&app, |catalog| Ok((snapshot_from(&app, catalog)?, false))))
        .await.map_err(|_| StorageError::new("unavailable"))?
}

#[tauri::command]
pub async fn project_asset_storage_save_connection(
    app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: SaveConnectionInput,
) -> Result<Snapshot, StorageError> {
    ensure_main(&webview)?;
    let connection = normalize_connection(input.connection)?;
    let id = connection.id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || catalog::access(&app, |catalog| {
        for binding in catalog.bindings.iter().filter(|binding| binding.connection_id == connection.id) {
            journal::ensure_not_applying(&app, &binding.owner_id)?;
        }
        let old = catalog.connections.iter().find(|value| value.connection.id == connection.id);
        if old.map(|value| value.revision.as_str()) != input.expected_revision.as_deref() { return Err(StorageError::new("conflict")); }
        if old.is_none() && catalog.connections.len() >= 64 { return Err(StorageError::new("busy")); }
        let previous = old.map(|old| current_credentials(&app, old)).transpose()?.flatten();
        // A different target never inherits the old endpoint's credential pair or token.
        let same_target = old.is_some_and(|old| config_hash(&old.connection) == config_hash(&connection));
        let next = merge_credentials(if same_target { previous } else { None }, input.credentials.unwrap_or_default())?;
        let revision = catalog.next_revision()?.to_string();
        if let Some(credentials) = next {
            let envelope = CredentialEnvelope { connection_revision: revision.clone(), config_hash: config_hash(&connection), credentials };
            let value = serde_json::to_string(&envelope).map_err(|_| StorageError::new("invalid_input"))?;
            crate::secret_store::set_internal_secret_sync(&app, &secret_key(&connection.id), &value)
                .map_err(|_| StorageError::new("unavailable"))?;
        } else {
            crate::secret_store::delete_internal_secret_sync(&app, &secret_key(&connection.id))
                .map_err(|_| StorageError::new("unavailable"))?;
        }
        let record = catalog::StoredConnection { connection, revision };
        catalog.connections.retain(|value| value.connection.id != record.connection.id);
        catalog.connections.push(record);
        catalog.revision = catalog.next_revision()?;
        Ok((snapshot_from(&app, catalog)?, true))
    })).await.map_err(|_| StorageError::new("unavailable"))?;
    state.cancel_connection(&id);
    result
}

#[tauri::command]
pub async fn project_asset_storage_remove_connection(
    app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, connection_id: String, expected_revision: String,
) -> Result<Snapshot, StorageError> {
    ensure_main(&webview)?;
    validate_id(&connection_id)?;
    let id = connection_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || catalog::access(&app, |catalog| {
        let connection = catalog.connection(&connection_id)?;
        if connection.revision != expected_revision { return Err(StorageError::new("conflict")); }
        if catalog.bindings.iter().any(|binding| binding.connection_id == connection_id) { return Err(StorageError::new("connection_in_use")); }
        crate::secret_store::delete_internal_secret_sync(&app, &secret_key(&connection_id)).map_err(|_| StorageError::new("unavailable"))?;
        catalog.connections.retain(|value| value.connection.id != connection_id);
        catalog.revision = catalog.next_revision()?;
        Ok((snapshot_from(&app, catalog)?, true))
    })).await.map_err(|_| StorageError::new("unavailable"))?;
    state.cancel_connection(&id);
    result
}

#[tauri::command]
pub async fn project_asset_storage_bind_project(
    app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: BindProjectInput,
) -> Result<OperationResult, StorageError> {
    ensure_main(&webview)?;
    validate_id(&input.owner_id)?;
    let owner_name = normalize_owner_name(&input.owner_name)?;
    let task = state.start(&input.task_id, &input.connection_id, &input.owner_id)?;
    let read_app = app.clone();
    let connection_id = input.connection_id.clone();
    let owner_id = input.owner_id.clone();
    let connection_revision = input.connection_revision.clone();
    let (connection, credentials, owner_revision) = tauri::async_runtime::spawn_blocking(move || catalog::access(&read_app, |catalog| {
        let connection = catalog.connection(&connection_id)?.clone();
        if connection.revision != connection_revision { return Err(StorageError::new("conflict")); }
        let credentials = current_credentials(&read_app, &connection)?.ok_or_else(|| StorageError::new("credentials_missing"))?;
        Ok(((connection, credentials, catalog.owner_revision(&owner_id)), false))
    })).await.map_err(|_| StorageError::new("unavailable"))??;
    assert_current(&task.cancel)?;
    let scope = scope_for(&connection.connection, &input.library_id, &input.shared_project_id)?;
    let report = client::prepare_project(&connection.connection, &scope, input.mode, credentials, task.cancel.clone()).await?;
    assert_current(&task.cancel)?;
    let cancel = task.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || catalog::access(&app, |catalog| {
        assert_current(&cancel)?;
        journal::ensure_not_applying(&app, &input.owner_id)?;
        if catalog.connection(&input.connection_id)?.revision != input.connection_revision || catalog.owner_revision(&input.owner_id) != owner_revision {
            return Err(StorageError::new("conflict"));
        }
        let bound = report.multiplayer_writable;
        if bound {
            catalog.bindings.retain(|binding| binding.owner_id != input.owner_id);
            catalog.bump_owner(&input.owner_id)?;
            catalog.bindings.push(ProjectBinding {
                owner_id: input.owner_id, owner_name, connection_id: input.connection_id,
                connection_revision: input.connection_revision, library_id: input.library_id,
                shared_project_id: input.shared_project_id, project_prefix: scope.project_prefix,
                capabilities: report.clone(), updated_at: now_ms(),
            });
            catalog.revision = catalog.next_revision()?;
        }
        let snapshot = snapshot_from(&app, catalog)?;
        assert_current(&cancel)?;
        Ok((OperationResult { snapshot, report, bound }, bound))
    })).await.map_err(|_| StorageError::new("unavailable"))?
}

#[tauri::command]
pub async fn project_asset_storage_probe_project(
    app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: ProbeProjectInput,
) -> Result<OperationResult, StorageError> {
    ensure_main(&webview)?;
    validate_id(&input.owner_id)?;
    let task = state.start(&input.task_id, "", &input.owner_id)?;
    let read_app = app.clone();
    let owner_id = input.owner_id.clone();
    let (binding, connection, credentials, owner_revision) = tauri::async_runtime::spawn_blocking(move || catalog::access(&read_app, |catalog| {
        let binding = catalog.bindings.iter().find(|binding| binding.owner_id == owner_id).cloned().ok_or_else(|| StorageError::new("binding_not_found"))?;
        let connection = catalog.connection(&binding.connection_id)?.clone();
        if binding.connection_revision != connection.revision { return Err(StorageError::new("conflict")); }
        let credentials = current_credentials(&read_app, &connection)?.ok_or_else(|| StorageError::new("credentials_missing"))?;
        Ok(((binding, connection, credentials, catalog.owner_revision(&owner_id)), false))
    })).await.map_err(|_| StorageError::new("unavailable"))??;
    {
        let mut tasks = task.tasks.lock().map_err(|_| StorageError::new("unavailable"))?;
        if let Some(running) = tasks.running.get_mut(&task.id) { running.connection_id = connection.connection.id.clone(); }
    }
    assert_current(&task.cancel)?;
    let verify_app = app.clone();
    let verify_connection = connection.clone();
    let verify_owner = input.owner_id.clone();
    tauri::async_runtime::spawn_blocking(move || catalog::access(&verify_app, |catalog| {
        if catalog.connection(&verify_connection.connection.id)?.revision != verify_connection.revision
            || catalog.owner_revision(&verify_owner) != owner_revision { return Err(StorageError::new("conflict")); }
        Ok(((), false))
    })).await.map_err(|_| StorageError::new("unavailable"))??;
    assert_current(&task.cancel)?;
    let scope = scope_for(&connection.connection, &binding.library_id, &binding.shared_project_id)?;
    let report = client::probe_project(&connection.connection, &scope, credentials, task.cancel.clone()).await?;
    assert_current(&task.cancel)?;
    let cancel = task.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || catalog::access(&app, |catalog| {
        assert_current(&cancel)?;
        journal::ensure_not_applying(&app, &binding.owner_id)?;
        if catalog.connection(&binding.connection_id)?.revision != binding.connection_revision || catalog.owner_revision(&binding.owner_id) != owner_revision {
            return Err(StorageError::new("conflict"));
        }
        let current = catalog.bindings.iter_mut().find(|value| value.owner_id == binding.owner_id).ok_or_else(|| StorageError::new("binding_not_found"))?;
        current.capabilities = report.clone();
        current.updated_at = now_ms();
        catalog.bump_owner(&binding.owner_id)?;
        catalog.revision = catalog.next_revision()?;
        let snapshot = snapshot_from(&app, catalog)?;
        assert_current(&cancel)?;
        Ok((OperationResult { snapshot, report, bound: true }, true))
    })).await.map_err(|_| StorageError::new("unavailable"))?
}

#[tauri::command]
pub async fn project_asset_storage_unbind_project(
    app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, owner_id: String,
    connection_revision: String, library_id: String, shared_project_id: String,
) -> Result<Snapshot, StorageError> {
    ensure_main(&webview)?;
    validate_id(&owner_id)?;
    let id = owner_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || catalog::access(&app, |catalog| {
        journal::ensure_not_applying(&app, &owner_id)?;
        let binding = catalog.bindings.iter().find(|binding| binding.owner_id == owner_id).ok_or_else(|| StorageError::new("binding_not_found"))?;
        if binding.connection_revision != connection_revision || binding.library_id != library_id || binding.shared_project_id != shared_project_id {
            return Err(StorageError::new("conflict"));
        }
        catalog.bindings.retain(|binding| binding.owner_id != owner_id);
        catalog.bump_owner(&owner_id)?;
        catalog.revision = catalog.next_revision()?;
        Ok((snapshot_from(&app, catalog)?, true))
    })).await.map_err(|_| StorageError::new("unavailable"))?;
    state.cancel_owner(&id);
    result
}

#[tauri::command]
pub fn project_asset_storage_cancel(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, task_id: String) -> Result<(), StorageError> {
    ensure_main(&webview)?;
    validate_id(&task_id)?;
    state.cancel(task_id.clone())?;
    sync::revoke_task_apply(&app, &state, &task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_error_keeps_the_first_stage_and_exposes_only_fixed_diagnostics() {
        let plain = serde_json::to_value(StorageError::new("unknown")).unwrap();
        assert_eq!(plain, serde_json::json!({ "code": "unknown" }));
        let error = StorageError::new("network").at_stage(ErrorStage::PartUpload).at_stage(ErrorStage::MultipartAbort);
        assert_eq!(serde_json::to_value(error).unwrap(), serde_json::json!({ "code": "network", "stage": "partUpload" }));
        for (stage, wire) in [
            (ErrorStage::BlobCheck, "blobCheck"), (ErrorStage::StagingVerify, "stagingVerify"),
            (ErrorStage::MultipartCreate, "multipartCreate"), (ErrorStage::PartUpload, "partUpload"),
            (ErrorStage::MultipartComplete, "multipartComplete"), (ErrorStage::BlobVerify, "blobVerify"),
            (ErrorStage::RevisionWrite, "revisionWrite"), (ErrorStage::HeadRead, "headRead"),
            (ErrorStage::RevisionRead, "revisionRead"), (ErrorStage::MultipartAbort, "multipartAbort"),
        ] {
            assert_eq!(serde_json::to_value(StorageError::new("unknown").at_stage(stage)).unwrap(), serde_json::json!({ "code": "unknown", "stage": wire }));
        }
    }

    fn credentials() -> Credentials {
        Credentials { access_key_id: "key".into(), secret_access_key: "secret".into(), session_token: Some("token".into()) }
    }

    #[test]
    fn token_changes_do_not_require_resending_the_key_pair() {
        let updated = merge_credentials(Some(credentials()), CredentialUpdate { session_token: Some("new".into()), ..Default::default() }).unwrap().unwrap();
        assert_eq!(updated.access_key_id, "key");
        assert_eq!(updated.session_token.as_deref(), Some("new"));
        let cleared = merge_credentials(Some(updated), CredentialUpdate { clear_session_token: true, ..Default::default() }).unwrap().unwrap();
        assert!(cleared.session_token.is_none());
        assert!(merge_credentials(None, CredentialUpdate { access_key_id: Some("key".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn connection_endpoints_accept_http_and_https_without_relaxing_url_boundaries() {
        let connection = ConnectionInput { id: "c".into(), name: "S3".into(), endpoint: "https://example.com".into(),
            region: "us-east-1".into(), bucket: "example".into(), root_prefix: "team".into(), path_style: true };
        for endpoint in ["http://localhost:9000/", "http://192.168.1.20:9000/", "http://storage.example.com:9000/", "https://example.com/"] {
            let normalized = normalize_connection(ConnectionInput { endpoint: endpoint.into(), ..connection.clone() }).unwrap();
            assert_eq!(normalized.endpoint, endpoint.trim_end_matches('/'));
        }
        let http = normalize_connection(ConnectionInput { endpoint: "http://example.com".into(), ..connection.clone() }).unwrap();
        assert_ne!(config_hash(&connection), config_hash(&http));
        for endpoint in ["ftp://example.com", "file:///tmp", "http://user:pass@example.com", "http://example.com/api", "http://example.com?token=hidden", "http://example.com#fragment"] {
            assert!(normalize_connection(ConnectionInput { endpoint: endpoint.into(), ..connection.clone() }).is_err());
        }
    }

    #[test]
    fn project_keys_are_scoped_and_credential_target_hash_excludes_the_display_name() {
        let connection = normalize_connection(ConnectionInput { id: "c".into(), name: "汉".repeat(70), endpoint: "https://example.com/".into(), region: "us-east-1".into(), bucket: "example".into(), root_prefix: "team".into(), path_style: true }).unwrap();
        let mut renamed = connection.clone(); renamed.name = "B".into();
        assert_eq!(config_hash(&connection), config_hash(&renamed));
        renamed.endpoint = "https://other.example".into();
        assert_ne!(config_hash(&connection), config_hash(&renamed));
        assert_eq!(scope_for(&connection, "lib", "project").unwrap().project_prefix, "team/libraries/lib/projects/project");
        assert!(scope_for(&connection, "lib", "../other").is_err());
    }

    #[test]
    fn early_cancellation_is_not_forgotten_when_the_bounded_cache_is_full() {
        let state = ObjectStorageState::default();
        for index in 0..256 { state.cancel(format!("task-{index}")).unwrap(); }
        assert!(matches!(state.cancel("overflow".into()), Err(error) if error.code == "busy"));
        assert!(matches!(state.start("task-0", "connection", "owner"), Err(error) if error.code == "cancelled"));
        assert!(matches!(state.start("task-0", "connection", "owner"), Err(error) if error.code == "cancelled"));
    }

    #[test]
    fn owner_display_name_preserves_long_project_names_without_changing_the_identity() {
        let name = "项".repeat(70);
        assert!(name.len() > 200);
        assert_eq!(normalize_owner_name(&format!("  {name}  ")).unwrap(), name);
        let long_name = "🎬".repeat(250);
        let normalized = normalize_owner_name(&long_name).unwrap();
        assert_eq!(normalized.chars().count(), 200);
        assert_eq!(normalized.len(), 800);
        assert!(normalize_owner_name(" \n ").is_err());
        assert!(normalize_owner_name("项目\n名称").is_err());
    }
}
