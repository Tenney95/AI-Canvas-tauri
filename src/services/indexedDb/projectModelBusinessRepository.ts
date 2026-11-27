/** 新项目导入、复制和恢复共用的聚合校验。 */
import type { CanvasDocument, EpisodeContent, ProjectContent } from '../../types/project';
import type { ProjectSettings } from '../../types';
import type { ProjectModelTransferAggregate } from '../../types/projectModelTransfer';
import { projectModelSourceToken } from './projectModelStagingRepository';
import { assertProjectModelProjectSettings, assertProjectModelSettingsPolicy } from '../projectModelSettings';
import { normalizeProjectTextFileReference } from '../../utils/manuscriptFileReference';
import { assertNoProjectModelCredentials } from '../projectModelBackup';
import { normalizeStoryGraph } from '../storyGraphService';
import { normalizeEpisodeAssetRoster } from '../../types/episodeAssets';
import { normalizeDramaAssetLibrary } from '../../types/dramaAssets';
import { normalizeCreationProfileSelection } from '../creationProfiles/creationProfileManifest';
import { normalizeTeamProfile, TEAM_ROLES, validateTeamReaders } from '../chat/teams/teamProfileService';
import { validateTeamGraph } from '../chat/teams/teamGraphService';

function fail(code: string): never { throw new Error('项目模型隔离业务未完成：' + code); }
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 256 && ![...value].some((character) => character.charCodeAt(0) < 32);
function assertId(value: unknown): asserts value is string { if (!identity(value)) fail('invalid-identity'); }
function data<T>(value: T): T {
  projectModelSourceToken(value); assertNoProjectModelCredentials(value); return structuredClone(value);
}
function portableReference(value: unknown): void {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\\') || value.includes(':')
    || value.split('/').some((part) => !part || part === '.' || part === '..' || /[<>"|?*]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      || [...part].some((character) => character.charCodeAt(0) < 32))) fail('non-portable-reference');
}
const temporaryMedia = /^(?:blob:|file:|asset:|https?:\/\/asset\.localhost(?:[/:]|$))/i;
function persistedStyle(settings: ProjectSettings, previous?: ProjectSettings): void {
  assertProjectModelProjectSettings(settings);
  const reference = settings.visualStyle?.styleReference;
  if (reference?.filePath !== undefined && reference.filePath !== previous?.visualStyle?.styleReference?.filePath) portableReference(reference.filePath);
  if (reference?.imageUrl && temporaryMedia.test(reference.imageUrl)
    && reference.imageUrl !== previous?.visualStyle?.styleReference?.imageUrl) fail('temporary-style-reference');
  const fields = ['visualStyle', 'promptSuffix', 'promptSuffixes', 'defaultModels', 'visionModelId', 'modelAutoRouting', 'generation'];
  if (Object.keys(settings).some((field) => !fields.includes(field))) fail('invalid-project-settings');
  for (const [value, allowed] of [[settings.visualStyle, ['styleId', 'styleName', 'prompt', 'locked', 'styleReference']],
    [reference, ['filePath', 'imageUrl', 'fileName', 'enabled']],
    [settings.promptSuffixes, ['text', 'image', 'video', 'audio']], [settings.defaultModels, ['text', 'image', 'video', 'audio']],
    [settings.generation, ['imageAspectRatio', 'imageSize', 'videoAspectRatio', 'videoResolution', 'videoDuration']]] as const) {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((field) => !(allowed as readonly string[]).includes(field)))) fail('invalid-project-settings');
  }
  for (const item of [settings.promptSuffix, settings.visualStyle?.styleId, settings.visualStyle?.styleName,
    settings.visualStyle?.prompt, reference?.fileName, reference?.imageUrl, reference?.filePath,
    ...Object.values(settings.promptSuffixes ?? {})]) if (item !== undefined && typeof item !== 'string') fail('invalid-project-settings');
  for (const item of [settings.visualStyle?.locked, settings.modelAutoRouting, reference?.enabled]) {
    if (item !== undefined && typeof item !== 'boolean') fail('invalid-project-settings');
  }
  for (const item of [settings.visionModelId, ...Object.values(settings.defaultModels ?? {}),
    settings.generation?.imageAspectRatio, settings.generation?.imageSize, settings.generation?.videoAspectRatio]) {
    if (item !== undefined && (typeof item !== 'string' || !item.trim())) fail('invalid-project-settings');
  }
  if (settings.generation?.videoResolution !== undefined && !['480p', '720p', '1080p', '4k'].includes(settings.generation.videoResolution)) fail('invalid-project-settings');
  const duration = settings.generation?.videoDuration;
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 2 || duration > 15)) fail('invalid-project-settings');
}
function canvasReferences(next: unknown, previous: unknown): void {
  const fields = new Set(['filePath', 'rootPath', 'sourcePath', 'outputPath', 'localPath', 'imageUrl', 'audioUrl', 'videoUrl', 'assetUrl', 'url']);
  const existing = new Set<string>();
  const visit = (value: unknown, collect: boolean): void => {
    if (!value || typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) return;
    for (const [field, item] of Object.entries(value)) {
      if (typeof item === 'string' && fields.has(field)) {
        const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(item) || temporaryMedia.test(item);
        if (absolute) {
          if (collect) existing.add(item); else if (!existing.has(item)) fail('non-portable-canvas-reference');
        }
      } else visit(item, collect);
    }
  };
  visit(previous, true); visit(next, false);
}
function textReference(value: unknown): void {
  if (value !== undefined && !normalizeProjectTextFileReference(value)) fail('invalid-script-file-reference');
}
function shape(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((field) => !fields.includes(field))) fail(code);
  return result;
}
/** 对已知DTO复用原有normalizer，但有损清洗要失败，不能把错误新值当成空资料。 */
function sameNormalized(input: unknown, normalized: unknown, code: string): void {
  const canonical = (value: unknown) => {
    const text = JSON.stringify(value); if (text === undefined) fail(code);
    return projectModelSourceToken(JSON.parse(text));
  };
  if (canonical(input) !== canonical(normalized)) fail(code);
}
function creativeFields(value: Record<string, unknown>): void {
  for (const field of ['outline', 'script']) if (value[field] !== undefined && typeof value[field] !== 'string') fail('invalid-creative-content');
  if (value.scriptFile !== undefined) {
    shape(value.scriptFile, ['fileName', 'relativePath', 'digest', 'sourceName'], 'invalid-script-file-reference');
    textReference(value.scriptFile);
    value.scriptFile = normalizeProjectTextFileReference(value.scriptFile)!;
  }
  if (value.creative !== undefined) {
    const item = shape(value.creative, ['task', 'coreConflict', 'openingHook', 'reversal', 'endingHook', 'beats', 'targetDurationSec', 'sourceRange'], 'invalid-creative-info');
    for (const field of ['task', 'coreConflict', 'openingHook', 'reversal', 'endingHook', 'sourceRange']) {
      if (item[field] !== undefined && typeof item[field] !== 'string') fail('invalid-creative-info');
    }
    if (item.beats !== undefined && (!Array.isArray(item.beats) || item.beats.some((beat) => typeof beat !== 'string'))) fail('invalid-creative-info');
    if (item.targetDurationSec !== undefined && (typeof item.targetDurationSec !== 'number' || !Number.isFinite(item.targetDurationSec) || item.targetDurationSec < 0)) fail('invalid-creative-info');
  }
  if (value.assetRoster !== undefined) {
    shape(value.assetRoster, ['version', 'revision', 'characters', 'scenes', 'props', 'sourceFingerprints'], 'invalid-asset-roster');
    sameNormalized(value.assetRoster, normalizeEpisodeAssetRoster(value.assetRoster), 'invalid-asset-roster');
  }
  if (value.creationProfile !== undefined) {
    const normalized = normalizeCreationProfileSelection(value.creationProfile);
    if (!normalized) fail('invalid-creation-profile'); sameNormalized(value.creationProfile, normalized, 'invalid-creation-profile');
  }
  if (value.teamProfileOverride !== undefined) {
    const profile = shape(value.teamProfileOverride, ['version', 'name', 'roles', 'roleExecutors', 'readers', 'graph', 'maxCalls', 'maxTotalTokens', 'maxOutputChars'], 'invalid-team-profile');
    if (profile.graph !== undefined) validateTeamGraph(profile.graph);
    try { validateTeamReaders(profile.readers); }
    catch { fail('invalid-team-profile'); }
    const roles = shape(profile.roles, TEAM_ROLES, 'invalid-team-profile');
    // 仅允许旧资料缺少新增角色；不改写原资料，也不放过其他有损清洗。
    sameNormalized({ ...profile, roles: { director: '', storyboard: '', ...roles } }, normalizeTeamProfile(profile), 'invalid-team-profile');
  }
}
function canvasShape(document: Pick<CanvasDocument, 'nodes' | 'edges' | 'groups'>): void {
  const ids = (values: unknown[]): Set<string> => {
    const result = new Set<string>();
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-canvas-collection');
      const id = (value as Record<string, unknown>).id; assertId(id);
      if (result.has(id)) fail('duplicate-canvas-identity'); result.add(id);
    }
    return result;
  };
  const nodeIds = ids(document.nodes); ids(document.edges); ids(document.groups);
  for (const value of document.edges) {
    const edge = value as Record<string, unknown>;
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string' || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) fail('dangling-canvas-edge');
  }
  for (const value of document.groups) {
    const group = value as Record<string, unknown>;
    if (!Array.isArray(group.nodeIds) || group.nodeIds.some((id) => typeof id !== 'string' || !nodeIds.has(id))) fail('dangling-canvas-group');
  }
}
/** 导入/复制/恢复复用业务字段规则，拒绝不完整聚合；旧引用只能以原值保留。 */
export function validateProjectModelTransferAggregate(input: ProjectModelTransferAggregate,
  previous?: ProjectModelTransferAggregate): ProjectModelTransferAggregate {
  const next = data(input);
  shape(next, ['project', 'content', 'episodes', 'episodeContents', 'canvases', 'previews', 'bindings'], 'invalid-transfer-aggregate');
  const project = next.project, contents = next.content;
  shape(project, ['id', 'name', 'kind', 'createdAt', 'updatedAt', 'epoch', 'dataFolder', 'storageRootRef',
    'storageBindings', 'defaultSettings', 'lastOpenedCanvasId'], 'invalid-transfer-project');
  assertId(project.id);
  if (!['standalone', 'series'].includes(project.kind) || typeof project.name !== 'string' || !project.name.trim()
    || project.name.length > 256 || !Array.isArray(project.storageBindings)) fail('invalid-transfer-project');
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
  for (const value of [project.createdAt, project.updatedAt, project.epoch]) if (!integer(value)) fail('invalid-transfer-version');
  portableReference(project.dataFolder); assertId(project.storageRootRef);
  const roots = new Set<string>();
  for (const root of project.storageBindings) {
    shape(root, ['rootRef', 'folderName', 'sourceRecordIds', 'source'], 'invalid-storage-binding');
    assertId(root.rootRef); portableReference(root.folderName);
    if (roots.has(root.rootRef) || !['legacy-folder-rule', 'project-managed'].includes(root.source)
      || !Array.isArray(root.sourceRecordIds) || root.sourceRecordIds.some((id) => !identity(id))) fail('invalid-storage-binding');
    roots.add(root.rootRef);
  }
  if (!roots.has(project.storageRootRef)) fail('missing-storage-binding');
  if (project.defaultSettings) persistedStyle(project.defaultSettings, previous?.project.defaultSettings);
  shape(contents, ['projectId', 'originalWork', 'script', 'storyGraph', 'dramaAssets', 'standaloneCreative', 'revisions'], 'invalid-project-content');
  if (contents.projectId !== project.id) fail('broken-project-content');
  shape(contents.revisions, ['source', 'script', 'storyGraph', 'assets'], 'invalid-project-content');
  if (Object.values(contents.revisions).length !== 4 || Object.values(contents.revisions).some((value) => !integer(value))) fail('invalid-transfer-version');
  if (contents.script !== undefined && typeof contents.script !== 'string') fail('invalid-project-script');
  if (contents.originalWork) {
    shape(contents.originalWork, ['fileName', 'relativePath', 'addedAt'], 'invalid-source-file-reference');
    portableReference(contents.originalWork.relativePath);
    if (contents.originalWork.fileName !== contents.originalWork.relativePath.split('/').at(-1)
      || !integer(contents.originalWork.addedAt)) fail('invalid-source-file-reference');
  }
  if (contents.storyGraph) sameNormalized(contents.storyGraph, normalizeStoryGraph(contents.storyGraph), 'invalid-story-graph');
  if (contents.dramaAssets) {
    sameNormalized(contents.dramaAssets, normalizeDramaAssetLibrary(contents.dramaAssets), 'invalid-drama-assets');
    canvasReferences(contents.dramaAssets, previous?.content.dramaAssets);
  }
  const creative = (value: EpisodeContent | NonNullable<ProjectContent['standaloneCreative']>, extra: string[]) => {
    shape(value, ['outline', 'script', 'scriptFile', 'creative', 'assetRoster', 'revision', 'storageRootRef', ...extra], 'invalid-transfer-creative');
    if (!integer(value.revision) || !roots.has(value.storageRootRef)) fail('invalid-transfer-creative');
    creativeFields(value as unknown as Record<string, unknown>);
  };
  if (contents.standaloneCreative) {
    if (project.kind !== 'standalone') fail('series-has-standalone-content');
    creative(contents.standaloneCreative, ['creationProfile', 'teamProfileOverride']);
  }
  if (![next.episodes, next.episodeContents, next.canvases, next.previews, next.bindings].every(Array.isArray)) fail('invalid-transfer-collections');
  const episodeIds = new Set<string>(), canvasIds = new Set<string>(), order = new Set<number>();
  for (const episode of next.episodes) {
    shape(episode, ['id', 'projectId', 'canvasId', 'name', 'orderRank', 'displayNo', 'createdAt', 'updatedAt', 'epoch', 'revision',
      'settingsPolicy', 'creationProfile', 'teamProfileOverride'], 'invalid-transfer-episode');
    assertId(episode.id); assertId(episode.canvasId);
    if (episode.projectId !== project.id || episodeIds.has(episode.id) || order.has(episode.orderRank)
      || typeof episode.name !== 'string' || !episode.name.trim()
      || ![episode.orderRank, episode.createdAt, episode.updatedAt, episode.epoch, episode.revision].every(integer)
      || episode.displayNo !== undefined && (!integer(episode.displayNo) || episode.displayNo < 1)) fail('invalid-transfer-episode');
    assertProjectModelSettingsPolicy(episode.settingsPolicy);
    const oldPolicy = previous?.episodes.find((item) => item.id === episode.id)?.settingsPolicy;
    if (episode.settingsPolicy.mode === 'legacy-pinned') persistedStyle(episode.settingsPolicy.snapshot,
      oldPolicy?.mode === 'legacy-pinned' ? oldPolicy.snapshot : undefined);
    canvasReferences(episode.settingsPolicy, oldPolicy);
    creativeFields({ creationProfile: episode.creationProfile, teamProfileOverride: episode.teamProfileOverride });
    episodeIds.add(episode.id); order.add(episode.orderRank);
  }
  for (const canvas of next.canvases) {
    shape(canvas, ['id', 'projectId', 'episodeId', 'storageRootRef', 'nodes', 'edges', 'groups', 'epoch', 'revision', 'revisionScope'], 'invalid-transfer-canvas');
    assertId(canvas.id);
    if (canvasIds.has(canvas.id) || canvas.projectId !== project.id || !roots.has(canvas.storageRootRef)
      || !integer(canvas.epoch) || !integer(canvas.revision) || !['project', 'global'].includes(canvas.revisionScope)
      || ![canvas.nodes, canvas.edges, canvas.groups].every(Array.isArray)) fail('invalid-transfer-canvas');
    const target = next.episodes.find((episode) => episode.canvasId === canvas.id);
    if (project.kind === 'series' ? !target || canvas.episodeId !== target.id : canvas.episodeId !== null) fail('broken-canvas-membership');
    canvasShape(canvas); canvasReferences(canvas, previous?.canvases.find((item) => item.id === canvas.id)); canvasIds.add(canvas.id);
  }
  if (project.kind === 'standalone' ? episodeIds.size !== 0 || canvasIds.size !== 1
    : canvasIds.size !== episodeIds.size || next.episodes.some((episode) => !canvasIds.has(episode.canvasId))) fail('broken-transfer-membership');
  const contentIds = new Set<string>();
  for (const content of next.episodeContents) {
    if (!episodeIds.has(content.episodeId) || contentIds.has(content.episodeId)) fail('broken-episode-content');
    creative(content, ['episodeId']); contentIds.add(content.episodeId);
  }
  if (contentIds.size !== episodeIds.size) fail('missing-episode-content');
  const previewIds = new Set<string>();
  for (const preview of next.previews) {
    shape(preview, ['canvasId', 'snapshot', 'updatedAt'], 'invalid-canvas-preview');
    if (!canvasIds.has(preview.canvasId) || previewIds.has(preview.canvasId) || typeof preview.snapshot !== 'string'
      || !integer(preview.updatedAt)) fail('invalid-canvas-preview');
    previewIds.add(preview.canvasId);
  }
  const bindingKeys = new Set<string>();
  for (const binding of next.bindings) {
    shape(binding, ['namespace', 'legacyId', 'projectId', 'episodeId', 'canvasId', 'storageRootRef', 'sourceEpoch', 'retired', 'retiredAt'], 'invalid-legacy-binding');
    assertId(binding.legacyId);
    const key = JSON.stringify([binding.namespace, binding.legacyId]);
    if (bindingKeys.has(key) || !['legacy-root', 'legacy-episode', 'legacy-canvas'].includes(binding.namespace)
      || binding.projectId !== project.id || !roots.has(binding.storageRootRef) || !integer(binding.sourceEpoch)
      || binding.retired !== undefined && binding.retired !== true
      || binding.retiredAt !== undefined && !integer(binding.retiredAt)
      || !binding.retired && (binding.episodeId !== undefined && !episodeIds.has(binding.episodeId)
        || binding.canvasId !== undefined && !canvasIds.has(binding.canvasId))) fail('invalid-legacy-binding');
    bindingKeys.add(key);
  }
  if (project.lastOpenedCanvasId !== undefined && !canvasIds.has(project.lastOpenedCanvasId)) fail('invalid-last-opened-canvas');
  return next;
}
