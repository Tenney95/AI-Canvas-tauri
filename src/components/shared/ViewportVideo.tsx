import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type ForwardedRef,
  type VideoHTMLAttributes,
} from 'react';
import { useViewportMediaSource } from '../../hooks/useViewportMediaSource';
import { releaseViewportVideoElement } from './viewportVideoResource';

interface ViewportVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> {
  src?: string;
  eager?: boolean;
  rootMargin?: string;
  unloadDelayMs?: number;
}

function assignForwardedRef(
  ref: ForwardedRef<HTMLVideoElement>,
  value: HTMLVideoElement | null,
): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

const ViewportVideo = forwardRef<HTMLVideoElement, ViewportVideoProps>(function ViewportVideo({
  src,
  eager = false,
  rootMargin = '800px 0px',
  unloadDelayMs = 2_000,
  preload = 'metadata',
  ...videoProps
}, forwardedRef) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasMountedSourceRef = useRef(false);
  const mountedSrc = useViewportMediaSource(src, videoRef, { eager, rootMargin, unloadDelayMs });
  const setVideoRef = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    assignForwardedRef(forwardedRef, video);
  }, [forwardedRef]);

  useEffect(() => {
    if (mountedSrc) {
      hasMountedSourceRef.current = true;
      return;
    }
    if (hasMountedSourceRef.current) {
      releaseViewportVideoElement(videoRef.current);
      hasMountedSourceRef.current = false;
    }
  }, [mountedSrc]);

  useEffect(() => () => {
    if (hasMountedSourceRef.current) releaseViewportVideoElement(videoRef.current);
    hasMountedSourceRef.current = false;
  }, []);

  return (
    <video
      {...videoProps}
      ref={setVideoRef}
      src={mountedSrc}
      preload={preload}
      data-viewport-video={mountedSrc ? 'loaded' : 'deferred'}
    />
  );
});

export default ViewportVideo;
