/** 新项目剪辑转场：只续查原远端任务，结果直接条件提交到原工程。 */
import { stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { CanvasContext } from '../types/project';
import type { ModelProtocolVariables } from './ai/modelProtocol';
import type { NormalizedModelExecutionProtocol, MediaReference } from '../types/aiTypes';
import type { VideoEditorAiTransitionRequest } from './videoEditorWindowService';
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { extractModelName, resolveGeneralModelConnection, splitCommaSeparatedUrls } from './ai/helpers';
import { getProviderPolicy, resolveProviderCatalogId } from './ai/providerPolicies';
import { buildGeneralVideoProtocolVariables, buildVolcengineVideoRequestBody } from './ai/generateVideo';
import { buildModelProtocolRequest, collectModelProtocolTemplatePaths, resolveModelExecutionProfile, submitModelProtocol } from './ai/modelProtocol';
import { resolvePoll, pollResolvedModelProtocol } from './ai/modelProtocolPoll';
import { findModelProtocolForEachCapabilityConflicts, findUnusedReferenceVariables } from './ai/modelProtocolRuntime';
import { createMediaDownloadAccess } from './ai/mediaDownloadAccess';
import { getAssetUrlFromPath, getProjectDataDir, getRelativeAssetPath, joinPath, persistMediaUrlToProjectData } from './fileService';
import { readNativeVideoImageReference, type NativeVideoImageReference } from './nativeVideoImageReference';
import { arrayBufferToBase64 } from './fs/core';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { assertNativeEditorMediaPrepared, claimNativeEditorMediaTask, commitNativeEditorMediaResult, listNativeEditorMediaTasks,
  prepareNativeEditorMediaTask, recordNativeEditorMediaSubmission, retainNativeEditorMediaOutput, reviewNativeEditorMediaTask, type NativeEditorMediaTask } from './indexedDb/nativeEditorMediaTaskRepository';
import { getHttpResponseError } from './ai/httpUtils';
import { pollTask, PollTaskFailedError } from './pollTask';
import { assertModelProtocolResult } from './ai/modelCapabilityValidation';
import { failNativeEditorMediaTask } from './indexedDb/nativeEditorMediaTaskRepository';
import { APIMART_BASE_URL, VOLCENGINE_BASE_URL } from '../constants/api';
import { getVolcengineSeedanceCapability } from './ai/volcengineVideoModels';
import { buildApimartSeedanceRequest, getApimartSeedanceCapability } from './ai/apimartVideoModels';
import { assertVideoInputConstraints } from './ai/videoInputValidation';
import { resolveCanonicalVideoRequest } from './ai/videoRequestResolver';
import { resolveVideoModelCapability } from './ai/videoModelCapabilityResolver';
import { resolveImageUrlsSequentially } from './ai/referenceMediaPreparation';
import { pollVolcengineVideoTask } from './ai/providers/volcengineVideoQuery';
import { fetchApimartTask, type ApimartTaskResult } from './ai/apimartGen';
import { createBillingRun, findBillingRunByTask, updateBillingRun, type BillingRun } from './billing/volcengineBillingService';
import { quoteVolcengineVideo } from './billing/volcenginePricing';
import { VIDEO_POLL_MAX_DURATION_MS } from './pollManager';
import { APIMART_EDITOR_PROTOCOL, VOLCENGINE_EDITOR_PROTOCOL } from './nativeEditorProtocols';

async function probeStoredVideo(root: string, relativePath: string): Promise<number> {
  const match = /^media\/([a-f0-9]{64})\.[a-z0-9]{1,16}$/.exec(relativePath);
  if (!match) throw new Error('转场产物没有可核验的本项目文件身份');
  const files = await invoke<Array<{ path: string; sha256: string }>>('inspect_project_archive_assets', { assetsDir: root, selectedPaths: [relativePath] });
  if (files.length !== 1 || files[0].path !== relativePath || files[0].sha256 !== match[1]) throw new Error('原转场素材已变化，原回执保留');
  const { createVideoInput, probeVideoSource } = await import('./videoEditorMediaService');
  const input = await createVideoInput(await getAssetUrlFromPath(joinPath(root, relativePath)));
  try {
    const probe = await probeVideoSource(input);
    if (!Number.isFinite(probe.duration) || probe.duration <= 0 || !probe.videoCodec) throw new Error('转场产物不是可识别的视频');
    return probe.duration;
  } finally { input.dispose(); }
}

const digest = (value: unknown) => sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(value)));
function currentContext(): CanvasContext {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1) throw new Error('请返回原新项目画布');
  return context;
}
function assertCurrent(context: CanvasContext, anchorNodeId: string): void {
  const state = useAppStore.getState();
  if (!isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false }) || !state.nodes.some((node) => node.id === anchorNodeId)) {
    throw new Error('原画布或视频节点已变化，转场回执保留');
  }
}
function connection(modelRef: string, providerHint = 'general') {
  if (providerHint === 'volcengine' || providerHint === 'apimart') {
    const provider = useAppStore.getState().config.providers[providerHint];
    if (!provider?.apiKey) throw new Error('缺少原视频连接，请恢复后续查');
    const base = new URL(provider.baseUrl?.trim() || (providerHint === 'volcengine' ? VOLCENGINE_BASE_URL : APIMART_BASE_URL));
    if (!['https:', 'http:'].includes(base.protocol) || base.search || base.hash || base.username || base.password) throw new Error('原连接地址不能安全恢复');
    const modelId = extractModelName(modelRef, providerHint);
    const capability = providerHint === 'volcengine' ? getVolcengineSeedanceCapability(modelId) : getApimartSeedanceCapability(modelId);
    if (!capability || !capability.operations.includes('image-to-video') || capability.maxImageReferences < 2
      || providerHint === 'apimart' && !capability.frameFields && !capability.imageWithRoles) throw new Error('所选模型没有已接通的首尾帧合同，未提交转场');
    const videoCapability = resolveVideoModelCapability(`${providerHint}/${modelId}`, useAppStore.getState().config);
    if (!videoCapability) throw new Error('所选模型能力尚未就绪，未提交转场');
    return { kind: providerHint as 'volcengine' | 'apimart', provider, providerConfigId: providerHint, apiKey: provider.apiKey, baseUrl: base.href.replace(/\/+$/, ''),
      model: { modelId, videoCapability }, frameMode: capability.imageWithRoles ? 'roles' as const : 'fields' as const,
      protocol: providerHint === 'volcengine' ? VOLCENGINE_EDITOR_PROTOCOL : APIMART_EDITOR_PROTOCOL };
  }
  if (providerHint !== 'general') throw new Error('该模型尚未接入可恢复首尾帧转场，未提交任务');
  const found = resolveGeneralModelConnection(modelRef);
  if (!found?.apiKey || !found.baseUrl) throw new Error('缺少原模型连接，请恢复原连接后续查');
  const base = new URL(found.baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.search || base.hash || base.username || base.password) throw new Error('连接地址无法安全恢复');
  const protocol = resolveModelExecutionProfile(found.model.executionProfile);
  if (!protocol || protocol.mode !== 'async' || !protocol.poll) throw new Error('当前模型没有可续查的异步协议');
  const policy = getProviderPolicy(found.definition?.id ?? resolveProviderCatalogId(found.providerConfigId, found.provider));
  if (policy.upload || policy.referenceTransport) throw new Error('该连接的首尾帧上传尚未接入可恢复转场，未提交任务');
  taskIdContext(protocol, 'validation');
  return { ...found, kind: 'general' as const, baseUrl: base.href.replace(/\/$/, ''), protocol };
}
type EditorConnection = ReturnType<typeof connection>;
const connectionDigest = (selected: EditorConnection) => digest(selected.kind === 'general' ? selected.protocol
  : [selected.kind, selected.model.modelId, selected.protocol]);
/** 不保存响应全文或解析后的请求；只接受能由原任务 ID 完整重建的查询协议。 */
function taskIdContext(protocol: NormalizedModelExecutionProtocol, taskId: string): Record<string, unknown> {
  const path = protocol.response.taskIdPath;
  const references = collectModelProtocolTemplatePaths(JSON.stringify(protocol.poll));
  if (!path || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)
    || path.split('.').some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))
    || !references.length || references.some((item) => item !== `submit.${path}`)) {
    throw new Error('该查询协议依赖任务 ID 之外的提交内容，暂不能安全重启恢复');
  }
  const payload: Record<string, unknown> = {};
  let cursor = payload;
  const keys = path.split('.');
  keys.forEach((key, index) => { if (index === keys.length - 1) cursor[key] = taskId; else { const next = {}; cursor[key] = next; cursor = next; } });
  return { submit: payload };
}
async function readFrame(context: CanvasContext, filePath: string | undefined): Promise<{ reference: NativeVideoImageReference; dataUrl: string }> {
  const root = await getProjectDataDir(context.canvasId), relativePath = root && filePath && getRelativeAssetPath(filePath, root);
  const match = relativePath && /^media\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/.exec(relativePath);
  if (!match || !filePath || !relativePath) throw new Error('首尾帧必须是本项目保存的图片');
  const info = await stat(filePath), mimeType = (match[2] === 'jpg' ? 'image/jpeg' : `image/${match[2]}`) as NativeVideoImageReference['mimeType'];
  const reference: NativeVideoImageReference = { sourceNodeId: 'editor-frame', relativePath, sha256: match[1], bytes: info.size, mimeType };
  const bytes = await readNativeVideoImageReference(context.projectId, reference);
  return { reference, dataUrl: `data:${mimeType};base64,${arrayBufferToBase64(bytes.buffer as ArrayBuffer)}` };
}
export async function submitNativeEditorTransition(request: VideoEditorAiTransitionRequest, anchorNodeId: string,
  signal?: AbortSignal, assertWindowCurrent?: () => void): Promise<never> {
  const context = currentContext(); assertCurrent(context, anchorNodeId); assertWindowCurrent?.();
  if (!request.beforeClipId) throw new Error('缺少原剪辑接缝，未提交任务');
  const selected = connection(request.model, request.provider);
  const [first, last] = await Promise.all([readFrame(context, request.firstFrameFilePath), readFrame(context, request.lastFrameFilePath)]);
  assertCurrent(context, anchorNodeId); assertWindowCurrent?.(); signal?.throwIfAborted();
  const references: MediaReference[] = [{ kind: 'image', url: first.dataUrl, origin: 'connection', role: 'first_frame' },
    { kind: 'image', url: last.dataUrl, origin: 'connection', role: 'last_frame' }];
  const referenceInput = { prompt: request.prompt, operation: 'image-to-video' as const,
    imageUrls: [first.dataUrl, last.dataUrl], videoUrls: [], audioUrls: [], references };
  const settings = useAppStore.getState().projects.find((project) => project.id === context.canvasId)?.settings?.generation;
  const params = { prompt: request.prompt, provider: selected.kind, model: selected.model.modelId,
    seedanceDuration: request.duration ?? (selected.kind === 'general' ? undefined : settings?.videoDuration),
    seedanceResolution: selected.kind === 'general' ? undefined : settings?.videoResolution,
    seedanceRatio: selected.kind === 'general' ? undefined : settings?.videoAspectRatio };
  resolveCanonicalVideoRequest(params, { references, capability: selected.model.videoCapability });
  await assertVideoInputConstraints(referenceInput, selected.model.videoCapability, '所选转场模型', { signal });
  let variables: ModelProtocolVariables, requestBody: Record<string, unknown> | undefined;
  if (selected.kind === 'general') {
    variables = buildGeneralVideoProtocolVariables(selected.model.modelId, params, referenceInput, selected.model.videoCapability);
    const conflicts = findModelProtocolForEachCapabilityConflicts(selected.protocol, selected.model.videoCapability);
    if (conflicts.length || findUnusedReferenceVariables(JSON.stringify(selected.protocol), variables).length) throw new Error('模型协议未完整接收首尾帧，未提交任务');
  } else {
    if (selected.kind === 'volcengine') requestBody = buildVolcengineVideoRequestBody(selected.model.modelId, request.prompt, references, true, params);
    else {
      // 沿用既有公共上传边界；上传源是已核验的本轮字节，不再读取可能变化的原文件。
      const uploaded = await resolveImageUrlsSequentially([first.dataUrl, last.dataUrl], 'apimart', signal);
      requestBody = buildApimartSeedanceRequest(selected.model.modelId, request.prompt, { operation: 'image-to-video',
        duration: params.seedanceDuration, resolution: params.seedanceResolution, ratio: params.seedanceRatio,
        ...(selected.frameMode === 'roles' ? { imageWithRoles: [{ url: uploaded[0], role: 'first_frame' }, { url: uploaded[1], role: 'last_frame' }] }
          : { firstFrameUrl: uploaded[0], lastFrameUrl: uploaded[1] }) }) ?? undefined;
    }
    if (!requestBody) throw new Error('所选视频模型缺少首尾帧请求合同');
    variables = { request: JSON.parse(JSON.stringify(requestBody)) };
  }
  const options = { apiKey: selected.apiKey, baseUrl: selected.baseUrl, protocol: selected.protocol, variables, signal };
  buildModelProtocolRequest(options);
  let row = await prepareNativeEditorMediaTask({ context, requestId: request.requestId, anchorNodeId, beforeClipId: request.beforeClipId,
    modelRef: selected.kind === 'general' ? request.model : `${selected.kind}/${selected.model.modelId}`,
    providerConfigId: selected.providerConfigId, providerBase: selected.baseUrl, protocolDigest: await connectionDigest(selected) });
  let sent = false, remoteId: string | undefined;
  let billingRun: BillingRun | null = null;
  try {
    assertCurrent(context, anchorNodeId); assertWindowCurrent?.(); signal?.throwIfAborted();
    if (selected.kind === 'volcengine' && requestBody) {
      const details = { referenceType: 'frame-reference', referenceCount: 2, durationSeconds: Number(requestBody.duration ?? -1),
        resolution: String(requestBody.resolution ?? '720p'), ratio: String(requestBody.ratio ?? '16:9') };
      billingRun = await createBillingRun({ nodeId: anchorNodeId, modelType: 'video', modelId: selected.model.modelId, prompt: request.prompt,
        details, quote: quoteVolcengineVideo({ modelId: selected.model.modelId, ...details }) });
    }
    await Promise.all([readNativeVideoImageReference(context.projectId, first.reference), readNativeVideoImageReference(context.projectId, last.reference)]);
    await assertNativeEditorMediaPrepared(context, row);
    const latest = connection(request.model, request.provider);
    if (latest.providerConfigId !== selected.providerConfigId || latest.baseUrl !== selected.baseUrl || latest.apiKey !== selected.apiKey
      || await connectionDigest(latest) !== row.protocolDigest || latest.model.modelId !== selected.model.modelId) throw new Error('模型连接或协议已变化，未提交任务');
    const finalConnection = connection(request.model, request.provider);
    if (finalConnection.provider !== selected.provider || selected.kind === 'general' && finalConnection.model !== selected.model) throw new Error('模型连接在提交前已变化，未提交任务');
    assertCurrent(context, anchorNodeId); assertWindowCurrent?.(); signal?.throwIfAborted();
    sent = true;
    const submitted = await submitModelProtocol(options);
    remoteId = submitted.taskId;
    if (!remoteId || !submitted.poll) throw new Error('提交未返回可确认的任务 ID，请到平台核对原任务');
    row = await recordNativeEditorMediaSubmission(row, { taskId: remoteId });
    billingRun = await updateBillingRun(billingRun, { status: 'running', taskId: remoteId });
  } catch (error) {
    await recordNativeEditorMediaSubmission(row, remoteId ? { taskId: remoteId }
      : !sent || getHttpResponseError(error)?.definitiveFailure ? { notStarted: true } : { unknown: true }).catch(() => {});
    await updateBillingRun(billingRun, { ...(remoteId ? { taskId: remoteId } : {}), status: remoteId || sent && !getHttpResponseError(error)?.definitiveFailure ? 'unknown' : 'failed',
      ...(!sent || getHttpResponseError(error)?.definitiveFailure ? { calculatedMicros: 0, amountConfidence: 'calculated' as const, finishedAt: Date.now() } : {}) });
    throw new Error(`转场原操作已保留（${row.operationId}）；请从原视频节点取回，不要重新提交。`);
  }
  const pending = new Error('转场任务已提交，请从原视频节点取回；关闭剪辑窗口后仍可继续查询原任务。');
  pending.name = 'NativeEditorTransitionPending';
  throw pending;
}
export async function listNativeEditorTransitions(anchorNodeId?: string): Promise<NativeEditorMediaTask[]> {
  return listNativeEditorMediaTasks(currentContext(), anchorNodeId);
}
/** 结束跟踪只核对原账本scope；锚点删除后仍可从存储健康处理，不能据此恢复投递。 */
export async function reviewNativeEditorTransition(operationId: string, anchorNodeId?: string): Promise<void> {
  const context = currentContext();
  const task = (await listNativeEditorMediaTasks(context, anchorNodeId)).find((row) => row.operationId === operationId);
  if (!task || !isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('当前画布没有该原转场任务或画布已切换');
  await reviewNativeEditorMediaTask(context, operationId);
}
/** 恢复不依赖旧窗口会话；新画布运行租约、工程完整 CAS 和原回执共同决定唯一交付。 */
export async function recoverNativeEditorTransition(operationId: string, anchorNodeId: string, signal?: AbortSignal): Promise<void> {
  const context = currentContext(); assertCurrent(context, anchorNodeId);
  let row = await claimNativeEditorMediaTask(context, operationId);
  if (row.anchorNodeId !== anchorNodeId) throw new Error('转场不属于当前视频节点');
  const builtinVolcengine = row.providerConfigId === 'volcengine' && !row.modelRef.startsWith('general/');
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const unsubscribe = useAppStore.subscribe(() => { try { assertCurrent(context, anchorNodeId); } catch { controller.abort(); } });
  const guard = () => { activeSignal.throwIfAborted(); assertCurrent(context, anchorNodeId); };
  let remoteFailed: 'failed' | 'cancelled' | undefined;
  try {
    const root = await getProjectDataDir(context.canvasId);
    if (!root) throw new Error('原项目素材目录不可用');
    if (row.resultPath) {
      const duration = await probeStoredVideo(root, row.resultPath);
      if (duration !== row.resultDuration) throw new Error('原转场素材时长已变化');
      guard();
      await commitNativeEditorMediaResult(context, row, row.resultPath);
      return;
    }
    const selected = connection(row.modelRef, row.modelRef.startsWith('general/') ? 'general' : row.providerConfigId);
    if (selected.providerConfigId !== row.providerConfigId || selected.baseUrl !== row.providerBase || await connectionDigest(selected) !== row.protocolDigest) {
      throw new Error('原模型连接或协议已变化，请恢复原配置后取回原任务');
    }
    const result = selected.kind === 'volcengine' ? await (async () => {
      const completed = await pollVolcengineVideoTask({ apiKey: selected.apiKey, baseUrl: selected.baseUrl, taskId: row.remoteTaskId!,
        signal: activeSignal, maxDuration: VIDEO_POLL_MAX_DURATION_MS, onFailed: (status) => { remoteFailed = status; } });
      const run = await findBillingRunByTask(row.remoteTaskId!, row.canvasId).catch(() => null);
      if (run) {
        let quote: ReturnType<typeof quoteVolcengineVideo> | null = null;
        let inputJson = run.inputJson;
        try {
          const details = JSON.parse(run.inputJson) as { durationSeconds?: number; resolution?: string; ratio?: string };
          if (completed.completionTokens !== undefined) {
            quote = quoteVolcengineVideo({ modelId: run.modelId, durationSeconds: details.durationSeconds ?? -1,
              resolution: details.resolution ?? '720p', ratio: details.ratio ?? '16:9', completionTokens: completed.completionTokens });
            inputJson = JSON.stringify({ ...details, completionTokens: completed.completionTokens });
          }
        } catch { /* 原费用输入无法复核时不猜测金额。 */ }
        await updateBillingRun(run, { status: 'succeeded', finishedAt: Date.now(), calculatedMicros: quote?.amountMicros ?? null,
          amountConfidence: quote?.amountMicros == null ? 'unknown' : 'usage', inputJson });
      }
      return { urls: [completed.url] };
    })() : selected.kind === 'apimart' ? await pollTask<ApimartTaskResult<{ videos?: Array<{ url: string[] }> }>, { urls: string[] }>({
      fetchState: (querySignal) => fetchApimartTask(selected.apiKey, selected.baseUrl, row.remoteTaskId!, querySignal, true),
      isComplete: (task) => {
        if (task.status !== 'completed') return null;
        const urls = task.result?.videos?.flatMap((video) => splitCommaSeparatedUrls(video.url)) ?? [];
        if (!urls.length) throw new Error('原 APIMart 任务完成但未返回视频');
        return { urls };
      },
      isFailed: (task) => {
        if (!['failed', 'cancelled', 'error'].includes(task.status ?? '')) return null;
        remoteFailed = task.status === 'cancelled' ? 'cancelled' : 'failed'; return '原 APIMart 转场任务已失败或取消';
      }, interval: 3000, maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal: activeSignal, onFetchError: 'throw',
    }) : await pollResolvedModelProtocol(resolvePoll(selected.baseUrl, selected.protocol.poll!, selected.protocol.auth,
      taskIdContext(selected.protocol, row.remoteTaskId!)), selected.apiKey, activeSignal, selected.baseUrl);
    assertModelProtocolResult('video', result);
    if (!result.urls?.[0]) throw new Error('原任务尚未取得视频结果');
    guard();
    const saved = await persistMediaUrlToProjectData(result.urls[0], context.canvasId, 'ai-video', `AI转场-${row.operationId}`, {
      signal: activeSignal, assertCurrent: guard, mediaDownloadAccess: createMediaDownloadAccess(row.providerConfigId, selected.baseUrl, selected.protocol.auth) });
    guard();
    const relativePath = saved.filePath && getRelativeAssetPath(saved.filePath, root);
    if (!relativePath) throw new Error('转场结果未保存到原项目目录');
    const duration = await probeStoredVideo(root, relativePath);
    guard();
    row = await retainNativeEditorMediaOutput(context, row, relativePath, duration);
    guard();
    await commitNativeEditorMediaResult(context, row, relativePath);
    // 确认结果实际可解析，保存后的工程只携带相对路径，不保存临时 URL 或本机路径。
    await getAssetUrlFromPath(joinPath(root, relativePath));
  } catch (error) {
    if (remoteFailed || error instanceof PollTaskFailedError) {
      await failNativeEditorMediaTask(row).catch(() => {});
      if (builtinVolcengine) {
        const run = await findBillingRunByTask(row.remoteTaskId!, row.canvasId).catch(() => null);
        await updateBillingRun(run, { status: remoteFailed ?? 'failed', finishedAt: Date.now(), calculatedMicros: 0, amountConfidence: 'calculated' });
      }
    }
    throw error;
  } finally { unsubscribe(); controller.abort(); }
}
