import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../../types';
import { withPreviewRevision } from '../../../hooks/useReferencedImageWatcher';
import { useCanvasNodeLodPreviewRevision } from '../../../hooks/useCanvasNodeLod';
import { acquireCanvasImagePreview } from './image/canvasImagePreviewCache';
import { acquireCanvasVideoPoster } from './video/canvasVideoPreviewCache';

interface Props {
  data: BaseNodeData;
  video: boolean;
  projectId: string | null;
  width: number;
  height: number;
  cover?: boolean;
  onUnavailable: () => void;
}

function CanvasNodeLodPreview({ data, video, projectId, width, height, cover = false, onUnavailable }: Props) {
  const revision = useCanvasNodeLodPreviewRevision() ?? 0;
  const imageSource = video
    ? (data.thumbnailUrl !== data.videoUrl && data.thumbnailUrl !== data.sourceUrl ? data.thumbnailUrl : undefined)
    : data.imageUrl || data.thumbnailUrl;
  const source = imageSource
    ? withPreviewRevision(imageSource, revision)
    : data.videoUrl;
  const [preview, setPreview] = useState<{
    source: string; projectId: string | null; image: boolean; src: string; request: AbortController;
  }>();
  const [ready, setReady] = useState<string>();
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    requestRef.current = request;
    let lease: { src: string; release: () => void } | null = null;
    if (source) {
      const acquisition = imageSource
        ? acquireCanvasImagePreview(source, 256, request.signal, projectId)
        : acquireCanvasVideoPoster(source, request.signal);
      void acquisition.then((result) => {
        lease = result;
        if (request.signal.aborted) { lease?.release(); return; }
        if (lease) setPreview({ source, projectId, image: !!imageSource, src: lease.src, request });
        else onUnavailable();
      }, () => { if (!request.signal.aborted) onUnavailable(); });
    }
    return () => { request.abort(); lease?.release(); };
  }, [source, imageSource, projectId, onUnavailable]);

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
            if (request && !request.signal.aborted && request === requestRef.current) setReady(resolved);
          } catch { if (request && !request.signal.aborted && request === requestRef.current) onUnavailable(); }
        }}
        onError={() => {
          if (preview && !preview.request.signal.aborted && preview.request === requestRef.current) onUnavailable();
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
