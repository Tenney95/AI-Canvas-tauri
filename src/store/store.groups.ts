/**
 * Group slice — visual node grouping on canvas
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData, NodeGroup, StoryboardCellOverride } from '../types';
import { GROUP_COLOR_PALETTE } from '../types';
import { generateId } from './store.utils';
import {
  ensureGroupFolder,
  getAssetUrlFromPath,
  getProjectDataDir,
  moveProjectFileToFolder,
  renameGroupFolder,
  sanitizeFolderName,
} from '../services/fileService';

export interface GroupSlice {
  groups: NodeGroup[];
  groupSelectedNodes: () => void;
  ungroupSelectedNodes: () => void;
  renameGroup: (id: string, name: string) => void;
  /** 在画布上直接创建一个空文件夹（折叠态分组），拖节点进去即入组 */
  createEmptyGroup: (position: { x: number; y: number }) => void;
  /** 折叠/展开分组：折叠后收成文件夹卡片，组内节点与其连线不再渲染 */
  toggleGroupCollapsed: (groupId: string) => void;
  setGroupColor: (groupId: string, color: string) => void;
  /** 把节点文件搬到所属分组的文件夹（未分组则搬回项目根目录），由自动保存驱动 */
  syncGroupFiles: () => Promise<void>;
}

/** 一次移动的结果：新路径 + 重建的展示 URL + 项目内相对路径 */
interface MovedFile {
  filePath: string;
  assetUrl: string;
  relativePath: string;
}

async function describeFile(filePath: string, folder: string | null): Promise<MovedFile> {
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return {
    filePath,
    assetUrl: await getAssetUrlFromPath(filePath),
    relativePath: folder ? `${folder}/${fileName}` : fileName,
  };
}

async function moveFile(
  filePath: string | undefined,
  projectDir: string,
  folder: string | null,
): Promise<MovedFile | null> {
  const moved = await moveProjectFileToFolder(filePath, projectDir, folder);
  return moved ? describeFile(moved, folder) : null;
}

/** 文件夹整体改名后，把仍指向旧文件夹的路径改写到新文件夹（文件本身已随文件夹一起搬走） */
function repointToRenamedFolder(
  filePath: string | undefined,
  oldPrefix: string,
  newPrefix: string,
): string | null {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith(oldPrefix) ? newPrefix + normalized.slice(oldPrefix.length) : null;
}

/** 把移动结果回填到节点数据；期间 filePath 已被改写时保持原样（新文件由下一轮搬运） */
function applyNodeMove(data: BaseNodeData, expectedPath: string | undefined, moved: MovedFile): BaseNodeData {
  if (data.filePath !== expectedPath) return data;
  const next: BaseNodeData = { ...data, filePath: moved.filePath, relativePath: moved.relativePath };
  if (next.thumbnailUrl && next.thumbnailUrl === next.imageUrl) next.thumbnailUrl = moved.assetUrl;
  if (next.imageUrl) next.imageUrl = moved.assetUrl;
  if (next.videoUrl) next.videoUrl = moved.assetUrl;
  if (next.audioUrl) next.audioUrl = moved.assetUrl;
  return next;
}

function applyOverrideMove(
  override: StoryboardCellOverride,
  expectedPath: string | undefined,
  moved: MovedFile,
): StoryboardCellOverride {
  if (override.filePath !== expectedPath) return override;
  return { ...override, filePath: moved.filePath, relativePath: moved.relativePath, url: moved.assetUrl };
}

/** 折叠后的文件夹卡片尺寸 */
export const COLLAPSED_GROUP_SIZE = { width: 220, height: 152 };

// 自动保存每 2 秒可能触发一次，重入会让同一个文件被搬两次
let syncingGroupFiles = false;

export const createGroupSlice: StateCreator<AppState, [], [], GroupSlice> = (set, get) => {
  /**
   * 分组文件夹整体改名后，把节点里仍指向旧文件夹的路径改写过去。
   * 不做则所有 filePath 立刻失效：搬运找不到源文件，保存时 stat 直接抛错。
   */
  const repointGroupPaths = async (projectId: string, oldName: string, newName: string) => {
    const oldFolder = sanitizeFolderName(oldName);
    const newFolder = sanitizeFolderName(newName);
    if (oldFolder === newFolder) return;
    const projectDir = await getProjectDataDir(projectId);
    if (!projectDir || get().currentProjectId !== projectId) return;

    const root = projectDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const oldPrefix = `${root}/${oldFolder}/`;
    const newPrefix = `${root}/${newFolder}/`;

    // getAssetUrlFromPath 是异步的，先把改写计划算好，再一次性回填
    const patches: { nodeId: string; index: number | null; oldPath: string; moved: MovedFile }[] = [];
    for (const node of get().nodes) {
      const data = node.data as BaseNodeData;
      const repointed = repointToRenamedFolder(data.filePath, oldPrefix, newPrefix);
      if (repointed) {
        patches.push({ nodeId: node.id, index: null, oldPath: data.filePath!, moved: await describeFile(repointed, newFolder) });
      }
      const overrides = data.storyboardOverrides;
      if (!Array.isArray(overrides)) continue;
      for (let i = 0; i < overrides.length; i++) {
        const cellPath = repointToRenamedFolder(overrides[i]?.filePath, oldPrefix, newPrefix);
        if (cellPath) {
          patches.push({ nodeId: node.id, index: i, oldPath: overrides[i]!.filePath!, moved: await describeFile(cellPath, newFolder) });
        }
      }
    }
    if (patches.length === 0) return;

    set((s) => ({
      nodes: s.nodes.map((n) => {
        const own = patches.filter((p) => p.nodeId === n.id);
        if (own.length === 0) return n;
        let data = n.data as BaseNodeData;
        for (const patch of own) {
          if (patch.index === null) {
            data = applyNodeMove(data, patch.oldPath, patch.moved);
            continue;
          }
          const list = data.storyboardOverrides;
          if (!Array.isArray(list) || !list[patch.index]) continue;
          const next = [...list];
          next[patch.index] = applyOverrideMove(list[patch.index]!, patch.oldPath, patch.moved);
          if (next[patch.index] !== list[patch.index]) data = { ...data, storyboardOverrides: next };
        }
        return data === n.data ? n : { ...n, data };
      }),
    }));
  };

  return {
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

    // 分组名同时也是本地文件夹名，重名会撞同一个文件夹，所以创建时就去重
    let groupName = '分组';
    for (let i = 2; groups.some((g) => g.name === groupName); i++) groupName = `分组 ${i}`;

    const groupId = `group-${generateId()}`;
    const newGroup: NodeGroup = {
      id: groupId,
      name: groupName,
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

    void ensureGroupFolder(get().currentProjectId, newGroup.name);

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

  createEmptyGroup: (position) => {
    const { groups } = get();
    const usedColors = new Set(groups.map((g) => g.color));
    const color = GROUP_COLOR_PALETTE.find((c) => !usedColors.has(c)) || GROUP_COLOR_PALETTE[0];
    let groupName = '分组';
    for (let i = 2; groups.some((g) => g.name === groupName); i++) groupName = `分组 ${i}`;
    const groupId = `group-${generateId()}`;

    get().commitToHistory();
    set((state) => ({
      groups: [...state.groups, { id: groupId, name: groupName, nodeIds: [], color, createdAt: Date.now() }],
      // 分组节点必须排在子节点之前（xyflow 要求）
      nodes: [
        {
          id: groupId,
          type: 'group' as const,
          position,
          data: { label: groupName, type: 'comment' as const, groupId, color, groupCollapsed: true },
          style: { ...COLLAPSED_GROUP_SIZE },
          ...COLLAPSED_GROUP_SIZE,
        },
        ...state.nodes,
      ],
    }));

    void ensureGroupFolder(get().currentProjectId, groupName);
    get().showToast(`已创建「${groupName}」`);
  },

  toggleGroupCollapsed: (groupId) => {
    const groupNode = get().nodes.find((n) => n.id === groupId && n.type === 'group');
    if (!groupNode) return;
    const collapsed = groupNode.data.groupCollapsed === true;
    const childIds = new Set(get().nodes.filter((n) => n.parentId === groupId).map((n) => n.id));
    const expanded = groupNode.data.groupExpandedSize;
    const currentSize = {
      width: Number(groupNode.width ?? groupNode.style?.width ?? groupNode.measured?.width) || 320,
      height: Number(groupNode.height ?? groupNode.style?.height ?? groupNode.measured?.height) || 200,
    };
    const nextSize = collapsed ? expanded ?? currentSize : COLLAPSED_GROUP_SIZE;

    get().commitToHistory();
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== groupId) {
          // 折叠后组内节点看不见了，不能继续留在选区里
          return collapsed || !childIds.has(n.id) || !n.selected ? n : { ...n, selected: false };
        }
        return {
          ...n,
          width: nextSize.width,
          height: nextSize.height,
          style: { ...n.style, ...nextSize },
          data: {
            ...n.data,
            groupCollapsed: collapsed ? undefined : true,
            groupExpandedSize: collapsed ? expanded : currentSize,
          },
        };
      }),
      selectedNodeIds: collapsed
        ? state.selectedNodeIds
        : state.selectedNodeIds.filter((id) => !childIds.has(id)),
    }));
  },

  setGroupColor: (groupId, color) => {
    if (!get().groups.some((g) => g.id === groupId)) return;
    get().commitToHistory();
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, color } : g)),
      nodes: state.nodes.map((n) => (n.id === groupId
        ? { ...n, data: { ...n.data, color } }
        : n)),
    }));
  },

  renameGroup: (id, name) => {
    const oldName = get().groups.find((g) => g.id === id)?.name;
    if (!oldName || oldName === name) return;

    get().commitToHistory();
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
      // 分组节点的 label 是显示与持久化的来源，一并改掉
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, label: name } } : n)),
    }));

    const projectId = get().currentProjectId;
    void renameGroupFolder(projectId, oldName, name).then((ok) => {
      if (!ok) {
        get().showToast(`分组文件夹「${name}」已存在，未同步改名`, 'error');
        return;
      }
      if (projectId) return repointGroupPaths(projectId, oldName, name);
    });
  },

  syncGroupFiles: async () => {
    if (syncingGroupFiles) return;
    const projectId = get().currentProjectId;
    if (!projectId) return;
    const projectDir = await getProjectDataDir(projectId);
    if (!projectDir) return;

    syncingGroupFiles = true;
    try {
      const { nodes, groups } = get();
      const folderOfGroup = new Map(groups.map((g) => [g.id, sanitizeFolderName(g.name)]));

      for (const node of nodes) {
        if (node.type === 'group') continue;
        if (get().currentProjectId !== projectId) return;   // 项目已切换，停手
        const folder = node.parentId ? folderOfGroup.get(node.parentId) ?? null : null;
        const data = node.data as BaseNodeData;

        const moved = await moveFile(data.filePath, projectDir, folder);
        if (moved) {
          set((s) => ({
            nodes: s.nodes.map((n) => (
              n.id === node.id ? { ...n, data: applyNodeMove(n.data as BaseNodeData, data.filePath, moved) } : n
            )),
          }));
        }

        const overrides = data.storyboardOverrides;
        if (!Array.isArray(overrides)) continue;
        for (let i = 0; i < overrides.length; i++) {
          const override = overrides[i];
          const movedCell = override ? await moveFile(override.filePath, projectDir, folder) : null;
          if (!movedCell) continue;
          set((s) => ({
            nodes: s.nodes.map((n) => {
              if (n.id !== node.id) return n;
              const current = (n.data as BaseNodeData).storyboardOverrides;
              if (!Array.isArray(current) || !current[i]) return n;
              const next = [...current];
              next[i] = applyOverrideMove(current[i]!, override!.filePath, movedCell);
              return { ...n, data: { ...(n.data as BaseNodeData), storyboardOverrides: next } };
            }),
          }));
        }
      }
    } finally {
      syncingGroupFiles = false;
    }
  },
  };
};
