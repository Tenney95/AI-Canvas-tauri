import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '../../src/types/plugin';
import { createPluginPreview } from '../../src/services/plugins/pluginPreviewService';

let receive: (event: MessageEvent) => void;
let removed: ReturnType<typeof vi.fn>;
const source = 'window.__previewMustNotRun = true;';
const manifest: PluginManifest = { id: 'preview', name: 'preview', apiVersion: 1, version: '1.0.0', category: 'utility', runtime: 'javascript',
  entry: 'main.js', permissions: ['ui.custom'], contributes: { nodeTools: [] }, ui: { entry: 'ui.js',
    integrity: createHash('sha256').update(source).digest('hex'), exports: { panel: 'Panel' } } };

beforeEach(() => {
  removed = vi.fn();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('window', { location: { href: 'http://localhost/' },
    addEventListener: (_kind: string, listener: (event: MessageEvent) => void) => { receive = listener; }, removeEventListener: removed });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('isolated mock plugin preview', () => {
  it('verifies UI bytes before creating any execution surface', async () => {
    await expect(createPluginPreview({ manifest, uiSource: 'changed', exportName: 'panel', theme: 'dark', locale: 'zh-CN', onClose: vi.fn(), onSubmit: vi.fn() }))
      .rejects.toThrow('摘要');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('binds the real frame, rejects effects, and revokes resources on close', async () => {
    const session = await createPluginPreview({ manifest, uiSource: source, exportName: 'panel', theme: 'light', locale: 'zh-CN', onClose: vi.fn(), onSubmit: vi.fn() });
    const frame = { postMessage: vi.fn() };
    session.attach(frame as unknown as Window);
    const sessionId = new URLSearchParams(session.src.split('#')[1]).get('session');
    const deliver = (kind: string, payload: unknown = null, sender: unknown = frame) => receive({ source: sender, data: {
      channel: 'ai-canvas-plugin-preview-v1', sessionId, requestId: crypto.randomUUID(), kind, payload,
    } } as MessageEvent);
    deliver('context', null, {});
    expect(frame.postMessage).not.toHaveBeenCalled();
    deliver('context');
    const context = frame.postMessage.mock.calls[0][0].value;
    expect(context).toMatchObject({ node: { id: 'preview-node' } });
    // 模型列表由预览 bootstrap 固定为空，不从主窗口传模型目录。
    expect(context).not.toHaveProperty('models');
    deliver('effect', { type: 'network.request', url: 'https://example.com' });
    expect(frame.postMessage.mock.lastCall![0].ok).toBe(false);
    deliver('set-parameters', JSON.parse('{"__proto__":{"admin":true}}'));
    expect(frame.postMessage.mock.lastCall![0].ok).toBe(false);
    const before = frame.postMessage.mock.calls.length;
    await session.dispose(); await session.dispose();
    deliver('context');
    expect(frame.postMessage).toHaveBeenCalledTimes(before);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
