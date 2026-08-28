/**
 * DirectorDeskNode — 3D 导演台节点
 * 通过 Tauri 独立窗口打开 Tenney95/3d-director-desk，截图/导出回写本节点。
 */
import { memo, useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Icon } from '@iconify/react';
import type { BaseNodeData, DirectorRuntimeKind } from '../../types';
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

const DEFAULT_W = 320;
const DEFAULT_H = 240;

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
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const showToast = useAppStore((s) => s.showToast);
  const theme = useAppStore((s) => s.config.theme);
  const { displayLabel, handleRename } = useNodeRename(id, data, '3D 导演台');

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

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

  const persistCaptures = useCallback(
    async (captures: DirectorRuntimeCapture[]) => {
      if (!captures.length) return;
      const projectId = currentProjectId;
      const nextUrls: string[] = Array.isArray(data.directorCaptureUrls)
        ? [...(data.directorCaptureUrls as string[])]
        : [];
      const nextPaths: string[] = Array.isArray(data.directorCaptureFilePaths)
        ? [...(data.directorCaptureFilePaths as string[])]
        : [];

      let added = 0;
      for (const capture of captures) {
        const dataUrl = capture.dataUrl?.trim();
        if (!dataUrl?.startsWith('data:image/')) continue;

        let imageUrl = dataUrl;
        let filePath: string | undefined;
        if (projectId) {
          try {
            const fileName = buildNodeFileName((data.label as string) || '导演台', 'png', 'director');
            const saved = await saveDataUrlToProjectData(dataUrl, projectId, fileName);
            if (saved?.assetUrl) imageUrl = saved.assetUrl;
            if (saved?.filePath) filePath = saved.filePath;
          } catch (err) {
            console.warn('[DirectorDeskNode] 截图落盘失败，使用 data URL', err);
          }
        }

        nextUrls.push(imageUrl);
        if (filePath) nextPaths.push(filePath);
        added += 1;
      }

      if (added === 0) {
        showToast('未收到有效截图', 'error');
        return;
      }

      const latest = nextUrls[nextUrls.length - 1];
      const latestPath = nextPaths[nextPaths.length - 1];
      updateNodeData(id, {
        directorCaptureUrls: nextUrls.slice(-12),
        directorCaptureFilePaths: nextPaths.slice(-12),
        imageUrl: latest,
        filePath: latestPath,
        thumbnailUrl: latest,
        status: 'success',
        error: undefined,
        directorStatus: 'ready',
      });
      showToast(`已同步 ${added} 张导演台截图到节点`);
    },
    [currentProjectId, data.directorCaptureFilePaths, data.directorCaptureUrls, data.label, id, showToast, updateNodeData],
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
      await openDirectorRuntime(data.directorRuntimeKind, { instanceId, theme: deskTheme });
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开 3D 导演台失败';
      setReady(false);
      updateNodeDataTransient(id, { directorStatus: 'idle', error: message });
      showToast(message, 'error');
    }
  }, [data.directorRuntimeKind, deskTheme, id, instanceId, showToast, updateNodeDataTransient]);

  const handleExportFrame = useCallback(async () => {
    if (!ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出当前帧…');
    try {
      const result = await exportDirectorRuntimeFrame(data.directorRuntimeKind, instanceId, {
        position: 'current',
        quality: '1080p',
        fileName: `${(data.label as string) || 'director'}-frame.png`,
      });
      await persistCaptures([result]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出帧失败', 'error');
    } finally {
      setBusy(null);
    }
  }, [data.directorRuntimeKind, data.label, instanceId, persistCaptures, ready, showToast]);

  const handleExportVideo = useCallback(async () => {
    if (!ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出参考视频…');
    try {
      const result = await exportDirectorRuntimeVideo(
        data.directorRuntimeKind,
        instanceId,
        {
          quality: '720p',
          fps: 24,
          fileName: `${(data.label as string) || 'director'}-ref.mp4`,
        },
      );

      const mediaUrl = result.mediaUrl;

      let videoUrl = mediaUrl;
      let filePath: string | undefined;
      if (currentProjectId && mediaUrl.startsWith('data:')) {
        try {
          const saved = await saveDataUrlToProjectData(
            mediaUrl,
            currentProjectId,
            buildNodeFileName((data.label as string) || '导演台', 'mp4', 'director-ref'),
          );
          if (saved?.assetUrl) videoUrl = saved.assetUrl;
          if (saved?.filePath) filePath = saved.filePath;
        } catch {
          /* keep raw */
        }
      }

      updateNodeData(id, {
        videoUrl,
        filePath: filePath || (data.filePath as string | undefined),
        status: 'success',
        directorStatus: 'ready',
        error: undefined,
      });
      showToast('参考视频已写入节点；图生视频请优先使用同步的截图/帧');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出视频失败', 'error');
    } finally {
      setBusy(null);
    }
  }, [currentProjectId, data.directorRuntimeKind, data.filePath, data.label, id, instanceId, ready, showToast, updateNodeData]);

  const handleRuntimeChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextKind = event.target.value as DirectorRuntimeKind;
    if (nextKind === runtimeKind) return;
    setReady(false);
    setBusy(null);
    updateNodeData(id, {
      directorRuntimeKind: nextKind,
      directorStatus: 'idle',
      error: undefined,
    });
  }, [id, runtimeKind, updateNodeData]);

  const canOpenRuntime = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.open;
  const canExportFrame = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.exportFrame;
  const canExportVideo = runtimeResolution.supported
    && runtimeResolution.descriptor.capabilities.exportVideo;

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
              <div className="director-capture-grid">
                {captureUrls.slice(-4).map((url, idx) => (
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
          </div>

          <div className="director-node-actions nodrag nopan">
            <button
              type="button"
              className="director-node-btn primary"
              disabled={!canOpenRuntime || !!busy}
              onClick={() => { void handleOpen(); }}
              data-tooltip={runtimeUnavailableReason}
            >
              {canOpenRuntime ? (ready ? '聚焦导演台' : '打开导演台') : '运行时不可用'}
            </button>
            <button
              type="button"
              className="director-node-btn grid h-7 w-7 place-items-center p-0"
              disabled={!ready || !canExportFrame || !!busy}
              onClick={() => { void handleExportFrame(); }}
              aria-label="同步当前帧"
              data-tooltip="同步当前帧"
            >
              <Icon icon="lucide:scan-line" width={14} height={14} />
            </button>
            <button
              type="button"
              className="director-node-btn grid h-7 w-7 place-items-center p-0"
              disabled={!ready || !canExportVideo || !!busy}
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

          {data.error && <NodeError nodeId={id} message={String(data.error)} />}

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
