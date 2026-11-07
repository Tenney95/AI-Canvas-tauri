/** canonical2/bundle2 的纯接收边界。不会修改 v1 原文、访问仓储或激活正式新模型。 */
import type { ProjectExchangeEntity, ProjectExchangeObject, ProjectExchangeValue } from '../types/projectExchange';
import type { ProjectArchiveHistoricalTarget, ProjectExchangeBundleV2, ProjectExchangeEntityV2, ProjectExchangeKindV2,
  ProjectExchangeReferenceV2, ProjectExchangeRevisionHeaderV2, ProjectExchangeRevisionReference, ProjectExchangeRevisionV2,
  ProjectExchangeSnapshotV2 } from '../types/projectArchiveV4';
import { PROJECT_ARCHIVE_V4_CONTRACT } from '../types/projectArchiveV4';
import type { AnyProjectExchangeHeader, AnyProjectExchangeRevision, ProjectExchangeBaseResultV2 } from '../types/projectExchangeV2';
import { PROJECT_EXCHANGE_LIMITS, parseProjectExchangeSnapshot, projectExchangeId,
  projectExchangeRevisionHeader, serializeProjectExchangeValue, verifyProjectExchangeHeader, verifyProjectExchangeRevision } from './projectExchangeFormat';
import { exchangeReferences, safeExchangePath, validateExchangeDomain } from './projectExchangeDomain';
import { sha256BytesHex } from './mediaDataUrl';
import { normalizeStoryGraph } from './storyGraphService';
import { assertProjectModelProjectSettings, assertProjectModelSettingsPolicy } from './projectModelSettings';
import type { ProjectSettings } from '../types';
import type { EpisodeSettingsPolicy } from '../types/project';

const encoder = new TextEncoder();
const kinds = new Set<ProjectExchangeKindV2>(['project', 'episode', 'canvas', 'node', 'edge', 'group', 'character', 'scene', 'prop',
  'referenceImage', 'voiceClip', 'action', 'actionMedia', 'shot', 'file', 'imageMetadata']);
const canvasKinds = new Set<ProjectExchangeKindV2>(['node', 'edge', 'group', 'shot']);
const mediaUrlFields = new Set(['url', 'imageUrl', 'videoUrl', 'audioUrl', 'sourceUrl', 'thumbnailUrl', 'directorCaptureUrls']);
const fail = (code: string): never => { throw new Error(`新版项目协作材料无效（${code}），已停止处理`); };
const sort = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const projectExchangeEntityKeyV2 = (ref: ProjectExchangeReferenceV2): string => JSON.stringify([ref.kind, ref.scopeId, ref.id]);
const key = projectExchangeEntityKeyV2;
const same = (a: unknown, b: unknown) => serializeProjectExchangeValue(a) === serializeProjectExchangeValue(b);
const digest = (input: unknown): string => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input) ? input : fail('invalid_digest');
const array = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : fail('limit_exceeded');
function object(input: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length || Object.values(Object.getOwnPropertyDescriptors(input)).some((item) => !('value' in item) || !item.enumerable)) return fail('invalid_object');
  const value = input as Record<string, unknown>;
  if (allowed && Object.keys(value).some((field) => !allowed.includes(field))) return fail('unknown_field');
  return value;
}
/** 不执行输入访问器；随后复用 v1 的 JSON 深度/凭据字段/容量规则。 */
function plain(input: unknown, depth = 0, budget = { count: 0 }, visiting = new WeakSet<object>(), field = '', portable = false): void {
  if (++budget.count > PROJECT_EXCHANGE_LIMITS.values || depth > PROJECT_EXCHANGE_LIMITS.depth) return fail('limit_exceeded');
  if (portable && typeof input === 'string' && (mediaUrlFields.has(field) && /^(?:file:|asset:|blob:|data:|https?:\/\/(?:asset\.localhost|tauri\.localhost)|[a-z]:[\\/]|\\\\)/i.test(input)
    || /(?:paths?|directory|folder)$/i.test(field) && /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(input))) return fail('non_portable_value');
  if (!input || typeof input !== 'object') return;
  if (visiting.has(input)) return fail('invalid_object');
  visiting.add(input);
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length
      || Object.values(Object.getOwnPropertyDescriptors(input)).some((item) => !('value' in item))
      || Object.keys(input).some((field) => !/^(0|[1-9]\d*)$/.test(field))) return fail('invalid_object');
    for (const value of input) plain(value, depth + 1, budget, visiting, field, portable);
  } else for (const [name, value] of Object.entries(object(input))) plain(value, depth + 1, budget, visiting, name, portable);
  visiting.delete(input);
}
function parseInput(input: unknown, max: number, portable = false): unknown {
  if (typeof input === 'string') {
    if (input.length > max || encoder.encode(input).byteLength > max) return fail('limit_exceeded');
    try { input = JSON.parse(input); } catch { return fail('invalid_json'); }
  }
  plain(input, 0, { count: 0 }, new WeakSet(), '', portable);
  return input;
}
function ref(input: unknown): ProjectExchangeReferenceV2 {
  const value = object(input, ['kind', 'scopeId', 'id']);
  if (!kinds.has(value.kind as ProjectExchangeKindV2)) return fail('invalid_kind');
  return { kind: value.kind as ProjectExchangeKindV2, scopeId: projectExchangeId(value.scopeId), id: projectExchangeId(value.id) };
}
function versioned(input: unknown): ProjectExchangeRevisionReference {
  const value = object(input, ['canonicalVersion', 'revisionId']);
  if (value.canonicalVersion !== 1 && value.canonicalVersion !== 2) return fail('unknown_canonical_version');
  return { canonicalVersion: value.canonicalVersion, revisionId: digest(value.revisionId) };
}
const revisionKey = (value: ProjectExchangeRevisionReference) => `${value.canonicalVersion}:${value.revisionId}`;
const reference = (kind: ProjectExchangeKindV2, scopeId: string, id: string): ProjectExchangeReferenceV2 => ({ kind, scopeId, id });
const strings = (value: ProjectExchangeValue | undefined): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || new Set(value).size !== value.length) return fail('invalid_members');
  return value.map((item) => projectExchangeId(item));
};
/** 设置验证只投影已知母图字段，不把 portable token 当作本机路径或获取文件授权。 */
function settingsForValidation(input: unknown, policy = false): unknown {
  const value = structuredClone(object(input));
  const settings = policy && value.mode === 'inherit' ? object(value.overrides) : value;
  const visual = settings.visualStyle === undefined ? undefined : object(settings.visualStyle);
  if (visual?.styleReference !== undefined) {
    const holder = policy ? object(visual.styleReference) : visual;
    const source = policy ? holder.value : visual.styleReference;
    if (source && typeof source === 'object' && !Array.isArray(source) && Object.hasOwn(source, 'relativePath')) {
      const refValue = object(source);
      if (typeof refValue.relativePath !== 'string' || !refValue.relativePath.startsWith('exchange-file:')) return fail('invalid_settings_reference');
      const { relativePath, ...rest } = refValue;
      const projected = { ...rest, imageUrl: relativePath };
      if (policy) holder.value = projected; else visual!.styleReference = projected;
    }
  }
  return value;
}

/** 归档构造与合并共用引用规则；不能信任包内自报的 references。 */
export function exchangeReferencesV2(entity: ProjectExchangeEntityV2, all: readonly ProjectExchangeEntityV2[], root: string): ProjectExchangeReferenceV2[] {
  const structural: ProjectExchangeReferenceV2[] = [];
  const contentReferences: ProjectExchangeReferenceV2[] = [];
  let scope = entity.scopeId;
  const data = { ...entity.data };
  if (entity.kind === 'file') return [];
  if (entity.kind === 'project') {
    for (const child of all) if (child.kind === 'episode' || child.kind === 'canvas') structural.push(reference(child.kind, root, child.id));
    if (data.content && typeof data.content === 'object' && !Array.isArray(data.content)) {
      const content = { ...data.content }; delete content.storyGraph;
      const contentScope = typeof data.standaloneCanvasId === 'string' ? data.standaloneCanvasId : root;
      contentReferences.push(...exchangeReferences({ kind: 'project', scopeId: contentScope, id: contentScope, data: content,
        references: [] }, all as readonly ProjectExchangeEntity[], root));
      delete data.content;
    }
  } else if (entity.kind === 'episode') {
    scope = projectExchangeId(data.canvasId);
    structural.push(reference('project', root, root), reference('canvas', root, scope));
  } else if (entity.kind === 'canvas') {
    scope = entity.id;
    structural.push(reference('project', root, root));
    if (data.episodeId !== null) structural.push(reference('episode', root, projectExchangeId(data.episodeId)));
  } else if (canvasKinds.has(entity.kind)) structural.push(reference('canvas', root, entity.scopeId));
  // 旧的引用识别保留 @drama、镜头胶囊、分组、文件 token 和已有资产边界。
  const old = exchangeReferences({ ...entity, scopeId: scope, data } as ProjectExchangeEntity,
    all as readonly ProjectExchangeEntity[], root);
  if (entity.kind === 'project' && entity.data.content && typeof entity.data.content === 'object' && !Array.isArray(entity.data.content)
    && entity.data.content.storyGraph !== undefined) {
    const graphValue = object(entity.data.content.storyGraph);
    if (Object.hasOwn(graphValue, 'revision')) return fail('local_story_graph_revision');
    const graph = normalizeStoryGraph({ ...graphValue, revision: 0 });
    for (const item of [...graph.nodes, ...graph.edges]) {
      const ids = [...item.episodeIds, ...item.evidence.map((item) => item.episodeId),
        ...('fromEpisodeId' in item && item.fromEpisodeId ? [item.fromEpisodeId] : []),
        ...('toEpisodeId' in item && item.toEpisodeId ? [item.toEpisodeId] : [])];
      for (const id of ids) if (all.some((entry) => entry.kind === 'episode' && entry.id === id)) structural.push(reference('episode', root, id));
    }
    for (const item of graph.nodes) if (item.asset && all.some((entry) => entry.kind === item.asset!.kind && entry.scopeId === root && entry.id === item.asset!.id)) {
      // 故事图可保留已删除资产的只读出处；它不是可执行 @drama 引用。
      structural.push(reference(item.asset.kind, root, item.asset.id));
    }
  }
  const refs = new Map([...structural, ...old, ...contentReferences].map((item) => [key(item), item]));
  return [...refs.values()].sort((a, b) => sort(key(a), key(b)));
}

function validateStructure(snapshot: ProjectExchangeSnapshotV2): void {
  const { entities, rootProjectId: root } = snapshot;
  const projects = entities.filter((item) => item.kind === 'project');
  if (projects.length !== 1 || projects[0].id !== root || projects[0].scopeId !== root) return fail('invalid_owner');
  const project = projects[0], episodes = entities.filter((item) => item.kind === 'episode'), canvases = entities.filter((item) => item.kind === 'canvas');
  if (!['standalone', 'series'].includes(String(project.data.kind)) || typeof project.data.name !== 'string') return fail('invalid_project_kind');
  if (project.data.defaultSettings !== undefined) assertProjectModelProjectSettings(settingsForValidation(project.data.defaultSettings) as ProjectSettings);
  const roots = array(project.data.storageRoots, PROJECT_EXCHANGE_LIMITS.entities).map((item) => {
    const rootValue = object(item, ['id', 'role']);
    if (!['shared', 'canvas', 'manuscript'].includes(String(rootValue.role))) return fail('invalid_storage_root');
    return projectExchangeId(rootValue.id);
  });
  if (!roots.length || new Set(roots).size !== roots.length) return fail('invalid_storage_root');
  const canvasIds = new Set(canvases.map((item) => item.id)), episodeIds = new Set(episodes.map((item) => item.id));
  if (canvases.some((item) => item.scopeId !== root || item.data.projectId !== root || !roots.includes(projectExchangeId(item.data.storageRootRef))
    || !['project', 'global'].includes(String(item.data.revisionScope)))) return fail('invalid_canvas_owner');
  if (episodes.some((item) => item.scopeId !== root || item.data.projectId !== root || !canvasIds.has(projectExchangeId(item.data.canvasId))
    || typeof item.data.name !== 'string' || !Number.isSafeInteger(item.data.orderRank) || (item.data.orderRank as number) < 0)) return fail('invalid_episode_owner');
  if (new Set(episodes.map((item) => item.data.orderRank)).size !== episodes.length) return fail('invalid_order');
  for (const episode of episodes) {
    const policy = object(episode.data.settingsPolicy);
    if (policy.mode === 'legacy-pinned') { object(policy, ['mode', 'snapshot']); object(policy.snapshot); }
    else if (policy.mode === 'inherit') { object(policy, ['mode', 'overrides']); object(policy.overrides); }
    else return fail('invalid_settings_policy');
    assertProjectModelSettingsPolicy(settingsForValidation(policy, true) as EpisodeSettingsPolicy);
    if (episode.data.displayNo !== undefined && (!Number.isSafeInteger(episode.data.displayNo) || (episode.data.displayNo as number) < 1)) return fail('invalid_display_number');
  }
  if (project.data.kind === 'standalone') {
    if (episodes.length || canvases.length !== 1 || project.data.standaloneCanvasId !== canvases[0].id || canvases[0].data.episodeId !== null) return fail('invalid_standalone');
  } else if (project.data.standaloneCanvasId !== undefined || canvases.length !== episodes.length) return fail('invalid_series');
  for (const canvas of canvases) {
    const owner = episodes.find((item) => item.id === canvas.data.episodeId);
    if (project.data.kind === 'series' && (!owner || owner.data.canvasId !== canvas.id)) return fail('invalid_canvas_owner');
    for (const [field, kind] of [['nodesIds', 'node'], ['edgesIds', 'edge'], ['groupsIds', 'group']] as const) {
      const ids = strings(canvas.data[field]), actual = entities.filter((item) => item.kind === kind && item.scopeId === canvas.id);
      if (ids.length !== actual.length || actual.some((item) => !ids.includes(item.id))) return fail('incomplete_members');
    }
  }
  const fileLocations = new Set<string>();
  const fileById = new Map(entities.filter((entity) => entity.kind === 'file').map((entity) => [entity.id, entity]));
  const defaultRoot = (project.data.storageRoots as ProjectExchangeObject[]).find((entry) => entry.role === 'shared')?.id ?? roots[0];
  const checkFileRoots = (value: ProjectExchangeValue, rootRef: string): void => {
    if (typeof value === 'string' && value.startsWith('exchange-file:')) {
      if (fileById.get(value.slice('exchange-file:'.length))?.data.rootRef !== rootRef) return fail('file_root_mismatch');
    } else if (Array.isArray(value)) value.forEach((item) => checkFileRoots(item, rootRef));
    else if (value && typeof value === 'object') {
      const next = value.storageRootRef === undefined ? rootRef : projectExchangeId(value.storageRootRef);
      if (!roots.includes(next)) return fail('invalid_storage_root');
      Object.values(value).forEach((item) => checkFileRoots(item, next));
    }
  };
  for (const entity of entities) {
    if (canvasKinds.has(entity.kind) ? !canvasIds.has(entity.scopeId) : entity.scopeId !== root) return fail('invalid_scope');
    if (entity.kind === 'file') {
      if (!roots.includes(projectExchangeId(entity.data.rootRef))) return fail('invalid_file_root');
      // 旧 canonical1 不包含路径；比较投影的显式旧证明不可被当作可落盘地址。
      if (entity.data.relativePath !== undefined) {
        if (typeof entity.data.relativePath !== 'string' || safeExchangePath(entity.data.relativePath) !== entity.data.relativePath) return fail('invalid_file_path');
        if (entity.data.name !== entity.data.relativePath.split('/').pop()) return fail('invalid_file_name');
        const location = JSON.stringify([entity.data.rootRef, entity.data.relativePath.normalize('NFC').toLowerCase()]);
        if (fileLocations.has(location)) return fail('duplicate_file_location');
        fileLocations.add(location);
      }
      else if (entity.data.legacyPathUnavailable !== true) return fail('missing_file_path');
    } else {
      const owningCanvas = canvasKinds.has(entity.kind) ? canvases.find((item) => item.id === entity.scopeId) : undefined;
      const owningEpisode = entity.kind === 'episode' ? object(entity.data.content) : undefined;
      const effectiveRoot = owningCanvas?.data.storageRootRef ?? owningEpisode?.storageRootRef ?? defaultRoot;
      checkFileRoots(entity.data, projectExchangeId(effectiveRoot));
    }
  }
  for (const target of snapshot.historicalTargets) {
    // 同ID业务稿可经内容恢复重新存在；退役历史仍是独立只读出处，不因此重新激活。
    if (target.projectId !== root) return fail('invalid_retired_target');
  }
  const content = object(project.data.content);
  if (content.storyGraph !== undefined) {
    const graphValue = object(content.storyGraph);
    if (Object.hasOwn(graphValue, 'revision')) return fail('local_story_graph_revision');
    const graph = normalizeStoryGraph({ ...graphValue, revision: 0 });
    const known = new Set([...episodeIds, ...(project.data.kind === 'standalone' ? [root] : []),
      ...snapshot.historicalTargets.filter((target) => target.kind === 'episode' || target.kind === 'standalone-creative').map((target) => target.id)]);
    for (const item of [...graph.nodes, ...graph.edges]) {
      const ids = [...item.episodeIds, ...item.evidence.map((entry) => entry.episodeId),
        ...('fromEpisodeId' in item && item.fromEpisodeId ? [item.fromEpisodeId] : []),
        ...('toEpisodeId' in item && item.toEpisodeId ? [item.toEpisodeId] : [])];
      if (ids.some((id) => !known.has(id))) return fail('missing_story_target');
    }
  }
  // 借用已审查的旧领域校验检查节点/资产结构；投影不作为旧格式导出，也不改变原历史。
  const synthetic: ProjectExchangeEntity[] = [];
  const rootData: ProjectExchangeObject = { ...project.data, nodesIds: [], edgesIds: [], groupsIds: [] };
  delete rootData.content; delete rootData.standaloneCanvasId; delete rootData.storageRoots;
  synthetic.push({ kind: 'project', scopeId: root, id: root, data: rootData, references: [] });
  for (const canvas of canvases) {
    const data: ProjectExchangeObject = { name: '', nodesIds: canvas.data.nodesIds, edgesIds: canvas.data.edgesIds, groupsIds: canvas.data.groupsIds };
    if (canvas.id === root) Object.assign(rootData, data); else synthetic.push({ kind: 'project', scopeId: canvas.id, id: canvas.id,
      data: { ...data, parentId: root }, references: [] });
  }
  synthetic.push(...entities.filter((item) => !['project', 'episode', 'canvas'].includes(item.kind)).map((item) => {
    if (item.kind !== 'file') return item as ProjectExchangeEntity;
    return { ...item, data: { name: item.data.name ?? '', mediaId: item.data.mediaId }, references: [] } as ProjectExchangeEntity;
  }));
  validateExchangeDomain({ format: 'ai-canvas-project-snapshot', canonicalVersion: 1, lineageId: snapshot.lineageId,
    rootProjectId: root, complete: true, entities: synthetic, media: snapshot.media });
}

export function parseProjectExchangeSnapshotV2(input: unknown): ProjectExchangeSnapshotV2 {
  const value = object(parseInput(input, PROJECT_EXCHANGE_LIMITS.snapshotBytes, true),
    ['format', 'canonicalVersion', 'lineageId', 'rootProjectId', 'complete', 'entities', 'media', 'historicalTargets']);
  if (value.format !== 'ai-canvas-project-snapshot' || value.canonicalVersion !== 2 || value.complete !== true) return fail('invalid_snapshot');
  const root = projectExchangeId(value.rootProjectId), lineageId = projectExchangeId(value.lineageId);
  let count = 0;
  const entities = array(value.entities, PROJECT_EXCHANGE_LIMITS.entities).map((input): ProjectExchangeEntityV2 => {
    const item = object(input, ['kind', 'scopeId', 'id', 'data', 'references']), identity = ref({ kind: item.kind, scopeId: item.scopeId, id: item.id });
    const references = array(item.references, PROJECT_EXCHANGE_LIMITS.references).map(ref).sort((a, b) => sort(key(a), key(b)));
    count += references.length;
    if (count > PROJECT_EXCHANGE_LIMITS.references || new Set(references.map(key)).size !== references.length) return fail('invalid_references');
    const data = JSON.parse(serializeProjectExchangeValue(object(item.data))) as ProjectExchangeObject;
    if (Object.hasOwn(data, 'id')) return fail('duplicate_entity_identity');
    return { ...identity, data, references };
  }).sort((a, b) => sort(key(a), key(b)));
  if (new Set(entities.map(key)).size !== entities.length) return fail('duplicate_identity');
  const byKey = new Set(entities.map(key));
  for (const entity of entities) {
    if (entity.references.some((item) => !byKey.has(key(item)))) return fail('missing_dependency');
    if (!same(entity.references, exchangeReferencesV2(entity, entities, root))) return fail('invalid_references');
  }
  // 复用旧媒体预算及“每个载荷恰有逻辑 file 使用”规则，不复用其项目归属推断。
  const mediaProbe = parseProjectExchangeSnapshot({ format: 'ai-canvas-project-snapshot', canonicalVersion: 1,
    lineageId, rootProjectId: root, complete: true, entities: [
      { kind: 'project', id: root, scopeId: root, data: {}, references: [] },
      ...entities.filter((item) => item.kind === 'file').map((item) => ({ ...item, references: [] })),
    ], media: value.media });
  const historicalTargets = array(value.historicalTargets, PROJECT_EXCHANGE_LIMITS.entities).map((input): ProjectArchiveHistoricalTarget => {
    const item = object(input, ['state', 'kind', 'projectId', 'id']);
    if (item.state !== 'retired' || !['episode', 'canvas', 'standalone-creative'].includes(String(item.kind))) return fail('invalid_retired_target');
    return { state: 'retired', kind: item.kind as ProjectArchiveHistoricalTarget['kind'], projectId: projectExchangeId(item.projectId), id: projectExchangeId(item.id) };
  }).sort((a, b) => sort(JSON.stringify(a), JSON.stringify(b)));
  if (new Set(historicalTargets.map((item) => JSON.stringify(item))).size !== historicalTargets.length) return fail('duplicate_retired_target');
  const result: ProjectExchangeSnapshotV2 = { format: 'ai-canvas-project-snapshot', canonicalVersion: 2, lineageId, rootProjectId: root,
    complete: true, entities, media: mediaProbe.media, historicalTargets };
  validateStructure(result);
  if (encoder.encode(serializeProjectExchangeValue(result)).byteLength > PROJECT_EXCHANGE_LIMITS.snapshotBytes) return fail('limit_exceeded');
  return result;
}

function headerV2(input: unknown): ProjectExchangeRevisionHeaderV2 {
  const item = object(input, ['canonicalVersion', 'lineageId', 'revisionId', 'contentDigest', 'parents', 'adapterVersion']);
  if (item.canonicalVersion !== 2 || item.adapterVersion !== PROJECT_ARCHIVE_V4_CONTRACT.adapterVersion) return fail('unknown_canonical_version');
  const parents = array(item.parents, 2).map(versioned).sort((a, b) => sort(revisionKey(a), revisionKey(b)));
  const result: ProjectExchangeRevisionHeaderV2 = { canonicalVersion: 2, lineageId: projectExchangeId(item.lineageId),
    revisionId: digest(item.revisionId), contentDigest: digest(item.contentDigest), parents, adapterVersion: PROJECT_ARCHIVE_V4_CONTRACT.adapterVersion };
  if (new Set(parents.map(revisionKey)).size !== parents.length || parents.some((parent) => revisionKey(parent) === revisionKey(result))) return fail('invalid_ancestry');
  return result;
}
const hash = (value: unknown) => sha256BytesHex(encoder.encode(serializeProjectExchangeValue(value)));
const headerInput = ({ revisionId: _revisionId, ...value }: ProjectExchangeRevisionHeaderV2) => value;
export function projectExchangeRevisionHeaderV2(revision: ProjectExchangeRevisionV2): ProjectExchangeRevisionHeaderV2 {
  return { canonicalVersion: 2, lineageId: revision.lineageId, revisionId: revision.revisionId, contentDigest: revision.contentDigest,
    parents: revision.parents.map((parent) => ({ ...parent })), adapterVersion: revision.adapterVersion };
}
export async function verifyProjectExchangeHeaderV2(input: unknown): Promise<ProjectExchangeRevisionHeaderV2> {
  plain(input);
  const header = headerV2(input);
  if (await hash(headerInput(header)) !== header.revisionId) return fail('invalid_digest');
  return header;
}
export async function createProjectExchangeRevisionV2(input: unknown, inputParents: readonly ProjectExchangeRevisionReference[] = []): Promise<ProjectExchangeRevisionV2> {
  const snapshot = parseProjectExchangeSnapshotV2(input);
  const parents = array([...inputParents], 2).map(versioned).sort((a, b) => sort(revisionKey(a), revisionKey(b)));
  if (new Set(parents.map(revisionKey)).size !== parents.length) return fail('invalid_ancestry');
  const contentDigest = await hash(snapshot), body = { canonicalVersion: 2 as const, lineageId: snapshot.lineageId, contentDigest,
    parents, adapterVersion: PROJECT_ARCHIVE_V4_CONTRACT.adapterVersion };
  return { ...body, revisionId: await hash(body), snapshot };
}
export async function verifyProjectExchangeRevisionV2(input: unknown): Promise<ProjectExchangeRevisionV2> {
  plain(input);
  const item = object(input, ['canonicalVersion', 'lineageId', 'revisionId', 'contentDigest', 'parents', 'adapterVersion', 'snapshot']);
  const header = await verifyProjectExchangeHeaderV2(Object.fromEntries(Object.entries(item).filter(([name]) => name !== 'snapshot')));
  const snapshot = parseProjectExchangeSnapshotV2(item.snapshot);
  if (snapshot.lineageId !== header.lineageId || await hash(snapshot) !== header.contentDigest) return fail('invalid_digest');
  return { ...header, snapshot };
}
async function verifyAnyHeader(input: unknown): Promise<AnyProjectExchangeHeader> {
  plain(input); return object(input).canonicalVersion === 1 ? verifyProjectExchangeHeader(input) : verifyProjectExchangeHeaderV2(input);
}
async function verifyAnyRevision(input: unknown): Promise<AnyProjectExchangeRevision> {
  plain(input); return object(input).canonicalVersion === 1 ? verifyProjectExchangeRevision(input) : verifyProjectExchangeRevisionV2(input);
}
const parentsOf = (entry: AnyProjectExchangeHeader): ProjectExchangeRevisionReference[] => entry.canonicalVersion === 1
  ? entry.parentRevisionIds.map((revisionId) => ({ canonicalVersion: 1, revisionId })) : entry.parents;
const anyHeader = (entry: AnyProjectExchangeRevision): AnyProjectExchangeHeader => entry.canonicalVersion === 1
  ? projectExchangeRevisionHeader(entry) : projectExchangeRevisionHeaderV2(entry);

/** 唯一最近公共祖先；v1/v2 同名 digest 也不会混为同一个版本。 */
export async function findProjectExchangeBaseV2(left: ProjectExchangeRevisionReference, right: ProjectExchangeRevisionReference,
  revisions: readonly AnyProjectExchangeRevision[], ancestors: readonly AnyProjectExchangeHeader[] = []): Promise<ProjectExchangeBaseResultV2> {
  left = versioned(left); right = versioned(right);
  if (revisions.length + ancestors.length > PROJECT_EXCHANGE_LIMITS.revisions) return fail('limit_exceeded');
  const graph = new Map<string, AnyProjectExchangeHeader>(), bodies = new Map<string, AnyProjectExchangeRevision>();
  const insert = (entry: AnyProjectExchangeHeader) => {
    const id = revisionKey(entry), previous = graph.get(id);
    if (previous && !same(previous, entry)) return fail('invalid_ancestry');
    graph.set(id, entry);
  };
  for (const input of ancestors) insert(await verifyAnyHeader(input));
  const roots = new Map<string, string>();
  for (const input of revisions) {
    const entry = await verifyAnyRevision(input), root = roots.get(entry.lineageId);
    if (root !== undefined && root !== entry.snapshot.rootProjectId) return fail('invalid_ancestry');
    roots.set(entry.lineageId, entry.snapshot.rootProjectId); insert(anyHeader(entry)); bodies.set(revisionKey(entry), entry);
  }
  const a = graph.get(revisionKey(left)), b = graph.get(revisionKey(right));
  if (!a || !b) return { status: 'incomplete' };
  if (a.lineageId !== b.lineageId) return { status: 'unrelated' };
  const colors = new Map<string, number>(); let incomplete = false;
  const visit = (id: string) => {
    if (colors.get(id) === 1) return fail('invalid_ancestry');
    if (colors.get(id) === 2) return;
    const entry = graph.get(id);
    if (!entry) { incomplete = true; return; }
    if (entry.lineageId !== a.lineageId) return fail('invalid_ancestry');
    colors.set(id, 1); parentsOf(entry).forEach((parent) => visit(revisionKey(parent))); colors.set(id, 2);
  };
  visit(revisionKey(left)); visit(revisionKey(right));
  if (incomplete) return { status: 'incomplete' };
  const reachable = (start: string) => {
    const found = new Set<string>(), pending = [start];
    while (pending.length) { const id = pending.pop()!; if (found.has(id)) continue; found.add(id); pending.push(...parentsOf(graph.get(id)!).map(revisionKey)); }
    return found;
  };
  const ar = reachable(revisionKey(left)), br = reachable(revisionKey(right)), common = [...ar].filter((id) => br.has(id));
  if (!common.length) return { status: 'unrelated' };
  const superseded = new Set<string>();
  for (const id of common) for (const parent of reachable(id)) if (parent !== id) superseded.add(parent);
  const nearest = common.filter((id) => !superseded.has(id));
  if (nearest.length !== 1) return { status: 'ambiguous' };
  return bodies.has(nearest[0]) ? { status: 'found', revision: bodies.get(nearest[0])! } : { status: 'missingSnapshot' };
}

export async function parseProjectExchangeBundleV2(input: unknown): Promise<ProjectExchangeBundleV2> {
  const item = object(parseInput(input, PROJECT_EXCHANGE_LIMITS.bundleBytes), ['format', 'version', 'packageId', 'lineageId', 'head', 'revisions', 'ancestors', 'files']);
  if (item.format !== 'ai-canvas-project-exchange' || item.version !== 2) return fail('unknown_bundle_version');
  const head = versioned(item.head); if (head.canonicalVersion !== 2) return fail('invalid_head');
  const lineageId = projectExchangeId(item.lineageId), revisions: AnyProjectExchangeRevision[] = [], ancestors: AnyProjectExchangeHeader[] = [];
  const ri = array(item.revisions, PROJECT_EXCHANGE_LIMITS.revisions), ai = array(item.ancestors, PROJECT_EXCHANGE_LIMITS.revisions);
  if (!ri.length || ri.length + ai.length > PROJECT_EXCHANGE_LIMITS.revisions) return fail('limit_exceeded');
  for (const value of ri) revisions.push(await verifyAnyRevision(value));
  for (const value of ai) ancestors.push(await verifyAnyHeader(value));
  const all = [...revisions, ...ancestors];
  if (all.some((entry) => entry.lineageId !== lineageId) || new Set(all.map(revisionKey)).size !== all.length) return fail('invalid_ancestry');
  const headRevision = revisions.find((entry): entry is ProjectExchangeRevisionV2 => entry.canonicalVersion === 2 && entry.revisionId === head.revisionId);
  if (!headRevision) return fail('missing_head');
  // 任一包内历史分支都必须闭合且可达；不允许附带循环/断裂的未使用伪历史。
  if (revisions.some((entry) => entry.snapshot.rootProjectId !== headRevision.snapshot.rootProjectId)) return fail('invalid_ancestry');
  const graph = new Map(all.map((entry) => [revisionKey(entry), entry])), colors = new Map<string, number>();
  const visit = (id: string): void => {
    if (colors.get(id) === 1) return fail('invalid_ancestry');
    if (colors.get(id) === 2) return;
    const entry = graph.get(id);
    if (!entry) return fail('incomplete_ancestry');
    colors.set(id, 1); parentsOf(entry).forEach((parent) => visit(revisionKey(parent))); colors.set(id, 2);
  };
  for (const id of graph.keys()) visit(id);
  const files = array(item.files, PROJECT_EXCHANGE_LIMITS.media).map((input) => {
    const file = object(input, ['mediaId', 'archivePath']), path = safeExchangePath(String(file.archivePath));
    if (!path.startsWith('assets/') || path !== file.archivePath) return fail('invalid_archive_path');
    return { mediaId: projectExchangeId(file.mediaId), archivePath: path };
  });
  if (new Set(files.map((file) => file.mediaId)).size !== files.length || new Set(files.map((file) => file.archivePath.normalize('NFC').toLowerCase())).size !== files.length
    || files.length !== headRevision.snapshot.media.length || headRevision.snapshot.media.some((media) => !files.some((file) => file.mediaId === media.id))) return fail('invalid_files');
  const result: ProjectExchangeBundleV2 = { format: 'ai-canvas-project-exchange', version: 2, packageId: projectExchangeId(item.packageId),
    lineageId, head: { canonicalVersion: 2, revisionId: head.revisionId }, revisions, ancestors, files };
  if (encoder.encode(JSON.stringify(result)).byteLength > PROJECT_EXCHANGE_LIMITS.bundleBytes) return fail('limit_exceeded');
  return result;
}

/** 原 lineage 若已有必要 canonical2 历史，不能冒充可无损 v3 导出。 */
export function assertProjectExchangeV3Compatible(revisions: readonly AnyProjectExchangeHeader[]): void {
  if (revisions.some((revision) => revision.canonicalVersion !== 1)) throw new Error('此来源包含新版规范历史，请导出 v4；兼容副本必须使用独立来源');
}

/** 已验证图上的后继证明，允许祖先只有 header；仍按版本化身份比较。 */
export async function isProjectExchangeAncestorV2(ancestor: ProjectExchangeRevisionReference,
  descendant: ProjectExchangeRevisionReference, input: ProjectExchangeBundleV2): Promise<boolean> {
  ancestor = versioned(ancestor); descendant = versioned(descendant);
  const bundle = await parseProjectExchangeBundleV2(input);
  const graph = new Map([...bundle.revisions, ...bundle.ancestors].map((entry) => [revisionKey(entry), entry]));
  const target = revisionKey(ancestor), pending = [revisionKey(descendant)], found = new Set<string>();
  if (!graph.has(target)) return false;
  while (pending.length) {
    const id = pending.pop()!;
    if (found.has(id)) continue;
    const entry = graph.get(id);
    if (!entry) return false;
    if (id === target) return true;
    found.add(id); pending.push(...parentsOf(entry).map(revisionKey));
  }
  return false;
}
