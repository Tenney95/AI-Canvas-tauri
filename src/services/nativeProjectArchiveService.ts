import { nativeGlobalAssetReferenceRows } from './nativeGlobalAssetReferences';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { hasControlCharacters } from '../utils/controlCharacters';
/** 新项目归档入口；旧项目继续使用 projectTransferService 的原路径。 */
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { copyFile, mkdir, remove, exists } from '@tauri-apps/plugin-fs';
import { configValuesEqual } from './configPatch';
import { sanitizeFileName, isTauriEnv } from './fileService';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { prepareProjectModelArchiveCapture } from './projectModelArchiveService';
import { createBoundProjectModelArchiveExportPort } from './projectModelArchiveNativePort';
import { readProjectArchiveV4, serializeProjectArchiveV4 } from './projectArchiveV4';
import { PROJECT_EXCHANGE_LIMITS } from './projectExchangeFormat';
import { withEpisodeEditorWrite } from './episodeEditorSessionService';
import { openDB, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_PROJECT_MEMORIES, STORE_HISTORY, STORE_METADATA } from './indexedDb/schema';
import { getAssetIndexById } from './indexedDbService';
import { getGlobalFilesDir } from './fs/assetLibrary';
import { getRelativeAssetPath } from './fs/assetIndex';
import { safeExchangePath, type ArchiveAssetDigest } from './projectExchangeDomain';
import { advanceNativeProjectExport, listNativeRetiredCanvasIds, prepareNativeProjectExport, readNativeProjectCapture, readNativeProjectExport } from './indexedDb/nativeProjectRepository';
import type { ProjectModelTransferCapture, ProjectModelTransferHistoryRow } from '../types/projectModelTransfer';
import type { ProjectExportResult, ProjectImportResult } from './projectTransferService';
import type { VideoEditorProjectRecord } from '../types/videoEditor';
import { getBaseDir, joinPath } from './fileService';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { syncNativeOutputHistory } from './nativeOutputHistorySync';

const req = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('项目历史读取失败'));
});

/** 一次旧库只读事务覆盖项目根、活动与墓碑画布的阅读历史。 */
async function readHistory(projectId: string, canvasIds: string[]): Promise<ProjectModelTransferHistoryRow[]> {
  const database = await openDB();
  const owners = [...new Set([projectId, ...canvasIds])];
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_PROJECT_MEMORIES, STORE_HISTORY, STORE_METADATA], 'readonly');
    let result: ProjectModelTransferHistoryRow[] | undefined, failure: unknown;
    const read = async () => {
      const range = (id: string) => IDBKeyRange.bound([id, 0], [id, Infinity]);
      const [conversations, memories, outputs] = await Promise.all([
        Promise.all(owners.map((id) => req(tx.objectStore(STORE_CHAT_CONVERSATIONS).index('projectId_updatedAt').getAll(range(id))))),
        Promise.all(owners.map((id) => req(tx.objectStore(STORE_PROJECT_MEMORIES).index('projectId_updatedAt').getAll(range(id))))),
        Promise.all(canvasIds.map((id) => req(tx.objectStore(STORE_HISTORY).index('projectId_timestamp_id')
          .getAll(IDBKeyRange.bound([id, -Infinity], [id, Infinity, []]))))),
      ]);
      const active = conversations.flat().filter((row) => !row.deletedAt) as Array<{ id: string; projectId: string; [field: string]: unknown }>;
      const messages = (await Promise.all(active.map((row) => req(tx.objectStore(STORE_CHAT_MESSAGES).index('conversationId_sequence')
        .getAll(IDBKeyRange.bound([row.id, 0], [row.id, Infinity])))))).flat() as Array<{ id: string; projectId: string; conversationId: string; [field: string]: unknown }>;
      const byConversation = new Map(active.map((row) => [row.id, row.projectId]));
      if (messages.some((row) => !byConversation.has(row.conversationId) || byConversation.get(row.conversationId) !== row.projectId)) {
        throw new Error('会话消息归属异常，未导出项目');
      }
      const make = (kind: ProjectModelTransferHistoryRow['kind'], value: ProjectModelTransferHistoryRow['value']): ProjectModelTransferHistoryRow =>
        ({ kind, sourceNamespace: `native:${projectId}`, archiveOriginId: '', value });
      const readableOutputs: ProjectModelTransferHistoryRow['value'][] = [];
      for (const value of outputs.flat() as ProjectModelTransferHistoryRow['value'][]) {
        if (await req(tx.objectStore(STORE_METADATA).getKey(`forgotten-missing-history:${encodeURIComponent(value.id)}`)) === undefined) readableOutputs.push(value);
      }
      const rows = [...active.map((value) => make('conversation', value)), ...messages.map((value) => make('message', value)),
        ...memories.flat().map((value) => make('memory', value)), ...readableOutputs.map((value) => make('output', value))];
      if (rows.length > PROJECT_EXCHANGE_LIMITS.values || new TextEncoder().encode(projectModelSourceToken(rows)).byteLength > PROJECT_EXCHANGE_LIMITS.bundleBytes) {
        throw new Error('项目历史超过归档上限，未截断导出');
      }
      return rows;
    };
    void read().then((value) => { result = value; }, (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } });
    tx.oncomplete = () => result ? resolve(result) : reject(failure ?? new Error('项目历史捕获失败'));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('项目历史捕获失败'));
  });
}

/** 仅导出产物文件闭包；未交付/已结束跟踪的同步文件也保留，不导出任务执行权。 */
export function nativeMediaResultsForArchive(records: readonly NativeMediaTaskRecord[], canvasIds: ReadonlySet<string>): NonNullable<ProjectModelTransferCapture['nativeMediaResults']> {
  return records.filter((record) => canvasIds.has(record.canvasId)).flatMap((record) => {
    const cached = nativeMediaLocalOutputs(record);
    const outputs = cached.length ? cached : record.status === 'delivered' && record.resultRelativePath
      ? [{ relativePath: record.resultRelativePath, category: record.category }] : [];
    return outputs.map((file, ordinal) => ({ operationId: record.operationId, ...(record.apimartImageBatch || record.localResults ? { ordinal } : {}),
      canvasId: record.canvasId, relativePath: file.relativePath, category: file.category, providerConfigId: record.providerConfigId, createdAt: record.createdAt,
      ...(record.origin ? { origin: record.origin } : {}) }));
  }).sort((left, right) => left.operationId.localeCompare(right.operationId) || (left.ordinal ?? 0) - (right.ordinal ?? 0));
}

export async function captureNativeProjectArchive(projectId: string): Promise<{ value: ProjectModelTransferCapture; changeRevision: number; editorRecords: VideoEditorProjectRecord[] }> {
  const before = await readNativeProjectCapture(projectId);
  if (!before) throw new Error('项目不存在');
  // 剪辑写入推进 changeRevision；前后围栏避免检查后漏掉并发写入。
  const { listNativeVideoEditorProjectsForProject } = await import('./indexedDb/nativeVideoEditorRepository');
  const allEditors = await listNativeVideoEditorProjectsForProject(projectId);
  const retired = await listNativeRetiredCanvasIds(projectId);
  // outbox先按原画布投影，再冻结旧库历史；这里只处理新项目，不迁移旧项目。
  for (const canvasId of [...before.aggregate.canvases.map((canvas) => canvas.id), ...retired]) await syncNativeOutputHistory(canvasId);
  const activeCanvasIds = new Set(before.aggregate.canvases.map((canvas) => canvas.id));
  const retiredCanvasIds = new Set(retired);
  if (allEditors.some((record) => !activeCanvasIds.has(record.projectId) && !retiredCanvasIds.has(record.projectId))) {
    throw new Error('剪辑工程缺少对应的活动画布或墓碑');
  }
  const editorRecords = allEditors.filter((record) => activeCanvasIds.has(record.projectId));
  const retiredEditorRecords = allEditors.filter((record) => retiredCanvasIds.has(record.projectId));
  const { listNativeMediaTasks } = await import('./indexedDb/nativeMediaTaskRepository');
  const mediaRecords = await listNativeMediaTasks(projectId), mediaCanvases = new Set([...activeCanvasIds, ...retiredCanvasIds]);
  const nativeMediaResults = nativeMediaResultsForArchive(mediaRecords, mediaCanvases);
  const { listNativeWorkflowRetainedOutputs } = await import('./nativeWorkflowTasks');
  const { listNativeBuiltinImageRetainedOutputs } = await import('./nativeBuiltinImageTask');
  const retainedOutputs = [...await listNativeWorkflowRetainedOutputs(projectId), ...await listNativeBuiltinImageRetainedOutputs(projectId)];
  for (const output of retainedOutputs) {
    const original = mediaRecords.find((row) => row.operationId === output.operationId && row.canvasId === output.canvasId);
    if (!original || !mediaCanvases.has(output.canvasId)) throw new Error('已保留工作流产物缺少原画布或任务身份');
    // sidecar保留服务商顺序，主结果集合可能按请求类别前置；文件闭包不将同一字节引用重复分配身份。
    if (nativeMediaResults.some((file) => file.operationId === output.operationId && file.relativePath === output.relativePath && file.category === output.category)) continue;
    nativeMediaResults.push({ operationId: output.operationId, ordinal: output.ordinal, canvasId: output.canvasId,
      relativePath: output.relativePath, category: output.category, providerConfigId: original.providerConfigId, createdAt: original.createdAt,
      ...(original.origin ? { origin: original.origin } : {}) });
  }
  nativeMediaResults.sort((left, right) => left.operationId.localeCompare(right.operationId) || (left.ordinal ?? 0) - (right.ordinal ?? 0)
    || left.relativePath.localeCompare(right.relativePath));
  const { readNativeAssets } = await import('./indexedDb/nativeAssetRepository');
  const { listNativeEditorMediaArtifactsForProject } = await import('./indexedDb/nativeEditorMediaTaskRepository');
  const nativeEditorMediaArtifacts = await listNativeEditorMediaArtifactsForProject(projectId);
  const assetMetadata = (await readNativeAssets()).filter((record) => record.projectId === projectId).map((record) => ({
    assetId: record.assetId, rootRef: record.rootRef, path: record.relativePath, ownerId: record.ownerId,
    bytes: record.bytes, sha256: record.sha256, ...(record.tags ? { tags: record.tags } : {}),
    ...(record.images ? { images: record.images } : {}),
  })).sort((left, right) => left.assetId.localeCompare(right.assetId));
  const history = await readHistory(projectId, [...before.aggregate.canvases.map((item) => item.id), ...retired]);
  const after = await readNativeProjectCapture(projectId);
  if (!after || before.changeRevision !== after.changeRevision || !configValuesEqual(before.exchange, after.exchange)) throw new Error('项目在捕获期间变化，请重试');
  const aggregate = { ...before.aggregate, previews: [], bindings: retired.map((id) => ({ namespace: 'legacy-canvas' as const,
    legacyId: id, projectId, canvasId: id, storageRootRef: before.aggregate.project.storageRootRef, sourceEpoch: 0, retired: true as const })) };
  const sourceToken = await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken({ aggregate, history,
    ...(editorRecords.length ? { editorRecords } : {}),
    ...(retiredEditorRecords.length ? { retiredEditorRecords } : {}),
    ...(nativeMediaResults.length ? { nativeMediaResults } : {}),
    ...(nativeEditorMediaArtifacts.length ? { nativeEditorMediaArtifacts } : {}),
    ...(assetMetadata.length ? { assetMetadata } : {}), exchange: before.exchange })));
  return { changeRevision: before.changeRevision, editorRecords, value: { schemaVersion: 1, generation: 1, sessionId: 'native-project',
    sessionRevision: before.changeRevision, aggregate, exchange: before.exchange, historyBindings: [], history, editorRecords,
    retiredEditorRecords, nativeMediaResults, nativeEditorMediaArtifacts, assetMetadata, sourceToken, includesHistory: true } };
}

async function assertCurrent(expected: ProjectModelTransferCapture): Promise<void> {
  const latest = await captureNativeProjectArchive(expected.aggregate.project.id);
  if (latest.value.sourceToken !== expected.sourceToken || latest.changeRevision !== expected.sessionRevision) throw new Error('项目或历史在导出期间变化，请重试');
}

/** 只改本次归档快照；全局字节先以原生受控复制物化到独立目录。 */
export interface NativeGlobalRecoveryFile { assetId: string; rootRef: string; path: string; bytes: number; sha256: string }
export async function verifyNativeGlobalRecoverySources(capture: ProjectModelTransferCapture, files: readonly NativeGlobalRecoveryFile[]): Promise<void> {
  if (!files.length) return;
  const root = await getGlobalFilesDir(); if (!root) throw new Error('原全局素材目录不可用，未更新项目');
  const references = nativeGlobalAssetReferenceRows(capture);
  for (const file of files) {
    const index = await getAssetIndexById(file.assetId);
    const relative = index && getRelativeAssetPath(index.path, root);
    if (!index || index.source !== 'global' || index.status !== 'online' || !relative
      || !references.some((row) => (typeof row.imageAssetId === 'string' && row.imageAssetId ? row.imageAssetId
        : typeof row.assetId === 'string' && row.assetId ? row.assetId : undefined) === file.assetId)) throw new Error('原全局素材身份或目录已变化，原操作保留');
    const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: root, selectedPaths: [safeExchangePath(relative)] });
    if (actual.length !== 1 || actual[0].path !== relative || actual[0].bytes !== file.bytes || actual[0].sha256 !== file.sha256) throw new Error('原全局素材字节已变化，未更新项目');
  }
}
export async function materializeNativeArchiveGlobalAssets(capture: ProjectModelTransferCapture, operationId: string,
  recovery?: { files: NativeGlobalRecoveryFile[] }): Promise<ProjectModelTransferCapture> {
  const portable = structuredClone(capture), references: Array<{ row: Record<string, unknown>; id: string }> = [];
  const indexes = new Map<string, Awaited<ReturnType<typeof getAssetIndexById>>>();
  for (const record of nativeGlobalAssetReferenceRows(portable)) {
    if (record.assetSource === 'project' && (typeof record.relativePath === 'string' || typeof record.imageRelativePath === 'string')) continue;
    const candidate = typeof record.imageAssetId === 'string' && record.imageAssetId ? record.imageAssetId
      : typeof record.assetId === 'string' && record.assetId ? record.assetId : undefined;
    if (!candidate) throw new Error('全局素材缺少身份，无法完整导出');
    if (!indexes.has(candidate)) indexes.set(candidate, await getAssetIndexById(candidate));
    const index = indexes.get(candidate);
    if (!index && (record.assetSource === 'global' || record.imageAssetId)) throw new Error('全局素材索引缺失，无法完整导出');
    if (index?.source === 'global') references.push({ row: record, id: candidate });
  }
  if (!references.length) return portable;
  const globalRoot = await getGlobalFilesDir();
  if (!globalRoot) throw new Error('全局素材目录不可用');
  const sources = new Map<string, string>();
  for (const { id } of references) {
    const index = indexes.get(id);
    if (!index || index.status !== 'online' || index.source !== 'global') throw new Error('全局素材离线，无法完整导出');
    const relative = getRelativeAssetPath(index.path, globalRoot);
    if (!relative) throw new Error('全局素材不属于受权目录，无法导出');
    sources.set(id, safeExchangePath(relative));
  }
  const paths = [...new Set(sources.values())];
  const scanned = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: globalRoot, selectedPaths: paths });
  if (scanned.length !== paths.length || paths.some((path) => !scanned.some((item) => item.path === path))) throw new Error('全局素材缺失，无法完整导出');
  const publicationId = `global-${operationId}`, destination = new Map<string, string>();
  const assets = await Promise.all(paths.map(async (path) => {
    const source = scanned.find((item) => item.path === path)!;
    const suffix = path.split('.').pop()?.toLowerCase() ?? 'bin', ext = /^[a-z0-9]{1,16}$/.test(suffix) ? suffix : 'bin';
    const sourceId = [...sources.entries()].filter(([, value]) => value === path).map(([id]) => id).sort()[0];
    const name = `global-${await sha256BytesHex(new TextEncoder().encode(sourceId))}.${ext}`;
    destination.set(path, `imports/${publicationId}/${name}`);
    return { path, sourceRootRef: 'global', destinationPath: name, bytes: source.bytes, sha256: source.sha256 };
  }));
  const projectDir = await invoke<string>('resolve_native_project_media_root', { projectId: capture.aggregate.project.id });
  const publicationDirectory = `${projectDir.replace(/[\\/]+$/, '')}/imports/${publicationId}`;
  if (!await exists(publicationDirectory)) {
    try { await invoke('publish_project_import_assets', { stagingDir: globalRoot, projectDir, operationId: publicationId,
      sourceRoots: [{ rootRef: 'global', directory: globalRoot }], assets }); }
    catch (error) { if (!await exists(publicationDirectory)) throw error; }
  }
  // 同操作只能核验原副本，不能覆盖；完整集合也须相同，不能复用部分或换过来源的目录。
  const published = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: publicationDirectory });
  if (published.length !== assets.length || assets.some((asset) => !published.some((file) => file.path === asset.destinationPath
    && file.bytes === asset.bytes && file.sha256 === asset.sha256))) throw new Error('原全局素材发布内容与本轮冻结清单不一致，未覆盖原副本');
  const copied = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: projectDir,
    selectedPaths: assets.map((item) => destination.get(item.path)!) });
  if (copied.length !== assets.length || assets.some((item) => !copied.some((found) => found.path === destination.get(item.path)
    && found.bytes === item.bytes && found.sha256 === item.sha256))) throw new Error('全局素材副本校验失败，未导出');
  const logicalRoot = portable.exchange?.identities.find((item) => item.kind === 'storage-root'
    && item.localId === portable.aggregate.project.storageRootRef)?.sourceId;
  if (portable.exchange && logicalRoot) for (const asset of assets) {
    const filename = asset.destinationPath.replace(/\.[^.]+$/, '');
    const previous = portable.exchange.fileBindings.filter((item) => item.rootRef === logicalRoot
      && /^imports\/global-[a-f0-9-]{36}\//.test(item.localRelativePath)
      && item.localRelativePath.split('/').at(-1)?.replace(/\.[^.]+$/, '') === filename);
    if (previous.length > 1) throw new Error('全局素材的旧身份映射不唯一');
    if (previous[0]) previous[0].localRelativePath = destination.get(asset.path)!;
  }
  for (const { row, id } of references) {
    const path = destination.get(sources.get(id)!);
    if (!path) throw new Error('全局素材映射缺失');
    if (recovery) {
      const source = copied.find((item) => item.path === path)!;
      if (!recovery.files.some((item) => item.assetId === id)) recovery.files.push({ assetId: id,
        rootRef: portable.aggregate.project.storageRootRef, path, bytes: source.bytes, sha256: source.sha256 });
      row.assetSource = 'project';
      if (row.imageAssetId) row.imageRelativePath = path;
    } else {
      delete row.assetSource; delete row.assetId; delete row.imageAssetId; delete row.imageRelativePath;
    }
    delete row.filePath; delete row.imageUrl; delete row.audioUrl; delete row.videoUrl; delete row.url; delete row.output; delete row.imageNodeId; delete row.sourceNodeId;
    row.storageRootRef = portable.aggregate.project.storageRootRef; row.relativePath = path;
  }
  return portable;
}

async function prepareNativeArchiveMaterial(capture: ProjectModelTransferCapture, operationId: string,
  port: ReturnType<typeof createBoundProjectModelArchiveExportPort>) {
  const globalFiles: NativeGlobalRecoveryFile[] = [];
  const portable = await materializeNativeArchiveGlobalAssets(capture, operationId, { files: globalFiles });
  const original = await port.inspectAssets(portable);
  const { captureNativeAssetSnapshots, rebindNativeAssetReferenceFiles } = await import('./nativeProjectAssetRecovery');
  const captured = await captureNativeAssetSnapshots(portable.aggregate, portable.editorRecords ?? [], original, globalFiles);
  const ids = new Set(captured.map((asset) => asset.assetId));
  for (const asset of portable.assetMetadata ?? []) if (!ids.has(asset.assetId) && original.some((file) => file.rootRef === asset.rootRef
    && file.path === asset.path && file.bytes === asset.bytes && file.sha256 === asset.sha256)) captured.push(structuredClone(asset));
  const { freezeNativeAssetImageReferences } = await import('./nativeAssetReferenceFiles');
  const frozen = await freezeNativeAssetImageReferences(capture.aggregate.project.id, operationId, captured);
  portable.assetMetadata = frozen.snapshots; rebindNativeAssetReferenceFiles(portable, frozen.referenceFiles);
  const assets = await port.inspectAssets(portable);
  return { portable, assets };
}

/** 保存对话框选定后捕获完整材料，登记 journal，再使用原生回执发布。 */
export async function exportNativeProjectArchive(projectId: string): Promise<ProjectExportResult | null> {
  if (!isTauriEnv()) throw new Error('项目导出仅在桌面版可用');
  const initial = await readNativeProjectCapture(projectId);
  if (!initial) throw new Error('项目不存在');
  const outputPath = await save({ title: '导出项目', defaultPath: `${sanitizeFileName(initial.aggregate.project.name || '项目')}.aicanvas`,
    filters: [{ name: 'AI Canvas 项目包', extensions: ['aicanvas'] }] });
  if (!outputPath) return null;
  const source = await captureNativeProjectArchive(projectId), owners = [...new Set([projectId, ...source.value.aggregate.episodes.map((item) => item.id),
    ...source.value.aggregate.canvases.map((item) => item.id)])].sort();
  const operationId = crypto.randomUUID(), port = createBoundProjectModelArchiveExportPort(projectId, outputPath);
  const lock = async (index: number): Promise<ProjectExportResult> => {
    if (index < owners.length) return withEpisodeEditorWrite(owners[index], () => lock(index + 1));
    const { portable, assets } = await prepareNativeArchiveMaterial(source.value, operationId, port);
    const prepared = await prepareProjectModelArchiveCapture(portable, assets);
    const entries = await serializeProjectArchiveV4(prepared.payload, { packageId: prepared.exchange.bundle.packageId, exportedAt: Date.now() },
      prepared.exchange.bundle.files.map((file) => { const media = prepared.snapshot.media.find((item) => item.id === file.mediaId)!;
        return { path: file.archivePath.slice(7), bytes: media.bytes, sha256: media.sha256 }; }));
    await assertCurrent(source.value);
    let operation = await prepareNativeProjectExport({ operationId, projectId, expectedChangeRevision: source.changeRevision,
      expectedExchange: source.value.exchange, exchange: prepared.exchange, includesHistory: true, sourceToken: source.value.sourceToken });
    operation = await advanceNativeProjectExport(operationId, operation.sequence, 'packing');
    const receipt = await port.pack(operation, entries, portable, prepared.files, assets);
    await port.verifyExportPublication(operation, receipt);
    operation = await advanceNativeProjectExport(operationId, operation.sequence, 'published', receipt);
    await assertCurrent(source.value);
    await advanceNativeProjectExport(operationId, operation.sequence, 'registered', receipt);
    return { filePath: outputPath, assetCount: assets.length, archiveBytes: receipt.archiveBytes ?? 0,
      episodeCount: source.value.aggregate.episodes.length, operationId };
  };
  try { return await lock(0); }
  catch (error) {
    let operation: Awaited<ReturnType<typeof readNativeProjectExport>>;
    try { operation = await readNativeProjectExport(operationId); }
    catch (cause) { throw new Error(`导出结果未知，原操作 ${operationId} 已保留，请先核对`, { cause }); }
    if (operation) throw new Error(`导出未完成，原操作 ${operationId} 已保留；${error instanceof Error ? error.message : '请核对后续接'}`, { cause: error });
    throw error;
  }
}

/** 确认原操作的原生文件；不会重新打包或覆盖。 */
export async function reconcileNativeProjectArchiveExport(operationId: string): Promise<void> {
  let operation = await readNativeProjectExport(operationId);
  if (!operation) throw new Error('导出操作不存在');
  if (operation.phase === 'registered') return;
  if (operation.phase !== 'packing' && operation.phase !== 'published') throw new Error('原导出尚未发布，请重新选择输出');
  const port = createBoundProjectModelArchiveExportPort(operation.projectId, '');
  const receipt = await port.recoverExportPublication(operation);
  if (operation.phase === 'packing') operation = await advanceNativeProjectExport(operationId, operation.sequence, 'published', receipt);
  const current = await captureNativeProjectArchive(operation.projectId);
  if (current.value.sourceToken !== operation.expectedToken || current.changeRevision !== operation.expectedChangeRevision) {
    throw new Error('原归档已发布，但项目或历史已变化，保留原回执待核对');
  }
  await advanceNativeProjectExport(operationId, operation.sequence, 'registered', receipt);
}

/** 复制使用独立来源和导入 journal，不修改源项目的协作 head。 */
export async function duplicateNativeProjectArchive(projectId: string, name: string): Promise<ProjectImportResult> {
  if (!isTauriEnv()) throw new Error('项目复制仅在桌面版可用');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 256 || hasControlCharacters(name)) throw new Error('副本名称无效');
  const source = await captureNativeProjectArchive(projectId), operationId = crypto.randomUUID();
  const owners = [...new Set([projectId, ...source.value.aggregate.episodes.map((item) => item.id),
    ...source.value.aggregate.canvases.map((item) => item.id)])].sort();
  const run = async (index: number): Promise<ProjectImportResult> => {
    if (index < owners.length) return withEpisodeEditorWrite(owners[index], () => run(index + 1));
    const port = createBoundProjectModelArchiveExportPort(projectId, '');
    const { portable, assets } = await prepareNativeArchiveMaterial(source.value, operationId, port);
    portable.aggregate.project.name = name.trim();
    const prepared = await prepareProjectModelArchiveCapture(portable, assets);
    const descriptors = prepared.exchange.bundle.files.map((file) => {
      const media = prepared.snapshot.media.find((item) => item.id === file.mediaId);
      if (!media) throw new Error('项目副本缺少媒体描述');
      return { path: safeExchangePath(file.archivePath.slice(7)), bytes: media.bytes, sha256: media.sha256 };
    });
    const entries = await serializeProjectArchiveV4(prepared.payload, { packageId: prepared.exchange.bundle.packageId, exportedAt: Date.now() }, descriptors);
    const validated = await readProjectArchiveV4(Object.fromEntries(entries.map((entry) => [entry.path, entry.content])), descriptors);
    await assertCurrent(source.value);
    const base = await getBaseDir(); if (!base) throw new Error('无法准备项目副本暂存目录');
    const directory = joinPath(base, `native-copy-${operationId}`);
    await mkdir(directory);
    try {
      for (const file of prepared.exchange.bundle.files) {
        const logical = prepared.files.find((item) => item.mediaId === file.mediaId);
        const binding = logical && prepared.exchange.fileBindings.find((item) => item.id === logical.id && item.rootRef === logical.rootRef
          && item.relativePath === logical.relativePath);
        const root = logical && prepared.exchange.identities.find((item) => item.kind === 'storage-root' && item.sourceId === logical.rootRef)?.localId;
        const asset = assets.find((item) => item.rootRef === root && (item.path === binding?.localRelativePath
          || !!binding && item.aliases?.includes(binding.localRelativePath)));
        if (!asset?.localAbsolutePath) throw new Error('项目副本缺少可确认的素材来源');
        const parts = safeExchangePath(file.archivePath.slice(7)).split('/');
        if (parts.length > 1) await mkdir(joinPath(directory, ...parts.slice(0, -1)), { recursive: true });
        await copyFile(asset.localAbsolutePath, joinPath(directory, ...parts));
      }
      await assertCurrent(source.value);
      const { importNativeProjectArchiveCopy } = await import('./nativeProjectImportService');
      return await importNativeProjectArchiveCopy(validated, directory);
    } finally {
      // 真实导入会先复制并核验自己的独立来源；此目录只属于本次副本操作。
      await remove(directory, { recursive: true }).catch(() => undefined);
    }
  };
  return run(0);
}
