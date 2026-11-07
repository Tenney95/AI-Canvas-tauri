/** P1 只读准备与恢复范围：只编写回归，不在实现阶段执行真实迁移。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ operations: new Map<string, Map<string, Uint8Array>>() }));

vi.mock('../../src/services/fileService', () => ({
  createProjectModelBackupPort: vi.fn(async (operationId: string) => {
    if (memory.operations.has(operationId)) throw new Error('existing operation');
    const files = new Map<string, Uint8Array>(); memory.operations.set(operationId, files);
    const write = async (path: string, bytes: Uint8Array) => {
      if (files.has(path)) throw new Error('existing file');
      files.set(path, Uint8Array.from(bytes));
    };
    return { writeExclusive: write, publishComplete: write,
      read: async (path: string, maxBytes: number) => {
        const value = files.get(path); if (!value || value.byteLength > maxBytes) throw new Error('unreadable');
        return Uint8Array.from(value);
      } };
  }),
  openProjectModelBackupPort: vi.fn(async (operationId: string) => {
    const files = memory.operations.get(operationId); if (!files) throw new Error('missing backup');
    return { writeExclusive: async () => { throw new Error('read only'); },
      publishComplete: async () => { throw new Error('read only'); },
      read: async (path: string, maxBytes: number) => {
        const value = files.get(path); if (!value || value.byteLength > maxBytes) throw new Error('unreadable');
        return Uint8Array.from(value);
      } };
  }),
}));

import {
  inspectProjectModelBackup, prepareProjectModelBackup, prepareProjectModelRestore,
  PROJECT_MODEL_PREPARATION_CAPABILITIES,
} from '../../src/services/projectModelMigration';

let database: IDBDatabase | undefined;
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('localStorage', { getItem: () => '[]' }); memory.operations.clear();
});
afterEach(() => { database?.close(); database = undefined; vi.unstubAllGlobals(); });

async function setup(records: unknown[]) {
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ai-canvas-db', 27);
    request.onupgradeneeded = () => {
      for (const name of ['projects', 'metadata', 'agentTasks']) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = database!.transaction('projects', 'readwrite');
    for (const record of records) tx.objectStore('projects').put(record);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
const project = (id: string) => ({ id, name: '旧项目', createdAt: 1, updatedAt: 2,
  nodes: [{ id: 'node-1', data: { type: 'source-text', text: '保留中文' } }], edges: [] });

describe('项目模型 P1 准备', () => {
  it('读回完整备份但不授予激活/恢复权限，也不提升数据库版本', async () => {
    await setup([project('p')]);
    const report = await prepareProjectModelBackup({ operationId: 'backup-one' });
    expect(report).toMatchObject({ status: 'backed-up', projectIds: ['p'], canActivate: false, quiescence: 'not-established' });
    const backup = await inspectProjectModelBackup('backup-one');
    expect(backup.source.stores.find((row) => row.name === 'projects')?.records[0].value).toEqual(project('p'));
    expect(database!.version).toBe(27); expect(Array.from(database!.objectStoreNames)).toEqual(['agentTasks', 'metadata', 'projects']);
    expect(PROJECT_MODEL_PREPARATION_CAPABILITIES).toMatchObject({ activation: false, restoreWrites: false, nativeArchiveV4: false });
  });

  it('坏画布仍备份原始数据，不能伪造空画布或宣称可以迁移', async () => {
    await setup([{ ...project('p'), nodes: null }]);
    const report = await prepareProjectModelBackup({ operationId: 'backup-broken' });
    expect(report.quarantinedRecordIds).toEqual(['p']); expect(report.projectIds).toEqual([]);
    const backup = await inspectProjectModelBackup('backup-broken');
    expect(backup.source.stores.find((row) => row.name === 'projects')?.records[0].value).toMatchObject({ nodes: null });
  });

  it('局部恢复准备保留其他项目与迁移后提交事实，不写回旧任务', async () => {
    await setup([project('p'), project('q')]);
    await prepareProjectModelBackup({ operationId: 'before-new-task' });
    const task = { id: 'new-paid-task', projectId: 'p', budget: { toolCalls: 9 }, mcpOperation: { phase: 'submitted', sequence: 5 } };
    await new Promise<void>((resolve, reject) => {
      const tx = database!.transaction('agentTasks', 'readwrite'); tx.objectStore('agentTasks').put(task);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    const plan = await prepareProjectModelRestore({ operationId: 'before-new-task', scope: { kind: 'project', projectId: 'p' } });
    expect(plan).toMatchObject({ status: 'prepared-readonly', canApply: false, sourceProjectIds: ['p'],
      unaffectedProjectIds: ['q'], pendingTaskPolicy: 'preserve-current-and-reconcile', requiresPreRestoreBackup: true });
    expect(plan.retainedAudit).toContainEqual({ store: 'agentTasks', currentRecordCount: 1, policy: 'preserve-current-and-reconcile' });
    const persisted = await new Promise<unknown>((resolve) => {
      const request = database!.transaction('agentTasks').objectStore('agentTasks').get(task.id);
      request.onsuccess = () => resolve(request.result);
    });
    expect(persisted).toEqual(task);
  });

  it('未知 metadata 阻断完成状态，且不创建恢复目录', async () => {
    await setup([project('p')]);
    await new Promise<void>((resolve) => {
      const tx = database!.transaction('metadata', 'readwrite'); tx.objectStore('metadata').put({ id: 'future-project-state', value: 1 });
      tx.oncomplete = () => resolve();
    });
    await expect(prepareProjectModelBackup({ operationId: 'must-not-exist' })).rejects.toMatchObject({ code: 'incomplete-source' });
    expect(memory.operations.size).toBe(0);
  });

  it('完成标记缺失或已取消时不能作为已验证备份使用', async () => {
    await setup([project('p')]); await prepareProjectModelBackup({ operationId: 'interrupted' });
    memory.operations.get('interrupted')!.delete('complete.json');
    await expect(inspectProjectModelBackup('interrupted')).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(prepareProjectModelBackup({ operationId: 'cancelled', signal: controller.signal })).rejects.toThrow();
    expect(memory.operations.has('cancelled')).toBe(false);
  });
});
