import { describe, expect, it } from 'vitest';
import { inspectPluginContract } from '../../src/services/plugins/pluginContractCatalog';
import { PLUGIN_HOST } from '../../src/services/plugins/pluginHost';
import type { InstalledPlugin } from '../../src/types/plugin';

describe('public plugin contracts', () => {
  it('omits corrupted protocol metadata instead of reflecting arbitrary installed fields', () => {
    const plugin: InstalledPlugin = { id: 'example.protocol', enabled: true, installedAt: 1, updatedAt: 1, source: '',
      manifest: { apiVersion: 2, id: 'example.protocol', name: 'Example', version: '1.0.0', category: 'utility', entry: 'main.js', runtime: 'javascript', permissions: [],
        contributes: { nodeTools: [], modelProtocols: [{ id: 'responses', name: 'Responses', category: 'text', adapter: 'private-secret' as never }] } } };
    const result = inspectPluginContract({ section: 'plugins' }, [plugin]);
    expect(result.entries[0].contract.modelProtocols).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
  it('publishes bounded native protocol preset contract without arbitrary request codecs', () => {
    const entry = inspectPluginContract({ section: 'manifest', query: 'modelProtocols' }).entries[0];
    expect(entry.contract).toMatchObject({ apiVersion: 2, capability: 'model.protocolPresets', maxItems: 16, category: ['text'] });
    expect(entry.contract.adapters).toContain('openai-responses');
    expect(JSON.stringify(entry.contract)).not.toContain('apiKey');
  });
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
