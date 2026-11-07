/** P4 剪辑仓储代际与旧模型门禁回归源；本轮不执行。 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { VideoEditorProjectRecord } from '../../src/types/videoEditor';
import { VIDEO_EDITOR_SCHEMA_VERSION } from '../../src/types/videoEditor';

const holder = vi.hoisted(() => ({ database: null as IDBDatabase | null }));
vi.mock('../../src/services/indexedDb/schema', () => ({
  openDB: vi.fn(async () => holder.database!), STORE_METADATA: 'metadata', STORE_PROJECTS: 'projects',
  STORE_VIDEO_EDITOR_PROJECTS: 'videoEditorProjects',
}));
import { openDB } from '../../src/services/indexedDb/schema';
import { assertVideoEditorProjectContext, saveVideoEditorProject, getVideoEditorProject,
  compareAndSaveVideoEditorProject, deleteVideoEditorProject } from '../../src/services/indexedDb/videoEditorRepository';

const canvasId = 'canvas::old';
const context = (): CanvasContext => ({ kind: 'canvas', schemaVersion: 2, modelGeneration: 0, runtimeEpoch: 'fixture-process',
  projectId: 'owner', projectEpoch: 2, canvasId, episodeId: canvasId, canvasEpoch: 3, canvasRevision: 7 });
const record = (): VideoEditorProjectRecord => ({ id: `${canvasId}::node`, projectId: canvasId, nodeId: 'node',
  schemaVersion: VIDEO_EDITOR_SCHEMA_VERSION, name: '原剪辑', tracks: [], automationRevision: 0, createdAt: 1, updatedAt: 2 });
async function put(store: string, value: unknown) {
  await new Promise<void>((resolve, reject) => {
    const tx = holder.database!.transaction(store, 'readwrite'); tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
beforeEach(async () => {
  holder.database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = new IDBFactory().open('video-context-fixture', 1);
    request.onupgradeneeded = () => {
      for (const name of ['projects', 'metadata', 'videoEditorProjects']) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  vi.mocked(openDB).mockImplementation(async () => holder.database!);
  await put('projects', { id: 'owner', exchangeEpoch: 2 });
  await put('projects', { id: canvasId, parentId: 'owner', exchangeEpoch: 3 });
});
afterEach(() => { holder.database?.close(); vi.restoreAllMocks(); });

it('preserves literal old canvas aliases containing the separator and keeps automation CAS', async () => {
  const original = record();
  await saveVideoEditorProject(original, context());
  expect(await getVideoEditorProject(original.id, context())).toEqual(original);
  const automated = { ...original, automationRevision: 1, name: '自动更新' };
  await compareAndSaveVideoEditorProject(automated, original, context());
  await expect(saveVideoEditorProject(original, context())).rejects.toThrow('MCP');
  await expect(compareAndSaveVideoEditorProject(original, original, context())).rejects.toThrow('变化');
  expect(await getVideoEditorProject(original.id)).toEqual(automated);
});

it.each(['project-model-source-freeze', 'activeDataModel', 'project-model-business-fixture'])('blocks all old editor writes when %s exists', async (id) => {
  await put('metadata', { id, value: false });
  await expect(saveVideoEditorProject(record(), context())).rejects.toThrow();
  await expect(compareAndSaveVideoEditorProject(record(), null, context())).rejects.toThrow();
  await expect(deleteVideoEditorProject(record().id, context())).rejects.toThrow();
  expect(await getVideoEditorProject(record().id)).toBeNull();
});

it('rejects an old window after same-id import changes either canvas or owner epoch', async () => {
  await saveVideoEditorProject(record(), context());
  await put('projects', { id: canvasId, parentId: 'owner', exchangeEpoch: 4 });
  await expect(saveVideoEditorProject({ ...record(), name: '迟到覆盖' }, context())).rejects.toThrow('代际');
  await expect(getVideoEditorProject(record().id, context())).rejects.toThrow('代际');
  await put('projects', { id: canvasId, parentId: 'owner', exchangeEpoch: 3 });
  await put('projects', { id: 'owner', exchangeEpoch: 9 });
  await expect(assertVideoEditorProjectContext(canvasId, context())).rejects.toThrow('代际');
  expect((await getVideoEditorProject(record().id))?.name).toBe('原剪辑');
});

it('keeps context-free reads but refuses writes without an execution context or to future records', async () => {
  const future = { ...record(), schemaVersion: VIDEO_EDITOR_SCHEMA_VERSION + 1 };
  await put('videoEditorProjects', future);
  expect(await getVideoEditorProject(future.id)).toBeNull();
  await expect(getVideoEditorProject(future.id, context())).rejects.toThrow('更高版本');
  await expect(saveVideoEditorProject(record(), context())).rejects.toThrow('更高版本');
  await expect(deleteVideoEditorProject(future.id, context())).rejects.toThrow('更高版本');
  await expect(saveVideoEditorProject(record())).rejects.toThrow();
});

it('captures context and record before awaiting the database and never accepts a later replacement', async () => {
  const expected = context(), input = record();
  let release!: (db: IDBDatabase) => void;
  vi.mocked(openDB).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const saving = saveVideoEditorProject(input, expected);
  expected.canvasEpoch = 90; input.name = '调用后修改';
  release(holder.database!);
  await saving;
  expect((await getVideoEditorProject(input.id))?.name).toBe('原剪辑');
});
