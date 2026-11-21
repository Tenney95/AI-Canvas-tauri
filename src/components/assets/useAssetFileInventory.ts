import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import {
  extractFilesFromNodeData, getProjectDataDir, isTauriEnv, listExternalFolderContents, listGlobalFolderContents,
  type AssetFileEntry, type AssetFolderEntry, type AssetFolderSelection, type FileCategory,
} from '../../services/fileService';
import { deleteAssetMeta, getAllAssetMeta, imageHistoryReferenceKey, putAssetMeta } from '../../services/indexedDbService';
import { mediaFileAllocationKey, pendingAssetMoveTargets } from '../../services/indexedDb/mediaRelocations';

export type FileTabKey = 'project' | 'permanent';
export type TabKey = FileTabKey | 'drama' | 'ark' | 'nodes' | 'refmods';
type FileLoadError = {
  message: string;
  failures?: { projectId: string; reason: string }[];
};

/** 仅展示固定错误类别，原生异常可能含本地路径或连接凭据。 */
function projectFileFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === '文件引用写入事务失败') return '文件索引保存失败';
  if (message === '项目文件身份范围无效，请重新预览'
    || message === '项目文件包含其他来源的资产身份，请先复制为独立项目资产'
    || message === '项目文件资产身份存在歧义，请先修复'
    || message === '资产身份已变化，请重新扫描'
    || message === '素材已被清理，请重新加载后重试') return '文件身份校验失败';
  if (message === '文件引用迁移记录损坏，停止分配文件名'
    || message === '读取文件引用迁移记录失败') return '文件迁移记录读取失败';
  return '读取失败';
}


export function assetKey(file: AssetFileEntry): string {
  return file.assetId ?? file.path;
}

export function useAssetFileInventory({
  activeTab, currentProjectId, selectedProjectId, baseDataDir, viewProjectIds, nativeFileOwner, folders,
}: {
  activeTab: FileTabKey;
  currentProjectId: string | null;
  selectedProjectId: string | null;
  baseDataDir?: string;
  viewProjectIds: string[];
  nativeFileOwner?: string;
  folders: string[];
}) {
  const [projectFileOwners, setProjectFileOwners] = useState(new Map<string, string>());
  const projectIdForFile = useCallback((file: AssetFileEntry) => activeTab === 'project'
    ? projectFileOwners.get(file.path) ?? selectedProjectId ?? currentProjectId ?? undefined
    : undefined, [activeTab, projectFileOwners, selectedProjectId, currentProjectId]);
  const [projectFiles, setProjectFiles] = useState<AssetFileEntry[]>([]);
  const [permanentFiles, setPermanentFiles] = useState<AssetFileEntry[]>([]);
  const [externalFolders, setExternalFolders] = useState<AssetFolderEntry[]>([]);
  const [globalRootPath, setGlobalRootPath] = useState<string | null>(null);
  const [folderSelection, setFolderSelection] = useState<AssetFolderSelection>({ kind: 'all' });
  const deletedFilePathsRef = useRef(new Set<string>());
  const [folderScanTruncated, setFolderScanTruncated] = useState(false);
  const [tagMap, setTagMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<FileLoadError | null>(null);
  const loadRequestRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const cancelFileScan = useCallback(() => {
    loadRequestRef.current += 1;
    loadControllerRef.current?.abort();
  }, []);
  const projectFilesScopeRef = useRef<string | null>(null);
  const permanentFilesScopeRef = useRef<string | null>(null);

  // 载入标签元数据 → Map
  const loadTags = useCallback(async () => {
    try {
      const metas = await getAllAssetMeta();
      const map: Record<string, string[]> = {};
      for (const m of metas) if (m.tags?.length) map[m.assetId] = m.tags;
      setTagMap(map);
    } catch { /* ignore */ }
  }, [setTagMap]);

  // 载入文件列表（按 Tab 聚合）
  const loadFiles = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const requestId = ++loadRequestRef.current;
    const isCurrentRequest = () => !controller.signal.aborted && requestId === loadRequestRef.current
      && useAppStore.getState().assetsPanelOpen
      && currentProjectId === useAppStore.getState().currentProjectId
      && baseDataDir === useAppStore.getState().config.baseDataDir;
    let publishTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPublishAt = 0;
    let publishFiles: (() => void) | undefined;
    const cancelPublish = () => {
      if (publishTimer !== null) clearTimeout(publishTimer);
      publishTimer = null;
    };
    const publishProgress = () => {
      if (!isCurrentRequest()) return;
      const remaining = 80 - (Date.now() - lastPublishAt);
      if (lastPublishAt === 0 || remaining <= 0) {
        cancelPublish();
        lastPublishAt = Date.now();
        publishFiles?.();
      } else if (publishTimer === null) {
        publishTimer = setTimeout(() => {
          publishTimer = null;
          if (!isCurrentRequest()) return;
          lastPublishAt = Date.now();
          publishFiles?.();
        }, remaining);
      }
    };
    controller.signal.addEventListener('abort', cancelPublish, { once: true });
    setLoading(true);
    setLoadError(null);
    try {
      if (activeTab === 'project') {
        const scope = JSON.stringify([baseDataDir, viewProjectIds]);
        if (projectFilesScopeRef.current !== scope) {
          projectFilesScopeRef.current = scope;
          setProjectFiles([]);
          setProjectFileOwners(new Map());
        }
        if (!viewProjectIds.length) { setProjectFiles([]); setProjectFileOwners(new Map()); return; }
        const { projectAssetSyncService } = await import('../../services/fs/sharedAssetSync');
        if (!isCurrentRequest()) return;
        const scanIds = nativeFileOwner ? [viewProjectIds[0]] : viewProjectIds;
        const viewIds = new Set(viewProjectIds);
        // 新作品共用同一磁盘根。旧项目继续按实际目录定位所属分集。
        const projectRoots = !nativeFileOwner && viewProjectIds.length > 1 ? await Promise.all(viewProjectIds.map(async (projectId) => {
          const directory = await getProjectDataDir(projectId).catch(() => null);
          return { projectId, prefix: directory ? `${imageHistoryReferenceKey(directory) ?? directory}/` : null };
        })) : [];
        if (!isCurrentRequest()) return;
        const fileOwner = (file: AssetFileEntry, fallbackProjectId: string) => {
          if (nativeFileOwner) return file.ownerProjectId && viewIds.has(file.ownerProjectId) ? file.ownerProjectId : fallbackProjectId;
          const path = imageHistoryReferenceKey(file.path) ?? file.path;
          let owner = fallbackProjectId;
          let prefixLength = 0;
          for (const root of projectRoots) {
            if (root.prefix && path.startsWith(root.prefix) && root.prefix.length >= prefixLength) {
              owner = root.projectId;
              prefixLength = root.prefix.length;
            }
          }
          return owner;
        };
        const owners = new Map<string, string>();
        const diskEntries = new Map<string, AssetFileEntry>();
        publishFiles = () => {
          const snapshot = Array.from(diskEntries.entries());
          const ownerSnapshot = Array.from(owners.entries());
          setProjectFiles((previous) => {
            const merged = new Map(previous.map((file) => [imageHistoryReferenceKey(file.path) ?? file.path, file]));
            for (const [key, file] of snapshot) merged.set(key, file);
            return Array.from(merged.values());
          });
          setProjectFileOwners((previous) => new Map([...previous, ...ownerSnapshot]));
        };
        const receiveFiles = (entries: AssetFileEntry[], projectId: string) => {
          if (!isCurrentRequest()) return;
          for (const file of entries) {
            diskEntries.set(imageHistoryReferenceKey(file.path) ?? file.path, file);
            owners.set(file.path, fileOwner(file, projectId));
            deletedFilePathsRef.current.delete(file.path);
          }
          if (entries.length) publishProgress();
        };
        const failures: NonNullable<FileLoadError['failures']> = [];
        // 父项目后读取分集，重叠目录中的文件沿用具体分集的身份和历史归属。
        for (const projectId of scanIds) {
          const previousEntries = new Map(diskEntries);
          const previousOwners = new Map(owners);
          let entries: AssetFileEntry[] | null = null;
          let failureReason = '读取失败';
          // 单个目录/索引读取失败不丢弃整部剧；短暂故障仅自动重读一次。
          for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) {
              diskEntries.clear();
              for (const [key, file] of previousEntries) diskEntries.set(key, file);
              owners.clear();
              for (const [path, owner] of previousOwners) owners.set(path, owner);
            }
            try { entries = await projectAssetSyncService.readProjectFiles(projectId, {
              signal: controller.signal,
              onFiles: (batch) => receiveFiles(batch, projectId),
            }); }
            catch (error) {
              if (!isCurrentRequest()) return;
              failureReason = projectFileFailureReason(error);
              if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
            if (!isCurrentRequest()) return;
            if (entries !== null) break;
          }
          if (entries === null) failures.push({ projectId, reason: failureReason });
          receiveFiles(entries ?? [], projectId);
        }
        const diskFiles = Array.from(diskEntries.values());
        if (!isCurrentRequest()) return;
        // 原生返回反斜杠路径，目录扫描使用正斜杠；旧节点还可能带 Windows 长路径前缀。
        // 与提示词关联复用同一比较键，已有磁盘条目优先，不追加大小为 0 的节点副本。
        const known = new Set(diskFiles.map((f) => imageHistoryReferenceKey(f.path) ?? f.path));
        for (const file of diskFiles) deletedFilePathsRef.current.delete(file.path);
        const nodeEntries: AssetFileEntry[] = [];
        // 仅当查看的是「当前项目」时，才并入画布上尚未落盘的节点文件
        // （store.nodes 始终是当前项目的画布，其他项目无法从内存取节点）
        if (currentProjectId && viewIds.has(currentProjectId)) {
          for (const node of useAppStore.getState().nodes) {
            const entry = extractFilesFromNodeData(node.data as Record<string, unknown>, { projectId: currentProjectId, nodeId: node.id });
            if (!entry) continue;
            const key = imageHistoryReferenceKey(entry.path) ?? entry.path;
            if (!known.has(key) && !deletedFilePathsRef.current.has(entry.path)) {
              nodeEntries.push(entry);
              known.add(key);
              owners.set(entry.path, currentProjectId);
            }
          }
        }
        if (failures.length < scanIds.length || nodeEntries.length || diskFiles.length) {
          const combined = [...diskFiles, ...nodeEntries];
          const projected: AssetFileEntry[] = [];
          // 节点补充条目也经同一适配口过滤，旧版本不会因节点仍引用它而回到当前资产列表。
          for (const projectId of scanIds) {
            const entries = nativeFileOwner && nodeEntries.length === 0 ? diskFiles
              : await projectAssetSyncService.projectFileView(projectId,
                nativeFileOwner ? combined : combined.filter((file) => owners.get(file.path) === projectId), { signal: controller.signal });
            if (!isCurrentRequest()) return;
            for (const file of entries) {
              projected.push(file);
              owners.set(file.path, nativeFileOwner ? fileOwner(file, owners.get(file.path) ?? projectId) : projectId);
            }
          }
          setProjectFileOwners(owners);
          setProjectFiles(projected);
        }
        if (failures.length) setLoadError({ message: '项目文件读取未完成，已保留可用资源，请重试。', failures });
      } else {
        const scope = JSON.stringify([baseDataDir, folders]);
        if (permanentFilesScopeRef.current !== scope) {
          permanentFilesScopeRef.current = scope;
          setPermanentFiles([]);
          setExternalFolders([]);
          setGlobalRootPath(null);
          setFolderScanTruncated(false);
        } else if (isTauriEnv()) {
          const pending = await pendingAssetMoveTargets();
          if (!isCurrentRequest()) return;
          if (pending.size) setPermanentFiles((previous) => previous.filter((file) => !pending.has(mediaFileAllocationKey(file.path))));
        }
        const discovered = new Map<string, AssetFileEntry>();
        publishFiles = () => {
          const snapshot = Array.from(discovered.entries());
          setPermanentFiles((previous) => {
            const merged = new Map(previous.map((file) => [file.path, file]));
            for (const [path, file] of snapshot) merged.set(path, file);
            return Array.from(merged.values());
          });
        };
        const receiveFiles = (entries: AssetFileEntry[]) => {
          if (!isCurrentRequest()) return;
          for (const file of entries) {
            if (discovered.get(file.path)?.source !== 'global' || file.source === 'global') discovered.set(file.path, file);
          }
          if (entries.length) publishProgress();
        };
        // 永久 = 全局 file 目录 + 登记的外部文件夹（递归）
        const [globalContents, contents] = await Promise.all([
          listGlobalFolderContents({ signal: controller.signal, onFiles: receiveFiles }),
          listExternalFolderContents(folders, { signal: controller.signal, onFiles: receiveFiles }),
        ]);
        if (!isCurrentRequest()) return;
        const seen = new Set<string>();
        const merged: AssetFileEntry[] = [];
        for (const f of [...globalContents.files, ...contents.files]) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          merged.push(f);
        }
        setPermanentFiles(merged);
        const allFolders = Array.from(new Map([...globalContents.folders, ...contents.folders]
          .map((folder) => [JSON.stringify([folder.rootPath, folder.relativePath]), folder])).values());
        setGlobalRootPath(globalContents.rootPath);
        setExternalFolders(allFolders);
        setFolderScanTruncated(contents.truncated || globalContents.truncated);
        setFolderSelection((selection) => selection.kind === 'folder'
          && !allFolders.some((folder) => folder.rootPath === selection.rootPath && folder.relativePath === selection.relativePath)
          ? { kind: 'all' } : selection);
      }
    } catch {
      if (isCurrentRequest()) {
        publishFiles?.();
        setLoadError({ message: '资源读取失败，请重试。' });
      }
    } finally {
      cancelPublish();
      controller.signal.removeEventListener('abort', cancelPublish);
      if (isCurrentRequest()) setLoading(false);
      controller.abort();
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
    }
  }, [activeTab, currentProjectId, baseDataDir, viewProjectIds, nativeFileOwner, folders]);

  // ── 标签编辑（手动）──
  const persistTags = useCallback(async (assetId: string, path: string, tags: string[]) => {
    setTagMap((prev) => {
      const next = { ...prev };
      if (tags.length) next[assetId] = tags; else delete next[assetId];
      return next;
    });
    try {
      if (tags.length) await putAssetMeta({ assetId, path, tags, taggedBy: 'manual', updatedAt: Date.now() });
      else await deleteAssetMeta(assetId);
    } catch { /* ignore */ }
  }, [setTagMap]);

  const addTag = useCallback((file: AssetFileEntry, raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    const key = assetKey(file);
    const cur = tagMap[key] ?? [];
    if (cur.includes(tag)) return;
    persistTags(key, file.path, [...cur, tag]);
  }, [tagMap, persistTags]);

  const removeTag = useCallback((file: AssetFileEntry, tag: string) => {
    const key = assetKey(file);
    persistTags(key, file.path, (tagMap[key] ?? []).filter((t) => t !== tag));
  }, [tagMap, persistTags]);

  return {
    setProjectFileOwners, projectIdForFile, projectFiles, setProjectFiles, permanentFiles,
    setPermanentFiles, externalFolders, globalRootPath, folderSelection, setFolderSelection,
    deletedFilePathsRef, folderScanTruncated, tagMap, setTagMap, loading, loadError, loadControllerRef,
    cancelFileScan, loadTags, loadFiles, addTag, removeTag,
  };
}

export function useAssetFilterRow({
  assetsPanelOpen, visibleTab, categoryCounts, tagList, filterRowExpanded, setFilterRowExpanded,
}: {
  assetsPanelOpen: boolean;
  visibleTab: TabKey;
  categoryCounts: Record<FileCategory, number>;
  tagList: [string, number][];
  filterRowExpanded: boolean;
  setFilterRowExpanded: (expanded: boolean) => void;
}) {
  const [filterRowOverflow, setFilterRowOverflow] = useState(false);
  const [visibleFilterItemCount, setVisibleFilterItemCount] = useState(Number.POSITIVE_INFINITY);
  const filterRowRef = useRef<HTMLDivElement | null>(null);
  const filterListRef = useRef<HTMLDivElement | null>(null);
  const measureFilterRowOverflow = useCallback(() => {
    const row = filterRowRef.current;
    const list = filterListRef.current;
    if (!row || !list) return;

    const rowStyle = window.getComputedStyle(row);
    const availableWidth = row.clientWidth
      - (Number.parseFloat(rowStyle.paddingLeft) || 0)
      - (Number.parseFloat(rowStyle.paddingRight) || 0);
    const rowGap = Number.parseFloat(rowStyle.columnGap) || 0;
    const listGap = Number.parseFloat(window.getComputedStyle(list).columnGap) || 0;
    const items = Array.from(list.children) as HTMLElement[];
    const itemWidths = items.map((item) => {
      const itemStyle = window.getComputedStyle(item);
      return item.getBoundingClientRect().width
        + (Number.parseFloat(itemStyle.marginLeft) || 0)
        + (Number.parseFloat(itemStyle.marginRight) || 0);
    });
    const contentWidth = itemWidths.reduce((total, width) => total + width, 0)
      + Math.max(0, items.length - 1) * listGap;
    const hasOverflow = contentWidth > availableWidth + 1;

    setFilterRowOverflow(hasOverflow);
    if (!hasOverflow) {
      setVisibleFilterItemCount(items.length);
      setFilterRowExpanded(false);
      return;
    }
    if (filterRowExpanded) {
      setVisibleFilterItemCount(items.length);
      return;
    }

    const collapsedWidth = availableWidth - 28 - rowGap;
    let usedWidth = 0;
    let visibleCount = 0;
    for (const width of itemWidths) {
      const nextWidth = usedWidth + (visibleCount > 0 ? listGap : 0) + width;
      if (nextWidth > collapsedWidth) break;
      usedWidth = nextWidth;
      visibleCount++;
    }
    if (items[visibleCount - 1]?.hasAttribute('data-filter-separator')) visibleCount--;
    setVisibleFilterItemCount(visibleCount);
  }, [filterRowExpanded, setFilterRowExpanded]);

  useEffect(() => {
    if (!assetsPanelOpen || visibleTab === 'drama' || visibleTab === 'nodes') return;
    const row = filterRowRef.current;
    if (!row) return;

    const frame = window.requestAnimationFrame(measureFilterRowOverflow);
    const resizeObserver = new ResizeObserver(measureFilterRowOverflow);
    resizeObserver.observe(row);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [assetsPanelOpen, categoryCounts, measureFilterRowOverflow, tagList, visibleTab]);

  return { filterRowOverflow, visibleFilterItemCount, filterRowRef, filterListRef };
}
