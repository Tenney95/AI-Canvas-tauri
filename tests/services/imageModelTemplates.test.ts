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
    expect(createImageQuickAdaptTemplate('banana-pro:google').imageCapability!.maxImageReferences).toBe(6);
    expect(createImageQuickAdaptTemplate('banana-pro:apimart').imageCapability!.maxImageReferences).toBe(14);
    expect(createImageQuickAdaptTemplate('gpt-2:images-json').imageCapability!.maxImageReferences).toBe(8);
    expect(createImageQuickAdaptTemplate('gpt-2:apimart').imageCapability!.maxBatchCount).toBe(1);
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

  it('resolves APIMart polling from the actual nested submission response and array URLs', () => {
    const protocol = resolveModelExecutionProfile(createImageQuickAdaptTemplate('gpt-2.5:apimart').executionProfile)!;
    const poll = resolvePoll('https://apimart.example/v1', protocol.poll!, protocol.auth,
      { submit: { data: [{ task_id: 'task-123', status: 'submitted' }] } });
    expect(poll.url).toBe('https://apimart.example/v1/tasks/task-123');
    expect(readModelProtocolUrls({ data: { result: { images: [{ url: ['https://cdn.example/one.png', 'https://cdn.example/two.png'] }] } } },
      poll.resultUrlPath!)).toEqual(['https://cdn.example/one.png', 'https://cdn.example/two.png']);
  });
});
