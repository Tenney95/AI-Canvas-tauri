import { t } from '../../i18n';
import * as fileService from '../../services/fileService';
import { relocateMediaReferences } from '../../services/indexedDb/mediaRelocations';
import { applyAssetRepairs, cleanupUnavailableAssets } from '../../services/fs/assetRepair';
import { assertDramaAssetWriteCurrent } from '../../types/dramaAssets';
import type { ProjectSlice, ProjectSliceGet, ProjectSliceSet } from '../store.projects';

export function createAssetFileActions(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
): Pick<ProjectSlice,
  | 'moveGlobalAssetToFolder'
  | 'renameAssetFile'
  | 'repairAssetLocations'
  | 'cleanupMissingAssets'
> {
  return {
    moveGlobalAssetToFolder: async (file, selection, options) => fileService.moveAssetFile(
      file, selection, get().config.assetFolders ?? [], (move) => {
        // 按最新状态迁移精确路径，不把异步操作开始时的旧画布覆盖回来。
        const state = get();
        if (relocateMediaReferences(state.nodes, [move]) !== state.nodes) state.commitToHistory();
        set((current) => ({ ...relocateMediaReferences(current, [move]), recentAssetsRevision: current.recentAssetsRevision + 1 }));
      }, options),

    renameAssetFile: async (file, name, projectId) => fileService.renameAssetFile(
      file, name, projectId, get().config.assetFolders ?? [], (move) => {
        const state = get();
        if (relocateMediaReferences(state.nodes, [move]) !== state.nodes) state.commitToHistory();
        set((current) => ({ ...relocateMediaReferences(current, [move]), recentAssetsRevision: current.recentAssetsRevision + 1 }));
      }),

    repairAssetLocations: async (preview, assetIds, options = {}) => {
      const initialRoot = get().config.baseDataDir;
      const assertCurrent = () => {
        assertDramaAssetWriteCurrent(options);
        if (get().config.baseDataDir !== initialRoot) throw new Error(t('素材根目录已变化，请重新预览'));
        if (preview.target.kind === 'folder' && !(get().config.assetFolders ?? []).includes(preview.target.path)) {
          throw new Error(t('原目录引用已移除，请重新选择'));
        }
      };
      assertCurrent();
      return applyAssetRepairs(preview, assetIds, get().config.assetFolders ?? [], (moves) => {
        const state = get();
        if (relocateMediaReferences(state.nodes, moves) !== state.nodes) state.commitToHistory();
        set((current) => ({ ...relocateMediaReferences(current, moves), recentAssetsRevision: current.recentAssetsRevision + 1 }));
        if (preview.target.kind === 'folder' && preview.selectedRoot) {
          const oldRoot = preview.target.path;
          const selectedRoot = preview.selectedRoot;
          const current = get().config.assetFolders ?? [];
          const allRepaired = !preview.truncated && preview.candidates.length > 0 && preview.candidates.every((candidate) => assetIds.includes(candidate.index.assetId));
          const assetFolders = allRepaired ? current.map((root) => root === oldRoot ? selectedRoot : root)
            : [...current, selectedRoot];
          get().updateConfig({ assetFolders: [...new Set(assetFolders)] });
        }
      }, { ...options, assertCurrent });
    },

    cleanupMissingAssets: async (preview, assetIds, options = {}) => {
      const initialRoot = get().config.baseDataDir;
      const assertCurrent = () => {
        assertDramaAssetWriteCurrent(options);
        if (get().config.baseDataDir !== initialRoot) throw new Error(t('素材根目录已变化，请重新预览'));
        if (preview.target.kind === 'folder' && !(get().config.assetFolders ?? []).includes(preview.target.path)) {
          throw new Error(t('原目录引用已移除，请重新选择'));
        }
      };
      assertCurrent();
      return cleanupUnavailableAssets(preview, assetIds, ({ historyIds, deletedHistoryCounts }) => {
        const removed = new Set(historyIds);
        set((state) => {
          const records = state.outputHistoryRecords.filter((record) => !removed.has(record.id));
          const totalCount = Math.max(0, state.historyTotalCount - (state.historyProjectId ? deletedHistoryCounts[state.historyProjectId] ?? 0 : 0));
          return { outputHistoryRecords: records, historyTotalCount: totalCount,
            historyHasMore: state.historyHasMore && totalCount > records.length, recentAssetsRevision: state.recentAssetsRevision + 1 };
        });
        void get().refreshHistoryAfterAssetCleanup();
      }, { ...options, assertCurrent });
    },
  };
}
