import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginVideoReplicaJobSummary } from '../../src/types/plugin';

const summary = (projectId = 'project-a', index = 1): PluginVideoReplicaJobSummary => ({
  jobId: `video-replica-${index}`, projectId, pluginId: 'video-replica', nodeId: 'source-video',
  sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), modelId: 'general/video-model',
  status: 'queued', stage: '等待全片复刻', totalSegments: 4, completedSegments: 0, progress: 0,
  createdAt: index, updatedAt: index, segmentNodeIds: [],
});

async function repository() { return import('../../src/services/plugins/pluginVideoReplicaJobRepository'); }
async function putMetadata(projectId: string, jobs: unknown): Promise<void> {
  const { openDB, STORE_METADATA } = await import('../../src/services/indexedDb/schema');
  const { pluginVideoReplicaJobsKey } = await repository();
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    tx.objectStore(STORE_METADATA).put({ id: pluginVideoReplicaJobsKey(projectId), jobs });
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
async function stored(projectId: string): Promise<{ jobs: Record<string, unknown>[] } | undefined> {
  const { openDB, STORE_METADATA } = await import('../../src/services/indexedDb/schema');
  const { pluginVideoReplicaJobsKey } = await repository();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly').objectStore(STORE_METADATA).get(pluginVideoReplicaJobsKey(projectId));
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });
  vi.resetModules();
});

describe('视频复刻摘要边界', () => {
  it('persists only whitelisted summary fields, never context, paths, secrets, grants or controllers', async () => {
    const { sanitizeReplicaJobSummary, savePluginVideoReplicaJob } = await repository();
    const raw = Object.assign(summary(), { filePath: 'D:/private/source.mp4', prompt: '完整原始要求',
      apiKey: 'sk-private-secret', grantId: 'grant-private', controller: new AbortController(),
      resourceReadContext: { grantPath: 'D:/private/grant' }, tool: undefined });
    expect(sanitizeReplicaJobSummary(raw)).toEqual(summary());
    await savePluginVideoReplicaJob(raw);
    const data = (await stored('project-a'))!;
    expect(data.jobs).toEqual([summary()]);
    expect(JSON.stringify(data)).not.toMatch(/filePath|private|prompt|apiKey|grantId|controller|resourceReadContext/);
  });
  it.each([
    { totalSegments: 0 }, { totalSegments: 65 }, { totalSegments: 1.5 },
    { completedSegments: -1 }, { completedSegments: 5 }, { completedSegments: 0.5 },
    { progress: NaN }, { progress: Infinity }, { progress: -0.01 }, { progress: 1.01 },
    { createdAt: -1 }, { createdAt: 0.5 }, { updatedAt: 0 }, { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    { sourceDigest: 'sha256-' + 'a'.repeat(64) }, { revisionDigest: 'b'.repeat(63) },
    { jobId: '/home/private' }, { projectId: 'D:/private' }, { pluginId: '../private' }, { nodeId: '' },
    { modelId: 'general/../private' }, { status: 'running' }, { status: { toString: (): string => 'queued' } },
    { stage: '' }, { stage: 'a'.repeat(241) }, { outputNodeId: '../private' }, { outputNodeId: 2 },
    { segmentNodeIds: ['node-1', 'node-1'] }, { segmentNodeIds: ['asset://node'] },
    { segmentNodeIds: ['1', '2', '3', '4', '5'] }, { error: 12 }, { warnings: 'warning' },
    { warnings: Array(9).fill('尚未生成') }, { warnings: ['正常', 'a'.repeat(241)] },
  ])('rejects malformed summaries atomically instead of truncating fields: %j', async (patch) => {
    const { sanitizeReplicaJobSummary, savePluginVideoReplicaJob } = await repository();
    const invalid = { ...summary(), ...patch };
    expect(sanitizeReplicaJobSummary(invalid)).toBeNull();
    await expect(savePluginVideoReplicaJob(invalid as PluginVideoReplicaJobSummary)).rejects.toThrow('摘要无效');
    expect(await stored('project-a')).toBeUndefined();
  });
  it.each([
    '读取 D:\\private\\source.mp4', '读取 D:/private/source.mp4', '读取 \\\\server\\share\\video.mp4',
    '读取 /Users/user/video.mp4', '读取/home/user/audio.wav', '/tmp/video.wav', '读取 /audio.wav', 'file:///private/video',
    'asset://private/video', 'https://host/video?token=secret', 'blob:private', 'data:audio/wav;base64,private',
    'apiKey=private', 'api_key=private', 'Bearer private', 'token private', 'provider_token=private',
    'secret private', 'grantId private', 'grant_id=private', 'resourceId private', 'sk-abcdefghijk', 'plugin-ref-opaque', 'plugin-resource-opaque', '控制\u0000字符',
  ])('refuses private references in stage, error and warnings: %s', async (text) => {
    const { sanitizeReplicaJobSummary } = await repository();
    for (const patch of [{ stage: text }, { error: text }, { warnings: [text] }]) {
      expect(sanitizeReplicaJobSummary({ ...summary(), ...patch })).toBeNull();
    }
  });
  it('keeps ordinary progress fractions and copies arrays instead of retaining caller references', async () => {
    const { sanitizeReplicaJobSummary } = await repository();
    const original = { ...summary(), stage: '正在生成第 1/4 段', progress: 0.25, segmentNodeIds: ['node-1'], warnings: ['按模型上限自动分段'] };
    const safe = sanitizeReplicaJobSummary(original)!;
    original.segmentNodeIds.push('node-2'); original.warnings.push('later');
    expect(safe.segmentNodeIds).toEqual(['node-1']); expect(safe.warnings).toEqual(['按模型上限自动分段']);
  });
});

describe('视频复刻项目任务存储', () => {
  it('serializes concurrent writes within one project, bounds history at 30 and isolates other projects', async () => {
    const { readPluginVideoReplicaJobs, savePluginVideoReplicaJob } = await repository();
    expect(await readPluginVideoReplicaJobs('project-a')).toEqual([]);
    await Promise.all([
      ...Array.from({ length: 32 }, (_, index) => savePluginVideoReplicaJob(summary('project-a', index))),
      savePluginVideoReplicaJob(summary('project-b', 90)),
    ]);
    const saved = await readPluginVideoReplicaJobs('project-a');
    expect(saved).toHaveLength(30);
    expect(saved.map((job) => job.jobId)).toEqual(Array.from({ length: 30 }, (_, index) => `video-replica-${index + 2}`));
    expect(await readPluginVideoReplicaJobs('project-b')).toEqual([summary('project-b', 90)]);
    const updated = { ...summary('project-a', 2), updatedAt: 99, stage: '完成准备' };
    await savePluginVideoReplicaJob(updated);
    const after = await readPluginVideoReplicaJobs('project-a');
    expect(after).toHaveLength(30); expect(after.at(-1)).toEqual(updated);
    expect(after.filter((job) => job.jobId === updated.jobId)).toHaveLength(1);
  });
  it('captures a queued write before callers mutate its identity or arrays', async () => {
    const { readPluginVideoReplicaJobs, savePluginVideoReplicaJob } = await repository();
    const original = { ...summary(), segmentNodeIds: ['node-1'], warnings: ['准备完成'] };
    const pending = savePluginVideoReplicaJob(original);
    original.projectId = 'project-b'; original.segmentNodeIds.push('node-2'); original.warnings.push('later');
    await pending;
    expect(await readPluginVideoReplicaJobs('project-a')).toEqual([{ ...summary(), segmentNodeIds: ['node-1'], warnings: ['准备完成'] }]);
    expect(await readPluginVideoReplicaJobs('project-b')).toEqual([]);
  });
  it('reads only valid same-project rows and never returns unsafe persisted text', async () => {
    const { readPluginVideoReplicaJobs } = await repository();
    await putMetadata('project-a', [summary(), summary('project-b', 2), { ...summary('project-a', 3), error: 'D:/private/token' }, null]);
    expect(await readPluginVideoReplicaJobs('project-a')).toEqual([summary()]);
  });
  it('fails closed for malformed storage containers or oversized history and invalid project IDs', async () => {
    const { readPluginVideoReplicaJobs } = await repository();
    await putMetadata('project-a', { injected: true });
    await expect(readPluginVideoReplicaJobs('project-a')).rejects.toThrow('记录异常');
    await putMetadata('project-a', Array.from({ length: 31 }, (_, index) => summary('project-a', index)));
    await expect(readPluginVideoReplicaJobs('project-a')).rejects.toThrow('记录异常');
    await expect(readPluginVideoReplicaJobs('/home/private')).rejects.toThrow('项目标识');
  });
  it('releases a failed write queue for later explicit writes without retrying the failed transaction', async () => {
    const { readPluginVideoReplicaJobs, savePluginVideoReplicaJob } = await repository();
    const { openDB } = await import('../../src/services/indexedDb/schema');
    const transaction = vi.spyOn(await openDB(), 'transaction');
    transaction.mockImplementationOnce(() => { throw new DOMException('fixture-private', 'QuotaExceededError'); });
    await expect(savePluginVideoReplicaJob(summary())).rejects.toHaveProperty('name', 'QuotaExceededError');
    expect(transaction).toHaveBeenCalledOnce();
    await savePluginVideoReplicaJob(summary('project-a', 2));
    expect(await readPluginVideoReplicaJobs('project-a')).toEqual([summary('project-a', 2)]);
    transaction.mockRestore();
  });
  it('removes the project queue through the existing project deletion transaction', async () => {
    const { readPluginVideoReplicaJobs, savePluginVideoReplicaJob } = await repository();
    await savePluginVideoReplicaJob(summary('project-a')); await savePluginVideoReplicaJob(summary('project-b'));
    const { deleteProjectFromDb } = await import('../../src/services/indexedDbService');
    await deleteProjectFromDb('project-a');
    expect(await readPluginVideoReplicaJobs('project-a')).toEqual([]);
    expect(await readPluginVideoReplicaJobs('project-b')).toHaveLength(1);
  });
});

describe('视频复刻崩溃后的观察状态', () => {
  it.each(['queued', 'preparing', 'composing'] as const)('recovers %s as paused without modifying durable progress or starting work', async (status) => {
    const { recoverPluginVideoReplicaJob, savePluginVideoReplicaJob, readPluginVideoReplicaJobs } = await repository();
    const previous = { ...summary(), status, completedSegments: 1, progress: 0.25, segmentNodeIds: ['node-1'], warnings: ['需要检查'] };
    await savePluginVideoReplicaJob(previous);
    const observed = recoverPluginVideoReplicaJob((await readPluginVideoReplicaJobs('project-a'))[0]);
    expect(observed).toMatchObject({ status: 'paused', completedSegments: 1, progress: 0.25, segmentNodeIds: ['node-1'] });
    expect(observed.stage).toContain('未自动继续');
    observed.segmentNodeIds.push('mutated'); observed.warnings!.push('mutated');
    expect(await readPluginVideoReplicaJobs('project-a')).toEqual([previous]);
  });
  it('recovers a submitted generating task as unknown and never silently requeues it', async () => {
    const { recoverPluginVideoReplicaJob } = await repository();
    const previous = { ...summary(), status: 'generating' as const, completedSegments: 1, segmentNodeIds: ['node-1', 'submitted-node'] };
    const observed = recoverPluginVideoReplicaJob(previous);
    expect(observed.status).toBe('unknown'); expect(observed.stage).toContain('未自动重新提交');
    expect(recoverPluginVideoReplicaJob(observed)).toEqual(observed);
    expect(previous.status).toBe('generating');
  });
  it.each(['succeeded', 'failed', 'cancelled', 'paused', 'unknown'] as const)('keeps %s terminal/manual states unchanged', async (status) => {
    const { recoverPluginVideoReplicaJob } = await repository();
    const previous = { ...summary(), status };
    expect(recoverPluginVideoReplicaJob(previous)).toEqual(previous);
  });
});
