import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { InstalledPlugin, PluginNodeToolManifest, PluginUiWindowBinding, PluginUiWindowEvent } from '../../src/types/plugin';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), isTauri: vi.fn(), create: vi.fn(), getState: vi.fn(),
  channels: [] as Array<{ onmessage: (event: PluginUiWindowEvent) => void }>,
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke, isTauri: mocks.isTauri,
  Channel: class {
    onmessage = (_event: PluginUiWindowEvent) => {};
    constructor() { mocks.channels.push(this); }
  },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: mocks.getState } }));
vi.mock('../../src/services/plugins/pluginUiSessionService', () => ({ createPluginUiNativeSession: mocks.create }));
import { openPluginUiWindow, pluginUiWindowUnavailableReason } from '../../src/services/plugins/pluginUiWindowService';

const tool: PluginNodeToolManifest = {
  id: 'review', title: '逐帧拉片', placements: ['node-toolbar'], nodeTypes: ['ai-video'], inputFields: ['label'],
  dialog: { fields: [], ui: 'dialog', presentation: 'window' }, output: { mode: 'update-current', fields: [] },
};
const plugin: InstalledPlugin = {
  id: 'com.example.review', enabled: true, source: '', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64),
  uiDigest: 'c'.repeat(64), installedAt: 1, updatedAt: 1,
  manifest: {
    apiVersion: 1, id: 'com.example.review', name: '逐帧拉片', version: '1.0.0', category: 'utility',
    runtime: 'javascript', entry: 'main.js', permissions: ['ui.custom'], contributes: { nodeTools: [tool] },
  },
};
const options = { plugin, tool, nodeId: 'video-1', exportName: 'dialog' };
const fixtureBinding = (): PluginUiWindowBinding => ({
  sessionId: crypto.randomUUID(),
  identity: { pluginId: plugin.id, toolId: tool.id, sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), uiDigest: 'c'.repeat(64) },
  projectId: 'project-1', nodeId: 'video-1', canvasRevision: 7,
});
let binding: PluginUiWindowBinding;
let active: boolean;
let revoke: () => void;
const request = vi.fn();
const dispose = vi.fn();
const finishRequest = vi.fn();
const emit = (event: PluginUiWindowEvent) => mocks.channels[0].onmessage(event);
const send = (kind: 'context' | 'effect' | 'submit' | 'close' = 'context') => {
  const event: PluginUiWindowEvent = { type: 'request', binding, requestId: crypto.randomUUID(), kind, payload: {} };
  emit(event);
  return event;
};
const replies = () => mocks.invoke.mock.calls.filter(([command]) => command === 'respond_plugin_ui_window_request');
const closes = () => mocks.invoke.mock.calls.filter(([command]) => command === 'close_plugin_ui_window');
const opens = () => mocks.invoke.mock.calls.filter(([command]) => command === 'open_plugin_ui_window');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channels.length = 0;
  active = true;
  binding = fixtureBinding();
  revoke = () => {};
  mocks.isTauri.mockReturnValue(true);
  mocks.getState.mockReturnValue({ currentProjectId: 'project-1', installedPlugins: [plugin], showToast: vi.fn() });
  dispose.mockImplementation(() => { active = false; });
  finishRequest.mockImplementation(() => {});
  request.mockResolvedValue({ ok: true, value: { theme: 'dark' } });
  mocks.create.mockImplementation(async ({ onClose }: { onClose: () => void }) => {
    revoke = onClose;
    return { binding, request, dispose, finishRequest, isActive: () => active };
  });
  let openingCount = 0;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'open_plugin_ui_window') return { binding, reused: openingCount++ > 0 };
    return undefined;
  });
});
afterEach(async () => {
  for (const channel of mocks.channels) channel.onmessage({ type: 'closed', binding, reason: 'window-closed' });
  revoke();
  await Promise.resolve();
});

describe('pluginUiWindowService', () => {
  it('keeps native presentation gated until real WebView acceptance and supports web fallback', async () => {
    const launcher = readFileSync(new URL('../../src/components/nodes/shared/toolbar/NodePluginToolDialog.tsx', import.meta.url), 'utf8');
    expect(launcher).toContain("dialog?.presentation === 'window' ? pluginUiWindowUnavailableReason() : null");
    expect(launcher).toContain("dialog?.presentation === 'window' && windowFallback === null");
    expect(launcher).toContain('if (useNativeWindow)');
    expect(launcher).toContain('openPluginUiWindow({');
    expect(launcher).toContain('sandbox="allow-scripts"');
    expect(pluginUiWindowUnavailableReason()).toContain('隔离验收');
    mocks.isTauri.mockReturnValue(false);
    expect(pluginUiWindowUnavailableReason()).toContain('不是 Tauri');
    await expect(openPluginUiWindow(options)).rejects.toThrow('仅支持 Tauri');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('opens via the exact native command and binding, then forwards only through its registered Channel', async () => {
    expect(await openPluginUiWindow(options)).toEqual(binding);
    expect(opens()[0]).toEqual(['open_plugin_ui_window', {
      options: { binding, exportName: 'dialog', title: '逐帧拉片' }, channel: mocks.channels[0],
    }]);
    const event = send();
    await vi.waitFor(() => expect(replies()).toHaveLength(1));
    expect(request).toHaveBeenCalledWith('context', {});
    expect(replies()[0][1]).toMatchObject({ binding, requestId: event.requestId, reply: { ok: true } });
    expect(finishRequest).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent creation and focuses with the original session/channel, without re-minting', async () => {
    const [first, second] = await Promise.all([openPluginUiWindow(options), openPluginUiWindow(options)]);
    expect(first).toEqual(second);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(opens()).toHaveLength(2);
    expect(opens()[1][1].channel).toBe(opens()[0][1].channel);
    expect(mocks.channels).toHaveLength(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each(['sessionId', 'projectId', 'nodeId', 'canvasRevision', 'pluginId', 'toolId', 'sourceDigest', 'revisionDigest', 'uiDigest'])(
    'rejects a Channel event with a mismatched %s, without replying to its claimed identity', async (field) => {
      await openPluginUiWindow(options);
      const wrong = ['sessionId', 'projectId', 'nodeId', 'canvasRevision'].includes(field)
        ? { ...binding, [field]: field === 'canvasRevision' ? 8 : 'forged' }
        : { ...binding, identity: { ...binding.identity, [field]: 'forged' } };
      emit({ type: 'request', binding: wrong, requestId: crypto.randomUUID(), kind: 'effect', payload: {} });
      expect(request).not.toHaveBeenCalled();
      expect(replies()).toHaveLength(0);
      expect(dispose).toHaveBeenCalledOnce();
      expect(closes()[0][1]).toEqual({ binding });
    },
  );

  it('rejects replayed request IDs without executing an effect twice', async () => {
    await openPluginUiWindow(options);
    const event = send('effect');
    await vi.waitFor(() => expect(replies()).toHaveLength(1));
    emit(event);
    expect(request).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('revokes on native close, drops late results and ignores subsequent events', async () => {
    let finish!: (reply: { ok: boolean }) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await openPluginUiWindow(options);
    send('effect');
    emit({ type: 'closed', binding, reason: 'plugin-changed' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(closes()).toHaveLength(0);
    finish({ ok: true });
    await Promise.resolve();
    expect(replies()).toHaveLength(0);
    send();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('revokes native state when the host broker invalidates its lease', async () => {
    await openPluginUiWindow(options);
    revoke();
    expect(dispose).toHaveBeenCalledOnce();
    expect(closes()).toHaveLength(1);
    send();
    expect(request).not.toHaveBeenCalled();
  });

  it('cleans up failed opens and refuses to adopt a native session whose Channel is not owned', async () => {
    mocks.invoke.mockResolvedValueOnce({ binding: fixtureBinding(), reused: true });
    await expect(openPluginUiWindow(options)).rejects.toThrow('创建身份不匹配');
    expect(dispose).toHaveBeenCalledOnce();
    expect(closes()[0][1]).toEqual({ binding });
  });

  it('closes a late native open again after host revocation raced its registration', async () => {
    let finish!: (value: { binding: PluginUiWindowBinding; reused: boolean }) => void;
    mocks.invoke.mockImplementation((command) => command === 'open_plugin_ui_window'
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
    const pending = openPluginUiWindow(options);
    await vi.waitFor(() => expect(opens()).toHaveLength(1));
    revoke();
    expect(closes()).toHaveLength(1);
    finish({ binding, reused: false });
    await expect(pending).rejects.toThrow('失效');
    expect(closes()).toHaveLength(2);
  });

  it('also revokes a late focus operation if native state was removed while focusing', async () => {
    await openPluginUiWindow(options);
    let finish!: (value: { binding: PluginUiWindowBinding; reused: boolean }) => void;
    mocks.invoke.mockImplementation((command) => command === 'open_plugin_ui_window'
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
    const pending = openPluginUiWindow(options);
    await vi.waitFor(() => expect(opens()).toHaveLength(2));
    revoke();
    finish({ binding, reused: false });
    await expect(pending).rejects.toThrow('身份不匹配');
    expect(closes()).toHaveLength(2);
  });

  it('revokes resources on submit but closes only after the plugin has acknowledged success using close', async () => {
    await openPluginUiWindow(options);
    let acknowledge!: () => void;
    mocks.invoke.mockReturnValueOnce(new Promise<void>((resolve) => { acknowledge = resolve; }));
    send('submit');
    await vi.waitFor(() => expect(replies()).toHaveLength(1));
    expect(finishRequest).not.toHaveBeenCalled();
    expect(closes()).toHaveLength(0);
    expect(dispose).toHaveBeenCalledOnce();
    acknowledge();
    await Promise.resolve();
    expect(closes()).toHaveLength(0);
    send('effect');
    await vi.waitFor(() => expect(replies()).toHaveLength(2));
    expect(replies()[1][1].reply).toMatchObject({ ok: false });
    expect(request).toHaveBeenCalledTimes(1);
    send('close');
    await vi.waitFor(() => expect(closes()).toHaveLength(1));
    expect(finishRequest).not.toHaveBeenCalled();
    expect(closes()).toHaveLength(1);
  });

  it('reclaims a submitted native window after a bounded wait if its close acknowledgement never arrives', async () => {
    vi.useFakeTimers();
    try {
      await openPluginUiWindow(options);
      send('submit');
      await vi.advanceTimersByTimeAsync(0);
      expect(closes()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(closes()).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('fails closed on reply transport errors and does not claim success', async () => {
    await openPluginUiWindow(options);
    mocks.invoke.mockRejectedValueOnce(new Error('transport failed'));
    send('submit');
    await vi.waitFor(() => expect(closes()).toHaveLength(1));
    expect(finishRequest).not.toHaveBeenCalled();
    expect(mocks.getState().showToast).toHaveBeenCalledWith(expect.stringContaining('桥接失败'), 'error');
  });

  it('reports an unconfirmed native close while keeping the host lease revoked', async () => {
    await openPluginUiWindow(options);
    mocks.invoke.mockRejectedValueOnce(new Error('offline'));
    revoke();
    await vi.waitFor(() => expect(mocks.getState().showToast).toHaveBeenCalledWith(expect.stringContaining('未确认'), 'error'));
    expect(active).toBe(false);
  });

  it('refuses stale plugin launchers or project changes before minting', async () => {
    await expect(openPluginUiWindow({ ...options, plugin: { ...plugin, revisionDigest: 'd'.repeat(64) } })).rejects.toThrow('revision');
    const pending = openPluginUiWindow(options);
    mocks.getState().currentProjectId = 'project-2';
    await expect(pending).rejects.toThrow('项目已变化');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
