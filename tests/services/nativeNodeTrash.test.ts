/** 新结构节点回收只移动独占文件；跨画布、回执及恢复材料仍保护原件。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '../../src/types/project';
import type { NativeProjectAggregate, readNativeProjectCapture } from '../../src/services/indexedDb/nativeProjectRepository';
import type { NativeStorageSnapshot } from '../../src/services/fs/nativeStorageReferences';

const mocks = vi.hoisted(() => ({
  readCapture: vi.fn(),
  readSnapshot: vi.fn(),
  owner: vi.fn(),
  root: vi.fn(),
  invoke: vi.fn(),
  getProjectConversations: vi.fn(),
  getTrashConversations: vi.fn(),
  getConversationMessages: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/fs/core', () => ({
  getNativeProjectOwner: mocks.owner,
  getProjectDataDir: mocks.root,
}));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', async () => ({
  ...await vi.importActual<typeof import('../../src/services/indexedDb/nativeProjectRepository')>(
    '../../src/services/indexedDb/nativeProjectRepository'),
  readNativeProjectCapture: mocks.readCapture,
}));
vi.mock('../../src/services/fs/nativeStorageReferences', async () => ({
  ...await vi.importActual<typeof import('../../src/services/fs/nativeStorageReferences')>(
    '../../src/services/fs/nativeStorageReferences'),
  readNativeStorageSnapshot: mocks.readSnapshot,
}));
vi.mock('../../src/services/indexedDbService', () => ({
  getProjectConversations: mocks.getProjectConversations,
  getTrashConversations: mocks.getTrashConversations,
  getConversationMessages: mocks.getConversationMessages,
}));

import { createNativeNodeTrashGuard } from '../../src/services/fs/nativeNodeTrash';

const id = (prefix: 'p2' | 'c2' | 'e2' | 'r2', digit: string) =>
  `${prefix}-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const projectId = id('p2', '1'), canvasId = id('c2', '2'), otherCanvasId = id('c2', '3');
const rootRef = id('r2', '4'), subrootRef = id('r2', '5');
const root = '/projects/show', subroot = `${root}/imports/recovery`;
type Capture = NonNullable<Awaited<ReturnType<typeof readNativeProjectCapture>>>;
let capture: Capture;
let snapshot: NativeStorageSnapshot;

function canvas(identity: string, nodes: unknown[]): CanvasDocument {
  return { id: identity, projectId, episodeId: null, storageRootRef: rootRef,
    nodes, edges: [], groups: [], epoch: 0, revision: 0, revisionScope: 'project' };
}

function mediaNode(nodeId: string, relativePath: string) {
  return { id: nodeId, type: 'source-image', position: { x: 0, y: 0 },
    data: { type: 'source-image', relativePath } };
}

beforeEach(() => {
  vi.resetAllMocks();
  const first = canvas(canvasId, [mediaNode('removed', 'images/removed.png'), mediaNode('living', 'images/living.png')]);
  const aggregate: NativeProjectAggregate = {
    project: { id: projectId, name: 'show', kind: 'standalone', createdAt: 1, updatedAt: 1, epoch: 0,
      dataFolder: 'show', storageRootRef: rootRef,
      storageBindings: [{ rootRef, folderName: 'show', sourceRecordIds: [], source: 'project-managed' }] },
    content: { projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } },
    canvas: first, canvases: [first], episodes: [], episodeContents: [],
  };
  capture = { aggregate, changeRevision: 3, exchange: null, includesHistory: false };
  snapshot = { exchange: [], transfers: [], retired: [] };
  mocks.owner.mockImplementation((identity: string) => [projectId, canvasId, otherCanvasId].includes(identity) ? projectId : undefined);
  mocks.root.mockResolvedValue(root);
  mocks.invoke.mockImplementation(async (command: string, input: { rootRef?: string }) => {
    if (command === 'resolve_native_project_media_subroot' && input.rootRef === subrootRef) return subroot;
    throw new Error('unexpected native root request');
  });
  mocks.readCapture.mockImplementation(async () => structuredClone(capture));
  mocks.readSnapshot.mockImplementation(async () => structuredClone(snapshot));
  mocks.getProjectConversations.mockResolvedValue([]);
  mocks.getTrashConversations.mockResolvedValue([]);
  mocks.getConversationMessages.mockResolvedValue({ messages: [], total: 0 });
});

describe('新结构节点文件回收保护', () => {
  it('排除被删节点及单画布别名的旧引用，保留当前存活节点', async () => {
    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    expect(guard.references).not.toContain(`${root}/images/removed.png`);
    expect(guard.references).toContain(`${root}/images/living.png`);
    await expect(guard.isCurrent()).resolves.toBe(true);
    expect(capture.aggregate.canvases[0].nodes).toHaveLength(2);
  });

  it('同名节点属于另一画布或正文时仍保护，不按被删节点 ID 全项目排除', async () => {
    capture.aggregate.canvas = null;
    capture.aggregate.project.kind = 'series';
    capture.aggregate.canvases.push(canvas(otherCanvasId, [mediaNode('removed', 'images/removed.png')]));
    capture.aggregate.content.originalWork = { fileName: 'original.txt', relativePath: 'texts/original.txt', addedAt: 1 };
    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    expect(guard.references).toContain(`${root}/images/removed.png`);
    expect(guard.references).toContain(`${root}/texts/original.txt`);
  });

  it('按已绑定子根解析其他画布及终态回执、恢复点的相对引用', async () => {
    capture.aggregate.project.storageBindings.push({ rootRef: subrootRef, folderName: 'imports/recovery',
      sourceRecordIds: [], source: 'project-managed' });
    capture.aggregate.canvases.push({ ...canvas(otherCanvasId, [mediaNode('other', 'frame.png')]), storageRootRef: subrootRef });
    snapshot.exchange.push({ kind: 'native-output-history-v1', projectId, rootRef: subrootRef, relativePath: 'history.png' });
    snapshot.transfers.push({ kind: 'native-content-recovery', projectId, phase: 'ready',
      rootRef: subrootRef, relativePath: 'recovery.png' });

    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    for (const name of ['frame.png', 'history.png', 'recovery.png']) expect(guard.references).toContain(`${subroot}/${name}`);
    expect(guard.references).not.toContain(`${root}/frame.png`);
    expect(mocks.invoke).toHaveBeenCalledWith('resolve_native_project_media_subroot', {
      projectId, rootRef: subrootRef, create: false,
    });
  });

  it.each(['native-media-task-v1', 'unknown-protocol'])('存在未完成或未知操作时不开放回收：%s', async (kind) => {
    snapshot.exchange.push({ kind, projectId, status: 'submitted' });
    await expect(createNativeNodeTrashGuard(canvasId, ['removed'])).rejects.toThrow();
  });

  it('项目、其他画布与退役画布的聊天和可恢复会话仍保护附件', async () => {
    const retiredId = id('c2', '6');
    capture.aggregate.canvases.push(canvas(otherCanvasId, []));
    snapshot.retired.push({ id: retiredId, projectId, kind: 'canvas' });
    mocks.getProjectConversations.mockImplementation(async (identity: string) =>
      identity === projectId || identity === otherCanvasId ? [{ id: identity }] : []);
    mocks.getTrashConversations.mockImplementation(async (identity: string) =>
      identity === retiredId ? [{ id: 'recoverable-conversation' }] : []);
    mocks.getConversationMessages.mockImplementation(async (conversationId: string) => ({
      messages: [{ mediaResult: { filePath: `${root}/images/${conversationId}.png` } }], total: 1,
    }));

    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    for (const identity of [projectId, otherCanvasId, 'recoverable-conversation']) {
      expect(guard.references).toContain(`${root}/images/${identity}.png`);
    }
    expect(mocks.getTrashConversations).toHaveBeenCalledWith(retiredId);
  });

  it('消息分页未读完却返回空页时拒绝回收，移动前新增聊天附件同样使许可失效', async () => {
    mocks.getProjectConversations.mockImplementation(async (identity: string) => identity === canvasId ? [{ id: 'chat' }] : []);
    mocks.getConversationMessages.mockResolvedValueOnce({ messages: [], total: 1 });
    await expect(createNativeNodeTrashGuard(canvasId, ['removed'])).rejects.toThrow('消息引用读取不完整');
    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    mocks.getConversationMessages.mockResolvedValue({ messages: [{ mediaResult: { filePath: `${root}/images/removed.png` } }], total: 1 });
    await expect(guard.isCurrent()).resolves.toBe(false);
  });

  it('归属登记、权威画布或素材根无法确认时保留文件', async () => {
    mocks.owner.mockReturnValueOnce(undefined);
    await expect(createNativeNodeTrashGuard(canvasId, ['removed'])).rejects.toThrow();
    mocks.readCapture.mockResolvedValueOnce(null);
    await expect(createNativeNodeTrashGuard(canvasId, ['removed'])).rejects.toThrow();
    await expect(createNativeNodeTrashGuard(otherCanvasId, ['removed'])).rejects.toThrow();
    mocks.root.mockRejectedValueOnce(new Error('root unavailable'));
    await expect(createNativeNodeTrashGuard(canvasId, ['removed'])).rejects.toThrow();
  });

  it('本次删除自动保存后版本已稳定，仍允许回收独占文件', async () => {
    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    capture.aggregate.canvases[0].nodes = capture.aggregate.canvases[0].nodes.filter((value) =>
      (value as { id: string }).id !== 'removed');
    capture.aggregate.canvases[0].revision += 1;
    capture.aggregate.project.updatedAt += 1;
    capture.changeRevision += 1;
    await expect(guard.isCurrent()).resolves.toBe(true);
  });

  it('新增其他画布的文件引用后，不继续使用原回收许可', async () => {
    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    capture.aggregate.canvases.push(canvas(otherCanvasId, [mediaNode('new-reference', 'images/removed.png')]));
    capture.changeRevision += 1;
    await expect(guard.isCurrent()).resolves.toBe(false);
  });

  it('本轮引用扫描尚未结束又发生保存时，拒绝不稳定的回收许可', async () => {
    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    mocks.getProjectConversations.mockImplementationOnce(async () => {
      capture.changeRevision += 1;
      return [];
    });
    await expect(guard.isCurrent()).resolves.toBe(false);
  });

  it('移动前新增正文文件引用、回执或物理根变化都会拒绝旧许可', async () => {
    const content = await createNativeNodeTrashGuard(canvasId, ['removed']);
    capture.aggregate.content.originalWork = { fileName: 'removed.png', relativePath: 'images/removed.png', addedAt: 1 };
    await expect(content.isCurrent()).resolves.toBe(false);

    const receipts = await createNativeNodeTrashGuard(canvasId, ['removed']);
    snapshot.exchange.push({ kind: 'native-output-history-v1', projectId, relativePath: 'images/removed.png' });
    await expect(receipts.isCurrent()).resolves.toBe(false);

    const directory = await createNativeNodeTrashGuard(canvasId, ['removed']);
    mocks.root.mockResolvedValue('/projects/changed');
    await expect(directory.isCurrent()).resolves.toBe(false);
  });

  it('移动前材料读取失败或画布撤销登记时返回 false，不把未知状态当作空引用', async () => {
    const unreadable = await createNativeNodeTrashGuard(canvasId, ['removed']);
    mocks.readSnapshot.mockRejectedValueOnce(new Error('read denied'));
    await expect(unreadable.isCurrent()).resolves.toBe(false);
    const unregistered = await createNativeNodeTrashGuard(canvasId, ['removed']);
    mocks.owner.mockReturnValue(undefined);
    await expect(unregistered.isCurrent()).resolves.toBe(false);
  });

  it('其他作品的独立回执变化不废弃本作品的回收许可', async () => {
    const guard = await createNativeNodeTrashGuard(canvasId, ['removed']);
    snapshot.exchange.push({ kind: 'native-output-history-v1', projectId: id('p2', '9'), relativePath: 'other.png' });
    await expect(guard.isCurrent()).resolves.toBe(true);
  });
});
