/**
 * ImageComposerEditor — 多图自由编辑 / 拼图合成器（基于 react-konva）
 *
 * 能力：多图层自由变换（移动/缩放/旋转/翻转/层级/透明度/混合模式）、图片调色滤镜、
 * 主体抠图、文字、基础形状、自由画笔与橡皮、对齐与拖拽吸附、撤销重做，
 * 最终合成为透明 PNG 并按现有「loading 节点 → 回填」流程建新节点。
 *
 * 与裁切/扩图一致：onStart() 即时建 loading 节点，onSave(dataUrl, meta) 回填结果。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer as KLayer, Rect, Line, Transformer } from 'react-konva';
import FullscreenOverlay from '../../../../shared/FullscreenOverlay';
import { setExternalDropCaptured } from '../../../../../utils/dropCapture';
import { useAppStore } from '../../../../../store/useAppStore';
import {
  fetchImageForCrop,
  saveBinaryToProjectData,
  saveDataUrlToProjectData,
} from '../../../../../services/fileService';
import { subjectMatting, checkModelExists, downloadModel } from '../../../../../services/onnxService';
import { clamp } from '../../../../../utils/num';
import ImageEditorZoomControls from '../ImageEditorZoomControls';
import { useComposer } from './useComposer';
import ComposerToolbar from './ComposerToolbar';
import ComposerSidePanel from './ComposerSidePanel';
import ComposerLayerNode from './ComposerLayerNode';
import { NO_GUIDES, alignOffset, fitScaleFactor, snapDuringDrag } from './composerGeometry';
import type { SnapGuides } from './composerGeometry';
import { isDefaultAdjustments, type AlignDir, type Layer } from '../../../../../types/composerTypes';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  assertEditorCanvasBudget,
  canvasToDataUrl,
  estimateComposerFilterCacheWorkingSetBytes,
  getComposerFilterCacheAggregateBudgetError,
  getComposerPeakWorkingSetBudgetError,
  getEditorCanvasBudgetError,
} from '../imageResourceBudget';

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
const MATTING_MODEL = 'rmbg-1.4.onnx';
/** 吸附触发距离（屏幕像素，换算到页面坐标时再除以相机缩放） */
const SNAP_PX = 6;

const errMessage = (err: unknown, fallback: string): string =>
  typeof err === 'string' ? err
  : err instanceof Error ? err.message
  : err && typeof err === 'object' && 'message' in err ? String((err as Record<string, unknown>).message)
  : fallback;

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

function extensionForImageSource(source: string, mimeType: string): string {
  const byMime = IMAGE_EXTENSION_BY_MIME[mimeType.toLowerCase()];
  if (byMime) return byMime;
  const match = source.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  return match?.[1]?.toLowerCase() || 'png';
}

async function saveComposerSourceToProject(source: string, projectId: string) {
  const stamp = Date.now();
  const resolvedSource = await fetchImageForCrop(source);
  if (resolvedSource.startsWith('data:')) {
    const mime = resolvedSource.match(/^data:([^;,]+)/i)?.[1] ?? 'image/png';
    return saveDataUrlToProjectData(
      resolvedSource,
      projectId,
      `composer_subject_${stamp}.${extensionForImageSource(source, mime)}`,
    );
  }
  const response = await fetch(resolvedSource);
  if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
  const blob = await response.blob();
  return saveBinaryToProjectData(
    new Uint8Array(await blob.arrayBuffer()),
    projectId,
    `composer_subject_${stamp}.${extensionForImageSource(source, blob.type)}`,
  );
}

export default function ImageComposerEditor({ isOpen, nodeId, imageUrl, onClose, onStart, onSave }: ImageComposerEditorProps) {
  const cmp = useComposer();
  const {
    layers, selectedId, setSelectedId, selectedLayer, canvas, updateCanvas,
    updateLayer, removeLayer, duplicateLayer, reorderLayer, addImageLayer, addImageFileLayer, replaceImageLayer,
    addBrushStroke, tool, setTool, brush, undo, redo, clearHistory, reset, retainedImageBytes,
  } = cmp;

  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef<Map<string, Konva.Node>>(new Map());

  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [camScale, setCamScale] = useState(1);
  const [camPos, setCamPos] = useState({ x: 0, y: 0 });
  const [editingText, setEditingText] = useState<{ id: string; left: number; top: number; width: number; fontPx: number } | null>(null);
  const [guides, setGuides] = useState<SnapGuides>(NO_GUIDES);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [sideToggled, setSideToggled] = useState(false);
  const [draft, setDraft] = useState<number[] | null>(null);
  const draftRef = useRef<number[] | null>(null);
  const drawingRef = useRef(false);
  const seededRef = useRef(false);
  const exportingRef = useRef(false);
  const exportFrameRef = useRef<number | null>(null);
  const editorEpochRef = useRef(0);
  const imageImportQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resourceIssuesRef = useRef<Map<string, string>>(new Map());

  /** 笔画点位以 ref 为准，收笔时才读取（避免在 setState 更新器里做副作用） */
  const setDraftPoints = useCallback((points: number[] | null) => {
    draftRef.current = points;
    setDraft(points);
  }, []);

  const registerNode = useCallback((id: string, node: Konva.Node | null) => {
    if (node) nodeRefs.current.set(id, node);
    else nodeRefs.current.delete(id);
  }, []);

  const handleResourceIssue = useCallback((id: string, message: string | null) => {
    const previous = resourceIssuesRef.current.get(id);
    if (!message) {
      resourceIssuesRef.current.delete(id);
      return;
    }
    resourceIssuesRef.current.set(id, message);
    if (previous !== message) useAppStore.getState().showToast(message, 'error');
  }, []);

  const filterCacheBudget = useMemo(() => {
    const errors = new Map<string, string>();
    let retainedWorkingBytes = 0;
    for (const layer of layers) {
      if (layer.type !== 'image' || !layer.visible || isDefaultAdjustments(layer.adjustments)) continue;
      const offset = Math.ceil(layer.adjustments.blur) * 2 + 1;
      const error = getComposerFilterCacheAggregateBudgetError(
        retainedWorkingBytes,
        layer.width,
        layer.height,
        offset,
        retainedImageBytes,
      );
      if (error) {
        errors.set(layer.id, error);
        continue;
      }
      retainedWorkingBytes += estimateComposerFilterCacheWorkingSetBytes(
        layer.width,
        layer.height,
        offset,
      ) ?? 0;
    }
    return { errors, workingBytes: retainedWorkingBytes };
  }, [layers, retainedImageBytes]);
  const filterCacheErrors = filterCacheBudget.errors;

  /** 所有图片解码串行执行；关闭编辑器后，队列中尚未开始/完成的结果全部失效。 */
  const enqueueImageImport = useCallback((
    task: (isCurrent: () => boolean) => Promise<void>,
    notifyFailure = true,
  ): Promise<void> => {
    const epoch = editorEpochRef.current;
    const isCurrent = () => editorEpochRef.current === epoch;
    const queued = imageImportQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) return;
        await task(isCurrent);
      });
    imageImportQueueRef.current = queued.catch((error) => {
      if (notifyFailure && isCurrent()) {
        useAppStore.getState().showToast(errMessage(error, '图片导入失败'), 'error');
      }
    });
    return queued;
  }, []);

  /* ── 居中适配相机 ── */
  const fitToView = useCallback((pageW: number, pageH: number, sw: number, sh: number) => {
    const scale = clamp(Math.min((sw - 96) / pageW, (sh - 120) / pageH), 0.05, 2);
    setCamScale(scale);
    setCamPos({ x: (sw - pageW * scale) / 2, y: (sh - pageH * scale) / 2 });
  }, []);

  const handleFit = useCallback(() => {
    fitToView(canvas.width, canvas.height, stageSize.w, stageSize.h);
  }, [canvas.width, canvas.height, fitToView, stageSize.w, stageSize.h]);

  const handleZoomChange = useCallback((nextScale: number) => {
    const next = clamp(nextScale, 0.05, 8);
    const center = { x: stageSize.w / 2, y: stageSize.h / 2 };
    const worldCenter = {
      x: (center.x - camPos.x) / camScale,
      y: (center.y - camPos.y) / camScale,
    };
    setCamScale(next);
    setCamPos({
      x: center.x - worldCenter.x * next,
      y: center.y - worldCenter.y * next,
    });
  }, [camPos.x, camPos.y, camScale, stageSize.h, stageSize.w]);

  const resetZoom = useCallback(() => handleZoomChange(1), [handleZoomChange]);

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
    void enqueueImageImport(async (isCurrent) => {
      await addImageLayer(imageUrl, '底图', (img) => {
        if (!isCurrent()) throw new Error('编辑器已关闭');
        const W = Math.min(img.naturalWidth, MAX_SEED);
        const H = Math.round((img.naturalHeight / img.naturalWidth) * W);
        updateCanvas({ width: W, height: H, bg: 'transparent' }, null);
        fitToView(W, H, stageSize.w, stageSize.h);
      });
      if (isCurrent()) {
        // 底图属于初始状态，不该被撤销掉
        clearHistory();
      }
    }, false).catch(() => {
      /* 加载失败时仍可手动加图 */
    });
  }, [
    addImageLayer,
    clearHistory,
    enqueueImageImport,
    fitToView,
    imageUrl,
    isOpen,
    stageSize.h,
    stageSize.w,
    updateCanvas,
  ]);

  /* ── 关闭时复位 ── */
  const handleClose = useCallback(() => {
    editorEpochRef.current += 1;
    if (exportFrameRef.current !== null) {
      cancelAnimationFrame(exportFrameRef.current);
      exportFrameRef.current = null;
    }
    reset();
    seededRef.current = false;
    setEditingText(null);
    setDraftPoints(null);
    exportingRef.current = false;
    resourceIssuesRef.current.clear();
    onClose();
  }, [reset, onClose, setDraftPoints]);

  useEffect(() => {
    if (isOpen) return;
    editorEpochRef.current += 1;
    if (exportFrameRef.current !== null) {
      cancelAnimationFrame(exportFrameRef.current);
      exportFrameRef.current = null;
    }
    exportingRef.current = false;
  }, [isOpen]);

  useEffect(() => () => {
    editorEpochRef.current += 1;
    seededRef.current = false;
    if (exportFrameRef.current !== null) cancelAnimationFrame(exportFrameRef.current);
    exportFrameRef.current = null;
  }, []);

  /* ── Transformer 跟随选中（锁定图层与绘制模式下不挂控制点）── */
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const layer = selectedId ? layers.find((l) => l.id === selectedId) : null;
    const node = layer && !layer.locked && tool === 'select' ? nodeRefs.current.get(layer.id) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, layers, tool]);

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

  /* ── 画笔 / 橡皮 ── */
  const pagePointer = useCallback(() => {
    const stage = stageRef.current;
    return stage?.getRelativePointerPosition() ?? null;
  }, []);

  const onStagePointerDown = useCallback((e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (tool !== 'select') {
      const p = pagePointer();
      if (!p) return;
      drawingRef.current = true;
      setDraftPoints([p.x, p.y]);
      return;
    }
    const t = e.target;
    if (t === t.getStage() || t.name() === 'page-bg') setSelectedId(null);
  }, [pagePointer, setDraftPoints, setSelectedId, tool]);

  const onStagePointerMove = useCallback(() => {
    if (!drawingRef.current) return;
    const p = pagePointer();
    if (!p) return;
    setDraftPoints([...(draftRef.current ?? []), p.x, p.y]);
  }, [pagePointer, setDraftPoints]);

  const finishStroke = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const points = draftRef.current;
    setDraftPoints(null);
    if (points && points.length >= 4) addBrushStroke(points, tool === 'eraser');
  }, [addBrushStroke, setDraftPoints, tool]);

  /* ── 拖拽：吸附 + 回写 ── */
  const otherNodes = useCallback((excludeId: string) => {
    const list: Konva.Node[] = [];
    for (const [id, node] of nodeRefs.current) {
      if (id === excludeId) continue;
      const layer = layers.find((l) => l.id === id);
      if (layer?.visible) list.push(node);
    }
    return list;
  }, [layers]);

  const handleDragMove = useCallback((id: string, node: Konva.Node, evt: DragEvent) => {
    // 按住 Alt 临时关闭吸附
    if (evt.altKey) {
      setGuides(NO_GUIDES);
      return;
    }
    setGuides(snapDuringDrag(node, otherNodes(id), canvas, SNAP_PX / camScale));
  }, [camScale, canvas, otherNodes]);

  const syncFromNode = useCallback((id: string, node: Konva.Node) => {
    setGuides(NO_GUIDES);
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
      width: layer.width * Math.abs(layer.scaleX) * camScale,
      fontPx: layer.fontSize * Math.abs(layer.scaleY) * camScale,
    });
  }, [camPos, camScale, setSelectedId]);

  const commitText = useCallback((value: string) => {
    if (editingText) updateLayer(editingText.id, { text: value } as Partial<Layer>);
    setEditingText(null);
  }, [editingText, updateLayer]);

  /* ── 对齐 / 适配画布 ── */
  const alignSelected = useCallback((dir: AlignDir) => {
    if (!selectedLayer) return;
    const node = nodeRefs.current.get(selectedLayer.id);
    if (!node) return;
    const { dx, dy } = alignOffset(node, canvas, dir);
    updateLayer(selectedLayer.id, { x: selectedLayer.x + dx, y: selectedLayer.y + dy });
  }, [canvas, selectedLayer, updateLayer]);

  const fitSelectedToCanvas = useCallback((mode: 'contain' | 'cover') => {
    if (!selectedLayer) return;
    const node = nodeRefs.current.get(selectedLayer.id);
    if (!node) return;
    const k = fitScaleFactor(node, canvas, mode);
    updateLayer(selectedLayer.id, {
      scaleX: selectedLayer.scaleX * k,
      scaleY: selectedLayer.scaleY * k,
      x: canvas.width / 2,
      y: canvas.height / 2,
    });
  }, [canvas, selectedLayer, updateLayer]);

  /* ── 键盘：撤销/重做、删除、微调、层级、工具切换 ──
   * 捕获阶段拦截：阻止 React Flow / 全局快捷键在编辑器打开时删除底层节点。
   * 输入框内（数值/颜色/文字编辑）不拦截，交还原生行为。 */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (editingText) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const stop = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };

      if (mod && e.key.toLowerCase() === 'z') {
        stop();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { stop(); redo(); return; }
      if (mod && e.key.toLowerCase() === 'd' && selectedId) { stop(); duplicateLayer(selectedId); return; }
      if (mod && (e.key === ']' || e.key === '[') && selectedId) {
        stop();
        reorderLayer(selectedId, e.key === ']' ? 'up' : 'down');
        return;
      }
      if (mod && e.key === '0') { stop(); handleFit(); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 始终拦截（无论是否选中），避免误删画布节点
        stop();
        if (selectedId) removeLayer(selectedId);
        return;
      }
      if (e.key === 'Escape') {
        if (tool !== 'select') { stop(); setTool('select'); return; }
        if (selectedId) { stop(); setSelectedId(null); }
        return;
      }
      if (e.key.startsWith('Arrow') && selectedId) {
        const layer = cmp.layersRef.current.find((l) => l.id === selectedId);
        if (!layer) return;
        stop();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        updateLayer(selectedId, { x: layer.x + dx, y: layer.y + dy }, `nudge:${selectedId}`);
        return;
      }
      if (!mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'v') { setTool('select'); }
        else if (k === 'b') { setTool('brush'); }
        else if (k === 'e') { setTool('eraser'); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, selectedId, editingText, tool, cmp.layersRef, removeLayer, setSelectedId,
    setTool, undo, redo, duplicateLayer, reorderLayer, updateLayer, handleFit]);

  /* ── 剪贴板粘贴图片 ── */
  useEffect(() => {
    if (!isOpen) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const file = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'))?.getAsFile();
      if (!file) return;
      e.preventDefault();
      void enqueueImageImport(async (isCurrent) => {
        if (!isCurrent()) return;
        await addImageFileLayer(file, '粘贴图片');
      }).catch(() => {});
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [isOpen, addImageFileLayer, enqueueImageImport]);

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
      void enqueueImageImport(async (isCurrent) => {
        if (!isCurrent()) return;
        await addImageFileLayer(f, f.name);
      }).catch(() => {});
    }
  }, [addImageFileLayer, enqueueImageImport]);

  // Tauri 桌面端：原生 drag-drop 事件（独占，避免画布在弹层后建节点）
  useEffect(() => {
    if (!isOpen || !('__TAURI_INTERNALS__' in window)) return;
    setExternalDropCaptured(true);
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const ul = await listen<{ type: string; paths: string[] }>('tauri://drag-drop', async (event) => {
        const { type, paths } = event.payload;
        if (type === 'enter' || type === 'over') { setIsDragOver(true); return; }
        if (type === 'leave' || type === 'cancelled') { setIsDragOver(false); return; }
        setIsDragOver(false);
        for (const fp of paths ?? []) {
          if (!IMAGE_EXT.test(fp)) continue;
          await enqueueImageImport(async (isCurrent) => {
            if (!isCurrent()) return;
            const src = convertFileSrc(fp);
            await addImageLayer(src, fp.split(/[\\/]/).pop() || '图片');
          }).catch(() => { /* 单个文件失败不阻断其余 */ });
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
  }, [isOpen, addImageLayer, enqueueImageImport]);

  /* ── 识别主体：对选中图片图层抠出主体（透明背景）并原位替换 ──
   * 复用节点端的 ONNX RMBG-1.4。需桌面端 + 已保存项目（要落地本地文件）。 */
  const [mattingLayerId, setMattingLayerId] = useState<string | null>(null);
  const handleMatteSubject = useCallback(async () => {
    const layer = selectedLayer;
    if (!layer || layer.type !== 'image') return;
    const store = useAppStore.getState();
    if (!('__TAURI_INTERNALS__' in window)) {
      store.showToast('主体识别仅桌面端可用', 'error');
      return;
    }
    const projectId = store.currentProjectId;
    if (!projectId || projectId === 'default') {
      store.showToast('请先在项目中使用主体识别', 'error');
      return;
    }

    setMattingLayerId(layer.id);
    try {
      if (!(await checkModelExists(MATTING_MODEL))) {
        store.showToast('正在下载主体识别模型…');
        await downloadModel(MATTING_MODEL);
      }
      // 1. 落地图层图片为输入文件
      const saved = await saveComposerSourceToProject(layer.src, projectId);
      if (!saved) throw new Error('无法写入临时文件');
      // 2. 抠主体
      const outputPath = `${saved.filePath.replace(/\.[^.]+$/, '')}_subject.png`;
      const result = await subjectMatting(saved.filePath, outputPath, MATTING_MODEL, `composer-matting-${Date.now()}`);
      // 3. 载回并原位替换图层图片
      const resultSrc = convertFileSrc(result.subject_path);
      await replaceImageLayer(layer.id, resultSrc);
      store.showToast(`主体识别完成 (${result.input_size})`);
    } catch (err) {
      store.showToast(errMessage(err, '主体识别失败'), 'error');
    } finally {
      setMattingLayerId(null);
    }
  }, [replaceImageLayer, selectedLayer]);

  /* ── 导出：临时复位相机 + 舞台尺寸=画布，导出原生分辨率透明 PNG ── */
  const handleExport = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || layers.length === 0 || exportingRef.current) return;
    const resourceIssue = resourceIssuesRef.current.values().next().value;
    if (resourceIssue) {
      useAppStore.getState().showToast(`${resourceIssue}；请处理后再导出`, 'error');
      return;
    }
    const budgetError = getEditorCanvasBudgetError(canvas.width, canvas.height, '合成导出');
    if (budgetError) {
      useAppStore.getState().showToast(budgetError, 'error');
      return;
    }
    const peakBudgetError = getComposerPeakWorkingSetBudgetError(
      retainedImageBytes,
      filterCacheBudget.workingBytes,
      canvas.width,
      canvas.height,
    );
    if (peakBudgetError) {
      useAppStore.getState().showToast(peakBudgetError, 'error');
      return;
    }
    exportingRef.current = true;
    setSelectedId(null);
    setGuides(NO_GUIDES);
    const exportEpoch = editorEpochRef.current;
    const isCurrentExport = () => editorEpochRef.current === exportEpoch;
    exportFrameRef.current = requestAnimationFrame(() => {
      exportFrameRef.current = null;
      if (!isCurrentExport() || stageRef.current !== stage) {
        exportingRef.current = false;
        return;
      }

      void (async () => {
        const prev = { scale: camScale, pos: { ...camPos }, w: stageSize.w, h: stageSize.h };
        let exportCanvas: HTMLCanvasElement | null = null;
        let exportError: unknown = null;
        try {
          assertEditorCanvasBudget(canvas.width, canvas.height, '合成导出');
          stage.size({ width: canvas.width, height: canvas.height });
          stage.scale({ x: 1, y: 1 });
          stage.position({ x: 0, y: 0 });
          stage.batchDraw();
          exportCanvas = stage.toCanvas({
            x: 0,
            y: 0,
            width: canvas.width,
            height: canvas.height,
            pixelRatio: 1,
          });
        } catch (err) {
          exportError = err;
        } finally {
          try {
            stage.size({ width: prev.w, height: prev.h });
            stage.scale({ x: prev.scale, y: prev.scale });
            stage.position(prev.pos);
            stage.batchDraw();
          } catch (restoreError) {
            exportError ??= restoreError;
            console.error('[Composer] stage restore failed:', restoreError);
          }
        }

        let dataUrl: string | null = null;
        try {
          if (exportError || !exportCanvas) throw exportError ?? new Error('合成导出画布不可用');
          dataUrl = await canvasToDataUrl(exportCanvas);
        } catch (err) {
          exportError = err;
        } finally {
          if (exportCanvas) {
            exportCanvas.width = 1;
            exportCanvas.height = 1;
          }
        }

        if (!isCurrentExport()) return;
        if (exportError || !dataUrl) {
          console.error('[Composer] export failed:', exportError);
          useAppStore.getState().showToast(errMessage(exportError, '合成导出失败，请重试'), 'error');
          return;
        }

        const { width, height } = canvas;
        editorEpochRef.current += 1;
        onStart?.();
        reset();
        seededRef.current = false;
        resourceIssuesRef.current.clear();
        onSave(dataUrl, { width, height });
      })().finally(() => {
        exportingRef.current = false;
      });
    });
  }, [layers.length, camScale, camPos, stageSize, canvas, filterCacheBudget.workingBytes,
    onStart, onSave, reset, retainedImageBytes, setSelectedId]);

  /** 画布外沿一圈的参考线长度，超出画布也能看到 */
  const guideSpan = useMemo(() => ({
    x: -canvas.width, y: -canvas.height, w: canvas.width * 3, h: canvas.height * 3,
  }), [canvas.width, canvas.height]);

  return (
    <FullscreenOverlay isOpen={isOpen} onClose={handleClose} title="多图编辑" hidePanel className="composer-overlay">
      <div className={`composer-root${sideCollapsed ? ' side-collapsed' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="composer-toolbar-dock">
          <ComposerToolbar
            composer={cmp}
            canExport={layers.length > 0}
            onFit={handleFit}
            onExport={handleExport}
            onClose={handleClose}
          />
          <ImageEditorZoomControls
            scale={camScale}
            minScale={0.05}
            maxScale={8}
            onZoomChange={handleZoomChange}
            onReset={resetZoom}
          />
        </div>

        <div className="composer-body">
          <div
            className={`composer-stage-wrap${isDragOver ? ' drag-over' : ''}${tool !== 'select' ? ' drawing' : ''}`}
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
                onMouseDown={onStagePointerDown}
                onTouchStart={onStagePointerDown}
                onMouseMove={onStagePointerMove}
                onTouchMove={onStagePointerMove}
                onMouseUp={finishStroke}
                onTouchEnd={finishStroke}
                onMouseLeave={finishStroke}
              >
                <KLayer>
                  {/* 画布底：纯色才绘制（透明则不画，导出保留 alpha；空白处点击命中 Stage 即取消选中）。
                      棋盘格仅作 DOM 背景，不进入导出 */}
                  {canvas.bg !== 'transparent' && (
                    <Rect name="page-bg" x={0} y={0} width={canvas.width} height={canvas.height} fill={canvas.bg} listening={tool === 'select'} />
                  )}
                  {layers.map((layer) => (
                    <ComposerLayerNode
                      key={layer.id}
                      layer={layer}
                      interactive={tool === 'select'}
                      hidden={editingText?.id === layer.id}
                      onSelect={setSelectedId}
                      onDragMove={handleDragMove}
                      onDragEnd={syncFromNode}
                      onTransformEnd={syncFromNode}
                      onBeginTextEdit={beginTextEdit}
                      registerNode={registerNode}
                      onResourceIssue={handleResourceIssue}
                      resourceBudgetError={filterCacheErrors.get(layer.id)}
                    />
                  ))}

                  {/* 正在绘制的笔画（收笔才落成图层） */}
                  {draft && (
                    <Line
                      points={draft}
                      stroke={brush.color}
                      strokeWidth={brush.size}
                      tension={0.4}
                      lineCap="round"
                      lineJoin="round"
                      listening={false}
                      globalCompositeOperation={tool === 'eraser' ? 'destination-out' : 'source-over'}
                    />
                  )}

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

                  {/* 吸附参考线 */}
                  {guides.v !== null && (
                    <Line
                      points={[guides.v, guideSpan.y, guides.v, guideSpan.y + guideSpan.h]}
                      stroke="#ec4899"
                      strokeWidth={1 / camScale}
                      dash={[6 / camScale, 4 / camScale]}
                      listening={false}
                    />
                  )}
                  {guides.h !== null && (
                    <Line
                      points={[guideSpan.x, guides.h, guideSpan.x + guideSpan.w, guides.h]}
                      stroke="#ec4899"
                      strokeWidth={1 / camScale}
                      dash={[6 / camScale, 4 / camScale]}
                      listening={false}
                    />
                  )}
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
                  if (e.nativeEvent.isComposing) return; // 输入法组合中，回车属于候选框
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitText((e.target as HTMLTextAreaElement).value);
                  } else if (e.key === 'Escape') {
                    setEditingText(null);
                  }
                }}
              />
            )}

          </div>

          <ComposerSidePanel
            composer={cmp}
            nodeId={nodeId}
            collapsed={sideCollapsed}
            animateIn={!sideToggled}
            onToggleCollapsed={() => { setSideToggled(true); setSideCollapsed((v) => !v); }}
            onMatteSubject={handleMatteSubject}
            mattingLayerId={mattingLayerId}
            onAlign={alignSelected}
            onFitLayer={fitSelectedToCanvas}
          />
        </div>
      </div>
    </FullscreenOverlay>
  );
}
