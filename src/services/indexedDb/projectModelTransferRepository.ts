/** P5 fixture 聚合事务与传输 journal；不打开正式库，不发布/删除文件，不恢复审计或LS。 */
import type { CanvasDocument, CanvasPreview, EpisodeContent, EpisodeRecord, LegacyProjectBinding, ProjectContent, ProjectRecord } from '../../types/project';
import type { ProjectModelFixtureBusinessSession, ProjectModelStored } from '../../types/projectModelBusiness';
import type {
  ProjectModelArchiveHistoryBinding, ProjectModelExportPhase, ProjectModelImportPhase, ProjectModelTransferAggregate,
  ProjectModelTransferCapture, ProjectModelTransferExchange, ProjectModelTransferExportJournal, ProjectModelTransferHistoryKind,
  ProjectModelTransferHistoryRow, ProjectModelTransferImportInput, ProjectModelTransferImportJournal,
  ProjectModelTransferSafety,
} from '../../types/projectModelTransfer';
import { createProjectModelStagingRepository, projectModelSourceToken } from './projectModelStagingRepository';
import { readProjectModelBusinessMarker, validateProjectModelTransferAggregate } from './projectModelBusinessRepository';
import { assertNoProjectModelCredentials, isProjectModelFixtureBackupStore, isProjectModelFixtureBackupMetadataKey,
  PROJECT_MODEL_BACKUP_LIMITS, type ProjectModelBackupSource, type ProjectModelBackupStore } from '../projectModelBackup';
import { isKnownExcludedProjectModelBackupStore, isKnownExcludedProjectModelBackupMetadataKey,
  estimateLegacyBackupValueBytes } from './projectModelMigrationRepository';
import { safeExchangePath } from '../projectExchangeDomain';
import { parseProjectExchangeBundleV2 } from '../projectExchangeV2Format';
import { PROJECT_EXCHANGE_LIMITS } from '../projectExchangeFormat';

const META = 'metadata';
const TABLES = ['projectRoots', 'projectContents', 'episodes', 'episodeContents', 'canvasDocuments', 'canvasPreviews', 'legacyProjectBindings'];
const HISTORY = { conversation: 'chatConversations', message: 'chatMessages', memory: 'projectMemories' } as const;
const IMPORT_PHASES: ProjectModelImportPhase[] = ['prepared', 'media_publishing', 'media_ready', 'db_committed', 'projected', 'finalized'];
const EXPORT_PHASES: ProjectModelExportPhase[] = ['prepared', 'packing', 'published', 'registered', 'aborted'];
const error = (code: string) => new Error('项目模型隔离传输未完成：' + code);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const operation = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function increment(value: number): number { if (!integer(value) || value >= Number.MAX_SAFE_INTEGER) throw error('revision-overflow'); return value + 1; }
function data<T>(input: T): T { projectModelSourceToken(input); assertNoProjectModelCredentials(input); return structuredClone(input); }
function row<T>(input: ProjectModelStored<T>): T {
  const { generation: _generation, operationId: _operationId, ...value } = input;
  return value as T;
}
function request<T>(input: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { input.onsuccess = () => resolve(input.result); input.onerror = () => reject(input.error); });
}
function boundedRows<T>(source: IDBObjectStore | IDBIndex, range: IDBKeyRange | IDBValidKey | undefined,
  budget: { rows: number; bytes: number; maxRows: number; maxBytes: number }, keep: (value: T) => boolean = () => true): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const values: T[] = [], cursor = source.openCursor(range);
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      try {
        const current = cursor.result;
        if (!current) { resolve(values); return; }
        const value = current.value as T;
        budget.bytes += estimateLegacyBackupValueBytes(value, budget.maxBytes);
        if (++budget.rows > budget.maxRows || budget.bytes > budget.maxBytes) throw error('capture-capacity');
        if (keep(value)) values.push(value);
        current.continue();
      } catch (failure) { reject(failure); }
    };
  });
}
function transaction<T>(database: IDBDatabase, tables: string[], write: boolean,
  work: (tx: IDBTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const names = [...new Set([META, ...tables])];
  let tx: IDBTransaction;
  try { tx = database.transaction(names, write ? 'readwrite' : 'readonly', { durability: 'strict' }); }
  catch (failure) {
    if (!(failure instanceof TypeError) && !(failure instanceof DOMException && failure.name === 'NotSupportedError')) throw failure;
    tx = database.transaction(names, write ? 'readwrite' : 'readonly');
  }
  let value: T, failure: unknown;
  const abort = () => { failure = new DOMException('项目传输已取消', 'AbortError'); try { tx.abort(); } catch { /* 已结束 */ } };
  signal?.addEventListener('abort', abort, { once: true });
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(value); };
    tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? error('transaction-aborted')); };
    tx.onerror = () => { failure ??= tx.error; };
    void work(tx).then((result) => { value = result; }).catch((cause: unknown) => {
      failure = cause; try { tx.abort(); } catch { cleanup(); reject(cause); }
    });
    if (signal?.aborted) abort();
  });
}
function compare(left: unknown, right: unknown): boolean { return projectModelSourceToken(left) === projectModelSourceToken(right); }
function bindingKey(value: Pick<ProjectModelArchiveHistoryBinding, 'destinationProjectId' | 'sourceNamespace' | 'kind' | 'archiveOriginId'>): IDBValidKey[] {
  return [value.destinationProjectId, value.sourceNamespace, value.kind, value.archiveOriginId];
}
type HistoricalTarget = NonNullable<ProjectModelArchiveHistoryBinding['historicalTarget']>;
function historicalIdentity(value: HistoricalTarget): string {
  return JSON.stringify([value.kind === 'project' ? value.domain : value.kind, value.projectId,
    value.state === 'retired' ? value.id : value.kind === 'episode' ? value.episodeId : value.projectId]);
}
function historyTransition(previous: HistoricalTarget | undefined, next: HistoricalTarget | undefined): boolean {
  return compare(previous, next) || !!previous && !!next && previous.state === 'active' && next.state === 'retired'
    && historicalIdentity(previous) === historicalIdentity(next);
}
function reference(value: { canonicalVersion: number; revisionId: string }): void {
  if (![1, 2].includes(value.canonicalVersion) || !hash(value.revisionId)) throw error('invalid-head-reference');
}
function closed(value: object, fields: readonly string[]): void {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((field) => !fields.includes(field))) throw error('unsupported-transfer-fields');
}
function validateExchange(value: ProjectModelTransferExchange | null): void {
  if (value === null) return;
  closed(value, ['lineageId', 'localHead', 'stateVersion', 'bundle', 'identities', 'fileBindings', 'published']);
  if (!id(value.lineageId) || !integer(value.stateVersion) || value.stateVersion < 1 || !Array.isArray(value.published)
    || !Array.isArray(value.identities) || !Array.isArray(value.fileBindings) || value.bundle?.version !== 2 || value.bundle.lineageId !== value.lineageId
    || value.identities.length > PROJECT_EXCHANGE_LIMITS.entities || value.fileBindings.length > PROJECT_EXCHANGE_LIMITS.media
    || !compare(value.localHead, value.bundle.head)) throw error('invalid-exchange-state');
  reference(value.localHead);
  const logical = new Set<string>(), local = new Set<string>();
  for (const mapping of value.identities) {
    closed(mapping, ['kind', 'sourceId', 'localId']);
    const sourceKey = JSON.stringify([mapping.kind, mapping.sourceId]), localKey = JSON.stringify([mapping.kind, mapping.localId]);
    if (!['project', 'episode', 'canvas', 'storage-root'].includes(mapping.kind) || !id(mapping.sourceId) || !id(mapping.localId)
      || logical.has(sourceKey) || local.has(localKey)) throw error('invalid-exchange-identities');
    logical.add(sourceKey); local.add(localKey);
  }
  const fileIds = new Set<string>(), paths = new Set<string>(), localPaths = new Set<string>();
  for (const binding of value.fileBindings) {
    closed(binding, ['id', 'rootRef', 'relativePath', 'localRelativePath']);
    if (!id(binding.id) || !id(binding.rootRef)) throw error('invalid-file-binding');
    safeExchangePath(binding.relativePath); safeExchangePath(binding.localRelativePath);
    const path = JSON.stringify([binding.rootRef, binding.relativePath]), localPath = JSON.stringify([binding.rootRef, binding.localRelativePath.normalize('NFC').toLowerCase()]);
    if (fileIds.has(binding.id) || paths.has(path) || localPaths.has(localPath)) throw error('duplicate-file-binding');
    fileIds.add(binding.id); paths.add(path); localPaths.add(localPath);
  }
  for (const item of value.published) {
    closed(item, ['operationId', 'packageDigest', 'outputRef', 'head']);
    if (!operation(item.operationId) || !hash(item.packageDigest) || !opaque(item.outputRef)) throw error('invalid-publication-receipt');
    reference(item.head);
  }
}
async function verifiedExchange(value: ProjectModelTransferExchange | null, previous: ProjectModelTransferExchange | null = null): Promise<void> {
  validateExchange(value);
  if (!value) { if (previous) throw error('cannot-drop-exchange-history'); return; }
  if (value.stateVersion !== (previous?.stateVersion ?? 0) + 1) throw error('exchange-state-version-conflict');
  value.bundle = await parseProjectExchangeBundleV2(value.bundle);
  const head = value.bundle.revisions.find((revision) => revision.canonicalVersion === value.bundle.head.canonicalVersion
    && revision.revisionId === value.bundle.head.revisionId);
  if (!head || head.canonicalVersion !== 2) throw error('missing-head');
  const files = head.snapshot.entities.filter((entity) => entity.kind === 'file');
  if (files.length !== value.fileBindings.length || files.some((file) => !value.fileBindings.some((binding) => binding.id === file.id
    && binding.rootRef === file.data.rootRef && binding.relativePath === file.data.relativePath
    && value.identities.some((mapping) => mapping.kind === 'storage-root' && mapping.sourceId === binding.rootRef)))) throw error('file-binding-closure');
  if (!previous) return;
  if (value.lineageId !== previous.lineageId) throw error('lineage-changed');
  if (!previous.identities.every((old) => value.identities.some((mapping) => compare(old, mapping)))) throw error('accepted-identities-changed');
  const keyOf = (item: { canonicalVersion: number; revisionId: string }) => JSON.stringify([item.canonicalVersion, item.revisionId]);
  const graph = new Map([...value.bundle.revisions, ...value.bundle.ancestors].map((entry) => [keyOf(entry), entry]));
  for (const old of [...previous.bundle.revisions, ...previous.bundle.ancestors]) {
    const retained = graph.get(keyOf(old));
    if (!retained) throw error('accepted-history-truncated');
    if ('snapshot' in old ? !compare(old, retained) : !compare(old, 'snapshot' in retained
      ? Object.fromEntries(Object.entries(retained).filter(([field]) => field !== 'snapshot')) : retained)) throw error('immutable-revision-conflict');
  }
  const pending = [value.localHead], seen = new Set<string>();
  let reaches = false;
  while (pending.length) {
    const current = pending.pop()!, keyValue = keyOf(current);
    if (keyValue === keyOf(previous.localHead)) { reaches = true; break; }
    if (seen.has(keyValue)) continue; seen.add(keyValue);
    const revision = graph.get(keyValue);
    if (revision) pending.push(...(revision.canonicalVersion === 1
      ? revision.parentRevisionIds.map((revisionId) => ({ canonicalVersion: 1 as const, revisionId })) : revision.parents));
  }
  if (!reaches) throw error('new-head-does-not-preserve-current');
  if (!previous.published.every((receipt) => value.published.some((item) => compare(item, receipt)))) throw error('publication-history-truncated');
}

/** 同一 fixture session 的新表是唯一权威；journal存在不能替代已提交标记。 */
export function createProjectModelTransferRepository(database: IDBDatabase, session: ProjectModelFixtureBusinessSession,
  safety: ProjectModelTransferSafety = {}) {
  createProjectModelStagingRepository(database);
  session = data(session);
  safety = { ...safety };
  if (!operation(session.operationId) || !operation(session.sessionId) || !integer(session.generation) || session.generation < 1) throw error('invalid-session');
  const generation = session.generation;
  const key = (value: string): IDBValidKey[] => [generation, value];
  const importKey = (operationId: string) => `project-model-import:${generation}:${operationId}`;
  const exportKey = (operationId: string) => `project-model-export:${generation}:${operationId}`;
  const exchangeKey = (projectId: string) => `project-model-exchange:${generation}:${projectId}`;
  const recoveryKey = (operationId: string) => `project-model-recovery:${generation}:${operationId}`;
  const tombstoneKey = (kind: string, value: string) => `project-model-business-tombstone:${session.operationId}:${kind}:${value}`;
  const stored = <T extends object>(value: T): ProjectModelStored<T> => ({ ...value, generation, operationId: session.operationId });
  const guard = (tx: IDBTransaction) => readProjectModelBusinessMarker(tx, session);
  const allTables = (history: boolean) => [...TABLES, 'archiveHistoryBindings', ...(history ? Object.values(HISTORY) : [])];
  async function assertNoUnfinishedExport(tx: IDBTransaction, projectId: string): Promise<void> {
    await boundedRows<ProjectModelTransferExportJournal>(tx.objectStore(META),
      IDBKeyRange.bound(`project-model-export:${generation}:`, `project-model-export:${generation}:\uffff`),
      { rows: 0, bytes: 0, maxRows: PROJECT_EXCHANGE_LIMITS.entities, maxBytes: PROJECT_MODEL_BACKUP_LIMITS.maxTotalBytes },
      (value) => { if (value.targetProjectId === projectId && (value.schemaVersion !== 1 || value.kind !== 'project-model-export'
        || !['registered', 'aborted'].includes(value.phase))) throw error('unfinished-export-present'); return false; });
  }

  async function captureIn(tx: IDBTransaction, projectId: string, history: boolean): Promise<ProjectModelTransferCapture | null> {
    if (!id(projectId)) throw error('invalid-project');
    const marker = await guard(tx);
    const budget = { rows: 0, bytes: 0, maxRows: PROJECT_EXCHANGE_LIMITS.entities, maxBytes: PROJECT_EXCHANGE_LIMITS.snapshotBytes };
    const project = await request<ProjectModelStored<ProjectRecord> | undefined>(tx.objectStore('projectRoots').get(key(projectId)));
    if (!project) return null;
    if (project.generation !== generation || project.operationId !== session.operationId) throw error('invalid-project-owner');
    const content = await request<ProjectModelStored<ProjectContent> | undefined>(tx.objectStore('projectContents').get(key(projectId)));
    if (!content) throw error('missing-project-content');
    const episodes = await boundedRows<ProjectModelStored<EpisodeRecord>>(tx.objectStore('episodes').index('projectId_orderRank'),
      IDBKeyRange.bound([generation, projectId], [generation, projectId, []]), budget);
    const canvases = await boundedRows<ProjectModelStored<CanvasDocument>>(tx.objectStore('canvasDocuments').index('projectId'), [generation, projectId], budget);
    const episodeContents = await Promise.all(episodes.map((episode) => request<ProjectModelStored<EpisodeContent> | undefined>(
      tx.objectStore('episodeContents').get(key(episode.id)))));
    if (episodeContents.some((item) => !item)) throw error('missing-episode-content');
    const previews = await Promise.all(canvases.map((canvas) => request<ProjectModelStored<CanvasPreview> | undefined>(
      tx.objectStore('canvasPreviews').get(key(canvas.id)))));
    const bindings = await boundedRows<ProjectModelStored<LegacyProjectBinding>>(tx.objectStore('legacyProjectBindings').index('projectId'), [generation, projectId], budget);
    const aggregate: ProjectModelTransferAggregate = { project: row(project), content: row(content), episodes: episodes.map(row),
      episodeContents: episodeContents.map((item) => row(item!)), canvases: canvases.map(row).sort((a, b) => a.id.localeCompare(b.id)),
      previews: previews.filter((item): item is ProjectModelStored<CanvasPreview> => !!item).map(row).sort((a, b) => a.canvasId.localeCompare(b.canvasId)),
      bindings: bindings.map(row).sort((a, b) => JSON.stringify([a.namespace, a.legacyId]).localeCompare(JSON.stringify([b.namespace, b.legacyId]))) };
    // 老绝对引用原值可读；写入时才与本次前置快照比较并拒绝新绝对引用。
    validateProjectModelTransferAggregate(aggregate, aggregate);
    const exchangeRecord = await request<{ value: ProjectModelTransferExchange } | undefined>(tx.objectStore(META).get(exchangeKey(projectId)));
    const exchange = exchangeRecord?.value ?? null;
    validateExchange(exchange);
    const historyBindings = await boundedRows<ProjectModelArchiveHistoryBinding>(tx.objectStore('archiveHistoryBindings'),
      IDBKeyRange.bound([projectId], [projectId, []]), budget);
    historyBindings.sort((a, b) => JSON.stringify(bindingKey(a)).localeCompare(JSON.stringify(bindingKey(b))));
    const historyRows: ProjectModelTransferHistoryRow[] = [];
    const legacyOwners = new Set([projectId, ...aggregate.bindings.map((binding) => binding.legacyId)]);
    if (history) for (const kind of Object.keys(HISTORY) as ProjectModelTransferHistoryKind[]) {
      const store = tx.objectStore(HISTORY[kind]);
      let values: Array<ProjectModelTransferHistoryRow['value']> = [];
      if (kind !== 'message' && store.indexNames.contains('projectId_updatedAt')) {
        for (const owner of legacyOwners) values.push(...await boundedRows<ProjectModelTransferHistoryRow['value']>(store.index('projectId_updatedAt'),
          IDBKeyRange.bound([owner, -Infinity], [owner, Infinity]), budget));
      } else if (kind === 'message' && store.indexNames.contains('conversationId_sequence')) {
        for (const conversation of historyRows.filter((item) => item.kind === 'conversation')) values.push(...await boundedRows<ProjectModelTransferHistoryRow['value']>(store.index('conversationId_sequence'),
          IDBKeyRange.bound([conversation.value.id, -Infinity], [conversation.value.id, Infinity]), budget));
      } else values = await boundedRows<ProjectModelTransferHistoryRow['value']>(store, undefined, budget, (value) => legacyOwners.has(value.projectId));
      for (const value of values.filter((item) => legacyOwners.has(item.projectId)).sort((a, b) => a.id.localeCompare(b.id))) {
        const matching = historyBindings.filter((item) => item.kind === kind && item.localId === value.id);
        if (new Set(matching.map((item) => item.archiveOriginId)).size > 1
          || matching.filter((item) => item.historicalTarget).some((item, _index, targets) => historicalIdentity(item.historicalTarget!) !== historicalIdentity(targets[0].historicalTarget!))) throw error('history-origin-ambiguous');
        const binding = matching.find((item) => item.historicalTarget?.state === 'retired') ?? matching.find((item) => item.historicalTarget) ?? matching[0];
        historyRows.push({ kind, sourceNamespace: binding?.sourceNamespace ?? `local:${value.projectId}`,
          archiveOriginId: binding?.archiveOriginId ?? (hash(value.archiveOriginId) ? value.archiveOriginId : value.id),
          ...(binding?.historicalTarget ? { historicalTarget: binding.historicalTarget } : {}), value });
      }
    }
    const captured = { schemaVersion: 1 as const, generation, sessionId: session.sessionId, aggregate,
      exchange, historyBindings, history: historyRows, includesHistory: history };
    return { ...captured, sessionRevision: marker.revision, sourceToken: projectModelSourceToken(captured) };
  }
  function capture(projectId: string, options: { history?: boolean; signal?: AbortSignal } = {}): Promise<ProjectModelTransferCapture | null> {
    return transaction(database, allTables(options.history === true), false, (tx) => captureIn(tx, projectId, options.history === true), options.signal);
  }
  async function assertExpected(tx: IDBTransaction, expected: ProjectModelTransferCapture | null, projectId: string): Promise<void> {
    const current = await captureIn(tx, projectId, expected?.includesHistory === true);
    if (expected ? !current || current.sourceToken !== expected.sourceToken : current !== null) throw error('preview-changed');
  }
  function validateHistory(rows: ProjectModelTransferHistoryRow[], projectId: string, exchange: ProjectModelTransferExchange | null): void {
    const origins = new Set<string>();
    const forbidden = ['agentTaskId', 'taskId', 'requestId', 'commands', 'executionResults', 'mcpServerIds', 'mcpSelectionRevision', 'workbenchTarget'];
    for (const item of rows) {
      closed(item, ['kind', 'sourceNamespace', 'archiveOriginId', 'historicalTarget', 'value', 'existingLocalId']);
      const origin = JSON.stringify([item.sourceNamespace, item.kind, item.archiveOriginId]);
      if (!Object.hasOwn(HISTORY, item.kind) || !id(item.sourceNamespace) || !id(item.archiveOriginId) || !id(item.value?.id)
        || item.value.projectId !== projectId || origins.has(origin) || forbidden.some((field) => Object.hasOwn(item.value, field))
        || item.existingLocalId !== undefined && !id(item.existingLocalId)) throw error('invalid-history-row');
      if (item.kind === 'conversation' && item.value.agentMode !== 'plan') throw error('imported-runtime-mode');
      if (item.historicalTarget && item.kind !== 'conversation') throw error('invalid-history-target');
      if (item.historicalTarget) {
        const target = item.historicalTarget;
        const revision = exchange?.bundle.revisions.find((entry) => entry.canonicalVersion === 2 && entry.revisionId === exchange.localHead.revisionId);
        const head = revision?.canonicalVersion === 2 ? revision.snapshot : undefined;
        if (!head || !['active', 'retired'].includes(target.state) || target.projectId !== head.rootProjectId) throw error('invalid-history-target');
        if (target.state === 'retired') {
          closed(target, ['state', 'kind', 'projectId', 'id']);
          if (!head.historicalTargets.some((descriptor) => compare(descriptor, target))) throw error('unproved-retired-history-target');
        } else if (target.kind === 'episode') {
          closed(target, ['state', 'kind', 'projectId', 'episodeId']);
          if (!head.entities.some((entity) => entity.kind === 'episode' && entity.id === target.episodeId)) throw error('invalid-history-target');
        } else {
          closed(target, ['state', 'kind', 'projectId', 'domain']);
          if (target.state !== 'active' || target.kind !== 'project' || target.domain !== 'standalone-creative'
            || !head.entities.some((entity) => entity.kind === 'project' && entity.data.kind === 'standalone')) throw error('invalid-history-target');
        }
      }
      origins.add(origin);
    }
  }
  async function validateImport(input: ProjectModelTransferImportInput): Promise<ProjectModelTransferImportInput> {
    const { signal, ...fields } = input;
    const fixed = data(fields);
    closed(fixed, ['operationId', 'mode', 'packageDigest', 'intentDigest', 'sourceLineageId', 'targetProjectId',
      'expected', 'next', 'exchange', 'idMap', 'history', 'media', 'sourceRef', 'sourceFiles', 'restoreProof']);
    if (!operation(fixed.operationId) || !hash(fixed.packageDigest) || !hash(fixed.intentDigest) || !id(fixed.targetProjectId)
      || fixed.sourceLineageId !== undefined && !id(fixed.sourceLineageId)
      || !['import-new', 'update-existing', 'independent-copy', 'restore-content'].includes(fixed.mode)
      || fixed.next.project.id !== fixed.targetProjectId || !Array.isArray(fixed.media) || fixed.media.length > PROJECT_EXCHANGE_LIMITS.media
      || !Array.isArray(fixed.idMap) || fixed.idMap.length > PROJECT_EXCHANGE_LIMITS.entities
      || fixed.expected && (fixed.expected.schemaVersion !== 1 || typeof fixed.expected.includesHistory !== 'boolean'
        || typeof fixed.expected.sourceToken !== 'string' || fixed.expected.generation !== generation || fixed.expected.sessionId !== session.sessionId
        || fixed.expected.aggregate.project.id !== fixed.targetProjectId)) throw error('invalid-import-input');
    if (['import-new', 'independent-copy'].includes(fixed.mode) ? fixed.expected !== null : fixed.expected === null) throw error('invalid-import-mode');
    if (fixed.expected) closed(fixed.expected, ['schemaVersion', 'generation', 'sessionId', 'sessionRevision', 'aggregate',
      'exchange', 'historyBindings', 'history', 'sourceToken', 'includesHistory']);
    fixed.next = validateProjectModelTransferAggregate(fixed.next, fixed.expected?.aggregate);
    await verifiedExchange(fixed.exchange, fixed.expected?.exchange); validateHistory(fixed.history, fixed.targetProjectId, fixed.exchange);
    if (fixed.sourceRef !== undefined) safeExchangePath(fixed.sourceRef);
    if (fixed.sourceFiles !== undefined && (!Array.isArray(fixed.sourceFiles) || fixed.sourceFiles.length > PROJECT_EXCHANGE_LIMITS.media)) throw error('invalid-source-files');
    if (fixed.sourceFiles?.length && !fixed.sourceRef) throw error('source-reference-required');
    const sourceIds = new Set<string>(), sourceLogical = new Set<string>(), sourcePaths = new Map<string, { bytes: number; sha256: string }>();
    let sourceBytes = 0;
    for (const file of fixed.sourceFiles ?? []) {
      closed(file, ['id', 'rootRef', 'relativePath', 'archivePath', 'bytes', 'sha256']);
      safeExchangePath(file.relativePath); safeExchangePath(file.archivePath);
      const logical = JSON.stringify([file.rootRef, file.relativePath]), path = file.archivePath.normalize('NFC').toLowerCase();
      const previous = sourcePaths.get(path);
      if (!id(file.id) || !id(file.rootRef) || !file.archivePath.startsWith('assets/') || !integer(file.bytes) || !hash(file.sha256)
        || sourceIds.has(file.id) || sourceLogical.has(logical) || previous && (previous.bytes !== file.bytes || previous.sha256 !== file.sha256)) throw error('invalid-source-files');
      sourceIds.add(file.id); sourceLogical.add(logical); sourcePaths.set(path, { bytes: file.bytes, sha256: file.sha256 });
      if (!previous) sourceBytes += file.bytes;
      if (!Number.isSafeInteger(sourceBytes) || sourceBytes > PROJECT_EXCHANGE_LIMITS.mediaBytes) throw error('source-capacity');
    }
    const mediaKeys = new Set<string>(); let mediaBytes = 0;
    for (const media of fixed.media) {
      closed(media, ['rootRef', 'relativePath', 'bytes', 'sha256']);
      safeExchangePath(media.relativePath);
      const mediaKey = JSON.stringify([media.rootRef, media.relativePath]);
      if (!id(media.rootRef) || !integer(media.bytes) || !hash(media.sha256) || mediaKeys.has(mediaKey)
        || !fixed.next.project.storageBindings.some((root) => root.rootRef === media.rootRef)) throw error('invalid-media-manifest');
      if (fixed.exchange) {
        const exchange = fixed.exchange;
        const binding = exchange.fileBindings.find((item) => item.localRelativePath === media.relativePath
          && exchange.identities.some((mapping) => mapping.kind === 'storage-root' && mapping.sourceId === item.rootRef && mapping.localId === media.rootRef));
        const head = exchange.bundle.revisions.find((item) => item.canonicalVersion === 2 && item.revisionId === exchange.localHead.revisionId);
        const file = head?.snapshot.entities.find((item) => item.kind === 'file' && item.id === binding?.id);
        const payload = head?.snapshot.media.find((item) => item.id === file?.data.mediaId);
        if (!binding || !payload || payload.bytes !== media.bytes || payload.sha256 !== media.sha256) throw error('media-binding-missing');
      }
      mediaKeys.add(mediaKey);
      mediaBytes += media.bytes;
      if (!Number.isSafeInteger(mediaBytes) || mediaBytes > PROJECT_EXCHANGE_LIMITS.mediaBytes) throw error('media-capacity');
    }
    const identities = new Set<string>(), local = new Set<string>();
    for (const mapping of fixed.idMap) {
      closed(mapping, ['kind', 'sourceId', 'localId']);
      if (!['project', 'episode', 'canvas', 'storage-root'].includes(mapping.kind) || !id(mapping.sourceId) || !id(mapping.localId)
        || identities.has(JSON.stringify([mapping.kind, mapping.sourceId])) || local.has(JSON.stringify([mapping.kind, mapping.localId]))) throw error('invalid-id-map');
      identities.add(JSON.stringify([mapping.kind, mapping.sourceId])); local.add(JSON.stringify([mapping.kind, mapping.localId]));
    }
    const byIdentity = (left: ProjectModelTransferImportInput['idMap'][number], right: ProjectModelTransferImportInput['idMap'][number]) =>
      JSON.stringify([left.kind, left.sourceId]).localeCompare(JSON.stringify([right.kind, right.sourceId]));
    if (fixed.exchange && !compare([...fixed.idMap].sort(byIdentity), [...fixed.exchange.identities].sort(byIdentity))) throw error('exchange-id-map-mismatch');
    const targets: Array<[string, string]> = [['project', fixed.targetProjectId], ...fixed.next.episodes.map((item): [string, string] => ['episode', item.id]),
      ...fixed.next.canvases.map((item): [string, string] => ['canvas', item.id]), ...fixed.next.project.storageBindings.map((item): [string, string] => ['storage-root', item.rootRef])];
    const activeTargets = new Set(targets.map(([kind, localId]) => JSON.stringify([kind, localId])));
    if (targets.some(([kind, localId]) => !local.has(JSON.stringify([kind, localId])))
      || fixed.idMap.some((mapping) => !activeTargets.has(JSON.stringify([mapping.kind, mapping.localId]))
        && !fixed.expected?.exchange?.identities.some((old) => compare(old, mapping)))) throw error('incomplete-id-map');
    if (fixed.expected) {
      if (fixed.next.project.dataFolder !== fixed.expected.aggregate.project.dataFolder
        || fixed.next.project.storageRootRef !== fixed.expected.aggregate.project.storageRootRef
        || fixed.expected.aggregate.project.storageBindings.some((binding) => !fixed.next.project.storageBindings.some((item) => compare(item, binding)))) throw error('target-storage-changed');
      if (fixed.expected.exchange && (!fixed.exchange || fixed.exchange.lineageId !== fixed.expected.exchange.lineageId
        || fixed.exchange.stateVersion !== fixed.expected.exchange.stateVersion + 1)) throw error('lineage-changed');
    }
    if (fixed.mode === 'independent-copy' && fixed.exchange?.published.length) throw error('copy-has-publication-history');
    if (fixed.mode === 'independent-copy' && fixed.sourceLineageId && fixed.sourceLineageId === fixed.exchange?.lineageId) throw error('copy-reuses-source-lineage');
    if (fixed.mode === 'restore-content') {
      const proof = fixed.restoreProof;
      if (proof) closed(proof, ['kind', 'backupOperationId', 'manifestDigest', 'backupSourceDigest', 'sourceToken', 'sourceMediaDigest', 'verified', 'auditPolicy']);
      if (!proof || proof.kind !== 'project-model-pre-restore' || proof.verified !== true || proof.auditPolicy !== 'preserve-current'
        || !operation(proof.backupOperationId) || !hash(proof.manifestDigest) || !hash(proof.backupSourceDigest)
        || proof.sourceMediaDigest !== undefined && !hash(proof.sourceMediaDigest)
        || proof.sourceToken !== fixed.expected!.sourceToken) throw error('restore-backup-required');
      if (!safety.verifyRestoreBackup) throw error('restore-backup-verifier-required');
      await safety.verifyRestoreBackup(proof, fixed.expected!);
    } else if (fixed.restoreProof) throw error('unexpected-restore-proof');
    return { ...fixed, signal };
  }
  async function importJournal(tx: IDBTransaction, operationId: string): Promise<ProjectModelTransferImportJournal> {
    if (!operation(operationId)) throw error('invalid-operation');
    const value = await request<ProjectModelTransferImportJournal | undefined>(tx.objectStore(META).get(importKey(operationId)));
    if (!value || value.schemaVersion !== 1 || value.kind !== 'project-model-import' || value.operationId !== operationId || value.id !== importKey(operationId)
      || value.generation !== generation || value.sessionId !== session.sessionId
      || !IMPORT_PHASES.includes(value.phase) || !integer(value.sequence)) throw error('import-operation-unavailable');
    return value;
  }
  async function exportJournal(tx: IDBTransaction, operationId: string): Promise<ProjectModelTransferExportJournal> {
    if (!operation(operationId)) throw error('invalid-operation');
    const value = await request<ProjectModelTransferExportJournal | undefined>(tx.objectStore(META).get(exportKey(operationId)));
    if (!value || value.schemaVersion !== 1 || value.kind !== 'project-model-export' || value.operationId !== operationId || value.id !== exportKey(operationId)
      || value.generation !== generation || value.sessionId !== session.sessionId
      || !EXPORT_PHASES.includes(value.phase) || !integer(value.sequence)) throw error('export-operation-unavailable');
    return value;
  }
  async function prepareImport(input: ProjectModelTransferImportInput): Promise<ProjectModelTransferImportJournal> {
    const { signal: capturedSignal, ...capturedFields } = input;
    input = { ...data(capturedFields), signal: capturedSignal };
    const existing = operation(input.operationId) ? await transaction(database, [], false, async (tx) => {
      await guard(tx); return request<ProjectModelTransferImportJournal | undefined>(tx.objectStore(META).get(importKey(input.operationId)));
    }, input.signal) : undefined;
    if (existing) {
      if (existing.mode !== input.mode || existing.packageDigest !== input.packageDigest || existing.intentDigest !== input.intentDigest
        || existing.targetProjectId !== input.targetProjectId || existing.expected?.sourceToken !== input.expected?.sourceToken
        || input.sourceRef !== undefined && input.sourceRef !== existing.sourceRef
        || input.sourceFiles !== undefined && !compare(input.sourceFiles, existing.sourceFiles)) throw error('operation-identity-conflict');
      return readImport(input.operationId, { signal: input.signal });
    }
    input = await validateImport(input);
    const { signal, ...fixed } = input;
    return transaction(database, allTables(input.expected?.includesHistory === true), true, async (tx) => {
      await guard(tx);
      const existing = await request<ProjectModelTransferImportJournal | undefined>(tx.objectStore(META).get(importKey(fixed.operationId)));
      if (existing) {
        if (existing.mode !== fixed.mode || existing.packageDigest !== fixed.packageDigest || existing.intentDigest !== fixed.intentDigest
          || existing.targetProjectId !== fixed.targetProjectId || existing.expected?.sourceToken !== fixed.expected?.sourceToken
          || fixed.sourceRef !== undefined && fixed.sourceRef !== existing.sourceRef
          || fixed.sourceFiles !== undefined && !compare(fixed.sourceFiles, existing.sourceFiles)) throw error('operation-identity-conflict');
        return importJournal(tx, fixed.operationId);
      }
      await assertNoUnfinishedExport(tx, fixed.targetProjectId);
      await assertExpected(tx, fixed.expected, fixed.targetProjectId);
      if (fixed.expected === null && await request(tx.objectStore(META).get(tombstoneKey('project', fixed.targetProjectId))) !== undefined) throw error('retired-project-identity');
      const now = Date.now();
      const journal: ProjectModelTransferImportJournal = { ...fixed, id: importKey(fixed.operationId), schemaVersion: 1, kind: 'project-model-import',
        generation, sessionId: session.sessionId, phase: 'prepared', sequence: 0, createdAt: now, updatedAt: now, cleanup: 'retain-until-unreferenced' };
      await request(tx.objectStore(META).add(journal)); return journal;
    }, signal);
  }
  async function advanceImport(operationId: string, sequence: number, phase: ProjectModelImportPhase,
    options: { mediaPublicationRef?: string; signal?: AbortSignal } = {}): Promise<ProjectModelTransferImportJournal> {
    options = { ...options };
    if (options.mediaPublicationRef !== undefined && !opaque(options.mediaPublicationRef)) throw error('invalid-media-publication');
    if (phase === 'media_ready') {
      const journal = await readImport(operationId, options);
      const publicationRef = options.mediaPublicationRef ?? journal.mediaPublicationRef;
      if (journal.media.length || journal.exchange?.fileBindings.length) {
        if (!publicationRef || !safety.verifyMediaPublication) throw error('media-publication-verifier-required');
        await safety.verifyMediaPublication(journal, publicationRef);
      }
    }
    return transaction(database, [], true, async (tx) => {
      await guard(tx); const before = await importJournal(tx, operationId);
      if (before.phase === phase && before.sequence === sequence + 1) {
        if (options.mediaPublicationRef && options.mediaPublicationRef !== before.mediaPublicationRef) throw error('media-publication-conflict');
        return before;
      }
      if (before.sequence !== sequence || IMPORT_PHASES.indexOf(phase) !== IMPORT_PHASES.indexOf(before.phase) + 1
        || phase === 'db_committed') throw error('import-phase-conflict');
      if (phase === 'media_ready' && (before.media.length > 0 || before.exchange?.fileBindings.length)
        && !options.mediaPublicationRef && !before.mediaPublicationRef) throw error('media-publication-required');
      const next = { ...before, phase, sequence: increment(before.sequence), updatedAt: Date.now(),
        ...(options.mediaPublicationRef ? { mediaPublicationRef: options.mediaPublicationRef } : {}) };
      await request(tx.objectStore(META).put(next)); return next;
    }, options.signal);
  }
  async function appendHistory(tx: IDBTransaction, projectId: string, input: ProjectModelTransferHistoryRow[]): Promise<void> {
    const mappings = new Map<string, string>(), pending: Array<{ item: ProjectModelTransferHistoryRow; binding: ProjectModelArchiveHistoryBinding; existing: boolean }> = [];
    for (const item of input) {
      const identity = { destinationProjectId: projectId, sourceNamespace: item.sourceNamespace, kind: item.kind, archiveOriginId: item.archiveOriginId };
      const previous = await request<ProjectModelArchiveHistoryBinding | undefined>(tx.objectStore('archiveHistoryBindings').get(bindingKey(identity)));
      if (previous && item.historicalTarget && !historyTransition(previous.historicalTarget, item.historicalTarget)) throw error('history-origin-ambiguous');
      if (previous && item.existingLocalId && item.existingLocalId !== previous.localId) throw error('history-origin-ambiguous');
      const binding = previous ? { ...previous, ...(item.historicalTarget ? { historicalTarget: item.historicalTarget } : {}) }
        : { ...identity, localId: item.existingLocalId ?? item.value.id, ...(item.historicalTarget ? { historicalTarget: item.historicalTarget } : {}) };
      const lookup = JSON.stringify([item.kind, item.value.id]);
      if (mappings.has(lookup) && mappings.get(lookup) !== binding.localId) throw error('history-local-mapping-ambiguous');
      mappings.set(lookup, binding.localId); pending.push({ item, binding, existing: !!previous || !!item.existingLocalId });
    }
    const mapped = (kind: ProjectModelTransferHistoryKind, value: unknown) => typeof value === 'string' ? mappings.get(JSON.stringify([kind, value])) ?? value : value;
    for (const { item, binding, existing } of pending) {
      const store = tx.objectStore(HISTORY[item.kind]);
      const previous = await request<{ projectId: string } | undefined>(store.get(binding.localId));
      if (existing) {
        const owners = new Set([projectId, ...(await request<ProjectModelStored<LegacyProjectBinding>[]>(tx.objectStore('legacyProjectBindings').index('projectId').getAll([generation, projectId]))).map((value) => value.legacyId)]);
        if (!previous || !owners.has(previous.projectId)) throw error('broken-history-binding');
        await request(tx.objectStore('archiveHistoryBindings').put(binding));
        continue;
      }
      if (previous) throw error('history-local-id-collision');
      const value: ProjectModelTransferHistoryRow['value'] = { ...item.value, id: binding.localId, projectId };
      if (item.kind === 'message') value.conversationId = mapped('conversation', value.conversationId);
      if (item.kind === 'conversation' && value.branchSource && typeof value.branchSource === 'object') {
        const branch = value.branchSource as Record<string, unknown>;
        value.branchSource = { ...branch, conversationId: mapped('conversation', branch.conversationId), messageId: mapped('message', branch.messageId) };
      }
      if (item.kind === 'memory' && value.source && typeof value.source === 'object') {
        const source = value.source as Record<string, unknown>;
        if (source.taskId !== undefined) throw error('history-has-runtime-source');
        value.source = { ...source, conversationId: mapped('conversation', source.conversationId),
          ...(source.messageId !== undefined ? { messageId: mapped('message', source.messageId) } : {}) };
      }
      await request(store.add(value)); await request(tx.objectStore('archiveHistoryBindings').add(binding));
    }
    for (const { item, binding } of pending) {
      if (item.kind === 'message') {
        const value = await request<{ conversationId?: string }>(tx.objectStore(HISTORY.message).get(binding.localId));
        const conversation = value?.conversationId && await request<{ projectId: string } | undefined>(tx.objectStore(HISTORY.conversation).get(value.conversationId));
        const owners = new Set([projectId, ...(await request<ProjectModelStored<LegacyProjectBinding>[]>(tx.objectStore('legacyProjectBindings').index('projectId').getAll([generation, projectId]))).map((entry) => entry.legacyId)]);
        if (!conversation || !owners.has(conversation.projectId)) throw error('history-missing-conversation');
      }
    }
  }
  async function commitImport(operationId: string, sequence: number, options: { signal?: AbortSignal } = {}): Promise<ProjectModelTransferImportJournal> {
    options = { ...options };
    const prepared = await readImport(operationId, options);
    if (IMPORT_PHASES.indexOf(prepared.phase) >= IMPORT_PHASES.indexOf('db_committed')) return prepared;
    await verifiedExchange(prepared.exchange, prepared.expected?.exchange);
    if (prepared.mode === 'restore-content') {
      if (!prepared.restoreProof || !prepared.expected || !safety.verifyRestoreCommit) throw error('restore-commit-verifier-required');
      await safety.verifyRestoreCommit(data(prepared.restoreProof), data(prepared.expected), data(prepared));
    }
    return transaction(database, allTables(true), true, async (tx) => {
      const marker = await guard(tx), journal = await importJournal(tx, operationId);
      if (IMPORT_PHASES.indexOf(journal.phase) >= IMPORT_PHASES.indexOf('db_committed')) return journal;
      if (!compare(journal, prepared)) throw error('import-journal-changed');
      if (journal.phase !== 'media_ready' || journal.sequence !== sequence) throw error('import-not-media-ready');
      await assertNoUnfinishedExport(tx, journal.targetProjectId);
      await assertExpected(tx, journal.expected, journal.targetProjectId);
      const next = validateProjectModelTransferAggregate(journal.next, journal.expected?.aggregate), before = journal.expected?.aggregate;
      const now = Date.now();
      const max = (...values: Array<number | undefined>) => Math.max(0, ...values.map((value) => value ?? 0));
      const advance = (value: number, old?: number) => increment(max(value, old));
      next.project.epoch = advance(next.project.epoch, before?.project.epoch); next.project.updatedAt = now;
      for (const field of ['source', 'script', 'storyGraph', 'assets'] as const) next.content.revisions[field] = advance(next.content.revisions[field], before?.content.revisions[field]);
      if (next.content.standaloneCreative) next.content.standaloneCreative.revision = advance(next.content.standaloneCreative.revision, before?.content.standaloneCreative?.revision);
      for (const item of next.episodes) {
        const old = before?.episodes.find((value) => value.id === item.id);
        const retired = await request<{ projectId: string; generation: number; epoch: number } | undefined>(tx.objectStore(META).get(tombstoneKey('episode', item.id)));
        if (retired && (!old && journal.mode !== 'restore-content' || retired.projectId !== next.project.id
          || retired.generation !== generation || !integer(retired.epoch))) throw error('retired-local-identity');
        item.epoch = increment(max(item.epoch, old?.epoch, retired?.epoch)); item.revision = advance(item.revision, old?.revision); item.updatedAt = now;
      }
      for (const item of next.episodeContents) item.revision = advance(item.revision, before?.episodeContents.find((value) => value.episodeId === item.episodeId)?.revision);
      for (const item of next.canvases) {
        const old = before?.canvases.find((value) => value.id === item.id);
        const retired = await request<{ projectId: string; generation: number; epoch: number } | undefined>(tx.objectStore(META).get(tombstoneKey('canvas', item.id)));
        if (retired && (!old && journal.mode !== 'restore-content' || retired.projectId !== next.project.id
          || retired.generation !== generation || !integer(retired.epoch))) throw error('retired-local-identity');
        item.epoch = increment(max(item.epoch, old?.epoch, retired?.epoch)); item.revision = advance(item.revision, old?.revision);
      }
      for (const [table, items, oldItems, idField] of [
        ['episodes', next.episodes, before?.episodes ?? [], 'id'], ['episodeContents', next.episodeContents, before?.episodeContents ?? [], 'episodeId'],
        ['canvasDocuments', next.canvases, before?.canvases ?? [], 'id'], ['canvasPreviews', next.previews, before?.previews ?? [], 'canvasId'],
      ] as const) {
        const retained = new Set(items.map((value) => (value as unknown as Record<string, string>)[idField]));
        const oldIds = new Set(oldItems.map((value) => (value as unknown as Record<string, string>)[idField]));
        for (const item of items) {
          const itemId = (item as unknown as Record<string, string>)[idField];
          if (!oldIds.has(itemId) && await request(tx.objectStore(table).get(key(itemId))) !== undefined) throw error('local-identity-already-used');
          if (journal.mode !== 'restore-content' && !oldIds.has(itemId) && (table === 'episodes' || table === 'canvasDocuments')
            && await request(tx.objectStore(META).get(tombstoneKey(table === 'episodes' ? 'episode' : 'canvas', itemId))) !== undefined) throw error('retired-local-identity');
          await request(tx.objectStore(table).put(stored(item)));
        }
        for (const old of oldItems) {
          const itemId = (old as unknown as Record<string, string>)[idField];
          if (retained.has(itemId)) continue;
          await request(tx.objectStore(table).delete(key(itemId)));
          if (table === 'episodes' || table === 'canvasDocuments') {
            const kind = table === 'episodes' ? 'episode' : 'canvas', previousEpoch = (old as unknown as { epoch: number }).epoch;
            await request(tx.objectStore(META).put({ id: tombstoneKey(kind, itemId), kind, projectId: next.project.id, targetId: itemId,
              generation, operationId: session.operationId, previousEpoch, epoch: increment(previousEpoch), deletedAt: now }));
          }
        }
      }
      const activeEpisodes = new Set(next.episodes.map((item) => item.id)), activeCanvases = new Set(next.canvases.map((item) => item.id));
      for (const old of before?.bindings ?? []) if (!next.bindings.some((item) => item.namespace === old.namespace && item.legacyId === old.legacyId)) {
        next.bindings.push({ ...old, retired: true, retiredAt: now });
      }
      for (const binding of next.bindings) {
        if (binding.episodeId && !activeEpisodes.has(binding.episodeId) || binding.canvasId && !activeCanvases.has(binding.canvasId)) {
          binding.retired = true; binding.retiredAt = now;
        }
        const bindingKeyValue = [generation, binding.namespace, binding.legacyId];
        const existing = await request<ProjectModelStored<LegacyProjectBinding> | undefined>(tx.objectStore('legacyProjectBindings').get(bindingKeyValue));
        if (existing && existing.projectId !== next.project.id) throw error('legacy-binding-owned-by-another-project');
        await request(tx.objectStore('legacyProjectBindings').put(stored(binding)));
      }
      await request(tx.objectStore('projectRoots').put(stored(next.project)));
      await request(tx.objectStore('projectContents').put(stored(next.content)));
      await appendHistory(tx, next.project.id, journal.history);
      if (journal.exchange) await request(tx.objectStore(META).put({ id: exchangeKey(next.project.id), value: journal.exchange }));
      else if (journal.expected?.exchange) throw error('cannot-drop-exchange-history');
      if (journal.expected) await request(tx.objectStore(META).add({ id: recoveryKey(operationId), kind: 'project-model-content-recovery',
        operationId, targetProjectId: next.project.id, generation, captured: journal.expected,
        afterEpoch: next.project.epoch, media: journal.media, auditPolicy: 'preserve-current', createdAt: now }));
      await request(tx.objectStore(META).put({ ...marker, revision: increment(marker.revision), dirty: true }));
      const committed = await captureIn(tx, next.project.id, journal.expected?.includesHistory === true);
      const result: ProjectModelTransferImportJournal = { ...journal, next, phase: 'db_committed', sequence: increment(journal.sequence),
        updatedAt: now, committedToken: committed!.sourceToken };
      await request(tx.objectStore(META).put(result)); return result;
    }, options.signal);
  }
  async function readImport(operationId: string, options: { signal?: AbortSignal } = {}): Promise<ProjectModelTransferImportJournal> {
    return transaction(database, [], false, async (tx) => { await guard(tx); return importJournal(tx, operationId); }, options.signal);
  }
  async function prepareExport(input: { operationId: string; capture: ProjectModelTransferCapture; exchange: ProjectModelTransferExchange; signal?: AbortSignal }): Promise<ProjectModelTransferExportJournal> {
    const { signal, ...fields } = input; const fixed = data(fields);
    if (!operation(fixed.operationId) || fixed.capture.schemaVersion !== 1 || typeof fixed.capture.includesHistory !== 'boolean'
      || typeof fixed.capture.sourceToken !== 'string' || fixed.capture.generation !== generation || fixed.capture.sessionId !== session.sessionId) throw error('invalid-export-input');
    await verifiedExchange(fixed.exchange, fixed.capture.exchange);
    return transaction(database, allTables(fixed.capture.includesHistory), true, async (tx) => {
      await guard(tx); const existing = await request<ProjectModelTransferExportJournal | undefined>(tx.objectStore(META).get(exportKey(fixed.operationId)));
      if (existing) {
        if (existing.expectedToken !== fixed.capture.sourceToken || !compare(existing.exchange, fixed.exchange)) throw error('operation-identity-conflict');
        return exportJournal(tx, fixed.operationId);
      }
      await assertExpected(tx, fixed.capture, fixed.capture.aggregate.project.id);
      // 同项目的初次导出不能各自创建新lineage；已发布未登记也不能被新操作绕过。
      await assertNoUnfinishedExport(tx, fixed.capture.aggregate.project.id);
      const now = Date.now();
      const journal: ProjectModelTransferExportJournal = { id: exportKey(fixed.operationId), schemaVersion: 1, kind: 'project-model-export', operationId: fixed.operationId,
        generation, sessionId: session.sessionId, targetProjectId: fixed.capture.aggregate.project.id, expectedToken: fixed.capture.sourceToken,
        expectedExchange: fixed.capture.exchange,
        includesHistory: fixed.capture.includesHistory, head: fixed.exchange.localHead, exchange: fixed.exchange,
        phase: 'prepared', sequence: 0, createdAt: now, updatedAt: now };
      await request(tx.objectStore(META).add(journal)); return journal;
    }, signal);
  }
  async function advanceExport(operationId: string, sequence: number, phase: ProjectModelExportPhase,
    options: { packageDigest?: string; outputRef?: string; signal?: AbortSignal } = {}): Promise<ProjectModelTransferExportJournal> {
    options = { ...options };
    if (options.packageDigest !== undefined && !hash(options.packageDigest) || options.outputRef !== undefined && !opaque(options.outputRef)) throw error('invalid-publication-receipt');
    if (phase === 'published' || phase === 'registered') {
      const journal = await transaction(database, [], false, async (tx) => { await guard(tx); return exportJournal(tx, operationId); }, options.signal);
      const packageDigest = options.packageDigest ?? journal.packageDigest, outputRef = options.outputRef ?? journal.outputRef;
      if (!packageDigest || !outputRef || !safety.verifyExportPublication) throw error('publication-verifier-required');
      await safety.verifyExportPublication(journal, { packageDigest, outputRef });
      if (phase === 'registered') await verifiedExchange(journal.exchange, journal.expectedExchange);
    }
    return transaction(database, allTables(true), true, async (tx) => {
      await guard(tx); const before = await exportJournal(tx, operationId);
      if (before.phase === phase && before.sequence === sequence + 1) {
        if (options.packageDigest && options.packageDigest !== before.packageDigest || options.outputRef && options.outputRef !== before.outputRef) throw error('publication-receipt-conflict');
        return before;
      }
      if (phase === 'aborted' || before.sequence !== sequence || EXPORT_PHASES.indexOf(phase) !== EXPORT_PHASES.indexOf(before.phase) + 1) throw error('export-phase-conflict');
      // 发布事实即使在本地编辑变化后也必须先保留；登记失败不得重新打包/覆盖同一输出。
      if (phase === 'packing') {
        const current = await captureIn(tx, before.targetProjectId, before.includesHistory);
        if (!current || current.sourceToken !== before.expectedToken) throw error('export-capture-changed');
      }
      const packageDigest = options.packageDigest ?? before.packageDigest, outputRef = options.outputRef ?? before.outputRef;
      if (['published', 'registered'].includes(phase) && (!packageDigest || !outputRef)) throw error('publication-receipt-required');
      if (phase === 'registered') {
        const current = await captureIn(tx, before.targetProjectId, false);
        if (!current || !compare(current.exchange, before.expectedExchange)) throw error('export-exchange-changed');
        const exchange = data(before.exchange);
        exchange.published = [...exchange.published.filter((item) => item.operationId !== operationId),
          { operationId, packageDigest: packageDigest!, outputRef: outputRef!, head: before.head }];
        await request(tx.objectStore(META).put({ id: exchangeKey(before.targetProjectId), value: exchange }));
      }
      const next: ProjectModelTransferExportJournal = { ...before, phase, sequence: increment(before.sequence), updatedAt: Date.now(),
        ...(packageDigest ? { packageDigest } : {}), ...(outputRef ? { outputRef } : {}) };
      await request(tx.objectStore(META).put(next)); return next;
    }, options.signal);
  }
  async function abandonPreparedExport(operationId: string, sequence: number,
    options: { signal?: AbortSignal } = {}): Promise<ProjectModelTransferExportJournal> {
    return transaction(database, [], true, async (tx) => {
      await guard(tx); const before = await exportJournal(tx, operationId);
      if (before.phase === 'aborted' && before.sequence === sequence + 1) return before;
      if (before.phase !== 'prepared' || before.sequence !== sequence) throw error('only-prepared-export-can-abort');
      const result: ProjectModelTransferExportJournal = { ...before, phase: 'aborted', sequence: increment(before.sequence), updatedAt: Date.now() };
      await request(tx.objectStore(META).put(result)); return result;
    }, options.signal);
  }
  return {
    access: 'fixture-transfer' as const, capture, prepareImport, advanceImport, commitImport, readImport, prepareExport, advanceExport, abandonPreparedExport,
    findImport: (operationId: string, options: { signal?: AbortSignal } = {}): Promise<ProjectModelTransferImportJournal | null> => transaction(database, [], false, async (tx) => {
      await guard(tx);
      if (!operation(operationId)) throw error('invalid-operation');
      const existing = await request<unknown>(tx.objectStore(META).get(importKey(operationId)));
      return existing === undefined ? null : importJournal(tx, operationId);
    }, options.signal),
    /** 专用恢复前备份：业务、别名、历史、审计侧表和操作journal在同一只读事务捕获。 */
    captureBackupSource: async (projectId: string, pendingTaskSource: string | null,
      options: { signal?: AbortSignal } = {}): Promise<{ capture: ProjectModelTransferCapture; source: ProjectModelBackupSource }> => {
      const names = Array.from(database.objectStoreNames);
      if (names.some((name) => !isProjectModelFixtureBackupStore(name) && !isKnownExcludedProjectModelBackupStore(name))) throw error('unknown-backup-store');
      const included = names.filter(isProjectModelFixtureBackupStore);
      return transaction(database, included, false, async (tx) => {
        await guard(tx);
        const captured = await captureIn(tx, projectId, true);
        if (!captured) throw error('project-unavailable');
        const stores: ProjectModelBackupStore[] = [];
        let recordCount = 0, totalBytes = 0;
        for (const name of included) {
          const store = tx.objectStore(name), records: ProjectModelBackupStore['records'] = [];
          await new Promise<void>((resolve, reject) => {
            const cursor = store.openCursor();
            cursor.onerror = () => reject(cursor.error);
            cursor.onsuccess = () => {
              try {
                const value = cursor.result;
                if (!value) { resolve(); return; }
                if (name === META && !isProjectModelFixtureBackupMetadataKey(value.primaryKey)) {
                  if (!isKnownExcludedProjectModelBackupMetadataKey(value.primaryKey)) throw error('unknown-backup-metadata');
                } else {
                  const record = { key: value.primaryKey, value: value.value };
                  totalBytes += estimateLegacyBackupValueBytes(record, PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes);
                  if (++recordCount > PROJECT_MODEL_BACKUP_LIMITS.maxRecords || totalBytes > PROJECT_MODEL_BACKUP_LIMITS.maxTotalBytes) throw error('backup-capacity');
                  records.push(record);
                }
                value.continue();
              } catch (failure) { reject(failure); }
            };
          });
          const indexes = Array.from(store.indexNames).map((indexName) => {
            const index = store.index(indexName);
            return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          });
          stores.push({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, records });
        }
        return { capture: captured, source: { databaseName: database.name, schemaVersion: database.version,
          databaseStoreNames: names, stores, localStorage: [{ key: 'ai_canvas_pending_tasks', value: pendingTaskSource }] } };
      }, options.signal);
    },
    readExport: (operationId: string, options: { signal?: AbortSignal } = {}) => transaction(database, [], false,
      async (tx) => { await guard(tx); return exportJournal(tx, operationId); }, options.signal),
    recoveryDisposition: async (operationId: string) => {
      const journal = await readImport(operationId), committed = IMPORT_PHASES.indexOf(journal.phase) >= IMPORT_PHASES.indexOf('db_committed');
      return { operationId, phase: journal.phase, action: committed ? 'reproject-committed' as const : 'resume-or-retain-unreferenced' as const,
        canRepeatMerge: false as const, canDeletePublishedMedia: false as const, journal };
    },
  };
}
