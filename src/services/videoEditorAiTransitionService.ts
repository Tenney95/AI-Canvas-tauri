/**
 * AI 转场 — 主窗口侧执行
 *
 * 剪辑窗口是独立 webview：它有自己的模块实例，读不到主窗口的 Store，
 * 也拿不到 API Key。因此转场的模型调用一律在主窗口完成，
 * 编辑器只负责出首/尾帧、给提示词，并接收落盘后的结果。
 */
import { useAppStore } from '../store/useAppStore';
import { getMediaModelOptions } from '../components/nodes/shared/defaultModels';
import { generateVideo } from './ai/generateVideo';
import { resolveGeneralModel, resolveGeneralModelConnection } from './ai/helpers';
import { resolveModelExecutionProfile } from './ai/modelProtocol';
import { resolveProviderCatalogId } from './ai/providerPolicies';
import { resolveMinimaxExecutionProfile } from './ai/providers/minimaxModelManifest';
import { getAssetUrlFromPath, getProjectDataDir, getRelativeAssetPath, joinPath, openMediaFileReader, persistMediaUrlToProjectData } from './fileService';
import type { MediaDownloadAccess, MediaReference, MediaTaskReceipt } from '../types/aiTypes';
import { sanitizeMediaResultUrls } from './ai/mediaDownloadAccess';
import { bindMediaTaskContext, getPendingTasksForProject, isVideoEditorTransitionTaskActive, pauseMediaTask, readVideoEditorTransitionTaskResult,
  registerMediaNodeOperation, savePendingTask, updatePendingTask, type PendingTask } from './pollManager';
import type {
  VideoEditorAiTransitionRequest,
  VideoEditorModelOption,
} from './videoEditorWindowService';

/** 编辑器模型下拉的数据源：与画布视频节点用同一份模型目录 */
export function listVideoEditorVideoModels(): VideoEditorModelOption[] {
  const config = useAppStore.getState().config;
  return getMediaModelOptions(config.generalModels ?? [], config)
    .filter((option) => option.mediaKind === 'video')
    .map((option) => ({
      value: option.value,
      label: option.label,
      provider: option.provider,
      groupName: option.groupName,
    }));
}

export interface VideoEditorAiTransitionOutcome {
  videoUrl: string;
  filePath?: string;
  fileName: string;
  taskReceipt?: MediaTaskReceipt;
}

/** 首/尾帧转成生成入口认识的参考媒体；顺序即角色顺序 */
function buildFrameReferences(request: VideoEditorAiTransitionRequest): MediaReference[] {
  const frames: Array<{ url: string; filePath?: string }> = [
    { url: request.firstFrameUrl, filePath: request.firstFrameFilePath },
    { url: request.lastFrameUrl, filePath: request.lastFrameFilePath },
  ];
  return frames
    .filter((frame) => !!frame.url.trim())
    .map((frame, index) => ({
      kind: 'image' as const,
      url: frame.url,
      origin: 'connection' as const,
      role: index === 0 ? ('first_frame' as const) : ('last_frame' as const),
      filePath: frame.filePath,
    }));
}

function transitionTask(receipt: MediaTaskReceipt): PendingTask {
  const task = getPendingTasksForProject(receipt.projectId).find((item) => item.nodeId === receipt.nodeId
    && item.taskId === receipt.taskId && item.attemptId === receipt.attemptId && item.mediaContext?.editorTransition);
  if (!task) throw new Error('原 AI 转场回执已变化，请先核对任务');
  return task;
}

async function savedTransition(task: PendingTask, signal?: AbortSignal): Promise<VideoEditorAiTransitionOutcome | undefined> {
  const fileName = task.mediaContext?.editorTransition?.fileName;
  if (!fileName) return;
  const root = await getProjectDataDir(task.projectId);
  if (!root) return;
  const filePath = joinPath(root, fileName);
  // 文件名从 PendingTask 的白名单取得；实际读取仍走既有原生 scope 和普通文件校验。
  const reader = await openMediaFileReader(filePath, signal);
  await reader.close();
  return { videoUrl: await getAssetUrlFromPath(filePath), filePath, fileName,
    taskReceipt: { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId } };
}

async function persistTransitionResult(url: string, receipt: MediaTaskReceipt, mediaDownloadAccess?: MediaDownloadAccess,
  signal?: AbortSignal, assertCurrent?: () => void): Promise<VideoEditorAiTransitionOutcome> {
  const task = transitionTask(receipt);
  const providerKey = task.providerConfigId ? useAppStore.getState().config.providers[task.providerConfigId]?.apiKey : undefined;
  const resultUrls = sanitizeMediaResultUrls([url], providerKey);
  // 先保存已完成事实，随后任何租约/取消检查均不得丢弃唯一付费结果。
  updatePendingTask(receipt.nodeId, { ...(resultUrls ? { resultUrls } : {}),
    ...(mediaDownloadAccess ? { mediaDownloadAccess } : {}), mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId);
  if (resultUrls) assertCurrent?.();
  const baseName = `AI转场-${task.attemptId ?? task.mediaContext!.editorTransition!.requestId}`;
  const persisted = await persistMediaUrlToProjectData(url, task.projectId, 'ai-video', baseName,
    { ...(resultUrls ? { assertCurrent, signal } : {}), mediaDownloadAccess });
  const root = persisted.filePath ? await getProjectDataDir(task.projectId) : null;
  const fileName = root && persisted.filePath ? getRelativeAssetPath(persisted.filePath, root) : undefined;
  if (persisted.filePath && (!fileName || /[\\/:]/.test(fileName))) throw new Error('转场结果不在原项目数据目录，原回执已保留');
  if (!resultUrls && !fileName) throw new Error('转场内嵌结果未能保存为原项目文件，原回执已保留');
  if (fileName) {
    const current = transitionTask(receipt);
    updatePendingTask(receipt.nodeId, { mediaContext: { ...current.mediaContext!, editorTransition: {
      ...current.mediaContext!.editorTransition!, fileName } } }, receipt.taskId, receipt.attemptId);
  }
  assertCurrent?.();
  signal?.throwIfAborted();
  return { videoUrl: persisted.mediaUrl, filePath: persisted.filePath, fileName: fileName ?? `${baseName}.mp4`, taskReceipt: receipt };
}

/** 用户从原锚点主动取回，只查询/下载原任务，不发起新的模型生成。 */
export async function recoverVideoEditorAiTransition(receipt: MediaTaskReceipt, anchorNodeId: string,
  signal?: AbortSignal, assertCurrent?: () => void): Promise<VideoEditorAiTransitionOutcome> {
  assertCurrent?.();
  if (useAppStore.getState().currentProjectId !== receipt.projectId) throw new Error('请返回原画布后取回 AI 转场');
  const task = transitionTask(receipt);
  if (task.mediaContext?.editorTransition?.anchorNodeId !== anchorNodeId) throw new Error('此转场不属于当前视频节点');
  try {
    const saved = await savedTransition(task, signal).catch(() => undefined);
    if (saved) { assertCurrent?.(); signal?.throwIfAborted(); return saved; }
    const result = await readVideoEditorTransitionTaskResult(receipt, signal);
    return await persistTransitionResult(result.url, receipt, result.mediaDownloadAccess, signal, assertCurrent);
  } catch (error) {
    const current = transitionTask(receipt);
    pauseMediaTask(receipt, error, current.resultUrls?.length || current.mediaContext?.editorTransition?.fileName
      ? 'delivery_pending' : 'query_interrupted');
    throw error;
  }
}

/**
 * 按首帧 → 尾帧生成一段过渡视频，并写入项目数据目录。
 *
 * 落盘失败不静默降级：编辑器需要一个稳定可读的地址来建片段，
 * 只有远端签名 URL 的话，工程下次打开就取不到素材了。
 */
export async function runVideoEditorAiTransition(
  request: VideoEditorAiTransitionRequest,
  projectId: string,
  anchorNodeId: string,
  signal?: AbortSignal,
  assertCurrent?: () => void,
): Promise<VideoEditorAiTransitionOutcome> {
  assertCurrent?.();
  if (useAppStore.getState().currentProjectId !== projectId) throw new Error('原画布已切换，请重新打开剪辑窗口');
  if (![request.requestId, anchorNodeId].every((value) => typeof value === 'string' && value.length > 0
    && value.length <= 256 && !/[\\/:]/.test(value)
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && value !== '.' && value !== '..')) throw new Error('转场请求身份无效');
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error('转场提示词不能为空');
  if (!request.model || !request.provider) throw new Error('请先选择用于生成转场的视频模型');

  const references = buildFrameReferences(request);
  if (references.length < 2) throw new Error('缺少首帧或尾帧，无法生成转场');
  if (useAppStore.getState().projectExecutionContext?.modelGeneration === 1) {
    const { submitNativeEditorTransition } = await import('./nativeEditorTransitionService');
    assertCurrent?.();
    if (useAppStore.getState().currentProjectId !== projectId) throw new Error('原剪辑画布已切换，未提交转场');
    return submitNativeEditorTransition(request, anchorNodeId, signal, assertCurrent);
  }

  const projectSettings = useAppStore.getState().projects
    .find((project) => project.id === projectId)?.settings;
  const directGeneralProtocol = request.provider === 'general';
  const identity = new TextEncoder().encode(JSON.stringify([projectId, anchorNodeId, request.requestId]));
  const digest = await crypto.subtle.digest('SHA-256', identity);
  const trackingId = `video-editor-transition:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  assertCurrent?.();
  if (useAppStore.getState().currentProjectId !== projectId) throw new Error('原画布已切换，请重新打开剪辑窗口');
  if (isVideoEditorTransitionTaskActive(projectId, trackingId)) throw new Error('原转场请求仍在处理，请稍后取回');
  const pending = getPendingTasksForProject(projectId).find((task) => task.nodeId === trackingId);
  if (pending) return recoverVideoEditorAiTransition({ projectId, nodeId: trackingId, taskId: pending.taskId,
    attemptId: pending.attemptId }, anchorNodeId, signal, assertCurrent);
  // 这些视频适配器均依赖旧队列恢复远端异步任务，提前阻断避免创建误报未知的占位回执。
  const projectContext = useAppStore.getState().projectExecutionContext;
  if (projectContext && projectContext.modelGeneration > 0) {
    let knownAsync = ['apimart', 'dreamina', 'volcengine', 'runninghub', 'grsai'].includes(request.provider);
    if (request.provider === 'general') {
      const model = resolveGeneralModel(request.model);
      const connection = resolveGeneralModelConnection(request.model);
      const catalogId = connection && (connection.definition?.id ?? resolveProviderCatalogId(connection.providerConfigId, connection.provider));
      const profile = model && (catalogId === 'minimax'
        ? resolveMinimaxExecutionProfile(model.modelId, model.executionProfile) : model.executionProfile);
      knownAsync = resolveModelExecutionProfile(profile)?.mode === 'async';
    }
    if (knownAsync) throw new Error('新项目暂不支持异步转场任务恢复，未提交请求');
  }
  let receipt: MediaTaskReceipt | undefined;
  let completed = false;
  const releaseOperation = registerMediaNodeOperation(trackingId, true);
  const unbind = bindMediaTaskContext(trackingId, { projectId, modelId: request.model,
    editorTransition: { anchorNodeId, requestId: request.requestId } }, (next) => { receipt = next; });
  try {
    const result = await generateVideo({
      prompt,
      model: request.model,
      provider: request.provider,
      nodeId: trackingId,
      referenceMedia: references,
      seedanceRatio: directGeneralProtocol ? undefined : projectSettings?.generation?.videoAspectRatio,
      seedanceResolution: directGeneralProtocol ? undefined : projectSettings?.generation?.videoResolution,
      seedanceDuration: request.duration
        ?? (directGeneralProtocol ? undefined : projectSettings?.generation?.videoDuration),
    }, signal, () => {
      assertCurrent?.();
      signal?.throwIfAborted();
      // 同步协议尚无远端 ID 时，也在真实提交边界保留 unknown，禁止重启后误当新请求。
      if (!getPendingTasksForProject(projectId).some((task) => task.nodeId === trackingId)) {
        receipt = savePendingTask({ projectId, nodeId: trackingId, nodeType: 'ai-video', provider: request.provider,
          taskType: 'general', taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown' });
      }
    });
    completed = true;
    receipt = result.taskReceipt ?? receipt;
    const current = getPendingTasksForProject(projectId).find((task) => task.nodeId === trackingId);
    if (!current) {
      receipt = savePendingTask({ projectId, nodeId: trackingId, nodeType: 'ai-video', provider: request.provider,
        providerConfigId: result.mediaDownloadAccess?.providerConfigId, taskType: 'custom-protocol',
        taskId: receipt?.taskId || `result-${crypto.randomUUID()}`, attemptId: receipt?.attemptId, submitted: true });
    } else {
      receipt = updatePendingTask(trackingId, { taskId: current.taskId || `result-${crypto.randomUUID()}`,
        ...(!current.taskId ? { taskType: 'custom-protocol', providerConfigId: result.mediaDownloadAccess?.providerConfigId } : {}),
        submitted: true, mediaRecoveryState: 'delivery_pending' }, current.taskId, current.attemptId);
    }
    if (!receipt) throw new Error('转场已完成，但原任务回执保存失败，请先核对平台结果');
    return await persistTransitionResult(result.url, receipt, result.mediaDownloadAccess, signal, assertCurrent);
  } catch (error) {
    if (receipt) pauseMediaTask(receipt, error, completed ? 'delivery_pending' : 'query_interrupted');
    throw error;
  } finally {
    unbind(); releaseOperation();
  }
}
