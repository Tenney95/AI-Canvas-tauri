/**
 * MattingEditor — 图像遮罩编辑全屏覆盖层（portal 到 body）
 * 封装抠图画布、笔画追踪、历史管理、键盘快捷键
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ImageEditorZoomControls from './ImageEditorZoomControls';
import MattingToolbar from './MattingToolbar';
import { MAX_MATTING_CANVAS_EDGE, MAX_MATTING_HISTORY_BYTES } from './imageResourceBudget';
import { floodFillImageData, trimImageDataHistory } from './mattingUtils';

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

/* 蒙版以"满 alpha"绘制到画布（满色叠满色仍是满色，任意重叠都不会变深），
   显示时由画布 CSS opacity 统一降到 MASK_DISPLAY_ALPHA，保存时再把该透明度烤进输出，
   使最终蒙版处处一致、且与下游消费格式（半透明黄）保持不变。 */
const MASK_RGB: [number, number, number] = [255, 200, 0];
const MASK_DISPLAY_ALPHA = 0.45;
const MASK_COLOR = `rgba(${MASK_RGB[0]}, ${MASK_RGB[1]}, ${MASK_RGB[2]}, 1)`;

/** 调用方只在打开时挂载本组件（关闭即卸载），因此状态靠卸载重置，无需 effect 复位。 */
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
  const disposedRef = useRef(false);

  const [tool, setTool] = useState<MattingTool>('brush');
  const [brushMode, setBrushMode] = useState<BrushMode>('normal');
  const [brushSize, setBrushSize] = useState(40);
  // 撤销栈游标 + 长度：长度必须进 state，渲染期读 historyRef.current 会读到过期值
  const [history, setHistory] = useState({ idx: -1, len: 0 });

  // ── 缩放 / 平移 ──
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef({ x: 0, y: 0 });
  const [panReady, setPanReady] = useState(false); // 空格按下 → 进入平移就绪态（手型光标）
  const spaceDown = useRef(false);
  const isPanning = useRef(false);
  const [panning, setPanning] = useState(false); // 仅用于光标样式，渲染期不能读 isPanning.current
  const panStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  // 每个画布单位对应的屏幕像素（含缩放）——用于让画笔光标圆圈与实际笔触直径一致
  const [dispScale, setDispScale] = useState(1);
  const recomputeDispScale = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0) setDispScale(rect.width / canvas.width);
  }, []);

  useEffect(() => { offsetRef.current = offset; }, [offset]);

  useEffect(() => {
    disposedRef.current = false;
    const canvas = canvasRef.current;
    return () => {
      disposedRef.current = true;
      historyRef.current = [];
      strokeBaseline.current = null;
      strokePoints.current = [];
      isDrawing.current = false;
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
    };
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const handleZoomChange = useCallback((nextScale: number) => {
    const next = Math.max(0.5, Math.min(6, nextScale));
    setScale(next);
    if (next <= 1) setOffset({ x: 0, y: 0 });
  }, []);

  // ── Initialize canvas ──
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;

    // 后备尺寸用图片自然分辨率（封顶防爆内存），与图片严格等比；
    // 显示尺寸交给 .matting-canvas 的 100%/100% 拉伸贴合，从而全图可涂、且不受缩放变换影响。
    let w = image.naturalWidth;
    let h = image.naturalHeight;
    if (!w || !h) {
      const rect = image.getBoundingClientRect();
      w = Math.round(rect.width);
      h = Math.round(rect.height);
    }
    const longest = Math.max(w, h);
    if (longest > MAX_MATTING_CANVAS_EDGE) {
      const k = MAX_MATTING_CANVAS_EDGE / longest;
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    canvas.width = w;
    canvas.height = h;
    requestAnimationFrame(recomputeDispScale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (initialMask) {
      const maskImg = new Image();
      maskImg.onload = () => {
        if (disposedRef.current) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        // 归一化：已保存的蒙版是半透明的，统一拉回满 alpha，保证后续涂抹不累加、显示不二次衰减
        const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = initial.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 10) {
            d[i] = MASK_RGB[0];
            d[i + 1] = MASK_RGB[1];
            d[i + 2] = MASK_RGB[2];
            d[i + 3] = 255;
          } else {
            d[i + 3] = 0;
          }
        }
        ctx.putImageData(initial, 0, 0);
        historyRef.current = [initial];
        setHistory({ idx: 0, len: 1 });
      };
      maskImg.src = initialMask;
      return;
    }

    const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
    historyRef.current = [initial];
    setHistory({ idx: 0, len: 1 });
  }, [initialMask, recomputeDispScale]);

  // ── History management ──
  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Use functional update to get current history cursor
    setHistory((current) => {
      const newHistory = historyRef.current.slice(0, current.idx + 1);
      newHistory.push(imageData);
      const trimmed = trimImageDataHistory(newHistory, MAX_MATTING_HISTORY_BYTES);
      historyRef.current = trimmed;
      return { idx: trimmed.length - 1, len: trimmed.length };
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

      // 中键 或 空格+左键 → 平移视图（不绘制）
      if (e.button === 1 || spaceDown.current) {
        isPanning.current = true;
        setPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y };
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      isDrawing.current = true;
      canvas.setPointerCapture(e.pointerId);

      const [x, y] = getCanvasCoords(e);

      if (tool === 'bucket') {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const fillR = brushMode === 'normal' ? MASK_RGB[0] : 0;
        const fillG = brushMode === 'normal' ? MASK_RGB[1] : 0;
        const fillB = brushMode === 'normal' ? MASK_RGB[2] : 0;
        const fillA = brushMode === 'normal' ? 255 : 0;
        const changed = floodFillImageData(imageData, x, y, [fillR, fillG, fillB, fillA]);
        if (changed) ctx.putImageData(imageData, 0, 0);
        isDrawing.current = changed;
        return;
      }

      strokeBaseline.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      strokePoints.current = [{ x, y }];
    },
    [tool, brushMode, getCanvasCoords],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // 平移视图
      if (isPanning.current) {
        const dx = e.clientX - panStart.current.x;
        const dy = e.clientY - panStart.current.y;
        setOffset({ x: panStart.current.ox + dx, y: panStart.current.oy + dy });
        return;
      }
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
      if (isPanning.current) {
        isPanning.current = false;
        setPanning(false);
        const canvas = canvasRef.current;
        if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      const canvas = canvasRef.current;
      if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (!isDrawing.current) return;
      isDrawing.current = false;
      strokeBaseline.current = null;
      strokePoints.current = [];
      pushHistory();
    },
    [pushHistory],
  );

  // ── Undo / Redo / Clear ──
  const handleUndo = useCallback(() => {
    setHistory((current) => {
      const newIdx = current.idx - 1;
      if (newIdx < 0) return current;
      restoreHistory(newIdx);
      return { ...current, idx: newIdx };
    });
  }, [restoreHistory]);

  const handleRedo = useCallback(() => {
    setHistory((current) => {
      const newIdx = current.idx + 1;
      if (newIdx >= historyRef.current.length) return current;
      restoreHistory(newIdx);
      return { ...current, idx: newIdx };
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
    // 画布内部是满 alpha；导出时统一乘以显示透明度，得到处处一致的半透明蒙版
    const out = document.createElement('canvas');
    try {
      out.width = canvas.width;
      out.height = canvas.height;
      const octx = out.getContext('2d');
      if (!octx) return;
      octx.globalAlpha = MASK_DISPLAY_ALPHA;
      octx.drawImage(canvas, 0, 0);
      const maskUrl = out.toDataURL('image/png');
      onSave(maskUrl);
    } finally {
      out.width = 1;
      out.height = 1;
    }
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

  // ── 滚轮缩放（非 passive，允许 preventDefault）──
  useEffect(() => {
    if (!isOpen) return;
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.12 : 0.12;
      setScale((prev) => Math.max(0.5, Math.min(6, Math.round((prev + prev * delta) * 100) / 100)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isOpen]);

  // ── 缩放级别 / 窗口变化后，重算光标换算比例 ──
  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(recomputeDispScale);
    window.addEventListener('resize', recomputeDispScale);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', recomputeDispScale);
    };
  }, [isOpen, scale, recomputeDispScale]);

  // ── 空格键：进入/退出平移就绪态 ──
  useEffect(() => {
    if (!isOpen) return;
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        spaceDown.current = true;
        setPanReady(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        setPanReady(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // 画笔光标圆圈的屏幕直径 = 笔刷画布尺寸 × 显示换算比例（含缩放），保证与实际笔触一致
  const cursorD = Math.max(6, Math.round(brushSize * dispScale));

  return createPortal(
    <div data-tauri-drag-region className="matting-overlay">
      <div className="matting-toolbar-dock">
        <MattingToolbar
          onCancel={onClose}
          onSave={handleSave}
          onToolChange={setTool}
          onBrushSizeChange={setBrushSize}
          onBrushModeChange={setBrushMode}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClear={handleClear}
          canUndo={history.idx > 0}
          canRedo={history.idx < history.len - 1}
        />
        <ImageEditorZoomControls
          scale={scale}
          minScale={0.5}
          maxScale={6}
          onZoomChange={handleZoomChange}
          onReset={resetView}
        />
      </div>

      <div className="matting-stage" ref={stageRef}>
        <div
          className="matting-zoom"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        >
          <div className="matting-viewport">
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
              style={{
                opacity: MASK_DISPLAY_ALPHA,
                ...(panReady
                  ? { cursor: panning ? 'grabbing' : 'grab' }
                  : tool !== 'bucket'
                    ? {
                        cursor: `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="${cursorD}" height="${cursorD}" viewBox="0 0 ${cursorD} ${cursorD}"><circle cx="${cursorD / 2}" cy="${cursorD / 2}" r="${cursorD / 2 - 1}" fill="none" stroke="white" stroke-width="1" opacity="0.8"/></svg>') ${cursorD / 2} ${cursorD / 2}, auto`,
                      }
                    : {}),
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />
          </div>
        </div>

      </div>
    </div>,
    document.body,
  );
}
