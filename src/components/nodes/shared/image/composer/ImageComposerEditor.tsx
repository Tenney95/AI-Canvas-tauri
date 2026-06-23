/**
 * ImageComposerEditor — 多图自由编辑 / 拼图合成器（基于 react-konva）
 *
 * 能力（标准版）：多图层自由变换（移动/缩放/旋转/层级/透明度）、文字、基础形状，
 * 可设画布尺寸与背景，最终合成为透明 PNG 并按现有「loading 节点 → 回填」流程建新节点。
 *
 * 与裁切/扩图一致：onStart() 即时建 loading 节点，onSave(dataUrl, meta) 回填结果。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer as KLayer, Rect, Ellipse, Image as KImage, Text as KText, Line, Arrow, Transformer } from 'react-konva';
import FullscreenOverlay from '../../../../shared/FullscreenOverlay';
import { setExternalDropCaptured } from '../../../../../utils/dropCapture';
import { loadSafeImage } from '../imageUtils';
import { useComposer } from './useComposer';
import ComposerToolbar from './ComposerToolbar';
import ComposerSidePanel from './ComposerSidePanel';
import type { Layer } from './types';

interface ImageComposerEditorProps {
  isOpen: boolean;
  /** 当前图像节点 id — 用于展示连线节点内容 */
  nodeId: string;
  imageUrl: string;
  onClose: () => void;
  onStart?: () => void;
  onSave: (dataUrl: string, metadata?: { width: number; height: number }) => void;
}

const MAX_SEED = 2048;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function ImageComposerEditor({ isOpen, nodeId, imageUrl, onClose, onStart, onSave }: ImageComposerEditorProps) {
  const cmp = useComposer();
  const {
    layers, selectedId, setSelectedId, selectedLayer,
    canvas, setCanvas, updateLayer, removeLayer, addImageLayer, reset,
  } = cmp;

  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef<Map<string, Konva.Node>>(new Map());

  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [camScale, setCamScale] = useState(1);
  const [camPos, setCamPos] = useState({ x: 0, y: 0 });
  const [editingText, setEditingText] = useState<{ id: string; left: number; top: number; width: number; fontPx: number } | null>(null);
  const seededRef = useRef(false);

  /* ── 居中适配相机 ── */
  const fitToView = useCallback((pageW: number, pageH: number, sw: number, sh: number) => {
    const scale = clamp(Math.min((sw - 96) / pageW, (sh - 120) / pageH), 0.05, 2);
    setCamScale(scale);
    setCamPos({ x: (sw - pageW * scale) / 2, y: (sh - pageH * scale) / 2 });
  }, []);

  /* ── 容器尺寸跟踪 ── */
  useEffect(() => {
    if (!isOpen) return;
    const el = stageWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setStageSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [isOpen]);

  /* ── 打开时用初始图片做底图 ── */
  useEffect(() => {
    if (!isOpen || seededRef.current || stageSize.w === 0 || !imageUrl) return;
    seededRef.current = true;
    (async () => {
      try {
        const img = await loadSafeImage(imageUrl);
        const W = Math.min(img.naturalWidth, MAX_SEED);
        const H = Math.round((img.naturalHeight / img.naturalWidth) * W);
        setCanvas({ width: W, height: H, bg: 'transparent' });
        fitToView(W, H, stageSize.w, stageSize.h);
        await addImageLayer(imageUrl, '底图');
      } catch {
        /* 加载失败时仍可手动加图 */
      }
    })();
  }, [isOpen, stageSize.w, stageSize.h, imageUrl, setCanvas, fitToView, addImageLayer]);

  /* ── 关闭时复位 ── */
  const handleClose = useCallback(() => {
    reset();
    seededRef.current = false;
    setEditingText(null);
    onClose();
  }, [reset, onClose]);

  /* ── Transformer 跟随选中 ── */
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = selectedId ? nodeRefs.current.get(selectedId) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, layers]);

  /* ── 滚轮：ctrl 缩放（trackpad 捏合）/ 否则平移（双指滑动）── */
  const onWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    if (e.evt.ctrlKey) {
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const mp = { x: (pointer.x - camPos.x) / camScale, y: (pointer.y - camPos.y) / camScale };
      const factor = Math.exp(clamp(-e.evt.deltaY, -40, 40) * 0.01);
      const next = clamp(camScale * factor, 0.05, 8);
      setCamScale(next);
      setCamPos({ x: pointer.x - mp.x * next, y: pointer.y - mp.y * next });
    } else {
      setCamPos((p) => ({ x: p.x - e.evt.deltaX, y: p.y - e.evt.deltaY }));
    }
  }, [camScale, camPos]);

  /* ── 点击空白取消选中 ── */
  const onStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const t = e.target;
    if (t === t.getStage() || t.name() === 'page-bg') setSelectedId(null);
  }, [setSelectedId]);

  const syncFromNode = useCallback((id: string, node: Konva.Node) => {
    updateLayer(id, {
      x: node.x(), y: node.y(),
      rotation: node.rotation(),
      scaleX: node.scaleX(), scaleY: node.scaleY(),
    });
  }, [updateLayer]);

  /* ── 双击文字进入编辑 ── */
  const beginTextEdit = useCallback((layer: Layer) => {
    if (layer.type !== 'text') return;
    const node = nodeRefs.current.get(layer.id);
    const wrap = stageWrapRef.current;
    if (!node || !wrap) return;
    const abs = node.getClientRect({ relativeTo: stageRef.current ?? undefined });
    // getClientRect relativeTo stage 给出舞台坐标；换算为屏幕（容器）坐标
    const left = camPos.x + abs.x * camScale;
    const top = camPos.y + abs.y * camScale;
    setSelectedId(layer.id);
    setEditingText({
      id: layer.id,
      left,
      top,
      width: layer.width * layer.scaleX * camScale,
      fontPx: layer.fontSize * layer.scaleY * camScale,
    });
  }, [camPos, camScale, setSelectedId]);

  const commitText = useCallback((value: string) => {
    if (editingText) updateLayer(editingText.id, { text: value } as Partial<Layer>);
    setEditingText(null);
  }, [editingText, updateLayer]);

  /* ── 键盘：删除选中图层 / 取消选中 ──
   * 捕获阶段拦截：阻止 React Flow / 全局快捷键在编辑器打开时删除底层节点。
   * 输入框内（数值/颜色/文字编辑）不拦截，交还原生行为。 */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (editingText) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 始终拦截（无论是否选中），避免误删画布节点
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (selectedId) removeLayer(selectedId);
      } else if (e.key === 'Escape' && selectedId) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, selectedId, editingText, removeLayer, setSelectedId]);

  /* ── 外部拖拽图片加入图层 ── */
  const [isDragOver, setIsDragOver] = useState(false);

  // 浏览器环境：DOM 拖放（Tauri 桌面端走下面的原生事件）
  const onDomDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    }
  }, []);
  const onDomDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setIsDragOver(false);
  }, []);
  const onDomDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => addImageLayer(reader.result as string, f.name);
      reader.readAsDataURL(f);
    }
  }, [addImageLayer]);

  // Tauri 桌面端：原生 drag-drop 事件（独占，避免画布在弹层后建节点）
  useEffect(() => {
    if (!isOpen || !('__TAURI_INTERNALS__' in window)) return;
    setExternalDropCaptured(true);
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const ul = await listen<{ type: string; paths: string[] }>('tauri://drag-drop', async (event) => {
        const { type, paths } = event.payload;
        if (type === 'enter' || type === 'over') { setIsDragOver(true); return; }
        if (type === 'leave' || type === 'cancelled') { setIsDragOver(false); return; }
        setIsDragOver(false);
        for (const fp of paths ?? []) {
          if (!IMAGE_EXT.test(fp)) continue;
          try {
            await addImageLayer(convertFileSrc(fp), fp.split(/[\\/]/).pop() || '图片');
          } catch { /* 单个文件失败不阻断其余 */ }
        }
      });
      if (cancelled) ul();
      else unlisten = ul;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      setExternalDropCaptured(false);
      setIsDragOver(false);
    };
  }, [isOpen, addImageLayer]);

  /* ── 导出：临时复位相机 + 舞台尺寸=画布，导出原生分辨率透明 PNG ── */
  const handleExport = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || layers.length === 0) return;
    setSelectedId(null);
    requestAnimationFrame(() => {
      try {
        const prev = { scale: camScale, pos: { ...camPos }, w: stageSize.w, h: stageSize.h };
        stage.size({ width: canvas.width, height: canvas.height });
        stage.scale({ x: 1, y: 1 });
        stage.position({ x: 0, y: 0 });
        stage.batchDraw();
        const dataUrl = stage.toDataURL({ x: 0, y: 0, width: canvas.width, height: canvas.height, pixelRatio: 1 });
        // 还原
        stage.size({ width: prev.w, height: prev.h });
        stage.scale({ x: prev.scale, y: prev.scale });
        stage.position(prev.pos);
        stage.batchDraw();

        onStart?.();
        const { width, height } = canvas;
        reset();
        seededRef.current = false;
        onSave(dataUrl, { width, height });
      } catch (err) {
        console.error('[Composer] export failed:', err);
        onSave('', { width: 0, height: 0 });
      }
    });
  }, [layers.length, camScale, camPos, stageSize, canvas, onStart, onSave, reset, setSelectedId]);

  /* ── 渲染单个图层 ── */
  const renderLayer = (layer: Layer) => {
    if (!layer.visible) return null;
    const common = {
      id: layer.id,
      x: layer.x,
      y: layer.y,
      rotation: layer.rotation,
      scaleX: layer.scaleX,
      scaleY: layer.scaleY,
      opacity: layer.opacity,
      draggable: true,
      onMouseDown: () => setSelectedId(layer.id),
      onTap: () => setSelectedId(layer.id),
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => syncFromNode(layer.id, e.target),
      onTransformEnd: (e: Konva.KonvaEventObject<Event>) => syncFromNode(layer.id, e.target),
      ref: (node: Konva.Node | null) => {
        if (node) nodeRefs.current.set(layer.id, node);
        else nodeRefs.current.delete(layer.id);
      },
    };

    switch (layer.type) {
      case 'image':
        return (
          <KImage
            key={layer.id}
            {...common}
            image={layer.image}
            width={layer.width}
            height={layer.height}
            offsetX={layer.width / 2}
            offsetY={layer.height / 2}
          />
        );
      case 'rect':
        return (
          <Rect
            key={layer.id}
            {...common}
            width={layer.width}
            height={layer.height}
            offsetX={layer.width / 2}
            offsetY={layer.height / 2}
            fill={layer.fill}
            stroke={layer.strokeWidth > 0 ? layer.stroke : undefined}
            strokeWidth={layer.strokeWidth}
            cornerRadius={layer.cornerRadius}
          />
        );
      case 'ellipse':
        return (
          <Ellipse
            key={layer.id}
            {...common}
            radiusX={layer.width / 2}
            radiusY={layer.height / 2}
            fill={layer.fill}
            stroke={layer.strokeWidth > 0 ? layer.stroke : undefined}
            strokeWidth={layer.strokeWidth}
          />
        );
      case 'text':
        return (
          <KText
            key={layer.id}
            {...common}
            text={layer.text}
            fontSize={layer.fontSize}
            fontFamily={layer.fontFamily}
            fontStyle={layer.fontStyle}
            fill={layer.fill}
            align={layer.align}
            width={layer.width}
            offsetX={layer.width / 2}
            visible={editingText?.id !== layer.id}
            onDblClick={() => beginTextEdit(layer)}
            onDblTap={() => beginTextEdit(layer)}
          />
        );
      case 'line':
        return <Line key={layer.id} {...common} points={layer.points} stroke={layer.stroke} strokeWidth={layer.strokeWidth} lineCap="round" />;
      case 'arrow':
        return <Arrow key={layer.id} {...common} points={layer.points} stroke={layer.stroke} fill={layer.stroke} strokeWidth={layer.strokeWidth} pointerLength={layer.strokeWidth * 3} pointerWidth={layer.strokeWidth * 3} />;
      default:
        return null;
    }
  };

  return (
    <FullscreenOverlay isOpen={isOpen} onClose={handleClose} title="多图编辑" hidePanel className="composer-overlay">
      <div className="composer-root" onClick={(e) => e.stopPropagation()}>
        <ComposerToolbar
          composer={cmp}
          camScale={camScale}
          canExport={layers.length > 0}
          onFit={() => fitToView(canvas.width, canvas.height, stageSize.w, stageSize.h)}
          onExport={handleExport}
          onClose={handleClose}
        />

        <div className="composer-body">
          <div
            className={`composer-stage-wrap${isDragOver ? ' drag-over' : ''}`}
            ref={stageWrapRef}
            onDragOver={onDomDragOver}
            onDragLeave={onDomDragLeave}
            onDrop={onDomDrop}
          >
            {stageSize.w > 0 && (
              <Stage
                ref={stageRef}
                width={stageSize.w}
                height={stageSize.h}
                scaleX={camScale}
                scaleY={camScale}
                x={camPos.x}
                y={camPos.y}
                onWheel={onWheel}
                onMouseDown={onStageMouseDown}
                onTouchStart={onStageMouseDown}
              >
                <KLayer>
                  {/* 画布底：纯色才绘制（透明则不画，导出保留 alpha；空白处点击命中 Stage 即取消选中）。
                      棋盘格仅作 DOM 背景，不进入导出 */}
                  {canvas.bg !== 'transparent' && (
                    <Rect name="page-bg" x={0} y={0} width={canvas.width} height={canvas.height} fill={canvas.bg} />
                  )}
                  {layers.map(renderLayer)}
                  <Transformer
                    ref={trRef}
                    rotateEnabled
                    keepRatio={false}
                    anchorSize={9}
                    borderStroke="#6366f1"
                    anchorStroke="#6366f1"
                    anchorFill="#fff"
                    boundBoxFunc={(oldBox, newBox) => (newBox.width < 8 || newBox.height < 8 ? oldBox : newBox)}
                  />
                </KLayer>
              </Stage>
            )}

            {/* 画布边框示意 */}
            <div
              className="composer-page-frame"
              style={{
                left: camPos.x,
                top: camPos.y,
                width: canvas.width * camScale,
                height: canvas.height * camScale,
              }}
            />

            {/* 行内文字编辑 */}
            {editingText && (
              <textarea
                className="composer-text-edit"
                autoFocus
                defaultValue={(selectedLayer?.type === 'text' ? selectedLayer.text : '') || ''}
                style={{
                  left: editingText.left,
                  top: editingText.top,
                  width: editingText.width,
                  fontSize: editingText.fontPx,
                }}
                onBlur={(e) => commitText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitText((e.target as HTMLTextAreaElement).value);
                  } else if (e.key === 'Escape') {
                    setEditingText(null);
                  }
                }}
              />
            )}

            <span className="composer-zoom-indicator">{Math.round(camScale * 100)}%</span>
          </div>

          <ComposerSidePanel composer={cmp} nodeId={nodeId} />
        </div>
      </div>
    </FullscreenOverlay>
  );
}
