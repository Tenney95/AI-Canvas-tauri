/** 主窗口持有全片任务；ReShot 仍是插件执行，媒体生成和合成复用宿主平台。 */
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import type { PluginVideoReplicaJobSummary, PluginVideoReplicaStart, AvailableNodePluginTool, PluginInvocationResources } from '../../types/plugin';
import type { VideoEditorTrackInput } from '../../types/videoEditorControl';
import type { VideoModelCapability } from '../../types/aiTypes';
import { useAppStore } from '../../store/useAppStore';
import { generateId } from '../../store/store.utils';
import { registerCanvasDerivation, completeCanvasDerivation, isCanvasDerivationFresh } from '../canvasDerivationGuard';
import { sha256BytesHex } from '../mediaDataUrl';
import { resolvePromptToChatContent, resolvePromptWithMediaRefs } from '../ai/promptResolver';
import { resolveMediaModel } from '../ai/generationRuntime';
import { resolveVideoModelCapability } from '../ai/videoModelCapabilityResolver';
import { resolveCanonicalVideoRequest } from '../ai/videoRequestResolver';
import { fingerprintAssetImage } from '../fs/assetImageMetadata';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { extractComfyUIIONodes } from '../comfyUIWindowService';
import { inspectVideoNode, videoInputFingerprint } from '../videoBatchPlanning';
import { createControlledEditor, updateControlledEditor } from '../videoEditorControlService';
import { probeControlledNode } from '../videoEditorInspectionService';
import { createVideoInput, probeVideoSource } from '../videoEditorMediaService';
import { startControlledExport, getControlledExport, cancelControlledExport } from '../videoEditorExportService';
import { buildPluginModelCatalog } from './pluginModelCatalog';
import { executeNodePluginTool, executePluginUiHostEffect } from './pluginRuntime';
import { mintPluginInvocationResources, clearPluginInvocationResources, resolvePluginResourceHostUrl, resolvePluginMediaWorkspaceInputs, type PluginResourceReadContext } from './pluginResourceService';
import { PLUGIN_HOST } from './pluginHost';
import { rewritePluginPromptReferences, resolvePluginPromptReferencesForModel } from './pluginPromptReferenceService';
import { extractReplicaSegmentAudio, inspectReplicaSpeechModels, prepareReplicaSpeechModels, transcribeReplicaSegmentAudio } from './pluginVideoReplicaAudioService';
import { planPluginVideoReplica, type PluginVideoReplicaPlan, type PluginVideoReplicaSegmentPlan } from './pluginVideoReplicaPlanning';
import { readPluginVideoReplicaJobs, recoverPluginVideoReplicaJob, savePluginVideoReplicaJob } from './pluginVideoReplicaJobRepository';

interface JobIdentity { projectId: string; pluginId: string; nodeId: string; sourceDigest: string; revisionDigest: string }
interface StartContext extends JobIdentity {
  tool: AvailableNodePluginTool;
  resources: PluginInvocationResources;
  resourceReadContext: PluginResourceReadContext;
  signal?: AbortSignal;
}
interface ReplicaJob {
  summary: PluginVideoReplicaJobSummary;
  controller: AbortController;
  exportJobId?: string;
  unsubscribe?: () => void;
}
const jobs = new Map<string, ReplicaJob>();
const activeStatuses = new Set(['queued', 'preparing', 'generating', 'composing']);
let starting = false;
class ReplicaFailure extends Error {}
export class ReplicaGenerationUnknown extends Error {}

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
  if (state.currentProjectId !== identity.projectId || !state.nodes.some((node) => node.id === identity.nodeId)
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
    const library = canonical.includes('@drama{') ? [state.dramaAssets, state.globalCharacters] : [];
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
  return { canonical, plain: plainText(resolved.prompt), references: media.references, async check() {
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
  const running = [...jobs.values()].find((job) => job.summary.projectId === identity.projectId
    && job.summary.pluginId === identity.pluginId && job.summary.nodeId === identity.nodeId
    && job.summary.sourceDigest === identity.sourceDigest && job.summary.revisionDigest === identity.revisionDigest
    && (activeStatuses.has(job.summary.status) || ['paused', 'unknown'].includes(job.summary.status)));
  if (running) return { ...running.summary, segmentNodeIds: [...running.summary.segmentNodeIds] };
  const previous = (await readPluginVideoReplicaJobs(identity.projectId)).reverse().find((job) => job.pluginId === identity.pluginId
    && job.nodeId === identity.nodeId && job.sourceDigest === identity.sourceDigest && job.revisionDigest === identity.revisionDigest
    && (activeStatuses.has(job.status) || ['paused', 'unknown'].includes(job.status)));
  return previous ? recoverPluginVideoReplicaJob(previous) : undefined;
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
  try {
    const previous = await findPluginVideoReplicaJob(context);
    if (previous && ['paused', 'unknown'].includes(previous.status)) throw new ReplicaFailure('此前任务需要核对已有分段；不会自动重复提交，请先检查视频批次');
    const catalog = buildPluginModelCatalog(state.config, ['video', 'text']);
    const selected = catalog.find((model) => model.id === request.modelId && model.category === 'video');
    if (!selected) throw new ReplicaFailure('请选择当前应用可用的视频模型或工作流');
    const model = resolveMediaModel('video', request.modelId);
    if (!['general', 'comfyui', 'volcengine'].includes(model.provider)) {
      throw new ReplicaFailure('一键全片复刻当前支持已配置中转协议、ComfyUI 和火山方舟；此通道请使用高级物料流程');
    }
    const url = await resolvePluginResourceHostUrl(context.resourceReadContext, request.resourceId);
    const sourceInput = (await resolvePluginMediaWorkspaceInputs(context.resourceReadContext, context.resources))[0];
    const sourceData = useAppStore.getState().nodes.find((node) => node.id === context.nodeId)!.data;
    const audioPath = sourceData.filePath || localMediaUrlToPath(sourceData.videoUrl);
    if (!audioPath || normalizeReplicaPath(audioPath) !== normalizeReplicaPath(sourceInput.path)) throw new ReplicaFailure('源视频授权与音轨来源不一致，请重新导入同一份本地视频');
    const fileFingerprint = (await fingerprintAssetImage(sourceInput.path, context.signal)).digest;
    const input = await createVideoInput(url);
    let probe; let hasAudio;
    try { probe = await probeVideoSource(input); hasAudio = !!(await input.getPrimaryAudioTrack()); }
    finally { input.dispose(); }
    requireIdentity(context);
    if (!probe.decodable) throw new ReplicaFailure('参考视频无法解码，请检查本地编码');
    const workflow = model.workflowId ? state.workflows.find((item) => item.id === model.workflowId) : undefined;
    const capability = resolveVideoModelCapability(request.modelId, state.config, request.resolution) ?? (model.provider === 'comfyui' && request.maxSegmentSeconds
      ? comfyCapability(workflow, request.maxSegmentSeconds) : undefined);
    if (!capability) throw new ReplicaFailure('模型未声明视频能力；请配置能力，或为 ComfyUI 设置分段时长');
    const plan = planPluginVideoReplica({ duration: probe.duration, capability: { ...capability, operations: capability.operations ? [...capability.operations] : undefined },
      cuts: request.cuts, maxSegmentSeconds: request.maxSegmentSeconds, resolution: request.resolution, controls: request.controls, hasAudio });
    const nodeBudget = PLUGIN_HOST.limits.replica?.nodes ?? 512;
    if (plan.segments.reduce((count, segment) => count + 2 * Math.ceil(Math.max(1, segment.references.length) / 6) + 3 + (hasAudio ? 1 : 0)
      + segment.references.length * request.controls.length + segment.audioReferences.length, 0) > nodeBudget) {
      throw new ReplicaFailure(`完整任务预计超过 ${nodeBudget} 个派生节点，请减少控制类型或使用更长生成段`);
    }
    if (request.transcribe && hasAudio && !(await inspectReplicaSpeechModels()).ready) {
      if (!request.downloadSpeech) return { speechModelsRequired: true };
      await prepareReplicaSpeechModels(context.signal);
    }
    const requirements = await captureRequirements(context, request);
    const replacementReferences = requirements.references;
    for (const segment of plan.segments) {
      // 开始任何付费视觉分析前，连同用户的替换引用验证总参考额度。
      const imageSlots = (capability.maxImageReferences ?? Infinity) - replacementReferences.filter((reference) => reference.kind === 'image').length;
      resolveCanonicalVideoRequest({ provider: model.provider, model: model.requestModel, prompt: '视频复刻任务的完整素材预检',
        seedanceDuration: segment.generationDuration, seedanceResolution: request.resolution, seedanceRatio: request.aspectRatio,
        generateAudio: request.audioMode === 'model' }, { capability, references: [
        ...replacementReferences,
        ...segment.references.flatMap((part) => request.controls.map((control) => ({ kind: 'video' as const,
          url: `planning://${part.key}/${control}`, role: 'reference' as const, origin: 'connection' as const }))),
        ...segment.audioReferences.map((part) => ({ kind: 'audio' as const, url: `planning://${part.key}`, role: 'reference_audio' as const, origin: 'connection' as const })),
        ...(imageSlots > 0 ? [{ kind: 'image' as const, url: 'planning://frame', role: 'reference' as const, origin: 'connection' as const }] : []),
      ] });
    }
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
    const job: ReplicaJob = { controller: new AbortController(), summary: {
      projectId: context.projectId, pluginId: context.pluginId, nodeId: context.nodeId, sourceDigest: context.sourceDigest, revisionDigest: context.revisionDigest,
      jobId: `video-replica-${generateId()}`, modelId: request.modelId, status: 'queued', stage: '等待全片复刻',
      totalSegments: plan.segments.length, completedSegments: 0, progress: 0, createdAt: now, updatedAt: now, segmentNodeIds: [], warnings: [
        ...plan.warnings, ...(!hasAudio ? ['源视频没有音轨，将仅生成画面。'] : []),
      ] } };
    const check = () => {
      requireIdentity(context);
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
    throw new ReplicaFailure('任务启动未完成；请检查模型能力、引用额度、素材授权和本地环境');
  } finally { starting = false; }
}

async function runJob(job: ReplicaJob, context: StartContext, request: PluginVideoReplicaStart, plan: PluginVideoReplicaPlan,
  model: ReturnType<typeof resolveMediaModel>, capability: VideoModelCapability, requirements: Awaited<ReturnType<typeof captureRequirements>>, hasAudio: boolean,
  probe: Awaited<ReturnType<typeof probeVideoSource>>, sourcePath: string, check: () => void, checkOriginalInputs: () => Promise<void>): Promise<void> {
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
    let transcript = '';
    const audioNodes: Node<BaseNodeData>[] = [];
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
          audioNodes.push({ id, type: 'source-audio', position: { x: anchor.position.x + index * 480, y: anchor.position.y + 600 }, data: { type: 'source-audio', label: `复刻第 ${index + 1} 段 · 原音`, status: 'success',
            filePath: audio.filePath, fileName: audio.fileName, audioUrl: audio.assetUrl, audioDuration: audio.duration } });
        }
        for (const reference of segment.audioReferences) {
          const audio = await extractReplicaSegmentAudio({ projectId: context.projectId, nodeId: context.nodeId, start: reference.inPoint, end: reference.outPoint,
            referenceDuration: reference.referenceDuration, signal: job.controller.signal, assertFresh: audioCheck });
          if (!audio) throw new ReplicaFailure('模型音频参考未能准备，未提交生成');
          audioNodes.push({ id: `node-${generateId()}`, type: 'source-audio', position: { x: anchor.position.x + index * 480, y: anchor.position.y + 760 + audioNodes.length * 120 },
            data: { type: 'source-audio', label: `复刻第 ${index + 1} 段 · 音频参考`, status: 'success', filePath: audio.filePath, fileName: audio.fileName, audioUrl: audio.assetUrl, audioDuration: audio.duration } });
        }
      }
      audioCheck();
    } finally { completeCanvasDerivation(guard); }
    await checkInputs();
    let description = '保留源片构图、镜头顺序、动作和运镜。';
    const controlNodes: Node<BaseNodeData>[] = [];
    const referenceFrames: Node<BaseNodeData>[] = [];
    const parts = segment.references.length ? segment.references : [{ key: `${segment.key}-frame`, inPoint: segment.inPoint, outPoint: segment.outPoint, referenceDuration: segment.outPoint - segment.inPoint }];
    for (let offset = 0; offset < parts.length; offset += 6) {
      await checkInputs();
      const batch = parts.slice(offset, offset + 6);
      const invocationId = crypto.randomUUID();
      const batchGuard = registerCanvasDerivation(useAppStore.getState(), context.nodeId);
      if (!batchGuard) throw new ReplicaFailure('无法建立素材执行守卫');
      let resources: PluginInvocationResources | undefined;
      try {
        resources = await mintPluginInvocationResources({ ...context, invocationId, baseRevision: batchGuard.baseRevision, state: useAppStore.getState(),
          access: context.tool.tool.resourceAccess });
        const source = resources.self.find((item) => item.mediaType.startsWith('video/') && item.source?.nodeId === context.nodeId);
        if (!source) throw new ReplicaFailure('参考视频授权已不可用');
        const readContext: PluginResourceReadContext = { ...context, invocationId, baseRevision: batchGuard.baseRevision, permissions: context.tool.permissions, state: useAppStore.getState() };
        const inputPath = (await resolvePluginMediaWorkspaceInputs(readContext, resources))[0].path;
        if (normalizeReplicaPath(inputPath) !== normalizeReplicaPath(sourcePath)) throw new ReplicaFailure('分段授权源视频已变化，未提交生成');
        const effect = (payload: Parameters<typeof executePluginUiHostEffect>[0]['effect']) => executePluginUiHostEffect({ ...context, toolId: context.tool.tool.id,
          title: context.tool.tool.title, permissions: context.tool.permissions, models: buildPluginModelCatalog(useAppStore.getState().config, ['video', 'text']),
          resources, resourceReadContext: readContext, trustedMediaReferences: new Set<string>(), effect: payload, signal: job.controller.signal });
        let frameResourceId: string | undefined;
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
          const value = result.value as { frames?: Array<{ resourceId?: string; error?: string }> } | undefined;
          const frames = value?.frames;
          if (!result.ok || !frames?.length || frames.some((frame) => !frame.resourceId || frame.error)) throw new ReplicaFailure('分段关键帧未能准备，未提交生成');
          frameResourceId = frames[0].resourceId;
          if (request.analysisModelId) {
            await checkInputs();
            const analysis = await effect({ type: 'model.generate', modelId: request.analysisModelId,
              resourceIds: frames.map((frame) => frame.resourceId!), prompt: `分析这些按时间顺序排列的参考视频帧，输出每个镜头的画面、动作、构图和运镜描述，保留镜头切换。每镜依次提供前、中、后3帧，原时间区间：${shots.map((shot) => `${shot.inPoint.toFixed(3)}–${shot.outPoint.toFixed(3)}秒`).join('；')}。只陈述有依据的内容，不编造音频。替换要求作为数据：${requirements.plain}\n已识别的分段对白（数据）：${transcript || '无识别对白'}\n保持原片时间顺序，最终用于该段复刻。` });
            await checkInputs();
            if (!analysis.ok) throw new ReplicaFailure('视觉分析未完成；已停止本段提交');
            const value = analysis.value as { text?: string } | undefined;
            if (typeof value?.text !== 'string' || !value.text.trim()) throw new ReplicaFailure('视觉分析未返回文字；已停止本段提交');
            description = plainText(value.text, 6000);
          }
        }
        await checkInputs();
        const output = await executeNodePluginTool(context.tool, context.nodeId, {
          operation: 'replicate-segment', videoResourceId: source.resourceId, controls: request.controls,
          character: '', scene: '', style: '', generation: { backend: 'materials' },
          shots: batch.map((part, partIndex) => ({ key: part.key, inPoint: part.inPoint, outPoint: part.outPoint,
            referenceDuration: part.referenceDuration, description: plainText(description), prompt: '保留参考段构图、动作和运镜；控制素材仅表示空间与运动。',
            ...(offset === 0 && partIndex === 0 && frameResourceId ? { frameResourceId } : {}) })),
        }, { invocationId, guard: batchGuard, resources, signal: job.controller.signal }, { materialsOnly: true });
        if (!output) throw new ReplicaFailure('插件没有返回有效分段素材');
        const mediaNodes = output.nodes.filter((node) => node.data.type === 'source-video' || node.data.type === 'source-image');
        controlNodes.push(...mediaNodes.filter((node) => node.data.type === 'source-video'));
        referenceFrames.push(...mediaNodes.filter((node) => node.data.type === 'source-image'));
        await captureMediaLease(mediaNodes.map((node) => node.id));
      } finally { clearPluginInvocationResources(invocationId); completeCanvasDerivation(batchGuard); }
    }
    await checkInputs();
    const id = `node-${generateId()}`;
    const prompt = [`复刻参考片第 ${index + 1} 段（原时间 ${segment.inPoint.toFixed(3)}–${segment.outPoint.toFixed(3)} 秒），按参考素材顺序保持全部动作、构图、运镜与镜头节奏。`,
      description, `替换要求：\n${requirements.canonical}`, `该段对白：\n${transcript || '无识别对白；不要编造对白。'}`,
      '深度、骨架或线稿是控制素材，不要把其可视化外观画进最终视频。所有控制子片按连线顺序拼接理解。'].join('\n');
    const imageSlots = (capability.maxImageReferences ?? Infinity) - requirements.references.filter((reference) => reference.kind === 'image').length;
    const connected = [...controlNodes, ...(imageSlots > 0 ? referenceFrames.slice(0, 1) : []), ...audioNodes.slice(1)];
    resolveCanonicalVideoRequest({ provider: model.provider, model: model.requestModel, prompt,
      seedanceDuration: segment.generationDuration, seedanceResolution: request.resolution, seedanceRatio: request.aspectRatio,
      generateAudio: request.audioMode === 'model' }, { capability, references: [
      ...requirements.references, ...connected.map((node) => ({ kind: node.data.type === 'source-image' ? 'image' as const
        : node.data.type === 'source-audio' ? 'audio' as const : 'video' as const,
      url: (node.data.imageUrl || node.data.audioUrl || node.data.videoUrl)!, origin: 'connection' as const, role: 'reference' as const })),
    ] });
    const generated: Node<BaseNodeData> = { id, type: 'ai-video', position: { x: anchor.position.x + 1000 + index * 480, y: anchor.position.y }, data: {
      type: 'ai-video', label: `复刻第 ${index + 1}/${plan.segments.length} 段`, prompt, status: 'idle', model: model.requestModel, provider: model.provider,
      ...(model.workflowId ? { workflowId: model.workflowId } : {}),
      ...(segment.generationDuration > 0 ? { seedanceDuration: segment.generationDuration } : {}),
      ...(request.resolution ? { seedanceResolution: request.resolution } : {}), ...(request.aspectRatio ? { seedanceRatio: request.aspectRatio } : {}),
      generateAudio: request.audioMode === 'model',
    } };
    for (const node of connected) audioEdges.push({ id: generateId(), source: node.id, target: id, sourceHandle: 'right', targetHandle: 'left' });
    const transcriptNode: Node<BaseNodeData> = { id: `node-${generateId()}`, type: 'ai-markdown', position: { x: generated.position.x, y: generated.position.y + 520 },
      data: { type: 'ai-markdown', label: `复刻第 ${index + 1} 段 · 对白`, output: `${segment.inPoint.toFixed(3)}–${segment.outPoint.toFixed(3)} 秒\n\n${transcript || '无识别对白'}`, status: 'success' } };
    const commitGuard = registerCanvasDerivation(useAppStore.getState(), context.nodeId);
    if (!commitGuard) throw new ReplicaFailure('分段节点守卫不可用');
    try {
      check(); if (!isCanvasDerivationFresh(commitGuard, useAppStore.getState())) throw new ReplicaFailure('分段回写已过期');
      useAppStore.getState().addNodesWithEdges([...audioNodes, transcriptNode, generated], audioEdges);
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
        const node = useAppStore.getState().nodes.find((item) => item.id === nodeId)!;
        const preflight = inspectVideoNode(node, useAppStore.getState());
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
      error: error instanceof ReplicaFailure || error instanceof ReplicaGenerationUnknown ? error.message : '当前步骤未完成；请检查环境、模型配置和已创建的素材。未自动重新提交。' }).catch(() => undefined);
  } finally {
    job.unsubscribe?.();
    const retained = PLUGIN_HOST.limits.replica?.summaries ?? 30;
    const terminal = [...jobs.values()].filter((item) => !activeStatuses.has(item.summary.status)).sort((a, b) => a.summary.updatedAt - b.summary.updatedAt);
    for (const old of terminal.slice(0, Math.max(0, jobs.size - retained))) jobs.delete(old.summary.jobId);
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => { for (const job of jobs.values()) if (activeStatuses.has(job.summary.status)) job.controller.abort(); });
