/**
 * 仅在图片接近视口时挂载真实 src，并在远离视口后延迟卸载。
 *
 * 浏览器原生 loading="lazy" 只推迟首次加载，不保证滚出长列表后的解码位图可回收。
 * 该组件保留 img 元素和布局，只管理资源 src 生命周期，适合资产、角色和消息列表。
 */
import { useRef, type ImgHTMLAttributes } from 'react';
import { useViewportMediaSource } from '../../hooks/useViewportMediaSource';

interface ViewportImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string;
  /** 选中态或关键首图可跳过延迟挂载。 */
  eager?: boolean;
  /** 提前加载边界，默认上下各 800px，避免快速滚动时闪烁。 */
  rootMargin?: string;
  /** 离开预加载边界后延迟卸载，避免边缘抖动反复解码。 */
  unloadDelayMs?: number;
}

export default function ViewportImage({
  src,
  eager = false,
  rootMargin = '800px 0px',
  unloadDelayMs = 2_000,
  loading = 'lazy',
  decoding = 'async',
  ...imageProps
}: ViewportImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const mountedSrc = useViewportMediaSource(src, imageRef, { eager, rootMargin, unloadDelayMs });

  return (
    <img
      {...imageProps}
      ref={imageRef}
      src={mountedSrc}
      loading={loading}
      decoding={decoding}
      data-viewport-image={mountedSrc ? 'loaded' : 'deferred'}
    />
  );
}
