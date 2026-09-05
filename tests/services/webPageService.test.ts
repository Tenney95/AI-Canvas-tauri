import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearWebReadSessionsForTests } from '../../src/services/chat/webReadSessionService';
import { readWebPage, shouldRenderDynamicHtml } from '../../src/services/webPageService';

const invokeMock = vi.hoisted(() => vi.fn());
afterEach(() => clearWebReadSessionsForTests());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

// 显式 DOM 替身只验证提取编排、PRE 保留和相对链接绑定，不冒充浏览器 HTML 解析验收。
class FixtureElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: Array<FixtureElement | { nodeType: number; textContent: string }>;
  constructor(tagName: string, childNodes: FixtureElement['childNodes']) {
    this.tagName = tagName;
    this.childNodes = childNodes;
  }
  get textContent(): string { return this.childNodes.map((node) => node.textContent).join(''); }
}
const documents = new Map<string, unknown>();
function htmlFixture(body: string, title: string, text: string, href = './reference') {
  const root = new FixtureElement('MAIN', [
    new FixtureElement('P', [{ nodeType: 3, textContent: text }]),
    new FixtureElement('NAV', [{ nodeType: 3, textContent: 'NAVIGATION_NOISE' }]),
  ]);
  documents.set(body, {
    body: root,
    querySelector: (selector: string) => selector === 'title' ? { textContent: title } : root,
    querySelectorAll: () => [{ getAttribute: () => href, textContent: `${title} reference` }],
  });
  return body;
}

beforeEach(() => {
  invokeMock.mockReset();
  documents.clear();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  vi.stubGlobal('Node', class { static readonly TEXT_NODE = 3; });
  vi.stubGlobal('Element', FixtureElement);
  vi.stubGlobal('DOMParser', class {
    parseFromString(body: string) {
      const document = documents.get(body);
      if (!document) throw new Error('Missing explicit DOM fixture');
      return document;
    }
  });
});

describe('web page SPA rendering fallback', () => {
  it('continues a stable long body and rechecks authorization without additional native calls', async () => {
    const url = 'https://example.com/docs';
    const text = 'A'.repeat(20_000) + 'MIDDLE' + 'Z'.repeat(20_000);
    const body = htmlFixture('<main>long</main>', 'Long doc', text);
    invokeMock.mockResolvedValue({ url, body, contentType: 'text/html', fetchedAt: 1 });
    let allowed = true;
    const options = { scope: { projectId: 'p', conversationId: 'c', taskId: 't' }, authorize: () => allowed, charLimit: 10_000 };
    const first = await readWebPage(url, options);
    const middle = await readWebPage(url, { ...options, readSessionId: first.readSessionId, offset: 20_000 });
    expect(middle.text).toContain('MIDDLE');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    allowed = false;
    await expect(readWebPage(url, { ...options, cursor: first.nextCursor })).rejects.toThrow('授权');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
  it('requests rendering for an empty application root with a JavaScript bundle', () => {
    const html = `
      <!doctype html>
      <html>
        <head><script type="module" src="/assets/index.js"></script></head>
        <body><div id="root"></div></body>
      </html>
    `;

    expect(shouldRenderDynamicHtml(html, 'text/html; charset=utf-8', '')).toBe(true);
  });

  it('requests rendering for a hashed non-module bundle (e.g. /static/js/index.xxx.js)', () => {
    const html = `
      <!doctype html>
      <html>
        <head><script defer src="/static/js/index.55998905b6.js"></script></head>
        <body><div id="root"></div></body>
      </html>
    `;

    expect(shouldRenderDynamicHtml(html, 'text/html; charset=utf-8', '')).toBe(true);
  });

  it('keeps substantial server-rendered HTML on the static path', () => {
    const html = `
      <html><body><main>${'<p>API documentation</p>'.repeat(80)}</main>
      <script type="module" src="/assets/index.js"></script></body></html>
    `;

    expect(shouldRenderDynamicHtml(html, 'text/html', 'API documentation '.repeat(80)))
      .toBe(false);
  });

  it('does not render ordinary short HTML without SPA markers', () => {
    expect(shouldRenderDynamicHtml(
      '<html><body><main><p>Short status page</p></main></body></html>',
      'text/html',
      'Short status page',
    )).toBe(false);
  });

  it('does not attempt browser rendering for JSON or XML responses', () => {
    expect(shouldRenderDynamicHtml('{"status":"ok"}', 'application/json', 'status ok'))
      .toBe(false);
    expect(shouldRenderDynamicHtml('<rss></rss>', 'application/rss+xml', '')).toBe(false);
  });

  it('renders a nonempty loading shell but keeps a genuine short SSR article', () => {
    const shell = '<div id="root"><p>加载中...</p></div><script src="/app.js"></script>';
    expect(shouldRenderDynamicHtml(shell, 'text/html', '加载中...')).toBe(true);
    const article = '<div id="root"><article><p>本接口今日维护完成，服务已恢复。</p></article></div><script src="/app.js"></script>';
    expect(shouldRenderDynamicHtml(article, 'text/html', '本接口今日维护完成，服务已恢复。')).toBe(false);
  });
});

describe('structured web page reads', () => {
  it.each([2, 3, 4, 5])('keeps all %i rendered pages paired with their own URL and links', async (count) => {
    const shell = htmlFixture('<div id="root"></div><script src="/app.js"></script>', 'Shell', '加载中...');
    const pages = Array.from({ length: count }, (_, index) => ({
      url: `https://example.com/chapter-${index + 1}/page`,
      contentType: 'text/html',
      body: htmlFixture(`<main>PAGE_${index + 1}</main>`, `Chapter ${index + 1}`, `PAGE_${index + 1}`),
      truncated: false,
    }));
    invokeMock.mockResolvedValueOnce({ url: pages[0].url, contentType: 'text/html', body: shell, fetchedAt: 1 })
      .mockResolvedValueOnce({ url: pages[0].url, contentType: 'text/html', body: '', fetchedAt: 2, pages, complete: true, issues: [] });

    const result = await readWebPage(pages[0].url);

    expect(result.pages).toHaveLength(count);
    expect(new Set(result.pages.map((page) => page.source.id)).size).toBe(count);
    result.pages.forEach((page, index) => {
      expect(page.text).toBe(`PAGE_${index + 1}`);
      expect(page.source.url).toBe(pages[index].url);
      expect(page.links[0].url).toBe(`https://example.com/chapter-${index + 1}/reference`);
      expect(result.text).toContain(`PAGE_${index + 1}`);
    });
    expect(result.source.url).toBe(pages[0].url);
    expect(result).toMatchObject({ readMethod: 'rendered', complete: true, truncated: false });
    expect(result.text).not.toContain('NAVIGATION_NOISE');
    expect(JSON.stringify(result.pages.map((page) => page.source))).not.toContain('PAGE_');
  });

  it('accepts the legacy single-page response without requiring pages metadata', async () => {
    invokeMock.mockResolvedValue({ url: 'https://example.com/status', contentType: 'application/json', body: '{"status":"ok"}', fetchedAt: 4 });
    const result = await readWebPage('https://example.com/status');
    expect(result).toMatchObject({ text: '{"status":"ok"}', readMethod: 'static', complete: true, truncated: false });
    expect(result.pages).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('retains a successfully captured page but reports native partial failure', async () => {
    invokeMock.mockResolvedValue({
      url: 'https://example.com/page', contentType: 'application/json', body: '', fetchedAt: 5,
      pages: [{ url: 'https://example.com/page', contentType: 'application/json', body: 'CAPTURED', truncated: false }],
      complete: false, issues: ['timeout'], readMethod: 'rendered',
    });
    const result = await readWebPage('https://example.com/page');
    expect(result).toMatchObject({ text: 'CAPTURED', complete: false, issues: ['timeout'] });
  });

  it('bounds the combined output and reports text clipping even when native capture completed', async () => {
    const pages = Array.from({ length: 5 }, (_, index) => ({
      url: `https://example.com/${index}`, contentType: 'application/json', body: `PAGE_${index}:` + 'x'.repeat(4_000), truncated: false,
    }));
    invokeMock.mockResolvedValue({ url: pages[0].url, contentType: 'application/json', body: '', pages, fetchedAt: 8, complete: true });
    const result = await readWebPage(pages[0].url, { charLimit: 2_000 });
    expect(result.text.length).toBeLessThanOrEqual(2_000);
    expect(result).toMatchObject({ complete: false, truncated: true, issues: expect.arrayContaining(['text_limit']) });
    for (let i = 0; i < 5; i += 1) expect(result.text).toContain(`PAGE_${i}`);
  });

  it('redistributes unused page budgets instead of clipping a long page when all content fits', async () => {
    const pages = [
      { url: 'https://example.com/long', contentType: 'application/json', body: 'x'.repeat(10_000), truncated: false },
      { url: 'https://example.com/short', contentType: 'application/json', body: 'SHORT', truncated: false },
    ];
    invokeMock.mockResolvedValue({ url: pages[0].url, contentType: 'text/html', body: '', pages, fetchedAt: 8, complete: true });
    const full = await readWebPage(pages[0].url);
    expect(full).toMatchObject({ complete: true, truncated: false });
    expect(full.pages[0].text).toBe(pages[0].body);
    const clipped = await readWebPage(pages[0].url, { charLimit: 2_000 });
    expect(clipped.text.length).toBe(2_000);
    expect(clipped.pages[1].text).toBe('SHORT');
  });

  it('rejects legacy concatenated multi-page HTML whose page sources cannot be reconstructed', async () => {
    const shell = htmlFixture('<div id="root"></div><script src="/app.js"></script>', 'Shell', '加载中...');
    invokeMock.mockResolvedValueOnce({ url: 'https://example.com/start', contentType: 'text/html', body: shell, fetchedAt: 1 })
      .mockResolvedValueOnce({
        url: 'https://example.com/last', contentType: 'text/html', fetchedAt: 2,
        body: htmlFixture('<main>FIRST</main>\n<!-- page-break -->\n<main>LAST</main>', 'First page', 'FIRST'),
      });
    await expect(readWebPage('https://example.com/start')).rejects.toThrow('旧版多页响应');
  });

  it('skips a loading-only page without losing later content or claiming full success', async () => {
    const pages = [
      { url: 'https://example.com/empty', contentType: 'text/html', body: htmlFixture('<main>Loading...</main>', 'Loading', 'Loading...') },
      { url: 'https://example.com/content', contentType: 'application/json', body: 'REAL_CONTENT', truncated: true },
    ];
    invokeMock.mockResolvedValue({ url: pages[0].url, contentType: 'text/html', body: '', pages, fetchedAt: 10, complete: true });
    const result = await readWebPage(pages[0].url);
    expect(result.text).toBe('REAL_CONTENT');
    expect(result.source.url).toBe(pages[1].url);
    expect(result).toMatchObject({ complete: false, truncated: true, issues: expect.arrayContaining(['empty_page', 'body_limit']) });
  });

  it('rejects an unsafe URL in any structured page rather than assigning its body to another page', async () => {
    invokeMock.mockResolvedValue({
      url: 'https://example.com/page', contentType: 'application/json', body: 'LEGACY', fetchedAt: 7,
      pages: [{ url: 'http://127.0.0.1/secret', contentType: 'application/json', body: 'PRIVATE' }],
    });
    await expect(readWebPage('https://example.com/page')).rejects.toThrow('安全校验');
  });
});
