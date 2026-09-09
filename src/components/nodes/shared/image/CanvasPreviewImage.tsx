import { memo, useEffect, useRef, useState, type ImgHTMLAttributes, type SyntheticEvent } from 'react';
import { useStore } from '@xyflow/react';
import { acquireCanvasImagePreview } from './canvasImagePreviewCache';

interface CanvasPreviewImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  nodeWidth: number;
  nodeHeight: number;
  projectId?: string | null;
}

interface ResolvedPreview {
  source: string;
  projectId?: string | null;
  edge: number;
  src: string;
  release: () => void;
}

function CanvasThumbnailImage({
  src,
  edge,
  initialSource,
  projectId,
  onError,
  ...imageProps
}: ImgHTMLAttributes<HTMLImageElement> & { src: string; edge: number; initialSource?: string; projectId?: string | null }) {
  const [preview, setPreview] = useState<ResolvedPreview | null>(initialSource
    ? { source: src, projectId, edge, src: initialSource, release: () => {} }
    : null);
  const heldLeases = useRef(new Set<() => void>());

  useEffect(() => {
    const leases = heldLeases.current;
    return () => {
      for (const release of leases) release();
      leases.clear();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    let delivered = false;
    const leases = heldLeases.current;
    const deliver = (lease: { src: string; release: () => void } | null) => {
      if (!current) {
        lease?.release();
        controller.abort();
        return;
      }
      delivered = true;
      const release = () => {
        lease?.release();
        controller.abort();
        leases.delete(release);
      };
      leases.add(release);
      setPreview({
        source: src,
        projectId,
        edge,
        src: lease?.src ?? src,
        release,
      });
    };
    void acquireCanvasImagePreview(src, edge, controller.signal, projectId).then(deliver, () => deliver(null));
    return () => {
      current = false;
      // 已显示的旧尺寸档保留到替换完成，避免缩放时空白或使用已撤销的 blob URL。
      if (!delivered) controller.abort();
    };
  }, [src, edge, projectId]);

  useEffect(() => () => preview?.release(), [preview]);

  const resolvedSrc = preview?.source === src && preview.projectId === projectId ? preview.src : undefined;
  const handleError = (event: SyntheticEvent<HTMLImageElement, Event>) => {
    if (src && resolvedSrc && resolvedSrc !== src) {
      // 派生图自身解码失败时退回原图；原图失败再交给节点已有的重试逻辑。
      setPreview({ source: src, projectId, edge, src, release: () => {} });
      return;
    }
    if (resolvedSrc) onError?.(event);
  };

  return <img {...imageProps} src={resolvedSrc} decoding="async" onError={handleError} />;
}

/** 只改变画布展示源；源图地址、节点尺寸和编辑/生成输入仍由父节点持有。 */
function CanvasPreviewImage({ src, nodeWidth, nodeHeight, projectId, ...imageProps }: CanvasPreviewImageProps) {
  // selector 返回尺寸档，微小缩放与纯平移不会触发每张图片的 React 更新。
  const edge = useStore((state) => {
    const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const screenEdge = Math.max(nodeWidth, nodeHeight) * state.transform[2] * pixelRatio;
    if (!Number.isFinite(screenEdge) || screenEdge <= 0 || screenEdge > 1024) return 0;
    return screenEdge <= 256 ? 256 : screenEdge <= 512 ? 512 : 1024;
  });
  const [lastOriginalSource, setLastOriginalSource] = useState<string>();
  if (edge === 0 && lastOriginalSource !== src) setLastOriginalSource(src);

  // 原图档卸载缩略图持有者，使不再显示的预览进入有界空闲缓存。
  // 缩回时暂用刚显示过的原图，避免缩略图缓存已过期时闪空；首次小图展示不加载原图。
  return src && edge > 0
    ? <CanvasThumbnailImage
        {...imageProps}
        src={src}
        edge={edge}
        projectId={projectId}
        initialSource={lastOriginalSource === src ? src : undefined}
      />
    : <img {...imageProps} src={src} decoding="async" />;
}

export default memo(CanvasPreviewImage);
