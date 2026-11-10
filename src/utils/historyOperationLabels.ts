/**
 * 从两份画布快照的差异推断一条「操作记录」描述。
 *
 * 撤销栈里存的是纯快照（commitToHistory 在改动前记录当前状态），61 处调用点都没有
 * 携带操作名。与其给每个调用点补参数，这里直接对比前后快照来命名操作 ——
 * 好处是描述永远和真实发生的改动一致，不会因为漏传参数而失真。
 */
import { getNodeTypeConfig } from '../types';
import type { BaseNodeData, NodeGroup } from '../types';
import { t } from '../i18n';
import { getGroupLayoutPosition } from './groupCollapseLayout';

export interface HistorySnapshotLike {
  nodes: {
    id: string;
    type?: string;
    position: { x: number; y: number };
    data: BaseNodeData;
    width?: number;
    height?: number;
    measured?: { width?: number; height?: number };
    style?: { width?: string | number; height?: string | number };
  }[];
  edges: { id: string }[];
  groups: NodeGroup[];
}

export interface HistoryOperationLabel {
  title: string;
  icon: string;
}

/** 历史只比较分组的展开尺寸，文件夹卡片大小属于浏览状态。 */
export function getHistoryGroupSize(node: HistorySnapshotLike['nodes'][number]): { width: number; height: number } {
  if (node.data.groupCollapsed && node.data.groupExpandedSize) return node.data.groupExpandedSize;
  return {
    width: Number(node.width ?? node.style?.width ?? node.measured?.width) || 320,
    height: Number(node.height ?? node.style?.height ?? node.measured?.height) || 200,
  };
}

/** 节点类型 → 中文名，用于「新增生成图像」这类描述。 */
function nodeTypeLabel(node: HistorySnapshotLike['nodes'][number], translate: typeof t): string {
  const kind = (node.data?.type as string) || node.type || '';
  return translate(getNodeTypeConfig(kind).label);
}

function countLabel(nodes: HistorySnapshotLike['nodes'], translate: typeof t): string {
  if (nodes.length === 1) return nodeTypeLabel(nodes[0], translate);
  const kinds = new Set(nodes.map((node) => nodeTypeLabel(node, translate)));
  return kinds.size === 1
    ? translate('{count} 个{type}', { count: nodes.length, type: [...kinds][0] })
    : translate('{count} 个节点', { count: nodes.length });
}

/** 节点内容是否发生变化（忽略位置与尺寸，这两项另作「移动 / 调整大小」处理）。 */
function hasContentChange(before: BaseNodeData, after: BaseNodeData): boolean {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  keys.delete('nodeWidth');
  keys.delete('nodeHeight');
  keys.delete('groupCollapsed');
  keys.delete('groupExpandedSize');
  keys.delete('groupLayoutOffsetX');
  keys.delete('groupCollapseLayout');
  for (const key of keys) {
    const left = (before as Record<string, unknown>)?.[key];
    const right = (after as Record<string, unknown>)?.[key];
    if (left === right) continue;
    // 对象/数组只做浅层 JSON 比较，够用且不会因引用变化误报
    if (JSON.stringify(left) !== JSON.stringify(right)) return true;
  }
  return false;
}

/**
 * 比较前后快照，给出一条描述。按「结构改动优先」排序：
 * 增删节点 > 连线 > 分组 > 内容编辑 > 尺寸 > 位置。
 */
export function describeCanvasChange(
  before: HistorySnapshotLike,
  after: HistorySnapshotLike,
  translate: typeof t = t,
): HistoryOperationLabel {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));

  const added = after.nodes.filter((node) => !beforeNodes.has(node.id));
  const removed = before.nodes.filter((node) => !afterNodes.has(node.id));
  if (added.length > 0 && removed.length === 0) {
    return { title: translate('新增 {target}', { target: countLabel(added, translate) }), icon: 'mdi:plus-circle-outline' };
  }
  if (removed.length > 0 && added.length === 0) {
    return { title: translate('删除 {target}', { target: countLabel(removed, translate) }), icon: 'mdi:trash-can-outline' };
  }
  if (added.length > 0 && removed.length > 0) {
    return { title: translate('替换 {target}', { target: countLabel(removed, translate) }), icon: 'mdi:swap-horizontal' };
  }

  const beforeEdges = new Set(before.edges.map((edge) => edge.id));
  const afterEdges = new Set(after.edges.map((edge) => edge.id));
  const addedEdges = [...afterEdges].filter((id) => !beforeEdges.has(id)).length;
  const removedEdges = [...beforeEdges].filter((id) => !afterEdges.has(id)).length;
  if (addedEdges > 0 && removedEdges === 0) {
    return {
      title: addedEdges === 1 ? translate('连接节点') : translate('新增 {count} 条连线', { count: addedEdges }),
      icon: 'mdi:vector-polyline-plus',
    };
  }
  if (removedEdges > 0 && addedEdges === 0) {
    return {
      title: removedEdges === 1 ? translate('断开连线') : translate('删除 {count} 条连线', { count: removedEdges }),
      icon: 'mdi:vector-polyline-remove',
    };
  }
  if (addedEdges > 0 || removedEdges > 0) {
    return { title: translate('调整连线'), icon: 'mdi:vector-polyline' };
  }

  if (before.groups.length !== after.groups.length) {
    return {
      title: after.groups.length > before.groups.length ? translate('新建分组') : translate('解散分组'),
      icon: 'mdi:group',
    };
  }
  const groupChanged = after.groups.some((group) => {
    const previous = before.groups.find((item) => item.id === group.id);
    if (!previous) return true;
    return previous.nodeIds.length !== group.nodeIds.length
      || previous.nodeIds.some((id, index) => id !== group.nodeIds[index])
      || previous.name !== group.name;
  });
  if (groupChanged) return { title: translate('调整分组'), icon: 'mdi:group' };

  const contentChanged = after.nodes.filter((node) => {
    const previous = beforeNodes.get(node.id);
    return previous && hasContentChange(previous.data, node.data);
  });
  if (contentChanged.length > 0) {
    return {
      title: translate('编辑 {target}', { target: countLabel(contentChanged, translate) }),
      icon: 'mdi:pencil-outline',
    };
  }

  const resized = after.nodes.filter((node) => {
    const previous = beforeNodes.get(node.id);
    if (!previous) return false;
    if (previous.type === 'group' && node.type === 'group') {
      const beforeSize = getHistoryGroupSize(previous);
      const afterSize = getHistoryGroupSize(node);
      return beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height;
    }
    return previous.data?.nodeWidth !== node.data?.nodeWidth
      || previous.data?.nodeHeight !== node.data?.nodeHeight
      || previous.style?.width !== node.style?.width
      || previous.style?.height !== node.style?.height;
  });
  if (resized.length > 0) {
    return { title: translate('调整节点大小'), icon: 'mdi:resize' };
  }

  const moved = after.nodes.filter((node) => {
    const previous = beforeNodes.get(node.id);
    if (!previous) return false;
    const beforePosition = getGroupLayoutPosition(previous);
    const afterPosition = getGroupLayoutPosition(node);
    return beforePosition.x !== afterPosition.x || beforePosition.y !== afterPosition.y;
  });
  if (moved.length > 0) {
    return { title: translate('移动节点位置'), icon: 'mdi:cursor-move' };
  }

  return { title: translate('画布修改'), icon: 'mdi:circle-small' };
}
