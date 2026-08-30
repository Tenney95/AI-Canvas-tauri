/**
 * CropEditor — 图像裁切全屏编辑器
 * 基于 react-image-crop，提供自由裁切 + 预设宽高比
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import ReactCrop, {
  type Crop,
  type PixelCrop,
  convertToPixelCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import FullscreenOverlay from '../../../shared/FullscreenOverlay';
import AnimatedButton from '../../../shared/AnimatedButton';
import { springGentle } from '../../../../utils/motion';
import { useImageViewportGesture } from '../../../../hooks/useImageViewportGesture';
import ImageEditorZoomControls from './ImageEditorZoomControls';
import PenCropLayer, { type PenCropHandle, type Anchor } from './PenCropLayer';
import { makeContainedCenteredCrop } from './cropUtils';
import { assertEditorCanvasBudget, canvasToDataUrl } from './imageResourceBudget';
import { beginCropOperation, type CropOperation } from './cropOperationRegistry';
import { createSafeImagePreviewSource, type SafeImagePreviewSource } from './imageUtils';

/* ── 类型 ── */
type AspectPreset = 'free' | '1:1' | '4:3' | '16:9' | '3:4' | '9:16';
type CropMode = 'rect' | 'pen';

interface CropEditorProps {
  isOpen: boolean;
  imageUrl: string;
  onClose: () => void;
  /** 点击确认后立即调用（在关闭弹窗之前），用于创建 loading 节点 */
  onStart?: () => void;
  onSave: (croppedDataUrl: string, metadata?: { width: number; height: number }) => void | Promise<void>;
  /** 跨卸载/重开识别同一节点，避免旧裁切结果覆盖新结果。 */
  operationKey?: string;
}

/* ── 预设 ── */
const ASPECT_OPTIONS: { key: AspectPreset; label: string; ratio?: number }[] = [
  { key: 'free', label: '自由' },
  { key: '1:1', label: '1:1', ratio: 1 },
  { key: '4:3', label: '4:3', ratio: 4 / 3 },
  { key: '16:9', label: '16:9', ratio: 16 / 9 },
  { key: '3:4', label: '3:4', ratio: 3 / 4 },
  { key: '9:16', label: '9:16', ratio: 9 / 16 },
];

function toDisplayedPixelCrop(percentCrop: Crop, img: HTMLImageElement, scale: number): PixelCrop {
  return convertToPixelCrop(percentCrop, img.clientWidth * scale, img.clientHeight * scale);
}

/** 将钢笔锚点（自然坐标）描成 canvas 贝塞尔路径 */
function tracePenPath(ctx: CanvasRenderingContext2D, anchors: Anchor[]) {
  ctx.beginPath();
  ctx.moveTo(anchors[0].p.x, anchors[0].p.y);
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i];
    const nxt = anchors[(i + 1) % anchors.length];
    const c1 = cur.hOut ?? cur.p;
    const c2 = nxt.hIn ?? nxt.p;
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, nxt.p.x, nxt.p.y);
  }
  ctx.closePath();
}

/* ════════════════════════════════════════════
   CropEditor
   ════════════════════════════════════════════ */
export default function CropEditor({ isOpen, imageUrl, onClose, onStart, onSave, operationKey }: CropEditorProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const cropFrameRef = useRef<number | null>(null);
  const pendingCropRef = useRef<Crop | undefined>(undefined);
  const latestPixelCropRef = useRef<PixelCrop | undefined>(undefined);
  const activeOperationRef = useRef<CropOperation | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  const [aspect, setAspect] = useState<AspectPreset>('free');
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [mode, setMode] = useState<CropMode>('rect');
  const [penReady, setPenReady] = useState(false);
  const [imgSize, setImgSize] = useState({ natW: 0, natH: 0, clientW: 0 });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewSource, setPreviewSource] = useState<SafeImagePreviewSource | null>(null);
  const penRef = useRef<PenCropHandle>(null);
  const {
    containerRef: stageRef,
    scale,
    tx,
    ty,
    dragging,
    gesturing,
    onPointerDown: onStagePan,
    reset: resetViewport,
    zoomTo,
  } = useImageViewportGesture({
    initialScale: 1,
    minScale: 0.1,
    maxScale: 5,
    enablePointerPan: true,
    enableWheelPan: true, // macOS 双指滑动平移（wheel 事件，放大后生效）
    panButtons: [1, 2], // 滚轮键 / 右键拖拽平移（左键留给 ReactCrop 框选）
  });

  const aspectRatio = ASPECT_OPTIONS.find((o) => o.key === aspect)?.ratio;

  const cancelPendingCrop = useCallback(() => {
    if (cropFrameRef.current !== null) cancelAnimationFrame(cropFrameRef.current);
    cropFrameRef.current = null;
    pendingCropRef.current = undefined;
    latestPixelCropRef.current = undefined;
  }, []);

  const flushPendingCrop = useCallback(() => {
    if (cropFrameRef.current !== null) cancelAnimationFrame(cropFrameRef.current);
    cropFrameRef.current = null;
    const nextCrop = pendingCropRef.current;
    pendingCropRef.current = undefined;
    if (nextCrop) setCrop(nextCrop);
  }, []);

  useEffect(() => cancelPendingCrop, [cancelPendingCrop]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!isOpen || !imageUrl) return;
    let active = true;
    let prepared: SafeImagePreviewSource | null = null;
    void createSafeImagePreviewSource(imageUrl, '裁切源图').then((result) => {
      if (!active) {
        result.release();
        return;
      }
      prepared = result;
      setPreviewSource(result);
      setFailure(null);
    }).catch((error) => {
      if (active) setFailure(error instanceof Error ? error.message : '裁切源图读取失败，请重试');
    });
    return () => {
      active = false;
      prepared?.release();
    };
  }, [imageUrl, isOpen]);
  const activePreviewSource = previewSource?.sourceUrl === imageUrl ? previewSource : null;

  const beginConfirm = useCallback((): CropOperation | null => {
    if (busyRef.current) return null;
    const operation = beginCropOperation(operationKey ?? onSave);
    if (!operation) {
      setFailure('上一次裁切仍在处理中，请稍后再试');
      return null;
    }
    busyRef.current = true;
    setBusy(true);
    activeOperationRef.current = operation;
    return operation;
  }, [onSave, operationKey]);

  const finishConfirm = useCallback((operation: CropOperation) => {
    operation.complete();
    if (activeOperationRef.current !== operation) return;
    activeOperationRef.current = null;
    busyRef.current = false;
    if (mountedRef.current) setBusy(false);
  }, []);

  const cancelActiveConfirm = useCallback(() => {
    activeOperationRef.current?.cancel();
    activeOperationRef.current = null;
    busyRef.current = false;
    if (mountedRef.current) setBusy(false);
  }, []);

  /* ── 双击重置缩放 ── */
  const handleDoubleClick = useCallback(() => resetViewport(), [resetViewport]);

  /* ── 中键/右键：拦截 ReactCrop 框选并交给手势平移（左键仍归框选）── */
  const handleStagePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1 || e.button === 2) {
        // 捕获阶段始终拦截，阻止 ReactCrop 在中键/右键时创建裁剪框
        e.preventDefault();
        e.stopPropagation();
      }
      onStagePan(e); // 放大后才会真正平移（hook 内部判定）
    },
    [onStagePan],
  );

  /* ── 关闭：重置所有状态 ── */
  const handleClose = useCallback(() => {
    if (busyRef.current) return;
    cancelActiveConfirm();
    cancelPendingCrop();
    setCrop(undefined);
    setCompletedCrop(undefined);
    setAspect('free');
    setMode('rect');
    penRef.current?.reset();
    setPenReady(false);
    setFailure(null);
    resetViewport();
    onClose();
  }, [cancelActiveConfirm, cancelPendingCrop, onClose, resetViewport]);

  /* ── 图片加载：初始化居中裁切框 ── */
  const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: w, naturalHeight: h, clientWidth } = e.currentTarget;
    if (!w || !h) return;

    setImgSize({ natW: w, natH: h, clientW: clientWidth || w });
    setFailure(null);

    const ratio = aspectRatio ?? w / h;
    const initial = makeContainedCenteredCrop(ratio, w, h);
    setCrop(initial);
    setCompletedCrop(toDisplayedPixelCrop(initial, e.currentTarget, scale));
  }, [aspectRatio, scale]);

  /* ── 裁切变更 ── */
  const handleChange = useCallback(
    (pixelCrop: PixelCrop, percentCrop: Crop) => {
      latestPixelCropRef.current = pixelCrop;
      pendingCropRef.current = percentCrop;
      if (cropFrameRef.current !== null) return;
      cropFrameRef.current = requestAnimationFrame(() => {
        cropFrameRef.current = null;
        const nextCrop = pendingCropRef.current;
        pendingCropRef.current = undefined;
        if (nextCrop) setCrop(nextCrop);
      });
    },
    [],
  );

  const handleComplete = useCallback(
    (pixelCrop: PixelCrop) => {
      setCompletedCrop(latestPixelCropRef.current ?? pixelCrop);
      latestPixelCropRef.current = undefined;
    },
    [],
  );

  /* ── 重置本地状态（确认/关闭后复用）── */
  const resetLocal = useCallback(() => {
    cancelPendingCrop();
    setCrop(undefined);
    setCompletedCrop(undefined);
    setAspect('free');
    setMode('rect');
    penRef.current?.reset();
    setPenReady(false);
    setFailure(null);
    resetViewport();
  }, [cancelPendingCrop, resetViewport]);

  /* ── 钢笔裁切：沿贝塞尔路径裁切为透明 PNG ── */
  const confirmPen = useCallback(async () => {
    const img = imgRef.current;
    const data = penRef.current?.getData();
    if (!img || !data || !data.closed || data.anchors.length < 3) return;
    const operation = beginConfirm();
    if (!operation) return;
    const { natW, natH } = imgSize;

    let canvas: HTMLCanvasElement | null = null;
    let started = false;
    let delivered = false;
    try {
      // 控制点凸包包络即路径包围盒，取整并裁到图像范围
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const acc = (p: { x: number; y: number }) => {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      };
      for (const a of data.anchors) {
        acc(a.p);
        if (a.hIn) acc(a.hIn);
        if (a.hOut) acc(a.hOut);
      }
      minX = Math.max(0, Math.floor(minX));
      minY = Math.max(0, Math.floor(minY));
      maxX = Math.min(natW, Math.ceil(maxX));
      maxY = Math.min(natH, Math.ceil(maxY));
      const bw = Math.max(1, maxX - minX);
      const bh = Math.max(1, maxY - minY);
      assertEditorCanvasBudget(bw, bh, '钢笔裁切输出');

      onStart?.();
      started = true;
      resetLocal();

      canvas = document.createElement('canvas');
      canvas.width = bw;
      canvas.height = bh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('钢笔裁切画布初始化失败，请重试');

      ctx.translate(-minX, -minY);
      tracePenPath(ctx, data.anchors);
      ctx.clip();

      ctx.drawImage(img, 0, 0, natW, natH);

      const dataUrl = await canvasToDataUrl(canvas);
      if (!operation.isCurrent()) return;
      delivered = true;
      await onSave(dataUrl, { width: bw, height: bh });
    } catch (err) {
      if (!operation.isCurrent()) return;
      console.error('[CropEditor] pen crop failed:', err);
      setFailure(err instanceof Error ? err.message : '钢笔裁切失败，请重试');
      if (started && !delivered) {
        try {
          await onSave('', { width: 0, height: 0 });
        } catch (deliveryError) {
          console.error('[CropEditor] failed to deliver pen crop failure:', deliveryError);
        }
      }
    } finally {
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
      finishConfirm(operation);
    }
  }, [beginConfirm, finishConfirm, imgSize, onSave, onStart, resetLocal]);

  /* ── 矩形裁切 ── */
  const confirmRect = useCallback(async () => {
    const img = imgRef.current;
    if (!img || !completedCrop || completedCrop.width <= 0 || completedCrop.height <= 0) return;
    const operation = beginConfirm();
    if (!operation) return;

    const { x, y, width, height } = completedCrop;

    // completedCrop 坐标基于 DOM 视觉渲染尺寸（含 CSS transform scale），需换算到自然分辨率
    const visualW = img.clientWidth * scale;
    const visualH = img.clientHeight * scale;
    const scaleX = img.naturalWidth / visualW;
    const scaleY = img.naturalHeight / visualH;

    let canvas: HTMLCanvasElement | null = null;
    let started = false;
    let delivered = false;
    try {
      const destW = Math.round(width * scaleX);
      const destH = Math.round(height * scaleY);
      assertEditorCanvasBudget(destW, destH, '矩形裁切输出');

      onStart?.();
      started = true;
      resetLocal();

      canvas = document.createElement('canvas');
      canvas.width = destW;
      canvas.height = destH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('矩形裁切画布初始化失败，请重试');

      ctx.drawImage(
        img,
        x * scaleX, y * scaleY, width * scaleX, height * scaleY,
        0, 0, destW, destH,
      );

      const dataUrl = await canvasToDataUrl(canvas);
      if (!operation.isCurrent()) return;
      delivered = true;
      await onSave(dataUrl, { width: destW, height: destH });
    } catch (err) {
      if (!operation.isCurrent()) return;
      console.error('[CropEditor] crop failed:', err);
      setFailure(err instanceof Error ? err.message : '矩形裁切失败，请重试');
      if (started && !delivered) {
        try {
          await onSave('', { width: 0, height: 0 });
        } catch (deliveryError) {
          console.error('[CropEditor] failed to deliver crop failure:', deliveryError);
        }
      }
    } finally {
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
      finishConfirm(operation);
    }
  }, [beginConfirm, completedCrop, finishConfirm, onSave, onStart, resetLocal, scale]);

  /* ── 确认裁切：立即关闭弹窗 → 后台裁切 → 回调 onSave ── */
  const handleConfirm = useCallback(() => {
    if (mode === 'pen') return confirmPen();
    return confirmRect();
  }, [mode, confirmPen, confirmRect]);

  /* ── 宽高比切换 ── */
  const handleAspectChange = useCallback(
    (preset: AspectPreset) => {
      setAspect(preset);
      setFailure(null);
      const img = imgRef.current;
      if (!img) return;
      const { naturalWidth: w, naturalHeight: h } = img;
      const ratio = ASPECT_OPTIONS.find((o) => o.key === preset)?.ratio;
      if (ratio) {
        cancelPendingCrop();
        const nextCrop = makeContainedCenteredCrop(ratio, w, h);
        setCrop(nextCrop);
        setCompletedCrop(toDisplayedPixelCrop(nextCrop, img, scale));
      }
    },
    [cancelPendingCrop, scale],
  );

  /* ── 宽高比变化后重新计算初始裁切 ── */
  // handled in handleAspectChange for explicit button clicks
  // onImageLoad handles the initial load case

  return (
    <FullscreenOverlay
      isOpen={isOpen}
      onClose={handleClose}
      hidePanel
      className="crop-overlay"
    >
      <motion.div
        className="crop-content"
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springGentle}
        onClick={(e) => e.stopPropagation()}
      >
      {/* ── 裁切工具栏（模式 + 宽高比/钢笔 + 确认按钮）── */}
      <div className="crop-toolbar-dock">
        <div className="crop-aspect-bar">
        {/* 模式切换：矩形 / 钢笔 */}
        <div className="crop-mode-toggle">
          <button
            type="button"
            className={`crop-aspect-btn${mode === 'rect' ? ' active' : ''}`}
            onClick={() => { setMode('rect'); setFailure(null); }}
          >
            矩形
          </button>
          <button
            type="button"
            className={`crop-aspect-btn${mode === 'pen' ? ' active' : ''}`}
            onClick={() => { setMode('pen'); setFailure(null); }}
          >
            钢笔
          </button>
        </div>
        <div className="crop-bar-divider" />

        {mode === 'rect' ? (
          ASPECT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`crop-aspect-btn${aspect === opt.key ? ' active' : ''}`}
              onClick={() => handleAspectChange(opt.key)}
            >
              {opt.label}
            </button>
          ))
        ) : (
          <>
            <span className="crop-pen-hint">单击落点 · 拖拽出曲线 · 点首锚点闭合 · 双击切角点</span>
            <button
              type="button"
              className="crop-aspect-btn"
              onClick={() => { penRef.current?.reset(); setPenReady(false); }}
            >
              清除
            </button>
          </>
        )}

        <div className="crop-aspect-spacer" />
        {failure && (
          <span className="max-w-[360px] text-xs leading-relaxed text-red-300" role="alert">
            {failure}
          </span>
        )}
        <AnimatedButton
          className="crop-action-btn confirm"
          data-tooltip="确认裁切"
          aria-label="确认裁切"
          disabled={busy || !activePreviewSource || (mode === 'pen' ? !penReady : !completedCrop)}
          onClick={handleConfirm}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M3 17l5-5 3 3 8-8" />
          </svg>
          <span>确认</span>
        </AnimatedButton>
        <AnimatedButton
          type="button"
          className="crop-aspect-btn crop-aspect-close crop-toolbar-close act-cancel"
          data-tooltip="关闭 (Esc)"
          aria-label="关闭"
          disabled={busy}
          onClick={handleClose}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </AnimatedButton>
        </div>
        <ImageEditorZoomControls
          scale={scale}
          minScale={0.1}
          maxScale={5}
          onZoomChange={zoomTo}
          onReset={resetViewport}
        />
      </div>
      <div
        className={`crop-stage${mode === 'pen' ? ' pen-mode' : ''}`}
        ref={stageRef}
        onDoubleClick={handleDoubleClick}
        onPointerDownCapture={handleStagePointerDown}
        onContextMenu={(e) => e.preventDefault()}
        style={dragging ? { cursor: 'grabbing' } : undefined}
      >
        <div
          className="crop-zoom-stage"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transition: gesturing || dragging ? 'none' : 'transform 0.18s var(--ease-out-expo, ease-out)',
          }}
        >
          {activePreviewSource && <ReactCrop
            crop={crop}
            onChange={handleChange}
            onComplete={handleComplete}
            onDragEnd={flushPendingCrop}
            aspect={aspectRatio}
            minWidth={40}
            minHeight={40}
            className="crop-react-wrapper"
          >
            <img
              ref={imgRef}
              src={activePreviewSource.src}
              alt="Crop preview"
              className="crop-image"
              onLoad={onImageLoad}
              draggable={false}
            />
          </ReactCrop>}
          <PenCropLayer
            ref={penRef}
            active={mode === 'pen'}
            naturalWidth={imgSize.natW}
            naturalHeight={imgSize.natH}
            displayWidth={imgSize.clientW}
            scale={scale}
            onReadyChange={setPenReady}
          />
        </div>
      </div>
      </motion.div>
    </FullscreenOverlay>
  );
}
