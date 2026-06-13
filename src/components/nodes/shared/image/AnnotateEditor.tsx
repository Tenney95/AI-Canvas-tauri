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

export default function AnnotateEditor({
  isOpen,
  imageUrl,
  initialAnnotation,
  onClose,
  onSave,
}: AnnotateEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const strokeBaseline = useRef<ImageData | null>(null);
  const strokePoints = useRef<{ x: number; y: number }[]>([]);
  const isDrawing = useRef(false);
  const historyRef = useRef<ImageData[]>([]);

  const [tool, setTool] = useState<AnnotateTool>('brush');
  const [color, setColor] = useState(ANNOTATE_COLORS[0]);
  const [brushSize, setBrushSize] = useState(5);
  const [historyIdx, setHistoryIdx] = useState(-1);

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
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      isDrawing.current = true;
      canvas.setPointerCapture(e.pointerId);

      strokeBaseline.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const [x, y] = getCanvasCoords(e);
      strokePoints.current = [{ x, y }];
    },
    [getCanvasCoords],
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
    pushHistory();
  }, [pushHistory]);

  // ── Save ──
  const handleSave = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const annotationUrl = canvas.toDataURL('image/png');
    onSave(annotationUrl);
  }, [onSave]);

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
              cursor: `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="${brushSize}" height="${brushSize}" viewBox="0 0 ${brushSize} ${brushSize}"><circle cx="${brushSize / 2}" cy="${brushSize / 2}" r="${brushSize / 2 - 1}" fill="none" stroke="white" stroke-width="1" opacity="0.8"/></svg>') ${brushSize / 2} ${brushSize / 2}, auto`,
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
