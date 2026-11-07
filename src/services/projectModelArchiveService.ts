/** P5 新模型归档编排。只接受已登记的 fixture 仓储；正式 Store 不调用该工厂。 */
import type { ProjectExchangeMedia, ProjectExchangeObject, ProjectExchangeState } from '../types/projectExchange';
import type { ProjectArchiveBusinessV4, ProjectArchivePayloadV4, ProjectArchiveHistoryV4, ValidatedProjectArchiveV4,
  ProjectExchangeSnapshotV2, ProjectArchiveFileV4 } from '../types/projectArchiveV4';
import type { ProjectModelFixtureBusinessSession } from '../types/projectModelBusiness';
import type { ProjectModelTransferAggregate, ProjectModelTransferCapture, ProjectModelTransferExchange,
  ProjectModelTransferIdMapEntry, ProjectModelTransferImportJournal, ProjectModelTransferExportJournal,
  ProjectModelTransferHistoryRow, ProjectModelVerifiedRestoreProof } from '../types/projectModelTransfer';
import type { ProjectArchiveTextEntry } from './projectArchiveSerialization';
import type { ArchiveAssetDigest } from './projectExchangeDomain';
import { safeExchangePath, remapStoryGraphBindings } from './projectExchangeDomain';
import { captureProjectSnapshot } from './projectMergeWorkerClient';
import { readProjectArchiveContents } from './projectImportService';
import { portableArchiveChat, sanitizeLegacyArchiveProject } from './projectArchiveValidation';
import { createProjectExchangeRevisionV2, parseProjectExchangeBundleV2, findProjectExchangeBaseV2 } from './projectExchangeV2Format';
import { adaptSnapshotV1ToV2, deriveLegacyExchangeIdentity, deriveLegacyProjectionProofFromRevisions } from './projectExchangeV2Domain';
import { buildProjectExchangeSnapshotV2, projectArchivePayloadFromSnapshotV2, readProjectArchiveV4,
  readProjectArchiveV4Files, serializeProjectArchiveV4 } from './projectArchiveV4';
import { buildProjectMergePlanV2, resolveProjectMergeV2, type ProjectMergePlanV2, type ProjectMergeSideV2 } from './projectMergeV2Service';
import { createProjectModelTransferRepository } from './indexedDb/projectModelTransferRepository';
import { sha256BytesHex } from './mediaDataUrl';
import { buildProjectFolderName } from './fileService';
import type { ProjectContent, EpisodeContent } from '../types/project';
import type { StoryGraph } from '../types/storyGraph';
import { storyGraphCanonicalSnapshot } from './storyGraphService';
import { withEpisodeEditorWrite } from './episodeEditorSessionService';

export interface ProjectModelArchiveAsset extends ArchiveAssetDigest {
  rootRef: string;
  /** 仅当前受信文件端口的内存证据，不能进入portable正文、exchange或journal。 */
  localAbsolutePath?: string;
  /** 原生逐项确认指向同一文件的其他相对路径，仅用于本次捕获。 */
  aliases?: string[];
}
export interface ProjectModelArchivePort {
  inspectAssets(capture: ProjectModelTransferCapture): Promise<ProjectModelArchiveAsset[]>;
  captureImportSource?(source: ValidatedProjectArchiveV4): Promise<Pick<ProjectModelTransferImportJournal, 'sourceRef' | 'sourceFiles'>>;
  publishMedia(operation: ProjectModelTransferImportJournal, source?: ValidatedProjectArchiveV4): Promise<string>;
  verifyMediaPublication(operation: ProjectModelTransferImportJournal, reference: string): Promise<void>;
  pack(operation: ProjectModelTransferExportJournal, entries: ProjectArchiveTextEntry[], capture: ProjectModelTransferCapture,
    files: ProjectArchiveFileV4[], assets: ProjectModelArchiveAsset[]): Promise<{ outputRef: string; packageDigest: string }>;
  verifyExportPublication(operation: ProjectModelTransferExportJournal, receipt: { outputRef: string; packageDigest: string }): Promise<void>;
  recoverExportPublication(operation: ProjectModelTransferExportJournal): Promise<{ outputRef: string; packageDigest: string }>;
  createRestoreBackup?(capture: ProjectModelTransferCapture, expectedAssets?: ProjectModelArchiveAsset[]): Promise<ProjectModelVerifiedRestoreProof>;
  verifyRestoreBackup?(proof: ProjectModelVerifiedRestoreProof, capture: ProjectModelTransferCapture): Promise<void>;
  verifyRestoreCommit?(proof: ProjectModelVerifiedRestoreProof, capture: ProjectModelTransferCapture, journal: ProjectModelTransferImportJournal): Promise<void>;
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: unknown) => sha256BytesHex(new TextEncoder().encode(JSON.stringify(value)));
const refKey = (value: { canonicalVersion: number; revisionId: string }) => `${value.canonicalVersion}:${value.revisionId}`;
export async function projectModelArchiveMediaPrefix(operationId: string): Promise<string> {
  return operationId.length <= 110 ? operationId : `import-${await digest(['media-child', operationId])}`;
}
/** 物理旧根可为恢复保留；只有当前head声明或正文正在使用的根进入新的业务包。 */
export function projectModelArchiveStorageContext(capture: ProjectModelTransferCapture) {
  const head = capture.exchange?.bundle.revisions.find((item) => refKey(item) === refKey(capture.exchange!.localHead));
  const declared = (head?.canonicalVersion === 2
    ? head.snapshot.entities.find((item) => item.kind === 'project')?.data.storageRoots : undefined) as unknown as ProjectArchiveBusinessV4['project']['storageRoots'] | undefined;
  const local = (sourceId: string) => capture.exchange?.identities.find((item) => item.kind === 'storage-root' && item.sourceId === sourceId)?.localId;
  const primary = declared ? local((declared.find((item) => item.role === 'shared') ?? declared[0]).id) ?? capture.aggregate.project.storageRootRef
    : capture.aggregate.project.storageRootRef;
  const used = new Set<string>([primary]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [field, item] of Object.entries(value)) {
      if (field === 'storageRootRef' && typeof item === 'string') used.add(item); else walk(item);
    }
  };
  walk(capture.aggregate.content); walk(capture.aggregate.project.defaultSettings); walk(capture.aggregate.episodeContents); walk(capture.aggregate.canvases);
  const roots = capture.aggregate.project.storageBindings.filter((binding) => !declared || used.has(binding.rootRef)
    || declared.some((item) => local(item.id) === binding.rootRef));
  return { roots, primary, role: (rootRef: string) => declared?.find((item) => local(item.id) === rootRef)?.role
    ?? (rootRef === primary ? 'shared' as const : 'canvas' as const) };
}
/** filePath-only 先依受权根内真实扫描证据投影，不能先sanitize后静默丢掉原引用。 */
function localFileReferences(value: unknown, rootRef: string, assets: ProjectModelArchiveAsset[] = [], depth = 0, budget = { count: 0 }): unknown {
  if (++budget.count > 1_000_000 || depth > 32) throw new Error('项目记录嵌套或数量超过上限');
  if (Array.isArray(value)) return value.map((item) => localFileReferences(item, rootRef, assets, depth + 1, budget));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>, bound = typeof source.storageRootRef === 'string' ? source.storageRootRef : rootRef;
  const result = Object.fromEntries(Object.entries(source).map(([field, item]) => [field, localFileReferences(item, bound, assets, depth + 1, budget)]));
  const relative = (path: unknown): string => {
    if (typeof path !== 'string' || !path) throw new Error('素材本机路径缺少可证明的相对映射');
    const normalized = path.replace(/\\/g, '/');
    const match = assets.find((asset) => asset.rootRef === bound && (asset.localAbsolutePath
      && (/^[a-z]:\//i.test(normalized) ? asset.localAbsolutePath.replace(/\\/g, '/').toLowerCase() === normalized.toLowerCase()
        : asset.localAbsolutePath.replace(/\\/g, '/') === normalized) || asset.rootRef === bound && asset.path === normalized));
    if (!match) throw new Error('素材只有未证明来源的本机路径，请重新保存引用后归档');
    return safeExchangePath(match.path);
  };
  if (source.filePath && !source.relativePath) result.relativePath = relative(source.filePath);
  if (source.imageFilePath && !source.relativePath && !source.imageRelativePath) result.imageRelativePath = relative(source.imageFilePath);
  if (source.directorCaptureFilePaths && !source.directorCaptureRelativePaths) {
    if (!Array.isArray(source.directorCaptureFilePaths)) throw new Error('导演截图路径结构无效');
    result.directorCaptureRelativePaths = source.directorCaptureFilePaths.map(relative);
  }
  return result;
}
function withCaptureEditorLocks<T>(capture: ProjectModelTransferCapture, work: () => Promise<T>): Promise<T> {
  const owners = [...new Set([capture.aggregate.project.id, ...capture.aggregate.episodes.map((item) => item.id),
    ...capture.aggregate.bindings.map((item) => item.legacyId)])].sort();
  const lock = (index: number): Promise<T> => index === owners.length ? work() : withEpisodeEditorWrite(owners[index], () => lock(index + 1));
  return lock(0);
}

/** 旧包先由原接收器验证，原 canonical1 修订不改字节，只追加确定性迁移修订。 */
export async function readProjectModelArchive(texts: Record<string, string>, assets: ArchiveAssetDigest[]): Promise<ValidatedProjectArchiveV4> {
  const version = (JSON.parse(texts['manifest.json'] ?? 'null') as { formatVersion?: unknown } | null)?.formatVersion;
  if (version === 4) return readProjectArchiveV4(texts, assets);
  const legacy = await readProjectArchiveContents({ texts, assets });
  const records = legacy.records.map((record) => sanitizeLegacyArchiveProject(localFileReferences(record, '',
    assets.map((asset) => ({ ...asset, rootRef: '' }))) as typeof record));
  if (version === 1 && records.length === 1) records[0] = { ...records[0], parentId: undefined };
  const oldHead = legacy.bundle?.revisions.find((row) => row.revisionId === legacy.bundle!.headRevisionId);
  // 没有来源证明的旧包只能声称“同一份材料”；不能因重读随机换身份，也不能按同名推断共同祖先。
  let captureState: ProjectExchangeState | null = legacy.sourceState;
  let syntheticDigest: string | undefined;
  if (!captureState && !oldHead) {
    syntheticDigest = await digest([Object.keys(texts).sort().map((path) => [path, texts[path]]),
      [...assets].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((asset) => [safeExchangePath(asset.path), asset.bytes, asset.sha256])]);
    const lineageId = `legacy_${syntheticDigest}`, projectIds = new Map<string, string>();
    for (const record of records) projectIds.set(record.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(record.id)
      ? record.id : `project_${await digest([lineageId, record.id])}`);
    const root = projectIds.get(records[0].id)!;
    captureState = { ownerId: records[0].id, lineageId, rootProjectId: root, headRevisionId: '0'.repeat(64), stateVersion: 0,
      identities: [...records.map((record) => ({ kind: 'project' as const, scopeId: projectIds.get(record.id)!, id: projectIds.get(record.id)!, localId: record.id })),
        ...await Promise.all(assets.map(async (asset) => ({ kind: 'file' as const, scopeId: root,
          id: `file_${await digest([lineageId, root, safeExchangePath(asset.path)])}`, localId: safeExchangePath(asset.path) })))],
    };
  }
  const captured = await captureProjectSnapshot(records, assets, captureState, oldHead?.snapshot);
  const snapshotV1 = oldHead?.snapshot ?? captured.snapshot;
  const rootRef = await deriveLegacyExchangeIdentity(snapshotV1.lineageId, snapshotV1.rootProjectId, 'root');
  let snapshot = await adaptSnapshotV1ToV2(snapshotV1, {
    roots: snapshotV1.entities.filter((entity) => entity.kind === 'project').map((entity) => ({ scopeId: entity.id, rootRef })),
    files: captured.identities.filter((identity) => identity.kind === 'file' && snapshotV1.entities.some((entity) => entity.kind === 'file' && entity.id === identity.id)).map((identity) => ({
      fileId: identity.id, rootRef, relativePath: identity.localId,
    })),
  });
  const files = readProjectArchiveV4Files(snapshot);
  const conversations: ProjectArchiveHistoryV4['payload']['conversations'] = [], messages: ProjectArchiveHistoryV4['payload']['messages'] = [],
    memories: ProjectArchiveHistoryV4['payload']['memories'] = [], targets: ProjectArchiveHistoryV4['workbenchTargets'] = [];
  const origin = async (kind: string, value: { id: string; archiveOriginId?: string }) => value.archiveOriginId && /^[a-f0-9]{64}$/.test(value.archiveOriginId)
    ? value.archiveOriginId : digest([`legacy-project:${legacy.manifest.projectId}`, kind, value.id]);
  for (const payload of legacy.chat) if (payload) {
    for (const conversation of payload.conversations) {
      const { workbenchTarget, ...row } = conversation;
      conversations.push({ ...row, projectId: snapshot.rootProjectId, archiveOriginId: await origin('conversation', row) });
      if (workbenchTarget) {
        const logicalEpisode = legacy.sourceState?.identities.find((identity) => identity.kind === 'project' && identity.localId === workbenchTarget.episodeId)?.id
          ?? captured.identities.find((identity) => identity.kind === 'project' && identity.localId === workbenchTarget.episodeId)?.id
          ?? (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workbenchTarget.episodeId) ? workbenchTarget.episodeId
            : `episode_${await digest([snapshot.lineageId, 'retired-episode', workbenchTarget.episodeId])}`);
        targets.push({ conversationId: row.id, target: snapshot.entities.some((entity) => entity.kind === 'episode' && entity.id === logicalEpisode)
          ? { state: 'active', kind: 'episode', projectId: snapshot.rootProjectId, episodeId: logicalEpisode }
          : { state: 'retired', kind: 'episode', projectId: snapshot.rootProjectId, id: logicalEpisode } });
      }
    }
    for (const row of payload.messages) messages.push({ ...row, projectId: snapshot.rootProjectId, archiveOriginId: await origin('message', row) });
    for (const row of payload.memories) memories.push({ ...row, projectId: snapshot.rootProjectId, archiveOriginId: await origin('memory', row) });
  }
  const retired = new Map(snapshot.historicalTargets.map((target) => [JSON.stringify([target.kind, target.id]), target]));
  for (const { target } of targets) if (target.state === 'retired') retired.set(JSON.stringify([target.kind, target.id]), target);
  snapshot = { ...snapshot, historicalTargets: [...retired.values()] };
  const head = await createProjectExchangeRevisionV2(snapshot, oldHead ? [{ canonicalVersion: 1, revisionId: oldHead.revisionId }] : []);
  const exchange = await parseProjectExchangeBundleV2({ format: 'ai-canvas-project-exchange', version: 2,
    packageId: legacy.bundle?.packageId ?? `package_${syntheticDigest}`, lineageId: snapshot.lineageId,
    head: { canonicalVersion: 2, revisionId: head.revisionId }, revisions: [...(legacy.bundle?.revisions ?? []), head],
    ancestors: legacy.bundle?.ancestors ?? [], files: snapshot.media.map((media) => {
      const file = files.find((item) => item.mediaId === media.id)!;
      return legacy.bundle?.files.find((item) => item.mediaId === media.id) ?? { mediaId: media.id, archivePath: `assets/${file.relativePath}` };
    }) });
  const payload: ProjectArchivePayloadV4 = { ...projectArchivePayloadFromSnapshotV2(snapshot), exchange,
    ...(conversations.length || memories.length ? { history: { payload: { conversations, messages, memories }, workbenchTargets: targets } } : {}) };
  const entries = await serializeProjectArchiveV4(payload, { packageId: exchange.packageId, exportedAt: legacy.manifest.exportedAt }, assets);
  return readProjectArchiveV4(Object.fromEntries(entries.map((entry) => [entry.path, entry.content])), assets);
}

function mapGraph(value: unknown, project: (id: string) => string): unknown {
  return value ? remapStoryGraphBindings({ ...value as StoryGraph, revision: 0 }, project, (asset) => asset.id, 0) : value;
}
/** 只投影有类型语义的根/文件字段，正文、名称和提示词中的同名字符串保持原值。 */
function storageReferences(value: unknown, currentRoot: string, root: (id: string) => string,
  path: (rootRef: string, relativePath: string) => string, field = ''): unknown {
  if (typeof value === 'string' && value && ['relativePath', 'imageRelativePath', 'directorCaptureRelativePaths'].includes(field)) {
    return path(currentRoot, safeExchangePath(value));
  }
  if (Array.isArray(value)) return value.map((item) => storageReferences(item, currentRoot, root, path, field));
  if (!value || typeof value !== 'object') return value;
  const bound = typeof (value as { storageRootRef?: unknown }).storageRootRef === 'string'
    ? (value as { storageRootRef: string }).storageRootRef : currentRoot;
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field,
    field === 'storageRootRef' && typeof item === 'string' ? root(item) : storageReferences(item, bound, root, path, field)]));
}
function aggregateBusiness(capture: ProjectModelTransferCapture, mappings = capture.exchange?.identities ?? [],
  fileBindings = capture.exchange?.fileBindings ?? [], assets: ProjectModelArchiveAsset[] = []): ProjectArchiveBusinessV4 {
  const aggregate = capture.aggregate;
  const logical = (kind: ProjectModelTransferIdMapEntry['kind'], localId: string) => mappings.find((row) => row.kind === kind && row.localId === localId)?.sourceId ?? localId;
  const projectId = logical('project', aggregate.project.id), root = (id: string) => logical('storage-root', id);
  const path = (rootRef: string, relativePath: string) => {
    const asset = assets.find((item) => item.rootRef === rootRef && (item.path === relativePath || item.aliases?.includes(relativePath)));
    const actual = asset?.path ?? relativePath;
    return fileBindings.find((binding) => binding.rootRef === root(rootRef) && (binding.localRelativePath === actual
      || asset?.aliases?.includes(binding.localRelativePath)))?.relativePath ?? actual;
  };
  const storage = projectModelArchiveStorageContext(capture), projectRoot = storage.primary;
  const portable = (value: unknown, rootRef = projectRoot) => storageReferences(value, rootRef, root, path);
  const sanitized = <T>(value: T, rootRef = projectRoot): ProjectExchangeObject => json(sanitizeLegacyArchiveProject(
    localFileReferences(value, rootRef, assets) as never)) as unknown as ProjectExchangeObject;
  const { projectId: _project, revisions: _revisions, ...content } = aggregate.content;
  if (content.standaloneCreative) { const { revision: _revision, ...creative } = content.standaloneCreative; content.standaloneCreative = creative as typeof content.standaloneCreative; }
  if (content.storyGraph) content.storyGraph = storyGraphCanonicalSnapshot(mapGraph(content.storyGraph,
    (id) => logical('episode', id)) as StoryGraph) as StoryGraph;
  return json({ project: { id: projectId, name: aggregate.project.name, kind: aggregate.project.kind,
    storageRoots: storage.roots.map((binding) => ({ id: root(binding.rootRef), role: storage.role(binding.rootRef) })),
    defaultSettings: aggregate.project.defaultSettings ? portable(sanitized(aggregate.project.defaultSettings)) : undefined,
    ...(aggregate.project.kind === 'standalone' ? { standaloneCanvasId: logical('canvas', aggregate.canvases[0].id) } : {}),
  }, episodes: aggregate.episodes.map(({ id, canvasId, name, orderRank, displayNo, settingsPolicy, creationProfile, teamProfileOverride }) => ({
    id: logical('episode', id), projectId, canvasId: logical('canvas', canvasId), name, orderRank, displayNo,
    settingsPolicy: portable(sanitized(settingsPolicy, aggregate.episodeContents.find((item) => item.episodeId === id)?.storageRootRef ?? projectRoot),
      aggregate.episodeContents.find((item) => item.episodeId === id)?.storageRootRef ?? projectRoot), creationProfile, teamProfileOverride,
  })), canvases: aggregate.canvases.map(({ id, episodeId, storageRootRef, revisionScope, nodes, edges, groups }) => ({
    id: logical('canvas', id), projectId, episodeId: episodeId === null ? null : logical('episode', episodeId), storageRootRef: root(storageRootRef),
    revisionScope, nodes: portable(sanitized({ nodes }, storageRootRef).nodes, storageRootRef), edges: portable(sanitized({ edges }, storageRootRef).edges, storageRootRef), groups: portable(sanitized({ groups }, storageRootRef).groups, storageRootRef),
  })), contents: { project: { projectId, data: portable(sanitized(content)) },
    episodes: aggregate.episodeContents.map(({ episodeId, revision: _revision, ...fields }) => ({
      episodeId: logical('episode', episodeId), data: portable(sanitized(fields, fields.storageRootRef), fields.storageRootRef),
    })) } }) as ProjectArchiveBusinessV4;
}

async function materializeBusiness(business: ProjectArchiveBusinessV4, snapshot: ProjectExchangeSnapshotV2, expected: ProjectModelTransferCapture | null,
  targetId: string, operationId: string, available?: { exchange: ProjectModelTransferExchange; snapshot: ProjectExchangeSnapshotV2 }): Promise<{
    aggregate: ProjectModelTransferAggregate; identities: ProjectModelTransferIdMapEntry[];
    fileBindings: ProjectModelTransferExchange['fileBindings']; media: ProjectModelTransferImportJournal['media'];
  }> {
  const identities = [...(available?.exchange.identities ?? expected?.exchange?.identities ?? [])];
  const local = (kind: ProjectModelTransferIdMapEntry['kind'], sourceId: string): string => {
    let mapping = identities.find((entry) => entry.kind === kind && entry.sourceId === sourceId);
    if (!mapping) { mapping = { kind, sourceId, localId: kind === 'project' ? targetId : crypto.randomUUID() }; identities.push(mapping); }
    return mapping.localId;
  };
  const projectId = local('project', business.project.id), folder = expected?.aggregate.project.dataFolder ?? buildProjectFolderName(business.project.name, targetId);
  if (projectId !== targetId) throw new Error('项目逻辑映射与所选目标不一致');
  const root = (id: string) => local('storage-root', id), now = Date.now();
  const primary = business.project.storageRoots.find((entry) => entry.role === 'shared')?.id ?? business.project.storageRoots[0].id;
  const roots = business.project.storageRoots.map((entry) => root(entry.id));
  const publicationPrefix = await projectModelArchiveMediaPrefix(operationId);
  const fileBindings: ProjectModelTransferExchange['fileBindings'] = [], media: ProjectModelTransferImportJournal['media'] = [];
  const availableFiles = available ? readProjectArchiveV4Files(available.snapshot) : [];
  for (const file of readProjectArchiveV4Files(snapshot)) {
    const descriptor = snapshot.media.find((item) => item.id === file.mediaId)!;
    const before = availableFiles.find((item) => item.id === file.id && item.rootRef === file.rootRef && item.relativePath === file.relativePath);
    const previous = available?.exchange.fileBindings.find((item) => item.id === file.id && item.rootRef === file.rootRef && item.relativePath === file.relativePath);
    const localRelativePath = before?.mediaId === file.mediaId && previous ? previous.localRelativePath
      : `imports/${publicationPrefix}-root-${roots.indexOf(root(file.rootRef))}/${safeExchangePath(file.relativePath)}`;
    fileBindings.push({ id: file.id, rootRef: file.rootRef, relativePath: file.relativePath, localRelativePath });
    if (!previous || localRelativePath !== previous.localRelativePath) media.push({ rootRef: root(file.rootRef), relativePath: localRelativePath,
      bytes: descriptor.bytes, sha256: descriptor.sha256 });
  }
  const path = (rootRef: string, relativePath: string) => {
    const binding = fileBindings.find((item) => item.rootRef === rootRef && item.relativePath === relativePath);
    if (!binding) throw new Error('正文引用缺少可落盘的文件绑定'); return binding.localRelativePath;
  };
  const material = (value: unknown, rootRef = primary) => storageReferences(value, rootRef, root, path);
  const contentData = material(business.contents.project.data) as unknown as Omit<ProjectContent, 'projectId' | 'revisions'>;
  contentData.storyGraph = mapGraph(contentData.storyGraph, (id) => business.episodes.some((episode) => episode.id === id)
    ? local('episode', id) : identities.find((item) => item.kind === 'episode' && item.sourceId === id)?.localId ?? id) as typeof contentData.storyGraph;
  if (contentData.standaloneCreative) contentData.standaloneCreative.revision = 0;
  const storageBindings = json(expected?.aggregate.project.storageBindings ?? []);
  for (const entry of business.project.storageRoots) if (!storageBindings.some((binding) => binding.rootRef === root(entry.id))) storageBindings.push({
    rootRef: root(entry.id), folderName: !expected && entry.id === primary ? folder : `${folder}/roots/${root(entry.id)}`,
    sourceRecordIds: [], source: 'project-managed',
  });
  const project = { id: projectId, name: business.project.name, kind: business.project.kind, dataFolder: folder,
    storageRootRef: expected?.aggregate.project.storageRootRef ?? root(primary),
    createdAt: expected?.aggregate.project.createdAt ?? now, updatedAt: now, epoch: 0,
    storageBindings,
    defaultSettings: material(business.project.defaultSettings) as ProjectModelTransferAggregate['project']['defaultSettings'] };
  return { identities, fileBindings, media, aggregate: { project,
    content: { ...contentData, projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } },
    episodes: business.episodes.map((episode) => ({ ...episode, id: local('episode', episode.id), projectId,
      canvasId: local('canvas', episode.canvasId), createdAt: now, updatedAt: now, epoch: 0, revision: 0,
      settingsPolicy: material(episode.settingsPolicy, String(business.contents.episodes.find((item) => item.episodeId === episode.id)?.data.storageRootRef ?? primary)) as ProjectModelTransferAggregate['episodes'][number]['settingsPolicy'],
      creationProfile: episode.creationProfile as unknown as ProjectModelTransferAggregate['episodes'][number]['creationProfile'],
      teamProfileOverride: episode.teamProfileOverride as unknown as ProjectModelTransferAggregate['episodes'][number]['teamProfileOverride'] })),
    episodeContents: business.contents.episodes.map((content) => ({ ...material(content.data, String(content.data.storageRootRef ?? primary)) as Omit<EpisodeContent, 'episodeId' | 'revision'>,
      episodeId: local('episode', content.episodeId), revision: 0, storageRootRef: root(String(content.data.storageRootRef ?? primary)) })),
    canvases: business.canvases.map((canvas) => ({ ...canvas, nodes: material(canvas.nodes, canvas.storageRootRef) as unknown[],
      edges: material(canvas.edges, canvas.storageRootRef) as unknown[], groups: material(canvas.groups, canvas.storageRootRef) as unknown[], id: local('canvas', canvas.id), projectId,
      episodeId: canvas.episodeId === null ? null : local('episode', canvas.episodeId), storageRootRef: root(canvas.storageRootRef),
      revisionScope: canvas.revisionScope ?? 'project', epoch: 0, revision: 0 })), previews: [], bindings: expected?.aggregate.bindings ?? [],
  } };
}

async function historyOrigin(capture: ProjectModelTransferCapture, row: ProjectModelTransferHistoryRow): Promise<string> {
  const binding = capture.historyBindings.find((item) => item.kind === row.kind && item.localId === row.value.id);
  const explicit = binding?.archiveOriginId ?? row.value.archiveOriginId;
  if (typeof explicit === 'string' && /^[a-f0-9]{64}$/.test(explicit)) return explicit;
  if (/^[a-f0-9]{64}$/.test(row.archiveOriginId)) return row.archiveOriginId;
  const legacyRoot = capture.aggregate.bindings.find((item) => item.namespace === 'legacy-root')?.legacyId ?? capture.aggregate.project.id;
  return digest([`legacy-project:${legacyRoot}`, row.kind, row.value.id]);
}
async function captureHistory(capture: ProjectModelTransferCapture, business: ProjectArchiveBusinessV4,
  mappings = capture.exchange?.identities ?? []): Promise<ProjectArchiveHistoryV4 | undefined> {
  if (!capture.includesHistory || !capture.history.length) return;
  const rows = (kind: ProjectModelTransferHistoryRow['kind']) => capture.history.filter((item) => item.kind === kind);
  const payload = portableArchiveChat({ conversations: rows('conversation').map((item) => item.value) as never,
    messages: rows('message').map((item) => item.value) as never, memories: rows('memory').map((item) => item.value) as never });
  const source = new Map(capture.history.map((item) => [`${item.kind}:${item.value.id}`, item]));
  const origin = async (kind: ProjectModelTransferHistoryRow['kind'], id: string) => {
    const row = source.get(`${kind}:${id}`)!;
    return historyOrigin(capture, row);
  };
  const logicalEpisode = (id: string) => {
    const alias = capture.aggregate.bindings.find((binding) => binding.legacyId === id && binding.episodeId);
    const localId = alias?.episodeId ?? id;
    return mappings.find((mapping) => mapping.kind === 'episode' && mapping.localId === localId)?.sourceId ?? localId;
  };
  const workbenchTargets: ProjectArchiveHistoryV4['workbenchTargets'] = [];
  const conversations = await Promise.all(payload.conversations.map(async ({ workbenchTarget, ...row }) => {
    const stored = source.get(`conversation:${row.id}`)?.historicalTarget;
    if (stored) {
      const active = stored.state === 'active' && (stored.kind === 'episode'
        ? business.episodes.some((item) => item.id === stored.episodeId)
        : business.project.kind === 'standalone' && stored.projectId === business.project.id);
      workbenchTargets.push({ conversationId: row.id, target: stored.state === 'retired' || active ? stored
        : { state: 'retired', kind: stored.kind === 'episode' ? 'episode' : 'standalone-creative', projectId: business.project.id,
          id: stored.kind === 'episode' ? stored.episodeId : stored.projectId } });
    }
    else if (workbenchTarget) {
      const episodeId = logicalEpisode(workbenchTarget.episodeId);
      workbenchTargets.push({ conversationId: row.id, target: business.episodes.some((episode) => episode.id === episodeId)
        ? { state: 'active', kind: 'episode', projectId: business.project.id, episodeId }
        : { state: 'retired', kind: 'episode', projectId: business.project.id, id: episodeId } });
    }
    return { ...row, projectId: business.project.id, archiveOriginId: await origin('conversation', row.id) };
  }));
  return { payload: { conversations,
    messages: await Promise.all(payload.messages.map(async (row) => ({ ...row, projectId: business.project.id, archiveOriginId: await origin('message', row.id) }))),
    memories: await Promise.all(payload.memories.map(async (row) => ({ ...row, projectId: business.project.id, archiveOriginId: await origin('memory', row.id) }))),
  }, workbenchTargets };
}

async function importHistory(source: ValidatedProjectArchiveV4, targetId: string, namespace: string,
  expected: ProjectModelTransferCapture | null, options: { appendChat: boolean; appendMemories: boolean }): Promise<ProjectModelTransferHistoryRow[]> {
  const history = source.payload.history; if (!history) return [];
  const rows: ProjectModelTransferHistoryRow[] = [], ids = new Map<string, string>();
  const origin = (kind: string, row: { id: string; archiveOriginId?: string }) => row.archiveOriginId ?? digest([source.snapshot.lineageId, kind, row.id]);
  const existing = new Map<string, string>();
  for (const item of expected?.history ?? []) {
    const value = await historyOrigin(expected!, item);
    const identity = `${item.kind}:${value}`;
    if (existing.has(identity) && existing.get(identity) !== item.value.id) throw new Error('历史来源映射有歧义');
    existing.set(identity, item.value.id);
  }
  const add = async (kind: ProjectModelTransferHistoryRow['kind'], value: { id: string; [field: string]: unknown }) => {
    const archiveOriginId = await origin(kind, value), id = `archive-${await digest([targetId, namespace, kind, archiveOriginId])}`;
    ids.set(`${kind}:${value.id}`, id);
    const local = expected?.historyBindings.find((binding) => binding.sourceNamespace === namespace && binding.kind === kind
      && binding.archiveOriginId === archiveOriginId)?.localId ?? existing.get(`${kind}:${archiveOriginId}`);
    const historicalTarget = kind === 'conversation' ? history.workbenchTargets.find((binding) => binding.conversationId === value.id)?.target : undefined;
    rows.push({ kind, sourceNamespace: namespace, archiveOriginId, ...(local ? { existingLocalId: local } : {}),
      ...(historicalTarget ? { historicalTarget } : {}), value: { ...value, id, projectId: targetId } });
  };
  if (options.appendChat) {
    for (const row of history.payload.conversations) await add('conversation', { ...row, agentMode: 'plan', pinned: false });
    for (const row of history.payload.messages) await add('message', { ...row });
  }
  if (options.appendMemories) for (const row of history.payload.memories) await add('memory', { ...row });
  for (const row of rows) {
    if (row.kind === 'message') row.value.conversationId = ids.get(`conversation:${row.value.conversationId}`);
    if (row.kind === 'memory') {
      const previous = row.value.source as { conversationId: string; messageId?: string; unavailable?: boolean };
      const conversationId = options.appendChat ? ids.get(`conversation:${previous.conversationId}`) : undefined;
      row.value.source = { conversationId: conversationId ?? '', ...(conversationId && previous.messageId
        ? { messageId: ids.get(`message:${previous.messageId}`) } : {}), unavailable: previous.unavailable === true || !conversationId };
    }
  }
  return rows;
}

export interface ProjectModelArchivePreview {
  source: ValidatedProjectArchiveV4;
  expected: ProjectModelTransferCapture | null;
  plan: ProjectMergePlanV2 | null;
  localSnapshot?: ProjectExchangeSnapshotV2;
  localExchange?: ProjectModelTransferExchange;
  localAssets?: ProjectModelArchiveAsset[];
  packageDigest: string;
}

export function createProjectModelArchiveService(database: IDBDatabase, session: ProjectModelFixtureBusinessSession, port: ProjectModelArchivePort) {
  const repository = createProjectModelTransferRepository(database, session, {
    verifyMediaPublication: (operation, ref) => port.verifyMediaPublication(operation, ref),
    verifyExportPublication: (operation, receipt) => port.verifyExportPublication(operation, receipt),
    verifyRestoreBackup: (proof, capture) => {
      if (!port.verifyRestoreBackup) throw new Error('没有专用耐久备份校验器，未恢复作品');
      return port.verifyRestoreBackup(proof, capture);
    },
    verifyRestoreCommit: (proof, capture, journal) => {
      if (!port.verifyRestoreCommit) throw new Error('没有恢复提交前耐久备份校验器，未恢复作品');
      return port.verifyRestoreCommit(proof, capture, journal);
    },
  });
  const current = async (capture: ProjectModelTransferCapture) => {
    if ((await repository.capture(capture.aggregate.project.id, { history: capture.includesHistory }))?.sourceToken !== capture.sourceToken) throw new Error('项目或历史在归档期间变化，请重新预览');
  };
  async function prepareCapture(capture: ProjectModelTransferCapture) {
    const lineageId = capture.exchange?.lineageId ?? crypto.randomUUID();
    const roots = capture.aggregate.project.storageBindings;
    const identities = [...(capture.exchange?.identities ?? [])];
    // P3 的 legacy-root:UUID 是本机定位，不是 portable ID；首次投影必须在构造业务正文前冻结映射。
    for (const [kind, ids] of [['project', [capture.aggregate.project.id]], ['episode', capture.aggregate.episodes.map((item) => item.id)],
      ['canvas', capture.aggregate.canvases.map((item) => item.id)], ['storage-root', roots.map((item) => item.rootRef)]] as const) {
      for (const localId of ids) if (!identities.some((entry) => entry.kind === kind && entry.localId === localId)) identities.push({ kind,
        sourceId: kind !== 'storage-root' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(localId)
          ? localId : `${kind === 'storage-root' ? 'root' : kind}_${await digest([lineageId, kind, localId])}`, localId });
    }
    const assets = await port.inspectAssets(capture), business = aggregateBusiness(capture, identities, capture.exchange?.fileBindings, assets);
    const logicalRoot = (id: string) => identities.find((mapping) => mapping.kind === 'storage-root' && mapping.localId === id)!.sourceId;
    const media = new Map<string, ProjectExchangeMedia>(), files: ProjectArchiveFileV4[] = [];
    const fileBindings: ProjectModelTransferExchange['fileBindings'] = [];
    for (const asset of assets) {
      if (!roots.some((root) => root.rootRef === asset.rootRef)) throw new Error('素材来源根不属于捕获项目');
      safeExchangePath(asset.path);
      const rootRef = logicalRoot(asset.rootRef);
      const previous = capture.exchange?.fileBindings.find((binding) => binding.rootRef === rootRef
        && (binding.localRelativePath === asset.path || asset.aliases?.includes(binding.localRelativePath)));
      const relativePath = previous?.relativePath ?? asset.path;
      const extension = relativePath.split('.').pop()?.toLowerCase() ?? 'bin', ext = /^[a-z0-9]{1,16}$/.test(extension) ? extension : 'bin';
      const previousHead = capture.exchange?.bundle.revisions.find((item) => refKey(item) === refKey(capture.exchange!.localHead));
      const previousFile = previousHead?.canonicalVersion === 2 && previous
        ? readProjectArchiveV4Files(previousHead.snapshot).find((item) => item.id === previous.id) : undefined;
      const oldMedia = previousHead?.canonicalVersion === 2 && previousFile
        ? previousHead.snapshot.media.find((item) => item.id === previousFile.mediaId && item.sha256 === asset.sha256 && item.bytes === asset.bytes) : undefined;
      const mediaId = oldMedia?.id ?? `${asset.sha256}_${ext}`;
      media.set(mediaId, oldMedia ?? { id: mediaId, bytes: asset.bytes, sha256: asset.sha256, extension: ext,
        kind: /^(png|jpe?g|webp|gif|avif)$/.test(ext) ? 'image' : /^(mp4|mov|webm|mkv)$/.test(ext) ? 'video' : /^(mp3|wav|ogg|m4a|flac)$/.test(ext) ? 'audio' : 'file' });
      const id = previous?.id ?? `file_${await digest([lineageId, rootRef, relativePath])}`;
      files.push({ id, rootRef, relativePath, mediaId });
      fileBindings.push({ id, rootRef, relativePath, localRelativePath: previous?.localRelativePath ?? asset.path });
    }
    const history = await captureHistory(capture, business, identities);
    const previous = capture.exchange?.bundle.revisions.find((revision) => refKey(revision) === refKey(capture.exchange!.localHead));
    const retired = new Map(previous?.canonicalVersion === 2 ? previous.snapshot.historicalTargets.map((target) => [JSON.stringify([target.kind, target.id]), target]) : []);
    for (const binding of history?.workbenchTargets ?? []) if (binding.target.state === 'retired') retired.set(JSON.stringify([binding.target.kind, binding.target.id]), binding.target);
    const snapshot = buildProjectExchangeSnapshotV2(business, lineageId, [...media.values()], files, [...retired.values()]);
    const createdHead = await createProjectExchangeRevisionV2(snapshot, capture.exchange ? [capture.exchange.localHead] : []);
    const head = previous?.canonicalVersion === 2 && previous.contentDigest === createdHead.contentDigest ? previous : createdHead;
    const revisions = [...(capture.exchange?.bundle.revisions ?? []).filter((revision) => refKey(revision) !== refKey(head)), head];
    const bundle = await parseProjectExchangeBundleV2({ format: 'ai-canvas-project-exchange', version: 2, packageId: crypto.randomUUID(),
      lineageId, head: { canonicalVersion: 2, revisionId: head.revisionId }, revisions, ancestors: capture.exchange?.bundle.ancestors ?? [],
      files: [...media.values()].map((value) => ({ mediaId: value.id, archivePath: `assets/${value.id}.${value.extension}` })) });
    await current(capture);
    const exchange: ProjectModelTransferExchange = { lineageId, localHead: bundle.head, bundle,
      stateVersion: (capture.exchange?.stateVersion ?? 0) + 1, identities, fileBindings, published: capture.exchange?.published ?? [] };
    return { assets, files, snapshot, exchange, payload: { ...business, exchange: bundle, ...(history ? { history } : {}) } as ProjectArchivePayloadV4 };
  }
  async function preview(source: ValidatedProjectArchiveV4, targetId?: string): Promise<ProjectModelArchivePreview> {
    // 重新经过收件校验，不能拿任意伪造的 Validated 类型对象取得写入。
    const entries = await serializeProjectArchiveV4(source.payload, source.manifest, source.assets);
    source = await readProjectArchiveV4(Object.fromEntries(entries.map((entry) => [entry.path, entry.content])), source.assets);
    const expected = targetId ? await repository.capture(targetId, { history: true }) : null;
    if (targetId && !expected) throw new Error('更新目标已删除');
    let plan: ProjectMergePlanV2 | null = null, localSnapshot: ProjectExchangeSnapshotV2 | undefined, localExchange: ProjectModelTransferExchange | undefined,
      localAssets: ProjectModelArchiveAsset[] | undefined;
    if (expected) {
      if (!expected.exchange || expected.exchange.lineageId !== source.snapshot.lineageId) throw new Error('目标缺少可证明的共同来源，请导入为独立项目');
      const prepared = await prepareCapture(expected); localSnapshot = prepared.snapshot; localExchange = prepared.exchange; localAssets = prepared.assets;
      const graph = [...expected.exchange.bundle.revisions, ...source.payload.exchange.revisions];
      const base = await findProjectExchangeBaseV2(expected.exchange.localHead, source.payload.exchange.head, graph,
        [...expected.exchange.bundle.ancestors, ...source.payload.exchange.ancestors]);
      if (base.status !== 'found') throw new Error(`无法自动合并：${base.status}，请补充完整基线材料`);
      const baseProof = base.revision.canonicalVersion === 1 ? await deriveLegacyProjectionProofFromRevisions(base.revision, graph) : undefined;
      plan = await buildProjectMergePlanV2(base.revision.snapshot, localSnapshot, source.snapshot, { base: baseProof });
    }
    return { source, expected, plan, localSnapshot, localExchange, localAssets, packageDigest: await digest([source.manifest, source.payload.exchange]) };
  }
  async function finishImport(operation: ProjectModelTransferImportJournal, signal?: AbortSignal) {
    if (['db_committed', 'projected', 'finalized'].includes(operation.phase)) return operation;
    if (operation.phase === 'prepared') operation = await repository.advanceImport(operation.operationId, operation.sequence, 'media_publishing', { signal });
    if (operation.phase === 'media_publishing') {
      const ref = await port.publishMedia(operation);
      operation = await repository.advanceImport(operation.operationId, operation.sequence, 'media_ready', { mediaPublicationRef: ref, signal });
    }
    return repository.commitImport(operation.operationId, operation.sequence, { signal });
  }
  return { repository, preview,
    async exportProject(projectId: string, operationId: string = crypto.randomUUID()) {
      const capture = await repository.capture(projectId, { history: true }); if (!capture) throw new Error('项目不存在');
      return withCaptureEditorLocks(capture, async () => {
        const prepared = await prepareCapture(capture);
        const entries = await serializeProjectArchiveV4(prepared.payload, { packageId: prepared.exchange.bundle.packageId, exportedAt: Date.now() },
          prepared.exchange.bundle.files.map((file) => { const value = prepared.snapshot.media.find((media) => media.id === file.mediaId)!;
            return { path: file.archivePath.slice(7), bytes: value.bytes, sha256: value.sha256 }; }));
        await current(capture);
        let operation = await repository.prepareExport({ operationId, capture, exchange: prepared.exchange });
        if (operation.phase === 'aborted') throw new Error('该导出已撤销，请使用新操作选择输出');
        if (operation.phase !== 'prepared') throw new Error('该导出已有发布尝试，请核对原操作，不重新打包');
        operation = await repository.advanceExport(operationId, operation.sequence, 'packing');
        const receipt = await port.pack(operation, entries, capture, prepared.files, prepared.assets);
        operation = await repository.advanceExport(operationId, operation.sequence, 'published', receipt);
        return repository.advanceExport(operationId, operation.sequence, 'registered', receipt);
      });
    },
    async apply(previewed: ProjectModelArchivePreview, options: { operationId: string; mode: 'import-new' | 'update-existing' | 'independent-copy' | 'restore-content';
      choices?: Readonly<Record<string, ProjectMergeSideV2>>; appendChat?: boolean; appendMemories?: boolean; signal?: AbortSignal }) {
      options.signal?.throwIfAborted();
      const intentDigest = await digest([previewed.packageDigest, previewed.expected?.sourceToken, options.mode, options.choices ?? {}, options.appendChat, options.appendMemories]);
      const existingOperation = await repository.findImport(options.operationId);
      if (existingOperation && (existingOperation.packageDigest !== previewed.packageDigest || existingOperation.intentDigest !== intentDigest
        || existingOperation.mode !== options.mode)) throw new Error('原操作已绑定另一份预览或冲突选择');
      // 已落 journal 就只推进第一次冻结的 next/映射/证明，不能重跑合并、随机ID分配或安全备份。
      if (existingOperation) return finishImport(existingOperation, options.signal);
      if (previewed.expected) await current(previewed.expected);
      let snapshot = options.mode === 'restore-content' ? previewed.source.snapshot
        : previewed.plan ? resolveProjectMergeV2(previewed.plan, options.choices ?? {}) : previewed.source.snapshot;
      const expected = previewed.expected, targetId = expected?.aggregate.project.id ?? crypto.randomUUID();
      if ((options.mode === 'update-existing' || options.mode === 'restore-content') !== !!expected) throw new Error('操作模式与所选更新目标不一致');
      if (options.mode === 'independent-copy') snapshot = { ...snapshot, lineageId: crypto.randomUUID() };
      const material = await materializeBusiness(projectArchivePayloadFromSnapshotV2(snapshot), snapshot, expected, targetId, options.operationId,
        previewed.localExchange && previewed.localSnapshot ? { exchange: previewed.localExchange, snapshot: previewed.localSnapshot } : undefined);
      const source = port.captureImportSource ? await port.captureImportSource(previewed.source) : { sourceRef: undefined, sourceFiles: [] };
      if (previewed.source.files.length && (!source.sourceRef || !source.sourceFiles?.length)) throw new Error('缺少可恢复的隔离素材来源，未准备导入');
      let restoreProof: ProjectModelVerifiedRestoreProof | undefined;
      if (options.mode === 'restore-content') {
        if (!port.createRestoreBackup || !expected) throw new Error('没有恢复前安全备份入口，未恢复');
        restoreProof = await port.createRestoreBackup(expected, previewed.localAssets); await current(expected);
      }
      const parents = options.mode === 'independent-copy' ? [] : expected
        ? [expected.exchange!.localHead, previewed.source.payload.exchange.head] : [previewed.source.payload.exchange.head];
      const head = await createProjectExchangeRevisionV2(snapshot, [...new Map(parents.map((ref) => [refKey(ref), ref])).values()]);
      const sourceBundle = previewed.source.payload.exchange, old = expected?.exchange?.bundle;
      const revisions = options.mode === 'independent-copy' ? [head]
        : [...new Map([...(old?.revisions ?? []), ...sourceBundle.revisions, head].map((row) => [refKey(row), row])).values()];
      const ancestors = options.mode === 'independent-copy' ? []
        : [...new Map([...(old?.ancestors ?? []), ...sourceBundle.ancestors].map((row) => [refKey(row), row])).values()].filter((row) => !revisions.some((revision) => refKey(row) === refKey(revision)));
      const bundle = await parseProjectExchangeBundleV2({ ...sourceBundle, lineageId: snapshot.lineageId,
        packageId: crypto.randomUUID(), head: { canonicalVersion: 2, revisionId: head.revisionId }, revisions, ancestors,
        files: snapshot.media.map((media) => ({ mediaId: media.id, archivePath: `assets/${media.id}.${media.extension}` })) });
      const exchange: ProjectModelTransferExchange = { lineageId: snapshot.lineageId, localHead: bundle.head, bundle,
        identities: material.identities, fileBindings: material.fileBindings,
        stateVersion: (expected?.exchange?.stateVersion ?? 0) + 1, published: expected?.exchange?.published ?? [] };
      const history = options.mode === 'restore-content' ? [] : await importHistory(previewed.source, targetId, snapshot.lineageId, expected,
        { appendChat: options.appendChat === true, appendMemories: options.appendMemories === true });
      const operation = await repository.prepareImport({ operationId: options.operationId, mode: options.mode, packageDigest: previewed.packageDigest,
        intentDigest, sourceLineageId: previewed.source.snapshot.lineageId, ...source,
        targetProjectId: targetId, expected, next: material.aggregate, exchange, idMap: material.identities, history, media: material.media, restoreProof, signal: options.signal });
      return finishImport(operation, options.signal);
    },
    async recoverImport(operationId: string) { return repository.recoveryDisposition(operationId); },
    async resumeImport(operationId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      return finishImport(await repository.readImport(operationId), signal);
    },
    async recoverExport(operationId: string) {
      let operation = await repository.readExport(operationId);
      if (operation.phase === 'registered') return operation;
      if (operation.phase === 'aborted') throw new Error('该导出已撤销，请使用新操作选择输出');
      if (operation.phase === 'prepared') throw new Error('原操作尚未发布，请重新选择输出');
      const receipt = await port.recoverExportPublication(operation);
      if (operation.phase === 'packing') operation = await repository.advanceExport(operationId, operation.sequence, 'published', receipt);
      return repository.advanceExport(operationId, operation.sequence, 'registered', receipt);
    },
    async abandonPreparedExport(operationId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const operation = await repository.readExport(operationId);
      return repository.abandonPreparedExport(operationId, operation.sequence, { signal });
    },
    async markProjected(operationId: string) {
      let operation = await repository.readImport(operationId);
      if (operation.phase === 'db_committed') operation = await repository.advanceImport(operationId, operation.sequence, 'projected');
      if (operation.phase === 'projected') operation = await repository.advanceImport(operationId, operation.sequence, 'finalized');
      return operation;
    },
  };
}
