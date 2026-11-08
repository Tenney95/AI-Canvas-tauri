/** 新项目剪辑转场：只续查原远端任务，结果直接条件提交到原工程。 */
import { stat } from '@tauri-apps/plugin-fs';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { CanvasContext } from '../types/project';
import type { ModelProtocolVariables } from './ai/modelProtocol';
import type { MediaReference } from '../types/aiTypes';
import type { VideoEditorAiTransitionRequest } from './videoEditorWindowService';
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { extractModelName, resolveGeneralModelConnection, splitCommaSeparatedUrls } from './ai/helpers';
import { resolveProviderCatalogId } from './ai/providerPolicies';
import { buildCanonicalVideoProtocolVariables, buildVolcengineVideoRequestBody } from './ai/generateVideo';
import { buildModelProtocolRequest, resolveModelExecutionProfile, submitModelProtocol } from './ai/modelProtocol';
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
import { retainNativeEditorMediaOutputs } from './indexedDb/nativeEditorMediaTaskRepository';
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
import { apimartEditorTaskIds, APIMART_EDITOR_PROTOCOL, DREAMINA_EDITOR_PROTOCOL, RUNNINGHUB_EDITOR_PROTOCOL, VOLCENGINE_EDITOR_PROTOCOL } from './nativeEditorProtocols';
import { nativeProtocolQueryDigest, nativeProtocolQueryPaths, captureNativeProtocolContext, resolveNativeProtocolContext, isSafeNativeProtocolTaskId } from './nativeModelProtocolTask';
import { captureNativeMediaLocalResult, readNativeMediaLocalResult } from './nativeMediaLocalResult';
import { isNativeMediaContentPath } from './nativeMediaContentPath';
import type { NativeMediaLocalOutput } from '../types/media';
import { runningHubConnection } from './workflowExecutionService';
import { getRunningHubModel, runningHubFrameRole } from './ai/providers/runninghubModelManifest';
import { buildRunningHubModelRequest, submitPreparedRunningHubModel, queryRunningHubModel } from './ai/providers/runninghubMedia';
import { RunningHubTaskFailed } from './ai/providers/runninghubWorkflow';
import { libapiVideoVariables, usesLibapiModelProtocol } from './ai/providers/libapiModelManifest';
import { toapisVideoVariables } from './ai/providers/toapisModelManifest';
import { relayonVideoVariables, usesRelayonModelProtocol, RELAYON_VIDEO_RESULT_URL_PATHS } from './ai/providers/relayonModelManifest';
import { aigcsiVideoVariables, usesAigcsiModelProtocol } from './ai/providers/aigcsiModelManifest';
import { minimaxVideoVariables, resolveMinimaxExecutionProfile, usesMinimaxModelProtocol, assertMinimaxQueryResponse } from './ai/providers/minimaxModelManifest';
import { buildDreaminaVideoParams } from './dreaminaService';
import { getDreaminaVideoCapability } from './ai/dreaminaModels';

async function probeStoredVideo(root: string, relativePath: string): Promise<number> {
  const hash = /([a-f0-9]{64})\.[a-z0-9]{1,16}$/.exec(relativePath)?.[1];
  if (!hash || !isNativeMediaContentPath(relativePath, hash)) throw new Error('转场产物没有可核验的本项目文件身份');
  const files = await invoke<Array<{ path: string; sha256: string }>>('inspect_project_archive_assets', { assetsDir: root, selectedPaths: [relativePath] });
  if (files.length !== 1 || files[0].path !== relativePath || files[0].sha256 !== hash) throw new Error('原转场素材已变化，原回执保留');
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
  if (providerHint === 'dreamina') {
    const modelId = extractModelName(modelRef, 'dreamina'), definition = getDreaminaVideoCapability(modelId);
    const videoCapability = resolveVideoModelCapability(`dreamina/${modelId}`, useAppStore.getState().config);
    if (!definition || !videoCapability || definition.maxImageReferences < 2) throw new Error('该即梦型号没有已确认的首尾帧能力');
    return { kind: 'dreamina' as const, provider: undefined, providerConfigId: 'dreamina', apiKey: '', baseUrl: 'http://dreamina.local',
      definition, model: { modelId, videoCapability }, protocol: DREAMINA_EDITOR_PROTOCOL };
  }
  if (providerHint === 'runninghub' || providerHint === 'runninghub-model') {
    const state = useAppStore.getState(), definition = getRunningHubModel(modelRef, true);
    if (!definition || definition.kind !== 'video' || !['first_frame', 'last_frame'].every((role) => definition.parameters.some((field) =>
      field.required && field.schema.type === 'string' && field.mediaKind === 'image' && runningHubFrameRole(field) === role))) {
      throw new Error('该 RunningHub 型号没有明确的首尾帧字段，未提交转场');
    }
    const rawConnection = runningHubConnection(state.config.providers, 'runninghub-model');
    return { kind: 'runninghub' as const, provider: state.config.providers['runninghub-model'], providerConfigId: 'runninghub-model',
      ...rawConnection, rawConnection, definition, model: { modelId: definition.id, videoCapability: undefined }, protocol: RUNNINGHUB_EDITOR_PROTOCOL };
  }
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
  const catalogId = found.definition?.id ?? resolveProviderCatalogId(found.providerConfigId, found.provider);
  const profile = catalogId === 'minimax' ? resolveMinimaxExecutionProfile(found.model.modelId, found.model.executionProfile) : found.model.executionProfile;
  const protocol = resolveModelExecutionProfile(profile);
  if (!protocol || protocol.mode === 'async' && !protocol.poll) throw new Error('当前模型没有可恢复的媒体协议');
  if (protocol.mode === 'async') nativeProtocolQueryPaths(protocol);
  return { ...found, kind: 'general' as const, sourceModel: found.model, catalogId, profile,
    model: { ...found.model, videoCapability: found.model.videoCapability ?? resolveVideoModelCapability(modelRef, useAppStore.getState().config) },
    baseUrl: base.href.replace(/\/$/, ''), protocol };
}
type EditorConnection = ReturnType<typeof connection>;
const connectionDigest = (selected: EditorConnection) => digest(selected.kind === 'general' ? selected.protocol
  : [selected.kind, selected.model.modelId, selected.protocol, ...(selected.kind === 'runninghub' ? [selected.definition] : [])]);
function generalVariables(selected: Extract<EditorConnection, { kind: 'general' }>, canonical: ReturnType<typeof resolveCanonicalVideoRequest>): ModelProtocolVariables {
  const variables = buildCanonicalVideoProtocolVariables(canonical), id = selected.model.modelId;
  if (selected.catalogId === 'toapis') return toapisVideoVariables(canonical, variables);
  if (selected.catalogId === 'libapi' && usesLibapiModelProtocol(id, selected.profile)) return libapiVideoVariables(canonical, variables);
  if (selected.catalogId === 'relayonapi' && usesRelayonModelProtocol(id, selected.profile)) return relayonVideoVariables(id, variables);
  if (selected.catalogId === 'aigc-si' && usesAigcsiModelProtocol(id, selected.profile)) return aigcsiVideoVariables(variables);
  if (selected.catalogId === 'minimax' && usesMinimaxModelProtocol(id, selected.profile)) return minimaxVideoVariables(canonical, variables);
  return variables;
}
async function saveOutputs(row: NativeEditorMediaTask, urls: readonly string[], selected: EditorConnection,
  signal?: AbortSignal, guard?: () => void, completion?: NativeEditorMediaTask['completion']): Promise<NativeEditorMediaTask> {
  const unique = [...new Set(urls)];
  if (!unique.length || unique.length > 128) throw new Error('原转场视频候选数量无效，回执保留');
  const outputs: NativeMediaLocalOutput[] = [];
  for (const [index, url] of unique.entries()) {
    const saved = await persistMediaUrlToProjectData(url, row.canvasId, 'ai-video', `AI转场-${row.operationId}-${index + 1}`, {
      ...(signal ? { signal } : {}), ...(guard ? { assertCurrent: guard } : {}),
      mediaDownloadAccess: createMediaDownloadAccess(row.providerConfigId, selected.baseUrl, selected.protocol.auth) });
    if (!saved.filePath) throw new Error('原转场结果未保存为本机文件');
    outputs.push({ ...await captureNativeMediaLocalResult(row.canvasId, saved.filePath), category: 'video' });
  }
  return retainNativeEditorMediaOutputs(row, outputs, completion ? { completion } : {});
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
  const canonical = resolveCanonicalVideoRequest(params, { references, capability: selected.model.videoCapability });
  if (selected.kind !== 'runninghub') await assertVideoInputConstraints(referenceInput, selected.model.videoCapability, '所选转场模型', { signal });
  let variables: ModelProtocolVariables, requestBody: Record<string, unknown> | undefined;
  if (selected.kind === 'general') {
    variables = generalVariables(selected, canonical);
    const conflicts = findModelProtocolForEachCapabilityConflicts(selected.protocol, selected.model.videoCapability);
    if (conflicts.length || findUnusedReferenceVariables(JSON.stringify(selected.protocol), variables).length) throw new Error('模型协议未完整接收首尾帧，未提交任务');
    // 公共上传层执行原厂商 transport/policy；输入仅使用本轮已核验的冻结字节。
    const uploaded = await resolveImageUrlsSequentially([first.dataUrl, last.dataUrl], selected.providerConfigId, signal);
    const uploadedReferences = references.map((reference, index) => ({ ...reference, url: uploaded[index] }));
    variables = generalVariables(selected, resolveCanonicalVideoRequest(params, { references: uploadedReferences, capability: selected.model.videoCapability }));
  } else if (selected.kind === 'runninghub') {
    requestBody = await buildRunningHubModelRequest(selected.rawConnection, selected.definition, request.prompt,
      request.duration !== undefined && selected.definition.parameters.some((field) => field.name === 'duration') ? { duration: String(request.duration) } : {},
      { image: [first.dataUrl, last.dataUrl], imageRoles: ['first_frame', 'last_frame'] }, signal);
    variables = { model: selected.model.modelId, request: requestBody };
  } else if (selected.kind === 'dreamina') {
    requestBody = buildDreaminaVideoParams({ model: selected.model.modelId, prompt: request.prompt, references,
      duration: params.seedanceDuration, resolution: params.seedanceResolution, ratio: params.seedanceRatio });
    if (requestBody.kind !== 'frames2video') throw new Error('即梦未生成明确首尾帧合同，未提交转场');
    variables = { request: requestBody };
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
  const options = { apiKey: selected.apiKey, baseUrl: selected.baseUrl, protocol: selected.protocol, variables, signal,
    ...(selected.protocol.mode === 'async' ? { captureRecoveryContext: (payload: unknown) => ({
      ...captureNativeProtocolContext(selected.protocol, payload, variables, [selected.apiKey]),
      ...(selected.kind === 'apimart' ? { taskIds: apimartEditorTaskIds(payload, selected.apiKey) } : {}),
    }) } : {}) };
  buildModelProtocolRequest(options);
  let row = await prepareNativeEditorMediaTask({ context, requestId: request.requestId, anchorNodeId, beforeClipId: request.beforeClipId,
    modelRef: selected.kind === 'general' ? `general/${selected.sourceModel.id}` : `${selected.kind}/${selected.model.modelId}`,
    providerConfigId: selected.providerConfigId, providerBase: selected.baseUrl, protocolDigest: await connectionDigest(selected),
    submissionKind: selected.protocol.mode, ...(selected.protocol.mode === 'async' ? { queryDigest: await nativeProtocolQueryDigest(selected.model.modelId, selected.protocol) } : {}) });
  let sent = false, remoteId: string | undefined, pollContext: Record<string, unknown> | undefined;
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
    if (finalConnection.provider !== selected.provider || selected.kind === 'general' && (finalConnection.kind !== 'general' || finalConnection.sourceModel !== selected.sourceModel)) throw new Error('模型连接在提交前已变化，未提交任务');
    assertCurrent(context, anchorNodeId); assertWindowCurrent?.(); signal?.throwIfAborted();
    row = await recordNativeEditorMediaSubmission(row, { unknown: true });
    assertCurrent(context, anchorNodeId); assertWindowCurrent?.(); signal?.throwIfAborted();
    const sendingConnection = connection(request.model, request.provider);
    if (sendingConnection.provider !== selected.provider || sendingConnection.apiKey !== selected.apiKey || sendingConnection.baseUrl !== selected.baseUrl
      || selected.kind === 'general' && (sendingConnection.kind !== 'general' || sendingConnection.sourceModel !== selected.sourceModel)) throw new Error('模型连接在停写确认后已变化，未提交任务');
    sent = true;
    if (selected.kind === 'dreamina') {
      // 原生提交不可取消；真实返回ID始终先写原账本，再响应切集/关窗。
      const submitted = await invoke<{ submitId: string }>('dreamina_generate', { params: requestBody });
      if (!isSafeNativeProtocolTaskId(submitted.submitId)) throw new Error('即梦未返回可安全保存的原任务身份');
      remoteId = submitted.submitId;
      pollContext = captureNativeProtocolContext(selected.protocol, submitted, variables);
    } else if (selected.kind === 'runninghub') {
      remoteId = await submitPreparedRunningHubModel(selected.rawConnection, selected.definition.id, requestBody!, signal);
      pollContext = captureNativeProtocolContext(selected.protocol, { taskId: remoteId }, variables, [selected.apiKey]);
    } else {
      const submitted = await submitModelProtocol(options);
      if (selected.protocol.mode === 'sync') {
        assertModelProtocolResult('video', submitted);
        // 同步付费返回后先保存原根；切集/关窗只暂停后续投递。
        row = await saveOutputs(row, submitted.urls ?? [], selected);
      } else {
        if (!isSafeNativeProtocolTaskId(submitted.taskId, [selected.apiKey])) throw new Error('提交未返回可安全保存的原任务身份');
        remoteId = submitted.taskId;
        pollContext = submitted.recoveryContext;
        if (!submitted.poll || !pollContext) throw new Error('提交未返回可确认的任务身份，请到平台核对原任务');
      }
    }
    if (remoteId) {
      row = await recordNativeEditorMediaSubmission(row, { taskId: remoteId, ...(pollContext ? { pollContext } : {}) });
      billingRun = await updateBillingRun(billingRun, { status: 'running', taskId: remoteId });
    }
  } catch (error) {
    const lateId = (error as { nativeTaskId?: unknown })?.nativeTaskId;
    if (!remoteId && isSafeNativeProtocolTaskId(lateId, [selected.apiKey])) remoteId = lateId;
    await recordNativeEditorMediaSubmission(row, remoteId ? { taskId: remoteId, ...(pollContext ? { pollContext } : {}) }
      : !sent || getHttpResponseError(error)?.definitiveFailure ? { notStarted: true } : { unknown: true }).catch(() => {});
    await updateBillingRun(billingRun, { ...(remoteId ? { taskId: remoteId } : {}), status: remoteId || sent && !getHttpResponseError(error)?.definitiveFailure ? 'unknown' : 'failed',
      ...(!sent || getHttpResponseError(error)?.definitiveFailure ? { calculatedMicros: 0, amountConfidence: 'calculated' as const, finishedAt: Date.now() } : {}) });
    throw new Error(`转场原操作已保留（${row.operationId}）；请从原视频节点取回，不要重新提交。`, { cause: error });
  }
  try {
    assertCurrent(context, anchorNodeId); assertWindowCurrent?.(); signal?.throwIfAborted();
    await recoverNativeEditorTransition(row.operationId, anchorNodeId, signal);
  } catch { /* 原ID/本机集合已持久化，关闭窗口或切集只暂停投递；从原节点续取。 */ }
  const pending = new Error('转场原操作已保留；请从原视频节点重新打开剪辑工程查看，未完成时可继续取回原任务。');
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
  let completion: NativeEditorMediaTask['completion'];
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
    if (row.localResults?.length) {
      for (const file of row.localResults) await readNativeMediaLocalResult(row.canvasId, file);
      const path = row.localResults[0].relativePath, duration = await probeStoredVideo(root, path);
      guard(); row = await retainNativeEditorMediaOutput(context, row, path, duration);
      guard(); await commitNativeEditorMediaResult(context, row, path); return;
    }
    const selected = connection(row.modelRef, row.modelRef.startsWith('general/') ? 'general' : row.providerConfigId);
    if (selected.providerConfigId !== row.providerConfigId || selected.baseUrl !== row.providerBase || await connectionDigest(selected) !== row.protocolDigest
      || row.queryDigest && await nativeProtocolQueryDigest(selected.model.modelId, selected.protocol) !== row.queryDigest) {
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
    })() : selected.kind === 'apimart' ? await (async () => {
      const ids = row.pollContext?.taskIds ?? [row.remoteTaskId!];
      if (!Array.isArray(ids) || !ids.length || ids.length > 128 || ids[0] !== row.remoteTaskId
        || !ids.every((id): id is string => isSafeNativeProtocolTaskId(id, [selected.apiKey])) || new Set(ids).size !== ids.length) throw new Error('原APIMart任务集合不能安全恢复');
      const urls: string[] = []; let failedTasks = 0;
      for (const taskId of ids) {
        guard();
        try {
          urls.push(...await pollTask<ApimartTaskResult<{ videos?: Array<{ url: string[] }> }>, string[]>({
            fetchState: (querySignal) => fetchApimartTask(selected.apiKey, selected.baseUrl, taskId, querySignal, true),
            isComplete: (task) => {
              if (task.status !== 'completed') return null;
              const candidates = task.result?.videos?.flatMap((video) => splitCommaSeparatedUrls(video.url)) ?? [];
              if (!candidates.length) throw new Error('原 APIMart 任务完成但未返回视频');
              return candidates;
            },
            isFailed: (task) => ['failed', 'cancelled', 'error'].includes(task.status ?? '') ? '原 APIMart 转场任务已失败或取消' : null,
            interval: 3000, maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal: activeSignal, onFetchError: 'throw',
          }));
        } catch (error) { if (!(error instanceof PollTaskFailedError)) throw error; failedTasks++; }
      }
      if (!urls.length) { remoteFailed = 'failed'; throw new PollTaskFailedError('原APIMart转场任务均已失败或取消'); }
      completion = { taskCount: ids.length, failedTasks }; return { urls };
    })() : selected.kind === 'dreamina' ? { urls: await pollTask<{ status: string; outputs: Array<{ url: string; localPath: string }>; failReason?: string }, string[]>({
      fetchState: () => invoke('dreamina_query_result', { submitId: row.remoteTaskId! }),
      isComplete: (value) => value.status === 'success' && value.outputs.length ? value.outputs.map((file) => file.localPath ? convertFileSrc(file.localPath) : file.url) : null,
      isFailed: (value) => value.status === 'failed' ? '即梦已确认原转场任务失败' : null,
      signal: activeSignal, interval: 3000, maxDuration: 60 * 60 * 1000, onFetchError: 'throw',
    }) } : selected.kind === 'runninghub' ? { urls: (await queryRunningHubModel(selected.rawConnection, [row.remoteTaskId!], 'video', activeSignal)).map((output) => output.url) }
      : await (async () => {
        const poll = resolvePoll(selected.baseUrl, selected.protocol.poll!, selected.protocol.auth,
          resolveNativeProtocolContext(selected.protocol, row.remoteTaskId!, row.pollContext));
        if (selected.catalogId === 'relayonapi' && usesRelayonModelProtocol(selected.model.modelId, selected.profile)) poll.resultUrlFallbackPaths = [...RELAYON_VIDEO_RESULT_URL_PATHS];
        return pollResolvedModelProtocol(poll, selected.apiKey, activeSignal, selected.baseUrl,
          selected.catalogId === 'minimax' && usesMinimaxModelProtocol(selected.model.modelId, selected.profile) ? assertMinimaxQueryResponse : undefined);
      })();
    assertModelProtocolResult('video', result);
    if (!result.urls?.[0]) throw new Error('原任务尚未取得视频结果');
    guard();
    row = await saveOutputs(row, result.urls, selected, activeSignal, guard, completion);
    const relativePath = row.localResults![0].relativePath;
    const duration = await probeStoredVideo(root, relativePath);
    guard();
    row = await retainNativeEditorMediaOutput(context, row, relativePath, duration);
    guard();
    await commitNativeEditorMediaResult(context, row, relativePath);
    // 确认结果实际可解析，保存后的工程只携带相对路径，不保存临时 URL 或本机路径。
    await getAssetUrlFromPath(joinPath(root, relativePath));
  } catch (error) {
    if (remoteFailed || error instanceof PollTaskFailedError || error instanceof RunningHubTaskFailed) {
      await failNativeEditorMediaTask(row).catch(() => {});
      if (builtinVolcengine) {
        const run = await findBillingRunByTask(row.remoteTaskId!, row.canvasId).catch(() => null);
        await updateBillingRun(run, { status: remoteFailed ?? 'failed', finishedAt: Date.now(), calculatedMicros: 0, amountConfidence: 'calculated' });
      }
    }
    throw error;
  } finally { unsubscribe(); controller.abort(); }
}
