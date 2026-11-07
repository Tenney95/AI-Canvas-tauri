/** 原操作恢复只复用首次冻结材料；不重读原包、不重合并、不分配新身份。 */
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import * as files from './fileService';
import { advanceProjectImportOperation, commitProjectImport, digestProjectImportSourceRecords, readProjectImportOperation, readProjectImportScope,
  type LegacyProjectImportOperation } from './indexedDb/projectImportRepository';
import { openDB } from './indexedDb/schema';
import { assertLegacyProjectWritesAllowed } from './indexedDb/legacyProjectWriteGuard';
import { safeExchangePath, type ArchiveAssetDigest } from './projectExchangeDomain';
import { throwProjectImportCommitFailure } from './projectImportOutcome';
import { withEpisodeEditorWrite } from './episodeEditorSessionService';
import { configValuesEqual } from './configPatch';

const applied = (phase: string) => ['committed', 'db_committed', 'projected', 'finalized'].includes(phase);
async function original(operationId: string): Promise<LegacyProjectImportOperation> {
  const value = await readProjectImportOperation(operationId);
  if (!value) throw new Error('原导入操作记录不可用，已保留材料');
  return value;
}
export async function verifyPreparedProjectImportMedia(directory: string, required: ArchiveAssetDigest[]): Promise<void> {
  const expected = new Map<string, ArchiveAssetDigest>();
  for (const asset of required) {
    const path = safeExchangePath(asset.path), previous = expected.get(path);
    if (previous && (previous.bytes !== asset.bytes || previous.sha256 !== asset.sha256)) throw new Error('原操作媒体清单有歧义，未继续恢复');
    expected.set(path, asset);
  }
  if (!expected.size) return;
  const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: directory, selectedPaths: [...expected.keys()] });
  if (actual.length !== expected.size || [...expected].some(([path, asset]) => {
    const value = actual.find((entry) => entry.path === path); return !value || value.bytes !== asset.bytes || value.sha256 !== asset.sha256;
  })) throw new Error('原操作媒体缺失或摘要变化，已保留材料，未重新发布或提交');
}
async function continueOriginal(operation: LegacyProjectImportOperation, signal?: AbortSignal) {
  const prepared = operation.prepared;
  if (!applied(operation.phase)) {
    if (!prepared || prepared.version !== 1) throw new Error('原操作尚未冻结可恢复材料；已保留暂存，不能重解包、重合并或推断未提交');
    if (!Array.isArray(prepared.sourceRecordDigests)) throw new Error('原操作缺少精确CAS源证明，不能自动恢复');
    if (!prepared.media.verified) throw new Error('原操作缺少已核验的媒体清单；已保留材料，不能自动恢复');
    files.registerProjectFolder(operation.ownerId, safeExchangePath(prepared.media.targetFolder));
    const directory = await files.ensureProjectDataDir(operation.ownerId);
    if (!directory) throw new Error('无法定位原操作目标素材目录');
    if (operation.phase === 'prepared') {
      await advanceProjectImportOperation(operation.operationId, 'media_publishing');
      operation = await original(operation.operationId);
    }
    if (operation.phase === 'media_publishing') {
      if (prepared.media.mode === 'publish' && prepared.media.assets.length) {
        const destination = files.joinPath(directory, 'imports', operation.operationId);
        if (!(await exists(destination))) {
          if (!operation.stagingProjectId || !operation.stagingFolder) throw new Error('原操作未保留暂存引用，不能重新发布');
          files.registerProjectFolder(operation.stagingProjectId, safeExchangePath(operation.stagingFolder));
          const stagingDir = await files.getProjectDataDir(operation.stagingProjectId);
          if (!stagingDir || !(await exists(stagingDir))) throw new Error('原操作暂存来源缺失，未重新发布');
          signal?.throwIfAborted();
          await invoke('publish_project_import_assets', { stagingDir, projectDir: directory,
            operationId: operation.operationId, assets: prepared.media.assets });
        }
      }
      await verifyPreparedProjectImportMedia(directory, prepared.media.required);
      signal?.throwIfAborted();
      await advanceProjectImportOperation(operation.operationId, 'media_ready');
      operation = await original(operation.operationId);
    }
    if (!applied(operation.phase)) {
      if (operation.phase !== 'media_ready') throw new Error('原操作阶段无法继续；已保留材料，未重新合并');
      await verifyPreparedProjectImportMedia(directory, prepared.media.required);
      signal?.throwIfAborted();
      const expectedRecords = prepared.sourceRecordDigests.length ? await readProjectImportScope(operation.ownerId) : [];
      if (!configValuesEqual(await digestProjectImportSourceRecords(expectedRecords), prepared.sourceRecordDigests)) {
        throw new Error('原操作CAS源已变化，已保留冻结材料，不能重新合并后继续');
      }
      let committed = false;
      try {
        await commitProjectImport({ ...prepared.commit, expectedRecords, signal }); committed = true;
        operation = await original(operation.operationId);
      } catch (error) {
        return throwProjectImportCommitFailure(error, operation.operationId, operation.ownerId, committed,
          () => readProjectImportOperation(operation.operationId));
      }
    }
  }
  // 已提交读取此刻的数据库，不拿 journal 的旧 next 覆盖后来编辑。
  try {
    const records = await readProjectImportScope(operation.ownerId);
    files.registerProjectFolders(records); files.notifyProjectDiskChanged();
    if (operation.phase === 'db_committed') await advanceProjectImportOperation(operation.operationId, 'projected');
    const current = await readProjectImportOperation(operation.operationId);
    if (current?.phase === 'projected') await advanceProjectImportOperation(operation.operationId, 'finalized');
    return { status: 'committed' as const, operationId: operation.operationId, ownerId: operation.ownerId, records };
  } catch (error) {
    return throwProjectImportCommitFailure(error, operation.operationId, operation.ownerId, true,
      () => readProjectImportOperation(operation.operationId));
  }
}

const resumes = new Map<string, ReturnType<typeof continueOriginal>>();
async function resumeOriginal(operationId: string, options: { signal?: AbortSignal }) {
  options.signal?.throwIfAborted();
  await assertLegacyProjectWritesAllowed(await openDB());
  const operation = await readProjectImportOperation(operationId);
  if (!operation) throw new Error('原导入操作不存在，不能推断未提交或重新导入');
  const ids = [...new Set([operation.ownerId, ...(operation.prepared?.commit.records.map((record) => record.id) ?? [])])].sort();
  const lock = (index: number): ReturnType<typeof continueOriginal> => index === ids.length
    ? original(operationId).then((current) => continueOriginal(current, options.signal)) : withEpisodeEditorWrite(ids[index], () => lock(index + 1));
  return lock(0);
}
export function resumeProjectImportOperation(operationId: string, options: { signal?: AbortSignal } = {}) {
  const existing = resumes.get(operationId); if (existing) return existing;
  const result = resumeOriginal(operationId, options); resumes.set(operationId, result);
  const cleanup = () => { if (resumes.get(operationId) === result) resumes.delete(operationId); };
  void result.then(cleanup, cleanup);
  return result;
}
