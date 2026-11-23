/**
 * relayonModelManifest — 回归测试：RelayOnAPI 已核对文本目录。
 */
import { assert, describe, expect, it } from 'vitest';
import type { ProviderModelSelection } from '../../src/types';
import {
  RELAYON_BASE_URL,
  RELAYON_IMAGE_BASE_URL,
  RELAYON_VIDEO_BASE_URL,
  RELAYON_IMAGE_MODEL_IDS,
  RELAYON_IMAGE_26_VARIANT_MODEL_IDS,
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
  resolveRelayonVideoExecutionProfile,
  getRelayonVideoFileKinds,
  getRelayonVideoRecoveryProfiles,
  usesRelayonModelProtocol,
  usesRelayonImageFileUpload,
  getRelayonImageOutputsPerJob,
} from '../../src/services/ai/providers/relayonModelManifest';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { buildModelProtocolRequest, previewModelProtocolRequest, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import { assertVideoModelCapability } from '../../src/services/ai/videoRequestResolver';
import { findUnusedReferenceVariables } from '../../src/services/ai/modelProtocolRuntime';
import { getImageSizePresets } from '../../src/services/ai/modelSizeProfiles';
import type { ImageModelCapability, ModelExecutionProfile, ProtocolJsonValue, VideoModelCapability } from '../../src/types/aiTypes';

function remote(id: string): ProviderModelSelection {
  return { id, name: id, provider: 'relayon-personal', category: 'text' };
}

describe('RelayOnAPI 已核对文本目录', () => {
  it('只预置四个已确认型号，使用通用对话协议，不推断视觉和上下文能力', () => {
    expect(RELAYON_BASE_URL).toBe('https://relayonapi.com/v1');
    expect(RELAYON_VIDEO_BASE_URL).toBe('https://api.relayonapi.com/v1');
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

function legacyImage26Capability(): ImageModelCapability {
  const pixels = getImageSizePresets('relayon-image-2.5');
  return { ...structuredClone(model('image-2.6-01').imageCapability!),
    resolutions: Object.keys(pixels), ratios: Object.keys(pixels['1K']), dimensionPresets: pixels };
}

const SEEDANCE_VIDEO_IDS = RELAYON_VIDEO_MODEL_IDS.filter((id) => id !== 'minimax-h3');
const LEGACY_SINGLE_RATIO_VIDEO_IDS = [
  'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-5-260628',
  'sd-2.0-A', 'sd-2.5-A', 'sd-2.5-c1',
];
const SEEDANCE_RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1'];
const SD_COMMON_RATIOS = ['16:9', '9:16', '1:1'];
const SD_25_C_IDS = ['sd-2.5-c1', 'sd-2.5-c2', 'sd-2.5-c3'];
const SD_VIDEO_IDS = ['sd-2.0-A', 'sd-2.5-A', 'sd-2.0-c1', 'sd-2.0-c2', 'sd-2.0-c3', 'sd-2.5-c1'];

/** 2026-11-10 修订前实际发布的合同，保留旧时长、音频与 output 层级。 */
function previousVideoCapability(id: string): VideoModelCapability {
  const saved = structuredClone(model(id).videoCapability!);
  if (id === 'minimax-h3') {
    delete saved.durations;
    saved.minDuration = 4;
    saved.maxDuration = 15;
    saved.defaultDuration = 4;
  }
  if (['sd-2.0-c1', 'sd-2.0-c2', 'sd-2.0-c3', 'sd-2.5-c1'].includes(id)) saved.ratios = [...SEEDANCE_RATIOS];
  if (id === 'sd-2.0-c2' || id === 'sd-2.0-c3') {
    delete saved.durations;
    saved.minDuration = 4;
    saved.defaultDuration = 4;
  }
  if (id === 'sd-2.0-c1' || id === 'sd-2.5-c1') {
    delete saved.durations;
    saved.minDuration = id === 'sd-2.0-c1' ? 10 : 4;
    saved.defaultDuration = id === 'sd-2.0-c1' ? 10 : 4;
  }
  if (id === 'sd-2.0-c3') saved.maxAudioReferences = 3;
  if (id.endsWith('-A') || id === 'sd-2.5-c1') saved.supportsAudio = true;
  return saved;
}

function previousVideoProfile(id: string): ModelExecutionProfile {
  const saved = structuredClone(model(id).executionProfile!);
  if (!SD_VIDEO_IDS.includes(id)) return saved;
  const protocol = saved.protocol;
  assert(protocol?.version === 2);
  const body = protocol.submit.body as Record<string, ProtocolJsonValue>;
  if (id.endsWith('-A') || id === 'sd-2.5-c1') {
    delete body.resolution;
    delete body.aspect_ratio;
    body.output = { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}' };
    body.generate_audio = '{{generateAudio}}';
  }
  protocol.poll!.response.result = { urlPath: 'url', mimeType: 'video/mp4' };
  return saved;
}

describe('RelayOnAPI Seedance 宽高比', () => {
  it('完整旧 2.5 C1 快照更新当前渠道比例，不要求新增官方模式或自动时长', () => {
    const saved: VideoModelCapability = {
      defaultRatio: '16:9', defaultDuration: 4,
      operations: ['text-to-video', 'image-to-video', 'video-to-video'],
      minDuration: 4, maxDuration: 30, resolutions: ['720p'], defaultResolution: '720p',
      supportsAudio: true, supportsStandaloneAudio: false,
      maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10,
      ratios: ['16:9'],
    };
    const selected = model('sd-2.5-c1');
    const current: VideoModelCapability = { ...saved, ratios: [...SEEDANCE_RATIOS, '21:9'],
      durations: [30], minDuration: 30, maxDuration: 30, defaultDuration: 30 };
    delete current.supportsAudio;
    expect(selected.videoCapability).toEqual(current);
    expect(resolveRelayonVideoCapability(selected.id, selected.executionProfile, saved))
      .toEqual(current);
    expect(saved.ratios).toEqual(['16:9']);
  });

  it('共用型号基线仍保留渠道缺省字段，不引入未核对的帧率、模式或自动时长', () => {
    for (const id of RELAYON_VIDEO_MODEL_IDS) {
      const capability = model(id).videoCapability!;
      const keys = ['defaultRatio', 'defaultDuration', 'operations', 'minDuration', 'maxDuration',
        'resolutions', 'defaultResolution', 'ratios'];
      if (id.startsWith('doubao-')) keys.push('supportsAudio');
      if (id === 'minimax-h3' || /^sd-2\.[05]-c[123]$/.test(id)) keys.push('durations');
      if (!id.startsWith('doubao-')) keys.push('supportsStandaloneAudio');
      if (!id.endsWith('-A')) keys.push('maxImageReferences', 'maxVideoReferences', 'maxAudioReferences');
      expect(Object.keys(capability).sort(), id).toEqual(keys.sort());
    }
  });

  it.each(SEEDANCE_VIDEO_IDS)('%s 读取公共型号基线并应用当前渠道比例和请求层级', (id) => {
    const selected = model(id);
    const expectedRatios = ['sd-2.0-c1', 'sd-2.0-c2', 'sd-2.0-c3'].includes(id) ? SD_COMMON_RATIOS
      : SD_25_C_IDS.includes(id) ? [...SEEDANCE_RATIOS, '21:9'] : SEEDANCE_RATIOS;
    expect(selected.videoCapability?.ratios).toEqual(expectedRatios);
    expect(selected.videoCapability?.defaultRatio).toBe('16:9');
    for (const aspectRatio of expectedRatios) {
      const duration = selected.videoCapability!.defaultDuration!;
      const variables = relayonVideoVariables(id, { model: id, prompt: '比例回归', duration,
        durationText: String(duration), resolution: '720p', aspectRatio });
      const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
        protocol: selected.executionProfile!.protocol!, variables });
      expect(built.renderedBody).toMatchObject(id.startsWith('doubao-')
        ? { metadata: { ratio: aspectRatio } }
        : { aspect_ratio: aspectRatio });
      if (!id.startsWith('doubao-')) expect(built.renderedBody).not.toHaveProperty('output');
    }
  });

  it.each(LEGACY_SINGLE_RATIO_VIDEO_IDS)('%s 的完整旧单比例快照仅临时补齐宽高比', (id) => {
    const selected = model(id);
    for (const defaultRatio of [undefined, '16:9']) {
      const saved: VideoModelCapability = { ...structuredClone(selected.videoCapability), ratios: ['16:9'], defaultRatio };
      const before = structuredClone(saved);
      expect(resolveRelayonVideoCapability(id, selected.executionProfile, saved))
        .toEqual({ ...before, ratios: selected.videoCapability!.ratios });
      expect(saved).toEqual(before);
    }
  });

  it.each(SEEDANCE_VIDEO_IDS)('%s 未声明比例限制时补齐当前画幅', (id) => {
    const selected = model(id);
    const saved = structuredClone(selected.videoCapability!);
    delete saved.ratios;
    const before = structuredClone(saved);
    expect(resolveRelayonVideoCapability(id, selected.executionProfile, saved))
        .toEqual({ ...before, ratios: selected.videoCapability!.ratios });
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
    expect(resolveRelayonVideoCapability(id, selected.executionProfile)?.ratios).toEqual([...SEEDANCE_RATIOS, '21:9']);

    const saved: VideoModelCapability = { ...structuredClone(selected.videoCapability), ratios: ['16:9'] };
    const before = structuredClone(saved);
    const effective = resolveRelayonVideoCapability(id, selected.executionProfile, saved)!;
    expect(effective).toEqual({ ...before, ratios: [...SEEDANCE_RATIOS, '21:9'] });
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
    expect(resolveRelayonVideoCapability('minimax-h3', model('minimax-h3').executionProfile)).toEqual(model('minimax-h3').videoCapability);
  });

  it.each(RELAYON_VIDEO_MODEL_IDS.filter((id) => !['sd-2.5-c2', 'sd-2.5-c3'].includes(id)))('%s 仅投影完整旧协议和能力，不修改保存记录', (id) => {
    const profile = previousVideoProfile(id);
    const capability = previousVideoCapability(id);
    const before = structuredClone({ profile, capability });
    expect(usesRelayonModelProtocol(id, profile)).toBe(true);
    expect(resolveRelayonVideoExecutionProfile(id, profile)).toEqual(model(id).executionProfile);
    expect(resolveRelayonVideoCapability(id, profile, capability)).toEqual(model(id).videoCapability);
    expect({ profile, capability }).toEqual(before);
    const partial = { maxDuration: capability.maxDuration };
    expect(resolveRelayonVideoCapability(id, profile, partial)).toBe(partial);
    const custom = structuredClone(profile);
    custom.protocol!.submit.path = '/my/videos';
    expect(usesRelayonModelProtocol(id, custom)).toBe(false);
    expect(resolveRelayonVideoExecutionProfile(id, custom)).toBe(custom);
    expect(resolveRelayonVideoCapability(id, custom, capability)).toBe(capability);
  });

  it.each(LEGACY_SINGLE_RATIO_VIDEO_IDS)('%s 仍识别真实旧单画幅快照而非只比较当前新版字段', (id) => {
    const capability = { ...previousVideoCapability(id), ratios: ['16:9'] };
    expect(resolveRelayonVideoCapability(id, previousVideoProfile(id), capability)).toEqual(model(id).videoCapability);
    expect(capability.ratios).toEqual(['16:9']);
    const edited = { ...capability, maxDuration: capability.maxDuration! - 1 };
    expect(resolveRelayonVideoCapability(id, previousVideoProfile(id), edited)).toBe(edited);
  });

  it('H3 完整旧连续 4–30 秒快照投影 15 秒，保留用户限制与原配置', () => {
    const id = 'minimax-h3', profile = previousVideoProfile(id);
    const saved = { ...previousVideoCapability(id), maxDuration: 30 };
    const before = structuredClone(saved);
    const effective = resolveRelayonVideoCapability(id, profile, saved)!;
    expect(effective).toEqual(model(id).videoCapability);
    expect(effective).toMatchObject({ durations: [15], minDuration: 15, maxDuration: 15, defaultDuration: 15 });
    effective.durations!.push(35);
    expect(saved).toEqual(before);
    for (const explicit of [{ ...saved, maxDuration: 25 }, { ...saved, durations: [15, 30] }, { maxDuration: 30 }]) {
      expect(resolveRelayonVideoCapability(id, profile, explicit)).toBe(explicit);
    }
    const custom = structuredClone(profile);
    custom.protocol!.submit.path = '/user/videos';
    expect(resolveRelayonVideoCapability(id, custom, saved)).toBe(saved);
  });

  it('恢复候选同时保留完整原协议和新版协议，供原回执摘要精确选择', () => {
    const id = 'sd-2.5-A';
    for (const profile of [previousVideoProfile(id), model(id).executionProfile!]) {
      const candidates = getRelayonVideoRecoveryProfiles(id, profile);
      expect(candidates).toHaveLength(2);
      expect(candidates).toContainEqual(previousVideoProfile(id));
      expect(candidates).toContainEqual(model(id).executionProfile);
      candidates[0].protocol!.submit.path = '/mutated';
      expect(profile.protocol!.submit.path).toBe('/videos');
    }
    expect(getRelayonVideoRecoveryProfiles('minimax-h3', model('minimax-h3').executionProfile)).toHaveLength(1);
    const custom = previousVideoProfile(id);
    assert(custom.protocol?.version === 2);
    custom.protocol.poll!.response.result.urlPath = 'userResult.url';
    expect(getRelayonVideoRecoveryProfiles(id, custom)).toEqual([custom]);
    expect(resolveRelayonVideoExecutionProfile(id, custom)).toBe(custom);
    expect(getRelayonVideoRecoveryProfiles(id, undefined)).toEqual([]);
  });
});

describe('RelayOnAPI 已确认的媒体合同', () => {
  it('图片复用基础模板后仍只保留本渠道声明的字段与像素，MJ 渠道合同保持独立', () => {
    for (const id of RELAYON_IMAGE_MODEL_IDS) {
      const keys = ['resolutions', 'defaultResolution', 'ratios', 'defaultRatio', 'dimensionPresets',
        'supportsBatch', 'maxBatchCount', 'supportsImageReference', 'maxImageReferences', 'supportsDataUrlReference'];
      if (id === 'Image-2.5-Flare' || id === 'Image-2.5-Sunburst') keys.push('qualities', 'backgrounds');
      if (RELAYON_IMAGE_26_VARIANT_MODEL_IDS.some((variant) => variant === id)) {
        keys.push('qualities', 'outputFormats', 'defaultOutputFormat', 'textOnlyOutputFormats', 'squareOnlyOutputFormats',
          'gifFrameCount', 'gifFrameDurationMs', 'supportsGifTransparency');
      }
      expect(Object.keys(model(id).imageCapability!).sort(), id).toEqual(keys.sort());
    }
    expect(model('nano-banana-pro').imageCapability?.dimensionPresets?.['2K']['16:9']).toEqual([2560, 1440]);
    expect(model('nano-banana-pro').imageCapability?.maxImageReferences).toBe(6);
    expect(model('Midjourney v7').imageCapability?.maxImageReferences).toBe(1);
  });

  it('声明十七个图片、十三个视频，质量/背景与输出格式按具体型号隔离', () => {
    expect(RELAYON_IMAGE_MODEL_IDS).toHaveLength(17);
    expect(RELAYON_VIDEO_MODEL_IDS).toHaveLength(13);
    expect(RELAYON_MODEL_MANIFEST).toHaveLength(34);
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
      } else if (RELAYON_IMAGE_26_VARIANT_MODEL_IDS.some((variant) => variant === id)) {
        expect(model(id).imageCapability).toMatchObject({ qualities: ['auto', 'low', 'medium', 'high'],
          outputFormats: ['png', 'gif', 'svg'], defaultOutputFormat: 'png' });
        expect(model(id).imageCapability).not.toHaveProperty('backgrounds');
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
    const reference = 'data:image/png;base64,YQ==';
    const variables = relayonImageVariables(id, { model: id, prompt: 'test', imageSize: extended ? '2K' : '1K',
      aspectRatio: extended ? '4:5' : '16:9', imageUrls: [reference], n: 1 });
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol: edited.protocol!, variables });
    expect(built.url).toBe(`${RELAYON_BASE_URL}/images/edits`);
    expect(built.renderedBody).toMatchObject({ model: id, n: 1, resolution: extended ? '2k' : '1k',
      size: extended ? '1632x2040' : '1536x864', image: { $file: [reference] } });
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

  it('2.6 01 按独立文档发送全部 30 档像素，分辨率和比例保持一致', () => {
    const current = model('image-2.6-01');
    const previous = model('image-2.5-flare-01');
    const documented = {
      '1:1': [[1024, 1024], [2048, 2048], [3840, 3840]],
      '16:9': [[1280, 720], [2560, 1440], [3840, 2160]],
      '9:16': [[720, 1280], [1440, 2560], [2160, 3840]],
      '3:2': [[1248, 832], [2496, 1664], [3504, 2336]],
      '2:3': [[832, 1248], [1664, 2496], [2336, 3504]],
      '4:3': [[1152, 864], [2304, 1728], [3264, 2448]],
      '3:4': [[864, 1152], [1728, 2304], [2448, 3264]],
      '5:4': [[1120, 896], [2240, 1792], [3200, 2560]],
      '4:5': [[896, 1120], [1792, 2240], [2560, 3200]],
      '21:9': [[1456, 624], [3024, 1296], [3696, 1584]],
    };
    expect(current.imageCapability!.resolutions).toEqual(['1K', '2K', '4K']);
    expect(new Set(current.imageCapability!.ratios)).toEqual(new Set(Object.keys(documented)));
    expect(current.imageCapability!.dimensionPresets).not.toEqual(previous.imageCapability!.dimensionPresets);
    expect(current.executionProfile).toEqual(previous.executionProfile);
    expect(getRelayonImageOutputsPerJob(current.id, current.executionProfile)).toBe(1);
    for (const [tier, resolution] of ['1K', '2K', '4K'].entries()) {
      for (const [ratio, sizes] of Object.entries(documented)) {
        const [width, height] = sizes[tier];
        const size = `${width}x${height}`;
        expect(current.imageCapability!.dimensionPresets![resolution][ratio]).toEqual([width, height]);
        const variables = relayonImageVariables(current.id, { model: current.id, prompt: 'test',
          imageSize: resolution, aspectRatio: ratio });
        expect(variables).toMatchObject({ model: current.id, imageSize: resolution, aspectRatio: ratio, size, width, height });
        const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
          protocol: current.executionProfile!.protocol!, variables });
        expect(built.renderedBody).toMatchObject({ model: current.id, resolution, aspect_ratio: ratio, size });
      }
    }
    expect(current.imageCapability).not.toHaveProperty('qualities');
    expect(current.imageCapability).not.toHaveProperty('backgrounds');
  });

  it('2.6 完整旧内置能力在运行期采用新像素表，不改写保存快照', () => {
    const current = model('image-2.6-01');
    const saved = legacyImage26Capability();
    const profile = structuredClone(current.executionProfile!);
    const before = structuredClone({ saved, profile });
    const effective = resolveRelayonImageModelContract(current.id, profile, saved);
    expect(effective.imageCapability).toEqual(current.imageCapability);
    expect(effective.executionProfile).toEqual(profile);
    expect({ saved, profile }).toEqual(before);
    expect(effective.imageCapability!.dimensionPresets!['2K']['16:9'])
      .not.toBe(current.imageCapability!.dimensionPresets!['2K']['16:9']);
    effective.imageCapability!.dimensionPresets!['2K']['16:9'] = [1, 1440];
    expect({ saved, profile }).toEqual(before);
    expect(current.imageCapability!.dimensionPresets!['2K']['16:9']).toEqual([2560, 1440]);
  });

  it('普通2.6只为文档明确的4K方图显式旧像素保留2880，不更改默认3840', () => {
    expect(relayonImageVariables('image-2.6-01', { imageSize: '4K', aspectRatio: '1:1', size: '2880x2880' }))
      .toMatchObject({ size: '2880x2880', width: 2880, height: 2880 });
    expect(relayonImageVariables('image-2.6-01', { imageSize: '4K', aspectRatio: '1:1' })).toMatchObject({ size: '3840x3840' });
    expect(() => relayonImageVariables('image-2.6-01', { imageSize: '2K', aspectRatio: '1:1', size: '2880x2880' })).toThrow('不一致');
  });

  it.each(RELAYON_IMAGE_26_VARIANT_MODEL_IDS)('%s 按独立30档与三种真实输出格式映射请求', (id) => {
    const current = model(id);
    const before = structuredClone(current);
    const dimensions = getImageSizePresets('relayon-image-2.6');
    dimensions['4K']['1:1'] = [4096, 4096];
    expect(current.imageCapability!.dimensionPresets).toEqual(dimensions);
    expect(current.imageCapability).toMatchObject({ maxImageReferences: 6, maxBatchCount: 1,
      textOnlyOutputFormats: ['gif', 'svg'], squareOnlyOutputFormats: ['gif', 'svg'],
      gifFrameCount: { min: 2, max: 16, step: 1, default: 9 },
      gifFrameDurationMs: { min: 20, max: 655350, step: 10, default: 200 }, supportsGifTransparency: true });
    for (const format of ['png', 'gif', 'svg'] as const) {
      const variables = relayonImageVariables(id, { model: id, prompt: 'format contract', imageSize: '4K', aspectRatio: '1:1',
        imageOutputFormat: format, imageQuality: 'high' });
      const profile = resolveRelayonImageExecutionProfile(id, current.executionProfile, 0, undefined, { imageOutputFormat: format })!;
      assert(profile.protocol?.version === 2);
      const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol: profile.protocol!, variables });
      expect(built.renderedBody).toMatchObject({ model: id, n: 1, response_format: 'url', size: '4096x4096',
        resolution: '4K', aspect_ratio: '1:1', output_format: format, quality: 'high' });
      expect(built.renderedBody).not.toHaveProperty('image');
      expect(profile.protocol!.response.result!.mimeType).toBe(format === 'svg' ? 'image/svg+xml' : `image/${format}`);
      if (format === 'gif') expect(built.renderedBody).toMatchObject({ frame_count: 9, frame_duration_ms: 200, transparent: false });
      else for (const key of ['frame_count', 'frame_duration_ms', 'transparent']) expect(built.renderedBody).not.toHaveProperty(key);
      const automatic = relayonImageVariables(id, { model: id, imageOutputFormat: format, imageQuality: 'auto' });
      const autoRequest = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol: profile.protocol!, variables: automatic });
      expect(autoRequest.renderedBody).not.toHaveProperty('quality');
    }
    expect(current).toEqual(before);
    const defaults = relayonImageVariables(id, {});
    expect(defaults.imageOutputFormat).toBe('png');
    expect(defaults.imageFrameCount).toBeUndefined();
  });

  it.each(RELAYON_IMAGE_26_VARIANT_MODEL_IDS)('%s 上传前拒绝GIF/SVG参考、非方图和非法专属参数', (id) => {
    for (const format of ['gif', 'svg'] as const) {
      expect(() => relayonImageVariables(id, { imageOutputFormat: format, aspectRatio: '16:9' })).toThrow('方图');
      expect(() => resolveRelayonImageExecutionProfile(id, model(id).executionProfile, 1, undefined, { imageOutputFormat: format })).toThrow('文生');
      expect(() => relayonImageVariables(id, { imageOutputFormat: format, mask: 'https://example.test/mask.png' })).toThrow('文生');
    }
    for (const fields of [{ imageFrameCount: 1 }, { imageFrameCount: 17 }, { imageFrameDurationMs: 21 },
      { imageFrameDurationMs: 655360 }, { imageTransparent: 'false' }]) {
      expect(() => relayonImageVariables(id, { imageOutputFormat: 'gif', ...fields })).toThrow();
    }
    expect(() => relayonImageVariables(id, { imageOutputFormat: 'png', imageTransparent: false })).toThrow('仅适用于GIF');
    expect(() => relayonImageVariables(id, { imageOutputFormat: 'svg', imageFrameCount: 9 })).toThrow('仅适用于GIF');
    expect(() => relayonImageVariables(id, { imageOutputFormat: 'jpeg' })).toThrow('格式');
    expect(() => relayonImageVariables('image-2-01', { imageOutputFormat: 'gif' })).toThrow('未声明');
  });

  it.each(RELAYON_IMAGE_26_VARIANT_MODEL_IDS.flatMap((id) => [1, 2].flatMap((count) => [false, true].map((explicit) => ({ id, count, explicit })))))(
    '$id 的$count图PNG编辑省略wire格式，显式PNG=$explicit，canonical格式映射仍有效', ({ id, count, explicit }) => {
      const current = model(id); const before = structuredClone(current);
      const fixtures = [
        { mime: 'image/png', extension: 'png', encoded: 'iVBORw0KGgo=' },
        { mime: 'image/jpeg', extension: 'jpg', encoded: '/9j/2Q==' },
      ].slice(0, count);
      const imageUrls = fixtures.map(({ mime, encoded }) => `data:${mime};base64,${encoded}`);
      const input = { model: id, prompt: 'png edit contract', imageSize: '2K', aspectRatio: '16:9', imageUrls,
        ...(explicit ? { imageOutputFormat: 'png' } : {}) };
      const variables = relayonImageVariables(id, input);
      const profile = resolveRelayonImageExecutionProfile(id, current.executionProfile, count, undefined,
        explicit ? { imageOutputFormat: 'png' } : {})!;
      expect(() => assertModelCapabilityProtocol({ ...current, executionProfile: profile })).not.toThrow();
      expect(profile.protocol!.submit.body).toHaveProperty('output_format', '{{imageOutputFormat}}');
      expect(variables.imageOutputFormat).toBeUndefined();
      expect(input.imageOutputFormat).toBe(explicit ? 'png' : undefined);
      const built = buildModelProtocolRequest({ baseUrl: RELAYON_IMAGE_BASE_URL, apiKey: 'fixture', protocol: profile.protocol!, variables });
      expect(built.url).toBe(`${RELAYON_IMAGE_BASE_URL}/images/edits`);
      expect(built.renderedBody).toMatchObject({ model: id, size: '2560x1440', n: 1 });
      for (const key of ['output_format', 'resolution', 'aspect_ratio']) expect(built.renderedBody).not.toHaveProperty(key);
      expect(new Headers(built.init.headers).get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
      const wire = String.fromCharCode(...new Uint8Array(built.init.body as ArrayBuffer));
      const field = count === 1 ? 'image' : 'image[]';
      expect(wire.split(`name="${field}"; filename=`)).toHaveLength(count + 1);
      expect(wire).not.toContain(`name="${count === 1 ? 'image[]' : 'image'}"; filename=`);
      expect(wire).not.toContain('name="output_format"');
      let previousPosition = -1;
      for (const [index, { mime, extension, encoded }] of fixtures.entries()) {
        expect(wire).toContain(`name="${field}"; filename="reference-${index + 1}.${extension}"`);
        const position = wire.indexOf(`Content-Type: ${mime}\r\n\r\n${atob(encoded)}\r\n`);
        expect(position).toBeGreaterThan(previousPosition); previousPosition = position;
      }
      expect(wire).not.toContain('data:image/');
      expect(current).toEqual(before);
    },
  );

  it.each(['pixels', 'ratios', 'references'] as const)('2.6 用户修改过的 %s 能力不按旧快照升级', (change) => {
    const saved = legacyImage26Capability();
    if (change === 'pixels') saved.dimensionPresets!['2K']['16:9'] = [2400, 1350];
    else if (change === 'ratios') { saved.ratios = ['16:9']; saved.defaultRatio = '16:9'; }
    else saved.maxImageReferences = 1;
    const before = structuredClone(saved);
    const effective = resolveRelayonImageModelContract('image-2.6-01', model('image-2.6-01').executionProfile, saved);
    expect(effective.imageCapability).toEqual(before);
    expect(saved).toEqual(before);
  });

  it('2.6 自定义协议及无协议配置不自动套用新内置能力', () => {
    const saved = legacyImage26Capability();
    const custom = structuredClone(model('image-2.6-01').executionProfile!);
    custom.protocol!.submit.path = '/user/images';
    const before = structuredClone({ saved, custom });
    const effective = resolveRelayonImageModelContract('image-2.6-01', custom, saved);
    expect(effective.executionProfile).toBe(custom);
    expect(effective.imageCapability).toBe(saved);
    expect(resolveRelayonImageModelContract('image-2.6-01', undefined, saved))
      .toEqual({ executionProfile: undefined, imageCapability: saved });
    expect({ saved, custom }).toEqual(before);
  });

  it('2.6 尺寸修正不改变 2.5 型号的既有像素与保存配置', () => {
    for (const id of ['Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst', 'image-2.5-sunburst-01']) {
      const current = model(id);
      const saved = structuredClone(current.imageCapability!);
      const effective = resolveRelayonImageModelContract(id, current.executionProfile, saved);
      expect(effective.imageCapability).toEqual(saved);
      expect(saved.dimensionPresets).toEqual(getImageSizePresets('relayon-image-2.5'));
      expect(relayonImageVariables(id, { imageSize: '2K', aspectRatio: '16:9' })).toMatchObject({ size: '2048x1152' });
      expect(relayonImageVariables(id, { imageSize: '4K', aspectRatio: '5:4' })).toMatchObject({ size: '2880x2304' });
    }
  });

  it('全部能力与协议满足当前校验，H3 和 SD 渠道均沿本渠道鉴权 content 取件', () => {
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
        if (item.id === 'minimax-h3' || SD_VIDEO_IDS.includes(item.id) || SD_25_C_IDS.includes(item.id)) {
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
    expect(built.renderedBody).toMatchObject({ image: { $file: [inline] }, size: '2048x1152', n: 1 });
    expect(new Headers(built.init.headers).get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(resolveRelayonImageExecutionProfile(id, profile, 0)!.protocol!.submit.path).toBe('/images/generations');
    expect(relayonImageVariables(id, { imageUrls: [] }).imageUrls).toBeUndefined();
    expect(profile).toEqual(original);
  });

  it.each(RELAYON_IMAGE_MODEL_IDS)('%s 的参考编辑编码为有序文件，文生请求仍为原 JSON 合同', (id) => {
    const item = model(id);
    const saved = structuredClone(item.executionProfile!);
    assert(saved.protocol?.version === 2);
    const fixtures = [
      { mime: 'image/png', extension: 'png', encoded: 'iVBORw0KGgo=' },
      { mime: 'image/jpeg', extension: 'jpg', encoded: '/9j/2Q==' },
      { mime: 'image/webp', extension: 'webp', encoded: 'UklGRgQAAABXRUJQ' },
    ].slice(0, item.imageCapability!.maxImageReferences);
    const imageUrls = fixtures.map(({ mime, encoded }) => `data:${mime};base64,${encoded}`);
    expect(usesRelayonImageFileUpload(id, item.executionProfile)).toBe(true);
    const variables = relayonImageVariables(id, { model: id, prompt: 'reference edit', n: 1, imageUrls });
    const protocol = resolveRelayonImageExecutionProfile(id, item.executionProfile, imageUrls.length)!.protocol!;
    assert(protocol.version === 2);
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol, variables });
    expect(built.url).toBe(`${RELAYON_BASE_URL}/images/edits`);
    expect(new Headers(built.init.headers).get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(built.init.body).toBeInstanceOf(ArrayBuffer);
    const wire = String.fromCharCode(...new Uint8Array(built.init.body as ArrayBuffer));
    const field = imageUrls.length > 1 ? 'image[]' : 'image';
    const indexedFiles = id === 'image-2.6-01' || RELAYON_IMAGE_26_VARIANT_MODEL_IDS.some((variant) => variant === id);
    expect(wire.split(`name="${field}"; filename=`)).toHaveLength(imageUrls.length + 1);
    let previousPosition = -1;
    for (const [index, { mime, extension, encoded }] of fixtures.entries()) {
      const filename = indexedFiles ? `reference-${index + 1}.${extension}` : `upload.${extension}`;
      expect(wire).toContain(`name="${field}"; filename="${filename}"`);
      const position = wire.indexOf(`Content-Type: ${mime}\r\n\r\n${atob(encoded)}\r\n`);
      expect(position).toBeGreaterThan(previousPosition);
      previousPosition = position;
    }
    expect(wire).not.toContain('data:image/');
    expect(built.renderedBody).toMatchObject({ model: id, n: 1, size: variables.size, response_format: 'url' });
    if (indexedFiles) for (const key of ['resolution', 'aspect_ratio']) expect(built.renderedBody).not.toHaveProperty(key);
    else expect(built.renderedBody).toMatchObject({ resolution: variables.imageSize, aspect_ratio: variables.aspectRatio });
    expect(protocol.mode).toBe('sync');
    expect(protocol.response).toEqual(saved.protocol!.response);
    const preview = previewModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, protocol, variables });
    for (const { encoded } of fixtures) expect(JSON.stringify(preview.body)).not.toContain(encoded);

    const textProtocol = resolveRelayonImageExecutionProfile(id, item.executionProfile, 0)!.protocol!;
    const textVariables = relayonImageVariables(id, { model: id, prompt: 'text generation', n: 1 });
    const textRequest = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol: textProtocol, variables: textVariables });
    expect(textRequest.url).toBe(`${RELAYON_BASE_URL}/images/generations`);
    expect(textProtocol.submit.bodyEncoding).toBe('json');
    expect(new Headers(textRequest.init.headers).get('Content-Type')).toBe('application/json');
    const textBody = JSON.parse(String(textRequest.init.body));
    expect(textBody).not.toHaveProperty('image');
    expect(textBody).toMatchObject({ resolution: textVariables.imageSize, aspect_ratio: textVariables.aspectRatio, size: textVariables.size });
    expect(item.executionProfile).toEqual(saved);
  });

  it('文件直传只接受已核实精确型号及完整新旧内置协议，不接管自定义合同', () => {
    const id = 'image-2-01';
    const stored = model(id).executionProfile!;
    for (const unknown of ['image-2-01-alias', 'Image-2-01', 'image-2.6-Flare', 'unknown']) {
      expect(usesRelayonImageFileUpload(unknown, stored)).toBe(false);
    }
    expect(usesRelayonImageFileUpload(id, undefined)).toBe(false);
    for (const change of ['path', 'response', 'image-field'] as const) {
      const custom = structuredClone(stored);
      assert(custom.protocol?.version === 2);
      if (change === 'path') custom.protocol.submit.path = '/custom/images';
      else if (change === 'response') custom.protocol.response.result!.urlPath = 'custom_result';
      else (custom.protocol.submit.body as Record<string, ProtocolJsonValue>).image = '{{firstImage}}';
      const before = structuredClone(custom);
      expect(usesRelayonImageFileUpload(id, custom)).toBe(false);
      expect(resolveRelayonImageExecutionProfile(id, custom, 1)).toBe(custom);
      expect(custom).toEqual(before);
    }
    const legacy = structuredClone(stored);
    assert(legacy.protocol?.version === 2);
    delete legacy.protocol.response.result!.base64Path;
    delete legacy.protocol.response.result!.mimeType;
    const before = structuredClone(legacy);
    expect(usesRelayonImageFileUpload(id, legacy)).toBe(true);
    expect(resolveRelayonImageExecutionProfile(id, legacy, 1)!.protocol!.submit.bodyEncoding).toBe('multipart');
    expect(legacy).toEqual(before);
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
      expect(model(id).videoCapability).toMatchObject({ minDuration: 4, maxDuration, defaultDuration: 4, resolutions,
        operations: ['text-to-video'], maxImageReferences: 0, maxVideoReferences: 0, maxAudioReferences: 0 });
      expect(model(id).videoCapability).not.toHaveProperty('durations');
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
      expect(built.renderedBody).toMatchObject({ prompt: '@图1配合@视频1和@音频1', seconds: '6', resolution: '720p', aspect_ratio: '16:9',
        references: [
          { type: 'image', url: 'https://cdn.example/i1.png', role: 'reference' },
          { type: 'image', url: 'https://cdn.example/i2.png', role: 'reference' },
          { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' },
        ] });
      expect(built.renderedBody).not.toHaveProperty('output');
      expect(built.renderedBody).not.toHaveProperty('generate_audio');
      expect(model(id).videoCapability).not.toHaveProperty('supportsAudio');
      expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
    }
  });

  it.each([['sd-2.0-A', 15], ['sd-2.5-A', 30]] as const)('%s 保留 4 至 %s 秒整数区间，不套用 C 渠道固定时长', (id, maximum) => {
    expect(model(id).videoCapability).toMatchObject({ minDuration: 4, maxDuration: maximum, defaultDuration: 4 });
    expect(model(id).videoCapability).not.toHaveProperty('durations');
    for (const duration of [4, 7, maximum]) {
      expect(relayonVideoVariables(id, { durationText: String(duration) }).durationText).toBe(String(duration));
    }
    for (const duration of [3, maximum + 1, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => relayonVideoVariables(id, { durationText: String(duration) })).toThrow('不支持');
    }
  });

  it.each([
    ['sd-2.0-c1', 15], ['sd-2.0-c2', 15], ['sd-2.0-c3', 15], ['minimax-h3', 15],
    ['sd-2.5-c1', 30], ['sd-2.5-c2', 30], ['sd-2.5-c3', 30],
  ] as const)('%s 的可选、默认及上下限统一为 %s 秒，拒绝旧值和非整数', (id, duration) => {
    expect(model(id).videoCapability).toMatchObject({ durations: [duration], minDuration: duration,
      maxDuration: duration, defaultDuration: duration });
    const usesSeconds = id.startsWith('sd-2.5-');
    const actualDuration = (input: Record<string, ProtocolJsonValue>) => relayonVideoVariables(id, usesSeconds
      ? { durationText: String(duration), ...input } : { duration, ...input });
    expect(() => actualDuration({})).not.toThrow();
    expect(() => relayonVideoVariables(id, {})).not.toThrow();
    for (const invalid of [0, duration - 1, duration + 1, duration + 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => actualDuration(usesSeconds ? { durationText: String(invalid) } : { duration: invalid })).toThrow('不支持');
    }
  });

  it('C1 使用顶层数值时长、精确素材上限，并只转换存在的提示词编号', () => {
    const id = 'sd-2.0-c1';
    const variables = relayonVideoVariables(id, { model: id, prompt: '图片1和图片2参考视频1与@音频1，图片3无对应素材',
      duration: 15, resolution: '720p', aspectRatio: '9:16',
      referenceImageUrls: ['https://cdn.example/i1.png', 'https://cdn.example/i2.png'],
      referenceVideoUrls: ['https://cdn.example/v.mp4'], referenceAudioUrls: ['https://cdn.example/a.mp3'] });
    const protocol = model(id).executionProfile!.protocol!;
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture', protocol, variables });
    expect(built.renderedBody).toMatchObject({ prompt: '@图1和@图2参考@视频1与@音频1，图片3无对应素材',
      duration: 15, resolution: '720p', aspect_ratio: '9:16' });
    expect(built.renderedBody).not.toHaveProperty('metadata');
    expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
    expect(model(id).videoCapability).toMatchObject({ durations: [15], minDuration: 15, maxDuration: 15, defaultDuration: 15,
      maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3 });
    expect(model('sd-2.0-c2').videoCapability).toMatchObject({ durations: [15], minDuration: 15, maxDuration: 15, defaultDuration: 15, maxVideoReferences: 0 });
    expect(() => relayonVideoVariables('sd-2.0-c2', { referenceVideoUrls: ['https://cdn.example/v.mp4'] })).toThrow('最多接受 0 个参考视频');
    expect(() => relayonVideoVariables(id, { referenceAudioUrls: Array(4).fill('https://cdn.example/a.mp3') })).toThrow('最多接受 3 个参考音频');
  });

  it('C2 按通用参考格式转换真实图片和音频编号，不改写未知编号或素材顺序', () => {
    const id = 'sd-2.0-c2';
    const prompt = '图片1和图片2配合音频1，图片3是普通文字，@图1也保持原文';
    const variables = relayonVideoVariables(id, { model: id, prompt, duration: 15, resolution: '720p', aspectRatio: '9:16',
      referenceImageUrls: ['https://cdn.example/i1.png', 'https://cdn.example/i2.png'],
      referenceAudioUrls: ['https://cdn.example/a.mp3'] });
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
      protocol: model(id).executionProfile!.protocol!, variables });
    expect(built.renderedBody).toMatchObject({ prompt: '@图1和@图2配合@音频1，图片3是普通文字，@图1也保持原文', references: [
      { type: 'image', url: 'https://cdn.example/i1.png' }, { type: 'image', url: 'https://cdn.example/i2.png' },
      { type: 'audio', url: 'https://cdn.example/a.mp3' },
    ] });
    expect(variables.prompt).toBe('@图1和@图2配合@音频1，图片3是普通文字，@图1也保持原文');
  });

  it('H3 使用 C1 请求格式与小写档位，保留顺序且不将 720p、1K 改写为像素预设', () => {
    const id = 'minimax-h3';
    expect(model(id).videoCapability).toMatchObject({ resolutions: ['480p', '720p', '1K', '2K'],
      durations: [15], minDuration: 15, maxDuration: 15, defaultDuration: 15,
      ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
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
    expect(() => relayonVideoVariables(id, { duration: 31 })).toThrow('不支持 31 秒');
    expect(findUnusedReferenceVariables(JSON.stringify(model(id).executionProfile!.protocol), variables)).toEqual([]);
  });

  it('H3 按 2026-11-17 秒数表只放行 15 秒，拒绝旧的 20／25／30 秒档位', () => {
    for (const duration of [15, 20, 25, 30]) {
      const input = { model: 'minimax-h3', prompt: '固定十五秒', duration, resolution: '720p', aspectRatio: '16:9' };
      if (duration !== 15) {
        expect(() => relayonVideoVariables('minimax-h3', input)).toThrow(`不支持 ${duration} 秒`);
        continue;
      }
      const variables = relayonVideoVariables('minimax-h3', input);
      const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
        protocol: model('minimax-h3').executionProfile!.protocol!, variables });
      expect(built.renderedBody).toMatchObject({ duration });
    }
    for (const duration of [4, 10, 14, 16, 19, 21, 24, 26, 29, 31, 15.5]) {
      expect(() => relayonVideoVariables('minimax-h3', { duration })).toThrow('可选时长为 15 秒');
    }
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

  it('C3 只开放 15 秒、通用三比例，任何参考音频均在提交前明确拒绝', () => {
    expect(model('sd-2.0-c3').videoCapability).toMatchObject({ durations: [15], minDuration: 15, maxDuration: 15, defaultDuration: 15,
      resolutions: ['720p'], maxImageReferences: 9, maxVideoReferences: 0, maxAudioReferences: 0 });
    const input = { model: 'sd-2.0-c3', duration: 15, resolution: '720p', aspectRatio: '16:9',
      prompt: '图片1自然移动', referenceImageUrls: ['https://cdn.example/one.png'] };
    expect(() => relayonVideoVariables('sd-2.0-c3', input)).not.toThrow();
    const withAudio = { ...input, referenceAudioUrls: ['https://cdn.example/one.mp3'] };
    expect(() => relayonVideoVariables('sd-2.0-c3', withAudio)).toThrow('没有可调度的参考音频线路');
    for (const duration of [5, 10, 15]) {
      if (duration !== 15) {
        expect(() => relayonVideoVariables('sd-2.0-c3', { ...input, duration })).toThrow(`不支持 ${duration} 秒`);
        continue;
      }
      for (const aspectRatio of ['16:9', '9:16', '1:1']) {
        const variables = relayonVideoVariables('sd-2.0-c3', { ...input, duration, aspectRatio });
        const built = buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
          protocol: model('sd-2.0-c3').executionProfile!.protocol!, variables });
        expect(built.renderedBody).toMatchObject({ duration, aspect_ratio: aspectRatio, prompt: '@图1自然移动' });
      }
    }
    expect(() => relayonVideoVariables('sd-2.0-c3', { ...input, referenceVideoUrls: ['https://cdn.example/v.mp4'] })).toThrow('最多接受 0 个参考视频');
  });

  it.each(['sd-2.0-c2', 'sd-2.0-c3'])('%s 不再放行不可路由的中间时长与暂停比例', (id) => {
    for (const duration of [4, 5, 6, 7, 10, 11, 14, 16, 30, 5.5, 15.5]) {
      expect(() => relayonVideoVariables(id, { duration })).toThrow('不支持');
    }
    for (const aspectRatio of ['4:3', '3:4', '21:9']) {
      expect(() => relayonVideoVariables(id, { duration: 15, aspectRatio })).toThrow('当前不支持比例');
    }
  });

  it('时长预检校验实际发送字段，旧变量的另一种时长不能绕过上限', () => {
    expect(() => relayonVideoVariables('sd-2.0-A', { duration: 10, durationText: '30' })).toThrow('不支持 30 秒');
    expect(() => relayonVideoVariables('sd-2.0-c1', { duration: 30, durationText: '10' })).toThrow('不支持 30 秒');
  });

  it.each(SD_25_C_IDS)('%s 沿用 2.5 C1 顶层参数、规格与参考上限', (id) => {
    expect(model(id).videoCapability).toMatchObject({ durations: [30], minDuration: 30, maxDuration: 30, defaultDuration: 30, resolutions: ['720p'],
      maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10 });
    expect(model(id).inputModalities).toEqual(['text', 'image']);
    const variables = relayonVideoVariables(id, { model: id, prompt: '图片1和视频1、音频1', durationText: '30',
      resolution: '720p', aspectRatio: '16:9', generateAudio: true, referenceImageUrls: ['https://cdn.example/i.png'],
      referenceVideoUrls: ['https://cdn.example/v.mp4'], referenceAudioUrls: ['https://cdn.example/a.mp3'] });
    expect(buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
      protocol: model(id).executionProfile!.protocol!, variables }).renderedBody).toEqual({ model: id,
      prompt: '@图1和@视频1、@音频1', seconds: '30', resolution: '720p', aspect_ratio: '16:9',
      references: [{ type: 'image', url: 'https://cdn.example/i.png', role: 'reference' },
        { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' }] });
    expect(() => relayonVideoVariables(id, { referenceImageUrls: Array(31).fill('https://cdn.example/i.png') })).toThrow('最多接受 30 个参考图');
  });

  it.each(['sd-2.5-c2', 'sd-2.5-c3'])('%s 与 2.5 C1 只区分请求型号，固定 30 秒且保留音视频参考合同', (id) => {
    const original = model('sd-2.5-c1');
    const selected = model(id);
    expect(selected.executionProfile).toEqual(original.executionProfile);
    expect(selected.videoCapability).toEqual(original.videoCapability);
    expect(selected.inputModalities).toEqual(original.inputModalities);
    expect(selected.videoCapability?.durations).toEqual([30]);
    expect(getRelayonVideoRecoveryProfiles(id, selected.executionProfile)).toEqual([selected.executionProfile]);
    for (const duration of [4, 7, 30]) {
      const input = { prompt: '图片1参考视频1与音频1', duration, durationText: String(duration),
        resolution: '720p', aspectRatio: '21:9', referenceImageUrls: ['https://cdn.example/i.png'],
        referenceVideoUrls: ['https://cdn.example/v.mp4'], referenceAudioUrls: ['https://cdn.example/a.mp3'] };
      if (duration !== 30) {
        for (const modelId of [original.id, id]) {
          expect(() => relayonVideoVariables(modelId, input)).toThrow(`不支持 ${duration} 秒`);
        }
        continue;
      }
      const build = (modelId: string) => buildModelProtocolRequest({ baseUrl: RELAYON_BASE_URL, apiKey: 'fixture',
        protocol: model(modelId).executionProfile!.protocol!, variables: relayonVideoVariables(modelId, { ...input, model: modelId }) });
      const expected = build(original.id);
      const actual = build(id);
      expect(actual.renderedBody).toEqual({ ...(expected.renderedBody as Record<string, ProtocolJsonValue>), model: id });
      expect(actual.renderedBody).toMatchObject({ seconds: String(duration), aspect_ratio: '21:9',
        references: [{ type: 'image', url: 'https://cdn.example/i.png', role: 'reference' },
          { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' }] });
      expect(actual.renderedBody).not.toHaveProperty('duration');
      expect(actual.renderedBody).not.toHaveProperty('generate_audio');
    }
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

describe('RelayOnAPI 视频参考文件直传', () => {
  const files = {
    image: ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='],
    video: ['data:video/mp4;base64,Yw==', 'data:video/mp4;base64,ZA=='],
    audio: ['data:audio/mpeg;base64,ZQ==', 'data:audio/mpeg;base64,Zg=='],
  };

  it('只在已准备的上传中接受文件标记，表单保留每张图的实际格式和序号', () => {
    const id = 'sd-2.0-A', profile = model(id).executionProfile!;
    const variables = { referenceImageUrls: ['relayon-file:0:image/jpeg', 'relayon-file:1:image/webp'] };
    expect(() => resolveRelayonVideoExecutionProfile(id, profile, variables)).toThrow('文件类型无效');
    expect(resolveRelayonVideoExecutionProfile(id, profile, variables, true)?.protocol?.submit.body)
      .toMatchObject({ images: [
        { $file: '{{referenceImageUrls.0}}', filename: 'reference-image-1.jpg' },
        { $file: '{{referenceImageUrls.1}}', filename: 'reference-image-2.webp' },
      ] });
    expect(() => resolveRelayonVideoExecutionProfile(id, profile, { referenceVideoUrls: variables.referenceImageUrls }, true))
      .toThrow('文件类型无效');
  });

  it.each([
    ['image', 'image/svg+xml', 'svg'], ['image', 'image/bmp', 'bmp'], ['image', 'image/tiff', 'tiff'],
    ['image', 'image/heic', 'heic'], ['video', 'video/quicktime', 'mov'], ['video', 'video/x-matroska', 'mkv'],
    ['audio', 'audio/mp4', 'm4a'], ['audio', 'audio/webm', 'weba'],
  ] as const)('已核实的 %s 文件 %s 采用 .%s 后缀', (kind, mime, ext) => {
    const variable = { image: 'referenceImageUrls', video: 'referenceVideoUrls', audio: 'referenceAudioUrls' }[kind];
    const profile = resolveRelayonVideoExecutionProfile('sd-2.0-A', model('sd-2.0-A').executionProfile,
      { [variable]: [`relayon-file:0:${mime}`] }, true);
    expect(profile?.protocol?.submit.body).toMatchObject({ [kind]: { filename: `reference-${kind}-1.${ext}` } });
  });

  it.each([
    ['sd-2.0-A', ['image', 'video', 'audio']], ['sd-2.5-A', ['image', 'video', 'audio']],
    ['sd-2.0-c1', ['image', 'video', 'audio']], ['minimax-h3', ['image', 'video', 'audio']],
    ['sd-2.0-c2', ['image', 'audio']], ['sd-2.0-c3', ['image', 'audio']],
    ['sd-2.5-c1', ['image']], ['sd-2.5-c2', ['image']], ['sd-2.5-c3', ['image']],
    ['doubao-seedance-2-0-260128', []], ['doubao-seedance-2-0-fast-260128', []],
    ['doubao-seedance-2-0-mini-260615', []], ['doubao-seedance-2-5-260628', []],
  ] as const)('%s 只声明文档确认的文件类型，不从其他型号借用上传合同', (id, kinds) => {
    expect(getRelayonVideoFileKinds(id, model(id).executionProfile)).toEqual(kinds);
    expect(getRelayonVideoFileKinds(id, undefined)).toEqual([]);
    const custom = structuredClone(model(id).executionProfile!);
    custom.protocol!.submit.path = '/custom/videos';
    expect(getRelayonVideoFileKinds(id, custom)).toEqual([]);
    expect(resolveRelayonVideoExecutionProfile(id, custom, { referenceImageUrls: files.image })).toBe(custom);
    expect(getRelayonVideoFileKinds(`${id}-alias`, model(id).executionProfile)).toEqual([]);
  });

  it.each([
    ['sd-2.0-A', 1], ['sd-2.0-A', 2], ['sd-2.5-A', 2], ['sd-2.0-c1', 1], ['sd-2.0-c1', 2],
    ['minimax-h3', 2], ['sd-2.0-c2', 1], ['sd-2.0-c2', 2], ['sd-2.0-c3', 2],
    ['sd-2.5-c1', 1], ['sd-2.5-c2', 2], ['sd-2.5-c3', 2],
  ] as const)('%s 的 %s 份参考按 singular/plural 字段发送原文件，不使用 image[]', async (id, count) => {
    const stored = model(id).executionProfile!;
    const before = structuredClone(stored);
    const kinds = getRelayonVideoFileKinds(id, stored).filter((kind) => id !== 'sd-2.0-c3' || kind !== 'audio');
    const duration = model(id).videoCapability!.defaultDuration!;
    const variables = relayonVideoVariables(id, { model: id, prompt: '图片1、图片2与视频1、音频1保持顺序',
      duration, durationText: String(duration), resolution: '720p', aspectRatio: '16:9',
      referenceImageUrls: files.image.slice(0, count),
      referenceVideoUrls: kinds.includes('video') ? files.video.slice(0, count) : [],
      referenceAudioUrls: kinds.includes('audio') ? files.audio.slice(0, count) : [],
    });
    const projected = resolveRelayonVideoExecutionProfile(id, stored, variables)!;
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_VIDEO_BASE_URL, apiKey: 'video-fixture',
      protocol: projected.protocol!, variables, idempotencyKey: 'video-files-request-0001' });
    expect(built.url).toBe(`${RELAYON_VIDEO_BASE_URL}/videos`);
    expect(new Headers(built.init.headers).get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(new Headers(built.init.headers).get('Idempotency-Key')).toBe('video-files-request-0001');
    const form = await new Response(built.init.body, { headers: built.init.headers }).formData();
    expect(form.get('model')).toBe(id);
    expect(form.get(id.endsWith('-A') || id.startsWith('sd-2.5-c') ? 'seconds' : 'duration')).toBe(String(duration));
    for (const kind of kinds) {
      const field = count === 1 ? kind : `${kind}s`;
      const entries = form.getAll(field) as File[];
      expect(entries).toHaveLength(count);
      expect(form.has(`${kind}[]`)).toBe(false);
      expect(form.has(count === 1 ? `${kind}s` : kind)).toBe(false);
      for (const [index, file] of entries.entries()) {
        expect(file.type).toBe(kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg');
        expect(new TextDecoder().decode(await file.arrayBuffer())).toBe(atob(files[kind][index].split(',')[1]));
      }
    }
    expect(form.has('references')).toBe(false);
    expect(projected.protocol!.poll).toEqual(stored.protocol!.poll);
    expect(stored).toEqual(before);
    expect(resolveRelayonVideoExecutionProfile(id, stored)).toEqual(stored);
    const preview = previewModelProtocolRequest({ baseUrl: RELAYON_VIDEO_BASE_URL, protocol: projected.protocol!, variables });
    for (const urls of Object.values(files)) for (const url of urls) expect(JSON.stringify(preview.body)).not.toContain(url);
  });

  it('不能把 Tauri HTTPS 本地地址作为远程视频参考交给服务端', () => {
    expect(() => resolveRelayonVideoExecutionProfile('sd-2.0-A', model('sd-2.0-A').executionProfile, {
      referenceImageUrls: ['https://asset.localhost/local-reference.png'],
    })).toThrow('文件类型无效');
  });

  it('纯 HTTPS 参考保留 JSON；混合文件请求的剩余 references 只编码为一个 JSON 数组字段', async () => {
    const id = 'sd-2.0-A', stored = model(id).executionProfile!;
    const remote = relayonVideoVariables(id, { model: id, prompt: '图片1参考视频1和音频1', durationText: '4',
      resolution: '720p', aspectRatio: '16:9', referenceImageUrls: ['https://cdn.example/i.png'],
      referenceVideoUrls: ['https://cdn.example/v.mp4'], referenceAudioUrls: ['https://cdn.example/a.mp3'] });
    expect(resolveRelayonVideoExecutionProfile(id, stored, remote)).toEqual(stored);
    const remoteBuilt = buildModelProtocolRequest({ baseUrl: RELAYON_VIDEO_BASE_URL, apiKey: 'fixture', protocol: stored.protocol!, variables: remote });
    expect(new Headers(remoteBuilt.init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(remoteBuilt.init.body))).toMatchObject({ seconds: '4', references: [
      { type: 'image', url: 'https://cdn.example/i.png', role: 'reference' },
      { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' },
    ] });
    const variables = { ...remote, referenceImageUrls: [files.image[0]] };
    const projected = resolveRelayonVideoExecutionProfile(id, stored, variables)!;
    const built = buildModelProtocolRequest({ baseUrl: RELAYON_VIDEO_BASE_URL, apiKey: 'fixture', protocol: projected.protocol!, variables });
    const form = await new Response(built.init.body, { headers: built.init.headers }).formData();
    expect(form.getAll('references')).toHaveLength(1);
    expect(JSON.parse(String(form.get('references')))).toEqual([
      { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' },
    ]);
    expect((form.get('image') as File).type).toBe('image/png');
    expect(form.get('seconds')).toBe('4');
    expect(form.has('output')).toBe(false);
  });

  it.each(['sd-2.5-c1', 'sd-2.5-c2', 'sd-2.5-c3'])('%s 未公开本地音视频文件合同，投影前失败且不改写保存协议', (id) => {
    const stored = model(id).executionProfile!;
    const before = structuredClone(stored);
    for (const kind of ['video', 'audio'] as const) {
      const variables = { referenceImageUrls: files.image.slice(0, 1),
        [kind === 'video' ? 'referenceVideoUrls' : 'referenceAudioUrls']: files[kind].slice(0, 1) };
      expect(() => resolveRelayonVideoExecutionProfile(id, stored, variables)).toThrow('不会回退到图床');
    }
    expect(stored).toEqual(before);
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
