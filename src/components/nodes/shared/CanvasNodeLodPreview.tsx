import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../../types';
import { withPreviewRevision } from '../../../hooks/useReferencedImageWatcher';
import { CanvasNodeLodContext, useCanvasNodeLodPreviewRevision } from '../../../hooks/useCanvasNodeLod';
import { acquireCachedCanvasImagePreview, acquireCanvasImagePreview } from './image/canvasImagePreviewCache';
import { acquireCanvasVideoPoster } from './video/canvasVideoPreviewCache';

interface Props {
  nodeId?: string;
  data: BaseNodeData;
  video: boolean;
  projectId: string | null;
  width: number;
  height: number;
  cover?: boolean;
  onUnavailable: () => void;
}

function CanvasNodeLodPreview({ nodeId, data, video, projectId, width, height, cover = false, onUnavailable }: Props) {
  const runtime = useContext(CanvasNodeLodContext);
  const revision = useCanvasNodeLodPreviewRevision() ?? 0;
  const imageSource = video
    ? (data.thumbnailUrl !== data.videoUrl && data.thumbnailUrl !== data.sourceUrl ? data.thumbnailUrl : undefined)
    : data.imageUrl || data.thumbnailUrl;
  const source = imageSource
    ? withPreviewRevision(imageSource, revision)
    : data.videoUrl;
  const [preview, setPreview] = useState<{
    source: string; projectId: string | null; image: boolean; src: string; request: AbortController; cached?: boolean;
  }>();
  const [ready, setReady] = useState<string>();
  const requestRef = useRef<AbortController | null>(null);
  const cancelDisplay = useRef<(() => void) | undefined>(undefined);
  const publish = useCallback((request: AbortController, update: () => void, cached = false) => {
    if (request.signal.aborted || requestRef.current !== request) return;
    cancelDisplay.current?.();
    const commit = () => { if (!request.signal.aborted && requestRef.current === request) update(); };
    if (runtime && !cached) cancelDisplay.current = runtime.enqueueDisplay(request, commit, nodeId);
    else commit();
  }, [runtime, nodeId]);

  useEffect(() => {
    const request = new AbortController();
    requestRef.current = request;
    const cached = source && imageSource ? acquireCachedCanvasImagePreview(source, 256, request.signal, projectId) : null;
    let lease: { src: string; release: () => void } | null = cached;
    const prepare = async () => {
      if (!source || request.signal.aborted) return;
      const acquisition = cached ? Promise.resolve(cached)
        : imageSource ? acquireCanvasImagePreview(source, 256, request.signal, projectId)
          : acquireCanvasVideoPoster(source, request.signal);
      await acquisition.then((result) => {
        // 缓存租约已由清理函数持有；异步冷请求的迟到租约在这里归还。
        if (request.signal.aborted) { if (!cached) result?.release(); return; }
        lease = result;
        const next = lease;
        publish(request, () => {
          if (next) setPreview({ source, projectId, image: !!imageSource, src: next.src, request, cached: !!cached });
          else onUnavailable();
        }, !!cached);
      }, () => publish(request, onUnavailable));
    };
    let cancelPrepare: (() => void) | undefined;
    // 已就绪的内存小图随节点入场显示；未缓存图和视频派生仍等待交互预算。
    if (cached) void prepare();
    else cancelPrepare = runtime ? runtime.prepareDisplay(request, prepare, nodeId) : (void prepare(), undefined);
    return () => { request.abort(); cancelPrepare?.(); cancelDisplay.current?.(); lease?.release(); };
  }, [source, imageSource, projectId, onUnavailable, publish, runtime, nodeId]);

  const resolved = preview?.source === source && preview?.projectId === projectId && preview?.image === !!imageSource
    ? preview?.src : undefined;
  const visible = !!resolved && ready === resolved;
  return (
    <div
      className={`node-wrapper canvas-node-lod-preview${cover ? ' is-cover' : ''}`}
      data-canvas-node-lod="preview"
      style={{ width, height }}
      aria-label={data.label}
    >
      {resolved && <img
        className={`canvas-node-lod-image${visible ? ' is-ready' : ''}`}
        src={resolved}
        alt=""
        draggable={false}
        decoding="async"
        onLoad={async (event) => {
          const request = preview?.request;
          try {
            await event.currentTarget.decode();
            if (request) publish(request, () => setReady(resolved), preview?.cached);
          } catch { if (request) publish(request, onUnavailable); }
        }}
        onError={() => {
          if (preview) publish(preview.request, onUnavailable);
        }}
      />}
      {!cover && <>
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source" />
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source" />
      </>}
    </div>
  );
}

export default memo(CanvasNodeLodPreview);
