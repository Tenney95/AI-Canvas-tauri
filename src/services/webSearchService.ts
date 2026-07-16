import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import type { WebSource } from '../types/chat';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const allowedUrlsByConversation = new Map<string, Set<string>>();
const citationByConversation = new Map<string, Map<string, string>>();

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

interface NativeSearchResponse {
  status: number;
  body: string;
  fetchedAt: number;
}

export interface WebSearchResult {
  query: string;
  sources: WebSource[];
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

export function normalizePublicWebUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.home.arpa')
    ) return null;
    if (
      /^(?:0|10|127|169\.254|192\.168)\./.test(hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
      || hostname === '::1'
      || hostname.startsWith('fc')
      || hostname.startsWith('fd')
      || hostname.startsWith('fe80:')
    ) return null;
    if (url.port && !['80', '443'].includes(url.port)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function rememberWebSources(conversationId: string, sources: WebSource[]): void {
  const allowed = allowedUrlsByConversation.get(conversationId) ?? new Set<string>();
  for (const source of sources) {
    const normalized = normalizePublicWebUrl(source.url);
    if (normalized) allowed.add(normalized);
  }
  allowedUrlsByConversation.set(conversationId, allowed);
}

export function assignWebSourceCitations(
  conversationId: string,
  sources: WebSource[],
): WebSource[] {
  const citations = citationByConversation.get(conversationId) ?? new Map<string, string>();
  const next = sources.map((source) => {
    const existing = citations.get(source.url);
    if (existing) return { ...source, citationId: existing };
    const citationId = `S${citations.size + 1}`;
    citations.set(source.url, citationId);
    return { ...source, citationId };
  });
  citationByConversation.set(conversationId, citations);
  return next;
}

export function isWebUrlAllowed(
  conversationId: string,
  rawUrl: string,
  userMessage: string,
): boolean {
  const normalized = normalizePublicWebUrl(rawUrl);
  if (!normalized) return false;
  if (allowedUrlsByConversation.get(conversationId)?.has(normalized)) return true;
  const mentionedUrls = userMessage.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return mentionedUrls.some((candidate) => normalizePublicWebUrl(candidate) === normalized);
}

function toSources(response: TavilyResponse, fetchedAt: number): WebSource[] {
  const sources: WebSource[] = [];
  for (const result of response.results ?? []) {
    const url = result.url ? normalizePublicWebUrl(result.url) : null;
    if (!url) continue;
    const parsed = new URL(url);
    sources.push({
      id: `web-${sources.length + 1}-${Math.random().toString(36).slice(2, 7)}`,
      title: result.title?.trim() || parsed.hostname,
      url,
      domain: parsed.hostname,
      snippet: result.content?.trim().slice(0, 1200),
      fetchedAt,
      sourceType: 'search',
    });
  }
  return sources;
}

export async function searchWeb(
  query: string,
  conversationId: string,
  options: {
    maxResults?: number;
    topic?: 'general' | 'news' | 'finance';
    signal?: AbortSignal;
  } = {},
): Promise<WebSearchResult> {
  const apiKey = useAppStore.getState().config.providers.tavily?.apiKey?.trim();
  if (!apiKey) throw new Error('请先在设置中配置 Tavily API Key');
  const trimmedQuery = query.trim();
  if (!trimmedQuery) throw new Error('搜索词不能为空');
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  let body: string;
  let fetchedAt = Date.now();
  if (isTauriRuntime()) {
    const response = await invoke<NativeSearchResponse>('assistant_web_search', {
      request: {
        apiKey,
        query: trimmedQuery,
        maxResults: Math.min(10, Math.max(1, options.maxResults ?? 5)),
        topic: options.topic ?? 'general',
      },
    });
    body = response.body;
    fetchedAt = response.fetchedAt;
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  } else {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: trimmedQuery,
        search_depth: 'basic',
        topic: options.topic ?? 'general',
        max_results: Math.min(10, Math.max(1, options.maxResults ?? 5)),
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Tavily 搜索失败（HTTP ${response.status}）`);
    body = await response.text();
  }

  const parsed = JSON.parse(body) as TavilyResponse;
  const sources = assignWebSourceCitations(
    conversationId,
    toSources(parsed, fetchedAt),
  );
  if (sources.length === 0) throw new Error('搜索没有返回可用的公网来源');
  rememberWebSources(conversationId, sources);
  return { query: trimmedQuery, sources };
}
