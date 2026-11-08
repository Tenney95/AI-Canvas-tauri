/** 新剪辑记录只在独立 fake IndexedDB 中演练；不访问真实项目。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import { VIDEO_EDITOR_SCHEMA_VERSION, type VideoEditorProjectRecord } from '../../src/types/videoEditor';
import { createNativeProject, convertNativeProjectToSeries, deleteNativeEpisode, readNativeProjectCapture,
  NATIVE_PROJECT_DATABASE_NAME, NATIVE_PROJECT_DATABASE_VERSION, EXCHANGE, openNativeProjectDatabase, transact } from '../../src/services/indexedDb/nativeProjectRepository';
import { readNativeVideoEditorProject, writeNativeVideoEditorProject, deleteNativeVideoEditorProject,
  listNativeVideoEditorProjectsForProject, bindNativeVideoEditorSession,
  revokeNativeVideoEditorSession } from '../../src/services/indexedDb/nativeVideoEditorRepository';
import { replaceNativeVideoEditorInTransaction, validateNativeVideoEditorUpdateMedia } from '../../src/services/indexedDb/nativeVideoEditorUpdate';
import type { ProjectModelTransferExchange } from '../../src/types/projectModelTransfer';

const projectId = 'p2-11111111-1111-4111-8111-111111111111';
const canvasId = 'c2-22222222-2222-4222-8222-222222222222';
const episodeId = 'e2-33333333-3333-4333-8333-333333333333';
let factory: IDBFactory;
const context = (patch: Partial<CanvasContext> = {}): CanvasContext => ({ kind: 'canvas', schemaVersion: 2, modelGeneration: 1,
  projectId, projectEpoch: 1, canvasId, canvasEpoch: 1, canvasRevision: 0, episodeId: null, ...patch });
const record = (): VideoEditorProjectRecord => ({ id: `${canvasId}::node`, projectId: canvasId, nodeId: 'node',
  schemaVersion: VIDEO_EDITOR_SCHEMA_VERSION, name: '剪辑', tracks: [], createdAt: 1, updatedAt: 1 });
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  factory = new IDBFactory();
  await createNativeProject({ projectId, canvasId, name: '作品' }, { factory });
});
afterEach(() => vi.unstubAllGlobals());

describe('新画布剪辑仓储', () => {
  it('与新画布同事务保存、比较版本并推进作品变更号，不升级新库', async () => {
    const initial = record();
    await writeNativeVideoEditorProject(initial, context(), { expected: null }, { factory });
    expect(await readNativeVideoEditorProject(initial.id, context(), { factory })).toEqual(initial);
    expect((await readNativeProjectCapture(projectId, { factory }))?.changeRevision).toBe(1);
    await expect(writeNativeVideoEditorProject({ ...initial, name: '过期' }, context(), { expected: null }, { factory })).rejects.toThrow('已变化');
    expect((await readNativeVideoEditorProject(initial.id, context(), { factory }))?.name).toBe('剪辑');
    expect((await factory.databases()).find((item) => item.name === NATIVE_PROJECT_DATABASE_NAME)?.version).toBe(NATIVE_PROJECT_DATABASE_VERSION);
  });

  it('转成分集保留同一画布工程，旧画布代际和删除后的写入都被拒绝', async () => {
    const initial = record();
    await writeNativeVideoEditorProject(initial, context(), { expected: null }, { factory });
    const converted = await convertNativeProjectToSeries({ projectId, expectedProjectEpoch: 1, expectedCanvasId: canvasId,
      expectedCanvasEpoch: 1, expectedCanvasRevision: 0, expectedStandaloneRevision: 0, episodeId, name: '第一集' }, { factory });
    await expect(writeNativeVideoEditorProject(initial, context(), null, { factory })).rejects.toThrow('代际');
    const current = context({ projectEpoch: converted.project.epoch, canvasEpoch: converted.canvas!.epoch, episodeId });
    expect(await readNativeVideoEditorProject(initial.id, current, { factory })).toEqual(initial);
    await deleteNativeEpisode({ projectId, expectedProjectEpoch: converted.project.epoch, episodeId, expectedCanvasId: canvasId,
      expectedEpisodeRevision: 0, expectedContentRevision: 0, expectedCanvasEpoch: converted.canvas!.epoch, expectedCanvasRevision: 0 }, { factory });
    await expect(deleteNativeVideoEditorProject(initial.id, current, { factory })).rejects.toThrow();
    expect(await listNativeVideoEditorProjectsForProject(projectId, { factory })).toEqual([initial]);
  });

  it('更新事务比较全部旧工程，原子替换并撤销旧窗口租约', async () => {
    const initial = record(), session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const current = context({ runtimeEpoch: 'fixture-process' });
    await bindNativeVideoEditorSession(current, session, { factory });
    await writeNativeVideoEditorProject(initial, current, { expected: null }, { factory }, session);
    const db = await openNativeProjectDatabase(false, { factory });
    if (!db) throw new Error('fixture database missing');
    try {
      const input = { projectId, expected: [initial], next: [{ ...initial, name: '导入' }],
        oldCanvasIds: [canvasId], retiredCanvasIds: [], expectedRetired: [], nextCanvasIds: [canvasId] };
      await expect(transact(db, 'readwrite', { factory }, (tx) => replaceNativeVideoEditorInTransaction(tx.objectStore(EXCHANGE),
        { ...input, expected: [] }), [EXCHANGE])).rejects.toThrow('已变化');
      expect(await readNativeVideoEditorProject(initial.id, current, { factory }, session)).toEqual(initial);
      await transact(db, 'readwrite', { factory }, (tx) => replaceNativeVideoEditorInTransaction(tx.objectStore(EXCHANGE), input), [EXCHANGE]);
      expect(await readNativeVideoEditorProject(initial.id, current, { factory })).toMatchObject({ name: '导入' });
      await expect(readNativeVideoEditorProject(initial.id, current, { factory }, session)).rejects.toThrow('已撤销');
    } finally { db.close(); }
  });

  it('更新仅接受主素材根中唯一已核验的旧文件或新发布文件', () => {
    const primaryRoot = 'r2-44444444-4444-4444-8444-444444444444';
    const media = { rootRef: primaryRoot, relativePath: 'imports/new/media.mp4', bytes: 7, sha256: 'a'.repeat(64) };
    const withClip: VideoEditorProjectRecord = { ...record(), tracks: [{ id: 'track', name: '主轨', kind: 'video', clips: [{ id: 'clip',
      kind: 'video', fileName: '素材', relativePath: media.relativePath, timelineStart: 0, sourceIn: 0, sourceOut: 1 }] }] };
    const exchange = { identities: [{ kind: 'storage-root', sourceId: 'root', localId: primaryRoot }], fileBindings: [
      { id: 'file', rootRef: 'root', relativePath: 'media.mp4', localRelativePath: media.relativePath },
    ] } as unknown as ProjectModelTransferExchange;
    const input = { records: [withClip], canvasIds: [canvasId], primaryRoot, exchange, media: [media], oldAssets: [] };
    expect(() => validateNativeVideoEditorUpdateMedia(input)).not.toThrow();
    expect(() => validateNativeVideoEditorUpdateMedia({ ...input, media: [], oldAssets: [{ rootRef: primaryRoot,
      path: media.relativePath, bytes: 7, sha256: media.sha256 }] })).not.toThrow();
    expect(() => validateNativeVideoEditorUpdateMedia({ ...input, media: [] })).toThrow('文件');
    expect(() => validateNativeVideoEditorUpdateMedia({ ...input, media: [media, media] })).toThrow('唯一');
    expect(() => validateNativeVideoEditorUpdateMedia({ ...input, exchange: { ...exchange, fileBindings: [] } })).toThrow('映射');
    expect(() => validateNativeVideoEditorUpdateMedia({ ...input, canvasIds: [] })).toThrow('画布');
  });

  it('更新删除画布时保留原工程供墓碑历史只读使用', async () => {
    const initial = record();
    await writeNativeVideoEditorProject(initial, context(), { expected: null }, { factory });
    const db = await openNativeProjectDatabase(false, { factory });
    if (!db) throw new Error('fixture database missing');
    try {
      await transact(db, 'readwrite', { factory }, (tx) => replaceNativeVideoEditorInTransaction(tx.objectStore(EXCHANGE), {
        projectId, expected: [initial], expectedRetired: [], next: [], oldCanvasIds: [canvasId], retiredCanvasIds: [], nextCanvasIds: [],
      }), [EXCHANGE]);
      expect(await listNativeVideoEditorProjectsForProject(projectId, { factory })).toEqual([initial]);
    } finally { db.close(); }
  });

  it('项目更新核对并保留墓碑画布上的历史剪辑工程', async () => {
    const initial = record();
    await writeNativeVideoEditorProject(initial, context(), { expected: null }, { factory });
    const converted = await convertNativeProjectToSeries({ projectId, expectedProjectEpoch: 1, expectedCanvasId: canvasId,
      expectedCanvasEpoch: 1, expectedCanvasRevision: 0, expectedStandaloneRevision: 0, episodeId, name: '第一集' }, { factory });
    await deleteNativeEpisode({ projectId, expectedProjectEpoch: converted.project.epoch, episodeId, expectedCanvasId: canvasId,
      expectedEpisodeRevision: 0, expectedContentRevision: 0, expectedCanvasEpoch: converted.canvas!.epoch,
      expectedCanvasRevision: converted.canvas!.revision }, { factory });
    const db = await openNativeProjectDatabase(false, { factory });
    if (!db) throw new Error('fixture database missing');
    try {
      const input = { projectId, expected: [], next: [], oldCanvasIds: [], nextCanvasIds: [],
        expectedRetired: [initial], retiredCanvasIds: [canvasId] };
      await expect(transact(db, 'readwrite', { factory }, (tx) => replaceNativeVideoEditorInTransaction(tx.objectStore(EXCHANGE),
        { ...input, expectedRetired: [] }), [EXCHANGE])).rejects.toThrow('已变化');
      await transact(db, 'readwrite', { factory }, (tx) => replaceNativeVideoEditorInTransaction(tx.objectStore(EXCHANGE), input), [EXCHANGE]);
      expect(await listNativeVideoEditorProjectsForProject(projectId, { factory })).toEqual([initial]);
    } finally { db.close(); }
  });

  it('拒绝把本机绝对路径或临时地址写入新工程', async () => {
    const unsafe = { ...record(), tracks: [{ id: 'track', name: '主轨', kind: 'video' as const, clips: [{ id: 'clip', kind: 'video' as const,
      fileName: '素材', filePath: 'C:\\private\\clip.mp4', timelineStart: 0, sourceIn: 0, sourceOut: 1 }] }] };
    await expect(writeNativeVideoEditorProject(unsafe, context(), { expected: null }, { factory })).rejects.toThrow('可持久化');
    expect(await readNativeVideoEditorProject(unsafe.id, context(), { factory })).toBeNull();
  });

  it('切换画布撤销窗口会话，旧会话不能覆盖工程或撤销新会话', async () => {
    const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const target = context({ runtimeEpoch: 'fixture-process' });
    await bindNativeVideoEditorSession(target, first, { factory });
    await writeNativeVideoEditorProject(record(), target, { expected: null }, { factory }, first);
    await revokeNativeVideoEditorSession(canvasId, first, { factory });
    await expect(writeNativeVideoEditorProject({ ...record(), name: '迟到写入' }, target, null, { factory }, first)).rejects.toThrow('已撤销');
    await bindNativeVideoEditorSession(target, second, { factory });
    await revokeNativeVideoEditorSession(canvasId, first, { factory });
    expect(await readNativeVideoEditorProject(record().id, target, { factory }, second)).toEqual(record());
    await expect(readNativeVideoEditorProject(record().id, target, { factory }, first)).rejects.toThrow('已撤销');
  });
});
