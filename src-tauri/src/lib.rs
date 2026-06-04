use std::sync::Mutex;
use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct DreaminaLoginPayload {
    cookie: String,
}

/// 注入到即梦登录窗口的 JS：轮询 Cookie + DOM 观察，登录成功后通过 event.emit 回传凭证
const DREAMINA_LOGIN_WATCHER: &str = r#"
(function(){
  if (window.__dreaminaWatcher) return;
  window.__dreaminaWatcher = true;

  function sendCookie() {
    var c = document.cookie || '';
    // 登录成功的 Cookie 通常较长，包含 session/token 等关键字段
    if (c.length > 80) {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('dreamina-cookie', { cookie: c });
      }
    }
  }

  // 1. 每 2 秒轮询 Cookie
  var pollTimer = setInterval(sendCookie, 2000);

  // 2. 观察 DOM 变化（登录模态框关闭时触发）
  var obsTimer;
  var observer = new MutationObserver(function() {
    clearTimeout(obsTimer);
    obsTimer = setTimeout(sendCookie, 600);
  });

  setTimeout(function() {
    observer.observe(document.body, { childList: true, subtree: true, attributes: false, characterData: false });
  }, 3000);

  // 3. 兜底：120 秒后强制检查
  setTimeout(function() {
    clearInterval(pollTimer);
    sendCookie();
  }, 120000);
})();
"#;

#[tauri::command]
async fn dreamina_login(app: tauri::AppHandle) -> Result<DreaminaLoginPayload, String> {
    let login_url = "https://jimeng.jianying.com/";

    // 先关闭可能残留的历史登录窗口
    if let Some(old) = app.get_webview_window("dreamina-login") {
        let _ = old.close();
    }

    let webview = WebviewWindowBuilder::new(
        &app,
        "dreamina-login",
        WebviewUrl::External(Url::parse(login_url).map_err(|e| e.to_string())?),
    )
    .title("即梦登录 — 登录后自动关闭")
    .inner_size(800.0, 660.0)
    .center()
    .resizable(true)
    .visible(true)
    .build()
    .map_err(|e| format!("创建登录窗口失败: {e}"))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));

    // 监听 webview 发来的 cookie 事件
    let event_id = app.listen("dreamina-cookie", move |event: tauri::Event| {
        if let Ok(payload) = serde_json::from_str::<DreaminaLoginPayload>(event.payload()) {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(payload.cookie);
            }
        }
    });

    // 等页面加载完成后注入 Cookie 轮询脚本
    let webview_clone = webview.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let _ = webview_clone.eval(DREAMINA_LOGIN_WATCHER);
    });

    // 等待 cookie（最多 180 秒）
    let cookie = tokio::time::timeout(std::time::Duration::from_secs(180), rx)
        .await
        .map_err(|_| "登录超时，请重试".to_string())?
        .map_err(|_| "登录已取消".to_string())?;

    app.unlisten(event_id);

    // 关闭登录窗口
    let _ = webview.close();

    if cookie.is_empty() {
        return Err("未获取到登录凭证，请确认登录成功".to_string());
    }

    Ok(DreaminaLoginPayload { cookie })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![dreamina_login])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
