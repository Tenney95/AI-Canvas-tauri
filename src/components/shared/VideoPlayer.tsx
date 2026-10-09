import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type VideoHTMLAttributes } from 'react';
import { Icon } from '@iconify/react';
import { releaseViewportVideoElement } from './viewportVideoResource';

export interface VideoPlayerMetadata { width: number; height: number; duration: number }
export interface VideoPlayerProps {
  src?: string;
  poster?: string;
  name: string;
  autoPlay?: boolean;
  unavailable?: boolean;
  className?: string;
  /** 小型画布播放器；媒体挂载时机仍由宿主决定。 */
  compact?: boolean;
  active?: boolean;
  durationHint?: number;
  mediaRef?: (video: HTMLVideoElement | null) => void;
  crossOrigin?: VideoHTMLAttributes<HTMLVideoElement>['crossOrigin'];
  onLoadedMetadata?: VideoHTMLAttributes<HTMLVideoElement>['onLoadedMetadata'];
  onPlay?: () => void;
  onPause?: () => void;
  onVolumeChange?: (volume: number, muted: boolean) => void;
  onPosterError?: () => void;
  onRequestPlayback?: () => void;
  onFullscreen?: () => void;
  onMetadata?: (metadata: VideoPlayerMetadata) => void;
  onError?: () => void;
  onEnded?: () => void;
  /** 全屏预览宿主可提供关闭入口；普通嵌入不拦截页面 Esc。 */
  onEscape?: () => void;
}

function timeLabel(seconds: number): string {
  const value = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function seekPreview(video: HTMLVideoElement | null, time: number) {
  if (video && video.readyState > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(time, video.duration);
}

function VideoSeekPreview({ src, time }: { src: string; time: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { seekPreview(videoRef.current, time); }, [time, src]);
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.src = src;
    return () => releaseViewportVideoElement(video);
  }, [src]);
  return <div className="ui-video-player__seek-preview" aria-hidden="true">
    {failed ? <span className="text-xs text-canvas-text-muted">预览不可用</span>
      : <video ref={videoRef} src={src} muted playsInline preload="metadata" tabIndex={-1} onLoadedMetadata={(event) => seekPreview(event.currentTarget, time)} onError={() => setFailed(true)} />}
    <span className="ui-video-player__seek-time">{timeLabel(time)}</span>
  </div>;
}

/** UI Kit 视频播放器：调用方提供可播放地址，不依赖 Store、文件服务或生成历史。 */
export default function VideoPlayer({ src, poster, name, autoPlay = false, unavailable = false, className = '', compact = false, active = true, durationHint = 0, mediaRef, crossOrigin, onLoadedMetadata, onPlay, onPause, onVolumeChange, onPosterError, onRequestPlayback, onFullscreen, onMetadata, onError, onEnded, onEscape }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bindVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    mediaRef?.(video);
  }, [mediaRef]);
  const claimedEscape = useRef(false);
  const preferredRate = useRef(1);
  const preferredAudio = useRef({ volume: 1, muted: false });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const progressInputRef = useRef<HTMLInputElement | null>(null);
  const scrubPointerRef = useRef<{ pointerId: number; value: number } | null>(null);
  const finishScrub = useCallback(() => {
    scrubPointerRef.current = null;
    progressRef.current?.classList.remove('is-scrubbing', 'is-scrubbing-forward', 'is-scrubbing-backward');
  }, []);
  const paintProgress = useCallback((video: HTMLVideoElement, position = video.currentTime) => {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const clamped = Math.min(duration, Math.max(0, position));
    progressRef.current?.style.setProperty('--video-played', `${duration ? clamped / duration * 100 : 0}%`);
    if (progressInputRef.current) progressInputRef.current.value = String(clamped);
  }, []);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [menu, setMenu] = useState<'speed' | 'time' | null>(null);
  const [remainingTime, setRemainingTime] = useState(false);
  const [hover, setHover] = useState<{ ratio: number; time: number } | null>(null);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ src: string; width: number; height: number; duration: number } | null>(null);
  const mediaInfo = dimensions?.src === src ? dimensions : null;
  const knownDuration = mediaInfo?.duration ?? durationHint;
  const duration = Number.isFinite(knownDuration) && knownDuration > 0 ? knownDuration : 0;
  const buffered = duration ? Math.min(100, Math.max(time, bufferedEnd) / duration * 100) : 0;
  const silent = muted || volume === 0;
  const changeAudio = (nextVolume: number, nextMuted: boolean) => {
    // 音量设置不依赖媒体实例；封面模式或暂停释放实例后仍可调节，下次挂载再应用。
    preferredAudio.current = { volume: nextVolume, muted: nextMuted };
    setVolume(nextVolume);
    setMuted(nextMuted);
    const video = videoRef.current;
    if (video) { video.volume = nextVolume; video.muted = nextMuted; }
    onVolumeChange?.(nextVolume, nextMuted);
  };
  const updateBuffer = (video: HTMLVideoElement) => {
    let end = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) end = video.buffered.end(i);
    }
    setBufferedEnd(end);
  };
  const play = () => {
    if (!src) return;
    if (!active) { onRequestPlayback?.(); return; }
    const video = videoRef.current; if (!video) return;
    if (video.error || !video.getAttribute('src')) { video.src = src; video.load(); }
    void video.play().catch(() => { if (videoRef.current === video && video.getAttribute('src') === src) setBlocked(true); });
  };
  const fullscreen = () => {
    if (onFullscreen && !document.fullscreenElement) { onFullscreen(); return; }
    const operation = document.fullscreenElement ? document.exitFullscreen?.() : stageRef.current?.requestFullscreen?.();
    if (operation) void operation.catch(() => setFullscreenError(true));
    else setFullscreenError(true);
  };

  useEffect(() => () => finishScrub(), [src, active, finishScrub]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let current = true;
    // 清理移除 src，StrictMode 重放时必须重新恢复。
    video.src = src;
    video.playbackRate = preferredRate.current;
    video.volume = preferredAudio.current.volume;
    video.muted = preferredAudio.current.muted;
    if (autoPlay) void video.play().catch(() => { if (current) setBlocked(true); });
    return () => { current = false; releaseViewportVideoElement(video); };
  }, [src, autoPlay, active]);

  // 子播放器先登记释放键处理，避免蒙层把收起菜单或退出原生全屏的 Esc 当成关闭预览。
  useLayoutEffect(() => {
    if (!active) return;
    const release = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && claimedEscape.current) {
        claimedEscape.current = false;
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keyup', release, true);
    return () => window.removeEventListener('keyup', release, true);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      // 仅处理自己的全屏或菜单；嵌入页面时不抢占其他组件的 Esc。
      const fullscreenElement = document.fullscreenElement;
      if (fullscreenElement) {
        if (fullscreenElement === stageRef.current || stageRef.current?.contains(fullscreenElement)) {
          claimedEscape.current = true;
          event.stopImmediatePropagation();
        }
        return;
      }
      if (!onEscape && !stageRef.current?.contains(event.target as Node)) return;
      if (!menu && !onEscape) return;
      event.preventDefault(); event.stopImmediatePropagation();
      claimedEscape.current = true;
      if (menu) { setMenu(null); controlsRef.current?.querySelector<HTMLButtonElement>(`[data-video-${menu}-trigger]`)?.focus(); }
      else onEscape?.();
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [onEscape, menu, active]);

  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video || !src) return;
    let frame: number | null = null;
    let mediaTime = video.currentTime;
    let sampledAt = performance.now();
    let visualTime = mediaTime;
    const sync = () => {
      mediaTime = video.currentTime;
      sampledAt = performance.now();
      visualTime = mediaTime;
      paintProgress(video, visualTime);
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      sync();
    };
    const refresh = (now: number) => {
      frame = null;
      if (video.paused || video.ended || video.seeking || video.readyState < 3) { sync(); return; }
      if (scrubPointerRef.current) { frame = requestAnimationFrame(refresh); return; }
      if (video.currentTime !== mediaTime) {
        mediaTime = video.currentTime;
        sampledAt = now;
      }
      // 媒体时钟可能分段更新；按真实倍速补齐采样间隙，最多领先 250ms，避免停滞时持续前进。
      const elapsed = Math.max(0, (now - sampledAt) / 1000);
      const lead = Math.min(0.25, elapsed * video.playbackRate);
      visualTime = Math.min(mediaTime + 0.25, Math.max(visualTime, mediaTime + lead));
      paintProgress(video, visualTime);
      frame = requestAnimationFrame(refresh);
    };
    const start = () => {
      stop();
      if (!video.paused && !video.ended && !video.seeking && video.readyState >= 3) frame = requestAnimationFrame(refresh);
    };
    const resumeEvents = ['playing', 'seeked', 'ratechange', 'canplay'];
    const stopEvents = ['pause', 'ended', 'waiting', 'seeking', 'emptied', 'error'];
    resumeEvents.forEach((event) => video.addEventListener(event, start));
    stopEvents.forEach((event) => video.addEventListener(event, stop));
    video.addEventListener('loadedmetadata', sync);
    start();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resumeEvents.forEach((event) => video.removeEventListener(event, start));
      stopEvents.forEach((event) => video.removeEventListener(event, stop));
      video.removeEventListener('loadedmetadata', sync);
    };
  }, [src, active, paintProgress]);

  useEffect(() => {
    if (!menu) return;
    popupRef.current?.querySelector<HTMLElement>(menu === 'speed' ? 'input' : '[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      // 按钮等交互目标先完成自己的点击；例如关闭预览不应被收起菜单打断。
      if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) return;
      if (!controlsRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [menu]);

  return (
    <div ref={stageRef} className={`ui-video-player${compact ? ' ui-video-player--compact' : ''} ${className}`} aria-label={`${name} 视频播放器`}>
        <div className="ui-video-player__view">
        {src && active ? <>
          <video ref={bindVideo} src={src} poster={poster} crossOrigin={crossOrigin} playsInline preload="auto" aria-label={`${name} 视频播放`}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setDimensions({ src, width: video.videoWidth, height: video.videoHeight, duration: video.duration });
              updateBuffer(video);
              onMetadata?.({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
              onLoadedMetadata?.(event);
            }}
            onTimeUpdate={(event) => { setTime(event.currentTarget.currentTime); updateBuffer(event.currentTarget); }}
            onProgress={(event) => updateBuffer(event.currentTarget)}
            onPlay={() => { setPlaying(true); setBlocked(false); setFailed(null); onPlay?.(); }}
            onPause={(event) => { setPlaying(false); setTime(event.currentTarget.currentTime); setMenu(null); onPause?.(); }}
            onEnded={(event) => { setPlaying(false); setTime(event.currentTarget.currentTime); onEnded?.(); }}
            onSeeking={(event) => setTime(event.currentTarget.currentTime)}
            onSeeked={(event) => setTime(event.currentTarget.currentTime)}
            onVolumeChange={(event) => {
              const video = event.currentTarget;
              preferredAudio.current = { volume: video.volume, muted: video.muted };
              setMuted(video.muted); setVolume(video.volume);
              onVolumeChange?.(video.volume, video.muted);
            }}
            onRateChange={(event) => { preferredRate.current = event.currentTarget.playbackRate; setRate(event.currentTarget.playbackRate); }}
            onError={() => { setPlaying(false); setFailed(src); setBlocked(true); onError?.(); }} />
          {(blocked || failed === src) && <button type="button" className="ui-btn ui-video-player__retry" onClick={play}>{failed === src ? '视频加载失败，点击重试' : '点击播放'}</button>}
        </> : src && poster ? <img src={poster} alt="" draggable={false} onError={onPosterError} />
          : <p role="status" className="text-xs text-canvas-text-muted">{unavailable ? '视频不可用' : src && !active ? '点击播放' : '加载视频…'}</p>}
        </div>
        <div ref={controlsRef} className={`ui-video-player__controls nodrag nopan ${compact ? 'p-2' : 'p-3'}`} aria-label="视频播放控件"
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          <div ref={progressRef} className="ui-video-player__progress" style={{ '--video-buffered': `${buffered}%` } as CSSProperties}
            onPointerMove={(event) => {
              if (!active || compact || !duration || !src || event.pointerType === 'touch') return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
              setHover({ ratio, time: Math.round(ratio * duration * 5) / 5 });
            }} onPointerLeave={() => setHover(null)}>
          <div className="ui-video-player__progress-track" aria-hidden="true"><span className="ui-video-player__progress-empty" /><span className="ui-video-player__progress-buffer" /><span className="ui-video-player__progress-played" /></div>
          {duration > 0 && <span className="ui-video-player__progress-marker" aria-hidden="true" />}
          <input ref={progressInputRef} type="range" data-native-range className="ui-video-player__range-hit" min={0} max={duration || 1} step={0.01} defaultValue={0} disabled={!duration || !active}
            aria-label="播放进度" aria-valuetext={`${timeLabel(time)} / ${timeLabel(duration)}`}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.currentTarget.disabled || scrubPointerRef.current) return;
              scrubPointerRef.current = { pointerId: event.pointerId, value: Number(event.currentTarget.value) };
              progressRef.current?.classList.add('is-scrubbing');
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerUp={(event) => { if (scrubPointerRef.current?.pointerId === event.pointerId) finishScrub(); }}
            onPointerCancel={finishScrub} onLostPointerCapture={finishScrub} onBlur={finishScrub}
            onChange={(event) => {
              const position = Number(event.currentTarget.value);
              const scrub = scrubPointerRef.current;
              if (scrub && position !== scrub.value) {
                progressRef.current?.classList.toggle('is-scrubbing-forward', position > scrub.value);
                progressRef.current?.classList.toggle('is-scrubbing-backward', position < scrub.value);
                scrub.value = position;
              }
              const video = videoRef.current;
              if (video && duration) { video.currentTime = position; paintProgress(video); setTime(video.currentTime); }
            }} />
          {hover && src && <div className="ui-video-player__seek-anchor" style={{ '--video-hover': `${hover.ratio * 100}%` } as CSSProperties}><VideoSeekPreview key={src} src={src} time={hover.time} /></div>}
          </div>
          <div className="ui-video-player__control-row">
            <div className="ui-video-player__control-left">
              <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control" aria-label={active && playing ? '暂停视频' : '播放视频'} disabled={!src}
                onClick={() => { if (!videoRef.current || videoRef.current.paused) play(); else videoRef.current.pause(); }}><Icon icon={active && playing ? 'lucide:pause' : 'lucide:play'} className="ui-video-player__play-icon" aria-hidden="true" /></button>
              <div className="ui-video-player__control-anchor">
                <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control ui-video-player__speed-trigger" data-video-speed-trigger
                  aria-label="播放速度" aria-haspopup="dialog" aria-expanded={menu === 'speed'} disabled={!src || !active} onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>{rate}×</button>
                {menu === 'speed' && <div ref={popupRef} className="ui-menu ui-menu--up ui-video-player__speed-popover p-3" role="dialog" aria-label="播放速度设置">
                  <h2 className="pb-3 text-sm font-semibold text-canvas-text">播放速度</h2>
                  <div className="ui-video-player__speed-options">{[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => <button type="button" key={value}
                    className={`ui-btn ui-btn--ghost ui-video-player__speed-option${rate === value ? ' is-selected' : ''}`} aria-label={`${value} 倍速`} aria-pressed={rate === value}
                    onClick={() => { if (videoRef.current) videoRef.current.playbackRate = value; }}>{value}</button>)}</div>
                  <div className="ui-video-player__value-track" style={{ '--video-value': `${(rate - 0.25) / 1.75 * 100}%` } as CSSProperties}><span aria-hidden="true" className="ui-video-player__value-fill" /><span aria-hidden="true" className="ui-video-player__value-marker" />
                    <input className="ui-video-player__range-hit" type="range" data-native-range min={0.25} max={2} step={0.25} value={rate} aria-label="调整播放速度"
                      onChange={(event) => { if (videoRef.current) videoRef.current.playbackRate = Number(event.currentTarget.value); }} />
                  </div>
                </div>}
              </div>
              <div className="ui-video-player__volume">
                <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control" aria-label={silent ? '取消静音' : '静音视频'} disabled={!src}
                  onClick={() => changeAudio(silent && !volume ? 1 : volume, !silent)}><Icon icon={silent ? 'lucide:volume-x' : 'lucide:volume-2'} aria-hidden="true" /></button>
                <input className="ui-slider ui-video-player__volume-track" type="range" min={0} max={1} step={0.01} value={silent ? 0 : volume} aria-label="视频音量" disabled={!src}
                  style={{ '--range-progress': `${silent ? 0 : volume * 100}%` } as CSSProperties}
                  onChange={(event) => { const nextVolume = Number(event.currentTarget.value); changeAudio(nextVolume, nextVolume === 0); }} />
              </div>
            </div>
            <div className="ui-video-player__time-format ui-video-player__control-anchor">
              <time className="text-sm font-medium tabular-nums text-canvas-text">{remainingTime ? `-${timeLabel(duration - time)}` : timeLabel(time)} / {timeLabel(duration)}</time>
              <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control ui-video-player__time-trigger" data-video-time-trigger aria-label="时间显示格式" aria-haspopup="menu" aria-expanded={menu === 'time'} onClick={() => setMenu(menu === 'time' ? null : 'time')}><Icon icon="lucide:chevron-down" aria-hidden="true" /></button>
              {menu === 'time' && <div ref={popupRef} className="ui-menu ui-menu--up ui-video-player__time-popover" role="menu" aria-label="时间显示格式选项"
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                  const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
                  const index = options.indexOf(event.target as HTMLButtonElement);
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                  event.preventDefault(); event.stopPropagation(); options[next]?.focus();
                }}>
                {[false, true].map((value) => <button type="button" key={String(value)} className={`ui-menu__item${remainingTime === value ? ' is-active' : ''}`} role="menuitemradio" aria-checked={remainingTime === value}
                  onClick={() => { setRemainingTime(value); setMenu(null); controlsRef.current?.querySelector<HTMLButtonElement>('[data-video-time-trigger]')?.focus(); }}>{value ? '剩余时间 / 总时长' : '已播放 / 总时长'}</button>)}
              </div>}
            </div>
            <div className="flex justify-end"><button type="button" className="ui-btn ui-btn--ghost ui-video-player__control ui-video-player__fullscreen-control" aria-label="全屏播放视频" onClick={fullscreen}><Icon icon="lucide:expand" aria-hidden="true" /></button></div>
          </div>
          {fullscreenError && <p role="status" className="pt-2 text-xs text-canvas-text-secondary">此窗口暂不支持播放器全屏</p>}
        </div>
      </div>
  );
}
