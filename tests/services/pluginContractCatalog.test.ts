import { describe, expect, it } from 'vitest';
import { inspectPluginContract } from '../../src/services/plugins/pluginContractCatalog';
import { PLUGIN_HOST } from '../../src/services/plugins/pluginHost';

describe('public plugin contracts', () => {
  it('exposes supported capabilities without claiming granted authority', () => {
    const result = inspectPluginContract({ section: 'host' });
    expect(result.entries[0].contract.capabilities).toEqual(PLUGIN_HOST.capabilities);
    expect(result.entries[0].summary).toContain('不代表');
    expect(result.hostVersion).toBe(PLUGIN_HOST.version);
  });
  it('keeps complete JSON entries under budget and stable pagination', () => {
    const first = inspectPluginContract({ section: 'sdk', limit: 2 });
    const next = inspectPluginContract({ section: 'sdk', limit: 2, offset: first.nextOffset });
    expect(first.hasMore).toBe(true);
    expect(next.entries[0].id).not.toBe(first.entries[0].id);
    expect(new TextEncoder().encode(JSON.stringify(first.entries)).length).toBeLessThanOrEqual(16384);
    expect(inspectPluginContract({ query: 'video.replicaJob.start' }).entries[0].contract.fields).toContain('controls');
  });
  it('rejects object paths and invalid pagination rather than reflecting internal objects', () => {
    expect(() => inspectPluginContract({ section: 'config.providers' as never })).toThrow();
    expect(() => inspectPluginContract({ limit: 9 })).toThrow();
    expect(inspectPluginContract({ query: 'apiKey' }).entries).toEqual([]);
    expect(inspectPluginContract({ section: 'ui' }).entries[0].contract.uiKit).toContain('未注入');
  });
});
