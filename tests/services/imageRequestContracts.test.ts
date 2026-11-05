/**
 * imageRequestContracts — 回归测试：built-in image request contracts。
 */
import { describe, expect, it } from 'vitest';
import { resolveBuiltInImageRequestContract, validateBuiltInImageResponse } from '../../src/services/ai/imageRequestContracts';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { previewModelProtocolRequest, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';

function contractFor(model: string, size = '2K', ratio = '16:9') {
  const contract = resolveBuiltInImageRequestContract(getProviderDefinition('grsai'), model, size, ratio);
  if (contract?.kind !== 'protocol') throw new Error('Expected a documented GRSAI protocol');
  return contract;
}

describe('built-in image request contracts', () => {
  it('GRSAI 2.6 仅使用已确认的 1K 正方形与 auto 合同，不继承其他站的增强能力', () => {
    const contract = contractFor('gpt-image-2.6', '1K', '1:1');
    expect(contract.protocol.submit.body).toEqual({ model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}',
      aspectRatio: '1024x1024', quality: 'auto', replyType: 'json' });
    expect(contract.dimensions).toEqual({ width: 1024, height: 1024 });
    expect(validateModelExecutionProtocol(contract.protocol)).toEqual([]);
    expect(contractFor('gpt-image-2.6', '4K', '1:1').dimensions).toEqual(contract.dimensions);
    expect(() => contractFor('gpt-image-2.6', '1K', '16:9')).toThrow('1:1');
    expect(() => resolveBuiltInImageRequestContract(getProviderDefinition('grsai'),
      'gpt-image-2.6', '1K', '1:1', 'high')).toThrow('不支持质量');
    expect(resolveBuiltInImageRequestContract(getProviderDefinition('grsai'), 'gpt-image-2.6-flare', '1K', '1:1')).toBeUndefined();
    expect(resolveBuiltInImageRequestContract(getProviderDefinition('grsai'), 'gpt-image-2.6-sunburst', '1K', '1:1')).toBeUndefined();
    expect(resolveBuiltInImageRequestContract(getProviderDefinition('cccapi'), 'gpt-image-2.6', '1K', '1:1'))
      .toEqual({ kind: 'standard', imageReferenceRequestMode: 'edits-multipart' });
  });

  it.each(['gpt-image-2-vip', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])(
    'maps only documented transparent background for GRSAI %s', (model) => {
      const definition = getProviderDefinition('grsai');
      const quality = model === 'gpt-image-2-vip' ? 'medium' : 'high';
      const transparent = resolveBuiltInImageRequestContract(definition, model, '2K', '16:9', quality, 'transparent');
      expect(transparent?.kind === 'protocol' && transparent.protocol.submit.body).toMatchObject({
        background: 'transparent', quality, aspectRatio: '2048x1152',
      });
      expect(transparent?.kind === 'protocol' && transparent.protocol.submit.body).not.toHaveProperty('output_format');
      expect(contractFor(model).protocol.submit.body).not.toHaveProperty('background');
      expect(() => resolveBuiltInImageRequestContract(definition, model, '2K', '16:9', quality, 'opaque'))
        .toThrow('不支持背景');
    },
  );
  it('does not infer background support from a GRSAI GPT 2.5 family name', () => {
    const contract = resolveBuiltInImageRequestContract(getProviderDefinition('grsai'), 'gpt-image-2.5',
      '1K', '16:9', undefined, 'transparent');
    expect(contract?.kind === 'protocol' && contract.protocol.submit.body).not.toHaveProperty('background');
  });
  it.each([
    ['gpt-image-2.5-flare', 'high'], ['gpt-image-2.5-sunburst', 'max'],
  ])('uses the selected GRSAI quality without changing pixels (%s)', (model, quality) => {
    const contract = resolveBuiltInImageRequestContract(getProviderDefinition('grsai'), model, '2K', '16:9', quality);
    expect(contract?.kind === 'protocol' && contract.protocol.submit.body)
      .toMatchObject({ aspectRatio: '2048x1152', quality });
    expect(contract?.kind === 'protocol' && contract.dimensions).toEqual({ width: 2048, height: 1152 });
  });

  it('rejects GRSAI quality unsupported by the precise model', () => {
    expect(() => resolveBuiltInImageRequestContract(getProviderDefinition('grsai'),
      'gpt-image-2.5-flare', '2K', '16:9', 'max')).toThrow('不支持质量');
    expect(() => resolveBuiltInImageRequestContract(getProviderDefinition('grsai'),
      'gpt-image-2', '1K', '16:9', 'high')).toThrow('不支持质量');
  });
  it.each(['nano-banana-2.1', 'nano-banana-2-lite'])('uses the native generation contract for %s', (model) => {
    const { protocol } = contractFor(model);
    expect(protocol.submit.path).toBe('/api/generate');
    expect(protocol.submit.body).toMatchObject({ imageSize: model.endsWith('lite') ? '1K' : '2K', aspectRatio: '16:9', images: '{{imageUrls}}' });
    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
  });

  it.each([
    ['nano-banana-2-cl', '4K', '1K'], ['nano-banana-pro-cl', '2K', '1K'],
    ['nano-banana-2-2k-cl', '1K', '2K'], ['nano-banana-2-4k-cl', '2K', '4K'],
    ['nano-banana-pro-4k-vip', '1K', '4K'], ['nano-banana-pro-vip', '4K', '1K'],
  ])('normalizes %s to its documented resolution', (model, requested, expected) => {
    expect(contractFor(model, requested).protocol.submit.body).toMatchObject({ imageSize: expected });
  });
  it('reuses the CCC catalog contract without guessing from a GPT model name', () => {
    expect(resolveBuiltInImageRequestContract(getProviderDefinition('cccapi'), 'gpt-image-2.5-sunburst', '2K', '16:9'))
      .toEqual({ kind: 'standard', imageReferenceRequestMode: 'edits-multipart' });
    for (const provider of ['custom-openai', 'google', 'xai']) {
      expect(resolveBuiltInImageRequestContract(getProviderDefinition(provider), 'gpt-image-2.5-sunburst', '2K', '16:9')).toBeUndefined();
    }
    expect(resolveBuiltInImageRequestContract(getProviderDefinition('cccapi'), 'vendor-image', '2K', '16:9')).toBeUndefined();
    expect(resolveBuiltInImageRequestContract(getProviderDefinition('grsai'), 'undocumented-image', '2K', '16:9')).toBeUndefined();
  });

  it('maps Nano Banana references and sizes to native JSON fields through the shared protocol engine', () => {
    const { protocol } = contractFor('nano-banana-2');
    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    const request = previewModelProtocolRequest({
      baseUrl: 'https://gateway.example/v1', protocol,
      variables: { model: 'nano-banana-2', prompt: '合影', imageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] },
    });
    expect(request.relativeUrl).toBe('/v1/api/generate');
    expect(request.body).toEqual({
      model: 'nano-banana-2', prompt: '合影', images: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      aspectRatio: '16:9', imageSize: '2K', replyType: 'json',
    });
  });

  it.each(['gpt-image-2', 'gpt-image-2.5'])('keeps the documented 1K ratio contract for %s', (model) => {
    const contract = contractFor(model, '4K');
    expect(contract.protocol.submit.body).toMatchObject({ aspectRatio: '16:9', quality: 'auto' });
    expect(contract.dimensions).toEqual({ width: 1672, height: 941 });
    expect(contract.protocol.submit.body).not.toHaveProperty('imageSize');
    expect(contract.protocol.submit.body).not.toHaveProperty('resolution');
  });

  it.each(['gpt-image-2-vip', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])('uses documented pixel sizes for %s', (model) => {
    const contract = contractFor(model);
    expect(contract.protocol.submit.body).toMatchObject({ aspectRatio: '2048x1152', quality: 'medium' });
    expect(contract.dimensions).toEqual({ width: 2048, height: 1152 });
    expect(validateModelExecutionProtocol(contract.protocol)).toEqual([]);
  });

  it.each(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21', '2:1', '1:2'])(
    'keeps 4K GPT pixels within the documented limits (%s)', (ratio) => {
      const { width, height } = contractFor('gpt-image-2-vip', '4K', ratio).dimensions;
      expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
      expect(width * height).toBeLessThanOrEqual(8294400);
      expect(width * height).toBeGreaterThanOrEqual(655360);
    },
  );

  it('rejects unsupported parameters before requesting a generation', () => {
    expect(() => contractFor('nano-banana-pro', '8K')).toThrow('不支持图片档位');
    expect(() => contractFor('nano-banana-pro', '2K', '1:8')).toThrow('不支持比例');
    expect(contractFor('nano-banana-2', '2K', '1:8').protocol.submit.body).toMatchObject({ aspectRatio: '1:8' });
    expect(contractFor('nano-banana-2', '720p').protocol.submit.body).toMatchObject({ imageSize: '1K' });
    expect(contractFor('gpt-image-2-vip', '4K', 'auto').protocol.submit.body).toMatchObject({ aspectRatio: 'auto' });
  });

  it('does not treat failed or unfinished task responses as generated images', () => {
    expect(() => validateBuiltInImageResponse({ status: 'failed', error: 'reference rejected' })).toThrow('reference rejected');
    expect(() => validateBuiltInImageResponse({ status: 'running', id: 'task-id' })).toThrow('不要重复提交');
    expect(() => validateBuiltInImageResponse({ status: 'succeeded' })).not.toThrow();
  });
});
