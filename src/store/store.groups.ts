/**
 * Group slice — visual node grouping on canvas
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { NodeGroup } from '../types';
import { GROUP_COLOR_PALETTE } from '../types';
import { generateId } from './store.utils';

export interface GroupSlice {
  groups: NodeGroup[];
  groupSelectedNodes: () => void;
  ungroupSelectedNodes: () => void;
  renameGroup: (id: string, name: string) => void;
}

export const createGroupSlice: StateCreator<AppState, [], [], GroupSlice> = (set, get) => ({
  groups: [],

  groupSelectedNodes: () => {
    const { selectedNodeIds, groups, nodes } = get();
    if (selectedNodeIds.length === 0) {
      get().showToast('请先选中节点', 'error');
      return;
    }

    // Auto-detect ungroup scenario:
    // - any selected node has parentId (inside a group)
    // - any selected node is itself a group node
    const shouldUngroup = nodes.some(
      (n) => selectedNodeIds.includes(n.id) && (n.parentId != null || n.type === 'group'),
    );
    if (shouldUngroup) {
      get().ungroupSelectedNodes();
      return;
    }

    if (selectedNodeIds.length < 2) {
      get().showToast('请至少选中 2 个节点', 'error');
      return;
    }

    const candidateIds = selectedNodeIds;

    get().commitToHistory();

    // Compute bounding box from absolute positions
    const selectedNodes = nodes.filter((n) => candidateIds.includes(n.id));
    const sizes = selectedNodes.map((n) => ({
      width: (n.data?.nodeWidth as number) || (n.measured?.width) || 280,
      height: (n.data?.nodeHeight as number) || (n.measured?.height) || 160,
    }));
    const minLeft = Math.min(...selectedNodes.map((n) => {
      const absX = n.parentId ? n.position.x + (nodes.find(p => p.id === n.parentId)?.position.x || 0) : n.position.x;
      return absX;
    }));
    const minTop = Math.min(...selectedNodes.map((n) => {
      const absY = n.parentId ? n.position.y + (nodes.find(p => p.id === n.parentId)?.position.y || 0) : n.position.y;
      return absY;
    }));

    const padding = 36;
    const titleBarH = 36;
    const gX = minLeft - padding;
    const gY = minTop - padding - titleBarH;

    // Calculate relative positions & group dimensions
    const relMap = new Map<string, { x: number; y: number }>();
    let maxRight = 0;
    let maxBottom = 0;

    for (let i = 0; i < candidateIds.length; i++) {
      const n = nodes.find((nn) => nn.id === candidateIds[i])!;
      const absX = n.parentId ? n.position.x + (nodes.find(p => p.id === n.parentId)?.position.x || 0) : n.position.x;
      const absY = n.parentId ? n.position.y + (nodes.find(p => p.id === n.parentId)?.position.y || 0) : n.position.y;
      const rx = absX - gX;
      const ry = absY - gY;
      relMap.set(n.id, { x: rx, y: ry });
      const right = rx + sizes[i].width;
      const bottom = ry + sizes[i].height;
      if (right > maxRight) maxRight = right;
      if (bottom > maxBottom) maxBottom = bottom;
    }

    const gW = Math.max(200, maxRight + padding);
    const gH = Math.max(120, maxBottom + padding);

    const usedColors = new Set(groups.map((g) => g.color));
    const color = GROUP_COLOR_PALETTE.find((c) => !usedColors.has(c)) || GROUP_COLOR_PALETTE[0];

    const groupId = `group-${generateId()}`;
    const newGroup: NodeGroup = {
      id: groupId,
      name: '分组',
      nodeIds: candidateIds,
      color,
      createdAt: Date.now(),
    };

    // Build the group node — must appear BEFORE its children in the nodes array
    const groupNode = {
      id: groupId,
      type: 'group' as const,
      position: { x: gX, y: gY },
      data: { label: newGroup.name, type: 'comment' as const, groupId, color },
      style: { width: gW, height: gH },
    };

    set((state) => ({
      groups: [...state.groups, newGroup],
      nodes: [
        // Place group node BEFORE children (xyflow requirement)
        groupNode,
        ...state.nodes.map((n) =>
          candidateIds.includes(n.id)
            ? { ...n, parentId: groupId, position: relMap.get(n.id)! }
            : n
        ),
      ],
    }));

    get().showToast(`已创建「${newGroup.name}」（${candidateIds.length} 个节点）`);
  },

  ungroupSelectedNodes: () => {
    const { selectedNodeIds, groups, nodes } = get();
    if (selectedNodeIds.length === 0) {
      get().showToast('请先选中节点或分组', 'error');
      return;
    }

    // Find groups that contain any selected nodes (or are themselves selected group nodes)
    const affectedGroupIds = new Set<string>();
    for (const n of nodes) {
      if (selectedNodeIds.includes(n.id) && n.parentId) affectedGroupIds.add(n.parentId);
    }
    // Also include selected group nodes themselves
    for (const id of selectedNodeIds) {
      const gn = nodes.find((n) => n.id === id);
      if (gn?.data?.groupId) affectedGroupIds.add(gn.data.groupId as string);
    }

    if (affectedGroupIds.size === 0) {
      get().showToast('选中节点未属于任何分组', 'error');
      return;
    }

    get().commitToHistory();

    const dissolvedNames: string[] = [];
    const newNodeGroups = groups.filter((g) => {
      if (affectedGroupIds.has(g.id)) {
        dissolvedNames.push(g.name);
        return false;
      }
      return true;
    });

    // Collect all child IDs of dissolved groups
    const dissolvedChildIds = new Set<string>();
    for (const gid of affectedGroupIds) {
      const gn = groups.find((g) => g.id === gid);
      if (gn) gn.nodeIds.forEach((id) => dissolvedChildIds.add(id));
    }

    // Remove parentId and convert to absolute positions
    set((state) => ({
      groups: newNodeGroups,
      nodes: state.nodes
        .filter((n) => {
          // Remove dissolved group nodes
          if (affectedGroupIds.has(n.id) && n.type === 'group') return false;
          return true;
        })
        .map((n) => {
          if (dissolvedChildIds.has(n.id) && n.parentId) {
            const pn = state.nodes.find((p) => p.id === n.parentId);
            return {
              ...n,
              parentId: undefined,
              position: {
                x: (pn ? pn.position.x : 0) + n.position.x,
                y: (pn ? pn.position.y : 0) + n.position.y,
              },
            };
          }
          return n;
        }),
    }));

    const dissolvedGroupNames = groups.filter((g) => affectedGroupIds.has(g.id)).map((g) => g.name);
    get().showToast(`已解散分组「${dissolvedGroupNames.join('、')}」`);
  },

  renameGroup: (id, name) => {
    get().commitToHistory();
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
    }));
  },
});
