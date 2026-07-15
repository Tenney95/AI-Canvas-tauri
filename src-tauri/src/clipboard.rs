//! clipboard.rs — 系统剪贴板文件写入（三平台实现）
//!
//! 提供 `copy_files_to_clipboard` Tauri 命令，将一组本地文件路径写入系统剪贴板。
//! - Windows: CF_HDROP（DirectX 剪贴板，可在资源管理器/聊天中粘贴）
//! - macOS: osascript AppleScript（内置，无额外依赖）
//! - Linux: X11 用 xclip，Wayland 用 wl-copy（系统工具，需安装）

use std::path::Path;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;

/// Windows CF_HDROP 常量。
#[cfg(target_os = "windows")]
const CF_HDROP: u32 = 15;

/// Windows DROPFILES 结构体（与 SDK 一致），紧随其后为宽字符路径列表。
#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct DropFiles {
    p_files: u32,
    pt_x: i32,
    pt_y: i32,
    f_nc: i32,
    f_wide: i32,
}

// ── Windows 实现 ──
#[cfg(target_os = "windows")]
fn copy_files_impl(paths: &[String]) -> Result<(), String> {
    use std::mem::size_of;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let mut wide_bytes: Vec<u8> = Vec::new();
    for p in paths {
        let abs = Path::new(p)
            .canonicalize()
            .map_err(|e| format!("路径无效 {}: {e}", p))?;
        let abs_str = abs.to_string_lossy().into_owned();
        let abs_clean = abs_str
            .strip_prefix(r"\\?\")
            .unwrap_or(&abs_str)
            .to_string();
        let mut wide: Vec<u16> = abs_clean.encode_utf16().collect();
        wide.push(0);
        for w in wide {
            wide_bytes.push(w as u8);
            wide_bytes.push((w >> 8) as u8);
        }
    }
    wide_bytes.push(0);
    wide_bytes.push(0);

    let header_size = size_of::<DropFiles>();
    let total = header_size + wide_bytes.len();

    unsafe {
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, total)
            .map_err(|e| format!("GlobalAlloc 失败: {e}"))?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            return Err("GlobalLock 失败".to_string());
        }
        let ptr = ptr as *mut u8;

        let header = DropFiles {
            p_files: header_size as u32,
            pt_x: 0,
            pt_y: 0,
            f_nc: 0,
            f_wide: 1,
        };
        std::ptr::write_unaligned(ptr as *mut DropFiles, header);

        let data_ptr = ptr.add(header_size);
        std::ptr::copy_nonoverlapping(wide_bytes.as_ptr(), data_ptr, wide_bytes.len());

        let _ = GlobalUnlock(hglobal);

        OpenClipboard(None).map_err(|e| format!("OpenClipboard 失败: {e}"))?;
        let _ = EmptyClipboard();
        let result = SetClipboardData(CF_HDROP, HANDLE(hglobal.0));
        let _ = CloseClipboard();

        if result.is_err() {
            return Err("SetClipboardData 失败".to_string());
        }
    }
    Ok(())
}

// ── macOS 实现：osascript AppleScript ──
#[cfg(target_os = "macos")]
fn copy_files_impl(paths: &[String]) -> Result<(), String> {
    // 构建 AppleScript：把 POSIX 文件路径作为 alias 写入剪贴板
    let mut aliases = String::new();
    for (i, p) in paths.iter().enumerate() {
        let abs = Path::new(p)
            .canonicalize()
            .map_err(|e| format!("路径无效 {}: {e}", p))?;
        let abs_str = abs.to_string_lossy();
        if i > 0 {
            aliases.push_str(", ");
        }
        aliases.push_str(&format!(
            "(POSIX file \"{}\") as alias",
            abs_str.replace('"', "\\\"")
        ));
    }

    let script = if paths.len() == 1 {
        format!("set the clipboard to {}", aliases)
    } else {
        format!("set the clipboard to {{{}}}", aliases)
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("执行 osascript 失败: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("osascript 错误: {}", stderr.trim()))
    }
}

// ── Linux 实现：xclip (X11) / wl-copy (Wayland) ──
#[cfg(target_os = "linux")]
fn copy_files_impl(paths: &[String]) -> Result<(), String> {
    // 构建 file:// URI 列表
    let mut uri_list = String::new();
    for p in paths {
        let abs = Path::new(p)
            .canonicalize()
            .map_err(|e| format!("路径无效 {}: {e}", p))?;
        let abs_str = abs.to_string_lossy();
        uri_list.push_str(&format!("file://{}\n", abs_str));
    }

    // 先用 x-special/gnome-copied-files target（GNOME/Nautilus 标准格式，含 copy 操作标识）
    let gnome_payload = format!("copy\n{}", uri_list);

    // 检测图形会话类型
    let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();

    // Wayland → wl-copy
    if session_type == "wayland" {
        let mut child = Command::new("wl-copy")
            .arg("-t")
            .arg("text/uri-list")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|_| "未找到 wl-copy（请安装 wl-clipboard）".to_string())?;

        if let Some(stdin) = child.stdin.as_mut() {
            use std::io::Write;
            let _ = stdin.write_all(uri_list.as_bytes());
        }
        let status = child.wait().map_err(|e| format!("wl-copy 执行失败: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("wl-copy 写入剪贴板失败".to_string());
    }

    // X11 / 未检测到 → xclip（优先用 GNOME 专用 target）
    let xclip_result = (|| -> Result<(), String> {
        let mut child = Command::new("xclip")
            .args([
                "-i",
                "-selection",
                "clipboard",
                "-target",
                "x-special/gnome-copied-files",
            ])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|_| "未找到 xclip（请安装 xclip）".to_string())?;

        if let Some(stdin) = child.stdin.as_mut() {
            use std::io::Write;
            let _ = stdin.write_all(gnome_payload.as_bytes());
        }
        let status = child.wait().map_err(|e| format!("xclip 执行失败: {e}"))?;
        if status.success() {
            return Ok(());
        }

        // GNOME target 不支持时回退到 text/uri-list
        let mut child2 = Command::new("xclip")
            .args(["-i", "-selection", "clipboard", "-target", "text/uri-list"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|_| "xclip 启动失败".to_string())?;

        if let Some(stdin) = child2.stdin.as_mut() {
            use std::io::Write;
            let _ = stdin.write_all(uri_list.as_bytes());
        }
        let status2 = child2.wait().map_err(|e| format!("xclip 执行失败: {e}"))?;
        if status2.success() {
            Ok(())
        } else {
            Err("xclip 写入剪贴板失败".to_string())
        }
    })();

    xclip_result
}

/// 将一组文件路径写入系统剪贴板，三平台通用。
#[tauri::command]
pub async fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("文件路径列表为空".to_string());
    }

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        copy_files_impl(&paths)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = paths;
        Err("当前平台不支持复制文件到剪贴板".to_string())
    }
}
