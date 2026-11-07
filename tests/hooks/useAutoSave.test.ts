/**
 * useAutoSave — 回归测试：useAutoSave node data tracking。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

const driver = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  pending: vi.fn(async (_projectId: string) => [] as import('../../src/services/indexedDb/mediaRelocations').MediaRelocation[]),
  directory: vi.fn(async (id: string) => `D:/data/${id}`),
  move: vi.fn(async (path: string | undefined, dir: string, folder: string | null) => {
    if (!path) return null;
    const name = path.replaceAll('\\', '/').split('/').pop();
    const target = `${dir}/${folder ? `${folder}/` : ''}${name}`;
    return path === target ? null : target;
  }),
  finish: vi.fn(async () => undefined),
  waitForSaves: vi.fn(async (_projectId: string) => true),
}));

// 在 Node 环境驱动 effect 生命周期；Hook 和分组 Store 使用生产实现。
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: <T,>(value: T) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => { driver.effects.push(effect); },
}));
vi.mock('../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../src/services/fileService')>(),
  getProjectDataDir: driver.directory,
  moveProjectFileToFolder: driver.move,
  finishProjectFileRelocation: driver.finish,
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
  ensureGroupFolder: vi.fn(async () => null),
  removeEmptyProjectGroupFolder: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/indexedDb/mediaRelocations', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/mediaRelocations')>(),
  pendingMediaRelocations: driver.pending,
  persistMediaRelocation: vi.fn(async () => undefined),
  completeMediaRelocation: vi.fn(async () => undefined),
}));
vi.mock('../../src/store/store.projects', async (original) => ({
  ...await original<typeof import('../../src/store/store.projects')>(),
  waitForPendingProjectSaves: driver.waitForSaves,
}));

import {
  captureNodeDataReferences,
  hasNodeDataReferenceChanges,
  flushPendingAutoSave,
  useAutoSave as mountAutoSave,
} from '../../src/hooks/useAutoSave';
import { useAppStore } from '../../src/store/useAppStore';
import { PROJECT_DISK_CHANGED_EVENT } from '../../src/services/fileService';

let cleanup: (() => void) | undefined;
const mediaNode = (): Node<BaseNodeData> => ({
  id: 'a', type: 'ai-image', position: { x: 0, y: 0 },
  data: { label: 'a', type: 'ai-image', filePath: 'D:/data/p1/a.png', imageUrl: 'asset://D:/data/p1/a.png' },
});
function mount() {
  mountAutoSave();
  const effect = driver.effects.pop()!;
  cleanup = effect() || undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.clearAllMocks();
  driver.effects = [];
  driver.pending.mockReset().mockResolvedValue([]);
  driver.waitForSaves.mockReset().mockResolvedValue(true);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p1', projectLoadStatus: 'ready',
    projects: [{ id: 'p1', name: '项目一', createdAt: 1, updatedAt: 1 }, { id: 'p2', name: '项目二', createdAt: 1, updatedAt: 1 }], nodes: [mediaNode()],
    saveCurrentProjectSilent: vi.fn(async () => 'p1') });
});
afterEach(async () => {
  cleanup?.();
  cleanup = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAutoSave node data tracking', () => {
  it('detects immutable node content updates', () => {
    const originalData = { label: '原内容', output: '第一版' };
    const baseline = captureNodeDataReferences([{ id: 'node-1', data: originalData }]);

    expect(hasNodeDataReferenceChanges([
      { id: 'node-1', data: { ...originalData, output: '第二版' } },
    ], baseline)).toBe(true);
  });

  it('ignores node wrapper changes when data is unchanged', () => {
    const data = { label: '文本节点', output: '内容' };
    const baseline = captureNodeDataReferences([{ id: 'node-1', data }]);

    expect(hasNodeDataReferenceChanges([{ id: 'node-1', data }], baseline)).toBe(false);
  });

  it('detects added nodes', () => {
    const baseline = captureNodeDataReferences([]);

    expect(hasNodeDataReferenceChanges([
      { id: 'node-1', data: { label: '新节点' } },
    ], baseline)).toBe(true);
  });
});

describe('useAutoSave with the group file Store', () => {
  it('does not sync or save during continuous pure selection and position changes', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    for (let step = 0; step < 8; step++) {
      useAppStore.setState({ nodes: [{ ...useAppStore.getState().nodes[0], selected: step % 2 === 0, position: { x: step, y: step } }] });
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(driver.pending).not.toHaveBeenCalled();
    expect(driver.directory).not.toHaveBeenCalled();
    expect(driver.move).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('saves body edits once without rescanning unrelated group media', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    useAppStore.getState().updateNodeDataTransient('a', { output: '修改后的正文' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(driver.directory).not.toHaveBeenCalled();
    expect(driver.move).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
  });

  it.each(['selection', 'drag'])('saves a body edit within its first window despite continuous %s changes', async (change) => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    useAppStore.getState().updateNodeDataTransient('a', { output: '尚未保存的正文' });
    for (let step = 1; step < 4; step++) {
      await vi.advanceTimersByTimeAsync(500);
      useAppStore.setState({ nodes: [{ ...useAppStore.getState().nodes[0], ...(change === 'selection'
        ? { selected: step % 2 === 0 } : { position: { x: step * 10, y: step * 20 }, dragging: true }) }] });
    }
    await vi.advanceTimersByTimeAsync(499);
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
    expect(useAppStore.getState().nodes[0].data.output).toBe('尚未保存的正文');
  });

  it('merges continuous body and disk updates into the latest state at the original deadline', async () => {
    const saved: Array<{ output: string | undefined; diskWrites: number }> = [];
    let diskWrites = 0;
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent).mockImplementation(async () => {
      saved.push({ output: useAppStore.getState().nodes[0].data.output, diskWrites });
      return 'p1';
    });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    for (let version = 0; version < 5; version++) {
      if (version > 0) await vi.advanceTimersByTimeAsync(400);
      useAppStore.getState().updateNodeDataTransient('a', { output: `正文版本 ${version}` });
      diskWrites++;
      window.dispatchEvent(new Event(PROJECT_DISK_CHANGED_EVENT));
    }
    await vi.advanceTimersByTimeAsync(399);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([{ output: '正文版本 4', diskWrites: 5 }]);
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
  });

  it('clears the old project timer and opens a fresh window after a direct project switch', async () => {
    const saved: Array<{ projectId: string | null; output: string | undefined }> = [];
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent).mockImplementation(async () => {
      const state = useAppStore.getState();
      saved.push({ projectId: state.currentProjectId, output: state.nodes[0].data.output });
      return state.currentProjectId ?? undefined;
    });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.getState().updateNodeDataTransient('a', { output: '旧项目待保存' });
    await vi.advanceTimersByTimeAsync(500);
    useAppStore.setState({ currentProjectId: 'p2', nodes: [{ id: 'b', type: 'ai-text', position: { x: 0, y: 0 },
      data: { label: 'b', type: 'ai-text', output: '新项目原文' } }] });
    await vi.advanceTimersByTimeAsync(500);
    useAppStore.getState().updateNodeDataTransient('b', { output: '新项目改动' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([{ projectId: 'p2', output: '新项目改动' }]);
  });

  it.each(['startup-page', 'unmount'])('cancels a pending merge window on %s', async (change) => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    useAppStore.getState().updateNodeDataTransient('a', { output: '待保存的正文' });
    await vi.advanceTimersByTimeAsync(500);
    if (change === 'startup-page') useAppStore.setState({ currentProjectId: null });
    else { cleanup?.(); cleanup = undefined; }
    await vi.advanceTimersByTimeAsync(5000);
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it.each([[1, 5000], [2, 10000], [3, 20000], [4, 40000], [5, 60000], [6, 60000]])(
    'keeps failure %s on its %s ms retry deadline despite clicks and disk updates', async (count, delay) => {
      const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent).mockImplementation(async () => {
        useAppStore.setState({ autoSaveFailure: { kind: 'disk-full', reason: '磁盘已满', count,
          firstAt: 0, lastAt: Date.now(), lastNotifiedAt: 0 } });
        return undefined;
      });
      mount();
      await vi.advanceTimersByTimeAsync(0);
      useAppStore.getState().updateNodeDataTransient('a', { output: '待重试的正文' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(save).toHaveBeenCalledOnce();
      for (let elapsed = 1000; elapsed < delay; elapsed += 1000) {
        await vi.advanceTimersByTimeAsync(1000);
        useAppStore.setState({ nodes: [{ ...useAppStore.getState().nodes[0], selected: elapsed % 2000 === 0 }] });
        window.dispatchEvent(new Event(PROJECT_DISK_CHANGED_EVENT));
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(save).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(save).toHaveBeenCalledTimes(2);
    },
  );

  it('archives a parentId change even when the group member array is unchanged', async () => {
    useAppStore.setState({ groups: [{ id: 'g', name: '镜头', nodeIds: [], color: '#888', createdAt: 0 }] });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    useAppStore.setState({ nodes: [{ ...mediaNode(), parentId: 'g' }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(useAppStore.getState().nodes[0].data.filePath).toBe('D:/data/p1/镜头/a.png');
    expect(driver.finish).toHaveBeenCalled();
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(driver.finish.mock.invocationCallOrder[0]);
  });

  it('archives a group name change without relying on a group node data update', async () => {
    useAppStore.setState({
      nodes: [{ ...mediaNode(), parentId: 'g', data: { ...mediaNode().data, filePath: 'D:/data/p1/旧镜头/a.png' } }],
      groups: [{ id: 'g', name: '旧镜头', nodeIds: ['a'], color: '#888', createdAt: 0 }],
    });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.setState({ groups: [{ ...useAppStore.getState().groups[0], name: '新镜头' }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(useAppStore.getState().nodes[0].data.filePath).toBe('D:/data/p1/新镜头/a.png');
  });

  it('checks initial and reopened projects without writing a clean project', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pending).toHaveBeenCalledWith('p1');
    driver.pending.mockClear();
    useAppStore.setState({ currentProjectId: null });
    useAppStore.setState({ currentProjectId: 'p1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pending).toHaveBeenCalledWith('p1');
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('recovers a switched project after the previous project releases its IO slot', async () => {
    let release!: (moves: []) => void;
    driver.pending.mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pending).toHaveBeenCalledExactlyOnceWith('p1');
    const oldPath = 'D:/data/p2/old.png';
    const newPath = 'D:/data/p2/new.png';
    driver.pending.mockResolvedValueOnce([{ oldPath, newPath, projectId: 'p2', assetUrl: `asset://${newPath}`, relativePath: 'new.png' }]);
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent).mockResolvedValue('p2');
    useAppStore.setState({ currentProjectId: 'p2', nodes: [] });
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pending).toHaveBeenCalledWith('p2');
    expect(driver.finish).toHaveBeenCalledWith(oldPath, newPath, 'D:/data/p2');
  });

  it('still saves disk changes when the canvas signatures are unchanged', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    window.dispatchEvent(new Event(PROJECT_DISK_CHANGED_EVENT));
    await vi.advanceTimersByTimeAsync(2000);
    expect(driver.move).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
  });
});

describe('flushPendingAutoSave', () => {
  it('does not create a save or snapshot for a clean canvas', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    const snapshot = vi.spyOn(useAppStore.getState(), 'captureCurrentProjectSnapshot');
    expect(await flushPendingAutoSave('p1')).toBe(true);
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    expect(driver.pending).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(driver.waitForSaves).toHaveBeenCalledWith('p1');
  });

  it('shares one immediate commit among concurrent callers instead of waiting for the merge timer', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (id: string) => void;
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent)
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    useAppStore.getState().updateNodeDataTransient('a', { output: '全屏前的新正文' });
    const first = flushPendingAutoSave('p1');
    expect(flushPendingAutoSave('p1')).toBe(first);
    let settled = false;
    void first.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finish('p1');
    expect(await first).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledOnce();
  });

  it.each(['merge-pending', 'already-queued'])('waits for old and newer commits when the newer state is %s', async (stage) => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    let finishOld!: (id: string) => void;
    let finishNew!: (id: string) => void;
    const oldCommit = new Promise<string>((resolve) => { finishOld = resolve; });
    const newCommit = new Promise<string>((resolve) => { finishNew = resolve; });
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent)
      .mockReturnValueOnce(oldCommit).mockReturnValueOnce(newCommit);
    driver.waitForSaves.mockImplementationOnce(async () => (await Promise.all([oldCommit, newCommit])).every((id) => id === 'p1'));
    useAppStore.getState().updateNodeDataTransient('a', { output: '旧正文' });
    await vi.advanceTimersByTimeAsync(2000);
    useAppStore.getState().updateNodeDataTransient('a', { output: '新正文' });
    if (stage === 'already-queued') await vi.advanceTimersByTimeAsync(2000);
    const flushing = flushPendingAutoSave('p1');
    let settled = false;
    void flushing.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    finishOld('p1');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    finishNew('p1');
    expect(await flushing).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('waits for a manual save even when the automatic-save baseline is clean', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (saved: boolean) => void;
    driver.waitForSaves.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const flushing = flushPendingAutoSave('p1');
    let settled = false;
    void flushing.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    finish(false);
    expect(await flushing).toBe(false);
  });

  it('does not consume the failure backoff when a preview requests a flush', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent).mockImplementationOnce(async () => {
      useAppStore.setState({ autoSaveFailure: { kind: 'disk-full', reason: '磁盘已满', count: 1,
        firstAt: Date.now(), lastAt: Date.now(), lastNotifiedAt: Date.now() } });
      return undefined;
    });
    useAppStore.getState().updateNodeDataTransient('a', { output: '保存失败的正文' });
    expect(await flushPendingAutoSave('p1')).toBe(false);
    expect(await flushPendingAutoSave('p1')).toBe(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it.each(['body', 'disk'])('leaves %s changes arriving during a flush on their existing timer', async (change) => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (id: string) => void;
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent)
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    useAppStore.getState().updateNodeDataTransient('a', { output: '刷新开始时的正文' });
    const flushing = flushPendingAutoSave('p1');
    await vi.advanceTimersByTimeAsync(0);
    if (change === 'body') useAppStore.getState().updateNodeDataTransient('a', { output: '等待时新增的正文' });
    else window.dispatchEvent(new Event(PROJECT_DISK_CHANGED_EVENT));
    finish('p1');
    expect(await flushing).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it.each(['project-switch', 'unmount'])('does not approve a preview after %s during commit', async (change) => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (id: string) => void;
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent)
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    useAppStore.getState().updateNodeDataTransient('a', { output: '待提交正文' });
    const flushing = flushPendingAutoSave('p1');
    await vi.advanceTimersByTimeAsync(0);
    if (change === 'project-switch') useAppStore.setState({ currentProjectId: 'p2' });
    else { cleanup?.(); cleanup = undefined; }
    finish('p1');
    expect(await flushing).toBe(false);
  });

  it('preserves a dirty baseline when the same effect is replayed', async () => {
    mountAutoSave();
    const effect = driver.effects.pop()!;
    cleanup = effect() || undefined;
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.getState().updateNodeDataTransient('a', { output: '重放前未保存的正文' });
    cleanup?.();
    cleanup = effect() || undefined;
    expect(await flushPendingAutoSave('p1')).toBe(true);
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
  });

  it('keeps the current flush owner when an older effect cleans up later', async () => {
    mount();
    const oldCleanup = cleanup;
    mount();
    oldCleanup?.();
    expect(await flushPendingAutoSave('p1')).toBe(true);
  });

  it('fails closed without a live owner or for another project', async () => {
    expect(await flushPendingAutoSave('p1')).toBe(false);
    mount();
    expect(await flushPendingAutoSave('p2')).toBe(false);
    useAppStore.setState({ projectLoadStatus: 'loading' });
    expect(await flushPendingAutoSave('p1')).toBe(false);
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });
});
