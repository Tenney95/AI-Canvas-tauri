/** P3 只供显式隔离fixture业务。仅访问同一组新表，不回退或改写旧projects。 */
import type {
  CanvasDocument, CanvasPreview, EpisodeContent, EpisodeRecord, LegacyProjectBinding,
  ProjectContent, ProjectRecord, ProjectExpectedContext,
} from '../../types/project';
import type { ProjectSettings } from '../../types';
import type { ProjectModelTransferAggregate } from '../../types/projectModelTransfer';
import {
  PROJECT_MODEL_BUSINESS_FIXTURE_KEY,
  type ProjectModelBusinessReadOptions, type ProjectModelBusinessSelection, type ProjectModelBusinessTombstone,
  type ProjectModelCanvasSave, type ProjectModelContentSave, type ProjectModelConvertStandalone,
  type ProjectModelCreateEpisode, type ProjectModelDeleteEpisode, type ProjectModelDeleteProject,
  type ProjectModelEpisodeOrder, type ProjectModelEpisodeSave, type ProjectModelEpisodeSettingsUpdate,
  type ProjectModelFixtureBusinessSession, type ProjectModelProjectMutation, type ProjectModelStored,
} from '../../types/projectModelBusiness';
import { PROJECT_MODEL_ACTIVE_MARKER_KEY, PROJECT_MODEL_SOURCE_FREEZE_KEY } from '../../types/projectModelJournal';
import type { ProjectModelSourceFreeze, ProjectModelStagingJournal } from '../../types/projectModelJournal';
import { createProjectModelStagingRepository, projectModelSourceToken } from './projectModelStagingRepository';
import { assertProjectModelProjectSettings, assertProjectModelSettingsPolicy } from '../projectModelSettings';
import { normalizeProjectTextFileReference } from '../../utils/manuscriptFileReference';
import { assertNoProjectModelCredentials } from '../projectModelBackup';
import { normalizeStoryGraph } from '../storyGraphService';
import { normalizeEpisodeAssetRoster } from '../../types/episodeAssets';
import { normalizeDramaAssetLibrary } from '../../types/dramaAssets';
import { normalizeCreationProfileSelection } from '../creationProfiles/creationProfileManifest';
import { normalizeTeamProfile } from '../chat/teams/teamProfileService';
import { validateTeamGraph } from '../chat/teams/teamGraphService';

const META = 'metadata', JOURNALS = 'projectModelMigrations';
const TABLES = ['projectRoots', 'projectContents', 'episodes', 'episodeContents', 'canvasDocuments', 'canvasPreviews', 'legacyProjectBindings'];
function fail(code: string): never { throw new Error('项目模型隔离业务未完成：' + code); }
const increment = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return fail('revision-overflow');
  return value + 1;
};
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 256 && ![...value].some((character) => character.charCodeAt(0) < 32);
const operation = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
function assertId(value: unknown): asserts value is string { if (!identity(value)) fail('invalid-identity'); }
function clock(now?: number): number {
  const result = now ?? Date.now();
  if (!Number.isSafeInteger(result) || result < 0) fail('invalid-time');
  return result;
}
function data<T>(value: T): T {
  projectModelSourceToken(value); assertNoProjectModelCredentials(value); return structuredClone(value);
}
function captured<T extends { signal?: AbortSignal }>(input: T): T {
  const { signal, ...fields } = input;
  return { ...data(fields), signal } as T;
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
    const profile = shape(value.teamProfileOverride, ['version', 'name', 'roles', 'roleExecutors', 'graph', 'maxCalls', 'maxTotalTokens', 'maxOutputChars'], 'invalid-team-profile');
    if (profile.graph !== undefined) validateTeamGraph(profile.graph);
    sameNormalized(profile, normalizeTeamProfile(profile), 'invalid-team-profile');
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
function request<T>(item: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { item.onsuccess = () => resolve(item.result); item.onerror = () => reject(item.error); });
}
function transaction<T>(database: IDBDatabase, names: string[], write: boolean,
  work: (tx: IDBTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const tx = database.transaction([...new Set([META, ...names])], write ? 'readwrite' : 'readonly');
  let result: T;
  let failure: unknown;
  const abort = () => { failure = new DOMException('隔离业务已取消', 'AbortError'); try { tx.abort(); } catch { /* 已提交 */ } };
  signal?.addEventListener('abort', abort, { once: true });
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(result); };
    tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? new Error('隔离业务事务失败')); };
    void work(tx).then((value) => { result = value; }).catch((error: unknown) => {
      failure = error; try { tx.abort(); } catch { cleanup(); reject(error); }
    });
    if (signal?.aborted) abort();
  });
}
function assertSession(value: unknown): asserts value is ProjectModelFixtureBusinessSession {
  const marker = value as ProjectModelFixtureBusinessSession | undefined;
  if (!marker || marker.id !== PROJECT_MODEL_BUSINESS_FIXTURE_KEY || !operation(marker.operationId)
    || !operation(marker.sessionId) || !Number.isSafeInteger(marker.generation) || marker.generation < 1
    || !Number.isSafeInteger(marker.revision) || marker.revision < 0 || typeof marker.dirty !== 'boolean'
    || !Number.isSafeInteger(marker.sourceJournalSequence) || marker.sourceJournalSequence < 0
    || !/^[a-f0-9]{64}$/.test(marker.sourceDigest) || !/^[a-f0-9]{64}$/.test(marker.targetManifestDigest)
    || Object.keys(marker).some((field) => !['id', 'operationId', 'generation', 'sessionId', 'sourceJournalSequence',
      'sourceDigest', 'targetManifestDigest', 'revision', 'dirty'].includes(field))) fail('invalid-business-marker');
}

/** 归档聚合事务与普通业务使用同一个fixture权威，不另签活跃模型授权。 */
export async function readProjectModelBusinessMarker(tx: IDBTransaction,
  expected: ProjectModelFixtureBusinessSession): Promise<ProjectModelFixtureBusinessSession> {
  if (await request(tx.objectStore(META).get(PROJECT_MODEL_ACTIVE_MARKER_KEY)) !== undefined) fail('formal-model-present');
  const marker: unknown = await request(tx.objectStore(META).get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY));
  assertSession(marker);
  if (marker.sessionId !== expected.sessionId || marker.operationId !== expected.operationId
    || marker.generation !== expected.generation) fail('stale-business-session');
  const frozen = await request(tx.objectStore(META).get(PROJECT_MODEL_SOURCE_FREEZE_KEY)) as ProjectModelSourceFreeze | undefined;
  if (!frozen || frozen.operationId !== marker.operationId || frozen.generation !== marker.generation
    || frozen.state !== 'frozen' || frozen.sourceDigest !== marker.sourceDigest) fail('source-not-frozen');
  return marker;
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

/** P2 ready本身没有业务可写权威；显式fixture session才开放这一组新表。 */
export async function beginProjectModelFixtureBusinessSession(database: IDBDatabase, input: {
  operationId: string; generation: number; sessionId?: string; signal?: AbortSignal;
}): Promise<ProjectModelFixtureBusinessSession> {
  input = captured(input);
  const staging = createProjectModelStagingRepository(database); // 同时拒绝正式库/错误schema。
  if (!operation(input.operationId) || !Number.isSafeInteger(input.generation) || input.generation < 1
    || input.sessionId !== undefined && !operation(input.sessionId)) fail('invalid-session-input');
  const existing = await transaction(database, [JOURNALS], false, async (tx) => {
    const marker: unknown = await request(tx.objectStore(META).get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY));
    if (marker === undefined) return undefined;
    assertSession(marker);
    if (await request(tx.objectStore(META).get(PROJECT_MODEL_ACTIVE_MARKER_KEY)) !== undefined) fail('formal-model-present');
    const journal = await request(tx.objectStore(JOURNALS).get(marker.operationId)) as ProjectModelStagingJournal | undefined;
    const frozen = await request(tx.objectStore(META).get(PROJECT_MODEL_SOURCE_FREEZE_KEY)) as ProjectModelSourceFreeze | undefined;
    if (!journal || journal.stage !== 'ready' || journal.generation !== marker.generation || journal.sequence !== marker.sourceJournalSequence
      || !frozen || frozen.state !== 'frozen' || frozen.generation !== marker.generation || frozen.operationId !== marker.operationId
      || frozen.sourceDigest !== journal.sourceDigest || marker.sourceDigest !== journal.sourceDigest
      || marker.targetManifestDigest !== journal.manifestDigest) fail('business-session-conflict');
    return marker;
  }, input.signal);
  if (existing !== undefined) {
    assertSession(existing);
    if (existing.operationId !== input.operationId || existing.generation !== input.generation
      || input.sessionId !== undefined && existing.sessionId !== input.sessionId) fail('business-session-conflict');
    return existing;
  }
  const verified = await staging.verify({ operationId: input.operationId, signal: input.signal });
  if (verified.generation !== input.generation || verified.stage !== 'ready') fail('migration-not-ready');
  const marker: ProjectModelFixtureBusinessSession = {
    id: PROJECT_MODEL_BUSINESS_FIXTURE_KEY, operationId: input.operationId, generation: input.generation,
    sessionId: input.sessionId ?? crypto.randomUUID(), revision: 0, dirty: false, sourceJournalSequence: verified.sequence,
    sourceDigest: verified.sourceDigest, targetManifestDigest: verified.manifestDigest,
  };
  return transaction(database, [JOURNALS], true, async (tx) => {
    if (await request(tx.objectStore(META).get(PROJECT_MODEL_ACTIVE_MARKER_KEY)) !== undefined) fail('formal-model-present');
    if (await request(tx.objectStore(META).get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY)) !== undefined) fail('business-session-conflict');
    const journal = await request(tx.objectStore(JOURNALS).get(input.operationId)) as ProjectModelStagingJournal | undefined;
    if (!journal || journal.stage !== 'ready' || journal.generation !== marker.generation || journal.sequence !== marker.sourceJournalSequence
      || journal.sourceDigest !== marker.sourceDigest || journal.manifestDigest !== marker.targetManifestDigest) fail('migration-changed');
    const frozen = await request(tx.objectStore(META).get(PROJECT_MODEL_SOURCE_FREEZE_KEY)) as ProjectModelSourceFreeze | undefined;
    if (!frozen || frozen.operationId !== marker.operationId || frozen.generation !== marker.generation || frozen.state !== 'frozen') fail('source-not-frozen');
    await request(tx.objectStore(META).add(marker)); return marker;
  }, input.signal);
}

export function createProjectModelBusinessRepository(database: IDBDatabase, session: ProjectModelFixtureBusinessSession) {
  createProjectModelStagingRepository(database); assertSession(session); session = data(session);
  const generation = session.generation;
  const key = (id: string): IDBValidKey => [generation, id];
  const generationRange = () => IDBKeyRange.bound([generation], [generation, []]);
  const ownerRange = (id: string) => IDBKeyRange.bound([generation, id], [generation, id, []]);
  const stored = <T extends object>(value: T): ProjectModelStored<T> => ({ ...value, generation, operationId: session.operationId });
  async function guard(tx: IDBTransaction): Promise<ProjectModelFixtureBusinessSession> {
    return readProjectModelBusinessMarker(tx, session);
  }
  async function touch(tx: IDBTransaction, marker: ProjectModelFixtureBusinessSession): Promise<void> {
    await request(tx.objectStore(META).put({ ...marker, revision: increment(marker.revision), dirty: true }));
  }
  async function root(tx: IDBTransaction, projectId: string, expectedEpoch?: number): Promise<ProjectModelStored<ProjectRecord>> {
    assertId(projectId);
    const project = await request(tx.objectStore('projectRoots').get(key(projectId))) as ProjectModelStored<ProjectRecord> | undefined;
    if (!project || project.id !== projectId || project.generation !== generation || project.operationId !== session.operationId
      || !['standalone', 'series'].includes(project.kind)) fail('project-unavailable');
    if (expectedEpoch !== undefined && project.epoch !== expectedEpoch) fail('project-version-conflict');
    return project;
  }
  async function episodes(tx: IDBTransaction, projectId: string): Promise<Array<ProjectModelStored<EpisodeRecord>>> {
    const list = await request<Array<ProjectModelStored<EpisodeRecord>>>(tx.objectStore('episodes').index('projectId_orderRank').getAll(ownerRange(projectId)));
    const ranks = new Set<number>();
    for (const item of list) {
      if (item.projectId !== projectId || item.generation !== generation || item.operationId !== session.operationId
        || !identity(item.id) || !identity(item.canvasId) || !Number.isSafeInteger(item.orderRank) || item.orderRank < 0
        || ranks.has(item.orderRank)) fail('broken-episode-membership');
      ranks.add(item.orderRank);
    }
    return list;
  }
  async function content(tx: IDBTransaction, projectId: string): Promise<ProjectModelStored<ProjectContent>> {
    const result = await request(tx.objectStore('projectContents').get(key(projectId))) as ProjectModelStored<ProjectContent> | undefined;
    if (!result || result.projectId !== projectId || result.generation !== generation || result.operationId !== session.operationId) fail('project-content-unavailable');
    return result;
  }
  async function episode(tx: IDBTransaction, projectId: string, episodeId: string, revision?: number): Promise<ProjectModelStored<EpisodeRecord>> {
    assertId(episodeId);
    const result = await request(tx.objectStore('episodes').get(key(episodeId))) as ProjectModelStored<EpisodeRecord> | undefined;
    if (!result || result.projectId !== projectId || result.id !== episodeId
      || result.generation !== generation || result.operationId !== session.operationId) fail('episode-unavailable');
    if (revision !== undefined && result.revision !== revision) fail('episode-version-conflict');
    return result;
  }
  async function episodeContent(tx: IDBTransaction, episodeId: string): Promise<ProjectModelStored<EpisodeContent>> {
    const result = await request(tx.objectStore('episodeContents').get(key(episodeId))) as ProjectModelStored<EpisodeContent> | undefined;
    if (!result || result.episodeId !== episodeId || result.generation !== generation || result.operationId !== session.operationId) {
      fail('episode-content-unavailable');
    }
    return result;
  }
  async function canvas(tx: IDBTransaction, projectId: string, canvasId: string): Promise<ProjectModelStored<CanvasDocument>> {
    assertId(canvasId);
    const result = await request(tx.objectStore('canvasDocuments').get(key(canvasId))) as ProjectModelStored<CanvasDocument> | undefined;
    if (!result || result.projectId !== projectId || result.id !== canvasId
      || result.generation !== generation || result.operationId !== session.operationId) fail('canvas-unavailable');
    const project = await root(tx, projectId), list = await membership(tx, project);
    if (project.kind === 'standalone' && result.episodeId !== null
      || project.kind === 'series' && !list.some((item) => item.id === result.episodeId && item.canvasId === result.id)) fail('broken-canvas-membership');
    return result;
  }
  /** 只读索引键核对完整关系集合，不为导航克隆所有Canvas正文。 */
  async function membership(tx: IDBTransaction, project: ProjectModelStored<ProjectRecord>): Promise<Array<ProjectModelStored<EpisodeRecord>>> {
    const list = await episodes(tx, project.id);
    const canvasKeys = await request(tx.objectStore('canvasDocuments').index('projectId').getAllKeys([generation, project.id]));
    const canvasIds = new Set(canvasKeys.map((value) => {
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== generation || !identity(value[1])) fail('broken-canvas-membership');
      return value[1] as string;
    }));
    if (project.kind === 'standalone') {
      if (list.length || canvasIds.size !== 1) fail('broken-standalone-membership');
    } else {
      if (canvasIds.size !== list.length || new Set(list.map((item) => item.canvasId)).size !== list.length
        || list.some((item) => !canvasIds.has(item.canvasId))) fail('broken-canvas-membership');
      for (const item of list) {
        const reverse = await request(tx.objectStore('canvasDocuments').index('episodeId').getAllKeys([generation, item.id]));
        if (reverse.length !== 1 || !Array.isArray(reverse[0]) || reverse[0][1] !== item.canvasId) fail('broken-canvas-membership');
      }
    }
    return list;
  }
  const tombstoneId = (kind: ProjectModelBusinessTombstone['kind'], id: string) =>
    'project-model-business-tombstone:' + session.operationId + ':' + kind + ':' + id;
  async function tombstone(tx: IDBTransaction, kind: ProjectModelBusinessTombstone['kind'], projectId: string,
    targetId: string, epoch: number, now: number): Promise<void> {
    await request(tx.objectStore(META).add({ id: tombstoneId(kind, targetId), kind, projectId, targetId,
      generation, operationId: session.operationId, previousEpoch: epoch, epoch: increment(epoch), deletedAt: now } satisfies ProjectModelBusinessTombstone));
  }
  async function retireBindings(tx: IDBTransaction, projectId: string, canvasIds: Set<string>, episodeIds: Set<string>, now: number, all = false): Promise<void> {
    const bindings = await request(tx.objectStore('legacyProjectBindings').index('projectId').getAll([generation, projectId])) as Array<ProjectModelStored<LegacyProjectBinding>>;
    for (const binding of bindings) if (all || binding.canvasId && canvasIds.has(binding.canvasId) || binding.episodeId && episodeIds.has(binding.episodeId)) {
      if (binding.namespace === 'legacy-root' && !all) continue;
      await request(tx.objectStore('legacyProjectBindings').put({ ...binding, retired: true, retiredAt: now }));
    }
  }
  async function assertNewId(tx: IDBTransaction, table: string, kind: 'episode' | 'canvas', id: string): Promise<void> {
    assertId(id);
    if (await request(tx.objectStore(table).get(key(id))) !== undefined
      || await request(tx.objectStore(META).get(tombstoneId(kind, id))) !== undefined) fail('identity-already-used');
  }
  async function selection(tx: IDBTransaction, project: ProjectModelStored<ProjectRecord>, explicitCanvasId?: string): Promise<ProjectModelBusinessSelection> {
    const list = await membership(tx, project);
    let selected: ProjectModelStored<CanvasDocument> | undefined;
    if (project.kind === 'series') {
      const requested = explicitCanvasId ?? project.lastOpenedCanvasId;
      const target = list.find((item) => item.canvasId === requested) ?? (explicitCanvasId === undefined ? list[0] : undefined);
      if (explicitCanvasId !== undefined && !target) fail('canvas-not-in-project');
      if (target) {
        selected = await canvas(tx, project.id, target.canvasId);
        if (selected.episodeId !== target.id) fail('broken-canvas-membership');
      }
    } else {
      if (list.length) fail('standalone-has-episodes');
      const matches = await request(tx.objectStore('canvasDocuments').index('projectId').getAllKeys([generation, project.id]));
      if (matches.length !== 1) fail('broken-standalone-membership');
      if (matches.length) {
        selected = await canvas(tx, project.id, (matches[0] as IDBValidKey[])[1] as string);
        if (!selected || selected.episodeId !== null) fail('broken-canvas-membership');
      }
      if (explicitCanvasId !== undefined && selected?.id !== explicitCanvasId) fail('canvas-not-in-project');
    }
    return { activeProjectId: project.id, activeCanvasId: selected?.id ?? null, activeEpisodeId: selected?.episodeId ?? null,
      contextKind: selected ? 'canvas' : 'project', projectEpoch: project.epoch, generation,
      ...(selected ? { canvasEpoch: selected.epoch, canvasRevision: selected.revision } : {}) };
  }
  function read<T>(tables: string[], work: (tx: IDBTransaction, marker: ProjectModelFixtureBusinessSession) => Promise<T>, options: ProjectModelBusinessReadOptions = {}) {
    return transaction(database, tables, false, async (tx) => work(tx, await guard(tx)), options.signal);
  }
  async function write<T, I extends ProjectModelProjectMutation>(tables: string[], input: I,
    work: (tx: IDBTransaction, marker: ProjectModelFixtureBusinessSession, project: ProjectModelStored<ProjectRecord>, now: number, fixed: I) => Promise<T>) {
    input = captured(input);
    if (!Number.isSafeInteger(input.expectedProjectEpoch) || input.expectedProjectEpoch < 0) fail('invalid-project-version');
    const now = clock(input.now);
    return transaction(database, ['projectRoots', ...tables], true, async (tx) => {
      const marker = await guard(tx), project = await root(tx, input.projectId, input.expectedProjectEpoch);
      const result = await work(tx, marker, project, now, input); await touch(tx, marker); return result;
    }, input.signal);
  }
  return {
    access: 'fixture-business' as const,
    readSession: (options?: ProjectModelBusinessReadOptions) => read([], async (_tx, marker) => marker, options),
    // 退役项目仍可读原alias，只是历史定位，不授权默认DB27执行器写入fixture。
    listLegacyBindings: (projectId: string, options?: ProjectModelBusinessReadOptions) => read(['legacyProjectBindings'], async (tx) => {
      assertId(projectId);
      return request<ProjectModelStored<LegacyProjectBinding>[]>(tx.objectStore('legacyProjectBindings').index('projectId').getAll([generation, projectId]));
    }, options),
    readExpectedContext: (target: { kind: 'global' } | { kind: 'project'; projectId: string }
      | { kind: 'canvas'; projectId: string; canvasId: string } | { kind: 'episode'; projectId: string; episodeId: string },
    options?: ProjectModelBusinessReadOptions): Promise<ProjectExpectedContext> => read<ProjectExpectedContext>(['projectRoots', 'episodes', 'canvasDocuments'], async (tx, marker) => {
      if (target.kind === 'global') return { kind: 'global', schemaVersion: 2, modelGeneration: generation, catalogRevision: marker.revision };
      const project = await root(tx, target.projectId);
      const common = { schemaVersion: 2 as const, modelGeneration: generation, projectId: project.id, projectEpoch: project.epoch };
      if (target.kind === 'project') return { kind: 'project', ...common };
      if (target.kind === 'episode') {
        const result = await episode(tx, project.id, target.episodeId);
        const linkedCanvas = await canvas(tx, project.id, result.canvasId);
        if (project.kind !== 'series' || linkedCanvas.episodeId !== result.id) fail('episode-unavailable');
        return { kind: 'episode', ...common, episodeId: result.id, episodeRevision: result.revision };
      }
      const result = await canvas(tx, project.id, target.canvasId);
      return { kind: 'canvas', ...common, canvasId: result.id, episodeId: result.episodeId, canvasEpoch: result.epoch, canvasRevision: result.revision };
    }, options),
    listProjects: (options?: ProjectModelBusinessReadOptions) => read(['projectRoots'], async (tx) => {
      const values = await request<ProjectModelStored<ProjectRecord>[]>(tx.objectStore('projectRoots').getAll(generationRange()));
      return values.map(({ id, name, kind, createdAt, updatedAt, epoch, lastOpenedCanvasId }) =>
        ({ id, name, kind, createdAt, updatedAt, epoch, lastOpenedCanvasId }));
    }, options),
    listEpisodes: (projectId: string, options?: ProjectModelBusinessReadOptions) => read(['projectRoots', 'episodes'], async (tx) => {
      await root(tx, projectId);
      return (await episodes(tx, projectId)).map(({ id, projectId: ownerId, canvasId, name, orderRank, displayNo, createdAt, updatedAt, epoch, revision }) =>
        ({ id, projectId: ownerId, canvasId, name, orderRank, displayNo, createdAt, updatedAt, epoch, revision }));
    }, options),
    readEpisode: (projectId: string, episodeId: string, options?: ProjectModelBusinessReadOptions) => read(['projectRoots', 'episodes'], async (tx) => {
      await root(tx, projectId); return episode(tx, projectId, episodeId);
    }, options),
    readProject: (projectId: string, options?: ProjectModelBusinessReadOptions) => read(['projectRoots'], async (tx, marker) =>
      ({ project: await root(tx, projectId), sessionRevision: marker.revision }), options),
    readProjectContent: (projectId: string, options?: ProjectModelBusinessReadOptions) => read(['projectRoots', 'projectContents'], async (tx) => {
      await root(tx, projectId); return content(tx, projectId);
    }, options),
    readEpisodeContent: (projectId: string, episodeId: string, options?: ProjectModelBusinessReadOptions) => read(['projectRoots', 'episodes', 'episodeContents'], async (tx) => {
      await root(tx, projectId); await episode(tx, projectId, episodeId);
      return episodeContent(tx, episodeId);
    }, options),
    readCanvas: (projectId: string, canvasId: string, options?: ProjectModelBusinessReadOptions) => read(['projectRoots', 'episodes', 'canvasDocuments'], async (tx) => {
      await root(tx, projectId); return canvas(tx, projectId, canvasId);
    }, options),
    readPreview: (projectId: string, canvasId: string, options?: ProjectModelBusinessReadOptions) => read(['projectRoots', 'episodes', 'canvasDocuments', 'canvasPreviews'], async (tx) => {
      assertId(canvasId);
      const project = await root(tx, projectId), list = await membership(tx, project);
      if (project.kind === 'series' && !list.some((item) => item.canvasId === canvasId)) fail('canvas-not-in-project');
      if (project.kind === 'standalone') {
        const own = await request(tx.objectStore('canvasDocuments').index('projectId').getKey([generation, projectId]));
        if (!Array.isArray(own) || own[1] !== canvasId) fail('canvas-not-in-project');
      }
      return request<ProjectModelStored<CanvasPreview> | undefined>(tx.objectStore('canvasPreviews').get(key(canvasId)));
    }, options),
    openProject: (projectId: string, canvasId?: string, options?: ProjectModelBusinessReadOptions) => read(['projectRoots', 'episodes', 'canvasDocuments'], async (tx) =>
      selection(tx, await root(tx, projectId), canvasId), options),
    selectProject: (input: ProjectModelProjectMutation & { canvasId?: string }) => write(['episodes', 'canvasDocuments'], input, async (tx, _marker, project, _now, input) => {
      const selected = await selection(tx, project, input.canvasId);
      const next = { ...project }; if (selected.activeCanvasId) next.lastOpenedCanvasId = selected.activeCanvasId; else delete next.lastOpenedCanvasId;
      await request(tx.objectStore('projectRoots').put(next)); return selected;
    }),
    saveCanvas: async (input: ProjectModelCanvasSave) => {
      const document = data(input.document);
      if (!Array.isArray(document.nodes) || !Array.isArray(document.edges) || !Array.isArray(document.groups)
        || Object.keys(document).some((field) => !['nodes', 'edges', 'groups'].includes(field))) fail('invalid-canvas-patch');
      canvasShape(document);
      if (input.preview !== undefined && input.preview !== null
        && (typeof input.preview.snapshot !== 'string' || Object.keys(input.preview).some((field) => field !== 'snapshot'))) fail('invalid-canvas-preview');
      return write(['episodes', 'canvasDocuments', 'canvasPreviews'], input, async (tx, _marker, project, now, input) => {
        const before = await canvas(tx, project.id, input.canvasId);
        if (before.epoch !== input.expectedCanvasEpoch || before.revision !== input.expectedCanvasRevision) fail('canvas-version-conflict');
        canvasReferences(document, before);
        const next = { ...before, ...document, revision: increment(before.revision) };
        await request(tx.objectStore('canvasDocuments').put(next));
        if (input.preview === null) await request(tx.objectStore('canvasPreviews').delete(key(before.id)));
        else if (input.preview) await request(tx.objectStore('canvasPreviews').put(stored({ canvasId: before.id, snapshot: input.preview.snapshot, updatedAt: now })));
        await request(tx.objectStore('projectRoots').put({ ...project, updatedAt: now })); return next;
      });
    },
    saveEpisodeContent: async (input: ProjectModelEpisodeSave) => {
      const patch = data(input.patch);
      if (Object.keys(patch).some((field) => !['outline', 'script', 'scriptFile', 'creative', 'assetRoster'].includes(field))) fail('invalid-episode-patch');
      creativeFields(patch);
      return write(['episodes', 'episodeContents'], input, async (tx, _marker, project, now, input) => {
        if (!Number.isSafeInteger(input.expectedEpisodeRevision) || input.expectedEpisodeRevision < 0) fail('invalid-episode-version');
        const target = await episode(tx, project.id, input.episodeId, input.expectedEpisodeRevision);
        const before = await episodeContent(tx, target.id);
        if (before.revision !== input.expectedContentRevision) fail('episode-content-version-conflict');
        const next = { ...before, ...patch, revision: increment(before.revision) };
        await request(tx.objectStore('episodeContents').put(next));
        await request(tx.objectStore('episodes').put({ ...target, revision: increment(target.revision), updatedAt: now }));
        await request(tx.objectStore('projectRoots').put({ ...project, updatedAt: now })); return next;
      });
    },
    saveProjectContent: async (input: ProjectModelContentSave) => {
      let value = data(input.value);
      if (input.domain === 'source' && input.value !== undefined) {
        shape(input.value, ['fileName', 'relativePath', 'addedAt'], 'invalid-source-file-reference');
        portableReference(input.value.relativePath);
        if (input.value.fileName !== input.value.relativePath.split('/').at(-1)
          || !Number.isSafeInteger(input.value.addedAt) || input.value.addedAt < 0) fail('invalid-source-file-reference');
      }
      if (input.domain === 'script' && value !== undefined && typeof value !== 'string') fail('invalid-project-script');
      if (input.domain === 'storyGraph' && value !== undefined) value = normalizeStoryGraph(value);
      if (input.domain === 'assets' && value !== undefined) {
        shape(value, ['version', 'lastExtract', 'lastViewedAt', 'characters', 'scenes', 'props'], 'invalid-drama-assets');
        sameNormalized(value, normalizeDramaAssetLibrary(value), 'invalid-drama-assets');
      }
      if (input.domain === 'standaloneCreative' && value !== undefined) {
        const details = shape(value, ['outline', 'script', 'scriptFile', 'creative', 'assetRoster', 'creationProfile', 'teamProfileOverride'], 'invalid-standalone-creative');
        creativeFields(details);
      }
      return write(['projectContents'], input, async (tx, _marker, project, now, input) => {
        const before = await content(tx, project.id);
        if (input.domain === 'standaloneCreative') {
          if (project.kind !== 'standalone' || (before.standaloneCreative?.revision ?? 0) !== input.expectedRevision) fail('project-content-version-conflict');
          const next = { ...before, standaloneCreative: { ...(value as NonNullable<ProjectContent['standaloneCreative']> | undefined),
            revision: increment(input.expectedRevision), storageRootRef: before.standaloneCreative?.storageRootRef ?? project.storageRootRef } };
          await request(tx.objectStore('projectContents').put(next));
          await request(tx.objectStore('projectRoots').put({ ...project, updatedAt: now })); return next;
        }
        const fields = { source: 'originalWork', script: 'script', storyGraph: 'storyGraph', assets: 'dramaAssets' } as const;
        if (!(input.domain in fields) || before.revisions[input.domain] !== input.expectedRevision) fail('project-content-version-conflict');
        if (input.domain === 'assets') canvasReferences(value, before.dramaAssets);
        const updatedValue = input.domain === 'storyGraph' && value !== undefined ? { ...normalizeStoryGraph(value), revision: increment(input.expectedRevision) } : value;
        const next = { ...before, [fields[input.domain]]: updatedValue, revisions: { ...before.revisions, [input.domain]: increment(input.expectedRevision) } };
        await request(tx.objectStore('projectContents').put(next));
        await request(tx.objectStore('projectRoots').put({ ...project, updatedAt: now })); return next;
      });
    },
    updateProject: async (input: ProjectModelProjectMutation & { name?: string; defaultSettings?: ProjectSettings }) => {
      if (input.defaultSettings !== undefined) shape(input.defaultSettings,
        ['visualStyle', 'promptSuffix', 'promptSuffixes', 'defaultModels', 'visionModelId', 'modelAutoRouting', 'generation'], 'invalid-project-settings');
      const settings = input.defaultSettings === undefined ? undefined : data(input.defaultSettings);
      if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256)) fail('invalid-name');
      return write([], input, async (tx, _marker, project, now, input) => {
        if (settings) persistedStyle(settings, project.defaultSettings);
        const next = { ...project, ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.defaultSettings === undefined ? {} : { defaultSettings: settings }), epoch: increment(project.epoch), updatedAt: now };
        await request(tx.objectStore('projectRoots').put(next)); return next;
      });
    },
    updateEpisodeSettings: async (input: ProjectModelEpisodeSettingsUpdate) => {
      const policy = data(input.policy);
      assertProjectModelSettingsPolicy(policy);
      return write(['episodes'], input, async (tx, _marker, project, now, input) => {
        if (!Number.isSafeInteger(input.expectedEpisodeRevision) || input.expectedEpisodeRevision < 0) fail('invalid-episode-version');
        const target = await episode(tx, project.id, input.episodeId, input.expectedEpisodeRevision);
        const priorReference = target.settingsPolicy.mode === 'legacy-pinned' ? target.settingsPolicy.snapshot.visualStyle?.styleReference
          : target.settingsPolicy.overrides.visualStyle?.styleReference?.op === 'set' ? target.settingsPolicy.overrides.visualStyle.styleReference.value : undefined;
        const prior = { visualStyle: { styleReference: priorReference } };
        if (policy.mode === 'legacy-pinned') persistedStyle(policy.snapshot, prior);
        else if (policy.overrides.visualStyle?.styleReference?.op === 'set') persistedStyle({ visualStyle: { styleReference: policy.overrides.visualStyle.styleReference.value } }, prior);
        const next = { ...target, settingsPolicy: policy, revision: increment(target.revision), updatedAt: now };
        await request(tx.objectStore('episodes').put(next));
        await request(tx.objectStore('projectRoots').put({ ...project, updatedAt: now })); return next;
      });
    },
    createEpisode: (input: ProjectModelCreateEpisode) => write(['episodes', 'episodeContents', 'canvasDocuments'], input, async (tx, _marker, project, now, input) => {
      if (project.kind !== 'series') fail('convert-standalone-first');
      await assertNewId(tx, 'episodes', 'episode', input.episodeId); await assertNewId(tx, 'canvasDocuments', 'canvas', input.canvasId);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256
        || input.displayNo !== undefined && (!Number.isSafeInteger(input.displayNo) || input.displayNo < 1)) fail('invalid-episode');
      const list = await membership(tx, project), rank = list.length ? increment(list[list.length - 1].orderRank) : 0;
      const created: EpisodeRecord = { id: input.episodeId, projectId: project.id, canvasId: input.canvasId, name: input.name.trim(),
        orderRank: rank, ...(input.displayNo === undefined ? {} : { displayNo: input.displayNo }), createdAt: now, updatedAt: now,
        epoch: 0, revision: 0, settingsPolicy: { mode: 'inherit', overrides: {} } };
      const createdCanvas: CanvasDocument = { id: input.canvasId, projectId: project.id, episodeId: created.id, storageRootRef: project.storageRootRef,
        nodes: [], edges: [], groups: [], epoch: 0, revision: 0, revisionScope: 'project' };
      await request(tx.objectStore('episodes').add(stored(created)));
      await request(tx.objectStore('episodeContents').add(stored({ episodeId: created.id, revision: 0, storageRootRef: project.storageRootRef })));
      await request(tx.objectStore('canvasDocuments').add(stored(createdCanvas)));
      await request(tx.objectStore('projectRoots').put({ ...project, epoch: increment(project.epoch), updatedAt: now })); return created;
    }),
    convertStandaloneToSeries: (input: ProjectModelConvertStandalone) => write(['projectContents', 'episodes', 'episodeContents', 'canvasDocuments', 'legacyProjectBindings'], input, async (tx, _marker, project, now, input) => {
      if (project.kind !== 'standalone' || (await episodes(tx, project.id)).length) fail('project-is-not-standalone');
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256
        || input.displayNo !== undefined && (!Number.isSafeInteger(input.displayNo) || input.displayNo < 1)) fail('invalid-episode');
      await assertNewId(tx, 'episodes', 'episode', input.episodeId);
      const canvases = await request(tx.objectStore('canvasDocuments').index('projectId').getAll([generation, project.id])) as Array<ProjectModelStored<CanvasDocument>>;
      if (canvases.length !== 1 || canvases[0].episodeId !== null) fail('standalone-canvas-unavailable');
      const current = canvases[0], shared = await content(tx, project.id), creative = shared.standaloneCreative;
      const created: EpisodeRecord = { id: input.episodeId, projectId: project.id, canvasId: current.id, name: input.name.trim(),
        orderRank: 0, ...(input.displayNo === undefined ? {} : { displayNo: input.displayNo }), createdAt: now, updatedAt: now,
        epoch: 0, revision: 0, settingsPolicy: { mode: 'legacy-pinned', snapshot: data(project.defaultSettings ?? {}) },
        ...(creative?.creationProfile === undefined ? {} : { creationProfile: creative.creationProfile }),
        ...(creative?.teamProfileOverride === undefined ? {} : { teamProfileOverride: creative.teamProfileOverride }) };
      const details: EpisodeContent = { episodeId: created.id, revision: creative?.revision ?? 0,
        storageRootRef: creative?.storageRootRef ?? project.storageRootRef,
        ...(creative ? { outline: creative.outline, script: creative.script, scriptFile: creative.scriptFile, creative: creative.creative, assetRoster: creative.assetRoster } : {}) };
      const nextShared = { ...shared }; delete nextShared.standaloneCreative;
      await request(tx.objectStore('projectContents').put(nextShared)); await request(tx.objectStore('episodes').add(stored(created)));
      await request(tx.objectStore('episodeContents').add(stored(details)));
      await request(tx.objectStore('canvasDocuments').put({ ...current, episodeId: created.id, epoch: increment(current.epoch) }));
      await request(tx.objectStore('projectRoots').put({ ...project, kind: 'series', epoch: increment(project.epoch), updatedAt: now, lastOpenedCanvasId: current.id }));
      const bindings = await request(tx.objectStore('legacyProjectBindings').index('canvasId').getAll([generation, current.id])) as Array<ProjectModelStored<LegacyProjectBinding>>;
      for (const binding of bindings) if (binding.namespace === 'legacy-canvas') {
        await request(tx.objectStore('legacyProjectBindings').put({ ...binding, episodeId: created.id }));
      }
      return created;
    }),
    reorderEpisodes: (input: ProjectModelEpisodeOrder) => write(['episodes'], input, async (tx, _marker, project, now, input) => {
      if (project.kind !== 'series' || !Array.isArray(input.expectedEpisodes) || !Array.isArray(input.orderedEpisodeIds)) fail('invalid-episode-order');
      const list = await episodes(tx, project.id), expected = new Map(input.expectedEpisodes.map((item) => [item.id, item.revision]));
      if (expected.size !== input.expectedEpisodes.length || input.orderedEpisodeIds.length !== list.length
        || new Set(input.orderedEpisodeIds).size !== list.length || expected.size !== list.length
        || list.some((item) => expected.get(item.id) !== item.revision || !input.orderedEpisodeIds.includes(item.id))) fail('episode-membership-changed');
      const byId = new Map(list.map((item) => [item.id, item]));
      for (const [rank, id] of input.orderedEpisodeIds.entries()) {
        const before = byId.get(id)!;
        if (before.orderRank !== rank) await request(tx.objectStore('episodes').put({ ...before, orderRank: rank, revision: increment(before.revision), updatedAt: now }));
      }
      const next = { ...project, epoch: increment(project.epoch), updatedAt: now }; await request(tx.objectStore('projectRoots').put(next)); return next;
    }),
    deleteEpisode: (input: ProjectModelDeleteEpisode) => write(['episodes', 'episodeContents', 'canvasDocuments', 'canvasPreviews', 'legacyProjectBindings'], input, async (tx, _marker, project, now, input) => {
      if (project.kind !== 'series') fail('project-is-not-series');
      if (!Number.isSafeInteger(input.expectedEpisodeRevision) || input.expectedEpisodeRevision < 0) fail('invalid-episode-version');
      const target = await episode(tx, project.id, input.episodeId, input.expectedEpisodeRevision), current = await canvas(tx, project.id, target.canvasId);
      if (current.episodeId !== target.id || current.epoch !== input.expectedCanvasEpoch || current.revision !== input.expectedCanvasRevision) fail('canvas-version-conflict');
      await episodeContent(tx, target.id);
      await tombstone(tx, 'episode', project.id, target.id, target.epoch, now); await tombstone(tx, 'canvas', project.id, current.id, current.epoch, now);
      await retireBindings(tx, project.id, new Set([current.id]), new Set([target.id]), now);
      await request(tx.objectStore('episodes').delete(key(target.id))); await request(tx.objectStore('episodeContents').delete(key(target.id)));
      await request(tx.objectStore('canvasDocuments').delete(key(current.id))); await request(tx.objectStore('canvasPreviews').delete(key(current.id)));
      const remaining = (await episodes(tx, project.id));
      const next = { ...project, epoch: increment(project.epoch), updatedAt: now };
      if (next.lastOpenedCanvasId === current.id) {
        if (remaining.length) next.lastOpenedCanvasId = remaining[0].canvasId; else delete next.lastOpenedCanvasId;
      }
      await request(tx.objectStore('projectRoots').put(next));
      return { project: next, selection: await selection(tx, next) };
    }),
    deleteProject: (input: ProjectModelDeleteProject) => write(TABLES.filter((name) => name !== 'projectRoots'), input, async (tx, marker, project, now, input) => {
      if (marker.revision !== input.expectedSessionRevision) fail('fixture-version-conflict');
      const list = await episodes(tx, project.id);
      await membership(tx, project);
      const canvases = await request(tx.objectStore('canvasDocuments').index('projectId').getAll([generation, project.id])) as Array<ProjectModelStored<CanvasDocument>>;
      await tombstone(tx, 'project', project.id, project.id, project.epoch, now);
      for (const target of list) {
        await episodeContent(tx, target.id);
        await tombstone(tx, 'episode', project.id, target.id, target.epoch, now);
        await request(tx.objectStore('episodes').delete(key(target.id))); await request(tx.objectStore('episodeContents').delete(key(target.id)));
      }
      for (const current of canvases) {
        await tombstone(tx, 'canvas', project.id, current.id, current.epoch, now);
        await request(tx.objectStore('canvasDocuments').delete(key(current.id))); await request(tx.objectStore('canvasPreviews').delete(key(current.id)));
      }
      await retireBindings(tx, project.id, new Set(), new Set(), now, true);
      await request(tx.objectStore(META).add({ id: 'project-model-business-cleanup:' + session.operationId + ':' + project.id,
        operationId: session.operationId, generation, projectId: project.id, stage: 'pending',
        storageBindings: project.storageBindings, projectEpoch: increment(project.epoch), createdAt: now, canDeleteFiles: false }));
      await request(tx.objectStore('projectContents').delete(key(project.id))); await request(tx.objectStore('projectRoots').delete(key(project.id)));
      return { projectId: project.id, cleanupPending: true as const, canDeleteFiles: false as const };
    }),
  };
}
