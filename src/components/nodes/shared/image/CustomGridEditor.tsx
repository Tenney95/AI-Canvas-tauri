/**
 * CustomGridEditor — 自定义宫格裁切编辑器
 * 在全屏 overlay 上拖拽添加横向/竖向分割线，根据线的分布生成 storyboard 节点
 */
import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import FullscreenOverlay from '../../../shared/FullscreenOverlay';
import AnimatedButton from '../../../shared/AnimatedButton';
import { springGentle } from '../../../../utils/motion';

/* ── 类型 ── */
interface GuideLine {
  id: string;
  pos: number; // 0–100 百分比
}

type LineType = 'h' | 'v';

interface CustomGridEditorProps {
  isOpen: boolean;
  imageUrl: string;
  onClose: () => void;
  onConfirm: (hPercentages: number[], vPercentages: number[]) => void;
}

let guid = 0;
const nextId = () => `gl-${++guid}`;

export default function CustomGridEditor({ isOpen, imageUrl, onClose, onConfirm }: CustomGridEditorProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  /** 标记刚完成一次拖拽，阻止后续 click 意外新建线 */
  const justDraggedRef = useRef(false);

  const [hLines, setHLines] = useState<GuideLine[]>([]);
  const [vLines, setVLines] = useState<GuideLine[]>([]);
  const [mode, setMode] = useState<LineType>('h');
  const [dragging, setDragging] = useState<string | null>(null);

  /* ── 关闭：重置所有状态 ── */
  const handleClose = useCallback(() => {
    setHLines([]);
    setVLines([]);
    setMode('h');
    onClose();
  }, [onClose]);

  /* ── 点击图像 → 添加线 ── */
  const handleStageClick = useCallback(
    (e: React.MouseEvent) => {
      // 刚完成拖拽/删除操作的 click 不要新建线
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      if (!imgRef.current) return;
      const rect = imgRef.current.getBoundingClientRect();
      if (mode === 'h') {
        const yPct = ((e.clientY - rect.top) / rect.height) * 100;
        setHLines((prev) => [...prev, { id: nextId(), pos: Math.max(0, Math.min(100, yPct)) }]);
      } else {
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        setVLines((prev) => [...prev, { id: nextId(), pos: Math.max(0, Math.min(100, xPct)) }]);
      }
    },
    [mode],
  );

  /* ── 拖拽线 ── */
  const handleLinePointerDown = useCallback(
    (id: string, type: LineType) => (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setDragging(id);

      const onMove = (ev: PointerEvent) => {
        if (!imgRef.current) return;
        const rect = imgRef.current.getBoundingClientRect();
        if (type === 'h') {
          const yPct = ((ev.clientY - rect.top) / rect.height) * 100;
          const clamped = Math.max(0, Math.min(100, yPct));
          setHLines((prev) => prev.map((l) => (l.id === id ? { ...l, pos: clamped } : l)));
        } else {
          const xPct = ((ev.clientX - rect.left) / rect.width) * 100;
          const clamped = Math.max(0, Math.min(100, xPct));
          setVLines((prev) => prev.map((l) => (l.id === id ? { ...l, pos: clamped } : l)));
        }
      };

      const onUp = () => {
        justDraggedRef.current = true;
        setDragging(null);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [],
  );

  /* ── 删除线 ── */
  const deleteLine = useCallback((id: string, type: LineType) => {
    if (type === 'h') setHLines((prev) => prev.filter((l) => l.id !== id));
    else setVLines((prev) => prev.filter((l) => l.id !== id));
  }, []);

  /* ── 清除全部线 ── */
  const handleClearAll = useCallback(() => {
    setHLines([]);
    setVLines([]);
  }, []);

  /* ── 确认：传递排序后的线位置百分比 ── */
  const handleConfirm = useCallback(() => {
    const hPcts = [...hLines].sort((a, b) => a.pos - b.pos).map((l) => l.pos);
    const vPcts = [...vLines].sort((a, b) => a.pos - b.pos).map((l) => l.pos);
    onConfirm(hPcts, vPcts);
    setHLines([]);
    setVLines([]);
    setMode('h');
  }, [hLines, vLines, onConfirm]);

  const hasLines = hLines.length > 0 || vLines.length > 0;
  const hintText = `点击图像添加${mode === 'h' ? '横向' : '竖向'}分割线 · 拖拽调整 · 点 × 删除`;

  return (
    <FullscreenOverlay
      isOpen={isOpen}
      onClose={handleClose}
      title="自定义宫格裁切"
      hidePanel
      className="customgrid-overlay"
    >
      <motion.div
        className="customgrid-content"
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springGentle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 工具栏 ── */}
        <div className="customgrid-toolbar">
          <AnimatedButton
            type="button"
            className="customgrid-btn act-cancel"
            title="关闭 (Esc)"
            aria-label="关闭"
            onClick={handleClose}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </AnimatedButton>

          {/* 模式切换：横线 / 竖线 */}
          <div className="customgrid-mode-toggle">
            <button
              type="button"
              className={`customgrid-btn${mode === 'h' ? ' active' : ''}`}
              onClick={() => setMode('h')}
            >
              横线
            </button>
            <button
              type="button"
              className={`customgrid-btn${mode === 'v' ? ' active' : ''}`}
              onClick={() => setMode('v')}
            >
              竖线
            </button>
          </div>

          <div className="customgrid-bar-divider" />

          <span className="customgrid-hint">{hintText}</span>

          <div className="customgrid-bar-spacer" />

          <button type="button" className="customgrid-btn" onClick={handleClearAll} disabled={!hasLines}>
            清除全部
          </button>

          <AnimatedButton className="customgrid-btn act-confirm" title="确认裁切" aria-label="确认裁切" onClick={handleConfirm}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M3 17l5-5 3 3 8-8" />
            </svg>
            <span>确认</span>
          </AnimatedButton>
        </div>

        {/* ── 画布舞台：图像 + 叠加的线 ── */}
        <div className="customgrid-stage" onClick={handleStageClick}>
          <div className="customgrid-image-wrap">
            <img
              ref={imgRef}
              src={imageUrl}
              alt="Custom grid preview"
              className="customgrid-image"
              draggable={false}
            />

            {/* 横向线 */}
            {hLines.map((line) => (
              <div
                key={line.id}
                className={`customgrid-line customgrid-line--h${dragging === line.id ? ' dragging' : ''}`}
                style={{ top: `${line.pos}%` }}
                onPointerDown={handleLinePointerDown(line.id, 'h')}
              >
                <button
                  type="button"
                  className="customgrid-line-del"
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => { ev.stopPropagation(); deleteLine(line.id, 'h'); }}
                  aria-label="删除横线"
                />
              </div>
            ))}

            {/* 竖向线 */}
            {vLines.map((line) => (
              <div
                key={line.id}
                className={`customgrid-line customgrid-line--v${dragging === line.id ? ' dragging' : ''}`}
                style={{ left: `${line.pos}%` }}
                onPointerDown={handleLinePointerDown(line.id, 'v')}
              >
                <button
                  type="button"
                  className="customgrid-line-del"
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => { ev.stopPropagation(); deleteLine(line.id, 'v'); }}
                  aria-label="删除竖线"
                />
              </div>
            ))}

            {/* 当前光标模式指示 — 跟随鼠标的预览线 */}
          </div>
        </div>
      </motion.div>
    </FullscreenOverlay>
  );
}
