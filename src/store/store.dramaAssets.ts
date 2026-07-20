/**
 * 项目级短剧资产库（人物 / 场景 / 道具）
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type {
  DramaAsset,
  DramaAssetKind,
  DramaAssetLibrary,
  DramaCharacter,
  DramaProp,
  DramaScene,
} from '../types/dramaAssets';
import { emptyDramaAssetLibrary } from '../types/dramaAssets';
import type { DramaExtractParseResult } from '../services/dramaAssetExtract';
import { mergeDramaExtractIntoLibrary } from '../services/dramaAssetExtract';

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
    // 触发静默保存
    void get().saveCurrentProjectSilent?.();
  },

  confirmDramaAsset: (kind, id, confirmed = true) => {
    const lib = get().dramaAssets;
    if (kind === 'character') {
      set({
        dramaAssets: {
          ...lib,
          characters: patchList(lib.characters, id, { confirmed } as Partial<DramaCharacter>),
        },
      });
    } else if (kind === 'scene') {
      set({
        dramaAssets: {
          ...lib,
          scenes: patchList(lib.scenes, id, { confirmed } as Partial<DramaScene>),
        },
      });
    } else {
      set({
        dramaAssets: {
          ...lib,
          props: patchList(lib.props, id, { confirmed } as Partial<DramaProp>),
        },
      });
    }
    void get().saveCurrentProjectSilent?.();
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
    void get().saveCurrentProjectSilent?.();
  },

  updateDramaAssetFields: (kind, id, patch) => {
    const lib = get().dramaAssets;
    if (kind === 'character') {
      set({
        dramaAssets: {
          ...lib,
          characters: patchList(lib.characters, id, patch as Partial<DramaCharacter>),
        },
      });
    } else if (kind === 'scene') {
      set({
        dramaAssets: {
          ...lib,
          scenes: patchList(lib.scenes, id, patch as Partial<DramaScene>),
        },
      });
    } else {
      set({
        dramaAssets: {
          ...lib,
          props: patchList(lib.props, id, patch as Partial<DramaProp>),
        },
      });
    }
    void get().saveCurrentProjectSilent?.();
  },

  clearDramaAssetsByKind: (kind) => {
    const lib = get().dramaAssets;
    if (kind === 'character') set({ dramaAssets: { ...lib, characters: [] } });
    else if (kind === 'scene') set({ dramaAssets: { ...lib, scenes: [] } });
    else set({ dramaAssets: { ...lib, props: [] } });
    void get().saveCurrentProjectSilent?.();
  },
});
