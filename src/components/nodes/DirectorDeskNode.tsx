/**
 * DirectorDeskNode — 3D 导演台节点
 * 通过 Tauri 独立窗口打开 Tenney95/3d-director-desk，截图/导出回写本节点。
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Icon } from '@iconify/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import { useNodeRename } from './shared/useNodeRename';
import { useAppStore } from '../../store/useAppStore';
import { saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';
import {
  collectDirectorImageUrls,
  type DirectorCaptureItem,
} from '../../services/directorDeskService';
import {
  openDirectorDeskWindow,
  requestDirectorWindowAction,
  subscribeDirectorDeskWindow,
  type DirectorDeskProtocolMessage,
} from '../../services/directorDeskWindowService';
import {
  getDirectorDeskRuntimeStatus,
  requiresDirectorDeskRuntime,
} from '../../services/directorDeskRuntimeService';

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
    async (captures: DirectorCaptureItem[]) => {
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
    function onMessage(message: DirectorDeskProtocolMessage) {
      const type = message.type;

      if (type === 'storyai:director-desk-ready') {
        setReady(true);
        updateNodeDataTransient(id, { directorStatus: 'ready', error: undefined });
        return;
      }

      if (type === 'storyai:director-desk-close') {
        setReady(false);
        updateNodeDataTransient(id, {
          directorStatus: captureUrls.length ? 'ready' : 'idle',
        });
        return;
      }

      if (type === 'storyai:director-desk-captures-sent') {
        const captures = (message.payload?.captures ?? []) as DirectorCaptureItem[];
        void persistCaptures(
          captures
            .map((c) => ({
              dataUrl: String(c?.dataUrl || ''),
              fileName: String(c?.fileName || 'director-capture.png'),
            }))
            .filter((c) => c.dataUrl.startsWith('data:image/')),
        );
      }
    }

    return subscribeDirectorDeskWindow(instanceId, onMessage);
  }, [captureUrls.length, id, instanceId, persistCaptures, updateNodeDataTransient]);

  const handleOpen = useCallback(async () => {
    setReady(false);
    updateNodeDataTransient(id, { directorStatus: 'open' });
    try {
      if (requiresDirectorDeskRuntime()) {
        const runtime = await getDirectorDeskRuntimeStatus();
        if (!runtime.installed) {
          updateNodeDataTransient(id, { directorStatus: 'idle', error: undefined });
          useAppStore.getState().requestDirectorDeskRuntime(instanceId, true);
          return;
        }
      }
      await openDirectorDeskWindow({ instanceId, theme: deskTheme });
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开 3D 导演台失败';
      setReady(false);
      updateNodeDataTransient(id, { directorStatus: 'idle', error: message });
      showToast(message, 'error');
    }
  }, [deskTheme, id, instanceId, showToast, updateNodeDataTransient]);

  const handleExportFrame = useCallback(async () => {
    if (!ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出当前帧…');
    try {
      const result = (await requestDirectorWindowAction(instanceId, 'export.frame', {
        position: 'current',
        quality: '1080p',
        fileName: `${(data.label as string) || 'director'}-frame.png`,
      })) as { dataUrl?: string; fileName?: string } | undefined;

      const dataUrl = result?.dataUrl;
      if (!dataUrl?.startsWith('data:image/')) {
        throw new Error('导演台未返回有效帧图');
      }
      await persistCaptures([{ dataUrl, fileName: result?.fileName || 'director-frame.png' }]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出帧失败', 'error');
    } finally {
      setBusy(null);
    }
  }, [data.label, instanceId, persistCaptures, ready, showToast]);

  const handleExportVideo = useCallback(async () => {
    if (!ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出参考视频…');
    try {
      const result = (await requestDirectorWindowAction(
        instanceId,
        'export.video',
        {
          quality: '720p',
          fps: 24,
          fileName: `${(data.label as string) || 'director'}-ref.mp4`,
        },
        90_000,
      )) as { dataUrl?: string; blobUrl?: string; fileName?: string } | undefined;

      const mediaUrl = result?.dataUrl || result?.blobUrl;
      if (!mediaUrl) {
        throw new Error('导演台未返回参考视频（需先录制运镜轨迹）');
      }

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
  }, [currentProjectId, data.filePath, data.label, id, instanceId, ready, showToast, updateNodeData]);

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
                <span>3D 导演台</span>
                <span className="text-node-edit-hint">双击打开 · 同步截图后连线生视频</span>
              </div>
            )}
          </div>

          <div className="director-node-actions nodrag nopan">
            <button
              type="button"
              className="director-node-btn primary"
              onClick={() => { void handleOpen(); }}
            >
              {ready ? '聚焦导演台' : '打开导演台'}
            </button>
            <button
              type="button"
              className="director-node-btn grid h-7 w-7 place-items-center p-0"
              disabled={!ready || !!busy}
              onClick={() => { void handleExportFrame(); }}
              aria-label="同步当前帧"
              data-tooltip="同步当前帧"
            >
              <Icon icon="lucide:scan-line" width={14} height={14} />
            </button>
            <button
              type="button"
              className="director-node-btn grid h-7 w-7 place-items-center p-0"
              disabled={!ready || !!busy}
              onClick={() => { void handleExportVideo(); }}
              aria-label="导出参考视频"
              data-tooltip="导出参考视频"
            >
              <Icon icon="lucide:video" width={14} height={14} />
            </button>
            <span className="director-node-meta">
              {busy || (captureUrls.length > 0 ? `${captureUrls.length} 张参考图` : '未同步截图')}
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
