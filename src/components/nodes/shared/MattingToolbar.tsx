/**
 * MattingToolbar 遮罩编辑工具栏 — 图像遮罩编辑模式下的工具条，提供画笔(绘制/擦除)、橡皮擦、油漆桶及笔刷大小调整
 */
import { memo, useCallback, useState, useRef } from 'react';

type MattingTool = 'brush' | 'eraser' | 'bucket';
type BrushMode = 'normal' | 'alpha';

export interface MattingToolbarProps {
  onCancel: () => void;
  onSave: () => void;
  onToolChange: (tool: MattingTool) => void;
  onBrushSizeChange: (size: number) => void;
  // brush mode: 'normal' = paint, 'alpha' = erase (toggle within brush)
  onBrushModeChange: (mode: BrushMode) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

function MattingToolbar({
  onCancel,
  onSave,
  onToolChange,
  onBrushSizeChange,
  onBrushModeChange,
  onUndo,
  onRedo,
  onClear,
  canUndo,
  canRedo,
}: MattingToolbarProps) {
  const [activeTool, setActiveTool] = useState<MattingTool>('brush');
  const [brushMode, setBrushMode] = useState<BrushMode>('normal');
  const [brushSize, setBrushSize] = useState(40);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const handleToolSelect = useCallback(
    (tool: MattingTool) => {
      if (tool === 'brush') {
        // Toggle brush mode when clicking brush again
        if (activeTool === 'brush') {
          const nextMode = brushMode === 'normal' ? 'alpha' : 'normal';
          setBrushMode(nextMode);
          onBrushModeChange(nextMode);
          return;
        }
        setActiveTool(tool);
        onToolChange(tool);
        // Reset to normal when switching from other tool
        setBrushMode('normal');
        onBrushModeChange('normal');
      } else {
        setActiveTool(tool);
        onToolChange(tool);
      }
    },
    [activeTool, brushMode, onToolChange, onBrushModeChange],
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
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCancel();
    },
    [onCancel],
  );

  const handleSave = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSave();
    },
    [onSave],
  );

  const handleUndo = useCallback((e: React.MouseEvent) => { e.stopPropagation(); onUndo(); }, [onUndo]);
  const handleRedo = useCallback((e: React.MouseEvent) => { e.stopPropagation(); onRedo(); }, [onRedo]);
  const handleClear = useCallback((e: React.MouseEvent) => { e.stopPropagation(); onClear(); }, [onClear]);

  return (
    <div className="matting-toolbar" ref={toolbarRef}>
      {/* Cancel */}
      <button
        className="matting-btn icon-only act-cancel"
        data-tooltip="取消 (Esc)"
        aria-label="取消"
        onClick={handleCancel}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      <div className="matting-divider" />

      {/* Brush — click again to toggle alpha mode */}
      <button
        className={`matting-btn icon-only tool-btn${activeTool === 'brush' ? ' active' : ''}`}
        data-tool="brush"
        data-tooltip={activeTool === 'brush' ? `画笔 ${brushMode === 'alpha' ? '(擦除模式)' : '(绘制模式)'} B` : '画笔 B'}
        aria-label="画笔"
        onClick={() => handleToolSelect('brush')}
      >
        {brushMode === 'normal' ? (
          <svg className="brush-icon-normal" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        ) : (
          <svg className="brush-icon-alpha" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            <path d="M3 3h6v6H3z" fill="currentColor" fillOpacity="0.3" />
          </svg>
        )}
      </button>

      {/* Eraser */}
      <button
        className={`matting-btn icon-only tool-btn${activeTool === 'eraser' ? ' active' : ''}`}
        data-tool="eraser"
        data-tooltip="橡皮擦 E"
        aria-label="橡皮擦"
        onClick={() => handleToolSelect('eraser')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M20 20H7l-5-5a2 2 0 0 1 0-2.83l9.17-9.17a2 2 0 0 1 2.83 0L22 10a2 2 0 0 1 0 2.83L14.83 20" />
        </svg>
      </button>

      {/* Bucket */}
      <button
        className={`matting-btn icon-only tool-btn${activeTool === 'bucket' ? ' active' : ''}`}
        data-tool="bucket"
        data-tooltip="油漆桶 G"
        aria-label="油漆桶"
        onClick={() => handleToolSelect('bucket')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M19 11l-8-8-8.5 8.5a2.12 2.12 0 0 0 0 3l4 4a2.12 2.12 0 0 0 3 0L19 11z" />
          <path d="M16 14l-3.5 3.5" />
          <path d="M12 18l-2 2" />
          <path d="M20 20l-2-2" />
        </svg>
      </button>

      <div className="matting-divider" />

      {/* Brush size slider */}
      <div className="matting-size">
        <span className="matting-size-value">{brushSize}</span>
        <input
          className="matting-size-range"
          type="range"
          min="1"
          max="120"
          step="1"
          value={brushSize}
          onChange={handleSizeChange}
        />
      </div>

      <div className="matting-divider" />

      {/* Undo */}
      <button
        className="matting-btn icon-only act-undo"
        data-tooltip="撤销 Ctrl+Z"
        aria-label="撤销"
        onClick={handleUndo}
        disabled={!canUndo}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M9 14l-4-4 4-4" />
          <path d="M5 10h9a6 6 0 1 1 0 12h-3" />
        </svg>
      </button>

      {/* Redo */}
      <button
        className="matting-btn icon-only act-redo"
        data-tooltip="重做 Ctrl+Y"
        aria-label="重做"
        onClick={handleRedo}
        disabled={!canRedo}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M15 14l4-4-4-4" />
          <path d="M19 10H10a6 6 0 1 0 0 12h3" />
        </svg>
      </button>

      {/* Clear */}
      <button
        className="matting-btn icon-only act-clear"
        data-tooltip="清空 R"
        aria-label="清空"
        onClick={handleClear}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M6 6l1 16h10l1-16" />
        </svg>
      </button>

      {/* Save */}
      <button
        className="matting-btn matting-save act-save"
        data-tooltip="保存"
        aria-label="保存"
        onClick={handleSave}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M19 21H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h11l5 5v9a2 2 0 0 1-2 2Z" />
          <path d="M17 21v-8H7v8" />
          <path d="M7 3v4h8" />
        </svg>
        <span>保存</span>
      </button>
    </div>
  );
}

export default memo(MattingToolbar);
