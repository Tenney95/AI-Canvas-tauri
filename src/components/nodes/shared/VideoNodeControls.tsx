/**
 * VideoNodeControls — 视频节点内的紧凑播放控制层。
 */
import { memo, useCallback, useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { Icon } from '@iconify/react';

interface VideoNodeControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  source?: string;
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

function VideoNodeControls({ videoRef, source }: VideoNodeControlsProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
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
  }, [source, videoRef]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      void video.play().catch(() => {});
      return;
    }
    video.pause();
  }, [videoRef]);

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

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const audibleVolume = muted ? 0 : volume;

  return (
    <div
      className="video-node-controls nodrag nopan nowheel"
      role="group"
      aria-label="视频播放控制"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <input
        type="range"
        className="video-node-progress"
        min={0}
        max={Math.max(duration, 0.01)}
        step={0.01}
        value={Math.min(currentTime, Math.max(duration, 0.01))}
        disabled={duration <= 0}
        aria-label="视频进度"
        aria-valuetext={`${formatMediaTime(currentTime)} / ${formatMediaTime(duration)}`}
        style={{ '--video-progress': `${progress}%` } as CSSProperties}
        onChange={(event) => handleSeek(Number(event.target.value))}
      />

      <div className="video-node-control-row">
        <button
          type="button"
          className="video-node-control-btn"
          aria-label={isPlaying ? '暂停视频' : '播放视频'}
          onClick={togglePlayback}
        >
          <Icon icon={isPlaying ? 'mdi:pause' : 'mdi:play'} width={15} height={15} />
        </button>

        <span className="video-node-time" aria-live="off">
          {formatMediaTime(currentTime)} / {formatMediaTime(duration)}
        </span>

        <span className="video-node-control-spacer" />

        <button
          type="button"
          className="video-node-control-btn"
          aria-label={muted || volume === 0 ? '取消静音' : '静音'}
          onClick={toggleMuted}
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
          aria-label="视频音量"
          aria-valuetext={`${Math.round(audibleVolume * 100)}%`}
          style={{ '--video-volume': `${audibleVolume * 100}%` } as CSSProperties}
          onChange={(event) => handleVolume(Number(event.target.value))}
        />
      </div>
    </div>
  );
}

export default memo(VideoNodeControls);
