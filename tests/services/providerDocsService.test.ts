import { describe, expect, it } from 'vitest';
import {
  buildGroupedModelChoiceList,
  buildRelayCatalogContent,
  inferRelayModelCategory,
  parseNewApiPricingPayload,
  parseNewApiStatusPayload,
  sliceDocText,
} from '../../src/services/providerDocsService';
import { shouldRenderDynamicHtml } from '../../src/services/webPageService';

describe('new-api relay catalog parsing', () => {
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
    // 字段名必须以各模型自己的文档为准，通用约定只是读不到文档时的兜底
    expect(content.text).toContain('请求体字段务必以该模型自己的文档为准');
    expect(content.text).toContain('400 unsupported field');
    expect(content.text).toContain('/v1/videos');
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
