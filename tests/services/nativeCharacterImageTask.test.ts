import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoPendingNativeMediaTasks, createNativeProject, EXCHANGE, openNativeProjectDatabase, transact, TRANSFER,
} from '../../src/services/indexedDb/nativeProjectRepository';
import {
  listNativeCharacterImageTasks, listPendingNativeCharacterImageTasks, readNativeCharacterImageTask, reviewNativeCharacterImageTask,
} from '../../src/services/nativeCharacterImageTask';

const files = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/services/fileService', () => ({
  getProjectDataDir: async () => '/work', getAssetUrlFromPath: async (path: string) => `asset:${path}`,
  isTauriEnv: () => true, joinPath: (...segments: string[]) => segments.join('/'),
}));
vi.mock('../../src/services/fs/characterVisualFiles', () => ({ saveCharacterVisualResult: vi.fn() }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: files.read, captureNativeMediaLocalResult: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('crypto', webcrypto);
  files.read.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const { project } = await createNativeProject({ name: '回执验收' });
  const operationId = crypto.randomUUID();
  const sha256 = 'a'.repeat(64);
  const receipt = {
    projectId: `character-image-task:${project.id}:${operationId}`,
    kind: 'native-character-image-v1', ownerProjectId: project.id, projectEpoch: project.epoch,
    resultRootRef: project.storageRootRef, characterId: 'removed-character', operationId,
    modelRef: 'general/image', providerConfigId: 'image-provider', requestFingerprint: 'b'.repeat(64),
    status: 'outcome-unknown', outputs: [{ index: 0, width: 640, height: 480, bytes: 123, sha256, relativePath: `media/${sha256}.png` }],
    revision: 0, createdAt: 1, updatedAt: 1,
  };
  const db = await openNativeProjectDatabase(false, {});
  if (!db) throw new Error('Missing fixture database');
  await transact(db, 'readwrite', {}, async (tx) => {
    const store = tx.objectStore(EXCHANGE);
    store.add(receipt);
    for (let index = 0; index < 51; index += 1) {
      const id = crypto.randomUUID();
      store.add({ ...receipt, operationId: id, projectId: `character-image-task:${project.id}:${id}`,
        status: 'completed', createdAt: index + 2, updatedAt: index + 2 });
    }
  }, [EXCHANGE]);
  return { project, receipt, db };
}

describe('角色图片任务恢复', () => {
  it('从作品列出超过历史上限且角色卡已不存在的原回执，按状态核对后解除作品更新阻塞', async () => {
    const { project, receipt, db } = await fixture();
    const check = () => transact(db, 'readonly', {}, (tx) => assertNoPendingNativeMediaTasks(tx, project.id), [EXCHANGE, TRANSFER]);
    try {
      await expect(check()).rejects.toThrow('project-media-task-pending');
      await expect(listPendingNativeCharacterImageTasks(project.id)).resolves.toMatchObject([
        { operationId: receipt.operationId, characterId: receipt.characterId, status: 'outcome-unknown' },
      ]);
      await expect(reviewNativeCharacterImageTask(project.id, 'other-role', receipt.operationId, () => {}, 'outcome-unknown')).rejects.toThrow();
      await expect(reviewNativeCharacterImageTask(project.id, receipt.characterId, receipt.operationId, () => {}, 'prepared')).rejects.toThrow();
      await reviewNativeCharacterImageTask(project.id, receipt.characterId, receipt.operationId, () => {}, 'outcome-unknown');
      await expect(check()).resolves.toBeUndefined();
      await expect(listNativeCharacterImageTasks(project.id, receipt.characterId, [receipt.operationId])).resolves.toMatchObject([
        { status: 'reviewed', outputIndexes: [0] },
      ]);
      expect(files.read).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('历史摘要不读图片，读取一个候选时才按摘要校验原文件', async () => {
    const { project, receipt, db } = await fixture();
    try {
      await expect(listNativeCharacterImageTasks(project.id, receipt.characterId, [receipt.operationId])).resolves.toMatchObject([{ outputIndexes: [0] }]);
      expect(files.read).not.toHaveBeenCalled();
      await expect(readNativeCharacterImageTask(project.id, receipt.characterId, receipt.operationId, 0)).resolves.toMatchObject({
        candidates: [{ relativePath: receipt.outputs[0].relativePath }],
      });
      expect(files.read).toHaveBeenCalledOnce();
      files.read.mockRejectedValueOnce(new Error('Digest changed'));
      await expect(readNativeCharacterImageTask(project.id, receipt.characterId, receipt.operationId, 0)).resolves.toMatchObject({ candidates: [] });
    } finally { db.close(); }
  });
});
