/** 新项目更新的隔离来源与独立原生归档备份；不读写旧项目。 */
import { invoke } from '@tauri-apps/api/core';
import { exists, mkdir, readDir, remove } from '@tauri-apps/plugin-fs';
import * as files from './fileService';
import { captureNativeProjectArchive, materializeNativeArchiveGlobalAssets, verifyNativeGlobalRecoverySources, type NativeGlobalRecoveryFile } from './nativeProjectArchiveService';
import { createBoundProjectModelArchiveExportPort, createBoundProjectModelArchiveImportPort } from './projectModelArchiveNativePort';
import { prepareProjectModelArchiveCapture, readProjectModelArchive } from './projectModelArchiveService';
import { serializeProjectArchiveV4 } from './projectArchiveV4';
import { safeExchangePath, type ArchiveAssetDigest } from './projectExchangeDomain';
import { configValuesEqual } from './configPatch';
import type { ProjectModelArchiveAsset } from './projectModelArchiveService';
import type { NativeContentRecoveryPoint, NativeProjectUpdateJournal } from './indexedDb/nativeProjectRepository';
import type { ProjectModelTransferCapture, ProjectModelTransferExportJournal, ProjectModelTransferImportJournal } from '../types/projectModelTransfer';
import type { ValidatedProjectArchiveV4 } from '../types/projectArchiveV4';
import { captureNativeAssetSnapshots, rebindNativeAssetReferenceFiles, applyNativeGlobalRecoveryFiles } from './nativeProjectAssetRecovery';
import { freezeNativeAssetImageReferences } from './nativeAssetReferenceFiles';
import type { NativeMissingAssetProof } from './nativeMissingAssetBackup';
import { assertPlainArchiveSource, cleanupVerifiedArchiveSource, frozenArchiveSourceAssets, nativeUpdateSourceName } from './nativeArchiveSourceCleanup';
import { assertNativeArchiveHistoryCommitted } from './nativeArchiveHistoryCommit';
import { isPathInsideDir, trashPathKey } from './fs/undoTrashJournal';

export interface NativeUpdateBackup {
  operationId: string;
  outputRef: string;
  packageDigest: string;
}
const validId = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const nativeUpdateInventory = (assets: ProjectModelArchiveAsset[]) => assets.map(({ rootRef, path, bytes, sha256 }) => ({ rootRef, path, bytes, sha256 }))
  .sort((a, b) => { const left = `${a.rootRef}/${a.path}`, right = `${b.rootRef}/${b.path}`; return left < right ? -1 : left > right ? 1 : 0; });

const updateSourceCleanups = new Map<string, Promise<void>>();
const interruptedUnregisteredCleanups: Map<string, () => Promise<void>> = import.meta.hot?.data.interruptedNativeUpdateSourceCleanups ?? new Map();
if (import.meta.hot) import.meta.hot.data.interruptedNativeUpdateSourceCleanups = interruptedUnregisteredCleanups;

/** 正式媒体、历史和数据库提交已确认后，释放独立的更新或恢复输入。 */
export function cleanupFinalizedNativeProjectUpdateSource(operation: NativeProjectUpdateJournal, scannedBase?: string): Promise<void> {
  const { operationId, projectId, sourceRef, sourceFiles, mediaPublicationRef } = operation;
  if (!validId(operationId) || operation.kind !== 'project-model-import' || operation.schemaVersion !== 1
    || operation.sessionId !== 'native-project' || operation.generation !== 1 || operation.phase !== 'finalized'
    || !['update-existing', 'restore-content'].includes(operation.mode) || operation.id !== operationId
    || operation.targetProjectId !== projectId || operation.next?.project?.id !== projectId || operation.committedToken !== operationId
    || sourceRef !== `imports/native-update-${operationId}` || mediaPublicationRef !== `media_v1_${operationId}`
    || !Array.isArray(sourceFiles)) return Promise.resolve();
  const running = updateSourceCleanups.get(operationId);
  if (running) return running;
  const pending = (async () => {
    const base = await files.getBaseDir();
    if (!base || scannedBase !== undefined && scannedBase !== base) return;
    const directory = files.joinPath(base, sourceRef);
    if (!await exists(directory)) return;
    await assertPlainArchiveSource(base, true);
    await assertPlainArchiveSource(files.joinPath(base, 'imports'), true);
    const { readNativeProjectContent } = await import('./indexedDb/nativeProjectRepository');
    if (!await readNativeProjectContent(projectId)) return;
    const root = await invoke<string>('resolve_native_project_media_root', { projectId });
    if (!root || trashPathKey(directory) === trashPathKey(root) || isPathInsideDir(directory, root) || isPathInsideDir(root, directory)) return;
    await assertNativeArchiveHistoryCommitted(operation);
    const port = createBoundProjectModelArchiveImportPort(projectId, sourceRef);
    await port.verifyMediaPublication(operation as ProjectModelTransferImportJournal, mediaPublicationRef);
    await cleanupVerifiedArchiveSource(base, sourceRef, frozenArchiveSourceAssets(sourceFiles));
  })().catch(() => { /* 收尾已提交，缺证据时留原材料供后续核对。 */ }).finally(() => updateSourceCleanups.delete(operationId));
  updateSourceCleanups.set(operationId, pending);
  return pending;
}

export async function cleanupFinalizedNativeProjectUpdateSources(base: string): Promise<void> {
  const parent = files.joinPath(base, 'imports');
  if (!await exists(parent)) return;
  await assertPlainArchiveSource(base, true);
  await assertPlainArchiveSource(parent, true);
  const { readNativeProjectUpdate } = await import('./indexedDb/nativeProjectRepository');
  for (const entry of await readDir(parent)) {
    const operationId = entry.isDirectory && !entry.isSymlink ? nativeUpdateSourceName.exec(entry.name)?.[1] : undefined;
    if (!operationId) continue;
    const operation = await readNativeProjectUpdate(operationId).catch(() => null);
    if (operation) await cleanupFinalizedNativeProjectUpdateSource(operation, base);
  }
}

/** 备份具有原生 publication 回执和独立文件，保留任务/预算现状，不回退审计。 */
export async function createNativeUpdateBackup(expected: ProjectModelTransferCapture, operationId: string, missingFiles: readonly NativeMissingAssetProof[] = [], currentFilesOnly = false): Promise<{
  backup: NativeUpdateBackup; oldAssets: ReturnType<typeof nativeUpdateInventory>;
  assetSnapshots: Awaited<ReturnType<typeof captureNativeAssetSnapshots>>;
  recoveryState: { capture: ProjectModelTransferCapture; exchange: NonNullable<ProjectModelTransferCapture['exchange']>; assets: ReturnType<typeof nativeUpdateInventory>; globalFiles: NativeGlobalRecoveryFile[]; referenceFiles: ReturnType<typeof nativeUpdateInventory>; missingFiles: NativeMissingAssetProof[]; currentFilesOnly: boolean };
}> {
  if (!validId(operationId)) throw new Error('更新操作身份无效');
  const base = await files.getBaseDir(); if (!base) throw new Error('备份目录不可用');
  const projectId = expected.aggregate.project.id, backupId = `backup-${operationId}`;
  const outputPath = files.joinPath(base, `native-project-${backupId}.aicanvas`);
  const globalFiles: NativeGlobalRecoveryFile[] = [];
  const portable = await materializeNativeArchiveGlobalAssets(expected, operationId, { files: globalFiles });
  const port = missingFiles.length || currentFilesOnly ? createBoundProjectModelArchiveExportPort(projectId, outputPath, missingFiles, currentFilesOnly) : createBoundProjectModelArchiveExportPort(projectId, outputPath);
  await verifyNativeGlobalRecoverySources(expected, globalFiles);
  const oldAssets = nativeUpdateInventory(await port.inspectAssets(applyNativeGlobalRecoveryFiles(expected, globalFiles)));
  const originalAssets = await port.inspectAssets(portable);
  const capturedAssets = await captureNativeAssetSnapshots(portable.aggregate, portable.editorRecords ?? [], nativeUpdateInventory(originalAssets), globalFiles);
  const capturedIds = new Set(capturedAssets.map((asset) => asset.assetId));
  for (const asset of portable.assetMetadata ?? []) if (!capturedIds.has(asset.assetId) && originalAssets.some((file) => file.rootRef === asset.rootRef
    && file.path === asset.path && file.bytes === asset.bytes && file.sha256 === asset.sha256)) capturedAssets.push(structuredClone(asset));
  for (const asset of capturedAssets) if (asset.assetId.startsWith('na2-')) for (const image of asset.images ?? []) for (const reference of image.references) {
    const fallback = missingFiles.find((proof) => proof.rootRef === asset.rootRef && proof.path === reference.relativePath);
    if (fallback) reference.relativePath = fallback.copyPath;
  }
  const { snapshots: assetSnapshots, referenceFiles } = await freezeNativeAssetImageReferences(projectId, operationId, capturedAssets);
  rebindNativeAssetReferenceFiles(portable, referenceFiles);
  portable.assetMetadata = assetSnapshots;
  const assets = await port.inspectAssets(portable);
  let prepared = await prepareProjectModelArchiveCapture(portable, assets, [], 'snapshot');
  const descriptors = prepared.exchange.bundle.files.map((file) => {
    const media = prepared.snapshot.media.find((entry) => entry.id === file.mediaId);
    if (!media) throw new Error('恢复备份缺少素材描述');
    return { path: safeExchangePath(file.archivePath.slice(7)), bytes: media.bytes, sha256: media.sha256 };
  });
  const entries = await serializeProjectArchiveV4(prepared.payload,
    { packageId: prepared.exchange.bundle.packageId, exportedAt: Date.now() }, descriptors);
  const before = await captureNativeProjectArchive(projectId);
  if (before.value.sourceToken !== expected.sourceToken || before.changeRevision !== expected.sessionRevision) {
    throw new Error('备份期间项目内容发生变化，未更新');
  }
  const journal: ProjectModelTransferExportJournal = { id: backupId, schemaVersion: 1, kind: 'project-model-export',
    operationId: backupId, generation: 1, sessionId: 'native-project', targetProjectId: projectId,
    expectedToken: expected.sourceToken, expectedExchange: expected.exchange, includesHistory: true,
    head: prepared.exchange.localHead, exchange: prepared.exchange, phase: 'packing', sequence: 0, createdAt: Date.now(), updatedAt: Date.now() };
  // 同一原操作的打包回执可能在响应前落盘；只核对原回执，不覆盖已发布文件。
  const receipt = await port.recoverExportPublication(journal).catch(async () => {
    try { return await port.pack(journal, entries, portable, prepared.files, assets); }
    catch (error) {
      try { return await port.recoverExportPublication(journal); } catch { throw error; }
    }
  });
  await port.verifyExportPublication(journal, receipt);
  const backup = { operationId: backupId, outputRef: receipt.outputRef, packageDigest: receipt.packageDigest };
  const checked = await openNativeUpdateBackup(projectId, backup);
  try {
    if (!configValuesEqual(checked.source.snapshot, prepared.snapshot)) {
      // 若原操作已经用旧版媒体分类写出备份，复现其分类并继续比较原始内容与摘要。
      prepared = await prepareProjectModelArchiveCapture(portable, assets, checked.source.snapshot.media, 'snapshot');
    }
    if (!configValuesEqual(checked.source.snapshot, prepared.snapshot)
      || !configValuesEqual(checked.source.payload.videoEditor, prepared.payload.videoEditor)
      || !configValuesEqual(checked.source.payload.assetMetadata, prepared.payload.assetMetadata)
      || !configValuesEqual(checked.source.payload.history, prepared.payload.history)) throw new Error('恢复备份读回内容与原快照不一致，未更新');
  } finally {
    // 仅清理 openNativeUpdateBackup 为此次校验创建的随机解包目录，永久备份和 journal 均保留。
    await remove(checked.directory, { recursive: true }).catch(() => {});
  }
  const after = await captureNativeProjectArchive(projectId);
  if (after.value.sourceToken !== expected.sourceToken || after.changeRevision !== expected.sessionRevision) {
    throw new Error('备份期间项目内容发生变化，原备份已保留，未更新');
  }
  return { backup, oldAssets, assetSnapshots, recoveryState: { capture: portable, exchange: prepared.exchange, assets: nativeUpdateInventory(assets), globalFiles, referenceFiles, missingFiles: structuredClone(missingFiles) as NativeMissingAssetProof[], currentFilesOnly } };
}

/** 原生回执和文件摘要须在发布前及提交前核验；不能把布尔值当备份证明。 */
export async function verifyNativeUpdateBackup(projectId: string, backup: NativeUpdateBackup): Promise<void> {
  if (!/^backup-[a-f0-9-]{36}$/.test(backup.operationId) || !/^[a-f0-9]{64}$/.test(backup.packageDigest)) throw new Error('恢复备份证明无效');
  const port = createBoundProjectModelArchiveExportPort(projectId, '');
  const receipt = await port.recoverExportPublication({ operationId: backup.operationId, outputRef: backup.outputRef } as ProjectModelTransferExportJournal);
  if (receipt.outputRef !== backup.outputRef || receipt.packageDigest !== backup.packageDigest) throw new Error('恢复备份无法核实，未更新');
}

/** 冻结原操作独立来源。只有本次成功发布且确认未登记时才可回收。 */
export async function withStagedNativeUpdateSource(source: ValidatedProjectArchiveV4, sourceDirectory: string,
  operation: { projectId: string; operationId: string; mode: 'update-existing' | 'restore-content' },
  use: (staged: { sourceRef: string; sourceFiles: NonNullable<ProjectModelTransferImportJournal['sourceFiles']> }) => Promise<void>): Promise<void> {
  const { projectId, operationId, mode } = operation;
  if (!validId(operationId) || !sourceDirectory) throw new Error('更新来源不可用，请重新预览');
  const base = await files.getBaseDir(); if (!base) throw new Error('更新暂存目录不可用');
  const stagedOperation = `native-update-${operationId}`;
  const sourceRef = `imports/${stagedOperation}`, directory = files.joinPath(base, sourceRef);
  const assets = source.assets.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const retryCleanup = interruptedUnregisteredCleanups.get(operationId);
  if (retryCleanup) {
    const { readNativeProjectUpdate } = await import('./indexedDb/nativeProjectRepository');
    if (await readNativeProjectUpdate(operationId)) throw new Error('原操作已登记，请通过原操作续接');
    // 中途失败的清理可能已删除了一部分文件；补清理后再按原操作发布。
    await retryCleanup();
    interruptedUnregisteredCleanups.delete(operationId);
  }
  let ownedStage = false, usingStage = false;
  try {
    // 逐文件摘要、fsync 与原子发布由原生端负责。
    if (!await exists(directory)) {
      try {
        await invoke('publish_project_import_assets', { stagingDir: sourceDirectory, projectDir: base, operationId: stagedOperation,
          assets: assets.map((asset) => ({ path: safeExchangePath(asset.path), destinationPath: safeExchangePath(asset.path),
            bytes: asset.bytes, sha256: asset.sha256 })) });
        ownedStage = true;
      } catch (error) {
        // 回执丢失时可以继续核验原目录，但不能证明由本次创建。
        if (!await exists(directory)) throw error;
      }
    }
    const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: directory,
      selectedPaths: assets.map((asset) => asset.path) });
    if (actual.length !== assets.length || assets.some((asset) => !actual.some((item) => item.path === asset.path
      && item.bytes === asset.bytes && item.sha256 === asset.sha256))) throw new Error('更新来源素材变化，未修改项目');
    const port = createBoundProjectModelArchiveImportPort(projectId, sourceRef);
    const staged = await port.captureImportSource!(source);
    usingStage = true;
    await use({ sourceRef, sourceFiles: staged.sourceFiles ?? [] });
  } catch (error) {
    if (!ownedStage && !usingStage) throw error;
    const action = mode === 'restore-content' ? '恢复' : '更新';
    const { readNativeProjectUpdate } = await import('./indexedDb/nativeProjectRepository');
    let recorded: NativeProjectUpdateJournal | null;
    try { recorded = await readNativeProjectUpdate(operationId); }
    catch (cause) { throw new Error(`${action}结果未知，原操作 ${operationId} 已保留，请先核对`, { cause }); }
    if (recorded) throw new Error(`${action}未完成，原操作 ${operationId} 已保留；${error instanceof Error ? error.message : '请核对后续接'}`, { cause: error });
    if (ownedStage) {
      const cleanup = () => cleanupVerifiedArchiveSource(base, sourceRef, assets);
      await cleanup().catch(() => { interruptedUnregisteredCleanups.set(operationId, cleanup); });
    }
    throw error;
  }
}

/** 按原备份回执解包到隔离目录；不会覆盖当前项目或使用新的来源代替原备份。 */
export async function openNativeUpdateBackup(projectId: string, backup: NativeUpdateBackup): Promise<{
  source: ValidatedProjectArchiveV4; directory: string;
}> {
  await verifyNativeUpdateBackup(projectId, backup);
  const base = await files.getBaseDir(); if (!base) throw new Error('备份目录不可用');
  const archivePath = files.joinPath(base, `native-project-${backup.operationId}.aicanvas`);
  const directory = files.joinPath(base, `native-recovery-preview-${crypto.randomUUID()}`);
  await mkdir(directory);
  try {
    const unpacked = await invoke<{ texts: Record<string, string>; assets: ArchiveAssetDigest[] }>('unpack_project_archive', { archivePath, assetsDir: directory });
    const source = await readProjectModelArchive(unpacked.texts, unpacked.assets);
    await verifyNativeUpdateBackup(projectId, backup);
    return { source, directory };
  } catch (error) {
    await remove(directory, { recursive: true }).catch(() => {});
    throw error;
  }
}

/** 固定根经原生项目身份解析；不能将 Renderer 字符串作为任意文件授权。 */
async function nativeRecoveryRoot(projectId: string, rootRef: string, primaryRoot: string): Promise<string> {
  return rootRef === primaryRoot ? invoke<string>('resolve_native_project_media_root', { projectId })
    : invoke<string>('resolve_native_project_media_subroot', { projectId, rootRef, create: false });
}

/** 只有根、路径、大小及摘要的唯一读回匹配才允许复用。 */
export function selectReusableNativeRestoreAssets(
  originals: NonNullable<NativeContentRecoveryPoint['oldAssets']>,
  observed: NonNullable<NativeContentRecoveryPoint['oldAssets']>,
): NonNullable<NativeContentRecoveryPoint['oldAssets']> {
  return originals.filter((original) => {
    const matches = observed.filter((item) => item.rootRef === original.rootRef && item.path === original.path);
    return matches.length === 1 && matches[0].bytes === original.bytes && matches[0].sha256 === original.sha256;
  });
}

/** 原文件缺失或内容变化时，用备份原字节发布到新的不可覆盖位置。 */
export async function withNativeRestorePoint<T>(projectId: string, point: NativeContentRecoveryPoint, expected: ProjectModelTransferCapture,
  restore: (input: { source: ValidatedProjectArchiveV4; directory: string; prepared: Awaited<ReturnType<typeof prepareProjectModelArchiveCapture>>;
    reusableAssets: NonNullable<NativeContentRecoveryPoint['oldAssets']> }) => Promise<T>): Promise<T> {
  if (!point.backup || !point.exchange || !point.oldAssets || !point.editorRecords) throw new Error('恢复点缺少独立备份或原始材料');
  const { source, directory } = await openNativeUpdateBackup(projectId, point.backup);
  try {
    const archivedRetired = new Set((source.payload.videoEditor?.retiredRecords ?? []).map((record) => record.projectId));
    const historical = (expected.retiredEditorRecords ?? []).filter((record) => {
      const logical = point.exchange!.identities.find((item) => item.kind === 'canvas' && item.localId === record.projectId)?.sourceId ?? record.projectId;
      return archivedRetired.has(logical);
    });
    const capture: ProjectModelTransferCapture = { ...expected, aggregate: point.aggregate, exchange: point.exchange,
      editorRecords: point.editorRecords, retiredEditorRecords: historical, history: [], historyBindings: [], includesHistory: false,
      assetMetadata: point.assetSnapshots };
    const roots = new Map<string, string>();
    for (const binding of point.aggregate.project.storageBindings) roots.set(binding.rootRef,
      await nativeRecoveryRoot(projectId, binding.rootRef, point.aggregate.project.storageRootRef));
    // 只从持久恢复点重建原素材描述；内容再与已核验的备份快照逐字段比较。
    const assets: ProjectModelArchiveAsset[] = point.oldAssets.map((item) => {
      const root = roots.get(item.rootRef); if (!root) throw new Error('恢复素材根不可用');
      return { ...item, localAbsolutePath: files.joinPath(root, item.path) };
    });
    const prepared = await prepareProjectModelArchiveCapture(capture, assets, source.snapshot.media, 'snapshot');
    if (!configValuesEqual(prepared.snapshot.entities, source.snapshot.entities)
      || !configValuesEqual(prepared.snapshot.media, source.snapshot.media)
      || !configValuesEqual(prepared.payload.assetMetadata, source.payload.assetMetadata)
      || !configValuesEqual(prepared.payload.videoEditor, source.payload.videoEditor)) {
      throw new Error('恢复点原始内容或素材与独立备份不一致，未替换当前作品');
    }
    const observed: NonNullable<NativeContentRecoveryPoint['oldAssets']> = [];
    for (const [rootRef, root] of roots) {
      const selected = point.oldAssets.filter((item) => item.rootRef === rootRef);
      if (!selected.length) continue;
      const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', {
        assetsDir: root, selectedPaths: selected.map((item) => item.path),
      });
      observed.push(...actual.map((item) => ({ ...item, rootRef })));
    }
    await verifyNativeUpdateBackup(projectId, point.backup);
    return await restore({ source, directory, prepared, reusableAssets: selectReusableNativeRestoreAssets(point.oldAssets, observed) });
  } finally {
    // 这里只清理本次解包，已登记恢复从独立的 native-update 来源续接。
    const base = await files.getBaseDir().catch(() => undefined);
    const name = directory.split(/[\\/]/).at(-1);
    if (base && name && files.joinPath(base, name) === directory) {
      await cleanupVerifiedArchiveSource(base, name, source.assets).catch(() => undefined);
    }
  }
}

/** 续接时不重新展开备份；验证原备份与恢复点文件仍可用。 */
export async function verifyNativeRestoreAssets(projectId: string, point: NativeContentRecoveryPoint, expected: ProjectModelTransferCapture,
  reused: NonNullable<NativeContentRecoveryPoint['oldAssets']> = point.oldAssets ?? []): Promise<void> {
  if (!point.backup || !point.exchange || !point.oldAssets || !point.editorRecords) throw new Error('恢复点缺少原始材料');
  await verifyNativeUpdateBackup(projectId, point.backup);
  if (reused.some((item) => !point.oldAssets!.some((old) => configValuesEqual(old, item))
    || !point.aggregate.project.storageBindings.some((binding) => binding.rootRef === item.rootRef))) throw new Error('恢复素材不属于原恢复点');
  for (const binding of point.aggregate.project.storageBindings) {
    const selected = reused.filter((item) => item.rootRef === binding.rootRef); if (!selected.length) continue;
    const root = await nativeRecoveryRoot(projectId, binding.rootRef, point.aggregate.project.storageRootRef);
    const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: root, selectedPaths: selected.map((item) => item.path) });
    if (selected.some((item) => !actual.some((found) => found.path === item.path && found.bytes === item.bytes && found.sha256 === item.sha256))) {
      throw new Error('复用的恢复素材缺失或变化，原操作已保留');
    }
  }
  void expected;
}
