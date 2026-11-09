import { materializeNativeArchiveAssetMetadata } from './nativeArchiveAssetMetadata';
/** 新项目包新副本导入；未完成的操作保留原暂存与 journal。 */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { copyFile, mkdir } from '@tauri-apps/plugin-fs';
import * as files from './fileService';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { importProjectModelArchiveHistory, materializeProjectModelArchiveBusiness, readProjectModelArchive } from './projectModelArchiveService';
import { createBoundProjectModelArchiveImportPort } from './projectModelArchiveNativePort';
import { readProjectArchiveV4, serializeProjectArchiveV4 } from './projectArchiveV4';
import { createProjectExchangeRevisionV2 } from './projectExchangeV2Format';
import { commitNativeArchiveHistory } from './nativeArchiveHistoryCommit';
import { advanceNativeProjectImport, commitNativeProjectImport, prepareNativeProjectImport, readNativeProjectImport,
  type NativeProjectImportJournal } from './indexedDb/nativeProjectRepository';
import type { ProjectModelTransferExchange, ProjectModelTransferHistoryRow } from '../types/projectModelTransfer';
import { safeExchangePath, type ArchiveAssetDigest } from './projectExchangeDomain';
import type { ProjectImportResult } from './projectTransferService';
import { withPreparedProjectImportRead, type PreparedProjectImport, type ProjectImportOptions } from './projectImportService';
import type { ValidatedProjectArchiveV4 } from '../types/projectArchiveV4';

const digest = (value: unknown) => sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(value)));

async function finishImport(operation: NativeProjectImportJournal, signal?: AbortSignal): Promise<NativeProjectImportJournal> {
  signal?.throwIfAborted();
  if (operation.phase === 'finalized') return operation;
  if (!operation.sourceRef) throw new Error('原导入的隔离来源缺失，请保留操作材料');
  const port = createBoundProjectModelArchiveImportPort(operation.projectId, operation.sourceRef);
  if (operation.phase === 'prepared') {
    // claim 在原生登记已存在时校验并复用；未知目录不会被接管。
    await invoke('claim_native_project_media_root', { projectId: operation.projectId, projectName: operation.next.project.name });
    for (const root of operation.next.project.storageBindings) if (root.rootRef !== operation.next.project.storageRootRef) {
      try { await invoke('resolve_native_project_media_subroot', { projectId: operation.projectId, rootRef: root.rootRef, create: false }); }
      catch { await invoke('resolve_native_project_media_subroot', { projectId: operation.projectId, rootRef: root.rootRef, create: true }); }
    }
    signal?.throwIfAborted();
    operation = await advanceNativeProjectImport(operation.operationId, operation.sequence, 'media_publishing');
  }
  if (operation.phase === 'media_publishing') {
    const reference = await port.publishMedia(operation);
    await port.verifyMediaPublication(operation, reference);
    signal?.throwIfAborted();
    operation = await advanceNativeProjectImport(operation.operationId, operation.sequence, 'media_ready', reference);
  }
  if (operation.phase === 'media_ready') {
    await port.verifyMediaPublication(operation, operation.mediaPublicationRef!);
    signal?.throwIfAborted();
    await commitNativeArchiveHistory(operation);
    signal?.throwIfAborted();
    operation = await commitNativeProjectImport(operation.operationId, operation.sequence);
  }
  if (operation.phase === 'db_committed') operation = await advanceNativeProjectImport(operation.operationId, operation.sequence, 'finalized');
  return operation;
}

function result(operation: NativeProjectImportJournal): ProjectImportResult {
  const project = operation.next.project;
  return { projectId: project.id, projectName: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt,
    dataFolder: project.dataFolder, settings: project.defaultSettings, episodes: [], warnings: [], assetCount: operation.media.length,
    missingAssetCount: 0, conversationCount: operation.history.filter((item) => item.kind === 'conversation').length,
    memoryCount: operation.history.filter((item) => item.kind === 'memory').length };
}

/** v1–v4 项目包均转换为全新 p2/e2/c2 身份，不写入旧项目表。 */
async function importSource(sourceValue: ValidatedProjectArchiveV4, originalDirectory: string,
  options: Pick<ProjectImportOptions, 'appendChat' | 'appendMemories' | 'independent' | 'signal'>,
  onOperation?: (id: string) => void): Promise<ProjectImportResult> {
  options.signal?.throwIfAborted();
  const entries = await serializeProjectArchiveV4(sourceValue.payload, sourceValue.manifest, sourceValue.assets);
  let source = await readProjectArchiveV4(Object.fromEntries(entries.map((entry) => [entry.path, entry.content])), sourceValue.assets);
  // 旧包只有全局本机索引而未携带文件时不能跨机器恢复；避免无提示丢失。
  const shared = source.payload.contents.project.data.dramaAssets as { scenes?: Array<{ imageAssetId?: unknown; referenceImages?: Array<{ assetSource?: unknown }> }>;
    props?: Array<{ imageAssetId?: unknown; referenceImages?: Array<{ assetSource?: unknown }> }> } | undefined;
  for (const asset of [...(shared?.scenes ?? []), ...(shared?.props ?? [])]) {
    if (asset.imageAssetId || asset.referenceImages?.some((reference) => reference.assetSource === 'global')) {
      throw new Error('项目包引用了未随包携带的全局素材，无法完整导入');
    }
  }
  if (options.independent) {
    const snapshot = { ...source.snapshot, lineageId: crypto.randomUUID() };
    const head = await createProjectExchangeRevisionV2(snapshot);
    const exchange = { ...source.payload.exchange, lineageId: snapshot.lineageId, packageId: crypto.randomUUID(),
      head: { canonicalVersion: 2 as const, revisionId: head.revisionId }, revisions: [head], ancestors: [] };
    const payload = { ...source.payload, exchange };
    const converted = await serializeProjectArchiveV4(payload, { packageId: exchange.packageId, exportedAt: source.manifest.exportedAt }, source.assets);
    source = await readProjectArchiveV4(Object.fromEntries(converted.map((entry) => [entry.path, entry.content])), source.assets);
  }
  const operationId = crypto.randomUUID(), projectId = `p2-${crypto.randomUUID()}`, sourceRef = `native-import-${operationId}`;
  const base = await files.getBaseDir(); if (!base) throw new Error('无法准备隔离导入目录');
  const directory = files.joinPath(base, sourceRef);
  await mkdir(directory);
  for (const asset of source.assets) {
    options.signal?.throwIfAborted();
    const segments = safeExchangePath(asset.path).split('/');
    if (segments.length > 1) await mkdir(files.joinPath(directory, ...segments.slice(0, -1)), { recursive: true });
    await copyFile(files.joinPath(originalDirectory, ...segments), files.joinPath(directory, ...segments));
  }
  const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: directory,
    selectedPaths: source.assets.map((item) => item.path) });
  if (actual.length !== source.assets.length || source.assets.some((item) => !actual.some((found) => found.path === item.path
    && found.bytes === item.bytes && found.sha256 === item.sha256))) throw new Error('项目包素材在预览后变化，未导入');
  const allocateId = (kind: 'episode' | 'canvas' | 'storage-root') => `${kind === 'episode' ? 'e2' : kind === 'canvas' ? 'c2' : 'r2'}-${crypto.randomUUID()}`;
  const material = await materializeProjectModelArchiveBusiness(source.payload, source.snapshot, null, projectId, operationId,
    undefined, { allocateId, folderName: `project-${projectId}` });
  for (const scope of source.payload.history?.scopes ?? []) if (scope.retired
    && !material.identities.some((item) => item.kind === 'canvas' && item.sourceId === scope.canvasId)) {
    material.identities.push({ kind: 'canvas', sourceId: scope.canvasId, localId: allocateId('canvas') });
  }
  for (const record of source.payload.videoEditor?.retiredRecords ?? []) {
    if (!source.snapshot.historicalTargets.some((item) => item.kind === 'canvas' && item.state === 'retired'
      && item.projectId === source.snapshot.rootProjectId && item.id === record.projectId)) throw new Error('历史剪辑缺少原画布墓碑');
    if (!material.identities.some((item) => item.kind === 'canvas' && item.sourceId === record.projectId)) {
      material.identities.push({ kind: 'canvas', sourceId: record.projectId, localId: allocateId('canvas') });
    }
  }
  const exchange: ProjectModelTransferExchange = { lineageId: source.snapshot.lineageId, localHead: source.payload.exchange.head,
    stateVersion: 1, bundle: source.payload.exchange, identities: material.identities, fileBindings: material.fileBindings, published: [] };
  const editorArchive = await import('./videoEditorArchive');
  const editorRecords = editorArchive.materializeArchiveVideoEditorProjects(source.payload.videoEditor, material.identities, material.fileBindings);
  const retiredEditorRecords = editorArchive.materializeArchiveRetiredVideoEditorProjects(source.payload.videoEditor, material.identities, material.fileBindings);
  const assetRecords = materializeNativeArchiveAssetMetadata({ aggregate: material.aggregate, editors: editorRecords,
    identities: material.identities, bindings: material.fileBindings, selected: source.snapshot, source: source.snapshot,
    metadata: source.payload.assetMetadata });
  const defaultCanvasId = material.aggregate.project.kind === 'standalone' ? material.aggregate.canvases[0]?.id : undefined;
  const history: ProjectModelTransferHistoryRow[] = await importProjectModelArchiveHistory(source, projectId, source.snapshot.lineageId, null,
    { appendChat: options.appendChat, appendMemories: options.appendMemories }, { identities: material.identities, episodes: material.aggregate.episodes, defaultCanvasId, fileBindings: material.fileBindings });
  const port = createBoundProjectModelArchiveImportPort(projectId, sourceRef);
  const staged = await port.captureImportSource!(source);
  const packageDigest = await digest([source.manifest, source.payload.exchange]), intentDigest = await digest([packageDigest, projectId, operationId]);
  let operation: NativeProjectImportJournal;
  try {
    operation = await prepareNativeProjectImport({ operationId, mode: 'import-new', packageDigest, intentDigest,
      sourceLineageId: source.snapshot.lineageId, targetProjectId: projectId, expected: null, next: material.aggregate, exchange,
      idMap: material.identities, history, media: material.media, editorRecords, retiredEditorRecords, assetRecords, sourceRef, sourceFiles: staged.sourceFiles ?? [] });
  } catch (error) {
    // 提交回执丢失时先查原 journal；连查询也失败则保留原操作身份，不能自动重新分配。
    let existing: NativeProjectImportJournal | null;
    try { existing = await readNativeProjectImport(operationId); }
    catch (cause) { onOperation?.(operationId); throw new Error(`导入准备结果未知，原操作 ${operationId} 已保留，请先核对`, { cause }); }
    if (existing) { onOperation?.(operationId); throw new Error(`导入准备已保存，原操作 ${operationId} 可续接`, { cause: error }); }
    throw error;
  }
  onOperation?.(operationId);
  try { return result(await finishImport(operation, options.signal)); }
  catch (error) { throw new Error(`导入未完成，原操作 ${operationId} 已保留；${error instanceof Error ? error.message : '请核对后续接'}`, { cause: error }); }
}

/** 仅由受信调用方传入已校验包与隔离副本；仍重新核验正文和素材字节。 */
export async function importNativeProjectArchiveCopy(source: ValidatedProjectArchiveV4, directory: string): Promise<ProjectImportResult> {
  return importSource(source, directory, { appendChat: true, appendMemories: true, independent: true });
}

/** 使用用户已经预览过的正文和素材，复制并核验独立暂存，不重新打开原路径。 */
const attempts = new WeakMap<PreparedProjectImport, { intent: string; operationId?: string; pending?: Promise<ProjectImportResult> }>();
export async function importNativeProjectArchiveFromSession(session: PreparedProjectImport, options: ProjectImportOptions): Promise<ProjectImportResult> {
  if (!files.isTauriEnv() || session.disposed) throw new Error('项目包预览已关闭');
  if (!session.nativeSource) throw new Error(session.nativeSourceError ?? '项目包缺少可转换为新结构的完整材料');
  const intent = JSON.stringify([options.appendChat, options.appendMemories, !!options.independent]);
  let attempt = attempts.get(session);
  if (attempt && attempt.intent !== intent) throw new Error('原导入操作已冻结选项，请先恢复原操作');
  if (attempt?.pending) return attempt.pending;
  if (!attempt) { attempt = { intent }; attempts.set(session, attempt); }
  const current = attempt;
  const pending = current.operationId ? resumeNativeProjectImport(current.operationId, options.signal)
    : withPreparedProjectImportRead(session, () => importSource(session.nativeSource!, session.directory,
      options, (id) => { current.operationId = id; }));
  current.pending = pending;
  try { return await pending; }
  catch (error) { if (!current.operationId) attempts.delete(session); throw error; }
  finally { current.pending = undefined; }
}

export async function importNativeProjectArchive(): Promise<ProjectImportResult | null> {
  if (!files.isTauriEnv()) throw new Error('项目导入仅在桌面版可用');
  const archivePath = await open({ multiple: false, title: '选择项目包', filters: [{ name: 'AI Canvas 项目包', extensions: ['aicanvas'] }] });
  if (typeof archivePath !== 'string' || !archivePath) return null;
  const previewId = `native-preview-${crypto.randomUUID()}`;
  files.registerProjectFolder(previewId, previewId);
  const directory = await files.ensureProjectDataDir(previewId, { throwOnError: true });
  if (!directory) throw new Error('无法准备项目包预览');
  try {
    const unpacked = await invoke<{ texts: Record<string, string>; assets: ArchiveAssetDigest[] }>('unpack_project_archive', { archivePath, assetsDir: directory });
    const source = await readProjectModelArchive(unpacked.texts, unpacked.assets);
    return await importSource(source, directory, { appendChat: true, appendMemories: true });
  } finally { await files.deleteProjectDataDir(previewId, { throwOnError: true }).catch(() => undefined); }
}

/** 按原 journal 和原隔离来源继续，不重新分配身份或覆盖已有作品。 */
export async function resumeNativeProjectImport(operationId: string, signal?: AbortSignal): Promise<ProjectImportResult> {
  const operation = await readNativeProjectImport(operationId);
  if (!operation) throw new Error('原导入操作不存在');
  return result(await finishImport(operation, signal));
}
