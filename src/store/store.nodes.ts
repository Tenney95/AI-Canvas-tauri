/**
 * Node slice — canvas nodes / edges core state and CRUD
 */
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData, StoryboardCellOverride } from '../types';
import type { MediaGenerationIntent, MediaGenerationResult } from '../types/media';
import { generateId, getNextDisplayId } from './store.utils';
import { BATCH_NODE_LIMIT } from './store.chat';
import * as fileService from '../services/fileService';
import { playNodeExit } from '../utils/nodeAnimations';
import { cancelNodePolling } from '../services/pollManager';

interface GroupNodeDataAccess {
  groupId: string;
}

export interface NodeSlice {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  selectedNodeIds: string[];
  setNodes: (nodes: Node<BaseNodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  addNode: (node: Node<BaseNodeData>) => void;
  addNodes: (nodes: Node<BaseNodeData>[]) => void;
  addNodeWithEdge: (node: Node<BaseNodeData>, edge: Edge) => void;
  createMediaPlaceholder: (
    intent: MediaGenerationIntent,
    position?: { x: number; y: number },
  ) => string;
  settleMediaPlaceholder: (nodeId: string, artifact: MediaGenerationResult) => boolean;
  failMediaPlaceholder: (nodeId: string, error: string) => void;
  materializeMediaArtifact: (
    artifact: MediaGenerationResult,
    position?: { x: number; y: number },
  ) => string;
  /** 在原位复制一个节点（新 id / displayId，不带边）—— 用于 Ctrl 拖拽复制 */
  duplicateNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<BaseNodeData>) => void;
  deleteNode: (nodeId: string) => void;
  /** 原子批量删除多个节点（一次 commitToHistory，一次退场动画） */
  deleteNodesBatch: (nodeIds: string[]) => void;
  onConnect: (connection: Connection) => void;
  onNodesChange: (changes: NodeChange<Node<BaseNodeData>>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  clearGroupedSelection: () => void;
  settleNodeGroupingOnDragStop: (node: Node<BaseNodeData>) => void;
  /** 把一个图像节点拖入宫格分镜的某格：该格显示此图，源节点被消耗移除 */
  fillStoryboardCell: (storyboardId: string, cellIdx: number, sourceNodeId: string) => void;
}

export const createNodeSlice: StateCreator<AppState, [], [], NodeSlice> = (set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeIds: [],

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  addNode: (node) => {
    get().commitToHistory();
    set((state) => {
      const displayId = getNextDisplayId(state.nodes);
      return {
        nodes: [...state.nodes, { ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>],
      };
    });
  },

  addNodeWithEdge: (node, edge) => {
    get().commitToHistory();
    set((state) => {
      const displayId = getNextDisplayId(state.nodes);
      return {
        nodes: [...state.nodes, { ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>],
        edges: [...state.edges, edge],
      };
    });
  },

  addNodes: (nodes) => {
    if (nodes.length === 0) return;
    get().commitToHistory();
    set((state) => {
      const nextNodes = [...state.nodes];
      for (const node of nodes) {
        const displayId = getNextDisplayId(nextNodes);
        nextNodes.push({ ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>);
      }
      return { nodes: nextNodes };
    });
  },

  createMediaPlaceholder: (intent, requestedPosition) => {
    const state = get();
    const id = `node-${generateId()}`;
    const type = intent.kind === 'image' ? 'ai-image' : 'ai-video';
    const position = requestedPosition ?? state.lastCanvasMousePos ?? { x: 300, y: 200 };
    state.commitToHistory();
    set((current) => ({
      nodes: [...current.nodes, {
        id,
        type,
        position,
        data: {
          label: intent.kind === 'image' ? '对话生成图片' : '对话生成视频',
          type,
          role: 'source',
          prompt: intent.prompt,
          model: intent.modelRef,
          status: 'loading',
          nodeWidth: 280,
          nodeHeight: intent.kind === 'image' ? 158 : 160,
          ...(intent.kind === 'image' ? { aspectRatio: '1:1', imageSize: '2K' } : {}),
          displayId: getNextDisplayId(current.nodes),
        },
      } as Node<BaseNodeData>],
    }));
    return id;
  },

  settleMediaPlaceholder: (nodeId, artifact) => {
    if (!get().nodes.some((node) => node.id === nodeId)) return false;
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const mediaField = artifact.kind === 'image'
          ? { imageUrl: artifact.url, imageWidth: artifact.width, imageHeight: artifact.height }
          : { videoUrl: artifact.url };
        return {
          ...node,
          data: {
            ...node.data,
            ...mediaField,
            artifactId: artifact.id,
            prompt: artifact.prompt,
            model: artifact.modelId,
            provider: artifact.provider,
            output: artifact.sourceUrl,
            sourceUrl: artifact.sourceUrl,
            filePath: artifact.filePath,
            thumbnailUrl: artifact.kind === 'image' ? artifact.url : undefined,
            status: 'success',
            error: undefined,
          },
        } as Node<BaseNodeData>;
      }),
    }));
    return true;
  },

  failMediaPlaceholder: (nodeId, error) => {
    set((state) => ({
      nodes: state.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'error', error } as BaseNodeData }
        : node),
    }));
  },

  materializeMediaArtifact: (artifact, requestedPosition) => {
    const state = get();
    const existing = state.nodes.find((node) => node.data.artifactId === artifact.id);
    if (existing) return existing.id;

    const id = `node-${generateId()}`;
    const type = artifact.kind === 'image' ? 'ai-image' : 'ai-video';
    const position = requestedPosition ?? state.lastCanvasMousePos ?? { x: 300, y: 200 };
    const mediaField = artifact.kind === 'image'
      ? { imageUrl: artifact.url, imageWidth: artifact.width, imageHeight: artifact.height }
      : { videoUrl: artifact.url };
    state.commitToHistory();
    set((current) => ({
      nodes: [...current.nodes, {
        id,
        type,
        position,
        data: {
          label: artifact.kind === 'image' ? '对话生成图片' : '对话生成视频',
          type,
          role: 'source',
          artifactId: artifact.id,
          prompt: artifact.prompt,
          model: artifact.modelId,
          provider: artifact.provider,
          output: artifact.sourceUrl,
          sourceUrl: artifact.sourceUrl,
          filePath: artifact.filePath,
          thumbnailUrl: artifact.kind === 'image' ? artifact.url : undefined,
          status: 'success',
          nodeWidth: 280,
          nodeHeight: artifact.kind === 'image' ? 158 : 160,
          ...mediaField,
          displayId: getNextDisplayId(current.nodes),
        },
      } as Node<BaseNodeData>],
    }));
    return id;
  },

  updateNodeData: (nodeId, data) => {
    get().commitToHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } as BaseNodeData } : n
      ),
    }));
  },

  duplicateNode: (nodeId) => {
    const state = get();
    const src = state.nodes.find((n) => n.id === nodeId);
    // 分组节点暂不支持拖拽复制（涉及子节点/边重映射）
    if (!src || src.type === 'group') return;
    state.commitToHistory();

    // 身份对调：克隆留在原位，承接原节点的边与编号（= 不动的「原始」）；
    // 被拖动的那个节点改成新编号、断开所有边（= 拖出去的干净副本）。
    const cloneId = `node-${generateId()}`;
    const newDisplayId = getNextDisplayId(state.nodes);

    set((s) => {
      const clone = {
        ...src,
        id: cloneId,
        position: { ...src.position },
        selected: false,
        dragging: false,
      } as Node<BaseNodeData>;
      const nodes = s.nodes.map((n) =>
        n.id === nodeId
          ? ({ ...n, data: { ...n.data, displayId: newDisplayId } } as Node<BaseNodeData>)
          : n,
      );
      nodes.push(clone);
      // 原本指向被拖节点的边改指向克隆（边留在原位）
      const edges = s.edges.map((e) =>
        e.source === nodeId || e.target === nodeId
          ? { ...e, source: e.source === nodeId ? cloneId : e.source, target: e.target === nodeId ? cloneId : e.target }
          : e,
      );
      return { nodes, edges };
    });
  },

  deleteNode: (nodeId) => {
    get().commitToHistory();

    // Collect all node IDs to delete: self + descendants (for group nodes)
    const idsToDelete = new Set<string>([nodeId]);
    const { nodes } = get();
    const q = [nodeId];
    while (q.length > 0) {
      const pid = q.shift()!;
      nodes.filter((n) => n.parentId === pid).forEach((c) => {
        idsToDelete.add(c.id);
        q.push(c.id);
      });
    }

    // Cancel any active polling for all deleted nodes
    for (const id of idsToDelete) {
      cancelNodePolling(id);
    }

    // Delete local files for all affected nodes —— 跳过仍被存活节点引用的共享文件（复制节点场景）
    const keepPaths = new Set(
      nodes.filter((n) => !idsToDelete.has(n.id))
        .map((n) => (n.data as BaseNodeData).filePath)
        .filter((p): p is string => !!p),
    );
    for (const message of get().messages) {
      if (message.mediaResult?.filePath) keepPaths.add(message.mediaResult.filePath);
    }
    for (const id of idsToDelete) {
      const n = nodes.find((nn) => nn.id === id);
      if (n && !n.data.artifactId) {
        fileService.deleteNodeFile(n.data as BaseNodeData, keepPaths).catch((e) => console.warn('[删除节点] 文件清理失败:', e));
      }
    }

    // 先播放退场动画，结束后再真正从状态中移除（动画期间历史已提交，撤销仍指向删除前状态）
    playNodeExit([...idsToDelete]).then(() => {
      set((state) => ({
        nodes: state.nodes.filter((n) => !idsToDelete.has(n.id)),
        edges: state.edges.filter((e) => !idsToDelete.has(e.source) && !idsToDelete.has(e.target)),
        groups: state.groups
          .filter((g) => !idsToDelete.has(g.id))
          .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((nid) => !idsToDelete.has(nid)) })),
      }));
    });
  },

  deleteNodesBatch: (nodeIds) => {
    if (nodeIds.length === 0) return;
    // 最多删 BATCH_NODE_LIMIT 个
    const limitedIds = nodeIds.length > BATCH_NODE_LIMIT ? nodeIds.slice(0, BATCH_NODE_LIMIT) : nodeIds;

    get().commitToHistory();

    // 收集所有要删除的 ID（包含子节点递归）
    const idsToDelete = new Set<string>(limitedIds);
    const { nodes } = get();
    const q = [...limitedIds];
    while (q.length > 0) {
      const pid = q.shift()!;
      nodes.filter((n) => n.parentId === pid).forEach((c) => {
        idsToDelete.add(c.id);
        q.push(c.id);
      });
    }

    // 取消所有轮询
    for (const id of idsToDelete) {
      cancelNodePolling(id);
    }

    // 清理文件
    const keepPaths = new Set(
      nodes.filter((n) => !idsToDelete.has(n.id))
        .map((n) => (n.data as BaseNodeData).filePath)
        .filter((p): p is string => !!p),
    );
    for (const message of get().messages) {
      if (message.mediaResult?.filePath) keepPaths.add(message.mediaResult.filePath);
    }
    for (const id of idsToDelete) {
      const n = nodes.find((nn) => nn.id === id);
      if (n && !n.data.artifactId) {
        fileService.deleteNodeFile(n.data as BaseNodeData, keepPaths).catch((e) => console.warn('[批量删除] 文件清理失败:', e));
      }
    }

    // 统一播放退场动画后移除
    playNodeExit([...idsToDelete]).then(() => {
      set((state) => ({
        nodes: state.nodes.filter((n) => !idsToDelete.has(n.id)),
        edges: state.edges.filter((e) => !idsToDelete.has(e.source) && !idsToDelete.has(e.target)),
        groups: state.groups
          .filter((g) => !idsToDelete.has(g.id))
          .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((nid) => !idsToDelete.has(nid)) })),
      }));
    });
  },

  fillStoryboardCell: (storyboardId, cellIdx, sourceNodeId) => {
    const { nodes } = get();
    const sb = nodes.find((n) => n.id === storyboardId && n.type === 'ai-storyboard');
    const src = nodes.find((n) => n.id === sourceNodeId);
    if (!sb || !src || src.type !== 'ai-image') return;
    const url = (src.data.imageUrl || src.data.thumbnailUrl) as string | undefined;
    if (!url) return;

    get().commitToHistory();

    const cols = (sb.data.storyboardCols as number) || 3;
    const rows = (sb.data.storyboardRows as number) || 3;
    const total = cols * rows;
    const overrides: (StoryboardCellOverride | null)[] = Array.isArray(sb.data.storyboardOverrides)
      ? [...(sb.data.storyboardOverrides as (StoryboardCellOverride | null)[])]
      : new Array(total).fill(null);
    const extracted = Array.isArray(sb.data.storyboardExtracted)
      ? [...(sb.data.storyboardExtracted as boolean[])]
      : new Array(total).fill(false);
    while (overrides.length < total) overrides.push(null);
    while (extracted.length < total) extracted.push(false);
    overrides[cellIdx] = { url, filePath: (src.data.filePath as string) || undefined };
    extracted[cellIdx] = false;
    get().updateNodeData(storyboardId, {
      storyboardOverrides: overrides,
      storyboardExtracted: extracted,
    } as Partial<BaseNodeData>);

    // 直接移除源节点，不走 deleteNode —— 避免回收正被该格复用的图片文件
    cancelNodePolling(sourceNodeId);
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== sourceNodeId),
      edges: state.edges.filter((e) => e.source !== sourceNodeId && e.target !== sourceNodeId),
    }));
    get().showToast('已放入宫格');
  },

  onConnect: (connection) => {
    get().commitToHistory();
    const id = `edge-${generateId()}`;
    const edge: Edge = {
      id,
      source: connection.source!,
      target: connection.target!,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    };
    set((state) => ({ edges: [...state.edges, edge] }));
  },

  onNodesChange: (changes) => {
    const removedIds = changes
      .filter((c) => c.type === 'remove')
      .map((c) => c.id);

    // Cancel any active polling for removed nodes
    for (const id of removedIds) {
      cancelNodePolling(id);
    }

    if (removedIds.length === 0) {
      set((s) => ({
        nodes: applyNodeChanges(changes, s.nodes) as Node<BaseNodeData>[],
      }));
      return;
    }

    const state = get();
    const removedGroupNodes = state.nodes.filter(
      (n) => removedIds.includes(n.id) && n.type === 'group',
    );

    if (removedGroupNodes.length > 0) {
      state.commitToHistory();
      const groupNodeIdSet = new Set(removedGroupNodes.map((n) => n.id));
      const removedGroupDataIds = removedGroupNodes.map(
        (n) => (n.data as unknown as GroupNodeDataAccess).groupId,
      );

      const groupPositions = new Map(
        removedGroupNodes.map((gn) => [gn.id, gn.position]),
      );

      const repositioned = state.nodes
        .map((n) => {
          if (!n.parentId || !groupPositions.has(n.parentId)) return n;
          const gp = groupPositions.get(n.parentId)!;
          return {
            ...n,
            position: { x: n.position.x + gp.x, y: n.position.y + gp.y },
            parentId: undefined,
          };
        })
        .filter((n) => !groupNodeIdSet.has(n.id));

      const finalNodes = applyNodeChanges(
        changes.filter((c) => c.type !== 'remove' || !groupNodeIdSet.has(c.id)),
        repositioned,
      ) as Node<BaseNodeData>[];

      set((s) => ({
        nodes: finalNodes,
        edges: s.edges.filter(
          (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target),
        ),
        groups: s.groups.filter((g) => !removedGroupDataIds.includes(g.id)),
      }));
      return;
    }

    state.commitToHistory();
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes) as Node<BaseNodeData>[],
      edges: s.edges.filter(
        (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target),
      ),
    }));
  },

  onEdgesChange: (changes) => {
    const hasRemoval = changes.some((c) => c.type === 'remove');
    if (hasRemoval) get().commitToHistory();
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges) as Edge[],
    }));
  },

  clearGroupedSelection: () => {
    set((s) => {
      if (!s.nodes.some((n) => n.selected && n.type !== 'group')) return {};
      let changed = false;
      const nodes = s.nodes.map((n) => {
        if (n.type === 'group' && n.selected) {
          changed = true;
          return { ...n, selected: false };
        }
        return n;
      });
      return changed ? { nodes } : {};
    });
  },

  settleNodeGroupingOnDragStop: (node) => {
    const state = get();
    const allNodes = state.nodes;

    if (node.type === 'group') return;

    const absPos = { x: node.position.x, y: node.position.y };
    let pid = node.parentId;
    while (pid) {
      const p = allNodes.find((n) => n.id === pid);
      if (!p) break;
      absPos.x += p.position.x;
      absPos.y += p.position.y;
      pid = p.parentId;
    }

    const nodeWidth = (node.data?.nodeWidth as number) || node.measured?.width || 280;
    const nodeHeight = (node.data?.nodeHeight as number) || node.measured?.height || 160;
    const nodeCenter = {
      x: absPos.x + nodeWidth / 2,
      y: absPos.y + nodeHeight / 2,
    };

    const groupNodes = allNodes.filter((n) => n.type === 'group');
    let newNodes = allNodes.map((n) => ({ ...n, position: { ...n.position } }));
    let newGroups = [...state.groups];
    let changed = false;

    if (node.parentId) {
      const parentNode = groupNodes.find((g) => g.id === node.parentId);
      if (parentNode) {
        const pw = (parentNode.style?.width as number) || 400;
        const ph = (parentNode.style?.height as number) || 300;
        const inside =
          nodeCenter.x >= parentNode.position.x &&
          nodeCenter.x <= parentNode.position.x + pw &&
          nodeCenter.y >= parentNode.position.y &&
          nodeCenter.y <= parentNode.position.y + ph;
        if (!inside) {
          newNodes = newNodes.map((n) => {
            if (n.id !== node.id) return n;
            return { ...n, position: absPos, parentId: undefined };
          });
          const gId = (parentNode.data as unknown as GroupNodeDataAccess).groupId;
          newGroups = newGroups.map((g) =>
            g.id === gId
              ? { ...g, nodeIds: g.nodeIds.filter((id) => id !== node.id) }
              : g,
          );
          changed = true;
        }
      }
    }

    const updatedNode = newNodes.find((n) => n.id === node.id);
    if (updatedNode && !updatedNode.parentId) {
      for (const gn of groupNodes) {
        const pw = (gn.style?.width as number) || 400;
        const ph = (gn.style?.height as number) || 300;
        if (
          nodeCenter.x >= gn.position.x &&
          nodeCenter.x <= gn.position.x + pw &&
          nodeCenter.y >= gn.position.y &&
          nodeCenter.y <= gn.position.y + ph
        ) {
          newNodes = newNodes.map((n) => {
            if (n.id !== node.id) return n;
            return {
              ...n,
              position: {
                x: absPos.x - gn.position.x,
                y: absPos.y - gn.position.y,
              },
              parentId: gn.id,
            };
          });
          const gId = (gn.data as unknown as GroupNodeDataAccess).groupId;
          newGroups = newGroups.map((g) =>
            g.id === gId
              ? { ...g, nodeIds: [...new Set([...g.nodeIds, node.id])] }
              : g,
          );
          changed = true;
          break;
        }
      }
    }

    if (!changed) return;

    const emptyGroupIds = new Set(
      groupNodes
        .filter((gn) => newNodes.filter((n) => n.parentId === gn.id).length === 0)
        .map((gn) => gn.id),
    );
    if (emptyGroupIds.size > 0) {
      newNodes = newNodes.filter((n) => !emptyGroupIds.has(n.id));
      const emptyDataIds = new Set(
        groupNodes
          .filter((gn) => emptyGroupIds.has(gn.id))
          .map((gn) => (gn.data as unknown as GroupNodeDataAccess).groupId)
          .filter(Boolean),
      );
      newGroups = newGroups.filter((g) => !emptyDataIds.has(g.id));
    }

    state.commitToHistory();
    set({ nodes: newNodes, groups: newGroups });
  },
});
