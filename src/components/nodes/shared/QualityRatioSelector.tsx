/**
 * QualityRatioSelector 图像质量/比例选择器 — 弹出面板选择图像尺寸(1K/2K/4K)和宽高比
 */
import { useState, useRef, useEffect } from 'react';

interface QualityRatioSelectorProps {
  imageSize?: string;
  aspectRatio?: string;
  onChangeImageSize: (size: string) => void;
  onChangeAspectRatio: (ratio: string) => void;
}

export default function QualityRatioSelector({
  imageSize = '1K',
  aspectRatio = '16:9',
  onChangeImageSize,
  onChangeAspectRatio,
}: QualityRatioSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const ratios = [
    { value: '1:1', className: 'img-rp-sq' },
    { value: '9:16', className: 'img-rp-tall' },
    { value: '16:9', className: 'img-rp-wide' },
    { value: '3:4', className: 'img-rp-p34' },
    { value: '4:3', className: 'img-rp-l43' },
    { value: '3:2', className: 'img-rp-l32' },
    { value: '2:3', className: 'img-rp-p23' },
    { value: '5:4', className: 'img-rp-l54' },
    { value: '4:5', className: 'img-rp-p45' },
    { value: '21:9', className: 'img-rp-ultra' },
    { value: '1:4', className: 'img-rp-p14' },
    { value: '4:1', className: 'img-rp-l41' },
    { value: '1:8', className: 'img-rp-p18' },
    { value: '8:1', className: 'img-rp-l81' },
  ];

  return (
    <div className="ui-schema-renderer" data-ui-schema-model="apimart/gemini-3.1-flash-image-preview" data-ui-schema-placement="resolution" ref={ref}>
      <div className="ui-schema-quality-ratio-pill" data-ui-schema-composite-field="qualityRatio">
        <button
          type="button"
          className="img-pill-btn ui-schema-menu-trigger"
          data-ui-schema-menu-trigger="qualityRatio"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <path d="M9 21V9" />
          </svg>
          <span className="ui-schema-pill-label ui-schema-quality-ratio-label">
            {aspectRatio} · {imageSize}
          </span>
        </button>

        {open && (
          <div className="img-ratio-popup ui-schema-popup ui-schema-quality-ratio-popup" style={{ display: 'block' }}>
            <div className="img-rp-quality-area" data-ui-schema-field="imageSize" data-ui-schema-type="segmented" data-ui-schema-default="2K">
              <div className="img-rp-section-label">画质</div>
              <div className="img-rp-quality-segmented">
                {['720p', '1K', '2K', '4K'].map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`img-rp-quality-item ui-schema-option ${imageSize === size ? 'active' : ''}`}
                    data-ui-schema-value={size}
                    data-ui-schema-option-label={size}
                    onClick={() => onChangeImageSize(size)}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

            <div className="img-rp-ratio-area" data-ui-schema-field="aspectRatio" data-ui-schema-type="segmented" data-ui-schema-default="自适应">
              <div className="img-rp-section-label">比例</div>
              <div className="img-rp-ratio-split has-adaptive">
                <div className="img-rp-ratio-left">
                  <button
                    type="button"
                    className={`img-rp-large-adaptive ui-schema-option ${aspectRatio === '自适应' ? 'active' : ''}`}
                    data-label="自适应"
                    data-ui-schema-value="自适应"
                    onClick={() => onChangeAspectRatio('自适应')}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M3 9h18" />
                      <path d="M9 21V9" />
                    </svg>
                    <span>自适应</span>
                  </button>
                </div>
                <div className="img-rp-ratio-right">
                  {ratios.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      className={`img-rp-ratio-item ui-schema-option ${aspectRatio === r.value ? 'active' : ''}`}
                      data-label={r.value}
                      data-ui-schema-value={r.value}
                      onClick={() => onChangeAspectRatio(r.value)}
                    >
                      <span className={`img-rp-icon ${r.className}`}></span>
                      <span>{r.value}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
