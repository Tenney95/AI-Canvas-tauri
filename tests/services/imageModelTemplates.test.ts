/**
 * imageModelTemplates — 回归测试：explicit image quick templates。
 */
import { describe, expect, it } from 'vitest';
import {
  buildGoogleImageParts, createImageQuickAdaptTemplate, IMAGE_QUICK_ADAPT_OPTIONS,
  resolveImageTemplateDimensions,
} from '../../src/services/ai/imageModelTemplates';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { buildModelProtocolRequest, resolveModelExecutionProfile, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import { findUnusedReferenceVariables } from '../../src/services/ai/modelProtocolRuntime';
import { readModelProtocolUrls } from '../../src/services/ai/modelProtocolResponse';
import { resolvePoll } from '../../src/services/ai/modelProtocolPoll';
import type { ProviderModelSelection } from '../../src/types';
import { getImageSizePresets, resolveImageDimensions } from '../../src/services/ai/modelSizeProfiles';

describe('shared image size profiles', () => {
  it('preserves each channel table and returns isolated editable copies', () => {
    expect(getImageSizePresets('openai-gpt')['1K']['2:1']).toEqual([1536, 768]);
    expect(getImageSizePresets('apimart-gpt-2.5')['1k']['2:1']).toEqual([2048, 1024]);
    expect(getImageSizePresets('toapis-gpt-2.5')['1K']['2:1']).toBeUndefined();
    expect(getImageSizePresets('openai-gpt')['4K']['3:2']).toEqual([3520, 2336]);
    expect(getImageSizePresets('relayon-image-2.5')['4K']['3:2']).toEqual([3456, 2304]);
    expect(getImageSizePresets('relayon-image-2')['1K']['9:21']).toEqual([576, 1344]);
    expect(getImageSizePresets('relayon-image-2.5')['1K']['9:21']).toBeUndefined();
    const edited = getImageSizePresets('openai-gpt');
    edited['2K']['1:1'] = [1, 1];
    expect(getImageSizePresets('openai-gpt')['2K']['1:1']).toEqual([2048, 2048]);
    expect(getImageSizePresets('apimart-gpt-2.5')['2k']['1:1']).toEqual([2048, 2048]);
  });

  it.each([
    ['512', 512], ['0.5K', 512], ['1.5K', 1536], ['3K', 3072], ['2MP', 1536], ['4MP', 2560],
  ])('uses the same known %s dimensions through the template entry', (resolution, size) => {
    expect(resolveImageDimensions(undefined, String(resolution), '1:1')).toEqual({ width: size, height: size });
    expect(resolveImageTemplateDimensions(undefined, String(resolution), '1:1')).toEqual({ width: size, height: size });
  });

  it('requires declared mappings and keeps adaptive dimensions as a square layout estimate', () => {
    const capability = { dimensionPresets: getImageSizePresets('apimart-gpt-2.5') };
    expect(resolveImageDimensions(capability, '4K', '16:9')).toEqual({ width: 3840, height: 2160 });
    expect(resolveImageDimensions(capability, '4K', 'auto')).toEqual({ width: 2880, height: 2880 });
    expect(resolveImageDimensions(capability, '4K', 'adaptive')).toEqual({ width: 2880, height: 2880 });
    expect(resolveImageDimensions({ dimensionPresets: { '2K': { '16:9': [2048, 1152] } } }, '2K', 'auto'))
      .toEqual({ width: 2048, height: 2048 });
    expect(resolveImageDimensions(undefined, '1536x1024', '3:2')).toEqual({ width: 1536, height: 1024 });
    expect(() => resolveImageDimensions(capability, '4K', '8:1')).toThrow('缺少像素尺寸映射');
    expect(resolveImageDimensions(undefined, 'HD', '1:1')).toEqual({ width: 1024, height: 1024 });
  });

  it('keeps verified Google model sizes distinct from other channels and older models', () => {
    const original = getImageSizePresets('google-gemini-2.5-flash');
    const pro = getImageSizePresets('google-gemini-3-pro');
    const nano21 = getImageSizePresets('google-nano-banana-2.1');
    expect(Object.keys(original)).toEqual(['1K']);
    expect(original['1K']['16:9']).toEqual([1344, 768]);
    expect(original['1K']['3:4']).toEqual([864, 1184]);
    expect(pro['1K']['16:9']).toEqual([1376, 768]);
    expect(pro['2K']['16:9']).toEqual([2752, 1536]);
    expect(pro['4K']['16:9']).toEqual([5504, 3072]);
    expect(pro['1K']['1:8']).toBeUndefined();
    expect(nano21['1K']['1:8']).toEqual([384, 3072]);
    expect(nano21['4K']['1:8']).toEqual([1536, 12288]);
    expect(nano21['4K']['21:9']).toEqual([6336, 2688]);
    expect(nano21['512']).toBeUndefined();
  });
});

describe('explicit image quick templates', () => {
  it.each(IMAGE_QUICK_ADAPT_OPTIONS)('keeps $id capability and protocol consistent', ({ id }) => {
    const template = createImageQuickAdaptTemplate(id);
    const model: ProviderModelSelection = { id: 'actual-model-id', name: 'User name', category: 'image', provider: 'custom', ...template };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
    expect(validateModelExecutionProtocol(resolveModelExecutionProfile(template.executionProfile))).toEqual([]);
    expect(template).not.toHaveProperty('id');
    expect(template).not.toHaveProperty('name');
    expect(template).not.toHaveProperty('apiKey');
  });

  it('creates isolated drafts and explicitly replaces the old reference request mode', () => {
    const first = createImageQuickAdaptTemplate('gpt-2:images-json');
    first.imageCapability!.ratios!.push('invalid');
    expect(createImageQuickAdaptTemplate('gpt-2:images-json').imageCapability!.ratios).not.toContain('invalid');
    expect(first.imageReferenceRequestMode).toBe('generation-json-image-urls');
    expect(() => createImageQuickAdaptTemplate('unknown')).toThrow('未找到');
  });

  it('offers only GPT Image 2 and 2.5 across the three transport formats', () => {
    const gptOptions = IMAGE_QUICK_ADAPT_OPTIONS.filter((option) => option.family === 'gpt');
    expect(gptOptions.map((option) => option.id)).toEqual([
      'gpt-2:openai', 'gpt-2:images-json', 'gpt-2:apimart',
      'gpt-2.5:openai', 'gpt-2.5:images-json', 'gpt-2.5:apimart',
    ]);
    for (const variant of ['gpt-1', 'gpt-1.5']) for (const transport of ['openai', 'images-json', 'apimart']) {
      expect(() => createImageQuickAdaptTemplate(`${variant}:${transport}`)).toThrow('未找到');
    }
  });

  it.each(['gpt-2:openai', 'gpt-2.5:images-json'])('keeps every %s size within official pixel limits', (id) => {
    const capability = createImageQuickAdaptTemplate(id).imageCapability!;
    for (const resolution of capability.resolutions!) for (const ratio of capability.ratios!) {
      const { width, height } = resolveImageTemplateDimensions(capability, resolution, ratio);
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
      expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
      expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3);
      expect(width * height).toBeGreaterThanOrEqual(655360);
      expect(width * height).toBeLessThanOrEqual(8294400);
    }
    expect(resolveImageTemplateDimensions(capability, '4k', '16:9')).toEqual({ width: 3840, height: 2160 });
    expect(() => resolveImageTemplateDimensions(capability, '4K', '8:1')).toThrow('缺少像素尺寸映射');
  });

  it('separates model and transport limits instead of inferring a contract from the name', () => {
    expect(createImageQuickAdaptTemplate('banana:google').imageCapability!.resolutions).toEqual(['1K']);
    expect(createImageQuickAdaptTemplate('banana-2:google').imageCapability!.resolutions).toContain('512');
    expect(createImageQuickAdaptTemplate('banana-2:apimart').imageCapability!.resolutions).toContain('0.5K');
    expect(createImageQuickAdaptTemplate('banana-pro:google').imageCapability!.maxImageReferences).toBe(14);
    expect(createImageQuickAdaptTemplate('banana-pro:apimart').imageCapability!.maxImageReferences).toBe(14);
    expect(createImageQuickAdaptTemplate('gpt-2:images-json').imageCapability!.maxImageReferences).toBe(8);
    expect(createImageQuickAdaptTemplate('gpt-2:apimart').imageCapability!.maxBatchCount).toBe(1);
  });

  it.each(['google', 'gemini-relay'])('uses complete official tables only in explicit %s templates', (transport) => {
    const original = createImageQuickAdaptTemplate(`banana:${transport}`).imageCapability!;
    const pro = createImageQuickAdaptTemplate(`banana-pro:${transport}`).imageCapability!;
    const nano21 = createImageQuickAdaptTemplate(`banana-2.1:${transport}`).imageCapability!;
    expect(resolveImageTemplateDimensions(original, '1K', '16:9')).toEqual({ width: 1344, height: 768 });
    expect(resolveImageTemplateDimensions(pro, '4K', '16:9')).toEqual({ width: 5504, height: 3072 });
    expect(resolveImageTemplateDimensions(nano21, '2K', '1:8')).toEqual({ width: 768, height: 6144 });
    expect(createImageQuickAdaptTemplate(`banana-2:${transport}`).imageCapability?.dimensionPresets).toBeUndefined();
    expect(resolveImageTemplateDimensions(undefined, '512', '21:9')).toEqual({ width: 1195, height: 512 });
    for (const variant of ['banana', 'banana-pro', 'banana-2', 'banana-2.1']) {
      expect(createImageQuickAdaptTemplate(`${variant}:apimart`).imageCapability?.dimensionPresets).toBeUndefined();
    }
  });

  it('uses the APIMart 2.5 size contract without assuming the unconfirmed GPT Image 2 table', () => {
    const capability = createImageQuickAdaptTemplate('gpt-2.5:apimart').imageCapability!;
    expect(resolveImageTemplateDimensions(capability, '1k', '2:1')).toEqual({ width: 2048, height: 1024 });
    expect(createImageQuickAdaptTemplate('gpt-2:apimart').imageCapability?.dimensionPresets).toBeUndefined();
  });

  it.each([
    { variant: 'banana', maximum: 3 },
    { variant: 'banana-pro', maximum: 14 },
    { variant: 'banana-2', maximum: 14 },
    { variant: 'banana-2.1', maximum: 14 },
  ])('keeps $variant reference capacity independent of text VLM budgets', ({ variant, maximum }) => {
    for (const transport of ['google', 'gemini-relay', 'apimart']) {
      expect(createImageQuickAdaptTemplate(`${variant}:${transport}`).imageCapability!.maxImageReferences).toBe(maximum);
    }
  });

  it('converts all native references and keeps prompt/MIME metadata out of delivery checks', () => {
    const imageUrls = ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg=='];
    const googleImageParts = buildGoogleImageParts('Edit both images', imageUrls);
    const protocol = resolveModelExecutionProfile(createImageQuickAdaptTemplate('banana-pro:google').executionProfile)!;
    const variables = { model: 'actual-id', prompt: 'Edit both images', imageSize: '2K', aspectRatio: '16:9', imageUrls, googleImageParts };
    const request = buildModelProtocolRequest({ baseUrl: 'https://google.example/v1', apiKey: 'fixture', protocol, variables });
    expect(request.url).toBe('https://google.example/v1/models/actual-id:generateContent');
    expect(request.init.headers).toMatchObject({ 'x-goog-api-key': 'fixture' });
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'Edit both images' },
        { inlineData: { mimeType: 'image/png', data: 'YQ==' } },
        { inlineData: { mimeType: 'image/jpeg', data: 'Yg==' } }] }],
      generationConfig: { responseFormat: { image: { imageSize: '2K', aspectRatio: '16:9' } } },
    });
    expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
    // 只引用提示词或第一张图仍须拦截，不得通过改变原数组下标绕过校验。
    for (const index of [0, 1]) {
      const partial = { ...protocol, submit: { ...protocol.submit, body: { parts: `{{googleImageParts.${index}}}` } } };
      expect(findUnusedReferenceVariables(JSON.stringify(partial), variables)).toContain('imageUrls');
    }
    expect(findUnusedReferenceVariables(JSON.stringify(protocol), {
      ...variables, imageUrls: [], googleImageParts: buildGoogleImageParts('Text only', []),
    })).toEqual([]);
    expect(() => buildGoogleImageParts('edit', ['https://cdn.example/reference.png'])).toThrow('Base64');
  });

  it('declares quality only for the explicitly confirmed template contracts', () => {
    expect(createImageQuickAdaptTemplate('gpt-2:openai').imageCapability).toMatchObject({
      qualities: ['auto', 'low', 'medium', 'high'], defaultQuality: 'auto',
    });
    for (const transport of ['openai', 'apimart']) {
      expect(createImageQuickAdaptTemplate(`gpt-2.5:${transport}`).imageCapability).toMatchObject({
        qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'auto',
      });
    }
    for (const id of ['gpt-2:images-json', 'gpt-2.5:images-json', 'gpt-2:apimart', 'banana-pro:apimart']) {
      expect(createImageQuickAdaptTemplate(id).imageCapability?.qualities).toBeUndefined();
      expect(createImageQuickAdaptTemplate(id).imageCapability?.defaultQuality).toBeUndefined();
    }
  });

  it('declares 2.5 backgrounds only for confirmed official and APIMart templates with interface-default omission', () => {
    for (const transport of ['openai', 'apimart']) {
      const template = createImageQuickAdaptTemplate(`gpt-2.5:${transport}`);
      expect(template.imageCapability?.backgrounds).toEqual(['auto', 'opaque', 'transparent']);
      expect(template.imageCapability?.defaultBackground).toBeUndefined();
      const protocol = resolveModelExecutionProfile(template.executionProfile)!;
      const variables = { model: 'actual-id', prompt: 'sticker', imageSize: '1k', aspectRatio: '1:1', size: '1024x1024', n: 1 };
      const omitted = buildModelProtocolRequest({ baseUrl: 'https://images.example/v1', apiKey: 'fixture', protocol, variables });
      expect(JSON.parse(String(omitted.init.body))).not.toHaveProperty('background');
      const transparent = buildModelProtocolRequest({ baseUrl: 'https://images.example/v1', apiKey: 'fixture', protocol,
        variables: { ...variables, imageBackground: 'transparent' } });
      expect(JSON.parse(String(transparent.init.body))).toHaveProperty('background', 'transparent');
    }
    for (const id of ['gpt-2:openai', 'gpt-2:apimart', 'gpt-2:images-json', 'gpt-2.5:images-json', 'banana-pro:apimart', 'banana-pro:google']) {
      expect(createImageQuickAdaptTemplate(id).imageCapability?.backgrounds).toBeUndefined();
      expect(createImageQuickAdaptTemplate(id).imageCapability?.defaultBackground).toBeUndefined();
    }
    const bananaProtocol = resolveModelExecutionProfile(createImageQuickAdaptTemplate('banana-pro:apimart').executionProfile)!;
    expect(JSON.stringify(bananaProtocol.submit)).not.toContain('imageBackground');
  });

  it('sends APIMart 2.5 quality independently and keeps unconfirmed templates free of the field', () => {
    const variables = { model: 'actual-id', prompt: 'draft', imageSize: '2k', aspectRatio: '16:9', imageQuality: 'xhigh', n: 1 };
    for (const id of ['gpt-2.5:apimart', 'gpt-2:apimart', 'banana-pro:apimart']) {
      const protocol = resolveModelExecutionProfile(createImageQuickAdaptTemplate(id).executionProfile)!;
      const request = buildModelProtocolRequest({ baseUrl: 'https://apimart.example/v1', apiKey: 'fixture', protocol, variables });
      const body = JSON.parse(String(request.init.body));
      expect(body.resolution).toBe('2k');
      if (id === 'gpt-2.5:apimart') expect(body.quality).toBe('xhigh');
      else expect(body).not.toHaveProperty('quality');
    }
  });

  it('resolves APIMart polling from the actual nested submission response and array URLs', () => {
    const protocol = resolveModelExecutionProfile(createImageQuickAdaptTemplate('gpt-2.5:apimart').executionProfile)!;
    const poll = resolvePoll('https://apimart.example/v1', protocol.poll!, protocol.auth,
      { submit: { data: [{ task_id: 'task-123', status: 'submitted' }] } });
    expect(poll.url).toBe('https://apimart.example/v1/tasks/task-123');
    expect(readModelProtocolUrls({ data: { result: { images: [{ url: ['https://cdn.example/one.png', 'https://cdn.example/two.png'] }] } } },
      poll.resultUrlPath!)).toEqual(['https://cdn.example/one.png', 'https://cdn.example/two.png']);
  });
});
