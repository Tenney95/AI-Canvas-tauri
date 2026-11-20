use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Webview};

use super::WsagentSharedState;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginInstallBundle {
    request_id: String,
    manifest_text: String,
    source: String,
    ui_source: String,
    project_id: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginInstallStatus {
    Installed,
    Added,
    Failed,
    Unchanged,
    Cancelled,
}

fn ensure_main_caller(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("WSAGENT 插件注入只允许主窗口调用".into());
    }
    crate::path_policy::ensure_local_frontend_caller(webview)
}

#[tauri::command]
pub async fn wsagent_plugin_install_take(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
) -> Result<Option<PluginInstallBundle>, String> {
    ensure_main_caller(&webview)?;
    #[cfg(target_os = "macos")]
    {
        macos::take(&app, &state.plugin_install).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Ok(None)
    }
}

#[tauri::command]
pub async fn wsagent_plugin_install_finish(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    request_id: String,
    status: PluginInstallStatus,
) -> Result<(), String> {
    ensure_main_caller(&webview)?;
    #[cfg(target_os = "macos")]
    {
        macos::finish(&app, &state.plugin_install, &request_id, status).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, request_id, status);
        Err("WSAGENT 插件注入目前仅支持 macOS".into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::{on_opened, PluginInstallRequests};

#[cfg(target_os = "macos")]
mod macos {
    use reqwest::{header, Client, StatusCode};
    use std::{
        collections::VecDeque,
        sync::{Mutex, MutexGuard},
        time::{Duration, Instant},
    };
    use tauri::{AppHandle, Emitter, Manager, Url};

    use super::{PluginInstallBundle, PluginInstallStatus, WsagentSharedState};
    use crate::wsagent_shared::{
        blocking, digest, project_id, read_pairing_discovery, PairingDiscovery,
    };

    const EVENT: &str = "wsagent-plugin-install-requested";
    const TTL: Duration = Duration::from_secs(45);
    const MAX_PENDING: usize = 8;
    const MAX_COMPLETED: usize = 16;
    const MAX_BUNDLE_BYTES: usize = 128 * 1024;
    const MANIFEST_SHA256: &str =
        "72a266f037ff980b53cc6100d105a4fba2c94f427b10ef7c4b89b893915554d7";
    const MAIN_SHA256: &str = "57dcceab6a129ca97257b75a20c66098455b4e6476ab4aaaba96e943fe0e3066";
    const UI_SHA256: &str = "f9ae17a7b377f08b8f78cab1c2a46a6c053b2053e5b276c75ddf25cf05ddbb9e";
    const UNAVAILABLE: &str = "无法连接 WSAGENT，请从 WSAGENT 重新注入插件";
    const INVALID_BUNDLE: &str = "WSAGENT 插件包校验失败，请更新两端应用后重试";

    struct Request {
        id: String,
        expires_at: Instant,
    }

    struct ActiveRequest {
        request: Request,
        receipt: Option<ReceiptTarget>,
    }

    struct ReceiptTarget {
        client: Client,
        discovery: PairingDiscovery,
    }

    impl ReceiptTarget {
        async fn discover(app: &AppHandle) -> Result<Self, String> {
            let base = app.path().data_dir().map_err(|_| UNAVAILABLE)?;
            let discovery = blocking(move || read_pairing_discovery(&base))
                .await
                .map_err(|_| UNAVAILABLE)?;
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| UNAVAILABLE)?;
            Ok(Self { client, discovery })
        }

        fn endpoint(&self, request_id: &str) -> String {
            format!(
                "http://127.0.0.1:{}/v1/plugin-install/{request_id}",
                self.discovery.port
            )
        }

        async fn fetch(&self, request_id: &str) -> Result<PluginInstallBundle, &'static str> {
            let mut response = self
                .client
                .get(self.endpoint(request_id))
                .bearer_auth(&self.discovery.token)
                .header(header::ACCEPT, "application/json")
                .header(header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|_| UNAVAILABLE)?;
            if response.status() != StatusCode::OK {
                return Err(UNAVAILABLE);
            }
            let headers = response.headers();
            let is_json = headers
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
            if !is_json
                || headers
                    .get(header::CONTENT_ENCODING)
                    .is_some_and(|value| value != "identity")
                || response
                    .content_length()
                    .is_some_and(|length| length > MAX_BUNDLE_BYTES as u64)
            {
                return Err(INVALID_BUNDLE);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
                if chunk.len() > MAX_BUNDLE_BYTES - bytes.len() {
                    return Err(INVALID_BUNDLE);
                }
                bytes.extend_from_slice(&chunk);
            }
            let bundle: PluginInstallBundle =
                serde_json::from_slice(&bytes).map_err(|_| INVALID_BUNDLE)?;
            if bundle.request_id != request_id
                || bundle
                    .project_id
                    .as_deref()
                    .is_some_and(|value| !valid_project_id(value))
                || digest(bundle.manifest_text.as_bytes()) != MANIFEST_SHA256
                || digest(bundle.source.as_bytes()) != MAIN_SHA256
                || digest(bundle.ui_source.as_bytes()) != UI_SHA256
            {
                return Err(INVALID_BUNDLE);
            }
            Ok(bundle)
        }

        async fn report(
            &self,
            request_id: &str,
            status: PluginInstallStatus,
        ) -> Result<(), String> {
            let response = self
                .client
                .post(format!("{}/result", self.endpoint(request_id)))
                .bearer_auth(&self.discovery.token)
                .header(header::CONTENT_TYPE, "application/json")
                .body(serde_json::json!({ "status": status }).to_string())
                .send()
                .await
                .map_err(|_| UNAVAILABLE)?;
            if !response.status().is_success() {
                return Err(UNAVAILABLE.into());
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct Requests {
        queued: VecDeque<Request>,
        active: Option<ActiveRequest>,
        completed: VecDeque<Request>,
    }

    impl Requests {
        fn prune(&mut self, now: Instant) {
            self.queued.retain(|entry| entry.expires_at > now);
            self.completed.retain(|entry| entry.expires_at > now);
            if self
                .active
                .as_ref()
                .is_some_and(|entry| entry.request.expires_at <= now)
            {
                self.active = None;
            }
        }

        fn enqueue(&mut self, id: &str, now: Instant) -> bool {
            self.prune(now);
            if self.queued.len() >= MAX_PENDING
                || self.queued.iter().any(|entry| entry.id == id)
                || self.completed.iter().any(|entry| entry.id == id)
                || self
                    .active
                    .as_ref()
                    .is_some_and(|entry| entry.request.id == id)
            {
                return false;
            }
            self.queued.push_back(Request {
                id: id.into(),
                expires_at: now + TTL,
            });
            true
        }

        fn claim(&mut self, now: Instant) -> Option<String> {
            self.prune(now);
            if self.active.is_some() {
                return None;
            }
            let request = self.queued.pop_front()?;
            let id = request.id.clone();
            self.active = Some(ActiveRequest {
                request,
                receipt: None,
            });
            Some(id)
        }

        fn complete(&mut self, id: &str, now: Instant) -> Option<ReceiptTarget> {
            self.prune(now);
            if !self
                .active
                .as_ref()
                .is_some_and(|active| active.request.id == id && active.receipt.is_some())
            {
                return None;
            }
            let active = self.active.take()?;
            if self.completed.len() >= MAX_COMPLETED {
                self.completed.pop_front();
            }
            self.completed.push_back(active.request);
            active.receipt
        }
    }

    #[derive(Default)]
    pub(crate) struct PluginInstallRequests(Mutex<Requests>);

    impl PluginInstallRequests {
        fn lock(&self) -> Result<MutexGuard<'_, Requests>, String> {
            self.0.lock().map_err(|_| UNAVAILABLE.into())
        }
    }

    fn request_id_from_filename(filename: &str) -> Option<&str> {
        let id = filename
            .strip_prefix("wsagent-plugin-")?
            .strip_suffix(".aicwsagent")?;
        (id.len() == 32
            && id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .then_some(id)
    }

    fn valid_project_id(id: &str) -> bool {
        project_id(id).is_ok()
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }

    fn notify(app: &AppHandle) {
        let _ = app.emit_to("main", EVENT, ());
    }

    pub(crate) fn on_opened(app: &AppHandle, urls: &[Url]) {
        let state = app.state::<WsagentSharedState>();
        let Ok(mut pending) = state.plugin_install.lock() else {
            return;
        };
        let mut queued = false;
        let now = Instant::now();
        for url in urls {
            // LaunchServices supplies the nonce in the filename. Never read the marker.
            if let Ok(path) = url.to_file_path() {
                if let Some(id) = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(request_id_from_filename)
                {
                    queued |= pending.enqueue(id, now);
                }
            }
        }
        drop(pending);
        if queued {
            notify(app);
        }
    }

    pub(super) async fn take(
        app: &AppHandle,
        requests: &PluginInstallRequests,
    ) -> Result<Option<PluginInstallBundle>, String> {
        let claimed = requests.lock()?.claim(Instant::now());
        let Some(id) = claimed else {
            return Ok(None);
        };
        let result = async {
            let target = ReceiptTarget::discover(app).await?;
            match target.fetch(&id).await {
                Ok(bundle) => Ok((target, bundle)),
                Err(error) => {
                    let _ = target.report(&id, PluginInstallStatus::Failed).await;
                    Err(error.to_string())
                }
            }
        }
        .await;
        let mut pending = requests.lock()?;
        pending.prune(Instant::now());
        let Some(active) = pending
            .active
            .as_mut()
            .filter(|active| active.request.id == id)
        else {
            return Err(UNAVAILABLE.into());
        };
        match result {
            Ok((target, bundle)) => {
                active.receipt = Some(target);
                Ok(Some(bundle))
            }
            Err(error) => {
                pending.active = None;
                let queued = !pending.queued.is_empty();
                drop(pending);
                if queued {
                    notify(app);
                }
                Err(error)
            }
        }
    }

    pub(super) async fn finish(
        app: &AppHandle,
        requests: &PluginInstallRequests,
        request_id: &str,
        status: PluginInstallStatus,
    ) -> Result<(), String> {
        let (target, queued) = {
            let mut pending = requests.lock()?;
            let target = pending
                .complete(request_id, Instant::now())
                .ok_or("WSAGENT 插件注入请求已失效")?;
            (target, !pending.queued.is_empty())
        };
        let result = target.report(request_id, status).await;
        if queued {
            notify(app);
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const ID: &str = "0123456789abcdef0123456789abcdef";
        const OTHER_ID: &str = "abcdeabcdeabcdeabcdeabcdeabcdef1";

        #[test]
        fn accepts_only_the_exact_marker_filename() {
            assert_eq!(
                request_id_from_filename(&format!("wsagent-plugin-{ID}.aicwsagent")),
                Some(ID)
            );
            for name in [
                format!("prefix-wsagent-plugin-{ID}.aicwsagent"),
                format!("wsagent-plugin-{}.aicwsagent", ID.to_uppercase()),
                format!("wsagent-plugin-{ID}.aicwsagent.zip"),
                "wsagent-plugin-123.aicwsagent".into(),
            ] {
                assert_eq!(request_id_from_filename(&name), None);
            }
        }

        #[test]
        fn queues_only_once_and_expires_active_and_queued_requests() {
            let now = Instant::now();
            let mut requests = Requests::default();
            assert!(requests.enqueue(ID, now));
            assert!(!requests.enqueue(ID, now));
            assert_eq!(requests.claim(now).as_deref(), Some(ID));
            assert!(!requests.enqueue(ID, now));
            assert!(requests.enqueue(OTHER_ID, now));
            assert_eq!(requests.claim(now), None);
            assert_eq!(requests.claim(now + TTL), None);
            assert!(requests.enqueue(ID, now + TTL));
        }

        #[test]
        fn a_ready_request_can_complete_only_once() {
            let now = Instant::now();
            let mut requests = Requests::default();
            assert!(requests.enqueue(ID, now));
            assert_eq!(requests.claim(now).as_deref(), Some(ID));
            assert!(requests.complete(ID, now).is_none());
            requests.active.as_mut().unwrap().receipt = Some(ReceiptTarget {
                client: Client::new(),
                discovery: PairingDiscovery {
                    version: 1,
                    port: 4000,
                    token: String::new(),
                },
            });
            assert!(requests.complete(OTHER_ID, now).is_none());
            assert!(requests.complete(ID, now).is_some());
            assert!(requests.complete(ID, now).is_none());
            assert!(!requests.enqueue(ID, now));
        }
    }
}
