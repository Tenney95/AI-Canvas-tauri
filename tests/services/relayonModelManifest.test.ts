/**
 * relayonModelManifest — 回归测试：RelayOnAPI 已核对文本目录。
 */
import { assert, describe, expect, it } from 'vitest';
import type { ProviderModelSelection } from '../../src/types';
import {
  RELAYON_BASE_URL,
  RELAYON_IMAGE_MODEL_IDS,
  RELAYON_IMAGE_REFERENCE_LIMIT,
  RELAYON_MIDJOURNEY_MODEL_IDS,
  RELAYON_MODEL_MANIFEST,
  RELAYON_TEXT_MODEL_IDS,
  RELAYON_VIDEO_MODEL_IDS,
  RELAYON_VIDEO_RESULT_URL_PATHS,
  matchRelayonCatalog,
  relayonImageVariables,
  relayonVideoVariables,
  resolveRelayonImageExecutionProfile,
  resolveRelayonImageModelContract,
  resolveRelayonVideoCapability,
  usesRelayonModelProtocol,
  getRelayonImageOutputsPerJob,
} from '../../src/services/ai/providers/relayonModelManifest';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { buildModelProtocolRequest, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import { assertVideoModelCapability } from '../../src/services/ai/videoRequestResolver';
import { findUnusedReferenceVariables } from '../../src/services/ai/modelProtocolRuntime';
import type { ImageModelCapability, ModelExecutionProfile, ProtocolJsonValue, VideoModelCapability } from '../../src/types/aiTypes';

function remote(id: string): ProviderModelSelection {
  return { id, name: id, provider: 'relayon-personal', category: 'text' };
}

describe('RelayOnAPI 已核对文本目录', () => {
  it('只预置四个已确认型号，使用通用对话协议，不推断视觉和上下文能力', () => {
    expect(RELAYON_BASE_URL).toBe('https://relayonapi.com/v1');
    expect(RELAYON_TEXT_MODEL_IDS).toEqual([
      'gemini-3.8-flash', 'gemini-4-argon', 'gpt-6.1-sol', 'claude-opus-5-5',
    ]);
    const models = RELAYON_MODEL_MANIFEST.filter((model) => model.category === 'text');
    expect(models.map((model) => model.id)).toEqual(RELAYON_TEXT_MODEL_IDS);
    for (const model of models) {
      expect(model).toMatchObject({ provider: 'relayonapi', category: 'text',
        inputModalities: ['text'], executionProfile: { preset: 'openai-chat' } });
      expect(model.name).not.toBe(model.id);
      expect(model).not.toHaveProperty('contextWindow');
      expect(model).not.toHaveProperty('imageCapability');
      expect(model).not.toHaveProperty('videoCapability');
    }
  });

  it('只返回当前认证目录实际提供的精确型号，不补缺失型号或接受别名', () => {
    const result = matchRelayonCatalog([
      remote('gemini-3.8-flash'), remote('gpt-6.1-sol'),
      remote('GPT-6.1-SOL'), remote('gt-6.1-sol'), remote('gpt-6.1-sol-preview'),
      remote('gemini-3.1-flash-image'), remote('seedance-2-5'), remote('unknown'),
    ]);
    expect(result.map((model) => model.id)).toEqual(['gemini-3.8-flash', 'gpt-6.1-sol']);
    expect(result.every((model) => model.provider === 'relayon-personal')).toBe(true);
    expect(matchRelayonCatalog([])).toEqual([]);
  });

  it('不让远端误分类、媒体协议或未核实能力覆盖已确认文本合同', () => {
    const result = matchRelayonCatalog([{
      ...remote('claude-opus-5-5'), name: '远端媒体条目', category: 'video',
      inputModalities: ['text', 'image'], contextWindow: 999,
      executionProfile: { preset: 'openai-gpt-image' },
      imageCapability: { resolutions: ['4K'] }, videoCapability: { durations: [30] },
    }]);
    expect(result).toEqual([{
      id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'relayon-personal', category: 'text',
      inputModalities: ['text'], executionProfile: { preset: 'openai-chat' },
    }]);
  });

  it('同一个精确型号不重复展示，保持远端可用顺序和首个连接身份', () => {
    const result = matchRelayonCatalog([
      remote('gpt-6.1-sol'), { ...remote('gpt-6.1-sol'), provider: 'other-connection' },
      remote('gemini-4-argon'),
    ]);
    expect(result.map((model) => [model.id, model.provider])).toEqual([
      ['gpt-6.1-sol', 'relayon-personal'], ['gemini-4-argon', 'relayon-personal'],
    ]);
  });

  it('不修改输入或共享快照，返回的嵌套合同可以独立编辑', () => {
    const input = [remote('gpt-6.1-sol')];
    const inputBefore = structuredClone(input);
    const manifestBefore = structuredClone(RELAYON_MODEL_MANIFEST);
    const first = matchRelayonCatalog(input);
    first[0].inputModalities!.push('image');
    first[0].executionProfile!.preset = 'anthropic-chat';
    expect(input).toEqual(inputBefore);
    expect(RELAYON_MODEL_MANIFEST).toEqual(manifestBefore);
    expect(matchRelayonCatalog(input)[0]).toMatchObject({ inputModalities: ['text'],
      executionProfile: { preset: 'openai-chat' } });
  });
});

function model(id: string): ProviderModelSelection {
  const known = RELAYON_MODEL_MANIFEST.find((item) => item.id === id);
  if (!known) throw new Error(`missing fixture: ${id}`);
  return known;
}

const SEEDANCE_VIDEO_IDS = RELAYON_VIDEO_MODEL_IDS.filter((id) => id !== 'minimax-h3');
const LEGACY_SINGLE_RATIO_VIDEO_IDS = [
  'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-5-260628',
  'sd-2.0-A', 'sd-2.5-A', 'sd-2.5-c1',
];
const SEEDANCE_RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1'];

describe('RelayOnAPI Seedance 宽高比', () => {
  it.each(SEEDANCE_VIDEO_IDS)('%s 声明相同五种比例并按本渠道字段发送', (id) => {
    const selected = model(id);
    expect(selected.videoCapability?.ratios).toEqual(SEEDANCE_RATIOS);
    expect(selected.videoCapability?.defaultRatio).toBe('16:9');
    for (const aspectRatio of SEEDANCE_RATIOS) {
      const variables = relayonVideoVariables(id, { model: id, prompt: '比例回归', duration: 10,
        durationText: '10', resolution: '720p', aspectRatio });
      const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
        protocol: selected.executionProfile!.protocol!, variables });
      expect(built.renderedBody).toMatchObject(id.startsWith('doubao-')
        ? { metadata: { ratio: aspectRatio } }
        : id.endsWith('-A') || id === 'sd-2.5-c1'
          ? { output: { aspect_ratio: aspectRatio } }
          : { aspect_ratio: aspectRatio });
    }
  });

  it.each(LEGACY_SINGLE_RATIO_VIDEO_IDS)('%s 的完整旧单比例快照仅临时补齐宽高比', (id) => {
    const selected = model(id);
    for (const defaultRatio of [undefined, '16:9']) {
      const saved: VideoModelCapability = { ...structuredClone(selected.videoCapability), ratios: ['16:9'], defaultRatio };
      const before = structuredClone(saved);
      expect(resolveRelayonVideoCapability(id, selected.executionProfile, saved))
        .toEqual({ ...before, ratios: SEEDANCE_RATIOS });
      expect(saved).toEqual(before);
    }
  });

  it.each(SEEDANCE_VIDEO_IDS)('%s 未声明比例限制时补齐当前画幅', (id) => {
    const selected = model(id);
    const saved = structuredClone(selected.videoCapability!);
    delete saved.ratios;
    const before = structuredClone(saved);
    expect(resolveRelayonVideoCapability(id, selected.executionProfile, saved))
      .toEqual({ ...before, ratios: SEEDANCE_RATIOS });
    expect(saved).toEqual(before);
  });

  it.each(['sd-2.0-c1', 'sd-2.0-c2', 'sd-2.0-c3'])('%s 已保存的单项比例属于显式限制', (id) => {
    const selected = model(id);
    const explicit = { ...selected.videoCapability, ratios: ['16:9'] };
    expect(resolveRelayonVideoCapability(id, selected.executionProfile, explicit)).toBe(explicit);
  });

  it('缺失能力时返回独立的当前合同，不修改原始快照', () => {
    const id = 'sd-2.5-c1';
    const selected = model(id);
    const manifestBefore = structuredClone(RELAYON_MODEL_MANIFEST);
    const restored = resolveRelayonVideoCapability(id, selected.executionProfile)!;
    expect(restored).toEqual(selected.videoCapability);
    restored.ratios!.push('2:1');
    expect(resolveRelayonVideoCapability(id, selected.executionProfile)?.ratios).toEqual(SEEDANCE_RATIOS);

    const saved: VideoModelCapability = { ...structuredClone(selected.videoCapability), ratios: ['16:9'] };
    const before = structuredClone(saved);
    const effective = resolveRelayonVideoCapability(id, selected.executionProfile, saved)!;
    expect(effective).toEqual({ ...before, ratios: SEEDANCE_RATIOS });
    effective.ratios!.push('2:1');
    expect(saved).toEqual(before);
    expect(RELAYON_MODEL_MANIFEST).toEqual(manifestBefore);
  });

  it('完整内置协议也不能把已改时长、输入模式或不完整能力当成旧默认快照', () => {
    const selected = model('sd-2.5-c1');
    const legacy = { ...selected.videoCapability, ratios: ['16:9'] };
    const explicitCapabilities: VideoModelCapability[] = [
      { ...legacy, maxDuration: 29 },
      { ...legacy, inputModeCapabilities: { keyframe: { ratios: ['16:9'], defaultRatio: '16:9' } } },
      { ...legacy, operationCapabilities: { 'video-to-video': { ratios: ['16:9'], defaultRatio: '16:9' } } },
      { ratios: ['16:9'], defaultRatio: '16:9' },
    ];
    for (const explicit of explicitCapabilities) {
      const before = structuredClone(explicit);
      expect(resolveRelayonVideoCapability(selected.id, selected.executionProfile, explicit)).toBe(explicit);
      expect(explicit).toEqual(before);
    }
  });

  it('保留显式比例子集、非内置协议与非 Seedance 型号', () => {
    const selected = model('sd-2.0-A');
    for (const ratios of [['1:1'], ['16:9', '9:16']]) {
      const explicit = { ...selected.videoCapability, ratios, defaultRatio: ratios[0] };
      expect(resolveRelayonVideoCapability(selected.id, selected.executionProfile, explicit)).toBe(explicit);
    }
    const changedDefault = { ...selected.videoCapability, ratios: ['16:9'], defaultRatio: 'adaptive' };
    expect(resolveRelayonVideoCapability(selected.id, selected.executionProfile, changedDefault)).toBe(changedDefault);

    const saved = { ...selected.videoCapability, ratios: ['16:9'] };
    const customProfile = structuredClone(selected.executionProfile!);
    customProfile.protocol!.submit.path = '/custom/videos';
    expect(resolveRelayonVideoCapability(selected.id, customProfile, saved)).toBe(saved);
    expect(resolveRelayonVideoCapability(selected.id, undefined, saved)).toBe(saved);
    for (const id of ['minimax-h3', 'image-2-01', 'SD-2.0-A', 'unknown']) {
      expect(resolveRelayonVideoCapability(id, model('minimax-h3').executionProfile, saved)).toBe(saved);
    }
    expect(resolveRelayonVideoCapability('minimax-h3', model('minimax-h3').executionProfile)).toBeUndefined();
  });
});

describe('RelayOnAPI 已确认的媒体合同', () => {
  it('声明十五个图片、十一个视频，仅普通 Flare／Sunburst 开放本批确认的质量／背景候选', () => {
    expect(RELAYON_IMAGE_MODEL_IDS).toHaveLength(15);
    expect(RELAYON_VIDEO_MODEL_IDS).toHaveLength(11);
    expect(RELAYON_MODEL_MANIFEST).toHaveLength(30);
    expect(RELAYON_MODEL_MANIFEST.filter((item) => item.category === 'image').map((item) => item.id))
      .toEqual(RELAYON_IMAGE_MODEL_IDS);
    expect(RELAYON_MODEL_MANIFEST.filter((item) => item.category === 'video').map((item) => item.id))
      .toEqual(RELAYON_VIDEO_MODEL_IDS);
    expect(matchRelayonCatalog([remote('mj-v7'), remote('seedream-5.0-pro'), remote('Seedream 5.0 Pro')])
      .map((item) => [item.id, item.category])).toEqual([['Seedream 5.0 Pro', 'image']]);
    for (const id of RELAYON_IMAGE_MODEL_IDS) {
      if (id === 'Image-2.5-Flare' || id === 'Image-2.5-Sunburst') {
        expect(model(id).imageCapability).toMatchObject({ qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
          backgrounds: ['auto', 'opaque', 'transparent'] });
      } else {
        expect(model(id).imageCapability).not.toHaveProperty('qualities');
        expect(model(id).imageCapability).not.toHaveProperty('backgrounds');
      }
      expect(model(id).imageCapability).not.toHaveProperty('defaultQuality');
      expect(model(id).imageCapability).not.toHaveProperty('defaultBackground');
      expect(model(id).imageCapability!.maxImageReferences).toBe(RELAYON_MIDJOURNEY_MODEL_IDS.some((mj) => mj === id) ? 1 : RELAYON_IMAGE_REFERENCE_LIMIT);
    }
    expect(RELAYON_IMAGE_REFERENCE_LIMIT).toBe(6);
  });

  it.each(RELAYON_MIDJOURNEY_MODEL_IDS)('%s 按单作业四候选声明精确参数，不添加未公布的质量和背景', (id) => {
    const item = model(id);
    const extended = id === 'Midjourney v8.1' || id === 'Midjourney v8.2';
    expect(item.imageCapability).toMatchObject({ resolutions: extended ? ['1K', '2K'] : ['1K'],
      supportsBatch: false, maxBatchCount: 1, maxImageReferences: 1 });
    expect(item.imageCapability!.ratios).toHaveLength(10);
    expect(item.imageCapability).not.toHaveProperty('qualities');
    expect(item.imageCapability).not.toHaveProperty('backgrounds');
    expect(getRelayonImageOutputsPerJob(id, item.executionProfile)).toBe(4);
    const original = structuredClone(item.executionProfile!);
    const edited = resolveRelayonImageExecutionProfile(id, item.executionProfile, 1)!;
    const variables = relayonImageVariables(id, { model: id, prompt: 'test', imageSize: extended ? '2K' : '1K',
      aspectRatio: extended ? '4:5' : '16:9', imageUrls: ['https://cdn.example/reference.png'], n: 1 });
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol: edited.protocol!, variables });
    expect(built.url).toBe(`${RELAYON_BASE_URL}/images/edits`);
    expect(built.renderedBody).toMatchObject({ model: id, n: 1, resolution: extended ? '2k' : '1k',
      size: extended ? '1632x2040' : '1536x864', image: ['https://cdn.example/reference.png'] });
    expect(item.executionProfile).toEqual(original);
    const protocol = item.executionProfile?.protocol;
    assert(protocol?.version === 2);
    expect(protocol.response.result).toEqual({ urlPath: 'data.*.url', base64Path: 'data.*.b64_json', mimeType: 'image/png' });
    expect(() => relayonImageVariables(id, { imageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] })).toThrow('最多接受 1 张');
    expect(() => relayonImageVariables(id, { n: 4 })).toThrow('仅提交一个结果');
    if (!extended) expect(() => relayonImageVariables(id, { imageSize: '2K' })).toThrow('没有已公布的像素尺寸');
  });

  it('MJ 的四候选规则不继承到同名前缀或用户修改过的协议', () => {
    const profile = structuredClone(model('Midjourney v8.2').executionProfile!);
    profile.protocol!.submit.path = '/my/images';
    expect(getRelayonImageOutputsPerJob('Midjourney v8.2', profile)).toBe(1);
    expect(getRelayonImageOutputsPerJob('Midjourney v8.2-extra', profile)).toBe(1);
    expect(getRelayonImageOutputsPerJob('Midjourney v8.2', undefined)).toBe(1);
    const urlOnly = structuredClone(model('Midjourney v8.2').executionProfile!);
    assert(urlOnly.protocol?.version === 2);
    delete urlOnly.protocol.response.result!.base64Path;
    delete urlOnly.protocol.response.result!.mimeType;
    expect(usesRelayonModelProtocol('Midjourney v8.2', urlOnly)).toBe(false);
    expect(getRelayonImageOutputsPerJob('Midjourney v8.2', urlOnly)).toBe(1);
    expect(resolveRelayonImageModelContract('Midjourney v8.2', urlOnly).executionProfile).toBe(urlOnly);
  });

  it('2.6 01 仅按确认复用 2.5 01 请求与尺寸，不继承普通 2.5 的质量或背景', () => {
    const current = model('image-2.6-01');
    const previous = model('image-2.5-flare-01');
    expect(current.imageCapability).toEqual(previous.imageCapability);
    expect(current.executionProfile).toEqual(previous.executionProfile);
    expect(getRelayonImageOutputsPerJob(current.id, current.executionProfile)).toBe(1);
    const variables = relayonImageVariables(current.id, { model: current.id, imageSize: '4K', aspectRatio: '5:4' });
    expect(variables).toMatchObject({ model: 'image-2.6-01', imageSize: '4K', size: '2880x2304' });
    expect(current.imageCapability).not.toHaveProperty('qualities');
    expect(current.imageCapability).not.toHaveProperty('backgrounds');
  });

  it('全部能力与协议满足当前校验，视频保持同源查询，仅 H3 使用已公布的 content 下载', () => {
    for (const item of RELAYON_MODEL_MANIFEST) {
      expect(() => assertModelCapabilityProtocol(item), item.id).not.toThrow();
      if (item.videoCapability) expect(() => assertVideoModelCapability(item.videoCapability!), item.id).not.toThrow();
      const protocol = item.executionProfile?.protocol;
      if (protocol) expect(validateModelExecutionProtocol(protocol), item.id).toEqual([]);
      if (item.category === 'video') {
        expect(protocol).toMatchObject({ mode: 'async', response: { taskIdPath: 'id' },
          poll: { path: '/videos/{{submit.id}}', intervalMs: 10_000, maxDurationMs: 7_200_000,
            response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'] } } });
        assert(protocol?.version === 2, item.id);
        if (item.id === 'minimax-h3') {
          expect(protocol.poll!.response.result).toEqual({ mimeType: 'video/mp4', download: { method: 'GET', path: '/videos/{{submit.id}}/content' } });
        } else expect(protocol.poll!.response.result).toEqual({ urlPath: 'url', mimeType: 'video/mp4' });
      }
    }
    expect(RELAYON_VIDEO_RESULT_URL_PATHS).toEqual(['url', 'video_url', 'content.video_url']);
  });

  it.each([
    ['image-2-01', '1K', '4:3', '1152x864'],
    ['image-2-01', '2K', '3:2', '2016x1344'],
    ['image-2-01', '4K', '21:9', '3808x1632'],
    ['image-2-01', '4K', '9:21', '1632x3808'],
    ['Image-2.5-Flare', '2K', '4:5', '1600x2048'],
    ['image-2.5-sunburst-01', '4K', '5:4', '2880x2304'],
    ['nano-banana-2', '2K', '16:9', '2560x1440'],
    ['nano-banana-2.1', '4K', '3:2', '4992x3328'],
    ['nano-banana-pro', '4K', '9:16', '2880x5120'],
    ['Seedream 5.0 Pro', '1K', '16:9', '1536x864'],
    ['Seedream 5.0 Pro', '2K', '3:2', '2016x1344'],
  ])('%s 的 %s / %s 严格使用公布像素 %s', (id, resolution, ratio, size) => {
    const variables = relayonImageVariables(id, { model: id, prompt: 'test', imageSize: resolution, aspectRatio: ratio, n: 1 });
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
      protocol: model(id).executionProfile!.protocol!, variables });
    expect(built.renderedBody).toMatchObject({ resolution, aspect_ratio: ratio, size, n: 1, response_format: 'url' });
    expect(built.renderedBody).not.toHaveProperty('image');
  });

  it('文生与图编辑按真实参考数量切换临时路径，保留原协议并省略空参考数组', () => {
    const id = 'image-2-01';
    const profile = model(id).executionProfile!;
    const original = structuredClone(profile);
    const inline = 'data:image/png;base64,YQ==';
    const edit = resolveRelayonImageExecutionProfile(id, profile, 1)!;
    const variables = relayonImageVariables(id, { model: id, prompt: 'edit', imageSize: '2K', aspectRatio: '16:9',
      size: '2048x1152', imageUrls: [inline] });
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol: edit.protocol!, variables });
    expect(built.url).toBe('https://relayonapi.com/v1/images/edits');
    expect(built.renderedBody).toMatchObject({ image: [inline], size: '2048x1152', n: 1 });
    expect(resolveRelayonImageExecutionProfile(id, profile, 0)!.protocol!.submit.path).toBe('/images/generations');
    expect(relayonImageVariables(id, { imageUrls: [] }).imageUrls).toBeUndefined();
    expect(profile).toEqual(original);
  });

  it('参考数量、图片格式、生成数量和未映射尺寸错误在提交前失败', () => {
    expect(() => relayonImageVariables('image-2-01', { n: 2 })).toThrow('仅提交一个结果');
    expect(() => relayonImageVariables('image-2-01', { imageUrls: Array(7).fill('https://cdn.example/a.png') })).toThrow('最多接受 6 张');
    expect(() => resolveRelayonImageExecutionProfile('image-2-01', model('image-2-01').executionProfile, 7)).toThrow('最多接受 6 张');
    expect(relayonImageVariables('Image-2.5-Flare', { imageUrls: Array(6).fill('https://cdn.example/a.png') }).imageUrls).toHaveLength(6);
    expect(() => relayonImageVariables('nano-banana-2', { imageUrls: ['data:image/gif;base64,YQ=='] })).toThrow('PNG、JPEG、WebP');
    expect(() => relayonImageVariables('Seedream 5.0 Pro', { imageSize: '1K', aspectRatio: '2:3' })).toThrow('没有已公布的像素尺寸');
    expect(() => relayonImageVariables('image-2-01', { imageSize: '2K', aspectRatio: '16:9', size: '1024x1024' })).toThrow('不一致');
    expect(model('image-2-01').imageCapability!.ratios).toHaveLength(9);
    expect(model('Image-2.5-Flare').imageCapability!.ratios).toHaveLength(10);
    expect(model('Seedream 5.0 Pro').imageCapability!.ratios).toHaveLength(6);
  });

  it('只转换完整内置协议，保留用户编辑的提交路径及合同', () => {
    const id = 'image-2-01';
    expect(usesRelayonModelProtocol(id, structuredClone(model(id).executionProfile))).toBe(true);
    expect(usesRelayonModelProtocol('gpt-6.1-sol', model('gpt-6.1-sol').executionProfile)).toBe(false);
    expect(usesRelayonModelProtocol(id, undefined)).toBe(false);
    const custom: ModelExecutionProfile = structuredClone(model(id).executionProfile!);
    custom.protocol!.submit.path = '/user/images';
    expect(usesRelayonModelProtocol(id, custom)).toBe(false);
    expect(resolveRelayonImageExecutionProfile(id, custom, 1)).toBe(custom);
    expect(custom.protocol!.submit.path).toBe('/user/images');
  });

  it('四个官方型号仅提供已核实文生字段，分别保留时长和分辨率范围', () => {
    const expected = [
      ['doubao-seedance-2-0-260128', 15, ['480p', '720p', '1080p', '4k']],
      ['doubao-seedance-2-0-fast-260128', 15, ['480p', '720p']],
      ['doubao-seedance-2-0-mini-260615', 15, ['480p', '720p']],
      ['doubao-seedance-2-5-260628', 30, ['480p', '720p', '1080p']],
    ] as const;
    for (const [id, maxDuration, resolutions] of expected) {
      expect(model(id).videoCapability).toMatchObject({ minDuration: 4, maxDuration, resolutions,
        operations: ['text-to-video'], maxImageReferences: 0, maxVideoReferences: 0, maxAudioReferences: 0 });
      const variables = relayonVideoVariables(id, { model: id, prompt: 'test', durationText: '5', resolution: '720p', aspectRatio: '16:9', generateAudio: false });
      const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol: model(id).executionProfile!.protocol!, variables });
      expect(built.renderedBody).toEqual({ model: id, prompt: 'test', seconds: '5',
        metadata: { resolution: '720p', ratio: '16:9', generate_audio: false } });
      expect(() => relayonVideoVariables(id, { referenceImageUrls: ['https://cdn.example/i.png'] })).toThrow('最多接受 0 个参考图');
    }
  });

  it('A 渠道 references 按图片／视频／音频原序展开，只有图片声明 reference 角色', () => {
    for (const id of ['sd-2.0-A', 'sd-2.5-A']) {
      const variables = relayonVideoVariables(id, { model: id, prompt: '图片1配合视频1和音频1', durationText: '6',
        resolution: '720p', aspectRatio: '16:9', generateAudio: true,
        referenceImageUrls: ['https://cdn.example/i1.png', 'https://cdn.example/i2.png'],
        referenceVideoUrls: ['https://cdn.example/v.mp4'], referenceAudioUrls: ['https://cdn.example/a.mp3'] });
      const protocol = model(id).executionProfile!.protocol!;
      const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol, variables });
      expect(built.renderedBody).toMatchObject({ seconds: '6', output: { resolution: '720p', aspect_ratio: '16:9' }, generate_audio: true,
        references: [
          { type: 'image', url: 'https://cdn.example/i1.png', role: 'reference' },
          { type: 'image', url: 'https://cdn.example/i2.png', role: 'reference' },
          { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' },
        ] });
      expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
    }
  });

  it('C1 使用顶层数值时长、精确素材上限，并只转换存在的提示词编号', () => {
    const id = 'sd-2.0-c1';
    const variables = relayonVideoVariables(id, { model: id, prompt: '图片1和图片2参考视频1与@音频1，图片3无对应素材',
      duration: 10, resolution: '720p', aspectRatio: '9:16',
      referenceImageUrls: ['https://cdn.example/i1.png', 'https://cdn.example/i2.png'],
      referenceVideoUrls: ['https://cdn.example/v.mp4'], referenceAudioUrls: ['https://cdn.example/a.mp3'] });
    const protocol = model(id).executionProfile!.protocol!;
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol, variables });
    expect(built.renderedBody).toMatchObject({ prompt: '@图1和@图2参考@视频1与@音频1，图片3无对应素材',
      duration: 10, resolution: '720p', aspect_ratio: '9:16' });
    expect(built.renderedBody).not.toHaveProperty('metadata');
    expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
    expect(model(id).videoCapability).toMatchObject({ minDuration: 10, maxDuration: 15, maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3 });
    expect(model('sd-2.0-c2').videoCapability).toMatchObject({ minDuration: 4, maxDuration: 15, maxVideoReferences: 0 });
    expect(() => relayonVideoVariables('sd-2.0-c2', { referenceVideoUrls: ['https://cdn.example/v.mp4'] })).toThrow('最多接受 0 个参考视频');
    expect(() => relayonVideoVariables(id, { referenceAudioUrls: Array(4).fill('https://cdn.example/a.mp3') })).toThrow('最多接受 3 个参考音频');
  });

  it('C2 按官方说明保留图片和音频编号，不改写用户原文或素材顺序', () => {
    const id = 'sd-2.0-c2';
    const prompt = '图片1和图片2配合音频1，图片3是普通文字，@图1也保持原文';
    const variables = relayonVideoVariables(id, { model: id, prompt, duration: 5, resolution: '720p', aspectRatio: '9:16',
      referenceImageUrls: ['https://cdn.example/i1.png', 'https://cdn.example/i2.png'],
      referenceAudioUrls: ['https://cdn.example/a.mp3'] });
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
      protocol: model(id).executionProfile!.protocol!, variables });
    expect(built.renderedBody).toMatchObject({ prompt, references: [
      { type: 'image', url: 'https://cdn.example/i1.png' }, { type: 'image', url: 'https://cdn.example/i2.png' },
      { type: 'audio', url: 'https://cdn.example/a.mp3' },
    ] });
    expect(variables.prompt).toBe(prompt);
  });

  it('H3 使用 C1 请求格式与小写档位，保留顺序且不将 720p、1K 改写为像素预设', () => {
    const id = 'minimax-h3';
    expect(model(id).videoCapability).toMatchObject({ resolutions: ['480p', '720p', '1K', '2K'],
      minDuration: 4, maxDuration: 15, ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
      maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3 });
    const variables = relayonVideoVariables(id, { model: id, duration: 15, resolution: '1K', aspectRatio: '9:16',
      prompt: '图片2和@图1参考视频1与音频1', referenceImageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      referenceVideoUrls: ['https://cdn.example/v.mp4'], referenceAudioUrls: ['https://cdn.example/a.mp3'] });
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol: model(id).executionProfile!.protocol!, variables });
    expect(built.renderedBody).toEqual({ model: id, duration: 15, resolution: '1k', aspect_ratio: '9:16',
      prompt: '@图2和@图1参考@视频1与@音频1', references: [
        { type: 'image', url: 'https://cdn.example/a.png' }, { type: 'image', url: 'https://cdn.example/b.png' },
        { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' },
      ] });
    expect(relayonVideoVariables(id, { resolution: '720p' }).resolution).toBe('720p');
    expect(findUnusedReferenceVariables(JSON.stringify(model(id).executionProfile!.protocol), variables)).toEqual([]);
  });

  it('H3 合计 12 份通过，13 份拒绝；每张提供的图片都必须能在提示词找到编号', () => {
    const input = { prompt: Array.from({ length: 9 }, (_, index) => `图片${index + 1}`).join('、'),
      referenceImageUrls: Array.from({ length: 9 }, (_, index) => `https://cdn.example/${index}.png`),
      referenceVideoUrls: ['https://cdn.example/one.mp4', 'https://cdn.example/two.mp4'],
      referenceAudioUrls: ['https://cdn.example/a.mp3'] };
    expect(() => relayonVideoVariables('minimax-h3', input)).not.toThrow();
    expect(() => relayonVideoVariables('minimax-h3', { ...input,
      referenceVideoUrls: [...input.referenceVideoUrls, 'https://cdn.example/three.mp4'] })).toThrow('合计最多 12 份');
    expect(() => relayonVideoVariables('minimax-h3', { ...input, prompt: '图片1自然微笑' })).toThrow('参考图 2');
  });

  it('C3 无音频允许普通时长和五种比例，带音频仅允许指定时长与三种比例', () => {
    expect(model('sd-2.0-c3').videoCapability).toMatchObject({ minDuration: 4, maxDuration: 15,
      resolutions: ['720p'], maxImageReferences: 9, maxVideoReferences: 0, maxAudioReferences: 3 });
    const input = { model: 'sd-2.0-c3', duration: 7, resolution: '720p', aspectRatio: '4:3',
      prompt: '图片1按音频1说话', referenceImageUrls: ['https://cdn.example/one.png'] };
    expect(() => relayonVideoVariables('sd-2.0-c3', input)).not.toThrow();
    const withAudio = { ...input, referenceAudioUrls: ['https://cdn.example/one.mp3'] };
    expect(() => relayonVideoVariables('sd-2.0-c3', withAudio)).toThrow('5、10 或 15 秒');
    expect(() => relayonVideoVariables('sd-2.0-c3', { ...withAudio, duration: 10 })).toThrow('16:9、9:16 或 1:1');
    for (const duration of [5, 10, 15]) {
      for (const aspectRatio of ['16:9', '9:16', '1:1']) {
        const variables = relayonVideoVariables('sd-2.0-c3', { ...withAudio, duration, aspectRatio });
        const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
          protocol: model('sd-2.0-c3').executionProfile!.protocol!, variables });
        expect(built.renderedBody).toMatchObject({ duration, aspect_ratio: aspectRatio, prompt: '@图1按@音频1说话' });
      }
    }
    expect(() => relayonVideoVariables('sd-2.0-c3', { ...input, referenceVideoUrls: ['https://cdn.example/v.mp4'] })).toThrow('最多接受 0 个参考视频');
  });

  it('2.5 C1 按用户确认复用 2.5 兼容映射，规格与参考上限仍按本型号声明', () => {
    const id = 'sd-2.5-c1';
    expect(model(id).videoCapability).toMatchObject({ minDuration: 4, maxDuration: 30, resolutions: ['720p'],
      maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10 });
    expect(model(id).inputModalities).toEqual(['text', 'image']);
    const variables = relayonVideoVariables(id, { model: id, prompt: '图片1和视频1、音频1', durationText: '30',
      resolution: '720p', aspectRatio: '16:9', generateAudio: true, referenceImageUrls: ['https://cdn.example/i.png'],
      referenceVideoUrls: ['https://cdn.example/v.mp4'], referenceAudioUrls: ['https://cdn.example/a.mp3'] });
    expect(buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
      protocol: model(id).executionProfile!.protocol!, variables }).renderedBody).toEqual({ model: id,
      prompt: '图片1和视频1、音频1', seconds: '30', output: { resolution: '720p', aspect_ratio: '16:9' }, generate_audio: true,
      references: [{ type: 'image', url: 'https://cdn.example/i.png', role: 'reference' },
        { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' }] });
    expect(() => relayonVideoVariables(id, { referenceImageUrls: Array(31).fill('https://cdn.example/i.png') })).toThrow('最多接受 30 个参考图');
  });

  it('JSON 合同不接未公开的首尾帧，不把它们降级成普通参考', () => {
    for (const id of ['sd-2.0-A', 'sd-2.5-A', 'sd-2.0-c1', 'sd-2.0-c2']) {
      expect(() => relayonVideoVariables(id, { firstImage: 'https://cdn.example/i.png' })).toThrow('未公布首尾帧字段');
      expect(() => relayonVideoVariables(id, { videoInputMode: 'mixed' })).toThrow('未公布首尾帧字段');
    }
  });

  it('首批不开放未确认的纯音频组合，仍接收图片搭配音频', () => {
    for (const id of ['sd-2.0-A', 'sd-2.5-A', 'sd-2.0-c1', 'sd-2.0-c2']) {
      expect(model(id).videoCapability!.supportsStandaloneAudio).toBe(false);
      expect(() => relayonVideoVariables(id, { referenceAudioUrls: ['https://cdn.example/a.mp3'] })).toThrow('当前应用接入尚未开放');
      expect(relayonVideoVariables(id, { referenceImageUrls: ['https://cdn.example/i.png'],
        referenceAudioUrls: ['https://cdn.example/a.mp3'] }).referenceAudioUrls).toEqual(['https://cdn.example/a.mp3']);
    }
  });
});

function previousImageProfile(id: string): ModelExecutionProfile {
  const previous = structuredClone(model(id).executionProfile!);
  const body = previous.protocol!.submit.body as Record<string, ProtocolJsonValue>;
  delete body.quality;
  delete body.background;
  return previous;
}

describe('RelayOnAPI 普通 Image 2.5 的参数兼容', () => {
  it.each(['image-2-01', 'Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst', 'image-2.5-sunburst-01'])('%s 完整旧 URL 模板兼容 Base64 返回，不修改已保存协议', (id) => {
    const oldProfile = structuredClone(model(id).executionProfile!);
    assert(oldProfile.protocol?.version === 2);
    delete oldProfile.protocol.response.result!.base64Path;
    delete oldProfile.protocol.response.result!.mimeType;
    const before = structuredClone(oldProfile);
    expect(usesRelayonModelProtocol(id, oldProfile)).toBe(true);
    const effective = resolveRelayonImageModelContract(id, oldProfile).executionProfile!;
    assert(effective.protocol?.version === 2);
    expect(effective.protocol.response.result)
      .toEqual({ urlPath: 'data.*.url', base64Path: 'data.*.b64_json', mimeType: 'image/png' });
    expect(oldProfile).toEqual(before);
    oldProfile.protocol.response.result!.urlPath = 'custom_image_url';
    expect(usesRelayonModelProtocol(id, oldProfile)).toBe(false);
    expect(resolveRelayonImageModelContract(id, oldProfile).executionProfile).toBe(oldProfile);
  });

  it('未核对 Base64 返回的 Nano 和 Seedream 不增加该映射', () => {
    for (const id of ['nano-banana-2', 'nano-banana-2.1', 'nano-banana-pro', 'Seedream 5.0 Pro']) {
      const profile = model(id).executionProfile!;
      assert(profile.protocol?.version === 2);
      expect(profile.protocol.response.result).toEqual({ urlPath: 'data.*.url' });
    }
  });

  it.each(['Image-2.5-Flare', 'Image-2.5-Sunburst'])('%s 完整旧模板临时补齐质量和背景，保留既有尺寸设置', (id) => {
    const previous = previousImageProfile(id);
    const saved: ImageModelCapability = { ...structuredClone(model(id).imageCapability!),
      resolutions: ['2K'], defaultResolution: '2K', ratios: ['9:16'], defaultRatio: '9:16' };
    delete saved.qualities;
    delete saved.backgrounds;
    const before = structuredClone({ previous, saved });
    const effective = resolveRelayonImageModelContract(id, previous, saved);
    expect(usesRelayonModelProtocol(id, previous)).toBe(true);
    expect(effective.executionProfile).toEqual(model(id).executionProfile);
    expect(effective.imageCapability).toMatchObject({ resolutions: ['2K'], defaultResolution: '2K',
      ratios: ['9:16'], defaultRatio: '9:16', dimensionPresets: saved.dimensionPresets,
      qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], backgrounds: ['auto', 'opaque', 'transparent'] });
    expect({ previous, saved }).toEqual(before);
    expect(effective.executionProfile).not.toBe(previous);
    expect(effective.imageCapability).not.toBe(saved);
  });

  it('用户显式收窄的候选和默认值保持原值，不扩成内置候选', () => {
    const id = 'Image-2.5-Flare';
    const saved: ImageModelCapability = { ...structuredClone(model(id).imageCapability!),
      qualities: ['low', 'high'], defaultQuality: 'high', backgrounds: ['transparent'], defaultBackground: 'transparent',
      ratios: ['9:16'], defaultRatio: '9:16' };
    const before = structuredClone(saved);
    const effective = resolveRelayonImageModelContract(id, previousImageProfile(id), saved);
    expect(effective.imageCapability).toEqual(saved);
    effective.imageCapability!.qualities!.push('medium');
    expect(saved).toEqual(before);
    expect(model(id).imageCapability!.qualities).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('修改过的路径、响应或部分参数映射不当成完整旧内置模板', () => {
    const id = 'Image-2.5-Sunburst';
    const capability = { qualities: ['custom-quality'], defaultQuality: 'custom-quality' };
    for (const change of ['path', 'response', 'quality-only'] as const) {
      const custom = previousImageProfile(id);
      assert(custom.protocol?.version === 2);
      if (change === 'path') custom.protocol!.submit.path = '/user/images';
      else if (change === 'response') custom.protocol!.response.result!.urlPath = 'custom_result';
      else (custom.protocol!.submit.body as Record<string, ProtocolJsonValue>).quality = '{{imageQuality}}';
      const before = structuredClone(custom);
      expect(usesRelayonModelProtocol(id, custom)).toBe(false);
      const effective = resolveRelayonImageModelContract(id, custom, capability);
      expect(effective.executionProfile).toBe(custom);
      expect(effective.imageCapability).toBe(capability);
      expect(resolveRelayonImageExecutionProfile(id, custom, 1, 'transparent')).toBe(custom);
      expect(custom).toEqual(before);
    }
    expect(resolveRelayonImageModelContract(id, undefined, capability)).toEqual({ executionProfile: undefined, imageCapability: capability });
  });

  it.each(['Image-2.5-Flare', 'Image-2.5-Sunburst'])('%s 未选择质量／背景时均省略，不主动指定输出格式', (id) => {
    const profile = resolveRelayonImageExecutionProfile(id, previousImageProfile(id), 0)!;
    const variables = relayonImageVariables(id, { model: id, prompt: 'test', imageSize: '2K', aspectRatio: '9:16', n: 1 });
    const built = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: RELAYON_BASE_URL, protocol: profile.protocol!, variables });
    expect(built.renderedBody).toMatchObject({ resolution: '2K', aspect_ratio: '9:16', size: '1152x2048' });
    for (const key of ['quality', 'background', 'output_format']) expect(built.renderedBody).not.toHaveProperty(key);
  });

  it.each(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])('质量 %s 独立传入，不改变比例、分辨率或像素', (quality) => {
    const id = 'Image-2.5-Flare';
    const variables = relayonImageVariables(id, { model: id, prompt: 'test', imageSize: '2K', aspectRatio: '9:16', imageQuality: quality });
    const built = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: RELAYON_BASE_URL,
      protocol: resolveRelayonImageExecutionProfile(id, previousImageProfile(id), 0)!.protocol!, variables });
    expect(built.renderedBody).toMatchObject({ quality, resolution: '2K', aspect_ratio: '9:16', size: '1152x2048' });
    expect(built.renderedBody).not.toHaveProperty('background');
    expect(built.renderedBody).not.toHaveProperty('output_format');
  });

  it.each(['Image-2.5-Flare', 'Image-2.5-Sunburst'])('%s 仅透明背景临时要求 PNG，生成与编辑均保持原配置', (id) => {
    const previous = previousImageProfile(id);
    const before = structuredClone(previous);
    for (const referenceCount of [0, 1]) {
      for (const background of [undefined, 'auto', 'opaque', 'transparent']) {
        const profile = resolveRelayonImageExecutionProfile(id, previous, referenceCount, background)!;
        const variables = relayonImageVariables(id, { model: id, prompt: 'test', imageSize: '2K', aspectRatio: '9:16',
          imageQuality: 'high', imageBackground: background, imageUrls: referenceCount ? ['data:image/png;base64,YQ=='] : [] });
        const built = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: RELAYON_BASE_URL, protocol: profile.protocol!, variables });
        expect(built.url).toBe(`${RELAYON_BASE_URL}/images/${referenceCount ? 'edits' : 'generations'}`);
        expect(built.renderedBody).toMatchObject({ quality: 'high', resolution: '2K', aspect_ratio: '9:16', size: '1152x2048' });
        if (background === undefined) expect(built.renderedBody).not.toHaveProperty('background');
        else expect(built.renderedBody).toMatchObject({ background });
        if (background === 'transparent') expect(built.renderedBody).toMatchObject({ output_format: 'png' });
        else expect(built.renderedBody).not.toHaveProperty('output_format');
      }
    }
    expect(previous).toEqual(before);
    expect(model(id).executionProfile!.protocol!.submit.body).not.toHaveProperty('output_format');
  });

  it('不为其他型号追加质量、背景或透明输出格式', () => {
    for (const id of ['image-2-01', 'image-2.5-flare-01', 'image-2.5-sunburst-01', 'nano-banana-2', 'Seedream 5.0 Pro']) {
      const effective = resolveRelayonImageModelContract(id, model(id).executionProfile, model(id).imageCapability);
      expect(effective.imageCapability).not.toHaveProperty('qualities');
      expect(effective.imageCapability).not.toHaveProperty('backgrounds');
      const profile = resolveRelayonImageExecutionProfile(id, model(id).executionProfile, 0, 'transparent')!;
      expect(profile.protocol!.submit.body).not.toHaveProperty('quality');
      expect(profile.protocol!.submit.body).not.toHaveProperty('background');
      expect(profile.protocol!.submit.body).not.toHaveProperty('output_format');
    }
  });
});
