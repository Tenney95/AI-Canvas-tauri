/** 多POST短准备窗口只覆盖本机核验；全部使用隔离数据库与网络替身。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { NativeMediaSubmissionPreparation } from '../../src/types/media';
const driver = vi.hoisted(() => ({ state: {} as Record<string, unknown>, begin: vi.fn(), resume: vi.fn(),
  leases: [] as Array<NativeMediaSubmissionPreparation & { release: ReturnType<typeof vi.fn> }> }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => driver.state } }));
vi.mock('../../src/services/nativeVideoSubmission', () => ({ isNativeVideoSubmissionGuard: (guard: unknown) => typeof guard === 'function',
  captureNativeVideoSubmissionBaseline: async (_context: unknown, _nodeId: unknown, _image: unknown, _scheme: unknown,
    options: { preparation: NativeMediaSubmissionPreparation }) => {
    options.preparation.assertCurrent(); return { inputFingerprint: 'a'.repeat(64), canvasRevision: options.preparation.canvasRevision };
  }, assertNativeVideoSubmissionInput: async () => {} }));
vi.mock('../../src/services/nativeApimartImageRecovery', () => ({ resumeNativeApimartImageBatch: driver.resume }));
import { createNativeProject, readNativeProjectCapture, saveNativeProjectView } from '../../src/services/indexedDb/nativeProjectRepository';
import { listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { bindNativeMediaOrigin } from '../../src/services/nativeMediaOrigin';
import { submitNativeApimartImageBatch } from '../../src/services/nativeApimartImageSubmission';

let unbind: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto);
  driver.leases = []; driver.begin.mockReset(); driver.resume.mockReset().mockRejectedValue(new Error('原查询暂停'));
});
afterEach(() => { unbind?.(); unbind = undefined; vi.unstubAllGlobals(); });
async function fixture() {
  const aggregate = await createNativeProject({ name: '隔离图片批次' });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, projectId: aggregate.project.id,
    projectEpoch: aggregate.project.epoch, canvasId: aggregate.canvas!.id, canvasEpoch: aggregate.canvas!.epoch,
    episodeId: null, canvasRevision: 0, runtimeEpoch: 'original-window' };
  const nodeId = `media-message-${crypto.randomUUID()}`;
  unbind = bindNativeMediaOrigin(context.canvasId, nodeId, { conversationId: 'original-conversation', messageId: 'original-message', deliveryMode: 'chat' },
    { material: 'original-input', assertCurrent: () => {} });
  driver.state = { currentProjectId: context.canvasId, projectExecutionContext: context, projectLoadStatus: 'ready',
    beginNativeMediaSubmissionPreparation: driver.begin };
  const save = async () => {
    const capture = (await readNativeProjectCapture(context.projectId))!, canvas = capture.aggregate.canvases[0];
    return saveNativeProjectView({ projectId: context.projectId, expectedProjectEpoch: context.projectEpoch,
      canvasId: context.canvasId, episodeId: null, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: canvas.nodes, edges: canvas.edges, groups: canvas.groups } });
  };
  driver.begin.mockImplementation(async () => {
    const saved = await save(); let released = false;
    const lease = { context, canvasRevision: saved.canvas.revision, release: vi.fn(() => { released = true; }),
      assertCurrent: () => { if (released || driver.state.currentProjectId !== context.canvasId) throw new Error('原准备窗口已失效'); } };
    driver.leases.push(lease); return lease;
  });
  return { context, nodeId, save };
}
it('后续POST重取新保存版本，原sourceRevision不改，网络等待不持准备锁', async () => {
  const { context, nodeId, save } = await fixture();
  const submit = vi.fn(async () => {
    const ordinal = driver.leases.length - 1;
    expect(driver.leases[ordinal].release).toHaveBeenCalledOnce(); await save();
    return [`original-task-${ordinal}`];
  });
  await expect(submitNativeApimartImageBatch({ nodeId, model: 'fixture-model', baseUrl: 'https://fixture.example', requestedCount: 2,
    bodies: [{ prompt: 'first' }, { prompt: 'second' }], imageUrls: [], beforeSubmit: () => {}, submit }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  expect(submit).toHaveBeenCalledTimes(2); expect(driver.begin).toHaveBeenCalledTimes(2);
  expect(driver.leases.map((lease) => lease.canvasRevision)).toEqual([1, 3]);
  const row = (await listNativeMediaTasks(context.projectId))[0];
  expect(row).toMatchObject({ status: 'submitted', sourceCanvasRevision: 1 });
  expect(row.apimartImageBatch?.tasks.map((task) => task.taskId)).toEqual(['original-task-0', 'original-task-1']);
});
it('准备后取消释放窗口并封存未发送槽位，零POST且不留下prepared主任务', async () => {
  const { context, nodeId } = await fixture(); const controller = new AbortController();
  const submit = vi.fn(async () => ['never-submitted']);
  await expect(submitNativeApimartImageBatch({ nodeId, model: 'fixture-model', baseUrl: 'https://fixture.example', requestedCount: 2,
    bodies: [{ prompt: 'first' }, { prompt: 'second' }], imageUrls: [], signal: controller.signal,
    beforeSubmit: () => { if (driver.leases.length) controller.abort(); }, submit })).rejects.toThrow();
  expect(submit).not.toHaveBeenCalled(); expect(driver.leases[0].release).toHaveBeenCalledOnce();
  expect((await listNativeMediaTasks(context.projectId))[0].status).toBe('failed');
});
