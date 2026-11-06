import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../../src/types/plugin';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => mocks);
import { inspectPluginHealth } from '../../src/services/plugins/pluginHealthService';

const plugin: InstalledPlugin = { id: 'sample', source: 'not disclosed', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), enabled: true,
  installedAt: 1, updatedAt: 1, manifest: { id: 'sample', name: 'sample', apiVersion: 1, version: '1.0.0', runtime: 'javascript', entry: 'main.js',
    category: 'utility', permissions: [], contributes: { nodeTools: [] } } };
beforeEach(() => { mocks.invoke.mockReset(); mocks.isTauri.mockReturnValue(true); });
describe('plugin native health', () => {
  it('requires matching native identity and verified snapshot for ready', async () => {
    mocks.invoke.mockResolvedValue({ pluginId: plugin.id, exists: true, enabled: true, activeSourceDigest: plugin.sourceDigest,
      activeRevisionDigest: plugin.revisionDigest, snapshotVerified: true, healthCode: 'ready' });
    expect((await inspectPluginHealth(plugin, [plugin])).state).toBe('ready');
    mocks.invoke.mockResolvedValue({ pluginId: plugin.id, exists: true, enabled: true, activeSourceDigest: plugin.sourceDigest,
      activeRevisionDigest: 'c'.repeat(64), snapshotVerified: true, healthCode: 'ready' });
    expect((await inspectPluginHealth(plugin, [plugin])).state).toBe('invalid');
  });
  it('does not disclose native errors and does not invoke in browser', async () => {
    mocks.invoke.mockRejectedValue(new Error('C:\\private\\credentials'));
    expect(JSON.stringify(await inspectPluginHealth(plugin, [plugin]))).not.toContain('credentials');
    mocks.isTauri.mockReturnValue(false); mocks.invoke.mockClear();
    expect((await inspectPluginHealth(plugin, [plugin])).state).toBe('unavailable');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('does not label an approved Python plugin ready when its runtime is unavailable', async () => {
    const python = { ...plugin, manifest: { ...plugin.manifest, runtime: 'python' as const, entry: 'main.py' as const } };
    mocks.invoke.mockResolvedValueOnce({ pluginId: plugin.id, exists: true, enabled: true, activeSourceDigest: plugin.sourceDigest,
      activeRevisionDigest: plugin.revisionDigest, snapshotVerified: true, healthCode: 'ready' });
    mocks.invoke.mockResolvedValueOnce({ available: false, error: 'private runtime path' });
    const result = await inspectPluginHealth(python, [python]);
    expect(result.state).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('private runtime path');
  });
});
