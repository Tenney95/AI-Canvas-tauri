import { describe, expect, it, vi } from 'vitest';
import {
  comparePluginVersions,
  parsePluginMarketplaceCatalog,
  resolveGithubPlugin,
} from '../../src/services/plugins/pluginMarketplace';

function pluginManifest(repository: string, version = '1.2.0'): string {
  return JSON.stringify({
    apiVersion: 1,
    id: 'com.example.marketplace-tool',
    name: '市场插件',
    version,
    repository,
    license: 'MIT',
    category: 'content',
    entry: 'main.js',
    permissions: ['node.read', 'node.write'],
    contributes: {
      nodeTools: [{
        id: 'uppercase',
        title: '转大写',
        placements: ['node-context-menu'],
        nodeTypes: ['ai-text'],
        inputFields: ['output'],
        output: { mode: 'update-current', fields: ['output'] },
      }],
    },
  });
}

function pythonPluginManifest(repository: string): string {
  return JSON.stringify({
    apiVersion: 3,
    runtime: 'python',
    id: 'com.example.python-tool',
    name: 'Python 插件',
    version: '1.2.0',
    repository,
    category: 'content',
    entry: 'main.py',
    permissions: ['node.read', 'node.write'],
    contributes: {
      nodeTools: [{
        id: 'uppercase',
        title: '转大写',
        placements: ['node-context-menu'],
        nodeTypes: ['ai-text'],
        inputFields: ['output'],
        output: { mode: 'update-current', fields: ['output'] },
      }],
    },
  });
}

describe('GitHub plugin marketplace', () => {
  it('validates and normalizes marketplace repositories', () => {
    expect(parsePluginMarketplaceCatalog(JSON.stringify({
      schemaVersion: 1,
      plugins: [{ repository: 'example/marketplace-tool', featured: true }],
    }))).toEqual([{
      repository: 'https://github.com/example/marketplace-tool',
      featured: true,
    }]);

    expect(() => parsePluginMarketplaceCatalog(JSON.stringify({
      schemaVersion: 1,
      plugins: [{ repository: 'https://example.com/unsafe/plugin' }],
    }))).toThrow('github.com');
  });

  it('compares stable semantic versions', () => {
    expect(comparePluginVersions('1.10.0', '1.2.9')).toBe(1);
    expect(comparePluginVersions('2.0.0', '2.0.0')).toBe(0);
    expect(comparePluginVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  it('resolves a GitHub release through the normal plugin validator', async () => {
    const repository = 'https://github.com/example/marketplace-tool';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/latest')) {
        return new Response(JSON.stringify({
          tag_name: 'v1.2.0',
          html_url: `${repository}/releases/tag/v1.2.0`,
          published_at: '2026-08-24T00:00:00Z',
          draft: false,
          prerelease: false,
        }));
      }
      if (url.endsWith('/manifest.json')) return new Response(pluginManifest(repository));
      if (url.endsWith('/main.js')) return new Response('definePlugin({ tools: {} });');
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const plugin = await resolveGithubPlugin(repository, { fetcher, force: true });

    expect(plugin.releaseTag).toBe('v1.2.0');
    expect(plugin.manifest.repository).toBe(repository);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('downloads the Python entry declared by a trusted v3 plugin', async () => {
    const repository = 'https://github.com/example/python-tool';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/latest')) {
        return new Response(JSON.stringify({ tag_name: 'v1.2.0', draft: false, prerelease: false }));
      }
      if (url.endsWith('/manifest.json')) return new Response(pythonPluginManifest(repository));
      if (url.endsWith('/main.py')) return new Response('define_plugin({"tools": {}})');
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const plugin = await resolveGithubPlugin(repository, { fetcher, force: true });

    expect(plugin.manifest.runtime).toBe('python');
    expect(plugin.manifest.entry).toBe('main.py');
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/main.py'), expect.anything());
  });

  it('rejects a release whose tag and Manifest version differ', async () => {
    const repository = 'https://github.com/example/version-mismatch';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/latest')) {
        return new Response(JSON.stringify({ tag_name: 'v2.0.0', draft: false, prerelease: false }));
      }
      if (url.endsWith('/manifest.json')) return new Response(pluginManifest(repository, '1.0.0'));
      return new Response('definePlugin({ tools: {} });');
    }) as typeof fetch;

    await expect(resolveGithubPlugin(repository, { fetcher, force: true }))
      .rejects.toThrow('与 Release 标签');
  });
});
