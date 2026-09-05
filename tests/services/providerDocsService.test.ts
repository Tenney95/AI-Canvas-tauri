import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearWebReadSessionsForTests } from '../../src/services/chat/webReadSessionService';
import { clearProviderModelCatalogsForTests, getProviderModelCatalog } from '../../src/services/chat/providerModelCatalogService';
import {
  buildGroupedModelChoiceList,
  buildRelayCatalogContent,
  inferRelayModelCategory,
  parseNewApiPricingPayload,
  parseNewApiStatusPayload,
  readProviderDocsPage,
  sliceDocText,
} from '../../src/services/providerDocsService';
import { shouldRenderDynamicHtml } from '../../src/services/webPageService';

const invokeMock = vi.hoisted(() => vi.fn());
afterEach(() => { clearWebReadSessionsForTests(); clearProviderModelCatalogsForTests(); });
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

// 有意用明确的 DOM fixture 覆盖服务编排，不引入新的 DOM 依赖。
class DocElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: Array<DocElement | { nodeType: number; textContent: string }>;
  constructor(tagName: string, childNodes: DocElement['childNodes']) {
    this.tagName = tagName;
    this.childNodes = childNodes;
  }
  get textContent(): string { return this.childNodes.map((node) => node.textContent).join(''); }
}
const docs = new Map<string, unknown>();
function docFixture(body: string, text: string, tag = 'P', href = './reference') {
  const root = new DocElement('MAIN', [new DocElement(tag, [{ nodeType: 3, textContent: text }])]);
  docs.set(body, {
    body: root,
    querySelector: (selector: string) => selector === 'title' ? { textContent: 'Model documentation' } : root,
    querySelectorAll: () => [{ getAttribute: () => href, textContent: 'API reference' }],
  });
  return body;
}
const docUrl = 'https://example.com/docs/video/model';
function response(body: string, url = docUrl, contentType = 'text/html') {
  return { url, body, contentType, fetchedAt: 1, status: 200 };
}

beforeEach(() => {
  invokeMock.mockReset();
  docs.clear();
  vi.stubGlobal('window', { __TAURI__: {} });
  vi.stubGlobal('Node', class { static readonly TEXT_NODE = 3; });
  vi.stubGlobal('Element', DocElement);
  vi.stubGlobal('DOMParser', class {
    parseFromString(body: string) {
      const document = docs.get(body);
      if (!document) throw new Error('Missing explicit document fixture');
      return document;
    }
  });
});

describe('new-api relay catalog parsing', () => {
  const scope = { projectId: 'p', conversationId: 'c', taskId: 't' };
  it('returns a 1000-model catalog handle without copying raw pricing into model context', async () => {
    const body = JSON.stringify({ data: Array.from({ length: 1000 }, (_, index) => ({ model_name: `model-${index}`,
      display_name: `Model ${index}`, description: 'PRIVATE_RAW_DESCRIPTION', supported_endpoint_types: ['chat'] })) });
    invokeMock.mockResolvedValue(response(body, 'https://example.com/api/pricing', 'application/json'));
    const result = await readProviderDocsPage('https://example.com/api/pricing', { scope, authorize: () => true });
    expect(result.catalog?.total).toBe(1000);
    expect(result.modelCatalog).toBeUndefined();
    expect(result.text.length).toBeLessThan(300);
    expect(result.text).not.toContain('PRIVATE_RAW_DESCRIPTION');
    expect(getProviderModelCatalog(scope, result.catalog!.catalogId).options).toHaveLength(1000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
  it('reads the middle from the original documentation snapshot and not a later response', async () => {
    const body = docFixture('<main>large</main>', 'A'.repeat(20_000) + 'MIDDLE_REQUEST' + 'Z'.repeat(20_000));
    invokeMock.mockResolvedValue(response(body));
    const first = await readProviderDocsPage(docUrl, { scope, authorize: () => true });
    invokeMock.mockRejectedValue(new Error('must not refetch'));
    const middle = await readProviderDocsPage(docUrl, { scope, authorize: () => true, readSessionId: first.readSessionId, offset: 20_000 });
    expect(middle.text).toContain('MIDDLE_REQUEST');
    expect(middle.sources[0].url).toBe(docUrl);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
  const pricingBody = JSON.stringify({
    auto_groups: ['default'],
    data: [
      {
        model_name: 'lec-seedance-2-0-full-431-720p',
        display_name: 'Seedance 2.0 满血 431 720p',
        description: 'Seedance 2.0 431 系列视频生成，支持 10 秒或 15 秒视频生成。',
        model_price: 3.5,
        supported_endpoint_types: ['openai-video'],
      },
      {
        model_name: 'lec-ac-image-2',
        display_name: 'Image 2（AC）',
        description: 'Image 2 图像生成与编辑模型。',
        model_price: 0.08,
        supported_endpoint_types: ['image-generation'],
      },
      {
        model_name: 'gpt-4o',
        display_name: 'GPT-4o',
        model_price: 0.1,
        supported_endpoint_types: ['chat', 'completion'],
      },
    ],
  });

  it('parses the public new-api pricing model list', () => {
    const items = parseNewApiPricingPayload(pricingBody);
    expect(items).toHaveLength(3);
    expect(items?.[0].model_name).toBe('lec-seedance-2-0-full-431-720p');
    expect(items?.[1].display_name).toBe('Image 2（AC）');
  });

  it('rejects non-new-api pricing payloads', () => {
    expect(parseNewApiPricingPayload('not json')).toBeNull();
    expect(parseNewApiPricingPayload('{"data":"nope"}')).toBeNull();
    expect(parseNewApiPricingPayload('{"data":[]}')).toBeNull();
    expect(parseNewApiPricingPayload('{"data":[{"id":"x"}]}')).toBeNull();
    expect(parseNewApiPricingPayload('{"data":[{"model_name":""}]}')).toBeNull();
  });

  it('infers model category from endpoint types and identifiers', () => {
    expect(inferRelayModelCategory({ model_name: 'lec-seedance-x', supported_endpoint_types: ['openai-video'] })).toBe('视频');
    expect(inferRelayModelCategory({ model_name: 'lec-ac-image-2', supported_endpoint_types: ['image-generation'] })).toBe('图片');
    expect(inferRelayModelCategory({ model_name: 'tts-1', supported_endpoint_types: ['audio'] })).toBe('音频');
    expect(inferRelayModelCategory({ model_name: 'gpt-4o', supported_endpoint_types: ['chat'] })).toBe('文本');
    expect(inferRelayModelCategory({ model_name: 'flux-pro' })).toBe('图片');
    expect(inferRelayModelCategory({ model_name: 'seedream-x' })).toBe('图片');
  });

  it('parses status payload for system name and announcements', () => {
    const status = JSON.stringify({
      data: {
        system_name: 'Lec API',
        announcements: [{ content: '## 上架' }, { content: '' }],
      },
    });
    const info = parseNewApiStatusPayload(status);
    expect(info?.systemName).toBe('Lec API');
    expect(info?.announcements).toEqual(['## 上架']);
  });

  it('rejects non-new-api status payloads', () => {
    expect(parseNewApiStatusPayload('{"data":{"foo":"bar"}}')).toBeNull();
    expect(parseNewApiStatusPayload('nope')).toBeNull();
  });

  it('builds a readable catalog including model list and announcements', () => {
    const items = parseNewApiPricingPayload(pricingBody)!;
    const status = parseNewApiStatusPayload(JSON.stringify({
      data: { system_name: 'Lec API', announcements: [{ content: '## 上架' }] },
    }));
    const content = buildRelayCatalogContent('https://api.paipu.net/docs', items, status);
    expect(content.title).toBe('Lec API');
    expect(content.text).toContain('模型清单（共 3 个）');
    expect(content.text).toContain('lec-seedance-2-0-full-431-720p');
    expect(content.text).toContain('视频');
    expect(content.text).toContain('站内公告');
    expect(content.text).toContain('## 上架');
    // 视频不存在跨厂商标准；读不到真实文档时必须停止，不能猜端点。
    expect(content.text).toContain('请求体字段务必以该模型自己的文档为准');
    expect(content.text).toContain('400 unsupported field');
    expect(content.text).toContain('视频：没有跨厂商统一端点');
    expect(content.text).toContain('禁止猜测 /v1/videos、/videos/generations 或轮询路径');
  });
});

describe('中转站文档站的 SPA 识别', () => {
  it('识别出模型接口页是 SPA 空壳，从而走渲染而不是模型清单兜底', () => {
    // api.paipu.net 实测：/docs 与 /docs/videos/{模型ID} 返回的都是这个 951 字节空壳。
    // 这个判断为真，readProviderDocsPage 才会先渲染拿到单模型的真实字段；
    // 一旦判为假就会退回按 origin 探测的 /api/pricing 清单，助手又只能看到模型 ID。
    const shell = [
      '<!doctype html><html lang="en"><head><meta charset="UTF-8" />',
      '<title>Lec API</title></head>',
      '<body><div id="root"></div>',
      '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
      '</body></html>',
    ].join('');

    expect(shouldRenderDynamicHtml(shell, 'text/html; charset=utf-8', '')).toBe(true);
    // 已经有正文的静态页不该多渲染一次
    expect(shouldRenderDynamicHtml(shell, 'text/html', 'x'.repeat(2000))).toBe(false);
  });
});

describe('分类模型清单', () => {
  it('按 文本/图片/视频/音频 分组，供助手原样转述给用户挑选', () => {
    const grouped = buildGroupedModelChoiceList([
      { model_name: 'lec-grok-4.5', display_name: 'Grok 4.5', supported_endpoint_types: ['chat/completions'] },
      { model_name: 'lec-image-2', display_name: 'image-2 通用版', supported_endpoint_types: ['image-generation'] },
      { model_name: 'lec-seed-2-0-900', display_name: 'Seedance 2.0 900（专线）', supported_endpoint_types: ['openai-video'] },
      // 没有 display_name 时用模型 ID 兜底
      { model_name: 'lec-seed-2-5-900', supported_endpoint_types: ['openai-video'] },
    ]);

    expect(grouped).toBe([
      '【文本】',
      '  - Grok 4.5 —— lec-grok-4.5',
      '【图片】',
      '  - image-2 通用版 —— lec-image-2',
      '【视频】',
      '  - Seedance 2.0 900（专线） —— lec-seed-2-0-900',
      '  - lec-seed-2-5-900 —— lec-seed-2-5-900',
    ].join('\n'));

    expect(buildGroupedModelChoiceList([])).toBe('');
  });
});

describe('sliceDocText', () => {
  const text = 'a'.repeat(25_000);

  it('reports how much of a long page is still unread', () => {
    const first = sliceDocText(text, 0, 10_000);
    expect(first.text).toHaveLength(10_000);
    expect(first.truncated).toBe(true);
    expect(first.totalTextChars).toBe(25_000);
    expect(first.nextOffset).toBe(10_000);
  });

  it('continues from the given offset and closes out on the last chunk', () => {
    const second = sliceDocText(text, 10_000, 10_000);
    expect(second.nextOffset).toBe(20_000);

    const last = sliceDocText(text, 20_000, 10_000);
    expect(last.text).toHaveLength(5_000);
    expect(last.truncated).toBe(false);
    expect(last.nextOffset).toBeUndefined();
  });

  it('clamps an offset past the end instead of throwing', () => {
    expect(sliceDocText('short', 999, 10_000)).toMatchObject({ text: '', truncated: false });
  });
});

describe('provider document read orchestration', () => {
  function loadingShell() {
    return docFixture('<div id="root"><p>加载中...</p></div><script src="/app.js"></script>', '加载中...');
  }

  it('renders a short nonempty SPA before probing the catalog and preserves API code', async () => {
    const code = 'POST /v1/generate\n{\n  "model": "demo",\n  "image_urls": ["{{referenceImages}}"]\n}';
    invokeMock.mockResolvedValueOnce(response(loadingShell()))
      .mockResolvedValueOnce(response(docFixture('<main><pre>API_CODE</pre></main>', code, 'PRE')));
    const result = await readProviderDocsPage(docUrl);
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(['provider_docs_read', 'assistant_web_render']);
    expect(result.text).toContain(`\`\`\`\n${code}\n\`\`\``);
    expect(result).toMatchObject({ readMethod: 'rendered', complete: true, truncated: false });
    expect(result.text).not.toContain('加载中');
  });

  it('does not rerender a genuine short static article inside an application root', async () => {
    invokeMock.mockResolvedValueOnce(response(docFixture(
      '<div id="root"><article><p>请求方法为 POST，请使用公开参数。</p></article></div><script src="/app.js"></script>',
      '请求方法为 POST，请使用公开参数。',
    )));
    const result = await readProviderDocsPage(docUrl);
    expect(result.text).toContain('请求方法为 POST');
    expect(result.readMethod).toBe('static');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct rendered document bodies and resolves each relative link against its page', async () => {
    const pages = [1, 2, 3].map((i) => ({
      url: `https://example.com/docs/chapter-${i}/model`, contentType: 'text/html',
      body: docFixture(`<main>DOC_${i}</main>`, `DOC_${i}`), truncated: false,
    }));
    invokeMock.mockResolvedValueOnce(response(loadingShell()))
      .mockResolvedValueOnce({ ...response('', pages[0].url), pages, complete: false, issues: ['timeout'] });
    const result = await readProviderDocsPage(docUrl);
    for (let i = 1; i <= 3; i += 1) {
      expect(result.text).toContain(`DOC_${i}`);
      expect(result.text).toContain(`https://example.com/docs/chapter-${i}/model`);
      expect(result.links).toContainEqual({ label: 'API reference', url: `https://example.com/docs/chapter-${i}/reference` });
    }
    expect(result).toMatchObject({ complete: false, issues: ['timeout'] });
    expect(result.sources.map((source) => source.url)).toEqual(pages.map((page) => page.url));
  });

  it('falls back to a clearly labeled public catalog after render failure, not the loading text', async () => {
    invokeMock.mockResolvedValueOnce(response(loadingShell()))
      .mockRejectedValueOnce(new Error('render timeout'))
      .mockResolvedValueOnce(response('{"data":[{"model_name":"catalog-model"}]}', 'https://example.com/api/pricing', 'application/json'))
      .mockResolvedValueOnce(response('{"data":{"system_name":"Demo"}}', 'https://example.com/api/status', 'application/json'));
    const result = await readProviderDocsPage(docUrl);
    expect(result.text).toContain('catalog-model');
    expect(result.text).toContain('公开模型清单');
    expect(result.text).not.toContain('加载中');
    expect(result).toMatchObject({ readMethod: 'catalog', complete: false });
    expect(result.text).toContain('未读取到目标文档');
  });

  it('rejects login-only rendered pages when no public catalog exists', async () => {
    invokeMock.mockResolvedValueOnce(response(loadingShell()))
      .mockResolvedValueOnce(response(docFixture('<main><h1>请登录</h1><form><input type="password"></form></main>', '请登录')))
      .mockResolvedValueOnce(response('{}', 'https://example.com/api/pricing', 'application/json'));
    await expect(readProviderDocsPage(docUrl)).rejects.toThrow('没有可读取的正文');
  });

  it('rechecks the same-origin boundary for every rendered page', async () => {
    invokeMock.mockResolvedValueOnce(response(loadingShell()))
      .mockResolvedValueOnce({
        ...response(''), complete: true,
        pages: [{ url: 'https://other.example.com/page', body: 'WRONG_ORIGIN', contentType: 'application/json' }],
      });
    await expect(readProviderDocsPage(docUrl)).rejects.toThrow('同站安全校验');
  });

  it('binds a continuation slice to the page it actually contains, not to the entry page', async () => {
    const pages = [1, 2, 3].map((index) => ({
      url: `https://example.com/docs/chapter-${index}/model`, contentType: 'application/json',
      body: `DOC_${index}_` + 'x'.repeat(180), truncated: false,
    }));
    invokeMock.mockResolvedValue({ ...response('', pages[0].url), pages, complete: true });
    const full = await readProviderDocsPage(docUrl);
    const offset = full.text.indexOf('DOC_2_');
    const fragment = await readProviderDocsPage(docUrl, { offset, maxTextChars: 40 });
    expect(fragment.text).toContain('DOC_2_');
    expect(fragment.url).toBe(pages[1].url);
    expect(fragment.sources.map((source) => source.url)).toEqual([pages[1].url]);
    expect(fragment).toMatchObject({ complete: false, truncated: true, nextOffset: offset + 40 });
    expect(fragment.issues).toContain('text_limit');
  });

  it('does not return a catalog result after the caller cancels during the fallback probe', async () => {
    const controller = new AbortController();
    invokeMock.mockResolvedValueOnce(response(loadingShell()))
      .mockRejectedValueOnce(new Error('render timeout'))
      .mockImplementationOnce(async () => {
        controller.abort();
        return response('{"data":[{"model_name":"catalog-model"}]}', 'https://example.com/api/pricing', 'application/json');
      });
    await expect(readProviderDocsPage(docUrl, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
