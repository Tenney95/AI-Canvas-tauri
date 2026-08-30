/**
 * ComposerLayerNode — 把一个 Layer 渲染成对应的 Konva 节点
 *
 * 图片图层的调色走 Konva 滤镜：滤镜必须配合 node.cache()，所以单独拆出
 * ComposerImage，在参数变化时重建缓存；无调整时清缓存，避免白白多一层离屏画布。
 */
import { useEffect, useRef } from 'react';
import Konva from 'konva';
import { Rect, Ellipse, Image as KImage, Text as KText, Line, Arrow } from 'react-konva';
import { isDefaultAdjustments } from '../../../../../types/composerTypes';
import type { Filter } from 'konva/lib/Node';
import type { ImageAdjustments, ImageLayer, Layer } from '../../../../../types/composerTypes';
import { getComposerFilterCacheBudgetError } from '../imageResourceBudget';

interface Props {
  layer: Layer;
  /** 选择工具下才响应指针事件（画笔/橡皮模式让事件落到 Stage） */
  interactive: boolean;
  /** 该图层正在行内编辑文字时先隐藏 Konva 文本 */
  hidden: boolean;
  onSelect: (id: string) => void;
  onDragMove: (id: string, node: Konva.Node, evt: DragEvent) => void;
  onDragEnd: (id: string, node: Konva.Node) => void;
  onTransformEnd: (id: string, node: Konva.Node) => void;
  onBeginTextEdit: (layer: Layer) => void;
  registerNode: (id: string, node: Konva.Node | null) => void;
  onResourceIssue: (id: string, message: string | null) => void;
  resourceBudgetError?: string;
}

/** 各类图层共用的 Konva 属性 */
interface CommonNodeProps {
  id: string;
  name: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  globalCompositeOperation: GlobalCompositeOperation;
  listening: boolean;
  draggable: boolean;
  onMouseDown: () => void;
  onTap: () => void;
  onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}

function buildFilters(a: ImageAdjustments): Filter[] {
  const list: Filter[] = [];
  if (a.brightness !== 0) list.push(Konva.Filters.Brighten);
  if (a.contrast !== 0) list.push(Konva.Filters.Contrast);
  if (a.hue !== 0 || a.saturation !== 0 || a.luminance !== 0) list.push(Konva.Filters.HSL);
  if (a.blur > 0) list.push(Konva.Filters.Blur);
  if (a.grayscale) list.push(Konva.Filters.Grayscale);
  if (a.sepia) list.push(Konva.Filters.Sepia);
  if (a.invert) list.push(Konva.Filters.Invert);
  return list;
}

/** 图片图层 — 负责滤镜缓存的生命周期 */
function ComposerImage({
  layer,
  register,
  common,
  onResourceIssue,
  resourceBudgetError,
}: {
  layer: ImageLayer;
  register: (node: Konva.Node | null) => void;
  common: CommonNodeProps;
  onResourceIssue: (id: string, message: string | null) => void;
  resourceBudgetError?: string;
}) {
  const ref = useRef<Konva.Image | null>(null);
  const a = layer.adjustments;

  useEffect(() => {
    const node = ref.current;
    if (!node || !layer.image) return;
    if (isDefaultAdjustments(a)) {
      node.filters([]);
      node.clearCache();
      onResourceIssue(layer.id, null);
    } else {
      // blur 会向外扩散，缓存区域需要留余量，否则边缘被裁掉
      const offset = Math.ceil(a.blur) * 2 + 1;
      const budgetError = resourceBudgetError
        ?? getComposerFilterCacheBudgetError(layer.width, layer.height, offset);
      if (budgetError) {
        node.filters([]);
        node.clearCache();
        onResourceIssue(layer.id, `${layer.name}：${budgetError}`);
      } else {
        node.cache({ offset });
        node.filters(buildFilters(a));
        onResourceIssue(layer.id, null);
      }
    }
    node.getLayer()?.batchDraw();
    return () => {
      node.filters([]);
      node.clearCache();
    };
  }, [a, layer.id, layer.image, layer.name, layer.width, layer.height, onResourceIssue, resourceBudgetError]);

  useEffect(() => () => onResourceIssue(layer.id, null), [layer.id, onResourceIssue]);

  return (
    <KImage
      {...common}
      ref={(node) => {
        ref.current = node;
        register(node);
      }}
      image={layer.image}
      width={layer.width}
      height={layer.height}
      offsetX={layer.width / 2}
      offsetY={layer.height / 2}
      brightness={a.brightness}
      contrast={a.contrast}
      hue={a.hue}
      saturation={a.saturation}
      luminance={a.luminance}
      blurRadius={a.blur}
    />
  );
}

export default function ComposerLayerNode({
  layer,
  interactive,
  hidden,
  onSelect,
  onDragMove,
  onDragEnd,
  onTransformEnd,
  onBeginTextEdit,
  registerNode,
  onResourceIssue,
  resourceBudgetError,
}: Props) {
  if (!layer.visible) return null;

  const register = (node: Konva.Node | null) => { registerNode(layer.id, node); };
  const editable = interactive && !layer.locked;

  const common: CommonNodeProps = {
    id: layer.id,
    name: 'composer-layer',
    x: layer.x,
    y: layer.y,
    rotation: layer.rotation,
    scaleX: layer.scaleX,
    scaleY: layer.scaleY,
    opacity: layer.opacity,
    globalCompositeOperation: (layer.type === 'brush' && layer.erase
      ? 'destination-out'
      : layer.blendMode) as GlobalCompositeOperation,
    listening: editable,
    draggable: editable,
    onMouseDown: () => onSelect(layer.id),
    onTap: () => onSelect(layer.id),
    onDragMove: (e) => onDragMove(layer.id, e.target, e.evt),
    onDragEnd: (e) => onDragEnd(layer.id, e.target),
    onTransformEnd: (e) => onTransformEnd(layer.id, e.target),
  };

  switch (layer.type) {
    case 'image':
      return (
        <ComposerImage
          layer={layer}
          register={register}
          common={common}
          onResourceIssue={onResourceIssue}
          resourceBudgetError={resourceBudgetError}
        />
      );
    case 'rect':
      return (
        <Rect
          {...common}
          ref={register}
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
          {...common}
          ref={register}
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
          {...common}
          ref={register}
          text={layer.text}
          fontSize={layer.fontSize}
          fontFamily={layer.fontFamily}
          fontStyle={layer.fontStyle}
          fill={layer.fill}
          align={layer.align}
          width={layer.width}
          offsetX={layer.width / 2}
          lineHeight={layer.lineHeight}
          letterSpacing={layer.letterSpacing}
          stroke={layer.strokeWidth > 0 ? layer.stroke : undefined}
          strokeWidth={layer.strokeWidth}
          fillAfterStrokeEnabled
          shadowColor="#000000"
          shadowBlur={layer.shadow ? Math.max(4, layer.fontSize / 8) : 0}
          shadowOpacity={layer.shadow ? 0.55 : 0}
          shadowOffsetY={layer.shadow ? Math.max(2, layer.fontSize / 20) : 0}
          visible={!hidden}
          onDblClick={() => onBeginTextEdit(layer)}
          onDblTap={() => onBeginTextEdit(layer)}
        />
      );
    case 'line':
      return (
        <Line
          {...common}
          ref={register}
          points={layer.points}
          stroke={layer.stroke}
          strokeWidth={layer.strokeWidth}
          lineCap="round"
        />
      );
    case 'arrow':
      return (
        <Arrow
          {...common}
          ref={register}
          points={layer.points}
          stroke={layer.stroke}
          fill={layer.stroke}
          strokeWidth={layer.strokeWidth}
          pointerLength={layer.strokeWidth * 3}
          pointerWidth={layer.strokeWidth * 3}
        />
      );
    case 'brush':
      return (
        <Line
          {...common}
          ref={register}
          points={layer.points}
          stroke={layer.stroke}
          strokeWidth={layer.strokeWidth}
          tension={0.4}
          lineCap="round"
          lineJoin="round"
        />
      );
    default:
      return null;
  }
}
