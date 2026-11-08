/** APIMart 内置音频使用原项目任务和阶段回执恢复；未知 POST 永不重放。 */
import { invoke } from '@tauri-apps/api/core';
import type { AIAudioGenParams, AudioOutputFormat } from '../types/aiTypes';
import type { CanvasContext } from '../types/project';
import type { NativeMediaLocalOutput } from '../types/media';
import { APIMART_BASE_URL } from '../constants/api';
import { useAppStore } from '../store/useAppStore';
import { extractModelName } from './ai/helpers';
import { extractFlowMusicLyrics, extractFlowMusicTracks, fetchFlowMusicTask, generateApimartSpeech, getApimartAudioCapability,
  submitFlowMusicGeneration, submitFlowMusicLyrics, submitSunoGeneration, type FlowMusicTaskState } from './ai/apimartAudio';
import { getHttpResponseError } from './ai/httpUtils';
import { createMediaDownloadAccess } from './ai/mediaDownloadAccess';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { persistNativeMediaOrigin } from './nativeMediaOriginPersistence';
import { assertNativeMediaPrepared, assertNativeMediaResultRetention, claimNativeMediaRecovery, failNativeMediaTask,
  listNativeMediaTasks, normalizeNativeMediaProviderBase, prepareNativeMediaTask, recordNativeMediaSubmission, type NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { beginNativeApimartMusicStage, prepareNativeApimartMusicState, readNativeApimartMusicState, recordNativeApimartMusicStage,
  validateNativeAudioContentFile, type NativeAudioContentFile } from './indexedDb/nativeApimartMusicRepository';
import { retainNativeMediaOutputs } from './indexedDb/nativeMediaCollectionRepository';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { assertNativeVideoSubmissionInput, captureNativeVideoSubmissionBaseline, isNativeVideoSubmissionGuard } from './nativeVideoSubmission';
import { readNativeProjectView } from './nativeProjectNavigation';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { captureNativeMediaLocalResult } from './nativeMediaLocalResult';
import { persistMediaUrlToProjectData } from './fileService';
import { pollTask, PollTaskFailedError } from './pollTask';
import { VIDEO_POLL_MAX_DURATION_MS } from './pollManager';
import { readNativeMediaMessageInput, readNativeMediaOrigin } from './nativeMediaOrigin';
import { nativeMediaInputMaterial } from './nativeMediaInput';

type AudioSettings = Pick<AIAudioGenParams, 'audioVoice' | 'audioFormat' | 'audioSpeed' | 'musicLyrics' | 'musicTitle' | 'musicBpm' | 'musicDuration' | 'autoGenerateLyrics'>;
interface FrozenAudioInput { version: 1; modelId: string; prompt: string; settings: AudioSettings;
  chatSource?: { inputSha256: string; stateSha256: string; prompt: string; modelRef: string } }
const AUDIO_FORMATS: AudioOutputFormat[] = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'];
const AUDIO_MIME: Record<AudioOutputFormat, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac', pcm: 'audio/pcm' };
const contractDigest = (modelId: string) => sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(['apimart-audio-recovery-v1', modelId,
  '/audio/speech', '/music/generations/lyricsFlowMusic', '/music/generations', '/music/tasks/{taskId}?language=zh'])));
function validateInput(value: FrozenAudioInput): FrozenAudioInput {
  const fields = ['audioVoice', 'audioFormat', 'audioSpeed', 'musicLyrics', 'musicTitle', 'musicBpm', 'musicDuration', 'autoGenerateLyrics'];
  if (!value || value.version !== 1 || Object.keys(value).some((key) => !['version', 'modelId', 'prompt', 'settings', 'chatSource'].includes(key))
    || typeof value.modelId !== 'string' || value.modelId.length > 256 || !getApimartAudioCapability(value.modelId)
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 32_000 || !value.settings
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value.settings))
    || Object.keys(value.settings).some((key) => !fields.includes(key))) throw new Error('原音频输入文件无效，未提交生成');
  const settings = value.settings;
  if (value.chatSource && (!/^[a-f0-9]{64}$/.test(value.chatSource.inputSha256) || !/^[a-f0-9]{64}$/.test(value.chatSource.stateSha256)
    || typeof value.chatSource.prompt !== 'string' || value.chatSource.prompt.length > 64_000
    || typeof value.chatSource.modelRef !== 'string' || value.chatSource.modelRef.length > 256
    || Object.keys(value.chatSource).some((key) => !['inputSha256', 'stateSha256', 'prompt', 'modelRef'].includes(key)))) throw new Error('原对话音频输入证明无效');
  if (settings.audioVoice !== undefined && (typeof settings.audioVoice !== 'string' || !settings.audioVoice.trim() || settings.audioVoice.length > 256)
    || settings.audioFormat !== undefined && !AUDIO_FORMATS.includes(settings.audioFormat)
    || settings.audioSpeed !== undefined && (!Number.isFinite(settings.audioSpeed) || settings.audioSpeed < 0.25 || settings.audioSpeed > 4)
    || settings.musicLyrics !== undefined && (typeof settings.musicLyrics !== 'string' || settings.musicLyrics.length > 30_000)
    || settings.musicTitle !== undefined && (typeof settings.musicTitle !== 'string' || settings.musicTitle.length > 512)
    || settings.musicBpm !== undefined && !Number.isFinite(settings.musicBpm)
    || settings.musicDuration !== undefined && !Number.isFinite(settings.musicDuration)
    || settings.autoGenerateLyrics !== undefined && typeof settings.autoGenerateLyrics !== 'boolean'
    || getApimartAudioCapability(value.modelId) === 'speech' && value.prompt.length > 4096
    || settings.autoGenerateLyrics && value.modelId === 'flowmusic' && value.prompt.length > 3000) throw new Error('原音频参数无效，未提交生成');
  return value;
}
async function writeContent(projectId: string, value: unknown): Promise<NativeAudioContentFile> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (!bytes.length || bytes.length > 256 * 1024) throw new Error('原音频输入超过内容文件上限');
  const reference = await invoke<NativeAudioContentFile>('write_native_project_media', { projectId, mimeType: 'application/json', data: Array.from(bytes) });
  validateNativeAudioContentFile(reference);
  if (reference.bytes !== bytes.length || reference.sha256 !== await sha256BytesHex(bytes)) throw new Error('原音频输入未完整保存');
  await readContent(projectId, reference); return reference;
}
async function readContent(projectId: string, reference: NativeAudioContentFile): Promise<unknown> {
  validateNativeAudioContentFile(reference);
  const bytes = new Uint8Array(await invoke<number[]>('read_native_project_media', { projectId, reference }));
  if (bytes.length !== reference.bytes || await sha256BytesHex(bytes) !== reference.sha256) throw new Error('原音频内容文件已变化');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
function currentContext(): CanvasContext {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1) throw new Error('请先返回原音频任务画布'); return context;
}
function assertScope(context: CanvasContext, record: NativeMediaTaskRecord): void {
  if (context.projectId !== record.ownerProjectId || context.canvasId !== record.canvasId || context.episodeId !== record.episodeId
    || context.projectEpoch !== record.projectEpoch || context.canvasEpoch !== record.canvasEpoch
    || !isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原音频画布已切换或代际变化，原回执保留');
}
const chatStateDigest = (fields: unknown[]) => sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(JSON.parse(JSON.stringify(fields)) as unknown)));
async function assertInput(context: CanvasContext, record: NativeMediaTaskRecord, frozen: FrozenAudioInput): Promise<void> {
  assertScope(context, record);
  if (record.origin?.deliveryMode === 'chat') {
    const proof = frozen.chatSource, current = useAppStore.getState();
    if (!proof || proof.inputSha256 !== record.inputFingerprint || proof.modelRef !== record.origin.modelId) throw new Error('原对话音频缺少可复核的输入证明，未提交下一阶段');
    const fields = [current.projects.find((project) => project.id === context.canvasId)?.settings, current.customStyles,
      current.config.generalModels?.find((model) => model.id === proof.modelRef.replace(/^general\//, '')),
      nativeMediaInputMaterial({ id: record.nodeId, type: 'ai-audio', position: { x: 0, y: 0 },
        data: { type: 'ai-audio', label: '', prompt: proof.prompt, model: proof.modelRef, provider: record.providerConfigId } }, current, 'media-input-v3')];
    if (await chatStateDigest(fields) !== proof.stateSha256) throw new Error('原对话音频的项目设置、引用或模型输入已变化，未提交下一阶段');
    await persistNativeMediaOrigin(context, record.origin);
  }
  else await assertNativeVideoSubmissionInput(record, context);
  assertScope(context, record);
}
function connection(record: NativeMediaTaskRecord) {
  const provider = useAppStore.getState().config.providers.apimart;
  const baseUrl = provider?.baseUrl?.trim() || APIMART_BASE_URL;
  if (!provider?.apiKey || normalizeNativeMediaProviderBase(baseUrl) !== record.providerBase) throw new Error('请恢复原 APIMart 音频连接后续查，不会重新生成');
  return { apiKey: provider.apiKey, baseUrl };
}
function taskError(record: NativeMediaTaskRecord, delivered = false): Error {
  const error = new Error(delivered ? `原音频产物已保存并交付（${record.operationId}）` : `原音频操作 ${record.operationId} 已保留，请续取原阶段；未知提交不会重投。`);
  error.name = delivered ? 'NativeMediaTaskDelivered' : 'NativeMediaTaskPending';
  Object.assign(error, { nativeOperationId: record.operationId }); return error;
}
async function deliverCached(record: NativeMediaTaskRecord, signal?: AbortSignal): Promise<void> {
  const { resumeNativeVolcengineTask } = await import('./nativeVolcengineRecovery');
  await resumeNativeVolcengineTask(record.operationId, signal);
}

/** 注册入口先冻结原请求，再把 guard 传到真实 POST 前；旧项目不调用此入口。 */
export async function generateNativeBuiltinAudio(input: { params: AIAudioGenParams; prompt: string; apiKey: string; baseUrl: string;
  signal?: AbortSignal; beforeSubmit?: () => void | Promise<void> }): Promise<never> {
  if (!input.params.nodeId || !isNativeVideoSubmissionGuard(input.beforeSubmit)) throw new Error('原音频提交缺少受信画布入口');
  const context = currentContext(), modelId = extractModelName(input.params.model, input.params.provider);
  const settings = Object.fromEntries(['audioVoice', 'audioFormat', 'audioSpeed', 'musicLyrics', 'musicTitle', 'musicBpm', 'musicDuration', 'autoGenerateLyrics']
    .filter((key) => input.params[key as keyof AIAudioGenParams] !== undefined).map((key) => [key, input.params[key as keyof AIAudioGenParams]])) as AudioSettings;
  const frozen = validateInput({ version: 1, modelId, prompt: input.prompt, settings });
  await input.beforeSubmit?.(); input.signal?.throwIfAborted();
  const baseline = await captureNativeVideoSubmissionBaseline(context, input.params.nodeId, undefined, 'media-input-v3', { preparedReferences: true });
  const messageInput = readNativeMediaMessageInput(context.canvasId, input.params.nodeId);
  if (messageInput) {
    const material = JSON.parse(messageInput.material) as unknown;
    const origin = readNativeMediaOrigin(context.canvasId, input.params.nodeId);
    const intent = Array.isArray(material) ? material[0] as { kind?: unknown; prompt?: unknown } | undefined : undefined;
    if (!Array.isArray(material) || material.length !== 6 || intent?.kind !== 'audio' || typeof intent.prompt !== 'string' || !origin?.modelId
      || await sha256BytesHex(new TextEncoder().encode(messageInput.material)) !== baseline.inputFingerprint) throw new Error('原对话音频输入不能完整冻结，未提交生成');
    frozen.chatSource = { inputSha256: baseline.inputFingerprint, stateSha256: await chatStateDigest(material.slice(2)), prompt: intent.prompt, modelRef: origin.modelId };
  }
  const inputFile = await writeContent(context.projectId, frozen), protocolDigest = await contractDigest(modelId);
  const speech = getApimartAudioCapability(modelId) === 'speech';
  let record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: input.params.nodeId,
    providerConfigId: 'apimart', providerBase: input.baseUrl, modelRef: `apimart/${modelId}`, protocolDigest,
    recovery: { kind: 'builtin-audio', modelId, digest: protocolDigest }, category: 'audio', fingerprintScheme: 'media-input-v3',
    requestFingerprint: inputFile.sha256, inputFingerprint: baseline.inputFingerprint, sourceCanvasRevision: baseline.canvasRevision,
    submissionKind: speech ? 'sync' : 'async' });
  if (!speech) {
    await prepareNativeApimartMusicState(record, inputFile, frozen.settings.autoGenerateLyrics === true && modelId === 'flowmusic');
    try { await resumeNativeBuiltinAudioTask(record.operationId, input.signal, input.beforeSubmit); }
    catch (error) { if (error instanceof Error && error.name === 'NativeMediaTaskDelivered') throw error;
      const latest = (await listNativeMediaTasks(record.ownerProjectId)).find((row) => row.operationId === record.operationId);
      if (latest?.status === 'failed') throw new Error('原音频任务已确认失败，回执保留', { cause: error }); throw taskError(record); }
    throw taskError(record, true);
  }
  let sent = false, retained = false;
  try {
    const generated = await generateApimartSpeech(input.apiKey, input.baseUrl, { model: modelId, input: frozen.prompt,
      voice: settings.audioVoice ?? 'alloy', format: settings.audioFormat ?? 'wav', speed: settings.audioSpeed ?? 1 }, input.signal, async () => {
      await input.beforeSubmit?.(); input.signal?.throwIfAborted(); await assertInput(context, record, frozen); await assertNativeMediaPrepared(record);
      const selected = connection(record); if (selected.apiKey !== input.apiKey) throw new Error('原音频连接已变化');
      record = await recordNativeMediaSubmission(record.operationId, record.lease, { unknown: true });
      input.signal?.throwIfAborted(); sent = true;
    });
    try {
      await assertNativeMediaResultRetention(record);
      if (!generated.bytes?.length) throw new Error('原同步音频没有完整字节');
      const output = await invoke<{ relativePath: string; bytes: number; sha256: string }>('write_native_project_media', {
        projectId: record.ownerProjectId, mimeType: AUDIO_MIME[settings.audioFormat ?? 'wav'], data: Array.from(generated.bytes),
      });
      record = await retainNativeMediaOutputs(record, [{ relativePath: output.relativePath, bytes: output.bytes, sha256: output.sha256, category: 'audio' }]);
      retained = true; input.signal?.throwIfAborted(); assertScope(context, record); await deliverCached(record, input.signal);
    } finally { if (generated.url.startsWith('blob:')) URL.revokeObjectURL(generated.url); }
    throw taskError(record, true);
  } catch (error) {
    if (error instanceof Error && error.name === 'NativeMediaTaskDelivered') throw error;
    if (!retained) {
      record = await recordNativeMediaSubmission(record.operationId, record.lease,
        !sent || getHttpResponseError(error)?.definitiveFailure ? { notStarted: true } : { unknown: true }).catch(() => record);
      if (record.status === 'failed') throw new Error('原同步音频未成功提交，原回执保留', { cause: error });
    }
    throw taskError(record);
  }
}

/** 只续查原阶段 ID；只有持久证明从未发送的下一阶段才允许首次提交。 */
export async function resumeNativeBuiltinAudioTask(operationId: string, externalSignal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>, options: { allowUnstartedStage?: boolean } = {}): Promise<void> {
  const context = currentContext();
  let record = (await listNativeMediaTasks(context.projectId)).find((row) => row.operationId === operationId);
  if (!record || record.recovery?.kind !== 'builtin-audio' || record.providerConfigId !== 'apimart') throw new Error('没有此原音频操作');
  assertScope(context, record);
  if (record.status === 'delivered' || nativeMediaLocalOutputs(record).length) return deliverCached(record, externalSignal);
  if (record.submissionKind === 'sync') throw new Error('原同步调用未保留本机产物，须核对平台，不能重新提交');
  if (record.status === 'failed') throw new Error('原音频任务已确认失败，回执保留');
  if (await contractDigest(record.recovery.modelId!) !== record.protocolDigest || record.recovery.digest !== record.protocolDigest) throw new Error('原音频合同已变化，未查询或重新提交');
  let state = await readNativeApimartMusicState(record);
  const frozen = validateInput(await readContent(record.ownerProjectId, state.inputFile) as FrozenAudioInput);
  if (frozen.modelId !== record.recovery.modelId) throw new Error('原音频内容文件的模型不一致');
  const selected = connection(record), controller = new AbortController(), abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true }); if (externalSignal?.aborted) controller.abort();
  const unsubscribe = useAppStore.subscribe(() => { if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) controller.abort(); });
  const current = () => { controller.signal.throwIfAborted(); assertScope(context, record!); };
  const wait = (taskId: string) => pollTask<FlowMusicTaskState, FlowMusicTaskState>({
    fetchState: (signal) => fetchFlowMusicTask(selected.apiKey, selected.baseUrl, taskId, signal),
    isComplete: (task) => task.status === 'completed' ? task : null,
    isFailed: (task) => ['failed', 'cancelled', 'error'].includes(task.status ?? '') ? 'APIMart 已确认原音乐阶段失败' : null,
    interval: 3000, maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal: controller.signal, onFetchError: 'throw',
  });
  const submit = async (name: 'lyrics' | 'music', generated?: { title: string; lyrics: string }) => {
    const stage = state[name]; if (stage.state === 'unknown') throw new Error('原音频阶段提交未知，请核对平台，不能重投');
    if (stage.state === 'failed') throw new Error('原音频阶段已确认失败');
    if (!['prepared', 'not-started'].includes(stage.state)) return;
    if (!(beforeSubmit && isNativeVideoSubmissionGuard(beforeSubmit)) && options.allowUnstartedStage !== true) {
      throw new Error('下一阶段尚未提交，请显式继续生成阶段；普通续查不会提交付费请求');
    }
    let sent = false;
    const guard = async () => {
      current(); await beforeSubmit?.(); await assertInput(context, record!, frozen);
      if (connection(record!).apiKey !== selected.apiKey) throw new Error('原音频连接已变化');
      if (await useAppStore.getState().saveCurrentProjectSilent() !== record!.canvasId) throw new Error('原音频画布未保存');
      const saved = await readNativeProjectView(record!.ownerProjectId, record!.canvasId);
      current(); await assertInput(context, record!, frozen);
      if (!saved?.selection.canvas) throw new Error('原音频画布不可用');
      state = await beginNativeApimartMusicStage(state, name, saved.selection.canvas.revision);
      controller.signal.throwIfAborted(); sent = true;
    };
    try {
      const settings = frozen.settings;
      const taskId = name === 'lyrics'
        ? await submitFlowMusicLyrics(selected.apiKey, selected.baseUrl, frozen.prompt, controller.signal, guard)
        : /^suno(?:-v6(?:-wild|-mini)?)?$/.test(frozen.modelId)
          ? await submitSunoGeneration(selected.apiKey, selected.baseUrl, { version: frozen.modelId === 'suno' ? 'v6' : frozen.modelId.slice('suno-'.length) as 'v6' | 'v6-wild' | 'v6-mini',
            prompt: frozen.prompt, lyrics: settings.autoGenerateLyrics ? undefined : settings.musicLyrics, title: settings.musicTitle, duration: settings.musicDuration }, controller.signal, guard)
          : await submitFlowMusicGeneration(selected.apiKey, selected.baseUrl, { version: frozen.modelId === 'flowmusic-lyria-3.5' ? 'lyria-3.5' : undefined,
            soundPrompt: frozen.prompt, lyrics: generated?.lyrics || (settings.autoGenerateLyrics ? undefined : settings.musicLyrics),
            title: generated?.title || settings.musicTitle, bpm: settings.musicBpm, length: settings.musicDuration ?? 60 }, controller.signal, guard);
      if (selected.apiKey && taskId.includes(selected.apiKey)) throw new Error('音频响应中的任务身份包含凭据，不能保存或重投');
      state = await recordNativeApimartMusicStage(state, name, { taskId });
    } catch (error) {
      if (state[name].state === 'unknown' && (!sent || getHttpResponseError(error)?.definitiveFailure)) {
        state = await recordNativeApimartMusicStage(state, name, sent ? { failed: true } : { notStarted: true });
      }
      if (state[name].state === 'failed') await recordNativeMediaSubmission(record!.operationId, state.submissionLease, { notStarted: true }).catch(() => undefined);
      else if (state[name].state === 'unknown') await recordNativeMediaSubmission(record!.operationId, state.submissionLease, { unknown: true }).catch(() => undefined);
      throw error;
    }
  };
  try {
    current(); await submit('lyrics');
    let generated: { title: string; lyrics: string } | undefined;
    if (state.lyrics.state === 'submitted') {
      try {
        generated = extractFlowMusicLyrics(await wait(state.lyrics.taskId!));
        const resultFile = await writeContent(record.ownerProjectId, { version: 1, ...generated });
        state = await recordNativeApimartMusicStage(state, 'lyrics', { resultFile });
      } catch (error) {
        if (error instanceof PollTaskFailedError) { state = await recordNativeApimartMusicStage(state, 'lyrics', { failed: true });
          await recordNativeMediaSubmission(record.operationId, state.submissionLease, { notStarted: true }).catch(() => undefined); }
        throw error;
      }
    }
    if (state.lyrics.state === 'completed') {
      const saved = await readContent(record.ownerProjectId, state.lyrics.resultFile!) as { version?: unknown; title?: unknown; lyrics?: unknown };
      if (saved.version !== 1 || typeof saved.title !== 'string' || saved.title.length > 512 || typeof saved.lyrics !== 'string'
        || !saved.lyrics.trim() || saved.lyrics.length > 30_000 || Object.keys(saved).some((key) => !['version', 'title', 'lyrics'].includes(key))) throw new Error('原歌词文件不完整');
      generated = { title: saved.title, lyrics: saved.lyrics };
    }
    current(); await submit('music', generated);
    if (!state.music.taskId || !['submitted', 'completed'].includes(state.music.state)) throw new Error('原音乐任务尚无可确认的任务 ID');
    if (!record.remoteTaskId) record = await recordNativeMediaSubmission(record.operationId, state.submissionLease, { taskId: state.music.taskId });
    if (record.remoteTaskId !== state.music.taskId) throw new Error('原音乐任务 ID 与阶段回执不一致');
    record = await claimNativeMediaRecovery(record.operationId, context);
    const tracks = extractFlowMusicTracks(await wait(state.music.taskId)), outputs: NativeMediaLocalOutput[] = [];
    const access = createMediaDownloadAccess('apimart', selected.baseUrl, { type: 'bearer' });
    for (const [ordinal, track] of tracks.entries()) {
      current();
      const stored = await persistMediaUrlToProjectData(track.url, record.canvasId, 'ai-audio', `原音乐音轨 ${ordinal + 1}`,
        { signal: controller.signal, assertCurrent: current, mediaDownloadAccess: access });
      if (!stored.filePath) throw new Error('原音乐音轨尚未保存');
      outputs.push({ ...await captureNativeMediaLocalResult(record.canvasId, stored.filePath), category: 'audio' });
    }
    record = await retainNativeMediaOutputs(record, outputs);
    state = await recordNativeApimartMusicStage(state, 'music', { completed: true });
    current(); await deliverCached(record, controller.signal);
  } catch (error) {
    if (error instanceof PollTaskFailedError && state.music.state === 'submitted') {
      await recordNativeApimartMusicStage(state, 'music', { failed: true }).catch(() => undefined);
      await failNativeMediaTask(record).catch(() => undefined);
    }
    throw error;
  } finally { unsubscribe(); externalSignal?.removeEventListener('abort', abort); controller.abort(); }
}
