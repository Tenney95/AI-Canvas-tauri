/**
 * projectSummary — 将项目记录转换为列表用摘要。
 */
import type { EpisodeCreativeInfo, ProjectSeriesInfo, ProjectSettings } from '../../types';
import { normalizeEpisodeAssetRoster, type EpisodeAssetRoster } from '../../types/episodeAssets';
import type { CreationProfileSelection } from '../../types/creationProfile';
import type { AgentTeamProfile } from '../../types/agentTeam';
import { restoreCreationProfileSelection } from '../creationProfiles/creationProfileManifest';
import { normalizeTeamProfile } from '../chat/teams/teamProfileService';

/** 项目列表所需的轻量记录；禁止放入画布节点、连线、历史或角色库。 */
export interface ProjectSummaryRecord {
  exchangeEpoch?: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  snapshot?: string;
  dataFolder?: string;
  settings?: ProjectSettings;
  parentId?: string;
  episodeNo?: number;
  episodeOutline?: string;
  episodeScript?: string;
  episodeCreative?: EpisodeCreativeInfo;
  episodeAssetRoster?: EpisodeAssetRoster;
  creationProfile?: CreationProfileSelection;
  teamProfileOverride?: AgentTeamProfile;
  series?: ProjectSeriesInfo;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeProjectSettings(value: unknown): ProjectSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const settings = value as ProjectSettings;
  const visualStyle = settings.visualStyle;
  const styleReference = visualStyle?.styleReference;
  if (!visualStyle || !styleReference) return settings;

  const sanitizedReference = { ...styleReference };
  delete sanitizedReference.filePath;
  if (typeof sanitizedReference.imageUrl === 'string'
    && /^(?:data:image\/|blob:)/i.test(sanitizedReference.imageUrl)) {
    delete sanitizedReference.imageUrl;
  }
  return {
    ...settings,
    visualStyle: { ...visualStyle, styleReference: sanitizedReference },
  };
}

/** 从完整项目记录提取项目列表字段，显式白名单避免把 nodes/edges 意外复制进摘要。 */
export function toProjectSummaryRecord(record: unknown): ProjectSummaryRecord | null {
  if (!record || typeof record !== 'object') return null;
  const source = record as Record<string, unknown>;
  if (typeof source.id !== 'string' || !source.id.trim()) return null;

  const createdAt = finiteNumber(source.createdAt, Date.now());
  const summary: ProjectSummaryRecord = {
    id: source.id,
    name: typeof source.name === 'string' ? source.name : '未命名项目',
    createdAt,
    updatedAt: finiteNumber(source.updatedAt, createdAt),
  };
  if (typeof source.exchangeEpoch === 'number') summary.exchangeEpoch = source.exchangeEpoch;
  if (typeof source.snapshot === 'string') summary.snapshot = source.snapshot;
  if (typeof source.dataFolder === 'string') summary.dataFolder = source.dataFolder;
  const settings = sanitizeProjectSettings(source.settings);
  if (settings) summary.settings = settings;
  if (typeof source.parentId === 'string') summary.parentId = source.parentId;
  if (typeof source.episodeNo === 'number' && Number.isFinite(source.episodeNo)) {
    summary.episodeNo = source.episodeNo;
  }
  if (typeof source.episodeOutline === 'string') summary.episodeOutline = source.episodeOutline;
  if (typeof source.episodeScript === 'string') summary.episodeScript = source.episodeScript;
  if (source.episodeCreative && typeof source.episodeCreative === 'object') {
    summary.episodeCreative = source.episodeCreative as EpisodeCreativeInfo;
  }
  if (summary.parentId && source.episodeAssetRoster !== undefined) {
    summary.episodeAssetRoster = normalizeEpisodeAssetRoster(source.episodeAssetRoster);
  }
  if (source.series && typeof source.series === 'object') {
    summary.series = source.series as ProjectSeriesInfo;
  }
  const selection = restoreCreationProfileSelection(source.creationProfile);
  if (selection) {
    summary.creationProfile = selection;
    if (source.teamProfileOverride && typeof source.teamProfileOverride === 'object') {
      summary.teamProfileOverride = normalizeTeamProfile(source.teamProfileOverride);
    }
  }
  return summary;
}
