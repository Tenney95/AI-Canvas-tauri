import { describe, expect, it } from 'vitest';
import type { InstalledPlugin } from '../../src/types/plugin';
import { affectedPluginIds, compareDependencyVersions, parsePluginDependencies, resolvePluginDependencies } from '../../src/services/plugins/pluginDependencyService';

function plugin(id: string, dependencies: InstalledPlugin['manifest']['dependencies'] = []): InstalledPlugin {
  return { id, source: '', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64), enabled: true, installedAt: 1, updatedAt: 1,
    manifest: { apiVersion: 2, id, name: id, version: '1.2.0', runtime: 'javascript', entry: 'main.js', category: 'utility',
      permissions: [], dependencies, requiredCapabilities: ['plugin.dependencies'], contributes: { nodeTools: [] } } };
}

describe('plugin dependency leases', () => {
  it('blocks required but only diagnoses absent optional dependencies', () => {
    const required = plugin('a', [{ pluginId: 'missing' }]);
    expect(resolvePluginDependencies([required], 'a').ready).toBe(false);
    required.manifest.dependencies![0].optional = true;
    expect(resolvePluginDependencies([required], 'a')).toMatchObject({ ready: true, warnings: ['依赖不可用：missing'] });
  });
  it('rejects cycles including optional edges and changed dependency revisions', () => {
    const a = plugin('a', [{ pluginId: 'b' }]);
    const b = plugin('b');
    const before = resolvePluginDependencies([a, b], 'a');
    b.revisionDigest = 'c'.repeat(64);
    expect(resolvePluginDependencies([a, b], 'a').fingerprint).not.toBe(before.fingerprint);
    b.manifest.dependencies = [{ pluginId: 'a', optional: true }];
    expect(resolvePluginDependencies([a, b], 'a').ready).toBe(false);
  });
  it('bounds versions, duplicate entries and unsupported fields', () => {
    expect(compareDependencyVersions('1.10.0', '1.2.9')).toBeGreaterThan(0);
    for (const value of [[{ pluginId: 'a' }], [{ pluginId: 'b' }, { pluginId: 'b' }], [{ pluginId: 'b', path: '/private' }],
      [{ pluginId: 'b', minVersion: '1.0.0-beta' }], Array.from({ length: 17 }, (_, i) => ({ pluginId: `p${i}` }))]) {
      expect(() => parsePluginDependencies(value, 'a')).toThrow();
    }
  });
  it('finds transitive dependents without affecting unrelated plugins', () => {
    expect(new Set(affectedPluginIds([plugin('a', [{ pluginId: 'b' }]), plugin('b', [{ pluginId: 'c' }]), plugin('x')], 'c')))
      .toEqual(new Set(['a', 'b', 'c']));
  });
});
