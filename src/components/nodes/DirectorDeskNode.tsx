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
  useSyncExternalStore,
  type ChangeEvent,
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
import { saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';
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

const DEFAULT_W = 320;
const DEFAULT_H = 240;

function formatBlenderJobStatus(status: DirectorOperationSnapshot): string {
  const phaseLabels: Record<string, string> = {
    preparing: '准备 Blender',
    'loading-scene': '载入场景',
    rendering: '渲染',
    saving: '保存结果',
    finalizing: '校验结果',
  };
  if (status.state === 'cancelling') return '正在取消 Blender…';
  const phase = status.progress?.phase
    ? (phaseLabels[status.progress.phase] ?? '执行 Blender')
    : status.state === 'preparing'
      ? '启动 Blender'
      : status.state === 'collecting'
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
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const showToast = useAppStore((s) => s.showToast);
  const theme = useAppStore((s) => s.config.theme);
  const { displayLabel, handleRename } = useNodeRename(id, data, '3D 导演台');

  const [ready, setReady] = useState(false);
  const [localBusy, setBusy] = useState<string | null>(null);
  const activeBlenderOperation = useSyncExternalStore(
    subscribeDirectorNodeOperations,
    useCallback(() => getActiveDirectorNodeOperation(id), [id]),
    () => undefined,
  );
  const busy = localBusy || (activeBlenderOperation ? formatBlenderJobStatus(activeBlenderOperation) : null);
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
      showToast(error instanceof Error ? error.message : 'Blender 操作失败', 'error');
    }
  }, [id, showToast]);

  const cancelActiveBlenderOperation = useCallback(() => {
    const operation = getActiveDirectorNodeOperation(id);
    const projectId = useAppStore.getState().currentProjectId;
    if (!operation || !projectId) return;
    cancelDirectorOperation(operation.operationId, { source: 'ui', projectId });
  }, [id]);

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
    if (runtimeKind === 'blender') {
      await runBlenderOperation('open-editor');
      return;
    }
    setReady(false);
    updateNodeDataTransient(id, { directorStatus: 'open' });
    try {
      const availability = await getDirectorRuntimeAvailability(data.directorRuntimeKind);
      if (availability.state === 'setup-required') {
        updateNodeDataTransient(id, { directorStatus: 'idle', error: undefined });
        useAppStore.getState().requestDirectorDeskRuntime(instanceId, true);
        return;
      }
      if (availability.state === 'unavailable') throw new Error(availability.reason);
      await openDirectorRuntime('lightweight-web', { instanceId, theme: deskTheme });
    } catch (error) {
      if (isAbortError(error)) {
        updateNodeDataTransient(id, { directorStatus: captureUrls.length ? 'ready' : 'idle', error: undefined });
        return;
      }
      const message = error instanceof Error ? error.message : '打开 3D 导演台失败';
      setReady(false);
      updateNodeDataTransient(id, { directorStatus: 'idle', error: message });
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  }, [busy, captureUrls.length, data.directorRuntimeKind, deskTheme, id, instanceId, runBlenderOperation, runtimeKind, showToast, updateNodeDataTransient]);

  const handleExportFrame = useCallback(async () => {
    if (busy) return;
    if (runtimeKind === 'blender') {
      await runBlenderOperation('render-frame');
      return;
    }
    if (!ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出当前帧…');
    try {
      const result = await exportDirectorRuntimeFrame(data.directorRuntimeKind, instanceId, {
        position: 'current', quality: '1080p',
        fileName: `${(data.label as string) || 'director'}-frame.png`,
      });
      await persistCaptures([result]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出帧失败';
      showToast(message, 'error');
      updateNodeDataTransient(id, { error: message });
    } finally {
      setBusy(null);
    }
  }, [busy, data.directorRuntimeKind, data.label, id, instanceId, persistCaptures, ready, runBlenderOperation, runtimeKind, showToast, updateNodeDataTransient]);

  const handleExportVideo = useCallback(async () => {
    if (busy || videoExportPendingRef.current) return;
    if (runtimeKind === 'blender') {
      await runBlenderOperation('render-video');
      return;
    }
    if (!ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    videoExportPendingRef.current = true;
    setBusy('导出参考视频…');
    try {
      const result = await exportDirectorRuntimeVideo(data.directorRuntimeKind, instanceId, {
        quality: '720p', fps: 24,
        fileName: `${(data.label as string) || 'director'}-ref.mp4`,
      });
      let videoUrl = result.mediaUrl;
      let filePath = result.filePath;
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId && videoUrl.startsWith('data:')) {
        try {
          const saved = await saveDataUrlToProjectData(videoUrl, projectId,
            buildNodeFileName((data.label as string) || '导演台', 'mp4', 'director-ref'));
          if (saved?.assetUrl) videoUrl = saved.assetUrl;
          if (saved?.filePath) filePath = saved.filePath;
        } catch { /* 轻量导演台保留原有 data URL 回退。 */ }
      }
      const state = useAppStore.getState();
      const node = state.nodes.find((item) => item.id === id);
      if (!node || state.currentProjectId !== projectId) return;
      state.commitToHistory();
      state.updateNodeDataTransient(id, {
        videoUrl, filePath: filePath || node.data.filePath,
        status: 'success', directorStatus: 'ready', error: undefined,
      });
      state.incrementRevision();
      showToast('参考视频已写入节点；图生视频请优先使用同步的截图/帧');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出视频失败';
      showToast(message, 'error');
      updateNodeDataTransient(id, { error: message });
    } finally {
      videoExportPendingRef.current = false;
      setBusy(null);
    }
  }, [busy, data.directorRuntimeKind, data.label, id, instanceId, ready, runBlenderOperation, runtimeKind, showToast, updateNodeDataTransient]);

  const handleRuntimeChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextKind = event.target.value as DirectorRuntimeKind;
    const projectId = useAppStore.getState().currentProjectId;
    if (!projectId || nextKind === runtimeKind) return;
    try {
      setDirectorNodeRuntime(id, nextKind, { source: 'ui', projectId });
      setReady(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '切换运行时失败', 'error');
    }
  }, [id, runtimeKind, showToast]);

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
