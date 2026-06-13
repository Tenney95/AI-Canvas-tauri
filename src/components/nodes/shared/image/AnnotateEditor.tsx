/**
 * AnnotateEditor — 图像标注编辑全屏覆盖层（portal 到 body）
 * 封装自由涂写画布、笔画追踪、历史管理、键盘快捷键
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AnnotateToolbar, { type AnnotateTool, ANNOTATE_COLORS } from './AnnotateToolbar';

/* ── Props ── */
interface AnnotateEditorProps {
  isOpen: boolean;
  imageUrl: string;
  initialAnnotation?: string;
  onClose: () => void;
  onSave: (annotationUrl: string) => void;
}

/* ── Text input overlay state ── */
interface TextInputState {
  x: number; // canvas coordinates
  y: number;
  value: string;
}

/* ── Text annotation placed on canvas ── */
interface TextAnnotation {
  id: string;
  x: number;
  y: number;
  value: string;
  color: string;
  fontSize: number;
}

export default function AnnotateEditor({
  isOpen,
  imageUrl,
  initialAnnotation,
  onClose,
  onSave,
}: AnnotateEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const strokeBaseline = useRef<ImageData | null>(null);
  const strokePoints = useRef<{ x: number; y: number }[]>([]);
  const frameStartRef = useRef<{ x: number; y: number } | null>(null);
  const isDrawing = useRef(false);
  const historyRef = useRef<ImageData[]>([]);
  const textIdCounter = useRef(0);
  const dragRef = useRef<{
    id: string;
    offsetX: number;
    offsetY: number;
    vpLeft: number;
    vpTop: number;
    el: HTMLElement;
    startX: number;
    startY: number;
  } | null>(null);

  const [tool, setTool] = useState<AnnotateTool>('brush');
  const [color, setColor] = useState(ANNOTATE_COLORS[0]);
  const [brushSize, setBrushSize] = useState(5);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [textInput, setTextInput] = useState<TextInputState | null>(null);
  const [textAnnotations, setTextAnnotations] = useState<TextAnnotation[]>([]);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);

  // ── Initialize canvas ──
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;

    const rect = image.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (initialAnnotation) {
      const annotImg = new Image();
      annotImg.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(annotImg, 0, 0, canvas.width, canvas.height);
        const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
        historyRef.current = [initial];
        setHistoryIdx(0);
      };
      annotImg.src = initialAnnotation;
      return;
    }

    const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
    historyRef.current = [initial];
    setHistoryIdx(0);
  }, [initialAnnotation]);

  // ── History management ──
  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    setHistoryIdx((currentIdx) => {
      const newHistory = historyRef.current.slice(0, currentIdx + 1);
      newHistory.push(imageData);
      if (newHistory.length > 30) newHistory.shift();
      historyRef.current = newHistory;
      return newHistory.length - 1;
    });
  }, []);

  const restoreHistory = useCallback((idx: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = historyRef.current[idx];
    if (!imageData) return;
    ctx.putImageData(imageData, 0, 0);
  }, []);

  // ── Reset on open ──
  useEffect(() => {
    if (isOpen) {
      setTool('brush');
      setColor(ANNOTATE_COLORS[0]);
      setBrushSize(5);
      historyRef.current = [];
      setHistoryIdx(-1);
      setTextAnnotations([]);
      setEditingTextId(null);
      setSelectedTextId(null);
      textIdCounter.current = 0;
    }
  }, [isOpen]);

  // ── Coordinate conversion ──
  const getCanvasCoords = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
      const canvas = canvasRef.current;
      if (!canvas) return [0, 0];
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
    },
    [],
  );

  // ── Pointer handlers ──
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Text mode: open text input at click position
      if (tool === 'text') {
        setSelectedTextId(null);
        const [x, y] = getCanvasCoords(e);
        setTextInput({ x, y, value: '' });
        // Focus the input after React renders it
        requestAnimationFrame(() => textInputRef.current?.focus());
        return;
      }

      setSelectedTextId(null);

      // Frame mode: record start position for drag-to-draw
      if (tool === 'rect' || tool === 'circle') {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        isDrawing.current = true;
        canvas.setPointerCapture(e.pointerId);
        strokeBaseline.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const [fx, fy] = getCanvasCoords(e);
        frameStartRef.current = { x: fx, y: fy };
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      isDrawing.current = true;
      canvas.setPointerCapture(e.pointerId);

      strokeBaseline.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const [x, y] = getCanvasCoords(e);
      strokePoints.current = [{ x, y }];
    },
    [getCanvasCoords, tool],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing.current) return;
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const [x, y] = getCanvasCoords(e);

      // Frame preview: restore baseline → draw shape
      if (tool === 'rect' || tool === 'circle') {
        const baseline = strokeBaseline.current;
        if (baseline) ctx.putImageData(baseline, 0, 0);
        const start = frameStartRef.current;
        if (!start) return;

        const minX = Math.min(start.x, x);
        const minY = Math.min(start.y, y);
        const w = Math.abs(x - start.x);
        const h = Math.abs(y - start.y);
        if (w < 0.5 || h < 0.5) return;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = color;
        ctx.lineWidth = brushSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (tool === 'rect') {
          ctx.strokeRect(minX, minY, w, h);
        } else {
          ctx.beginPath();
          ctx.ellipse(minX + w / 2, minY + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
        return;
      }

      // Brush / Eraser
      strokePoints.current.push({ x, y });

      const baseline = strokeBaseline.current;
      if (baseline) ctx.putImageData(baseline, 0, 0);

      const points = strokePoints.current;
      if (points.length < 1) return;

      ctx.save();
      ctx.globalCompositeOperation = tool === 'brush' ? 'source-over' : 'destination-out';
      ctx.strokeStyle = tool === 'brush' ? color : '#000';
      ctx.lineWidth = brushSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.restore();
    },
    [tool, color, brushSize, getCanvasCoords],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing.current) return;
      isDrawing.current = false;
      strokeBaseline.current = null;
      strokePoints.current = [];
      frameStartRef.current = null;
      const canvas = canvasRef.current;
      canvas?.releasePointerCapture(e.pointerId);
      pushHistory();
    },
    [pushHistory],
  );

  // ── Undo / Redo / Clear ──
  const handleUndo = useCallback(() => {
    setHistoryIdx((currentIdx) => {
      const newIdx = currentIdx - 1;
      if (newIdx < 0) return currentIdx;
      restoreHistory(newIdx);
      return newIdx;
    });
  }, [restoreHistory]);

  const handleRedo = useCallback(() => {
    setHistoryIdx((currentIdx) => {
      const newIdx = currentIdx + 1;
      if (newIdx >= historyRef.current.length) return currentIdx;
      restoreHistory(newIdx);
      return newIdx;
    });
  }, [restoreHistory]);

  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setTextAnnotations([]);
    setEditingTextId(null);
    pushHistory();
  }, [pushHistory]);

  // ── Save ──
  const handleSave = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw all text annotations onto canvas before exporting
    ctx.save();
    for (const ta of textAnnotations) {
      ctx.fillStyle = ta.color;
      ctx.font = `bold ${ta.fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(ta.value, ta.x, ta.y);
    }
    ctx.restore();

    const annotationUrl = canvas.toDataURL('image/png');
    onSave(annotationUrl);
  }, [onSave, textAnnotations]);

  // ── Text input handlers ──
  const commitText = useCallback(
    (text: string, x: number, y: number) => {
      if (!text.trim()) return;
      const fontSize = Math.max(8, Math.round(brushSize * 2.5));
      const id = `txt-${++textIdCounter.current}`;
      setTextAnnotations((prev) => [...prev, { id, x, y, value: text.trim(), color, fontSize }]);
    },
    [brushSize, color],
  );

  const handleTextKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!textInput) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        commitText(textInput.value, textInput.x, textInput.y);
        setTextInput(null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setTextInput(null);
      }
    },
    [textInput, commitText],
  );

  const handleTextBlur = useCallback(() => {
    // Confirm on blur (save what's typed)
    if (textInput) {
      commitText(textInput.value, textInput.x, textInput.y);
      setTextInput(null);
    }
  }, [textInput, commitText]);

  // ── Text annotation drag ──
  const handleTextPointerDown = useCallback(
    (e: React.PointerEvent, ta: TextAnnotation) => {
      if (textInput || editingTextId) return;
      e.preventDefault();
      e.stopPropagation();

      const el = e.currentTarget as HTMLElement;
      const viewport = el.closest('.annotate-viewport') as HTMLElement;
      if (!viewport) return;
      const vpRect = viewport.getBoundingClientRect();

      dragRef.current = {
        id: ta.id,
        offsetX: e.clientX - vpRect.left - ta.x,
        offsetY: e.clientY - vpRect.top - ta.y,
        vpLeft: vpRect.left,
        vpTop: vpRect.top,
        el,
        startX: e.clientX,
        startY: e.clientY,
      };
      el.setPointerCapture(e.pointerId);
    },
    [textInput, editingTextId],
  );

  // ── Global pointer move/up for drag ──
  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const newX = e.clientX - d.vpLeft - d.offsetX;
      const newY = e.clientY - d.vpTop - d.offsetY;
      d.el.style.left = `${newX}px`;
      d.el.style.top = `${newY}px`;
    };

    const handleUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = Math.abs(e.clientX - d.startX);
      const dy = Math.abs(e.clientY - d.startY);

      if (dx < 3 && dy < 3) {
        // Click (no significant drag) → select this text
        setSelectedTextId(d.id);
      } else {
        // Drag → confirm new position
        const newX = e.clientX - d.vpLeft - d.offsetX;
        const newY = e.clientY - d.vpTop - d.offsetY;
        setTextAnnotations((prev) =>
          prev.map((t) => (t.id === d.id ? { ...t, x: newX, y: newY } : t)),
        );
      }
      dragRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, []);

  // ── Text annotation edit / delete ──
  const handleTextEdit = useCallback((id: string) => {
    setEditingTextId(id);
  }, []);

  const handleTextEditConfirm = useCallback(
    (id: string, newValue: string) => {
      if (!newValue.trim()) {
        setTextAnnotations((prev) => prev.filter((t) => t.id !== id));
      } else {
        setTextAnnotations((prev) =>
          prev.map((t) => (t.id === id ? { ...t, value: newValue.trim() } : t)),
        );
      }
      setEditingTextId(null);
    },
    [],
  );

  const handleTextDelete = useCallback((id: string) => {
    setTextAnnotations((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Text annotation font size change (from toolbar) ──
  const handleTextFontSizeChange = useCallback(
    (size: number) => {
      if (!selectedTextId) return;
      setTextAnnotations((prev) =>
        prev.map((t) => (t.id === selectedTextId ? { ...t, fontSize: size } : t)),
      );
    },
    [selectedTextId],
  );

  // Selected text annotation (for toolbar fontSize display)
  const selectedText = textAnnotations.find((t) => t.id === selectedTextId);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      switch (e.key.toLowerCase()) {
        case 'escape':
          onClose();
          break;
        case 'b':
          setTool('brush');
          break;
        case 'e':
          setTool('eraser');
          break;
        case 't':
          if (!e.ctrlKey && !e.metaKey) {
            setTool('text');
          }
          break;
        case 'r':
          handleClear();
          break;
        case 'z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleUndo();
          }
          break;
        case 'y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleRedo();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, handleClear, handleUndo, handleRedo]);

  if (!isOpen) return null;

  return createPortal(
    <div className="annotate-overlay">
      <AnnotateToolbar
        onCancel={onClose}
        onSave={handleSave}
        onToolChange={setTool}
        onColorChange={setColor}
        onBrushSizeChange={setBrushSize}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClear={handleClear}
        canUndo={historyIdx > 0}
        canRedo={historyIdx < historyRef.current.length - 1}
        selectedFontSize={selectedText?.fontSize}
        onFontSizeChange={handleTextFontSizeChange}
      />

      <div className="annotate-stage">
        <div className="annotate-viewport">
          <img
            ref={imageRef}
            src={imageUrl}
            alt="Annotating"
            className="annotate-image"
            draggable={false}
            onLoad={initCanvas}
          />
          <canvas
            ref={canvasRef}
            className="annotate-canvas"
            style={{
              cursor: tool === 'text'
                ? 'text'
                : tool === 'rect' || tool === 'circle'
                  ? 'crosshair'
                  : `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="${brushSize}" height="${brushSize}" viewBox="0 0 ${brushSize} ${brushSize}"><circle cx="${brushSize / 2}" cy="${brushSize / 2}" r="${brushSize / 2 - 1}" fill="none" stroke="white" stroke-width="1" opacity="0.8"/></svg>') ${brushSize / 2} ${brushSize / 2}, auto`,
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />

          {/* Text annotations — draggable labels */}
          {textAnnotations.map((ta) =>
            editingTextId === ta.id ? (
              <input
                key={ta.id}
                className="annotate-text-input"
                type="text"
                defaultValue={ta.value}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleTextEditConfirm(ta.id, e.currentTarget.value);
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditingTextId(null);
                  }
                }}
                onBlur={(e) => handleTextEditConfirm(ta.id, e.target.value)}
                autoFocus
                style={{
                  left: ta.x,
                  top: ta.y,
                  fontSize: ta.fontSize,
                  color: ta.color,
                }}
              />
            ) : (
              <div
                key={ta.id}
                className={`annotate-text-label${selectedTextId === ta.id ? ' selected' : ''}`}
                style={{
                  left: ta.x,
                  top: ta.y,
                  fontSize: ta.fontSize,
                  color: ta.color,
                }}
                onPointerDown={(e) => handleTextPointerDown(e, ta)}
                onDoubleClick={() => handleTextEdit(ta.id)}
              >
                {ta.value}
                <button
                  className="annotate-text-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTextDelete(ta.id);
                  }}
                  aria-label="删除文字"
                >
                  ×
                </button>
              </div>
            ),
          )}

          {/* Text input overlay — new text */}
          {textInput && (
            <input
              ref={textInputRef}
              className="annotate-text-input"
              type="text"
              value={textInput.value}
              onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
              onKeyDown={handleTextKeyDown}
              onBlur={handleTextBlur}
              placeholder="输入文字…"
              autoFocus
              style={{
                left: textInput.x,
                top: textInput.y,
                fontSize: Math.max(8, Math.round(brushSize * 2.5)),
                color,
              }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
