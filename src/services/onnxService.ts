/**
 * onnxService — ONNX Runtime 前端服务层
 * 封装 Tauri invoke 调用，含模型下载管理
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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

export interface ModelDownloadProgress {
  taskId: string;
  transferredBytes: number;
  totalBytes: number | null;
}

export interface ModelDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ModelDownloadProgress) => void;
  taskId?: string;
}

/** 角色 8 向宫格结果 */
export interface CharacterDirectionGridResult {
  grid_path: string;
  cell_size: number;
  grid_size: number;
}

/** 本地语音转文本结果 */
export interface SpeechToTextResult {
  text: string;
  duration_seconds: number;
}

/** 模型注册表：模型名 → 下载 URL */
const MODEL_REGISTRY: Record<string, string> = {
  'realesrgan-x4.onnx':
    'https://huggingface.co/AXERA-TECH/Real-ESRGAN/resolve/main/onnx/realesrgan-x4.onnx',
  'rmbg-1.4.onnx':
    'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
  // SenseVoice Small 的 int8 量化导出（约 230MB）+ SentencePiece 词表
  'sensevoice-small-int8.onnx':
    'https://huggingface.co/OpenVoiceOS/sensevoice-small-onnx/resolve/main/model_int8.onnx',
  'sensevoice-vocab.txt':
    'https://huggingface.co/OpenVoiceOS/sensevoice-small-onnx/resolve/main/vocab.txt',
};

/** 语音转文本用的模型文件名 */
export const ASR_MODEL = 'sensevoice-small-int8.onnx';
/** 语音转文本用的词表文件名 */
export const ASR_VOCAB = 'sensevoice-vocab.txt';

function createModelDownloadTaskId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `onnx-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
export async function downloadModel(
  modelName: string,
  options?: ModelDownloadOptions,
): Promise<DownloadResult> {
  const url = MODEL_REGISTRY[modelName];
  if (!url) throw new Error(`未知模型: ${modelName}，请联系开发者添加下载地址`);
  if (options?.signal?.aborted) {
    throw new DOMException('Model download aborted', 'AbortError');
  }

  const taskId = options?.taskId ?? createModelDownloadTaskId();
  let unlisten: UnlistenFn | undefined;
  let cancelRequested = false;
  const cancel = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void invoke('cancel_file_transfer', { taskId }).catch((error) => {
      console.warn('[onnxService] cancel_file_transfer failed:', error);
    });
  };

  try {
    if (options?.onProgress) {
      unlisten = await listen<ModelDownloadProgress>('file-transfer-progress', ({ payload }) => {
        if (payload.taskId === taskId) options.onProgress?.(payload);
      });
    }
    if (options?.signal?.aborted) {
      throw new DOMException('Model download aborted', 'AbortError');
    }
    options?.signal?.addEventListener('abort', cancel, { once: true });
    const json: string = await invoke('download_onnx_model', {
      modelName,
      url,
      taskId,
    });
    if (options?.signal?.aborted) {
      throw new DOMException('Model download aborted', 'AbortError');
    }
    return JSON.parse(json) as DownloadResult;
  } catch (error) {
    if (options?.signal?.aborted) {
      throw new DOMException('Model download aborted', 'AbortError');
    }
    throw error;
  } finally {
    options?.signal?.removeEventListener('abort', cancel);
    unlisten?.();
  }
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

/**
 * 调用本地 SenseVoice 模型做语音转文本（离线，不需要 API Key）。
 * @param inputPath 输入音频文件路径（绝对路径）
 * @param modelName 模型文件名
 * @param vocabName 词表文件名
 * @param taskId 进度事件关联的任务 id
 * @param language 语言提示：'auto' | 'zh' | 'en' | 'yue' | 'ja' | 'ko'
 * @returns 识别文本与音频时长（秒）
 */
export async function speechToText(
  inputPath: string,
  modelName: string,
  vocabName: string,
  taskId: string,
  language = 'auto',
): Promise<SpeechToTextResult> {
  const json: string = await invoke('speech_to_text', {
    inputPath,
    modelName,
    vocabName,
    taskId,
    language,
  });
  return JSON.parse(json) as SpeechToTextResult;
}

/**
 * 把 2×3 角色视图直接切图，拼成 3×3 的 8 向宫格（纯图像处理，不跑模型）。
 */
export async function createCharacterDirectionGrid(
  inputPath: string,
): Promise<CharacterDirectionGridResult> {
  const json: string = await invoke('character_direction_grid', { inputPath });
  return JSON.parse(json) as CharacterDirectionGridResult;
}
