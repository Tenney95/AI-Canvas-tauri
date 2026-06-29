/**
 * AnnotateToolbar 标注工具栏 — 自由涂写模式下的工具条，提供画笔/橡皮擦、颜色选择、笔刷大小调整、撤销/重做
 */
import { memo, useCallback, useState } from 'react';
import AnimatedButton from '../../../shared/AnimatedButton';

export type AnnotateTool = 'brush' | 'eraser' | 'text' | 'rect' | 'circle';
export type AnnotateColor = string;

export const ANNOTATE_COLORS: AnnotateColor[] = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ffffff', // white
  '#000000', // black
];

export interface AnnotateToolbarProps {
  onCancel: () => void;
  onSave: () => void;
  onToolChange: (tool: AnnotateTool) => void;
  onColorChange: (color: AnnotateColor) => void;
  onBrushSizeChange: (size: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Font size of currently selected text annotation (px). When set, slider controls this text. */
  selectedFontSize?: number;
  /** Called when slider changes while a text annotation is selected. */
  onFontSizeChange?: (size: number) => void;
}

function AnnotateToolbar({
  onCancel,
  onSave,
  onToolChange,
  onColorChange,
  onBrushSizeChange,
  onUndo,
  onRedo,
  onClear,
  canUndo,
  canRedo,
  selectedFontSize,
  onFontSizeChange,
}: AnnotateToolbarProps) {
  const [activeTool, setActiveTool] = useState<AnnotateTool>('brush');
  const [activeColor, setActiveColor] = useState<AnnotateColor>(ANNOTATE_COLORS[0]);
  const [brushSize, setBrushSize] = useState(5);

  const handleToolSelect = useCallback(
    (tool: AnnotateTool) => {
      setActiveTool(tool);
      onToolChange(tool);
    },
    [onToolChange],
  );

  const handleColorSelect = useCallback(
    (color: AnnotateColor) => {
      setActiveColor(color);
      onColorChange(color);
    },
    [onColorChange],
  );

  const handleSizeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const size = Number(e.target.value);
      setBrushSize(size);
      onBrushSizeChange(size);
    },
    [onBrushSizeChange],
  );

  const handleCancel = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); onCancel(); },
    [onCancel],
  );
  const handleSave = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); onSave(); },
    [onSave],
  );
  const handleUndo = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); onUndo(); },
    [onUndo],
  );
  const handleRedo = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); onRedo(); },
    [onRedo],
  );
  const handleClear = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); onClear(); },
    [onClear],
  );

  return (
    <div className="annotate-toolbar">
      {/* Cancel */}
      <AnimatedButton
        className="annotate-btn icon-only act-cancel"
        title="取消 (Esc)"
        aria-label="取消"
        onClick={handleCancel}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </AnimatedButton>

      <div className="annotate-divider" />

      {/* Brush */}
      <AnimatedButton
        className={`annotate-btn icon-only tool-btn${activeTool === 'brush' ? ' active' : ''}`}
        data-tool="brush"
        title="画笔 B"
        aria-label="画笔"
        onClick={() => handleToolSelect('brush')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </AnimatedButton>

      {/* Eraser */}
      <AnimatedButton
        className={`annotate-btn icon-only tool-btn${activeTool === 'eraser' ? ' active' : ''}`}
        data-tool="eraser"
        title="橡皮擦 E"
        aria-label="橡皮擦"
        onClick={() => handleToolSelect('eraser')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M20 20H7l-5-5a2 2 0 0 1 0-2.83l9.17-9.17a2 2 0 0 1 2.83 0L22 10a2 2 0 0 1 0 2.83L14.83 20" />
        </svg>
      </AnimatedButton>

      {/* Text */}
      <AnimatedButton
        className={`annotate-btn icon-only tool-btn${activeTool === 'text' ? ' active' : ''}`}
        data-tool="text"
        title="文字 T"
        aria-label="文字"
        onClick={() => handleToolSelect('text')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 4v16" />
        </svg>
      </AnimatedButton>

      {/* Rect */}
      <AnimatedButton
        className={`annotate-btn icon-only tool-btn${activeTool === 'rect' ? ' active' : ''}`}
        data-tool="rect"
        title="矩形框"
        aria-label="矩形框"
        onClick={() => handleToolSelect('rect')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      </AnimatedButton>

      {/* Circle */}
      <AnimatedButton
        className={`annotate-btn icon-only tool-btn${activeTool === 'circle' ? ' active' : ''}`}
        data-tool="circle"
        title="圆形框"
        aria-label="圆形框"
        onClick={() => handleToolSelect('circle')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <ellipse cx="12" cy="12" rx="9" ry="9" />
        </svg>
      </AnimatedButton>

      <div className="annotate-divider" />

      {/* Color palette */}
      <div className="annotate-colors">
        {ANNOTATE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`annotate-color-swatch${activeColor === color ? ' active' : ''}`}
            style={{ backgroundColor: color }}
            aria-label={color}
            onClick={() => handleColorSelect(color)}
          />
        ))}
      </div>

      <div className="annotate-divider" />

      {/* Brush size / Font size slider */}
      <div className="annotate-size">
        <span className="annotate-size-label">
          {selectedFontSize !== undefined || activeTool === 'text' ? '字号' : activeTool === 'rect' || activeTool === 'circle' ? '线宽' : '笔刷'}
        </span>
        <span className="annotate-size-value">
          {selectedFontSize !== undefined ? selectedFontSize : brushSize}
        </span>
        <input
          className="annotate-size-range"
          type="range"
          min={selectedFontSize !== undefined ? 6 : 1}
          max={selectedFontSize !== undefined ? 120 : 60}
          step="1"
          value={selectedFontSize !== undefined ? selectedFontSize : brushSize}
          onChange={(e) => {
            const size = Number(e.target.value);
            if (selectedFontSize !== undefined && onFontSizeChange) {
              onFontSizeChange(size);
            } else {
              handleSizeChange(e);
            }
          }}
        />
      </div>

      <div className="annotate-divider" />

      {/* Undo */}
      <AnimatedButton
        className="annotate-btn icon-only act-undo"
        title="撤销 Ctrl+Z"
        aria-label="撤销"
        onClick={handleUndo}
        disabled={!canUndo}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M9 14l-4-4 4-4" />
          <path d="M5 10h9a6 6 0 1 1 0 12h-3" />
        </svg>
      </AnimatedButton>

      {/* Redo */}
      <AnimatedButton
        className="annotate-btn icon-only act-redo"
        title="重做 Ctrl+Y"
        aria-label="重做"
        onClick={handleRedo}
        disabled={!canRedo}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M15 14l4-4-4-4" />
          <path d="M19 10H10a6 6 0 1 0 0 12h3" />
        </svg>
      </AnimatedButton>

      {/* Clear */}
      <AnimatedButton
        className="annotate-btn icon-only act-clear"
        title="清空 R"
        aria-label="清空"
        onClick={handleClear}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M6 6l1 16h10l1-16" />
        </svg>
      </AnimatedButton>

      {/* Save */}
      <AnimatedButton
        className="annotate-btn annotate-save act-save"
        title="保存"
        aria-label="保存"
        onClick={handleSave}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M19 21H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h11l5 5v9a2 2 0 0 1-2 2Z" />
          <path d="M17 21v-8H7v8" />
          <path d="M7 3v4h8" />
        </svg>
        <span>保存</span>
      </AnimatedButton>
    </div>
  );
}

export default memo(AnnotateToolbar);
