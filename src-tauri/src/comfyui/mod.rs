/// ComfyUI 启动逻辑
///
/// 统一策略：优先定位 main.py 与配套 Python 解释器**直接启动**——只有这样才能
/// 注入 API 参数，并绕过整合包启动器的环境/custom_nodes 检测（秋叶启动器每次
/// 启动都会做插件校验，用户要求跳过）。bat 脚本与启动器 exe 仅作兜底。
///
/// 兼容三类发行版（均以实机目录结构验证）：
///  · GitHub 原生 / 秋叶整合包：<root>/main.py（秋叶 Python 在 <root>/python/）
///  · 官方便携版：<root>/ComfyUI/main.py + <root>/python_embeded/
///  · 官方 Comfy Desktop（v0.20+）：<base>/ComfyUI-Installs/ComfyUI/ComfyUI/main.py，
///    venv 在同目录 .venv/；用户可能选 <base> 或 <base>/Comfy Desktop（Electron 安装目录）
///
/// 启动参数：--listen 开放 HTTP API；--enable-cors-header 允许跨源（本应用打包后
/// 从 tauri://localhost 直连 ComfyUI 必需）。GPU 无需参数——CUDA 可用时默认启用，
/// 三种发行版的 Python 环境都自带 CUDA 版 torch（兜底 bat 亦优先 run_nvidia_gpu.bat）。
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 直接启动 main.py 的统一参数（API 模式）
/// -u：禁用 Python 输出缓冲，否则新开的终端窗口长时间黑屏看不到启动日志
const COMFY_ARGS: &[&str] = &["-u", "-s", "main.py", "--listen", "--enable-cors-header"];

/// 定位 main.py 所在目录（即启动工作目录）
fn find_main_py(root: &Path) -> Option<PathBuf> {
    let candidates = [
        // GitHub 原生 / 秋叶整合包：根目录即源码
        root.to_path_buf(),
        // 官方便携版：ComfyUI 子目录
        root.join("ComfyUI"),
        // Comfy Desktop v0.20+：用户选择了基目录（如 F:\ComfyUI）
        root.join("ComfyUI-Installs").join("ComfyUI").join("ComfyUI"),
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

/// 在 Windows 新终端窗口中启动 ComfyUI
#[cfg(windows)]
fn launch_windows(comfy_path: &str) -> Result<String, String> {
    let root = Path::new(comfy_path);

    // 1) 首选：直接启动 main.py —— 可注入 API/CORS 参数，跳过启动器的 custom_nodes 检测
    if let Some(working_dir) = find_main_py(root) {
        if let Some(python) = find_python(&working_dir, root) {
            spawn_new_console(&python, COMFY_ARGS, &working_dir)?;
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
        root.join(".launcher").join("StableDiffusionWebUILauncher.exe"),
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
fn spawn_new_console(program: &str, args: &[&str], working_dir: &Path) -> Result<(), String> {
    let program_normalized = program.replace('/', "\\");
    let inner = format!(
        r#"cmd /k ""{}" {}""#,
        program_normalized,
        args.join(" ")
    );
    start_new_console(&inner, working_dir, "启动 ComfyUI 失败")
}

/// 非 Windows 系统
#[cfg(not(windows))]
fn launch_unix(comfy_path: &str) -> Result<String, String> {
    let root = Path::new(comfy_path);

    let working_dir = find_main_py(root)
        .ok_or_else(|| format!("在目录 {} 中未找到 main.py。", comfy_path))?;

    let python = find_python(&working_dir, root).unwrap_or_else(|| "python3".to_string());

    Command::new(&python)
        .args(COMFY_ARGS)
        .current_dir(&working_dir)
        .spawn()
        .map_err(|e| format!("启动 ComfyUI 失败: {e}"))?;

    Ok("ComfyUI 已启动（API 模式）".into())
}

/// Tauri command: 启动 ComfyUI
#[tauri::command]
pub async fn launch_comfyui(comfy_path: String) -> Result<String, String> {
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
