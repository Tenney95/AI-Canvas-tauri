import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';

const invokeMock = vi.hoisted(() => vi.fn());
const readWebPageMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../../../src/services/webPageService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/webPageService')>(),
  readWebPage: readWebPageMock,
}));

import { useAppStore } from '../../../src/store/useAppStore';
import { clearWebAccessGrantsForTests } from '../../../src/services/chat/webAccessGrantService';
import { normalizePageLinks } from '../../../src/services/webPageService';
import { registerWebAgentTools } from '../../../src/services/chat/tools/webTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  getAvailableAgentTools,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';

const context: AgentToolContext = {
  taskId: 'task-web',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  mode: 'collaborative',
  signal: new AbortController().signal,
};

function task(goal = '查找最新资料'): AgentTask {
  return {
    id: context.taskId,
    projectId: context.projectId,
    conversationId: context.conversationId,
    userMessageId: 'message-1',
    mode: context.mode,
    goal,
    status: 'running',
    steps: [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: {
      maxModelRounds: 12,
      maxToolCalls: 24,
      maxParallelReadTools: 3,
      maxReadRetries: 3,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  clearWebAccessGrantsForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ agentTasks: [task()] });
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  invokeMock.mockReset();
  readWebPageMock.mockReset();
  registerWebAgentTools();
});

afterEach(() => {
  clearAgentToolRegistryForTests();
  clearWebAccessGrantsForTests();
  vi.unstubAllGlobals();
});

describe('web agent tools', () => {
  it('passes continuation and live scope checks to the reader without persisting body metadata', async () => {
    const url = 'https://example.com/docs';
    const source = { id: 's', title: 'Docs', url, domain: 'example.com', fetchedAt: 1, sourceType: 'page' };
    readWebPageMock.mockResolvedValue({ source, pages: [{ source, text: 'TEMPORARY_BODY', links: [], truncated: true }],
      text: 'TEMPORARY_BODY', links: [], truncated: true, complete: false, readMethod: 'static', issues: ['text_limit'],
      readSessionId: 'snapshot', nextCursor: 'next-cursor', nextOffset: 10000, totalTextChars: 40000 });
    const result = await getAgentTool('web_extract')!.execute(context, { url, cursor: 'old-cursor' });
    expect(result.modelContent).toContain('next-cursor');
    expect(JSON.stringify(result.sources)).not.toContain('TEMPORARY_BODY');
    const options = readWebPageMock.mock.calls[0][1];
    expect(options).toMatchObject({ cursor: 'old-cursor', scope: context });
    expect(options.authorize()).toBe(true);
    useAppStore.setState({ agentTasks: [{ ...task(), status: 'stopped' }] });
    expect(options.authorize()).toBe(false);
    useAppStore.setState({ agentTasks: [{ ...task(), conversationId: 'other' }] });
    expect(options.authorize()).toBe(false);
  });
  it('normalizes relative page links and filters unsafe or duplicate targets', () => {
    expect(normalizePageLinks([
      { href: '/docs#intro', title: ' Documentation ' },
      { href: 'https://example.com/docs#other', title: 'Duplicate' },
      { href: 'http://127.0.0.1/admin', title: 'Private' },
      { href: 'file:///tmp/secret', title: 'Local file' },
      { href: 'https://example.org/article', title: '' },
    ], 'https://example.com/start')).toEqual([
      { title: 'Documentation', url: 'https://example.com/docs' },
      { title: 'example.org', url: 'https://example.org/article' },
    ]);
  });

  it('can retain search results that appear after noisy search-page navigation links', () => {
    const navigationLinks = Array.from({ length: 40 }, (_, index) => ({
      href: `/search?category=${index}`,
      title: `Navigation ${index}`,
    }));
    const candidates = [
      ...navigationLinks,
      { href: 'https://example.com/latest-ai', title: 'Latest AI report' },
    ];

    expect(normalizePageLinks(candidates, 'https://cn.bing.com/search?q=ai'))
      .not.toContainEqual(expect.objectContaining({ url: 'https://example.com/latest-ai' }));
    expect(normalizePageLinks(candidates, 'https://cn.bing.com/search?q=ai', 160))
      .toContainEqual({ title: 'Latest AI report', url: 'https://example.com/latest-ai' });
  });

  it('exposes controlled search and browsing in Tauri without a configured provider', () => {
    const withoutKey = getAvailableAgentTools(context).map((tool) => tool.id);
    expect(withoutKey).toContain('web_search');
    expect(withoutKey).toContain('web_extract');

    useAppStore.getState().setProviderKey('tavily', 'test-key');
    const withKey = getAvailableAgentTools(context).map((tool) => tool.id);
    expect(withKey).toContain('web_search');
    expect(withKey).toContain('web_extract');
    expect(getAgentTool('web_extract')?.description).toContain('隔离环境中渲染');
    expect(getAgentTool('web_extract')?.description).toContain('不支持跨域依赖');
  });

  it('uses the built-in controlled search when no provider key is configured', async () => {
    readWebPageMock.mockResolvedValue({
      text: 'Search results',
      truncated: false,
      links: [
        { title: 'Google News article', url: 'https://news.google.com/rss/articles/article-1' },
        { title: 'Latest AI report', url: 'https://example.com/ai-report' },
      ],
      source: {
        id: 'page-12',
        title: 'Search',
        url: 'https://news.google.com/rss/search?q=latest+ai',
        domain: 'news.google.com',
        fetchedAt: 12,
        sourceType: 'page',
      },
    });

    const result = await getAgentTool('web_search')!.execute(context, {
      query: 'latest ai',
      maxResults: 3,
    });

    expect(readWebPageMock).toHaveBeenCalledWith(
      'https://news.google.com/rss/search?q=latest+ai&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans',
      expect.objectContaining({ charLimit: 6_000, linkLimit: 160 }),
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'success',
      sources: [
        { citationId: 'S1', url: 'https://news.google.com/rss/articles/article-1' },
        { citationId: 'S2', url: 'https://example.com/ai-report' },
      ],
    });
  });

  it('hands an empty built-in search off to controlled web navigation', async () => {
    readWebPageMock.mockResolvedValue({
      text: 'No usable results',
      truncated: false,
      links: [],
      source: {
        id: 'page-empty',
        title: 'Search',
        url: 'https://news.google.com/rss/search?q=latest+ai',
        domain: 'news.google.com',
        fetchedAt: 13,
        sourceType: 'page',
      },
    });

    const result = await getAgentTool('web_search')!.execute(context, {
      query: 'latest ai',
    });

    expect(readWebPageMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'success',
      summary: '内置聚合搜索无结果，已切换到网页导航搜索',
    });
    expect(result.modelContent).toContain('请立即调用 web_extract');
    expect(result.modelContent).toContain(
      'https://news.google.com/rss/search?q=latest+ai&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans',
    );
    expect(result.modelContent).toContain('https://www.bing.com/search?q=latest+ai');
  });

  it('uses search pages only for navigation and grants their result links', async () => {
    const searchUrl = 'https://news.google.com/rss/search?q=latest+ai&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans';
    const resultUrl = 'http://example.com/latest-ai';
    readWebPageMock.mockResolvedValue({
      text: 'Search result snippets',
      truncated: false,
      links: [{ title: 'Latest AI report', url: resultUrl }],
      source: {
        id: 'page-navigation',
        title: 'Google News results',
        url: searchUrl,
        domain: 'news.google.com',
        fetchedAt: 14,
        sourceType: 'page',
      },
    });
    const extractTool = getAgentTool('web_extract')!;

    expect(extractTool.authorize?.(context, { url: resultUrl })).toMatchObject({ allowed: false });
    const result = await extractTool.execute(context, { url: searchUrl });

    expect(readWebPageMock).toHaveBeenCalledWith(
      searchUrl,
      expect.objectContaining({ linkLimit: 160 }),
    );
    expect(result).toMatchObject({ status: 'success' });
    expect(result).not.toHaveProperty('sources');
    expect(result.modelContent).toContain('不能作为最终事实来源或引用来源');
    expect(result.modelContent).toContain(resultUrl);
    expect(extractTool.authorize?.(context, { url: resultUrl })).toEqual({ allowed: true });
  });

  it('switches from Google News to Bing when the first navigation request fails', async () => {
    const googleUrl = 'https://news.google.com/rss/search?q=latest+ai&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans';
    readWebPageMock.mockRejectedValue('网页返回 HTTP 429');

    const result = await getAgentTool('web_extract')!.execute(context, { url: googleUrl });

    expect(result).toMatchObject({
      status: 'success',
      summary: 'Google News 搜索入口不可用，已切换到必应',
    });
    expect(result.modelContent).toContain('请立即调用 web_extract 打开必应搜索入口');
    expect(result.modelContent).toContain('https://www.bing.com/search?q=latest+ai');
  });

  it('browses public HTTPS without a key and grants links discovered on the page', async () => {
    readWebPageMock.mockResolvedValue({
      text: 'PUBLIC_RESEARCH_PAGE',
      truncated: false,
      links: [{
        title: 'Next public article',
        url: 'http://example.org/next',
      }],
      source: {
        id: 'page-10',
        title: 'Public research',
        url: 'https://example.com/research',
        domain: 'example.com',
        fetchedAt: 10,
        sourceType: 'page',
      },
    });
    const extractTool = getAgentTool('web_extract')!;

    expect(extractTool.authorize?.(context, { url: 'https://example.com/research' }))
      .toEqual({ allowed: true });
    expect(extractTool.authorize?.(context, { url: 'http://example.org/next' }))
      .toMatchObject({ allowed: false });

    const result = await extractTool.execute(context, {
      url: 'https://example.com/research',
    });

    expect(result.modelContent).toContain('PUBLIC_RESEARCH_PAGE');
    expect(result.modelContent).toContain('http://example.org/next');
    expect(extractTool.authorize?.(context, { url: 'http://example.org/next' }))
      .toEqual({ allowed: true });
    expect(result.sources).toEqual([expect.objectContaining({
      citationId: 'S1',
      url: 'https://example.com/research',
    })]);
  });

  it('preserves native string errors instead of replacing them with a generic message', async () => {
    readWebPageMock.mockRejectedValue('网页返回 HTTP 403');

    const result = await getAgentTool('web_extract')!.execute(context, {
      url: 'https://example.com/research',
    });

    expect(result).toMatchObject({
      status: 'error',
      summary: '网页返回 HTTP 403',
      modelContent: '网页返回 HTTP 403',
      retryable: false,
    });
  });

  it('uses the explicitly selected search provider', async () => {
    useAppStore.getState().setProviderKey('bocha', 'bocha-key');
    useAppStore.getState().updateConfig({ webSearchProviderId: 'bocha' });
    invokeMock.mockResolvedValue({
      fetchedAt: 11,
      body: JSON.stringify({
        data: {
          webPages: {
            value: [{
              name: 'Bocha documentation',
              url: 'https://example.com/bocha-docs',
              summary: 'Search metadata',
            }],
          },
        },
      }),
    });

    const result = await getAgentTool('web_search')!.execute(context, {
      query: 'bocha docs',
    });

    expect(invokeMock).toHaveBeenCalledWith('assistant_web_search', {
      request: expect.objectContaining({ provider: 'bocha', apiKey: 'bocha-key' }),
    });
    expect(result).toMatchObject({
      status: 'success',
      sources: [{ url: 'https://example.com/bocha-docs' }],
    });
  });

  it('grants extraction only to search results in the current task', async () => {
    useAppStore.getState().setProviderKey('tavily', 'test-key');
    invokeMock.mockResolvedValue({
      fetchedAt: 10,
      body: JSON.stringify({
        results: [{
          title: 'Public documentation',
              url: 'http://example.com/docs',
          content: 'Search metadata only',
        }],
      }),
    });

    const searchResult = await getAgentTool('web_search')!.execute(context, {
      query: 'example docs',
    });
    const extractTool = getAgentTool('web_extract')!;

    expect(searchResult).toMatchObject({
      status: 'success',
      sources: [{ citationId: 'S1', url: 'http://example.com/docs' }],
    });
    expect(extractTool.authorize?.(context, { url: 'http://example.com/docs' }))
      .toEqual({ allowed: true });
    expect(extractTool.authorize?.(context, { url: 'http://unrelated.example/page' }))
      .toMatchObject({ allowed: false });
  });

  it('returns page text to the model while keeping it out of source metadata', async () => {
    useAppStore.setState({ agentTasks: [task('读取 https://example.com/docs')] });
    readWebPageMock.mockResolvedValue({
      text: 'UNTRUSTED_PAGE_BODY',
      truncated: false,
      links: [],
      source: {
        id: 'page-1',
        title: 'Public documentation',
        url: 'https://example.com/docs',
        domain: 'example.com',
        fetchedAt: 20,
        sourceType: 'page',
      },
    });

    const result = await getAgentTool('web_extract')!.execute(context, {
      url: 'https://example.com/docs',
    });

    expect(result.modelContent).toContain('UNTRUSTED_PAGE_BODY');
    expect(JSON.stringify(result.sources)).not.toContain('UNTRUSTED_PAGE_BODY');
    expect(result.sources).toEqual([expect.objectContaining({
      citationId: 'S1',
      title: 'Public documentation',
      url: 'https://example.com/docs',
    })]);
  });

  it('assigns a citation to each page and keeps text paired with its own source', async () => {
    const pages = [1, 2, 3].map((i) => ({
      source: { id: `page-${i}`, title: `Chapter ${i}`, url: `https://example.com/docs/${i}`, domain: 'example.com', fetchedAt: 20, sourceType: 'page' },
      text: `BODY_${i}`, links: [], truncated: false,
    }));
    readWebPageMock.mockResolvedValue({ source: pages[0].source, pages, text: 'BODY_1\nBODY_2\nBODY_3', links: [], truncated: false, complete: false, issues: ['timeout'], readMethod: 'rendered' });
    const result = await getAgentTool('web_extract')!.execute(context, { url: pages[0].source.url });
    expect(result.sources).toHaveLength(3);
    for (let i = 1; i <= 3; i += 1) {
      expect(result.sources?.[i - 1]).toMatchObject({ citationId: `S${i}`, url: `https://example.com/docs/${i}` });
      expect(result.modelContent).toContain(`URL: https://example.com/docs/${i}\n--- 外部内容开始 ---\nBODY_${i}`);
    }
    expect(result.summary).toContain('部分');
    expect(result.modelContent).toContain('超时');
    expect(JSON.stringify(result.sources)).not.toContain('BODY_');
  });

  it('never cites a search navigation page mixed into rendered page results', async () => {
    const pages = ['https://example.com/research', 'https://www.bing.com/search?q=ai'].map((url, index) => ({
      source: { id: `page-${index}`, title: 'Page', url, domain: new URL(url).hostname, fetchedAt: 1, sourceType: 'page' },
      text: index === 0 ? 'FACT_BODY' : 'SEARCH_SNIPPET', links: [], truncated: false,
    }));
    readWebPageMock.mockResolvedValue({ source: pages[0].source, pages, text: 'FACT_BODY\nSEARCH_SNIPPET', links: [], truncated: false, complete: true, issues: [], readMethod: 'rendered' });
    const result = await getAgentTool('web_extract')!.execute(context, { url: pages[0].source.url });
    expect(result.sources).toEqual([expect.objectContaining({ url: 'https://example.com/research' })]);
    expect(result.modelContent).not.toContain('SEARCH_SNIPPET');
    expect(result.modelContent).toContain('搜索导航页');
  });
});
