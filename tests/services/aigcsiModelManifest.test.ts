import { assert, describe, expect, it } from 'vitest';
import type { ProviderModelSelection } from '../../src/types';
import type { ModelProtocolVariables } from '../../src/services/ai/modelProtocolTypes';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { buildModelProtocolRequest, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import {
  AIGCSI_BASE_URL, AIGCSI_MODEL_MANIFEST, aigcsiImageExecutionProfile, aigcsiVideoVariables,
  matchAigcsiCatalog, normalizeAigcsiCatalogItems, usesAigcsiModelProtocol,
} from '../../src/services/ai/providers/aigcsiModelManifest';

function model(id: string) {
  const result = AIGCSI_MODEL_MANIFEST.find((item) => item.id === id);
  assert(result);
  return result;
}

describe('Amam 已核对模型合同', () => {
  it('型号基线不扩大已核对渠道能力，也不补入未声明的图片默认值或精确像素', () => {
    expect(model('seedance2.5-15').videoCapability).toEqual({
      operations: ['text-to-video', 'image-to-video'],
      ratios: ['16:9', '9:16'], defaultRatio: '16:9', resolutions: ['720p'], defaultResolution: '720p',
      minDuration: 5, maxDuration: 30, defaultDuration: 5,
      maxImageReferences: 30, maxVideoReferences: 0, maxAudioReferences: 10, allowFrameAndReferenceMix: false,
    });
    expect(model('seedance2.0-930-1').videoCapability).toEqual({
      operations: ['text-to-video', 'image-to-video', 'video-to-video'],
      ratios: ['16:9', '9:16'], defaultRatio: '16:9', resolutions: ['720p'], defaultResolution: '720p',
      minDuration: 5, maxDuration: 15, defaultDuration: 5,
      maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 0, allowFrameAndReferenceMix: false,
    });
    for (const item of AIGCSI_MODEL_MANIFEST.filter((entry) => entry.category === 'image')) {
      expect(Object.keys(item.imageCapability!).sort(), item.id).toEqual([
        'resolutions', 'ratios', 'supportsBatch', 'maxBatchCount', 'supportsImageReference',
        'maxImageReferences', 'supportsDataUrlReference',
      ].sort());
    }
  });

  it('仅提供十一个常规图片、十个视频，全部声明可解析的异步协议与参数映射', () => {
    expect(AIGCSI_MODEL_MANIFEST.filter((item) => item.category === 'image')).toHaveLength(11);
    expect(AIGCSI_MODEL_MANIFEST.filter((item) => item.category === 'video')).toHaveLength(10);
    expect(new Set(AIGCSI_MODEL_MANIFEST.map((item) => item.id)).size).toBe(21);
    for (const item of AIGCSI_MODEL_MANIFEST) {
      assert(item.executionProfile?.protocol?.version === 2);
      expect(item.executionProfile?.protocol?.mode).toBe('async');
      expect(validateModelExecutionProtocol(item.executionProfile!.protocol)).toEqual([]);
      expect(() => assertModelCapabilityProtocol(item)).not.toThrow();
      expect(item.executionProfile!.protocol!.poll!.maxDurationMs).toBe(7_200_000);
    }
  });

  it('Muse 按固定时长、三种比例和四张图声明，不借用视频／音频参考或生成音轨开关', () => {
    const muse = model('muse-video-1');
    expect(muse.videoCapability).toMatchObject({ resolutions: ['720p'], defaultResolution: '720p',
      ratios: ['16:9', '9:16', '1:1'], durations: [5, 6, 8, 10], defaultDuration: 5,
      maxImageReferences: 4, maxVideoReferences: 0, maxAudioReferences: 0 });
    expect(muse.videoCapability).not.toHaveProperty('supportsAudio');
    expect(muse.videoCapability).not.toHaveProperty('frameRates');
    const protocol = muse.executionProfile!.protocol!;
    assert(protocol.version === 2);
    const request = buildModelProtocolRequest({ baseUrl: AIGCSI_BASE_URL, apiKey: 'fixture', protocol,
      variables: { model: muse.id, prompt: '镜头推进', durationText: '8', resolution: '720p', aspectRatio: '9:16',
        referenceImageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] } });
    expect(request.url).toBe('https://aigc-si.com/v1/videos');
    expect(JSON.parse(String(request.init.body))).toEqual({ model: 'muse-video-1', prompt: '镜头推进',
      seconds: '8', resolution: '720p', aspect_ratio: '9:16',
      reference_images: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] });
    expect(protocol.poll!.response.result).toEqual({ mimeType: 'video/mp4',
      download: { method: 'GET', path: '/videos/{{submit.id}}/content' } });
  });

  it('不同渠道的参考数量和输出范围分别声明，不混合独立最大值', () => {
    for (const item of AIGCSI_MODEL_MANIFEST.filter((entry) => entry.category === 'video')) {
      expect(item.inputModalities).toEqual(['text', 'image']);
    }
    expect(model('seedance2.5-15').videoCapability).toMatchObject({ maxImageReferences: 30, maxVideoReferences: 0, maxAudioReferences: 10 });
    expect(model('seedance2.0-930-1').videoCapability).toMatchObject({ maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 0, maxDuration: 15 });
    expect(model('seedance2.0-15').videoCapability).toMatchObject({ maxVideoReferences: 0, maxAudioReferences: 3 });
    expect(model('seedance2.0-7').videoCapability).toMatchObject({ resolutions: ['480p', '720p', '1080p', '4K'], durations: [15], defaultDuration: 15 });
    expect(model('minimax-h3-5').videoCapability).toMatchObject({ resolutions: ['768p', '2K'], minDuration: 4, maxDuration: 15 });
  });

  it.each([
    ['image-2.5-flare', 0], ['image-2.5-flare', 2],
    ['image-2.6-flare', 0], ['image-2.6-flare', 2],
    ['image-2.6-sunburst', 0], ['image-2.6-sunburst', 2],
  ] as const)('%s 参考图数量为 %s 时选择文生／编辑异步入口，不额外发送像素、质量或背景', (id, count) => {
    const protocol = aigcsiImageExecutionProfile(count).protocol!;
    assert(protocol.version === 2);
    const request = buildModelProtocolRequest({ baseUrl: AIGCSI_BASE_URL, apiKey: 'fixture', protocol,
      variables: { model: id, prompt: '贴纸', imageSize: '2K', aspectRatio: '9:16', n: 1,
        imageUrls: count ? ['data:image/png;base64,AQID', 'https://cdn.example/b.png'] : undefined,
        imageQuality: 'high', imageBackground: 'transparent', size: '123x456' } });
    expect(request.url).toBe(`https://aigc-si.com/v1/images/${count ? 'edits' : 'generations'}/async`);
    expect(JSON.parse(String(request.init.body))).toEqual({ model: id, prompt: '贴纸',
      resolution: '2K', aspect_ratio: '9:16', n: 1, response_format: 'url',
      ...(count ? { images: ['data:image/png;base64,AQID', 'https://cdn.example/b.png'] } : {}) });
    expect(protocol.poll!.response.result).toEqual({ urlPath: 'result.data.*.url' });
    expect(protocol.poll!.response.failureValues).toEqual(['failed', 'timeout']);
  });

  it('未确认的质量枚举和透明背景不开放，分辨率单独声明', () => {
    for (const item of AIGCSI_MODEL_MANIFEST.filter((entry) => entry.category === 'image')) {
      expect(item.imageCapability).not.toHaveProperty('qualities');
      expect(item.imageCapability).not.toHaveProperty('backgrounds');
      expect(item.imageCapability).toMatchObject({ supportsBatch: true, maxBatchCount: 4, maxImageReferences: 6 });
    }
    expect(model('香蕉2.1').imageCapability?.resolutions).toEqual(['1K']);
    expect(model('香蕉').imageCapability?.ratios).not.toContain('1:8');
    expect(model('香蕉-2').imageCapability?.ratios).toContain('1:8');
  });

  it.each(['image-2.6-flare', 'image-2.6-sunburst'])('%s 仅开放已确认的档位、比例、参考和批量能力', (id) => {
    expect(model(id)).toMatchObject({ id, provider: 'aigc-si', category: 'image', inputModalities: ['text', 'image'],
      imageCapability: { resolutions: ['1K', '2K', '4K'], ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        supportsBatch: true, maxBatchCount: 4, supportsImageReference: true, maxImageReferences: 6,
        supportsDataUrlReference: true } });
    expect(model(id).imageCapability).not.toHaveProperty('dimensionPresets');
    expect(model(id).imageCapability).not.toHaveProperty('defaultQuality');
    expect(model(id).imageCapability).not.toHaveProperty('defaultBackground');
  });

  it('目录优先使用 api_model，不采用显示名、未知调用值或停用条目', () => {
    expect(normalizeAigcsiCatalogItems([
      { id: 'sku', api_model: 'muse-video-1', name: '动态显示名' },
      { id: 'image-2', enabled: false }, { id: 'image-2', api_model: '  ' }, null,
    ])).toEqual([{ id: 'muse-video-1', api_model: 'muse-video-1', name: '动态显示名' }, { id: 'image-2', api_model: '  ' }]);
    const remote = (id: string): ProviderModelSelection => ({ id, name: id, category: 'text', provider: 'my-amam' });
    const result = matchAigcsiCatalog(['muse-video-1', 'muse-video-1', 'muse-video', 'MJ-2k',
      'native-image-2.5-flare-pool', 'unknown', 'image-2', 'image-2.6-flare', 'image-2.6-sunburst',
      'image-2.6-flare', 'native-image-2.6-flare-pool'].map(remote));
    expect(result.map((item) => [item.id, item.category, item.provider])).toEqual([
      ['muse-video-1', 'video', 'my-amam'], ['image-2', 'image', 'my-amam'],
      ['image-2.6-flare', 'image', 'my-amam'], ['image-2.6-sunburst', 'image', 'my-amam'],
    ]);
    result[0].videoCapability!.ratios!.push('3:2');
    expect(model('muse-video-1').videoCapability!.ratios).not.toContain('3:2');
  });

  it.each(['image-2', 'image-2.6-flare', 'image-2.6-sunburst'])('%s 只识别完整内置协议，不替换修改过的路径、参数或鉴权', (id) => {
    const item = model(id);
    expect(usesAigcsiModelProtocol(item.id, item.executionProfile)).toBe(true);
    expect(usesAigcsiModelProtocol(item.id, aigcsiImageExecutionProfile(0))).toBe(true);
    const customized = structuredClone(item.executionProfile!);
    customized.protocol!.submit.path = '/my-images';
    expect(usesAigcsiModelProtocol(item.id, customized)).toBe(false);
    const withQuality = structuredClone(item.executionProfile!);
    assert(withQuality.protocol!.submit.body && !Array.isArray(withQuality.protocol!.submit.body)
      && typeof withQuality.protocol!.submit.body === 'object');
    withQuality.protocol!.submit.body.quality = 'high';
    expect(usesAigcsiModelProtocol(item.id, withQuality)).toBe(false);
    expect(usesAigcsiModelProtocol('unknown', item.executionProfile)).toBe(false);
  });

  it.each([{ firstImage: 'https://cdn.example/first.png' },
    { lastImage: 'https://cdn.example/last.png' }, { videoInputMode: 'mixed' }] satisfies ModelProtocolVariables[])('首尾帧模式在上传／提交之前明确拒绝：%j', (variables) => {
    expect(() => aigcsiVideoVariables(variables)).toThrow('首尾帧');
  });
});
