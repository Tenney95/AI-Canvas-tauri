/** 仅为已证明版本的缺失文件创建备份来源；不修补或覆盖当前项目原路径。 */
import { invoke } from '@tauri-apps/api/core';
import { lstat } from '@tauri-apps/plugin-fs';
import type { ProjectModelTransferCapture } from '../types/projectModelTransfer';
import type { ValidatedProjectArchiveV4 } from '../types/projectArchiveV4';
import type { NativeContentRecoveryPoint } from './indexedDb/nativeProjectRepository';
import { readProjectArchiveV4Files } from './projectArchiveV4';
import { safeExchangePath } from './projectExchangeDomain';
import { configValuesEqual } from './configPatch';

export interface NativeMissingAssetProof {
  rootRef: string; path: string; copyPath: string; fileId: string; logicalRoot: string; logicalPath: string;
  bytes: number; sha256: string; sourceRecoveryId: string;
  sourceBackup: { operationId: string; outputRef: string; packageDigest: string };
}
export const isNativeFileNotFound = (error: unknown) => /\bENOENT\b|\bos error [23]\b|no such file|path not found|file not found|找不到指定的(?:文件|路径)/i.test(String(error));
export async function assertNativeFileMissing(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if (isNativeFileNotFound(error)) return; throw error; }
  throw new Error('原缺失文件已重新出现，请重新核对恢复操作');
}
export async function nativeMissingAssetRoot(capture: ProjectModelTransferCapture, rootRef: string): Promise<string> {
  if (!capture.aggregate.project.storageBindings.some((root) => root.rootRef === rootRef)) throw new Error('缺失素材根不属于当前项目');
  return rootRef === capture.aggregate.project.storageRootRef
    ? invoke<string>('resolve_native_project_media_root', { projectId: capture.aggregate.project.id })
    : invoke<string>('resolve_native_project_media_subroot', { projectId: capture.aggregate.project.id, rootRef, create: false });
}

export function validateNativeMissingAssetProof(expected: ProjectModelTransferCapture, point: NativeContentRecoveryPoint,
  proof: NativeMissingAssetProof, operationId: string): void {
  const fields = ['rootRef', 'path', 'copyPath', 'fileId', 'logicalRoot', 'logicalPath', 'bytes', 'sha256', 'sourceRecoveryId', 'sourceBackup'];
  if (!proof || ![Object.prototype, null].includes(Object.getPrototypeOf(proof)) || Object.keys(proof).some((field) => !fields.includes(field))
    || !proof.sourceBackup || Object.keys(proof.sourceBackup).some((field) => !['operationId', 'outputRef', 'packageDigest'].includes(field))
    || !Number.isSafeInteger(proof.bytes) || proof.bytes < 0 || !/^[a-f0-9]{64}$/.test(proof.sha256)
    || !/^r2-[a-f0-9-]{36}$/.test(proof.rootRef) || !proof.fileId || proof.fileId.length > 256
    || typeof proof.logicalPath !== 'string' || safeExchangePath(proof.logicalPath) !== proof.logicalPath
    || !new RegExp(`^imports/missing-backup-${operationId}/copy-${proof.sha256}\\.[a-z0-9]{1,16}$`).test(proof.copyPath)) throw new Error('缺失素材备份字段无效');
  const exchange = expected.exchange, head = exchange?.bundle.revisions.find((revision) => revision.canonicalVersion === exchange.localHead.canonicalVersion && revision.revisionId === exchange.localHead.revisionId);
  const source = point.exchange?.bundle.revisions.find((revision) => revision.canonicalVersion === point.exchange!.localHead.canonicalVersion && revision.revisionId === point.exchange!.localHead.revisionId);
  if (!head || head.canonicalVersion !== 2 || !source || source.canonicalVersion !== 2 || !point.backup
    || point.projectId !== expected.aggregate.project.id || proof.sourceRecoveryId !== point.operationId || !configValuesEqual(proof.sourceBackup, point.backup)
    || safeExchangePath(proof.path) !== proof.path || safeExchangePath(proof.copyPath) !== proof.copyPath
    || !proof.copyPath.startsWith(`imports/missing-backup-${operationId}/`) || proof.copyPath === proof.path) throw new Error('缺失素材备份证明无效');
  const identity = exchange!.identities.filter((item) => item.kind === 'storage-root' && item.localId === proof.rootRef && item.sourceId === proof.logicalRoot);
  const binding = exchange!.fileBindings.filter((item) => item.id === proof.fileId && item.rootRef === proof.logicalRoot
    && item.relativePath === proof.logicalPath && item.localRelativePath === proof.path);
  const file = readProjectArchiveV4Files(head.snapshot).find((item) => item.id === proof.fileId && item.rootRef === proof.logicalRoot && item.relativePath === proof.logicalPath);
  const original = readProjectArchiveV4Files(source.snapshot).find((item) => item.id === proof.fileId && item.rootRef === proof.logicalRoot && item.relativePath === proof.logicalPath);
  const currentMedia = head.snapshot.media.find((item) => item.id === file?.mediaId), originalMedia = source.snapshot.media.find((item) => item.id === original?.mediaId);
  if (identity.length !== 1 || binding.length !== 1 || !currentMedia || !originalMedia || currentMedia.bytes !== proof.bytes
    || currentMedia.sha256 !== proof.sha256 || originalMedia.bytes !== proof.bytes || originalMedia.sha256 !== proof.sha256
    || expected.assetMetadata?.some((asset) => asset.rootRef === proof.rootRef && asset.path === proof.path
      && (asset.bytes !== proof.bytes || asset.sha256 !== proof.sha256))) throw new Error('当前文件版本与所选恢复备份不一致，不能猜测缺失字节');
}

export async function prepareNativeMissingAssetBackup(expected: ProjectModelTransferCapture, point: NativeContentRecoveryPoint,
  source: ValidatedProjectArchiveV4, directory: string, operationId: string): Promise<NativeMissingAssetProof[]> {
  const exchange = expected.exchange, head = exchange?.bundle.revisions.find((revision) => revision.canonicalVersion === exchange.localHead.canonicalVersion && revision.revisionId === exchange.localHead.revisionId);
  if (!head || head.canonicalVersion !== 2 || !point.backup) return [];
  const directories = new Map<string, string>();
  const primary = await nativeMissingAssetRoot(expected, expected.aggregate.project.storageRootRef);
  for (const root of expected.aggregate.project.storageBindings) directories.set(root.rootRef, root.rootRef === expected.aggregate.project.storageRootRef
    ? primary : `${primary.replace(/[\\/]+$/, '')}/roots/${root.rootRef}`);
  const { currentStoragePaths } = await import('./projectModelArchiveNativePort');
  const currentPaths = currentStoragePaths(expected, directories);
  const proofs: NativeMissingAssetProof[] = [];
  const batches = new Map<string, { root: string; assets: Array<{ path: string; destinationPath: string; bytes: number; sha256: string }> }>();
  for (const file of readProjectArchiveV4Files(head.snapshot)) {
    const root = exchange!.identities.find((identity) => identity.kind === 'storage-root' && identity.sourceId === file.rootRef)?.localId;
    const binding = exchange!.fileBindings.find((item) => item.id === file.id && item.rootRef === file.rootRef && item.relativePath === file.relativePath);
    if (!root || !binding) throw new Error('当前文件缺少权威身份，无法准备缺失状态备份');
    if (!currentPaths.get(root)?.has(binding.localRelativePath)) continue;
    let batch = batches.get(root);
    if (!batch) { batch = { root: await nativeMissingAssetRoot(expected, root), assets: [] }; batches.set(root, batch); }
    const originalPath = `${batch.root.replace(/[\\/]+$/, '')}/${safeExchangePath(binding.localRelativePath)}`;
    try { await lstat(originalPath); continue; } catch (error) { if (!isNativeFileNotFound(error)) throw error; }
    const media = head.snapshot.media.find((item) => item.id === file.mediaId);
    const sourceFile = source.files.find((item) => item.id === file.id && item.rootRef === file.rootRef && item.relativePath === file.relativePath);
    const sourceMedia = source.snapshot.media.find((item) => item.id === sourceFile?.mediaId);
    const archive = source.payload.exchange.files.find((item) => item.mediaId === sourceFile?.mediaId)?.archivePath;
    if (!media || !sourceMedia || !archive?.startsWith('assets/') || media.sha256 !== sourceMedia.sha256 || media.bytes !== sourceMedia.bytes) throw new Error('当前缺失文件没有相同版本的备份字节');
    const extension = media.extension, destinationPath = `copy-${media.sha256}.${extension}`;
    const proof: NativeMissingAssetProof = { rootRef: root, path: safeExchangePath(binding.localRelativePath), copyPath: `imports/missing-backup-${operationId}/${destinationPath}`,
      fileId: file.id, logicalRoot: file.rootRef, logicalPath: file.relativePath, bytes: media.bytes, sha256: media.sha256,
      sourceRecoveryId: point.operationId, sourceBackup: point.backup };
    validateNativeMissingAssetProof(expected, point, proof, operationId); proofs.push(proof);
    if (!batch.assets.some((asset) => asset.destinationPath === destinationPath)) batch.assets.push({ path: safeExchangePath(archive.slice(7)), destinationPath, bytes: media.bytes, sha256: media.sha256 });
  }
  for (const batch of batches.values()) if (batch.assets.length) {
    try { await invoke('publish_project_import_assets', { stagingDir: directory, projectDir: batch.root, operationId: `missing-backup-${operationId}`, assets: batch.assets }); }
    catch { /* 仅按冻结清单读回原发布；既有内容不覆盖。 */ }
    const expectedFiles = batch.assets.map((asset) => ({ ...asset, path: `imports/missing-backup-${operationId}/${asset.destinationPath}` }));
    const actual = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', { assetsDir: batch.root, selectedPaths: expectedFiles.map((asset) => asset.path) });
    if (actual.length !== expectedFiles.length || expectedFiles.some((asset) => !actual.some((item) => item.path === asset.path && item.bytes === asset.bytes && item.sha256 === asset.sha256))) throw new Error('缺失状态的备份副本没有完整发布，原路径保留');
  }
  return proofs;
}

export async function verifyNativeMissingAssetBackups(expected: ProjectModelTransferCapture, points: readonly NativeContentRecoveryPoint[],
  proofs: readonly NativeMissingAssetProof[], operationId: string): Promise<void> {
  for (const proof of proofs) {
    const point = points.find((item) => item.operationId === proof.sourceRecoveryId);
    if (!point) throw new Error('缺失状态的来源恢复点不再存在');
    validateNativeMissingAssetProof(expected, point, proof, operationId);
    const root = await nativeMissingAssetRoot(expected, proof.rootRef);
    await assertNativeFileMissing(`${root.replace(/[\\/]+$/, '')}/${proof.path}`);
    const copies = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', { assetsDir: root, selectedPaths: [proof.copyPath] });
    if (copies.length !== 1 || copies[0].path !== proof.copyPath || copies[0].bytes !== proof.bytes || copies[0].sha256 !== proof.sha256) throw new Error('缺失状态的备份副本损坏，原操作保留');
  }
}
