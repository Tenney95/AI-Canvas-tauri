/**
 * onnxService — ONNX Runtime 前端服务层
 * 封装 Tauri invoke 调用，含模型下载管理
 */
import { invoke } from '@tauri-apps/api/core';

/** 图像超分结果 */
export interface UpscaleResult {
  output_path: string;
  input_size: string;
  output_size: string;
}

/** 模型下载结果 */
export interface DownloadResult {
  path: string;
  size_bytes: number;
  cached: boolean;
}

/** 主体识别结果 */
export interface MattingResult {
  subject_path: string;
  input_size: string;
}

/** 模型注册表：模型名 → 下载 URL */
const MODEL_REGISTRY: Record<string, string> = {
  'realesrgan-x4.onnx':
    'https://huggingface.co/AXERA-TECH/Real-ESRGAN/resolve/main/onnx/realesrgan-x4.onnx',
  'rmbg-1.4.onnx':
    'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
};

/** 判断是否运行在 Tauri 桌面环境中 */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 查询 ONNX 模型目录路径
 * @returns 模型目录的绝对路径字符串，或 null（非 Tauri 环境）
 */
export async function getModelsDir(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  try {
    const dir: string = await invoke('get_models_dir');
    return dir;
  } catch {
    return null;
  }
}

/**
 * 检查指定模型文件是否已存在
 * @returns 模型文件路径（若存在），否则 null
 */
export async function checkModelExists(modelName: string): Promise<string | null> {
  const dir = await getModelsDir();
  if (!dir) return null;
  try {
    // 用 Tauri 命令验证文件存在性
    const exists: boolean = await invoke('check_model_exists', { modelName });
    if (exists) {
      // 拼接路径
      const sep = dir.endsWith('\\') || dir.endsWith('/') ? '' : '\\';
      return `${dir}${sep}${modelName}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 下载 ONNX 模型文件（若已存在则跳过）
 * @param modelName 模型文件名（如 "realesrgan-x4.onnx"）
 * @returns 下载结果，含 path / size_bytes / cached
 */
export async function downloadModel(modelName: string): Promise<DownloadResult> {
  const url = MODEL_REGISTRY[modelName];
  if (!url) throw new Error(`未知模型: ${modelName}，请联系开发者添加下载地址`);

  const json: string = await invoke('download_onnx_model', {
    modelName,
    url,
  });
  return JSON.parse(json) as DownloadResult;
}

/**
 * 调用 ONNX 图像超分推理
 * @param inputPath 输入图像文件路径（绝对路径）
 * @param outputPath 输出图像文件路径（绝对路径，父目录自动创建）
 * @param modelName 模型文件名（如 "realesrgan-x4.onnx"）
 * @returns 推理结果，包含 output_path / input_size / output_size
 */
export async function imageUpscale(
  inputPath: string,
  outputPath: string,
  modelName: string,
  taskId: string,
): Promise<UpscaleResult> {
  const json: string = await invoke('image_upscale', {
    inputPath,
    outputPath,
    modelName,
    taskId,
  });
  return JSON.parse(json) as UpscaleResult;
}

/**
 * 调用 ONNX 主体识别（背景移除 / Matting）
 * @param inputPath 输入图像文件路径（绝对路径）
 * @param outputPath 输出 mask PNG 文件路径（绝对路径）
 * @param modelName 模型文件名（如 "rmbg-1.4.onnx"）
 * @returns 结果，包含 mask_path / input_size
 */
export async function subjectMatting(
  inputPath: string,
  outputPath: string,
  modelName: string,
  taskId: string,
): Promise<MattingResult> {
  const json: string = await invoke('subject_matting', {
    inputPath,
    outputPath,
    modelName,
    taskId,
  });
  return JSON.parse(json) as MattingResult;
}
