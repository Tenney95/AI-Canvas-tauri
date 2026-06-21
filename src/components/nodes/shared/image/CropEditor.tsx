/**
 * CropEditor — 图像裁切全屏编辑器
 * 基于 react-image-crop，提供自由裁切 + 预设宽高比
 */
import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import ReactCrop, {
  type Crop,
  type PixelCrop,
  centerCrop,
  makeAspectCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import FullscreenOverlay from '../../../shared/FullscreenOverlay';
import AnimatedButton from '../../../shared/AnimatedButton';
import { springGentle } from '../../../../utils/motion';
import { fetchImageForCrop } from '../../../../services/fileService';
import { useImageViewportGesture } from '../../../../hooks/useImageViewportGesture';

/* ── 类型 ── */
type AspectPreset = 'free' | '1:1' | '4:3' | '16:9' | '3:4' | '9:16';

interface CropEditorProps {
  isOpen: boolean;
  imageUrl: string;
  onClose: () => void;
  /** 点击确认后立即调用（在关闭弹窗之前），用于创建 loading 节点 */
  onStart?: () => void;
  onSave: (croppedDataUrl: string, metadata?: { width: number; height: number }) => void;
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

/* ════════════════════════════════════════════
   CropEditor
   ════════════════════════════════════════════ */
export default function CropEditor({ isOpen, imageUrl, onClose, onStart, onSave }: CropEditorProps) {
  const imgRef = useRef<HTMLImageElement>(null);

  const [aspect, setAspect] = useState<AspectPreset>('free');
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const {
    containerRef: stageRef,
    scale,
    gesturing,
    reset: resetViewport,
  } = useImageViewportGesture({
    initialScale: 1,
    minScale: 0.1,
    maxScale: 5,
    enablePointerPan: false,
    enableWheelPan: false,
  });

  const aspectRatio = ASPECT_OPTIONS.find((o) => o.key === aspect)?.ratio;

  /* ── 双击重置缩放 ── */
  const handleDoubleClick = useCallback(() => resetViewport(), [resetViewport]);

  /* ── 关闭：重置所有状态 ── */
  const handleClose = useCallback(() => {
    setCrop(undefined);
    setCompletedCrop(undefined);
    setAspect('free');
    resetViewport();
    onClose();
  }, [onClose, resetViewport]);

  /* ── 图片加载：初始化居中裁切框 ── */
  const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (!w || !h) return;

    const ratio = aspectRatio ?? w / h;
    const initial = centerCrop(
      makeAspectCrop({ unit: '%', width: 80 }, ratio, w, h),
      w,
      h,
    );
    setCrop(initial);
    // react-image-crop 初次 onComplete 由组件内部触发，这里还需手动设置初始完成值
  }, [aspectRatio]);

  /* ── 裁切变更 ── */
  const handleChange = useCallback(
    (_pixelCrop: PixelCrop, percentCrop: Crop) => {
      setCrop(percentCrop);
    },
    [],
  );

  const handleComplete = useCallback(
    (pixelCrop: PixelCrop) => {
      setCompletedCrop(pixelCrop);
    },
    [],
  );

  /* ── 确认裁切：立即关闭弹窗 → 后台裁切 → 回调 onSave ── */
  const handleConfirm = useCallback(async () => {
    const img = imgRef.current;
    if (!img || !completedCrop || completedCrop.width <= 0 || completedCrop.height <= 0) return;

    const { x, y, width, height } = completedCrop;

    // completedCrop 坐标基于 DOM 视觉渲染尺寸（含 CSS transform scale），需换算到自然分辨率
    // clientWidth/clientHeight 不受 CSS transform 影响，但 ReactCrop 的 getBoundingClientRect 会
    // 所以需要乘以 scale 得到真实视觉尺寸
    const visualW = img.clientWidth * scale;
    const visualH = img.clientHeight * scale;
    const scaleX = img.naturalWidth / visualW;
    const scaleY = img.naturalHeight / visualH;

    // 1. 通知父组件创建 loading 节点（父组件通过 setIsCrop(false) 关闭弹窗）
    onStart?.();

    // 2. 重置本地状态（不再调用 onClose，避免与 handleCloseCrop 冲突清掉 pendingCropNodeId）
    setCrop(undefined);
    setCompletedCrop(undefined);
    setAspect('free');
    resetViewport();

    // 3. 后台裁切（异步，不阻塞 UI）
    try {
      const destW = Math.round(width * scaleX);
      const destH = Math.round(height * scaleY);
      const canvas = document.createElement('canvas');
      canvas.width = destW;
      canvas.height = destH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // data:/blob: 同源 URL，直接从 DOM img 绘制（不会污染 canvas）
      if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
        ctx.drawImage(
          img,
          x * scaleX, y * scaleY, width * scaleX, height * scaleY,
          0, 0, destW, destH,
        );
      } else if (
        imageUrl.startsWith('asset://') ||
        imageUrl.includes('asset.localhost')
      ) {
        // Tauri 本地资源：fetch 跨源响应创建的 blob: URL 仍可能污染 canvas
        // 必须通过 FileReader 转成 data: URL（绝对同源）再绘制
        const resp = await fetch(imageUrl);
        const blob = await resp.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        const sourceImg = new Image();
        sourceImg.src = dataUrl;
        await sourceImg.decode();
        ctx.drawImage(
          sourceImg,
          x * scaleX, y * scaleY, width * scaleX, height * scaleY,
          0, 0, destW, destH,
        );
      } else {
        // http:/https: 远程 URL 通过 Rust 原生 HTTP 下载，绕过 WebView CORS
        const safeUrl = await fetchImageForCrop(imageUrl);
        const sourceImg = new Image();
        sourceImg.src = safeUrl;
        await sourceImg.decode();
        ctx.drawImage(
          sourceImg,
          x * scaleX, y * scaleY, width * scaleX, height * scaleY,
          0, 0, destW, destH,
        );
      }

      const dataUrl = canvas.toDataURL('image/png');
      onSave(dataUrl, { width: destW, height: destH });
    } catch (err) {
      console.error('[CropEditor] crop failed:', err);
      onSave('', { width: 0, height: 0 });
    }
  }, [completedCrop, imageUrl, onSave, onStart, resetViewport, scale]);

  /* ── 宽高比切换 ── */
  const handleAspectChange = useCallback(
    (preset: AspectPreset) => {
      setAspect(preset);
      const img = imgRef.current;
      if (!img) return;
      const { naturalWidth: w, naturalHeight: h } = img;
      const ratio = ASPECT_OPTIONS.find((o) => o.key === preset)?.ratio;
      if (ratio) {
        // 基于当前裁切框中心，调整为新宽高比
        const baseCrop = completedCrop
          ? { unit: '%' as const, x: ((completedCrop.x + completedCrop.width / 2) / w) * 100 - 40, y: ((completedCrop.y + completedCrop.height / 2) / h) * 100 - (40 / ratio) * (h / w) * 100, width: 80, height: (80 / ratio) * (h / w) }
          : { unit: '%' as const, width: 80 };
        const newCrop = makeAspectCrop(baseCrop, ratio, w, h);
        const centered = centerCrop(newCrop, w, h);
        setCrop(centered);
      }
    },
    [completedCrop],
  );

  /* ── 宽高比变化后重新计算初始裁切 ── */
  // handled in handleAspectChange for explicit button clicks
  // onImageLoad handles the initial load case

  return (
    <FullscreenOverlay
      isOpen={isOpen}
      onClose={handleClose}
      title="裁切"
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
      {/* ── 裁切工具栏（宽高比 + 确认按钮）── */}
      <div className="crop-aspect-bar">
        <AnimatedButton
          type="button"
          className="crop-aspect-btn crop-aspect-close act-cancel"
          data-tooltip="关闭 (Esc)"
          aria-label="关闭"
          onClick={handleClose}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </AnimatedButton>
        {ASPECT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={`crop-aspect-btn${aspect === opt.key ? ' active' : ''}`}
            onClick={() => handleAspectChange(opt.key)}
          >
            {opt.label}
          </button>
        ))}
        <div className="crop-aspect-spacer" />
        <AnimatedButton
          className="crop-action-btn confirm"
          data-tooltip="确认裁切"
          aria-label="确认裁切"
          onClick={handleConfirm}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M3 17l5-5 3 3 8-8" />
          </svg>
          <span>确认</span>
        </AnimatedButton>
      </div>
      <div
        className="crop-stage"
        ref={stageRef}
        onDoubleClick={handleDoubleClick}
      >
        <div
          className="crop-zoom-stage"
          style={{
            transform: `scale(${scale})`,
            transition: gesturing ? 'none' : 'transform 0.18s var(--ease-out-expo, ease-out)',
          }}
        >
          <ReactCrop
            crop={crop}
            onChange={handleChange}
            onComplete={handleComplete}
            aspect={aspectRatio}
            minWidth={40}
            minHeight={40}
            className="crop-react-wrapper"
          >
            <img
              ref={imgRef}
              src={imageUrl}
              alt="Crop preview"
              className="crop-image"
              onLoad={onImageLoad}
              draggable={false}
            />
          </ReactCrop>
        </div>
        {scale !== 1 && (
          <span className="crop-zoom-indicator">{Math.round(scale * 100)}%</span>
        )}
      </div>
      </motion.div>
    </FullscreenOverlay>
  );
}
