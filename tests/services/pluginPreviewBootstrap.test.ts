import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/plugin-preview-bootstrap.js', import.meta.url), 'utf8');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
describe('preview page boundary', () => {
  it('requires opaque iframe isolation and real parent before loading author code', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const parent = { postMessage: vi.fn() };
    Object.defineProperty(parent, 'document', { get: () => { throw new Error('opaque'); } });
    const frame: Record<string, unknown> = {};
    const mount = vi.fn();
    const root = { textContent: '' };
    const document = { currentScript: { nonce: 'host-nonce' }, getElementById: () => root,
      documentElement: { dataset: {}, lang: '' }, createElement: () => ({}), head: { appendChild: (script: { nonce: string; onload: () => void }) => {
        expect(script.nonce).toBe('host-nonce');
        (frame.__AI_CANVAS_PLUGIN_HOST__ as { exports: Record<string, unknown> }).exports.Panel = mount;
        script.onload();
      } } };
    new Script(source).runInNewContext({ window: frame, parent, document, origin: 'null', location: { protocol: 'blob:', hash: '#session=test' },
      URLSearchParams, URL: { createObjectURL: () => 'blob:frame-owned', revokeObjectURL: vi.fn() }, Blob,
      crypto: { randomUUID: () => 'context' }, setTimeout: () => 1, clearTimeout: vi.fn(),
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), removeEventListener: vi.fn() });
    const value = { theme: 'dark', locale: 'zh-CN', uiSource: '/* preview UI */', exportName: 'Panel', host: {}, resources: {}, parameters: {}, node: {} };
    const response = { channel: 'ai-canvas-plugin-preview-v1', sessionId: 'test', requestId: 'context', ok: true, value };
    listeners.get('message')!({ source: {}, data: response }); await flush();
    expect(mount).not.toHaveBeenCalled();
    listeners.get('message')!({ source: parent, data: response }); await flush();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0][1].models).toEqual([]);
  });
});
