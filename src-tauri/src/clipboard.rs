//! clipboard.rs — 系统剪贴板文件写入（Windows: CF_HDROP）
//!
//! 提供 `copy_files_to_clipboard` Tauri 命令，将一组本地文件路径写入系统剪贴板，
//! 用户随后可在资源管理器、聊天工具文件框中粘贴出文件。

use std::mem::size_of;

/// CF_HDROP 剪贴板格式的常量值（Windows SDK 中定义为 15）。
const CF_HDROP: u32 = 15;

/// DROPFILES 结构体（与 Windows SDK 一致），紧随其后为宽字符路径列表。
#[repr(C)]
#[derive(Default)]
struct DropFiles {
    p_files: u32,
    pt_x: i32,
    pt_y: i32,
    f_nc: i32,
    f_wide: i32,
}

/// 将一组文件路径写入系统剪贴板（CF_HDROP 格式，可在资源管理器/聊天中粘贴）。
///
/// 仅 Windows 实现；其他平台返回错误。
#[tauri::command]
pub async fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("文件路径列表为空".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

        // 1. 构建宽字符路径列表，每个路径以 \0 结尾，列表以额外 \0\0 结尾
        let mut wide_bytes: Vec<u8> = Vec::new();
        for p in &paths {
            let abs = std::path::Path::new(p)
                .canonicalize()
                .map_err(|e| format!("路径无效 {}: {e}", p))?;
            // canonicalize 在 Windows 返回 \\?\ 前缀，去掉更通用
            let abs_str = abs.to_string_lossy().into_owned();
            let abs_clean = abs_str
                .strip_prefix(r"\\?\")
                .unwrap_or(&abs_str)
                .to_string();
            let mut wide: Vec<u16> = abs_clean.encode_utf16().collect();
            wide.push(0); // per-path terminator
            for w in wide {
                wide_bytes.push(w as u8);
                wide_bytes.push((w >> 8) as u8);
            }
        }
        // 末尾额外 \0\0 表示列表结束
        wide_bytes.push(0);
        wide_bytes.push(0);

        let header_size = size_of::<DropFiles>(); // 20
        let total = header_size + wide_bytes.len();

        unsafe {
            // 2. 分配可移动全局内存
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, total)
                .map_err(|e| format!("GlobalAlloc 失败: {e}"))?;

            let ptr = GlobalLock(hglobal);
            if ptr.is_null() {
                return Err("GlobalLock 失败".to_string());
            }
            let ptr = ptr as *mut u8;

            // 3. 写 DROPFILES header
            let header = DropFiles {
                p_files: header_size as u32,
                pt_x: 0,
                pt_y: 0,
                f_nc: 0,
                f_wide: 1, // 使用宽字符
            };
            std::ptr::write_unaligned(ptr as *mut DropFiles, header);

            // 4. 写路径数据
            let data_ptr = ptr.add(header_size);
            std::ptr::copy_nonoverlapping(wide_bytes.as_ptr(), data_ptr, wide_bytes.len());

            let _ = GlobalUnlock(hglobal);

            // 5. 打开剪贴板并写入（SetClipboardData 取得内存所有权）
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

    #[cfg(not(target_os = "windows"))]
    {
        let _ = paths;
        Err("当前平台不支持复制文件到剪贴板".to_string())
    }
}
