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
    expect(result.modelContent).toContain('https://www.sogou.com/web?query=latest+ai');
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

  it('switches from Google News to Sogou when the first navigation request fails', async () => {
    const googleUrl = 'https://news.google.com/rss/search?q=latest+ai&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans';
    readWebPageMock.mockRejectedValue('网页返回 HTTP 429');

    const result = await getAgentTool('web_extract')!.execute(context, { url: googleUrl });

    expect(result).toMatchObject({
      status: 'success',
      summary: 'Google News 搜索入口不可用，已切换到搜狗',
    });
    expect(result.modelContent).toContain('请立即调用 web_extract 打开搜狗搜索入口');
    expect(result.modelContent).toContain('https://www.sogou.com/web?query=latest+ai');
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
});
