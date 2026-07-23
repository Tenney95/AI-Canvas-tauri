import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import type { WebSource } from '../types/chat';
import type { WebSearchProviderId } from '../types';
import {
  getProviderDefinition,
  resolveWebSearchProviderId,
} from './ai/providerCatalogService';
import { readWebPage, type WebPageLink } from './webPageService';
import {
  assignWebSourceCitations,
  normalizePublicWebUrl,
  rememberWebSources,
} from './chat/webAccessGrantService';

interface SearchResultCandidate {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
}

interface NativeSearchResponse {
  body: string;
  fetchedAt: number;
}

export interface WebSearchResult {
  query: string;
  sources: WebSource[];
}

const BUILT_IN_SEARCH_PAGE_BUILDERS = [
  (query: string) => {
    const params = new URLSearchParams({
      q: query,
      hl: 'zh-CN',
      gl: 'CN',
      ceid: 'CN:zh-Hans',
    });
    return `https://news.google.com/rss/search?${params.toString()}`;
  },
  (query: string) => {
    const params = new URLSearchParams({ query });
    return `https://www.sogou.com/web?${params.toString()}`;
  },
] as const;

function isBuiltInSearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'bing.com'
    || host.endsWith('.bing.com')
    || host === 'duckduckgo.com'
    || host.endsWith('.duckduckgo.com');
}

function decodeBingTarget(value: string): string | null {
  if (!value.startsWith('a1')) return value.startsWith('http') ? value : null;
  try {
    const encoded = value.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    return globalThis.atob(padded);
  } catch {
    return null;
  }
}

function unwrapBuiltInSearchUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    let candidate = rawUrl;
    if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) {
      candidate = parsed.searchParams.get('uddg') ?? rawUrl;
    } else if ((host === 'bing.com' || host.endsWith('.bing.com')) && parsed.pathname === '/ck/a') {
      candidate = decodeBingTarget(parsed.searchParams.get('u') ?? '') ?? rawUrl;
    }
    const normalized = normalizePublicWebUrl(candidate);
    if (!normalized || isBuiltInSearchHost(new URL(normalized).hostname)) return null;
    return normalized;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSearchResults(
  results: SearchResultCandidate[],
  fetchedAt: number,
): WebSource[] {
  const unique = new Map<string, WebSource>();
  for (const item of results) {
    const url = typeof item.url === 'string' ? normalizePublicWebUrl(item.url) : null;
    if (!url || unique.has(url)) continue;
    const parsed = new URL(url);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const snippet = typeof item.snippet === 'string' ? item.snippet.trim().slice(0, 1_200) : '';
    unique.set(url, {
      id: `web-${fetchedAt}-${unique.size + 1}`,
      title: title || parsed.hostname,
      url,
      domain: parsed.hostname,
      snippet: snippet || undefined,
      fetchedAt,
      sourceType: 'search',
    });
  }
  return [...unique.values()];
}

function parseBuiltInSearchLinks(
  links: WebPageLink[],
  fetchedAt: number,
  maxResults: number,
): WebSource[] {
  return normalizeSearchResults(links.map((link) => ({
    title: link.title,
    url: unwrapBuiltInSearchUrl(link.url),
  })), fetchedAt).slice(0, maxResults);
}

async function searchBuiltInWeb(
  query: string,
  taskId: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchResult> {
  let lastError: unknown;
  for (const buildSearchUrl of BUILT_IN_SEARCH_PAGE_BUILDERS) {
    try {
      const page = await readWebPage(buildSearchUrl(query), {
        signal,
        charLimit: 6_000,
        linkLimit: 160,
      });
      const sources = assignWebSourceCitations(
        taskId,
        parseBuiltInSearchLinks(page.links, page.source.fetchedAt, maxResults),
      );
      if (sources.length === 0) continue;
      rememberWebSources(taskId, sources);
      return { query, sources };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw new Error(lastError instanceof Error
    ? `内置搜索失败：${lastError.message}`
    : '内置搜索没有返回可用的公网来源');
}

export function parseTavilySearchResponse(payload: unknown, fetchedAt: number): WebSource[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
  return normalizeSearchResults(payload.results.filter(isRecord).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.content,
  })), fetchedAt);
}

export function parseBochaSearchResponse(payload: unknown, fetchedAt: number): WebSource[] {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.webPages)) return [];
  const results = payload.data.webPages.value;
  if (!Array.isArray(results)) return [];
  return normalizeSearchResults(results.filter(isRecord).map((item) => ({
    title: item.name,
    url: item.url,
    snippet: typeof item.summary === 'string' && item.summary.trim() ? item.summary : item.snippet,
  })), fetchedAt);
}

export function parseZhipuSearchResponse(payload: unknown, fetchedAt: number): WebSource[] {
  if (!isRecord(payload) || !Array.isArray(payload.search_result)) return [];
  return normalizeSearchResults(payload.search_result.filter(isRecord).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.content,
  })), fetchedAt);
}

export function parseExaSearchResponse(payload: unknown, fetchedAt: number): WebSource[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
  return normalizeSearchResults(payload.results.filter(isRecord).map((item) => {
    const highlights = Array.isArray(item.highlights)
      ? item.highlights.filter((value): value is string => typeof value === 'string').join(' ')
      : '';
    return {
      title: item.title,
      url: item.url,
      snippet: typeof item.summary === 'string' && item.summary.trim()
        ? item.summary
        : highlights || item.text,
    };
  }), fetchedAt);
}

export function parseWebSearchResponse(
  providerId: WebSearchProviderId,
  payload: unknown,
  fetchedAt: number,
): WebSource[] {
  switch (providerId) {
    case 'tavily': return parseTavilySearchResponse(payload, fetchedAt);
    case 'bocha': return parseBochaSearchResponse(payload, fetchedAt);
    case 'zhipu-search': return parseZhipuSearchResponse(payload, fetchedAt);
    case 'exa': return parseExaSearchResponse(payload, fetchedAt);
  }
}

export function getConfiguredWebSearchProvider(): {
  providerId: WebSearchProviderId;
  apiKey: string;
  name: string;
} | null {
  const config = useAppStore.getState().config;
  const providerId = resolveWebSearchProviderId(config);
  if (!providerId) return null;
  const apiKey = config.providers[providerId]?.apiKey?.trim();
  if (!apiKey) return null;
  return {
    providerId,
    apiKey,
    name: getProviderDefinition(providerId)?.name || providerId,
  };
}

export async function searchWeb(
  query: string,
  taskId: string,
  options: {
    maxResults?: number;
    topic?: 'general' | 'news' | 'finance';
    signal?: AbortSignal;
  } = {},
): Promise<WebSearchResult> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || trimmedQuery.length > 500) throw new Error('搜索词长度必须为 1-500 个字符');
  if (typeof window === 'undefined' || !('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) {
    throw new Error('联网搜索仅在 Tauri 桌面环境可用');
  }
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const maxResults = Math.min(10, Math.max(1, options.maxResults ?? 5));
  const provider = getConfiguredWebSearchProvider();
  if (!provider) {
    return searchBuiltInWeb(trimmedQuery, taskId, maxResults, options.signal);
  }
  const response = await invoke<NativeSearchResponse>('assistant_web_search', {
    request: {
      provider: provider.providerId,
      apiKey: provider.apiKey,
      query: trimmedQuery,
      maxResults,
      topic: options.topic ?? 'general',
    },
  });
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error(`${provider.name} 搜索返回了无效 JSON`);
  }
  const sources = assignWebSourceCitations(
    taskId,
    parseWebSearchResponse(provider.providerId, payload, response.fetchedAt),
  );
  if (sources.length === 0) throw new Error('搜索没有返回可用的公网来源');
  rememberWebSources(taskId, sources);
  return { query: trimmedQuery, sources };
}
