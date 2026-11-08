/** 提交新项目更新前的权威读回；journal 的字符串或布尔值不构成文件证明。 */
import type { NativeProjectUpdateJournal } from './indexedDb/nativeProjectRepository';
import type { ProjectModelTransferImportJournal } from '../types/projectModelTransfer';
import { remove } from '@tauri-apps/plugin-fs';
import { configValuesEqual } from './configPatch';
import { captureNativeProjectArchive, verifyNativeGlobalRecoverySources } from './nativeProjectArchiveService';
import { applyNativeGlobalRecoveryFiles } from './nativeProjectAssetRecovery';
import { createBoundProjectModelArchiveExportPort, createBoundProjectModelArchiveImportPort } from './projectModelArchiveNativePort';
import { listNativeContentRecoveryPoints } from './indexedDb/nativeProjectRepository';
import { nativeUpdateInventory, openNativeUpdateBackup, verifyNativeRestoreAssets, verifyNativeUpdateBackup } from './nativeProjectUpdateMedia';
import { prepareProjectModelArchiveCapture } from './projectModelArchiveService';
import { verifyNativeMissingAssetBackups } from './nativeMissingAssetBackup';

/** 不能由 caller 提交回执代替；重新读取原生备份、原材料及已发布的目标文件。 */
export async function verifyNativeProjectUpdateCommit(operation: NativeProjectUpdateJournal): Promise<void> {
  if (operation.phase !== 'media_ready' || !operation.sourceRef || !operation.mediaPublicationRef) {
    throw new Error('更新缺少可核验的原生媒体发布材料');
  }
  await verifyNativeUpdateBackup(operation.projectId, operation.backup);
  const current = await captureNativeProjectArchive(operation.projectId);
  if (current.value.sourceToken !== operation.expected.sourceToken || current.changeRevision !== operation.expected.sessionRevision) {
    throw new Error('项目或历史在更新期间变化，原操作已保留');
  }
  const missing = operation.recoveryState?.missingFiles ?? [];
  if (missing.length) await verifyNativeMissingAssetBackups(operation.expected, await listNativeContentRecoveryPoints(operation.projectId), missing, operation.operationId);
  const currentOnly = operation.recoveryState?.currentFilesOnly ?? false;
  const read = missing.length || currentOnly ? createBoundProjectModelArchiveExportPort(operation.projectId, '', missing, currentOnly) : createBoundProjectModelArchiveExportPort(operation.projectId, '');
  const globals = operation.recoveryState?.globalFiles ?? [];
  if (globals.length) await verifyNativeGlobalRecoverySources(operation.expected, globals);
  const inspected = await read.inspectAssets(applyNativeGlobalRecoveryFiles(operation.expected, globals));
  const assets = nativeUpdateInventory(inspected);
  if (!configValuesEqual(assets, operation.oldAssets)) throw new Error('项目素材在更新期间变化，原操作已保留');
  // 回执只证明文件存在，不能证明其内容是原项目；必须从独立包读回并比较冻结的可移植投影。
  const recovery = operation.recoveryState?.capture ?? operation.expected;
  const frozenAssets = operation.recoveryState ? await read.inspectAssets(recovery) : inspected;
  if (operation.recoveryState && !configValuesEqual(nativeUpdateInventory(frozenAssets), operation.recoveryState.assets)) throw new Error('恢复副本素材在更新前发生变化');
  const projected = await prepareProjectModelArchiveCapture(recovery, frozenAssets);
  const backup = await openNativeUpdateBackup(operation.projectId, operation.backup);
  try {
    if (!configValuesEqual(backup.source.snapshot, projected.snapshot)
      || !configValuesEqual(backup.source.payload.videoEditor, projected.payload.videoEditor)
      || !configValuesEqual(backup.source.payload.assetMetadata, projected.payload.assetMetadata)
      || !configValuesEqual(backup.source.payload.history, projected.payload.history)) {
      throw new Error('独立备份与更新前项目内容不一致');
    }
  } finally {
    // 只清理本次解包创建的独立随机目录，原备份和操作材料保留。
    await remove(backup.directory, { recursive: true }).catch(() => {});
  }
  if (operation.mode === 'restore-content') {
    const point = (await listNativeContentRecoveryPoints(operation.projectId)).find((item) => item.operationId === operation.restoreRecoveryId);
    if (!point || !operation.restoreAssets) throw new Error('原恢复点已变化，未恢复项目');
    await verifyNativeRestoreAssets(operation.projectId, point, operation.expected, operation.restoreAssets);
  }
  const port = createBoundProjectModelArchiveImportPort(operation.projectId, operation.sourceRef);
  await port.verifyMediaPublication(operation as ProjectModelTransferImportJournal, operation.mediaPublicationRef);
}
