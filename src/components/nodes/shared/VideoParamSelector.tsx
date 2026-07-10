/**
 * VideoParamSelector 视频参数选择器
 * - volcengine provider → Seedance 参数（分辨率、宽高比、时长、有声视频）
 * - 其他 provider → ComfyUI / RunningHub 参数（像素分辨率、帧率、帧数）
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import AnimatedButton from '../../shared/AnimatedButton';

interface VideoParamSelectorProps {
  provider?: string;
  // ── ComfyUI / RunningHub ──
  videoResolution?: number;
  videoFps?: number;
  videoFrames?: number;
  onChangeResolution?: (value: number) => void;
  onChangeFps?: (value: number) => void;
  onChangeFrames?: (value: number) => void;
  // ── Seedance ──
  seedanceResolution?: string;
  seedanceRatio?: string;
  seedanceDuration?: number;
  generateAudio?: boolean;
  onChangeSeedanceResolution?: (value: string) => void;
  onChangeSeedanceRatio?: (value: string) => void;
  onChangeSeedanceDuration?: (value: number) => void;
  onChangeGenerateAudio?: (value: boolean) => void;
}

const SEEDANCE_RESOLUTIONS = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '4k', label: '4K' },
];

const SEEDANCE_RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
  { value: 'adaptive', label: '自适应' },
];

const COMBO_RESOLUTIONS = [832, 1024, 1280, 1440];
const COMBO_FPS_OPTIONS = [
  { value: 16, label: '16帧' },
  { value: 24, label: '24帧' },
  { value: 30, label: '30帧' },
];

export default function VideoParamSelector({
  provider,
  videoResolution = 832, videoFps = 24, videoFrames = 77,
  onChangeResolution, onChangeFps, onChangeFrames,
  seedanceResolution = '720p', seedanceRatio = '16:9',
  seedanceDuration = 5, generateAudio = false,
  onChangeSeedanceResolution, onChangeSeedanceRatio,
  onChangeSeedanceDuration, onChangeGenerateAudio,
}: VideoParamSelectorProps) {
  const [open, setOpen] = useState(false);
  const [editingFrames, setEditingFrames] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const framesInputRef = useRef<HTMLInputElement>(null);

  const isSeedance = provider === 'volcengine' || provider === 'dreamina';
  const isVolcengine = provider === 'volcengine';

  // Close popup on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open]);

  // Close popup on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // ── ComfyUI 帧数编辑 ──
  const handleFramesBlur = useCallback(() => {
    if (editingFrames === null) return;
    const val = parseInt(editingFrames, 10);
    if (!isNaN(val) && val >= 0 && val <= 999999) onChangeFrames?.(val);
    setEditingFrames(null);
  }, [editingFrames, onChangeFrames]);

  const handleFramesKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleFramesBlur();
    },
    [handleFramesBlur],
  );

  // ── 触发按钮文案 ──
  const triggerLabel = isSeedance
    ? `时长${seedanceDuration}s · ${seedanceRatio}`
    : `帧数${videoFrames} · 帧率${videoFps} · 分辨率${videoResolution}`;

  return (
    <div className="ui-schema-renderer" data-ui-schema-placement="videoParams" ref={ref}>
      <div className="ui-schema-quality-ratio-pill">
        <AnimatedButton
          type="button"
          className="img-pill-btn ui-schema-menu-trigger"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
          <span className="ui-schema-pill-label ui-schema-quality-ratio-label">{triggerLabel}</span>
        </AnimatedButton>

        {open && (
          <div className="img-ratio-popup ui-schema-popup ui-schema-video-params-popup" style={{ display: 'block' }}>
            {isSeedance ? (
              <>
                {/* Seedance 分辨率 */}
                <div className="img-rp-quality-area mb-2">
                  <div className="img-rp-section-label">
                    分辨率
                    <span className="rh-tip" data-tooltip="分辨率越高细节越清晰，但生成耗时会明显增加。4K 仅 Seedance 2.0 支持。">!</span>
                  </div>
                  <div className="img-rp-quality-segmented rh-video-resolution-seg">
                    {SEEDANCE_RESOLUTIONS.map((opt) => (
                      <AnimatedButton
                        key={opt.value}
                        type="button"
                        className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${seedanceResolution === opt.value ? 'active' : ''}`}
                        onClick={() => onChangeSeedanceResolution?.(opt.value)}
                      >
                        {opt.label}
                      </AnimatedButton>
                    ))}
                  </div>
                </div>

                {/* Seedance 宽高比 */}
                <div className="img-rp-quality-area mb-2">
                  <div className="img-rp-section-label">
                    宽高比
                    <span className="rh-tip" data-tooltip="决定输出视频的画面比例。自适应 = 由模型智能决定。">!</span>
                  </div>
                  <div className="img-rp-quality-segmented rh-video-resolution-seg">
                    {SEEDANCE_RATIOS.map((opt) => (
                      <AnimatedButton
                        key={opt.value}
                        type="button"
                        className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${seedanceRatio === opt.value ? 'active' : ''}`}
                        onClick={() => onChangeSeedanceRatio?.(opt.value)}
                      >
                        {opt.label}
                      </AnimatedButton>
                    ))}
                  </div>
                </div>

                {/* Seedance 时长 */}
                <div className="rh-v5-meta-panel">
                  <div className="rh-vram-adv-row">
                    <div className="rh-vram-adv-label">
                      <span>生成时长（秒）</span>
                      <span className="rh-tip" data-tooltip="整数秒，范围 2-15。值越大视频越长、耗时越高。">!</span>
                    </div>
                    <div className="rh-duration-slider">
                      <div className="rh-duration-track">
                        <div
                          className="rh-duration-fill"
                          style={{ width: `${((seedanceDuration - 2) / 13) * 100}%` }}
                        />
                        <input
                          type="range"
                          className="rh-duration-input"
                          min={2}
                          max={15}
                          step={1}
                          value={seedanceDuration}
                          onChange={(e) => onChangeSeedanceDuration?.(Number(e.target.value))}
                        />
                      </div>
                      <div className="rh-duration-labels">
                        {[2, 5, 8, 10, 12, 15].map((v) => (
                          <span key={v} className={`rh-duration-tick ${seedanceDuration >= v ? 'active' : ''}`} onClick={() => onChangeSeedanceDuration?.(v)}>
                            {v}s
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>


                  {/* 有声视频开关 — 仅火山方舟 API 支持 */}
                  {isVolcengine && (
                  <div className="rh-vram-adv-row">
                    <div className="rh-vram-adv-label" style={{ justifyContent: 'space-between', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>生成有声视频</span>
                        <span className="rh-tip" data-tooltip="开启后 Seedance 会同时生成配乐（仅 Seedance 2.0 / 1.5 pro 支持）。">!</span>
                      </div>
                      <label className="rh-toggle-switch">
                        <input
                          type="checkbox"
                          checked={generateAudio}
                          onChange={(e) => onChangeGenerateAudio?.(e.target.checked)}
                        />
                        <span className="rh-toggle-track">
                          <span className="rh-toggle-knob" />
                        </span>
                      </label>
                    </div>
                  </div>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* ComfyUI / RunningHub 分辨率 */}
                <div className="img-rp-quality-area mb-2" data-ui-schema-field="rhVideoResolution" data-ui-schema-type="segmented" data-ui-schema-value-type="number" data-ui-schema-default="832">
                  <div className="img-rp-section-label">
                    分辨率
                    <span className="rh-tip" data-tooltip="分辨率越高细节越清晰、边缘更稳定。同时显存占用与生成耗时会明显增加。">!</span>
                  </div>
                  <div className="img-rp-quality-segmented rh-video-resolution-seg">
                    {COMBO_RESOLUTIONS.map((res) => (
                      <AnimatedButton
                        key={res}
                        type="button"
                        className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${videoResolution === res ? 'active' : ''}`}
                        data-value={res}
                        data-ui-schema-value={res}
                        onClick={() => onChangeResolution?.(res)}
                      >
                        {res}
                      </AnimatedButton>
                    ))}
                  </div>
                </div>

                {/* 帧率 & 帧数 */}
                <div className="rh-v5-meta-panel">
                  <div className="rh-vram-adv-row">
                    <div className="rh-vram-adv-label">
                      <span>帧率</span>
                      <span className="rh-tip" data-tooltip="帧率越高运动更顺滑、动作更连贯。但生成更慢、成本更高。常用 24 帧。">!</span>
                    </div>
                    <div className="img-rp-quality-segmented rh-adv-seg rh-v5-fps-seg">
                      {COMBO_FPS_OPTIONS.map((opt) => (
                        <AnimatedButton
                          key={opt.value}
                          type="button"
                          className={`img-rp-quality-item rh-v5-fps-btn ui-schema-option ${videoFps === opt.value ? 'active' : ''}`}
                          data-value={opt.value}
                          data-ui-schema-value={opt.value}
                          onClick={() => onChangeFps?.(opt.value)}
                        >
                          {opt.label}
                        </AnimatedButton>
                      ))}
                    </div>
                  </div>

                  <div className="rh-vram-adv-row ui-schema-rh-video-stepper" data-ui-schema-field="rhVideoFrames" data-ui-schema-type="stepper">
                    <div className="rh-vram-adv-label">
                      <span>生成时长（帧数）</span>
                      <span className="rh-tip" data-tooltip="帧数决定生成片段的长度：数值越大视频越长、耗时越高。填 0 表示按源视频全长处理。">!</span>
                      <div className="rh-stepper rh-v5-frames-stepper">
                        <div className="rh-v5-source-framecount" aria-label="源视频总帧数">—</div>
                        {editingFrames !== null ? (
                          <input
                            ref={framesInputRef}
                            type="number"
                            className="rh-stepper-value rh-stepper-input"
                            min={0} max={999999} step={1}
                            value={editingFrames}
                            onChange={(e) => setEditingFrames(e.target.value)}
                            onBlur={handleFramesBlur}
                            onKeyDown={handleFramesKeyDown}
                            autoFocus
                          />
                        ) : (
                          <div
                            className="rh-stepper-value" role="spinbutton"
                            aria-label="生成帧数" aria-valuenow={videoFrames} tabIndex={0}
                            onClick={() => {
                              setEditingFrames(String(videoFrames));
                              setTimeout(() => framesInputRef.current?.focus(), 0);
                            }}
                          >
                            {videoFrames}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
