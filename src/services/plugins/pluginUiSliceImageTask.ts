import { DEFAULT_BASE_URLS } from '../../constants/api';
import type { AIImageGenParams } from '../../types/aiTypes';
import type { CharacterImageTaskRecovery, NativeMediaLocalResult } from '../../types/media';
import { useAppStore } from '../../store/useAppStore';
import { generateImagesBatch } from '../ai/generateImage';
import { getHttpResponseError } from '../ai/httpUtils';
import { resolveImageOutputsPerJob, resolveImageParameterCapability } from '../ai/mediaModelCapabilities';
import { getProviderDefinition } from '../ai/providerCatalogService';
import { registerCharacterImageTaskContext, validateCharacterImageTaskRecovery } from '../characterImageTaskContext';
import { characterImageConfigurationDigest, recoverCharacterImageTask } from '../characterImageTaskRecovery';
import { getAssetUrlFromPath, getProjectDataDir, joinPath } from '../fileService';
import { readImageSourceBlob } from '../fs/imageSourceBlob';
import { openDB, STORE_METADATA } from '../indexedDb/schema';
import { sha256BytesHex } from '../mediaDataUrl';
import { readNativeMediaLocalResult } from '../nativeMediaLocalResult';
import { isNativeMediaContentPath } from '../nativeMediaContentPath';
import { persistNativeMediaResult } from '../nativeMediaResultPersistence';
import { nativeQueryCredentialProof } from '../nativeProtocolRecovery';
import { PollTaskFailedError } from '../pollTask';
import { captureLegacyCanvasContext } from '../projectExecutionContext';
import { readRasterImageDimensions } from '../rasterImageDimensions';
import { resolveRunningHubCredential, runningHubSiteId } from '../runninghubSiteCredentials';
import { mediaProviderConfigId } from '../workflowExecutionService';

interface SliceReceipt {
  id: string;
  operationId: string;
  revision?: number;
  credentialProof: string;
  status: 'submitted' | 'failed' | 'saved';
  recovery: CharacterImageTaskRecovery;
  file?: NativeMediaLocalResult;
}

interface SliceSource {
  selection: string;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  description: string;
}

export interface UiSliceImageCandidate extends SliceSource {
  id: string;
  file: NativeMediaLocalResult;
  previewSha256: string;
  model: string;
  provider: string;
  prompt: string;
  width: number;
  height: number;
}

export interface UiSliceImageDestination extends SliceSource {
  previousId?: string;
  candidates: Map<string, UiSliceImageCandidate>;
}

const active = new Set<string>();
const encoder = new TextEncoder();
class InvalidSliceImage extends Error {}

function checkReceipt(row: SliceReceipt, id: string) {
  const revision = row?.revision ?? 0;
  if (!row || row.id !== id || typeof row.operationId !== 'string' || !row.operationId
    || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER
    || !['submitted', 'saved', 'failed'].includes(row.status) || !row.recovery
    || !/^[a-f0-9]{64}$/u.test(row.credentialProof)
    || row.status === 'saved' && (!row.file || typeof row.file.relativePath !== 'string' || typeof row.file.sha256 !== 'string'
      || !isNativeMediaContentPath(row.file.relativePath, row.file.sha256) || !Number.isSafeInteger(row.file.bytes) || row.file.bytes <= 0)) {
    throw new Error('切图回执不完整，请核对原任务和项目文件');
  }
}

async function receiptTransaction(id: string, change?: (old?: SliceReceipt) => SliceReceipt): Promise<SliceReceipt | undefined> {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_METADATA, change ? 'readwrite' : 'readonly', { durability: 'strict' });
    const store = transaction.objectStore(STORE_METADATA);
    const read = store.get(id);
    let result: SliceReceipt | undefined;
    let failure: unknown;
    read.onsuccess = () => {
      try {
        result = read.result as SliceReceipt | undefined;
        if (result !== undefined) checkReceipt(result, id);
        if (change) {
          result = change(result);
          checkReceipt(result, id);
          store.put(result);
        }
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('切图任务回执保存失败'));
  });
}

export async function resolveUiSliceImageFile(projectId: string, file: NativeMediaLocalResult) {
  await readNativeMediaLocalResult(projectId, file);
  const root = await getProjectDataDir(projectId);
  if (!root) throw new Error('切图结果的项目目录不可用');
  const filePath = joinPath(root, file.relativePath);
  const imageUrl = await getAssetUrlFromPath(filePath);
  return { filePath, imageUrl, relativePath: file.relativePath, thumbnailUrl: imageUrl, output: imageUrl };
}

async function previewOriginal(imageUrl: string, signal: AbortSignal) {
  const blob = await readImageSourceBlob(imageUrl, signal);
  const dimensions = await readRasterImageDimensions(blob);
  if (dimensions && dimensions.width * dimensions.height > 64 * 1024 * 1024) throw new InvalidSliceImage('原图像素超过可预览范围');
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    try { await image.decode(); }
    catch (cause) {
      signal.throwIfAborted();
      throw new InvalidSliceImage('生成结果无法解码为图片，请重新生成该项', { cause });
    }
    signal.throwIfAborted();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width * height > 64 * 1024 * 1024) throw new InvalidSliceImage('原图尺寸无效');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 192 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    try {
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('无法读取原图预览');
      drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
      return { width, height, preview: canvas.toDataURL('image/png') };
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { URL.revokeObjectURL(url); }
}

export async function generateUiSliceImage(params: AIImageGenParams, sourceNodeId: string, destination: UiSliceImageDestination,
  sessionSignal: AbortSignal, assertFresh: () => void) {
  const state = useAppStore.getState(), context = captureLegacyCanvasContext(state);
  if (!context || params.nodeId || params.image_urls?.length !== 1 || !params.prompt.trim()) {
    throw new Error('切图生图需要当前项目、单张参考图和素材描述');
  }
  const config = state.config;
  const selectedModel = params.provider === 'general'
    ? config.generalModels?.find((item) => 'general/' + item.id === params.model) : undefined;
  const connectionId = params.provider === 'general' ? selectedModel?.providerConfigId : mediaProviderConfigId(params.provider);
  if (!connectionId) throw new Error('切图模型连接已变化，请重新选择');
  const connection = config.providers[connectionId];
  const runningHubModel = params.provider === 'runninghub';
  const runningHubCredential = runningHubModel ? resolveRunningHubCredential(config.providers, 'runninghub-model') : undefined;
  const apiKey = runningHubModel ? runningHubCredential?.apiKey?.trim() : connection?.apiKey;
  const runningHubSite = runningHubModel ? runningHubSiteId(runningHubCredential?.baseUrl) : undefined;
  const queryCredential = runningHubSite ? resolveRunningHubCredential(config.providers, 'runninghub-model', runningHubSite) : runningHubCredential;
  if (runningHubModel && queryCredential?.apiKey?.trim() !== apiKey) {
    throw new Error('RunningHub 提交与查询的模型凭据不一致，请核对当前站点设置');
  }
  const connectionAbort = runningHubModel ? new AbortController() : undefined;
  const signal = connectionAbort ? AbortSignal.any([sessionSignal, connectionAbort.signal]) : sessionSignal;
  const connectionChanged = (current: typeof config) => current.providers[connectionId] !== connection
    || runningHubModel && resolveRunningHubCredential(current.providers, 'runninghub-model') !== runningHubCredential
    || runningHubSite && resolveRunningHubCredential(current.providers, 'runninghub-model', runningHubSite) !== queryCredential;
  const connectionError = () => new Error('切图模型连接已变化，请重新打开后续查');
  const capability = resolveImageParameterCapability(params.model, params.provider, config);
  if (capability?.supportsImageReference === false || capability?.maxImageReferences === 0) throw new Error('所选模型不支持参考图');
  if (resolveImageOutputsPerJob(params.model, params.provider, config) > 1 || (capability?.minBatchCount ?? 1) > 1
    || (capability?.outputCountRange?.max ?? 1) > 1) throw new Error('每个切图需要一个独立结果，请选择单图模型');
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertFresh();
    const current = useAppStore.getState().config;
    if (connectionChanged(current) || selectedModel && current.generalModels !== config.generalModels
      && current.generalModels?.find((item) => item.id === selectedModel.id) !== selectedModel) {
      throw connectionError();
    }
  };
  const digest = await sha256BytesHex(encoder.encode(JSON.stringify([
    context.projectId, context.projectEpoch, context.canvasId, context.canvasEpoch, sourceNodeId, destination.sourceSha256,
    destination.selection, params.model, params.provider, params.prompt, params.image_urls, params.imageSize, params.aspectRatio,
  ])));
  const key = 'ui-slice-image:' + digest;
  assertCurrent();
  if (active.has(key)) throw new Error('该切图的生成或续查正在进行');
  active.add(key);
  // 续查会重新读取站点凭据。设置变化时先停止轮询，避免把原任务 ID 发送给另一个账户。
  const unsubscribe = connectionAbort && useAppStore.subscribe((current) => {
    if (connectionChanged(current.config)) connectionAbort.abort(connectionError());
  });
  try {
    const prior = await receiptTransaction(key);
    const configurationDigest = await characterImageConfigurationDigest(params.model, connectionId);
    let file = prior?.status === 'saved' && prior.operationId !== destination.previousId
      && prior.recovery.configurationDigest === configurationDigest && prior.recovery.connectionId === connectionId ? prior.file : undefined;
    let operationId = prior?.operationId ?? '';
    let latest = prior;
    const commit = async (receipt: SliceReceipt) => {
      const expected = latest;
      latest = await receiptTransaction(key, (current) => {
        if (current?.operationId !== expected?.operationId || current?.status !== expected?.status
          || current?.revision !== expected?.revision) throw new Error('另一项生成已更新此切图回执');
        return { ...receipt, revision: (current?.revision ?? 0) + 1 };
      });
    };
    const saveOutput = async (outputs: Array<{ url: string; kind?: string }> & { incomplete?: true }, row: SliceReceipt) => {
      if (outputs.incomplete || outputs.length !== 1 || !outputs[0].url || outputs[0].kind && outputs[0].kind !== 'image') {
        throw new InvalidSliceImage('模型没有返回完整的单张切图结果');
      }
      assertCurrent();
      file = await persistNativeMediaResult(outputs[0].url, context.canvasId, { category: 'image', label: 'UI切图-' + operationId,
        missingFileMessage: '生成原图尚未保存', mediaDownloadAccess: row.recovery.mediaDownloadAccess, signal, assertCurrent });
      await commit({ ...row, status: 'saved', file });
    };
    assertCurrent();
    if (!file) {
      const secrets = Object.values(config.providers).flatMap((provider) => provider.apiKey ? [provider.apiKey] : []);
      assertCurrent();
      if (prior?.status === 'submitted') {
        validateCharacterImageTaskRecovery(prior.recovery, secrets);
        if (prior.recovery.configurationDigest !== configurationDigest || prior.recovery.connectionId !== connectionId
          || prior.recovery.modelRef !== params.model) throw new Error('请恢复该切图原先的模型连接再续查');
        if (!prior.recovery.tasks.length) throw new Error('原请求的提交结果未知，请先到模型服务商核对；未重复提交');
        if (prior.credentialProof !== await nativeQueryCredentialProof(operationId, connectionId, apiKey ?? '')) {
          throw new Error('请恢复该切图提交时的连接凭据再续查');
        }
        assertCurrent();
        try { await saveOutput(await recoverCharacterImageTask(prior.recovery, operationId, signal), prior); }
        catch (error) {
          if (error instanceof PollTaskFailedError || error instanceof InvalidSliceImage) await commit({ ...prior, status: 'failed' });
          throw error;
        }
      } else {
        operationId = crypto.randomUUID();
        const delivered = Object.assign(new Error('切图已保存'), { name: 'NativeMediaTaskDelivered' });
        const task = registerCharacterImageTaskContext({ assertCurrent, execute: async (plan) => {
          if ((plan.expectedCount ?? 1) !== 1 || (plan.recovery.imageOutputCountRange?.max ?? 1) > 1) throw new Error('请选择单图输出模型');
          const base = plan.recovery.providerBase ?? plan.recovery.workflow?.providerBase ?? (connectionId === 'dreamina' ? 'http://dreamina.local'
            : connection?.baseUrl?.trim() || getProviderDefinition(connectionId, connection)?.defaultBaseUrl || DEFAULT_BASE_URLS[connectionId] || '');
          const recovery: CharacterImageTaskRecovery = { ...plan.recovery, version: 1, expectedCount: 1, connectionId,
            modelRef: params.model, providerBase: base.replace(/\/+$/, ''), configurationDigest, tasks: [],
            ...(plan.mediaDownloadAccess ? { mediaDownloadAccess: plan.mediaDownloadAccess } : {}) };
          const credentialProof = await nativeQueryCredentialProof(operationId, connectionId, apiKey ?? '');
          if (recovery.query?.serverId && apiKey) recovery.query = { ...recovery.query, credentialProof };
          validateCharacterImageTaskRecovery(recovery, secrets);
          const row: SliceReceipt = { id: key, operationId, recovery, credentialProof, status: 'submitted' };
          let claimed = false;
          try {
            const outputs = await plan.execute(async () => {
              assertCurrent();
              if (claimed) throw new Error('该切图请求已经提交');
              await commit(row);
              try { assertCurrent(); }
              catch (error) {
                await commit({ ...row, status: 'failed' });
                throw error;
              }
              claimed = true;
            }, async (taskId, recoveryContext) => {
              if (!claimed) throw new Error('切图任务缺少提交回执');
              if (!recovery.tasks.some((entry) => entry.taskId === taskId)) recovery.tasks.push({ taskId, recoveryContext });
              validateCharacterImageTaskRecovery(recovery, secrets);
              await commit(row);
            }, operationId);
            if (!claimed) throw new Error('切图模型没有确认提交');
            await saveOutput(outputs, row);
          } catch (error) {
            if (claimed && (error instanceof PollTaskFailedError || error instanceof InvalidSliceImage || plan.isDefinitiveFailure?.(error)
              || !recovery.tasks.length && getHttpResponseError(error)?.definitiveFailure)) {
              await commit({ ...row, status: 'failed' });
            }
            throw error;
          }
          throw delivered;
        } });
        try { await generateImagesBatch(params, 1, signal, task.beforeSubmit); }
        catch (error) { if (!file || error !== delivered && !(error instanceof Error && error.name === delivered.name)) throw error; }
        finally { task.release(); }
      }
    }
    if (!file) throw new Error('未取得该切图的完整原图');
    assertCurrent();
    const { imageUrl } = await resolveUiSliceImageFile(context.canvasId, file);
    const { preview, width, height } = await previewOriginal(imageUrl, signal).catch(async (error) => {
      if (error instanceof InvalidSliceImage && latest) await commit({ ...latest, status: 'failed' });
      throw error;
    });
    const previewSha256 = await sha256BytesHex(encoder.encode(preview));
    assertCurrent();
    destination.candidates.set(operationId, { id: operationId, file, previewSha256, width, height, prompt: params.prompt, model: params.model,
      provider: params.provider, selection: destination.selection, sourceSha256: destination.sourceSha256,
      sourceWidth: destination.sourceWidth, sourceHeight: destination.sourceHeight, description: destination.description });
    return { url: preview, width, height, uiSliceCandidateId: operationId };
  } finally {
    unsubscribe?.();
    active.delete(key);
  }
}
