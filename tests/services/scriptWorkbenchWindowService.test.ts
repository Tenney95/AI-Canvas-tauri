import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptWorkbenchRequest, ScriptWorkbenchSnapshot } from '../../src/types/scriptWorkbench';
import type { ProjectWindowContext } from '../../src/types/projectWindow';

const events = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  emitTo: vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: events.emitTo,
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    const listeners = events.listeners.get(name) ?? new Set();
    listeners.add(callback);
    events.listeners.set(name, listeners);
    return () => { listeners.delete(callback); };
  },
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    static getByLabel = async () => null;
    once = async (name: string, callback: () => void) => {
      if (name === 'tauri://created') queueMicrotask(callback);
      return () => {};
    };
    destroy = async () => {};
  },
}));

import { connectScriptWorkbenchWindow, createScriptWorkbenchWindowHost } from '../../src/services/scriptWorkbenchWindowService';

const cleanups: Array<() => void> = [];
const deliver = (name: string, payload: unknown) => {
  for (const listener of events.listeners.get(name) ?? []) listener({ payload });
};
const context: ProjectWindowContext = { schemaVersion: 2,
  target: { kind: 'episode', schemaVersion: 2, modelGeneration: 0, runtimeEpoch: 'test-runtime', projectId: 'series', projectEpoch: 0, episodeId: 'episode-b', episodeRevision: 0 },
  canvas: { kind: 'canvas', schemaVersion: 2, modelGeneration: 0, runtimeEpoch: 'test-runtime', projectId: 'series', projectEpoch: 0,
    canvasId: 'episode-a', episodeId: 'episode-a', canvasEpoch: 0, canvasRevision: 1 } };
const frame = (sessionId: string, revision: number) => ({ sessionId, revision, schemaVersion: 2,
  windowContext: context, currentEpisode: { id: 'episode-b' }, canvasProjectId: 'episode-a' }) as ScriptWorkbenchSnapshot;
const requestSequences = new Map<string, number>();
const deliverRequest = (request: ScriptWorkbenchRequest) => {
  if (!requestSequences.has(request.requestId)) requestSequences.set(request.requestId, requestSequences.size + 1);
  const stamped = { ...request, schemaVersion: 2, sequence: requestSequences.get(request.requestId), windowContext: context };
  deliver('script-workbench:request', stamped);
  return stamped;
};

beforeEach(() => {
  events.listeners.clear();
  requestSequences.clear();
  events.emitTo.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe('独立工作台客户端协议', () => {
  it('先安装状态/响应监听再握手，忽略其他会话与过期快照', async () => {
    events.emitTo.mockImplementation(async (_target, event) => {
      if (event === 'script-workbench:hello') {
        expect(events.listeners.get('script-workbench:state')?.size).toBe(1);
        expect(events.listeners.get('script-workbench:response')?.size).toBe(1);
      }
    });
    const onSnapshot = vi.fn();
    const bridge = await connectScriptWorkbenchWindow('session-workbench', onSnapshot);
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('different-session', 5));
    deliver('script-workbench:state', frame('session-workbench', 2));
    deliver('script-workbench:state', frame('session-workbench', 1));
    deliver('script-workbench:state', frame('session-workbench', 2));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });

  it('将最后一次草稿随保存请求交接，只有匹配会话与请求的回复才能完成保存', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-handoff', vi.fn());
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('session-handoff', 3));
    const handoff = { episodeId: 'episode-b', sequence: 7, draft: { outline: '集纲', script: '最后输入',
      creative: { task: '', coreConflict: '', openingHook: '', reversal: '', endingHook: '', beats: '',
        targetDurationSec: '90', sourceRange: '' } } };
    const saving = bridge.request({ revision: 3, episodeId: 'episode-b', action: { type: 'save' }, handoff });
    const sent = events.emitTo.mock.calls.find((call) => call[1] === 'script-workbench:request')?.[2] as ScriptWorkbenchRequest;
    expect(sent).toMatchObject({ sessionId: 'session-handoff', episodeId: 'episode-b', handoff });
    let completed = false;
    void saving.then(() => { completed = true; }, () => {});
    deliver('script-workbench:response', { sessionId: 'different-session', requestId: sent.requestId, sequence: sent.sequence, value: true });
    await Promise.resolve();
    expect(completed).toBe(false);
    deliver('script-workbench:response', { sessionId: 'session-handoff', requestId: sent.requestId, sequence: sent.sequence, value: true });
    await expect(saving).resolves.toBe(true);
  });

  it('传递主窗口保存错误，断开时取消未完成请求并清理监听', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-errors', vi.fn());
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('session-errors', 1));
    const failed = bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'save' } });
    const sent = events.emitTo.mock.calls.find((call) => call[1] === 'script-workbench:request')?.[2] as ScriptWorkbenchRequest;
    const failure = expect(failed).rejects.toThrow('原分集已变化');
    deliver('script-workbench:response', { sessionId: 'session-errors', requestId: sent.requestId, sequence: sent.sequence, error: '原分集已变化' });
    await failure;
    const pending = bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'flush_draft' } });
    const canceled = expect(pending).rejects.toThrow('工作台窗口已关闭');
    bridge.dispose();
    await canceled;
    expect([...events.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await expect(bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'save' } })).rejects.toThrow('尚未连接');
  });

  it('请求保留原 revision 的目标，切换后迟到结果不能被当作新分集结果', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-late-result', vi.fn());
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('session-late-result', 1));
    const reading = bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'read_source', part: 'script' } });
    const rejected = expect(reading).rejects.toThrow('目标已切换');
    const sent = events.emitTo.mock.calls.find((call) => call[1] === 'script-workbench:request')?.[2] as ScriptWorkbenchRequest;
    deliver('script-workbench:state', { ...frame('session-late-result', 2), windowContext: { ...context,
      target: { ...context.target, episodeId: 'episode-c' } } });
    expect(sent.windowContext).toEqual(context);
    deliver('script-workbench:response', { sessionId: 'session-late-result', requestId: sent.requestId, sequence: sent.sequence, value: '旧结果' });
    await rejected;
    expect(events.emitTo.mock.calls.filter((call) => call[1] === 'script-workbench:request')).toHaveLength(1);
  });
});

describe('关系图宿主写入边界', () => {
  function graphFrame(revision: number): ScriptWorkbenchSnapshot {
    return { ...frame('graph-host-session', 0), episodes: [], pendingAction: null, draftVersion: 0,
      series: { id: 'series', name: '剧集', hasScript: true, hasOriginal: false },
      storyGraphView: { schemaVersion: 1, id: 'graph', revision, nodes: [], edges: [], positions: {},
        counts: { totalNodes: 0, totalEdges: 0, matchedNodes: 0, matchedEdges: 0, visibleNodes: 0, visibleEdges: 0, truncated: false } } };
  }

  it.each(['valid-b', 'legacy', 'future', 'canvas', 'episode', 'epoch'] as const)('通用保存 RPC 检查 %s 边界', async (boundary) => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let current = graphFrame(1);
    const onRequest = vi.fn(async () => true);
    let respond!: (value: { error?: string; value?: unknown }) => void;
    const replied = new Promise<{ error?: string; value?: unknown }>((resolve) => { respond = resolve; });
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', { sessionId: 'graph-host-session' });
      if (event === 'script-workbench:response') respond(payload as { error?: string });
    });
    const host = createScriptWorkbenchWindowHost({ sessionId: 'graph-host-session', getSnapshot: () => current,
      onRequest, onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    await host.open();
    if (boundary === 'canvas') current = { ...current, canvasProjectId: 'episode-c', windowContext: { ...context,
      canvas: { ...context.canvas!, canvasId: 'episode-c', episodeId: 'episode-c' } } };
    if (boundary === 'episode') current = { ...current, currentEpisode: { ...current.currentEpisode!, id: 'episode-c' }, windowContext: { ...context,
      target: { ...context.target, episodeId: 'episode-c' } } as ProjectWindowContext };
    if (boundary === 'epoch') current = { ...current, windowContext: { ...context,
      target: { ...context.target, projectEpoch: 1 } } as ProjectWindowContext };
    const request: ScriptWorkbenchRequest = { sessionId: 'graph-host-session', requestId: 'save_scope_boundary', revision: 1,
      episodeId: 'episode-b', action: { type: 'save' }, schemaVersion: 2, sequence: 1, windowContext: context };
    deliver('script-workbench:request', { ...request, schemaVersion: boundary === 'legacy' ? undefined : boundary === 'future' ? 3 : 2 });
    const response = await replied;
    if (boundary === 'valid-b') { expect(response.value).toBe(true); expect(onRequest).toHaveBeenCalledWith(request); }
    else { expect(response.error).toContain('窗口上下文已变化'); expect(onRequest).not.toHaveBeenCalled(); }
  });

  it('拒绝从旧图快照发起的写入，不进入主窗口执行器', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let current = graphFrame(1);
    const onRequest = vi.fn(async () => true);
    let response!: (value: { error?: string }) => void;
    const replied = new Promise<{ error?: string }>((resolve) => { response = resolve; });
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', { sessionId: 'graph-host-session' });
      if (event === 'script-workbench:response') response(payload as { error?: string });
    });
    const host = createScriptWorkbenchWindowHost({ sessionId: 'graph-host-session', getSnapshot: () => current,
      onRequest, onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    await host.open();
    current = graphFrame(2);
    await host.publish();
    deliverRequest({ sessionId: 'graph-host-session', requestId: 'old_graph_write_001', revision: 1,
      episodeId: 'episode-b', action: { type: 'story_graph_patch', patch: { graphId: 'graph', positions: {} }, expectedRevision: 1 } });
    expect((await replied).error).toContain('确认内容已变化');
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('同一付费提取请求只执行一次，且等待主窗口完成后才确认', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let finish!: () => void;
    let markStarted!: () => void;
    let reply!: (value: { value?: unknown }) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const persisted = new Promise<void>((resolve) => { finish = resolve; });
    const replied = new Promise<{ value?: unknown }>((resolve) => { reply = resolve; });
    const onRequest = vi.fn(async () => { markStarted(); await persisted; return true; });
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', { sessionId: 'graph-host-session' });
      if (event === 'script-workbench:response') reply(payload as { value?: unknown });
    });
    const host = createScriptWorkbenchWindowHost({ sessionId: 'graph-host-session', getSnapshot: () => graphFrame(1),
      onRequest, onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    await host.open();
    const request: ScriptWorkbenchRequest = { sessionId: 'graph-host-session', requestId: 'extract_graph_001', revision: 1,
      episodeId: 'episode-b', action: { type: 'story_graph_extract', request: { episodeIds: ['episode-b'], parts: ['script'], modelId: 'text-model' } } };
    const stamped = deliverRequest(request);
    deliverRequest(request);
    await started;
    expect(events.emitTo.mock.calls.some((call) => call[1] === 'script-workbench:response')).toBe(false);
    finish();
    expect((await replied).value).toBe(true);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith(stamped);
  });

  it.each(['epoch', 'run'] as const)('拒绝旧 %s 快照对空图或新提取的操作', async (boundary) => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let current = { ...graphFrame(0), storyGraphExtraction: { status: 'running' as const, runId: 'run-before', completed: 0, total: 1 } };
    const onRequest = vi.fn(async () => true);
    let respond!: (value: { error?: string }) => void;
    const replied = new Promise<{ error?: string }>((resolve) => { respond = resolve; });
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', { sessionId: 'graph-host-session' });
      if (event === 'script-workbench:response') respond(payload as { error?: string });
    });
    const host = createScriptWorkbenchWindowHost({ sessionId: 'graph-host-session', getSnapshot: () => current,
      onRequest, onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    await host.open();
    current = boundary === 'epoch' ? { ...current, series: { ...current.series!, exchangeEpoch: 1 } }
      : { ...current, storyGraphExtraction: { ...current.storyGraphExtraction, runId: 'run-after' } };
    await host.publish();
    const action: ScriptWorkbenchRequest['action'] = boundary === 'epoch'
      ? { type: 'story_graph_patch', expectedRevision: 0, patch: { graphId: 'graph', positions: {} } }
      : { type: 'story_graph_cancel', runId: 'run-before' };
    deliverRequest({ sessionId: 'graph-host-session', requestId: 'old_boundary_request', revision: 1, episodeId: 'episode-b', action });
    expect((await replied).error).toContain('确认内容已变化');
    expect(onRequest).not.toHaveBeenCalled();
  });
});
