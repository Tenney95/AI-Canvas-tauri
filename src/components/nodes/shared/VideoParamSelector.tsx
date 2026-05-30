/**
 * VideoParamSelector 视频参数选择器 — 弹出面板配置视频分辨率、帧率、帧数等生成参数
 */
import { useState, useRef, useEffect, useCallback } from 'react';

interface VideoParamSelectorProps {
  videoResolution?: number;
  videoFps?: number;
  videoFrames?: number;
  onChangeResolution: (value: number) => void;
  onChangeFps: (value: number) => void;
  onChangeFrames: (value: number) => void;
}

export default function VideoParamSelector({
  videoResolution = 832,
  videoFps = 24,
  videoFrames = 77,
  onChangeResolution,
  onChangeFps,
  onChangeFrames,
}: VideoParamSelectorProps) {
  const [open, setOpen] = useState(false);
  const [editingFrames, setEditingFrames] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const framesInputRef = useRef<HTMLInputElement>(null);

  // Close popup on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler);
    }
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close popup on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    if (open) {
      window.addEventListener('keydown', handler);
    }
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const resolutions = [832, 1024, 1280, 1440];
  const fpsOptions = [
    { value: 16, label: '16帧' },
    { value: 24, label: '24帧' },
    { value: 30, label: '30帧' },
  ];

  const handleFramesBlur = useCallback(() => {
    if (editingFrames === null) return;
    const val = parseInt(editingFrames, 10);
    if (!isNaN(val) && val >= 0 && val <= 999999) {
      onChangeFrames(val);
    }
    setEditingFrames(null);
  }, [editingFrames, onChangeFrames]);

  const handleFramesKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleFramesBlur();
      }
    },
    [handleFramesBlur]
  );

  return (
    <div className="ui-schema-renderer" data-ui-schema-model="apimart/nano-banana-2" data-ui-schema-placement="videoParams" ref={ref}>
      <div className="ui-schema-quality-ratio-pill">
        <button
          type="button"
          className="img-pill-btn ui-schema-menu-trigger"
          data-ui-schema-menu-trigger="videoParams"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
          <span className="ui-schema-pill-label ui-schema-quality-ratio-label">
            帧数{videoFrames} · 帧率{videoFps} · 分辨率{videoResolution}
          </span>
        </button>

        {open && (
          <div className="img-ratio-popup ui-schema-popup ui-schema-video-params-popup" style={{ display: 'block' }}>
            {/* 分辨率 */}
            <div className="img-rp-quality-area mb-2" data-ui-schema-field="rhVideoResolution" data-ui-schema-type="segmented" data-ui-schema-value-type="number" data-ui-schema-default="832">
              <div className="img-rp-section-label">
                分辨率
                <span
                  className="rh-tip"
                  data-tooltip="分辨率越高细节越清晰、边缘更稳定。同时显存占用与生成耗时会明显增加。"
                >
                  !
                </span>
              </div>
              <div className="img-rp-quality-segmented rh-video-resolution-seg">
                {resolutions.map((res) => (
                  <button
                    key={res}
                    type="button"
                    className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${videoResolution === res ? 'active' : ''}`}
                    data-value={res}
                    data-ui-schema-value={res}
                    onClick={() => onChangeResolution(res)}
                  >
                    {res}
                  </button>
                ))}
              </div>
            </div>

            {/* 帧率 & 帧数 */}
            <div className="rh-v5-meta-panel">
              <div className="rh-vram-adv-row">
                <div className="rh-vram-adv-label">
                  <span>帧率</span>
                  <span
                    className="rh-tip"
                    data-tooltip="帧率越高运动更顺滑、动作更连贯。但生成更慢、成本更高。常用 24 帧；想更快或更省可选 16 帧。"
                  >
                    !
                  </span>
                </div>
                <div className="img-rp-quality-segmented rh-adv-seg rh-v5-fps-seg">
                  {fpsOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`img-rp-quality-item rh-v5-fps-btn ui-schema-option ${videoFps === opt.value ? 'active' : ''}`}
                      data-value={opt.value}
                      data-ui-schema-value={opt.value}
                      onClick={() => onChangeFps(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rh-vram-adv-row ui-schema-rh-video-stepper" data-ui-schema-field="rhVideoFrames" data-ui-schema-type="stepper">
                <div className="rh-vram-adv-label">
                  <span>生成时长（帧数）</span>
                  <span
                    className="rh-tip"
                    data-tooltip="帧数决定生成片段的长度：数值越大视频越长、耗时越高。填 0 表示按源视频全长处理（适合整段替换）。"
                  >
                    !
                  </span>
                  <div className="rh-stepper rh-v5-frames-stepper">
                    <div className="rh-v5-source-framecount" aria-label="源视频总帧数">
                      —
                    </div>
                    {editingFrames !== null ? (
                      <input
                        ref={framesInputRef}
                        type="number"
                        className="rh-stepper-value rh-stepper-input"
                        min={0}
                        max={999999}
                        step={1}
                        value={editingFrames}
                        onChange={(e) => setEditingFrames(e.target.value)}
                        onBlur={handleFramesBlur}
                        onKeyDown={handleFramesKeyDown}
                        autoFocus
                      />
                    ) : (
                      <div
                        className="rh-stepper-value"
                        role="spinbutton"
                        aria-label="生成帧数"
                        aria-valuenow={videoFrames}
                        tabIndex={0}
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
          </div>
        )}
      </div>
    </div>
  );
}
