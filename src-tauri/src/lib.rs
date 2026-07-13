use base64::Engine;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Listener, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use url::Url;

mod comfyui;
mod dreamina;
pub mod onnx;

static CHAT_WINDOW_LOCKED: AtomicBool = AtomicBool::new(false);
static CHAT_WINDOW_LOCK_OFFSET: Mutex<(i32, i32)> = Mutex::new((0, 0));

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

/// 通用 HTTP 代理：前端通过 invoke 调用，由 Rust 端发起 HTTP 请求，彻底绕过浏览器 CORS 限制。
/// 请求体和响应体均使用 base64 编码传输，支持 GET/POST 等任意方法。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ProxyFetchRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>, // base64 编码的请求体
}

#[derive(Clone, serde::Serialize)]
struct ProxyFetchResponse {
    status: u16,
    body: String, // base64 编码的响应体
    headers: Vec<(String, String)>,
}

#[tauri::command]
async fn proxy_fetch(req: ProxyFetchRequest) -> Result<ProxyFetchResponse, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("无效的 HTTP 方法: {e}"))?;

    let mut request = client.request(method, &req.url);

    for (key, value) in &req.headers {
        request = request.header(key.as_str(), value.as_str());
    }

    if let Some(body) = &req.body {
        if !body.is_empty() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(body)
                .map_err(|e| format!("请求体 base64 解码失败: {e}"))?;
            request = request.body(bytes);
        }
    }

    let response = request.send().await.map_err(|e| format!("请求失败: {e}"))?;

    let status = response.status().as_u16();
    let res_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let res_bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let body_b64 = base64::engine::general_purpose::STANDARD.encode(&res_bytes);

    Ok(ProxyFetchResponse {
        status,
        body: body_b64,
        headers: res_headers,
    })
}

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

/// 使用指定应用打开文件（直接调用系统进程 API，绕过 shell 插件权限限制）
#[tauri::command]
async fn open_with_app(app_path: String, file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&app_path)
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("启动应用失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", &app_path, &file_path])
            .spawn()
            .map_err(|e| format!("启动应用失败: {e}"))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app_path, file_path);
        return Err("不支持的操作系统".to_string());
    }
    Ok(())
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

/// 打开独立的 AI 对话助手窗口
#[tauri::command]
async fn open_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    CHAT_WINDOW_LOCKED.store(false, Ordering::Release);

    // 先关闭可能残留的历史窗口
    if let Some(old) = app.get_webview_window("chat-assistant") {
        let _ = old.close();
    }

    #[cfg(debug_assertions)]
    let url = WebviewUrl::External(
        Url::parse("http://localhost:1420/?view=chat").map_err(|e| e.to_string())?,
    );
    #[cfg(not(debug_assertions))]
    let url = WebviewUrl::App("index.html?view=chat".into());

    let main_window = app.get_webview_window("main");
    let mut chat_window_builder = WebviewWindowBuilder::new(&app, "chat-assistant", url)
        .title("AI 对话助手")
        .inner_size(480.0, 720.0)
        .min_inner_size(360.0, 480.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .visible(false);

    if let Some(parent) = main_window.as_ref() {
        chat_window_builder = chat_window_builder
            .parent(parent)
            .map_err(|e| format!("绑定对话窗口到主窗口失败: {e}"))?;
    }

    let chat_window = chat_window_builder
        .build()
        .map_err(|e| format!("创建对话窗口失败: {e}"))?;

    // 与主窗口内的助手面板保持一致：显示在主窗口右侧，并留出相同的边距。
    let positioned = if let Some(main_window) = main_window {
        match (
            main_window.outer_position(),
            main_window.outer_size(),
            main_window.scale_factor(),
            chat_window.outer_size(),
        ) {
            (Ok(main_position), Ok(main_size), Ok(scale_factor), Ok(chat_size)) => {
                let right_margin = (10.0 * scale_factor).round() as i32;
                let top_margin = (30.0 * scale_factor).round() as i32;
                let x = main_position.x + main_size.width as i32
                    - chat_size.width as i32
                    - right_margin;
                let y = main_position.y + top_margin;
                chat_window
                    .set_position(PhysicalPosition::new(x, y))
                    .is_ok()
            }
            _ => false,
        }
    } else {
        false
    };

    if !positioned {
        let _ = chat_window.center();
    }
    chat_window
        .show()
        .map_err(|e| format!("显示对话窗口失败: {e}"))?;

    Ok(())
}

/// 关闭独立的 AI 对话助手窗口
#[tauri::command]
async fn close_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    CHAT_WINDOW_LOCKED.store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window("chat-assistant") {
        window
            .close()
            .map_err(|e| format!("关闭对话窗口失败: {e}"))?;
    }
    Ok(())
}

/// 锁定或解锁对话窗口与主窗口的相对位置。
#[tauri::command]
async fn set_chat_window_locked(app: tauri::AppHandle, locked: bool) -> Result<(), String> {
    if locked {
        let main_window = app
            .get_webview_window("main")
            .ok_or("未找到主窗口".to_string())?;
        let chat_window = app
            .get_webview_window("chat-assistant")
            .ok_or("未找到对话窗口".to_string())?;
        let main_position = main_window
            .outer_position()
            .map_err(|e| format!("读取主窗口位置失败: {e}"))?;
        let chat_position = chat_window
            .outer_position()
            .map_err(|e| format!("读取对话窗口位置失败: {e}"))?;

        let mut offset = CHAT_WINDOW_LOCK_OFFSET
            .lock()
            .map_err(|_| "保存对话窗口锁定位置失败".to_string())?;
        *offset = (
            chat_position.x - main_position.x,
            chat_position.y - main_position.y,
        );
    }

    CHAT_WINDOW_LOCKED.store(locked, Ordering::Release);
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
    // Windows WebView2/Chromium 渲染优化：
    // - CalculateNativeWinOcclusion：原生窗口遮挡检测。在虚拟显示适配器 / 远程桌面
    //   工具（MuMu、向日葵、Virtual Display 等）环境下常误判窗口被遮挡，从而节流甚至
    // - 其余 flag 强制 GPU 光栅化 / 忽略黑名单 / 解除帧率上限。
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-features=CalculateNativeWinOcclusion --enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy --disable-frame-rate-limit",
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            fetch_image_data_url,
            proxy_fetch,
            move_to_trash,
            dreamina_login,
            dreamina::dreamina_login_start,
            dreamina::dreamina_login_runtime,
            dreamina::dreamina_logout,
            dreamina::dreamina_status,
            dreamina::dreamina_generate,
            dreamina::dreamina_query_result,
            open_chat_window,
            close_chat_window,
            set_chat_window_locked,
            open_with_app,
            toggle_devtools,
            comfyui::launch_comfyui,
            onnx::get_models_dir,
            onnx::check_model_exists,
            onnx::image_upscale,
            onnx::subject_matting,
            onnx::download_onnx_model,
            onnx::get_onnx_gpu_status,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" || !CHAT_WINDOW_LOCKED.load(Ordering::Acquire) {
                return;
            }
            let tauri::WindowEvent::Moved(main_position) = event else {
                return;
            };
            let Ok(offset) = CHAT_WINDOW_LOCK_OFFSET.lock() else {
                return;
            };
            if let Some(chat_window) = window.app_handle().get_webview_window("chat-assistant") {
                let _ = chat_window.set_position(PhysicalPosition::new(
                    main_position.x + offset.0,
                    main_position.y + offset.1,
                ));
            }
        })
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
