/// GPU 检测与 DirectML 能力探测（仅在 worker 进程中调用）
/// 主进程永远不碰此模块，确保 DirectML 初始化死锁不会影响主进程。

/// GPU 适配器信息
#[derive(Debug, Clone)]
pub struct GpuAdapter {
    pub device_id: u32,
    pub name: String,
    pub dedicated_vram_mb: u64,
    pub is_software: bool,
}

#[cfg(windows)]
mod win {
    use super::GpuAdapter;
    use std::path::Path;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    /// 枚举所有 DXGI 适配器
    pub fn enumerate_adapters() -> Vec<GpuAdapter> {
        let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
            Ok(f) => f,
            Err(_) => {
                eprintln!("[onnx-worker] CreateDXGIFactory1 失败");
                return vec![];
            }
        };

        let mut adapters = Vec::new();
        for idx in 0u32.. {
            let adapter = match unsafe { factory.EnumAdapters1(idx) } {
                Ok(a) => a,
                Err(_) => break,
            };

            let desc = match unsafe { adapter.GetDesc1() } {
                Ok(d) => d,
                Err(_) => continue,
            };

            let name = String::from_utf16_lossy(&desc.Description)
                .trim_end_matches('\0')
                .to_string();

            let software_flag = DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32;
            let is_software = (desc.Flags & software_flag) != 0;

            adapters.push(GpuAdapter {
                device_id: idx,
                name,
                dedicated_vram_mb: desc.DedicatedVideoMemory as u64 / (1024 * 1024),
                is_software,
            });
        }
        adapters
    }

    /// 从适配器列表中选出最适合的独显，跳过虚拟/软件适配器
    pub fn select_best(adapters: &[GpuAdapter]) -> Option<&GpuAdapter> {
        adapters
            .iter()
            .filter(|a| !a.is_software)
            .filter(|a| {
                let n = a.name.to_lowercase();
                !n.contains("virtual")
                    && !n.contains("remote")
                    && !n.contains("mirror")
                    && !n.contains("idd")
                    && !n.contains("indirect")
                    && !n.contains("parsec")
                    && !n.contains("mumu")
                    && !n.contains("oray")
            })
            .max_by_key(|a| {
                let n = a.name.to_lowercase();
                let is_discrete =
                    n.contains("nvidia") || n.contains("amd") || n.contains("radeon") || n.contains("arc");
                (is_discrete, a.dedicated_vram_mb)
            })
    }

    /// 用模型自适应的探针图完整测试 DirectML 管线（不再硬编码 64×64）
    pub fn probe_directml(model_path: &Path, device_id: i32) -> Result<(), String> {
        use ort::session::Session;

        let session = Session::builder()
            .map_err(|e| format!("创建 SessionBuilder 失败: {e}"))?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Disable)
            .map_err(|e| format!("配置优化级别失败: {e}"))?
            .with_execution_providers([ort::execution_providers::DirectMLExecutionProvider::default()
                .with_device_id(device_id)
                .build()])
            .map_err(|e| format!("配置 DirectML EP 失败 (device_id={device_id}): {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("DirectML Session 创建失败 (device_id={device_id}): {e}"))?;

        let in_name = session
            .inputs()
            .first()
            .map(|i| i.name().to_string())
            .ok_or("模型没有输入节点".to_string())?;
        let out_name = session
            .outputs()
            .first()
            .map(|o| o.name().to_string())
            .ok_or("模型没有输出节点".to_string())?;

        // 从模型元数据读取期望的输入尺寸（动态自适应，不再硬编码）
        let (h, w) = {
            let input = session.inputs().first().unwrap();
            match input.dtype() {
                ort::value::ValueType::Tensor { shape, .. } => {
                    let h = shape.get(2).copied().unwrap_or(64).max(1) as usize;
                    let w = shape.get(3).copied().unwrap_or(64).max(1) as usize;
                    (h, w)
                }
                _ => (64, 64),
            }
        };

        let size = h.max(w); // 取正方形边长
        let mut data = vec![0.5f32; 3 * size * size];
        for i in 0..data.len() {
            data[i] = ((i % 256) as f32) / 255.0;
        }
        let shape = vec![1i64, 3, size as i64, size as i64];

        let input_tensor = ort::value::Tensor::from_array((shape, data))
            .map_err(|e| format!("创建探针 Tensor ({size}×{size}) 失败: {e}"))?;

        let mut session = session;

        let outputs = session
            .run(ort::inputs![in_name.clone() => input_tensor])
            .map_err(|e| format!("DirectML 探针推理失败 ({size}×{size}): {e}"))?;

        let _val = outputs
            .get(&*out_name)
            .ok_or(format!("探针推理结果缺少输出 '{out_name}'"))?;

        let (_oshape, _odata) = _val
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("提取探针输出 Tensor 失败: {e}"))?;

        Ok(())
    }
}

#[cfg(not(windows))]
mod win {
    use super::GpuAdapter;
    use std::path::Path;

    pub fn enumerate_adapters() -> Vec<GpuAdapter> {
        vec![]
    }

    pub fn select_best(_adapters: &[GpuAdapter]) -> Option<&GpuAdapter> {
        None
    }

    pub fn probe_directml(_model_path: &Path, _device_id: i32) -> Result<(), String> {
        Err("DirectML 仅支持 Windows 平台".to_string())
    }
}

pub use win::*;
