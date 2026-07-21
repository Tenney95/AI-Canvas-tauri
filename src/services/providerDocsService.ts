import { invoke } from '@tauri-apps/api/core';
import { normalizeProviderDocUrl } from './chat/providerDocsGrantService';

interface NativeProviderDocsResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
  fetchedAt: number;
}
export interface ProviderDocLink {
  label: string;
  url: string;
}

export interface ProviderDocsPage {
  title: string;
  url: string;
  text: string;
  links: ProviderDocLink[];
  fetchedAt: number;
  truncated: boolean;
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME', 'FORM']);
const LINK_HINT_RE = /api|model|endpoint|reference|image|video|audio|chat|模型|接口|图片|视频|音频|对话/i;

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
    .replace(/\r/g, '')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n[\t ]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlPage(body: string, finalUrl: string): {
  title: string;
  text: string;
  links: ProviderDocLink[];
} {
  const parser = new DOMParser();
  const document = parser.parseFromString(body, 'text/html');
  const title = normalizeText(document.querySelector('title')?.textContent ?? '')
    || new URL(finalUrl).hostname;
  const linksByUrl = new Map<string, ProviderDocLink>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let resolved: string;
    try {
      resolved = new URL(anchor.getAttribute('href') || '', finalUrl).toString();
    } catch {
      continue;
    }
    const normalized = normalizeProviderDocUrl(resolved);
    if (!normalized || normalized.length > 512) continue;
    const label = normalizeText(anchor.textContent ?? '').slice(0, 100) || new URL(normalized).pathname;
    if (!linksByUrl.has(normalized)) linksByUrl.set(normalized, { label, url: normalized });
  }
  const root = document.querySelector('article, main') ?? document.body;
  const text = root ? normalizeText(structuredText(root)) : '';
  const links = [...linksByUrl.values()]
    .sort((left, right) => Number(LINK_HINT_RE.test(right.label + right.url))
      - Number(LINK_HINT_RE.test(left.label + left.url)));
  return { title, text, links };
}

export async function readProviderDocsPage(
  rawUrl: string,
  options: { signal?: AbortSignal; maxTextChars?: number } = {},
): Promise<ProviderDocsPage> {
  const normalized = normalizeProviderDocUrl(rawUrl);
  if (!normalized) throw new Error('厂商文档 URL 未通过本地安全校验');
  if (typeof window === 'undefined' || !('__TAURI__' in window)) {
    throw new Error('厂商文档读取仅在 Tauri 桌面环境可用');
  }
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const response = await invoke<NativeProviderDocsResponse>('provider_docs_read', { url: normalized });
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const finalUrl = normalizeProviderDocUrl(response.url);
  if (!finalUrl || new URL(finalUrl).origin !== new URL(normalized).origin) {
    throw new Error('厂商文档最终地址未通过同站安全校验');
  }

  const extracted = response.contentType.startsWith('application/json')
    ? { title: new URL(finalUrl).hostname, text: normalizeText(response.body), links: [] }
    : extractHtmlPage(response.body, finalUrl);
  if (!extracted.text) throw new Error('厂商文档页面没有可读取的正文');
  const limit = Math.max(1, Math.min(options.maxTextChars ?? 10_000, 10_000));
  return {
    title: extracted.title,
    url: finalUrl,
    text: extracted.text.slice(0, limit),
    links: extracted.links.slice(0, 24),
    fetchedAt: response.fetchedAt,
    truncated: extracted.text.length > limit,
  };
}
