/**
 * 项目级短剧资产库（人物 / 场景 / 道具）
 */
import type { StateCreator } from 'zustand';
import type { Node } from '@xyflow/react';
import type { AppState } from './useAppStore';
import type {
  DramaAsset,
  DramaAssetKind,
  DramaAssetLibrary,
} from '../types/dramaAssets';
import { emptyDramaAssetLibrary } from '../types/dramaAssets';
import type { DramaExtractParseResult } from '../services/dramaAssetExtract';
import { mergeDramaExtractIntoLibrary, normalizeAssetKey } from '../services/dramaAssetExtract';
import {
  buildDramaAssetImagePrompt,
  defaultAspectRatioForAsset,
  defaultPurposeForKind,
  findDramaAssetByKind,
  purposeLabel,
} from '../services/dramaAssetPrompt';
import { generateId } from './store.utils';
import type { BaseNodeData } from '../types';

export interface DramaAssetsSlice {
  dramaAssets: DramaAssetLibrary;
  dramaAssetsPanelOpen: boolean;
  setDramaAssetsPanelOpen: (open: boolean) => void;
  setDramaAssets: (library: DramaAssetLibrary) => void;
  resetDramaAssets: () => void;
  /** 提取成功后合并入库 */
  mergeDramaExtract: (
    parsed: DramaExtractParseResult,
    meta?: { sourceNodeId?: string; modelId?: string },
  ) => void;
  confirmDramaAsset: (kind: DramaAssetKind, id: string, confirmed?: boolean) => void;
  deleteDramaAsset: (kind: DramaAssetKind, id: string) => void;
  updateDramaAssetFields: (
    kind: DramaAssetKind,
    id: string,
    patch: Partial<Pick<DramaAsset, 'summary' | 'visualNotes' | 'storyRole' | 'name'>>,
  ) => void;
  clearDramaAssetsByKind: (kind: DramaAssetKind) => void;
  /** 绑定画布图像节点 */
  bindDramaAssetImage: (
    kind: DramaAssetKind,
    id: string,
    imageNodeId: string,
    imageUrl?: string,
  ) => void;
  unbindDramaAssetImage: (kind: DramaAssetKind, id: string) => void;
  /** 图像生成成功后：按 imageNodeId / dramaAssetId 回写 imageUrl */
  syncDramaAssetImageFromNode: (imageNodeId: string, imageUrl: string) => void;
  /**
   * 从资产创建图像节点并填入定妆/场景/道具 prompt，自动绑定。
   * 返回新节点 id；失败返回 null。
   */
  createImageNodeFromDramaAsset: (kind: DramaAssetKind, id: string) => string | null;
}

function patchList<T extends { id: string; updatedAt: number }>(
  list: T[],
  id: string,
  patch: Partial<T>,
): T[] {
  return list.map((item) =>
    item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
  );
}

function mapKindList(
  lib: DramaAssetLibrary,
  kind: DramaAssetKind,
  mapper: (list: DramaAsset[]) => DramaAsset[],
): DramaAssetLibrary {
  if (kind === 'character') {
    return { ...lib, characters: mapper(lib.characters) as DramaAssetLibrary['characters'] };
  }
  if (kind === 'scene') {
    return { ...lib, scenes: mapper(lib.scenes) as DramaAssetLibrary['scenes'] };
  }
  return { ...lib, props: mapper(lib.props) as DramaAssetLibrary['props'] };
}

function silentSave(get: () => AppState) {
  void get().saveCurrentProjectSilent?.();
}

function pickSpawnPosition(nodes: Node<BaseNodeData>[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 120, y: 120 };
  let maxX = 0;
  let yAtMax = 120;
  for (const n of nodes) {
    const w = (n.data?.nodeWidth as number) || 280;
    const right = n.position.x + w;
    if (right > maxX) {
      maxX = right;
      yAtMax = n.position.y;
    }
  }
  return { x: maxX + 80, y: yAtMax };
}

export const createDramaAssetsSlice: StateCreator<AppState, [], [], DramaAssetsSlice> = (set, get) => ({
  dramaAssets: emptyDramaAssetLibrary(),
  dramaAssetsPanelOpen: false,

  setDramaAssetsPanelOpen: (open) => set(open
    ? {
        dramaAssetsPanelOpen: true,
        assetsPanelOpen: false,
        historyPanelOpen: false,
        settingsOpen: false,
        chatOpen: false,
      }
    : { dramaAssetsPanelOpen: false }),

  setDramaAssets: (library) => set({ dramaAssets: library ?? emptyDramaAssetLibrary() }),

  resetDramaAssets: () => set({ dramaAssets: emptyDramaAssetLibrary() }),

  mergeDramaExtract: (parsed, meta) => {
    const next = mergeDramaExtractIntoLibrary(get().dramaAssets, parsed, meta);
    set({ dramaAssets: next });
    silentSave(get);
  },

  confirmDramaAsset: (kind, id, confirmed = true) => {
    const lib = get().dramaAssets;
    set({
      dramaAssets: mapKindList(lib, kind, (list) =>
        patchList(list, id, { confirmed } as Partial<DramaAsset>),
      ),
    });
    silentSave(get);
  },

  deleteDramaAsset: (kind, id) => {
    const lib = get().dramaAssets;
    if (kind === 'character') {
      set({ dramaAssets: { ...lib, characters: lib.characters.filter((c) => c.id !== id) } });
    } else if (kind === 'scene') {
      set({ dramaAssets: { ...lib, scenes: lib.scenes.filter((c) => c.id !== id) } });
    } else {
      set({ dramaAssets: { ...lib, props: lib.props.filter((c) => c.id !== id) } });
    }
    silentSave(get);
  },

  updateDramaAssetFields: (kind, id, patch) => {
    const lib = get().dramaAssets;
    // 改名时同步 key，保证后续重提取 merge 仍能对上
    const nextPatch: Partial<DramaAsset> = { ...patch };
    if (typeof patch.name === 'string' && patch.name.trim()) {
      nextPatch.key = normalizeAssetKey(patch.name);
    }
    set({
      dramaAssets: mapKindList(lib, kind, (list) =>
        patchList(list, id, nextPatch),
      ),
    });
    silentSave(get);
  },

  clearDramaAssetsByKind: (kind) => {
    const lib = get().dramaAssets;
    if (kind === 'character') set({ dramaAssets: { ...lib, characters: [] } });
    else if (kind === 'scene') set({ dramaAssets: { ...lib, scenes: [] } });
    else set({ dramaAssets: { ...lib, props: [] } });
    silentSave(get);
  },

  bindDramaAssetImage: (kind, id, imageNodeId, imageUrl) => {
    const lib = get().dramaAssets;
    const node = get().nodes.find((n) => n.id === imageNodeId);
    const resolvedUrl =
      imageUrl
      || (node?.data?.imageUrl as string | undefined)
      || (node?.data?.thumbnailUrl as string | undefined);
    set({
      dramaAssets: mapKindList(lib, kind, (list) =>
        patchList(list, id, {
          imageNodeId,
          imageUrl: resolvedUrl,
        } as Partial<DramaAsset>),
      ),
    });
    silentSave(get);
  },

  unbindDramaAssetImage: (kind, id) => {
    const lib = get().dramaAssets;
    const strip = (list: DramaAsset[]): DramaAsset[] =>
      list.map((item) => {
        if (item.id !== id) return item;
        const { imageNodeId: _n, imageUrl: _u, ...rest } = item;
        return { ...rest, updatedAt: Date.now() } as DramaAsset;
      });
    set({ dramaAssets: mapKindList(lib, kind, strip) });
    silentSave(get);
  },

  syncDramaAssetImageFromNode: (imageNodeId, imageUrl) => {
    const lib = get().dramaAssets;
    let changed = false;

    const syncList = <T extends DramaAsset>(list: T[]): T[] =>
      list.map((item) => {
        if (item.imageNodeId === imageNodeId) {
          if (item.imageUrl === imageUrl) return item;
          changed = true;
          return { ...item, imageUrl, updatedAt: Date.now() };
        }
        return item;
      });

    const next: DramaAssetLibrary = {
      ...lib,
      characters: syncList(lib.characters),
      scenes: syncList(lib.scenes),
      props: syncList(lib.props),
    };

    // 按节点 data.dramaAssetId 补绑（一键创建路径兜底）
    const node = get().nodes.find((n) => n.id === imageNodeId);
    const dramaAssetId = node?.data?.dramaAssetId as string | undefined;
    const dramaAssetKind = node?.data?.dramaAssetKind as DramaAssetKind | undefined;
    if (dramaAssetId && dramaAssetKind) {
      const asset = findDramaAssetByKind(next, dramaAssetKind, dramaAssetId);
      if (asset && (asset.imageNodeId !== imageNodeId || asset.imageUrl !== imageUrl)) {
        changed = true;
        const bindPatch = { imageNodeId, imageUrl, updatedAt: Date.now() };
        if (dramaAssetKind === 'character') {
          next.characters = next.characters.map((c) =>
            c.id === dramaAssetId ? { ...c, ...bindPatch } : c,
          );
        } else if (dramaAssetKind === 'scene') {
          next.scenes = next.scenes.map((c) =>
            c.id === dramaAssetId ? { ...c, ...bindPatch } : c,
          );
        } else {
          next.props = next.props.map((c) =>
            c.id === dramaAssetId ? { ...c, ...bindPatch } : c,
          );
        }
      }
    }

    if (!changed) return;
    set({ dramaAssets: next });
    silentSave(get);
  },

  createImageNodeFromDramaAsset: (kind, id) => {
    const asset = findDramaAssetByKind(get().dramaAssets, kind, id);
    if (!asset) {
      get().showToast?.('未找到该资产', 'error');
      return null;
    }

    const purpose = defaultPurposeForKind(kind);
    const prompt = buildDramaAssetImagePrompt(asset, purpose);
    const nodeId = `node-${generateId()}`;
    const pos = pickSpawnPosition(get().nodes as Node<BaseNodeData>[]);
    const aspectRatio = defaultAspectRatioForAsset(kind);
    const label = `${asset.name} · ${purposeLabel(purpose)}`;

    // 粗算节点高度
    const nodeWidth = 280;
    const ratioParts = aspectRatio.split(':').map(Number);
    const ar = ratioParts[0] && ratioParts[1] ? ratioParts[0] / ratioParts[1] : 1;
    const nodeHeight = Math.max(160, Math.round((nodeWidth - 4) / ar) + 4);

    const newNode: Node<BaseNodeData> = {
      id: nodeId,
      type: 'ai-image',
      position: pos,
      data: {
        label,
        type: 'ai-image',
        role: 'generator',
        prompt,
        status: 'idle',
        aspectRatio,
        imageSize: '2K',
        nodeWidth,
        nodeHeight,
        dramaAssetId: asset.id,
        dramaAssetKind: kind,
      },
    };

    // 回填本地偏好模型（与侧栏添加图像节点一致）
    try {
      const raw = localStorage.getItem('canvas-model-prefs');
      if (raw) {
        const prefs: Record<string, string> = JSON.parse(raw);
        const modelValue = prefs['ai-image'];
        if (modelValue && modelValue.includes('::')) {
          const [provider, model] = modelValue.split('::');
          if (provider && model) {
            newNode.data.provider = provider;
            newNode.data.model = model;
          }
        }
      }
    } catch { /* ignore */ }

    get().addNode(newNode);
    get().bindDramaAssetImage(kind, id, nodeId);
    get().setDramaAssetsPanelOpen(false);
    get().setSelectedNodeIds([nodeId]);
    get().showToast(`已创建「${label}」图像节点，可直接生成`);

    return nodeId;
  },
});
