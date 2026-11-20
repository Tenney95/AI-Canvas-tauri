//! Resolve the WSAGENT project for an already delivered plugin request.
//! Package intake, trust and installation belong to the host's plugin delivery service.

use tauri::{AppHandle, Webview};

#[tauri::command]
pub async fn wsagent_plugin_install_project(
    app: AppHandle,
    webview: Webview,
    request_id: String,
) -> Result<Option<String>, String> {
    if webview.label() != "main" {
        return Err("项目互联只允许主窗口调用".into());
    }
    crate::path_policy::ensure_local_frontend_caller(&webview)?;
    if request_id.len() != 32
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(None);
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        Ok(resolve_project(&app, &request_id).await)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        Ok(None)
    }
}

#[cfg(any(target_os = "macos", windows))]
async fn resolve_project(app: &AppHandle, request_id: &str) -> Option<String> {
    use super::{blocking, project_id, read_pairing_discovery};
    use reqwest::{header, redirect::Policy, Client, StatusCode};
    use std::time::Duration;
    use tauri::Manager;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Placement {
        request_id: String,
        project_id: Option<String>,
    }

    let base = app.path().data_dir().ok()?;
    let discovery = blocking(move || read_pairing_discovery(&base)).await.ok()?;
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let mut response = client
        .get(format!(
            "http://127.0.0.1:{}/v1/plugin-install/{request_id}",
            discovery.port
        ))
        .bearer_auth(&discovery.token)
        .header(header::ACCEPT, "application/json")
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .ok()?;
    const LIMIT: usize = 1024;
    if response.status() != StatusCode::OK
        || response
            .content_length()
            .is_some_and(|length| length > LIMIT as u64)
        || response
            .headers()
            .get(header::CONTENT_ENCODING)
            .is_some_and(|encoding| encoding != "identity")
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > LIMIT - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let placement: Placement = serde_json::from_slice(&bytes).ok()?;
    let peer = placement.project_id?;
    (placement.request_id == request_id
        && project_id(&peer).is_ok()
        && peer
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then_some(peer)
}
