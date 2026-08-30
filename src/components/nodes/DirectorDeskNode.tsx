/**
 * DirectorDeskNode — 3D 导演台节点
 * 通过 Tauri 独立窗口打开 Tenney95/3d-director-desk，截图/导出回写本节点。
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { Handle, Position } from '@xyflow/react';
import { Icon } from '@iconify/react';
import type {
  BaseNodeData,
  DirectorResultManifestReference,
  DirectorRuntimeKind,
  DirectorScene,
  DirectorSceneReference,
} from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import { useNodeRename } from './shared/useNodeRename';
import { useAppStore } from '../../store/useAppStore';
import { saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';
import { collectDirectorImageUrls } from '../../services/directorDeskService';
import {
  DIRECTOR_RUNTIME_OPTIONS,
  exportDirectorRuntimeFrame,
  exportDirectorRuntimeVideo,
  getDirectorRuntimeAvailability,
  openDirectorRuntime,
  prepareDirectorRuntime,
  resolveDirectorRuntime,
  subscribeDirectorRuntime,
  type DirectorRuntimeBlenderContext,
  type DirectorRuntimeCapture,
} from '../../services/directorRuntimeRegistry';
import {
  createDefaultDirectorScene,
  type DirectorBlenderJobStatus,
} from '../../services/directorBlenderRuntimeService';
import { loadDirectorScene, saveDirectorScene } from '../../services/directorSceneService';
import {
  normalizeDirectorResultManifestReference,
  normalizeDirectorSceneReference,
} from '../../services/directorSceneSchema';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from '../../services/canvasDerivationGuard';

const DEFAULT_W = 320;
const DEFAULT_H = 240;

interface PreparedBlenderNodeOperation {
  projectId: string;
  instanceId: string;
  scene: DirectorScene;
  sceneReference: DirectorSceneReference;
  previousManifestReference?: DirectorResultManifestReference;
  controller: AbortController;
  guard: CanvasDerivationGuard;
}

function sceneReferencesEqual(left: unknown, right: DirectorSceneReference): boolean {
  try {
    const normalized = normalizeDirectorSceneReference(left);
    return normalized.schemaVersion === right.schemaVersion
      && normalized.sceneId === right.sceneId
      && normalized.revision === right.revision
      && normalized.relativePath === right.relativePath
      && normalized.sha256 === right.sha256
      && normalized.bytes === right.bytes;
  } catch {
    return false;
  }
}

function manifestReferencesEqual(
  left: unknown,
  right: DirectorResultManifestReference | undefined,
): boolean {
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  try {
    const normalized = normalizeDirectorResultManifestReference(left);
    return normalized.schemaVersion === right.schemaVersion
      && normalized.sceneId === right.sceneId
      && normalized.sceneRevision === right.sceneRevision
      && normalized.sceneSha256 === right.sceneSha256
      && normalized.manifestRevision === right.manifestRevision
      && normalized.relativePath === right.relativePath
      && normalized.sha256 === right.sha256
      && normalized.bytes === right.bytes;
  } catch {
    return false;
  }
}

function formatBlenderJobStatus(status: DirectorBlenderJobStatus): string {
  const phaseLabels: Record<string, string> = {
    preparing: '准备 Blender',
    'loading-scene': '载入场景',
    rendering: '渲染',
    saving: '保存结果',
    finalizing: '校验结果',
  };
  const phase = status.progress?.phase
    ? (phaseLabels[status.progress.phase] ?? '执行 Blender')
    : status.state === 'starting'
      ? '启动 Blender'
      : status.state === 'awaiting-collection' || status.state === 'collecting'
        ? '回收结果'
        : '执行 Blender';
  if (!status.progress || status.progress.total <= 0) return `${phase}…`;
  const percent = Math.min(100, Math.round(
    (status.progress.completed / status.progress.total) * 100,
  ));
  return `${phase} ${percent}%`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function DirectorDeskNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: BaseNodeData;
  selected?: boolean;
}) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const showToast = useAppStore((s) => s.showToast);
  const theme = useAppStore((s) => s.config.theme);
  const { displayLabel, handleRename } = useNodeRename(id, data, '3D 导演台');

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const instanceId = useMemo(
    () => (typeof data.directorInstanceId === 'string' && data.directorInstanceId) || id,
    [data.directorInstanceId, id],
  );
  const runtimeResolution = useMemo(
    () => resolveDirectorRuntime(data.directorRuntimeKind),
    [data.directorRuntimeKind],
  );
  const runtimeKind = runtimeResolution.supported ? runtimeResolution.kind : null;
  const runtimeDescriptor = runtimeResolution.supported
    ? runtimeResolution.descriptor
    : null;
  const runtimeUnavailableReason = runtimeResolution.supported
    ? runtimeResolution.descriptor.unavailableReason
    : runtimeResolution.reason;

  const captureUrls = useMemo(
    () => collectDirectorImageUrls(data),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.imageUrl, data.directorCaptureUrls],
  );
  const visibleCaptureUrls = useMemo(() => {
    const latest = typeof data.imageUrl === 'string' ? data.imageUrl.trim() : '';
    const ordered = latest
      ? [...captureUrls.filter((url) => url !== latest), latest]
      : captureUrls;
    return ordered.slice(-4);
  }, [captureUrls, data.imageUrl]);

  const width = (data.nodeWidth as number) || DEFAULT_W;
  const height = (data.nodeHeight as number) || DEFAULT_H;
  const deskTheme: 'dark' | 'light' = theme === 'light' ? 'light' : 'dark';

  useEffect(() => {
    if (data.directorInstanceId === instanceId) return;
    updateNodeDataTransient(id, { directorInstanceId: instanceId });
  }, [data.directorInstanceId, id, instanceId, updateNodeDataTransient]);

  const handleResize = useCallback(
    (w: number, h: number) => {
      updateNodeDataTransient(id, { nodeWidth: w, nodeHeight: h });
    },
    [id, updateNodeDataTransient],
  );

  const ensureBlenderScene = useCallback(async (): Promise<{
    projectId: string;
    instanceId: string;
    scene: DirectorScene;
    reference: DirectorSceneReference;
  }> => {
    const initialState = useAppStore.getState();
    const projectId = initialState.currentProjectId;
    const initialNode = initialState.nodes.find((node) => node.id === id && node.type === 'ai-director');
    if (!projectId || !initialNode) throw new Error('当前 3D 导演台不属于有效项目');

    const initialData = initialNode.data as BaseNodeData;
    const initialRuntime = resolveDirectorRuntime(initialData.directorRuntimeKind);
    if (!initialRuntime.supported || initialRuntime.kind !== 'blender') {
      throw new Error('当前节点已不再使用 Blender 运行时');
    }
    const liveInstanceId = (
      typeof initialData.directorInstanceId === 'string' && initialData.directorInstanceId
    ) || id;

    if (initialData.directorScene !== undefined) {
      const reference = normalizeDirectorSceneReference(initialData.directorScene);
      const scene = await loadDirectorScene(projectId, reference);
      const checkedState = useAppStore.getState();
      const checkedNode = checkedState.nodes.find((node) => node.id === id && node.type === 'ai-director');
      const checkedData = checkedNode?.data as BaseNodeData | undefined;
      const checkedRuntime = resolveDirectorRuntime(checkedData?.directorRuntimeKind);
      const checkedInstanceId = (
        typeof checkedData?.directorInstanceId === 'string' && checkedData.directorInstanceId
      ) || id;
      if (
        checkedState.currentProjectId !== projectId
        || !checkedData
        || !checkedRuntime.supported
        || checkedRuntime.kind !== 'blender'
        || checkedInstanceId !== liveInstanceId
        || !sceneReferencesEqual(checkedData.directorScene, reference)
      ) {
        throw new Error('读取场景期间画布状态已变化');
      }
      return { projectId, instanceId: liveInstanceId, scene, reference };
    }

    const saved = await saveDirectorScene(
      projectId,
      createDefaultDirectorScene(liveInstanceId),
    );
    const checkedState = useAppStore.getState();
    const checkedNode = checkedState.nodes.find((node) => node.id === id && node.type === 'ai-director');
    const checkedData = checkedNode?.data as BaseNodeData | undefined;
    const checkedRuntime = resolveDirectorRuntime(checkedData?.directorRuntimeKind);
    const checkedInstanceId = (
      typeof checkedData?.directorInstanceId === 'string' && checkedData.directorInstanceId
    ) || id;
    if (
      checkedState.currentProjectId !== projectId
      || !checkedData
      || !checkedRuntime.supported
      || checkedRuntime.kind !== 'blender'
      || checkedInstanceId !== liveInstanceId
    ) {
      throw new Error('创建场景期间画布状态已变化');
    }

    if (checkedData.directorScene !== undefined) {
      const adoptedReference = normalizeDirectorSceneReference(checkedData.directorScene);
      const adoptedScene = await loadDirectorScene(projectId, adoptedReference);
      return {
        projectId,
        instanceId: liveInstanceId,
        scene: adoptedScene,
        reference: adoptedReference,
      };
    }

    checkedState.updateNodeData(id, {
      directorScene: saved.reference,
      error: undefined,
    });
    checkedState.incrementRevision();
    return {
      projectId,
      instanceId: liveInstanceId,
      scene: saved.scene,
      reference: saved.reference,
    };
  }, [id]);

  const prepareBlenderNodeOperation = useCallback(async (): Promise<PreparedBlenderNodeOperation> => {
    if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
      throw new Error('已有 Blender 任务正在执行');
    }
    const sceneBundle = await ensureBlenderScene();
    const state = useAppStore.getState();
    const node = state.nodes.find((item) => item.id === id && item.type === 'ai-director');
    const nodeData = node?.data as BaseNodeData | undefined;
    if (!nodeData) throw new Error('3D 导演台节点已不存在');
    const previousManifestReference = nodeData.directorResultManifest === undefined
      ? undefined
      : normalizeDirectorResultManifestReference(nodeData.directorResultManifest);
    const controller = new AbortController();
    const guard = registerCanvasDerivation(state, id, {
      onCancel: () => controller.abort(),
    });
    if (!guard) throw new Error('无法为当前画布创建 Blender 任务');
    abortControllerRef.current = controller;
    return {
      projectId: sceneBundle.projectId,
      instanceId: sceneBundle.instanceId,
      scene: sceneBundle.scene,
      sceneReference: sceneBundle.reference,
      previousManifestReference,
      controller,
      guard,
    };
  }, [ensureBlenderScene, id]);

  const isBlenderOperationFresh = useCallback((operation: PreparedBlenderNodeOperation): boolean => {
    const state = useAppStore.getState();
    if (!isCanvasDerivationFresh(operation.guard, state)) return false;
    const node = state.nodes.find((item) => item.id === id && item.type === 'ai-director');
    const nodeData = node?.data as BaseNodeData | undefined;
    if (!nodeData || state.currentProjectId !== operation.projectId) return false;
    const currentRuntime = resolveDirectorRuntime(nodeData.directorRuntimeKind);
    const currentInstanceId = (
      typeof nodeData.directorInstanceId === 'string' && nodeData.directorInstanceId
    ) || id;
    return currentRuntime.supported
      && currentRuntime.kind === 'blender'
      && currentInstanceId === operation.instanceId
      && sceneReferencesEqual(nodeData.directorScene, operation.sceneReference)
      && manifestReferencesEqual(
        nodeData.directorResultManifest,
        operation.previousManifestReference,
      );
  }, [id]);

  const finishBlenderNodeOperation = useCallback((operation: PreparedBlenderNodeOperation) => {
    completeCanvasDerivation(operation.guard);
    if (abortControllerRef.current === operation.controller) abortControllerRef.current = null;
  }, []);

  const cancelActiveBlenderOperation = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  useEffect(() => () => {
    abortControllerRef.current?.abort();
  }, []);

  const persistCaptures = useCallback(
    async (captures: DirectorRuntimeCapture[]) => {
      if (!captures.length) return;
      const initialState = useAppStore.getState();
      const projectId = initialState.currentProjectId;
      const initialNode = initialState.nodes.find((node) => node.id === id);
      const initialData = initialNode?.data as BaseNodeData | undefined;
      if (!initialData) return;
      const nextUrls: string[] = Array.isArray(initialData.directorCaptureUrls)
        ? [...(initialData.directorCaptureUrls as string[])]
        : [];
      const nextPaths: string[] = Array.isArray(initialData.directorCaptureFilePaths)
        ? [...(initialData.directorCaptureFilePaths as string[])]
        : [];

      let added = 0;
      let latestManifestReference: DirectorResultManifestReference | undefined;
      for (const capture of captures) {
        const dataUrl = capture.dataUrl?.trim();
        const nativeMediaUrl = capture.mediaUrl?.trim();
        let imageUrl: string;
        let filePath = capture.filePath?.trim() || undefined;
        if (dataUrl?.startsWith('data:image/')) {
          imageUrl = dataUrl;
        } else if (nativeMediaUrl && filePath) {
          imageUrl = nativeMediaUrl;
        } else {
          continue;
        }

        if (dataUrl?.startsWith('data:image/') && projectId) {
          try {
            const fileName = buildNodeFileName(
              (initialData.label as string) || '导演台',
              'png',
              'director',
            );
            const saved = await saveDataUrlToProjectData(dataUrl, projectId, fileName);
            if (saved?.assetUrl) imageUrl = saved.assetUrl;
            if (saved?.filePath) filePath = saved.filePath;
          } catch (err) {
            console.warn('[DirectorDeskNode] 截图落盘失败，使用 data URL', err);
          }
        }

        nextUrls.push(imageUrl);
        if (filePath) nextPaths.push(filePath);
        if (capture.manifestReference) {
          latestManifestReference = normalizeDirectorResultManifestReference(
            capture.manifestReference,
          );
        }
        added += 1;
      }

      if (added === 0) {
        showToast('未收到有效截图', 'error');
        return;
      }

      const latest = nextUrls[nextUrls.length - 1];
      const latestPath = nextPaths[nextPaths.length - 1];
      const liveState = useAppStore.getState();
      if (liveState.currentProjectId !== projectId || !liveState.nodes.some((node) => node.id === id)) {
        return;
      }
      liveState.updateNodeData(id, {
        directorCaptureUrls: nextUrls.slice(-12),
        directorCaptureFilePaths: nextPaths.slice(-12),
        imageUrl: latest,
        filePath: latestPath,
        thumbnailUrl: latest,
        ...(latestManifestReference
          ? { directorResultManifest: latestManifestReference }
          : {}),
        status: 'success',
        error: undefined,
        directorStatus: 'ready',
      });
      liveState.incrementRevision();
      showToast(`已同步 ${added} 张导演台截图到节点`);
    },
    [id, showToast],
  );

  useEffect(() => {
    return subscribeDirectorRuntime(data.directorRuntimeKind, instanceId, (event) => {
      if (event.type === 'ready') {
        setReady(true);
        updateNodeDataTransient(id, { directorStatus: 'ready', error: undefined });
        return;
      }

      if (event.type === 'closed') {
        setReady(false);
        updateNodeDataTransient(id, {
          directorStatus: captureUrls.length ? 'ready' : 'idle',
        });
        return;
      }

      if (event.type === 'captures') {
        void persistCaptures(event.captures);
      }
    });
  }, [captureUrls.length, data.directorRuntimeKind, id, instanceId, persistCaptures, updateNodeDataTransient]);

  const handleOpen = useCallback(async () => {
    if (busy) return;
    setReady(false);
    updateNodeDataTransient(id, { directorStatus: 'open' });
    let blenderOperation: PreparedBlenderNodeOperation | null = null;
    try {
      const availability = await getDirectorRuntimeAvailability(data.directorRuntimeKind);
      if (availability.state === 'setup-required') {
        if (runtimeKind === 'blender') {
          setBusy('选择 Blender…');
          await prepareDirectorRuntime('blender');
        } else {
          updateNodeDataTransient(id, { directorStatus: 'idle', error: undefined });
          useAppStore.getState().requestDirectorDeskRuntime(instanceId, true);
          return;
        }
      }
      if (availability.state === 'unavailable') throw new Error(availability.reason);

      if (runtimeKind === 'blender') {
        setBusy('准备 Blender 导演模式…');
        blenderOperation = await prepareBlenderNodeOperation();
        const blenderContext: DirectorRuntimeBlenderContext = {
          projectId: blenderOperation.projectId,
          sceneReference: blenderOperation.sceneReference,
          previousManifestReference: blenderOperation.previousManifestReference,
          signal: blenderOperation.controller.signal,
          onStatus: (status) => setBusy(formatBlenderJobStatus(status)),
        };
        const result = await openDirectorRuntime('blender', {
          instanceId: blenderOperation.instanceId,
          theme: deskTheme,
          blender: blenderContext,
        });
        if (!isBlenderOperationFresh(blenderOperation)) {
          showToast('Blender 已返回，但画布绑定已变化，结果未写回节点', 'error');
          return;
        }
        if (!result?.capture) throw new Error('Blender 保存返回未生成当前镜头图');
        await persistCaptures([result.capture]);
        showToast('Blender 高级编辑已保存并返回 3D 导演台');
        return;
      }

      await openDirectorRuntime('lightweight-web', { instanceId, theme: deskTheme });
    } catch (error) {
      if (isAbortError(error)) {
        updateNodeDataTransient(id, {
          directorStatus: captureUrls.length ? 'ready' : 'idle',
          error: undefined,
        });
        return;
      }
      const message = error instanceof Error ? error.message : '打开 3D 导演台失败';
      setReady(false);
      updateNodeDataTransient(id, { directorStatus: 'idle', error: message });
      showToast(message, 'error');
    } finally {
      if (blenderOperation) finishBlenderNodeOperation(blenderOperation);
      setBusy(null);
    }
  }, [
    busy,
    captureUrls.length,
    data.directorRuntimeKind,
    deskTheme,
    finishBlenderNodeOperation,
    id,
    instanceId,
    isBlenderOperationFresh,
    persistCaptures,
    prepareBlenderNodeOperation,
    runtimeKind,
    showToast,
    updateNodeDataTransient,
  ]);

  const handleExportFrame = useCallback(async () => {
    if (runtimeKind !== 'blender' && !ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出当前帧…');
    let blenderOperation: PreparedBlenderNodeOperation | null = null;
    try {
      let blenderContext: DirectorRuntimeBlenderContext | undefined;
      let targetFrame: number | undefined;
      let requestInstanceId = instanceId;
      if (runtimeKind === 'blender') {
        blenderOperation = await prepareBlenderNodeOperation();
        requestInstanceId = blenderOperation.instanceId;
        targetFrame = blenderOperation.scene.timeline.startFrame;
        blenderContext = {
          projectId: blenderOperation.projectId,
          sceneReference: blenderOperation.sceneReference,
          previousManifestReference: blenderOperation.previousManifestReference,
          signal: blenderOperation.controller.signal,
          onStatus: (status) => setBusy(formatBlenderJobStatus(status)),
        };
      }
      const result = await exportDirectorRuntimeFrame(
        runtimeKind ?? data.directorRuntimeKind,
        requestInstanceId,
        {
          position: 'current',
          quality: '1080p',
          fileName: `${(data.label as string) || 'director'}-frame.png`,
          ...(targetFrame !== undefined ? { targetFrame } : {}),
          ...(blenderContext ? { blender: blenderContext } : {}),
        },
      );
      if (blenderOperation && !isBlenderOperationFresh(blenderOperation)) {
        showToast('Blender 已返回，但画布绑定已变化，当前帧未写回节点', 'error');
        return;
      }
      await persistCaptures([result]);
    } catch (err) {
      if (isAbortError(err)) {
        showToast('已取消 Blender 任务');
        return;
      }
      showToast(err instanceof Error ? err.message : '导出帧失败', 'error');
      updateNodeDataTransient(id, {
        error: err instanceof Error ? err.message : '导出帧失败',
      });
    } finally {
      if (blenderOperation) finishBlenderNodeOperation(blenderOperation);
      setBusy(null);
    }
  }, [
    data.directorRuntimeKind,
    data.label,
    finishBlenderNodeOperation,
    id,
    instanceId,
    isBlenderOperationFresh,
    persistCaptures,
    prepareBlenderNodeOperation,
    ready,
    runtimeKind,
    showToast,
    updateNodeDataTransient,
  ]);

  const handleExportVideo = useCallback(async () => {
    if (runtimeKind !== 'blender' && !ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出参考视频…');
    let blenderOperation: PreparedBlenderNodeOperation | null = null;
    try {
      let blenderContext: DirectorRuntimeBlenderContext | undefined;
      let requestInstanceId = instanceId;
      if (runtimeKind === 'blender') {
        blenderOperation = await prepareBlenderNodeOperation();
        requestInstanceId = blenderOperation.instanceId;
        blenderContext = {
          projectId: blenderOperation.projectId,
          sceneReference: blenderOperation.sceneReference,
          previousManifestReference: blenderOperation.previousManifestReference,
          signal: blenderOperation.controller.signal,
          onStatus: (status) => setBusy(formatBlenderJobStatus(status)),
        };
      }
      const result = await exportDirectorRuntimeVideo(
        runtimeKind ?? data.directorRuntimeKind,
        requestInstanceId,
        {
          quality: '720p',
          fps: 24,
          fileName: `${(data.label as string) || 'director'}-ref.mp4`,
          ...(blenderContext ? { blender: blenderContext } : {}),
        },
      );
      if (blenderOperation && !isBlenderOperationFresh(blenderOperation)) {
        showToast('Blender 已返回，但画布绑定已变化，参考视频未写回节点', 'error');
        return;
      }

      const mediaUrl = result.mediaUrl;

      let videoUrl = mediaUrl;
      let filePath = result.filePath;
      const projectId = blenderOperation?.projectId ?? useAppStore.getState().currentProjectId;
      if (projectId && mediaUrl.startsWith('data:')) {
        try {
          const saved = await saveDataUrlToProjectData(
            mediaUrl,
            projectId,
            buildNodeFileName((data.label as string) || '导演台', 'mp4', 'director-ref'),
          );
          if (saved?.assetUrl) videoUrl = saved.assetUrl;
          if (saved?.filePath) filePath = saved.filePath;
        } catch {
          /* keep raw */
        }
      }

      const liveState = useAppStore.getState();
      const liveNode = liveState.nodes.find((node) => node.id === id);
      const liveData = liveNode?.data as BaseNodeData | undefined;
      if (!liveData || liveState.currentProjectId !== projectId) return;
      liveState.updateNodeData(id, {
        videoUrl,
        filePath: filePath || (liveData.filePath as string | undefined),
        ...(result.manifestReference
          ? { directorResultManifest: result.manifestReference }
          : {}),
        status: 'success',
        directorStatus: 'ready',
        error: undefined,
      });
      liveState.incrementRevision();
      showToast('参考视频已写入节点；图生视频请优先使用同步的截图/帧');
    } catch (err) {
      if (isAbortError(err)) {
        showToast('已取消 Blender 任务');
        return;
      }
      showToast(err instanceof Error ? err.message : '导出视频失败', 'error');
      updateNodeDataTransient(id, {
        error: err instanceof Error ? err.message : '导出视频失败',
      });
    } finally {
      if (blenderOperation) finishBlenderNodeOperation(blenderOperation);
      setBusy(null);
    }
  }, [
    data.directorRuntimeKind,
    data.label,
    finishBlenderNodeOperation,
    id,
    instanceId,
    isBlenderOperationFresh,
    prepareBlenderNodeOperation,
    ready,
    runtimeKind,
    showToast,
    updateNodeDataTransient,
  ]);

  const handleRuntimeChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextKind = event.target.value as DirectorRuntimeKind;
    if (nextKind === runtimeKind) return;
    cancelActiveBlenderOperation();
    setReady(false);
    updateNodeData(id, {
      directorRuntimeKind: nextKind,
      directorStatus: 'idle',
      error: undefined,
    });
    useAppStore.getState().incrementRevision();
  }, [cancelActiveBlenderOperation, id, runtimeKind, updateNodeData]);

  const canOpenRuntime = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.open;
  const canExportFrame = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.exportFrame;
  const canExportVideo = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.exportVideo;
  const runtimeReadyForExport = runtimeKind === 'blender' || ready;

  return (
    <>
      <div className="node-wrapper relative" style={{ width }}>
        <NodeLabel
          kind="ai-director"
          label={displayLabel}
          displayId={data.displayId as number | undefined}
          nodeId={id}
          onRename={handleRename}
        />

        <div
          className={`node director-node ${selected ? 'selected' : ''} ${data.status === 'loading' ? 'loading' : ''}`}
          style={{ width, height }}
          onDoubleClick={() => { void handleOpen(); }}
        >
          <div className="node-preview director-preview">
            <div className="nodrag nopan absolute left-2 top-2 z-10">
              <select
                value={runtimeKind ?? ''}
                onChange={handleRuntimeChange}
                disabled={!!busy}
                aria-label="3D 导演运行时"
                data-tooltip={runtimeUnavailableReason}
                className="h-7 max-w-[180px] rounded-md border border-canvas-border bg-canvas-surface/90 px-2 text-[11px] text-canvas-text shadow-sm outline-none focus:border-violet-400"
              >
                {!runtimeResolution.supported && (
                  <option value="" disabled>未知运行时</option>
                )}
                {DIRECTOR_RUNTIME_OPTIONS.map((option) => (
                  <option
                    key={option.kind}
                    value={option.kind}
                    disabled={!option.selectable && runtimeKind !== option.kind}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {captureUrls.length > 0 ? (
              <div
                className="director-capture-grid"
                data-capture-count={visibleCaptureUrls.length}
              >
                {visibleCaptureUrls.map((url, idx) => (
                  <img
                    key={`${idx}-${url.slice(0, 48)}`}
                    src={url}
                    alt=""
                    className="director-capture-thumb"
                    draggable={false}
                  />
                ))}
              </div>
            ) : (
              <div className="node-preview-placeholder">
                <Icon icon="mdi:video-3d" width={28} height={28} />
                <span>{runtimeDescriptor?.label ?? '未知运行时'}</span>
                <span className="text-node-edit-hint">
                  {runtimeUnavailableReason || '双击打开 · 同步截图后连线生视频'}
                </span>
              </div>
            )}

            {data.error && <NodeError nodeId={id} message={String(data.error)} />}
          </div>

          <div className="director-node-actions nodrag nopan">
            <button
              type="button"
              className="director-node-btn primary"
              disabled={!canOpenRuntime || (!!busy && runtimeKind !== 'blender')}
              onClick={() => {
                if (busy && runtimeKind === 'blender') cancelActiveBlenderOperation();
                else void handleOpen();
              }}
              data-tooltip={runtimeUnavailableReason}
            >
              {busy && runtimeKind === 'blender'
                ? '取消任务'
                : canOpenRuntime
                  ? runtimeKind === 'blender'
                    ? '打开 Blender'
                    : ready
                      ? '聚焦导演台'
                      : '打开导演台'
                  : '运行时不可用'}
            </button>
            <button
              type="button"
              className="director-node-btn grid h-7 w-7 place-items-center p-0"
              disabled={!runtimeReadyForExport || !canExportFrame || !!busy}
              onClick={() => { void handleExportFrame(); }}
              aria-label="同步当前帧"
              data-tooltip="同步当前帧"
            >
              <Icon icon="lucide:scan-line" width={14} height={14} />
            </button>
            <button
              type="button"
              className="director-node-btn grid h-7 w-7 place-items-center p-0"
              disabled={!runtimeReadyForExport || !canExportVideo || !!busy}
              onClick={() => { void handleExportVideo(); }}
              aria-label="导出参考视频"
              data-tooltip="导出参考视频"
            >
              <Icon icon="lucide:video" width={14} height={14} />
            </button>
            <span className="director-node-meta">
              {busy
                || runtimeUnavailableReason
                || (captureUrls.length > 0 ? `${captureUrls.length} 张参考图` : '未同步截图')}
            </span>
          </div>

          <Handle type="target" position={Position.Left} id="left" className="node-handle handle-target handle-director">
            <GooeyBtn className="gooey-btn-left" hue={280} />
          </Handle>
          <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-director">
            <GooeyBtn className="gooey-btn-right" hue={280} />
          </Handle>
        </div>

        <ResizeHandle
          nodeId={id}
          currentWidth={width}
          currentHeight={height}
          minWidth={260}
          minHeight={180}
          onResizeStart={commitToHistory}
          onResizeEnd={commitToHistory}
          onResize={handleResize}
        />
      </div>

    </>
  );
}

export default memo(DirectorDeskNode);
