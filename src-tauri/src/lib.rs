use base64::Engine;
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

/// 使用原生 HTTP 客户端下载远程图片并返回 base64 data URL（绕过 WebView CORS 限制）
#[tauri::command]
async fn fetch_image_data_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("AI-Canvas/0.1")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    // 从 Content-Type 头推导 MIME（提前提取为 String，避免借用冲突）
    let mime = {
        let ct = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(';').next())
            .unwrap_or("image/png")
            .trim();
        if ct.starts_with("image/") {
            ct.to_string()
        } else {
            // 从 URL 后缀推导
            let lower = url.to_lowercase();
            let guess = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
                "image/jpeg"
            } else if lower.ends_with(".gif") {
                "image/gif"
            } else if lower.ends_with(".webp") {
                "image/webp"
            } else if lower.ends_with(".bmp") {
                "image/bmp"
            } else if lower.ends_with(".svg") {
                "image/svg+xml"
            } else {
                "image/png"
            };
            guess.to_string()
        }
    };

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 将文件或目录移动到系统回收站/废纸篓
#[tauri::command]
async fn move_to_trash(path: String) -> Result<(), String> {
    trash::delete(std::path::Path::new(&path))
        .map_err(|e| format!("移动文件到回收站失败: {}", e))
}

/// 切换当前 WebView 的开发者工具（先关闭再打开实现 toggle 效果）
#[tauri::command]
async fn toggle_devtools(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("未找到主窗口".to_string())?;
    window.close_devtools();
    window.open_devtools();
    Ok(())
}

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
        .invoke_handler(tauri::generate_handler![fetch_image_data_url, move_to_trash, dreamina_login, toggle_devtools])
        .setup(|_app| {
            // 调试构建自动打开 DevTools（方便排查打包后白屏等问题）
            #[cfg(debug_assertions)]
            {
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
