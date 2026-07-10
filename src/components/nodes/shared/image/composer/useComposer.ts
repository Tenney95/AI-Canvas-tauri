/**
 * useComposer — 图片合成编辑器的图层与画布状态
 *
 * 图层数组顺序即 z 轴（末尾 = 最上层）。所有「带尺寸」的图层以中心为原点
 * （x/y 为中心点），便于 Transformer 绕中心旋转/缩放。
 *
 * 注意：所有 setState 更新器保持「纯函数」——不在某个 setState 的更新器内部
 * 调用另一个 setState（否则 StrictMode 双调用会重复添加图层）。需要读取当前
 * 画布尺寸时通过 canvasRef 读取最新值。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { generateId } from '../../../../../store/useAppStore';
import { loadSafeImage } from '../imageUtils';
import type { CanvasSettings, Layer, LayerType } from '../../../../../types/composerTypes';

const newId = () => `layer-${generateId()}`;

const baseProps = (id: string, name: string, x: number, y: number) => ({
  id,
  name,
  x,
  y,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  visible: true,
});

export type ComposerApi = ReturnType<typeof useComposer>;

export function useComposer() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<CanvasSettings>({ width: 1024, height: 1024, bg: 'transparent' });

  // 始终持有最新画布尺寸，供添加图层时读取（避免在 setState 更新器里嵌套 setState）
  const canvasRef = useRef(canvas);
  useEffect(() => {
    canvasRef.current = canvas;
  }, [canvas]);

  const selectedLayer = layers.find((l) => l.id === selectedId) ?? null;

  const updateLayer = useCallback((id: string, patch: Partial<Layer>) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)));
  }, []);

  const removeLayer = useCallback((id: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const duplicateLayer = useCallback((id: string) => {
    const copyId = newId();
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx < 0) return prev;
      const copy = { ...prev[idx], id: copyId, x: prev[idx].x + 24, y: prev[idx].y + 24 } as Layer;
      const next = prev.slice();
      next.splice(idx + 1, 0, copy);
      return next;
    });
    setSelectedId(copyId);
  }, []);

  /** dir: 'up'|'down' 相邻交换；'top'|'bottom' 置顶/置底 */
  const reorderLayer = useCallback((id: string, dir: 'up' | 'down' | 'top' | 'bottom') => {
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx < 0) return prev;
      const next = prev.slice();
      const [item] = next.splice(idx, 1);
      if (dir === 'top') next.push(item);
      else if (dir === 'bottom') next.unshift(item);
      else if (dir === 'up') next.splice(Math.min(idx + 1, next.length), 0, item);
      else next.splice(Math.max(idx - 1, 0), 0, item);
      return next;
    });
  }, []);

  /** 居中放入一张图片图层（若超出画布按比例缩小适配） */
  const addImageLayer = useCallback(async (src: string, label = '图片') => {
    const img = await loadSafeImage(src);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const cv = canvasRef.current;
    const fit = Math.min(1, (cv.width * 0.9) / w, (cv.height * 0.9) / h);
    const id = newId();
    const layer: Layer = {
      ...baseProps(id, label, cv.width / 2, cv.height / 2),
      type: 'image',
      src: img.src,
      image: img,
      width: w,
      height: h,
      scaleX: fit,
      scaleY: fit,
    };
    setLayers((prev) => [...prev, layer]);
    setSelectedId(id);
  }, []);

  const addText = useCallback((text = '双击编辑文字', label = '文字') => {
    const cv = canvasRef.current;
    const id = newId();
    const layer: Layer = {
      ...baseProps(id, label, cv.width / 2, cv.height / 2),
      type: 'text',
      text,
      fontSize: Math.round(cv.height / 14),
      fontFamily: 'sans-serif',
      fontStyle: 'bold',
      fill: '#ffffff',
      align: 'center',
      width: Math.round(cv.width * 0.6),
    };
    setLayers((prev) => [...prev, layer]);
    setSelectedId(id);
  }, []);

  const addShape = useCallback((type: Extract<LayerType, 'rect' | 'ellipse' | 'line' | 'arrow'>) => {
    const cv = canvasRef.current;
    const cx = cv.width / 2;
    const cy = cv.height / 2;
    const s = Math.min(cv.width, cv.height) * 0.3;
    const id = newId();
    let layer: Layer;
    if (type === 'rect' || type === 'ellipse') {
      layer = {
        ...baseProps(id, type === 'rect' ? '矩形' : '椭圆', cx, cy),
        type,
        width: s,
        height: s * 0.7,
        fill: '#6366f1',
        stroke: '#ffffff',
        strokeWidth: 0,
        cornerRadius: 0,
      };
    } else {
      layer = {
        ...baseProps(id, type === 'line' ? '直线' : '箭头', cx - s / 2, cy),
        type,
        points: [0, 0, s, 0],
        stroke: '#ffffff',
        strokeWidth: Math.max(2, Math.round(s / 30)),
      };
    }
    setLayers((prev) => [...prev, layer]);
    setSelectedId(id);
  }, []);

  const reset = useCallback(() => {
    setLayers([]);
    setSelectedId(null);
    setCanvas({ width: 1024, height: 1024, bg: 'transparent' });
  }, []);

  return {
    layers,
    setLayers,
    selectedId,
    setSelectedId,
    selectedLayer,
    canvas,
    setCanvas,
    updateLayer,
    removeLayer,
    duplicateLayer,
    reorderLayer,
    addImageLayer,
    addText,
    addShape,
    reset,
  };
}
