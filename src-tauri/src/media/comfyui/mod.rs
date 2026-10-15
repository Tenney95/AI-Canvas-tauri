//! ComfyUI 启动逻辑。
//!
//! 统一策略：优先定位 main.py 与配套 Python 解释器**直接启动**——只有这样才能
//! 注入 API 参数，并绕过整合包启动器的环境/custom_nodes 检测（秋叶启动器每次
//! 启动都会做插件校验，用户要求跳过）。bat 脚本与启动器 exe 仅作兜底。
//!
//! 兼容三类发行版（均以实机目录结构验证）：
//!  · GitHub 原生 / 秋叶整合包：<root>/main.py（秋叶 Python 在 <root>/python/）
//!  · 官方便携版：<root>/ComfyUI/main.py + <root>/python_embeded/
//!  · 官方 Comfy Desktop（v0.20+）：<base>/ComfyUI-Installs/ComfyUI/ComfyUI/main.py，
//!    venv 在同目录 .venv/；用户可能选 <base> 或 <base>/Comfy Desktop（Electron 安装目录）
//!
//! 启动参数固定绑定回环 HTTP API，并按已保存的白名单设置覆盖端口、显存、
//! 扩散模型精度、注意力与预览。默认 GPU 选择由 ComfyUI 自行决定。
pub mod installation;
pub mod launch_settings;
pub mod management;
pub mod model_dedupe;
pub mod model_dedupe_links;
pub mod model_dedupe_history;
pub mod runtime_console;

use launch_settings::ComfyUILaunchSettings;
use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 直接启动 main.py 的统一参数（API 模式）
/// -u：禁用 Python 输出缓冲，否则新开的终端窗口长时间黑屏看不到启动日志
/// --listen 仅绑定回环地址，避免 ComfyUI API 暴露到局域网
const COMFY_ARGS: &[&str] = &[
    "-u",
    "-s",
    "main.py",
    "--listen",
    "127.0.0.1",
    "--enable-cors-header",
];
const COMFYUI_WINDOW_LABEL: &str = "comfyui";
const FAST_DISK_MARKER: &str = ".ai-canvas-fast-disk";
#[cfg(windows)]
const FALLBACK_SCRIPTS: [&str; 3] = ["run_nvidia_gpu.bat", "run.bat", "run_cpu.bat"];
#[cfg(windows)]
const FALLBACK_LAUNCHERS: [&str; 5] = [
    "ComfyUi.exe", "A启动器.exe", "启动器.exe", "Comfy Desktop.exe",
    ".launcher/StableDiffusionWebUILauncher.exe",
];
const COMFYUI_BRIDGE_SCRIPT: &str = include_str!("bridge.js");
const MAX_WORKFLOW_JSON_LENGTH: usize = 16 * 1024 * 1024;
const COMFYUI_ACTION_PATH: &str = "/__ai_canvas_comfy_action__";
const COMFYUI_CONNECT_TIMEOUT: Duration = Duration::from_millis(700);
const COMFYUI_WINDOW_STATE_TIMEOUT: Duration = Duration::from_secs(5);
// 设置页与工作流编辑入口共用固定标签，检查、关闭和创建必须在同一把锁内。
static COMFYUI_WINDOW_OPEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const TAKE_SAVE_PAYLOAD_SCRIPT: &str = r#"(() => {
  const payload = window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__ ?? null;
  delete window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__;
  return payload;
})()"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComfyUIEditorPayload<'a> {
    request_id: &'a str,
    workflow_id: Option<&'a str>,
    workflow_name: Option<&'a str>,
    workflow_category: Option<&'a str>,
    workflow_file_name: Option<&'a str>,
    api_json: &'a str,
    editable_json: Option<&'a str>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyUIWorkflowOpenResult {
    request_id: String,
    node_count: usize,
    source: String,
    detail: String,
}

fn parse_editor_load_result(
    raw: &str,
    request_id: &str,
) -> Result<Option<ComfyUIWorkflowOpenResult>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "ComfyUI 返回的载入状态无效".to_string())?;
    if value.is_null() {
        return Ok(None);
    }
    if value.get("requestId").and_then(|v| v.as_str()) != Some(request_id) {
        return Err("ComfyUI 载入回执与当前请求不匹配".to_string());
    }
    let detail = value
        .get("detail")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(1200)
        .collect::<String>();
    match value.get("state").and_then(|v| v.as_str()) {
        Some("loading") => Ok(None),
        Some("error") => Err(if detail.is_empty() {
            "ComfyUI 工作流载入失败".to_string()
        } else {
            detail
        }),
        Some("ready") => {
            let node_count = value
                .get("nodeCount")
                .and_then(|v| v.as_u64())
                .filter(|count| *count > 0 && *count <= 100_000)
                .ok_or_else(|| "ComfyUI 未返回有效的画布节点，请重试".to_string())?;
            let source = value.get("source").and_then(|v| v.as_str()).unwrap_or("");
            if !matches!(source, "api" | "editable" | "existing") {
                return Err("ComfyUI 返回的载入来源无效".to_string());
            }
            Ok(Some(ComfyUIWorkflowOpenResult {
                request_id: request_id.to_string(),
                node_count: node_count as usize,
                source: source.to_string(),
                detail,
            }))
        }
        _ => Err("ComfyUI 返回的载入状态无效".to_string()),
    }
}

async fn wait_for_editor_load(
    window: &tauri::WebviewWindow,
    origin: &Url,
    request_id: &str,
) -> Result<ComfyUIWorkflowOpenResult, String> {
    let encoded = serde_json::to_string(request_id).map_err(|_| "载入请求无效".to_string())?;
    let script = format!("window.__AI_CANVAS_COMFY__?.getLoadResult({encoded}) ?? null");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline {
        let current = window
            .url()
            .map_err(|_| "ComfyUI 窗口已关闭，请重新打开".to_string())?;
        if current.as_str() == "about:blank" {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        if !is_same_comfyui_origin(&current, origin) {
            return Err("ComfyUI 页面已离开配置的服务器，请关闭该窗口后重试".to_string());
        }
        let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
        let sender = Arc::new(Mutex::new(Some(sender)));
        if window
            .eval_with_callback(&script, move |raw| {
                if let Ok(mut sender) = sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(raw);
                    }
                }
            })
            .is_ok()
        {
            if let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(2), receiver).await {
                if let Some(result) = parse_editor_load_result(&raw, request_id)? {
                    return Ok(result);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("ComfyUI 工作流载入超时，请检查编辑窗口中的提示后重试".to_string())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComfyUIWorkflowSavePayload {
    request_id: String,
    workflow_id: String,
    name: String,
    category: String,
    file_name: String,
    file_content: String,
    editable_content: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ComfyUIWindowAction {
    Close,
    Maximize,
    Minimize,
    Save,
    StartDragging,
}

fn parse_comfyui_url(comfy_url: &str) -> Result<Url, String> {
    let url = Url::parse(comfy_url.trim()).map_err(|_| "ComfyUI 服务地址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("ComfyUI 服务地址仅支持 http 或 https".to_string());
    }
    Ok(url)
}

fn is_local_comfyui_url(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
}

/// 同源即同一个 ComfyUI 服务。窗口复用只看这个：ComfyUI 前端自己会改路径/查询串，
/// 拿整个 URL 比会把窗口判成“换了地址”而销毁重建，页面一重载就多出一个同名标签页。
fn is_same_comfyui_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

/// 初始化脚本可能在导航后再次执行；工作流正文与桥接都只交给配置的顶层页面。
fn scope_comfyui_script(url: &Url, script: &str) -> String {
    let origin = serde_json::to_string(&url.origin().ascii_serialization())
        .expect("URL origin can be serialized");
    format!(
        "(() => {{ const aiCanvasComfyOrigin = {origin}; if (window.top !== window || window.location.origin !== aiCanvasComfyOrigin) return;\n{script}\n}})();"
    )
}

fn comfyui_socket_endpoint(url: &Url) -> Result<(String, u16), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "ComfyUI 服务地址缺少主机名".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "ComfyUI 服务地址缺少端口".to_string())?;
    Ok((host.to_string(), port))
}

async fn ensure_local_comfyui_reachable(url: &Url) -> Result<(), String> {
    let (host, port) = comfyui_socket_endpoint(url)?;
    let display_endpoint = format!("{host}:{port}");
    tauri::async_runtime::spawn_blocking(move || {
        let addresses = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|_| format!("无法解析 ComfyUI 服务地址：{display_endpoint}"))?;
        for address in addresses {
            if TcpStream::connect_timeout(&address, COMFYUI_CONNECT_TIMEOUT).is_ok() {
                return Ok(());
            }
        }
        Err(format!(
            "无法连接 ComfyUI 服务（{display_endpoint}），请先启动 ComfyUI 后再打开"
        ))
    })
    .await
    .map_err(|error| format!("检查 ComfyUI 服务状态失败: {error}"))?
}

fn build_editor_script(
    request_id: Option<&str>,
    workflow_id: Option<&str>,
    workflow_name: Option<&str>,
    workflow_category: Option<&str>,
    workflow_file_name: Option<&str>,
    api_json: Option<&str>,
    editable_json: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(api_json) = api_json else {
        return Ok(None);
    };
    let request_id = request_id
        .filter(|value| {
            value.starts_with("open-")
                && value.len() <= 160
                && value
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_' | b'.'))
        })
        .ok_or_else(|| "ComfyUI 打开请求标识无效".to_string())?;
    if api_json.len() > MAX_WORKFLOW_JSON_LENGTH
        || editable_json.is_some_and(|json| json.len() > MAX_WORKFLOW_JSON_LENGTH)
    {
        return Err("ComfyUI 工作流超过 16 MiB 上限".to_string());
    }
    serde_json::from_str::<serde_json::Value>(api_json)
        .map_err(|_| "ComfyUI API 工作流 JSON 无效".to_string())?;
    // 编辑布局可损坏；桥接会从已校验的 API 数据重建，不应先打开空白后静默失败。

    let payload = ComfyUIEditorPayload {
        request_id,
        workflow_id,
        workflow_name,
        workflow_category,
        workflow_file_name,
        api_json,
        editable_json,
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| format!("序列化 ComfyUI 工作流失败: {error}"))?;
    Ok(Some(format!(
        "window.__AI_CANVAS_PENDING_WORKFLOW__={payload_json};window.__AI_CANVAS_COMFY__?.consumePending();"
    )))
}

fn parse_comfyui_window_action(url: &Url, comfy_url: &Url) -> Option<ComfyUIWindowAction> {
    if !is_same_comfyui_origin(url, comfy_url) || url.path() != COMFYUI_ACTION_PATH {
        return None;
    }

    match url
        .query_pairs()
        .find_map(|(key, value)| (key == "action").then(|| value.into_owned()))?
        .as_str()
    {
        "close" => Some(ComfyUIWindowAction::Close),
        "maximize" => Some(ComfyUIWindowAction::Maximize),
        "minimize" => Some(ComfyUIWindowAction::Minimize),
        "save" => Some(ComfyUIWindowAction::Save),
        "start-dragging" => Some(ComfyUIWindowAction::StartDragging),
        _ => None,
    }
}

fn parse_workflow_save_payload(raw: &str) -> Result<ComfyUIWorkflowSavePayload, String> {
    const MAX_SERIALIZED_LENGTH: usize = MAX_WORKFLOW_JSON_LENGTH * 4 + 64 * 1024;
    if raw.len() > MAX_SERIALIZED_LENGTH {
        return Err("ComfyUI 工作流保存数据超过限制".to_string());
    }

    let payload: ComfyUIWorkflowSavePayload =
        serde_json::from_str(raw).map_err(|_| "ComfyUI 工作流保存数据格式无效".to_string())?;
    if !is_valid_save_request_id(&payload.request_id)
        || payload.workflow_id.is_empty()
        || payload.workflow_id.len() > 256
        || payload.name.is_empty()
        || payload.name.len() > 512
        || payload.file_name.is_empty()
        || payload.file_name.len() > 512
        || payload.category.len() > 32
    {
        return Err("ComfyUI 工作流元数据无效".to_string());
    }
    if !matches!(
        payload.category.as_str(),
        "ai-text" | "ai-image" | "ai-video" | "ai-audio"
    ) {
        return Err("ComfyUI 工作流分类无效".to_string());
    }
    if payload.file_content.len() > MAX_WORKFLOW_JSON_LENGTH
        || payload.editable_content.len() > MAX_WORKFLOW_JSON_LENGTH
    {
        return Err("ComfyUI 工作流超过 16 MiB 上限".to_string());
    }
    serde_json::from_str::<serde_json::Value>(&payload.file_content)
        .map_err(|_| "ComfyUI API 工作流 JSON 无效".to_string())?;
    serde_json::from_str::<serde_json::Value>(&payload.editable_content)
        .map_err(|_| "ComfyUI 可编辑工作流 JSON 无效".to_string())?;
    Ok(payload)
}

fn is_valid_save_request_id(request_id: &str) -> bool {
    request_id.strip_prefix("save-").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 120
            && suffix.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')
            })
    })
}

fn notify_comfyui_save(
    window: &tauri::WebviewWindow,
    request_id: Option<&str>,
    success: bool,
    detail: &str,
) -> Result<(), String> {
    let request_id_json = serde_json::to_string(&request_id)
        .map_err(|error| format!("序列化 ComfyUI 保存请求 ID 失败: {error}"))?;
    let detail_json = serde_json::to_string(detail)
        .map_err(|error| format!("序列化 ComfyUI 保存结果失败: {error}"))?;
    window
        .eval(format!(
            "window.__AI_CANVAS_COMFY__?.completeSave({request_id_json},{success},{detail_json});"
        ))
        .map_err(|error| format!("回传 ComfyUI 保存结果失败: {error}"))
}

fn transfer_comfyui_save_payload(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let callback_app = app.clone();
    let callback_window = window.clone();
    let result = window
        .eval_with_callback(TAKE_SAVE_PAYLOAD_SCRIPT, move |raw| {
            let result = parse_workflow_save_payload(&raw).and_then(|payload| {
                callback_app
                    .emit_to("main", "comfyui-workflow-save", &payload)
                    .map_err(|error| format!("保存 ComfyUI 工作流失败: {error}"))?;
                Ok(())
            });
            if let Err(error) = result {
                let _ = notify_comfyui_save(&callback_window, None, false, &error);
            }
        })
        .map_err(|error| format!("读取 ComfyUI 工作流失败: {error}"));
    if let Err(error) = &result {
        let _ = notify_comfyui_save(window, None, false, error);
    }
    result
}

/// 主窗口完成校验与持久化后，才把最终结果回传给 ComfyUI 页面。
#[tauri::command]
pub fn complete_comfyui_workflow_save(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    request_id: String,
    success: bool,
    detail: String,
) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if !is_valid_save_request_id(&request_id) {
        return Err("ComfyUI 保存请求 ID 无效".to_string());
    }
    let window = app
        .get_webview_window(COMFYUI_WINDOW_LABEL)
        .ok_or_else(|| "ComfyUI 窗口不存在".to_string())?;
    notify_comfyui_save(&window, Some(&request_id), success, &detail)
}

fn handle_comfyui_window_action(
    app: &tauri::AppHandle,
    action: ComfyUIWindowAction,
) -> Result<(), String> {
    let window = app
        .get_webview_window(COMFYUI_WINDOW_LABEL)
        .ok_or_else(|| "ComfyUI 窗口不存在".to_string())?;
    match action {
        ComfyUIWindowAction::Close => window.close(),
        ComfyUIWindowAction::Maximize => {
            #[cfg(target_os = "macos")]
            {
                window
                    .is_fullscreen()
                    .and_then(|is_fullscreen| window.set_fullscreen(!is_fullscreen))
            }
            #[cfg(not(target_os = "macos"))]
            {
                window.is_maximized().and_then(|is_maximized| {
                    if is_maximized {
                        window.unmaximize()
                    } else {
                        window.maximize()
                    }
                })
            }
        }
        ComfyUIWindowAction::Minimize => window.minimize(),
        ComfyUIWindowAction::Save => return transfer_comfyui_save_payload(app, &window),
        ComfyUIWindowAction::StartDragging => window.start_dragging(),
    }
    .map_err(|error| format!("控制 ComfyUI 窗口失败: {error}"))
}

/// 定位 main.py 所在目录（即启动工作目录）
fn find_main_py(root: &Path) -> Option<PathBuf> {
    let candidates = [
        // GitHub 原生 / 秋叶整合包：根目录即源码
        root.to_path_buf(),
        // 官方便携版：ComfyUI 子目录
        root.join("ComfyUI"),
        // Comfy Desktop v0.20+：用户选择了基目录（如 F:\ComfyUI）
        root.join("ComfyUI-Installs")
            .join("ComfyUI")
            .join("ComfyUI"),
        // Desktop 目录提示；后面仍限定在所选安装根内，不跟随根外的同级源码。
        root.parent()
            .map(|p| p.join("ComfyUI-Installs").join("ComfyUI").join("ComfyUI"))
            .unwrap_or_default(),
        // 旧版 Comfy Desktop（≤v0.4）：源码打包在 resources 下
        root.join("resources").join("ComfyUI"),
    ];
    candidates.into_iter().filter(|candidate| candidate.starts_with(root))
        .find(|directory| directory.join("main.py").is_file())
}

/// 查找与安装配套的 Python 解释器
fn find_python(working_dir: &Path, root: &Path) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for base in [working_dir, root] {
        // Comfy Desktop：venv 与源码同目录；GitHub 原生常用 venv/.venv
        candidates.push(base.join(".venv").join("Scripts").join("python.exe"));
        candidates.push(base.join("venv").join("Scripts").join("python.exe"));
        // 便携版 / 秋叶整合包的内嵌 Python
        candidates.push(base.join("python_embeded").join("python.exe"));
        candidates.push(base.join("python_embedded").join("python.exe"));
        candidates.push(base.join("python").join("python.exe"));
        // Unix venv
        candidates.push(base.join(".venv").join("bin").join("python"));
        candidates.push(base.join("venv").join("bin").join("python"));
    }
    // Comfy Desktop：standalone 基础环境（.venv 缺失时的兜底）
    if let Some(parent) = working_dir.parent() {
        candidates.push(parent.join("standalone-env").join("python.exe"));
    }

    for p in &candidates {
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }

    // 系统 Python（仅 GitHub 原生装在系统环境的情况）
    for name in &["python3", "python"] {
        let mut cmd = Command::new(name);
        cmd.arg("--version");

        #[cfg(windows)]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        if cmd.output().map(|o| o.status.success()).unwrap_or(false) {
            return Some(name.to_string());
        }
    }

    None
}

/// 官方 Comfy Desktop 的共享模型配置由桌面端写入 Roaming 配置目录。
/// 本应用绕过 Electron 启动器、直接启动 main.py，因此需要把该配置显式传给 ComfyUI。
fn find_comfy_desktop_shared_model_paths(root: &Path, working_dir: &Path) -> Option<PathBuf> {
    let looks_like_desktop = root.join("Comfy Desktop.exe").is_file()
        || root
            .join("Comfy Desktop")
            .join("Comfy Desktop.exe")
            .is_file()
        || working_dir
            .ancestors()
            .any(|p| p.file_name().is_some_and(|name| name == "ComfyUI-Installs"));

    if !looks_like_desktop {
        return None;
    }

    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("Comfy Desktop").join("shared_model_paths.yaml"))
        .filter(|p| p.is_file())
}

fn build_comfy_args(
    root: &Path,
    working_dir: &Path,
    settings: &ComfyUILaunchSettings,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = COMFY_ARGS.iter().map(|arg| (*arg).to_string()).collect();
    let declared_args = std::fs::read_to_string(working_dir.join("comfy/cli_args.py"))
        .map_err(|_| {
            "无法读取 ComfyUI 启动参数声明，请检查安装目录中的 comfy/cli_args.py".to_string()
        })?;
    for flag in ["--listen", "--enable-cors-header"] {
        if !launch_settings::declares_cli_flag(&declared_args, flag) {
            return Err(format!("当前 ComfyUI 版本不支持 API 启动参数 {flag}"));
        }
    }
    settings.append_args(&mut args, &declared_args)?;

    // fast-disk can avoid Windows page-file thrashing for models larger than system RAM.
    // Keep it opt-in per ComfyUI installation because it can be slower on mechanical disks,
    // and only pass the flag when the installed ComfyUI version actually declares it.
    let fast_disk_enabled =
        root.join(FAST_DISK_MARKER).is_file() || working_dir.join(FAST_DISK_MARKER).is_file();
    let fast_disk_supported = launch_settings::declares_cli_flag(&declared_args, "--fast-disk");
    if fast_disk_enabled && fast_disk_supported {
        args.push("--fast-disk".to_string());
    }

    if let Some(shared_model_paths) = find_comfy_desktop_shared_model_paths(root, working_dir) {
        launch_settings::append_supported_arg(
            &mut args,
            &declared_args,
            "--extra-model-paths-config",
            Some(shared_model_paths.to_string_lossy().as_ref()),
        )?;
    }

    Ok(args)
}

/// 仅保留无法直接启动 Python 的旧整合包兜底；此模式不能捕获输出。
#[cfg(windows)]
fn launch_external_windows(app: &tauri::AppHandle, root: &Path, settings: &ComfyUILaunchSettings) -> Result<String, String> {
    if settings.requires_direct_launch() {
        return Err("当前安装只能使用启动器或批处理启动，无法应用已保存的启动设置；请补齐 main.py 与配套 Python，或先恢复默认设置".to_string());
    }

    // 便携版 bat（GPU 优先）
    for script in &FALLBACK_SCRIPTS {
        let script_path = root.join(script);
        if script_path.is_file() {
            crate::path_policy::validate_comfyui_installation_file(app, &script_path, root)?;
            return run_bat_script(&script_path);
        }
    }

    // 启动器 exe（秋叶启动器 / Comfy Desktop Electron）
    for launcher in &FALLBACK_LAUNCHERS {
        let launcher_path = root.join(launcher);
        if launcher_path.is_file() {
            crate::path_policy::validate_comfyui_installation_file(app, &launcher_path, root)?;
            return run_exe_new_console(&launcher_path);
        }
    }

    Err("未找到可用的 ComfyUI main.py、Python 或受支持的启动入口，请检查安装目录。".into())
}

/// 通过 cmd 内建 start 在全新控制台中运行命令。
///
/// 不能直接用 CREATE_NEW_CONSOLE 生成子进程：Rust std 会把父进程的 stdout/stderr
/// 句柄传给子进程（STARTF_USESTDHANDLES），结果新控制台窗口一片空白，日志全部
/// 打到父进程终端（tauri dev 的终端）。start 拉起的进程不继承标准句柄，
/// 输出会正确接到新控制台。
#[cfg(windows)]
fn start_new_console(inner_cmd: &str, working_dir: &Path, err_ctx: &str) -> Result<(), String> {
    let dir_str = working_dir.to_string_lossy().replace('/', "\\");

    let mut cmd = Command::new("cmd");
    cmd.creation_flags(CREATE_NO_WINDOW); // 外层 cmd 本身不显示窗口

    cmd.raw_arg(&format!(
        r#"/c start "ComfyUI" /D "{}" {}"#,
        dir_str, inner_cmd
    ));

    cmd.spawn().map_err(|e| format!("{err_ctx}: {e}"))?;
    Ok(())
}

/// 在新控制台窗口执行 .bat 脚本
#[cfg(windows)]
fn run_bat_script(script_path: &Path) -> Result<String, String> {
    let dir = script_path
        .parent()
        .ok_or_else(|| "无法获取脚本所在目录".to_string())?;

    let script_str = script_path.to_string_lossy().replace('/', "\\");
    // 内层引号由 cmd 的引号剥离规则还原：""x"" → "x"
    let inner = format!(r#"cmd /c ""{}"""#, script_str);
    start_new_console(&inner, dir, "启动 ComfyUI 失败")?;

    Ok("ComfyUI 已启动".into())
}

/// 在新控制台窗口直接启动 .exe（启动器多为 GUI 程序，无需保留控制台）
#[cfg(windows)]
fn run_exe_new_console(exe_path: &Path) -> Result<String, String> {
    let dir = exe_path
        .parent()
        .ok_or_else(|| "无法获取程序所在目录".to_string())?;

    let exe_str = exe_path.to_string_lossy().replace('/', "\\");
    let inner = format!(r#""{}""#, exe_str);
    start_new_console(&inner, dir, "启动 ComfyUI 启动器失败")?;

    Ok("ComfyUI 启动器已启动".into())
}

/// Tauri command: 启动 ComfyUI
#[tauri::command]
pub async fn launch_comfyui(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    comfy_path: String,
) -> Result<runtime_console::ComfyUIRuntimeStartResult, String> {
    // 只有自有本地窗口能触发进程启动；目录内容仍由下面的已知文件名探测约束。
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" { return Err("仅主窗口可以通过安装路径启动 ComfyUI".into()); }
    let _operation_guard = management::lock_operations().await;
    let path = installation::authorize_installation(&app, &comfy_path).await?;
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let launch_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || runtime_console::launch_authorized(&launch_app, &path))
        .await.map_err(|_| "ComfyUI 启动任务中断，请查看运行状态".to_string())??;
    runtime_console::notify_main_started(&app, &result);
    Ok(result)
}

/// 把下载结果告诉 ComfyUI 页面。wry 默认把下载标记为已处理，WebView2 既不弹「另存为」
/// 也不显示下载提示，不回个话用户就以为导出没生效。
fn notify_comfyui_download(webview: &tauri::Webview, path: Option<&Path>, success: bool) {
    let path_text = path
        .map(|item| item.display().to_string())
        .unwrap_or_default();
    let encoded = serde_json::to_string(&path_text).unwrap_or_else(|_| "\"\"".to_string());
    let _ = webview.eval(&format!(
        "window.__AI_CANVAS_COMFY__?.notifyDownload?.({success}, {encoded});"
    ));
}

/// 等待原生窗口状态稳定；超时保留现有窗口，不强行销毁可能含有草稿的页面。
async fn wait_for_comfyui_window_state<T>(
    mut inspect: impl FnMut() -> Result<Option<T>, String>,
    timeout: Duration,
    timeout_message: &str,
) -> Result<T, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(value) = inspect()? {
            return Ok(value);
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(timeout_message.to_string());
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(50))).await;
    }
}

/// Tauri command: 在应用内的独立 Webview 窗口中打开 ComfyUI 页面。
#[tauri::command]
pub async fn open_comfyui_window(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    comfy_url: String,
    request_id: Option<String>,
    workflow_id: Option<String>,
    workflow_name: Option<String>,
    workflow_category: Option<String>,
    workflow_file_name: Option<String>,
    api_json: Option<String>,
    editable_json: Option<String>,
) -> Result<Option<ComfyUIWorkflowOpenResult>, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let url = parse_comfyui_url(&comfy_url)?;
    let _open_guard = COMFYUI_WINDOW_OPEN_LOCK.lock().await;
    if is_local_comfyui_url(&url) {
        // 服务短暂离线只返回错误，不能关闭还保存着未提交草稿的编辑窗口。
        ensure_local_comfyui_reachable(&url).await?;
    }
    let editor_script = build_editor_script(
        request_id.as_deref(),
        workflow_id.as_deref(),
        workflow_name.as_deref(),
        workflow_category.as_deref(),
        workflow_file_name.as_deref(),
        api_json.as_deref(),
        editable_json.as_deref(),
    )?;

    if let Some(window) = app.get_webview_window(COMFYUI_WINDOW_LABEL) {
        // WebView2 初始地址可能仍是 about:blank；此时不能把加载中的窗口当作旧服务关闭。
        let current = wait_for_comfyui_window_state(
            || {
                let current = window
                    .url()
                    .map_err(|_| "无法读取 ComfyUI 窗口状态，请稍后重试".to_string())?;
                Ok((current.as_str() != "about:blank").then_some(current))
            },
            COMFYUI_WINDOW_STATE_TIMEOUT,
            "ComfyUI 窗口仍在加载，请稍后重试",
        )
        .await?;
        // 只要还是同一个 ComfyUI 服务就复用窗口：前端自己改过的路径/查询串不算“换了地址”
        if is_same_comfyui_origin(&current, &url) {
            if let Some(script) = editor_script {
                window
                    .eval(scope_comfyui_script(&url, &script))
                    .map_err(|e| format!("载入 ComfyUI 工作流失败: {e}"))?;
            }
            let _ = window.unminimize();
            window
                .show()
                .map_err(|e| format!("显示 ComfyUI 窗口失败: {e}"))?;
            window
                .set_focus()
                .map_err(|e| format!("聚焦 ComfyUI 窗口失败: {e}"))?;
            return if api_json.is_some() {
                wait_for_editor_load(&window, &url, request_id.as_deref().unwrap_or(""))
                    .await
                    .map(Some)
            } else {
                Ok(None)
            };
        }
        window
            .close()
            .map_err(|e| format!("关闭旧 ComfyUI 窗口失败: {e}"))?;
        // close 只排入关闭请求；等管理器注销 WebView 后才能复用固定标签。
        wait_for_comfyui_window_state(
            || {
                Ok(app
                    .get_webview_window(COMFYUI_WINDOW_LABEL)
                    .is_none()
                    .then_some(()))
            },
            COMFYUI_WINDOW_STATE_TIMEOUT,
            "旧 ComfyUI 窗口尚未关闭，请先关闭该窗口后重试",
        )
        .await?;
    }

    let mut initialization_script = COMFYUI_BRIDGE_SCRIPT.to_string();
    if let Some(script) = editor_script {
        initialization_script.push_str(&script);
    }

    let action_origin = url.clone();
    let page_origin = url.clone();
    let mut builder = WebviewWindowBuilder::new(
        &app,
        COMFYUI_WINDOW_LABEL,
        WebviewUrl::External(url.clone()),
    )
    .title("ComfyUI")
    .inner_size(1280.0, 820.0)
    .min_inner_size(900.0, 600.0)
    .center()
    .resizable(true)
    // 页面加载完成前保留原生标题栏；连接异常时窗口仍有系统关闭按钮。
    .decorations(true)
    // Tauri 默认的原生拖放处理会吞掉 HTML5 drag 事件，ComfyUI 就收不到拖进来的
    // 工作流 JSON / 图片；关掉它交还给页面自己处理
    .disable_drag_drop_handler()
    // wry 默认注册的下载处理器会把下载标记为已处理，WebView2 自带的「另存为」
    // 和下载提示都不会出现，导出的工作流悄悄落到「下载」目录里。这里补上反馈。
    .on_download(|webview, event| {
        if let tauri::webview::DownloadEvent::Finished { path, success, .. } = event {
            notify_comfyui_download(&webview, path.as_deref(), success);
        }
        true
    })
    .visible(true);
    {
        let navigation_app = app.clone();
        builder = builder.on_navigation(move |navigation_url| {
            let Some(action) = parse_comfyui_window_action(navigation_url, &action_origin) else {
                return is_same_comfyui_origin(navigation_url, &action_origin);
            };
            let action_app = navigation_app.clone();
            let expected_origin = action_origin.clone();
            let _ = navigation_app.run_on_main_thread(move || {
                // 校验动作发起页面，而不只校验导航目标；排队期间窗口也可能被替换。
                if action_app
                    .get_webview_window(COMFYUI_WINDOW_LABEL)
                    .is_some_and(|window| {
                        window.url().is_ok_and(|current| {
                            is_same_comfyui_origin(&current, &expected_origin)
                        })
                    })
                {
                    let _ = handle_comfyui_window_action(&action_app, action);
                }
            });
            false
        });
        builder = builder.on_page_load(move |window, payload| {
            let loaded_url = payload.url();
            let is_same_origin = loaded_url.scheme() == page_origin.scheme()
                && loaded_url.host_str() == page_origin.host_str()
                && loaded_url.port_or_known_default() == page_origin.port_or_known_default();
            if matches!(payload.event(), PageLoadEvent::Finished) && is_same_origin {
                let callback_window = window.clone();
                let _ = window.eval_with_callback(
                    "Boolean(window.__AI_CANVAS_COMFY__)",
                    move |bridge_ready| {
                        if bridge_ready.trim() == "true" {
                            let _ = callback_window.set_decorations(false);
                        }
                    },
                );
            }
        });
    }
    builder = builder.initialization_script(scope_comfyui_script(&url, &initialization_script));
    let window = builder
        .build()
        .map_err(|e| format!("创建 ComfyUI 窗口失败: {e}"))?;

    if api_json.is_some() {
        wait_for_editor_load(&window, &url, request_id.as_deref().unwrap_or(""))
            .await
            .map(Some)
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::launch_settings::ComfyUILaunchSettings;
    use super::{
        build_comfy_args, build_editor_script, comfyui_socket_endpoint,
        ensure_local_comfyui_reachable, is_local_comfyui_url, is_same_comfyui_origin,
        parse_comfyui_url, parse_comfyui_window_action, parse_editor_load_result,
        parse_workflow_save_payload, scope_comfyui_script, wait_for_comfyui_window_state,
        ComfyUIWindowAction, COMFY_ARGS, FAST_DISK_MARKER,
    };
    use std::fs;
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};
    use url::Url;

    #[tokio::test]
    async fn waits_for_loading_window_before_deciding_whether_to_reuse_it() {
        let configured = parse_comfyui_url("http://127.0.0.1:8188").unwrap();
        let mut states = std::collections::VecDeque::from([
            Url::parse("about:blank").unwrap(),
            parse_comfyui_url("http://127.0.0.1:8188/?workflow=draft").unwrap(),
        ]);
        let current = wait_for_comfyui_window_state(
            || {
                let current = states.pop_front().unwrap();
                Ok((current.as_str() != "about:blank").then_some(current))
            },
            std::time::Duration::from_secs(1),
            "仍在加载",
        )
        .await
        .unwrap();
        assert!(is_same_comfyui_origin(&current, &configured));
        assert!(states.is_empty());
    }

    #[tokio::test]
    async fn loading_window_state_times_out() {
        let result = wait_for_comfyui_window_state::<Url>(
            || Ok(None),
            std::time::Duration::from_millis(1),
            "ComfyUI 窗口仍在加载，请稍后重试",
        )
        .await;
        assert_eq!(result.unwrap_err(), "ComfyUI 窗口仍在加载，请稍后重试");
    }

    #[tokio::test]
    async fn waits_until_the_old_webview_is_unregistered() {
        // 关闭请求已返回，但管理器在后续事件循环才移除同名 WebView。
        let mut registered = std::collections::VecDeque::from([true, true, false]);
        wait_for_comfyui_window_state(
            || Ok((!registered.pop_front().unwrap()).then_some(())),
            std::time::Duration::from_secs(1),
            "尚未关闭",
        )
        .await
        .unwrap();
        assert!(registered.is_empty());
    }

    #[tokio::test]
    async fn waiting_for_unregistration_times_out_when_close_is_cancelled() {
        let result = wait_for_comfyui_window_state::<()>(
            || Ok(None),
            std::time::Duration::from_millis(1),
            "旧 ComfyUI 窗口尚未关闭，请先关闭该窗口后重试",
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "旧 ComfyUI 窗口尚未关闭，请先关闭该窗口后重试"
        );
    }

    #[tokio::test]
    async fn stops_when_window_state_cannot_be_read() {
        let result = wait_for_comfyui_window_state::<Url>(
            || Err("窗口已销毁".to_string()),
            std::time::Duration::from_secs(1),
            "等待超时",
        )
        .await;
        assert_eq!(result.unwrap_err(), "窗口已销毁");
    }

    #[test]
    fn reuses_window_when_only_the_frontend_route_changed() {
        let configured = parse_comfyui_url("http://127.0.0.1:8188").unwrap();
        // ComfyUI 前端自己改过路径/查询串，仍然是同一个服务，不该销毁重建窗口
        for current in [
            "http://127.0.0.1:8188/",
            "http://127.0.0.1:8188/?workflow=demo",
            "http://127.0.0.1:8188/templates#browse",
        ] {
            assert!(is_same_comfyui_origin(
                &parse_comfyui_url(current).unwrap(),
                &configured
            ));
        }
        // 换了端口或主机才算换了服务
        assert!(!is_same_comfyui_origin(
            &parse_comfyui_url("http://127.0.0.1:8189").unwrap(),
            &configured
        ));
        assert!(!is_same_comfyui_origin(
            &parse_comfyui_url("http://comfy.example.com:8188").unwrap(),
            &configured
        ));
    }

    #[test]
    fn accepts_http_and_https_comfyui_urls() {
        assert!(parse_comfyui_url("http://127.0.0.1:8188").is_ok());
        assert!(parse_comfyui_url("https://comfy.example.com/ui").is_ok());
    }

    #[test]
    fn rejects_non_http_comfyui_urls() {
        assert!(parse_comfyui_url("javascript:alert(1)").is_err());
        assert!(parse_comfyui_url("file:///tmp/comfyui").is_err());
        assert!(parse_comfyui_url("not-a-url").is_err());
    }

    #[test]
    fn probes_connectivity_only_for_loopback_urls() {
        assert!(is_local_comfyui_url(
            &parse_comfyui_url("http://127.0.0.1:8188").unwrap()
        ));
        assert!(is_local_comfyui_url(
            &parse_comfyui_url("https://localhost:8188").unwrap()
        ));
        assert!(!is_local_comfyui_url(
            &parse_comfyui_url("https://comfy.example.com").unwrap()
        ));
    }

    #[test]
    fn resolves_comfyui_socket_ports() {
        assert_eq!(
            comfyui_socket_endpoint(&parse_comfyui_url("http://127.0.0.1:8188").unwrap()).unwrap(),
            ("127.0.0.1".to_string(), 8188)
        );
        assert_eq!(
            comfyui_socket_endpoint(&parse_comfyui_url("https://localhost").unwrap()).unwrap(),
            ("localhost".to_string(), 443)
        );
    }

    #[tokio::test]
    async fn reports_when_local_comfyui_is_not_listening() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("应能占用本地临时端口");
        let port = listener.local_addr().unwrap().port();
        let url = parse_comfyui_url(&format!("http://127.0.0.1:{port}")).unwrap();

        assert!(ensure_local_comfyui_reachable(&url).await.is_ok());
        drop(listener);

        let error = ensure_local_comfyui_reachable(&url).await.unwrap_err();
        assert!(error.contains("请先启动 ComfyUI"));
    }

    #[test]
    fn safely_serializes_editor_payload() {
        let script = build_editor_script(
            Some("open-test-1"),
            Some("wf-1"),
            Some("引号\"与换行\n测试"),
            Some("ai-image"),
            Some("workflow.json"),
            Some(r#"{"1":{"class_type":"SaveImage","inputs":{}}}"#),
            None,
        )
        .unwrap()
        .unwrap();
        assert!(script.contains("window.__AI_CANVAS_PENDING_WORKFLOW__="));
        assert!(script.contains("open-test-1"));
        assert!(script.contains(r#"引号\"与换行\n测试"#));
    }

    #[test]
    fn editor_load_requires_matching_request_and_nonempty_canvas() {
        assert!(parse_editor_load_result("null", "open-a")
            .unwrap()
            .is_none());
        assert!(
            parse_editor_load_result(r#"{"requestId":"open-a","state":"loading"}"#, "open-a")
                .unwrap()
                .is_none()
        );
        let ready = r#"{"requestId":"open-a","state":"ready","nodeCount":4,"source":"existing","detail":"已切换"}"#;
        assert_eq!(
            parse_editor_load_result(ready, "open-a")
                .unwrap()
                .unwrap()
                .node_count,
            4
        );
        assert!(parse_editor_load_result(ready, "open-b").is_err());
        assert!(parse_editor_load_result(
            &ready.replace("\"nodeCount\":4", "\"nodeCount\":0"),
            "open-a"
        )
        .is_err());
        assert_eq!(
            parse_editor_load_result(
                r#"{"requestId":"open-a","state":"error","detail":"缺少节点"}"#,
                "open-a"
            )
            .unwrap_err(),
            "缺少节点"
        );
    }

    #[test]
    fn accepts_only_same_origin_window_actions() {
        let comfy_url = parse_comfyui_url("http://127.0.0.1:8188").unwrap();
        let close_url =
            parse_comfyui_url("http://127.0.0.1:8188/__ai_canvas_comfy_action__?action=close")
                .unwrap();
        assert_eq!(
            parse_comfyui_window_action(&close_url, &comfy_url),
            Some(ComfyUIWindowAction::Close)
        );

        let wrong_origin =
            parse_comfyui_url("http://localhost:8188/__ai_canvas_comfy_action__?action=close")
                .unwrap();
        assert_eq!(parse_comfyui_window_action(&wrong_origin, &comfy_url), None);
        let unknown_action =
            parse_comfyui_url("http://127.0.0.1:8188/__ai_canvas_comfy_action__?action=destroy")
                .unwrap();
        assert_eq!(
            parse_comfyui_window_action(&unknown_action, &comfy_url),
            None
        );
    }

    #[test]
    fn remote_window_actions_require_the_configured_origin() {
        let configured = parse_comfyui_url("https://comfy.example.com/comfy/").unwrap();
        let save =
            parse_comfyui_url("https://comfy.example.com/__ai_canvas_comfy_action__?action=save")
                .unwrap();
        assert_eq!(
            parse_comfyui_window_action(&save, &configured),
            Some(ComfyUIWindowAction::Save)
        );
        for other in [
            "https://other.example.com/__ai_canvas_comfy_action__?action=save",
            "http://comfy.example.com/__ai_canvas_comfy_action__?action=save",
            "https://comfy.example.com:8443/__ai_canvas_comfy_action__?action=save",
        ] {
            assert_eq!(
                parse_comfyui_window_action(&parse_comfyui_url(other).unwrap(), &configured),
                None
            );
        }
    }

    #[test]
    fn scopes_bridge_and_workflow_payload_to_the_configured_top_level_origin() {
        let url = parse_comfyui_url("https://comfy.example.com/comfy/?token=private").unwrap();
        let script = scope_comfyui_script(&url, "window.__AI_CANVAS_PENDING_WORKFLOW__ = {};");
        assert!(script.contains("const aiCanvasComfyOrigin = \"https://comfy.example.com\""));
        assert!(script.contains("window.top !== window"));
        assert!(script.contains("window.location.origin !== aiCanvasComfyOrigin) return;"));
        assert!(!script.contains("token=private"));
        assert!(
            script.find("return;").unwrap()
                < script.find("window.__AI_CANVAS_PENDING_WORKFLOW__").unwrap()
        );
    }

    #[test]
    fn validates_workflow_payload_from_comfyui_webview() {
        let valid = serde_json::json!({
            "requestId": "save-test-1",
            "workflowId": "wf-1",
            "name": "测试工作流",
            "category": "ai-image",
            "fileName": "workflow.json",
            "fileContent": "{}",
            "editableContent": "{}"
        });
        assert!(parse_workflow_save_payload(&valid.to_string()).is_ok());

        let mut invalid_category = valid.clone();
        invalid_category["category"] = serde_json::Value::String("unknown".to_string());
        assert!(parse_workflow_save_payload(&invalid_category.to_string()).is_err());

        let mut invalid_workflow = valid;
        invalid_workflow["fileContent"] = serde_json::Value::String("not-json".to_string());
        assert!(parse_workflow_save_payload(&invalid_workflow.to_string()).is_err());

        let mut invalid_request_id = serde_json::json!({
            "requestId": "request-without-save-prefix",
            "workflowId": "wf-1",
            "name": "测试工作流",
            "category": "ai-image",
            "fileName": "workflow.json",
            "fileContent": "{}",
            "editableContent": "{}"
        });
        assert!(parse_workflow_save_payload(&invalid_request_id.to_string()).is_err());
        invalid_request_id["requestId"] = serde_json::Value::String("save-valid".to_string());
        assert!(parse_workflow_save_payload(&invalid_request_id.to_string()).is_ok());
    }

    #[test]
    fn binds_comfyui_http_api_to_loopback_only() {
        assert!(COMFY_ARGS
            .windows(2)
            .any(|args| args == ["--listen", "127.0.0.1"]));
    }

    #[test]
    fn enables_fast_disk_only_for_an_opted_in_supported_installation() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ai-canvas-comfy-fast-disk-{unique}"));
        let comfy_dir = root.join("comfy");
        fs::create_dir_all(&comfy_dir).unwrap();
        fs::write(
            comfy_dir.join("cli_args.py"),
            "parser.add_argument('--listen')\nparser.add_argument('--enable-cors-header')\nparser.add_argument('--port')\nparser.add_argument('--fast-disk')",
        )
        .unwrap();

        let settings = ComfyUILaunchSettings::default();
        assert!(!build_comfy_args(&root, &root, &settings)
            .unwrap()
            .contains(&"--fast-disk".to_string()));
        fs::write(root.join(FAST_DISK_MARKER), "enabled\n").unwrap();
        assert!(build_comfy_args(&root, &root, &settings)
            .unwrap()
            .contains(&"--fast-disk".to_string()));

        fs::write(
            comfy_dir.join("cli_args.py"),
            "parser.add_argument('--listen')\nparser.add_argument('--enable-cors-header')\nparser.add_argument('--port')",
        )
        .unwrap();
        assert!(!build_comfy_args(&root, &root, &settings)
            .unwrap()
            .contains(&"--fast-disk".to_string()));
        fs::remove_dir_all(root).unwrap();
    }
}
