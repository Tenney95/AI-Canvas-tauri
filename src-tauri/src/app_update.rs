//! 更新资源仅来自 updater 的原生资源表；下载可切源，验签及安装仍由原更新器完成。
use std::{sync::Mutex, time::{Duration, Instant}};
use tauri::{ipc::Channel, Manager, Webview};
use tauri_plugin_updater::Update;

static UPDATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn download(update: &Update, events: &Channel<serde_json::Value>) -> Result<Vec<u8>, crate::github_fallback::Failure> {
    use crate::github_fallback::{policy, Failure};
    let last_chunk = Mutex::new((Instant::now(), false));
    let mut started = false;
    let request = update.download(|chunk, total| {
        if let Ok(mut last) = last_chunk.lock() { *last = (Instant::now(), true); }
        if !started {
            started = true;
            let _ = events.send(serde_json::json!({ "event": "Started", "data": { "contentLength": total } }));
        }
        let _ = events.send(serde_json::json!({ "event": "Progress", "data": { "chunkLength": chunk } }));
    }, || {});
    tokio::pin!(request);
    loop {
        tokio::select! {
            result = &mut request => return result.map_err(|error| match error {
                tauri_plugin_updater::Error::Reqwest(error) => Failure {
                    retryable: error.is_timeout() || error.is_connect() || error.is_body(),
                    message: "更新包连接或读取失败".into(),
                },
                tauri_plugin_updater::Error::Network(message) => {
                    let status = message.strip_prefix("Download request failed with status: ")
                        .and_then(|value| value.split_whitespace().next()).and_then(|value| value.parse::<u16>().ok());
                    Failure { message: "更新包下载请求失败".into(), retryable: status.is_some_and(crate::github_fallback::transient_status) }
                }
                other => Failure::terminal(format!("更新下载或签名校验失败：{other}")),
            }),
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                let state = last_chunk.lock().map_err(|_| Failure::terminal("更新计时器不可用"))?;
                let timeout = if state.1 { policy().read_timeout_ms } else { policy().connect_timeout_ms };
                if state.0.elapsed() >= Duration::from_millis(timeout) {
                    return Err(Failure { message: "更新包连接或读取超时".into(), retryable: true });
                }
            }
        }
    }
}

#[tauri::command]
pub async fn download_app_update(webview: Webview, rid: tauri::ResourceId, on_event: Channel<serde_json::Value>) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" { return Err("仅主窗口可安装应用更新".into()); }
    let _lease = UPDATING.try_lock().map_err(|_| "已有更新正在下载或安装".to_string())?;
    let resource = webview.resources_table().get::<Update>(rid).map_err(|_| "更新资源已失效，请重新检查更新".to_string())?;
    let mut update = (*resource).clone();
    // check() 的超时也会进入 Update；大包按无进度时长超时，不设整包下载时长限制。
    update.timeout = None;
    let bytes = match download(&update, &on_event).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let public = update.headers.keys().all(|key| matches!(key.as_str(), "accept" | "user-agent" | "content-type"));
            let mirror = if public && error.retryable { crate::github_fallback::mirror_url(update.download_url.as_str()) } else { None };
            let Some(mirror) = mirror else { return Err(error.message); };
            update.download_url = url::Url::parse(&mirror).map_err(|_| "更新加速地址无效".to_string())?;
            let _ = on_event.send(serde_json::json!({ "event": "Started", "data": {} }));
            download(&update, &on_event).await.map_err(|error| error.message)?
        }
    };
    // download() 返回前已经验签；校验失败不能切源，安装永远只执行一次。
    let _ = on_event.send(serde_json::json!({ "event": "Finished" }));
    update.install(bytes).map_err(|error| format!("更新安装失败：{error}"))
}
