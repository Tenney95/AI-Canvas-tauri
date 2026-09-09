/**
 * apimartService — APIMart 图片编辑 API 封装
 * 上传图片 → 提交图像生成 → 轮询任务结果 → 返回生成图片 URL
 */

import { APIMART_BASE_URL } from '../constants/api';
import { isLocalMediaUrl, isRemoteMediaUrl } from '../utils/mediaUrl';
import { assertMediaDataUrlWithinLimitAsync, isMediaDataUrl, readFileToDataUrl } from './fileService';
import { pollTask } from './pollTask';
import { splitCommaSeparatedUrls } from './ai/helpers';
const APIMART_BASE = APIMART_BASE_URL;

interface TaskResult {
  images: Array<{ url: string[]; expires_at?: number }>;
}

interface TaskData {
  status: string;
  progress?: number;
  result?: TaskResult;
  cost?: number;
  created?: number;
  estimated_time?: number;
  actual_time?: number;
  id?: string;
}

interface TaskResponse {
  code: number;
  data: TaskData;
}

interface UploadResponse {
  url: string;
  filename?: string;
  content_type?: string;
  bytes?: number;
}

interface SubmitResponse {
  code: number;
  data: Array<{ task_id: string; status: string }>;
}

/* ── data URL → Blob ── */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/* ── 步骤 1: 上传图片到 APIMart ── */
async function uploadToApimart(sourceUrl: string, apiKey: string): Promise<string> {
  const dataUrl = isMediaDataUrl(sourceUrl)
    ? sourceUrl
    : await readFileToDataUrl(sourceUrl, { kind: 'image', label: '扩图参考图' });
  if (!dataUrl) throw new Error('无法读取扩图参考图');
  await assertMediaDataUrlWithinLimitAsync(dataUrl, 'image', '扩图参考图');
  const blob = dataUrlToBlob(dataUrl);
  const formData = new FormData();
  const fileName = `canvas-image-${Date.now()}.png`;
  formData.append('file', blob, fileName);

  const resp = await fetch(`${APIMART_BASE}/uploads/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`图片上传失败 (${resp.status}): ${errBody}`);
  }

  const result: UploadResponse = await resp.json();
  if (!isRemoteMediaUrl(result.url)) {
    throw new Error('图片上传失败: 未返回有效的网络地址');
  }
  return result.url;
}

/* ── 步骤 2: 提交图像生成任务 ── */
async function submitGeneration(
  apiKey: string,
  model: string,
  prompt: string,
  imageUrl: string,
  size: string = '4:3',
): Promise<string> {
  const resp = await fetch(`${APIMART_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      resolution: '2k',
      size,
      image_urls: [imageUrl],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`生成提交失败 (${resp.status}): ${errBody}`);
  }

  const result: SubmitResponse = await resp.json();
  const taskId = result.data?.[0]?.task_id;
  if (!taskId) {
    throw new Error('生成提交失败: 未返回 task_id');
  }
  return taskId;
}

/* ── 步骤 3: 轮询任务直到完成 ── */
async function pollApimartTask(
  apiKey: string,
  taskId: string,
  onProgress?: (progress: number) => void,
): Promise<TaskData> {
  return pollTask<TaskResponse | TaskData, TaskData>({
    fetchState: async () => {
      const resp = await fetch(`${APIMART_BASE}/tasks/${taskId}?language=zh`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`任务查询失败 (${resp.status}): ${errBody}`);
      }
      return (await resp.json()) as TaskResponse | TaskData;
    },
    isComplete: (raw) => {
      const task: TaskData = 'data' in (raw as TaskResponse) ? (raw as TaskResponse).data : (raw as TaskData);
      if (task.status === 'completed') return task;
      return null;
    },
    isFailed: (raw) => {
      const task: TaskData = 'data' in (raw as TaskResponse) ? (raw as TaskResponse).data : (raw as TaskData);
      return task.status === 'failed' || task.status === 'error'
        ? `生成任务失败: ${task.status}` : null;
    },
    interval: 5000,
    onProgress,
    onFetchError: 'throw',
  });
}

/* ════════════════════════════════════════════
   导出：扩图（outpainting）生成流程
   原图已在客户端合成到目标画幅的大画布上（四周透明留白），
   模型负责把透明区域补全为与原图无缝衔接的内容。
   ════════════════════════════════════════════ */

export interface OutpaintGenerateParams {
  apiKey: string;
  model: string;          // 如 'gemini-3.1-flash-image-preview'（不含 apimart/ 前缀）
  imageUrl: string;       // 扩图参考图，支持 data/blob/asset/file 与 HTTP(S) URL
  size: string;           // 目标画幅，如 '1:1' / '16:9' / '9:16'
  prompt?: string;        // 可选的补充描述，追加到默认扩图提示词后
}

export interface OutpaintGenerateResult {
  imageUrls: string[];
}

/** 默认扩图提示词：强调无缝延展、保持原内容不变 */
function buildOutpaintPrompt(extra?: string): string {
  const base =
    'Outpaint and naturally extend this image to fill the entire frame. ' +
    'Seamlessly continue the existing scene, lighting, perspective, colors and art style into the transparent/empty areas. ' +
    'Keep the original content completely unchanged and ensure smooth transitions at the edges.';
  const trimmed = extra?.trim();
  return trimmed ? `${base} ${trimmed}` : base;
}

/**
 * 执行扩图生成：上传合成图 → 提交 → 轮询 → 返回结果
 */
export async function generateOutpaintImage(
  params: OutpaintGenerateParams,
  onProgress?: (progress: number) => void,
): Promise<OutpaintGenerateResult> {
  const { apiKey, model, imageUrl, size, prompt } = params;

  // 步骤 1: 本地参考图先上传到 APIMart，使用本次扩图调用的凭据。
  let publicUrl: string;
  if (isLocalMediaUrl(imageUrl)) {
    onProgress?.(5);
    publicUrl = await uploadToApimart(imageUrl, apiKey);
    onProgress?.(15);
  } else if (isRemoteMediaUrl(imageUrl)) {
    publicUrl = imageUrl;
    onProgress?.(10);
  } else {
    throw new Error('扩图参考图地址无效');
  }

  // 步骤 2: 构建提示词并提交生成任务
  const fullPrompt = buildOutpaintPrompt(prompt);
  onProgress?.(20);
  const taskId = await submitGeneration(apiKey, model, fullPrompt, publicUrl, size);
  onProgress?.(25);

  // 步骤 3: 轮询任务结果
  const taskData = await pollApimartTask(apiKey, taskId, (p) => {
    onProgress?.(25 + Math.round(p * 0.7));
  });

  onProgress?.(95);

  // 步骤 4: 提取图片 URL
  const imageUrls = taskData.result?.images?.flatMap((img) => splitCommaSeparatedUrls(img.url)) ?? [];
  if (imageUrls.length === 0) {
    throw new Error('扩图完成但未返回图片');
  }

  onProgress?.(100);
  return { imageUrls };
}
