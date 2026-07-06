/**
 * ComposerToolbar — 合成器顶栏：加图层 / 画布设置 / 适配 / 导出
 */
import { useRef, useState } from 'react';
import AnimatedButton from '../../../../shared/AnimatedButton';
import QualityRatioSelector from '../../QualityRatioSelector';
import { useAppStore } from '../../../../../store/useAppStore';
import type { BaseNodeData } from '../../../../../types';
import type { CanvasBg } from './types';
import type { ComposerApi } from './useComposer';

interface Props {
  composer: ComposerApi;
  camScale: number;
  canExport: boolean;
  onFit: () => void;
  onExport: () => void;
  onClose: () => void;
}

/** 画质档位 → 长边像素 */
const QUALITY_LONG_EDGE: Record<string, number> = {
  '720p': 720,
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
};

/** 由「比例 + 画质」算出画布像素尺寸（长边对齐画质档位）*/
function dimsFromRatioQuality(ratio: string, quality: string): { w: number; h: number } {
  const long = QUALITY_LONG_EDGE[quality] ?? 1024;
  const [a, b] = ratio.split(':').map(Number);
  if (!a || !b) return { w: long, h: long };
  return a >= b
    ? { w: long, h: Math.round((long * b) / a) }
    : { w: Math.round((long * a) / b), h: long };
}

/** 由画布像素尺寸反推最接近的比例（用于回显选中态）*/
const RATIO_CHOICES = ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', '1:4', '4:1', '1:8', '8:1'];
function detectRatio(w: number, h: number): string {
  const r = w / h;
  let best = RATIO_CHOICES[0];
  let bestDiff = Infinity;
  for (const k of RATIO_CHOICES) {
    const [a, b] = k.split(':').map(Number);
    const diff = Math.abs(r - a / b);
    if (diff < bestDiff) { bestDiff = diff; best = k; }
  }
  return best;
}

const BG_PRESETS: { label: string; value: CanvasBg }[] = [
  { label: '透明', value: 'transparent' },
  { label: '白', value: '#ffffff' },
  { label: '黑', value: '#000000' },
];

export default function ComposerToolbar({ composer, camScale, canExport, onFit, onExport, onClose }: Props) {
  const { canvas, setCanvas, addImageLayer, addText, addShape } = composer;
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<'canvas' | 'bg' | null>(null);

  // 画布尺寸：比例由实时画布反推（随打开的图片/缩放同步回显），画质档位本地维护
  const [sizeQuality, setSizeQuality] = useState('1K');
  const sizeRatio = detectRatio(canvas.width, canvas.height);
  const handleRatioChange = (ratio: string) => {
    const { w, h } = dimsFromRatioQuality(ratio, sizeQuality);
    setCanvas((cv) => ({ ...cv, width: w, height: h }));
  };
  const handleQualityChange = (quality: string) => {
    setSizeQuality(quality);
    const { w, h } = dimsFromRatioQuality(sizeRatio, quality);
    setCanvas((cv) => ({ ...cv, width: w, height: h }));
  };

  const imageNodes = useAppStore((s) => s.nodes).filter(
    (n) => n.type === 'ai-image' && (n.data as BaseNodeData)?.imageUrl,
  );

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addImageLayer(reader.result as string, file.name);
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div data-tauri-drag-region className="composer-toolbar">
      <div className="composer-toolbar-main">
        {/* 添加图层 */}
        <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="上传图片" aria-label="上传图片" onClick={() => fileRef.current?.click()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </AnimatedButton>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleUpload} />

      <div className="composer-dd">
        <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="从画布添加图片" aria-label="从画布添加图片" onClick={() => setMenu(menu === 'canvas' ? null : 'canvas')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </AnimatedButton>
        {menu === 'canvas' && (
          <div className="composer-menu" onMouseLeave={() => setMenu(null)}>
            {imageNodes.length === 0 && <div className="composer-menu-empty">画布暂无图片节点</div>}
            {imageNodes.map((n) => {
              const d = n.data as BaseNodeData;
              return (
                <button
                  key={n.id}
                  type="button"
                  className="composer-menu-item"
                  onClick={() => { addImageLayer(d.imageUrl as string, (d.label as string) || '图片'); setMenu(null); }}
                >
                  <img src={d.imageUrl as string} alt="" />
                  <span>{(d.label as string) || '图片'}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="crop-bar-divider" />
      <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="文字" aria-label="文字" onClick={() => addText()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <path d="M5 6V4h14v2M9 20h6M12 4v16" />
        </svg>
      </AnimatedButton>
      <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="矩形" aria-label="矩形" onClick={() => addShape('rect')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <rect x="4" y="6" width="16" height="12" rx="1" />
        </svg>
      </AnimatedButton>
      <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="椭圆" aria-label="椭圆" onClick={() => addShape('ellipse')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <ellipse cx="12" cy="12" rx="8" ry="6" />
        </svg>
      </AnimatedButton>
      <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="直线" aria-label="直线" onClick={() => addShape('line')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <line x1="5" y1="19" x2="19" y2="5" />
        </svg>
      </AnimatedButton>
      <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="箭头" aria-label="箭头" onClick={() => addShape('arrow')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <path d="M5 12h12M13 6l6 6-6 6" />
        </svg>
      </AnimatedButton>

      <div className="crop-bar-divider" />
      {/* 画布尺寸 — 比例 + 画质 */}
      <QualityRatioSelector
        imageSize={sizeQuality}
        aspectRatio={sizeRatio}
        onChangeImageSize={handleQualityChange}
        onChangeAspectRatio={handleRatioChange}
        showAdaptive={false}
        placement="bottom"
      />

      {/* 背景 */}
      <div className="composer-dd">
        <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="背景" aria-label="背景" onClick={() => setMenu(menu === 'bg' ? null : 'bg')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 12h18M12 3v18" />
          </svg>
        </AnimatedButton>
        {menu === 'bg' && (
          <div className="composer-menu" onMouseLeave={() => setMenu(null)}>
            {BG_PRESETS.map((b) => (
              <button key={b.label} type="button" className={`composer-menu-item row${canvas.bg === b.value ? ' active' : ''}`} onClick={() => { setCanvas((cv) => ({ ...cv, bg: b.value })); setMenu(null); }}>
                {b.label}
              </button>
            ))}
            <div className="composer-menu-custom">
              <span>自定义</span>
              <input type="color" value={canvas.bg === 'transparent' ? '#ffffff' : canvas.bg} onChange={(e) => setCanvas((cv) => ({ ...cv, bg: e.target.value }))} />
            </div>
          </div>
        )}
      </div>

      <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="适配画布" aria-label="适配画布" onClick={onFit}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      </AnimatedButton>
      <span className="composer-zoom-text">{Math.round(camScale * 100)}%</span>
      <AnimatedButton className="crop-action-btn confirm" data-tooltip="合成为新节点" aria-label="导出" disabled={!canExport} onClick={onExport}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <path d="M3 17l5-5 3 3 8-8" />
        </svg>
        <span>合成</span>
      </AnimatedButton>
      </div>

      <AnimatedButton className="composer-toolbar-close crop-aspect-btn crop-aspect-close act-cancel" data-tooltip="关闭 (Esc)" aria-label="关闭" onClick={onClose}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </AnimatedButton>
    </div>
  );
}
