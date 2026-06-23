/**
 * ComposerToolbar — 合成器顶栏：加图层 / 画布设置 / 适配 / 导出
 */
import { useRef, useState } from 'react';
import AnimatedButton from '../../../../shared/AnimatedButton';
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

const SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '1:1', w: 1024, h: 1024 },
  { label: '16:9', w: 1280, h: 720 },
  { label: '9:16', w: 720, h: 1280 },
  { label: '4:3', w: 1024, h: 768 },
  { label: '3:4', w: 768, h: 1024 },
];

const BG_PRESETS: { label: string; value: CanvasBg }[] = [
  { label: '透明', value: 'transparent' },
  { label: '白', value: '#ffffff' },
  { label: '黑', value: '#000000' },
];

export default function ComposerToolbar({ composer, camScale, canExport, onFit, onExport, onClose }: Props) {
  const { canvas, setCanvas, addImageLayer, addText, addShape } = composer;
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<'canvas' | 'size' | 'bg' | null>(null);

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
    <div className="composer-toolbar">
      <AnimatedButton className="crop-aspect-btn crop-aspect-close act-cancel" data-tooltip="关闭 (Esc)" aria-label="关闭" onClick={onClose}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </AnimatedButton>

      {/* 添加图层 */}
      <button type="button" className="crop-aspect-btn" onClick={() => fileRef.current?.click()}>上传图片</button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleUpload} />

      <div className="composer-dd">
        <button type="button" className="crop-aspect-btn" onClick={() => setMenu(menu === 'canvas' ? null : 'canvas')}>画布图片 ▾</button>
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
      <button type="button" className="crop-aspect-btn" onClick={() => addText()}>文字</button>
      <button type="button" className="crop-aspect-btn" onClick={() => addShape('rect')}>矩形</button>
      <button type="button" className="crop-aspect-btn" onClick={() => addShape('ellipse')}>椭圆</button>
      <button type="button" className="crop-aspect-btn" onClick={() => addShape('line')}>直线</button>
      <button type="button" className="crop-aspect-btn" onClick={() => addShape('arrow')}>箭头</button>

      <div className="crop-bar-divider" />
      {/* 画布尺寸 */}
      <div className="composer-dd">
        <button type="button" className="crop-aspect-btn" onClick={() => setMenu(menu === 'size' ? null : 'size')}>
          尺寸 {canvas.width}×{canvas.height} ▾
        </button>
        {menu === 'size' && (
          <div className="composer-menu" onMouseLeave={() => setMenu(null)}>
            {SIZE_PRESETS.map((p) => (
              <button key={p.label} type="button" className="composer-menu-item row" onClick={() => { setCanvas((cv) => ({ ...cv, width: p.w, height: p.h })); setMenu(null); }}>
                {p.label} · {p.w}×{p.h}
              </button>
            ))}
            <div className="composer-menu-custom">
              <input type="number" min={16} max={4096} value={canvas.width} onChange={(e) => setCanvas((cv) => ({ ...cv, width: +e.target.value || cv.width }))} />
              <span>×</span>
              <input type="number" min={16} max={4096} value={canvas.height} onChange={(e) => setCanvas((cv) => ({ ...cv, height: +e.target.value || cv.height }))} />
            </div>
          </div>
        )}
      </div>

      {/* 背景 */}
      <div className="composer-dd">
        <button type="button" className="crop-aspect-btn" onClick={() => setMenu(menu === 'bg' ? null : 'bg')}>背景 ▾</button>
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

      <div className="crop-aspect-spacer" />
      <button type="button" className="crop-aspect-btn" onClick={onFit}>适配</button>
      <span className="composer-zoom-text">{Math.round(camScale * 100)}%</span>
      <AnimatedButton className="crop-action-btn confirm" data-tooltip="合成为新节点" aria-label="导出" disabled={!canExport} onClick={onExport}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <path d="M3 17l5-5 3 3 8-8" />
        </svg>
        <span>合成</span>
      </AnimatedButton>
    </div>
  );
}
