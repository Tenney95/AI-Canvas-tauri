/**
 * ComposerSidePanel — 右侧图层列表 + 选中图层属性
 */
import { useMemo } from 'react';
import AnimatedButton from '../../../../shared/AnimatedButton';
import { useAppStore } from '../../../../../store/useAppStore';
import type { BaseNodeData } from '../../../../../types';
import type { Layer } from './types';
import type { ComposerApi } from './useComposer';

interface Props {
  composer: ComposerApi;
  nodeId: string;
  /** 对选中图片图层识别主体 */
  onMatteSubject: () => void;
  /** 正在识别主体的图层 id（用于按钮 loading 态） */
  mattingLayerId: string | null;
}

export default function ComposerSidePanel({ composer, nodeId, onMatteSubject, mattingLayerId }: Props) {
  const { layers, selectedId, setSelectedId, selectedLayer, updateLayer, removeLayer, duplicateLayer, reorderLayer, addImageLayer, addText } = composer;

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

  const patch = (p: Partial<Layer>) => selectedLayer && updateLayer(selectedLayer.id, p);
  const hasFill = selectedLayer && (selectedLayer.type === 'rect' || selectedLayer.type === 'ellipse');
  const hasStroke = selectedLayer && (selectedLayer.type === 'rect' || selectedLayer.type === 'ellipse' || selectedLayer.type === 'line' || selectedLayer.type === 'arrow');

  return (
    <div className="composer-side">
      {/* 图层列表（顶层在上） */}
      <div className="composer-side-section">
        <div className="composer-side-title">图层</div>
        <div className="composer-layer-list">
          {layers.length === 0 && <div className="composer-menu-empty">还没有图层</div>}
          {layers.slice().reverse().map((l) => (
            <div
              key={l.id}
              className={`composer-layer-item${l.id === selectedId ? ' active' : ''}`}
              onClick={() => setSelectedId(l.id)}
            >
              <button
                type="button"
                className="composer-icon-btn"
                data-tooltip={l.visible ? '隐藏' : '显示'}
                onClick={(e) => { e.stopPropagation(); updateLayer(l.id, { visible: !l.visible }); }}
              >
                {l.visible ? '👁' : '🚫'}
              </button>
              <span className="composer-layer-name">{l.name}</span>
              <button type="button" className="composer-icon-btn danger" data-tooltip="删除" onClick={(e) => { e.stopPropagation(); removeLayer(l.id); }}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* 选中属性 */}
      {selectedLayer && (
        <div className="composer-side-section">
          <div className="composer-side-title">属性</div>

          <label className="composer-field">
            <span>透明度</span>
            <input type="range" min={0} max={1} step={0.01} value={selectedLayer.opacity} onChange={(e) => patch({ opacity: +e.target.value })} />
          </label>

          {selectedLayer.type === 'image' && (
            <AnimatedButton
              className="crop-aspect-btn composer-matte-btn"
              disabled={mattingLayerId === selectedLayer.id}
              onClick={onMatteSubject}
            >
              {mattingLayerId === selectedLayer.id ? '识别主体中…' : '识别主体（抠图）'}
            </AnimatedButton>
          )}

          {selectedLayer.type === 'text' && (
            <>
              <label className="composer-field">
                <span>字号</span>
                <input type="number" min={8} max={400} value={selectedLayer.fontSize} onChange={(e) => patch({ fontSize: +e.target.value || selectedLayer.fontSize } as Partial<Layer>)} />
              </label>
              <label className="composer-field">
                <span>颜色</span>
                <input type="color" value={selectedLayer.fill} onChange={(e) => patch({ fill: e.target.value } as Partial<Layer>)} />
              </label>
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

          {hasFill && (
            <label className="composer-field">
              <span>填充</span>
              <input type="color" value={(selectedLayer as Extract<Layer, { type: 'rect' | 'ellipse' }>).fill} onChange={(e) => patch({ fill: e.target.value } as Partial<Layer>)} />
            </label>
          )}

          {hasStroke && (
            <>
              <label className="composer-field">
                <span>描边色</span>
                <input type="color" value={(selectedLayer as Extract<Layer, { type: 'rect' | 'ellipse' | 'line' | 'arrow' }>).stroke} onChange={(e) => patch({ stroke: e.target.value } as Partial<Layer>)} />
              </label>
              <label className="composer-field">
                <span>描边宽</span>
                <input type="number" min={0} max={80} value={(selectedLayer as Extract<Layer, { type: 'rect' | 'ellipse' | 'line' | 'arrow' }>).strokeWidth} onChange={(e) => patch({ strokeWidth: +e.target.value } as Partial<Layer>)} />
              </label>
            </>
          )}

          {selectedLayer.type === 'rect' && (
            <label className="composer-field">
              <span>圆角</span>
              <input type="number" min={0} max={400} value={selectedLayer.cornerRadius} onChange={(e) => patch({ cornerRadius: +e.target.value } as Partial<Layer>)} />
            </label>
          )}

          <div className="composer-field">
            <span>层级</span>
            <div className="composer-seg">
              <button type="button" onClick={() => reorderLayer(selectedLayer.id, 'bottom')} data-tooltip="置底">⤓</button>
              <button type="button" onClick={() => reorderLayer(selectedLayer.id, 'down')} data-tooltip="下移">▽</button>
              <button type="button" onClick={() => reorderLayer(selectedLayer.id, 'up')} data-tooltip="上移">△</button>
              <button type="button" onClick={() => reorderLayer(selectedLayer.id, 'top')} data-tooltip="置顶">⤒</button>
            </div>
          </div>

          <div className="composer-side-actions">
            <AnimatedButton className="crop-aspect-btn" onClick={() => duplicateLayer(selectedLayer.id)}>复制</AnimatedButton>
            <AnimatedButton className="crop-aspect-btn danger" onClick={() => removeLayer(selectedLayer.id)}>删除</AnimatedButton>
          </div>
        </div>
      )}

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
              onClick={() => (c.img ? addImageLayer(c.img, c.label) : c.text && addText(c.text, c.label))}
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
  );
}
