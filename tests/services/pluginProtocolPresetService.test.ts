import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin, PluginRegistrationStatus } from '../../src/types/plugin';
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => native);
import { acquirePluginProtocolPreset, listPluginProtocolPresets, revokePluginProtocolPresets, verifyPluginProtocolPreset } from '../../src/services/plugins/pluginProtocolPresetService';

const ref = { pluginId: 'example.responses', presetId: 'responses' };
function fixture(id = ref.pluginId): InstalledPlugin {
  return { id, enabled: true, source: 'definePlugin({ tools: {} });', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), installedAt: 1, updatedAt: 1,
    manifest: { apiVersion: 2, requiredCapabilities: ['model.protocolPresets'], id, name: '同名插件', version: '1.0.0', category: 'utility', runtime: 'javascript', entry: 'main.js', permissions: [],
      contributes: { nodeTools: [], modelProtocols: [{ id: 'responses', name: 'OpenAI Responses', category: 'text', adapter: 'openai-responses' }] } } };
}
function status(plugin: InstalledPlugin): PluginRegistrationStatus {
  return { pluginId: plugin.id, exists: true, enabled: plugin.enabled, activeSourceDigest: plugin.sourceDigest!, activeRevisionDigest: plugin.revisionDigest!,
    version: plugin.manifest.version, snapshotVerified: true, healthCode: 'ready', dependencyFingerprint: 'c'.repeat(64), modelProtocols: plugin.manifest.contributes.modelProtocols };
}
let plugins: InstalledPlugin[];
beforeEach(() => {
  revokePluginProtocolPresets();
  plugins = [fixture()];
  native.isTauri.mockReturnValue(true);
  native.invoke.mockReset().mockImplementation(async (_cmd, { pluginId }: { pluginId: string }) => status(plugins.find((item) => item.id === pluginId)!));
});

describe('native protocol preset catalog and leases', () => {
  it('discovers same display names with distinct identities, without running scripts', async () => {
    plugins.push(fixture('another.responses'));
    const entries = await listPluginProtocolPresets(plugins);
    expect(entries.map((item) => item.pluginId)).toEqual(['another.responses', 'example.responses']);
    expect(entries.every((item) => item.available)).toBe(true);
    expect(native.invoke.mock.calls.every(([command]) => command === 'get_plugin_registration_status')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('sourceDigest');
  });

  it.each([
    { enabled: false }, { exists: false }, { healthCode: 'invalid' }, { snapshotVerified: false },
    { activeSourceDigest: 'd'.repeat(64) }, { activeRevisionDigest: 'd'.repeat(64) },
    { dependencyFingerprint: undefined }, { modelProtocols: undefined },
    { modelProtocols: [{ id: 'responses', name: 'OpenAI Responses', category: 'text', adapter: 'openai-compatible' }] },
  ])('rejects unavailable or forged native metadata %j', async (overrides) => {
    native.invoke.mockResolvedValue({ ...status(plugins[0]), ...overrides });
    await expect(verifyPluginProtocolPreset(ref, plugins)).rejects.toThrow();
    expect((await listPluginProtocolPresets(plugins))[0].available).toBe(false);
  });

  it('requires a desktop native snapshot and hides native error details in catalog diagnostics', async () => {
    native.invoke.mockRejectedValue(new Error('C:\\private\\snapshot-token'));
    const entries = await listPluginProtocolPresets(plugins);
    expect(entries[0].available).toBe(false);
    expect(JSON.stringify(entries)).not.toContain('snapshot-token');
    native.isTauri.mockReturnValue(false); native.invoke.mockClear();
    await expect(verifyPluginProtocolPreset(ref, plugins)).rejects.toThrow('桌面端');
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('blocks missing dependencies and disabled/missing plugins without invoking native code', async () => {
    plugins[0].manifest.dependencies = [{ pluginId: 'required.base' }];
    await expect(verifyPluginProtocolPreset(ref, plugins)).rejects.toThrow('依赖');
    plugins[0].enabled = false;
    await expect(verifyPluginProtocolPreset(ref, plugins)).rejects.toThrow('未启用');
    await expect(verifyPluginProtocolPreset(ref, [])).rejects.toThrow('未安装');
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('revokes active calls immediately and allows a new call after failed-update compensation', async () => {
    const first = new AbortController();
    const lease = await acquirePluginProtocolPreset(ref, () => plugins, first);
    revokePluginProtocolPresets(ref.pluginId);
    expect(first.signal.aborted).toBe(true);
    await expect(lease.assertCurrent()).rejects.toThrow();
    const next = await acquirePluginProtocolPreset(ref, () => plugins, new AbortController());
    await expect(next.assertCurrent()).resolves.toBeUndefined();
    lease.release(); next.release();
  });

  it('detects revision changes and native dependency changes before delivering results', async () => {
    const lease = await acquirePluginProtocolPreset(ref, () => plugins, new AbortController());
    native.invoke.mockResolvedValue({ ...status(plugins[0]), dependencyFingerprint: 'e'.repeat(64) });
    await expect(lease.assertCurrent()).rejects.toThrow('原生活动版本');
    expect(lease.signal.aborted).toBe(true);
    lease.release();
    native.invoke.mockResolvedValue(status(plugins[0]));
    const updated = await acquirePluginProtocolPreset(ref, () => plugins, new AbortController());
    plugins = [{ ...plugins[0], revisionDigest: 'f'.repeat(64) }];
    expect(() => updated.assertActive()).toThrow('已变化');
    updated.release();
  });

  it('does not revive a lease revoked while native verification was pending', async () => {
    let complete!: (value: PluginRegistrationStatus) => void;
    native.invoke.mockReturnValue(new Promise<PluginRegistrationStatus>((resolve) => { complete = resolve; }));
    const pending = acquirePluginProtocolPreset(ref, () => plugins, new AbortController());
    revokePluginProtocolPresets();
    complete(status(plugins[0]));
    await expect(pending).rejects.toThrow();
  });

  it('aborts the transport when frontend availability changes outside the store transaction', async () => {
    const lease = await acquirePluginProtocolPreset(ref, () => plugins, new AbortController());
    plugins = [];
    expect(() => lease.assertActive()).toThrow('未安装');
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  it('aborts the transport when native availability fails during the final verification', async () => {
    const lease = await acquirePluginProtocolPreset(ref, () => plugins, new AbortController());
    native.invoke.mockResolvedValue({ ...status(plugins[0]), enabled: false });
    await expect(lease.assertCurrent()).rejects.toThrow('活动版本不可用');
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  it('releases completed calls without allowing later revocation to abort their controllers', async () => {
    const controller = new AbortController();
    const lease = await acquirePluginProtocolPreset(ref, () => plugins, controller);
    lease.release(); revokePluginProtocolPresets();
    expect(controller.signal.aborted).toBe(false);
  });
});
