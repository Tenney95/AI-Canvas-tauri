import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../src-tauri/src/plugins/window-bootstrap.js', import.meta.url), 'utf8');
const binding = {
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  identity: { pluginId: 'test.plugin', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), uiDigest: 'c'.repeat(64), toolId: 'review' },
  projectId: 'project-1', nodeId: 'node-1', canvasRevision: 7,
};
const pageUrl = `http://plugin-window.localhost/${binding.sessionId}/index.html`;
const initialContext = { surface: 'tool-dialog', theme: 'dark', node: { id: 'node-1' }, models: [], resources: {}, parameters: {} };
type BridgeRequest = { binding: typeof binding; requestId: string; kind: string; payload: unknown };
type Invoke = (command: string, args: { request: BridgeRequest }) => Promise<unknown>;
interface Props {
  readonly busy: boolean;
  readonly theme: string;
  readonly parameters: Record<string, unknown>;
  runEffect: (effect: unknown) => Promise<unknown>;
  setParameters: (patch: Record<string, unknown>) => Promise<void>;
  submit: (data?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<unknown>;
}
interface ElementStub {
  tagName: string;
  className?: string;
  textContent?: string;
  src?: string;
  onload?: () => void;
  onerror?: () => void;
  setAttribute: ReturnType<typeof vi.fn>;
}
const reply = (value: unknown) => JSON.stringify({ ok: true, value });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: { invoke?: Invoke; embedded?: boolean; location?: string; mount?: (root: unknown, props: Props) => unknown } = {}) {
  const root = { replaceChildren: vi.fn() };
  const listeners = new Map<string, (event?: unknown) => void>();
  const mount = vi.fn(options.mount ?? (() => undefined));
  const invoke = vi.fn<Invoke>(options.invoke ?? (async (_command, { request }) => reply(request.kind === 'context' ? initialContext : true)));
  const attributes = new Map<string, string>();
  const scripts: ElementStub[] = [];
  const windowStub: Record<string, unknown> = {
    location: { href: options.location ?? pageUrl },
    __TAURI_INTERNALS__: { invoke },
    addEventListener: (event: string, handler: (event?: unknown) => void) => listeners.set(event, handler),
    dispatchEvent: vi.fn(),
  };
  windowStub.top = options.embedded ? {} : windowStub;
  const document = {
    getElementById: () => root,
    createElement: (tagName: string): ElementStub => ({ tagName, setAttribute: vi.fn() }),
    documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
    head: { appendChild: (element: ElementStub) => {
      scripts.push(element);
      const host = windowStub.__AI_CANVAS_PLUGIN_HOST__ as { exports: Record<string, unknown> };
      host.exports.Review = mount;
      queueMicrotask(() => element.onload?.());
    } },
  };
  let sequence = 0;
  new Script(source, { filename: 'window-bootstrap.js' }).runInNewContext({
    window: windowStub, document, URL,
    crypto: { randomUUID: () => `request-${sequence += 1}` },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, detail: unknown) { this.type = type; this.detail = detail; }
    },
    __PLUGIN_WINDOW_CONFIG__: { binding, exportName: 'Review', url: pageUrl },
  });
  return { root, listeners, mount, invoke, attributes, scripts, windowStub };
}

describe('dedicated native plugin window bootstrap', () => {
  it('waits for bound context before loading only the fixed bundle and mounting v1 props', async () => {
    let resolveContext!: (value: unknown) => void;
    const context = new Promise((resolve) => { resolveContext = resolve; });
    const host = harness({ invoke: async () => context });
    expect(host.scripts).toHaveLength(0);
    expect(host.invoke).toHaveBeenCalledWith('plugin_ui_window_request', {
      request: { binding, requestId: 'request-1', kind: 'context', payload: null },
    });
    resolveContext(reply(initialContext));
    await flush();
    expect(host.scripts.map((script) => script.src)).toEqual([pageUrl.replace('index.html', 'bundle.js')]);
    expect(host.mount).toHaveBeenCalledOnce();
    expect(host.attributes.get('data-theme')).toBe('dark');
    expect(Object.isFrozen(host.mount.mock.calls[0][1])).toBe(true);
  });

  it.each([{ embedded: true }, { location: 'http://tauri.localhost/' }])('rejects the wrong top-level boundary before invoking', async (options) => {
    const host = harness(options);
    await flush();
    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.scripts).toHaveLength(0);
    expect(host.root.replaceChildren.mock.calls.at(-1)?.[0].textContent).toContain('隔离边界无效');
  });

  it('uses only the dedicated bridge, keeps busy until settlement and rejects concurrent effects', async () => {
    let finishEffect!: (value: unknown) => void;
    const host = harness({ invoke: async (_command, { request }) => (
      request.kind === 'effect' ? new Promise((resolve) => { finishEffect = resolve; }) : reply(initialContext)
    ) });
    await flush();
    const props = host.mount.mock.calls[0][1];
    const running = props.runEffect({ type: 'video.extractFrames' });
    expect(props.busy).toBe(true);
    await expect(props.submit()).rejects.toThrow('正在执行操作');
    finishEffect(reply({ frames: ['example'] }));
    await expect(running).resolves.toEqual({ frames: ['example'] });
    expect(props.busy).toBe(false);
    expect(host.invoke.mock.calls.every(([command]) => command === 'plugin_ui_window_request')).toBe(true);
    expect(host.invoke.mock.calls.every(([, args]) => args.request.binding === binding)).toBe(true);
  });

  it.each([{}, JSON.stringify({ ok: false, error: '资源已撤销' }), 'invalid-json'])('rejects malformed or denied replies without loading plugin code', async (result) => {
    const host = harness({ invoke: async () => result });
    await flush();
    expect(host.mount).not.toHaveBeenCalled();
    expect(host.scripts).toHaveLength(0);
    expect(host.root.replaceChildren.mock.calls.at(-1)?.[0].textContent).toContain('加载失败');
  });

  it('rejects waiting operations on pagehide and ignores late replies', async () => {
    let finishEffect!: (value: unknown) => void;
    const cleanup = vi.fn();
    const host = harness({ mount: () => cleanup, invoke: async (_command, { request }) => (
      request.kind === 'effect' ? new Promise((resolve) => { finishEffect = resolve; }) : reply(initialContext)
    ) });
    await flush();
    const props = host.mount.mock.calls[0][1];
    const operation = props.runEffect({ type: 'video.extractFrames' });
    const rejected = expect(operation).rejects.toThrow('已关闭');
    host.listeners.get('pagehide')?.();
    await rejected;
    finishEffect(reply('late'));
    await flush();
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(props.close()).rejects.toThrow('不可用');
  });

  it('refreshes light theme on focus through the same bridge without a general event listener', async () => {
    let theme = 'dark';
    const host = harness({ invoke: async () => reply({ ...initialContext, theme }) });
    await flush();
    theme = 'light';
    host.listeners.get('focus')?.();
    await flush();
    expect(host.attributes.get('data-theme')).toBe('light');
    expect(host.mount.mock.calls[0][1].theme).toBe('light');
    expect(host.listeners.has('message')).toBe(false);
  });

  it('sends close only after the page receives submit success, without turning close teardown into submit failure', async () => {
    let acknowledge!: (value: unknown) => void;
    const host = harness({ invoke: async (_command, { request }) => {
      if (request.kind === 'submit') return new Promise((resolve) => { acknowledge = resolve; });
      if (request.kind === 'close') throw new Error('window destroyed');
      return reply(initialContext);
    } });
    await flush();
    const operation = host.mount.mock.calls[0][1].submit({ output: 'saved' });
    expect(host.invoke.mock.calls.map(([, args]) => args.request.kind)).toEqual(['context', 'submit']);
    acknowledge(reply(true));
    await expect(operation).resolves.toBe(true);
    expect(host.invoke.mock.calls.map(([, args]) => args.request.kind)).toEqual(['context', 'submit', 'close']);
  });

  it('does not close a window when submit was denied', async () => {
    const host = harness({ invoke: async (_command, { request }) => request.kind === 'submit'
      ? JSON.stringify({ ok: false, error: '画布已变化' }) : reply(initialContext) });
    await flush();
    await expect(host.mount.mock.calls[0][1].submit()).rejects.toThrow('画布已变化');
    expect(host.invoke.mock.calls.map(([, args]) => args.request.kind)).toEqual(['context', 'submit']);
  });
});
