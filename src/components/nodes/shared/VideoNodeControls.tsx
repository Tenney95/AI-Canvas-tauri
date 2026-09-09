/**
 * VideoNodeControls — 视频节点内的紧凑播放控制层。
 */
import { memo, useCallback, useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../../i18n';

interface VideoNodeControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  source?: string;
  onInteract?: () => void;
  active?: boolean;
  durationHint?: number;
  onRequestPlayback?: () => void;
}

function formatMediaTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function VideoNodeControls({ videoRef, source, onInteract, active = true, durationHint = 0, onRequestPlayback }: VideoNodeControlsProps) {
  const t = useT();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;

    const syncPlayback = () => setIsPlaying(!video.paused && !video.ended);
    const syncTime = () => setCurrentTime(video.currentTime || 0);
    const syncDuration = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const syncVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    syncPlayback();
    syncTime();
    syncDuration();
    syncVolume();
    video.addEventListener('play', syncPlayback);
    video.addEventListener('pause', syncPlayback);
    video.addEventListener('ended', syncPlayback);
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('loadedmetadata', syncDuration);
    video.addEventListener('durationchange', syncDuration);
    video.addEventListener('volumechange', syncVolume);
    return () => {
      video.removeEventListener('play', syncPlayback);
      video.removeEventListener('pause', syncPlayback);
      video.removeEventListener('ended', syncPlayback);
      video.removeEventListener('timeupdate', syncTime);
      video.removeEventListener('loadedmetadata', syncDuration);
      video.removeEventListener('durationchange', syncDuration);
      video.removeEventListener('volumechange', syncVolume);
    };
  }, [source, videoRef, active]);

  const togglePlayback = useCallback(() => {
    if (!active) { onRequestPlayback?.(); return; }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      void video.play().catch(() => {});
      return;
    }
    video.pause();
  }, [videoRef, active, onRequestPlayback]);

  const handleSeek = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value)) return;
    video.currentTime = value;
    setCurrentTime(value);
  }, [videoRef]);

  const toggleMuted = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.muted && video.volume === 0) video.volume = 0.7;
    video.muted = !video.muted;
  }, [videoRef]);

  const handleVolume = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value)) return;
    video.volume = value;
    video.muted = value === 0;
  }, [videoRef]);

  const displayedDuration = active ? duration : durationHint;
  const displayedTime = active ? currentTime : 0;
  const progress = displayedDuration > 0 ? Math.min(100, (displayedTime / displayedDuration) * 100) : 0;
  const audibleVolume = muted ? 0 : volume;

  return (
    <div
      className="video-node-controls nodrag nopan nowheel"
      role="group"
      aria-label={t('视频播放控制')}
      onPointerDown={(event) => {
        event.stopPropagation();
        onInteract?.();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <input
        type="range"
        className="video-node-progress"
        min={0}
        max={Math.max(displayedDuration, 0.01)}
        step={0.01}
        value={Math.min(displayedTime, Math.max(displayedDuration, 0.01))}
        disabled={!active || displayedDuration <= 0}
        aria-label={t('视频进度')}
        aria-valuetext={`${formatMediaTime(displayedTime)} / ${formatMediaTime(displayedDuration)}`}
        style={{ '--video-progress': `${progress}%` } as CSSProperties}
        onChange={(event) => handleSeek(Number(event.target.value))}
      />

      <div className="video-node-control-row">
        <button
          type="button"
          className="video-node-control-btn"
          aria-label={active && isPlaying ? t('暂停视频') : t('播放视频')}
          onClick={togglePlayback}
        >
          <Icon icon={active && isPlaying ? 'mdi:pause' : 'mdi:play'} width={15} height={15} />
        </button>

        <span className="video-node-time" aria-live="off">
          {formatMediaTime(displayedTime)} / {formatMediaTime(displayedDuration)}
        </span>

        <span className="video-node-control-spacer" />

        <button
          type="button"
          className="video-node-control-btn"
          aria-label={muted || volume === 0 ? t('取消静音') : t('静音')}
          onClick={toggleMuted}
          disabled={!active}
        >
          <Icon icon={muted || volume === 0 ? 'mdi:volume-off' : 'mdi:volume-high'} width={15} height={15} />
        </button>

        <input
          type="range"
          className="video-node-volume"
          min={0}
          max={1}
          step={0.05}
          value={audibleVolume}
          aria-label={t('视频音量')}
          aria-valuetext={`${Math.round(audibleVolume * 100)}%`}
          style={{ '--video-volume': `${audibleVolume * 100}%` } as CSSProperties}
          onChange={(event) => handleVolume(Number(event.target.value))}
          disabled={!active}
        />
      </div>
    </div>
  );
}

export default memo(VideoNodeControls);
