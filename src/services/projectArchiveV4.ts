/** v4 的纯接收、规范投影与固定 Worker 序列化；不打开数据库、不发布文件。 */
import type {
  ProjectArchiveBusinessV4, ProjectArchiveCanvasV4, ProjectArchiveContentsV4, ProjectArchiveEpisodeV4,
  ProjectArchiveFileV4, ProjectArchiveHistoricalTarget, ProjectArchiveHistoryV4, ProjectArchiveManifestV4,
  ProjectArchivePayloadV4, ProjectArchiveProjectV4, ProjectExchangeEntityV2, ProjectExchangeSnapshotV2,
  ProjectExchangeKindV2, ValidatedProjectArchiveV4,
} from '../types/projectArchiveV4';
import { PROJECT_ARCHIVE_V4_ENTRIES } from '../types/projectArchiveV4';
import type { ProjectExchangeMedia, ProjectExchangeObject, ProjectExchangeValue } from '../types/projectExchange';
import { PROJECT_EXCHANGE_LIMITS, projectExchangeId, serializeProjectExchangeValue } from './projectExchangeFormat';
import { exchangeReferencesV2, validateExchangeDomainV2 } from './projectExchangeV2Domain';
import { parseProjectExchangeBundleV2 } from './projectExchangeV2Format';
import { safeExchangePath, type ArchiveAssetDigest } from './projectExchangeDomain';
import { portableArchiveChat } from './projectArchiveValidation';
import { serializeProjectArchiveEntries, type ProjectArchiveTextEntry } from './projectArchiveSerialization';
import { sha256BytesHex } from './mediaDataUrl';

const encoder = new TextEncoder();
const JSON_ENTRIES = [...PROJECT_ARCHIVE_V4_ENTRIES, 'history.json'] as const;
const digestPattern = /^[a-f0-9]{64}$/;
const fileToken = 'exchange-file:';
const collectionKinds: ReadonlyArray<readonly [string, ProjectExchangeKindV2]> = [
  ['referenceImages', 'referenceImage'], ['voiceClips', 'voiceClip'], ['actions', 'action'],
  ['media', 'actionMedia'], ['shotlistRows', 'shot'],
];
const assetKinds = [['characters', 'character'], ['scenes', 'scene'], ['props', 'prop']] as const;
const fail = (reason: string): never => { throw new Error(`项目 v4 归档无效：${reason}`); };
const object = (value: unknown, allowed?: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !('value' in entry) || !entry.enumerable)) return fail('对象结构无效');
  if (allowed && Object.keys(value).some((key) => !allowed.includes(key))) return fail('包含未知字段');
  return value as Record<string, unknown>;
};
const array = (value: unknown, limit: number = PROJECT_EXCHANGE_LIMITS.entities): unknown[] => {
  if (!Array.isArray(value) || value.length > limit) return fail('集合缺失或超过上限');
  return value;
};
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= PROJECT_EXCHANGE_LIMITS.stringBytes;
const identity = (value: unknown) => projectExchangeId(value);
const equal = (a: unknown, b: unknown) => serializeProjectExchangeValue(a) === serializeProjectExchangeValue(b);
const entityKey = (kind: string, scopeId: string, id: string) => JSON.stringify([kind, scopeId, id]);
const pathKey = (rootRef: string, path: string) => JSON.stringify([rootRef, safeExchangePath(path).normalize('NFC').toLowerCase()]);

/** 多根逻辑文件与物理包条目分离：同名异根不能覆盖；同字节可共用一个 mediaId。 */
export function readProjectArchiveV4Files(snapshot: ProjectExchangeSnapshotV2): ProjectArchiveFileV4[] {
  return snapshot.entities.filter((entity) => entity.kind === 'file').map((entity) => {
    const data = object(entity.data);
    if (typeof data.rootRef !== 'string' || typeof data.relativePath !== 'string' || typeof data.mediaId !== 'string') return fail('文件缺少来源根或相对路径');
    return { id: entity.id, rootRef: identity(data.rootRef), relativePath: safeExchangePath(data.relativePath), mediaId: identity(data.mediaId) };
  });
}

/** 唯一的 sidecar → canonical2 投影；只接受已脱离本机路径与运行时状态的业务值。 */
export function buildProjectExchangeSnapshotV2(business: ProjectArchiveBusinessV4, lineageId: string,
  media: ProjectExchangeMedia[], files: ProjectArchiveFileV4[], historicalTargets: ProjectArchiveHistoricalTarget[] = []): ProjectExchangeSnapshotV2 {
  const project = object(business.project, ['id', 'name', 'kind', 'storageRoots', 'defaultSettings', 'standaloneCanvasId']);
  const root = identity(project.id);
  if (!text(project.name) || !['standalone', 'series'].includes(String(project.kind))) return fail('项目资料无效');
  const roots = array(project.storageRoots).map((entry) => {
    const value = object(entry, ['id', 'role']);
    if (!['shared', 'canvas', 'manuscript'].includes(String(value.role))) return fail('素材根角色无效');
    return identity(value.id);
  });
  if (!roots.length || new Set(roots).size !== roots.length) return fail('素材根缺失或重复');
  const rootSet = new Set(roots);
  const defaultRoot = (project.storageRoots as ProjectArchiveProjectV4['storageRoots']).find((entry) => entry.role === 'shared')?.id ?? roots[0];
  const fileIds = new Set<string>(), paths = new Map<string, ProjectArchiveFileV4>();
  for (const file of files) {
    object(file, ['id', 'rootRef', 'relativePath', 'mediaId']);
    identity(file.id); identity(file.mediaId);
    if (!rootSet.has(file.rootRef) || fileIds.has(file.id) || paths.has(pathKey(file.rootRef, file.relativePath))) return fail('逻辑素材身份或根内路径重复');
    paths.set(pathKey(file.rootRef, file.relativePath), file); fileIds.add(file.id);
  }
  const clean = (value: unknown, rootRef: string, field = '', depth = 0): ProjectExchangeValue => {
    if (depth > PROJECT_EXCHANGE_LIMITS.depth) return fail('正文嵌套过深');
    if (typeof value === 'string') {
      if (['relativePath', 'imageRelativePath', 'directorCaptureRelativePaths'].includes(field)) {
        if (!value) return value;
        const file = paths.get(pathKey(rootRef, value));
        if (!file) return fail('正文引用的素材未包含在所属根的清单中');
        return fileToken + file.id;
      }
      if (field === 'status' && ['loading', 'generating', 'running', 'pending', 'polling'].includes(value)) return fail('包含未脱敏的运行状态');
      if (['url', 'imageUrl', 'videoUrl', 'audioUrl', 'thumbnailUrl', 'sourceUrl', 'directorCaptureUrls'].includes(field)
        && /^(?:file:|asset:|blob:|data:|https?:\/\/(?:asset\.localhost|tauri\.localhost)|[a-z]:[\\/]|\\\\)/i.test(value)) return fail('正文包含本机或临时媒体地址');
      if (/(?:paths?|directory|folder)$/i.test(field) && /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) return fail('正文包含本机绝对路径');
      return value;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map((item) => clean(item, rootRef, field, depth + 1));
    const source = object(value);
    const bound = typeof source.storageRootRef === 'string' ? source.storageRootRef : rootRef;
    if (!rootSet.has(bound)) return fail('正文绑定了未声明的素材根');
    return Object.fromEntries(Object.entries(source).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, clean(item, bound, key, depth + 1)]));
  };
  const entities: ProjectExchangeEntityV2[] = [];
  const add = (kind: ProjectExchangeKindV2, scopeId: string, source: Record<string, unknown>, rootRef: string): string => {
    const id = identity(source.id);
    const data = clean(source, rootRef) as ProjectExchangeObject;
    delete data.id;
    for (const [field, childKind] of collectionKinds) {
      if (source[field] === undefined) continue;
      data[field + 'Ids'] = array(source[field]).map((item) => add(childKind, scopeId, object(item), rootRef));
      delete data[field];
    }
    if (kind === 'node' && source.data && object(source.data).shotlistRows !== undefined) {
      const nodeData = object(source.data);
      data.shotlistRowsIds = array(nodeData.shotlistRows).map((item) => add('shot', scopeId, object(item), rootRef));
      delete (data.data as ProjectExchangeObject).shotlistRows;
    }
    entities.push({ kind, scopeId, id, data, references: [] });
    return id;
  };
  const contents = object(business.contents, ['project', 'episodes']);
  const projectContent = object(contents.project, ['projectId', 'data']);
  if (projectContent.projectId !== root) return fail('项目正文归属不一致');
  const contentData = object(projectContent.data);
  const projectData = clean(project, defaultRoot) as ProjectExchangeObject;
  delete projectData.id;
  projectData.content = clean(contentData, defaultRoot);
  const drama = contentData.dramaAssets === undefined ? undefined : object(contentData.dramaAssets);
  if (drama) {
    const canonicalDrama = (projectData.content as ProjectExchangeObject).dramaAssets as ProjectExchangeObject;
    for (const [field, kind] of assetKinds) {
      projectData[field + 'Ids'] = array(drama[field] ?? []).map((asset) => add(kind, root, object(asset), defaultRoot));
      delete canonicalDrama[field];
    }
  }
  entities.push({ kind: 'project', scopeId: root, id: root, data: projectData, references: [] });
  const episodeContents = new Map<string, Record<string, unknown>>();
  for (const entry of array(contents.episodes)) {
    const item = object(entry, ['episodeId', 'data']), episodeId = identity(item.episodeId);
    if (episodeContents.has(episodeId)) return fail('分集正文重复');
    episodeContents.set(episodeId, object(item.data));
  }
  for (const entry of array(business.episodes)) {
    const episode = object(entry, ['id', 'projectId', 'canvasId', 'name', 'orderRank', 'displayNo', 'settingsPolicy', 'creationProfile', 'teamProfileOverride']);
    const episodeId = identity(episode.id);
    const content = episodeContents.get(episodeId);
    if (!content || episode.projectId !== root || !text(episode.name) || !integer(episode.orderRank)
      || episode.displayNo !== undefined && (!integer(episode.displayNo) || episode.displayNo === 0)) return fail('分集归属、顺序或正文不完整');
    const contentRoot = typeof content.storageRootRef === 'string' ? content.storageRootRef : defaultRoot;
    const data = clean(episode, contentRoot) as ProjectExchangeObject;
    delete data.id; data.content = clean(content, contentRoot);
    entities.push({ kind: 'episode', scopeId: root, id: episodeId, data, references: [] });
    episodeContents.delete(episodeId);
  }
  if (episodeContents.size) return fail('存在没有所属分集的正文');
  for (const entry of array(business.canvases)) {
    const canvas = object(entry, ['id', 'projectId', 'episodeId', 'storageRootRef', 'revisionScope', 'nodes', 'edges', 'groups']);
    const canvasId = identity(canvas.id), storageRootRef = identity(canvas.storageRootRef);
    if (canvas.projectId !== root || !rootSet.has(storageRootRef)
      || canvas.revisionScope !== undefined && !['project', 'global'].includes(String(canvas.revisionScope))) return fail('画布归属或素材根无效');
    const data: ProjectExchangeObject = { projectId: root, episodeId: canvas.episodeId as string | null, storageRootRef,
      revisionScope: (canvas.revisionScope as 'project' | 'global' | undefined) ?? 'project' };
    for (const [field, kind] of [['nodes', 'node'], ['edges', 'edge'], ['groups', 'group']] as const) {
      data[field + 'Ids'] = array(canvas[field]).map((item) => add(kind, canvasId, object(item), storageRootRef));
    }
    entities.push({ kind: 'canvas', scopeId: root, id: canvasId, data, references: [] });
  }
  for (const file of files) entities.push({ kind: 'file', scopeId: root, id: file.id,
    data: { mediaId: file.mediaId, name: file.relativePath.split('/').pop()!, rootRef: file.rootRef, relativePath: safeExchangePath(file.relativePath) }, references: [] });
  const snapshot: ProjectExchangeSnapshotV2 = { format: 'ai-canvas-project-snapshot', canonicalVersion: 2,
    lineageId: identity(lineageId), rootProjectId: root, complete: true, entities, media, historicalTargets };
  snapshot.entities = entities.map((entity) => ({ ...entity, references: exchangeReferencesV2(entity, entities, root) }));
  return validateExchangeDomainV2(snapshot);
}

/** 仅反投影规范 head，不能用并存 sidecar 修补缺失实体。 */
export function projectArchivePayloadFromSnapshotV2(input: ProjectExchangeSnapshotV2): ProjectArchiveBusinessV4 {
  const snapshot = validateExchangeDomainV2(input), root = snapshot.rootProjectId;
  const byKey = new Map(snapshot.entities.map((entity) => [entityKey(entity.kind, entity.scopeId, entity.id), entity]));
  const files = new Map(readProjectArchiveV4Files(snapshot).map((file) => [file.id, file]));
  const decode = (value: ProjectExchangeValue, rootRef: string): ProjectExchangeValue => {
    if (typeof value === 'string' && value.startsWith(fileToken)) {
      const file = files.get(value.slice(fileToken.length));
      if (!file || file.rootRef !== rootRef) return fail('素材引用与正文来源根不一致');
      return file.relativePath;
    }
    if (Array.isArray(value)) return value.map((item) => decode(item, rootRef));
    if (value && typeof value === 'object') {
      const nextRoot = typeof value.storageRootRef === 'string' ? value.storageRootRef : rootRef;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, nextRoot)]));
    }
    return value;
  };
  const restore = (entity: ProjectExchangeEntityV2, rootRef: string): ProjectExchangeObject => {
    const data = decode(entity.data, rootRef) as ProjectExchangeObject;
    for (const [field, kind] of collectionKinds) {
      const ids = data[field + 'Ids'];
      if (ids === undefined) continue;
      const values = array(ids).map((id) => {
        const child = byKey.get(entityKey(kind, entity.scopeId, identity(id)));
        if (!child) return fail('规范正文缺少子对象');
        return restore(child, rootRef);
      });
      delete data[field + 'Ids'];
      if (field === 'shotlistRows' && entity.kind === 'node') (data.data as ProjectExchangeObject).shotlistRows = values;
      else data[field] = values;
    }
    return { id: entity.id, ...data };
  };
  const entity = byKey.get(entityKey('project', root, root));
  if (!entity) return fail('缺少项目对象');
  const roots = entity.data.storageRoots as unknown as ProjectArchiveProjectV4['storageRoots'];
  const defaultRoot = roots.find((entry) => entry.role === 'shared')?.id ?? roots[0]?.id;
  if (!defaultRoot) return fail('缺少素材根');
  const restored = restore(entity, defaultRoot), projectContent = object(restored.content) as ProjectExchangeObject;
  delete restored.content;
  for (const [field, kind] of assetKinds) {
    const ids = restored[field + 'Ids'];
    if (ids === undefined) continue;
    const values = array(ids).map((id) => {
      const asset = byKey.get(entityKey(kind, root, identity(id)));
      if (!asset) return fail('缺少共享资产');
      return restore(asset, defaultRoot);
    });
    if (!projectContent.dramaAssets || typeof projectContent.dramaAssets !== 'object' || Array.isArray(projectContent.dramaAssets)) return fail('缺少共享资产容器');
    (projectContent.dramaAssets as ProjectExchangeObject)[field] = values;
    delete restored[field + 'Ids'];
  }
  const episodeContents: ProjectArchiveContentsV4['episodes'] = [];
  const episodes = snapshot.entities.filter((item) => item.kind === 'episode').map((item): ProjectArchiveEpisodeV4 => {
    const content = object(item.data.content), rootRef = typeof content.storageRootRef === 'string' ? content.storageRootRef : defaultRoot;
    const value = restore(item, rootRef); delete value.content;
    episodeContents.push({ episodeId: item.id, data: decode(content as ProjectExchangeObject, rootRef) as ProjectExchangeObject });
    return value as unknown as ProjectArchiveEpisodeV4;
  }).sort((a, b) => a.orderRank - b.orderRank);
  episodeContents.sort((a, b) => episodes.findIndex((item) => item.id === a.episodeId) - episodes.findIndex((item) => item.id === b.episodeId));
  const canvases = snapshot.entities.filter((item) => item.kind === 'canvas').map((item): ProjectArchiveCanvasV4 => {
    const rootRef = identity(item.data.storageRootRef), value = restore(item, rootRef);
    for (const [field, kind] of [['nodes', 'node'], ['edges', 'edge'], ['groups', 'group']] as const) {
      value[field] = array(value[field + 'Ids']).map((id) => {
        const node = byKey.get(entityKey(kind, item.id, identity(id)));
        if (!node) return fail('缺少画布元素');
        return restore(node, rootRef);
      });
      delete value[field + 'Ids'];
    }
    return value as unknown as ProjectArchiveCanvasV4;
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { project: restored as unknown as ProjectArchiveProjectV4, episodes, canvases,
    contents: { project: { projectId: root, data: projectContent }, episodes: episodeContents } };
}

function validateHistory(history: ProjectArchiveHistoryV4 | undefined, snapshot: ProjectExchangeSnapshotV2): void {
  if (!history) return;
  const value = object(history, ['payload', 'workbenchTargets']), payload = object(value.payload, ['conversations', 'messages', 'memories']);
  array(payload.conversations, 100_000); array(payload.messages, 100_000); array(payload.memories, 100_000);
  if ((payload.conversations as unknown[]).some((row) => Object.hasOwn(object(row), 'workbenchTarget'))) return fail('历史同时包含旧版和新版目标');
  const portable = JSON.parse(JSON.stringify(portableArchiveChat(history.payload))) as unknown;
  if (!equal(portable, payload)) return fail('历史包含非可移植字段或运行权限');
  const conversationIds = new Set(history.payload.conversations.map((row) => row.id));
  const messages = new Map(history.payload.messages.map((row) => [row.id, row])), sequences = new Set<string>();
  for (const row of [...history.payload.conversations, ...history.payload.messages, ...history.payload.memories]) {
    if (row.projectId !== snapshot.rootProjectId) return fail('历史记录跨项目');
  }
  for (const row of history.payload.messages) {
    const sequence = JSON.stringify([row.conversationId, row.sequence]);
    if (!conversationIds.has(row.conversationId) || sequences.has(sequence)) return fail('消息来源会话缺失或序号重复');
    sequences.add(sequence);
  }
  for (const row of history.payload.memories) {
    if (row.source.unavailable) continue;
    if (!conversationIds.has(row.source.conversationId) || row.source.messageId
      && messages.get(row.source.messageId)?.conversationId !== row.source.conversationId) return fail('记忆来源闭包不完整');
  }
  const seen = new Set<string>();
  for (const item of array(value.workbenchTargets, 100_000)) {
    const binding = object(item, ['conversationId', 'target']), conversationId = identity(binding.conversationId);
    if (!conversationIds.has(conversationId) || seen.has(conversationId)) return fail('工作台历史目标重复或缺少会话');
    seen.add(conversationId);
    const target = object(binding.target);
    if (target.projectId !== snapshot.rootProjectId) return fail('历史目标跨项目');
    if (target.state === 'retired') {
      object(target, ['state', 'kind', 'projectId', 'id']);
      if (!snapshot.historicalTargets.some((entry) => equal(entry, target))) return fail('已删除历史目标没有原来源描述');
    } else if (target.state === 'active' && target.kind === 'episode') {
      object(target, ['state', 'kind', 'projectId', 'episodeId']);
      if (!snapshot.entities.some((entry) => entry.kind === 'episode' && entry.id === target.episodeId)) return fail('活动历史分集不存在');
    } else if (target.state === 'active' && target.kind === 'project' && target.domain === 'standalone-creative') {
      object(target, ['state', 'kind', 'projectId', 'domain']);
      if (snapshot.entities.find((entry) => entry.kind === 'project')?.data.kind !== 'standalone') return fail('历史普通稿件目标无效');
    } else return fail('历史目标类型无效');
  }
}

/** 严格接收端；assets 路径是解包后的相对清单，不是可直接打开的本机路径。 */
export async function readProjectArchiveV4(texts: Record<string, string>, assets: ArchiveAssetDigest[] = []): Promise<ValidatedProjectArchiveV4> {
  object(texts);
  if (Object.keys(texts).length + assets.length > PROJECT_EXCHANGE_LIMITS.entities) return fail('归档条目总数超过上限');
  if (Object.keys(texts).some((path) => path !== 'manifest.json' && !JSON_ENTRIES.includes(path as typeof JSON_ENTRIES[number]))) return fail('存在未声明的正文条目');
  let bytes = 0;
  for (const value of Object.values(texts)) {
    if (typeof value !== 'string') return fail('正文不是 UTF-8 文本');
    bytes += encoder.encode(value).byteLength;
    if (bytes > PROJECT_EXCHANGE_LIMITS.bundleBytes) return fail('JSON 总量超过上限');
  }
  const parse = (path: string): unknown => {
    if (!Object.hasOwn(texts, path)) return fail('缺少必要正文条目');
    try { return JSON.parse(texts[path]); } catch { return fail('JSON 正文损坏'); }
  };
  const manifest = object(parse('manifest.json'), ['formatVersion', 'packageId', 'exportedAt', 'appVersion', 'projectId', 'projectName', 'projectKind', 'episodeCount', 'canvasCount', 'entries']);
  if (manifest.formatVersion !== 4 || !integer(manifest.exportedAt) || !integer(manifest.episodeCount) || !integer(manifest.canvasCount)
    || !text(manifest.projectName) || manifest.appVersion !== undefined && !text(manifest.appVersion)) return fail('清单版本或字段无效');
  identity(manifest.packageId); identity(manifest.projectId);
  const seen = new Set<string>();
  for (const row of array(manifest.entries, JSON_ENTRIES.length)) {
    const entry = object(row, ['path', 'bytes', 'sha256']);
    if (!JSON_ENTRIES.includes(entry.path as typeof JSON_ENTRIES[number]) || seen.has(entry.path as string)
      || !integer(entry.bytes) || typeof entry.sha256 !== 'string' || !digestPattern.test(entry.sha256)) return fail('条目清单重复或摘要无效');
    const path = entry.path as string; seen.add(path);
    const content = texts[path];
    if (typeof content !== 'string' || encoder.encode(content).byteLength !== entry.bytes
      || await sha256BytesHex(encoder.encode(content)) !== entry.sha256) return fail('正文大小或摘要不符');
  }
  if (PROJECT_ARCHIVE_V4_ENTRIES.some((path) => !seen.has(path)) || Object.keys(texts).length !== seen.size + 1) return fail('条目清单没有完整覆盖正文');
  const exchange = await parseProjectExchangeBundleV2(parse('exchange.json'));
  const revision = exchange.revisions.find((item) => item.canonicalVersion === 2 && item.revisionId === exchange.head.revisionId);
  if (!revision || revision.canonicalVersion !== 2) return fail('缺少当前规范正文');
  const snapshot = validateExchangeDomainV2(revision.snapshot), files = readProjectArchiveV4Files(snapshot);
  const business: ProjectArchiveBusinessV4 = { project: parse('project.json') as ProjectArchiveProjectV4,
    episodes: parse('episodes.json') as ProjectArchiveEpisodeV4[], canvases: parse('canvases.json') as ProjectArchiveCanvasV4[],
    contents: parse('contents.json') as ProjectArchiveContentsV4 };
  const projected = buildProjectExchangeSnapshotV2(business, exchange.lineageId, snapshot.media, files, snapshot.historicalTargets);
  if (!equal(projected, snapshot)) return fail('业务正文与协作 head 不一致');
  if (manifest.packageId !== exchange.packageId || manifest.projectId !== business.project.id || manifest.projectName !== business.project.name
    || manifest.projectKind !== business.project.kind || manifest.episodeCount !== business.episodes.length || manifest.canvasCount !== business.canvases.length) return fail('清单与业务正文不一致');
  const canonical = projectArchivePayloadFromSnapshotV2(snapshot);
  const history = seen.has('history.json') ? parse('history.json') as ProjectArchiveHistoryV4 : undefined;
  validateHistory(history, snapshot);
  const byPath = new Map<string, ArchiveAssetDigest>();
  let assetBytes = 0;
  for (const asset of assets) {
    object(asset, ['path', 'bytes', 'sha256']);
    const path = safeExchangePath(asset.path), key = path.normalize('NFC').toLowerCase();
    if (asset.path !== path || byPath.has(key) || !integer(asset.bytes) || !digestPattern.test(asset.sha256)) return fail('素材路径、大小或摘要无效');
    byPath.set(key, asset); assetBytes += asset.bytes;
    if (assetBytes > PROJECT_EXCHANGE_LIMITS.mediaBytes || byPath.size > PROJECT_EXCHANGE_LIMITS.media) return fail('素材总量超过上限');
  }
  const mediaById = new Map(snapshot.media.map((item) => [item.id, item]));
  if (exchange.files.length !== assets.length) return fail('素材条目未完整覆盖');
  for (const file of exchange.files) {
    const asset = byPath.get(file.archivePath.slice('assets/'.length).normalize('NFC').toLowerCase()), media = mediaById.get(file.mediaId);
    if (!asset || asset.path !== file.archivePath.slice('assets/'.length) || !media
      || asset.bytes !== media.bytes || asset.sha256 !== media.sha256) return fail('素材载荷与规范摘要不一致');
  }
  return { manifest: manifest as unknown as ProjectArchiveManifestV4, payload: { ...canonical, exchange, ...(history ? { history } : {}) }, snapshot, files, assets };
}

/** manifest 摘要取实际 Worker 产出的 UTF-8 字节，导出前再走同一接收端校验。 */
export async function serializeProjectArchiveV4(payload: ProjectArchivePayloadV4,
  meta: { packageId: string; exportedAt: number; appVersion?: string }, assets: ArchiveAssetDigest[] = []): Promise<ProjectArchiveTextEntry[]> {
  const entries = await serializeProjectArchiveEntries([
    { path: 'project.json', value: payload.project }, { path: 'episodes.json', value: payload.episodes },
    { path: 'canvases.json', value: payload.canvases }, { path: 'contents.json', value: payload.contents },
    { path: 'exchange.json', value: payload.exchange }, ...(payload.history ? [{ path: 'history.json', value: payload.history }] : []),
  ]);
  const manifest: ProjectArchiveManifestV4 = { formatVersion: 4, ...meta, projectId: payload.project.id,
    projectName: payload.project.name, projectKind: payload.project.kind, episodeCount: payload.episodes.length,
    canvasCount: payload.canvases.length, entries: await Promise.all(entries.map(async (entry) => ({
      path: entry.path as ProjectArchiveManifestV4['entries'][number]['path'], bytes: encoder.encode(entry.content).byteLength,
      sha256: await sha256BytesHex(encoder.encode(entry.content)),
    }))) };
  const [manifestEntry] = await serializeProjectArchiveEntries([{ path: 'manifest.json', value: manifest }]);
  const result = [manifestEntry, ...entries];
  await readProjectArchiveV4(Object.fromEntries(result.map((entry) => [entry.path, entry.content])), assets);
  return result;
}
