/**
 * 仅在图片接近视口时挂载真实 src，并在远离视口后延迟卸载。
 *
 * 浏览器原生 loading="lazy" 只推迟首次加载，不保证滚出长列表后的解码位图可回收。
 * 该组件保留 img 元素和布局，只管理资源 src 生命周期，适合资产、角色和消息列表。
 */
import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { useViewportMediaSource } from '../../hooks/useViewportMediaSource';
import { acquireCanvasImagePreview, type CanvasImagePreviewLease } from '../nodes/shared/image/canvasImagePreviewCache';

interface ViewportImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string;
  /** 选中态或关键首图可跳过延迟挂载。 */
  eager?: boolean;
  /** 提前加载边界；普通模式上下 800px，性能模式上下 160px。 */
  rootMargin?: string;
  /** 离开预加载边界后延迟卸载，避免边缘抖动反复解码。 */
  unloadDelayMs?: number;
  /** 可重建的小图预览，仅在接近视口后准备；显式大图查看仍由宿主使用原源。 */
  previewMaxEdge?: number;
  /** 只传已知文件所属项目，禁止借当前项目为外部文件建立缓存归属。 */
  projectId?: string | null;
}

export default function ViewportImage({
  src,
  eager = false,
  rootMargin,
  unloadDelayMs,
  previewMaxEdge,
  projectId,
  loading = 'lazy',
  decoding = 'async',
  onLoad,
  onError,
  style,
  ...imageProps
}: ViewportImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [imageSize, setImageSize] = useState<{ source: string; width: number; height: number }>();
  const mountedSrc = useViewportMediaSource(src, imageRef, { eager, rootMargin, unloadDelayMs });
  const retainedSize = imageSize?.source === src ? imageSize : undefined;
  const wantsPreview = typeof previewMaxEdge === 'number' && Number.isFinite(previewMaxEdge) && previewMaxEdge > 0;
  const [preview, setPreview] = useState<{
    source: string; edge: number; projectId?: string | null; src: string; request: AbortController;
    release: () => void;
  }>();

  useEffect(() => {
    if (!mountedSrc || !wantsPreview || !previewMaxEdge) return;
    const request = new AbortController();
    let lease: CanvasImagePreviewLease | null = null;
    const release = () => { lease?.release(); lease = null; };
    void acquireCanvasImagePreview(mountedSrc, previewMaxEdge, request.signal, projectId).then((result) => {
      if (request.signal.aborted) { result?.release(); return; }
      lease = result;
      setPreview({ source: mountedSrc, edge: previewMaxEdge, projectId,
        src: result?.src ?? mountedSrc, request, release });
    }, () => {
      if (!request.signal.aborted) setPreview({ source: mountedSrc, edge: previewMaxEdge, projectId,
        src: mountedSrc, request, release });
    });
    return () => { request.abort(); release(); };
  }, [mountedSrc, wantsPreview, previewMaxEdge, projectId]);

  const currentPreview = preview && preview.source === mountedSrc && preview.edge === previewMaxEdge
    && preview.projectId === projectId && !preview.request.signal.aborted ? preview : undefined;
  const displayedSrc = !mountedSrc ? undefined : wantsPreview ? currentPreview?.src : mountedSrc;

  return (
    <img
      {...imageProps}
      ref={imageRef}
      src={displayedSrc}
      style={{ aspectRatio: retainedSize ? `${retainedSize.width} / ${retainedSize.height}` : undefined, ...style }}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (mountedSrc && naturalWidth > 0 && naturalHeight > 0) {
          // 卸载 src 后仍保留图片比例，避免瀑布流卡片塌陷并改变滚动位置。
          setImageSize((previous) => (
            previous?.source === mountedSrc && previous.width === naturalWidth && previous.height === naturalHeight
              ? previous
              : { source: mountedSrc, width: naturalWidth, height: naturalHeight }
          ));
        }
        onLoad?.(event);
      }}
      onError={(event) => {
        if (currentPreview && displayedSrc !== mountedSrc && mountedSrc) {
          currentPreview.release();
          setPreview({ ...currentPreview, src: mountedSrc });
        } else onError?.(event);
      }}
      loading={loading}
      decoding={decoding}
      data-viewport-image={displayedSrc ? 'loaded' : 'deferred'}
    />
  );
}
