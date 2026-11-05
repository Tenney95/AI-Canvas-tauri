/**
 * Group slice — visual node grouping on canvas
 */
import { t } from '../i18n';

import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { NodeGroup } from '../types';
import { GROUP_COLOR_PALETTE } from '../types';
import { generateId } from './store.utils';
import { layoutEpisodeShots } from '../utils/episodeLayout';
import { getNodeSize } from '../utils/nodeBounds';
import { isNodeMediaCopySource } from '../services/nodeMediaCopy';
import { persistMissingNodeTextFiles } from '../services/nodeTextFilePersistence';
import { registerCanvasImport, isCanvasDerivationFresh, completeCanvasDerivation, type CanvasDerivationGuard } from '../services/canvasDerivationGuard';
import { persistMediaRelocation, pendingMediaRelocations, completeMediaRelocation,
  relocateMediaReferences, relocateOwnedMediaReferences, type MediaRelocation } from '../services/indexedDb/mediaRelocations';
import {
  ensureGroupFolder,
  getAssetUrlFromPath,
  getProjectDataDir,
  moveProjectFileToFolder,
  finishProjectFileRelocation,
  removeEmptyProjectGroupFolder,
  sanitizeFolderName,
  stripVerbatimPrefix,
} from '../services/fileService';

export interface GroupSlice {
  groups: NodeGroup[];
  layoutEpisodeGroups: (selectedOnly?: boolean, columns?: number) => string[];
  groupSelectedNodes: () => void;
  ungroupSelectedNodes: () => void;
  renameGroup: (id: string, name: string) => void;
  /** 在画布上直接创建一个空文件夹（折叠态分组），拖节点进去即入组 */
  createEmptyGroup: (position: { x: number; y: number }) => void;
  /** 折叠/展开分组：不进入撤销历史；折叠后收成文件夹卡片，组内节点与其连线不再渲染 */
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
  forceCopy = false,
  isFresh = () => true,
): Promise<MovedFile | null> {
  const moved = await moveProjectFileToFolder(filePath, projectDir, folder, { preserveSource: true, forceCopy });
  if (!isFresh()) return null;
  return moved ? describeFile(moved, folder) : null;
}

/** 折叠后的文件夹卡片尺寸 */
export const COLLAPSED_GROUP_SIZE = { width: 220, height: 152 };

// 自动保存每 2 秒可能触发一次，重入会让同一个文件被搬两次
let syncingGroupFiles = false;
let queuedGroupSync: (() => Promise<void>) | null = null;
const retiredFolders = new Map<string, Set<string>>();
function retireFolders(projectId: string | null, names: string[]) {
  if (projectId) retiredFolders.set(projectId, new Set([...(retiredFolders.get(projectId) ?? []), ...names]));
}

/** 正文、参数和画布位置不影响归档；只记录实际参与搬运和共享判断的字段。 */
function groupFilesSignature(state: Pick<AppState, 'nodes' | 'groups'>): string {
  return JSON.stringify([
    state.groups.map((group) => [group.id, sanitizeFolderName(group.name)]),
    state.nodes.map((node) => [node.id, node.type, node.parentId, node.data.filePath,
      node.data.storyboardOverrides?.map((cell) => cell?.filePath), node.data.directorCaptureFilePaths]),
  ]);
}

async function relocateGroupedFiles(projectId: string, projectDir: string, guard: CanvasDerivationGuard,
  set: Parameters<StateCreator<AppState>>[0], get: () => AppState,
  pending: MediaRelocation[], scanFiles: boolean): Promise<boolean> {
  const fresh = () => isCanvasDerivationFresh(guard, get());
  let expectedSignature = groupFilesSignature(get());
  const inputsFresh = () => {
    if (get().currentProjectId !== projectId) return false;
    if (groupFilesSignature(get()) !== expectedSignature) {
      queuedGroupSync = get().syncGroupFiles;
      return false;
    }
    return fresh();
  };
  const key = (value: string) => value.replace(/\\/g, '/');
  let indexedNodes: AppState['nodes'] | undefined;
  let indexedGroups: AppState['groups'] | undefined;
  let nodeById = new Map<string, AppState['nodes'][number]>();
  let folderByGroupId = new Map<string, string>();
  let ownersByPath = new Map<string, Set<string>>();
  const index = () => {
    const state = get();
    if (indexedNodes === state.nodes && indexedGroups === state.groups) return;
    indexedNodes = state.nodes;
    indexedGroups = state.groups;
    nodeById = new Map(state.nodes.map((node) => [node.id, node]));
    folderByGroupId = new Map(state.groups.map((group) => [group.id, sanitizeFolderName(group.name)]));
    ownersByPath = new Map();
    for (const node of state.nodes) {
      for (const path of [node.data.filePath, ...(node.data.storyboardOverrides ?? []).map((cell) => cell?.filePath),
        ...(node.data.directorCaptureFilePaths ?? [])]) {
        if (!path) continue;
        const normalized = key(path);
        let owners = ownersByPath.get(normalized);
        if (!owners) { owners = new Set(); ownersByPath.set(normalized, owners); }
        owners.add(node.id);
      }
    }
  };
  const finish = async (move: MediaRelocation) => {
    if (!inputsFresh() || isNodeMediaCopySource(move.oldPath)) return false;
    if (!move.ownerId) {
      index();
      if (ownersByPath.has(key(move.oldPath))) return false;
      await finishProjectFileRelocation(move.oldPath, move.newPath, projectDir);
      if (!inputsFresh()) return false;
    }
    await completeMediaRelocation(move);
    return inputsFresh();
  };
  if (!inputsFresh()) return false;
  if (pending.length) {
    set((state) => pending.reduce((current, move) => move.ownerId
      ? relocateOwnedMediaReferences(current, move, move.ownerId) : relocateMediaReferences(current, [move]), state));
    expectedSignature = groupFilesSignature(get());
    if (await get().saveCurrentProjectSilent() !== projectId || !inputsFresh()) return false;
    for (const move of pending) if (!await finish(move)) return false;
  }
  if (!scanFiles) return inputsFresh();
  index();
  const nodeIds = [...nodeById.values()].filter((node) => node.type !== 'group').map((node) => node.id);
  const root = stripVerbatimPrefix(projectDir).replace(/\\/g, '/').replace(/\/+$/, '');
  let complete = true;
  for (const nodeId of nodeIds) {
    index();
    const initial = nodeById.get(nodeId);
    if (!initial || !fresh()) return false;
    const slots = [null, ...(initial.data.storyboardOverrides ?? []).map((_, index) => index)];
    for (const slot of slots) {
      if (!fresh()) return false;
      index();
      const node = nodeById.get(nodeId);
      if (!node) break;
      const path = slot === null ? node.data.filePath : node.data.storyboardOverrides?.[slot]?.filePath;
      if (!path) continue;
      if (isNodeMediaCopySource(path)) { complete = false; continue; }
      // Shared legacy nodes split first. The last owner performs the actual relocation.
      const shared = (ownersByPath.get(key(path))?.size ?? 0) > 1;
      const folder = node.parentId ? folderByGroupId.get(node.parentId) ?? null : null;
      const normalized = key(stripVerbatimPrefix(path));
      if (!normalized.startsWith(`${root}/`)) continue;
      const segments = normalized.slice(root.length + 1).split('/');
      const currentFolder = segments.length > 1 ? segments.slice(0, -1).join('/') : null;
      if (segments.some((part) => !part || part.startsWith('.')
        || /^(?:appdata|agent-private|plugin-private|blender-private|secrets)$/i.test(part))
        || (!folder && segments.length > 2)
        || (currentFolder === folder && !shared)) continue;
      const moved = await moveFile(path, projectDir, folder, shared, inputsFresh);
      if (!inputsFresh()) return false;
      if (!moved) { complete = false; continue; }
      const oldAssetUrl = await getAssetUrlFromPath(path);
      if (!inputsFresh()) return false;
      const move: MediaRelocation = { oldPath: path, newPath: moved.filePath, assetUrl: moved.assetUrl,
        relativePath: moved.relativePath, projectId, ownerId: shared ? nodeId : undefined, oldAssetUrl };
      await persistMediaRelocation(move, shared ? nodeId : undefined);
      if (!inputsFresh()) return false; // 已落盘的迁移留待下次打开项目恢复。
      set((state) => shared ? relocateOwnedMediaReferences(state, move, nodeId) : relocateMediaReferences(state, [move]));
      expectedSignature = groupFilesSignature(get());
      if (await get().saveCurrentProjectSilent() !== projectId || !inputsFresh()) return false;
      if (!await finish(move)) return false;
    }
  }
  return complete && inputsFresh();
}

export const createGroupSlice: StateCreator<AppState, [], [], GroupSlice> = (set, get) => {
  let syncedSignature: { projectId: string; signature: string } | undefined;
  return {
  groups: [],

  layoutEpisodeGroups: (selectedOnly = false, columns = 3) => {
    const state = get();
    const result = layoutEpisodeShots(state.nodes, selectedOnly ? state.selectedNodeIds : undefined, columns);
    if (!result.groupIds.length) {
      get().showToast('没有可整理的镜头组，请先将每镜素材放入独立 SH 镜头组并展开', 'error');
      return [];
    }
    get().commitToHistory();
    set({ nodes: result.nodes });
    get().showToast(t('已统一 {count} 个镜头组布局，可撤销{skipped}', { count: result.groupIds.length, skipped: result.skipped ? t('；跳过 {count} 个折叠或嵌套组', { count: result.skipped }) : '' }));
    return result.groupIds;
  },

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
      const size = getNodeSize(n);
      const right = rx + size.width;
      const bottom = ry + size.height;
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

    get().showToast(t('已创建「{name}」（{count} 个节点）', { name: newGroup.name, count: candidateIds.length }));
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

    retireFolders(get().currentProjectId, dissolvedNames);
    const dissolvedGroupNames = groups.filter((g) => affectedGroupIds.has(g.id)).map((g) => g.name);
    get().showToast(t('已解散分组「{name}」', { name: dissolvedGroupNames.join('、') }));
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
    get().showToast(t('已创建「{name}」', { name: groupName }));
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

    // 开合只改变浏览状态，不创建历史记录或截断重做分支。
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
    if (get().groups.some((group) => group.id !== id && sanitizeFolderName(group.name) === sanitizeFolderName(name))) {
      get().showToast('分组名称已存在', 'error');
      return;
    }

    get().commitToHistory();
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
      // 分组节点的 label 是显示与持久化的来源，一并改掉
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, label: name } } : n)),
    }));

    const projectId = get().currentProjectId;
    retireFolders(projectId, [oldName]);
    // 逐文件提交引用迁移，完成后只清理空目录。
    void ensureGroupFolder(projectId, name).then(() => {
      if (get().currentProjectId === projectId) return get().syncGroupFiles();
    });
  },

  syncGroupFiles: async () => {
    if (syncingGroupFiles) {
      queuedGroupSync = get().syncGroupFiles;
      return;
    }
    const projectId = get().currentProjectId;
    if (!projectId) return;
    const guard = registerCanvasImport(get());
    if (!guard) return;
    let initialSignature = groupFilesSignature(get());
    const fresh = () => {
      if (get().currentProjectId !== projectId) return false;
      if (groupFilesSignature(get()) !== initialSignature) {
        queuedGroupSync = get().syncGroupFiles;
        return false;
      }
      return isCanvasDerivationFresh(guard, get());
    };
    syncingGroupFiles = true;
    try {
      // MCP 和历史节点可只有正文；先补项目文件，再沿同一迁移日志归档到分组。
      if (!await persistMissingNodeTextFiles(get, () => isCanvasDerivationFresh(guard, get()))) return;
      initialSignature = groupFilesSignature(get());
      // pending 始终优先读取，不能因为媒体签名没变而跳过重启或保存失败后的恢复。
      const pending = await pendingMediaRelocations(projectId);
      if (!fresh()) return;
      const scanFiles = syncedSignature?.projectId !== projectId || syncedSignature.signature !== groupFilesSignature(get());
      if (!scanFiles && !pending.length && !retiredFolders.get(projectId)?.size) return;
      const projectDir = await getProjectDataDir(projectId);
      if (!projectDir || !fresh()) return;
      if (!await relocateGroupedFiles(projectId, projectDir, guard, set, get, pending, scanFiles || pending.length > 0)) return;
      if (!isCanvasDerivationFresh(guard, get())) return;
      const completedSignature = groupFilesSignature(get());
      const inputsFresh = () => {
        if (get().currentProjectId !== projectId) return false;
        if (groupFilesSignature(get()) !== completedSignature) {
          queuedGroupSync = get().syncGroupFiles;
          return false;
        }
        return isCanvasDerivationFresh(guard, get());
      };
      if (retiredFolders.get(projectId)?.size
        && (await get().saveCurrentProjectSilent() !== projectId || !inputsFresh())) return;
      for (const name of retiredFolders.get(projectId) ?? []) {
        if (!inputsFresh()) return;
        if (!get().groups.some((group) => sanitizeFolderName(group.name) === sanitizeFolderName(name))) {
          await removeEmptyProjectGroupFolder(projectDir, name);
          if (!inputsFresh()) return;
        }
        retiredFolders.get(projectId)?.delete(name);
      }
      if (inputsFresh()) syncedSignature = { projectId, signature: completedSignature };
    } catch {
      if (get().currentProjectId === projectId) get().showToast('节点文件保存或分组归档未完成，正文和原文件已保留，请重试', 'error');
    } finally {
      if (get().currentProjectId && get().currentProjectId !== projectId) queuedGroupSync = get().syncGroupFiles;
      completeCanvasDerivation(guard);
      syncingGroupFiles = false;
      // 归档期间的新请求合并成一轮，项目切换和异步改源都不会被忙碌标记吞掉。
      const queued = queuedGroupSync;
      queuedGroupSync = null;
      if (queued) await queued();
    }
  },
  };
};
