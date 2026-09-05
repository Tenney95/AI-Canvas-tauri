/** UI 与外部 MCP 共用的受管 Blender 操作；原生执行和产物校验仍由固定 Job 负责。 */
import type { BaseNodeData, DirectorResultManifestReference, DirectorSceneReference } from '../types';
import type {
  DirectorNodeOperationRequest,
  DirectorNodeState,
  DirectorOperationOwner,
  DirectorOperationSnapshot,
  DirectorSceneIdentity,
} from '../types/directorOperation';
import { generateId, useAppStore } from '../store/useAppStore';
import { derivedNodePlacement } from '../store/store.utils';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from './canvasDerivationGuard';
import { createDefaultDirectorScene, type DirectorBlenderJobStatus } from './directorBlenderRuntimeService';
import { loadDirectorScene, saveDirectorScene } from './directorSceneService';
import { normalizeDirectorResultManifestReference, normalizeDirectorSceneReference } from './directorSceneSchema';
import {
  exportDirectorRuntimeFrame,
  exportDirectorRuntimeVideo,
  getDirectorRuntimeAvailability,
  openDirectorRuntime,
  prepareDirectorRuntime,
  resolveDirectorRuntime,
  type DirectorRuntimeCapture,
} from './directorRuntimeRegistry';
import { buildNodeFileName, saveDataUrlToProjectData } from './fileService';
import { collectDirectorImageUrls } from './directorDeskService';

const MESSAGES = {
  DIRECTOR_CONTEXT_CHANGED: '画布绑定已变化，Blender 结果未写回节点',
  DIRECTOR_NOT_FOUND: '当前项目中找不到该 3D 导演台',
  DIRECTOR_NOT_OWNER: '该 Blender 任务不属于当前项目或会话',
  DIRECTOR_BUSY: '该导演台已有任务，或已有 Blender 编辑会话正在运行',
  DIRECTOR_SETUP_REQUIRED: '请先在导演台中选择 Blender 安装，再通过 MCP 启动任务',
  DIRECTOR_UNAVAILABLE: 'Blender 运行时不可用，请检查桌面运行环境和安装状态',
  DIRECTOR_RUNTIME_REQUIRED: '请先将该导演台切换为 Blender 运行时',
  DIRECTOR_INVALID_INPUT: '导演台操作参数无效',
  DIRECTOR_INVALID_FRAME: '目标帧必须位于导演场景的时间线范围内',
  DIRECTOR_SAVED_SCENE_REQUIRED: '尚无已保存的 Blender 工程，请先打开编辑器并保存返回',
  DIRECTOR_DESKTOP_UPDATE_REQUIRED: '保存 Blender 工程模式需要更新并重启桌面软件；当前仍可使用原有导演场景模式',
  DIRECTOR_INVALID_RESULT: 'Blender 未返回与当前任务匹配的完整成果',
  DIRECTOR_CANCELLED: '已取消 Blender 任务',
  DIRECTOR_OPERATION_FAILED: 'Blender 操作失败，请检查本机 Blender 运行环境',
} as const;

export class DirectorOperationError extends Error {
  readonly code: keyof typeof MESSAGES;

  constructor(code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
    this.code = code;
    this.name = 'DirectorOperationError';
  }
}

interface OperationRecord {
  snapshot: DirectorOperationSnapshot;
  owner: DirectorOperationOwner;
  controller: AbortController;
  guard: CanvasDerivationGuard;
  sceneReference?: DirectorSceneReference;
  previousManifestReference?: DirectorResultManifestReference;
  invalidated: boolean;
  mutating: boolean;
  acknowledged: boolean;
  disposed: boolean;
  failure?: DirectorOperationError;
  unsubscribe?: () => void;
  detachSignal?: () => void;
  resolveStart: (snapshot: DirectorOperationSnapshot) => void;
  rejectStart: (error: DirectorOperationError) => void;
}

const operations = new Map<string, OperationRecord>();
const listeners = new Set<() => void>();
const MAX_RETAINED_OPERATIONS = 64;
const terminalStates = new Set(['succeeded', 'cancelled', 'stale', 'failed']);

function isActive(record: OperationRecord): boolean {
  return !terminalStates.has(record.snapshot.state);
}

function emit(record: OperationRecord, patch: Partial<DirectorOperationSnapshot>): void {
  if (record.disposed) return;
  record.snapshot = { ...record.snapshot, ...patch, updatedAt: Date.now() };
  for (const listener of listeners) listener();
}

function cloneSnapshot(snapshot: DirectorOperationSnapshot): DirectorOperationSnapshot {
  return structuredClone(snapshot);
}

function sceneIdentity(reference: DirectorSceneReference): DirectorSceneIdentity {
  return { sceneId: reference.sceneId, revision: reference.revision, sha256: reference.sha256 };
}

function instanceId(nodeId: string, data: BaseNodeData): string {
  return typeof data.directorInstanceId === 'string' && data.directorInstanceId
    ? data.directorInstanceId : nodeId;
}

function isBlenderRuntime(value: unknown): boolean {
  const runtime = resolveDirectorRuntime(value);
  return runtime.supported && runtime.kind === 'blender';
}

function requireProject(owner: DirectorOperationOwner, baseRevision?: number): void {
  const state = useAppStore.getState();
  if (!owner.projectId || state.currentProjectId !== owner.projectId
    || (baseRevision !== undefined && state.getCurrentRevision() !== baseRevision)) {
    throw new DirectorOperationError('DIRECTOR_CONTEXT_CHANGED');
  }
  if (owner.source === 'mcp' && (!owner.taskId || !owner.conversationId)) {
    throw new DirectorOperationError('DIRECTOR_NOT_OWNER');
  }
}

function requireNode(nodeId: string, owner: DirectorOperationOwner) {
  requireProject(owner);
  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId && item.type === 'ai-director');
  if (!node) throw new DirectorOperationError('DIRECTOR_NOT_FOUND');
  if (![owner.projectId, node.id, instanceId(node.id, node.data)].every((value) => /^[a-zA-Z0-9_-]{1,160}$/.test(value))) {
    throw new DirectorOperationError('DIRECTOR_INVALID_INPUT');
  }
  return node;
}

function requireOperation(operationId: string, owner: DirectorOperationOwner): OperationRecord {
  requireProject(owner);
  const record = operations.get(operationId);
  // UI 属于主窗口，可控制同项目任务；MCP 可接续 UI 打开的会话，但不能接管其他 MCP 会话。
  if (!record || record.owner.projectId !== owner.projectId
    || (owner.source === 'mcp' && record.owner.source === 'mcp'
      && owner.conversationId !== record.owner.conversationId)) {
    throw new DirectorOperationError('DIRECTOR_NOT_OWNER');
  }
  return record;
}

function referencesEqual(data: BaseNodeData, record: OperationRecord): boolean {
  try {
    const scene = data.directorScene === undefined ? undefined : normalizeDirectorSceneReference(data.directorScene);
    const manifest = data.directorResultManifest === undefined
      ? undefined : normalizeDirectorResultManifestReference(data.directorResultManifest);
    return JSON.stringify(scene) === JSON.stringify(record.sceneReference)
      && JSON.stringify(manifest) === JSON.stringify(record.previousManifestReference);
  } catch {
    return false;
  }
}

function isFresh(record: OperationRecord): boolean {
  const state = useAppStore.getState();
  const node = state.nodes.find((item) => item.id === record.snapshot.nodeId && item.type === 'ai-director');
  return !record.invalidated && isCanvasDerivationFresh(record.guard, state) && !!node
    && isBlenderRuntime(node.data.directorRuntimeKind)
    && instanceId(node.id, node.data) === record.snapshot.instanceId
    && referencesEqual(node.data, record);
}

function assertFresh(record: OperationRecord): void {
  if (!isFresh(record)) throw new DirectorOperationError('DIRECTOR_CONTEXT_CHANGED');
  if (record.controller.signal.aborted) throw new DirectorOperationError('DIRECTOR_CANCELLED');
}

function acknowledge(record: OperationRecord): void {
  if (record.acknowledged) return;
  record.acknowledged = true;
  // MCP 的单次启动请求结束后，任务由共享运行时拥有；后续通过 operationId 取消。
  record.detachSignal?.();
  record.resolveStart(cloneSnapshot(record.snapshot));
}

function receiveStatus(record: OperationRecord, status: DirectorBlenderJobStatus): void {
  if (!isActive(record) || record.controller.signal.aborted) return;
  if (!isFresh(record)) {
    record.invalidated = true;
    record.controller.abort();
    return;
  }
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(status.jobId)
    || status.operation !== record.snapshot.operation
    || status.sceneId !== record.sceneReference?.sceneId
    || status.sceneRevision !== record.sceneReference.revision
    || (record.snapshot.jobId && record.snapshot.jobId !== status.jobId)) {
    record.failure = new DirectorOperationError('DIRECTOR_INVALID_RESULT');
    record.controller.abort();
    return;
  }
  const progress = status.progress;
  const safeProgress = progress && ['preparing', 'loading-scene', 'rendering', 'saving', 'finalizing'].includes(progress.phase)
    && Number.isSafeInteger(progress.completed) && Number.isSafeInteger(progress.total)
    && progress.completed >= 0 && progress.total >= progress.completed
    ? { phase: progress.phase, completed: progress.completed, total: progress.total } : undefined;
  emit(record, {
    jobId: status.jobId,
    state: ['awaiting-collection', 'collecting'].includes(status.state) ? 'collecting' : 'running',
    progress: safeProgress,
  });
  acknowledge(record);
}

async function prepareScene(record: OperationRecord) {
  if (record.sceneReference) {
    const scene = await loadDirectorScene(record.owner.projectId, record.sceneReference);
    assertFresh(record);
    return scene;
  }
  const saved = await saveDirectorScene(record.owner.projectId, createDefaultDirectorScene(record.snapshot.instanceId));
  assertFresh(record);
  record.mutating = true;
  try {
    const state = useAppStore.getState();
    state.updateNodeData(record.snapshot.nodeId, { directorScene: saved.reference, error: undefined });
    state.incrementRevision();
    record.sceneReference = normalizeDirectorSceneReference(saved.reference);
    completeCanvasDerivation(record.guard);
    const guard = registerCanvasDerivation(useAppStore.getState(), record.snapshot.nodeId, {
      onCancel: () => record.controller.abort(),
    });
    if (!guard) throw new DirectorOperationError('DIRECTOR_CONTEXT_CHANGED');
    record.guard = guard;
  } finally {
    record.mutating = false;
  }
  return saved.scene;
}

function requireManifest(record: OperationRecord, value: unknown): DirectorResultManifestReference {
  try {
    const manifest = normalizeDirectorResultManifestReference(value);
    if (manifest.sceneId === record.sceneReference?.sceneId
      && manifest.sceneRevision === record.sceneReference.revision
      && manifest.sceneSha256 === record.sceneReference.sha256
      && manifest.manifestRevision === (record.previousManifestReference?.manifestRevision ?? 0) + 1) return manifest;
  } catch { /* 不把来自原生/文件的数据写入错误摘要。 */ }
  throw new DirectorOperationError('DIRECTOR_INVALID_RESULT');
}

async function persistMedia(record: OperationRecord, mediaUrl: string, filePath: string | undefined, extension: 'png' | 'mp4') {
  if (!mediaUrl || (!mediaUrl.startsWith('data:') && !filePath)) {
    throw new DirectorOperationError('DIRECTOR_INVALID_RESULT');
  }
  if (mediaUrl.startsWith('data:')) {
    const saved = await saveDataUrlToProjectData(mediaUrl, record.owner.projectId,
      buildNodeFileName('导演台', extension, 'director'));
    assertFresh(record);
    if (!saved?.assetUrl || !saved.filePath) throw new DirectorOperationError('DIRECTOR_INVALID_RESULT');
    return { mediaUrl: saved.assetUrl, filePath: saved.filePath };
  }
  return { mediaUrl, filePath };
}

async function projectCapture(record: OperationRecord, capture: DirectorRuntimeCapture, hasBlend: boolean) {
  const manifest = requireManifest(record, capture.manifestReference);
  const media = await persistMedia(record, capture.mediaUrl || capture.dataUrl || '', capture.filePath, 'png');
  assertFresh(record);
  const state = useAppStore.getState();
  const node = requireNode(record.snapshot.nodeId, record.owner);
  record.mutating = true;
  state.commitToHistory();
  state.updateNodeDataTransient(node.id, {
    directorCaptureUrls: [...collectDirectorImageUrls(node.data), media.mediaUrl].slice(-12),
    directorCaptureFilePaths: [
      ...(Array.isArray(node.data.directorCaptureFilePaths) ? node.data.directorCaptureFilePaths : []),
      media.filePath!,
    ].slice(-12),
    imageUrl: media.mediaUrl, thumbnailUrl: media.mediaUrl, filePath: media.filePath,
    directorResultManifest: manifest, status: 'success', directorStatus: 'ready', error: undefined,
  });
  state.incrementRevision();
  return {
    nodeIds: [node.id], manifestRevision: manifest.manifestRevision, hasFrame: true, hasVideo: false, hasBlend,
    ...(capture.frame !== undefined ? { frame: capture.frame } : {}),
  };
}

async function runOperation(record: OperationRecord, request: DirectorNodeOperationRequest, allowSetup: boolean) {
  try {
    let availability = await getDirectorRuntimeAvailability('blender');
    assertFresh(record);
    if (availability.state === 'unavailable') throw new DirectorOperationError('DIRECTOR_UNAVAILABLE');
    if (availability.state === 'setup-required') {
      if (!allowSetup) throw new DirectorOperationError('DIRECTOR_SETUP_REQUIRED');
      await prepareDirectorRuntime('blender');
      assertFresh(record);
      availability = await getDirectorRuntimeAvailability('blender');
      assertFresh(record);
    }
    const supportsSavedScene = availability.state !== 'unavailable' && availability.supportsSavedScene === true;
    if (request.sceneSource === 'saved-blender' && !supportsSavedScene) {
      throw new DirectorOperationError('DIRECTOR_DESKTOP_UPDATE_REQUIRED');
    }
    emit(record, { sceneSource: request.sceneSource
      ?? (record.previousManifestReference && supportsSavedScene ? 'saved-blender' : 'director-scene') });
    const scene = await prepareScene(record);
    assertFresh(record);
    emit(record, { scene: sceneIdentity(record.sceneReference!) });
    const blender = {
      projectId: record.owner.projectId,
      sceneReference: record.sceneReference!,
      previousManifestReference: record.previousManifestReference,
      sceneSource: record.snapshot.sceneSource,
      signal: record.controller.signal,
      onStatus: (status: DirectorBlenderJobStatus) => receiveStatus(record, status),
    };
    const nodeId = request.nodeId;
    let result: NonNullable<DirectorOperationSnapshot['result']>;
    if (request.operation === 'open-editor') {
      const opened = await openDirectorRuntime('blender', {
        instanceId: record.snapshot.instanceId,
        theme: useAppStore.getState().config.theme === 'light' ? 'light' : 'dark',
        blender,
      });
      assertFresh(record);
      if (!opened?.capture || !opened.blendFilePath) throw new DirectorOperationError('DIRECTOR_INVALID_RESULT');
      result = await projectCapture(record, opened.capture, true);
    } else if (request.operation === 'render-frame') {
      const frame = request.frame ?? (record.snapshot.sceneSource === 'director-scene' ? scene.timeline.startFrame : undefined);
      if (record.snapshot.sceneSource === 'director-scene'
        && frame !== undefined && (frame < scene.timeline.startFrame || frame > scene.timeline.endFrame)) {
        throw new DirectorOperationError('DIRECTOR_INVALID_FRAME');
      }
      const capture = await exportDirectorRuntimeFrame('blender', record.snapshot.instanceId, {
        position: 'current', quality: '1080p', fileName: 'director-frame.png', targetFrame: frame, blender,
      });
      assertFresh(record);
      result = await projectCapture(record, capture, false);
    } else {
      const video = await exportDirectorRuntimeVideo('blender', record.snapshot.instanceId, {
        quality: '720p', fps: scene.timeline.fps, fileName: 'director-ref.mp4', blender,
      });
      assertFresh(record);
      const manifest = requireManifest(record, video.manifestReference);
      const media = await persistMedia(record, video.mediaUrl, video.filePath, 'mp4');
      assertFresh(record);
      const state = useAppStore.getState();
      const node = requireNode(nodeId, record.owner);
      const videoNodeId = `node-${generateId()}`;
      record.mutating = true;
      state.commitToHistory();
      state.updateNodeDataTransient(nodeId, {
        videoUrl: media.mediaUrl, filePath: media.filePath, directorResultManifest: manifest,
        status: 'success', directorStatus: 'ready', error: undefined,
      });
      state.addNodeTransient({
        id: videoNodeId, type: 'ai-video',
        ...derivedNodePlacement({ ...node, data: { ...node.data, nodeWidth: node.data.nodeWidth || 320 } }),
        data: {
          label: `${node.data.label || '3D 导演台'} 导出视频`, type: 'ai-video', role: 'source', status: 'success',
          videoUrl: media.mediaUrl, filePath: media.filePath, fileName: video.fileName,
          // 同项目共享成果目录，删除或撤销任一节点不能删除另一节点仍引用的文件。
          directorResultManifest: manifest, nodeWidth: 280, nodeHeight: 160,
        },
      });
      state.incrementRevision();
      result = {
        nodeIds: [nodeId, videoNodeId], manifestRevision: manifest.manifestRevision, hasFrame: false, hasVideo: true, hasBlend: false,
        ...(video.timeline ? { timeline: { ...video.timeline } } : {}),
      };
    }
    emit(record, { state: 'succeeded', result, progress: undefined });
    acknowledge(record);
    useAppStore.getState().showToast(request.operation === 'render-video'
      ? '参考视频已导出并创建视频节点' : 'Blender 当前镜头已保存并同步到导演台');
  } catch (error) {
    const failure = record.invalidated ? new DirectorOperationError('DIRECTOR_CONTEXT_CHANGED')
      : record.failure ? record.failure
      : error instanceof DirectorOperationError ? error
        : record.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? new DirectorOperationError('DIRECTOR_CANCELLED') : new DirectorOperationError('DIRECTOR_OPERATION_FAILED');
    const state = failure.code === 'DIRECTOR_CONTEXT_CHANGED' ? 'stale'
      : failure.code === 'DIRECTOR_CANCELLED' ? 'cancelled' : 'failed';
    if (!record.disposed && isFresh(record)) {
      record.mutating = true;
      const store = useAppStore.getState();
      const node = store.nodes.find((item) => item.id === record.snapshot.nodeId);
      store.updateNodeDataTransient(record.snapshot.nodeId, {
        error: state === 'cancelled' ? undefined : failure.message,
        directorStatus: node && collectDirectorImageUrls(node.data).length ? 'ready' : 'idle',
      });
    }
    emit(record, { state, error: { code: failure.code, message: failure.message }, progress: undefined });
    if (record.acknowledged && !record.disposed) {
      if (useAppStore.getState().currentProjectId === record.owner.projectId) {
        useAppStore.getState().showToast(failure.message, state === 'cancelled' ? undefined : 'error');
      }
    } else if (!record.acknowledged) record.rejectStart(failure);
  } finally {
    record.unsubscribe?.();
    record.detachSignal?.();
    completeCanvasDerivation(record.guard);
    // 终态记录有界保留；控制器、订阅和 promise 不暴露也不持久化。
    for (const [operationId, candidate] of operations) {
      if (operations.size <= MAX_RETAINED_OPERATIONS) break;
      if (!isActive(candidate)) operations.delete(operationId);
    }
  }
}

export function subscribeDirectorNodeOperations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React useSyncExternalStore 的稳定快照，不得在组件中修改。 */
export function getActiveDirectorNodeOperation(nodeId: string): DirectorOperationSnapshot | undefined {
  const projectId = useAppStore.getState().currentProjectId;
  return [...operations.values()].find((record) => isActive(record)
    && record.owner.projectId === projectId && record.snapshot.nodeId === nodeId)?.snapshot;
}

export function getDirectorOperation(operationId: string, owner: DirectorOperationOwner): DirectorOperationSnapshot {
  return cloneSnapshot(requireOperation(operationId, owner).snapshot);
}

export function cancelDirectorOperation(operationId: string, owner: DirectorOperationOwner): DirectorOperationSnapshot {
  const record = requireOperation(operationId, owner);
  if (isActive(record)) {
    record.controller.abort();
    emit(record, { state: 'cancelling' });
  }
  return cloneSnapshot(record.snapshot);
}

export function setDirectorNodeRuntime(nodeId: string, runtimeKind: unknown, owner: DirectorOperationOwner, baseRevision?: number): void {
  requireProject(owner, baseRevision);
  const node = requireNode(nodeId, owner);
  const runtime = resolveDirectorRuntime(runtimeKind);
  if (!runtime.supported || !['blender', 'lightweight-web'].includes(String(runtimeKind))) {
    throw new DirectorOperationError('DIRECTOR_INVALID_INPUT');
  }
  if (getActiveDirectorNodeOperation(nodeId)) throw new DirectorOperationError('DIRECTOR_BUSY');
  const currentRuntime = resolveDirectorRuntime(node.data.directorRuntimeKind);
  if (currentRuntime.supported && currentRuntime.kind === runtime.kind) return;
  const state = useAppStore.getState();
  state.updateNodeData(nodeId, { directorRuntimeKind: runtime.kind, directorStatus: 'idle', error: undefined });
  state.incrementRevision();
}

export async function getDirectorNodeState(nodeId: string, owner: DirectorOperationOwner): Promise<DirectorNodeState> {
  const initialNode = requireNode(nodeId, owner);
  const availability = await getDirectorRuntimeAvailability(initialNode.data.directorRuntimeKind);
  const node = requireNode(nodeId, owner);
  if (node.data.directorRuntimeKind !== initialNode.data.directorRuntimeKind) {
    throw new DirectorOperationError('DIRECTOR_CONTEXT_CHANGED');
  }
  const runtime = resolveDirectorRuntime(node.data.directorRuntimeKind);
  const scene = node.data.directorScene === undefined ? undefined : normalizeDirectorSceneReference(node.data.directorScene);
  const manifest = node.data.directorResultManifest === undefined
    ? undefined : normalizeDirectorResultManifestReference(node.data.directorResultManifest);
  const active = getActiveDirectorNodeOperation(nodeId);
  const visibleOperation = active ? getDirectorOperation(active.operationId, owner) : undefined;
  return {
    nodeId, projectId: owner.projectId, instanceId: instanceId(nodeId, node.data),
    runtimeKind: runtime.supported ? runtime.kind : null, availability: availability.state,
    scene: scene && sceneIdentity(scene), manifestRevision: manifest?.manifestRevision,
    activeOperation: visibleOperation, captureCount: collectDirectorImageUrls(node.data).length,
    hasVideo: typeof node.data.videoUrl === 'string' && !!node.data.videoUrl,
    renderContract: manifest && availability.state !== 'unavailable' && availability.supportsSavedScene === true
      ? 'saved-blender' : 'director-scene',
    supportsSavedScene: availability.state !== 'unavailable' && availability.supportsSavedScene === true,
  };
}

export async function startDirectorNodeOperation(
  request: DirectorNodeOperationRequest,
  owner: DirectorOperationOwner,
  options: { allowSetup?: boolean; baseRevision?: number; signal?: AbortSignal } = {},
): Promise<DirectorOperationSnapshot> {
  requireProject(owner, options.baseRevision);
  if (options.signal?.aborted) throw new DirectorOperationError('DIRECTOR_CANCELLED');
  const node = requireNode(request.nodeId, owner);
  if (!['open-editor', 'render-frame', 'render-video'].includes(request.operation)
    || (request.sceneSource !== undefined && !['director-scene', 'saved-blender'].includes(request.sceneSource))
    || (request.frame !== undefined && (request.operation !== 'render-frame'
      || !Number.isSafeInteger(request.frame) || request.frame < 0 || request.frame > 10_000_000))) {
    throw new DirectorOperationError('DIRECTOR_INVALID_INPUT');
  }
  if (!isBlenderRuntime(node.data.directorRuntimeKind)) {
    throw new DirectorOperationError('DIRECTOR_RUNTIME_REQUIRED');
  }
  if ([...operations.values()].some((record) => isActive(record)
    && ((record.owner.projectId === owner.projectId && record.snapshot.nodeId === node.id)
      || (request.operation === 'open-editor' && record.snapshot.operation === 'open-editor')))) {
    throw new DirectorOperationError('DIRECTOR_BUSY');
  }
  const sceneReference = node.data.directorScene === undefined ? undefined : normalizeDirectorSceneReference(node.data.directorScene);
  const previousManifestReference = node.data.directorResultManifest === undefined
    ? undefined : normalizeDirectorResultManifestReference(node.data.directorResultManifest);
  const sceneSource = request.sceneSource ?? 'director-scene';
  if (sceneSource === 'saved-blender' && !previousManifestReference) {
    throw new DirectorOperationError('DIRECTOR_SAVED_SCENE_REQUIRED');
  }
  const controller = new AbortController();
  const guard = registerCanvasDerivation(useAppStore.getState(), node.id, { onCancel: () => controller.abort() });
  if (!guard) throw new DirectorOperationError('DIRECTOR_CONTEXT_CHANGED');
  let resolveStart!: OperationRecord['resolveStart'];
  let rejectStart!: OperationRecord['rejectStart'];
  const started = new Promise<DirectorOperationSnapshot>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  const now = Date.now();
  const record: OperationRecord = {
    snapshot: {
      operationId: `director-operation-${generateId()}`, projectId: owner.projectId, nodeId: node.id,
      instanceId: instanceId(node.id, node.data), operation: request.operation, sceneSource,
      state: 'preparing', createdAt: now, updatedAt: now,
      scene: sceneReference && sceneIdentity(sceneReference),
    },
    owner: { ...owner }, controller, guard, sceneReference, previousManifestReference,
    invalidated: false, mutating: false, acknowledged: false, disposed: false, resolveStart, rejectStart,
  };
  operations.set(record.snapshot.operationId, record);
  record.unsubscribe = useAppStore.subscribe(() => {
    if (!record.mutating && isActive(record) && !isFresh(record)) {
      record.invalidated = true;
      controller.abort();
      emit(record, { state: 'cancelling' });
    }
  });
  const onAbort = () => { controller.abort(); emit(record, { state: 'cancelling' }); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  record.detachSignal = () => options.signal?.removeEventListener('abort', onAbort);
  useAppStore.getState().updateNodeDataTransient(node.id, {
    error: undefined, ...(request.operation === 'open-editor' ? { directorStatus: 'open' as const } : {}),
  });
  emit(record, {});
  void runOperation(record, { ...request }, owner.source === 'ui' && options.allowSetup === true);
  return started;
}

export function resetDirectorNodeOperationsForTests(): void {
  for (const record of operations.values()) {
    record.unsubscribe?.();
    record.detachSignal?.();
    record.invalidated = true;
    record.disposed = true;
    record.controller.abort();
    completeCanvasDerivation(record.guard);
  }
  operations.clear();
  listeners.clear();
}
