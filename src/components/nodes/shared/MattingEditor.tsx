/**
 * MattingEditor — 图像遮罩编辑全屏覆盖层（portal 到 body）
 * 封装抠图画布、笔画追踪、历史管理、键盘快捷键
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import MattingToolbar from './MattingToolbar';

/* ── Types ── */
type MattingTool = 'brush' | 'eraser' | 'bucket';
type BrushMode = 'normal' | 'alpha';

interface MattingEditorProps {
  isOpen: boolean;
  imageUrl: string;
  initialMask?: string;
  onClose: () => void;
  onSave: (maskUrl: string) => void;
}

const MASK_COLOR = 'rgba(255, 200, 0, 0.45)';

/* ── Flood fill helper ── */
function floodFill(
  imageData: ImageData,
  startX: number,
  startY: number,
  fillColor: [number, number, number, number],
): void {
  const { data, width, height } = imageData;
  const targetIdx = (startY * width + startX) * 4;
  const targetR = data[targetIdx];
  const targetG = data[targetIdx + 1];
  const targetB = data[targetIdx + 2];
  const targetA = data[targetIdx + 3];

  if (
    targetR === fillColor[0] &&
    targetG === fillColor[1] &&
    targetB === fillColor[2] &&
    targetA === fillColor[3]
  )
    return;

  const stack = [[startX, startY]];
  const visited = new Uint8Array(width * height);
  visited[startY * width + startX] = 1;

  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    const pi = (y * width + x) * 4;
    data[pi] = fillColor[0];
    data[pi + 1] = fillColor[1];
    data[pi + 2] = fillColor[2];
    data[pi + 3] = fillColor[3];

    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (visited[ni]) continue;
      const np = ni * 4;
      const tolerance = 20;
      if (
        Math.abs(data[np] - targetR) <= tolerance &&
        Math.abs(data[np + 1] - targetG) <= tolerance &&
        Math.abs(data[np + 2] - targetB) <= tolerance &&
        Math.abs(data[np + 3] - targetA) <= tolerance
      ) {
        visited[ni] = 1;
        stack.push([nx, ny]);
      }
    }
  }
}

export default function MattingEditor({
  isOpen,
  imageUrl,
  initialMask,
  onClose,
  onSave,
}: MattingEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const strokeBaseline = useRef<ImageData | null>(null);
  const strokePoints = useRef<{ x: number; y: number }[]>([]);
  const isDrawing = useRef(false);
  const historyRef = useRef<ImageData[]>([]);

  const [tool, setTool] = useState<MattingTool>('brush');
  const [brushMode, setBrushMode] = useState<BrushMode>('normal');
  const [brushSize, setBrushSize] = useState(40);
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

    if (initialMask) {
      const maskImg = new Image();
      maskImg.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
        historyRef.current = [initial];
        setHistoryIdx(0);
      };
      maskImg.src = initialMask;
      return;
    }

    const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
    historyRef.current = [initial];
    setHistoryIdx(0);
  }, [initialMask]);

  // ── History management ──
  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Use functional update to get current historyIdx
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
      setBrushMode('normal');
      setBrushSize(40);
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

      const [x, y] = getCanvasCoords(e);

      if (tool === 'bucket') {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const fillR = brushMode === 'normal' ? 255 : 0;
        const fillG = brushMode === 'normal' ? 200 : 0;
        const fillB = 0;
        const fillA = brushMode === 'normal' ? 115 : 0;
        floodFill(imageData, Math.round(x), Math.round(y), [fillR, fillG, fillB, fillA]);
        ctx.putImageData(imageData, 0, 0);
        return;
      }

      strokeBaseline.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      strokePoints.current = [{ x, y }];
    },
    [tool, brushMode, getCanvasCoords],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing.current || tool === 'bucket') return;
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

      const op =
        tool === 'brush'
          ? (brushMode === 'normal' ? 'source-over' : ('destination-out' as const))
          : ('destination-out' as const);
      const color = tool === 'brush' ? MASK_COLOR : '#000';

      ctx.save();
      ctx.globalCompositeOperation = op;
      ctx.strokeStyle = color;
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
    [tool, brushMode, brushSize, getCanvasCoords],
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
    const maskUrl = canvas.toDataURL('image/png');
    onSave(maskUrl);
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
          setBrushMode((prev) => (prev === 'normal' ? 'alpha' : 'normal'));
          break;
        case 'e':
          setTool('eraser');
          break;
        case 'g':
          setTool('bucket');
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
    <div className="matting-overlay">
      <MattingToolbar
        onCancel={onClose}
        onSave={handleSave}
        onToolChange={setTool}
        onBrushSizeChange={setBrushSize}
        onBrushModeChange={setBrushMode}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClear={handleClear}
        canUndo={historyIdx > 0}
        canRedo={historyIdx < historyRef.current.length - 1}
      />

      <motion.div
        className="matting-stage"
        initial={{ scale: 0.5 }}
        animate={{ scale: 1 }}
        transition={{ duration: 2, ease: [0.16, 1, 0.1, 1] }}
      >
        <img
          ref={imageRef}
          src={imageUrl}
          alt="Editing"
          className="matting-image"
          draggable={false}
          onLoad={initCanvas}
        />
        <canvas
          ref={canvasRef}
          className={`matting-canvas${tool === 'bucket' ? ' cursor-crosshair' : ''}`}
          style={
            tool !== 'bucket'
              ? {
                  cursor: `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="${brushSize}" height="${brushSize}" viewBox="0 0 ${brushSize} ${brushSize}"><circle cx="${brushSize / 2}" cy="${brushSize / 2}" r="${brushSize / 2 - 1}" fill="none" stroke="white" stroke-width="1" opacity="0.8"/></svg>') ${brushSize / 2} ${brushSize / 2}, auto`,
                }
              : undefined
          }
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </motion.div>
    </div>,
    document.body,
  );
}
