/**
 * DirectorDeskNode — 3D 导演台节点
 * 嵌入 xiaozangao/3d-director-desk（iframe），截图/导出回写本节点，可连线到生视频节点。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Icon } from '@iconify/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import { useNodeRename } from './shared/useNodeRename';
import { useAppStore } from '../../store/useAppStore';
import { saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';
import {
  buildDirectorDeskIframeSrc,
  collectDirectorImageUrls,
  getDirectorDeskOrigin,
  isDirectorDeskMessage,
  postDirectorSession,
  requestDirectorAction,
  type DirectorCaptureItem,
} from '../../services/directorDeskService';

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

  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
  const iframeSrc = buildDirectorDeskIframeSrc(instanceId, deskTheme);

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
    if (!open) return;

    function onMessage(event: MessageEvent) {
      if (!isDirectorDeskMessage(event)) return;
      const type = event.data?.type as string | undefined;
      if (!type) return;

      if (type === 'storyai:director-desk-ready') {
        setReady(true);
        const win = iframeRef.current?.contentWindow;
        if (win) {
          postDirectorSession(win, { instanceId, theme: deskTheme });
        }
        updateNodeDataTransient(id, { directorStatus: 'ready' });
        return;
      }

      if (type === 'storyai:director-desk-close') {
        setOpen(false);
        return;
      }

      if (type === 'storyai:director-desk-captures-sent') {
        const captures = (event.data?.payload?.captures ?? []) as DirectorCaptureItem[];
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

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [deskTheme, id, instanceId, open, persistCaptures, updateNodeDataTransient]);

  const handleOpen = useCallback(() => {
    setReady(false);
    setOpen(true);
    updateNodeDataTransient(id, { directorStatus: 'open' });
  }, [id, updateNodeDataTransient]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setReady(false);
    updateNodeDataTransient(id, { directorStatus: captureUrls.length ? 'ready' : 'idle' });
  }, [captureUrls.length, id, updateNodeDataTransient]);

  const handleExportFrame = useCallback(async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出当前帧…');
    try {
      const result = (await requestDirectorAction(win, 'export.frame', {
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
  }, [data.label, persistCaptures, ready, showToast]);

  const handleExportVideo = useCallback(async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !ready) {
      showToast('请先打开并等待导演台就绪', 'error');
      return;
    }
    setBusy('导出参考视频…');
    try {
      const result = (await requestDirectorAction(
        win,
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
  }, [currentProjectId, data.filePath, data.label, id, ready, showToast, updateNodeData]);

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
          onDoubleClick={handleOpen}
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
            <button type="button" className="director-node-btn primary" onClick={handleOpen}>
              打开导演台
            </button>
            <span className="director-node-meta">
              {captureUrls.length > 0 ? `${captureUrls.length} 张参考图` : '未同步截图'}
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

      <FullscreenOverlay
        isOpen={open}
        onClose={handleClose}
        title={`${displayLabel} · ${getDirectorDeskOrigin()}`}
        panelWidth="min(96vw, 1280px)"
        bodyClassName="director-overlay-body"
      >
        <div className="director-overlay-root">
          <div className="director-overlay-toolbar nodrag nopan">
            <span className={`director-ready-dot ${ready ? 'is-ready' : ''}`} />
            <span>{ready ? '已连接' : '连接中…'}</span>
            <span className="director-overlay-hint">
              在导演台内运镜后，点「发送截图到宿主」或下方「同步当前帧」；再连线到「生成视频」节点
            </span>
            <div className="director-overlay-actions">
              <button
                type="button"
                className="director-node-btn"
                disabled={!ready || !!busy}
                onClick={() => void handleExportFrame()}
              >
                同步当前帧
              </button>
              <button
                type="button"
                className="director-node-btn"
                disabled={!ready || !!busy}
                onClick={() => void handleExportVideo()}
              >
                导出参考视频
              </button>
              <button type="button" className="director-node-btn" onClick={handleClose}>
                关闭
              </button>
            </div>
          </div>
          {busy && <div className="director-overlay-busy">{busy}</div>}
          <iframe
            ref={iframeRef}
            className="director-overlay-iframe"
            title="3D 导演台"
            src={iframeSrc}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        </div>
      </FullscreenOverlay>
    </>
  );
}

export default memo(DirectorDeskNode);
