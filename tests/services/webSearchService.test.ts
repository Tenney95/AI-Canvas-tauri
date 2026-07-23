import { describe, expect, it } from 'vitest';
import {
  parseBochaSearchResponse,
  parseExaSearchResponse,
  parseTavilySearchResponse,
  parseZhipuSearchResponse,
} from '../../src/services/webSearchService';
import { resolveWebSearchProviderId } from '../../src/services/ai/providerCatalogService';
import { truncateWebContent } from '../../src/services/webPageService';

describe('web search response normalization', () => {
  it('keeps legacy Tavily configs and honors an explicit active provider', () => {
    const tavily = { name: 'Tavily', apiKey: 'legacy-key' };
    const exa = { name: 'Exa', apiKey: 'exa-key' };

    expect(resolveWebSearchProviderId({ providers: { tavily } })).toBe('tavily');
    expect(resolveWebSearchProviderId({
      providers: { tavily, exa },
      webSearchProviderId: 'exa',
    })).toBe('exa');
  });

  it('normalizes, filters and deduplicates Tavily results', () => {
    const sources = parseTavilySearchResponse({
      results: [
        {
          title: 'Public result',
          url: 'https://example.com/docs#intro',
          content: 'Useful summary',
        },
        {
          title: 'Duplicate',
          url: 'https://example.com/docs#other',
          content: 'Duplicate summary',
        },
        { title: 'Private', url: 'http://127.0.0.1/admin', content: 'Blocked' },
        { title: 'Credential URL', url: 'https://example.org/?token=secret', content: 'Blocked' },
        { title: 'Second', url: 'https://example.org/article', content: 'Second summary' },
      ],
    }, 1234);

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      title: 'Public result',
      url: 'https://example.com/docs',
      domain: 'example.com',
      snippet: 'Useful summary',
      fetchedAt: 1234,
      sourceType: 'search',
    });
    expect(sources[1].url).toBe('https://example.org/article');
  });

  it('bounds snippets without returning provider-specific fields', () => {
    const [result] = parseTavilySearchResponse({
      results: [{
        title: '',
        url: 'https://example.com/',
        content: 'x'.repeat(1_500),
        score: 0.99,
      }],
    }, 2);

    expect(result.title).toBe('example.com');
    expect(result.snippet).toHaveLength(1_200);
    expect(result).not.toHaveProperty('score');
  });

  it('normalizes Bocha web page results', () => {
    const [result] = parseBochaSearchResponse({
      data: {
        webPages: {
          value: [{
            name: '博查结果',
            url: 'https://example.com/bocha',
            snippet: '较短摘要',
            summary: '优先使用完整摘要',
          }],
        },
      },
    }, 3);

    expect(result).toMatchObject({
      title: '博查结果',
      url: 'https://example.com/bocha',
      snippet: '优先使用完整摘要',
    });
  });

  it('normalizes Zhipu and Exa provider-specific fields', () => {
    const [zhipu] = parseZhipuSearchResponse({
      search_result: [{
        title: '智谱结果',
        link: 'https://example.com/zhipu',
        content: '智谱摘要',
      }],
    }, 4);
    const [exa] = parseExaSearchResponse({
      results: [{
        title: 'Exa result',
        url: 'https://example.com/exa',
        highlights: ['First highlight.', 'Second highlight.'],
      }],
    }, 5);

    expect(zhipu).toMatchObject({ url: 'https://example.com/zhipu', snippet: '智谱摘要' });
    expect(exa).toMatchObject({
      url: 'https://example.com/exa',
      snippet: 'First highlight. Second highlight.',
    });
  });
});

describe('web page context budgeting', () => {
  it('returns short content unchanged', () => {
    expect(truncateWebContent('short text', 2_000)).toEqual({
      text: 'short text',
      truncated: false,
    });
  });

  it('keeps the head and tail of long content with an explicit omission marker', () => {
    const content = `HEAD\n${'m'.repeat(4_000)}\nTAIL`;
    const result = truncateWebContent(content, 2_000);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('HEAD');
    expect(result.text).toContain('TAIL');
    expect(result.text).toContain('中间内容已省略');
    expect(result.text.length).toBeLessThanOrEqual(2_200);
  });
});
