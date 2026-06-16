/// ONNX GPU 能力缓存配置
/// 主进程负责读写，worker 负责探测；缓存决定后续推理用哪个 EP。
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnnxGpuConfig {
    /// "cpu" | "directml"
    pub ep: String,
    /// GPU 适配器索引（仅 directml 时有效）
    pub device_id: Option<i32>,
    /// GPU 名称（如 "NVIDIA GeForce RTX 4070 Ti"），展示用
    pub device_name: Option<String>,
    /// 探测时间戳
    pub probed_at: Option<String>,
}

fn config_path() -> PathBuf {
    let local = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .unwrap_or_default();
    PathBuf::from(local)
        .join("com.aicanvas.app")
        .join("onnx_gpu_config.json")
}

impl OnnxGpuConfig {
    /// 从磁盘加载缓存，不存在则返回 None
    pub fn load() -> Option<Self> {
        let path = config_path();
        let raw = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// 写入磁盘
    pub fn save(&self) -> Result<(), String> {
        let path = config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("序列化 GPU 配置失败: {e}"))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("写入 GPU 配置失败: {e}"))?;
        Ok(())
    }

    /// 加载或返回 CPU-only 默认值
    pub fn get_or_default() -> Self {
        Self::load().unwrap_or_else(|| Self {
            ep: "cpu".to_string(),
            device_id: None,
            device_name: None,
            probed_at: None,
        })
    }
}
