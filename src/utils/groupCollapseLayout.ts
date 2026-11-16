/** 分组开合的可逆双轴让位；位置仍由 Store 保存，子节点相对坐标不变。 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { getNodeSize } from './nodeBounds';

type CanvasNode = Node<BaseNodeData>;
type CollapseLayout = NonNullable<BaseNodeData['groupCollapseLayout']>;
type Axis = 'x' | 'y';
type Size = { width: number; height: number };
type AxisLayout = { delta: number; nodeIds: string[]; expandedNodeIds?: string[] };
// 收起时仅靠拢同排／同列的后继，不能用整个大分组范围吞并其他行列。
const ROW_TOLERANCE = 28;
const dimension = (axis: Axis) => axis === 'x' ? 'width' : 'height';
const crossAxis = (axis: Axis): Axis => axis === 'x' ? 'y' : 'x';

export function getGroupLayoutOffsetX(node: Pick<CanvasNode, 'data'>): number {
  const value = node.data.groupLayoutOffsetX;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function getGroupLayoutOffsetY(node: Pick<CanvasNode, 'data'>): number {
  const value = node.data.groupLayoutOffsetY;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function getGroupLayoutPosition(node: Pick<CanvasNode, 'data' | 'position'>) {
  return { x: node.position.x - getGroupLayoutOffsetX(node), y: node.position.y - getGroupLayoutOffsetY(node) };
}

function comparisonCoordinate(value: number): number {
  const scaled = value * 1_000_000;
  if (!Number.isFinite(scaled)) return value;
  const rounded = Math.round(scaled) / 1_000_000;
  return rounded === 0 ? 0 : rounded;
}

/** 仅历史与操作描述量化比较，消除加减位移的浮点误差；实际位置与恢复不量化。 */
export function getGroupLayoutComparisonPosition(node: Pick<CanvasNode, 'data' | 'position'>) {
  const position = getGroupLayoutPosition(node);
  return { x: comparisonCoordinate(position.x), y: comparisonCoordinate(position.y) };
}

export function clearGroupLayoutData(data: BaseNodeData): BaseNodeData {
  const next = { ...data };
  delete next.groupLayoutOffsetX;
  delete next.groupLayoutOffsetY;
  delete next.groupCollapseLayout;
  return next;
}

function axisLayout(layout: CollapseLayout | undefined, axis: Axis): AxisLayout | undefined {
  const source = axis === 'x' ? layout : layout?.vertical;
  const delta = axis === 'x' ? layout?.deltaX : layout?.vertical?.deltaY;
  if (!source || typeof delta !== 'number' || !Number.isFinite(delta) || !Array.isArray(source.nodeIds)
    || (source.expandedNodeIds !== undefined && !Array.isArray(source.expandedNodeIds))) return undefined;
  return { delta, nodeIds: source.nodeIds, expandedNodeIds: source.expandedNodeIds };
}

function sameLayer(nodes: CanvasNode[], group: CanvasNode): CanvasNode[] {
  return nodes.filter((node) => node.id !== group.id && node.parentId === group.parentId
    && !node.hidden && !node.data.hiddenByCharacterLibrary
    && Number.isFinite(node.position.x) && Number.isFinite(node.position.y));
}

function layoutItems(nodes: CanvasNode[], group: CanvasNode) {
  return sameLayer(nodes, group).map((node) => ({
    node, ...node.position, basis: getGroupLayoutPosition(node),
    ...getNodeSize(node.type === 'group' ? { ...node, measured: undefined } : node),
  }));
}
type LayoutItem = ReturnType<typeof layoutItems>[number];
const intersects = (a: { x: number; y: number } & Size, b: { x: number; y: number } & Size) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const sameIds = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/** 关系按用户坐标判断，碰撞按撤去本源贡献后的可见坐标判断。 */
function createGroupCollapseLayout(
  nodes: CanvasNode[], group: CanvasNode, size: Size, nextSize: Size, previous?: CollapseLayout,
): CollapseLayout {
  const peers = layoutItems(nodes, group);
  const origin = getGroupLayoutPosition(group);
  const lowerRows = peers.filter((item) => item.basis.y >= origin.y + size.height
    && Math.abs(item.basis.x - origin.x) <= ROW_TOLERANCE);
  const createAxis = (axis: Axis): AxisLayout => {
    const old = previous?.parentId === group.parentId ? axisLayout(previous, axis) : undefined;
    const cross = crossAxis(axis);
    const candidates = peers.filter((item) => item.basis[axis] >= origin[axis] + size[dimension(axis)]
      && (Math.abs(item.basis[cross] - origin[cross]) <= ROW_TOLERANCE
        || (axis === 'y' && lowerRows.some((peer) => Math.abs(peer.basis.y - item.basis.y) <= ROW_TOLERANCE
          && item.basis.x >= peer.basis.x))));
    const barrier = candidates.reduce((at, item) => item.node.draggable === false ? Math.min(at, item.basis[axis]) : at, Infinity);
    return {
      delta: nextSize[dimension(axis)] - size[dimension(axis)],
      nodeIds: candidates.filter((item) => item.basis[axis] < barrier
        && (!old?.expandedNodeIds?.includes(item.node.id) || old.nodeIds.includes(item.node.id))).map((item) => item.node.id),
      ...(old?.expandedNodeIds ? { expandedNodeIds: old.expandedNodeIds } : {}),
    };
  };
  const x = createAxis('x');
  const y = createAxis('y');
  // 收回不能制造新的遮挡；发生碰撞时保留该轴整段，下一轮再按当前排列求解。
  const movingX = new Set(x.nodeIds);
  const movingY = new Set(y.nodeIds);
  const destination = (item: LayoutItem) => ({ ...item,
    x: item.x + (movingX.has(item.node.id) ? x.delta : 0),
    y: item.y + (movingY.has(item.node.id) ? y.delta : 0),
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of peers) {
      if (!movingX.has(item.node.id) && !movingY.has(item.node.id)) continue;
      if (!peers.some((other) => other !== item && intersects(destination(item), destination(other)) && !intersects(item, other))) continue;
      if (movingX.has(item.node.id)) { movingX.clear(); changed = true; }
      if (movingY.has(item.node.id)) { movingY.clear(); changed = true; }
    }
  }
  x.nodeIds = [...movingX];
  y.nodeIds = [...movingY];
  return { deltaX: x.delta, nodeIds: x.nodeIds, expandedNodeIds: x.expandedNodeIds, parentId: group.parentId,
    vertical: { deltaY: y.delta, nodeIds: y.nodeIds, expandedNodeIds: y.expandedNodeIds },
  };
}

/** 新旧关系均重新选轴并通过锁点检查，旧名单只作为持续关联的种子。 */
function createGroupExpansionLayout(nodes: CanvasNode[], group: CanvasNode, collapsedSize: Size, previous?: CollapseLayout): CollapseLayout | undefined {
  const size = { width: Number(group.width ?? group.style?.width), height: Number(group.height ?? group.style?.height) };
  if (![size.width, size.height, collapsedSize.width, collapsedSize.height].every((value) => Number.isFinite(value) && value > 0)) return previous;
  const x = axisLayout(previous, 'x') ?? { delta: collapsedSize.width - size.width, nodeIds: [] };
  const y = axisLayout(previous, 'y') ?? { delta: collapsedSize.height - size.height, nodeIds: [] };
  const oldX = new Set(x.expandedNodeIds ?? []);
  const oldY = new Set(y.expandedNodeIds ?? []);
  const negativeX = new Set(x.nodeIds);
  const negativeY = new Set(y.nodeIds);
  const items = layoutItems(nodes, group).map((item) => ({ ...item,
    // 用本源的紧凑相位认同行：原后继已归还负贡献，新放入空隙的内容尚无贡献。
    compact: { x: item.basis.x + (negativeX.has(item.node.id) ? x.delta : 0),
      y: item.basis.y + (negativeY.has(item.node.id) ? y.delta : 0) },
  }));
  const origin = getGroupLayoutPosition(group);
  const oldIds = new Set([...oldX, ...oldY]);
  const owner = new Map<string, Axis>();
  const collides = (item: LayoutItem) => intersects(item, { ...group.position, ...size });
  const lowerRows = items.filter((item) => (collides(item) || oldIds.has(item.node.id) || negativeY.has(item.node.id)) && y.delta < 0
    && item.compact.y >= origin.y + collapsedSize.height && item.compact.x < origin.x + collapsedSize.width);
  for (const item of items) {
    if (!oldIds.has(item.node.id) && !collides(item)) continue;
    const right = x.delta < 0 && item.compact.x >= origin.x + collapsedSize.width;
    const below = y.delta < 0 && item.compact.y >= origin.y + collapsedSize.height;
    if (right || below) {
      // 下方同排内容保持一起向下，避免展开、收起上方源时拆散仍在展开的下方分组与后继。
      const lowerRow = below && lowerRows.some((peer) => Math.abs(peer.compact.y - item.compact.y) <= ROW_TOLERANCE);
      owner.set(item.node.id, right && !lowerRow ? 'x' : 'y');
    }
  }
  const expandAxis = (axis: Axis, layout: AxisLayout): Set<string> => {
    const expandedIds = new Set<string>();
    if (layout.delta >= 0) return expandedIds;
    const cross = crossAxis(axis);
    const extent = dimension(axis);
    const crossExtent = dimension(cross);
    const candidates = items.filter((item) => item[axis] >= group.position[axis] + collapsedSize[extent]);
    const overlaps = (a: typeof items[number], b: typeof items[number]) => a[cross] < b[cross] + b[crossExtent]
      && a[cross] + a[crossExtent] > b[cross];
    const pending = candidates.filter((item) => owner.get(item.node.id) === axis && (oldIds.has(item.node.id) || collides(item)));
    const visited = new Set<string>();
    // 仅开合时扫描同层后继；闭包也保持单轴归属，避免右下角被横竖各推一次。
    for (let index = 0; index < pending.length; index++) {
      const collision = pending[index];
      if (visited.has(collision.node.id)) continue;
      visited.add(collision.node.id);
      const row = candidates.filter((item) => overlaps(item, collision));
      const barrier = row.reduce((at, item) => item.node.draggable === false ? Math.min(at, item[axis]) : at, Infinity);
      const moving = row.filter((item) => item[axis] >= collision[axis] && item[axis] < barrier
        && !expandedIds.has(item.node.id) && (!owner.has(item.node.id) || owner.get(item.node.id) === axis));
      if (moving.some((item) => item[axis] + item[extent] - layout.delta > barrier)) continue;
      for (const item of moving) {
        expandedIds.add(item.node.id);
        owner.set(item.node.id, axis);
        pending.push(item);
      }
    }
    const locked = candidates.filter((item) => item.node.draggable === false);
    if (candidates.some((item) => expandedIds.has(item.node.id)
      && locked.some((anchor) => overlaps(item, anchor) && item[axis] < anchor[axis]
        && item[axis] + item[extent] - layout.delta > anchor[axis]))) return new Set();
    return expandedIds;
  };
  const expandedX = expandAxis('x', x);
  const expandedY = expandAxis('y', y);
  if (sameIds(expandedX, oldX) && sameIds(expandedY, oldY)) return previous;
  return { ...previous, deltaX: x.delta, parentId: group.parentId, nodeIds: x.nodeIds, expandedNodeIds: [...expandedX],
    ...(previous?.vertical || expandedY.size ? { vertical: { deltaY: y.delta, nodeIds: y.nodeIds, expandedNodeIds: [...expandedY] } } : {}),
  };
}

/** 开合共用同一事务：撤本源贡献 → 目标尺寸与关系求解 → 一次投影。 */
export function toggleGroupLayout(nodes: CanvasNode[], groupId: string, collapsedSize: Size): CanvasNode[] {
  const group = nodes.find((node) => node.id === groupId && node.type === 'group');
  if (!group) return nodes;
  const collapsed = group.data.groupCollapsed === true;
  const expanded = group.data.groupExpandedSize;
  const size = {
    width: Number(group.width ?? group.style?.width ?? group.measured?.width) || 320,
    height: Number(group.height ?? group.style?.height ?? group.measured?.height) || 200,
  };
  const nextSize = collapsed ? expanded ?? size : collapsedSize;
  const previous = currentLayout(group);
  const neutral = reconcileGroupLayoutOffsets(nodes.map((node) => node.id === groupId
    ? { ...node, data: { ...node.data, groupCollapseLayout: undefined } } : node));
  const next = neutral.map((node) => node.id !== groupId ? node : {
    ...node, ...nextSize, style: { ...node.style, ...nextSize },
    data: { ...node.data, groupCollapsed: collapsed ? undefined : true,
      groupExpandedSize: collapsed ? expanded : size },
  });
  const source = next.find((node) => node.id === groupId)!;
  const layout = collapsed ? createGroupExpansionLayout(next, source, size, previous)
    : createGroupCollapseLayout(neutral, neutral.find((node) => node.id === groupId)!, size, nextSize, previous);
  return reconcileGroupLayoutOffsets(next.map((node) => node.id === groupId
    ? { ...node, data: { ...node.data, groupCollapseLayout: layout } } : node));
}

/** 撤销真实缩放后，折叠态按当前展开宽高修正贡献，实际坐标不量化。 */
function currentLayout(node: CanvasNode): CollapseLayout | undefined {
  const layout = node.data.groupCollapseLayout;
  if (node.type !== 'group' || !layout || layout.parentId !== node.parentId || !axisLayout(layout, 'x')) return undefined;
  if (!node.data.groupCollapsed) return layout;
  const size = { width: Number(node.width ?? node.style?.width), height: Number(node.height ?? node.style?.height) };
  const expanded = node.data.groupExpandedSize;
  const deltaX = size.width > 0 && Number.isFinite(size.width) && expanded && expanded.width > 0 && Number.isFinite(expanded.width)
    ? size.width - expanded.width : layout.deltaX;
  const vertical = axisLayout(layout, 'y');
  const deltaY = vertical && size.height > 0 && Number.isFinite(size.height) && expanded && expanded.height > 0 && Number.isFinite(expanded.height)
    ? size.height - expanded.height : vertical?.delta;
  if (deltaX === layout.deltaX && deltaY === layout.vertical?.deltaY) return layout;
  return { ...layout, deltaX, ...(vertical ? { vertical: { ...layout.vertical!, deltaY: deltaY! } } : {}) };
}

/** 根据当前开合记录重算两轴展示偏移，供开合与历史恢复共用。 */
export function reconcileGroupLayoutOffsets(nodes: CanvasNode[]): CanvasNode[] {
  if (!nodes.some((node) => node.data.groupLayoutOffsetX !== undefined || node.data.groupLayoutOffsetY !== undefined
    || node.data.groupCollapseLayout !== undefined)) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const offsets = new Map<string, { x: number; y: number }>();
  const layouts = new Map<string, CollapseLayout>();
  for (const group of nodes) {
    const layout = currentLayout(group);
    if (!layout) continue;
    layouts.set(group.id, layout);
    for (const axis of ['x', 'y'] as const) {
      const value = axisLayout(layout, axis);
      if (!value) continue;
      const ids = group.data.groupCollapsed ? value.nodeIds : value.expandedNodeIds ?? [];
      const delta = group.data.groupCollapsed ? value.delta : -value.delta;
      for (const id of new Set(ids)) {
        if (typeof id !== 'string' || id === group.id) continue;
        const node = byId.get(id);
        if (!node || node.parentId !== layout.parentId) continue;
        const offset = offsets.get(id) ?? { x: 0, y: 0 };
        const next = offset[axis] + delta;
        if (Number.isFinite(next)) offsets.set(id, { ...offset, [axis]: next });
      }
    }
  }
  return nodes.map((node) => {
    const previous = { x: getGroupLayoutOffsetX(node), y: getGroupLayoutOffsetY(node) };
    // 锁定／隐藏期间冻结可见位置及其偏移，不把冻结的自动位移烘焙成用户移动。
    const frozen = node.draggable === false || node.hidden || node.data.hiddenByCharacterLibrary;
    const offset = frozen ? previous : offsets.get(node.id) ?? { x: 0, y: 0 };
    const layout = layouts.get(node.id);
    const samePosition = offset.x === previous.x && offset.y === previous.y;
    if (samePosition && (!layout || layout === node.data.groupCollapseLayout)) return node;
    const x = node.position.x + offset.x - previous.x;
    const y = node.position.y + offset.y - previous.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return node;
    const data = { ...node.data };
    if (offset.x) data.groupLayoutOffsetX = offset.x;
    else delete data.groupLayoutOffsetX;
    if (offset.y) data.groupLayoutOffsetY = offset.y;
    else delete data.groupLayoutOffsetY;
    if (layout) data.groupCollapseLayout = layout;
    return { ...node, position: samePosition ? node.position : { ...node.position, x, y }, data };
  });
}

/** 换/脱组保留当前可见坐标，解除旧层两轴关系；拆走源分组时归还它的贡献。 */
export function detachGroupLayoutNodes(nodes: CanvasNode[], nodeIds: ReadonlySet<string>): CanvasNode[] {
  if (!nodeIds.size) return nodes;
  return reconcileGroupLayoutOffsets(nodes.map((node) => {
    if (nodeIds.has(node.id)) return { ...node, data: clearGroupLayoutData(node.data) };
    const layout = node.data.groupCollapseLayout;
    if (!layout) return node;
    const x = axisLayout(layout, 'x');
    const y = axisLayout(layout, 'y');
    if (![...(x?.nodeIds ?? []), ...(x?.expandedNodeIds ?? []), ...(y?.nodeIds ?? []), ...(y?.expandedNodeIds ?? [])]
      .some((id) => nodeIds.has(id))) return node;
    const keep = (ids: string[]) => ids.filter((id) => !nodeIds.has(id));
    return { ...node, data: { ...node.data, groupCollapseLayout: {
      ...layout,
      ...(x ? { nodeIds: keep(x.nodeIds), ...(x.expandedNodeIds ? { expandedNodeIds: keep(x.expandedNodeIds) } : {}) } : {}),
      ...(y ? { vertical: { deltaY: y.delta, nodeIds: keep(y.nodeIds),
        ...(y.expandedNodeIds ? { expandedNodeIds: keep(y.expandedNodeIds) } : {}),
      } } : {}),
    } } };
  }));
}
