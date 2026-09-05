/**
 * 通过受限 Tauri 命令读取公开网页，归一化正文、链接与来源并执行体积裁剪。
 */
import { invoke } from '@tauri-apps/api/core';
import type { NativeWebReadResponse, WebPageLink, WebPageResult, WebReadAccessScope, WebReadContinuation, WebReadDocument, WebReadIssue, WebReadPage, WebReadStatus } from '../types/chat';
import { readWebSession } from './chat/webReadSessionService';
import { normalizePublicWebUrl } from './chat/webAccessGrantService';

export type { WebPageLink, WebPageResult } from '../types/chat';

const MIN_STATIC_PAGE_TEXT = 800;
const SPA_ROOT_PATTERN = /<(?:div|main|section)\b[^>]*(?:\bid=["'](?:root|app|__next|__nuxt|svelte)["']|\bdata-reactroot\b)[^>]*>/i;
// SPA 入口通常由构建工具产出带 hash 的 JS 文件（例如 /static/js/index.55998905b6.js），
// 这些脚本不一定是 type="module"，src 也可能不是 .mjs/_next/_nuxt，但同样依赖客户端渲染。
const SPA_BOOTSTRAP_PATTERN = /<script\b[^>]*\bsrc=["'][^"']+\.js(?:\?[^"']*)?["'][^>]*>/i;

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
  'ASIDE', 'BUTTON', 'CANVAS', 'FOOTER', 'FORM', 'IFRAME', 'INPUT', 'NAV',
  'NOSCRIPT', 'OBJECT', 'EMBED', 'SCRIPT', 'STYLE', 'SVG',
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
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => index % 2 ? part : part
      .replace(/[\t ]+\n/g, '\n')
      .replace(/\n[\t ]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n'))
    .join('')
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
  if (contentType.startsWith('application/json') || contentType.startsWith('text/plain')) {
    return { text: normalizeText(body), links: [] };
  }
  if (contentType.includes('xml') || /^\s*<\?xml/i.test(body)) {
    const feed = extractFeedContent(body, baseUrl, linkLimit);
    if (feed) return feed;
  }
  const document = new DOMParser().parseFromString(body, 'text/html');
  const title = normalizeText(document.querySelector('title')?.textContent ?? '') || undefined;
  // 优先取主内容区，去掉侧边导航、页脚等噪声；与 Rust 侧渲染提取保持一致。
  const root = document.querySelector('main, article, [role="main"]')
    ?? document.querySelector('#content, #app, .content, .markdown-body')
    ?? document.body;
  return {
    title,
    text: root ? normalizeText(structuredText(root)) : '',
    links: extractPageLinks(document, baseUrl, linkLimit),
  };
}

export function shouldRenderDynamicHtml(
  body: string,
  contentType: string,
  extractedText: string,
): boolean {
  if (!contentType.includes('html')) return false;
  if (extractedText.trim().length >= MIN_STATIC_PAGE_TEXT) return false;
  // 有真实语义正文的短 SSR 页面无需再启动 WebView；加载/登录占位仍需尝试渲染。
  if (hasReadablePageText(body, contentType, extractedText)
    && /<(?:article|pre|table)\b/i.test(body)) return false;
  return SPA_ROOT_PATTERN.test(body) && SPA_BOOTSTRAP_PATTERN.test(body);
}

const SHELL_TEXT_PATTERN = /^(?:(?:loading|please\s*wait|sign\s*in|log\s*in|login|to\s*continue|加载中|正在加载|页面加载中|请稍候|请稍后|请登录|登录|注册|首页|文档|帮助|home|docs|documentation|help)|[\s.。…!！:：|/-])*$/i;

/** 只排除明确的壳页，不以篇幅短或没有 API 关键词否定真实文章。 */
export function hasReadablePageText(body: string, contentType: string, text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (!contentType.includes('html')) return true;
  if (value.length < MIN_STATIC_PAGE_TEXT && SHELL_TEXT_PATTERN.test(value)) return false;
  return !(value.length < MIN_STATIC_PAGE_TEXT
    && /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(body)
    && !/<(?:article|pre|code|table)\b/i.test(body));
}

const READ_ISSUE_LABELS: Record<WebReadIssue, string> = {
  page_limit: '达到 5 页遍历上限',
  body_limit: '达到原生正文体积上限',
  text_limit: '正文已按字符预算截断',
  timeout: '后续读取超时',
  navigation_failed: '后续页面读取失败',
  duplicate_page: '下一页未推进或出现重复页面',
  empty_page: '部分页面只有空白、导航、加载或登录提示',
  render_failed: '动态渲染失败',
  catalog_fallback: '未读取到目标文档，仅返回公开模型清单',
};

export function describeWebReadStatus(status: Partial<WebReadStatus> & { truncated?: boolean }): string {
  const issues = status.issues ?? [];
  const partial = status.complete === false || status.truncated || issues.length > 0;
  const method = status.readMethod === 'rendered' ? '动态渲染' : status.readMethod === 'catalog' ? '公开目录回退' : '静态读取';
  return `读取状态：${partial ? '部分读取' : '本次提取完整'}（${method}）`
    + (issues.length ? `；${issues.map((issue) => READ_ISSUE_LABELS[issue]).join('；')}` : '')
    + (partial ? '。不能声称已读完全部内容。' : '；不代表已遍历整站。');
}

/** 逐页解析，所有正文、标题和相对链接都绑定当前页；旧单页响应仍可读取。 */
export function extractWebReadResponse(
  response: NativeWebReadResponse,
  options: { linkLimit?: number; expectedOrigin?: string; readMethod?: 'static' | 'rendered' } = {},
): WebReadStatus & { pages: WebReadPage[] } {
  if (!response.pages && (options.readMethod === 'rendered' || response.readMethod === 'rendered')
    && response.body.includes('<!-- page-break -->')) {
    throw new Error('旧版多页响应缺少逐页来源，无法安全对应正文；请更新桌面后端后重试');
  }
  const validate = (rawUrl: string): string => {
    const url = normalizePublicWebUrl(rawUrl);
    if (!url) throw new Error('网页最终地址未通过安全校验');
    if (options.expectedOrigin && new URL(url).origin !== options.expectedOrigin) {
      throw new Error('厂商文档最终地址未通过同站安全校验');
    }
    return url;
  };
  validate(response.url);
  const nativePages = response.pages ?? [response];
  const issues = new Set<WebReadIssue>((response.issues ?? [])
    .filter((issue) => Object.hasOwn(READ_ISSUE_LABELS, issue)));
  if (nativePages.length > 5) issues.add('page_limit');
  const pages = nativePages.slice(0, 5).map((page, index): WebReadPage => {
    const url = validate(page.url);
    const extracted = extractReadableText(page.body, page.contentType.toLowerCase(), url, options.linkLimit ?? 30);
    const text = hasReadablePageText(page.body, page.contentType.toLowerCase(), extracted.text) ? extracted.text : '';
    if (!text) issues.add('empty_page');
    const clipped = 'truncated' in page && page.truncated === true;
    if (clipped) issues.add('body_limit');
    const domain = new URL(url).hostname;
    return {
      source: {
        id: `page-${response.fetchedAt}-${index + 1}`,
        title: normalizeText(('title' in page ? page.title : undefined) || extracted.title || domain).slice(0, 300),
        url, domain, fetchedAt: response.fetchedAt, sourceType: 'page',
      },
      text, links: extracted.links, truncated: clipped,
    };
  });
  if (!pages.length) issues.add('empty_page');
  if (response.complete === false && !issues.size) issues.add('navigation_failed');
  return {
    pages,
    readMethod: response.readMethod ?? options.readMethod ?? (response.pages ? 'rendered' : 'static'),
    complete: response.complete !== false && issues.size === 0,
    issues: [...issues],
  };
}

function clipText(content: string, limit: number): { text: string; truncated: boolean } {
  if (content.length <= limit) return { text: content, truncated: false };
  const marker = '\n\n[中间内容已省略；请缩小查询范围或读取更具体的页面]\n\n';
  if (limit <= marker.length) return { text: content.slice(0, limit), truncated: true };
  const available = limit - marker.length;
  const headSize = Math.floor(available * 0.75);
  return { text: content.slice(0, headSize) + marker + content.slice(-(available - headSize)), truncated: true };
}

export function truncateWebContent(content: string, limit = 15_000): {
  text: string;
  truncated: boolean;
} {
  const safeLimit = Math.max(2_000, Math.min(Math.floor(limit), 50_000));
  return clipText(content, safeLimit);
}

export async function readWebPage(
  rawUrl: string,
  options: { signal?: AbortSignal; charLimit?: number; linkLimit?: number;
    scope?: WebReadAccessScope; authorize?: () => boolean } & WebReadContinuation = {},
): Promise<WebPageResult> {
  if (options.scope) {
    return readWebSession({ ...options, scope: options.scope, kind: 'web', url: rawUrl,
      limit: options.charLimit, authorize: options.authorize ?? (() => false) },
    () => loadWebPageDocument(rawUrl, options));
  }
  const extracted = await loadWebPageDocument(rawUrl, options);
  return clipWebPageDocument(extracted, options);
}

async function loadWebPageDocument(rawUrl: string, options: { signal?: AbortSignal; linkLimit?: number }) {
  const normalized = normalizePublicWebUrl(rawUrl);
  if (!normalized) throw new Error('网页 URL 未通过本地安全校验');
  if (typeof window === 'undefined' || !('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) {
    throw new Error('受控网页读取仅在 Tauri 桌面环境可用');
  }
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  let response = await invoke<NativeWebReadResponse>('assistant_web_extract', { url: normalized });
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const finalUrl = normalizePublicWebUrl(response.url);
  if (!finalUrl) throw new Error('网页最终地址未通过安全校验');
  const linkLimit = Math.max(1, Math.min(Math.floor(options.linkLimit ?? 30), 200));
  let extracted = extractWebReadResponse(response, { linkLimit });
  if (!response.pages && shouldRenderDynamicHtml(response.body, response.contentType, extracted.pages[0]?.text ?? '')) {
    response = await invoke<NativeWebReadResponse>('assistant_web_render', { url: finalUrl });
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    extracted = extractWebReadResponse(response, { linkLimit, expectedOrigin: new URL(finalUrl).origin, readMethod: 'rendered' });
  }
  const readablePages = extracted.pages.filter((page) => page.text);
  if (!readablePages.length) throw new Error('网页没有可读取的正文，可能只有导航、加载或登录提示');
  return { ...extracted, pages: readablePages };
}

function clipWebPageDocument(extracted: WebReadDocument, options: { charLimit?: number; linkLimit?: number }): WebPageResult {
  const readablePages = extracted.pages;
  const linkLimit = Math.max(1, Math.min(Math.floor(options.linkLimit ?? 30), 200));
  const limit = Math.max(2_000, Math.min(Math.floor(options.charLimit ?? 15_000), 50_000));
  let remaining = limit - (readablePages.length - 1) * 2;
  // 给每个成功页分配正文预算，避免总串头尾裁剪再次吞掉中间页及其来源。
  // 短页用不到的预算要重新分给长页，否则总正文未超上限也会被不必要地截断。
  const budgets = readablePages.map(() => 0);
  let pending = readablePages.map((_, index) => index);
  while (remaining > 0 && pending.length > 0) {
    const share = Math.max(1, Math.floor(remaining / pending.length));
    for (const index of pending) {
      const allocated = Math.min(share, readablePages[index].text.length - budgets[index], remaining);
      budgets[index] += allocated;
      remaining -= allocated;
    }
    pending = pending.filter((index) => budgets[index] < readablePages[index].text.length);
  }
  const pages = readablePages.map((page, index) => {
    const budgeted = clipText(page.text, budgets[index]);
    return { ...page, text: budgeted.text, truncated: page.truncated || budgeted.truncated };
  });
  const issues = new Set(extracted.issues);
  if (pages.some((page, index) => page.text !== readablePages[index].text)) issues.add('text_limit');
  const links = [...new Map(extracted.pages.flatMap((page) => page.links).map((link) => [link.url, link])).values()].slice(0, linkLimit);
  return {
    source: pages[0].source,
    pages,
    text: pages.map((page) => page.text).join('\n\n'),
    truncated: pages.some((page) => page.truncated),
    links,
    readMethod: extracted.readMethod,
    complete: extracted.complete && issues.size === 0,
    issues: [...issues],
  };
}
