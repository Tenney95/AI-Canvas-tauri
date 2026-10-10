import type { BaseNodeData } from '../../../types';
import { cellBackgroundStyle, gridBoundaries } from '../../../utils/storyboardGrid';

export const CONNECTED_PREVIEW_THUMB_SIZE = 48;
export const CONNECTED_PREVIEW_GAP = 6;
export const CONNECTED_PREVIEW_LONG_PRESS_MS = 500;
export const CONNECTED_PREVIEW_MOVE_THRESHOLD_PX = 8;
export const REFERENCE_FAN_THUMB_SIZE = 64;

/** 全部素材沿装饰圆弧叠放，卡片纵轴朝向圆心；边缘空间不足时朝面板内展开。 */
export function calculateReferenceFan(
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
  count: number,
  arcCenterOffset = { x: 0, y: 0 },
) {
  const total = Math.max(0, Math.trunc(count));
  const padding = 12;
  const halfExtent = (rotation: number) => {
    const radians = rotation * Math.PI / 180;
    return REFERENCE_FAN_THUMB_SIZE / 2 * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians))) + 6;
  };
  const points = (inward: boolean) => Array.from({ length: total }, (_, index) => {
    const degrees = total === 1 ? 45 : 90 - index * 90 / (total - 1);
    const angle = degrees * Math.PI / 180;
    const direction = inward ? 1 : -1;
    return {
      x: direction * Math.cos(angle) * 96 + arcCenterOffset.x,
      y: direction * Math.sin(angle) * 96 + arcCenterOffset.y,
      rotate: degrees - 90,
    };
  });
  const outward = points(false);
  const fits = outward.every((point) => {
    const half = halfExtent(point.rotate);
    return anchor.x + point.x - half >= padding
      && anchor.y + point.y - half >= padding
      && anchor.x + point.x + half <= viewport.width - padding
      && anchor.y + point.y + half <= viewport.height - padding;
  });
  const items = fits ? outward : points(true);
  if (items.length === 0) return { items, inward: !fits };
  const minX = Math.min(...items.map((point) => point.x - halfExtent(point.rotate)));
  const maxX = Math.max(...items.map((point) => point.x + halfExtent(point.rotate)));
  const minY = Math.min(...items.map((point) => point.y - halfExtent(point.rotate)));
  const maxY = Math.max(...items.map((point) => point.y + halfExtent(point.rotate)));
  const shift = (min: number, max: number, origin: number, size: number) => Math.max(
    padding - origin - min,
    Math.min(0, size - padding - origin - max),
  );
  const dx = shift(minX, maxX, anchor.x, viewport.width);
  const dy = shift(minY, maxY, anchor.y, viewport.height);
  return {
    items: items.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
    inward: !fits,
  };
}

/** 读取实时节点内容；宫格引用只预览被引用的格子，不把整张主图当作单格。 */
export function resolveMentionPreview(
  nodes: readonly { id: string; data: BaseNodeData }[],
  id: string,
  fallbackLabel: string,
  thumbnailUrl?: string,
) {
  const cell = id.match(/^(.*)\/cell\/(\d+)$/);
  const node = nodes.find((item) => item.id === (cell?.[1] ?? id));
  const data = node?.data;
  const image = thumbnailUrl || data?.thumbnailUrl || data?.imageUrl || data?.directorCaptureUrls?.[0];
  const outputType: 'image' | 'video' | 'audio' | 'text' = cell || data?.imageUrl || data?.directorCaptureUrls?.length ? 'image'
    : data?.videoUrl ? 'video' : data?.audioUrl ? 'audio' : 'text';
  let sprite: ReturnType<typeof cellBackgroundStyle> | undefined;
  let cellImage = image;
  if (cell && data?.type === 'ai-storyboard') {
    const index = Number(cell[2]);
    const cols = Math.max(1, data.storyboardCols || 3);
    const rows = Math.max(1, data.storyboardRows || 3);
    const override = data.storyboardOverrides?.[index]?.url;
    if (index >= rows * cols) cellImage = undefined;
    else if (override) cellImage = override;
    else if (image) {
      const h = gridBoundaries(rows, data.storyboardRowPositions);
      const v = gridBoundaries(cols, data.storyboardColPositions);
      const row = Math.floor(index / cols);
      const col = index % cols;
      sprite = cellBackgroundStyle(v[col], h[row], v[col + 1] - v[col], h[row + 1] - h[row]);
    }
  }
  return {
    label: cell ? fallbackLabel : data?.label || fallbackLabel,
    displayId: cell ? undefined : data?.displayId,
    outputType,
    thumbnailUrl: cellImage,
    sprite,
    text: typeof data?.output === 'string' ? data.output.slice(0, 240) : '',
    missing: !node,
  };
}

interface PreviewNodeRef {
  id: string;
  type?: string;
  parentId?: string;
}

interface PreviewEdgeRef {
  id: string;
  source: string;
  target: string;
}

export function getConnectedPreviewEdgeIds(
  nodes: readonly PreviewNodeRef[],
  edges: readonly PreviewEdgeRef[],
  targetId: string,
): Map<string, string[]> {
  const target = nodes.find((node) => node.id === targetId);
  const targetIds = new Set([targetId, ...(target?.parentId ? [target.parentId] : [])]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edgeIdsBySource = new Map<string, string[]>();

  for (const edge of edges) {
    if (!targetIds.has(edge.target)) continue;
    const source = byId.get(edge.source);
    const sourceIds = source?.type === 'group'
      ? nodes.filter((node) => node.parentId === source.id).map((node) => node.id)
      : [edge.source];
    for (const sourceId of sourceIds) {
      const ids = edgeIdsBySource.get(sourceId) ?? [];
      ids.push(edge.id);
      edgeIdsBySource.set(sourceId, ids);
    }
  }

  return edgeIdsBySource;
}

export function calculateDockOffset(
  index: number,
  hoverIndex: number | null,
  maxScale: number,
  nearScale: number,
  thumbSize = CONNECTED_PREVIEW_THUMB_SIZE,
): number {
  if (hoverIndex === null || index === hoverIndex) return 0;
  const delta = index - hoverIndex;
  const distance = Math.abs(delta);
  const direction = Math.sign(delta);
  const hoveredHalfGrowth = thumbSize * (maxScale - 1) / 2;
  const nearFullGrowth = thumbSize * (nearScale - 1);
  const targetHalfGrowth = distance === 1 ? nearFullGrowth / 2 : 0;
  const betweenGrowth = distance > 1 ? nearFullGrowth : 0;

  return direction * (hoveredHalfGrowth + betweenGrowth + targetHalfGrowth);
}

interface LongPressPointer {
  button: number;
  isPrimary: boolean;
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface ConnectedPreviewLongPressController<T> {
  start: (item: T, event: LongPressPointer) => boolean;
  move: (event: Pick<LongPressPointer, 'pointerId' | 'clientX' | 'clientY'>) => void;
  end: (pointerId: number) => void;
  cancel: () => void;
  dispose: () => void;
}

export function createConnectedPreviewLongPressController<T>(
  onTrigger: (item: T) => void,
  delay = CONNECTED_PREVIEW_LONG_PRESS_MS,
  moveThreshold = CONNECTED_PREVIEW_MOVE_THRESHOLD_PX,
): ConnectedPreviewLongPressController<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: ({ item: T } & Pick<LongPressPointer, 'pointerId' | 'clientX' | 'clientY'>) | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    active = null;
  };

  return {
    start: (item, event) => {
      cancel();
      if (event.button !== 0 || !event.isPrimary) return false;
      active = {
        item,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      timer = setTimeout(() => {
        if (!active) return;
        const triggeredItem = active.item;
        timer = null;
        active = null;
        onTrigger(triggeredItem);
      }, delay);
      return true;
    },
    move: (event) => {
      if (!active || active.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - active.clientX, event.clientY - active.clientY) > moveThreshold) {
        cancel();
      }
    },
    end: (pointerId) => {
      if (active?.pointerId === pointerId) cancel();
    },
    cancel,
    dispose: cancel,
  };
}
