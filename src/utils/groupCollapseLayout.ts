/** 分组开合的可逆水平让位；位置仍由 Store 保存，子节点相对坐标不变。 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';

type CanvasNode = Node<BaseNodeData>;
type CollapseLayout = NonNullable<BaseNodeData['groupCollapseLayout']>;
// 与分组 28px 头部同一高度范围才视作同排，不能用整个大分组高度吞并下方各行。
const ROW_TOLERANCE = 28;

export function getGroupLayoutOffsetX(node: Pick<CanvasNode, 'data'>): number {
  const value = node.data.groupLayoutOffsetX;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function getGroupLayoutPosition(node: Pick<CanvasNode, 'data' | 'position'>) {
  return { x: node.position.x - getGroupLayoutOffsetX(node), y: node.position.y };
}

function comparisonCoordinate(value: number): number {
  const scaled = value * 1_000_000;
  if (!Number.isFinite(scaled)) return value;
  const rounded = Math.round(scaled) / 1_000_000;
  return rounded === 0 ? 0 : rounded;
}

/** 仅历史与操作描述按百万分之一画布单位比较，消除加减位移的浮点误差；实际位置与恢复不量化。 */
export function getGroupLayoutComparisonPosition(node: Pick<CanvasNode, 'data' | 'position'>) {
  const position = getGroupLayoutPosition(node);
  return { x: comparisonCoordinate(position.x), y: comparisonCoordinate(position.y) };
}

export function clearGroupLayoutData(data: BaseNodeData): BaseNodeData {
  const next = { ...data };
  delete next.groupLayoutOffsetX;
  delete next.groupCollapseLayout;
  return next;
}

/** 锁定节点是这一排的锚点；锚点及其后续内容不参与本轮靠拢。 */
export function createGroupCollapseLayout(nodes: CanvasNode[], group: CanvasNode, width: number, deltaX: number): CollapseLayout {
  const right = group.position.x + width;
  const candidates = nodes.filter((node) => node.id !== group.id && node.parentId === group.parentId
    && !node.hidden && !node.data.hiddenByCharacterLibrary
    && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
    && node.position.x >= right && Math.abs(node.position.y - group.position.y) <= ROW_TOLERANCE);
  const barrier = candidates.reduce((x, node) => node.draggable === false ? Math.min(x, node.position.x) : x, Infinity);
  return { deltaX, parentId: group.parentId, nodeIds: candidates.filter((node) => node.position.x < barrier).map((node) => node.id) };
}

/** 展示尺寸可在撤销真实缩放后改变；按当前展开宽度修正贡献，而非复用旧绝对坐标。 */
function currentLayout(node: CanvasNode): CollapseLayout | undefined {
  const layout = node.data.groupCollapseLayout;
  if (node.type !== 'group' || !node.data.groupCollapsed || !layout
    || layout.parentId !== node.parentId || !Number.isFinite(layout.deltaX)
    || !Array.isArray(layout.nodeIds)) return undefined;
  const width = Number(node.width ?? node.style?.width);
  const expandedWidth = node.data.groupExpandedSize?.width;
  const deltaX = width > 0 && Number.isFinite(width) && typeof expandedWidth === 'number'
    && expandedWidth > 0 && Number.isFinite(expandedWidth) ? width - expandedWidth : layout.deltaX;
  return deltaX === layout.deltaX ? layout : { ...layout, deltaX };
}

/** 根据当前折叠记录重算展示偏移，供开合与历史恢复共用。 */
export function reconcileGroupLayoutOffsets(nodes: CanvasNode[]): CanvasNode[] {
  if (!nodes.some((node) => node.data.groupLayoutOffsetX !== undefined || node.data.groupCollapseLayout !== undefined)) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const offsets = new Map<string, number>();
  const layouts = new Map<string, CollapseLayout>();
  for (const group of nodes) {
    const layout = currentLayout(group);
    if (!layout) continue;
    layouts.set(group.id, layout);
    for (const id of new Set(layout.nodeIds)) {
      if (typeof id !== 'string' || id === group.id) continue;
      const node = byId.get(id);
      if (!node || node.parentId !== layout.parentId) continue;
      const offset = (offsets.get(id) ?? 0) + layout.deltaX;
      if (Number.isFinite(offset)) offsets.set(id, offset);
    }
  }
  return nodes.map((node) => {
    const offset = offsets.get(node.id) ?? 0;
    const previous = getGroupLayoutOffsetX(node);
    const layout = layouts.get(node.id);
    if (offset === previous && (!layout || layout === node.data.groupCollapseLayout)) return node;
    const x = node.position.x + offset - previous;
    if (!Number.isFinite(x)) return node;
    const data = { ...node.data };
    if (offset) data.groupLayoutOffsetX = offset;
    else delete data.groupLayoutOffsetX;
    if (layout) data.groupCollapseLayout = layout;
    return { ...node, position: offset === previous ? node.position : { ...node.position, x }, data };
  });
}

/** 换/脱组保留当前可见坐标，解除旧同层的偏移关系；拆走折叠源时归还它对其他节点的贡献。 */
export function detachGroupLayoutNodes(nodes: CanvasNode[], nodeIds: ReadonlySet<string>): CanvasNode[] {
  if (!nodeIds.size) return nodes;
  return reconcileGroupLayoutOffsets(nodes.map((node) => {
    if (nodeIds.has(node.id)) return { ...node, data: clearGroupLayoutData(node.data) };
    const layout = node.data.groupCollapseLayout;
    if (!layout || !Array.isArray(layout.nodeIds) || !layout.nodeIds.some((id) => nodeIds.has(id))) return node;
    return { ...node, data: { ...node.data,
      groupCollapseLayout: { ...layout, nodeIds: layout.nodeIds.filter((id) => !nodeIds.has(id)) },
    } };
  }));
}
