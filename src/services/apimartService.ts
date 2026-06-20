/**
 * apimartService — APIMart 角度控制 API 封装
 * 上传图片 → 提交图像生成 → 轮询任务结果 → 返回生成图片 URL
 */

const APIMART_BASE = 'https://api.apib.ai/v1';

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

/* ── 相机角度映射 ── */
function buildCameraPrompt(rotation: number, pitch: number): string {
  const rot = ((rotation % 360) + 360) % 360;

  // 水平方位描述
  let horizontal: string;
  if (rot < 22.5 || rot >= 337.5) {
    horizontal = 'front view';
  } else if (rot < 67.5) {
    horizontal = 'front-right quarter view';
  } else if (rot < 112.5) {
    horizontal = 'right side view';
  } else if (rot < 157.5) {
    horizontal = 'rear-right quarter view';
  } else if (rot < 202.5) {
    horizontal = 'rear view';
  } else if (rot < 247.5) {
    horizontal = 'rear-left quarter view';
  } else if (rot < 292.5) {
    horizontal = 'left side view';
  } else {
    horizontal = 'front-left quarter view';
  }

  // 垂直角度描述
  let vertical: string;
  if (pitch > 20) {
    vertical = 'high angle shot';
  } else if (pitch < -10) {
    vertical = 'low angle shot';
  } else {
    vertical = 'eye-level shot';
  }

  return `switch the camera perspective: wide shot, ${horizontal}, ${vertical}`;
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
async function uploadToApimart(dataUrl: string, apiKey: string): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const formData = new FormData();
  // 如果是远程 URL，先 fetch 转 blob
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
  if (!result.url) {
    throw new Error('图片上传失败: 未返回 url');
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
async function pollTask(
  apiKey: string,
  taskId: string,
  onProgress?: (progress: number) => void,
): Promise<TaskData> {
  const POLL_INTERVAL = 5000;         // 每 5 秒轮询

  // 不设超时：轮询直到任务完成/失败（仅 ComfyUI 才设超时）
  while (true) {
    const resp = await fetch(`${APIMART_BASE}/tasks/${taskId}?language=zh`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`任务查询失败 (${resp.status}): ${errBody}`);
    }

    const result: TaskResponse | TaskData = await resp.json();
    const task: TaskData = 'data' in result ? result.data : result;

    onProgress?.(task.progress ?? 0);

    if (task.status === 'completed') {
      return task;
    }

    if (task.status === 'failed' || task.status === 'error') {
      throw new Error(`生成任务失败: ${task.status}`);
    }

    // 等待后继续轮询
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/* ════════════════════════════════════════════
   导出：完整角度控制生成流程
   ════════════════════════════════════════════ */

export interface AngleGenerateParams {
  apiKey: string;
  model: string;          // 如 'gpt-image-2'
  imageUrl: string;       // 源图片 URL（可为 data URL 或远程 URL）
  rotation: number;       // 水平角度 (0-360)
  pitch: number;          // 垂直角度 (-30 ~ 60)
}

export interface AngleGenerateResult {
  imageUrls: string[];    // 生成的图片 URL 列表
}

/**
 * 执行角度控制生成：上传→提交→轮询→返回结果
 * 支持 data URL（自动上传）和远程 URL（直接使用）
 */
export async function generateAngleImage(
  params: AngleGenerateParams,
  onProgress?: (progress: number) => void,
): Promise<AngleGenerateResult> {
  const { apiKey, model, imageUrl, rotation, pitch } = params;

  // 步骤 1: 如果 imageUrl 是 data URL，先上传到 APIMart
  let publicUrl: string;
  if (imageUrl.startsWith('data:')) {
    onProgress?.(5);
    publicUrl = await uploadToApimart(imageUrl, apiKey);
    onProgress?.(15);
  } else {
    publicUrl = imageUrl;
    onProgress?.(10);
  }

  // 步骤 2: 构建 prompt 并提交生成任务
  const prompt = buildCameraPrompt(rotation, pitch);
  onProgress?.(20);
  const taskId = await submitGeneration(apiKey, model, prompt, publicUrl);
  onProgress?.(25);

  // 步骤 3: 轮询任务结果
  const taskData = await pollTask(apiKey, taskId, (p) => {
    // 映射轮询进度到 25-95 区间
    onProgress?.(25 + Math.round(p * 0.7));
  });

  onProgress?.(95);

  // 步骤 4: 提取图片 URL
  const imageUrls = taskData.result?.images?.flatMap((img) => img.url) ?? [];
  if (imageUrls.length === 0) {
    throw new Error('生成完成但未返回图片');
  }

  onProgress?.(100);
  return { imageUrls };
}

/* ════════════════════════════════════════════
   导出：扩图（outpainting）生成流程
   原图已在客户端合成到目标画幅的大画布上（四周透明留白），
   模型负责把透明区域补全为与原图无缝衔接的内容。
   ════════════════════════════════════════════ */

export interface OutpaintGenerateParams {
  apiKey: string;
  model: string;          // 如 'gemini-3.1-flash-image-preview'（不含 apimart/ 前缀）
  imageUrl: string;       // 客户端合成好的"垫图"（data URL，原图 + 透明留白）
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

  // 步骤 1: 合成图通常是 data URL，先上传到 APIMart
  let publicUrl: string;
  if (imageUrl.startsWith('data:')) {
    onProgress?.(5);
    publicUrl = await uploadToApimart(imageUrl, apiKey);
    onProgress?.(15);
  } else {
    publicUrl = imageUrl;
    onProgress?.(10);
  }

  // 步骤 2: 构建提示词并提交生成任务
  const fullPrompt = buildOutpaintPrompt(prompt);
  onProgress?.(20);
  const taskId = await submitGeneration(apiKey, model, fullPrompt, publicUrl, size);
  onProgress?.(25);

  // 步骤 3: 轮询任务结果
  const taskData = await pollTask(apiKey, taskId, (p) => {
    onProgress?.(25 + Math.round(p * 0.7));
  });

  onProgress?.(95);

  // 步骤 4: 提取图片 URL
  const imageUrls = taskData.result?.images?.flatMap((img) => img.url) ?? [];
  if (imageUrls.length === 0) {
    throw new Error('扩图完成但未返回图片');
  }

  onProgress?.(100);
  return { imageUrls };
}

/* ── 简单 API Key 可用性检测 ── */
export async function testApimartConnection(apiKey: string): Promise<boolean> {
  try {
    const resp = await fetch(`${APIMART_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return resp.ok;
  } catch {
    return false;
  }
}
