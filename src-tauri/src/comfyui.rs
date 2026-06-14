/// ComfyUI 启动逻辑
/// 支持多种 ComfyUI 发行版：官方版（.bat）、秋叶整合包（python/main.py）、便携版（python_embeded）
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志：在新控制台窗口打开
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x00000010;

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

    // 2) 确认 main.py 存在
    let main_py = root.join("main.py");
    if !main_py.is_file() {
        return Err(format!(
            "在目录 {} 中未找到 ComfyUI 启动脚本。\n\
             请确认该目录是 ComfyUI 的安装根目录，\
             且包含 run_nvidia_gpu.bat / run_cpu.bat 或 main.py。",
            comfy_path
        ));
    }

    // 3) 查找 Python 解释器
    let python = find_python(root).ok_or_else(|| {
        format!(
            "未找到 Python 解释器。\n\
             请确认目录 {} 中包含 python/python.exe 或 python_embeded/python.exe。",
            comfy_path
        )
    })?;

    // 4) 在新控制台窗口中直接启动 python main.py（不经过 cmd /c start）
    spawn_new_console(&python, &["main.py", "--skip-manager-update"], Some(comfy_path))?;

    Ok("ComfyUI 已启动".into())
}

/// 在新控制台窗口执行 .bat 脚本
#[cfg(windows)]
fn run_bat_script(script_path: &Path) -> Result<String, String> {
    let dir = script_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let script = script_path.to_string_lossy().to_string();
    // cmd /c 运行 .bat，用 CREATE_NEW_CONSOLE 开新窗口，bat 跑完窗口留给 ComfyUI
    Command::new("cmd")
        .args(["/c", &script])
        .current_dir(&dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|e| format!("启动 ComfyUI 失败: {e}"))?;
    Ok("ComfyUI 已启动".into())
}

/// 用 cmd /k 在新控制台启动进程 —— /k 保活窗口，进程崩溃时用户能看到错误
/// cmd /k 要求命令是单个字符串，不能拆成多个 args
#[cfg(windows)]
fn spawn_new_console(program: &str, args: &[&str], working_dir: Option<&str>) -> Result<(), String> {
    // cmd /k "program" arg1 arg2 — 拼成单个命令字符串
    let cmd_line = format!("\"{}\" {}", program, args.join(" "));
    let mut cmd = Command::new("cmd");
    cmd.arg("/k");
    cmd.raw_arg(&cmd_line);
    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }
    cmd.creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|e| format!("启动 ComfyUI 失败: {e}"))?;
    Ok(())
}

/// 非 Windows 版本（fallback，不会在 Windows 上编译）
#[cfg(not(windows))]
fn run_bat_script(_script_path: &Path) -> Result<String, String> {
    Err("bat 脚本仅支持 Windows".into())
}

#[cfg(not(windows))]
fn spawn_new_console(_program: &str, _args: &[&str], _working_dir: Option<&str>) -> Result<(), String> {
    Err("新控制台仅支持 Windows".into())
}

/// 非 Windows：直接在当前终端启动
fn launch_unix(comfy_path: &str) -> Result<String, String> {
    let root = Path::new(comfy_path);

    let main_py = root.join("main.py");
    if !main_py.is_file() {
        return Err(format!(
            "在目录 {} 中未找到 main.py。",
            comfy_path
        ));
    }

    let python = find_python(root).unwrap_or_else(|| "python".to_string());

    Command::new(&python)
        .arg("main.py")
        .current_dir(comfy_path)
        .spawn()
        .map_err(|e| format!("启动 ComfyUI 失败: {e}"))?;

    Ok("ComfyUI 已启动".into())
}

/// 在目录中查找 Python 解释器（按优先级，必须 is_file 而非 is_dir）
fn find_python(root: &Path) -> Option<String> {
    // 捆绑 Python（全路径，必须是文件）
    for c in &[
        "python/python.exe",        // 秋叶整合包
        "python_embeded/python.exe", // portable 版
        "python_embeded/python",     // Linux portable
    ] {
        let p = root.join(c);
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }

    // 系统 Python（PATH 查找，不 join root）
    for name in &["python3", "python"] {
        if Command::new(name)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
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
