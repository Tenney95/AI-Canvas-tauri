/**
 * comfyWorkflowService — ComfyUI workflow execution runtime.
 *
 * Handles workflow JSON mutation, image upload, submission, and result polling.
 */
import { useAppStore } from '../store/useAppStore';
import type { WorkflowIONode } from '../types';
import type { AIAudioGenParams, AIImageGenParams, AIVideoGenParams } from './aiTypes';
import { mapImageDimensions } from './aiDimensions';
import { resolveNodeReferences } from './nodeReferenceService';

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
    const response = await fetch(imageUrl);
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

  const uploadRes = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: formData,
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
    const uploadResult = await uploadImageToComfyUI(baseUrl, imageUrl);

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
  await injectImagesIntoWorkflow(workflowObj, workflowInputs, ioNodes, baseUrl);

  // 返回 workflowObj 让调用方注入尺寸/视频参数后再提交
  return { baseUrl, promptId: '', workflowObj };
}

/** 提交 workflowObj 到 ComfyUI 并返回 promptId */
async function promptComfyUIWorkflow(
  baseUrl: string,
  workflowObj: Record<string, Record<string, unknown>>,
): Promise<string> {
  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflowObj }),
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

/** 轮询 ComfyUI 执行历史，等待图片生成完成 */
async function pollComfyUIHistory(
  baseUrl: string,
  promptId: string,
  dimensions: { width: number; height: number },
): Promise<{ url: string; width: number; height: number }> {
  // 最多轮询 1200 次，每次间隔 3 秒 = 3600 秒（1 小时）超时
  for (let attempt = 0; attempt < 1200; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));

    try {
      const res = await fetch(`${baseUrl}/history/${promptId}`);
      if (!res.ok) continue;

      const history: Record<string, unknown> = await res.json();
      const entry = history[promptId] as Record<string, unknown> | undefined;
      if (!entry) continue;

      const outputs = entry.outputs as Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> | undefined;
      if (!outputs) continue;

      // 遍历所有节点的输出，找第一个包含图片的
      for (const nodeOutput of Object.values(outputs)) {
        if (nodeOutput.images && nodeOutput.images.length > 0) {
          const img = nodeOutput.images[0];
          const subfolder = img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : '';
          const type = img.type ? `&type=${encodeURIComponent(img.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}${subfolder}${type}`;
          return { url, width: dimensions.width, height: dimensions.height };
        }
      }
    } catch {
      // 网络错误时继续轮询
    }
  }

  throw new Error('ComfyUI 图片生成超时（1 小时）');
}

/** 通过 ComfyUI 工作流执行图片生成 */
export async function executeComfyUIGenerate(params: AIImageGenParams): Promise<{ url: string; width: number; height: number }> {
  const { workflowId, workflowInputs, prompt, imageSize = '2K', aspectRatio = '1:1' } = params;

  const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt);

  // 注入画布选择的尺寸（仅对 @提及的节点）
  injectDimensionsIntoWorkflow(
    workflowObj,
    imageSize,
    aspectRatio,
    workflowInputs ? Object.keys(workflowInputs) : undefined,
  );

  // 提交工作流
  const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj);

  // 计算最终输出尺寸（用于节点显示）
  const dims = mapImageDimensions(imageSize, aspectRatio);

  // 轮询等待结果
  return pollComfyUIHistory(baseUrl, promptId, dims);
}

/** 轮询 ComfyUI 执行历史，等待视频生成完成 */
async function pollComfyUIHistoryForVideo(
  baseUrl: string,
  promptId: string,
): Promise<{ url: string }> {
  for (let attempt = 0; attempt < 1200; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));

    try {
      const res = await fetch(`${baseUrl}/history/${promptId}`);
      if (!res.ok) continue;

      const history: Record<string, unknown> = await res.json();
      const entry = history[promptId] as Record<string, unknown> | undefined;
      if (!entry) continue;

      const outputs = entry.outputs as Record<string, { gifs?: Array<{ filename: string; subfolder?: string; type?: string }>; videos?: Array<{ filename: string; subfolder?: string; type?: string }>; images?: Array<{ filename: string; subfolder?: string; type?: string }> }> | undefined;
      if (!outputs) continue;

      // 遍历所有节点输出，先找视频/gif，再 fallback 到图片
      for (const nodeOutput of Object.values(outputs)) {
        // 视频输出
        if (nodeOutput.videos && nodeOutput.videos.length > 0) {
          const vid = nodeOutput.videos[0];
          const subfolder = vid.subfolder ? `&subfolder=${encodeURIComponent(vid.subfolder)}` : '';
          const type = vid.type ? `&type=${encodeURIComponent(vid.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(vid.filename)}${subfolder}${type}`;
          return { url };
        }
        // GIF 输出
        if (nodeOutput.gifs && nodeOutput.gifs.length > 0) {
          const gif = nodeOutput.gifs[0];
          const subfolder = gif.subfolder ? `&subfolder=${encodeURIComponent(gif.subfolder)}` : '';
          const type = gif.type ? `&type=${encodeURIComponent(gif.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(gif.filename)}${subfolder}${type}`;
          return { url };
        }
        // 图片 fallback
        if (nodeOutput.images && nodeOutput.images.length > 0) {
          const img = nodeOutput.images[0];
          const subfolder = img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : '';
          const type = img.type ? `&type=${encodeURIComponent(img.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}${subfolder}${type}`;
          return { url };
        }
      }
    } catch {
      // 网络错误时继续轮询
    }
  }

  throw new Error('ComfyUI 视频生成超时（1 小时）');
}

/** 通过 ComfyUI 工作流执行视频生成 */
export async function executeComfyUIVideoGenerate(params: AIVideoGenParams): Promise<{ url: string }> {
  const { workflowId, workflowInputs, prompt, videoResolution = 832, videoFps = 24, videoFrames = 77 } = params;

  const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt);

  // 注入视频参数（仅对 @提及的节点）
  injectVideoParamsIntoWorkflow(
    workflowObj,
    videoResolution,
    videoFps,
    videoFrames,
    workflowInputs ? Object.keys(workflowInputs) : undefined,
  );

  // 提交工作流
  const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj);

  // 轮询等待结果
  return pollComfyUIHistoryForVideo(baseUrl, promptId);
}

/** 轮询 ComfyUI 执行历史，等待音频生成完成 */
async function pollComfyUIHistoryForAudio(
  baseUrl: string,
  promptId: string,
): Promise<{ url: string }> {
  for (let attempt = 0; attempt < 1200; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));

    try {
      const res = await fetch(`${baseUrl}/history/${promptId}`);
      if (!res.ok) continue;

      const history: Record<string, unknown> = await res.json();
      const entry = history[promptId] as Record<string, unknown> | undefined;
      if (!entry) continue;

      const outputs = entry.outputs as Record<string, {
        audios?: Array<{ filename: string; subfolder?: string; type?: string }>;
        videos?: Array<{ filename: string; subfolder?: string; type?: string }>;
        gifs?: Array<{ filename: string; subfolder?: string; type?: string }>;
        images?: Array<{ filename: string; subfolder?: string; type?: string }>;
      }> | undefined;
      if (!outputs) continue;

      // 遍历所有节点输出，优先找音频
      for (const nodeOutput of Object.values(outputs)) {
        if (nodeOutput.audios && nodeOutput.audios.length > 0) {
          const aud = nodeOutput.audios[0];
          const subfolder = aud.subfolder ? `&subfolder=${encodeURIComponent(aud.subfolder)}` : '';
          const type = aud.type ? `&type=${encodeURIComponent(aud.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(aud.filename)}${subfolder}${type}`;
          return { url };
        }
        // 视频 Fallback
        if (nodeOutput.videos && nodeOutput.videos.length > 0) {
          const vid = nodeOutput.videos[0];
          const subfolder = vid.subfolder ? `&subfolder=${encodeURIComponent(vid.subfolder)}` : '';
          const type = vid.type ? `&type=${encodeURIComponent(vid.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(vid.filename)}${subfolder}${type}`;
          return { url };
        }
        // 图片 Fallback
        if (nodeOutput.images && nodeOutput.images.length > 0) {
          const img = nodeOutput.images[0];
          const subfolder = img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : '';
          const type = img.type ? `&type=${encodeURIComponent(img.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}${subfolder}${type}`;
          return { url };
        }
      }
    } catch {
      // 网络错误时继续轮询
    }
  }

  throw new Error('ComfyUI 音频生成超时（1 小时）');
}

/** 通过 ComfyUI 工作流执行音频生成 */
export async function executeComfyUIAudioGenerate(params: AIAudioGenParams): Promise<{ url: string }> {
  const { workflowId, workflowInputs, prompt } = params;

  const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt);

  // 提交工作流
  const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj);

  // 轮询等待结果
  return pollComfyUIHistoryForAudio(baseUrl, promptId);
}
