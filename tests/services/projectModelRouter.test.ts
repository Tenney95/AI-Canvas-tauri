import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeProjectAggregate } from '../../src/services/indexedDb/nativeProjectRepository';

const mocks = vi.hoisted(() => ({
  openDB: vi.fn(), getAllProjects: vi.fn(), getProjectById: vi.fn(),
  listNativeProjectIdentities: vi.fn(), readNativeProject: vi.fn(),
}));
vi.mock('../../src/services/indexedDb/schema', () => ({ openDB: mocks.openDB, STORE_PROJECTS: 'projects', STORE_METADATA: 'metadata' }));
vi.mock('../../src/services/indexedDbService', () => ({ getAllProjects: mocks.getAllProjects, getProjectById: mocks.getProjectById }));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', () => ({
  listNativeProjectIdentities: mocks.listNativeProjectIdentities, readNativeProject: mocks.readNativeProject,
}));

import { listProjectCatalog, resolveProjectModel } from '../../src/services/projectModelRouter';

const native = { project: { id: 'native-root', name: '新作品', kind: 'series', createdAt: 1, updatedAt: 1 },
  content: {}, canvas: null, episodes: [{ id: 'native-episode' }], episodeContents: [], canvases: [{ id: 'native-canvas' }] } as unknown as NativeProjectAggregate;
const directory = { project: native.project, episodes: native.episodes, episodeIds: ['native-episode'], canvasIds: ['native-canvas'] };
let database: IDBDatabase;

beforeEach(async () => {
  vi.clearAllMocks();
  const factory = new IDBFactory();
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('routing-test', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      request.result.createObjectStore('metadata', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  mocks.openDB.mockResolvedValue(database);
  mocks.getAllProjects.mockResolvedValue([{ id: 'old-project', name: '旧项目', createdAt: 1, updatedAt: 1 }]);
  mocks.getProjectById.mockResolvedValue(undefined);
  mocks.listNativeProjectIdentities.mockResolvedValue([directory]);
  mocks.readNativeProject.mockResolvedValue(native);
});
afterEach(() => database.close());

async function occupy(id: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('projects', 'readwrite');
    transaction.objectStore('projects').put({ id, nodes: [{ id: 'legacy-node' }] });
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
  });
}

describe('新旧项目只读路由', () => {
  it('联合目录只读轻量身份，不读取新画布或依赖旧项目摘要承载画布', async () => {
    const result = await listProjectCatalog();
    expect(result).toEqual([
      expect.objectContaining({ dataModel: 'legacy', project: expect.objectContaining({ id: 'old-project' }) }),
      { dataModel: 'native', ...directory },
    ]);
    expect(mocks.readNativeProject).not.toHaveBeenCalled();
    expect(mocks.getProjectById).not.toHaveBeenCalled();
  });

  it.each(['native-root', 'native-episode', 'native-canvas'])('旧摘要缺行时仍从 projects 键发现 %s 冲突', async (id) => {
    await occupy(id);
    await expect(listProjectCatalog()).rejects.toThrow('身份冲突');
    await expect(resolveProjectModel('native-root')).rejects.toThrow('身份冲突');
  });

  it('旧目标已删除但保留墓碑时仍不能重用该身份', async () => {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('metadata', 'readwrite');
      transaction.objectStore('metadata').put({ id: 'project-deleted:native-canvas', retainedAudit: true });
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
    await expect(listProjectCatalog()).rejects.toThrow('身份冲突');
    await expect(resolveProjectModel('native-root')).rejects.toThrow('身份冲突');
  });

  it('旧项目即使使用类似新项目的 ID 也按旧仓储真实存在性判断', async () => {
    const old = { id: 'p2-like-old', name: '旧项目' };
    mocks.getProjectById.mockResolvedValue(old);
    mocks.listNativeProjectIdentities.mockResolvedValue([]);
    expect(await resolveProjectModel(old.id)).toEqual({ dataModel: 'legacy', project: old });
    expect(mocks.readNativeProject).not.toHaveBeenCalled();
  });

  it.each([['native-root', 'project'], ['native-episode', 'episode'], ['native-canvas', 'canvas']] as const)
  ('解析 %s 时只读取所属新作品并核对身份', async (id, target) => {
    expect(await resolveProjectModel(id)).toEqual({ dataModel: 'native', target, aggregate: native });
    expect(mocks.readNativeProject).toHaveBeenCalledExactlyOnceWith('native-root');
  });

  it('目录与正文身份发生变化、新库不可读或新旧同时存在时失败关闭；只读结果不是跨库写入授权', async () => {
    mocks.readNativeProject.mockResolvedValueOnce({ ...native, canvases: [] });
    await expect(resolveProjectModel('native-root')).rejects.toThrow('读取期间变化');
    mocks.readNativeProject.mockResolvedValueOnce({ ...native, episodes: [{ ...native.episodes[0], name: '更新后的分集' }] });
    await expect(resolveProjectModel('native-root')).rejects.toThrow('读取期间变化');
    mocks.listNativeProjectIdentities.mockRejectedValueOnce(new Error('新库版本未知'));
    await expect(resolveProjectModel('old-project')).rejects.toThrow('新库版本未知');
    mocks.getProjectById.mockResolvedValueOnce({ id: 'native-root' });
    await expect(resolveProjectModel('native-root')).rejects.toThrow('身份冲突');
  });

  it('两库均无记录时返回 missing，不创建或推断旧项目', async () => {
    mocks.listNativeProjectIdentities.mockResolvedValue([]);
    expect(await resolveProjectModel('missing')).toEqual({ dataModel: 'missing' });
    expect(mocks.readNativeProject).not.toHaveBeenCalled();
  });

  it('零集剧集可作为项目列出和解析，不伪造画布或旧分集', async () => {
    const aggregate = { ...native, episodes: [], episodeContents: [], canvases: [], canvas: null };
    const empty = { project: aggregate.project, episodes: [], episodeIds: [], canvasIds: [] };
    mocks.listNativeProjectIdentities.mockResolvedValue([empty]);
    mocks.readNativeProject.mockResolvedValue(aggregate);
    expect((await listProjectCatalog()).find((entry) => entry.dataModel === 'native')).toEqual({ dataModel: 'native', ...empty });
    expect(await resolveProjectModel('native-root')).toEqual({ dataModel: 'native', target: 'project', aggregate });
  });
});
