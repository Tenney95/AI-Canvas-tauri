import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { getBezierPath, Position } from '@xyflow/react';
import { Icon } from '@iconify/react';
import type { BaseNodeData } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { useViewportMediaSource } from '../../hooks/useViewportMediaSource';
import { withPreviewRevision } from '../../hooks/useReferencedImageWatcher';
import { acquireCanvasImagePreview } from '../nodes/shared/image/canvasImagePreviewCache';
import ResourceVideoPreview from '../shared/ResourceVideoPreview';
import { getAssetNodePorts, startAssetNodeConnectionDrag, type AssetNodePort } from '../../utils/assetNodeConnection';

interface Props {
  nodeId: string;
  data: BaseNodeData;
  projectId: string | null;
  connectable: boolean;
  videoExpanded?: boolean;
  onVideoExpandedChange?: (expanded: boolean) => void;
}

function CanvasNodeCardContent({ nodeId, data, projectId, connectable, videoExpanded = false, onVideoExpandedChange }: Props) {
  const plugins = useAppStore((state) => state.installedPlugins);
  const ports = useMemo(() => getAssetNodePorts(data, plugins), [data, plugins]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cancelDragRef = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<{ startX: number; startY: number; x: number; y: number; valid: boolean; input: boolean }>();
  const [preview, setPreview] = useState<{ source: string; projectId: string | null; src?: string }>();
  const [failedImage, setFailedImage] = useState<string>();
  const video = data.type === 'ai-video' || data.type === 'source-video';
  const image = video
    ? (data.thumbnailUrl !== data.videoUrl && data.thumbnailUrl !== data.sourceUrl ? data.thumbnailUrl : undefined)
    : data.imageUrl || data.thumbnailUrl;
  const mediaSource = video ? undefined : image;
  const revisionSource = mediaSource ? withPreviewRevision(mediaSource, data.mediaVersion ?? 0) : undefined;
  const visibleMedia = useViewportMediaSource(revisionSource, bodyRef, { rootMargin: '160px 0px' });
  const audioSource = useViewportMediaSource(data.audioUrl, bodyRef, { rootMargin: '160px 0px' });
  const text = (data.note?.text || data.output || data.prompt || '').trim().slice(0, 1600);

  useEffect(() => {
    if (!visibleMedia) return;
    const request = new AbortController();
    let lease: { src: string; release: () => void } | null = null;
    const acquisition = acquireCanvasImagePreview(visibleMedia, 512, request.signal, projectId);
    void acquisition.then((result) => {
      if (request.signal.aborted) { result?.release(); return; }
      lease = result;
      // 与画布图片一致：小图或无法派生缩略图时使用原图，仍由视口控制加载。
      setPreview({ source: visibleMedia, projectId, src: result?.src ?? (image ? visibleMedia : undefined) });
    }, () => {
      if (!request.signal.aborted) setPreview({ source: visibleMedia, projectId, src: image ? visibleMedia : undefined });
    });
    return () => { request.abort(); lease?.release(); };
  }, [visibleMedia, image, projectId]);

  useEffect(() => () => { cancelDragRef.current?.(); }, [nodeId, projectId, connectable]);

  const startConnection = (event: PointerEvent<HTMLButtonElement>, port: AssetNodePort) => {
    if (event.button !== 0 || !event.isPrimary || !connectable) return;
    event.preventDefault();
    event.stopPropagation();
    cancelDragRef.current?.();
    const bounds = event.currentTarget.getBoundingClientRect();
    const start = { startX: bounds.left + bounds.width / 2, startY: bounds.top + bounds.height / 2, input: port.direction === 'input' };
    setDrag({ ...start, x: event.clientX, y: event.clientY, valid: false });
    cancelDragRef.current = startAssetNodeConnectionDrag({
      origin: { nodeId, handleId: port.id, projectId }, pointerId: event.pointerId,
      onMove: (point) => setDrag({ ...start, ...point }),
      onEnd: () => { cancelDragRef.current = null; setDrag(undefined); },
    });
  };

  const resolved = preview?.source === visibleMedia && preview?.projectId === projectId ? preview.src : undefined;
  const [path] = drag ? getBezierPath({ sourceX: drag.startX, sourceY: drag.startY,
    sourcePosition: drag.input ? Position.Left : Position.Right, targetX: drag.x, targetY: drag.y,
    targetPosition: drag.input ? Position.Right : Position.Left }) : [''];

  return (
    <div ref={bodyRef} className={`assets-node-content${videoExpanded ? ' has-expanded-video' : ''}`}>
      {video ? (
        <ResourceVideoPreview key={`${projectId}:${nodeId}`} src={data.videoUrl} filePath={data.filePath} poster={image}
          revision={data.mediaVersion} name={data.label} expanded={videoExpanded}
          onExpandedChange={(expanded) => onVideoExpandedChange?.(expanded)} />
      ) : mediaSource ? (
        <div className="assets-node-media">
          {resolved && failedImage !== resolved ? (
            <img src={resolved} alt={data.label} draggable={false} loading="lazy" decoding="async" onError={() => setFailedImage(resolved)} />
          ) : <span className="text-xs text-canvas-text-muted">{preview?.source === visibleMedia ? '暂无可用预览' : '加载预览…'}</span>}
        </div>
      ) : data.audioUrl ? (
        <div className="assets-node-audio">
          <Icon icon="lucide:audio-lines" width="32" height="32" aria-hidden="true" />
          <audio key={`${projectId}:${data.audioUrl}`} src={audioSource} controls preload="none" aria-label={`${data.label} 音频预览`} />
        </div>
      ) : (
        <div className="assets-node-text">
          {text ? <p>{text}</p> : <span className="text-canvas-text-muted">{data.shotlistRows?.length ? `${data.shotlistRows.length} 个镜头` : '暂无内容'}</span>}
        </div>
      )}
      {connectable && ports.length > 0 && (
        <div className="assets-node-ports">
          {(['input', 'output'] as const).map((direction) => (
            <div key={direction} className={`assets-node-port-group${direction === 'output' ? ' is-output' : ''}`}>
              {ports.filter((port) => port.direction === direction).map((port) => (
                <button key={port.id} type="button" className="assets-node-port"
                  aria-label={`从 ${data.label} 的${port.label}端口拖出连线`} title={`${port.label}：拖到画布节点连接，Esc 取消`}
                  onPointerDown={(event) => startConnection(event, port)}>
                  <span className="assets-node-port-dot" aria-hidden="true" />{port.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {drag && createPortal(
        <svg className={`assets-node-connection-overlay${drag.valid ? ' is-valid' : ''}`} aria-hidden="true">
          <path d={path} />
          <circle cx={drag.x} cy={drag.y} r="4" />
          <text x={Math.max(8, Math.min(drag.x + 14, window.innerWidth - 160))} y={Math.max(20, drag.y - 12)}>{drag.valid ? '松开以连接' : '拖到画布节点接口'}</text>
        </svg>, document.body,
      )}
    </div>
  );
}

export default memo(CanvasNodeCardContent);
