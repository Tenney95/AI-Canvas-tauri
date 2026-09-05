use std::collections::BTreeSet;
use std::process::Command;

fn normalize_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    names
        .into_iter()
        .flat_map(|name| {
            name.split(',')
                .map(str::trim)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|name| !name.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(target_os = "macos")]
fn platform_font_names() -> Result<Vec<String>, String> {
    let output = Command::new("/usr/bin/osascript")
        .args([
            "-l",
            "JavaScript",
            "-e",
            "ObjC.import('AppKit'); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))",
        ])
        .output()
        .map_err(|error| format!("读取系统字体失败: {error}"))?;
    if !output.status.success() {
        return Err("读取系统字体失败：AppKit 字体枚举失败".into());
    }
    let names: Vec<String> = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("解析系统字体失败: {error}"))?;
    Ok(normalize_names(names))
}

#[cfg(target_os = "windows")]
fn platform_font_names() -> Result<Vec<String>, String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts').PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { $_.Name -replace '\\s*\\(.*?\\)\\s*$', '' }",
        ])
        .output()
        .map_err(|error| format!("读取系统字体失败: {error}"))?;
    if !output.status.success() {
        return Err("读取系统字体失败：PowerShell 执行失败".into());
    }
    Ok(normalize_names(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_owned),
    ))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn platform_font_names() -> Result<Vec<String>, String> {
    let output = Command::new("fc-list")
        .args(["-f", "%{family}\\n"])
        .output()
        .map_err(|error| format!("读取系统字体失败: {error}"))?;
    if !output.status.success() {
        return Err("读取系统字体失败：fc-list 执行失败".into());
    }
    Ok(normalize_names(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_owned),
    ))
}

/// 只读枚举字体名称，不接收路径，也不返回字体文件位置。
#[tauri::command]
pub async fn list_local_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(platform_font_names)
        .await
        .map_err(|error| format!("读取系统字体任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::normalize_names;

    #[test]
    fn font_names_are_trimmed_split_and_deduplicated() {
        assert_eq!(
            normalize_names([" PingFang SC, Arial ".into(), "Arial".into(), "".into()]),
            vec!["Arial".to_string(), "PingFang SC".to_string()],
        );
    }
}
