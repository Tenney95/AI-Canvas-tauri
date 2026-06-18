/**
 * ExpandEditor — 图像扩图（outpainting）全屏编辑器
 * 与 CropEditor 镜像对称：CropEditor 往内裁，ExpandEditor 往外扩。
 * 选择目标画幅 → 原图居中放入更大的目标画布 → 四周透明留白交给 AI 补全。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import FullscreenOverlay from '../../../shared/FullscreenOverlay';
import AnimatedButton from '../../../shared/AnimatedButton';
import ModelSelector from '../ModelSelector';
import { springGentle } from '../../../../utils/motion';
import { fetchImageForCrop } from '../../../../services/fileService';
import type { ModelGroup, ModelOption } from '../../../../types';

/* ── 类型 ── */
type AspectPreset = 'original' | '1:1' | '4:3' | '16:9' | '3:4' | '9:16';

export interface ExpandEditorProps {
  isOpen: boolean;
  imageUrl: string;
  onClose: () => void;
  /** 确认后回调：传出合成好的"垫图"data URL、目标画幅 size 字符串、模型与补充提示词 */
  onGenerate: (
    compositeDataUrl: string,
    meta: { size: string; width: number; height: number; model: string; provider: string; prompt: string },
  ) => void;
}

/* ── 画幅预设（ratio = 宽/高，undefined 表示保持原比例仅四周外扩）── */
const ASPECT_OPTIONS: { key: AspectPreset; label: string; ratio?: number }[] = [
  { key: 'original', label: '原比例' },
  { key: '1:1', label: '1:1', ratio: 1 },
  { key: '4:3', label: '4:3', ratio: 4 / 3 },
  { key: '16:9', label: '16:9', ratio: 16 / 9 },
  { key: '3:4', label: '3:4', ratio: 3 / 4 },
  { key: '9:16', label: '9:16', ratio: 9 / 16 },
];

/* ── 扩图模型（复用 APIMart 图生图模型，Nano Banana 系列扩图效果好）── */
const EXPAND_MODEL_GROUPS: ModelGroup[] = [
  {
    id: 'apimart',
    name: 'APIMart',
    description: '一个 API 搞定一切——节省 30-70%',
    iconType: 'badge',
    badgeText: 'AM',
    models: [
      { value: 'apimart/gemini-3.1-flash-image-preview', provider: 'apimart', label: 'Nano Banana 3.1', description: '最新 Nano Banana，扩图无缝衔接', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'AM' } as ModelOption,
      { value: 'apimart/gemini-3-pro-image-preview', provider: 'apimart', label: 'Nano Banana Pro', description: '专业级画质，光影渲染深度优化', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'AM' } as ModelOption,
      { value: 'apimart/gpt-image-2', provider: 'apimart', label: 'GPT Image 2', description: 'OpenAI 图像生成，支持图生图', nodeTypes: ['ai-image'], iconType: 'badge', badgeText: 'AM' } as ModelOption,
    ],
  },
];

/* ── 把任意目标比例归一到 API 接受的标准画幅字符串 ── */
const STANDARD_SIZES: { size: string; ratio: number }[] = [
  { size: '1:1', ratio: 1 },
  { size: '4:3', ratio: 4 / 3 },
  { size: '3:4', ratio: 3 / 4 },
  { size: '16:9', ratio: 16 / 9 },
  { size: '9:16', ratio: 9 / 16 },
];
function nearestSize(ratio: number): string {
  let best = STANDARD_SIZES[0];
  let bestDiff = Infinity;
  for (const s of STANDARD_SIZES) {
    const diff = Math.abs(Math.log(s.ratio / ratio));
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best.size;
}

/* ── 跨源加载图片为 HTMLImageElement（复用 CropEditor 的同源化策略）── */
async function loadSourceImage(imageUrl: string): Promise<HTMLImageElement> {
  let src = imageUrl;
  if (
    !imageUrl.startsWith('data:') &&
    !imageUrl.startsWith('blob:')
  ) {
    if (imageUrl.startsWith('asset://') || imageUrl.includes('asset.localhost')) {
      // Tauri 本地资源：fetch → FileReader 转 data URL 避免污染 canvas
      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } else {
      // 远程 URL：经 Rust 端下载
      src = await fetchImageForCrop(imageUrl);
    }
  }
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/* ════════════════════════════════════════════
   ExpandEditor
   ════════════════════════════════════════════ */
export default function ExpandEditor({ isOpen, imageUrl, onClose, onGenerate }: ExpandEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);

  const [aspect, setAspect] = useState<AspectPreset>('1:1');
  const [zoom, setZoom] = useState(0.8);            // 原图在目标画布中的占比（越小，四周留白越多）
  const [offset, setOffset] = useState({ x: 0, y: 0 }); // 原图相对居中位置的偏移（归一化 -0.5~0.5）
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const [selectedModel, setSelectedModel] = useState('apimart/gemini-3.1-flash-image-preview');
  const [selectedProvider, setSelectedProvider] = useState('apimart');

  /* ── 打开时加载原图自然尺寸 ── */
  useEffect(() => {
    if (!isOpen || !imageUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [isOpen, imageUrl]);

  /* ── 跟踪舞台可用尺寸（用于把目标画布等比缩放到视口内）── */
  useEffect(() => {
    if (!isOpen) return;
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStageBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);

  /* ── 计算目标画布的自然分辨率尺寸 ──
     1. 先按目标比例让原图"贴边内接"得到 base 画布
     2. 再除以 zoom 放大画布，使原图四周留白 */
  const target = useMemo(() => {
    if (!natural) return null;
    const { w: sw, h: sh } = natural;
    const srcRatio = sw / sh;
    const ratio = ASPECT_OPTIONS.find((o) => o.key === aspect)?.ratio ?? srcRatio;

    let baseW: number;
    let baseH: number;
    if (ratio >= srcRatio) {
      // 目标更宽 → 高度贴边
      baseH = sh;
      baseW = Math.round(sh * ratio);
    } else {
      // 目标更高 → 宽度贴边
      baseW = sw;
      baseH = Math.round(sw / ratio);
    }
    const z = Math.max(0.3, Math.min(1, zoom));
    const tw = Math.round(baseW / z);
    const th = Math.round(baseH / z);

    // 原图在目标画布中可移动的最大偏移（自然像素）
    const maxOffX = (tw - sw) / 2;
    const maxOffY = (th - sh) / 2;
    return { tw, th, sw, sh, maxOffX, maxOffY, ratio };
  }, [natural, aspect, zoom]);

  /* ── 目标画布在舞台中的显示缩放（contain）── */
  const display = useMemo(() => {
    if (!target || !stageBox.w || !stageBox.h) return null;
    const margin = 0.82; // 留点边距给棋盘格外圈
    const scale = Math.min((stageBox.w * margin) / target.tw, (stageBox.h * margin) / target.th);
    return {
      scale,
      frameW: target.tw * scale,
      frameH: target.th * scale,
      imgW: target.sw * scale,
      imgH: target.sh * scale,
    };
  }, [target, stageBox]);

  /* ── 切换画幅时重置偏移 ── */
  const handleAspectChange = useCallback((preset: AspectPreset) => {
    setAspect(preset);
    setOffset({ x: 0, y: 0 });
  }, []);

  /* ── 拖拽原图重定位 ── */
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [offset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !target || !display) return;
    // 屏幕位移 → 归一化偏移（相对可移动范围）
    const dxNat = (e.clientX - d.startX) / display.scale;
    const dyNat = (e.clientY - d.startY) / display.scale;
    const nx = target.maxOffX > 0 ? d.ox + dxNat / (2 * target.maxOffX) : 0;
    const ny = target.maxOffY > 0 ? d.oy + dyNat / (2 * target.maxOffY) : 0;
    setOffset({
      x: Math.max(-0.5, Math.min(0.5, nx)),
      y: Math.max(-0.5, Math.min(0.5, ny)),
    });
  }, [target, display]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  /* ── 关闭：重置状态 ── */
  const handleClose = useCallback(() => {
    setAspect('1:1');
    setZoom(0.8);
    setOffset({ x: 0, y: 0 });
    setPrompt('');
    setBusy(false);
    onClose();
  }, [onClose]);

  const handleSelectModel = useCallback((model: ModelOption) => {
    setSelectedModel(model.value);
    setSelectedProvider(model.provider);
  }, []);

  const handleZoomChange = useCallback((val: number) => {
    setZoom(val);
    setOffset({ x: 0, y: 0 });
  }, []);

  /* ── 确认：合成"垫图"画布 → 回调 onGenerate ── */
  const handleConfirm = useCallback(async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      const img = await loadSourceImage(imageUrl);
      const { tw, th, sw, sh, maxOffX, maxOffY } = target;

      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      if (!ctx) { setBusy(false); return; }

      // 透明背景（留白区），原图按偏移居中绘制
      const dx = (tw - sw) / 2 + offset.x * 2 * maxOffX;
      const dy = (th - sh) / 2 + offset.y * 2 * maxOffY;
      ctx.drawImage(img, dx, dy, sw, sh);

      const dataUrl = canvas.toDataURL('image/png');
      const size = aspect === 'original' ? nearestSize(tw / th)
        : (ASPECT_OPTIONS.find((o) => o.key === aspect)?.ratio ? aspect : nearestSize(tw / th));

      // 重置并交给父组件处理异步生成
      const meta = { size, width: tw, height: th, model: selectedModel, provider: selectedProvider, prompt };
      setAspect('1:1');
      setZoom(0.8);
      setOffset({ x: 0, y: 0 });
      setPrompt('');
      setBusy(false);
      onGenerate(dataUrl, meta);
    } catch (err) {
      console.error('[ExpandEditor] composite failed:', err);
      setBusy(false);
    }
  }, [target, busy, imageUrl, offset, aspect, selectedModel, selectedProvider, prompt, onGenerate]);

  return (
    <FullscreenOverlay
      isOpen={isOpen}
      onClose={handleClose}
      title="扩图"
      hidePanel
      className="crop-overlay expand-overlay"
    >
      <motion.div
        className="crop-content"
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springGentle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 顶部：画幅预设 + 确认 ── */}
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
            data-tooltip="开始扩图"
            aria-label="开始扩图"
            onClick={handleConfirm}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
            <span>扩图</span>
          </AnimatedButton>
        </div>

        {/* ── 中部：预览舞台 ── */}
        <div className="crop-stage expand-stage" ref={stageRef}>
          {display && target && (
            <div
              className="expand-frame"
              style={{ width: display.frameW, height: display.frameH }}
            >
              <img
                src={imageUrl}
                alt="原图"
                className="expand-src-img"
                draggable={false}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                style={{
                  width: display.imgW,
                  height: display.imgH,
                  left: (display.frameW - display.imgW) / 2 + offset.x * (display.frameW - display.imgW),
                  top: (display.frameH - display.imgH) / 2 + offset.y * (display.frameH - display.imgH),
                }}
              />
            </div>
          )}
          {target && (
            <span className="crop-zoom-indicator">
              {target.tw} × {target.th}
            </span>
          )}
        </div>

        {/* ── 底部：外扩量 + 补充描述 + 模型 ── */}
        <div className="expand-controls">
          <div className="expand-control-row">
            <span className="expand-label">外扩量</span>
            <input
              type="range"
              className="fa-slider expand-slider"
              min={0.3}
              max={1}
              step={0.02}
              value={zoom}
              onChange={(e) => handleZoomChange(Number(e.target.value))}
            />
            <span className="expand-value">{Math.round((1 - zoom) * 100)}%</span>
          </div>
          <input
            type="text"
            className="expand-prompt-input"
            placeholder="补充描述（可选）：希望补全区域出现什么…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <ModelSelector
            nodeType="ai-image"
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            onSelect={handleSelectModel}
            groups={EXPAND_MODEL_GROUPS}
            defaultExpandedGroupIds={['apimart']}
          />
        </div>
      </motion.div>
    </FullscreenOverlay>
  );
}
