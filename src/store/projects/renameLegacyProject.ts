import type { Node } from '@xyflow/react';
import type { BaseNodeData, CanvasProject } from '../../types';
import * as fileService from '../../services/fileService';
import type { ProjectSaveData } from '../../services/fileService';
import type { AppState } from '../useAppStore';
import type { ProjectSliceGet, ProjectSliceSet } from '../store.projects';

function replacePathPrefix(path: string | undefined, oldDir: string, newDir: string): string | undefined {
  if (!path) return path;
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedOldDir = oldDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedNewDir = newDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedPath.startsWith(`${normalizedOldDir}/`)) return path;
  return `${normalizedNewDir}${normalizedPath.slice(normalizedOldDir.length)}`;
}

async function remapProjectNodePaths(
  nodes: Node<BaseNodeData>[],
  oldDir: string,
  newDir: string,
): Promise<Node<BaseNodeData>[]> {
  return Promise.all(nodes.map(async (node) => {
    const data = node.data as BaseNodeData;
    const nextFilePath = replacePathPrefix(data.filePath, oldDir, newDir);
    let changed = nextFilePath !== data.filePath;
    let nextData: BaseNodeData = changed ? { ...data, filePath: nextFilePath } : data;

    if (changed && nextFilePath) {
      const assetUrl = await fileService.getAssetUrlFromPath(nextFilePath);
      if (nextData.imageUrl) nextData.imageUrl = assetUrl;
      if (nextData.videoUrl) nextData.videoUrl = assetUrl;
      if (nextData.audioUrl) nextData.audioUrl = assetUrl;
    }

    if (Array.isArray(data.storyboardOverrides)) {
      const nextOverrides = await Promise.all(data.storyboardOverrides.map(async (override) => {
        if (!override) return override;
        const nextOverridePath = replacePathPrefix(override.filePath, oldDir, newDir);
        if (nextOverridePath === override.filePath) return override;
        changed = true;
        return {
          ...override,
          filePath: nextOverridePath,
          url: nextOverridePath ? await fileService.getAssetUrlFromPath(nextOverridePath) : override.url,
        };
      }));
      if (nextOverrides !== data.storyboardOverrides && nextOverrides.some((override, index) => override !== data.storyboardOverrides?.[index])) {
        nextData = nextData === data ? { ...data } : nextData;
        nextData.storyboardOverrides = nextOverrides;
      }
    }

    return changed ? { ...node, data: nextData } : node;
  }));
}

/**
 * 重命名事务的补偿动作：把物理目录、文件夹名映射、内存中的项目名与素材路径一并
 * 恢复到重命名前的状态。缺少它时，目录已改名而记录未落盘，重启后会按旧 dataFolder
 * 去找已经改名的目录，导致素材全部丢失。
 */
async function rollbackProjectRename(params: {
  set: ProjectSliceSet;
  get: ProjectSliceGet;
  id: string;
  previousProject: CanvasProject;
  previousDataFolder: string | undefined;
  renamed: fileService.ProjectDataDirRenameResult | null;
}): Promise<void> {
  const { set, get, id, previousProject, previousDataFolder, renamed } = params;
  try {
    await fileService.revertProjectDataDirRename(id, renamed, previousDataFolder);

    const current = get();
    const restoredNodes = renamed && current.currentProjectId === id
      ? await remapProjectNodePaths(current.nodes, renamed.newDir, renamed.oldDir)
      : null;

    set((state) => ({
      ...(state.currentProjectId === id
        ? { projectName: previousProject.name, ...(restoredNodes ? { nodes: restoredNodes } : {}) }
        : {}),
      projects: state.projects.map((item) => (
        item.id === id
          ? {
            ...item,
            name: previousProject.name,
            updatedAt: previousProject.updatedAt,
            dataFolder: previousDataFolder,
          }
          : item
      )),
    }));
  } catch (error) {
    console.error('[项目重命名] 回滚失败:', error);
  }
}

export async function renameLegacyProject(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  id: string,
  nextName: string,
  enqueueProjectSave: (record: ProjectSaveData) => Promise<string>,
  ownedDramaAssets: (project: CanvasProject, library: AppState['dramaAssets']) => AppState['dramaAssets'] | undefined,
): Promise<boolean> {
  const initialState = get();
  const project = initialState.projects.find((item) => item.id === id);
  if (!project) return false;
  if (initialState.currentProjectId === id && initialState.projectLoadStatus !== 'ready') {
    get().showToast('项目尚未成功加载，已阻止重命名保存', 'error');
    return false;
  }

  const persistedProject = initialState.currentProjectId === id
    ? null
    : await fileService.loadProjectData(id);
  if (initialState.currentProjectId !== id && !persistedProject) {
    get().showToast('无法读取项目，重命名失败', 'error');
    return false;
  }

  const updatedAt = Date.now();
  // 分集与剧集共用一个素材目录，改分集名不能动目录，否则整部剧的素材路径都会失效。
  const nextDataFolder = project.parentId
    ? project.dataFolder
    : fileService.buildProjectFolderName(nextName, id);
  const oldDataFolder = project.dataFolder;
  const dataFolderChanged = Boolean(nextDataFolder) && oldDataFolder !== nextDataFolder;

  set((state) => ({
    ...(state.currentProjectId === id ? { projectName: nextName } : {}),
    projects: state.projects.map((item) =>
      item.id === id ? { ...item, name: nextName, updatedAt } : item
    ),
  }));

  let renamed: fileService.ProjectDataDirRenameResult | null = null;
  try {
    renamed = dataFolderChanged && nextDataFolder
      ? await fileService.renameProjectDataDir(id, oldDataFolder, nextDataFolder)
      : null;
    const latest = get();
    if (!latest.projects.some((item) => item.id === id)) return false;

    let nextNodes: Node<BaseNodeData>[];
    let record: ProjectSaveData;
    if (latest.currentProjectId === id) {
      nextNodes = renamed
        ? await remapProjectNodePaths(latest.nodes, renamed.oldDir, renamed.newDir)
        : latest.nodes;
      const latestProject = latest.projects.find((item) => item.id === id)!;
      record = {
        id,
        exchangeEpoch: latestProject.exchangeEpoch,
        name: nextName,
        createdAt: latestProject.createdAt,
        updatedAt,
        snapshot: latestProject.snapshot,
        dataFolder: renamed?.dataFolder ?? latestProject.dataFolder,
        settings: latestProject.settings,
        parentId: latestProject.parentId,
        episodeNo: latestProject.episodeNo,
        episodeOutline: latestProject.episodeOutline,
        episodeScript: latestProject.episodeScript,
        episodeScriptFile: latestProject.episodeScriptFile,
        episodeCreative: latestProject.episodeCreative,
        episodeAssetRoster: latestProject.episodeAssetRoster,
        series: latestProject.series,
        nodes: nextNodes,
        edges: latest.edges,
        groups: latest.groups,
        dramaAssets: ownedDramaAssets(latestProject, latest.dramaAssets),
      };
    } else {
      const source = persistedProject ?? await fileService.loadProjectData(id);
      if (!source) throw new Error('无法读取项目数据');
      nextNodes = renamed
        ? await remapProjectNodePaths(source.nodes as Node<BaseNodeData>[], renamed.oldDir, renamed.newDir)
        : source.nodes as Node<BaseNodeData>[];
      record = {
        ...source,
        name: nextName,
        updatedAt,
        dataFolder: renamed?.dataFolder ?? source.dataFolder,
        nodes: nextNodes,
      };
    }

    set((state) => ({
      ...(state.currentProjectId === id ? { projectName: nextName, nodes: nextNodes } : {}),
      projects: state.projects.map((item) => (
        item.id === id
          ? { ...item, name: nextName, updatedAt, dataFolder: record.dataFolder }
          : item
      )),
    }));
    await enqueueProjectSave(record);
    return true;
  } catch (error) {
    console.warn('[项目重命名] 保存失败，开始回滚:', error);
    await rollbackProjectRename({
      get,
      set,
      id,
      previousProject: project,
      previousDataFolder: oldDataFolder,
      renamed,
    });
    get().showToast('项目重命名失败，已恢复原名称', 'error');
    return false;
  }
}
