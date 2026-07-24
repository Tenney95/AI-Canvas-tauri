/**
 * comfyWorkflowService — ComfyUI workflow execution runtime.
 *
 * Handles workflow JSON mutation, image upload, submission, and result polling.
 */
import { useAppStore } from '../store/useAppStore';
import type { WorkflowIONode } from '../types';
import type { AIAudioGenParams, AIImageGenParams, AIVideoGenParams } from '../types/aiTypes';
import { mapImageDimensions } from './aiDimensions';
import { resolveNodeReferences } from './nodeReferenceService';
import { pollTask } from './pollTask';
import { savePendingTask, updatePendingTask, removePendingTask, registerNodePolling, cleanupNodePolling } from './pollManager';
import { corsSafeFetch } from './ai/httpTransport';

// ── 跨域安全的 fetch 包装 ──

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

/**
 * 将 ComfyUI 直连地址替换为当前环境可访问的地址：
 * - Tauri 模式：保留原地址（走 Rust proxy_fetch）
 * - 浏览器开发模式：替换为 Vite 代理路径 /api/comfyui
 */
function normalizeComfyUrl(url: string): string {
  if (isTauri) return url;
  // Vite dev proxy: http://127.0.0.1:8188/xxx → /api/comfyui/xxx
  return url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '/api/comfyui');
}

/** 将 FormData 序列化为 base64 编码的 multipart 字节流 */
async function formDataToBase64(formData: FormData): Promise<{ body: string; contentType: string }> {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const [name, value] of formData.entries()) {
    let header = `--${boundary}\r\n`;
    if (value instanceof Blob) {
      const filename = (value as File).name || 'blob';
      header += `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`;
      header += `Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`;
      parts.push(encoder.encode(header));
      parts.push(new Uint8Array(await value.arrayBuffer()));
      parts.push(encoder.encode('\r\n'));
    } else {
      header += `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      parts.push(encoder.encode(header));
    }
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.length;
  }

  let binary = '';
  for (let i = 0; i < merged.length; i++) binary += String.fromCharCode(merged[i]);
  return { body: btoa(binary), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * 跨域安全的 fetch — Tauri 模式走 Rust proxy_fetch，浏览器模式走 Vite 代理。
 * 用法与原生 fetch 一致，自动处理 ComfyUI URL 重写和 FormData 序列化。
 */
async function comfyFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const resolvedUrl = normalizeComfyUrl(url);

  if (!isTauri) {
    return corsSafeFetch(resolvedUrl, options);
  }

  const headers = new Headers(options.headers);
  let body = options.body;
  if (body instanceof FormData) {
    const encoded = await formDataToBase64(body);
    const binary = atob(encoded.body);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    headers.set('Content-Type', encoded.contentType);
    body = bytes.buffer;
  }
  return corsSafeFetch(resolvedUrl, { ...options, headers, body });
}

/** 从 Store 获取 ComfyUI 配置并校验 */
function getComfyUIConfig() {
  const config = useAppStore.getState().config;
  const comfyUrl = config.comfyUIUrl?.trim();
  if (!comfyUrl) {
    throw new Error('未配置 ComfyUI 服务地址\n请在「设置 → 服务地址」中配置');
  }
  return comfyUrl.replace(/\/+$/, '');
}

/** 将提示词注入到 ComfyUI workflow JSON 的 prompt 类型 IO 节点中 */
function injectPromptsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  workflowInputs: Record<string, string> | undefined,
  fallbackPrompt: string,
  ioNodeIds: string[],
): void {
  if (!workflowInputs || Object.keys(workflowInputs).length === 0) {
    // 没有 explicit IO 赋值时，遍历所有文本节点做兜底替换
    for (const [, nodeData] of Object.entries(workflowObj)) {
      if (!nodeData || typeof nodeData !== 'object') continue;
      const inputs = nodeData.inputs as Record<string, unknown> | undefined;
      if (!inputs) continue;
      const textKey = Object.keys(inputs).find((k) => (k === 'text' || k === 'prompt') && typeof inputs[k] === 'string');
      if (!textKey || !(inputs[textKey] as string)?.trim()) continue;
      const currentValue = (inputs[textKey] as string) || '';
      // 只替换短占位符（如 "t-1"）
      if (currentValue.length < 10 && !currentValue.includes(' ')) {
        inputs[textKey] = fallbackPrompt;
      }
    }
    return;
  }

  // 有 explicit IO 赋值：只替换用户在 workflowInputs 中明确赋值的节点，未被 @ 的节点保持原值
  const mentionedNodeIds = Object.keys(workflowInputs);
  for (const ioNodeId of mentionedNodeIds) {
    // 只处理同时存在于 ioNodeIds 和 workflowInputs 中的节点（被 @ 命中的）
    if (!ioNodeIds.includes(ioNodeId)) continue;

    const rawValue = workflowInputs[ioNodeId];
    const resolvedValue = rawValue !== undefined ? resolveNodeReferences(rawValue) : undefined;
    const finalValue = (resolvedValue && resolvedValue.trim()) ? resolvedValue : fallbackPrompt;

    const jsonNode = workflowObj[ioNodeId];
    if (!jsonNode) continue;
    const inputs = jsonNode.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    const textKey = Object.keys(inputs).find((k) => (k === 'text' || k === 'prompt'));
    if (textKey) {
      inputs[textKey] = finalValue;
    }
  }
}

/** 将图片上传到 ComfyUI 服务器，返回 filename/subfolder/type */
async function uploadImageToComfyUI(
  baseUrl: string,
  imageUrl: string,
  signal?: AbortSignal,
): Promise<{ name: string; subfolder?: string; type?: string }> {
  // 1. 获取图片 Blob（支持 data URL 和远程 URL）
  let blob: Blob;
  let ext: string;

  if (imageUrl.startsWith('data:')) {
    // data URL → 直接解析
    const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) throw new Error('不支持的 data URL 格式');
    const mimeType = match[1];
    const base64 = match[2];
    const byteChars = atob(base64);
    const byteArr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArr[i] = byteChars.charCodeAt(i);
    }
    blob = new Blob([byteArr], { type: mimeType });
    ext = mimeType.split('/')[1] || 'png';
  } else {
    // 远程 URL → fetch 获取
    const response = await fetch(imageUrl, { signal });
    if (!response.ok) {
      throw new Error(`下载图片失败 (${response.status})`);
    }
    blob = await response.blob();
    // 从 Content-Type 或 URL 推断扩展名
    const contentType = response.headers.get('Content-Type') || '';
    ext = contentType.split('/')[1] || imageUrl.split('.').pop()?.split('?')[0] || 'png';
  }

  // 2. 上传到 ComfyUI /upload/image
  const formData = new FormData();
  formData.append('image', blob, `upload_${Date.now()}.${ext}`);
  // 覆盖同名文件，避免重复堆积
  formData.append('overwrite', 'true');

  const uploadRes = await comfyFetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: formData,
    signal,
  });

  if (!uploadRes.ok) {
    const errorBody = await uploadRes.text().catch(() => '');
    throw new Error(`ComfyUI 图片上传失败 (${uploadRes.status})${errorBody ? ': ' + errorBody.slice(0, 200) : ''}`);
  }

  const uploadResult = (await uploadRes.json()) as { name: string; subfolder?: string; type?: string };
  if (!uploadResult.name) {
    throw new Error('ComfyUI 上传返回结果异常：缺少文件名');
  }

  return uploadResult;
}

/** 将图片注入到 ComfyUI workflow JSON 的 image 类型 IO 节点中 */
async function injectImagesIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  workflowInputs: Record<string, string> | undefined,
  ioNodes: WorkflowIONode[],
  baseUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!workflowInputs || Object.keys(workflowInputs).length === 0) return;

  // 构建 nodeId → type 映射
  const typeMap = new Map(ioNodes.map((io) => [io.nodeId, io.type]));

  const mentionedNodeIds = Object.keys(workflowInputs);
  for (const ioNodeId of mentionedNodeIds) {
    // 只处理 image 类型的 IO 节点
    if (typeMap.get(ioNodeId) !== 'image') continue;

    const rawValue = workflowInputs[ioNodeId];
    // 解析 @{nodeId:label} 引用，获取实际图片 URL
    const resolvedValue = rawValue !== undefined ? resolveNodeReferences(rawValue) : '';
    if (!resolvedValue || !resolvedValue.trim()) continue;

    const imageUrl = resolvedValue.trim();

    // 跳过无效值（比如解析后仍然是 @{...} 占位符）
    if (imageUrl.startsWith('@{')) continue;

    // 上传图片到 ComfyUI
    const uploadResult = await uploadImageToComfyUI(baseUrl, imageUrl, signal);

    // 写入工作流 JSON：LoadImage 节点的 inputs.image 为上传后的文件名
    const jsonNode = workflowObj[ioNodeId];
    if (!jsonNode) continue;
    const inputs = jsonNode.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    inputs.image = uploadResult.name;
    // 标准 ComfyUI LoadImage 节点还需要 upload 字段
    if (inputs.upload !== undefined) {
      inputs.upload = 'image';
    }
  }
}

/** 将画布选择的尺寸/比例注入到被 @ 提及的节点中；若未指定任何节点则全量注入 */
function injectDimensionsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  imageSize: string,
  aspectRatio: string,
  mentionedNodeIds?: string[],
): void {
  const dims = mapImageDimensions(imageSize, aspectRatio);
  for (const [nodeId, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    // 有指定节点时，只修改被 @ 的节点
    if (mentionedNodeIds && mentionedNodeIds.length > 0 && !mentionedNodeIds.includes(nodeId)) continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    // 匹配包含 width 和 height 的节点（EmptyLatentImage、EmptySD3LatentImage 等）
    if (inputs.width !== undefined && typeof inputs.width === 'number' && inputs.height !== undefined && typeof inputs.height === 'number') {
      inputs.width = dims.width;
      inputs.height = dims.height;
    }
  }
}

/** 将视频参数注入到被 @ 提及的节点中；若未指定任何节点则全量注入 */
function injectVideoParamsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  videoResolution: number,
  videoFps: number,
  videoFrames: number,
  mentionedNodeIds?: string[],
): void {
  for (const [nodeId, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    // 有指定节点时，只修改被 @ 的节点
    if (mentionedNodeIds && mentionedNodeIds.length > 0 && !mentionedNodeIds.includes(nodeId)) continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    // 注入 width/height 到 latent 或 image 节点
    if (inputs.width !== undefined && typeof inputs.width === 'number' && inputs.height !== undefined && typeof inputs.height === 'number') {
      inputs.width = videoResolution;
      inputs.height = videoResolution;
    }

    // 注入帧率到视频相关节点
    if (inputs.frame_rate !== undefined) {
      inputs.frame_rate = videoFps;
    }
    if (inputs.fps !== undefined && typeof inputs.fps === 'number') {
      inputs.fps = videoFps;
    }

    // 注入帧数
    if (inputs.frame_count !== undefined && typeof inputs.frame_count === 'number') {
      inputs.frame_count = videoFrames;
    }
    if (inputs.frames !== undefined && typeof inputs.frames === 'number') {
      inputs.frames = videoFrames;
    }
    if (inputs.length !== undefined && inputs.frame_count !== undefined && typeof inputs.length === 'number') {
      inputs.length = videoFrames;
    }
  }
}

/** 提交工作流到 ComfyUI，返回 baseUrl 和 promptId */
async function submitComfyUIWorkflow(
  workflowId: string,
  workflowInputs: Record<string, string> | undefined,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ baseUrl: string; promptId: string; workflowObj: Record<string, Record<string, unknown>> }> {
  const baseUrl = getComfyUIConfig();

  // 从 store 中获取工作流定义
  const workflows = useAppStore.getState().workflows;
  const wf = workflows.find((w) => w.id === workflowId);
  if (!wf) {
    throw new Error('所选工作流未找到，请重新导入');
  }

  // 解析工作流 JSON
  let workflowObj: Record<string, Record<string, unknown>>;
  try {
    workflowObj = JSON.parse(wf.fileContent);
  } catch {
    throw new Error('工作流 JSON 解析失败');
  }

  // 收集所有 IO 节点信息
  const ioNodes = wf.ioNodes || [];
  const ioNodeIds = ioNodes.map((io) => io.nodeId);

  // 注入提示词到 prompt 类型 IO 节点
  injectPromptsIntoWorkflow(workflowObj, workflowInputs, prompt, ioNodeIds);

  // 注入图片到 image 类型 IO 节点（上传 → 替换文件名）
  await injectImagesIntoWorkflow(workflowObj, workflowInputs, ioNodes, baseUrl, signal);

  // 返回 workflowObj 让调用方注入尺寸/视频参数后再提交
  return { baseUrl, promptId: '', workflowObj };
}

/** 提交 workflowObj 到 ComfyUI 并返回 promptId */
async function promptComfyUIWorkflow(
  baseUrl: string,
  workflowObj: Record<string, Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<string> {
  const promptRes = await comfyFetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflowObj }),
    signal,
  });

  if (!promptRes.ok) {
    const errorBody = await promptRes.text().catch(() => '');
    throw new Error(`ComfyUI 提交工作流失败 (${promptRes.status})${errorBody ? ': ' + errorBody.slice(0, 200) : ''}`);
  }

  const promptResult = (await promptRes.json()) as { prompt_id?: string; error?: string };
  if (promptResult.error) {
    throw new Error(`ComfyUI 错误: ${promptResult.error}`);
  }
  if (!promptResult.prompt_id) {
    throw new Error('ComfyUI 未返回 prompt_id');
  }

  return promptResult.prompt_id;
}

/* ── ComfyUI 输出文件类型 ── */
interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface ComfyOutputNode {
  images?: ComfyOutputFile[];
  videos?: ComfyOutputFile[];
  gifs?: ComfyOutputFile[];
  audios?: ComfyOutputFile[];
}

type ComfyOutputs = Record<string, ComfyOutputNode>;

interface ComfyHistoryEntry {
  outputs?: ComfyOutputs;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
}

function readComfyFailureMessage(entry: ComfyHistoryEntry): string | null {
  const status = entry.status;
  if (!status) return null;
  if (status.status_str?.toLowerCase() === 'error') {
    for (const message of [...(status.messages ?? [])].reverse()) {
      if (!Array.isArray(message) || typeof message[1] !== 'object' || message[1] === null) continue;
      const detail = message[1] as Record<string, unknown>;
      const text = detail.exception_message ?? detail.error ?? detail.message;
      if (typeof text === 'string' && text.trim()) return `ComfyUI 执行失败：${text.trim()}`;
    }
    return 'ComfyUI 执行失败';
  }
  return null;
}

/** 构造 ComfyUI 文件访问 URL */
function buildComfyFileUrl(baseUrl: string, file: ComfyOutputFile): string {
  const subfolder = file.subfolder ? `&subfolder=${encodeURIComponent(file.subfolder)}` : '';
  const type = file.type ? `&type=${encodeURIComponent(file.type)}` : '&type=output';
  return `${baseUrl}/view?filename=${encodeURIComponent(file.filename)}${subfolder}${type}`;
}

/**
 * ComfyUI 共享轮询：拉取 /history/{promptId}，每 3 秒一次，最多 1200 次（1 小时）
 * @param extract 从 outputs 中提取结果，返回 null 表示仍需等待
 */
async function pollComfyHistory<T>(
  baseUrl: string,
  promptId: string,
  timeoutMsg: string,
  extract: (outputs: ComfyOutputs) => T | null,
  signal?: AbortSignal,
): Promise<T> {
  return pollTask<ComfyHistoryEntry | undefined, T>({
    fetchState: async () => {
      const res = await comfyFetch(`${baseUrl}/history/${promptId}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const history = (await res.json()) as Record<string, unknown>;
      return history[promptId] as ComfyHistoryEntry | undefined;
    },
    isComplete: (entry) => (entry?.outputs ? extract(entry.outputs) : null),
    isFailed: (entry) => {
      if (!entry) return null;
      const failure = readComfyFailureMessage(entry);
      if (failure) return failure;
      if (entry.status?.completed === true) {
        const result = entry.outputs ? extract(entry.outputs) : null;
        if (result === null) return 'ComfyUI 执行完成但未返回目标媒体';
      }
      return null;
    },
    interval: 3000,
    maxAttempts: 1200,
    timeoutMsg,
    signal,
  });
}

/** 轮询 ComfyUI 执行历史，等待图片生成完成 */
async function pollComfyUIHistory(
  baseUrl: string,
  promptId: string,
  dimensions: { width: number; height: number },
  signal?: AbortSignal,
): Promise<{ url: string; width: number; height: number }> {
  return pollComfyHistory(baseUrl, promptId, 'ComfyUI 图片生成超时（1 小时）', (outputs) => {
    for (const nodeOutput of Object.values(outputs)) {
      if (nodeOutput.images?.length) {
        return { url: buildComfyFileUrl(baseUrl, nodeOutput.images[0]), width: dimensions.width, height: dimensions.height };
      }
    }
    return null;
  }, signal);
}

/** 通过 ComfyUI 工作流执行图片生成 */
export async function executeComfyUIGenerate(
  params: AIImageGenParams,
  externalSignal?: AbortSignal,
): Promise<{ url: string; width: number; height: number }> {
  const { workflowId, workflowInputs, prompt, imageSize = '2K', aspectRatio = '1:1' } = params;
  const comfyUrl = useAppStore.getState().config.comfyUIUrl?.trim() || '';
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;

  try {
    // 预存待续任务（在 submit 之前），确保关窗重启后能恢复
    if (params.nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        savePendingTask({
          nodeId: params.nodeId,
          projectId,
          nodeType: 'ai-image',
          provider: 'comfyui',
          taskId: '',
          taskType: 'comfyui',
          baseUrl: comfyUrl,
          submitted: false,
        });
      }
    }

    const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt, signal);

    // 注入画布选择的尺寸（仅对 @提及的节点）
    injectDimensionsIntoWorkflow(
      workflowObj,
      imageSize,
      aspectRatio,
      workflowInputs ? Object.keys(workflowInputs) : undefined,
    );

    // 提交工作流
    const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj, signal);

    // 回填 promptId，标记为已提交
    if (params.nodeId) {
      updatePendingTask(params.nodeId, { taskId: promptId, submitted: true, baseUrl });
    }

    // 计算最终输出尺寸（用于节点显示）
    const dims = mapImageDimensions(imageSize, aspectRatio);

    // 轮询等待结果
    return await pollComfyUIHistory(baseUrl, promptId, dims, signal);
  } finally {
    if (params.nodeId) {
      cleanupNodePolling(params.nodeId);
      removePendingTask(params.nodeId);
    }
  }
}

/** 轮询 ComfyUI 执行历史，等待视频生成完成 */
async function pollComfyUIHistoryForVideo(
  baseUrl: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  return pollComfyHistory(baseUrl, promptId, 'ComfyUI 视频生成超时（1 小时）', (outputs) => {
    for (const nodeOutput of Object.values(outputs)) {
      if (nodeOutput.videos?.length) return { url: buildComfyFileUrl(baseUrl, nodeOutput.videos[0]) };
      if (nodeOutput.gifs?.length) return { url: buildComfyFileUrl(baseUrl, nodeOutput.gifs[0]) };
      if (nodeOutput.images?.length) return { url: buildComfyFileUrl(baseUrl, nodeOutput.images[0]) };
    }
    return null;
  }, signal);
}

/** 通过 ComfyUI 工作流执行视频生成 */
export async function executeComfyUIVideoGenerate(
  params: AIVideoGenParams,
  externalSignal?: AbortSignal,
): Promise<{ url: string }> {
  const { workflowId, workflowInputs, prompt, videoResolution = 832, videoFps = 24, videoFrames = 77 } = params;
  const comfyUrl = useAppStore.getState().config.comfyUIUrl?.trim() || '';
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;

  try {
    // 预存待续任务（在 submit 之前），确保关窗重启后能恢复
    if (params.nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        savePendingTask({
          nodeId: params.nodeId,
          projectId,
          nodeType: 'ai-video',
          provider: 'comfyui',
          taskId: '',
          taskType: 'comfyui',
          baseUrl: comfyUrl,
          submitted: false,
        });
      }
    }

    const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt, signal);

    // 注入视频参数（仅对 @提及的节点）
    injectVideoParamsIntoWorkflow(
      workflowObj,
      videoResolution,
      videoFps,
      videoFrames,
      workflowInputs ? Object.keys(workflowInputs) : undefined,
    );

    // 提交工作流
    const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj, signal);

    // 回填 promptId，标记为已提交
    if (params.nodeId) {
      updatePendingTask(params.nodeId, { taskId: promptId, submitted: true, baseUrl });
    }

    // 轮询等待结果
    return await pollComfyUIHistoryForVideo(baseUrl, promptId, signal);
  } finally {
    if (params.nodeId) {
      cleanupNodePolling(params.nodeId);
      removePendingTask(params.nodeId);
    }
  }
}

/** 轮询 ComfyUI 执行历史，等待音频生成完成 */
async function pollComfyUIHistoryForAudio(
  baseUrl: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  return pollComfyHistory(baseUrl, promptId, 'ComfyUI 音频生成超时（1 小时）', (outputs) => {
    for (const nodeOutput of Object.values(outputs)) {
      if (nodeOutput.audios?.length) return { url: buildComfyFileUrl(baseUrl, nodeOutput.audios[0]) };
      if (nodeOutput.videos?.length) return { url: buildComfyFileUrl(baseUrl, nodeOutput.videos[0]) };
      if (nodeOutput.images?.length) return { url: buildComfyFileUrl(baseUrl, nodeOutput.images[0]) };
    }
    return null;
  }, signal);
}

/** 通过 ComfyUI 工作流执行音频生成 */
export async function executeComfyUIAudioGenerate(
  params: AIAudioGenParams,
  externalSignal?: AbortSignal,
): Promise<{ url: string }> {
  const { workflowId, workflowInputs, prompt } = params;
  const comfyUrl = useAppStore.getState().config.comfyUIUrl?.trim() || '';
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;

  try {
    // 预存待续任务（在 submit 之前），确保关窗重启后能恢复
    if (params.nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        savePendingTask({
          nodeId: params.nodeId,
          projectId,
          nodeType: 'ai-audio',
          provider: 'comfyui',
          taskId: '',
          taskType: 'comfyui',
          baseUrl: comfyUrl,
          submitted: false,
        });
      }
    }

    const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt, signal);

    // 提交工作流
    const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj, signal);

    // 回填 promptId，标记为已提交
    if (params.nodeId) {
      updatePendingTask(params.nodeId, { taskId: promptId, submitted: true, baseUrl });
    }

    // 轮询等待结果
    return await pollComfyUIHistoryForAudio(baseUrl, promptId, signal);
  } finally {
    if (params.nodeId) {
      cleanupNodePolling(params.nodeId);
      removePendingTask(params.nodeId);
    }
  }
}
