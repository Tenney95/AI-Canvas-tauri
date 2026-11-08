import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptWorkbenchRequest, ScriptWorkbenchSnapshot } from '../../src/types/scriptWorkbench';
import type { ProjectWindowContext } from '../../src/types/projectWindow';

const events = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  emitTo: vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>(),
  nativeWindow: null as object | null,
  lookupGate: undefined as Promise<void> | undefined,
  onLookup: undefined as (() => void) | undefined,
  destroyGate: undefined as Promise<void> | undefined,
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
    private destroyed = new Set<() => void>();
    constructor(_label: string, _options: unknown) { events.nativeWindow = this; }
    static getByLabel = async () => { events.onLookup?.(); await events.lookupGate; return events.nativeWindow; };
    show = async () => {};
    unminimize = async () => {};
    setFocus = async () => {};
    once = async (name: string, callback: () => void) => {
      if (name === 'tauri://created') queueMicrotask(callback);
      if (name === 'tauri://destroyed') this.destroyed.add(callback);
      return () => { this.destroyed.delete(callback); };
    };
    destroy = async () => {
      if (events.nativeWindow === this) events.nativeWindow = null;
      for (const callback of this.destroyed) callback();
      await events.destroyGate;
    };
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
const clientWindowSession = 'window-client-session';
const frame = (sessionId: string, revision: number) => ({ sessionId, windowSessionId: clientWindowSession, revision, schemaVersion: 2,
  windowContext: context, currentEpisode: { id: 'episode-b' }, canvasProjectId: 'episode-a' }) as ScriptWorkbenchSnapshot;
const requestSequences = new Map<string, number>();
const latestHostFrame = () => events.emitTo.mock.calls.filter((call) => call[1] === 'script-workbench:state').at(-1)![2] as ScriptWorkbenchSnapshot;
const deliverRequest = (request: ScriptWorkbenchRequest) => {
  if (!requestSequences.has(request.requestId)) requestSequences.set(request.requestId, requestSequences.size + 1);
  const stamped = { ...request, windowSessionId: request.windowSessionId ?? latestHostFrame().windowSessionId,
    schemaVersion: 2, sequence: request.sequence ?? requestSequences.get(request.requestId), windowContext: context };
  deliver('script-workbench:request', stamped);
  return stamped;
};

beforeEach(() => {
  events.listeners.clear();
  events.nativeWindow = null;
  events.lookupGate = undefined; events.onLookup = undefined; events.destroyGate = undefined;
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
    const bridge = await connectScriptWorkbenchWindow('session-workbench', onSnapshot, clientWindowSession);
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('different-session', 5));
    deliver('script-workbench:state', { ...frame('session-workbench', 8), windowSessionId: 'old-window-session' });
    deliver('script-workbench:state', frame('session-workbench', 2));
    deliver('script-workbench:state', frame('session-workbench', 1));
    deliver('script-workbench:state', frame('session-workbench', 2));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });

  it('将最后一次草稿随保存请求交接，只有匹配会话与请求的回复才能完成保存', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-handoff', vi.fn(), clientWindowSession);
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
    deliver('script-workbench:response', { sessionId: 'different-session', windowSessionId: clientWindowSession, requestId: sent.requestId, sequence: sent.sequence, value: true });
    await Promise.resolve();
    expect(completed).toBe(false);
    deliver('script-workbench:response', { sessionId: 'session-handoff', windowSessionId: 'old-window-session', requestId: sent.requestId, sequence: sent.sequence, value: true });
    await Promise.resolve();
    expect(completed).toBe(false);
    deliver('script-workbench:response', { sessionId: 'session-handoff', windowSessionId: clientWindowSession, requestId: sent.requestId, sequence: sent.sequence, value: true });
    await expect(saving).resolves.toBe(true);
  });

  it('传递主窗口保存错误，断开时取消未完成请求并清理监听', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-errors', vi.fn(), clientWindowSession);
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('session-errors', 1));
    const failed = bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'save' } });
    const sent = events.emitTo.mock.calls.find((call) => call[1] === 'script-workbench:request')?.[2] as ScriptWorkbenchRequest;
    const failure = expect(failed).rejects.toThrow('原分集已变化');
    deliver('script-workbench:response', { sessionId: 'session-errors', windowSessionId: clientWindowSession, requestId: sent.requestId, sequence: sent.sequence, error: '原分集已变化' });
    await failure;
    const pending = bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'flush_draft' } });
    const canceled = expect(pending).rejects.toThrow('工作台窗口已关闭');
    bridge.dispose();
    await canceled;
    expect([...events.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await expect(bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'save' } })).rejects.toThrow('尚未连接');
  });

  it('同一真实窗口重连沿主窗口已接受序号继续，不从零复用旧请求', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-reconnect', vi.fn(), clientWindowSession);
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', { ...frame('session-reconnect', 8), acceptedRequestSequence: 53 });
    const operation = bridge.request({ revision: 8, episodeId: 'episode-b', action: { type: 'save' } });
    const sent = events.emitTo.mock.calls.find((call) => call[1] === 'script-workbench:request')![2] as ScriptWorkbenchRequest;
    expect(sent.sequence).toBe(54);
    deliver('script-workbench:response', { sessionId: sent.sessionId, windowSessionId: clientWindowSession,
      requestId: sent.requestId, sequence: 54, value: true });
    await expect(operation).resolves.toBe(true);
  });

  it('请求保留原 revision 的目标，切换后迟到结果不能被当作新分集结果', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-late-result', vi.fn(), clientWindowSession);
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('session-late-result', 1));
    const reading = bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'read_source', part: 'script' } });
    const rejected = expect(reading).rejects.toThrow('目标已切换');
    const sent = events.emitTo.mock.calls.find((call) => call[1] === 'script-workbench:request')?.[2] as ScriptWorkbenchRequest;
    deliver('script-workbench:state', { ...frame('session-late-result', 2), windowContext: { ...context,
      target: { ...context.target, episodeId: 'episode-c' } } });
    expect(sent.windowContext).toEqual(context);
    deliver('script-workbench:response', { sessionId: 'session-late-result', windowSessionId: clientWindowSession, requestId: sent.requestId, sequence: sent.sequence, value: '旧结果' });
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

  it('关闭取消仍在查询原生窗口的打开操作，不创建迟到窗口', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let release!: () => void;
    let markLookup!: () => void;
    const lookedUp = new Promise<void>((resolve) => { markLookup = resolve; });
    events.lookupGate = new Promise<void>((resolve) => { release = resolve; });
    events.onLookup = markLookup;
    const host = createScriptWorkbenchWindowHost({ sessionId: 'graph-host-session', getSnapshot: () => graphFrame(1),
      onRequest: vi.fn(async () => true), onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    const opening = host.open();
    const canceled = expect(opening).rejects.toThrow('打开已取消');
    await lookedUp; await host.close(); release();
    await canceled;
    expect(events.nativeWindow).toBeNull();
    expect(events.emitTo).not.toHaveBeenCalled();
  });

  it('旧窗口销毁返回迟到时仍保留重开窗口的销毁句柄', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', payload);
    });
    const host = createScriptWorkbenchWindowHost({ sessionId: 'graph-host-session', getSnapshot: () => graphFrame(1),
      onRequest: vi.fn(async () => true), onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    await host.open();
    let finishDestroy!: () => void;
    events.destroyGate = new Promise<void>((resolve) => { finishDestroy = resolve; });
    const closing = host.close();
    expect(events.nativeWindow).toBeNull();
    await host.open();
    const reopened = events.nativeWindow;
    expect(reopened).not.toBeNull();
    finishDestroy(); await closing;
    events.destroyGate = undefined;
    await host.close();
    expect(events.nativeWindow).toBeNull();
  });

  it('同一业务会话重开窗口后接受序号 1，并拒绝原窗口握手、关闭和 RPC', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const onRequest = vi.fn(async (_request: ScriptWorkbenchRequest) => true);
    let reply!: () => void;
    let response = new Promise<void>((resolve) => { reply = resolve; });
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', payload);
      if (event === 'script-workbench:response') reply();
    });
    const host = createScriptWorkbenchWindowHost({ sessionId: 'graph-host-session', getSnapshot: () => graphFrame(1),
      onRequest, onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    await host.open();
    const original = latestHostFrame();
    const oldRequest = deliverRequest({ sessionId: original.sessionId, requestId: 'old_window_request', revision: original.revision,
      episodeId: 'episode-b', sequence: 41, action: { type: 'save' } });
    await response;
    await host.close();
    await host.open();
    const reopened = latestHostFrame();
    expect(reopened.sessionId).toBe(original.sessionId);
    expect(reopened.windowSessionId).not.toBe(original.windowSessionId);
    const publicationCount = events.emitTo.mock.calls.filter((call) => call[1] === 'script-workbench:state').length;
    deliver('script-workbench:hello', original);
    deliver('script-workbench:early-close', original);
    deliver('script-workbench:request', { ...oldRequest, requestId: 'late_old_request', revision: reopened.revision, sequence: 42 });
    await Promise.resolve();
    expect(events.emitTo.mock.calls.filter((call) => call[1] === 'script-workbench:state')).toHaveLength(publicationCount);
    expect(events.nativeWindow).not.toBeNull();
    response = new Promise<void>((resolve) => { reply = resolve; });
    deliverRequest({ sessionId: reopened.sessionId, requestId: 'new_window_first', revision: reopened.revision,
      episodeId: 'episode-b', sequence: 1, action: { type: 'save' } });
    await response;
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(onRequest.mock.calls[1][0]).toMatchObject({ sequence: 1, windowSessionId: reopened.windowSessionId });
  });

  it('旧窗口已开始操作的迟到结果不能向重开窗口回复或触发收回', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let finish!: () => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const onRequest = vi.fn(async () => { start(); await settled; return true; });
    const onReplySent = vi.fn();
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', payload);
    });
    const host = createScriptWorkbenchWindowHost({ sessionId: 'graph-host-session', getSnapshot: () => graphFrame(1),
      onRequest, onReplySent, onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    await host.open();
    const original = latestHostFrame();
    deliverRequest({ sessionId: original.sessionId, requestId: 'pending_old_window', revision: original.revision,
      episodeId: 'episode-b', action: { type: 'save' } });
    await started;
    await host.close(); await host.open();
    finish(); await settled;
    // 只排空该 Promise 回调链，不使用计时或运行应用。
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(events.emitTo.mock.calls.filter((call) => call[1] === 'script-workbench:response')).toHaveLength(0);
    expect(onReplySent).not.toHaveBeenCalled();
  });

  it.each(['valid-b', 'legacy', 'future', 'canvas', 'episode', 'epoch'] as const)('通用保存 RPC 检查 %s 边界', async (boundary) => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let current = graphFrame(1);
    const onRequest = vi.fn(async () => true);
    let respond!: (value: { error?: string; value?: unknown }) => void;
    const replied = new Promise<{ error?: string; value?: unknown }>((resolve) => { respond = resolve; });
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', payload);
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
    const request: ScriptWorkbenchRequest = { sessionId: 'graph-host-session', windowSessionId: latestHostFrame().windowSessionId, requestId: 'save_scope_boundary', revision: 1,
      episodeId: 'episode-b', action: { type: 'save' }, schemaVersion: 2, sequence: 1, windowContext: context };
    deliver('script-workbench:request', { ...request, schemaVersion: boundary === 'legacy' ? undefined : boundary === 'future' ? 3 : 2 });
    const response = await replied;
    if (boundary === 'valid-b') { expect(response.value).toBe(true); expect(onRequest).toHaveBeenCalledWith(request); }
    else { expect(response.error).toContain('窗口上下文已变化'); expect(onRequest).not.toHaveBeenCalled(); }
  });

  it.each(['save', 'close', 'dock'] as const)('原生 JSON 重排键后 %s 请求与末次草稿仍可往返', async (action) => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const nativeRoundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : entry
    )));
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      deliver(event, nativeRoundTrip(payload));
      if (event === 'script-workbench:state') deliver('script-workbench:ready', nativeRoundTrip(payload));
    });
    const onRequest = vi.fn(async () => true);
    const host = createScriptWorkbenchWindowHost({ sessionId: 'native-order-session', getSnapshot: () => graphFrame(1),
      onRequest, onDetachedChange: vi.fn() });
    cleanups.push(host.dispose);
    await host.open();
    let received!: () => void;
    const firstSnapshot = new Promise<void>((resolve) => { received = resolve; });
    const bridge = await connectScriptWorkbenchWindow('native-order-session', () => received(), latestHostFrame().windowSessionId!);
    cleanups.push(bridge.dispose);
    await firstSnapshot;
    const handoff = { episodeId: 'episode-b', sequence: 1, windowContext: context,
      draft: { outline: '集纲', script: '未保存的最后输入', creative: { task: '', coreConflict: '', openingHook: '',
        reversal: '', endingHook: '', beats: '', targetDurationSec: '90', sourceRange: '' } } };
    await expect(bridge.request({ revision: latestHostFrame().revision, episodeId: 'episode-b', action: { type: action }, handoff })).resolves.toBe(true);
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ action: { type: action }, handoff }));
  });

  it('拒绝从旧图快照发起的写入，不进入主窗口执行器', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let current = graphFrame(1);
    const onRequest = vi.fn(async () => true);
    let response!: (value: { error?: string }) => void;
    const replied = new Promise<{ error?: string }>((resolve) => { response = resolve; });
    events.emitTo.mockImplementation(async (_target, event, payload) => {
      if (event === 'script-workbench:state') deliver('script-workbench:ready', payload);
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
      if (event === 'script-workbench:state') deliver('script-workbench:ready', payload);
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
      if (event === 'script-workbench:state') deliver('script-workbench:ready', payload);
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
