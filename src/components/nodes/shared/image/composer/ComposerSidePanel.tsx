/**
 * ComposerSidePanel — 右侧属性面板
 *
 * 分区：图层列表（可拖拽换序 / 显隐 / 锁定 / 改名）→ 变换（位置、尺寸、旋转、
 * 翻转、对齐）→ 外观（混合模式、透明度、类型专属属性）→ 调整（图片调色滤镜）
 * → 画布尺寸 → 连线文件。可整体折叠，把工作区还给画面。
 */
import { useMemo, useState } from 'react';
import AnimatedButton from '../../../../shared/AnimatedButton';
import { useAppStore } from '../../../../../store/useAppStore';
import { BLEND_MODES, isDefaultAdjustments } from '../../../../../types/composerTypes';
import { NumField, RangeField } from './composerUi';
import type { BaseNodeData } from '../../../../../types';
import type { AlignDir, BlendMode, ImageAdjustments, ImageLayer, Layer, ShapeLayer } from '../../../../../types/composerTypes';
import type { ComposerApi } from './useComposer';

/** 有自然宽高、可按像素设定尺寸的图层 */
const isBoxedLayer = (l: Layer): l is ImageLayer | ShapeLayer =>
  l.type === 'image' || l.type === 'rect' || l.type === 'ellipse';

/** 带描边的图层 */
const isStrokedLayer = (l: Layer): l is Exclude<Layer, ImageLayer> => l.type !== 'image';

interface Props {
  composer: ComposerApi;
  nodeId: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 首次打开才播入场动画；折叠过一次后关掉，避免每次展开都要等动画 */
  animateIn: boolean;
  /** 对选中图片图层识别主体 */
  onMatteSubject: () => void;
  /** 正在识别主体的图层 id（用于按钮 loading 态） */
  mattingLayerId: string | null;
  /** 相对画布对齐选中图层 */
  onAlign: (dir: AlignDir) => void;
  /** 选中图层适配 / 铺满画布 */
  onFitLayer: (mode: 'contain' | 'cover') => void;
}

const FONT_FAMILIES = [
  { value: 'sans-serif', label: '无衬线' },
  { value: 'serif', label: '衬线' },
  { value: 'monospace', label: '等宽' },
  { value: 'PingFang SC, Microsoft YaHei, sans-serif', label: '苹方 / 雅黑' },
  { value: 'Songti SC, SimSun, serif', label: '宋体' },
];

const ALIGN_BUTTONS: { dir: AlignDir; icon: string; tip: string }[] = [
  { dir: 'left', icon: '⇤', tip: '左对齐' },
  { dir: 'hcenter', icon: '⇔', tip: '水平居中' },
  { dir: 'right', icon: '⇥', tip: '右对齐' },
  { dir: 'top', icon: '⤒', tip: '顶对齐' },
  { dir: 'vcenter', icon: '⇕', tip: '垂直居中' },
  { dir: 'bottom', icon: '⤓', tip: '底对齐' },
];

const ADJUST_SLIDERS: { key: keyof ImageAdjustments; label: string; min: number; max: number; step: number }[] = [
  { key: 'brightness', label: '亮度', min: -1, max: 1, step: 0.01 },
  { key: 'contrast', label: '对比度', min: -100, max: 100, step: 1 },
  { key: 'saturation', label: '饱和度', min: -2, max: 2, step: 0.02 },
  { key: 'hue', label: '色相', min: 0, max: 359, step: 1 },
  { key: 'luminance', label: '明度', min: -1, max: 1, step: 0.01 },
  { key: 'blur', label: '模糊', min: 0, max: 40, step: 1 },
];

export default function ComposerSidePanel({
  composer, nodeId, collapsed, onToggleCollapsed, animateIn, onMatteSubject, mattingLayerId, onAlign, onFitLayer,
}: Props) {
  const {
    layers, selectedId, setSelectedId, selectedLayer, canvas, updateCanvas,
    updateLayer, removeLayer, duplicateLayer, reorderLayer, moveLayerToIndex,
    addImageLayer, addText, flipLayer, resetTransform, setAdjustments, resetAdjustments,
  } = composer;

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  /* ── 连线节点内容 ── */
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const connected = useMemo(() => {
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.source === nodeId) ids.add(e.target);
      if (e.target === nodeId) ids.add(e.source);
    }
    return nodes
      .filter((n) => ids.has(n.id))
      .map((n) => {
        const d = n.data as BaseNodeData;
        const img = (d.imageUrl || d.thumbnailUrl) as string | undefined;
        const text = (d.output || d.prompt) as string | undefined;
        return { id: n.id, label: (d.label as string) || '节点', img, text };
      })
      .filter((c) => c.img || c.text);
  }, [nodes, edges, nodeId]);

  const patch = (p: Partial<Layer>, tag?: string) => selectedLayer && updateLayer(selectedLayer.id, p, tag);
  const shapeLayer = selectedLayer && (selectedLayer.type === 'rect' || selectedLayer.type === 'ellipse') ? selectedLayer : null;
  const strokedLayer = selectedLayer && isStrokedLayer(selectedLayer) ? selectedLayer : null;
  const boxedLayer = selectedLayer && isBoxedLayer(selectedLayer) ? selectedLayer : null;

  /** 按显示宽度反推缩放（保留翻转符号） */
  const setBoxSize = (axis: 'w' | 'h', px: number) => {
    if (!boxedLayer || px <= 0) return;
    const natural = axis === 'w' ? boxedLayer.width : boxedLayer.height;
    if (!natural) return;
    const current = axis === 'w' ? boxedLayer.scaleX : boxedLayer.scaleY;
    const next = (px / natural) * (current < 0 ? -1 : 1);
    patch(axis === 'w' ? { scaleX: next } : { scaleY: next });
  };

  const handleDrop = (displayIndex: number) => {
    if (dragIndex === null) return;
    // 列表倒序展示（顶层在上），换算回 layers 数组下标
    const from = layers.length - 1 - dragIndex;
    const to = layers.length - 1 - displayIndex;
    setDragIndex(null);
    moveLayerToIndex(from, to);
  };

  const addConnectedImage = (src: string, label: string) => {
    void addImageLayer(src, label).catch((error) => {
      useAppStore.getState().showToast(
        error instanceof Error ? error.message : '图片导入失败',
        'error',
      );
    });
  };

  const fontStyle = selectedLayer?.type === 'text' ? selectedLayer.fontStyle : '';
  const toggleFontStyle = (flag: 'bold' | 'italic') => {
    const has = fontStyle.includes(flag);
    const parts = new Set(fontStyle.split(' ').filter(Boolean));
    if (has) parts.delete(flag); else parts.add(flag);
    patch({ fontStyle: parts.size ? Array.from(parts).join(' ') : 'normal' } as Partial<Layer>);
  };

  return (
    <>
      {collapsed && (
        <button type="button" className="composer-side-expand" data-tooltip="展开属性面板" aria-label="展开属性面板" onClick={onToggleCollapsed}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      )}

      {/* 折叠时只隐藏不卸载：保住滚动位置，也不会每次展开都重播入场动画 */}
      <div className={`composer-side${collapsed ? ' collapsed' : ''}${animateIn ? '' : ' no-enter'}`}>
      <div className="composer-side-head">
        <span className="composer-side-heading">属性</span>
        <button type="button" className="composer-icon-btn" data-tooltip="收起面板" aria-label="收起面板" onClick={onToggleCollapsed}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      {/* 图层列表（顶层在上，可拖拽换序） */}
      <div className="composer-side-section">
        <div className="composer-side-title">图层</div>
        <div className="composer-layer-list">
          {layers.length === 0 && <div className="composer-menu-empty">还没有图层</div>}
          {layers.slice().reverse().map((l, i) => (
            <div
              key={l.id}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(i)}
              onDragEnd={() => setDragIndex(null)}
              className={`composer-layer-item${l.id === selectedId ? ' active' : ''}${dragIndex === i ? ' dragging' : ''}`}
              onClick={() => setSelectedId(l.id)}
              onDoubleClick={() => setRenamingId(l.id)}
            >
              <button
                type="button"
                className="composer-icon-btn"
                data-tooltip={l.visible ? '隐藏' : '显示'}
                onClick={(e) => { e.stopPropagation(); updateLayer(l.id, { visible: !l.visible }); }}
              >
                {l.visible ? '👁' : '🚫'}
              </button>
              {l.type === 'image' && <img className="composer-layer-thumb" src={l.src} alt="" />}
              {renamingId === l.id ? (
                <input
                  className="composer-layer-rename"
                  autoFocus
                  defaultValue={l.name}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { updateLayer(l.id, { name: e.target.value.trim() || l.name }); setRenamingId(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    else if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <span className="composer-layer-name">{l.name}</span>
              )}
              <button
                type="button"
                className={`composer-icon-btn${l.locked ? ' on' : ''}`}
                data-tooltip={l.locked ? '解锁' : '锁定'}
                onClick={(e) => { e.stopPropagation(); updateLayer(l.id, { locked: !l.locked }); }}
              >
                {l.locked ? '🔒' : '🔓'}
              </button>
              <button type="button" className="composer-icon-btn danger" data-tooltip="删除" onClick={(e) => { e.stopPropagation(); removeLayer(l.id); }}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {selectedLayer && (
        <>
          {/* 变换 */}
          <div className="composer-side-section">
            <div className="composer-side-title">变换</div>
            <div className="composer-num-grid">
              <NumField label="X" value={selectedLayer.x} onCommit={(v) => patch({ x: v })} />
              <NumField label="Y" value={selectedLayer.y} onCommit={(v) => patch({ y: v })} />
              {boxedLayer && (
                <>
                  <NumField label="宽" value={boxedLayer.width * Math.abs(boxedLayer.scaleX)} min={1} onCommit={(v) => setBoxSize('w', v)} />
                  <NumField label="高" value={boxedLayer.height * Math.abs(boxedLayer.scaleY)} min={1} onCommit={(v) => setBoxSize('h', v)} />
                </>
              )}
              <NumField label="旋转" value={selectedLayer.rotation} min={-360} max={360} onCommit={(v) => patch({ rotation: v })} />
            </div>

            <div className="composer-field">
              <span>翻转</span>
              <div className="composer-seg">
                <button type="button" data-tooltip="水平翻转" onClick={() => flipLayer(selectedLayer.id, 'x')}>⇋</button>
                <button type="button" data-tooltip="垂直翻转" onClick={() => flipLayer(selectedLayer.id, 'y')}>⇵</button>
                <button type="button" data-tooltip="重置旋转与缩放" onClick={() => resetTransform(selectedLayer.id)}>↺</button>
              </div>
            </div>

            <div className="composer-field">
              <span>对齐</span>
              <div className="composer-seg wrap">
                {ALIGN_BUTTONS.map((b) => (
                  <button key={b.dir} type="button" data-tooltip={b.tip} onClick={() => onAlign(b.dir)}>{b.icon}</button>
                ))}
              </div>
            </div>

            <div className="composer-side-actions">
              <AnimatedButton className="crop-aspect-btn" data-tooltip="等比放入画布" onClick={() => onFitLayer('contain')}>适配画布</AnimatedButton>
              <AnimatedButton className="crop-aspect-btn" data-tooltip="等比铺满画布" onClick={() => onFitLayer('cover')}>铺满画布</AnimatedButton>
            </div>
          </div>

          {/* 外观 */}
          <div className="composer-side-section">
            <div className="composer-side-title">外观</div>

            <RangeField
              label="透明度"
              value={selectedLayer.opacity}
              min={0}
              max={1}
              step={0.01}
              display={`${Math.round(selectedLayer.opacity * 100)}%`}
              onChange={(v) => patch({ opacity: v }, `opacity:${selectedLayer.id}`)}
            />

            <label className="composer-field">
              <span>混合</span>
              <select
                className="composer-select"
                value={selectedLayer.blendMode}
                onChange={(e) => patch({ blendMode: e.target.value as BlendMode })}
              >
                {BLEND_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>

            {selectedLayer.type === 'text' && (
              <>
                <label className="composer-field">
                  <span>字体</span>
                  <select className="composer-select" value={selectedLayer.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value } as Partial<Layer>)}>
                    {FONT_FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </label>
                <div className="composer-num-grid">
                  <NumField label="字号" value={selectedLayer.fontSize} min={8} max={600} onCommit={(v) => patch({ fontSize: v } as Partial<Layer>)} />
                  <NumField label="行高" value={selectedLayer.lineHeight} min={0.5} max={4} step={0.05} onCommit={(v) => patch({ lineHeight: v } as Partial<Layer>)} />
                  <NumField label="字距" value={selectedLayer.letterSpacing} min={-20} max={100} onCommit={(v) => patch({ letterSpacing: v } as Partial<Layer>)} />
                  <NumField label="框宽" value={selectedLayer.width} min={20} onCommit={(v) => patch({ width: v } as Partial<Layer>)} />
                </div>
                <label className="composer-field">
                  <span>颜色</span>
                  <input type="color" value={selectedLayer.fill} onChange={(e) => patch({ fill: e.target.value } as Partial<Layer>, `fill:${selectedLayer.id}`)} />
                </label>
                <div className="composer-field">
                  <span>样式</span>
                  <div className="composer-seg">
                    <button type="button" className={fontStyle.includes('bold') ? 'active' : ''} onClick={() => toggleFontStyle('bold')}><b>B</b></button>
                    <button type="button" className={fontStyle.includes('italic') ? 'active' : ''} onClick={() => toggleFontStyle('italic')}><i>I</i></button>
                    <button type="button" className={selectedLayer.shadow ? 'active' : ''} data-tooltip="投影" onClick={() => patch({ shadow: !selectedLayer.shadow } as Partial<Layer>)}>◍</button>
                  </div>
                </div>
                <div className="composer-field">
                  <span>对齐</span>
                  <div className="composer-seg">
                    {(['left', 'center', 'right'] as const).map((a) => (
                      <button key={a} type="button" className={selectedLayer.align === a ? 'active' : ''} onClick={() => patch({ align: a } as Partial<Layer>)}>
                        {a === 'left' ? '左' : a === 'center' ? '中' : '右'}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {shapeLayer && (
              <label className="composer-field">
                <span>填充</span>
                <input
                  type="color"
                  value={shapeLayer.fill}
                  onChange={(e) => patch({ fill: e.target.value } as Partial<Layer>, `fill:${shapeLayer.id}`)}
                />
              </label>
            )}

            {strokedLayer && (
              <>
                <label className="composer-field">
                  <span>描边色</span>
                  <input
                    type="color"
                    value={strokedLayer.stroke}
                    onChange={(e) => patch({ stroke: e.target.value } as Partial<Layer>, `stroke:${strokedLayer.id}`)}
                  />
                </label>
                <RangeField
                  label="描边宽"
                  value={strokedLayer.strokeWidth}
                  min={0}
                  max={80}
                  onChange={(v) => patch({ strokeWidth: v } as Partial<Layer>, `strokeWidth:${strokedLayer.id}`)}
                />
              </>
            )}

            {selectedLayer.type === 'rect' && (
              <RangeField
                label="圆角"
                value={selectedLayer.cornerRadius}
                min={0}
                max={400}
                onChange={(v) => patch({ cornerRadius: v } as Partial<Layer>, `radius:${selectedLayer.id}`)}
              />
            )}

            <div className="composer-field">
              <span>层级</span>
              <div className="composer-seg">
                <button type="button" onClick={() => reorderLayer(selectedLayer.id, 'bottom')} data-tooltip="置底">⤓</button>
                <button type="button" onClick={() => reorderLayer(selectedLayer.id, 'down')} data-tooltip="下移 (⌘[)">▽</button>
                <button type="button" onClick={() => reorderLayer(selectedLayer.id, 'up')} data-tooltip="上移 (⌘])">△</button>
                <button type="button" onClick={() => reorderLayer(selectedLayer.id, 'top')} data-tooltip="置顶">⤒</button>
              </div>
            </div>

            <div className="composer-side-actions">
              <AnimatedButton className="crop-aspect-btn" data-tooltip="复制图层 (⌘D)" onClick={() => duplicateLayer(selectedLayer.id)}>复制</AnimatedButton>
              <AnimatedButton className="crop-aspect-btn danger" data-tooltip="删除图层 (Delete)" onClick={() => removeLayer(selectedLayer.id)}>删除</AnimatedButton>
            </div>
          </div>

          {/* 调整 — 图片调色 */}
          {selectedLayer.type === 'image' && (
            <div className="composer-side-section">
              <div className="composer-side-title">
                调整
                {!isDefaultAdjustments(selectedLayer.adjustments) && (
                  <button type="button" className="composer-title-action" onClick={() => resetAdjustments(selectedLayer.id)}>复位</button>
                )}
              </div>

              {ADJUST_SLIDERS.map((s) => (
                <RangeField
                  key={s.key}
                  label={s.label}
                  value={selectedLayer.adjustments[s.key] as number}
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  onChange={(v) => setAdjustments(selectedLayer.id, { [s.key]: v } as Partial<ImageAdjustments>, `adj:${s.key}:${selectedLayer.id}`)}
                />
              ))}

              <div className="composer-field">
                <span>效果</span>
                <div className="composer-seg">
                  <button type="button" className={selectedLayer.adjustments.grayscale ? 'active' : ''} onClick={() => setAdjustments(selectedLayer.id, { grayscale: !selectedLayer.adjustments.grayscale })}>黑白</button>
                  <button type="button" className={selectedLayer.adjustments.sepia ? 'active' : ''} onClick={() => setAdjustments(selectedLayer.id, { sepia: !selectedLayer.adjustments.sepia })}>怀旧</button>
                  <button type="button" className={selectedLayer.adjustments.invert ? 'active' : ''} onClick={() => setAdjustments(selectedLayer.id, { invert: !selectedLayer.adjustments.invert })}>反相</button>
                </div>
              </div>

              <AnimatedButton
                className="crop-aspect-btn composer-matte-btn"
                disabled={mattingLayerId === selectedLayer.id}
                onClick={onMatteSubject}
              >
                {mattingLayerId === selectedLayer.id ? '识别主体中…' : '识别主体（抠图）'}
              </AnimatedButton>
            </div>
          )}
        </>
      )}

      {/* 画布尺寸 */}
      <div className="composer-side-section">
        <div className="composer-side-title">画布</div>
        <div className="composer-num-grid">
          <NumField label="宽" value={canvas.width} min={16} max={8192} onCommit={(v) => updateCanvas({ width: Math.round(v) })} />
          <NumField label="高" value={canvas.height} min={16} max={8192} onCommit={(v) => updateCanvas({ height: Math.round(v) })} />
        </div>
      </div>

      {/* 连线节点内容 — 点击加入图层 */}
      <div className="composer-side-section composer-files">
        <div className="composer-side-title">连线文件</div>
        {connected.length === 0 && <div className="composer-menu-empty">没有连线的节点</div>}
        <div className="composer-file-grid">
          {connected.map((c) => (
            <button
              key={c.id}
              type="button"
              className="composer-file-card"
              data-tooltip={`${c.label}（点击加入图层）`}
              onClick={() => (c.img ? addConnectedImage(c.img, c.label) : c.text && addText(c.text, c.label))}
            >
              {c.img ? (
                <img src={c.img} alt={c.label} />
              ) : (
                <span className="composer-file-text">{c.text}</span>
              )}
              <span className="composer-file-label">{c.label}</span>
            </button>
          ))}
        </div>
      </div>
      </div>
    </>
  );
}
