//! 插件自定义界面的私有产物协议。
//!
//! 界面代码既不进入宿主页面，也不通过 eval 执行：产物由 `plugin-ui://` 协议从插件
//! 版本目录读出，送到主窗口 Modal 内的 sandboxed iframe 运行；它拿不到宿主 DOM、
//! Store 或 Tauri 命令能力，宿主页面也不执行插件脚本。
//!
//! 协议只认主窗口，且每次都重新走启用状态、版本摘要与 ui.custom 校验。

use tauri::{
    http::{header, Request, Response, StatusCode},
    Runtime, UriSchemeContext,
};

use crate::plugin_registry::{plugin_private_dir, read_active_ui_source};

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// iframe 的协议请求归属于主 webview；其它窗口不得读取插件界面产物。
fn is_plugin_ui_surface(webview_label: &str) -> bool {
    webview_label == "main"
}

pub fn handle_protocol<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if !is_plugin_ui_surface(context.webview_label()) {
        return error_response(StatusCode::FORBIDDEN, "forbidden");
    }
    // convertFileSrc 会按平台生成 http://plugin-ui.localhost 或 plugin-ui://localhost；
    // 路径只放插件 ID，摘要放在唯一 query 参数中，避免编码后的路径分隔符产生歧义。
    let plugin_id = request.uri().path().trim_start_matches('/');
    let mut query = request
        .uri()
        .query()
        .map(|value| url::form_urlencoded::parse(value.as_bytes()));
    let Some((key, ui_digest)) = query.as_mut().and_then(Iterator::next) else {
        return error_response(StatusCode::BAD_REQUEST, "bad request");
    };
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || key != "digest"
        || ui_digest.is_empty()
        || query.as_mut().and_then(Iterator::next).is_some()
    {
        return error_response(StatusCode::BAD_REQUEST, "bad request");
    }
    let Ok(private_dir) = plugin_private_dir(context.app_handle()) else {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "无法定位插件目录");
    };
    match read_active_ui_source(&private_dir, plugin_id, &ui_digest) {
        Ok(source) => Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            )
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header("X-Content-Type-Options", "nosniff")
            .body(source.into_bytes())
            .unwrap_or_else(|_| Response::new(Vec::new())),
        Err(message) => error_response(StatusCode::FORBIDDEN, &message),
    }
}

#[cfg(test)]
mod tests {
    use super::is_plugin_ui_surface;

    #[test]
    fn plugin_ui_protocol_is_limited_to_the_main_webview() {
        assert!(is_plugin_ui_surface("main"));
        assert!(!is_plugin_ui_surface("plugin-ui-session"));
        assert!(!is_plugin_ui_surface("settings"));
        assert!(!is_plugin_ui_surface("chat"));
    }
}
