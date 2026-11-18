/** 回收整目录前重新核对权威目录、任务和目前仍可使用的素材引用。 */
import { assetUsageFileTreesOverlap, loadAssetDirectoryUsage, matchesAssetUsage } from '../assetUsageService';
import { configValuesEqual } from '../configPatch';
import { getAllAssetIndexes, getProjectById } from '../indexedDbService';
import { validateNativeAsset, type NativeAssetRecord } from '../indexedDb/nativeAssetRepository';
import { pendingMediaRelocations } from '../indexedDb/mediaRelocations';
import { readNativeProject } from '../indexedDb/nativeProjectRepository';
import { isNodeMediaCopySourceTree } from '../nodeMediaCopy';
import { getGlobalFilesDir } from './assetLibrary';
import { readNativeStorageSnapshot, nativeStorageProjectProtected, nativeStorageProjectRows, nativeStorageRowOwner,
  type NativeStorageSnapshot } from './nativeStorageReferences';
import { waitForPendingNodeFileDeletions } from './trash';

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;

function assertRetiredScope(snapshot: NativeStorageSnapshot, projectId: string): void {
  const rows = nativeStorageProjectRows(snapshot, projectId);
  if (!rows.retired.some((row) => row.kind === 'project' && row.id === projectId)) throw new Error('待回收项目缺少删除回执');
  if (nativeStorageProjectProtected(snapshot, projectId)) throw new Error('原项目仍保留待确认的任务或传输');
  if (rows.transfers.some((row) => record(row)?.kind === 'native-content-recovery')) throw new Error('项目目录仍有恢复点依赖');
}

export async function assertNativeProjectRecycleReferences(projectId: string, root: string): Promise<() => void> {
  if (!assetUsageFileTreesOverlap(root, root)) throw new Error('无法核对待回收项目目录');
  await waitForPendingNodeFileDeletions();
  const { useAppStore } = await import('../../store/useAppStore');
  const initial = useAppStore.getState();
  const initialConfig = initial.config;
  const assertReferencesCurrent = () => {
    const current = useAppStore.getState();
    const watched = ['currentProjectId', 'projects', 'nodes', 'edges', 'groups', 'history', 'messages', 'conversations', 'dramaAssets',
      'globalCharacters', 'globalScenes', 'globalProps', 'workflows', 'userPresets'] as const;
    if (current.projectLoadStatus !== 'ready' || watched.some((key) => current[key] !== initial[key])
      || current.config.baseDataDir !== initialConfig.baseDataDir || !configValuesEqual(current.config.assetFolders, initialConfig.assetFolders)
      || isNodeMediaCopySourceTree(root)) throw new Error('项目引用在回收前发生变化');
  };
  const [snapshot, existing, legacyProject, globalRoot, indexes] = await Promise.all([
    readNativeStorageSnapshot(), readNativeProject(projectId), getProjectById(projectId), getGlobalFilesDir(), getAllAssetIndexes(),
  ]);
  if (existing || legacyProject) throw new Error('项目仍在使用，未移动素材目录');
  assertRetiredScope(snapshot, projectId);
  const libraryRoots = [...(initialConfig.assetFolders ?? []), ...(globalRoot ? [globalRoot] : [])];
  if (!globalRoot || libraryRoots.some((path) => !assetUsageFileTreesOverlap(path, path) || assetUsageFileTreesOverlap(root, path))) {
    throw new Error('无法确认待回收目录与已登记素材库相互独立');
  }
  const rows = nativeStorageProjectRows(snapshot, projectId);
  const ownerIds = new Set(rows.retired.map((row) => row.id));
  const ownedIndexes = indexes.filter((index) => assetUsageFileTreesOverlap(index.path, root));
  if (ownedIndexes.some((index) => index.source !== 'project' || !index.projectId || !ownerIds.has(index.projectId))) {
    throw new Error('其他项目或全局素材库仍登记了原目录中的素材');
  }
  const assetIds = new Set(ownedIndexes.map((index) => index.assetId));
  for (const value of rows.exchange) {
    const row = record(value);
    if (row?.kind !== 'native-asset-v1') continue;
    const asset = row.record as NativeAssetRecord;
    validateNativeAsset(asset);
    assetIds.add(asset.assetId);
  }
  const target = { kind: 'file' as const, name: '', path: root, directoryAssetIds: assetIds };
  if ([...snapshot.exchange, ...snapshot.transfers].some((row) => nativeStorageRowOwner(row) !== projectId && matchesAssetUsage(row, target))) {
    throw new Error('其他项目回执或恢复材料仍引用原目录');
  }
  // 当前窗口可能仍缓存原项目对话。只有其权威归属已退役时才忽略这批缓存。
  const retiredConversationIds = new Set(initial.conversations
    .filter((conversation) => ownerIds.has(conversation.projectId)).map((conversation) => conversation.id));
  const [usage, globalMoves] = await Promise.all([
    loadAssetDirectoryUsage(root, assetIds, retiredConversationIds), pendingMediaRelocations('global-assets'),
  ]);
  if (usage.locations.length || matchesAssetUsage(globalMoves, target)) throw new Error('原目录仍有素材引用或正在迁移');
  const [latest, latestProject, latestLegacyProject] = await Promise.all([
    readNativeStorageSnapshot(), readNativeProject(projectId), getProjectById(projectId),
  ]);
  if (latestProject || latestLegacyProject || !configValuesEqual(latest, snapshot)) {
    throw new Error('核对期间项目目录、引用或文件操作发生变化');
  }
  assertRetiredScope(latest, projectId);
  assertReferencesCurrent();
  return assertReferencesCurrent;
}
