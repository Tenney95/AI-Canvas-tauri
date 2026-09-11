import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { AnimatePresence, MotionConfig, motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { useViewportMediaSource } from '../../hooks/useViewportMediaSource';
import { withPreviewRevision } from '../../hooks/useReferencedImageWatcher';
import { getResourceVideoFloatingRect, resolveResourceVideoSource } from '../../hooks/useResourceVideoPreview';
import { acquireCanvasVideoPoster } from '../nodes/shared/video/canvasVideoPreviewCache';
import { releaseViewportVideoElement } from './viewportVideoResource';
import { fadeFast, springSmooth } from '../../utils/motion';

type VideoGeometry = ReturnType<typeof getResourceVideoFloatingRect>;
const VIDEO_SPRING = { ...springSmooth, visualDuration: 0.48, bounce: 0.32 };
const OPEN_TRANSFORM = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

function measureVideoGeometry(anchor: HTMLDivElement, width: number, height: number): VideoGeometry {
  const parent = anchor.closest('[data-resource-video-boundary], [role="dialog"]')?.getBoundingClientRect();
  const left = Math.max(0, parent?.left ?? 0);
  const top = Math.max(0, parent?.top ?? 0);
  const right = Math.min(window.innerWidth, parent?.right ?? window.innerWidth);
  const bottom = Math.min(window.innerHeight, parent?.bottom ?? window.innerHeight);
  return getResourceVideoFloatingRect(anchor.getBoundingClientRect(), { width, height },
    { left, top, width: right - left, height: bottom - top });
}

interface Props {
  src?: string;
  filePath?: string;
  poster?: string;
  revision?: number;
  name: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  className?: string;
}

/** 仅显式展开时挂载播放器；缩略列表复用串行、可取消的共享封面缓存。 */
export default function ResourceVideoPreview({ src, filePath, poster, revision = 0, name, expanded, onExpandedChange, className = '' }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 多张卡片可能引用同一资产 ID；只有收到点击的卡片可以拥有播放器。
  const [requested, setRequested] = useState(false);
  const [closing, setClosing] = useState(false);
  const [openingGeometry, setOpeningGeometry] = useState<VideoGeometry>();
  if (!expanded && requested) setRequested(false);
  const active = expanded && requested;
  const identity = JSON.stringify([src, filePath, revision]);
  const visible = useViewportMediaSource(identity, rootRef, { eager: active, rootMargin: '160px 0px' });
  const [resolved, setResolved] = useState<{ identity: string; src?: string }>();
  const [failedSource, setFailedSource] = useState<string>();
  const [preview, setPreview] = useState<{ source: string; src?: string; width?: number; height?: number }>();
  const [failedPoster, setFailedPoster] = useState<string>();
  const primary = resolved?.identity === identity ? resolved.src : undefined;
  const source = primary && primary === failedSource && src && src !== primary ? withPreviewRevision(src, revision) : primary;
  const suppliedPoster = poster && poster !== src && poster !== primary ? withPreviewRevision(poster, revision) : undefined;

  useEffect(() => {
    if (!visible) return;
    let current = true;
    void resolveResourceVideoSource(src, filePath).then((url) => {
      if (current) setResolved({ identity, src: url ? withPreviewRevision(url, revision) : undefined });
    });
    return () => { current = false; };
  }, [visible, identity, src, filePath, revision]);

  useEffect(() => {
    if (!visible || !source || (suppliedPoster && suppliedPoster !== failedPoster)) return;
    const request = new AbortController();
    let held: { release: () => void } | null = null;
    void acquireCanvasVideoPoster(source, request.signal).then((lease) => {
      if (request.signal.aborted) { lease?.release(); return; }
      held = lease;
      setPreview({ source, src: lease?.src, width: lease?.videoWidth, height: lease?.videoHeight });
      if (!lease && primary && src && primary !== src) setFailedSource(primary);
    }, () => {
      if (!request.signal.aborted) setPreview({ source });
    });
    return () => { request.abort(); held?.release(); };
  }, [visible, source, suppliedPoster, failedPoster, primary, src]);

  const posterSource = visible ? (suppliedPoster && suppliedPoster !== failedPoster
    ? suppliedPoster : preview?.source === source ? preview?.src : undefined) : undefined;
  return (
    <div ref={rootRef} className={`resource-video-preview${active ? ' is-expanded' : ''} ${className}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => { if (active) { event.preventDefault(); event.stopPropagation(); } }}>
      <button type="button" className="resource-video-open" aria-label={`展开播放 ${name}`} aria-expanded={active}
        onClick={() => {
          if (!active && rootRef.current) {
            setOpeningGeometry(measureVideoGeometry(rootRef.current,
              preview?.source === source ? preview?.width ?? 640 : 640,
              preview?.source === source ? preview?.height ?? 360 : 360));
          }
          setClosing(active); setRequested(!active); onExpandedChange(!active);
        }}>
        {posterSource && posterSource !== failedPoster
          ? <img src={posterSource} alt={`${name} 视频缩略图`} draggable={false} decoding="async" loading="lazy" onError={() => setFailedPoster(posterSource)} />
          : <Icon icon="lucide:film" className="resource-video-placeholder" aria-hidden="true" />}
        <span className="resource-video-play"><Icon icon="lucide:play" width="20" aria-hidden="true" /></span>
      </button>
      {(active || closing) && openingGeometry && createPortal(
        <MotionConfig reducedMotion="user" transition={VIDEO_SPRING}>
          <AnimatePresence onExitComplete={() => setClosing(false)}>
            {active && <ResourceVideoPlayer key="resource-video" src={source} poster={posterSource} name={name} anchorRef={rootRef}
              openingGeometry={openingGeometry}
              width={preview?.source === source ? preview?.width : undefined} height={preview?.source === source ? preview?.height : undefined}
              unavailable={resolved?.identity === identity}
              onEnded={(animate = true) => { setClosing(animate); setRequested(false); onExpandedChange(false); }}
              onSourceError={() => { if (primary && src && primary !== src) setFailedSource(primary); }} />}
          </AnimatePresence>
        </MotionConfig>,
        document.body,
      )}
    </div>
  );
}

function ResourceVideoPlayer({ src, poster, name, anchorRef, openingGeometry, width = 640, height = 360, unavailable, onEnded, onSourceError }: {
  src?: string; poster?: string; name: string; anchorRef: RefObject<HTMLDivElement | null>;
  openingGeometry: VideoGeometry;
  width?: number; height?: number; unavailable: boolean; onEnded: (animate?: boolean) => void; onSourceError: () => void;
}) {
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onEnded);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [geometry, setGeometry] = useState(openingGeometry);
  useLayoutEffect(() => { closeRef.current = onEnded; }, [onEnded]);
  useLayoutEffect(() => {
    const boundary = anchorRef.current?.closest('[data-resource-video-boundary], [role="dialog"]');
    const position = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      setGeometry(measureVideoGeometry(anchor, dimensions?.width ?? width, dimensions?.height ?? height));
    };
    position();
    const observer = new ResizeObserver(position);
    if (boundary) observer.observe(boundary);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      observer.disconnect();
    };
  }, [anchorRef, dimensions, width, height]);
  useEffect(() => {
    const layer = floatingRef.current;
    if (!layer) return;
    const trigger = anchorRef.current?.querySelector('button');
    layer.querySelector('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!layer.contains(target) && !anchorRef.current?.contains(target)) {
        // 切到另一视频时立即撤掉旧层，避免两个播放器的进出动画重叠。
        closeRef.current(!(target instanceof Element && target.closest('.resource-video-open')));
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeRef.current();
      } else if (event.key === 'Tab' && layer.contains(document.activeElement)) {
        // 先于宿主模态框处理，避免焦点被其 portal 外部判断拉回列表。
        event.stopPropagation();
        const controls = Array.from(layer.querySelectorAll<HTMLElement>('button, video[controls]'));
        const current = controls.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey ? current <= 0 : current === controls.length - 1) {
          event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
        }
      }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', keyboard, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', keyboard, true);
      if (layer.contains(document.activeElement) && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [anchorRef]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || !present) return;
    let current = true;
    // StrictMode 会先清理再重放 effect，必须与清理移除 src 的动作对称。
    video.src = src;
    void video.play().catch(() => { if (current) setBlocked(true); });
    return () => { current = false; releaseViewportVideoElement(video); };
  }, [src, present]);
  return (
    <div className="resource-video-clip" data-performance-motion="essential" style={geometry.bounds}>
    <motion.div ref={floatingRef} className={`resource-video-floating${present ? '' : ' is-closing'}`} role="dialog" aria-label={`${name} 视频预览`} aria-hidden={!present}
      style={{ left: geometry.left - geometry.bounds.left, top: geometry.top - geometry.bounds.top, width: geometry.width,
        transformOrigin: '0 0', '--resource-video-ratio': `${geometry.width} / ${geometry.height}` } as CSSProperties}
      initial={{ opacity: 0, ...(reduceMotion ? OPEN_TRANSFORM : openingGeometry.thumbnail) }}
      animate={{ opacity: 1, ...OPEN_TRANSFORM }}
      exit={{ ...(reduceMotion ? OPEN_TRANSFORM : geometry.thumbnail), opacity: 0,
        transition: { default: VIDEO_SPRING, opacity: { ...fadeFast, delay: reduceMotion ? 0 : 0.62 } } }}
      transition={{ default: VIDEO_SPRING, opacity: fadeFast }}>
      <div className="resource-video-toolbar">
        <span className="truncate">{name}</span>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={`收起 ${name}`} onClick={() => onEnded()}>收起</button>
      </div>
      {src ? <div className="resource-video-player">
        <video ref={videoRef} src={src} poster={poster} controls playsInline preload="auto" aria-label={`${name} 视频播放`}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0) setDimensions({ width: video.videoWidth, height: video.videoHeight });
          }}
          onEnded={() => onEnded()} onPlay={() => { setBlocked(false); setError(false); }}
          onError={() => { setError(true); setBlocked(true); onSourceError(); }} />
        {blocked && <button type="button" className="ui-btn ui-btn--secondary resource-video-retry"
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            if (video.error || !video.getAttribute('src')) { video.src = src; video.load(); }
            void video.play().catch(() => setBlocked(true));
          }}>{error ? '视频加载失败，点击重试' : '点击播放'}</button>}
      </div> : <div className="resource-video-unavailable">{unavailable ? '视频不可用' : '加载视频…'}</div>}
    </motion.div>
    </div>
  );
}
