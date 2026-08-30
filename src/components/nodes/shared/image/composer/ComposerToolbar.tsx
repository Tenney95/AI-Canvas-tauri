/**
 * ComposerToolbar — 合成器底部命令栏
 *
 * 分组：历史（撤销/重做）→ 工具（选择/画笔/橡皮）→ 添加图层（图片/文字/形状）
 * → 画布（尺寸/背景）→ 视图（适配）→ 合成。形状收进下拉，避免横向按钮过多。
 */
import { useRef, useState } from 'react';
import AnimatedButton from '../../../../shared/AnimatedButton';
import QualityRatioSelector from '../../QualityRatioSelector';
import { rangeFill } from './composerRange';
import { useAppStore } from '../../../../../store/useAppStore';
import type { BaseNodeData } from '../../../../../types';
import type { CanvasBg, LayerType } from '../../../../../types/composerTypes';
import type { ComposerApi } from './useComposer';

interface Props {
  composer: ComposerApi;
  canExport: boolean;
  onFit: () => void;
  onExport: () => void;
  onClose: () => void;
}

type MenuKey = 'canvas' | 'bg' | 'shape' | 'brush';

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

const SHAPES: { type: Extract<LayerType, 'rect' | 'ellipse' | 'line' | 'arrow'>; label: string }[] = [
  { type: 'rect', label: '矩形' },
  { type: 'ellipse', label: '椭圆' },
  { type: 'line', label: '直线' },
  { type: 'arrow', label: '箭头' },
];

export default function ComposerToolbar({ composer, canExport, onFit, onExport, onClose }: Props) {
  const {
    canvas, updateCanvas, addImageLayer, addImageFileLayer, addText, addShape,
    tool, setTool, brush, setBrush, undo, redo, canUndo, canRedo,
  } = composer;
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<MenuKey | null>(null);
  const toggleMenu = (key: MenuKey) => setMenu((cur) => (cur === key ? null : key));

  // 画布尺寸：比例由实时画布反推（随打开的图片/缩放同步回显），画质档位本地维护
  const [sizeQuality, setSizeQuality] = useState('1K');
  const sizeRatio = detectRatio(canvas.width, canvas.height);
  const handleRatioChange = (ratio: string) => {
    const { w, h } = dimsFromRatioQuality(ratio, sizeQuality);
    updateCanvas({ width: w, height: h });
  };
  const handleQualityChange = (quality: string) => {
    setSizeQuality(quality);
    const { w, h } = dimsFromRatioQuality(sizeRatio, quality);
    updateCanvas({ width: w, height: h });
  };

  const imageNodes = useAppStore((s) => s.nodes).filter(
    (n) => n.type === 'ai-image' && (n.data as BaseNodeData)?.imageUrl,
  );

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void addImageFileLayer(file, file.name).catch((error) => {
      useAppStore.getState().showToast(
        error instanceof Error ? error.message : '图片导入失败',
        'error',
      );
    });
    e.target.value = '';
  };

  return (
    <div data-tauri-drag-region className="composer-toolbar">
      <div className="composer-toolbar-main">
        {/* 历史 */}
        <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="撤销 (⌘Z)" aria-label="撤销" disabled={!canUndo} onClick={undo}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
          </svg>
        </AnimatedButton>
        <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="重做 (⇧⌘Z)" aria-label="重做" disabled={!canRedo} onClick={redo}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M15 14l5-5-5-5" />
            <path d="M20 9H10a6 6 0 0 0 0 12h3" />
          </svg>
        </AnimatedButton>

        <div className="crop-bar-divider" />

        {/* 工具 */}
        <AnimatedButton className={`crop-aspect-btn icon-only${tool === 'select' ? ' active' : ''}`} data-tooltip="选择 (V)" aria-label="选择工具" onClick={() => setTool('select')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M4 3l7 17 2.5-6.5L20 11z" />
          </svg>
        </AnimatedButton>
        <div className="composer-dd">
          <AnimatedButton
            className={`crop-aspect-btn icon-only${tool === 'brush' ? ' active' : ''}`}
            data-tooltip="画笔 (B) — 再次点击设置笔刷"
            aria-label="画笔"
            onClick={() => (tool === 'brush' ? toggleMenu('brush') : setTool('brush'))}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M15 4l5 5L9 20H4v-5z" />
              <path d="M13.5 5.5l5 5" />
            </svg>
          </AnimatedButton>
          {menu === 'brush' && (
            <div className="composer-menu composer-brush-menu" onMouseLeave={() => setMenu(null)}>
              <div className="composer-menu-custom">
                <span>颜色</span>
                <input type="color" value={brush.color} onChange={(e) => setBrush({ color: e.target.value })} />
              </div>
              <div className="composer-menu-custom">
                <span>粗细 {brush.size}px</span>
                <input
                  type="range"
                  min={1}
                  max={120}
                  value={brush.size}
                  style={rangeFill(brush.size, 1, 120)}
                  onChange={(e) => setBrush({ size: +e.target.value })}
                />
              </div>
            </div>
          )}
        </div>
        <AnimatedButton className={`crop-aspect-btn icon-only${tool === 'eraser' ? ' active' : ''}`} data-tooltip="橡皮 (E)" aria-label="橡皮" onClick={() => setTool('eraser')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M4 15l7-7 6 6-5 5H6z" />
            <path d="M9 20h11" />
          </svg>
        </AnimatedButton>

        <div className="crop-bar-divider" />

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
          <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="从画布添加图片" aria-label="从画布添加图片" onClick={() => toggleMenu('canvas')}>
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
                    onClick={() => {
                      setMenu(null);
                      void addImageLayer(d.imageUrl as string, (d.label as string) || '图片').catch((error) => {
                        useAppStore.getState().showToast(
                          error instanceof Error ? error.message : '图片导入失败',
                          'error',
                        );
                      });
                    }}
                  >
                    <img src={d.imageUrl as string} alt="" />
                    <span>{(d.label as string) || '图片'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="文字" aria-label="文字" onClick={() => addText()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M5 6V4h14v2M9 20h6M12 4v16" />
          </svg>
        </AnimatedButton>

        <div className="composer-dd">
          <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="形状" aria-label="形状" onClick={() => toggleMenu('shape')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <rect x="3" y="10" width="11" height="11" rx="1" />
              <circle cx="15.5" cy="7.5" r="4.5" />
            </svg>
          </AnimatedButton>
          {menu === 'shape' && (
            <div className="composer-menu" onMouseLeave={() => setMenu(null)}>
              {SHAPES.map((s) => (
                <button key={s.type} type="button" className="composer-menu-item row" onClick={() => { addShape(s.type); setMenu(null); }}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

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
          <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="背景" aria-label="背景" onClick={() => toggleMenu('bg')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 12h18M12 3v18" />
            </svg>
          </AnimatedButton>
          {menu === 'bg' && (
            <div className="composer-menu" onMouseLeave={() => setMenu(null)}>
              {BG_PRESETS.map((b) => (
                <button key={b.label} type="button" className={`composer-menu-item row${canvas.bg === b.value ? ' active' : ''}`} onClick={() => { updateCanvas({ bg: b.value }); setMenu(null); }}>
                  {b.label}
                </button>
              ))}
              <div className="composer-menu-custom">
                <span>自定义</span>
                <input type="color" value={canvas.bg === 'transparent' ? '#ffffff' : canvas.bg} onChange={(e) => updateCanvas({ bg: e.target.value }, 'canvas-bg')} />
              </div>
            </div>
          )}
        </div>

      </div>

      <div className="composer-toolbar-actions">
        <AnimatedButton className="crop-aspect-btn icon-only" data-tooltip="适配画布 (⌘0)" aria-label="适配画布" onClick={onFit}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
          </svg>
        </AnimatedButton>
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
