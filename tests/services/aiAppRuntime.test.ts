/**
 * aiAppRuntime — 回归测试：AI app host runtime。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAppDefinition, AiAppJson, AiAppReference, AiAppUiSession } from '../../src/types/aiApp';

const mocks = vi.hoisted(() => ({
  state: vi.fn(), subscribe: vi.fn(), node: vi.fn(), resources: vi.fn(), load: vi.fn(),
  save: vi.fn(), image: vi.fn(), context: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: mocks.state, subscribe: mocks.subscribe } }));
vi.mock('../../src/services/aiApps/aiAppService', () => ({
  getAiAppNode: mocks.node, captureAiAppResources: mocks.resources, loadAiAppDefinition: mocks.load,
  saveAiAppState: mocks.save, readAiAppImage: mocks.image, assertAiAppContext: mocks.context,
}));
vi.mock('../../src/services/fs/projectFiles', () => ({ assertProjectFileReference: vi.fn() }));

import { createAiAppUiSession, runAiAppAction } from '../../src/services/aiApps/aiAppRuntime';

const channel = 'ai-canvas-app-v1';
const definition: AiAppDefinition = {
  version: 1, title: '素材检查', description: '检查素材', html: '<p>检查</p>', css: '',
  code: 'app.registerAction("scan", (input) => input);',
  actions: [{ id: 'scan', title: '检查', inputSchema: { type: 'object', additionalProperties: true } }],
};
interface Frame {
  postMessage: ReturnType<typeof vi.fn>;
  outgoing: Array<Record<string, unknown>>;
}
interface HiddenFrame {
  contentWindow: Frame;
  hidden: boolean;
  sandbox: { add: ReturnType<typeof vi.fn> };
  src: string;
  referrerPolicy: string;
  title: string;
  remove: ReturnType<typeof vi.fn>;
}
let app: AiAppReference;
let revision: number;
let projectId: string;
let exchangeEpoch: number;
let nodes: Array<{ id: string }>;
let fingerprint: string;
let sessions: AiAppUiSession[];
let messages: Set<(event: MessageEvent) => void>;
let subscribers: Set<() => void>;
let hiddenFrames: HiddenFrame[];
let autoRun: boolean;
let computed: ReturnType<typeof vi.fn>;

function emit(frame: Frame, src: string, data: Record<string, unknown>, source: unknown = frame) {
  for (const listener of messages) listener({ source, data: { channel, sessionId: src.split('#')[1], ...data } } as MessageEvent);
}
function frame(src: string): Frame {
  const outgoing: Array<Record<string, unknown>> = [];
  const value: Frame = { outgoing, postMessage: vi.fn((data: Record<string, unknown>) => {
    outgoing.push(data);
    if (autoRun && data.kind === 'run') queueMicrotask(() => emit(value, src, { kind: 'result', requestId: data.requestId, value: { selected: data.input } }));
  }) };
  return value;
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function create() {
  const onChange = vi.fn();
  const session = await createAiAppUiSession({ nodeId: 'app-node', onChange });
  sessions.push(session);
  const view = frame(session.src);
  session.attach(view as unknown as Window);
  return { session, view, onChange };
}
async function ready() {
  const host = await create();
  emit(host.view, host.session.src, { kind: 'ready' });
  emit(host.view, host.session.src, { kind: 'initialized' });
  await flush();
  return host;
}
async function run(host: Awaited<ReturnType<typeof create>>, result: AiAppJson = { count: 1 }) {
  const promise = host.session.run('scan', {});
  await flush();
  const request = host.view.outgoing.findLast((data) => data.kind === 'run')!;
  emit(host.view, host.session.src, { kind: 'result', requestId: request.requestId, value: result });
  return promise;
}
function changed() { for (const subscriber of [...subscribers]) subscriber(); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  revision = 3;
  projectId = 'project-1';
  exchangeEpoch = 0;
  nodes = [{ id: 'app-node' }, { id: 'source-1' }];
  fingerprint = 'resources-1';
  sessions = [];
  messages = new Set();
  subscribers = new Set();
  hiddenFrames = [];
  autoRun = false;
  app = {
    version: 1, instanceId: 'app-node', definition: { relativePath: `ai-apps/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), bytes: 512 },
    title: definition.title, description: definition.description, revision: 1,
    actions: definition.actions, inputNodeIds: ['source-1'], savedState: { count: 0 },
  };
  mocks.state.mockImplementation(() => ({ currentProjectId: projectId, projects: [{ id: projectId, exchangeEpoch }], nodes, getCurrentRevision: () => revision }));
  mocks.node.mockImplementation((nodeId: string, expectedProject = projectId) => {
    if (projectId !== expectedProject || !nodes.some((node) => node.id === nodeId)) throw new Error('节点或项目已失效');
    return { app: structuredClone(app), projectId };
  });
  mocks.resources.mockImplementation(() => ({ fingerprint, snapshots: [{ nodeId: 'source-1', text: '分镜 1' }] }));
  mocks.load.mockResolvedValue(structuredClone(definition));
  mocks.image.mockResolvedValue('data:image/png;base64,verified');
  mocks.context.mockImplementation((context: { projectId: string; baseRevision?: number; signal?: AbortSignal }) => {
    context.signal?.throwIfAborted();
    if (context.projectId !== projectId || (context.baseRevision !== undefined && context.baseRevision !== revision)) throw new Error('目标画布已变化');
  });
  mocks.subscribe.mockImplementation((subscriber: () => void) => {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  });
  mocks.save.mockImplementation((_nodeId: string, state: AiAppJson, result: AiAppJson | undefined, expectedRevision: number) => {
    if (app.revision !== expectedRevision) throw new Error('版本已变化');
    app = { ...app, revision: app.revision + 1, savedState: state, ...(result === undefined ? {} : { savedResult: result }) };
    revision += 1;
    changed();
  });
  computed = vi.fn((name: string) => name === '--theme-surface' ? 'rgb(20, 21, 22)' : name === '--theme-text' ? 'rgb(230, 231, 232)' : '');
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: computed }));
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') messages.add(listener); },
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') messages.delete(listener); },
  });
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ hidden: false, sandbox: { add: vi.fn() }, referrerPolicy: '', src: '', title: '', remove: vi.fn(), contentWindow: null }),
    body: { appendChild: (element: HiddenFrame) => {
      element.contentWindow = frame(element.src);
      hiddenFrames.push(element);
      queueMicrotask(() => {
        emit(element.contentWindow, element.src, { kind: 'ready' });
        emit(element.contentWindow, element.src, { kind: 'initialized' });
      });
    } },
  });
});
afterEach(() => {
  sessions.forEach((session) => session.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AI app host runtime', () => {
  it('requires the attached source, channel, session and ordered ready handshake', async () => {
    const host = await create();
    emit(host.view, host.session.src, { kind: 'ready' }, {});
    emit(host.view, host.session.src, { kind: 'ready', channel: 'other' });
    emit(host.view, host.session.src, { kind: 'ready', sessionId: 'forged' });
    expect(host.view.outgoing).toEqual([]);
    emit(host.view, host.session.src, { kind: 'ready' });
    expect(host.view.outgoing.find((data) => data.kind === 'init')).toMatchObject({ definition, state: { count: 0 }, inputs: [{ nodeId: 'source-1', text: '分镜 1' }] });
    emit(host.view, host.session.src, { kind: 'initialized' });
    expect(await run(host)).toEqual({ count: 1 });
    emit(host.view, host.session.src, { kind: 'ready' });
    await flush();
    expect(messages.size).toBe(0);
    expect(subscribers.size).toBe(0);
    await expect(host.session.run('scan')).rejects.toThrow('关闭');
  });

  it('rejects initialized before ready and does not accept replacement frame identities', async () => {
    const early = await create();
    emit(early.view, early.session.src, { kind: 'initialized' });
    await flush();
    expect(early.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false, error: expect.any(String) }));
    const host = await ready();
    host.session.attach(host.view as unknown as Window);
    expect(subscribers.size).toBe(1);
    host.session.attach(frame(host.session.src) as unknown as Window);
    expect(subscribers.size).toBe(0);
    await expect(host.session.run('scan')).rejects.toThrow('关闭');
  });

  it('returns read-only action results without persisting temporary state', async () => {
    const host = await ready();
    emit(host.view, host.session.src, { kind: 'state', value: { count: 4 } });
    expect(await run(host, { missing: ['image-1'] })).toEqual({ missing: ['image-1'] });
    expect(app.savedState).toEqual({ count: 0 });
    expect(app.savedResult).toBeUndefined();
    expect(mocks.save).not.toHaveBeenCalled();
    await expect(host.session.run('unknown')).rejects.toThrow('未声明');
    await expect(host.session.run('scan', 'invalid')).rejects.toThrow('参数无效');
  });

  it('uses the same action path headlessly and removes its hidden runner after completion', async () => {
    autoRun = true;
    expect(await runAiAppAction('app-node', 'scan', { selected: true }, { projectId, baseRevision: revision })).toEqual({ selected: { selected: true } });
    expect(hiddenFrames).toHaveLength(1);
    const hidden = hiddenFrames[0];
    expect(hidden).toMatchObject({ hidden: true, referrerPolicy: 'no-referrer' });
    expect(hidden.sandbox.add).toHaveBeenCalledExactlyOnceWith('allow-scripts');
    expect(hidden.contentWindow.outgoing.find((data) => data.kind === 'run')).toMatchObject({ actionId: 'scan', input: { selected: true } });
    expect(hidden.remove).toHaveBeenCalledOnce();
    expect(messages.size).toBe(0);
    expect(subscribers.size).toBe(0);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('refreshes its own identity after explicit save so the same UI can run and save again', async () => {
    const host = await ready();
    emit(host.view, host.session.src, { kind: 'state', value: { count: 4 } });
    await run(host, null);
    await host.session.save();
    expect(mocks.save).toHaveBeenCalledWith('app-node', { count: 4 }, null, 1, expect.objectContaining({ projectId, baseRevision: 3 }));
    expect(app.revision).toBe(2);
    expect(subscribers.size).toBe(1);
    expect(await run(host, { count: 5 })).toEqual({ count: 5 });
    await host.session.save();
    expect(app.revision).toBe(3);
    expect(host.onChange.mock.calls.some(([snapshot]) => snapshot.error)).toBe(false);
  });

  it.each([
    { name: '64 KiB payload', value: 'x'.repeat(64 * 1024 - 2) },
    { name: '8-level payload', value: [[[[[[[[0]]]]]]]] },
  ])('accepts a valid $name without counting its protocol envelope against the payload budget', async ({ value }) => {
    const host = await ready();
    emit(host.view, host.session.src, { kind: 'state', value });
    const result = await run(host, value);
    expect(JSON.stringify(result)).toBe(JSON.stringify(value));
    expect(mocks.save).not.toHaveBeenCalled();
    await host.session.save();
    expect(JSON.stringify(mocks.save.mock.calls[0][1])).toBe(JSON.stringify(value));
    expect(JSON.stringify(mocks.save.mock.calls[0][2])).toBe(JSON.stringify(value));
    expect(host.onChange.mock.calls.some(([snapshot]) => snapshot.error)).toBe(false);
  });

  it('keeps an idle app through unrelated canvas changes but rejects changes during an action', async () => {
    const host = await ready();
    revision += 1;
    changed();
    expect(subscribers.size).toBe(1);
    expect(await run(host)).toEqual({ count: 1 });
    const promise = host.session.run('scan');
    const rejected = expect(promise).rejects.toThrow('变化');
    await flush();
    const request = host.view.outgoing.findLast((data) => data.kind === 'run')!;
    revision += 1;
    changed();
    await rejected;
    emit(host.view, host.session.src, { kind: 'result', requestId: request.requestId, value: 'stale' });
    expect(host.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false, error: expect.any(String), result: { count: 1 } }));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(['code', 'state', 'binding', 'input', 'project', 'epoch', 'node'])('invalidates an idle app when its %s identity changes', async (kind) => {
    const host = await ready();
    if (kind === 'code') app = { ...app, definition: { ...app.definition, sha256: 'b'.repeat(64) } };
    if (kind === 'state') app = { ...app, savedState: { count: 99 } };
    if (kind === 'binding') app = { ...app, inputNodeIds: [] };
    if (kind === 'input') fingerprint = 'resources-2';
    if (kind === 'project') projectId = 'project-2';
    if (kind === 'epoch') exchangeEpoch += 1;
    if (kind === 'node') nodes = [];
    changed();
    expect(subscribers.size).toBe(0);
    expect(messages.size).toBe(0);
    expect(host.view.outgoing.at(-1)).toMatchObject({ kind: 'cancel' });
    await expect(host.session.run('scan')).rejects.toThrow('关闭');
  });

  it.each(['cancel', 'timeout'])('cleans pending actions and forbids later saving after %s', async (kind) => {
    const host = await ready();
    emit(host.view, host.session.src, { kind: 'state', value: { temporary: true } });
    const promise = host.session.run('scan');
    const rejected = expect(promise).rejects.toThrow(kind === 'cancel' ? '停止' : '超时');
    await flush();
    const request = host.view.outgoing.findLast((data) => data.kind === 'run')!;
    if (kind === 'cancel') host.session.cancel();
    else await vi.advanceTimersByTimeAsync(12_001);
    await rejected;
    const calls = host.onChange.mock.calls.length;
    emit(host.view, host.session.src, { kind: 'state', value: { stale: true } });
    emit(host.view, host.session.src, { kind: 'result', requestId: request.requestId, value: 'stale' });
    expect(host.onChange).toHaveBeenCalledTimes(calls);
    expect(messages.size).toBe(0);
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(host.session.save()).rejects.toThrow();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('times out startup and disposes sessions when their external abort signal fires', async () => {
    const host = await create();
    const waiting = expect(host.session.run('scan')).rejects.toThrow('启动超时');
    await vi.advanceTimersByTimeAsync(8001);
    await waiting;
    const controller = new AbortController();
    const onChange = vi.fn();
    const session = await createAiAppUiSession({ nodeId: 'app-node', onChange, signal: controller.signal });
    sessions.push(session);
    session.attach(frame(session.src) as unknown as Window);
    controller.abort();
    expect(messages.size).toBe(0);
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false, error: '操作已取消' }));
  });

  it('does not return asynchronously read resources after cancellation', async () => {
    let resolveImage!: (value: string) => void;
    mocks.image.mockImplementation(() => new Promise<string>((resolve) => { resolveImage = resolve; }));
    const host = await ready();
    emit(host.view, host.session.src, { kind: 'resource-request', requestId: 'resource-1', nodeId: 'source-1' });
    expect(mocks.image).toHaveBeenCalledWith(projectId, ['source-1'], 'source-1');
    host.session.cancel();
    resolveImage('data:image/png;base64,verified');
    await flush();
    expect(host.view.outgoing.some((data) => data.kind === 'resource-response')).toBe(false);
  });

  it('releases the concurrent session allowance when a UI is disposed', async () => {
    const hosts = await Promise.all(Array.from({ length: 4 }, create));
    await expect(create()).rejects.toThrow('最多运行 4');
    hosts[0].session.dispose();
    const replacement = await create();
    expect(replacement.session.src).toContain('/ai-app-host.html#');
    expect(messages.size).toBe(4);
    expect(subscribers.size).toBe(4);
  });

  it('maps current appearance tokens into the isolated canvas theme variables', async () => {
    const host = await ready();
    host.session.updateTheme('light');
    expect(host.view.outgoing.at(-1)).toMatchObject({ kind: 'theme', theme: 'light', variables: { '--canvas-surface': 'rgb(20, 21, 22)', '--canvas-text': 'rgb(230, 231, 232)' } });
  });

  it('cleans the headless session if mounting its hidden frame fails', async () => {
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => { throw new Error('宿主挂载失败'); });
    await expect(runAiAppAction('app-node', 'scan', {}, { projectId })).rejects.toThrow('宿主挂载失败');
    expect(messages.size).toBe(0);
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('still releases all resources when a disconnected frame throws during run and cancellation', async () => {
    const host = await ready();
    host.view.postMessage.mockImplementation(() => { throw new Error('消息已断开'); });
    await expect(host.session.run('scan')).rejects.toThrow('消息已断开');
    expect(messages.size).toBe(0);
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => host.session.dispose()).not.toThrow();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
