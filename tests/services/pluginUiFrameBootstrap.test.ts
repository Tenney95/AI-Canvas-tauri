import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/plugin-ui-bootstrap.js', import.meta.url), 'utf8');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const channel = 'ai-canvas-plugin-ui-v1';

function harness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const attributes = new Map<string, string>();
  const mount = vi.fn<(root: unknown, props: { locale: string }) => void>();
  const parent = { postMessage: vi.fn() };
  Object.defineProperty(parent, 'document', { get: () => { throw new Error('cross origin'); } });
  const windowStub: Record<string, unknown> = {
    parent, origin: 'null',
    location: { protocol: 'blob:', hash: '#session=test-session&export=Review&bundle=http%3A%2F%2Fplugin-ui.localhost%2Ftest' },
    setTimeout: () => 1, clearTimeout: vi.fn(),
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    dispatchEvent: vi.fn(),
  };
  new Script(source).runInNewContext({
    window: windowStub, URL, URLSearchParams,
    crypto: { randomUUID: () => 'context-request' },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, options: { detail: unknown }) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    document: {
      getElementById: () => ({ replaceChildren: vi.fn(), appendChild: vi.fn() }),
      documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
      createElement: () => ({}),
      head: { appendChild: (script: { onload: () => void }) => {
        (windowStub.__AI_CANVAS_PLUGIN_HOST__ as { exports: Record<string, unknown> }).exports.Review = mount;
        script.onload();
      } },
    },
  });
  const deliver = (data: Record<string, unknown>, sender: unknown = parent) => listeners.get('message')?.({
    source: sender, data: { channel, sessionId: 'test-session', ...data },
  });
  const context = (locale: string | undefined = 'zh-CN') => deliver({
    direction: 'response', requestId: 'context-request', ok: true,
    value: { locale, theme: 'dark', parameters: { prompt: 'draft' } },
  });
  return { context, deliver, mount, attributes, windowStub };
}

describe('embedded plugin locale bridge', () => {
  it.each(['zh-CN', 'en-US', 'ja-JP', 'ko-KR'])('initializes document and props with %s', async (locale) => {
    const host = harness();
    host.context(locale);
    await flush();
    expect(host.attributes.get('lang')).toBe(locale);
    expect(host.mount.mock.calls[0][1].locale).toBe(locale);
  });

  it('authenticates locale events, deduplicates updates and keeps the same mounted props', async () => {
    const host = harness();
    host.context();
    await flush();
    const props = host.mount.mock.calls[0][1];
    const event = { direction: 'event', kind: 'locale', value: 'ja-JP' };
    host.deliver(event, {});
    host.deliver({ ...event, sessionId: 'wrong' });
    host.deliver({ ...event, value: 'invalid' });
    expect(props.locale).toBe('zh-CN');
    expect(host.windowStub.dispatchEvent).not.toHaveBeenCalled();
    host.deliver(event);
    host.deliver(event);
    expect(props.locale).toBe('ja-JP');
    expect(host.attributes.get('lang')).toBe('ja-JP');
    expect(host.windowStub.dispatchEvent).toHaveBeenCalledOnce();
    expect(host.windowStub.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ai-canvas-locale-change', detail: 'ja-JP',
    }));
    expect(props).toMatchObject({ parameters: { prompt: 'draft' } });
    expect(host.mount).toHaveBeenCalledOnce();
  });

  it('retains a newer locale notification while the initial context is in flight', async () => {
    const host = harness();
    host.deliver({ direction: 'event', kind: 'locale', value: 'ko-KR' });
    host.context('zh-CN');
    await flush();
    expect(host.mount.mock.calls[0][1].locale).toBe('ko-KR');
    expect(host.attributes.get('lang')).toBe('ko-KR');
  });
});
