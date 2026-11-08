/** 新结构的轻量导航投影；这里只供 Store 展示，不能作为持久化或授权凭据。 */
import type { CanvasProject } from '../types';
import type { EpisodeContent } from '../types/project';
import type { ProjectCatalogEntry } from '../services/projectModelRouter';
import type { readNativeProjectView } from '../services/nativeProjectNavigation';
import { resolveProjectModelSettings } from '../services/projectModelSettings';
import { configValuesEqual } from '../services/configPatch';
import { remapStoryGraphBindings } from '../services/projectExchangeDomain';

export interface NativeProjectViewBinding {
  readonly projectId: string;
  readonly episodeId: string | null;
  readonly canvasId: string | null;
  readonly orderRank?: number;
  /** 分集元数据版本，与显示集号、画布版本和正文版本分别计数。 */
  readonly episodeRevision?: number;
}

export type NativeProjectViewItem = CanvasProject & { nativeView: NativeProjectViewBinding };

/** 保留现有画布 ID 导航合同，同时显式保存真正的项目和分集身份。 */
export function projectNativeCatalogEntry(entry: Extract<ProjectCatalogEntry, { dataModel: 'native' }>): NativeProjectViewItem[] {
  const { project, episodes, canvasIds } = entry;
  if (project.kind === 'standalone') {
    const canvasId = canvasIds[0];
    if (episodes.length || entry.episodeIds.length || canvasIds.length !== 1 || !canvasId) throw new Error('新项目画布关系不完整');
    return [{ id: canvasId, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, exchangeEpoch: project.epoch,
      dataFolder: project.dataFolder, settings: project.defaultSettings,
      nativeView: { projectId: project.id, episodeId: null, canvasId } }];
  }
  const ordered = [...episodes].sort((left, right) => left.orderRank - right.orderRank);
  if (ordered.length !== canvasIds.length || ordered.length !== entry.episodeIds.length
    || new Set(canvasIds).size !== canvasIds.length || new Set(ordered.map((item) => item.id)).size !== ordered.length
    || new Set(ordered.map((item) => item.canvasId)).size !== ordered.length
    || ordered.some((item) => item.projectId !== project.id || !entry.episodeIds.includes(item.id) || !canvasIds.includes(item.canvasId))) {
    throw new Error('新剧集画布关系不完整');
  }
  const owner: NativeProjectViewItem = { id: project.id, name: project.name, createdAt: project.createdAt,
    updatedAt: project.updatedAt, exchangeEpoch: project.epoch, dataFolder: project.dataFolder, settings: project.defaultSettings,
    nativeView: { projectId: project.id, episodeId: null, canvasId: null } };
  return [owner, ...ordered.map((episode, index): NativeProjectViewItem => ({
    id: episode.canvasId, parentId: project.id, name: episode.name, createdAt: episode.createdAt,
    updatedAt: episode.updatedAt, exchangeEpoch: episode.epoch, dataFolder: project.dataFolder, episodeNo: episode.displayNo ?? index + 1,
    settings: resolveProjectModelSettings(project.defaultSettings, episode.settingsPolicy),
    ...(episode.creationProfile ? { creationProfile: episode.creationProfile } : {}),
    ...(episode.teamProfileOverride ? { teamProfileOverride: episode.teamProfileOverride } : {}),
    nativeView: { projectId: project.id, episodeId: episode.id, canvasId: episode.canvasId, orderRank: episode.orderRank,
      episodeRevision: episode.revision },
  }))];
}

/** 把已核验的当前画布和正文补入导航视图，不把该投影作为存储记录。 */
export function hydrateNativeProjectView(
  entry: Extract<ProjectCatalogEntry, { dataModel: 'native' }>,
  loaded: NonNullable<Awaited<ReturnType<typeof readNativeProjectView>>>,
  allEpisodeContents?: readonly EpisodeContent[],
): NativeProjectViewItem[] {
  const { selection, content, episodeContent } = loaded;
  const orderedEpisodes = [...entry.episodes].sort((a, b) => a.orderRank - b.orderRank);
  if (!configValuesEqual(selection.project, entry.project) || !configValuesEqual(selection.episodes, orderedEpisodes)
    || content.projectId !== entry.project.id
    || (selection.episode?.id !== episodeContent?.episodeId && (selection.episode !== null || episodeContent !== null))) {
    throw new Error('新项目正文与导航身份不一致');
  }
  if (allEpisodeContents && (allEpisodeContents.length !== entry.episodes.length
    || new Set(allEpisodeContents.map((item) => item.episodeId)).size !== entry.episodes.length
    || allEpisodeContents.some((item) => !entry.episodeIds.includes(item.episodeId)))) throw new Error('新项目分集正文不完整');
  const series = entry.project.kind === 'series' ? {
    ...(content.originalWork ? { originalWork: content.originalWork } : {}),
    ...(content.script !== undefined ? { script: content.script } : {}),
    ...(content.storyGraph ? { storyGraph: remapStoryGraphBindings(content.storyGraph,
      (id) => entry.episodes.find((episode) => episode.id === id)?.canvasId ?? id, (asset) => asset.id) } : {}),
  } : undefined;
  const view = projectNativeCatalogEntry(entry);
  if (selection.canvas && !view.some((item) => item.nativeView.canvasId === selection.canvas?.id)) {
    throw new Error('新项目画布与导航身份不一致');
  }
  return view.map((item) => {
    if (!item.parentId && series) return { ...item, series };
    const creative = item.nativeView.episodeId
      ? allEpisodeContents?.find((body) => body.episodeId === item.nativeView.episodeId)
        ?? (item.nativeView.episodeId === episodeContent?.episodeId ? episodeContent : undefined)
      : item.nativeView.canvasId === selection.canvas?.id ? content.standaloneCreative : undefined;
    if (!creative) return item;
    return { ...item,
      ...(creative.outline !== undefined ? { episodeOutline: creative.outline } : {}),
      ...(creative.script !== undefined ? { episodeScript: creative.script } : {}),
      ...(creative.scriptFile ? { episodeScriptFile: creative.scriptFile } : {}),
      ...(creative.creative ? { episodeCreative: creative.creative } : {}),
      ...(creative.assetRoster ? { episodeAssetRoster: creative.assetRoster } : {}),
      ...('creationProfile' in creative && creative.creationProfile ? { creationProfile: creative.creationProfile } : {}),
      ...('teamProfileOverride' in creative && creative.teamProfileOverride ? { teamProfileOverride: creative.teamProfileOverride } : {}),
    };
  });
}
