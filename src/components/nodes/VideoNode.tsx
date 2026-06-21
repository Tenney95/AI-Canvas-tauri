/**
 * VideoNode 视频节点 — 在画布上渲染视频内容，支持上传本地视频、播放控制、连接其他节点
 */
import { memo, useCallback, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import VideoNodeToolbar from './shared/VideoNodeToolbar';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { computeImageNodeDimensions, generateId, useAppStore } from '../../store/useAppStore';
import { downloadUrlAndSave, saveDataUrlToProjectData } from '../../services/fileService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';

function captureVideoFrame(video: HTMLVideoElement): { dataUrl: string; width: number; height: number } {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建截帧画布');
  }

  ctx.drawImage(video, 0, 0, width, height);
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width,
    height,
  };
}

function isTaintedCanvasError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('Tainted canvases') || error.message.includes('may not be exported');
}

function captureFrameFromVideoUrl(url: string, currentTime: number): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const done = () => {
      if (settled) return;
      try {
        const frame = captureVideoFrame(video);
        settled = true;
        cleanup();
        resolve(frame);
      } catch (error) {
        fail(error);
      }
    };

    timer = window.setTimeout(() => fail(new Error('本地视频加载超时')), 15000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('error', () => fail(new Error('本地视频加载失败')), { once: true });
    video.addEventListener('loadedmetadata', () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const targetTime = duration > 0
        ? Math.min(Math.max(currentTime, 0), Math.max(duration - 0.01, 0))
        : 0;

      if (Math.abs(video.currentTime - targetTime) < 0.01) {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          done();
        } else {
          video.addEventListener('loadeddata', done, { once: true });
        }
        return;
      }

      video.addEventListener('seeked', done, { once: true });
      video.currentTime = targetTime;
    }, { once: true });
    video.src = url;
  });
}

function AIVideoNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const justCompleted = useCompletionFlash(data.status);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const isSingleSelection = useAppStore((s) => s.selectedNodeIds.length <= 1);
  const isSource = data.role === 'source';

  // ── Upload handler for source nodes ──
  const { isUploading, handleUpload: doUpload } = useSourceFileUpload('.mp4,.webm,.avi,.mov,.mkv');

  const handleUpload = useCallback(async () => {
    const result = await doUpload();
    if (!result) return;
    updateNodeData(id, {
      videoUrl: result.dataUrl,
      filePath: result.filePath,
      fileName: result.fileName,
      label: result.fileName,
      status: 'success',
    } as Partial<BaseNodeData>);
  }, [doUpload, id, updateNodeData]);

  const handleVideoClick = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (selected) return;
      e.preventDefault();
    },
    [selected],
  );

  const { displayLabel, handleRename } = useNodeRename(id, data, '粘贴视频');

  const handleCaptureFrame = useCallback(async () => {
    const store = useAppStore.getState();
    const video = videoRef.current;

    if (!video || !data.videoUrl) {
      store.showToast('没有可截取的视频', 'error');
      return;
    }

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
      store.showToast('视频尚未加载到可截取的帧', 'error');
      return;
    }

    const createFrameNode = async (frame: { dataUrl: string; width: number; height: number }) => {
      const dims = await computeImageNodeDimensions(frame.dataUrl);
      const currentNode = store.nodes.find((node) => node.id === id);
      const currentPosition = currentNode?.position ?? { x: 0, y: 0 };
      const nodeWidth = (data.nodeWidth as number | undefined) ?? 280;
      const frameFileName = `video-frame-${Date.now()}-${generateId()}.png`;
      const projectId = store.currentProjectId;
      const savedFrame = projectId && projectId !== 'default'
        ? await saveDataUrlToProjectData(frame.dataUrl, projectId, frameFileName)
        : null;
      const imageUrl = savedFrame?.assetUrl || frame.dataUrl;

      store.addNode({
        id: `node-${generateId()}`,
        type: 'ai-image',
        position: {
          x: currentPosition.x + nodeWidth + 40,
          y: currentPosition.y,
        },
        data: {
          label: `${displayLabel} 当前帧`,
          type: 'ai-image',
          role: 'source',
          status: 'success',
          imageUrl,
          filePath: savedFrame?.filePath,
          fileName: frameFileName,
          imageWidth: frame.width,
          imageHeight: frame.height,
          ...dims,
        },
      } as Parameters<typeof store.addNode>[0]);
    };

    try {
      await createFrameNode(captureVideoFrame(video));
      store.showToast('已截取当前帧为图像节点', 'success');
    } catch (error) {
      if (!isTaintedCanvasError(error)) {
        const message = error instanceof Error ? error.message : '截取当前帧失败';
        store.showToast(`截取当前帧失败：${message}`, 'error');
        return;
      }

      const remoteUrl = typeof data.sourceUrl === 'string' ? data.sourceUrl : data.videoUrl;
      const projectId = store.currentProjectId;
      if (!remoteUrl?.startsWith('http') || !projectId || projectId === 'default') {
        store.showToast('该视频来源禁止导出当前帧，请先上传为本地视频后再截帧', 'error');
        return;
      }

      store.showToast('远程视频受跨域限制，正在转为本地资源后重试...', 'success');
      const saved = await downloadUrlAndSave(remoteUrl, projectId, 'video-source');
      if (!saved?.assetUrl) {
        store.showToast('远程视频本地化失败，无法截取当前帧', 'error');
        return;
      }

      try {
        store.updateNodeData(id, {
          videoUrl: saved.assetUrl,
          filePath: saved.filePath,
          sourceUrl: remoteUrl,
        } as Partial<BaseNodeData>);

        await createFrameNode(await captureFrameFromVideoUrl(saved.assetUrl, video.currentTime));
        store.showToast('已截取当前帧为图像节点', 'success');
      } catch (fallbackError) {
        const message = fallbackError instanceof Error ? fallbackError.message : '本地资源截帧失败';
        store.showToast(`截取当前帧失败：${message}`, 'error');
      }
    }
  }, [data.nodeWidth, data.sourceUrl, data.videoUrl, displayLabel, id]);

  return (
    <div className="node-wrapper relative" style={{ width: 280 }}>
      <NodeLabel
        kind="ai-video"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />
      {data.videoUrl && (
        <div className={`node-toolbar-shell ${selected && isSingleSelection ? 'is-visible' : ''}`}>
          <VideoNodeToolbar onCaptureFrame={handleCaptureFrame} />
        </div>
      )}
      <div
        className={`node video-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''} ${justCompleted ? 'just-completed' : ''}`}
        style={{ minHeight: 160 }}
      >
        <div className="node-preview compact">
          {isSource && (
            <button
              className="node-upload-btn"
              onClick={(e) => { e.stopPropagation(); handleUpload(); }}
              data-tooltip="上传视频"
              aria-label="上传视频"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          )}
          {data.videoUrl ? (
            <video
              ref={videoRef}
              src={data.videoUrl}
              className="video-preview-player compact"
              crossOrigin="anonymous"
              controls={Boolean(selected)}
              onClick={handleVideoClick}
              muted
              data-source-url={data.sourceUrl}
            />
          ) : data.thumbnailUrl ? (
            <img
              src={data.thumbnailUrl}
              alt="Video thumbnail"
              className="image-preview-img compact"
            />
          ) : isUploading ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>上传中...</span>
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>生成视频中...</span>
            </div>
          ) : (
            <div className="node-preview-placeholder">
              {isSource ? (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              ) : (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" />
                </svg>
              )}
            </div>
          )}
        </div>
        {data.error && <NodeError nodeId={id} message={data.error} />}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-video" >
          <GooeyBtn className="gooey-btn-left" hue={217} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-video" >
          <GooeyBtn className="gooey-btn-right" hue={217} />
        </Handle>
      </div>
    </div>
  );
}

export default memo(AIVideoNode);
