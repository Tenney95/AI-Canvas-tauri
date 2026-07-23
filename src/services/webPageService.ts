import { invoke } from '@tauri-apps/api/core';
import type { WebSource } from '../types/chat';
import { normalizePublicWebUrl } from './chat/webAccessGrantService';

interface NativeWebReadResponse {
  url: string;
  contentType: string;
  body: string;
  fetchedAt: number;
}

export interface WebPageResult {
  source: WebSource;
  text: string;
  truncated: boolean;
  links: WebPageLink[];
}

export interface WebPageLink {
  title: string;
  url: string;
}

export interface PageLinkCandidate {
  href: string;
  title?: string;
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const IGNORED_TAGS = new Set([
  'BUTTON', 'CANVAS', 'FORM', 'IFRAME', 'INPUT', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'SVG',
]);

function structuredText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element) || IGNORED_TAGS.has(node.tagName)) return '';
  if (node.tagName === 'BR') return '\n';
  if (node.tagName === 'PRE') return `\n\`\`\`\n${node.textContent ?? ''}\n\`\`\`\n`;
  const content = [...node.childNodes].map(structuredText).join('');
  return BLOCK_TAGS.has(node.tagName) ? `\n${content}\n` : content;
}

function normalizeText(value: string): string {
  return value
    .replace(/data:image\/[^;\s]+;base64,[a-z0-9+/=\s]+/gi, '[IMAGE]')
    .replace(/\r/g, '')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n[\t ]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlText(value: string): string {
  const document = new DOMParser().parseFromString(value, 'text/html');
  return normalizeText(document.body.textContent ?? '');
}

function extractFeedContent(
  body: string,
  baseUrl: string,
  linkLimit: number,
): { title?: string; text: string; links: WebPageLink[] } | null {
  const document = new DOMParser().parseFromString(body, 'application/xml');
  if (document.querySelector('parsererror')) return null;
  const items = [...document.querySelectorAll('item')];
  if (items.length === 0) return null;
  const candidates = items.map((item) => ({
    href: item.querySelector('link')?.textContent?.trim() ?? '',
    title: item.querySelector('title')?.textContent ?? '',
  })).filter((candidate) => candidate.href);
  const text = items.map((item) => {
    const title = normalizeText(item.querySelector('title')?.textContent ?? '');
    const description = extractHtmlText(item.querySelector('description')?.textContent ?? '');
    return [title, description].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
  return {
    title: normalizeText(document.querySelector('channel > title')?.textContent ?? '') || undefined,
    text,
    links: normalizePageLinks(candidates, baseUrl, linkLimit),
  };
}

export function normalizePageLinks(
  candidates: PageLinkCandidate[],
  baseUrl: string,
  limit = 30,
): WebPageLink[] {
  const unique = new Map<string, WebPageLink>();
  const normalizedBaseUrl = normalizePublicWebUrl(baseUrl);
  for (const candidate of candidates) {
    if (unique.size >= limit) break;
    let normalized: string | null = null;
    try {
      normalized = normalizePublicWebUrl(new URL(candidate.href, baseUrl).toString());
    } catch {
      // Invalid and non-web links are intentionally ignored.
    }
    if (!normalized || normalized === normalizedBaseUrl || unique.has(normalized)) continue;
    const parsed = new URL(normalized);
    const title = normalizeText(candidate.title ?? '').slice(0, 300) || parsed.hostname;
    unique.set(normalized, { title, url: normalized });
  }
  return [...unique.values()];
}

function extractPageLinks(
  document: Document,
  baseUrl: string,
  limit: number,
): WebPageLink[] {
  const candidates = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .map((anchor) => ({
      href: anchor.getAttribute('href') ?? '',
      title: anchor.textContent ?? '',
    }))
    .filter((candidate) => candidate.href);
  return normalizePageLinks(candidates, baseUrl, limit);
}

function extractReadableText(
  body: string,
  contentType: string,
  baseUrl: string,
  linkLimit: number,
): { title?: string; text: string; links: WebPageLink[] } {
  if (contentType.startsWith('application/json')) {
    return { text: normalizeText(body), links: [] };
  }
  if (contentType.includes('xml') || /^\s*<\?xml/i.test(body)) {
    const feed = extractFeedContent(body, baseUrl, linkLimit);
    if (feed) return feed;
  }
  const document = new DOMParser().parseFromString(body, 'text/html');
  const title = normalizeText(document.querySelector('title')?.textContent ?? '') || undefined;
  const root = document.querySelector('article, main') ?? document.body;
  return {
    title,
    text: root ? normalizeText(structuredText(root)) : '',
    links: extractPageLinks(document, baseUrl, linkLimit),
  };
}

export function truncateWebContent(content: string, limit = 15_000): {
  text: string;
  truncated: boolean;
} {
  const safeLimit = Math.max(2_000, Math.min(Math.floor(limit), 50_000));
  if (content.length <= safeLimit) return { text: content, truncated: false };
  const marker = '\n\n[中间内容已省略；请缩小查询范围或读取更具体的页面]\n\n';
  const available = Math.max(1, safeLimit - marker.length);
  const headSize = Math.floor(available * 0.75);
  const tailSize = available - headSize;
  return {
    text: content.slice(0, headSize) + marker + content.slice(-tailSize),
    truncated: true,
  };
}

export async function readWebPage(
  rawUrl: string,
  options: { signal?: AbortSignal; charLimit?: number; linkLimit?: number } = {},
): Promise<WebPageResult> {
  const normalized = normalizePublicWebUrl(rawUrl);
  if (!normalized) throw new Error('网页 URL 未通过本地安全校验');
  if (typeof window === 'undefined' || !('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) {
    throw new Error('受控网页读取仅在 Tauri 桌面环境可用');
  }
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const response = await invoke<NativeWebReadResponse>('assistant_web_extract', { url: normalized });
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const finalUrl = normalizePublicWebUrl(response.url);
  if (!finalUrl) throw new Error('网页最终地址未通过安全校验');
  const linkLimit = Math.max(1, Math.min(Math.floor(options.linkLimit ?? 30), 200));
  const extracted = extractReadableText(
    response.body,
    response.contentType,
    finalUrl,
    linkLimit,
  );
  if (!extracted.text) throw new Error('网页没有可读取的正文');
  const budgeted = truncateWebContent(extracted.text, options.charLimit);
  const parsed = new URL(finalUrl);
  return {
    source: {
      id: `page-${response.fetchedAt}`,
      title: extracted.title || parsed.hostname,
      url: finalUrl,
      domain: parsed.hostname,
      fetchedAt: response.fetchedAt,
      sourceType: 'page',
    },
    text: budgeted.text,
    truncated: budgeted.truncated,
    links: extracted.links,
  };
}
