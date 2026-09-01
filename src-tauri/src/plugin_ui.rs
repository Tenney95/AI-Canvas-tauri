//! 插件自定义界面的窗口与协议服务。
//!
//! 界面代码既不进入宿主页面，也不通过 eval 执行：产物由 `plugin-ui://` 协议从插件
//! 版本目录读出，送到**独立的 webview 窗口**里运行。于是插件界面与主界面进程隔离——
//! 它崩溃、死循环或内存失控都只影响那个窗口——而宿主页面的 CSP 无需放宽。
//!
//! 协议只认插件界面窗口，且每次都重新走一遍启用状态、版本摘要与 ui.custom 的校验。

use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Manager, Runtime, UriSchemeContext, Webview, WebviewUrl, WebviewWindowBuilder,
};

use crate::path_policy::ensure_trusted_caller;
use crate::plugin_registry::{plugin_private_dir, read_active_ui_source};

const WINDOW_LABEL_PREFIX: &str = "plugin-ui-";
const WINDOW_WIDTH: f64 = 760.0;
const WINDOW_HEIGHT: f64 = 600.0;

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 只允许插件界面窗口访问本协议，避免主页面或其他窗口顺带拿到产物通道。
fn is_plugin_ui_window(webview_label: &str) -> bool {
    webview_label.starts_with(WINDOW_LABEL_PREFIX)
}

pub fn handle_protocol<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if !is_plugin_ui_window(context.webview_label()) {
        return error_response(StatusCode::FORBIDDEN, "forbidden");
    }
    // 路径形如 /<pluginId>/<uiDigest>，UI 产物按摘要内容寻址，杜绝路径穿越。
    let path = request.uri().path().trim_start_matches('/');
    let mut segments = path.split('/');
    let (Some(plugin_id), Some(ui_digest), None) =
        (segments.next(), segments.next(), segments.next())
    else {
        return error_response(StatusCode::BAD_REQUEST, "bad request");
    };
    if plugin_id.is_empty() || ui_digest.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "bad request");
    }
    let Ok(private_dir) = plugin_private_dir(context.app_handle()) else {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "无法定位插件目录");
    };
    match read_active_ui_source(&private_dir, plugin_id, ui_digest) {
        Ok(source) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/javascript; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(source.into_bytes())
            .unwrap_or_else(|_| Response::new(Vec::new())),
        Err(message) => error_response(StatusCode::FORBIDDEN, &message),
    }
}

/// 导出名会进入 URL 查询串，因此只允许安全的 JS 标识符字符。
fn validate_ui_export_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("界面导出名长度无效".to_string());
    }
    let mut characters = name.chars();
    let first = characters
        .next()
        .ok_or_else(|| "界面导出名不能为空".to_string())?;
    if !first.is_ascii_alphabetic() {
        return Err("界面导出名必须以字母开头".to_string());
    }
    if !characters.all(|character| character.is_ascii_alphanumeric() || character == '_') {
        return Err("界面导出名只能包含字母、数字和下划线".to_string());
    }
    Ok(())
}

/// 会话 ID 会进入窗口 label 与 URL 查询串，因此只允许安全字符。
fn validate_session_id(session_id: &str) -> Result<(), String> {
    if !(8..=64).contains(&session_id.len()) {
        return Err("插件界面会话 ID 长度无效".to_string());
    }
    if !session_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("插件界面会话 ID 含非法字符".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_plugin_ui_window(
    app: AppHandle,
    webview: Webview,
    session_id: String,
    plugin_id: String,
    ui_digest: String,
    export_name: String,
    title: String,
) -> Result<(), String> {
    ensure_trusted_caller(&webview)?;
    validate_session_id(&session_id)?;
    validate_ui_export_name(&export_name)?;
    if ui_digest.len() != 64 || !ui_digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("插件界面摘要无效".to_string());
    }
    let label = format!("{WINDOW_LABEL_PREFIX}{session_id}");
    if app.get_webview_window(&label).is_some() {
        return Err("插件界面窗口已存在".to_string());
    }
    let bundle = format!("http://plugin-ui.localhost/{plugin_id}/{ui_digest}");
    let page = format!("plugin-ui-host.html?session={session_id}&export={export_name}&bundle={bundle}");
    let window_title = if title.trim().is_empty() {
        "插件界面".to_string()
    } else {
        title.chars().take(80).collect()
    };
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(page.into()))
        .title(window_title)
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(420.0, 320.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|error| format!("无法创建插件界面窗口: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn close_plugin_ui_window(
    app: AppHandle,
    webview: Webview,
    session_id: String,
) -> Result<bool, String> {
    // 插件界面窗口运行的是插件代码，不是可信调用者；关闭动作只能由宿主窗口发起。
    ensure_trusted_caller(&webview)?;
    validate_session_id(&session_id)?;
    let label = format!("{WINDOW_LABEL_PREFIX}{session_id}");
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(false);
    };
    window
        .close()
        .map_err(|_| "无法关闭插件界面窗口".to_string())?;
    Ok(true)
}
