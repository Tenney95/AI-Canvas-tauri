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
//! 启动参数：--listen 开放 HTTP API；--enable-cors-header 允许跨源（本应用打包后
//! 从 tauri://localhost 直连 ComfyUI 必需）。GPU 无需参数——CUDA 可用时默认启用，
//! 三种发行版的 Python 环境都自带 CUDA 版 torch（兜底 bat 亦优先 run_nvidia_gpu.bat）。
use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
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
const COMFYUI_BRIDGE_SCRIPT: &str = include_str!("bridge.js");
const MAX_WORKFLOW_JSON_LENGTH: usize = 16 * 1024 * 1024;
const COMFYUI_ACTION_PATH: &str = "/__ai_canvas_comfy_action__";
const COMFYUI_CONNECT_TIMEOUT: Duration = Duration::from_millis(700);
const TAKE_SAVE_PAYLOAD_SCRIPT: &str = r#"(() => {
  const payload = window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__ ?? null;
  delete window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__;
  return payload;
})()"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComfyUIEditorPayload<'a> {
    workflow_id: Option<&'a str>,
    workflow_name: Option<&'a str>,
    workflow_category: Option<&'a str>,
    workflow_file_name: Option<&'a str>,
    api_json: &'a str,
    editable_json: Option<&'a str>,
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
    if api_json.len() > MAX_WORKFLOW_JSON_LENGTH
        || editable_json.is_some_and(|json| json.len() > MAX_WORKFLOW_JSON_LENGTH)
    {
        return Err("ComfyUI 工作流超过 16 MiB 上限".to_string());
    }
    serde_json::from_str::<serde_json::Value>(api_json)
        .map_err(|_| "ComfyUI API 工作流 JSON 无效".to_string())?;
    if let Some(editable_json) = editable_json {
        serde_json::from_str::<serde_json::Value>(editable_json)
            .map_err(|_| "ComfyUI 可编辑工作流 JSON 无效".to_string())?;
    }

    let payload = ComfyUIEditorPayload {
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
        // Comfy Desktop v0.20+：用户选择了 Electron 安装目录（如 F:\ComfyUI\Comfy Desktop）
        root.parent()
            .map(|p| p.join("ComfyUI-Installs").join("ComfyUI").join("ComfyUI"))
            .unwrap_or_default(),
        // 旧版 Comfy Desktop（≤v0.4）：源码打包在 resources 下
        root.join("resources").join("ComfyUI"),
    ];
    candidates.into_iter().find(|d| d.join("main.py").is_file())
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

fn build_comfy_args(root: &Path, working_dir: &Path) -> Vec<String> {
    let mut args: Vec<String> = COMFY_ARGS.iter().map(|arg| (*arg).to_string()).collect();

    if let Some(shared_model_paths) = find_comfy_desktop_shared_model_paths(root, working_dir) {
        args.push("--extra-model-paths-config".to_string());
        args.push(shared_model_paths.to_string_lossy().into_owned());
    }

    args
}

/// 在 Windows 新终端窗口中启动 ComfyUI
#[cfg(windows)]
fn launch_windows(comfy_path: &str) -> Result<String, String> {
    let root = Path::new(comfy_path);

    // 1) 首选：直接启动 main.py —— 可注入 API/CORS 参数，跳过启动器的 custom_nodes 检测
    if let Some(working_dir) = find_main_py(root) {
        if let Some(python) = find_python(&working_dir, root) {
            let args = build_comfy_args(root, &working_dir);
            spawn_new_console(&python, &args, &working_dir)?;
            return Ok(format!(
                "ComfyUI 已启动（API 模式）\n{}",
                working_dir.display()
            ));
        }
    }

    // 2) 兜底：便携版 bat（GPU 优先）
    for script in &["run_nvidia_gpu.bat", "run.bat", "run_cpu.bat"] {
        let script_path = root.join(script);
        if script_path.is_file() {
            return run_bat_script(&script_path);
        }
    }

    // 3) 兜底：启动器 exe（秋叶启动器 / Comfy Desktop Electron）
    let launchers = [
        root.join("ComfyUi.exe"),
        root.join("A启动器.exe"),
        root.join("启动器.exe"),
        root.join("Comfy Desktop.exe"),
        root.join(".launcher")
            .join("StableDiffusionWebUILauncher.exe"),
    ];
    for launcher_path in &launchers {
        if launcher_path.is_file() {
            return run_exe_new_console(launcher_path);
        }
    }

    Err(format!(
        "在目录 {} 中未找到 ComfyUI。\n\
         支持：GitHub 源码版 / 秋叶整合包（含 main.py）、官方便携版（ComfyUI/main.py）、\n\
         官方 Comfy Desktop（选择安装基目录，如 F:\\ComfyUI）。",
        comfy_path
    ))
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

/// 用 cmd /k 在新控制台启动进程（保留窗口以便查看服务日志）
#[cfg(windows)]
fn spawn_new_console(program: &str, args: &[String], working_dir: &Path) -> Result<(), String> {
    let program_normalized = program.replace('/', "\\");
    let args_joined = args
        .iter()
        .map(|arg| quote_cmd_arg(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let inner = format!(r#"cmd /k ""{}" {}""#, program_normalized, args_joined);
    start_new_console(&inner, working_dir, "启动 ComfyUI 失败")
}

#[cfg(windows)]
fn quote_cmd_arg(arg: &str) -> String {
    if arg.is_empty() || arg.contains([' ', '\t', '"']) {
        format!(r#""{}""#, arg.replace('"', r#"\""#))
    } else {
        arg.to_string()
    }
}

/// 非 Windows 系统
#[cfg(not(windows))]
fn launch_unix(comfy_path: &str) -> Result<String, String> {
    let root = Path::new(comfy_path);

    let working_dir =
        find_main_py(root).ok_or_else(|| format!("在目录 {} 中未找到 main.py。", comfy_path))?;

    let python = find_python(&working_dir, root).unwrap_or_else(|| "python3".to_string());

    let args = build_comfy_args(root, &working_dir);

    Command::new(&python)
        .args(args)
        .current_dir(&working_dir)
        .spawn()
        .map_err(|e| format!("启动 ComfyUI 失败: {e}"))?;

    Ok("ComfyUI 已启动（API 模式）".into())
}

/// Tauri command: 启动 ComfyUI
#[tauri::command]
pub async fn launch_comfyui(webview: tauri::Webview, comfy_path: String) -> Result<String, String> {
    // 只有自有本地窗口能触发进程启动；目录内容仍由下面的已知文件名探测约束。
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let path = Path::new(&comfy_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("ComfyUI 目录不存在: {}", comfy_path));
    }

    #[cfg(windows)]
    {
        launch_windows(&comfy_path)
    }

    #[cfg(not(windows))]
    {
        launch_unix(&comfy_path)
    }
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

/// Tauri command: 在应用内的独立 Webview 窗口中打开 ComfyUI 页面。
#[tauri::command]
pub async fn open_comfyui_window(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    comfy_url: String,
    workflow_id: Option<String>,
    workflow_name: Option<String>,
    workflow_category: Option<String>,
    workflow_file_name: Option<String>,
    api_json: Option<String>,
    editable_json: Option<String>,
) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let url = parse_comfyui_url(&comfy_url)?;
    let use_local_bridge = is_local_comfyui_url(&url);
    if use_local_bridge {
        if let Err(error) = ensure_local_comfyui_reachable(&url).await {
            if let Some(window) = app.get_webview_window(COMFYUI_WINDOW_LABEL) {
                let _ = window.close();
            }
            return Err(error);
        }
    }
    let editor_script = build_editor_script(
        workflow_id.as_deref(),
        workflow_name.as_deref(),
        workflow_category.as_deref(),
        workflow_file_name.as_deref(),
        api_json.as_deref(),
        editable_json.as_deref(),
    )?;

    if let Some(window) = app.get_webview_window(COMFYUI_WINDOW_LABEL) {
        // 只要还是同一个 ComfyUI 服务就复用窗口：前端自己改过的路径/查询串不算“换了地址”
        if window
            .url()
            .is_ok_and(|current| is_same_comfyui_origin(&current, &url))
        {
            window
                .set_decorations(!use_local_bridge)
                .map_err(|e| format!("更新 ComfyUI 标题栏失败: {e}"))?;
            if let Some(script) = editor_script {
                window
                    .eval(&script)
                    .map_err(|e| format!("载入 ComfyUI 工作流失败: {e}"))?;
            }
            let _ = window.unminimize();
            window
                .show()
                .map_err(|e| format!("显示 ComfyUI 窗口失败: {e}"))?;
            window
                .set_focus()
                .map_err(|e| format!("聚焦 ComfyUI 窗口失败: {e}"))?;
            return Ok(());
        }
        window
            .close()
            .map_err(|e| format!("关闭旧 ComfyUI 窗口失败: {e}"))?;
    }

    let mut initialization_script = String::new();
    if use_local_bridge {
        initialization_script.push_str(COMFYUI_BRIDGE_SCRIPT);
    }
    if let Some(script) = editor_script {
        initialization_script.push_str(&script);
    }

    let action_origin = url.clone();
    let page_origin = url.clone();
    let mut builder =
        WebviewWindowBuilder::new(&app, COMFYUI_WINDOW_LABEL, WebviewUrl::External(url))
            .title("ComfyUI")
            .inner_size(1280.0, 820.0)
            .min_inner_size(900.0, 600.0)
            .center()
            .resizable(true)
            // 本地页面加载完成前保留原生标题栏；连接异常时窗口仍有系统关闭按钮。
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
    if use_local_bridge {
        let navigation_app = app.clone();
        builder = builder.on_navigation(move |navigation_url| {
            let Some(action) = parse_comfyui_window_action(navigation_url, &action_origin) else {
                return true;
            };
            let action_app = navigation_app.clone();
            let _ = navigation_app.run_on_main_thread(move || {
                let _ = handle_comfyui_window_action(&action_app, action);
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
    if !initialization_script.is_empty() {
        builder = builder.initialization_script(&initialization_script);
    }
    builder
        .build()
        .map_err(|e| format!("创建 ComfyUI 窗口失败: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_editor_script, comfyui_socket_endpoint, ensure_local_comfyui_reachable,
        is_local_comfyui_url, is_same_comfyui_origin, parse_comfyui_url,
        parse_comfyui_window_action, parse_workflow_save_payload, ComfyUIWindowAction, COMFY_ARGS,
    };
    use std::net::TcpListener;

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
    fn enables_bridge_only_for_loopback_urls() {
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
        assert!(script.contains(r#"引号\"与换行\n测试"#));
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
}
