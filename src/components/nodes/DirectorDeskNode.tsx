/**
 * DirectorDeskNode — 3D 导演台节点
 * 通过 Tauri 独立窗口打开 Tenney95/3d-director-desk，截图/导出回写本节点。
 */
import { t, useT } from '../../i18n';
import Select from '../shared/Select';
import {
  memo,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Handle, Position } from '@xyflow/react';
import { Icon } from '@iconify/react';
import type {
  BaseNodeData,
  DirectorResultManifestReference,
  DirectorRuntimeKind,
} from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import { useNodeRename } from './shared/useNodeRename';
import { useAppStore } from '../../store/useAppStore';
import { saveDataUrlToProjectData, buildNodeFileName, isTauriEnv } from '../../services/fileService';
import { collectDirectorImageUrls } from '../../services/directorDeskService';
import {
  DIRECTOR_RUNTIME_OPTIONS,
  exportDirectorRuntimeFrame,
  exportDirectorRuntimeVideo,
  getDirectorRuntimeAvailability,
  openDirectorRuntime,
  resolveDirectorRuntime,
  subscribeDirectorRuntime,
  type DirectorRuntimeCapture,
} from '../../services/directorRuntimeRegistry';
import { normalizeDirectorResultManifestReference } from '../../services/directorSceneSchema';
import {
  cancelDirectorOperation,
  getActiveDirectorNodeOperation,
  setDirectorNodeRuntime,
  startDirectorNodeOperation,
  subscribeDirectorNodeOperations,
} from '../../services/directorNodeOperationService';
import type { DirectorNodeOperationRequest, DirectorOperationSnapshot } from '../../types/directorOperation';
import { loadDirectorPrevisScene, saveDirectorPrevisOutput, subscribeDirectorPrevisOpen } from '../../services/directorPrevisService';
import LazyLoadBoundary, { LazyLoadFallback } from '../shared/LazyLoadBoundary';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation, type CanvasDerivationGuard } from '../../services/canvasDerivationGuard';

const DirectorPrevisDialog = lazy(() => import('../director/DirectorPrevisDialog'));

const DEFAULT_W = 320;
const DEFAULT_H = 240;

// 多个导演节点一起载入时，逐个截图并释放 WebGL，避免互相打断 revision 守卫。
let previsCaptureQueue = Promise.resolve();

function formatBlenderJobStatus(status: DirectorOperationSnapshot): string {
  const phaseLabels: Record<string, string> = {
    preparing: '准备 Blender',
    'loading-scene': '载入场景',
    rendering: '渲染',
    saving: '保存结果',
    finalizing: '校验结果',
  };
  if (status.state === 'cancelling') return t('正在取消 Blender…');
  const phase = status.progress?.phase
    ? (phaseLabels[status.progress.phase] ?? '执行 Blender')
    : status.state === 'preparing'
      ? '启动 Blender'
      : status.state === 'collecting'
        ? '回收结果'
        : '执行 Blender';
  if (!status.progress || status.progress.total <= 0) return `${t(phase)}…`;
  const percent = Math.min(100, Math.round(
    (status.progress.completed / status.progress.total) * 100,
  ));
  return `${t(phase)} ${percent}%`;
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
  useT();
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const showToast = useAppStore((s) => s.showToast);
  const theme = useAppStore((s) => s.config.theme);
  const { displayLabel, handleRename } = useNodeRename(id, data, t('3D 导演台'));

  const [ready, setReady] = useState(false);
  const [localBusy, setBusy] = useState<string | null>(null);
  const [previsOpen, setPrevisOpen] = useState(false);
  const [previsAction, setPrevisAction] = useState<'editor' | 'frame' | 'video'>('editor');
  const activeBlenderOperation = useSyncExternalStore(
    subscribeDirectorNodeOperations,
    useCallback(() => getActiveDirectorNodeOperation(id), [id]),
    () => undefined,
  );
  const busy = (localBusy ? t(localBusy) : null) || (activeBlenderOperation ? formatBlenderJobStatus(activeBlenderOperation) : null);
  const videoExportPendingRef = useRef(false);

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
  const projectId = useAppStore((s) => s.currentProjectId);
  const previsReference = data.directorPrevisScene;
  const capturedPrevis = useRef(captureUrls.length ? previsReference?.sha256 : undefined);
  const lastPrevisImage = useRef(data.imageUrl);
  const captureBinding = useRef({ projectId, instanceId });

  useEffect(() => {
    if (captureBinding.current.projectId !== projectId || captureBinding.current.instanceId !== instanceId) {
      captureBinding.current = { projectId, instanceId };
      capturedPrevis.current = data.imageUrl ? previsReference?.sha256 : undefined;
      lastPrevisImage.current = data.imageUrl;
    }
    // 面板里手动同步过的当前帧已经是最新输出，不再用起始帧覆盖它。
    if (data.imageUrl && data.imageUrl !== lastPrevisImage.current) {
      capturedPrevis.current = previsReference?.sha256;
    }
    lastPrevisImage.current = data.imageUrl;
    if (runtimeKind !== 'ai-threejs' || !projectId || !previsReference || !isTauriEnv()
      || previsOpen || data.status === 'loading' || capturedPrevis.current === previsReference.sha256) return;
    const controller = new AbortController();
    previsCaptureQueue = previsCaptureQueue.then(async () => {
      if (controller.signal.aborted) return;
      const state = useAppStore.getState();
      const current = state.nodes.find((node) => node.id === id)?.data;
      if (state.currentProjectId !== projectId || current?.directorInstanceId !== instanceId
        || current?.directorRuntimeKind !== 'ai-threejs' || current.status === 'loading'
        || current?.directorPrevisScene?.sha256 !== previsReference.sha256) return;
      setBusy('同步预演截图…');
      try {
        await saveDirectorPrevisOutput(id, 'image', async (signal) => {
          const scene = await loadDirectorPrevisScene(projectId, previsReference);
          signal.throwIfAborted();
          const { createDirectorPrevisRenderer } = await import('../../services/directorPrevisRenderer');
          signal.throwIfAborted();
          const mount = document.createElement('div');
          mount.className = 'fixed invisible pointer-events-none h-48 w-80';
          document.body.appendChild(mount);
          let renderer: ReturnType<typeof createDirectorPrevisRenderer> | undefined;
          try {
            renderer = createDirectorPrevisRenderer(mount, scene);
            // 未打开面板时，播放位置从零开始；只截摄影机画面。
            return renderer.capture(0);
          } finally {
            renderer?.dispose();
            mount.remove();
          }
        }, controller.signal);
        capturedPrevis.current = previsReference.sha256;
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) {
          showToast(t('预演自动截图失败，可点击“同步当前帧”重试'), 'error');
        }
      } finally {
        if (!controller.signal.aborted) setBusy(null);
      }
    });
    return () => { controller.abort(); setBusy(null); };
  }, [data.imageUrl, data.status, id, instanceId, previsOpen, previsReference, projectId, runtimeKind, showToast]);

  useEffect(() => {
    if (runtimeKind !== 'ai-threejs') return;
    const unsubscribe = subscribeDirectorPrevisOpen(instanceId, () => {
      setPrevisAction('editor'); setPrevisOpen(true);
    });
    return () => { unsubscribe(); setPrevisOpen(false); };
  }, [instanceId, runtimeKind]);
  const closePrevis = useCallback(() => setPrevisOpen(false), []);

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

  const runBlenderOperation = useCallback(async (operation: DirectorNodeOperationRequest['operation']) => {
    if (getActiveDirectorNodeOperation(id)) return;
    const projectId = useAppStore.getState().currentProjectId;
    if (!projectId) return;
    try {
      await startDirectorNodeOperation({ nodeId: id, operation }, { source: 'ui', projectId }, { allowSetup: true });
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Blender 操作失败'), 'error');
    }
  }, [id, showToast]);

  const cancelActiveBlenderOperation = useCallback(() => {
    const operation = getActiveDirectorNodeOperation(id);
    const projectId = useAppStore.getState().currentProjectId;
    if (!operation || !projectId) return;
    cancelDirectorOperation(operation.operationId, { source: 'ui', projectId });
  }, [id]);

  const persistCaptures = useCallback(
    async (captures: DirectorRuntimeCapture[], operationGuard?: CanvasDerivationGuard) => {
      if (!captures.length) return;
      const initialState = useAppStore.getState();
      const projectId = initialState.currentProjectId;
      const initialNode = initialState.nodes.find((node) => node.id === id);
      const initialData = initialNode?.data as BaseNodeData | undefined;
      if (!initialData) return;
      const guard = operationGuard ?? registerCanvasDerivation(initialState, id);
      if (!guard) return;
      const assertFresh = () => {
        const state = useAppStore.getState();
        const current = state.nodes.find((node) => node.id === id)?.data;
        if (!isCanvasDerivationFresh(guard, state) || (current?.directorInstanceId || id) !== instanceId
          || current?.directorRuntimeKind !== initialData.directorRuntimeKind) throw new Error('导演台目标画布已变化');
      };
      try {
        assertFresh();
        const nextUrls: string[] = Array.isArray(initialData.directorCaptureUrls)
          ? [...(initialData.directorCaptureUrls as string[])]
          : [];
        const nextPaths: string[] = Array.isArray(initialData.directorCaptureFilePaths)
          ? [...(initialData.directorCaptureFilePaths as string[])]
          : [];

        let added = 0;
        let latestManifestReference: DirectorResultManifestReference | undefined;
        for (const capture of captures) {
          assertFresh();
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
              assertFresh();
              if (saved?.assetUrl) imageUrl = saved.assetUrl;
              if (saved?.filePath) filePath = saved.filePath;
            } catch (err) {
              assertFresh();
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
          showToast(t('未收到有效截图'), 'error');
          return;
        }

        const latest = nextUrls[nextUrls.length - 1];
        const latestPath = nextPaths[nextPaths.length - 1];
        const liveState = useAppStore.getState();
        assertFresh();
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
        showToast(t('已同步 {count} 张导演台截图到节点', { count: added }));
      } finally { completeCanvasDerivation(guard); }
    },
    [id, instanceId, showToast],
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
        void persistCaptures(event.captures).catch(() => {});
      }
    });
  }, [captureUrls.length, data.directorRuntimeKind, id, instanceId, persistCaptures, updateNodeDataTransient]);

  const handleOpen = useCallback(async () => {
    if (busy) return;
    if (runtimeKind === 'ai-threejs') {
      setPrevisAction('editor'); setPrevisOpen(true);
      return;
    }
    if (runtimeKind === 'blender') {
      await runBlenderOperation('open-editor');
      return;
    }
    setReady(false);
    const guard = registerCanvasDerivation(useAppStore.getState(), id);
    if (!guard) return;
    updateNodeDataTransient(id, { directorStatus: 'open' });
    try {
      const availability = await getDirectorRuntimeAvailability(data.directorRuntimeKind);
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
      if (availability.state === 'setup-required') {
        updateNodeDataTransient(id, { directorStatus: 'idle', error: undefined });
        useAppStore.getState().requestDirectorDeskRuntime(instanceId, true);
        return;
      }
      if (availability.state === 'unavailable') throw new Error(availability.reason);
      await openDirectorRuntime('lightweight-web', { instanceId, theme: deskTheme, expectedContext: guard.expectedContext });
    } catch (error) {
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
      if (isAbortError(error)) {
        updateNodeDataTransient(id, { directorStatus: captureUrls.length ? 'ready' : 'idle', error: undefined });
        return;
      }
      const message = error instanceof Error ? error.message : t('打开 3D 导演台失败');
      setReady(false);
      updateNodeDataTransient(id, { directorStatus: 'idle', error: message });
      showToast(message, 'error');
    } finally {
      completeCanvasDerivation(guard);
      setBusy(null);
    }
  }, [busy, captureUrls.length, data.directorRuntimeKind, deskTheme, id, instanceId, runBlenderOperation, runtimeKind, showToast, updateNodeDataTransient]);

  const handleExportFrame = useCallback(async () => {
    if (busy) return;
    if (runtimeKind === 'ai-threejs') {
      setPrevisAction('frame'); setPrevisOpen(true);
      return;
    }
    if (runtimeKind === 'blender') {
      await runBlenderOperation('render-frame');
      return;
    }
    if (!ready) {
      showToast(t('请先打开并等待导演台就绪'), 'error');
      return;
    }
    setBusy('导出当前帧…');
    const guard = registerCanvasDerivation(useAppStore.getState(), id);
    if (!guard) { setBusy(null); return; }
    try {
      const result = await exportDirectorRuntimeFrame(data.directorRuntimeKind, instanceId, {
        position: 'current', quality: '1080p',
        fileName: `${(data.label as string) || 'director'}-frame.png`,
      });
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
      await persistCaptures([result], guard);
    } catch (error) {
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
      const message = error instanceof Error ? error.message : t('导出帧失败');
      showToast(message, 'error');
      updateNodeDataTransient(id, { error: message });
    } finally {
      completeCanvasDerivation(guard);
      setBusy(null);
    }
  }, [busy, data.directorRuntimeKind, data.label, id, instanceId, persistCaptures, ready, runBlenderOperation, runtimeKind, showToast, updateNodeDataTransient]);

  const handleExportVideo = useCallback(async () => {
    if (busy || videoExportPendingRef.current) return;
    if (runtimeKind === 'ai-threejs') {
      setPrevisAction('video'); setPrevisOpen(true);
      return;
    }
    if (runtimeKind === 'blender') {
      await runBlenderOperation('render-video');
      return;
    }
    if (!ready) {
      showToast(t('请先打开并等待导演台就绪'), 'error');
      return;
    }
    videoExportPendingRef.current = true;
    setBusy('导出参考视频…');
    const guard = registerCanvasDerivation(useAppStore.getState(), id);
    if (!guard) { videoExportPendingRef.current = false; setBusy(null); return; }
    try {
      const result = await exportDirectorRuntimeVideo(data.directorRuntimeKind, instanceId, {
        quality: '720p', fps: 24,
        fileName: `${(data.label as string) || 'director'}-ref.mp4`,
      });
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
      let videoUrl = result.mediaUrl;
      let filePath = result.filePath;
      const projectId = guard.projectId;
      if (projectId && videoUrl.startsWith('data:')) {
        try {
          const saved = await saveDataUrlToProjectData(videoUrl, projectId,
            buildNodeFileName((data.label as string) || '导演台', 'mp4', 'director-ref'));
          if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
          if (saved?.assetUrl) videoUrl = saved.assetUrl;
          if (saved?.filePath) filePath = saved.filePath;
        } catch { /* 轻量导演台保留原有 data URL 回退。 */ }
      }
      const state = useAppStore.getState();
      if (!isCanvasDerivationFresh(guard, state)) return;
      const node = state.nodes.find((item) => item.id === id);
      if (!node || state.currentProjectId !== projectId) return;
      state.commitToHistory();
      state.updateNodeDataTransient(id, {
        videoUrl, filePath: filePath || node.data.filePath,
        status: 'success', directorStatus: 'ready', error: undefined,
      });
      state.incrementRevision();
      showToast(t('参考视频已写入节点；图生视频请优先使用同步的截图/帧'));
    } catch (error) {
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
      const message = error instanceof Error ? error.message : t('导出视频失败');
      showToast(message, 'error');
      updateNodeDataTransient(id, { error: message });
    } finally {
      completeCanvasDerivation(guard);
      videoExportPendingRef.current = false;
      setBusy(null);
    }
  }, [busy, data.directorRuntimeKind, data.label, id, instanceId, ready, runBlenderOperation, runtimeKind, showToast, updateNodeDataTransient]);

  const handleRuntimeChange = useCallback((value: string) => {
    const nextKind = value as DirectorRuntimeKind;
    const projectId = useAppStore.getState().currentProjectId;
    if (!projectId || nextKind === runtimeKind) return;
    try {
      setDirectorNodeRuntime(id, nextKind, { source: 'ui', projectId });
      setPrevisOpen(false);
      setReady(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('切换运行时失败'), 'error');
    }
  }, [id, runtimeKind, showToast]);

  const canOpenRuntime = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.open;
  const canExportFrame = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.exportFrame;
  const canExportVideo = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.exportVideo;
  const runtimeReadyForExport = runtimeKind === 'blender' || ready
    || (runtimeKind === 'ai-threejs' && !!data.directorPrevisScene);

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
              <Select fixedMenu
                value={runtimeKind ?? ''}
                onChange={handleRuntimeChange}
                disabled={!!busy}
                aria-label={t('3D 导演运行时')}
                data-tooltip={runtimeUnavailableReason ? t(runtimeUnavailableReason) : undefined}
                className="min-w-0 max-w-[180px]" size="sm"
              >
                {!runtimeResolution.supported && (
                  <option value="" disabled>{t('未知运行时')}</option>
                )}
                {DIRECTOR_RUNTIME_OPTIONS.map((option) => (
                  <option
                    key={option.kind}
                    value={option.kind}
                    disabled={!option.selectable && runtimeKind !== option.kind}
                  >
                    {t(option.label)}
                  </option>
                ))}
              </Select>
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
                <span>{runtimeDescriptor ? t(runtimeDescriptor.label) : t('未知运行时')}</span>
                <span className="text-node-edit-hint">
                  {runtimeUnavailableReason ? t(runtimeUnavailableReason) : t('双击打开 · 同步截图后连线生视频')}
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
              data-tooltip={runtimeUnavailableReason ? t(runtimeUnavailableReason) : undefined}
            >
              {busy && runtimeKind === 'blender'
                ? t('取消任务')
                : canOpenRuntime
                  ? runtimeKind === 'blender'
                    ? t('打开 Blender')
                    : runtimeKind === 'ai-threejs'
                      ? t('打开镜头预演')
                    : ready
                      ? t('聚焦导演台')
                      : t('打开导演台')
                  : t('运行时不可用')}
            </button>
            <button
              type="button"
              className="director-node-btn grid h-7 w-7 place-items-center p-0"
              disabled={!runtimeReadyForExport || !canExportFrame || !!busy}
              onClick={() => { void handleExportFrame(); }}
              aria-label={t('同步当前帧')}
              data-tooltip={t('同步当前帧')}
            >
              <Icon icon="lucide:scan-line" width={14} height={14} />
            </button>
            <button
              type="button"
              className="director-node-btn grid h-7 w-7 place-items-center p-0"
              disabled={!runtimeReadyForExport || !canExportVideo || !!busy}
              onClick={() => { void handleExportVideo(); }}
              aria-label={t('导出参考视频')}
              data-tooltip={t('导出参考视频')}
            >
              <Icon icon="lucide:video" width={14} height={14} />
            </button>
            <span className="director-node-meta">
              {busy
                || (runtimeUnavailableReason ? t(runtimeUnavailableReason) : null)
                || (captureUrls.length > 0 ? t('{count} 张参考图', { count: captureUrls.length }) : t('未同步截图'))}
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

      {previsOpen && runtimeKind === 'ai-threejs' && (
        <LazyLoadBoundary label={t('AI 镜头预演')} resetKey={instanceId}>
          <Suspense fallback={<LazyLoadFallback label={t('AI 镜头预演')} />}>
            <DirectorPrevisDialog nodeId={id} initialAction={previsAction} onClose={closePrevis} />
          </Suspense>
        </LazyLoadBoundary>
      )}
    </>
  );
}

export default memo(DirectorDeskNode);
