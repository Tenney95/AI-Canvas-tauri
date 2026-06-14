/// ComfyUI 启动逻辑
/// 支持多种 ComfyUI 发行版：官方版（.bat）、秋叶整合包（python/main.py）、便携版（python_embeded）
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x00000010; // 在新控制台窗口打开
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;   // 静默执行，不创建窗口

/// 在 Windows 新终端窗口中启动 ComfyUI
fn launch_windows(comfy_path: &str) -> Result<String, String> {
    let root = Path::new(comfy_path);

    // 1) 标准 portable 版：run_nvidia_gpu.bat / run_cpu.bat / run.bat
    for script in &["run_nvidia_gpu.bat", "run_cpu.bat", "run.bat"] {
        let script_path = root.join(script);
        if script_path.is_file() {
            return run_bat_script(&script_path);
        }
    }

    // 2) 秋叶整合包启动器（优先使用，自带完整环境配置）
    // 秋叶 v1.x: ComfyUi.exe（根目录）
    // 秋叶旧版: A启动器.exe
    for launcher in &["ComfyUi.exe", "A启动器.exe", "启动器.exe"] {
        let launcher_path = root.join(launcher);
        if launcher_path.is_file() {
            return run_exe_new_console(&launcher_path);
        }
    }

    // 2.1) 秋叶启动器框架（.launcher 子目录）
    {
        let sdui_launcher = root.join(".launcher").join("StableDiffusionWebUILauncher.exe");
        if sdui_launcher.is_file() {
            return run_exe_new_console(&sdui_launcher);
        }
    }

    // 3) 智能检测 main.py 的位置（适配秋叶包的嵌套结构：root/ComfyUI/main.py）
    let working_dir = if root.join("main.py").is_file() {
        root.to_path_buf()
    } else if root.join("ComfyUI").join("main.py").is_file() {
        root.join("ComfyUI")
    } else {
        return Err(format!(
            "在目录 {} 中未找到 ComfyUI 启动脚本。\n\
             请确认该目录是 ComfyUI 的安装根目录，且包含 main.py 或内含 ComfyUI/main.py。",
            comfy_path
        ));
    };

    // 4) 查找 Python 解释器（同时检测当前工作目录和外层根目录）
    let python = find_python(&working_dir, root).ok_or_else(|| {
        format!(
            "未找到 Python 解释器。\n\
             请确认目录 {} 中包含 python/python.exe 或 python_embeded/python.exe。",
            comfy_path
        )
    })?;

    // 5) 在新控制台窗口中通过 cd && python 启动
    // -s: 禁用 user site-packages（秋叶包标准启动方式，避免与系统包冲突）
    spawn_new_console(&python, &["-s", "main.py", "--listen"], &working_dir)?;

    Ok("ComfyUI 已启动".into())
}

/// 在新控制台窗口执行 .bat 脚本（使用 cd /d 链式调用避开 CMD 双引号 Bug）
#[cfg(windows)]
fn run_bat_script(script_path: &Path) -> Result<String, String> {
    let dir = script_path
        .parent()
        .ok_or_else(|| "无法获取脚本所在目录".to_string())?;
        
    let script_str = script_path.to_string_lossy().replace('/', "\\");
    let dir_str = dir.to_string_lossy().replace('/', "\\");

    let mut cmd = Command::new("cmd");
    cmd.creation_flags(CREATE_NEW_CONSOLE);
    
    // 利用 cd /d 规避 CMD 头部双引号截断
    let cmd_line = format!(
        "/c cd /d \"{}\" && \"{}\"",
        dir_str,
        script_str
    );
    cmd.raw_arg(&cmd_line);

    cmd.spawn()
        .map_err(|e| format!("启动 ComfyUI 失败: {e}"))?;

    Ok("ComfyUI 已启动".into())
}

/// 在新控制台窗口直接启动 .exe（如秋叶 A启动器.exe）
#[cfg(windows)]
fn run_exe_new_console(exe_path: &Path) -> Result<String, String> {
    let dir = exe_path
        .parent()
        .ok_or_else(|| "无法获取程序所在目录".to_string())?;

    let exe_str = exe_path.to_string_lossy().replace('/', "\\");
    let dir_str = dir.to_string_lossy().replace('/', "\\");

    let mut cmd = Command::new("cmd");
    cmd.creation_flags(CREATE_NEW_CONSOLE);

    let cmd_line = format!(
        "/c cd /d \"{}\" && \"{}\"",
        dir_str,
        exe_str
    );
    cmd.raw_arg(&cmd_line);

    cmd.spawn()
        .map_err(|e| format!("启动秋叶启动器失败: {e}"))?;

    Ok("ComfyUI 启动器已启动".into())
}

/// 用 cmd /k 在新控制台启动进程 —— 并在进程崩溃时保持窗口开启以供排错
#[cfg(windows)]
fn spawn_new_console(program: &str, args: &[&str], working_dir: &Path) -> Result<(), String> {
    let mut cmd = Command::new("cmd");
    cmd.creation_flags(CREATE_NEW_CONSOLE);

    let dir_str = working_dir.to_string_lossy().replace('/', "\\");
    let program_normalized = program.replace('/', "\\");
    
    // 核心修复：
    // 通过 /k cd /d "目录" && "python" main.py 的连写方式，
    // 命令开头为字母 c 而非双引号，彻底绕过了 CMD 的剥离双引号 Bug，100% 稳定运行。
    let cmd_line = format!(
        "/k cd /d \"{}\" && \"{}\" {}",
        dir_str,
        program_normalized,
        args.join(" ")
    );
    cmd.raw_arg(&cmd_line);

    cmd.spawn()
        .map_err(|e| format!("启动 ComfyUI 失败: {e}"))?;

    Ok(())
}

/// 非 Windows 版本的 Fallback
#[cfg(not(windows))]
fn run_bat_script(_script_path: &Path) -> Result<String, String> {
    Err("bat 脚本仅支持 Windows".into())
}

#[cfg(not(windows))]
fn spawn_new_console(_program: &str, _args: &[&str], _working_dir: &Path) -> Result<(), String> {
    Err("新控制台仅支持 Windows".into())
}

/// 非 Windows 系统（Unix / macOS）：直接在当前进程后台启动
fn launch_unix(comfy_path: &str) -> Result<String, String> {
    let root = Path::new(comfy_path);

    let working_dir = if root.join("main.py").is_file() {
        root.to_path_buf()
    } else if root.join("ComfyUI").join("main.py").is_file() {
        root.join("ComfyUI")
    } else {
        return Err(format!("在目录 {} 中未找到 main.py。", comfy_path));
    };

    let python = find_python(&working_dir, root).unwrap_or_else(|| "python3".to_string());

    Command::new(&python)
        .arg("main.py")
        .current_dir(working_dir)
        .spawn()
        .map_err(|e| format!("启动 ComfyUI 失败: {e}"))?;

    Ok("ComfyUI 已启动".into())
}

/// 安全查找 Python 解释器（适配秋叶包的嵌套结构）
fn find_python(working_dir: &Path, root: &Path) -> Option<String> {
    // 智能检测列表：同时考虑当前工作目录和外层根目录
    let candidates = [
        // 1. 基于当前工作目录（如 comfy_path/ComfyUI/）
        working_dir.join("python_embeded").join("python.exe"),
        working_dir.join("python_embedded").join("python.exe"),
        working_dir.join("python").join("python.exe"),
        working_dir.join("venv").join("Scripts").join("python.exe"),
        
        // 2. 基于外层根目录（如秋叶包 root/python/python.exe）
        root.join("python_embeded").join("python.exe"),
        root.join("python_embedded").join("python.exe"),
        root.join("python").join("python.exe"),
        root.join("venv").join("Scripts").join("python.exe"),

        // Unix 候选
        working_dir.join("venv").join("bin").join("python"),
        root.join("venv").join("bin").join("python"),
    ];

    for p in &candidates {
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }

    // 3. 检测系统全局环境变量中的 Python
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

/// Tauri command: 启动 ComfyUI
#[tauri::command]
pub async fn launch_comfyui(comfy_path: String) -> Result<String, String> {
    let path = Path::new(&comfy_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("ComfyUI 目录不存在: {}", comfy_path));
    }

    if cfg!(windows) {
        launch_windows(&comfy_path)
    } else {
        launch_unix(&comfy_path)
    }
}