//! 应用管理的本地 ComfyUI 启动配置，仅提供固定枚举与端口白名单。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use tauri::Manager;

const SETTINGS_FILE: &str = "comfyui-launch.json";
const SETTINGS_TEMP_FILE: &str = "comfyui-launch.json.tmp";
const SETTINGS_BACKUP_FILE: &str = "comfyui-launch.json.bak";
const MAX_SETTINGS_BYTES: u64 = 16 * 1024;
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
// 运行时观测只保留端口；即使启动后保存了新配置，也不能遗漏仍运行的旧端口。
static LAST_LAUNCH_PORT: AtomicU16 = AtomicU16::new(0);

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VramMode {
    #[default]
    Auto,
    High,
    Normal,
    Low,
    No,
    Cpu,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Precision {
    #[default]
    Auto,
    Fp16,
    Bf16,
    Fp32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Attention {
    #[default]
    Auto,
    Pytorch,
    Split,
    Quad,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewMethod {
    #[default]
    Auto,
    None,
    Latent2rgb,
    Taesd,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComfyUILaunchSettings {
    pub port: u16,
    pub vram_mode: VramMode,
    pub precision: Precision,
    pub attention: Attention,
    pub preview_method: PreviewMethod,
    pub disable_smart_memory: bool,
}

impl Default for ComfyUILaunchSettings {
    fn default() -> Self {
        Self {
            port: 8188,
            vram_mode: VramMode::Auto,
            precision: Precision::Auto,
            attention: Attention::Auto,
            preview_method: PreviewMethod::Auto,
            disable_smart_memory: false,
        }
    }
}

impl ComfyUILaunchSettings {
    fn validate(&self) -> Result<(), String> {
        if self.port < 1024 {
            return Err("ComfyUI 端口必须在 1024–65535 之间".to_string());
        }
        Ok(())
    }

    /// 只有全部默认值时，才可使用无法注入参数的旧启动器兜底。
    pub(super) fn requires_direct_launch(&self) -> bool {
        self != &Self::default()
    }

    pub(super) fn append_args(
        &self,
        args: &mut Vec<String>,
        declared_args: &str,
    ) -> Result<(), String> {
        self.validate()?;
        append_supported_arg(args, declared_args, "--port", Some(&self.port.to_string()))?;

        let vram = match self.vram_mode {
            VramMode::Auto => None,
            VramMode::High => Some("--highvram"),
            VramMode::Normal => Some("--normalvram"),
            VramMode::Low => Some("--lowvram"),
            VramMode::No => Some("--novram"),
            VramMode::Cpu => Some("--cpu"),
        };
        let precision = match self.precision {
            Precision::Auto => None,
            Precision::Fp16 => Some("--fp16-unet"),
            Precision::Bf16 => Some("--bf16-unet"),
            Precision::Fp32 => Some("--fp32-unet"),
        };
        let attention = match self.attention {
            Attention::Auto => None,
            Attention::Pytorch => Some("--use-pytorch-cross-attention"),
            Attention::Split => Some("--use-split-cross-attention"),
            Attention::Quad => Some("--use-quad-cross-attention"),
        };
        for flag in [vram, precision, attention].into_iter().flatten() {
            append_supported_arg(args, declared_args, flag, None)?;
        }
        let preview = match self.preview_method {
            PreviewMethod::Auto => None,
            PreviewMethod::None => Some("none"),
            PreviewMethod::Latent2rgb => Some("latent2rgb"),
            PreviewMethod::Taesd => Some("taesd"),
        };
        if let Some(preview) = preview {
            append_supported_arg(args, declared_args, "--preview-method", Some(preview))?;
        }
        if self.disable_smart_memory {
            append_supported_arg(args, declared_args, "--disable-smart-memory", None)?;
        }
        Ok(())
    }
}

/// 读取实际安装源码中的参数声明，不执行第三方 Python 或 --help。
pub(super) fn declares_cli_flag(source: &str, flag: &str) -> bool {
    source.split(".add_argument(").skip(1).any(|arguments| {
        let declaration = arguments.trim_start();
        declaration.starts_with(format!("\"{flag}\"").as_str())
            || declaration.starts_with(format!("'{flag}'").as_str())
    })
}

pub(super) fn append_supported_arg(
    args: &mut Vec<String>,
    source: &str,
    flag: &str,
    value: Option<&str>,
) -> Result<(), String> {
    if !declares_cli_flag(source, flag) {
        return Err(format!(
            "当前 ComfyUI 版本不支持启动选项 {flag}，请将对应设置恢复为自动或切换兼容版本"
        ));
    }
    args.push(flag.to_string());
    if let Some(value) = value {
        args.push(value.to_string());
    }
    Ok(())
}

fn settings_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| "无法定位 ComfyUI 启动配置目录".to_string())
}

fn ensure_plain_settings_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            let is_reparse = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let is_reparse = false;
            if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse {
                return Err("ComfyUI 启动配置必须为普通文件".to_string());
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("无法访问 ComfyUI 启动配置".to_string()),
    }
}

fn read_settings_file(path: &Path) -> Result<ComfyUILaunchSettings, String> {
    let size = fs::metadata(path)
        .map_err(|_| "无法读取 ComfyUI 启动配置".to_string())?
        .len();
    if size > MAX_SETTINGS_BYTES {
        return Err("ComfyUI 启动配置超过大小限制".to_string());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取 ComfyUI 启动配置".to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("ComfyUI 启动配置超过大小限制".to_string());
    }
    let settings: ComfyUILaunchSettings = serde_json::from_slice(&bytes)
        .map_err(|_| "ComfyUI 启动配置损坏，请在管理窗口重新保存设置".to_string())?;
    settings.validate()?;
    Ok(settings)
}

pub(super) fn load_settings(app: &tauri::AppHandle) -> Result<ComfyUILaunchSettings, String> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| "ComfyUI 启动配置锁异常".to_string())?;
    let directory = settings_directory(app)?;
    let file = directory.join(SETTINGS_FILE);
    if ensure_plain_settings_file(&file)? {
        return read_settings_file(&file);
    }
    // 恢复保存中断前的旧版本；不把损坏配置静默当成默认值。
    let backup = directory.join(SETTINGS_BACKUP_FILE);
    if ensure_plain_settings_file(&backup)? {
        return read_settings_file(&backup);
    }
    Ok(ComfyUILaunchSettings::default())
}

pub(super) fn configured_port(app: &tauri::AppHandle) -> Result<u16, String> {
    Ok(load_settings(app)?.port)
}

pub(super) fn last_launch_port() -> Option<u16> {
    match LAST_LAUNCH_PORT.load(Ordering::Acquire) {
        0 => None,
        port => Some(port),
    }
}

pub(super) fn record_launch_port(port: u16) {
    LAST_LAUNCH_PORT.store(port, Ordering::Release);
}

#[tauri::command]
pub fn get_comfyui_launch_settings(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<ComfyUILaunchSettings, String> {
    if webview.label() == "main" {
        crate::path_policy::ensure_trusted_caller(&webview)?;
    } else {
        super::management::ensure_management_caller(&webview, &app)?;
    }
    load_settings(&app)
}

#[tauri::command]
pub fn save_comfyui_launch_settings(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    settings: ComfyUILaunchSettings,
) -> Result<ComfyUILaunchSettings, String> {
    super::management::ensure_management_caller(&webview, &app)?;
    settings.validate()?;
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| "ComfyUI 启动配置锁异常".to_string())?;
    let directory = settings_directory(&app)?;
    fs::create_dir_all(&directory)
        .map_err(|_| "无法创建 ComfyUI 启动配置目录".to_string())?;
    let file = directory.join(SETTINGS_FILE);
    let temporary = directory.join(SETTINGS_TEMP_FILE);
    let backup = directory.join(SETTINGS_BACKUP_FILE);
    let had_file = ensure_plain_settings_file(&file)?;
    ensure_plain_settings_file(&temporary)?;
    ensure_plain_settings_file(&backup)?;
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|_| "无法序列化 ComfyUI 启动配置".to_string())?;
    fs::write(&temporary, bytes).map_err(|_| "无法写入 ComfyUI 启动配置".to_string())?;
    if had_file {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|_| "无法准备 ComfyUI 启动配置备份".to_string())?;
        }
        fs::rename(&file, &backup)
            .map_err(|_| "无法备份 ComfyUI 启动配置".to_string())?;
    }
    if fs::rename(&temporary, &file).is_err() {
        if had_file {
            let _ = fs::rename(&backup, &file);
        }
        let _ = fs::remove_file(&temporary);
        return Err("无法保存 ComfyUI 启动配置，已保留上一份配置".to_string());
    }
    let _ = fs::remove_file(&backup);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_zero_port_unknown_enum_and_arbitrary_fields() {
        let mut settings = ComfyUILaunchSettings::default();
        settings.port = 0;
        assert!(settings.validate().is_err());
        let mut value = serde_json::to_value(ComfyUILaunchSettings::default()).unwrap();
        value["vramMode"] = serde_json::json!("--listen=0.0.0.0");
        assert!(serde_json::from_value::<ComfyUILaunchSettings>(value).is_err());
        let mut value = serde_json::to_value(ComfyUILaunchSettings::default()).unwrap();
        value["args"] = serde_json::json!(["--listen", "0.0.0.0"]);
        assert!(serde_json::from_value::<ComfyUILaunchSettings>(value).is_err());
    }

    #[test]
    fn selected_options_fail_when_installation_does_not_declare_them() {
        let settings = ComfyUILaunchSettings {
            vram_mode: VramMode::Normal,
            ..Default::default()
        };
        let mut args = Vec::new();
        let source = "parser.add_argument('--port', type=int)";
        assert!(settings
            .append_args(&mut args, source)
            .unwrap_err()
            .contains("--normalvram"));
        assert!(!declares_cli_flag(
            "parser.add_argument('--highvram-extra')", "--highvram"
        ));
    }

    #[test]
    fn maps_explicit_options_without_shell_or_network_arguments() {
        let settings = ComfyUILaunchSettings {
            port: 8199,
            vram_mode: VramMode::Low,
            precision: Precision::Bf16,
            attention: Attention::Pytorch,
            preview_method: PreviewMethod::Latent2rgb,
            disable_smart_memory: true,
        };
        let source = [
            "--port", "--lowvram", "--bf16-unet", "--use-pytorch-cross-attention",
            "--preview-method", "--disable-smart-memory",
        ]
        .map(|flag| format!("parser.add_argument(\"{flag}\")"))
        .join("\n");
        let mut args = Vec::new();
        settings.append_args(&mut args, &source).unwrap();
        assert_eq!(args, [
            "--port", "8199", "--lowvram", "--bf16-unet", "--use-pytorch-cross-attention",
            "--preview-method", "latent2rgb", "--disable-smart-memory",
        ]);
        assert!(settings.requires_direct_launch());
        assert!(!ComfyUILaunchSettings::default().requires_direct_launch());
    }
}
