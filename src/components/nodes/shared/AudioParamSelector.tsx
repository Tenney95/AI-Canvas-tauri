import { Icon } from '@iconify/react';
import { memo, useEffect, useRef, useState } from 'react';
import type { AudioOutputFormat, AudioTtsVoice } from '../../../types/aiTypes';
import type { AudioGenerationPurpose } from '../../../types/media';
import AnimatedButton from '../../shared/AnimatedButton';

interface AudioParamSelectorProps {
  purpose?: AudioGenerationPurpose;
  voice?: AudioTtsVoice;
  format?: AudioOutputFormat;
  speed?: number;
  musicTitle?: string;
  musicLyrics?: string;
  musicBpm?: number;
  musicDuration?: number;
  autoGenerateLyrics?: boolean;
  onChangeVoice?: (value: AudioTtsVoice) => void;
  onChangeFormat?: (value: AudioOutputFormat) => void;
  onChangeSpeed?: (value: number) => void;
  onChangeMusicTitle?: (value: string) => void;
  onChangeMusicLyrics?: (value: string) => void;
  onChangeMusicBpm?: (value: number | undefined) => void;
  onChangeMusicDuration?: (value: number) => void;
  onChangeAutoGenerateLyrics?: (value: boolean) => void;
  onContinuousEditEnd?: () => void;
}

const VOICES: Array<{ value: AudioTtsVoice; label: string }> = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'echo', label: 'Echo' },
  { value: 'fable', label: 'Fable' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'nova', label: 'Nova' },
  { value: 'shimmer', label: 'Shimmer' },
];

const FORMATS: AudioOutputFormat[] = ['wav', 'opus', 'aac', 'flac', 'pcm'];

function AudioParamSelector({
  purpose,
  voice = 'alloy',
  format = 'wav',
  speed = 1,
  musicTitle = '',
  musicLyrics = '',
  musicBpm,
  musicDuration = 60,
  autoGenerateLyrics = false,
  onChangeVoice,
  onChangeFormat,
  onChangeSpeed,
  onChangeMusicTitle,
  onChangeMusicLyrics,
  onChangeMusicBpm,
  onChangeMusicDuration,
  onChangeAutoGenerateLyrics,
  onContinuousEditEnd,
}: AudioParamSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick, true);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  if (!purpose) return null;

  const triggerLabel = purpose === 'speech'
    ? `${voice} · ${format.toUpperCase()} · ${speed}x`
    : `${musicDuration}s${musicBpm ? ` · ${musicBpm} BPM` : ''}`;

  return (
    <div className="ui-schema-renderer" data-ui-schema-placement="audioParams" ref={ref}>
      <div className="ui-schema-quality-ratio-pill">
        <AnimatedButton
          type="button"
          className="img-pill-btn ui-schema-menu-trigger"
          aria-expanded={open}
          data-tooltip={purpose === 'speech' ? '语音参数' : '音乐参数'}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          <Icon icon={purpose === 'speech' ? 'mdi:account-voice' : 'mdi:music-note'} width={13} />
          <span className="ui-schema-pill-label ui-schema-quality-ratio-label">{triggerLabel}</span>
        </AnimatedButton>

        {open ? (
          <div className="img-ratio-popup ui-schema-popup ui-schema-video-params-popup block">
            {purpose === 'speech' ? (
              <div className="rh-v5-meta-panel">
                <label className="rh-vram-adv-row">
                  <span className="rh-vram-adv-label">音色</span>
                  <select
                    className="w-full rounded-md border border-canvas-border bg-canvas-bg px-2 py-1.5 text-xs text-canvas-text outline-none focus:border-orange-400"
                    value={voice}
                    onChange={(event) => onChangeVoice?.(event.target.value as AudioTtsVoice)}
                  >
                    {VOICES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>

                <div className="img-rp-quality-area">
                  <div className="img-rp-section-label">输出格式</div>
                  <div className="img-rp-quality-segmented rh-video-resolution-seg">
                    {FORMATS.map((item) => (
                      <AnimatedButton
                        key={item}
                        type="button"
                        className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${format === item ? 'active' : ''}`}
                        onClick={() => onChangeFormat?.(item)}
                      >
                        {item.toUpperCase()}
                      </AnimatedButton>
                    ))}
                  </div>
                </div>

                <label className="rh-vram-adv-row">
                  <span className="rh-vram-adv-label">语速 {speed}x</span>
                  <input
                    type="range"
                    className="rh-duration-input"
                    min={0.25}
                    max={4}
                    step={0.05}
                    value={speed}
                    onChange={(event) => onChangeSpeed?.(Number(event.target.value))}
                    onBlur={onContinuousEditEnd}
                  />
                </label>
              </div>
            ) : (
              <div className="rh-v5-meta-panel">
                <label className="rh-vram-adv-row">
                  <span className="rh-vram-adv-label">标题</span>
                  <input
                    className="w-full rounded-md border border-canvas-border bg-canvas-bg px-2 py-1.5 text-xs text-canvas-text outline-none focus:border-orange-400"
                    value={musicTitle}
                    maxLength={120}
                    onChange={(event) => onChangeMusicTitle?.(event.target.value)}
                    onBlur={onContinuousEditEnd}
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="rh-vram-adv-row">
                    <span className="rh-vram-adv-label">BPM</span>
                    <input
                      type="number"
                      className="w-full rounded-md border border-canvas-border bg-canvas-bg px-2 py-1.5 text-xs text-canvas-text outline-none focus:border-orange-400"
                      min={1}
                      value={musicBpm ?? ''}
                      onChange={(event) => {
                        const value = event.target.value ? Number(event.target.value) : undefined;
                        onChangeMusicBpm?.(value);
                      }}
                      onBlur={onContinuousEditEnd}
                    />
                  </label>
                  <label className="rh-vram-adv-row">
                    <span className="rh-vram-adv-label">时长 {musicDuration}s</span>
                    <input
                      type="range"
                      className="rh-duration-input"
                      min={1}
                      max={240}
                      step={1}
                      value={musicDuration}
                      onChange={(event) => onChangeMusicDuration?.(Number(event.target.value))}
                      onBlur={onContinuousEditEnd}
                    />
                  </label>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <span className="rh-vram-adv-label">自动生成歌词</span>
                  <label className="rh-toggle-switch" data-tooltip="先生成歌词，再继续生成音乐">
                    <input
                      type="checkbox"
                      checked={autoGenerateLyrics}
                      onChange={(event) => onChangeAutoGenerateLyrics?.(event.target.checked)}
                    />
                    <span className="rh-toggle-track"><span className="rh-toggle-knob" /></span>
                  </label>
                </div>

                {!autoGenerateLyrics ? (
                  <label className="rh-vram-adv-row">
                    <span className="rh-vram-adv-label">歌词</span>
                    <textarea
                      className="min-h-24 w-full resize-y rounded-md border border-canvas-border bg-canvas-bg px-2 py-1.5 text-xs leading-5 text-canvas-text outline-none focus:border-orange-400"
                      value={musicLyrics}
                      onChange={(event) => onChangeMusicLyrics?.(event.target.value)}
                      onBlur={onContinuousEditEnd}
                    />
                  </label>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default memo(AudioParamSelector);
