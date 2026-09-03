import type { PluginManifest, PluginPackageResourcePayload } from '../../types/plugin';
import {
  normalizeGithubRepository,
  parsePluginBundle,
  parsePluginManifest,
} from './pluginManifest';

const REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/Tenney95/AI-Canvas-tauri/master/public/plugin-marketplace.json';
const LOCAL_CATALOG_URL = '/plugin-marketplace.json';
const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_RELEASE_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_MARKETPLACE_PLUGINS = 100;
const RELEASE_TAG_RE = /^v?(\d+\.\d+\.\d+)$/;

type Fetcher = typeof fetch;

export interface PluginMarketplaceCatalogEntry {
  repository: string;
  featured: boolean;
}

export interface ResolvedGithubPlugin {
  repository: string;
  releaseTag: string;
  releaseUrl: string;
  publishedAt?: string;
  manifest: PluginManifest;
  manifestText: string;
  source: string;
  uiSource?: string;
  resourcePayloads: PluginPackageResourcePayload[];
}

export type PluginMarketplaceItem =
  | (ResolvedGithubPlugin & { status: 'ready'; featured: boolean })
  | { status: 'error'; repository: string; featured: boolean; error: string };

const releaseCache = new Map<string, { expiresAt: number; plugin: ResolvedGithubPlugin }>();

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function canonicalRepository(value: string): string {
  const trimmed = value.trim();
  return normalizeGithubRepository(trimmed.includes('://') ? trimmed : `https://github.com/${trimmed}`);
}

function githubRepositoryParts(repository: string): [string, string] {
  const parts = new URL(repository).pathname.split('/').filter(Boolean);
  return [parts[0], parts[1]];
}

async function fetchText(fetcher: Fetcher, url: string, maxBytes: number, accept?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: accept ? { Accept: accept } : undefined,
    });
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('下载内容过大');
    const text = await response.text();
    if (new Blob([text]).size > maxBytes) throw new Error('下载内容过大');
    return text;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('请求超时', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytes(fetcher: Fetcher, url: string, maxBytes: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('下载内容过大');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('下载内容过大');
    return bytes;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('请求超时', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parsePluginMarketplaceCatalog(text: string): PluginMarketplaceCatalogEntry[] {
  if (new Blob([text]).size > MAX_CATALOG_BYTES) throw new Error('插件市场索引过大');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('插件市场索引不是有效 JSON');
  }
  const catalog = objectValue(raw, '插件市场索引');
  if (catalog.schemaVersion !== 1) throw new Error('不支持的插件市场索引版本');
  if (!Array.isArray(catalog.plugins) || catalog.plugins.length > MAX_MARKETPLACE_PLUGINS) {
    throw new Error(`插件市场索引最多允许 ${MAX_MARKETPLACE_PLUGINS} 个插件`);
  }
  const seen = new Set<string>();
  return catalog.plugins.map((value, index) => {
    const entry = objectValue(value, `plugins[${index}]`);
    if (typeof entry.repository !== 'string') throw new Error(`plugins[${index}].repository 必须是字符串`);
    if (entry.featured !== undefined && typeof entry.featured !== 'boolean') {
      throw new Error(`plugins[${index}].featured 必须是布尔值`);
    }
    const repository = canonicalRepository(entry.repository);
    if (seen.has(repository)) throw new Error(`插件市场索引包含重复仓库：${repository}`);
    seen.add(repository);
    return { repository, featured: entry.featured === true };
  });
}

function semanticVersionParts(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`版本号必须使用 X.Y.Z 格式：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function comparePluginVersions(left: string, right: string): number {
  const a = semanticVersionParts(left);
  const b = semanticVersionParts(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export async function resolveGithubPlugin(
  repositoryInput: string,
  options: { fetcher?: Fetcher; force?: boolean } = {},
): Promise<ResolvedGithubPlugin> {
  const fetcher = options.fetcher ?? fetch;
  const repository = canonicalRepository(repositoryInput);
  const cached = releaseCache.get(repository);
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.plugin;

  const [owner, repo] = githubRepositoryParts(repository);
  const releaseText = await fetchText(
    fetcher,
    `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    MAX_RELEASE_BYTES,
    'application/vnd.github+json',
  );
  const release = objectValue(JSON.parse(releaseText), 'GitHub Release');
  const releaseTag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const tagMatch = RELEASE_TAG_RE.exec(releaseTag);
  if (!tagMatch) throw new Error('最新 GitHub Release 标签必须使用 vX.Y.Z');
  if (release.draft === true || release.prerelease === true) throw new Error('不能安装草稿或预发布版本');

  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${releaseTag}`;
  const manifestText = await fetchText(fetcher, `${rawBase}/manifest.json`, MAX_MANIFEST_BYTES);
  const declaredManifest = parsePluginManifest(manifestText);
  const source = await fetchText(fetcher, `${rawBase}/${declaredManifest.entry}`, MAX_SOURCE_BYTES);
  const manifest = parsePluginBundle(manifestText, source);
  if (!manifest.repository || manifest.repository !== repository) {
    throw new Error('Manifest repository 与 GitHub 仓库不一致');
  }
  if (manifest.version !== tagMatch[1]) {
    throw new Error(`Manifest 版本 ${manifest.version} 与 Release 标签 ${releaseTag} 不一致`);
  }
  const uiSource = manifest.ui
    ? await fetchText(fetcher, `${rawBase}/${manifest.ui.entry}`, 2 * 1024 * 1024)
    : undefined;
  const resourcePayloads = await Promise.all((manifest.resources ?? []).map(async (resource) => ({
    id: resource.id,
    bytes: Array.from(await fetchBytes(fetcher, `${rawBase}/${resource.path}`, resource.bytes)),
  })));

  const plugin: ResolvedGithubPlugin = {
    repository,
    releaseTag,
    releaseUrl: typeof release.html_url === 'string' ? release.html_url : `${repository}/releases/tag/${releaseTag}`,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
    manifest,
    manifestText,
    source,
    uiSource,
    resourcePayloads,
  };
  releaseCache.set(repository, { expiresAt: Date.now() + CACHE_TTL_MS, plugin });
  return plugin;
}

async function loadCatalog(fetcher: Fetcher): Promise<PluginMarketplaceCatalogEntry[]> {
  let remoteError: unknown;
  try {
    return parsePluginMarketplaceCatalog(await fetchText(fetcher, REMOTE_CATALOG_URL, MAX_CATALOG_BYTES));
  } catch (error) {
    remoteError = error;
  }
  try {
    return parsePluginMarketplaceCatalog(await fetchText(fetcher, LOCAL_CATALOG_URL, MAX_CATALOG_BYTES));
  } catch {
    throw remoteError;
  }
}

export async function loadPluginMarketplace(
  installedRepositories: string[] = [],
  options: { fetcher?: Fetcher; force?: boolean } = {},
): Promise<PluginMarketplaceItem[]> {
  const fetcher = options.fetcher ?? fetch;
  const catalog = await loadCatalog(fetcher);
  const repositories = new Map(catalog.map((entry) => [entry.repository, entry.featured]));
  for (const value of installedRepositories) {
    const repository = canonicalRepository(value);
    if (!repositories.has(repository)) repositories.set(repository, false);
  }
  const items = await Promise.all(Array.from(repositories, async ([repository, featured]): Promise<PluginMarketplaceItem> => {
    try {
      return {
        ...(await resolveGithubPlugin(repository, { fetcher, force: options.force })),
        status: 'ready',
        featured,
      };
    } catch (error) {
      return {
        status: 'error',
        repository,
        featured,
        error: error instanceof Error ? error.message : '无法读取插件仓库',
      };
    }
  }));
  return items.sort((left, right) => Number(right.featured) - Number(left.featured));
}
