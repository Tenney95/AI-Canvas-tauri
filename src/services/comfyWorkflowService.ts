/**
 * comfyWorkflowService — ComfyUI workflow execution runtime.
 *
 * Handles workflow JSON mutation, image upload, submission, and result polling.
 */
import { useAppStore } from '../store/useAppStore';
import { comfyBaseUrlFor } from './comfyServers';
import type { WorkflowIONode, WorkflowIONodeType } from '../types';
import type { AIAudioGenParams, AIImageGenParams, AIVideoGenParams } from '../types/aiTypes';
import { mapImageDimensions, mapVideoDimensions, resolveVideoDurationSeconds } from './aiDimensions';
import { resolveNodeReferences } from './nodeReferenceService';
import {
  cancelNodePolling,
  cleanupNodePolling,
  getPendingTasksForProject,
  registerNodePolling,
  removePendingTask,
  savePendingTask,
  updatePendingTask,
} from './pollManager';
import { comfyFetch, pollComfyHistory } from './comfyPolling';
import { corsSafeFetch } from './ai/httpTransport';
import { resolveComfyOutputUrl } from './comfyOutputs';
import { createComfyProgressSession, type ComfyProgressSession } from './comfyProgress';

/** ComfyUI 已注册的节点类型；同一次会话里短暂缓存，装完插件重开也能很快看到变化 */
let nodeClassCache: { baseUrl: string; classes: Set<string>; fetchedAt: number } | null = null;
const NODE_CLASS_CACHE_TTL = 30_000;

function queueContainsPrompt(queue: unknown, promptId: string): boolean {
  return Array.isArray(queue)
    && queue.some((item) => Array.isArray(item) && item[1] === promptId);
}

async function assertComfyResponse(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const detail = await response.text().catch(() => '');
  throw new Error(`${action}失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`);
}

/**
 * 终止一个节点当前提交给 ComfyUI 的任务。
 * 新版 ComfyUI 使用原子的 job cancel API；旧版回退到队列查询后再做定向删除/中断。
 */
export async function cancelComfyUINodeTask(nodeId: string): Promise<void> {
  const currentProjectId = useAppStore.getState().currentProjectId;
  const task = currentProjectId
    ? getPendingTasksForProject(currentProjectId).find((item) => (
      item.nodeId === nodeId && item.taskType === 'comfyui'
    ))
    : undefined;

  // 先停止本地上传或轮询，避免取消过程中结果又回写到节点。
  cancelNodePolling(nodeId);
  if (!task?.submitted || !task.taskId || !task.baseUrl) return;

  const baseUrl = task.baseUrl.replace(/\/+$/, '');
  const promptId = task.taskId;
  const directResponse = await comfyFetch(
    `${baseUrl}/api/jobs/${encodeURIComponent(promptId)}/cancel`,
    { method: 'POST' },
  );
  if (directResponse.status !== 404) {
    await assertComfyResponse(directResponse, '终止 ComfyUI 任务');
    return;
  }

  // 兼容尚未提供 /api/jobs/:id/cancel 的 ComfyUI 版本。
  const queueResponse = await comfyFetch(`${baseUrl}/queue`);
  await assertComfyResponse(queueResponse, '读取 ComfyUI 队列');
  const queue = (await queueResponse.json()) as Record<string, unknown>;
  if (queueContainsPrompt(queue.queue_pending, promptId)) {
    const deleteResponse = await comfyFetch(`${baseUrl}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    await assertComfyResponse(deleteResponse, '移除 ComfyUI 排队任务');
    return;
  }
  if (queueContainsPrompt(queue.queue_running, promptId)) {
    const interruptResponse = await comfyFetch(`${baseUrl}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId }),
    });
    await assertComfyResponse(interruptResponse, '中断 ComfyUI 运行任务');
  }
}

async function fetchComfyNodeClasses(baseUrl: string): Promise<Set<string> | null> {
  if (
    nodeClassCache
    && nodeClassCache.baseUrl === baseUrl
    && Date.now() - nodeClassCache.fetchedAt < NODE_CLASS_CACHE_TTL
  ) {
    return nodeClassCache.classes;
  }
  const response = await comfyFetch(`${baseUrl}/object_info`);
  if (!response.ok) return null;
  const classes = new Set(Object.keys((await response.json()) as Record<string, unknown>));
  nodeClassCache = { baseUrl, classes, fetchedAt: Date.now() };
  return classes;
}

/** 节点某个输入的声明：combo 的可选值 + 数值范围，用来决定敢不敢写、写多少 */
interface ComfyInputSpec {
  options?: unknown[];
  type?: string;
  min?: number;
  max?: number;
  step?: number;
}
type ComfyNodeInputSpecs = Record<string, ComfyInputSpec>;

const nodeInputSpecCache = new Map<string, { fetchedAt: number; specs: Promise<ComfyNodeInputSpecs | null> }>();

/** /object_info/{class} 的输入声明形如 { name: [type, config] }，combo 的 type 本身就是可选值数组 */
function parseNodeInputSpecs(payload: unknown, classType: string): ComfyNodeInputSpecs | null {
  const groups = (payload as Record<string, { input?: Record<string, Record<string, unknown>> }> | null)
    ?.[classType]?.input;
  if (!groups) return null;
  const specs: ComfyNodeInputSpecs = {};
  for (const group of ['required', 'optional'] as const) {
    for (const [name, declaration] of Object.entries(groups[group] ?? {})) {
      if (!Array.isArray(declaration)) continue;
      const [type, config] = declaration as [unknown, Record<string, unknown> | undefined];
      specs[name] = {
        options: Array.isArray(type) ? type : undefined,
        type: typeof type === 'string' ? type : undefined,
        min: typeof config?.min === 'number' ? config.min : undefined,
        max: typeof config?.max === 'number' ? config.max : undefined,
        step: typeof config?.step === 'number' ? config.step : undefined,
      };
    }
  }
  return specs;
}

/** 单个节点类型的输入声明；问不到就返回 null，调用方按「不敢写」处理 */
async function fetchNodeInputSpecs(baseUrl: string, classType: string): Promise<ComfyNodeInputSpecs | null> {
  const key = `${baseUrl}::${classType}`;
  const cached = nodeInputSpecCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < NODE_CLASS_CACHE_TTL) return cached.specs;
  const specs = (async () => {
    try {
      const response = await comfyFetch(`${baseUrl}/object_info/${encodeURIComponent(classType)}`);
      if (!response.ok) return null;
      return parseNodeInputSpecs(await response.json(), classType);
    } catch {
      return null;
    }
  })();
  nodeInputSpecCache.set(key, { fetchedAt: Date.now(), specs });
  return specs;
}

/**
 * 只为「写之前必须校验」的那几个输入名去问节点声明，一个工作流通常也就一两个节点命中。
 * 问不到就返回空表，注入时这些字段一律跳过，其余数值字段照常写。
 */
async function resolveParamSpecs(
  baseUrl: string,
  workflowObj: Record<string, Record<string, unknown>>,
  inputKeys: readonly string[],
): Promise<Map<string, ComfyNodeInputSpecs>> {
  const classTypes = new Set<string>();
  for (const nodeData of Object.values(workflowObj)) {
    const inputs = nodeData?.inputs as Record<string, unknown> | undefined;
    const classType = typeof nodeData?.class_type === 'string' ? nodeData.class_type : '';
    if (!inputs || !classType) continue;
    // 连线过来的值是数组，那种轮不到我们写
    const needsSpec = inputKeys.some((key) => inputs[key] !== undefined && !Array.isArray(inputs[key]));
    if (needsSpec) classTypes.add(classType);
  }
  const resolved = new Map<string, ComfyNodeInputSpecs>();
  await Promise.all([...classTypes].map(async (classType) => {
    const specs = await fetchNodeInputSpecs(baseUrl, classType);
    if (specs) resolved.set(classType, specs);
  }));
  return resolved;
}

/**
 * 列出工作流里 ComfyUI 没注册的节点类型（多半是没装或没启用对应插件）。
 * 问不到节点清单时返回空数组：宁可放行让 ComfyUI 自己报错，也不要拦住能用的工作流。
 */
export async function findMissingNodeClasses(
  baseUrl: string,
  workflowJson: string,
): Promise<string[]> {
  let workflowObj: Record<string, { class_type?: unknown }>;
  try {
    workflowObj = JSON.parse(workflowJson);
    const classes = await fetchComfyNodeClasses(baseUrl.replace(/\/+$/, ''));
    if (!classes) return [];
    const used = new Set(
      Object.values(workflowObj)
        .map((node) => node?.class_type)
        .filter((classType): classType is string => typeof classType === 'string'),
    );
    return [...used].filter((classType) => !classes.has(classType));
  } catch {
    return [];
  }
}

/** 取工作流要提交的服务端地址并校验（绑定了服务端就用绑定的那台） */
function getComfyUIConfig(workflowId?: string) {
  const comfyUrl = comfyBaseUrlFor(workflowId);
  if (!comfyUrl) {
    throw new Error('未配置 ComfyUI 服务地址\n请在「设置 → 服务地址」中配置');
  }
  return comfyUrl.replace(/\/+$/, '');
}

/** 往指定节点的第一个可用输入键写值；节点或输入键不存在时静默跳过 */
function writeNodeInput(
  workflowObj: Record<string, Record<string, unknown>>,
  nodeId: string,
  keys: string[],
  value: string,
): boolean {
  const inputs = workflowObj[nodeId]?.inputs as Record<string, unknown> | undefined;
  if (!inputs) return false;
  const key = keys.find((candidate) => typeof inputs[candidate] === 'string');
  if (!key) return false;
  inputs[key] = value;
  return true;
}

/** 默认节点按类型接受的输入键：写第一个已存在且是字符串的键 */
const DEFAULT_NODE_INPUT_KEYS: Record<WorkflowIONodeType, string[]> = {
  prompt: ['text', 'prompt', 'string', 'value'],
  image: ['image'],
  video: ['video'],
  audio: ['audio'],
};

/** 将提示词注入到 ComfyUI workflow JSON 的 prompt 类型 IO 节点中 */
function injectPromptsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  workflowInputs: Record<string, string> | undefined,
  fallbackPrompt: string,
  ioNodeIds: string[],
  /** 用户没 @ 任何 prompt 节点时，提示词写入这个节点，跳过下面的占位符猜测 */
  defaultPromptNodeId?: string,
): void {
  if (defaultPromptNodeId) {
    writeNodeInput(workflowObj, defaultPromptNodeId, DEFAULT_NODE_INPUT_KEYS.prompt, fallbackPrompt);
    return;
  }
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

type ComfyMediaKind = 'image' | 'audio' | 'video';

/** data URL 的 mime 子类型与 ComfyUI 能解码的音频容器扩展名不一致，落盘前按此表还原 */
const COMFY_AUDIO_MIME_EXTENSIONS: Record<string, string> = {
  mpeg: 'mp3',
  mp4: 'm4a',
  'x-m4a': 'm4a',
  'x-wav': 'wav',
  wave: 'wav',
};

const COMFY_MEDIA_FALLBACK_EXTENSION: Record<ComfyMediaKind, string> = {
  image: 'png',
  audio: 'mp3',
  video: 'mp4',
};

const COMFY_MEDIA_LABEL: Record<ComfyMediaKind, string> = {
  image: '图片',
  audio: '音频',
  video: '视频',
};

function normalizeComfyMediaExtension(
  kind: ComfyMediaKind,
  mimeSubtype: string | undefined,
  urlExtension: string | undefined,
): string {
  if (mimeSubtype) {
    if (kind === 'audio') return COMFY_AUDIO_MIME_EXTENSIONS[mimeSubtype] ?? mimeSubtype;
    return mimeSubtype;
  }
  return urlExtension || COMFY_MEDIA_FALLBACK_EXTENSION[kind];
}

interface ComfyUploadResult {
  name: string;
  subfolder?: string;
  type?: string;
}

/**
 * 同一份媒体在一次会话里只传一次 —— ComfyUI 的 input 目录是持久的，
 * 同一张参考图喂给多个节点、或连续生成多次都不必反复上传。
 */
const uploadCache = new Map<string, { result: ComfyUploadResult; uploadedAt: number }>();
const UPLOAD_CACHE_LIMIT = 64;
/** 换了 ComfyUI 实例或清过 input 目录时，缓存的文件名会失效，过一会儿重传一次更保险 */
const UPLOAD_CACHE_TTL = 10 * 60_000;

/** data URL 拿全文当键会把整份 base64 长期留在缓存里，改用内容哈希 */
async function uploadCacheKey(baseUrl: string, mediaUrl: string, kind: ComfyMediaKind): Promise<string> {
  const prefix = `${baseUrl}::${kind}::`;
  const subtle = globalThis.crypto?.subtle;
  if (!mediaUrl.startsWith('data:') || !subtle) return prefix + mediaUrl;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(mediaUrl));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}sha256:${hex}`;
}

function rememberUpload(key: string, result: ComfyUploadResult): void {
  uploadCache.set(key, { result, uploadedAt: Date.now() });
  // Map 按插入顺序迭代，超限时丢最早的
  while (uploadCache.size > UPLOAD_CACHE_LIMIT) {
    const oldest = uploadCache.keys().next();
    if (oldest.done) break;
    uploadCache.delete(oldest.value);
  }
}

/**
 * 将图片或音频上传到 ComfyUI 服务器，返回 filename/subfolder/type。
 * ComfyUI 只有 /upload/image 与 /upload/mask 两个上传路由，前者不校验扩展名或 MIME，
 * 默认写入 input 目录，音频同样走它（LoadAudio 只认 input 目录里的文件）。
 */
async function uploadMediaToComfyUI(
  baseUrl: string,
  mediaUrl: string,
  kind: ComfyMediaKind,
  signal?: AbortSignal,
): Promise<ComfyUploadResult> {
  const label = COMFY_MEDIA_LABEL[kind];
  const cacheKey = await uploadCacheKey(baseUrl, mediaUrl, kind);
  const cached = uploadCache.get(cacheKey);
  if (cached && Date.now() - cached.uploadedAt < UPLOAD_CACHE_TTL) return cached.result;
  // 1. 获取 Blob（支持 data URL 和远程 URL）
  let blob: Blob;
  let ext: string;

  if (mediaUrl.startsWith('data:')) {
    // data URL → 直接解析
    const match = mediaUrl.match(/^data:([\w.+-]+)\/([\w.+-]+);base64,(.+)$/);
    if (!match) throw new Error('不支持的 data URL 格式');
    const mimeType = `${match[1]}/${match[2]}`;
    const base64 = match[3];
    const byteChars = atob(base64);
    const byteArr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArr[i] = byteChars.charCodeAt(i);
    }
    blob = new Blob([byteArr], { type: mimeType });
    ext = normalizeComfyMediaExtension(kind, match[2].toLowerCase(), undefined);
  } else {
    // 远程 URL → 取回字节。http(s) 一律走 Rust 通道：WebView 对 ComfyUI /view、
    // 各家 CDN 这类第三方源没有 CORS 许可，裸 fetch 会直接 Failed to fetch。
    // asset.localhost / blob: 是 WebView 自己的资源，reqwest 拿不到，仍走原生 fetch。
    const useNativeChannel = /^https?:\/\//i.test(mediaUrl) && !mediaUrl.includes('asset.localhost');
    const response = await (useNativeChannel ? corsSafeFetch : fetch)(mediaUrl, { signal });
    if (!response.ok) {
      throw new Error(`下载${label}失败 (${response.status})`);
    }
    blob = await response.blob();
    // 从 Content-Type 或 URL 推断扩展名
    const mimeSubtype = (response.headers.get('Content-Type') || '')
      .split(';')[0]
      .split('/')[1]
      ?.toLowerCase();
    ext = normalizeComfyMediaExtension(
      kind,
      mimeSubtype || undefined,
      mediaUrl.split(/[?#]/)[0].split('.').pop()?.toLowerCase(),
    );
  }

  // 2. 上传到 ComfyUI /upload/image（表单字段名固定为 image，音频亦然）
  const formData = new FormData();
  // 加随机后缀：同一毫秒内的两次上传会撞名，overwrite 之下后者会盖掉前者
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  formData.append('image', blob, `upload_${unique}.${ext}`);
  // 覆盖同名文件，避免重复堆积
  formData.append('overwrite', 'true');

  const uploadRes = await comfyFetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: formData,
    signal,
  });

  if (!uploadRes.ok) {
    const errorBody = await uploadRes.text().catch(() => '');
    throw new Error(`ComfyUI ${label}上传失败 (${uploadRes.status})${errorBody ? ': ' + errorBody.slice(0, 200) : ''}`);
  }

  const uploadResult = (await uploadRes.json()) as ComfyUploadResult;
  if (!uploadResult.name) {
    throw new Error('ComfyUI 上传返回结果异常：缺少文件名');
  }

  rememberUpload(cacheKey, uploadResult);
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
    const uploadResult = await uploadMediaToComfyUI(baseUrl, imageUrl, 'image', signal);

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

/**
 * 将音频注入到 ComfyUI workflow JSON 的 audio 类型 IO 节点中。
 * ComfyUI 内置 LoadAudio 的输入名为 audio，取值是 input 目录下的文件名
 * （VideoHelperSuite 的 VHS_LoadAudioUpload 同名），所以上传后写文件名即可。
 * 未显式赋值的 audio IO 节点按顺序用连线音频兜底 —— 角色库绑定的声音正是这样进来的。
 */
async function injectAudioIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  workflowInputs: Record<string, string> | undefined,
  ioNodes: WorkflowIONode[],
  baseUrl: string,
  referenceAudioUrls: string[],
  signal?: AbortSignal,
  /** 指定了默认音频节点且用户没 @ 音频节点时，只填这一个 */
  defaultAudioNodeId?: string,
): Promise<void> {
  const allAudioIoNodeIds = ioNodes
    .filter((io) => io.type === 'audio')
    .map((io) => io.nodeId);
  const audioIoNodeIds = defaultAudioNodeId && allAudioIoNodeIds.includes(defaultAudioNodeId)
    ? [defaultAudioNodeId]
    : allAudioIoNodeIds;
  if (audioIoNodeIds.length === 0) return;

  const fallbackUrls = [...referenceAudioUrls];
  for (const ioNodeId of audioIoNodeIds) {
    const rawValue = workflowInputs?.[ioNodeId];
    const resolvedValue = rawValue !== undefined ? resolveNodeReferences(rawValue).trim() : '';
    // 显式赋值优先；解析后仍是 @{...} 占位符视为未赋值
    const explicitUrl = resolvedValue && !resolvedValue.startsWith('@{') ? resolvedValue : '';
    const audioUrl = explicitUrl || fallbackUrls.shift() || '';
    if (!audioUrl) continue;

    const jsonNode = workflowObj[ioNodeId];
    const inputs = jsonNode?.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    // VHS 的路径变体（VHS_LoadAudio）读的是 ComfyUI 主机上的绝对路径，
    // 上传到 input 目录得到的文件名对它无效，宁可跳过也不写入错误的路径。
    if (inputs.audio === undefined && inputs.audio_file !== undefined) {
      console.warn('[comfyWorkflowService] 该音频节点按主机路径取音频，已跳过注入', ioNodeId);
      continue;
    }

    const uploadResult = await uploadMediaToComfyUI(baseUrl, audioUrl, 'audio', signal);
    // 内置 LoadAudio 与 VHS_LoadAudioUpload 的输入名都是 audio，取值为 input 目录下的文件名
    inputs.audio = uploadResult.name;
    if (inputs.upload !== undefined) {
      inputs.upload = 'audio';
    }
  }
}

/** 媒体加载节点接受 input 目录文件名的输入键：核心 LoadVideo 用的是 file */
const MEDIA_LOADER_INPUT_KEYS: Record<'image' | 'video', string[]> = {
  image: ['image'],
  video: ['video', 'file'],
};

function mediaLoaderInputKey(
  inputs: Record<string, unknown>,
  kind: 'image' | 'video',
): string | undefined {
  return MEDIA_LOADER_INPUT_KEYS[kind].find((key) => typeof inputs[key] === 'string');
}

/**
 * 摘掉没喂到内容的可选参考位。
 * ComfyUI 的 autogrow 输入形如 "ref_images.ref_image_1"，带点号的键都是可选槽；
 * 顺着链路找下去，只要终点全是这种槽就能整条摘掉，否则一律保留（少一张图报错也好过删错节点）。
 */
function pruneOptionalMediaNode(
  workflowObj: Record<string, Record<string, unknown>>,
  startNodeId: string,
): void {
  const chain = new Set([startNodeId]);
  const optionalRefs: Array<[Record<string, unknown>, string]> = [];
  const queue = [startNodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let consumed = false;
    for (const [nodeId, nodeData] of Object.entries(workflowObj)) {
      const inputs = nodeData?.inputs as Record<string, unknown> | undefined;
      if (!inputs) continue;
      for (const [key, value] of Object.entries(inputs)) {
        if (!Array.isArray(value) || value[0] !== current) continue;
        consumed = true;
        if (key.includes('.')) {
          optionalRefs.push([inputs, key]);
        } else if (!chain.has(nodeId)) {
          // 必填输入：只有把消费者一起摘掉才合法，继续往下判断
          chain.add(nodeId);
          queue.push(nodeId);
        }
      }
    }
    // 没有任何下游的节点是出图/存盘之类的终点，摘掉等于毁掉工作流
    if (!consumed) return;
  }

  for (const [inputs, key] of optionalRefs) delete inputs[key];
  for (const nodeId of chain) delete workflowObj[nodeId];
}

/**
 * 用户没 @ 该类型 IO 节点时，把提示词框里的同类媒体依次注入该类型的所有加载节点
 * （默认节点排第一位）。没轮到内容的可选参考位会被摘掉，避免残留的示例文件名让工作流报错。
 */
async function injectDefaultMediaIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  ioNodes: WorkflowIONode[],
  defaultNodeId: string,
  kind: 'image' | 'video',
  mediaUrls: string[],
  /** 用户这次带了参考媒体：以他给的为准，没轮到的可选参考位清掉 */
  pruneUnfilled: boolean,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const targets = [
    defaultNodeId,
    ...ioNodes
      .filter((io) => io.type === kind && io.nodeId !== defaultNodeId)
      .map((io) => io.nodeId),
  ].filter((nodeId) => workflowObj[nodeId]?.inputs);
  const urls = mediaUrls
    .map((url) => url?.trim())
    .filter((url): url is string => Boolean(url) && !url.startsWith('@{'));
  // 一份媒体都没带时保持工作流原样，用户在 ComfyUI 里配好的输入照旧生效
  if (urls.length === 0 && !pruneUnfilled) return;

  for (const [index, nodeId] of targets.entries()) {
    const inputs = workflowObj[nodeId].inputs as Record<string, unknown>;
    const inputKey = mediaLoaderInputKey(inputs, kind);
    // VHS 的路径变体读的是 ComfyUI 主机上的绝对路径，上传到 input 目录得到的文件名对它无效
    if (!inputKey) {
      console.warn('[comfyWorkflowService] 该节点不接受 input 目录文件名，已跳过注入', nodeId);
      continue;
    }
    if (index >= urls.length) {
      pruneOptionalMediaNode(workflowObj, nodeId);
      continue;
    }
    const uploadResult = await uploadMediaToComfyUI(baseUrl, urls[index], kind, signal);
    inputs[inputKey] = uploadResult.name;
    if (inputs.upload !== undefined) {
      inputs.upload = kind;
    }
  }
}

/**
 * ResolutionSelector 这类节点没有 width/height 数字输入，靠「比例 + 总像素」算尺寸。
 * aspect_ratio 是 combo，写不认识的值会被服务端判非法，所以只写查得到的档位。
 */
const RESOLUTION_SELECTOR_RATIOS: Record<string, string> = {
  '1:1': '1:1 (Square)',
  '2:3': '2:3 (Portrait Photo)',
  '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)',
  '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)',
  '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
};

const DIMENSION_KEY_PAIRS = [
  ['width', 'height', 'always'],
  ['image_width', 'image_height', 'semantic'],
  ['target_width', 'target_height', 'semantic'],
  ['output_width', 'output_height', 'semantic'],
  ['latent_width', 'latent_height', 'semantic'],
  ['video_width', 'video_height', 'semantic'],
  ['custom_width', 'custom_height', 'custom'],
] as const;

const IMAGE_RESOLUTION_KEYS = ['resolution', 'image_size', 'size'] as const;
const RATIO_PRESET_KEYS = ['ratio_preset'] as const;
const IMAGE_PARAM_SPEC_KEYS = [
  'aspect_ratio', 'megapixels', ...IMAGE_RESOLUTION_KEYS, ...RATIO_PRESET_KEYS,
  'width', 'height', 'image_width', 'image_height', 'target_width', 'target_height',
  'output_width', 'output_height', 'latent_width', 'latent_height',
  'video_width', 'video_height', 'custom_width', 'custom_height',
] as const;

const DIMENSION_ALIAS_NODE = /(?:empty|latent|resolution|dimension|canvas|generate|generation|conditioning|(?:image|video).?to.?(?:image|video)|(?:text|txt).?to.?(?:image|video)|(?:t2i|i2v|t2v|v2v))/i;
const DIMENSION_PREPROCESS_NODE = /(?:load|loader|resize|rescale|scale|crop|pad|upscale|upscaler|constrain|constraint|preprocess|preview|save|encode|decode)/i;

type ComfyConnection = [string, number];

interface LinkedDimensionAssignment {
  nodeId: string;
  inputs: Record<string, unknown>;
  inputKey: string;
  value: number;
}

function isComfyConnection(value: unknown): value is ComfyConnection {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'string'
    && typeof value[1] === 'number';
}

function normalizeComfyDimension(value: number, spec?: ComfyInputSpec): number {
  const lower = typeof spec?.min === 'number' ? Math.max(64, spec.min) : 64;
  const upper = typeof spec?.max === 'number' ? Math.min(16_384, spec.max) : 16_384;
  const bounded = Math.min(upper, Math.max(lower, value));
  const step = typeof spec?.step === 'number' && Number.isFinite(spec.step) && spec.step > 0
    ? spec.step
    : 8;
  const origin = typeof spec?.min === 'number' ? spec.min : 0;
  let aligned = origin + Math.round((bounded - origin) / step) * step;
  if (aligned < lower) aligned = origin + Math.ceil((lower - origin) / step) * step;
  if (aligned > upper) aligned = origin + Math.floor((upper - origin) / step) * step;
  return Math.round(Math.min(upper, Math.max(lower, aligned)));
}

function canWriteDimensionValue(value: unknown, spec: ComfyInputSpec | undefined): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return typeof value === 'string'
    && /^\d+(?:\.\d+)?$/.test(value.trim())
    && /^(INT|FLOAT|NUMBER)$/i.test(spec?.type ?? '');
}

function dimensionNodeDescriptor(nodeData: Record<string, unknown>): string {
  const title = (nodeData._meta as Record<string, unknown> | undefined)?.title;
  return `${String(nodeData.class_type ?? '')} ${typeof title === 'string' ? title : ''}`;
}

/**
 * target/custom 等别名在预处理节点里也很常见，不能只凭字段名改写。
 * 节点名称明确表达生成尺寸，或同时暴露比例/分辨率选择器时，才认为是输出尺寸节点。
 */
function allowsDimensionAliases(
  nodeData: Record<string, unknown>,
  inputs: Record<string, unknown>,
): boolean {
  const descriptor = dimensionNodeDescriptor(nodeData);
  if (DIMENSION_PREPROCESS_NODE.test(descriptor)) return false;
  return DIMENSION_ALIAS_NODE.test(descriptor)
    || inputs.aspect_ratio !== undefined
    || inputs.resolution !== undefined
    || inputs.megapixels !== undefined;
}

function usesCustomDimensions(inputs: Record<string, unknown>): boolean {
  return [inputs.resolution, inputs.aspect_ratio]
    .some((value) => typeof value === 'string' && /(?:custom|自定义)/i.test(value));
}

/** 只追踪明确的标量 Primitive；Reroute 只负责透明转发，绝不改写连接数组本身。 */
function resolveLinkedDimensionPrimitive(
  workflowObj: Record<string, Record<string, unknown>>,
  connection: ComfyConnection,
  visited = new Set<string>(),
): Omit<LinkedDimensionAssignment, 'value'> | null {
  const sourceId = connection[0];
  if (visited.has(sourceId) || visited.size >= 8) return null;
  visited.add(sourceId);
  const sourceNode = workflowObj[sourceId];
  const sourceInputs = sourceNode?.inputs as Record<string, unknown> | undefined;
  if (!sourceNode || !sourceInputs) return null;
  const classType = String(sourceNode.class_type ?? '');

  if (/^Primitive(?:Int|Float|Number)?$/i.test(classType)) {
    const inputKey = ['value', 'int', 'float', 'number']
      .find((key) => (
        typeof sourceInputs[key] === 'number' && Number.isFinite(sourceInputs[key])
      ) || (
        typeof sourceInputs[key] === 'string' && /^\d+(?:\.\d+)?$/.test(sourceInputs[key].trim())
      ));
    return inputKey ? { nodeId: sourceId, inputs: sourceInputs, inputKey } : null;
  }

  if (/reroute/i.test(classType)) {
    const upstream = Object.values(sourceInputs).filter(isComfyConnection);
    return upstream.length === 1
      ? resolveLinkedDimensionPrimitive(workflowObj, upstream[0], visited)
      : null;
  }
  return null;
}

function planLinkedDimension(
  workflowObj: Record<string, Record<string, unknown>>,
  connection: ComfyConnection,
  value: number,
  assignments: Map<string, LinkedDimensionAssignment>,
  conflicts: Set<string>,
): void {
  const target = resolveLinkedDimensionPrimitive(workflowObj, connection);
  if (!target) return;
  const key = `${target.nodeId}:${target.inputKey}`;
  const previous = assignments.get(key);
  if (previous && previous.value !== value) conflicts.add(key);
  else assignments.set(key, { ...target, value });
}

function applyLinkedDimensionAssignments(
  assignments: Map<string, LinkedDimensionAssignment>,
  conflicts: Set<string>,
): number {
  let applied = 0;
  for (const [key, assignment] of assignments) {
    if (conflicts.has(key)) continue;
    assignment.inputs[assignment.inputKey] = assignment.value;
    applied += 1;
  }
  if (conflicts.size > 0) {
    console.warn('[comfyWorkflowService] 宽高共享同一标量节点且目标值冲突，已保留工作流原值', [...conflicts]);
  }
  return applied;
}

function injectDimensionPairs(
  workflowObj: Record<string, Record<string, unknown>>,
  nodeData: Record<string, unknown>,
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  specs: ComfyNodeInputSpecs | undefined,
  assignments: Map<string, LinkedDimensionAssignment>,
  conflicts: Set<string>,
): number {
  let matched = 0;
  const aliasesAllowed = allowsDimensionAliases(nodeData, inputs);
  for (const [widthKey, heightKey, policy] of DIMENSION_KEY_PAIRS) {
    if (!(widthKey in inputs) || !(heightKey in inputs)) continue;
    if (policy !== 'always' && !aliasesAllowed) continue;
    if (policy === 'custom' && !usesCustomDimensions(inputs)) continue;
    for (const [key, targetValue] of [[widthKey, dims.width], [heightKey, dims.height]] as const) {
      const value = inputs[key];
      const normalized = normalizeComfyDimension(targetValue, specs?.[key]);
      if (canWriteDimensionValue(value, specs?.[key])) {
        inputs[key] = normalized;
        matched += 1;
      } else if (isComfyConnection(value)) {
        planLinkedDimension(workflowObj, value, normalized, assignments, conflicts);
        // 实际写入数由 applyLinkedDimensionAssignments 统一统计；冲突连接不会被误报为已应用。
      }
    }
  }
  return matched;
}

function pickImageResolutionOption(
  options: unknown[],
  imageSize: string,
  dims: { width: number; height: number },
): unknown {
  const normalizedSize = imageSize.trim().toLowerCase();
  const exact = options.find((option): option is string => {
    if (typeof option !== 'string') return false;
    const normalized = option.trim().toLowerCase();
    return normalized === normalizedSize || normalized.startsWith(`${normalizedSize} `);
  });
  if (exact !== undefined) return exact;
  const labeled = pickResolutionOption(options, dims);
  return labeled ?? pickClosestNumericOption(options, Math.min(dims.width, dims.height));
}

interface RatioPresetSelection {
  option: string;
  dimensions?: { width: number; height: number };
}

function parseRatioValue(label: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(label);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : undefined;
}

function parsePresetDimensions(label: string): { width: number; height: number } | undefined {
  const match = /(\d{2,5})\s*[x×]\s*(\d{2,5})/i.exec(label);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width >= 64 && height >= 64 ? { width, height } : undefined;
}

/**
 * CatPixel 这类节点把比例和固定像素合并在一个 combo 里。
 * 只从 object_info 的合法选项中挑精确比例；同一比例有多个档位时再按面积选最近项。
 */
function pickRatioPresetOption(
  options: unknown[],
  aspectRatio: string | undefined,
  dims: { width: number; height: number },
): RatioPresetSelection | undefined {
  if (!aspectRatio) return undefined;
  const targetRatio = parseRatioValue(aspectRatio);
  if (targetRatio === undefined) return undefined;
  const targetArea = dims.width * dims.height;
  let best: RatioPresetSelection | undefined;
  let bestSizeDelta = Infinity;

  for (const option of options) {
    if (typeof option !== 'string') continue;
    const dimensions = parsePresetDimensions(option);
    const candidateRatio = parseRatioValue(option)
      ?? (dimensions ? dimensions.width / dimensions.height : undefined);
    if (candidateRatio === undefined) continue;
    const ratioDelta = Math.abs(candidateRatio - targetRatio) / targetRatio;
    if (ratioDelta > 0.01) continue;
    const sizeDelta = dimensions
      ? Math.abs(Math.log((dimensions.width * dimensions.height) / targetArea))
      : Infinity;
    if (!best || sizeDelta < bestSizeDelta) {
      best = { option, dimensions };
      bestSizeDelta = sizeDelta;
    }
  }
  return best;
}

function writeRatioPresetInput(
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  aspectRatio: string | undefined,
  specs: ComfyNodeInputSpecs | undefined,
): { matched: number; dimensions?: { width: number; height: number } } {
  const current = inputs.ratio_preset;
  const options = specs?.ratio_preset?.options;
  if (typeof current !== 'string' || !options) return { matched: 0 };
  const selected = pickRatioPresetOption(options, aspectRatio, dims);
  if (!selected) return { matched: 0 };
  inputs.ratio_preset = selected.option;
  return { matched: 1, dimensions: selected.dimensions };
}

function writeImageResolutionInputs(
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  imageSize: string,
  specs: ComfyNodeInputSpecs | undefined,
): number {
  let matched = 0;
  for (const key of IMAGE_RESOLUTION_KEYS) {
    const current = inputs[key];
    if (current === undefined || Array.isArray(current)) continue;
    const spec = specs?.[key];
    let next: unknown;
    if (spec?.options) {
      next = pickImageResolutionOption(spec.options, imageSize, dims);
    } else if (typeof current === 'string' && /^(?:720p|[124]k)$/i.test(current.trim())) {
      next = imageSize;
    } else if (typeof current === 'string' && /^\d+\s*[x×]\s*\d+$/i.test(current.trim())) {
      next = `${dims.width}x${dims.height}`;
    } else if (
      key === 'resolution'
      && typeof current === 'number'
      && current >= 64
    ) {
      // 图片尺寸档位以短边定义（1K/2K/4K）；视频的 resolution 才按长边语义处理。
      next = normalizeComfyDimension(Math.min(dims.width, dims.height), spec);
    } else if (
      key === 'resolution'
      && typeof current === 'string'
      && /^\d+(?:\.\d+)?$/.test(current.trim())
      && /^(INT|FLOAT|NUMBER)$/i.test(spec?.type ?? '')
    ) {
      next = normalizeComfyDimension(Math.min(dims.width, dims.height), spec);
    }
    if (next !== undefined) {
      inputs[key] = next;
      matched += 1;
    }
  }
  return matched;
}

function writeResolutionSelector(
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  aspectRatio: string | undefined,
  specs?: ComfyNodeInputSpecs,
): number {
  if (typeof inputs.aspect_ratio !== 'string' || typeof inputs.megapixels !== 'number') return 0;
  // 问得到可选值就按可选值挑（能兼容表里没有的档位写法），问不到再退回内置对照表
  const options = specs?.aspect_ratio?.options;
  const label = options
    ? pickAspectRatioOption(options, aspectRatio)
    : aspectRatio ? RESOLUTION_SELECTOR_RATIOS[aspectRatio] : undefined;
  let matched = 0;
  if (label !== undefined) {
    inputs.aspect_ratio = label;
    matched += 1;
  }
  const megapixels = Math.round((dims.width * dims.height) / 10_000) / 100;
  inputs.megapixels = clampToSpec(megapixels, specs?.megapixels, 0.1, 16);
  return matched + 1;
}

/**
 * 将画布选择的尺寸/比例注入工作流。
 * 注入所有带 width/height 的节点：被 @ 的都是提示词/图片 IO 节点，按它们过滤等于什么都不注入。
 */
async function injectDimensionsIntoWorkflow(
  baseUrl: string,
  workflowObj: Record<string, Record<string, unknown>>,
  imageSize: string,
  aspectRatio: string,
): Promise<{ dimensions: { width: number; height: number }; matchedInputs: number }> {
  const mapped = mapImageDimensions(imageSize, aspectRatio);
  const dims = {
    width: normalizeComfyDimension(mapped.width),
    height: normalizeComfyDimension(mapped.height),
  };
  const specsByClass = await resolveParamSpecs(baseUrl, workflowObj, IMAGE_PARAM_SPEC_KEYS);
  const assignments = new Map<string, LinkedDimensionAssignment>();
  const conflicts = new Set<string>();
  let matchedInputs = 0;
  let nonPresetMatchedInputs = 0;
  let presetDimensions: { width: number; height: number } | undefined;
  let presetDimensionsConflict = false;

  for (const [, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    const classType = String(nodeData.class_type ?? '');
    const specs = specsByClass.get(classType);
    const dimensionPairMatches = injectDimensionPairs(
      workflowObj, nodeData, inputs, dims, specs, assignments, conflicts,
    );
    matchedInputs += dimensionPairMatches;
    nonPresetMatchedInputs += dimensionPairMatches;

    const ratioPresetResult = writeRatioPresetInput(inputs, dims, aspectRatio, specs);
    matchedInputs += ratioPresetResult.matched;
    if (ratioPresetResult.dimensions) {
      if (presetDimensions && (
        presetDimensions.width !== ratioPresetResult.dimensions.width
        || presetDimensions.height !== ratioPresetResult.dimensions.height
      )) {
        presetDimensionsConflict = true;
      } else {
        presetDimensions = ratioPresetResult.dimensions;
      }
    }

    if (typeof inputs.aspect_ratio === 'string' && typeof inputs.megapixels === 'number') {
      const selectorMatches = writeResolutionSelector(inputs, dims, aspectRatio, specs);
      matchedInputs += selectorMatches;
      nonPresetMatchedInputs += selectorMatches;
    } else {
      if (writeAspectRatio(inputs, aspectRatio, specs)) {
        matchedInputs += 1;
        nonPresetMatchedInputs += 1;
      }
    }
    const resolutionMatches = writeImageResolutionInputs(inputs, dims, imageSize, specs);
    matchedInputs += resolutionMatches;
    nonPresetMatchedInputs += resolutionMatches;
  }

  const linkedDimensionMatches = applyLinkedDimensionAssignments(assignments, conflicts);
  matchedInputs += linkedDimensionMatches;
  nonPresetMatchedInputs += linkedDimensionMatches;
  if (matchedInputs === 0) {
    console.warn('[comfyWorkflowService] 工作流未找到可映射的图片宽高或分辨率输入');
  }
  if (presetDimensionsConflict) {
    console.warn('[comfyWorkflowService] 工作流存在多个冲突的比例预设尺寸，结果元数据保留画布目标值');
  }
  const effectiveDimensions = presetDimensions && !presetDimensionsConflict && nonPresetMatchedInputs === 0
    ? presetDimensions
    : dims;
  return { dimensions: effectiveDimensions, matchedInputs };
}

/** 秒数节点：工作流自己按秒算帧数（PrimitiveFloat + 数学表达式），比直接写帧数更可靠 */
function writeDurationSeconds(
  nodeData: Record<string, unknown>,
  inputs: Record<string, unknown>,
  durationSeconds: number,
): boolean {
  if (!/^Primitive(Float|Int)$/i.test(String(nodeData.class_type ?? ''))) return false;
  const title = String((nodeData._meta as Record<string, unknown> | undefined)?.title ?? '');
  if (!/duration|时长|秒/i.test(title) || typeof inputs.value !== 'number') return false;
  inputs.value = durationSeconds;
  return true;
}

/* ──────────────────────────────────────────────────────────────
   视频参数注入
   认哪些输入名是照着 ComfyUI 核心（comfy_extras、comfy_api_nodes）和常用插件的节点定义列的：
   - 帧数：length（Wan / Hunyuan / Mochi / LTXV latent）、num_frames（WanVideoWrapper 全家、
           WanTrackToVideo）、video_frames（SVD_img2vid_Conditioning）、frame_count、frames
   - 帧率：fps（CreateVideo、SaveWEBM、SVD）、frame_rate（LTXVConditioning、VHS_VideoCombine）
   - 时长：duration / duration_seconds（MiniMax、Kling、Vidu、Pixverse、Sora、Veo 等 API 节点，单位秒）
   - 尺寸：width/height；ResolutionSelector 的 aspect_ratio + megapixels；
           API 节点的 aspect_ratio（纯 "16:9"）与 resolution（"720p" 这类档位或 "1920x1080"）
   刻意不碰的：LoadVideo 系列的 custom_width / custom_height / force_rate / frame_load_cap
   （那是给输入素材用的），以及裁剪类节点的 duration（Video Slice 的 duration 是截取长度）。
   ────────────────────────────────────────────────────────────── */

const FRAME_COUNT_KEYS = ['frame_count', 'frames', 'num_frames', 'video_frames'] as const;
const FPS_KEYS = ['fps', 'frame_rate'] as const;
const DURATION_KEYS = ['duration', 'duration_seconds'] as const;
/** 这些输入名要按节点声明的可选值校验才敢写，否则 ComfyUI 会判非法直接拒掉整个任务 */
const COMBO_GUARDED_KEYS = ['aspect_ratio', 'resolution', ...DURATION_KEYS] as const;
const VIDEO_PARAM_SPEC_KEYS = [
  ...COMBO_GUARDED_KEYS,
  'width', 'height', 'image_width', 'image_height', 'target_width', 'target_height',
  'output_width', 'output_height', 'latent_width', 'latent_height', 'video_width', 'video_height',
  'custom_width', 'custom_height',
] as const;
/** 处理输入素材的节点：同名参数改的是素材本身，不是出片规格 */
const INPUT_MEDIA_CLASS = /load(video|image)|videoload|loadvideo/i;
/** 裁剪类节点：duration 是截取长度而非出片时长 */
const TRIM_CLASS = /slice|trim|cut|crop/i;

/** 档位标签 → 长边像素，用来在 resolution 这类 combo 里挑最接近的一档 */
const RESOLUTION_LABEL_LONG_SIDES: Record<string, number> = {
  '360p': 640, '480p': 854, '540p': 960, '720p': 1280,
  '1080p': 1920, '1440p': 2560, '2160p': 3840,
  '1k': 1024, '2k': 2048, '4k': 3840,
};

/** 从 combo 里挑与目标长边最接近的一档；"1920x1080" 这种写法还要求朝向一致 */
function pickResolutionOption(
  options: unknown[],
  dims: { width: number; height: number },
): string | undefined {
  const targetLongSide = Math.max(dims.width, dims.height);
  const isPortrait = dims.height > dims.width;
  let best: string | undefined;
  let bestDelta = Infinity;
  for (const option of options) {
    if (typeof option !== 'string') continue;
    const explicit = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(option.trim());
    let longSide: number | undefined;
    if (explicit) {
      const width = Number(explicit[1]);
      const height = Number(explicit[2]);
      if (height > width !== isPortrait) continue;
      longSide = Math.max(width, height);
    } else {
      longSide = RESOLUTION_LABEL_LONG_SIDES[option.trim().toLowerCase()];
    }
    if (longSide === undefined) continue;
    const delta = Math.abs(longSide - targetLongSide);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = option;
    }
  }
  return best;
}

/** "16:9" 和 "16:9 (Widescreen)" 都算命中 */
function pickAspectRatioOption(options: unknown[], ratio: string | undefined): string | undefined {
  if (!ratio) return undefined;
  return options.find(
    (option): option is string =>
      typeof option === 'string'
      && (option.trim() === ratio || option.trim().startsWith(`${ratio} `)),
  );
}

/** 时长 combo 只给 5/10 而用户选了 7 时，退到最近的一档，总好过让整个任务被判非法 */
function pickClosestNumericOption(options: unknown[], target: number): unknown {
  let best: unknown;
  let bestDelta = Infinity;
  for (const option of options) {
    const value = typeof option === 'number'
      ? option
      : typeof option === 'string' ? Number(option.trim().replace(/s$/i, '')) : NaN;
    if (!Number.isFinite(value)) continue;
    const delta = Math.abs(value - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = option;
    }
  }
  return best;
}

function clampToSpec(value: number, spec: ComfyInputSpec | undefined, min: number, max: number): number {
  const lower = typeof spec?.min === 'number' ? Math.max(min, spec.min) : min;
  const upper = typeof spec?.max === 'number' ? Math.min(max, spec.max) : max;
  return Math.min(upper, Math.max(lower, value));
}

/** API 节点上的纯比例（"16:9"）；带 megapixels 的 ResolutionSelector 已在别处写过 */
function writeAspectRatio(
  inputs: Record<string, unknown>,
  ratio: string | undefined,
  specs: ComfyNodeInputSpecs | undefined,
): boolean {
  if (typeof inputs.aspect_ratio !== 'string' || typeof inputs.megapixels === 'number') return false;
  const options = specs?.aspect_ratio?.options;
  // 问不到可选值就不写：猜错一个档位写法会让整个任务被拒
  if (!options) return false;
  const picked = pickAspectRatioOption(options, ratio);
  if (picked === undefined) return false;
  inputs.aspect_ratio = picked;
  return true;
}

/** API 节点上的档位式 resolution；数字型的（长边像素）按数字写 */
function writeResolutionInput(
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  specs: ComfyNodeInputSpecs | undefined,
): void {
  const current = inputs.resolution;
  if (typeof current === 'number') {
    // 只认已经是像素量级的，避免把倍率、缩放系数之类的同名参数改坏
    if (current >= 64) inputs.resolution = clampToSpec(Math.max(dims.width, dims.height), specs?.resolution, 64, 16_384);
    return;
  }
  if (typeof current !== 'string') return;
  const options = specs?.resolution?.options;
  if (!options) return;
  const picked = pickResolutionOption(options, dims);
  if (picked !== undefined) inputs.resolution = picked;
}

/** 秒数：数字直接写，combo / 字符串保持原来的写法（"5" 还是 "5s"） */
function writeDurationInputs(
  inputs: Record<string, unknown>,
  classType: string,
  durationSeconds: number,
  specs: ComfyNodeInputSpecs | undefined,
): void {
  if (TRIM_CLASS.test(classType)) return;
  for (const key of DURATION_KEYS) {
    const current = inputs[key];
    const spec = specs?.[key];
    if (spec?.options) {
      const picked = pickClosestNumericOption(spec.options, durationSeconds);
      if (picked !== undefined) inputs[key] = picked;
      continue;
    }
    // 字符串型（非 combo）不写：写错格式同样会被判非法
    if (typeof current === 'number') {
      inputs[key] = clampToSpec(durationSeconds, spec, 0, Number.MAX_SAFE_INTEGER);
    }
  }
}

/**
 * 将视频参数注入工作流。
 * 同样不按 @ 过滤：分辨率、帧率、帧数都在 latent / 合成节点上，用户不会去 @ 它们。
 */
function injectVideoParamsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  videoResolution: number,
  videoRatio: string | undefined,
  videoFps: number,
  videoFrames: number,
  durationSeconds: number,
  specsByClass: Map<string, ComfyNodeInputSpecs> = new Map(),
): void {
  const dims = mapVideoDimensions(videoResolution, videoRatio);
  const assignments = new Map<string, LinkedDimensionAssignment>();
  const conflicts = new Set<string>();

  // 先找秒数节点：工作流自带秒→帧换算时，帧率是它算式里的常量，再去改帧率只会让时长对不上
  let hasDurationNode = false;
  for (const nodeData of Object.values(workflowObj)) {
    const inputs = nodeData?.inputs as Record<string, unknown> | undefined;
    if (inputs && writeDurationSeconds(nodeData, inputs, durationSeconds)) hasDurationNode = true;
  }

  for (const [, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    const classType = String(nodeData.class_type ?? '');
    if (INPUT_MEDIA_CLASS.test(classType)) continue;
    const specs = specsByClass.get(classType);

    // 注入直接宽高、受控别名或其上游 Primitive；连接数组本身始终保留。
    const hasPrimarySizePair = inputs.width !== undefined && inputs.height !== undefined;
    injectDimensionPairs(workflowObj, nodeData, inputs, dims, specs, assignments, conflicts);
    writeResolutionSelector(inputs, dims, videoRatio, specs);
    writeAspectRatio(inputs, videoRatio, specs);
    writeResolutionInput(inputs, dims, specs);

    // 注入帧率到视频相关节点（数字才写：连线过来的值是 ["3", 0] 这种数组，写进去会把连线冲掉）
    if (!hasDurationNode) {
      for (const key of FPS_KEYS) {
        if (typeof inputs[key] === 'number') inputs[key] = clampToSpec(videoFps, specs?.[key], 1, 1000);
      }
    }

    // 注入帧数
    for (const key of FRAME_COUNT_KEYS) {
      if (typeof inputs[key] === 'number') inputs[key] = videoFrames;
    }
    // Wan / Hunyuan / Mochi 的 latent 节点用 length 表示总帧数；
    // 只认带 width/height 的节点，避免误伤其他节点上同名的 length 参数
    if (typeof inputs.length === 'number' && hasPrimarySizePair) {
      inputs.length = videoFrames;
    }

    writeDurationInputs(inputs, classType, durationSeconds, specs);
  }
  applyLinkedDimensionAssignments(assignments, conflicts);
}

/** 提交工作流到 ComfyUI，返回 baseUrl 和 promptId */
async function submitComfyUIWorkflow(
  workflowId: string,
  workflowInputs: Record<string, string> | undefined,
  prompt: string,
  signal?: AbortSignal,
  /** 连入生成节点的音频，用于兜底填充未显式赋值的 audio IO 节点 */
  referenceAudioUrls: string[] = [],
  /** 提示词框里引用的图片/视频，用于填充工作流指定的默认 IO 节点 */
  promptMedia: { imageUrls?: string[]; videoUrls?: string[] } = {},
): Promise<{ baseUrl: string; promptId: string; workflowObj: Record<string, Record<string, unknown>> }> {
  const baseUrl = getComfyUIConfig(workflowId);

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

  // 某类型只要被 @ 过，该类型就完全按用户的赋值走，默认节点不再介入
  const mentionedTypes = new Set(
    Object.keys(workflowInputs || {})
      .map((nodeId) => ioNodes.find((io) => io.nodeId === nodeId)?.type)
      .filter((type): type is WorkflowIONodeType => !!type),
  );
  const defaultNodeFor = (type: WorkflowIONodeType) => (
    mentionedTypes.has(type) ? undefined : wf.defaultNodes?.[type]
  );

  // 注入提示词到 prompt 类型 IO 节点（没 @ 时优先写默认节点）
  injectPromptsIntoWorkflow(workflowObj, workflowInputs, prompt, ioNodeIds, defaultNodeFor('prompt'));

  // 注入图片到 image 类型 IO 节点（上传 → 替换文件名）
  await injectImagesIntoWorkflow(workflowObj, workflowInputs, ioNodes, baseUrl, signal);

  // 没 @ 图片/视频节点时，把提示词框里引用的同类媒体送进默认节点
  const hasPromptMedia = Boolean(promptMedia.imageUrls?.length || promptMedia.videoUrls?.length);
  for (const kind of ['image', 'video'] as const) {
    const defaultNodeId = defaultNodeFor(kind);
    if (!defaultNodeId) continue;
    const urls = kind === 'image' ? promptMedia.imageUrls : promptMedia.videoUrls;
    await injectDefaultMediaIntoWorkflow(
      workflowObj, ioNodes, defaultNodeId, kind, urls || [], hasPromptMedia, baseUrl, signal,
    );
  }

  // 注入音频到 audio 类型 IO 节点（上传 → 替换文件名）
  await injectAudioIntoWorkflow(
    workflowObj,
    workflowInputs,
    ioNodes,
    baseUrl,
    referenceAudioUrls,
    signal,
    defaultNodeFor('audio'),
  );

  // 返回 workflowObj 让调用方注入尺寸/视频参数后再提交
  return { baseUrl, promptId: '', workflowObj };
}

/**
 * /prompt 校验失败时返回的是结构化错误：
 * { error: { message, details }, node_errors: { "14": { class_type, errors: [{ message, details }] } } }
 * 直接把原始 JSON 截断给用户等于什么都没说，这里翻成「哪个节点的哪个输入不行」。
 */
export function formatComfyPromptError(status: number, rawBody: string): string {
  const head = `ComfyUI 拒绝了工作流 (${status})`;
  let payload: {
    error?: { message?: unknown; details?: unknown };
    node_errors?: Record<string, { class_type?: unknown; errors?: unknown[] }>;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // 不是 JSON（网关错误页之类）就退回原文
    return rawBody.trim() ? `${head}: ${rawBody.trim().slice(0, 200)}` : head;
  }

  const lines: string[] = [];
  const summary = [payload.error?.message, payload.error?.details]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' — ');
  lines.push(summary ? `${head}：${summary}` : head);

  const nodeEntries = Object.entries(payload.node_errors ?? {});
  for (const [nodeId, nodeError] of nodeEntries.slice(0, 5)) {
    const classType = typeof nodeError?.class_type === 'string' ? ` ${nodeError.class_type}` : '';
    const detail = (nodeError?.errors ?? [])
      .map((item) => {
        const error = item as { message?: unknown; details?: unknown; extra_info?: { input_name?: unknown } };
        const inputName = typeof error.extra_info?.input_name === 'string' ? `${error.extra_info.input_name}: ` : '';
        const text = [error.message, error.details]
          .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .join(' — ');
        return text ? `${inputName}${text}` : '';
      })
      .filter(Boolean)
      .join('；');
    lines.push(`· 节点 #${nodeId}${classType}${detail ? ` · ${detail.slice(0, 300)}` : ''}`);
  }
  if (nodeEntries.length > 5) lines.push(`· 还有 ${nodeEntries.length - 5} 个节点报错`);

  return lines.join('\n');
}

/** 提交 workflowObj 到 ComfyUI 并返回 promptId */
async function promptComfyUIWorkflow(
  baseUrl: string,
  workflowObj: Record<string, Record<string, unknown>>,
  signal?: AbortSignal,
  progressSession?: ComfyProgressSession,
): Promise<string> {
  await progressSession?.waitUntilReady();
  const promptRes = await comfyFetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: workflowObj,
      ...(progressSession ? { client_id: progressSession.clientId } : {}),
    }),
    signal,
  });

  if (!promptRes.ok) {
    const errorBody = await promptRes.text().catch(() => '');
    throw new Error(formatComfyPromptError(promptRes.status, errorBody));
  }

  const promptResult = (await promptRes.json()) as { prompt_id?: string; error?: string };
  if (promptResult.error) {
    throw new Error(`ComfyUI 错误: ${promptResult.error}`);
  }
  if (!promptResult.prompt_id) {
    throw new Error('ComfyUI 未返回 prompt_id');
  }

  progressSession?.bindPrompt(promptResult.prompt_id);
  return promptResult.prompt_id;
}

/** 轮询 ComfyUI 执行历史，等待图片生成完成 */
async function pollComfyUIHistory(
  baseUrl: string,
  promptId: string,
  dimensions: { width: number; height: number },
  signal?: AbortSignal,
): Promise<{ url: string; width: number; height: number }> {
  return pollComfyHistory(baseUrl, promptId, 'ComfyUI 图片生成超时（1 小时）', (outputs) => {
    const found = resolveComfyOutputUrl(baseUrl, outputs, ['image']);
    return found ? { url: found.url, width: dimensions.width, height: dimensions.height } : null;
  }, signal);
}

/** 通过 ComfyUI 工作流执行图片生成 */
export async function executeComfyUIGenerate(
  params: AIImageGenParams,
  externalSignal?: AbortSignal,
  /** 提示词框里引用的图片，用于填充工作流指定的默认 image 节点 */
  referenceImageUrls: string[] = [],
): Promise<{ url: string; width: number; height: number }> {
  const { workflowId, workflowInputs, prompt, imageSize = '2K', aspectRatio = '1:1' } = params;
  const comfyUrl = comfyBaseUrlFor(workflowId);
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  const projectId = params.nodeId ? useAppStore.getState().currentProjectId : null;
  let progressSession: ComfyProgressSession | undefined;

  try {
    // 预存待续任务（在 submit 之前），确保关窗重启后能恢复
    if (params.nodeId) {
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

    const { baseUrl, workflowObj } = await submitComfyUIWorkflow(
      workflowId!,
      workflowInputs,
      prompt,
      signal,
      [],
      { imageUrls: referenceImageUrls },
    );

    // 注入画布选择的尺寸
    const dimensionInjection = await injectDimensionsIntoWorkflow(baseUrl, workflowObj, imageSize, aspectRatio);

    if (params.nodeId && projectId) {
      progressSession = createComfyProgressSession({ baseUrl, projectId, nodeId: params.nodeId, signal });
    }

    // 提交工作流
    const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj, signal, progressSession);

    // 回填 promptId，标记为已提交
    if (params.nodeId) {
      updatePendingTask(params.nodeId, { taskId: promptId, submitted: true, baseUrl });
    }

    // 计算最终输出尺寸（用于节点显示）
    const dims = dimensionInjection.dimensions;

    // 轮询等待结果
    return await pollComfyUIHistory(baseUrl, promptId, dims, signal);
  } finally {
    progressSession?.close();
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
  return pollComfyHistory(baseUrl, promptId, 'ComfyUI 视频生成超时（1 小时）', (outputs) => (
    // 视频节点常把成片挂在 images 下（SaveWEBM / SaveVideo），所以图片也算命中
    resolveComfyOutputUrl(baseUrl, outputs, ['video', 'image'])
  ), signal);
}

/** 通过 ComfyUI 工作流执行视频生成 */
export async function executeComfyUIVideoGenerate(
  params: AIVideoGenParams,
  externalSignal?: AbortSignal,
  /** 连入音频节点的产物，兜底填充工作流的 audio IO 节点 */
  referenceAudioUrls: string[] = [],
  /** 提示词框里引用的图片/视频，用于填充工作流指定的默认 IO 节点 */
  promptMedia: { imageUrls?: string[]; videoUrls?: string[] } = {},
): Promise<{ url: string }> {
  const {
    workflowId, workflowInputs, prompt,
    videoResolution = 832, videoFps = 24, videoFrames = 77, seedanceDuration,
    // 画面比例决定注入工作流的 width/height；未设置时按 16:9
    seedanceRatio = '16:9',
  } = params;
  const comfyUrl = comfyBaseUrlFor(workflowId);
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  const projectId = params.nodeId ? useAppStore.getState().currentProjectId : null;
  let progressSession: ComfyProgressSession | undefined;

  try {
    // 预存待续任务（在 submit 之前），确保关窗重启后能恢复
    if (params.nodeId) {
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

    const { baseUrl, workflowObj } = await submitComfyUIWorkflow(
      workflowId!,
      workflowInputs,
      prompt,
      signal,
      referenceAudioUrls,
      promptMedia,
    );

    // 注入视频参数（比例/档位这类 combo 要先问过节点声明才敢写）
    injectVideoParamsIntoWorkflow(
      workflowObj,
      videoResolution,
      seedanceRatio,
      videoFps,
      videoFrames,
      resolveVideoDurationSeconds(seedanceDuration, videoFrames, videoFps),
      await resolveParamSpecs(baseUrl, workflowObj, VIDEO_PARAM_SPEC_KEYS),
    );

    if (params.nodeId && projectId) {
      progressSession = createComfyProgressSession({ baseUrl, projectId, nodeId: params.nodeId, signal });
    }

    // 提交工作流
    const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj, signal, progressSession);

    // 回填 promptId，标记为已提交
    if (params.nodeId) {
      updatePendingTask(params.nodeId, { taskId: promptId, submitted: true, baseUrl });
    }

    // 轮询等待结果
    return await pollComfyUIHistoryForVideo(baseUrl, promptId, signal);
  } finally {
    progressSession?.close();
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
  return pollComfyHistory(baseUrl, promptId, 'ComfyUI 音频生成超时（1 小时）', (outputs) => (
    resolveComfyOutputUrl(baseUrl, outputs, ['audio', 'video', 'image'])
  ), signal);
}

/** 通过 ComfyUI 工作流执行音频生成 */
export async function executeComfyUIAudioGenerate(
  params: AIAudioGenParams,
  externalSignal?: AbortSignal,
  /** 连入音频节点的产物，兜底填充工作流的 audio IO 节点 */
  referenceAudioUrls: string[] = [],
): Promise<{ url: string }> {
  const { workflowId, workflowInputs, prompt } = params;
  const comfyUrl = comfyBaseUrlFor(workflowId);
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  const projectId = params.nodeId ? useAppStore.getState().currentProjectId : null;
  let progressSession: ComfyProgressSession | undefined;

  try {
    // 预存待续任务（在 submit 之前），确保关窗重启后能恢复
    if (params.nodeId) {
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

    const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt, signal, referenceAudioUrls);

    if (params.nodeId && projectId) {
      progressSession = createComfyProgressSession({ baseUrl, projectId, nodeId: params.nodeId, signal });
    }

    // 提交工作流
    const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj, signal, progressSession);

    // 回填 promptId，标记为已提交
    if (params.nodeId) {
      updatePendingTask(params.nodeId, { taskId: promptId, submitted: true, baseUrl });
    }

    // 轮询等待结果
    return await pollComfyUIHistoryForAudio(baseUrl, promptId, signal);
  } finally {
    progressSession?.close();
    if (params.nodeId) {
      cleanupNodePolling(params.nodeId);
      removePendingTask(params.nodeId);
    }
  }
}
