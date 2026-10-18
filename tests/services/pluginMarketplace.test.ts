import { describe, expect, it, vi } from 'vitest';
import {
  comparePluginVersions,
  loadPluginMarketplace,
  parsePluginMarketplaceCatalog,
  pluginMarketplaceKey,
  resolveGithubPlugin,
} from '../../src/services/plugins/pluginMarketplace';
import type { PluginMarketplaceDownloadProgress } from '../../src/services/plugins/pluginMarketplace';

function pluginManifest(repository: string, version = '1.2.0', id = 'com.example.marketplace-tool'): string {
  return JSON.stringify({
    apiVersion: 1,
    id,
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
    apiVersion: 1,
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

  it('插件下载网络失败切源，仍校验原仓库身份和包内容', async () => {
    const repository = 'https://github.com/example/fallback-plugin';
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v1.2.0',
        html_url: `${repository}/releases/tag/v1.2.0`, draft: false, prerelease: false }));
      if (url.endsWith('/manifest.json')) return new Response(pluginManifest(repository));
      return new Response('definePlugin({ tools: {} });');
    });
    const plugin = await resolveGithubPlugin(repository, { fetcher, force: true });
    expect(plugin.manifest.repository).toBe(repository);
    expect(fetcher.mock.calls.some(([source]) => String(source).startsWith('https://gh-proxy.com/https://api.github.com/'))).toBe(true);
  });

  it('registers independent directories in one repository and rejects a repeated directory', () => {
    const first = { repository: 'example/collection', directory: 'plugins/first', releaseTag: 'first-v1.2.0' };
    const second = { repository: first.repository, directory: 'second', releaseTag: 'second-v1.0.0' };
    const entries = parsePluginMarketplaceCatalog(JSON.stringify({ schemaVersion: 1, plugins: [first, second] }));
    expect(entries).toHaveLength(2);
    expect(pluginMarketplaceKey(entries[0])).not.toBe(pluginMarketplaceKey(entries[1]));
    expect(() => parsePluginMarketplaceCatalog(JSON.stringify({
      schemaVersion: 1, plugins: [first, { ...first, releaseTag: 'first-v1.3.0' }],
    }))).toThrow('重复插件');
  });

  it.each(['../escape', 'a/../escape', './first', '/first', 'a//first', 'a/', 'a\\first', 'C:/first', 'a/%2e%2e/first', 'a?ref=main', 'a#first', ''])(
    'rejects unsafe directory %s before any download', async (directory) => {
      const fetcher = vi.fn() as unknown as typeof fetch;
      await expect(resolveGithubPlugin('example/unsafe-directory', {
        directory, releaseTag: 'first-v1.2.0', fetcher,
      })).rejects.toThrow('相对目录');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'first-v1.2.0-beta', 'first/v1.2.0', '../v1.2.0', 'main'])(
    'rejects missing or unstable directory releaseTag %s', (releaseTag) => {
      expect(() => parsePluginMarketplaceCatalog(JSON.stringify({
        schemaVersion: 1, plugins: [{ repository: 'example/collection', directory: 'first', releaseTag }],
      }))).toThrow('releaseTag');
    },
  );

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

  it('reports streamed bytes and preserves Chinese text across chunk boundaries', async () => {
    const repository = 'https://github.com/example/streamed-progress';
    const source = 'definePlugin({ tools: {} }); // 中文';
    const bytes = new TextEncoder().encode(source);
    const split = bytes.byteLength - 2;
    const progress: PluginMarketplaceDownloadProgress[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v1.2.0' }));
      if (url.endsWith('/manifest.json')) return new Response(pluginManifest(repository));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, split));
          controller.enqueue(bytes.subarray(split));
          controller.close();
        },
      }), { headers: { 'content-length': String(bytes.byteLength) } });
    }) as typeof fetch;

    const plugin = await resolveGithubPlugin(repository, { fetcher, force: true, onProgress: (value) => progress.push(value) });

    expect(plugin.source).toBe(source);
    expect(progress.filter(({ fileName }) => fileName === 'main.js').map(({ downloadedBytes }) => downloadedBytes))
      .toEqual([0, split, bytes.byteLength]);
    expect(progress.at(-1)).toMatchObject({ downloadedBytes: bytes.byteLength, totalBytes: bytes.byteLength });
  });

  it.each([undefined, 'gzip'])('drops an unreliable response total for encoding %s', async (encoding) => {
    const repository = `https://github.com/example/unreliable-size-${encoding ?? 'identity'}`;
    const source = 'definePlugin({ tools: {} });';
    const progress: PluginMarketplaceDownloadProgress[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v1.2.0' }));
      if (url.endsWith('/manifest.json')) return new Response(pluginManifest(repository));
      return new Response(source, {
        headers: { 'content-length': '4', ...(encoding ? { 'content-encoding': encoding } : {}) },
      });
    }) as typeof fetch;

    await resolveGithubPlugin(repository, { fetcher, force: true, onProgress: (value) => progress.push(value) });

    const sourceProgress = progress.filter(({ fileName }) => fileName === 'main.js');
    expect(sourceProgress.at(-1)).toMatchObject({ downloadedBytes: new TextEncoder().encode(source).byteLength });
    expect(sourceProgress.at(-1)?.totalBytes).toBeUndefined();
    if (encoding) expect(sourceProgress.every(({ totalBytes }) => totalBytes === undefined)).toBe(true);
  });

  it('cancels a streamed source as soon as its existing byte limit is exceeded', async () => {
    const repository = 'https://github.com/example/oversized-stream';
    const cancel = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v1.2.0' }));
      if (url.endsWith('/manifest.json')) return new Response(pluginManifest(repository));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(512 * 1024));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      }));
    }) as typeof fetch;

    await expect(resolveGithubPlugin(repository, { fetcher, force: true })).rejects.toThrow('下载内容过大');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('accumulates parallel directory downloads without inventing a marketplace total', async () => {
    const repository = 'https://github.com/example/parallel-progress';
    const entries = ['first', 'second'].map((directory) => ({ repository, directory, releaseTag: `${directory}-v1.2.0` }));
    const progress: PluginMarketplaceDownloadProgress[] = [];
    let expectedBytes = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let text: string;
      if (url.endsWith('/plugin-marketplace.json')) text = JSON.stringify({ schemaVersion: 1, plugins: entries });
      else if (url.includes('/releases/tags/')) text = JSON.stringify({ tag_name: url.split('/').at(-1) });
      else if (url.endsWith('/manifest.json')) text = pluginManifest(repository);
      else text = 'definePlugin({ tools: {} });';
      const bytes = new TextEncoder().encode(text).byteLength;
      expectedBytes += bytes;
      return new Response(text, { headers: { 'content-length': String(bytes) } });
    }) as typeof fetch;

    const items = await loadPluginMarketplace([], { fetcher, force: true, onProgress: (value) => progress.push(value) });

    expect(items.every(({ status }) => status === 'ready')).toBe(true);
    expect(progress.at(-1)?.downloadedBytes).toBe(expectedBytes);
    expect(progress.every(({ totalBytes }) => totalBytes === undefined)).toBe(true);
    expect(progress.at(-1)?.currentFileTotalBytes).toBeGreaterThan(0);
    expect(progress.at(-1)?.currentFileDownloadedBytes).toBe(progress.at(-1)?.currentFileTotalBytes);
    expect(progress.every((value, index) => index === 0 || value.downloadedBytes >= progress[index - 1].downloadedBytes)).toBe(true);
  });

  it('downloads the Python entry declared by a trusted Plugin API v1 plugin', async () => {
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

  it('downloads the UI and declared resources from the pinned plugin directory', async () => {
    const repository = 'https://github.com/example/directory-assets';
    const directory = 'plugins/first';
    const releaseTag = 'first-v1.2.0';
    const rawBase = `https://raw.githubusercontent.com/example/directory-assets/${releaseTag}/${directory}`;
    const value = JSON.parse(pluginManifest(repository));
    value.permissions.push('ui.custom', 'plugin.resources.read');
    value.ui = { entry: 'ui.js', integrity: `sha256-${'a'.repeat(64)}`, exports: { panel: 'Panel' } };
    value.contributes.nodeTools[0].dialog = { title: '界面', fields: [], ui: 'panel' };
    value.resources = [{ id: 'data', path: 'resources/data.json', integrity: `sha256-${'b'.repeat(64)}`, mediaType: 'application/json', bytes: 2 }];
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === `https://api.github.com/repos/example/directory-assets/releases/tags/${releaseTag}`) {
        return new Response(JSON.stringify({ tag_name: releaseTag, draft: false, prerelease: false }));
      }
      if (url === `${rawBase}/manifest.json`) return new Response(JSON.stringify(value));
      if (url === `${rawBase}/main.js`) return new Response('definePlugin({ tools: {} });');
      if (url === `${rawBase}/ui.js`) return new Response('export function Panel() {}');
      if (url === `${rawBase}/resources/data.json`) return new Response('{}');
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const plugin = await resolveGithubPlugin(repository, { directory, releaseTag, fetcher, force: true });
    expect(plugin.directory).toBe(directory);
    expect(plugin.uiSource).toBe('export function Panel() {}');
    expect(plugin.resourcePayloads).toEqual([{ id: 'data', bytes: [123, 125] }]);
    expect(urls).toHaveLength(5);
    expect(urls.some((url) => url.endsWith('/releases/latest'))).toBe(false);
  });

  it.each([
    { release: { draft: true }, error: '草稿或预发布' },
    { release: { prerelease: true }, error: '草稿或预发布' },
    { release: { tag_name: 'other-v1.2.0' }, error: '标签与市场登记' },
  ])('rejects invalid pinned Release metadata: $error', async ({ release, error }) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'first-v1.2.0', ...release }))) as typeof fetch;
    await expect(resolveGithubPlugin('example/pinned-rejection', {
      directory: 'first', releaseTag: 'first-v1.2.0', fetcher, force: true,
    })).rejects.toThrow(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { manifestRepository: 'https://github.com/example/elsewhere', version: '1.2.0', error: 'repository' },
    { manifestRepository: 'https://github.com/example/pinned-identity', version: '1.2.1', error: '与 Release 标签' },
  ])('checks pinned Manifest identity and version: $error', async ({ manifestRepository, version, error }) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/releases/tags/')) return new Response(JSON.stringify({ tag_name: 'first-v1.2.0' }));
      if (String(input).endsWith('/manifest.json')) return new Response(pluginManifest(manifestRepository, version));
      return new Response('definePlugin({ tools: {} });');
    }) as typeof fetch;
    await expect(resolveGithubPlugin('example/pinned-identity', {
      directory: 'first', releaseTag: 'first-v1.2.0', fetcher, force: true,
    })).rejects.toThrow(error);
  });

  it('keeps directory and version caches independent', async () => {
    const repository = 'https://github.com/example/cache-collection';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/tags/')) return new Response(JSON.stringify({ tag_name: url.split('/').at(-1) }));
      if (url.endsWith('/manifest.json')) {
        const parts = url.split('/');
        const directory = parts.at(-2)!;
        const version = parts.at(-3)!.split('-v')[1];
        return new Response(pluginManifest(repository, version, `com.example.${directory}`));
      }
      return new Response('definePlugin({ tools: {} });');
    }) as typeof fetch;
    const first = await resolveGithubPlugin(repository, { directory: 'first', releaseTag: 'first-v1.2.0', fetcher, force: true });
    const second = await resolveGithubPlugin(repository, { directory: 'second', releaseTag: 'second-v1.2.0', fetcher });
    const update = await resolveGithubPlugin(repository, { directory: 'first', releaseTag: 'first-v1.2.1', fetcher });
    expect(first.manifest.id).toBe('com.example.first');
    expect(second.manifest.id).toBe('com.example.second');
    expect(update.manifest.version).toBe('1.2.1');
    expect(await resolveGithubPlugin(repository, { directory: 'first', releaseTag: 'first-v1.2.0', fetcher })).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it('loads multiple directory entries and legacy installed repositories without adding a collection root', async () => {
    const repository = 'https://github.com/example/catalog-collection';
    const entries = [
      { repository, directory: 'first', releaseTag: 'first-v1.2.0', featured: true },
      { repository, directory: 'second', releaseTag: 'second-v1.2.0' },
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/plugin-marketplace.json')) return new Response(JSON.stringify({ schemaVersion: 1, plugins: entries }));
      if (url.includes('/releases/tags/')) return new Response(JSON.stringify({ tag_name: url.split('/').at(-1) }));
      if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v1.2.0' }));
      if (url.endsWith('/manifest.json')) {
        const collection = url.includes('/catalog-collection/');
        const directory = url.split('/').at(-2)!;
        return new Response(pluginManifest(collection ? repository : 'https://github.com/example/unlisted', '1.2.0', `com.example.${collection ? directory : 'legacy'}`));
      }
      return new Response('definePlugin({ tools: {} });');
    }) as typeof fetch;
    const items = await loadPluginMarketplace([repository, 'example/unlisted', 'example/unlisted'], { fetcher, force: true });
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.status === 'ready')).toBe(true);
    expect(items.map(pluginMarketplaceKey)).toEqual([`${repository}#first`, `${repository}#second`, 'https://github.com/example/unlisted']);
    expect(fetcher).not.toHaveBeenCalledWith('https://api.github.com/repos/example/catalog-collection/releases/latest', expect.anything());
  });

  it('preserves the directory identity of failed items when using the local catalog fallback', async () => {
    const entry = { repository: 'https://github.com/example/fallback-collection', directory: 'first', releaseTag: 'first-v1.2.0' };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === '/plugin-marketplace.json'
      ? new Response(JSON.stringify({ schemaVersion: 1, plugins: [entry] }))
      : new Response('', { status: 404 })) as typeof fetch;
    const items = await loadPluginMarketplace([], { fetcher, force: true });
    expect(items).toEqual([{ ...entry, status: 'error', featured: false, error: '请求失败（HTTP 404）' }]);
  });
});
