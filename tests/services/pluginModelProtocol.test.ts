import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../../src/types/plugin';
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => native);
import { resolvePluginModelProtocol } from '../../src/services/ai/pluginModelProtocol';
import { parsePluginProtocolReference, revokePluginProtocolPresets } from '../../src/services/plugins/pluginProtocolPresetService';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { comparableProtocol, resolveModelExecutionProfile } from '../../src/services/ai/modelProtocol';

const plugin: InstalledPlugin = { id: 'sample.responses', enabled: true, source: 'never executed', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), installedAt: 1, updatedAt: 1,
  manifest: { apiVersion: 2, id: 'sample.responses', name: 'Responses', version: '1.0.0', category: 'utility', runtime: 'javascript', entry: 'main.js', permissions: [], requiredCapabilities: ['model.protocolPresets'],
    contributes: { nodeTools: [], modelProtocols: [{ id: 'responses', name: 'Responses', category: 'text', adapter: 'openai-responses' }] } } };
const profile = { preset: 'plugin' as const, plugin: { pluginId: plugin.id, presetId: 'responses' } };
beforeEach(() => {
  revokePluginProtocolPresets();
  native.invoke.mockReset().mockResolvedValue({ pluginId: plugin.id, exists: true, enabled: true, snapshotVerified: true, healthCode: 'ready',
    activeSourceDigest: plugin.sourceDigest, activeRevisionDigest: plugin.revisionDigest, dependencyFingerprint: 'c'.repeat(64), modelProtocols: plugin.manifest.contributes.modelProtocols });
});
describe('plugin model protocol references', () => {
  it('resolves only the verified host adapter and never falls back for an absent preset', async () => {
    const lease = await resolvePluginModelProtocol(profile, () => [plugin], new AbortController());
    expect(lease.adapter).toBe('openai-responses');
    lease.release();
    await expect(resolvePluginModelProtocol(profile, () => [], new AbortController())).rejects.toThrow('未安装');
    await expect(resolvePluginModelProtocol({ ...profile, plugin: { ...profile.plugin, presetId: 'absent' } }, () => [plugin], new AbortController())).rejects.toThrow('未提供');
    expect(() => resolveModelExecutionProfile(profile)).toThrow('原生活动');
  });
  it('preserves missing references for storage and distinguishes their stable identities', () => {
    expect(() => assertModelCapabilityProtocol({ id: 'm', name: 'm', provider: 'p', category: 'text', executionProfile: profile })).not.toThrow();
    expect(comparableProtocol(profile)).not.toBe(comparableProtocol({ ...profile, plugin: { ...profile.plugin, presetId: 'other' } }));
    expect(() => assertModelCapabilityProtocol({ id: 'm', name: 'm', provider: 'p', category: 'image', executionProfile: profile })).toThrow('文本模型');
  });
  it.each([undefined, {}, { pluginId: '../x', presetId: 'responses' }, { ...profile.plugin, adapter: 'openai-compatible' }])('rejects malformed or self-authorizing references %j', (reference) => {
    expect(() => parsePluginProtocolReference(reference)).toThrow('executionProfile.plugin');
  });
  it('honors caller cancellation before verifying or sending anything', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(resolvePluginModelProtocol(profile, () => [plugin], controller)).rejects.toThrow();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
