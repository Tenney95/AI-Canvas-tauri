/** 主窗口持有全片任务；ReShot 仍是插件执行，媒体生成和合成复用宿主平台。 */
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import type { CanvasContext } from '../../types/project';
import { isProjectExpectedContextCurrent } from '../projectExecutionContext';
import type { PluginVideoReplicaJobSummary, PluginVideoReplicaStart, AvailableNodePluginTool, PluginInvocationResources, PluginJsonValue } from '../../types/plugin';
import type { VideoEditorTrackInput } from '../../types/videoEditorControl';
import type { VideoModelCapability } from '../../types/aiTypes';
import { useAppStore } from '../../store/useAppStore';
import { resolvePluginDependencies } from './pluginDependencyService';
import { LocalSpeechModelError } from '../onnxService';
import { generateId } from '../../store/store.utils';
import { getNodeBounds, videoNodeDimensionsForAspectRatio } from '../../utils/nodeBounds';
import { registerCanvasDerivation, completeCanvasDerivation, isCanvasDerivationFresh } from '../canvasDerivationGuard';
import { sha256BytesHex } from '../mediaDataUrl';
import { resolvePromptToChatContent, resolvePromptWithMediaRefs } from '../ai/promptResolver';
import { listGlobalDramaAssets } from '../dramaAssetPrompt';
import { VLM_MAX_IMAGES } from '../ai/imageUtils';
import { resolveMediaModel } from '../ai/generationRuntime';
import { resolveVideoModelCapability } from '../ai/videoModelCapabilityResolver';
import { resolveCanonicalVideoRequest, VideoRequestResolutionError } from '../ai/videoRequestResolver';
import { fingerprintAssetImage } from '../fs/assetImageMetadata';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { extractComfyUIIONodes } from '../comfyUIWindowService';
import { inspectVideoNode, videoInputFingerprint } from '../videoBatchPlanning';
import { createControlledEditor, updateControlledEditor } from '../videoEditorControlService';
import { probeControlledNode } from '../videoEditorInspectionService';
import { createVideoInput, probeVideoSource } from '../videoEditorMediaService';
import { startControlledExport, getControlledExport, cancelControlledExport } from '../videoEditorExportService';
import { buildPluginModelCatalog, getPluginVideoReplicaSupport } from './pluginModelCatalog';
import { executeNodePluginTool, executePluginUiHostEffect } from './pluginRuntime';
import { mintPluginInvocationResources, clearPluginInvocationResources, resolvePluginResourceHostUrl, resolvePluginMediaWorkspaceInputs, type PluginResourceReadContext } from './pluginResourceService';
import { PLUGIN_HOST } from './pluginHost';
import { rewritePluginPromptReferences, resolvePluginPromptReferencesForModel } from './pluginPromptReferenceService';
import { extractReplicaSegmentAudio, inspectReplicaSpeechModels, prepareReplicaSpeechModels, transcribeReplicaSegmentAudio } from './pluginVideoReplicaAudioService';
import { planPluginVideoReplica, ReplicaPlanningError, type PluginVideoReplicaPlan, type PluginVideoReplicaSegmentPlan } from './pluginVideoReplicaPlanning';
import { readPluginVideoReplicaJobs, recoverPluginVideoReplicaJob, savePluginVideoReplicaJob } from './pluginVideoReplicaJobRepository';

interface JobIdentity {
  projectId: string; pluginId: string; nodeId: string; sourceDigest: string; revisionDigest: string;
  /** 仅宿主内存租约；不写入旧任务summary，也不复活重启后的任务。 */
  expectedContext?: Readonly<CanvasContext>;
}
interface StartContext extends JobIdentity {
  tool: AvailableNodePluginTool;
  resources: PluginInvocationResources;
  resourceReadContext: PluginResourceReadContext;
  /** 仅内存中的只读显示数据；不参与素材授权、生成参数解析或任务持久化。 */
  uiParameters?: Record<string, PluginJsonValue>;
  signal?: AbortSignal;
}
interface ReplicaJob {
  summary: PluginVideoReplicaJobSummary;
  controller: AbortController;
  exportJobId?: string;
  unsubscribe?: () => void;
  uiParameters?: Record<string, PluginJsonValue>;
}
const jobs = new Map<string, ReplicaJob>();
const activeStatuses = new Set(['queued', 'preparing', 'generating', 'composing']);
let starting = false;
class ReplicaFailure extends Error {}
export class ReplicaGenerationUnknown extends Error {}

// 不把模型 ID、参数原值、文件路径或底层异常正文传给隔离窗口。
const videoPreflightMessages: Record<VideoRequestResolutionError['code'], string> = {
  INVALID_PARAMETER: '生成参数不符合模型要求，请检查比例、分辨率和分段时长',
  INVALID_CAPABILITY: '模型视频能力配置无效，请检查能力声明',
  UNSUPPORTED_OPERATION: '模型不支持当前生成方式，请更换模型或调整控制视频',
  REQUIRED_REFERENCE: '模型要求参考素材，请检查替换引用和控制视频',
  REFERENCE_LIMIT_EXCEEDED: '替换引用与控制素材的总数超过模型参考额度，请减少引用或控制类型',
  REFERENCE_COMBINATION_UNSUPPORTED: '模型不支持当前参考素材组合，请检查首尾帧与普通参考是否混用',
  STANDALONE_AUDIO_UNSUPPORTED: '模型不支持仅用音频参考生成视频，请增加画面参考或更换模型',
  AUDIO_GENERATION_UNSUPPORTED: '模型不支持生成音频，请选择保留原片声音或静音',
  UNSUPPORTED_ASPECT_RATIO: '所选比例不受模型支持，请调整视频比例',
  UNSUPPORTED_RESOLUTION: '所选分辨率不受模型支持，请调整视频分辨率',
  UNSUPPORTED_FRAME_RATE: '所选帧率不受模型支持，请检查模型帧率配置',
  UNSUPPORTED_DURATION: '分段时长不符合模型要求，请检查固定或自动时长配置',
  DURATION_OUT_OF_RANGE: '分段时长超出模型范围，请调整分段时长',
};

function analysisFailure(raw: unknown): string {
  const message = typeof raw === 'string' ? raw.slice(0, 4000) : '';
  const status = /(?:\bHTTP\s*|\bstatus\s*[:=]?\s*|\(|^)([45]\d\d)\b/iu.exec(message)?.[1];
  let reason = '视觉分析模型调用失败，尚未识别具体接口原因';
  if (status === '401' || /unauthori[sz]ed|invalid.*(?:key|credential)|认证失败|密钥无效/iu.test(message)) reason = '视觉模型连接认证失败，请检查连接凭据';
  else if (status === '402' || /insufficient.*(?:quota|balance|credit)|余额不足|额度不足/iu.test(message)) reason = '视觉模型账户余额或额度不足';
  else if (status === '403' || /permission denied|forbidden|无权|权限不足/iu.test(message)) reason = '当前连接没有调用所选视觉模型的权限';
  else if (status === '429' || /rate.?limit|请求过于频繁/iu.test(message)) reason = '视觉模型请求被限流，请稍后手动重试';
  else if (/视觉输入最多允许|视觉输入图片总大小超过|参考图.*超过.*上限/u.test(message)) reason = '分析参考图超出宿主视觉输入的数量或大小限制，尚未调用分析接口';
  else if (status === '413' || /too many images|payload too large|图片数量|请求体过大/iu.test(message)) reason = '视觉分析的图片数量或请求体超出接口限制';
  else if (/image.*(?:not support|unsupported)|(?:not support|unsupported).*(?:image|vision)|不支持.*(?:图片|图像)/iu.test(message)) reason = '所选模型或当前连接不支持本次图片输入';
  else if (/读取参考图.*失败|参考图.*(?:内容为空|不是受支持的图片格式)/u.test(message)) reason = '分析参考图读取或格式转换失败，尚未调用分析接口';
  else if (/模型调用引用了当前调用范围外的资源|插件资源授权不存在|插件资源会话已失效|插件引用会话已失效/u.test(message)) reason = '分析参考图授权已失效，请重新打开插件选取素材';
  else if (/模型返回结果为空/u.test(message)) reason = '分析接口未返回可解析的文字，请核对视觉分析模型的响应协议';
  else if (status === '404' || /model.*not found|不存在.*模型|模型.*不存在/iu.test(message)) reason = '视觉模型名称或接口路由不可用';
  else if (status === '504' || /timeout|timed out|超时/iu.test(message)) reason = '视觉模型接口响应超时，未自动重投';
  else if (/failed to fetch|network|网络|连接失败/iu.test(message)) reason = '视觉模型网络请求失败，请检查连接';
  else if (status && Number(status) >= 500) reason = '视觉模型服务或上游返回错误';
  return `视觉分析失败：${reason}${status ? `（HTTP ${status}）` : ''}；未提交本段视频生成`;
}

/** 真正的生产任务也走此串行入口；任何不确定提交都停止后续段，不进行重投。 */
export async function executeReplicaPlan(plan: PluginVideoReplicaPlan, adapter: {
  assertFresh: () => void;
  prepare: (segment: PluginVideoReplicaSegmentPlan, index: number) => Promise<string>;
  generate: (nodeId: string) => Promise<'success' | 'error' | 'unknown' | 'cancelled'>;
  compose: (nodeIds: string[]) => Promise<string>;
  completed: (nodeId: string, count: number) => Promise<void>;
}): Promise<string> {
  const nodeIds: string[] = [];
  for (const [index, segment] of plan.segments.entries()) {
    adapter.assertFresh();
    const nodeId = await adapter.prepare(segment, index);
    adapter.assertFresh();
    const status = await adapter.generate(nodeId);
    if (status === 'unknown') throw new ReplicaGenerationUnknown('已提交分段的状态待核对；未自动重新提交');
    if (status !== 'success') throw new ReplicaFailure('分段生成未完成；已停止后续分段');
    adapter.assertFresh();
    nodeIds.push(nodeId); await adapter.completed(nodeId, nodeIds.length);
  }
  adapter.assertFresh();
  return adapter.compose(nodeIds);
}

function requireIdentity(identity: JobIdentity): void {
  const state = useAppStore.getState();
  const plugin = state.installedPlugins.find((item) => item.id === identity.pluginId);
  if (!resolvePluginDependencies(state.installedPlugins, identity.pluginId).ready) throw new ReplicaFailure('插件依赖已失效，任务已停止');
  if (state.currentProjectId !== identity.projectId || !state.nodes.some((node) => node.id === identity.nodeId)
    || identity.expectedContext !== undefined && !isProjectExpectedContextCurrent(identity.expectedContext, state, { checkCanvasRevision: false })
    || !plugin?.enabled || plugin.sourceDigest !== identity.sourceDigest || plugin.revisionDigest !== identity.revisionDigest) {
    throw new ReplicaFailure('项目、源节点或插件版本已变化，任务已停止');
  }
}

function sourceSignature(nodeId: string): string {
  const data = useAppStore.getState().nodes.find((node) => node.id === nodeId)?.data;
  return JSON.stringify([data?.filePath, data?.relativePath, data?.assetId, data?.videoUrl, data?.sourceUrl, data?.output, data?.videoDuration, data?.mediaVersion]);
}
function normalizeReplicaPath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\/([a-z]:)/iu, '$1');
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized;
}
function mediaCarrierSignature(node: Node<BaseNodeData> | undefined): string {
  const data = node?.data;
  return JSON.stringify([node?.type, data?.type, data?.filePath, data?.relativePath, data?.assetId,
    data?.imageUrl, data?.videoUrl, data?.audioUrl, data?.thumbnailUrl, data?.sourceUrl, data?.output,
    data?.videoDuration, data?.audioDuration, data?.mediaVersion]);
}

function modelSignature(modelId: string): string {
  const state = useAppStore.getState();
  const selected = buildPluginModelCatalog(state.config, ['video', 'text']).find((model) => model.id === modelId);
  if (!selected) throw new ReplicaFailure('所选模型已不可用，任务已停止');
  const general = state.config.generalModels?.find((model) => `general/${model.id}` === modelId);
  const workflow = state.workflows.find((item) => `comfyui/${item.id}` === modelId);
  const provider = state.config.providers[general?.providerConfigId ?? selected.provider];
  return JSON.stringify([selected, general, workflow, state.config.comfyUIUrl, state.config.comfyServers,
    provider?.baseUrl, provider?.apiKey, provider?.selectedModels]);
}

function plainText(text: string, limit = 8000): string {
  return text.replace(/@(?:asset|drama|model)?\{[^}]*\}|!\[[^\]]*\]\([^)]*\)/gu, '[参考内容]').slice(0, limit);
}

function matchesSegmentAudio(segment: PluginVideoReplicaSegmentPlan, reference: PluginVideoReplicaSegmentPlan['audioReferences'][number]): boolean {
  return Math.abs(reference.inPoint - segment.inPoint) < 0.001 && Math.abs(reference.outPoint - segment.outPoint) < 0.001
    && Math.abs(reference.referenceDuration - (segment.outPoint - segment.inPoint)) < 0.001;
}

function comfyCapability(workflow: ReturnType<typeof useAppStore.getState>['workflows'][number] | undefined, seconds: number): VideoModelCapability {
  if (!workflow) throw new ReplicaFailure('ComfyUI 工作流已不可用');
  const io = workflow.ioNodes?.length ? workflow.ioNodes : extractComfyUIIONodes(workflow.fileContent);
  const definition = JSON.parse(workflow.fileContent) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  const keys = { image: ['image'], video: ['video', 'file'], audio: ['audio'] };
  const count = (kind: keyof typeof keys) => new Set(io.filter((item) => {
    if (item.type !== kind) return false;
    const node = definition[item.nodeId];
    return node && !/Load.*Path/iu.test(node.class_type || '') && keys[kind].some((key) => node.inputs
      && Object.prototype.hasOwnProperty.call(node.inputs, key) && (node.inputs[key] == null || typeof node.inputs[key] === 'string'));
  }).map((item) => item.nodeId)).size;
  return { maxDuration: Math.min(15, seconds), minDuration: 1, operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: count('image'), maxVideoReferences: count('video'), maxAudioReferences: count('audio') };
}

async function captureRequirements(context: StartContext, request: PluginVideoReplicaStart) {
  const opaque = [`替换角色：${request.character || '保留原角色'}`, `替换场景：${request.scene || '保留原场景'}`, `视觉风格：${request.style || '保留原风格'}`].join('\n');
  const options = { context: context.resourceReadContext, resources: context.resources };
  const canonical = await rewritePluginPromptReferences(opaque, options);
  const resolved = await resolvePluginPromptReferencesForModel(opaque, options);
  // 关闭 UI 会撤销旧句柄；授权图只留在主窗口内存，顺序与已解析要求中的“图片N”一致。
  const analysisImageUrls = request.analysisModelId ? [...new Set(resolved.imageUrls)] : [];
  if (analysisImageUrls.length + 1 > VLM_MAX_IMAGES) {
    throw new ReplicaFailure(`视觉分析最多使用 ${VLM_MAX_IMAGES - 1} 张替换参考图，请减少角色或场景引用后重试`);
  }
  const media = await resolvePromptWithMediaRefs(canonical);
  const paths = [...new Set([
    ...media.references.map((reference) => reference.filePath || localMediaUrlToPath(reference.url)),
    ...[...canonical.matchAll(/@asset\{([^}]+)\}/gu)].map((match) => decodeURIComponent(match[1])),
  ].filter((path): path is string => !!path))];
  // 复用文件服务的固定块内容摘要；该入口只读，不修改资产索引的来源或归属。
  const files = await Promise.all(paths.map(async (path) => ({ path, digest: (await fingerprintAssetImage(path, context.signal)).digest })));
  // 身份只保存在主窗口运行时；每段重新解析并复核，UI 关闭后不沿用其 grant。
  const fingerprint = async () => {
    const state = useAppStore.getState();
    const ids = [...canonical.matchAll(/@\{([^:}]+):[^}]*\}/gu)].map((match) => match[1]);
    const library = canonical.includes('@drama{') ? [state.dramaAssets, listGlobalDramaAssets(state)] : [];
    const forAnalysis = canonical.replace(/@\{([^:}]+):([^}]*)\}/gu, (token, id: string, label: string) => {
      const data = state.nodes.find((node) => node.id === id)?.data;
      return data && ['source-video', 'ai-video', 'source-audio', 'ai-audio'].includes(data.type) ? `[${label}]` : token;
    });
    const content = await resolvePromptToChatContent(forAnalysis);
    return sha256BytesHex(new TextEncoder().encode(JSON.stringify([
      ids.map((id) => state.nodes.find((node) => node.id === id)?.data), library,
      canonical.includes('@asset{') ? state.config.assetFolders : [], content,
    ])));
  };
  const initial = await fingerprint();
  await rewritePluginPromptReferences(opaque, options);
  return { canonical, plain: plainText(resolved.prompt), analysisImageUrls, references: media.references, async check() {
    for (const file of files) {
      if ((await fingerprintAssetImage(file.path)).digest !== file.digest) {
        throw new ReplicaFailure('替换引用文件已变更；未提交下一段');
      }
    }
    if (await fingerprint() !== initial) throw new ReplicaFailure('替换引用已变更或删除；未提交下一段');
  } };
}

export async function findPluginVideoReplicaJob(identity: JobIdentity): Promise<PluginVideoReplicaJobSummary | undefined> {
  requireIdentity(identity);
  const matching = [...jobs.values()].filter((job) => job.summary.projectId === identity.projectId
    && job.summary.pluginId === identity.pluginId && job.summary.nodeId === identity.nodeId
    && job.summary.sourceDigest === identity.sourceDigest && job.summary.revisionDigest === identity.revisionDigest)
    .sort((a, b) => b.summary.createdAt - a.summary.createdAt);
  const running = matching.find((job) => activeStatuses.has(job.summary.status) || ['paused', 'unknown'].includes(job.summary.status)) ?? matching[0];
  if (running) return { ...running.summary, segmentNodeIds: [...running.summary.segmentNodeIds] };
  const previous = (await readPluginVideoReplicaJobs(identity.projectId)).reverse().find((job) => job.pluginId === identity.pluginId
    && job.nodeId === identity.nodeId && job.sourceDigest === identity.sourceDigest && job.revisionDigest === identity.revisionDigest);
  return previous ? recoverPluginVideoReplicaJob(previous) : undefined;
}

/** 只能按已校验的任务身份取回显示快照；不恢复旧会话的媒体或引用 grant。 */
export async function getPluginVideoReplicaJobUiParameters(identity: JobIdentity, jobId: string): Promise<Record<string, PluginJsonValue>> {
  await getPluginVideoReplicaJob(identity, jobId);
  return structuredClone(jobs.get(jobId)?.uiParameters ?? {});
}

export async function getPluginVideoReplicaJob(identity: JobIdentity, jobId: string): Promise<PluginVideoReplicaJobSummary> {
  requireIdentity(identity);
  const job = jobs.get(jobId)?.summary ?? (await readPluginVideoReplicaJobs(identity.projectId)).find((item) => item.jobId === jobId);
  if (!job || ['projectId', 'pluginId', 'nodeId', 'sourceDigest', 'revisionDigest'].some((key) => job[key as keyof JobIdentity] !== identity[key as keyof JobIdentity])) {
    throw new ReplicaFailure('该复刻任务不属于当前插件会话');
  }
  return jobs.has(jobId) ? { ...job, segmentNodeIds: [...job.segmentNodeIds] } : recoverPluginVideoReplicaJob(job);
}

export async function cancelPluginVideoReplicaJob(identity: JobIdentity, jobId: string) {
  await getPluginVideoReplicaJob(identity, jobId);
  const job = jobs.get(jobId);
  if (job && activeStatuses.has(job.summary.status)) {
    job.controller.abort(); job.summary.stage = '已停止后续提交；当前已提交步骤正在收尾';
    if (job.exportJobId) cancelControlledExport({ projectId: identity.projectId, signal: new AbortController().signal }, job.exportJobId);
  }
  return getPluginVideoReplicaJob(identity, jobId);
}

export async function startPluginVideoReplicaJob(context: StartContext, request: PluginVideoReplicaStart): Promise<PluginVideoReplicaJobSummary | { speechModelsRequired: true }> {
  requireIdentity(context);
  const state = useAppStore.getState();
  const installed = state.installedPlugins.find((plugin) => plugin.id === context.pluginId)!;
  if (installed.manifest.apiVersion !== 2 || installed.manifest.runtime !== 'python'
    || !installed.manifest.requiredCapabilities?.includes('video.replicaPipeline')
    || !context.tool.tool.pythonExecution?.mediaWorkspace
    || !['node.read', 'node.write', 'models.read', 'models.invoke', 'files.connected.read', 'files.output.create', 'prompt.references.read'].every((permission) => installed.manifest.permissions.includes(permission as never))) {
    throw new ReplicaFailure('插件未声明完整视频任务所需能力和权限');
  }
  if (starting || [...jobs.values()].some((job) => activeStatuses.has(job.summary.status))) throw new ReplicaFailure('已有完整复刻任务正在运行');
  const source = context.resources.self.find((resource) => resource.resourceId === request.resourceId && resource.source?.nodeId === context.nodeId && resource.mediaType.startsWith('video/'));
  if (!source) throw new ReplicaFailure('全片任务只接受当前视频节点的授权源视频');
  const initialSourceSignature = sourceSignature(context.nodeId);
  const initialModelSignature = modelSignature(request.modelId);
  const initialAnalysisSignature = request.analysisModelId ? modelSignature(request.analysisModelId) : undefined;
  starting = true;
  let startupFailure = '读取此前复刻任务失败，请检查本地任务存储后重试';
  try {
    const previous = await findPluginVideoReplicaJob(context);
    if (previous && ['paused', 'unknown'].includes(previous.status)) throw new ReplicaFailure('此前任务需要核对已有分段；不会自动重复提交，请先检查视频批次');
    const catalog = buildPluginModelCatalog(state.config, ['video', 'text']);
    const selected = catalog.find((model) => model.id === request.modelId && model.category === 'video');
    if (!selected) throw new ReplicaFailure('请选择当前应用可用的视频模型或工作流');
    startupFailure = '解析视频模型失败，请重新选择已配置的视频模型或工作流';
    const model = resolveMediaModel('video', request.modelId);
    const replicaSupport = getPluginVideoReplicaSupport(model.provider);
    if (!replicaSupport.supported) throw new ReplicaFailure(replicaSupport.reason);
    startupFailure = '源视频授权已失效或不满足媒体工作区要求，请重新打开插件并选择本地源视频';
    const url = await resolvePluginResourceHostUrl(context.resourceReadContext, request.resourceId);
    const sourceInput = (await resolvePluginMediaWorkspaceInputs(context.resourceReadContext, context.resources))[0];
    const sourceData = useAppStore.getState().nodes.find((node) => node.id === context.nodeId)!.data;
    const audioPath = sourceData.filePath || localMediaUrlToPath(sourceData.videoUrl);
    if (!audioPath || normalizeReplicaPath(audioPath) !== normalizeReplicaPath(sourceInput.path)) throw new ReplicaFailure('源视频授权与音轨来源不一致，请重新导入同一份本地视频');
    startupFailure = '读取源视频文件失败，请检查文件是否离线、被替换或失去读取授权';
    const fileFingerprint = (await fingerprintAssetImage(sourceInput.path, context.signal)).digest;
    startupFailure = '源视频探测或解码失败，请检查本地文件与视频编码';
    const input = await createVideoInput(url);
    let probe; let hasAudio;
    try { probe = await probeVideoSource(input); hasAudio = !!(await input.getPrimaryAudioTrack()); }
    finally { input.dispose(); }
    requireIdentity(context);
    if (!probe.decodable) throw new ReplicaFailure('参考视频无法解码，请检查本地编码');
    startupFailure = '视频分段规划失败，请检查模型视频能力和工作流输入配置';
    const workflow = model.workflowId ? state.workflows.find((item) => item.id === model.workflowId) : undefined;
    const capability = resolveVideoModelCapability(request.modelId, state.config, request.resolution) ?? (model.provider === 'comfyui' && request.maxSegmentSeconds
      ? comfyCapability(workflow, request.maxSegmentSeconds) : undefined);
    if (!capability) throw new ReplicaFailure('模型未声明视频能力；请配置能力，或为 ComfyUI 设置分段时长');
    const plan = planPluginVideoReplica({ duration: probe.duration, capability: { ...capability, operations: capability.operations ? [...capability.operations] : undefined },
      cuts: request.cuts, maxSegmentSeconds: request.maxSegmentSeconds, resolution: request.resolution, controls: request.controls, hasAudio });
    const nodeBudget = PLUGIN_HOST.limits.replica?.nodes ?? 512;
    if (plan.segments.reduce((count, segment) => count + 1 + (hasAudio ? 1 : 0)
      + segment.references.length * request.controls.length + segment.audioReferences.filter((reference) => !matchesSegmentAudio(segment, reference)).length, 1) > nodeBudget) {
      throw new ReplicaFailure(`完整任务预计超过 ${nodeBudget} 个派生节点，请减少控制类型或使用更长生成段`);
    }
    startupFailure = '替换引用解析失败，请重新选择角色或场景引用，并确认素材仍可读取';
    const requirements = await captureRequirements(context, request);
    const replacementReferences = requirements.references;
    // 此处只预检素材组合；最终生成提示词在实际提交前校验，不能拿占位文字校验长度。
    const preflightCapability = { ...capability, inputConstraints: { ...capability.inputConstraints, promptMinCharacters: undefined } };
    startupFailure = '模型参考素材预检失败，请检查替换引用与控制素材配置';
    for (const segment of plan.segments) {
      // 开始任何付费视觉分析前，连同用户的替换引用验证总参考额度。
      resolveCanonicalVideoRequest({ provider: model.provider, model: model.requestModel, prompt: '视频复刻任务的完整素材预检',
        seedanceDuration: segment.generationDuration, seedanceResolution: request.resolution, seedanceRatio: request.aspectRatio,
        generateAudio: request.audioMode === 'model' }, { capability: preflightCapability, references: [
        ...replacementReferences,
        ...segment.references.flatMap((part) => request.controls.map((control) => ({ kind: 'video' as const,
          url: `planning://${part.key}/${control}`, role: 'reference' as const, origin: 'connection' as const }))),
        ...segment.audioReferences.map((part) => ({ kind: 'audio' as const, url: `planning://${part.key}`, role: 'reference_audio' as const, origin: 'connection' as const })),
      ] });
    }
    startupFailure = '本地语音模型检查或准备失败，请检查语音模型文件与下载连接';
    if (request.transcribe && hasAudio && !(await inspectReplicaSpeechModels()).ready) {
      if (!request.downloadSpeech) return { speechModelsRequired: true };
      await prepareReplicaSpeechModels(context.signal);
    }
    startupFailure = '复核源视频授权失败，请重新打开插件后重试';
    await resolvePluginResourceHostUrl(context.resourceReadContext, request.resourceId);
    requireIdentity(context);
    if (context.signal?.aborted) throw new ReplicaFailure('复刻启动已取消');
    const original = initialSourceSignature;
    const selectedModel = initialModelSignature;
    const analysisModel = request.analysisModelId ? catalog.find((item) => item.id === request.analysisModelId && item.category === 'text'
      && item.inputModalities?.includes('image')) : undefined;
    if (request.analysisModelId && !analysisModel) throw new ReplicaFailure('请选择可用的视觉分析模型');
    const analysisSignature = initialAnalysisSignature;
    const now = Date.now();
    const ui = context.uiParameters?.replicaUi;
    if (ui !== undefined && JSON.stringify(ui).length > 750_000) throw new ReplicaFailure('复刻界面显示快照过大，请减少引用后重试');
    const job: ReplicaJob = { controller: new AbortController(), uiParameters: ui === undefined ? undefined : { replicaUi: structuredClone(ui) }, summary: {
      projectId: context.projectId, pluginId: context.pluginId, nodeId: context.nodeId, sourceDigest: context.sourceDigest, revisionDigest: context.revisionDigest,
      jobId: `video-replica-${generateId()}`, modelId: request.modelId, status: 'queued', stage: '等待全片复刻',
      totalSegments: plan.segments.length, completedSegments: 0, progress: 0, createdAt: now, updatedAt: now, segmentNodeIds: [], warnings: [
        ...plan.warnings, ...(!hasAudio ? ['源视频没有音轨，将仅生成画面。'] : []),
      ] } };
    const dependencyFingerprint = resolvePluginDependencies(useAppStore.getState().installedPlugins, context.pluginId).fingerprint;
    const check = () => {
      requireIdentity(context);
      if (resolvePluginDependencies(useAppStore.getState().installedPlugins, context.pluginId).fingerprint !== dependencyFingerprint) {
        throw new ReplicaFailure('插件依赖版本已变化，任务已停止');
      }
      if (job.controller.signal.aborted) throw new ReplicaFailure('任务已停止后续分段');
      if (sourceSignature(context.nodeId) !== original || modelSignature(request.modelId) !== selectedModel
        || (request.analysisModelId && modelSignature(request.analysisModelId) !== analysisSignature)) throw new ReplicaFailure('源视频或模型配置已变更，未提交下一段');
    };
    const checkInputs = async () => {
      check();
      if ((await fingerprintAssetImage(sourceInput.path, job.controller.signal)).digest !== fileFingerprint) {
        throw new ReplicaFailure('源视频文件已变更，未提交下一段');
      }
      await requirements.check(); check();
    };
    startupFailure = '复核任务输入失败，请检查源视频和替换素材是否仍可读取，再重新选择引用';
    await checkInputs();
    if (useAppStore.getState().getCurrentRevision() !== context.resourceReadContext.baseRevision) throw new ReplicaFailure('画布在任务启动时发生变化');
    // 首次持久化由任务准备阶段负责；此处完成最后一次异步检查后原子绑定观察身份。
    // 在持久化准备状态成功前不会准备素材或提交媒体模型。
    check();
    jobs.set(job.summary.jobId, job);
    job.unsubscribe = useAppStore.subscribe(() => { try { check(); } catch { job.controller.abort(); } });
    // 让 UI Broker 先切换成绑定任务的观察会话，再开始写素材节点。
    setTimeout(() => { void runJob(job, context, request, plan, model, capability, requirements, hasAudio, probe, sourceInput.path, check, checkInputs); }, 0);
    return { ...job.summary, segmentNodeIds: [] };
  } catch (error) {
    if (error instanceof ReplicaFailure) throw error;
    if (context.signal?.aborted) throw new ReplicaFailure('复刻启动已取消', { cause: error });
    if (error instanceof LocalSpeechModelError) throw new ReplicaFailure(error.message, { cause: error });
    if (error instanceof ReplicaPlanningError) throw new ReplicaFailure(error.message, { cause: error });
    if (error instanceof VideoRequestResolutionError) throw new ReplicaFailure(`模型预检未通过：${videoPreflightMessages[error.code]}`, { cause: error });
    throw new ReplicaFailure(startupFailure, { cause: error });
  } finally { starting = false; }
}

async function runJob(job: ReplicaJob, context: StartContext, request: PluginVideoReplicaStart, plan: PluginVideoReplicaPlan,
  model: ReturnType<typeof resolveMediaModel>, capability: VideoModelCapability, requirements: Awaited<ReturnType<typeof captureRequirements>>, hasAudio: boolean,
  probe: Awaited<ReturnType<typeof probeVideoSource>>, sourcePath: string, check: () => void, checkOriginalInputs: () => Promise<void>): Promise<void> {
  const nodeWidth = 300; const gap = 80; const columnStep = nodeWidth + gap;
  const mediaHeight = Math.max(160, Math.ceil(nodeWidth * probe.height / probe.width));
  const generatedDimensions = videoNodeDimensionsForAspectRatio(request.aspectRatio, nodeWidth)
    ?? { nodeWidth, nodeHeight: mediaHeight };
  let layoutOrigin: { x: number; parentId?: string } | undefined;
  const layoutNodeIds = new Set<string>();
  // 文件身份与摘要只活在主窗口任务内；节点 URL 不足以识别原地替换的控制素材或生成结果。
  const mediaLeases = new Map<string, () => Promise<void>>();
  const captureMediaLease = async (nodeIds: string[]) => {
    for (const nodeId of new Set(nodeIds)) {
      if (mediaLeases.has(nodeId)) continue;
      check();
      const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
      if (!node) throw new ReplicaFailure('分段素材节点已变化；任务已停止');
      const carrier = mediaCarrierSignature(node);
      const urlPath = localMediaUrlToPath(node.data.imageUrl || node.data.audioUrl || node.data.videoUrl);
      const path = node.data.filePath || urlPath;
      if (!path || (urlPath && normalizeReplicaPath(urlPath) !== normalizeReplicaPath(path))) {
        throw new ReplicaFailure('分段素材缺少一致的本地文件来源；任务已停止');
      }
      const assertCarrier = () => {
        check();
        if (mediaCarrierSignature(useAppStore.getState().nodes.find((item) => item.id === nodeId)) !== carrier) {
          throw new ReplicaFailure('分段素材节点已变化；旧结果未写回');
        }
      };
      const digest = (await fingerprintAssetImage(path, job.controller.signal)).digest;
      assertCarrier();
      mediaLeases.set(nodeId, async () => {
        assertCarrier();
        if ((await fingerprintAssetImage(path, job.controller.signal)).digest !== digest) {
          throw new ReplicaFailure('分段素材文件已变更；未提交后续生成或写回旧结果');
        }
        assertCarrier();
      });
    }
  };
  const checkInputs = async () => {
    await checkOriginalInputs();
    for (const assertMediaFresh of mediaLeases.values()) await assertMediaFresh();
    check();
  };
  const update = async (patch: Partial<PluginVideoReplicaJobSummary>) => {
    Object.assign(job.summary, patch, { updatedAt: Date.now() }); await savePluginVideoReplicaJob(job.summary);
  };
  const prepare = async (segment: PluginVideoReplicaSegmentPlan, index: number) => {
    await update({ status: 'preparing', stage: `准备第 ${index + 1}/${plan.segments.length} 段：控制素材、音频与对白` });
    await checkInputs();
    const anchor = useAppStore.getState().nodes.find((node) => node.id === context.nodeId)!;
    const layoutState = useAppStore.getState();
    if (!layoutOrigin) {
      // 同父分组坐标可以直接比较；只把本次任务放到已有内容右侧，不移动原节点。
      const rightEdge = layoutState.nodes.filter((node) => node.parentId === anchor.parentId)
        .reduce((right, node) => Math.max(right, node.position.x + getNodeBounds(node, []).width), anchor.position.x);
      layoutOrigin = { x: rightEdge + gap, ...(anchor.parentId ? { parentId: anchor.parentId } : {}) };
    }
    if (layoutOrigin.parentId !== anchor.parentId) throw new ReplicaFailure('源节点所属分组已变化，未提交后续分段');
    const originX = layoutOrigin.x;
    const parent = layoutOrigin.parentId ? { parentId: layoutOrigin.parentId } : {};
    const previousNodes = layoutState.nodes.filter((node) => layoutNodeIds.has(node.id));
    const rowY = previousNodes.length
      ? Math.max(...previousNodes.map((node) => node.position.y + getNodeBounds(node, []).height)) + gap
      : anchor.position.y;
    let transcript = '';
    const audioNodes: Node<BaseNodeData>[] = [];
    const referenceAudioNodes: Node<BaseNodeData>[] = [];
    const audioEdges: Edge[] = [];
    const guard = registerCanvasDerivation(useAppStore.getState(), context.nodeId);
    if (!guard) throw new ReplicaFailure('无法建立分段准备守卫');
    const audioCheck = () => { check(); if (!isCanvasDerivationFresh(guard, useAppStore.getState())) throw new ReplicaFailure('画布在音频准备时发生变化'); };
    try {
      if (hasAudio) {
        const audio = await extractReplicaSegmentAudio({ projectId: context.projectId, nodeId: context.nodeId, start: segment.inPoint, end: segment.outPoint,
          signal: job.controller.signal, assertFresh: audioCheck });
        if (audio && request.transcribe) transcript = plainText(await transcribeReplicaSegmentAudio(audio, { signal: job.controller.signal, assertFresh: audioCheck }), 16000);
        if (audio) {
          const id = `node-${generateId()}`;
          audioNodes.push({ id, type: 'source-audio', position: { x: originX + columnStep, y: rowY }, ...parent,
            data: { type: 'source-audio', nodeWidth, nodeHeight: 140, label: `复刻第 ${index + 1} 段 · 原音`, status: 'success',
            filePath: audio.filePath, fileName: audio.fileName, audioUrl: audio.assetUrl, audioDuration: audio.duration } });
        }
        for (const reference of segment.audioReferences) {
          if (audioNodes[0] && matchesSegmentAudio(segment, reference)) {
            referenceAudioNodes.push(audioNodes[0]);
            continue;
          }
          const audio = await extractReplicaSegmentAudio({ projectId: context.projectId, nodeId: context.nodeId, start: reference.inPoint, end: reference.outPoint,
            referenceDuration: reference.referenceDuration, signal: job.controller.signal, assertFresh: audioCheck });
          if (!audio) throw new ReplicaFailure('模型音频参考未能准备，未提交生成');
          const audioNode: Node<BaseNodeData> = { id: `node-${generateId()}`, type: 'source-audio',
            position: { x: originX + columnStep, y: rowY + audioNodes.length * (140 + gap) }, ...parent,
            data: { type: 'source-audio', nodeWidth, nodeHeight: 140, label: `复刻第 ${index + 1} 段 · 音频参考`, status: 'success', filePath: audio.filePath, fileName: audio.fileName, audioUrl: audio.assetUrl, audioDuration: audio.duration } };
          audioNodes.push(audioNode); referenceAudioNodes.push(audioNode);
        }
      }
      audioCheck();
    } finally { completeCanvasDerivation(guard); }
    await checkInputs();
    let description = '保留源片构图、镜头顺序、动作和运镜。';
    const controlNodes: Node<BaseNodeData>[] = [];
    const parts = segment.references.length ? segment.references : [{ key: `${segment.key}-frame`, inPoint: segment.inPoint, outPoint: segment.outPoint, referenceDuration: segment.outPoint - segment.inPoint }];
    for (let offset = 0; offset < parts.length; offset += 6) {
      await checkInputs();
      const batch = parts.slice(offset, offset + 6);
      const invocationId = crypto.randomUUID();
      const batchGuard = registerCanvasDerivation(useAppStore.getState(), context.nodeId);
      if (!batchGuard) throw new ReplicaFailure('无法建立素材执行守卫');
      let resources: PluginInvocationResources | undefined;
      try {
        resources = await mintPluginInvocationResources({ ...context, invocationId, baseRevision: batchGuard.baseRevision,
          expectedContext: batchGuard.expectedContext, getState: useAppStore.getState, state: useAppStore.getState(),
          access: context.tool.tool.resourceAccess });
        const source = resources.self.find((item) => item.mediaType.startsWith('video/') && item.source?.nodeId === context.nodeId);
        if (!source) throw new ReplicaFailure('参考视频授权已不可用');
        const readContext: PluginResourceReadContext = { ...context, invocationId, baseRevision: batchGuard.baseRevision,
          expectedContext: batchGuard.expectedContext, getState: useAppStore.getState, permissions: context.tool.permissions, state: useAppStore.getState() };
        const inputPath = (await resolvePluginMediaWorkspaceInputs(readContext, resources))[0].path;
        if (normalizeReplicaPath(inputPath) !== normalizeReplicaPath(sourcePath)) throw new ReplicaFailure('分段授权源视频已变化，未提交生成');
        const effect = (payload: Parameters<typeof executePluginUiHostEffect>[0]['effect']) => executePluginUiHostEffect({ ...context, toolId: context.tool.tool.id,
          title: context.tool.tool.title, permissions: context.tool.permissions, models: buildPluginModelCatalog(useAppStore.getState().config, ['video', 'text']),
          resources, resourceReadContext: readContext, trustedMediaReferences: new Set(requirements.analysisImageUrls), effect: payload, signal: job.controller.signal });
        if (offset === 0) {
          const detection = await effect({ type: 'video.detectShots', resourceId: source.resourceId, start: segment.inPoint, end: segment.outPoint });
          await checkInputs();
          const shots = (detection.value as { shots?: Array<{ inPoint: number; outPoint: number }> } | undefined)?.shots;
          if (!detection.ok || !shots?.length || shots.length > 8 || shots.some((shot) => !Number.isFinite(shot.inPoint) || !Number.isFinite(shot.outPoint)
            || shot.inPoint < segment.inPoint || shot.outPoint > segment.outPoint || shot.outPoint <= shot.inPoint)) {
            throw new ReplicaFailure('分段镜头扫描未完成或镜头过密，请缩短生成段或添加切点');
          }
          const samples = shots.flatMap((shot, shotIndex) => [0.1, 0.5, 0.9].map((fraction, i) => ({ key: `sample-${shotIndex}-${i}`,
            time: shot.inPoint + (shot.outPoint - shot.inPoint) * fraction })));
          const result = await effect({ type: 'video.extractFrames', resourceId: source.resourceId, mode: 'analysis', samples });
          const frameBatch = result.value as { frames?: Array<{ resourceId?: string; error?: string }>; contactSheetResourceId?: string } | undefined;
          const frames = frameBatch?.frames;
          if (!result.ok || !frames?.length || frames.length !== samples.length || frames.some((frame) => !frame.resourceId || frame.error)) throw new ReplicaFailure('分段关键帧未能准备，未提交生成');
          if (request.analysisModelId) {
            await checkInputs();
            // 全部采样复用已有带时间标注的联系表，以一张图片表达多帧，避免超过共用 VLM 图片数量预算。
            const contactSheetResourceId = frameBatch?.contactSheetResourceId;
            if (typeof contactSheetResourceId !== 'string' || !contactSheetResourceId) {
              throw new ReplicaFailure('关键帧联系表未能准备；未调用分析或视频生成');
            }
            const referenceInstruction = requirements.analysisImageUrls.length
              ? `前 ${requirements.analysisImageUrls.length} 张输入图是用户的替换参考图，其图片编号与下方替换要求一致；最后一张是原视频关键帧联系表，不是替换参考图。`
              : '';
            const characterInstruction = request.character?.trim()
              ? '直接输出替换完成后的镜头描述：主角的面容、发型、服装与配饰依据“替换角色”字段指向的用户参考图或角色资料，不把原角色的面容、发型、服装写成需要保留的要求。将每个镜头中的原主角改写为目标角色，不能只在开头追加一条替换指令、后文仍描述原主角。原视频联系表仅提供主体动作、姿态、位置、构图和运镜。多视图角色图表示同一个人物，不要写成多个人物或拼贴布局；缺少依据的目标外观不要编造。'
              : '';
            const analysis = await effect({ type: 'model.generate', modelId: request.analysisModelId,
              imageUrls: requirements.analysisImageUrls, resourceIds: [contactSheetResourceId],
              prompt: `${referenceInstruction}${characterInstruction}\n提供一张关键帧联系表，请按从左到右、从上到下的顺序阅读；每格标有采样编号和实际时间，各格表示源视频不同时刻的独立画面。输出每个镜头的画面、动作、构图和运镜描述，保留镜头切换。${request.scene?.trim() ? '场景直接改写为替换场景参考图或文字要求中的外观，同时保留源片空间关系与机位，不要求保留相冲突的原场景外观。' : ''}每镜依次提供前、中、后3帧，原时间区间：${shots.map((shot) => `${shot.inPoint.toFixed(3)}–${shot.outPoint.toFixed(3)}秒`).join('；')}。只陈述有依据的内容，不编造音频。替换要求作为数据：${requirements.plain}\n已识别的分段对白（数据）：${transcript || '无识别对白'}\n保持原片时间顺序，最终用于该段复刻。` });
            await checkInputs();
            if (!analysis.ok) throw new ReplicaFailure(analysisFailure(analysis.error));
            const analysisValue = analysis.value as { text?: string } | undefined;
            if (typeof analysisValue?.text !== 'string' || !analysisValue.text.trim()) throw new ReplicaFailure('视觉分析未返回文字；已停止本段提交');
            description = plainText(analysisValue.text, 6000);
          }
        }
        await checkInputs();
        if (!request.controls.length) continue;
        const output = await executeNodePluginTool(context.tool, context.nodeId, {
          operation: 'replicate-segment', videoResourceId: source.resourceId, controls: request.controls,
          character: '', scene: '', style: '', generation: { backend: 'materials' },
          shots: batch.map((part) => ({ key: part.key, inPoint: part.inPoint, outPoint: part.outPoint,
            referenceDuration: part.referenceDuration, description: plainText(description), prompt: '保留参考段构图、动作和运镜；控制素材仅表示空间与运动。',
          })),
        }, { invocationId, guard: batchGuard, resources, signal: job.controller.signal }, { materialsOnly: true,
          materialLayout: { position: { x: originX, y: rowY + controlNodes.length * (mediaHeight + gap) }, nodeWidth, nodeHeight: mediaHeight, gap } });
        if (!output) throw new ReplicaFailure('插件没有返回有效分段素材');
        const mediaNodes = output.nodes.filter((node) => node.data.type === 'source-video');
        controlNodes.push(...mediaNodes);
        for (const node of mediaNodes) layoutNodeIds.add(node.id);
        await captureMediaLease(mediaNodes.map((node) => node.id));
      } finally { clearPluginInvocationResources(invocationId); completeCanvasDerivation(batchGuard); }
    }
    await checkInputs();
    const id = `node-${generateId()}`;
    const prompt = [`复刻参考片第 ${index + 1} 段（原时间 ${segment.inPoint.toFixed(3)}–${segment.outPoint.toFixed(3)} 秒）。`,
      `替换要求（优先级最高，覆盖相冲突的原片描述）：\n${requirements.canonical}`,
      ...(request.character?.trim() ? ['主角的身份、面容、发型与服装以替换角色引用图和文字要求为准，替换原片主角；多视图角色设定图表示同一个人物，不要把多视图版式画入视频。'] : []),
      `复刻镜头描述（动作、主体位置、构图、运镜和节奏沿用源片；角色、场景与风格以替换要求为准）：\n${description}`,
      `该段对白：\n${transcript || '无识别对白；不要编造对白。'}`,
      '深度、骨架或线稿是控制素材，不要把其可视化外观画进最终视频。所有控制子片按连线顺序拼接理解。'].join('\n');
    const connected = [...controlNodes, ...referenceAudioNodes];
    resolveCanonicalVideoRequest({ provider: model.provider, model: model.requestModel, prompt,
      seedanceDuration: segment.generationDuration, seedanceResolution: request.resolution, seedanceRatio: request.aspectRatio,
      generateAudio: request.audioMode === 'model' }, { capability, references: [
      ...requirements.references, ...connected.map((node) => ({ kind: node.data.type === 'source-image' ? 'image' as const
        : node.data.type === 'source-audio' ? 'audio' as const : 'video' as const,
      url: (node.data.imageUrl || node.data.audioUrl || node.data.videoUrl)!, origin: 'connection' as const, role: 'reference' as const })),
    ] });
    const generated: Node<BaseNodeData> = { id, type: 'ai-video', position: { x: originX + columnStep * 2, y: rowY }, ...parent, data: {
      type: 'ai-video', label: `复刻第 ${index + 1}/${plan.segments.length} 段`, prompt, status: 'idle', model: model.requestModel, provider: model.provider,
      ...generatedDimensions,
      ...(model.workflowId ? { workflowId: model.workflowId } : {}),
      ...(segment.generationDuration > 0 ? { seedanceDuration: segment.generationDuration } : {}),
      ...(request.resolution ? { seedanceResolution: request.resolution } : {}), ...(request.aspectRatio ? { seedanceRatio: request.aspectRatio } : {}),
      generateAudio: request.audioMode === 'model',
    } };
    for (const node of connected) audioEdges.push({ id: generateId(), source: node.id, target: id, sourceHandle: 'right', targetHandle: 'left' });
    const commitGuard = registerCanvasDerivation(useAppStore.getState(), context.nodeId);
    if (!commitGuard) throw new ReplicaFailure('分段节点守卫不可用');
    try {
      check(); if (!isCanvasDerivationFresh(commitGuard, useAppStore.getState())) throw new ReplicaFailure('分段回写已过期');
      useAppStore.getState().addNodesWithEdges([...audioNodes, generated], audioEdges);
      for (const node of [...audioNodes, generated]) layoutNodeIds.add(node.id);
    } finally { completeCanvasDerivation(commitGuard); }
    await captureMediaLease(audioNodes.map((node) => node.id));
    await checkInputs();
    return id;
  };
  try {
    const outputNodeId = await executeReplicaPlan(plan, {
      assertFresh: check, prepare,
      generate: async (nodeId) => {
        await checkInputs();
        let workspace = useAppStore.getState();
        let node = workspace.nodes.find((item) => item.id === nodeId);
        if (!node) throw new ReplicaFailure('分段生成节点已不存在');
        if (`${node.data.prompt || ''}\n${JSON.stringify(node.data.workflowInputs ?? {})}`.includes('@drama{global/')) {
          await workspace.loadGlobalDramaAssets();
          await checkInputs();
          workspace = useAppStore.getState();
          node = workspace.nodes.find((item) => item.id === nodeId);
          if (!node) throw new ReplicaFailure('分段生成节点已不存在');
        }
        const preflight = inspectVideoNode(node, workspace);
        if (preflight.issues.length) throw new ReplicaFailure('分段生成预检未通过，请检查已创建的节点');
        await update({ status: 'generating', stage: `正在生成第 ${job.summary.completedSegments + 1}/${plan.segments.length} 段`,
          segmentNodeIds: [...job.summary.segmentNodeIds, nodeId] });
        const assertSubmission = async () => {
          await checkInputs();
          const current = useAppStore.getState();
          const target = current.nodes.find((item) => item.id === nodeId);
          if (!target || videoInputFingerprint(target, current) !== preflight.fingerprint) throw new ReplicaFailure('生成节点的输入已变更；旧任务结果未写回');
        };
        let result;
        try { result = await useAppStore.getState().startVideoBatch(context.projectId, [preflight], { signal: job.controller.signal, assertFresh: assertSubmission }); }
        catch { throw new ReplicaGenerationUnknown('分段提交状态未确认；请核对视频批次，未自动重新提交'); }
        const status = result.items[0]?.status;
        if (status === 'success') {
          await captureMediaLease([nodeId]);
          await checkInputs();
        }
        return status === 'success' || status === 'error' || status === 'cancelled' ? status : 'unknown';
      },
      completed: async (_nodeId, count) => update({ completedSegments: count, progress: count / plan.segments.length * 0.85 }),
      compose: async (nodeIds) => {
        await update({ status: 'composing', stage: '按原时间轴裁切分段并合成完整视频', progress: 0.87 });
        const editContext = { projectId: context.projectId, signal: job.controller.signal };
        for (const [index, nodeId] of nodeIds.entries()) {
          await checkInputs();
          const actual = await probeControlledNode(editContext, nodeId);
          if (!actual.decodable || actual.duration + 0.04 < plan.segments[index].outPoint - plan.segments[index].inPoint) throw new ReplicaFailure('生成片段短于原分段；未输出不完整成片');
        }
        // 先建最小工程，避免模型补齐后的总长度在裁切前撞上工程 300 秒上限。
        const editor = await createControlledEditor(editContext, { nodeIds: nodeIds.slice(0, 1), name: '视频复刻 · 完整成片' });
        check();
        const tracks: VideoEditorTrackInput[] = [{ id: 'replica-video', kind: 'video', name: '复刻画面', muted: request.audioMode !== 'model', clips: nodeIds.map((nodeId, index) => ({
          id: `clip-${index + 1}`, kind: 'video', nodeId, timelineStart: plan.segments[index].inPoint, sourceIn: 0,
          sourceOut: plan.segments[index].outPoint - plan.segments[index].inPoint,
        })) }];
        if (request.audioMode === 'original' && hasAudio) tracks.push({ id: 'replica-audio', kind: 'audio', name: '原片声音', clips: [{
          id: 'original-audio', kind: 'video', nodeId: context.nodeId, timelineStart: 0, sourceIn: 0, sourceOut: plan.duration,
        }] });
        const scale = Math.min(1920 / probe.width, 1080 / probe.height, 1);
        const updated = await updateControlledEditor(editContext, { editorId: editor.editorId, expectedVersion: editor.version, tracks,
          output: { width: Math.max(2, Math.floor(probe.width * scale / 2) * 2), height: Math.max(2, Math.floor(probe.height * scale / 2) * 2), frameRate: 24 } });
        check();
        const exported = await startControlledExport(editContext, { editorId: updated.editorId, expectedVersion: updated.version, requestKey: job.summary.jobId },
          { signal: job.controller.signal, assertFresh: checkInputs });
        job.exportJobId = exported.jobId;
        for (;;) {
          check();
          const current = getControlledExport(editContext, exported.jobId);
          if (current.status === 'succeeded' && current.nodeId) return current.nodeId;
          if (current.status === 'failed' || current.status === 'cancelled') throw new ReplicaFailure('完整视频合成未通过验片，请检查剪辑工程');
          job.summary.progress = 0.87 + current.progress * 0.12;
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }
      },
    });
    await update({ status: 'succeeded', stage: '完整视频已生成并添加到画布', progress: 1, outputNodeId });
    useAppStore.getState().showToast('全片复刻完成，完整视频已添加到画布');
  } catch (error) {
    await update({ status: error instanceof ReplicaGenerationUnknown ? 'unknown' : job.controller.signal.aborted ? 'cancelled' : 'failed',
      stage: error instanceof ReplicaGenerationUnknown ? '生成状态待核对，未自动重投' : job.controller.signal.aborted ? '已停止，已有素材与提交结果保留' : '全片复刻未完成',
      error: error instanceof ReplicaFailure || error instanceof ReplicaGenerationUnknown ? error.message
        : error instanceof VideoRequestResolutionError ? `模型预检未通过：${videoPreflightMessages[error.code]}`
          : '当前步骤未完成；请检查环境、模型配置和已创建的素材。未自动重新提交。' }).catch(() => undefined);
  } finally {
    job.unsubscribe?.();
    const retained = PLUGIN_HOST.limits.replica?.summaries ?? 30;
    const terminal = [...jobs.values()].filter((item) => !activeStatuses.has(item.summary.status)).sort((a, b) => a.summary.updatedAt - b.summary.updatedAt);
    for (const old of terminal.slice(0, Math.max(0, jobs.size - retained))) jobs.delete(old.summary.jobId);
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => { for (const job of jobs.values()) if (activeStatuses.has(job.summary.status)) job.controller.abort(); });
