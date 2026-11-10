/**
 * libapiModelManifest — 回归测试：LIBAPI 已审计的内置合同。
 */
import { describe, expect, it } from 'vitest';
import type { MediaReference } from '../../src/types/aiTypes';
import { LIBAPI_MODEL_MANIFEST, assertLibapiImageInput, assertLibapiVideoInput, getLibapiAudioCapability, libapiAudioVariables, libapiImageExecutionProfile, libapiImageVariables,
  libapiVideoVariables, matchLibapiCatalog, resolveLibapiModelId, usesLibapiModelProtocol } from '../../src/services/ai/providers/libapiModelManifest';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { buildModelProtocolRequest, resolveModelExecutionProfile, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import { buildCanonicalVideoProtocolVariables } from '../../src/services/ai/generateVideo';
import { assertVideoModelCapability, resolveCanonicalVideoRequest } from '../../src/services/ai/videoRequestResolver';
import { findUnusedReferenceVariables } from '../../src/services/ai/modelProtocolRuntime';

function model(id: string) {
  const result = LIBAPI_MODEL_MANIFEST.find((item) => item.id === id);
  if (!result) throw new Error(`missing fixture: ${id}`);
  return result;
}
function reference(kind: MediaReference['kind'], role: MediaReference['role'] = 'reference', index = 1): MediaReference {
  return { kind, role, origin: 'prompt', url: `https://cdn.example/${kind}-${index}` };
}
function video(id: string, references: MediaReference[] = []) {
  return resolveCanonicalVideoRequest({ model: id, provider: 'general', prompt: '图片1参考人物，视频1参考动作，音频1参考声音' }, {
    capability: model(id).videoCapability, references,
  });
}

describe('LIBAPI 已审计的内置合同', () => {
  it('仅注册普通生成型号，不将退役、超分、声纹、转写或数字人列入生成目录', () => {
    expect(LIBAPI_MODEL_MANIFEST.filter((item) => item.category === 'text').map((item) => item.id).sort()).toEqual([
      'cl-opus-5-5', 'deepseek-v4.1-flash', 'gk-4.7', 'glm-5.3-flash',
      'gm-3.8-flash', 'gm-4-argon', 'gt-6.1-sol', 'qwen3.8-flash',
    ].sort());
    expect(LIBAPI_MODEL_MANIFEST.filter((item) => item.category === 'image')).toHaveLength(22);
    expect(LIBAPI_MODEL_MANIFEST.filter((item) => item.category === 'video')).toHaveLength(31);
    expect(LIBAPI_MODEL_MANIFEST.filter((item) => item.category === 'audio').map((item) => item.id).sort()).toEqual([
      'speech-2.8', 'music', 'gm-3.1-flash-tts', 'gm-2.5-pro-tts', 'gt-4o-mini-tts', 'doubao-tts-2.0',
    ].sort());
    for (const id of ['happyhorse-1-0', 'gk-video-3', 'mj_imagine', 'aliyun-image-superres', 'face-repaint',
      'kling-v3-motion-control', 'vo-4-omni-v2v', 'kling-v3-omni-cankao', 'kling-avatar', 'kling-lip-sync',
      'aliyun-video-superres', 'voice-design', 'voice-clone', 'whisper-1',
      'deepseek-v4-flash', 'gt-6-sol', 'cl-sonnet-4-6', 'qwen3.8-27b']) {
      expect(resolveLibapiModelId(id), id).toBeUndefined();
    }
    expect(model('deepseek-v4.1-flash').inputModalities).toEqual(['text', 'image']);
    expect(model('gt-6.1-sol').contextWindow).toBeGreaterThan(0);
  });

  it('认证目录只匹配精确 internal/public ID，保留真实请求 ID、连接身份且不修改输入', () => {
    const remote = ['gpt-6.1-sol', 'gt-6.1-sol', 'gpt-6-sol', 'gt-6-sol',
      'gpt-image-2.5-flare', 'seedance-2-5', 'unknown-video'].map((id) => ({
      id, name: id, category: 'text' as const, provider: 'libapi-personal',
    }));
    const original = structuredClone(remote);
    const matched = matchLibapiCatalog(remote);
    expect(matched.map((item) => [item.id, item.category])).toEqual([
      ['gpt-6.1-sol', 'text'], ['gpt-image-2.5-flare', 'image'], ['seedance-2-5', 'video'],
    ]);
    expect(matched.every((item) => item.provider === 'libapi-personal')).toBe(true);
    expect(resolveLibapiModelId('gt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(resolveLibapiModelId('gt-image-2.5-flare')).toBe('gpt-image-2.5-flare');
    expect(remote).toEqual(original);
  });

  it('每个媒体合同均使用合法异步协议，原任务查询两小时且不设置提交重试', () => {
    for (const item of LIBAPI_MODEL_MANIFEST) {
      expect(() => assertModelCapabilityProtocol(item), item.id).not.toThrow();
      if (item.videoCapability) expect(() => assertVideoModelCapability(item.videoCapability!), item.id).not.toThrow();
      const protocol = item.executionProfile?.preset === 'custom' ? resolveModelExecutionProfile(item.executionProfile) : null;
      if (!protocol) continue;
      expect(validateModelExecutionProtocol(protocol), item.id).toEqual([]);
      expect(protocol.submit).toMatchObject({ path: '/api/v1/model-runtime/invoke', pathMode: 'origin' });
      expect(protocol.response).toMatchObject({ taskIdPath: 'task_id' });
      expect(protocol.poll).toMatchObject({ path: '/v1/tasks/{{submit.task_id}}', pathMode: 'origin', maxDurationMs: 7_200_000,
        response: { successValues: ['completed'], failureValues: ['failed'], result: { urlPath: 'output_url' } } });
      expect(protocol.submit).not.toHaveProperty('retry');
      expect(JSON.stringify(protocol)).not.toContain('{{parameters.');
    }
  });

  it('Seedance/H3 共用型号基线时仍由渠道快照限定离散时长、输入模式和参考名额', () => {
    const standard = model('seedance-2-5').videoCapability!;
    expect(standard).toMatchObject({ resolutions: ['480p', '720p', '1080p'], defaultResolution: '480p',
      ratios: ['16:9', '9:16', '21:9', '3:4', '1:1', '4:3'],
      durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 29, 30], defaultDuration: 5,
      inputModeCapabilities: { keyframe: { requiresRatio: false } },
      supportsStandaloneAudio: true, maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10 });
    const perTask = model('seedance-2-5-special').videoCapability!;
    expect(perTask).toMatchObject({ durations: [30], defaultDuration: 30, defaultRatio: '9:16',
      defaultResolution: '720p', maxVideoReferences: 0, maxAudioReferences: 0, supportsStandaloneAudio: false });
    expect(perTask.inputModeCapabilities).toBeUndefined();
    expect(model('seedance-2-0-ecom-special').videoCapability).toMatchObject({
      ratios: ['9:16', '16:9', '1:1'], durations: [5, 10, 15], maxVideoReferences: 0, maxAudioReferences: 0,
    });
    expect(model('seedance-2-0-ecom-special').videoCapability?.resolutions).toBeUndefined();
    for (const id of ['seedance-2-5', 'seedance-2-5-special', 'seedance-2-5-promo', 'seedance-2-0-official',
      'seedance-2-0-promo', 'seedance-2-0-special', 'seedance-2-0-manju-special', 'seedance-2-0-ecom-special',
      'seedance-2-0-9tu-special', 'minimax-h3']) {
      const capability = model(id).videoCapability!;
      expect(capability.minDuration, id).toBeUndefined();
      expect(capability.maxDuration, id).toBeUndefined();
      expect(capability.automaticDurationValue, id).toBeUndefined();
      expect(capability.operationCapabilities, id).toBeUndefined();
      expect(capability.supportsAudio, id).toBeUndefined();
    }
    expect(model('minimax-h3').videoCapability?.inputConstraints?.referenceVideo).toEqual({
      durationSeconds: { min: 2, max: undefined }, totalDurationSeconds: { max: 15 },
    });
  });

  it('GPT/Nano/Seedream 不继承官方像素或未知控件，保留快照枚举顺序和大小写', () => {
    expect(model('gm-3.1-flash-image').imageCapability).toMatchObject({
      resolutions: ['0.5K', '1K', '2K', '4K'], defaultResolution: '1K',
      ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto', '1:4', '4:1', '1:8', '8:1'],
    });
    expect(model('gm-nano-banana-2.1-image').imageCapability?.ratios).not.toContain('1:8');
    expect(model('doubao-seedream-4-5').imageCapability).toMatchObject({
      resolutions: ['2k', '4k', '1k'], defaultResolution: '2k', maxImageReferences: 4,
    });
    for (const id of ['gt-image-2', 'gt-image-2.5-flare', 'gt-image-2-official', 'gm-3.1-flash-image',
      'gm-3-pro-image', 'gm-nano-banana-2.1-image', 'doubao-seedream-4-5', 'doubao-seedream-5-0', 'doubao-seedream-5-0-pro']) {
      const capability = model(id).imageCapability!;
      expect(capability.dimensionPresets, id).toBeUndefined();
      expect(capability.defaultBackground, id).toBeUndefined();
      expect(capability.supportsBatch, id).toBe(false);
      expect(capability.maxBatchCount, id).toBe(1);
      expect(capability.supportsDataUrlReference, id).toBe(false);
    }
    expect(model('doubao-seedream-5-0-pro').imageCapability?.qualities).toBeUndefined();
    expect(model('doubao-seedream-5-0-pro').imageCapability?.backgrounds).toBeUndefined();
    expect(model('gt-image-1.5-all').imageCapability?.dimensionPresets).toEqual({ '1K': {
      '1:1': [1024, 1024], '3:2': [1536, 1024], '2:3': [1024, 1536],
    } });
  });

  it('GT 图片的质量、透明背景与比例分别映射，计数固定一张', () => {
    const id = 'gpt-image-2.5-flare';
    const variables = libapiImageVariables(id, { model: id, prompt: '透明贴纸', imageSize: '2k', aspectRatio: '9:16',
      imageQuality: 'high', imageBackground: 'transparent', imageUrls: ['https://cdn.example/reference.png'], n: 1 });
    const built = buildModelProtocolRequest({ protocol: model('gt-image-2.5-flare').executionProfile!.protocol!,
      baseUrl: 'https://libapi.cc/v1', apiKey: 'fixture', variables });
    expect(built.url).toBe('https://libapi.cc/api/v1/model-runtime/invoke');
    expect(built.renderedBody).toMatchObject({ model_id: id, modality: 'image', operation: 'generate', params: {
      prompt: '透明贴纸', count: 1, aspect_ratio: '9:16', resolution: '2K', quality: 'high',
      background: 'transparent', output_format: 'png', images: ['https://cdn.example/reference.png'],
    } });
    expect(model('gt-image-2.5-flare').imageCapability?.qualities).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(() => libapiImageVariables(id, { imageQuality: 'auto' })).toThrow('quality');
    expect(() => assertLibapiImageInput(id, 18, 1)).toThrow('17');
    expect(() => assertLibapiImageInput(id, 0, 2)).toThrow('批量');
  });

  it('图片模式按实际参考数量生成临时协议，不沿用文生图默认或污染保存合同', () => {
    const saved = structuredClone(model('gt-image-2.5-flare').executionProfile);
    for (const [count, mode] of [[0, 'text-to-image'], [1, 'image-edit'], [2, 'multi-reference']] as const) {
      const profile = libapiImageExecutionProfile('gpt-image-2.5-flare', count);
      expect(profile.protocol!.submit.body).toMatchObject({ params: { mode } });
      expect(profile).not.toBe(saved);
    }
    expect(model('gt-image-2.5-flare').executionProfile).toEqual(saved);
    expect(libapiImageExecutionProfile('fx-2', 1).protocol!.submit.body).toMatchObject({ params: { mode: 'multi-reference' } });
    expect(() => libapiImageExecutionProfile('gt-image-2-c', 2)).toThrow();
  });

  it('严格区分 size 的分辨率、比例和真实像素三种语义', () => {
    const cases = [
      ['gm-3.1-flash-image', { imageSize: '2K', aspectRatio: '16:9' }, { size: '2K', aspect_ratio: '16:9' }],
      ['doubao-seedream-5-0', { imageSize: '2K', aspectRatio: '9:16' }, { size: '9:16', resolution: '2k' }],
      ['gt-image-2-c', { imageSize: '1K', size: '1792x1024', aspectRatio: '7:4' }, { size: '1792x1024' }],
    ] as const;
    for (const [id, input, expected] of cases) {
      const built = buildModelProtocolRequest({ protocol: model(id).executionProfile!.protocol!, baseUrl: 'https://libapi.cc/v1',
        apiKey: 'fixture', variables: libapiImageVariables(id, { model: id, prompt: 'test', imageUrls: [], ...input }) });
      expect(built.renderedBody).toMatchObject({ params: expected });
    }
    expect(model('gt-image-2-c').imageCapability?.dimensionPresets?.['1K']?.['7:4']).toEqual([1792, 1024]);
    expect(() => libapiImageVariables('gt-image-2-c', { size: '2048x1152' })).toThrow('size');
  });

  it('多参考视频完整接收三类动态素材，模式不沿用界面文本值', () => {
    const request = video('seedance-2-5', [reference('image'), reference('video'), reference('audio', 'reference_audio')]);
    const variables = libapiVideoVariables(request, buildCanonicalVideoProtocolVariables(request));
    const protocol = model(request.modelId).executionProfile!.protocol!;
    expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
    const built = buildModelProtocolRequest({ protocol, baseUrl: 'https://libapi.cc/v1', apiKey: 'fixture', variables });
    expect(built.renderedBody).toMatchObject({ model_id: 'seedance-2-5', modality: 'video', params: {
      mode: 'reference', count: 1, images: ['https://cdn.example/image-1'],
      videos: ['https://cdn.example/video-1'], audios: ['https://cdn.example/audio-1'],
    } });
  });

  it('首尾帧按角色排序，不能混用普通参考或退化到另一种模式', () => {
    expect(model('seedance-2-5').videoCapability?.inputModeCapabilities?.keyframe).toEqual({ requiresRatio: false });
    expect(model('minimax-h3').videoCapability?.inputModeCapabilities?.keyframe).toEqual({ requiresRatio: false });
    const request = video('seedance-2-5', [reference('image', 'last_frame', 2), reference('image', 'first_frame')]);
    const variables = libapiVideoVariables(request, buildCanonicalVideoProtocolVariables(request));
    expect(variables).toMatchObject({ videoInputMode: 'first-last', imageUrls: ['https://cdn.example/image-1', 'https://cdn.example/image-2'] });
    expect(variables.aspectRatio).toBeUndefined();
    expect(() => video('seedance-2-5', [reference('image', 'first_frame'), reference('video')])).toThrow();
    expect(() => assertLibapiVideoInput(video('pixverse-v6', [reference('image')]))).toThrow('reference');
    expect(() => assertLibapiVideoInput(video('seedance-2-5-promo', [reference('image', 'first_frame'), reference('image', 'last_frame', 2)])))
      .toThrow('first-last');
  });

  it('只对明确支持的型号开放纯音频参考，争议字段不放开', () => {
    expect(() => assertLibapiVideoInput(video('seedance-2-5', [reference('audio', 'reference_audio')]))).not.toThrow();
    expect(model('seedance-2-5-special').videoCapability?.maxAudioReferences).toBe(0);
    expect(() => video('minimax-h3', [reference('audio', 'reference_audio')])).toThrow();
    expect(() => video('seedance-2-5-special', [reference('image'), reference('audio', 'reference_audio')])).toThrow();
  });

  it('单首帧特价型号不会发送虚构模式，续写专用视频参考不冒充普通参考', () => {
    const id = 'gk-imagine-1.5-special';
    const request = video(id, [reference('image', 'first_frame')]);
    const variables = libapiVideoVariables(request, buildCanonicalVideoProtocolVariables(request));
    expect(variables.imageUrls).toEqual(['https://cdn.example/image-1']);
    expect(variables.videoInputMode).toBeUndefined();
    const built = buildModelProtocolRequest({ protocol: model(id).executionProfile!.protocol!, baseUrl: 'https://libapi.cc/v1', apiKey: 'fixture', variables });
    expect(built.renderedBody).toMatchObject({ params: { images: ['https://cdn.example/image-1'] } });
    expect(built.renderedBody).not.toHaveProperty('params.mode');
    expect(model('vo-4-omni').videoCapability?.maxVideoReferences).toBe(0);
    expect(model('gk-imagine-video').videoCapability?.maxVideoReferences).toBe(0);
    expect(() => video('vo-4-omni', [reference('video')])).toThrow();
  });

  it('字段转换仅用于完整内置协议，修改请求或查询后不覆盖用户协议', () => {
    const current = model('gt-image-2.5-flare').executionProfile!;
    expect(usesLibapiModelProtocol('gpt-image-2.5-flare', structuredClone(current))).toBe(true);
    expect(usesLibapiModelProtocol('gpt-image-2.5-flare')).toBe(false);
    const custom = structuredClone(current);
    custom.protocol!.submit.path = '/my/image/generate';
    expect(usesLibapiModelProtocol('gt-image-2.5-flare', custom)).toBe(false);
    expect(custom.protocol!.submit.path).toBe('/my/image/generate');
    expect(usesLibapiModelProtocol('unknown', current)).toBe(false);
  });

  it('音频合同只增加正常TTS与音乐，并保持internal/public ID兼容', () => {
    expect(resolveLibapiModelId('gm-3.1-flash-tts')).toBe('gemini-3.1-flash-tts');
    expect(resolveLibapiModelId('gt-4o-mini-tts')).toBe('gpt-4o-mini-tts');
    const profile = model('gt-4o-mini-tts').executionProfile!;
    expect(usesLibapiModelProtocol('gpt-4o-mini-tts', profile)).toBe(true);
    const customized = structuredClone(profile);
    customized.protocol!.submit.path = '/my/speech';
    expect(usesLibapiModelProtocol('gt-4o-mini-tts', customized)).toBe(false);
    expect(getLibapiAudioCapability('voice-clone')).toBeUndefined();
    expect(getLibapiAudioCapability('whisper-1')).toBeUndefined();
    expect(getLibapiAudioCapability('gt-image-2')).toBeUndefined();
  });

  it('GT TTS使用公开默认值、容器格式和有效语速，不开放未封装的PCM', () => {
    const id = 'gt-4o-mini-tts';
    expect(getLibapiAudioCapability(id)).toMatchObject({ kind: 'speech', voiceInput: 'select',
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], defaultVoice: 'alloy',
      formats: ['mp3', 'opus', 'aac', 'flac', 'wav'], defaultFormat: 'mp3', speed: { min: 0.25, max: 4, default: 1 }, supportsVoiceReference: false });
    const variables = libapiAudioVariables('gpt-4o-mini-tts', { model: id, prompt: '你好' });
    expect(variables).toMatchObject({ audioVoice: 'alloy', audioFormat: 'mp3', audioSpeed: 1 });
    const built = buildModelProtocolRequest({ protocol: model(id).executionProfile!.protocol!, baseUrl: 'https://libapi.cc/v1', apiKey: 'fixture', variables });
    expect(built.renderedBody).toEqual({ model_id: id, modality: 'audio', operation: 'speech',
      params: { input: '你好', voice: 'alloy', response_format: 'mp3', speed: 1 } });
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioFormat: 'pcm' })).toThrow('格式');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioVoice: 'Zephyr' })).toThrow('预置列表');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioSpeed: 4.1 })).toThrow('速度');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioSpeed: Number.NaN })).toThrow('速度');
    expect(libapiAudioVariables(id, { prompt: '你好', audioSpeed: 0.37 }).audioSpeed).toBe(0.37);
  });

  it.each(['gm-3.1-flash-tts', 'gm-2.5-pro-tts'])('%s只提供公开30音色与WAV，不发送不存在的速度倍率', (id) => {
    const capability = getLibapiAudioCapability(id)!;
    expect(capability.voices).toHaveLength(30);
    expect(capability).toMatchObject({ defaultVoice: 'Zephyr', formats: ['wav'], defaultFormat: 'wav' });
    expect(capability.speed).toBeUndefined();
    const variables = libapiAudioVariables(id, { model: id, prompt: '你好', audioVoice: 'Kore' });
    const built = buildModelProtocolRequest({ protocol: model(id).executionProfile!.protocol!, baseUrl: 'https://libapi.cc/v1', apiKey: 'fixture', variables });
    expect(built.renderedBody).toMatchObject({ params: { input: '你好', voice: 'Kore', response_format: 'wav' } });
    expect(built.renderedBody).not.toHaveProperty('params.speed');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioSpeed: 1 })).toThrow('未公布速度');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioFormat: 'mp3' })).toThrow('格式');
  });

  it.each(['speech-2.8', 'doubao-tts-2.0'])('%s必须由用户填写平台已有音色ID，不采用文档示例或GT默认', (id) => {
    const capability = getLibapiAudioCapability(id)!;
    expect(capability).toMatchObject({ voiceInput: 'id', speed: { options: [0.5, 0.75, 1, 1.25, 1.5, 2] } });
    expect(capability.defaultVoice).toBeUndefined();
    expect(() => libapiAudioVariables(id, { prompt: '你好' })).toThrow('音色 ID');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioVoice: '   ' })).toThrow('音色 ID');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioVoice: 'voice\ninvalid' })).toThrow('控制字符');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioVoice: 'v'.repeat(257) })).toThrow('256');
    expect(() => libapiAudioVariables(id, { prompt: '你好', audioVoice: 'my_existing_voice', audioSpeed: 1.1 })).toThrow('速度');
    const variables = libapiAudioVariables(id, { model: id, prompt: '你好', audioVoice: '  my_existing_voice  ', audioSpeed: 0.75 });
    expect(variables.audioVoice).toBe('my_existing_voice');
    const built = buildModelProtocolRequest({ protocol: model(id).executionProfile!.protocol!, baseUrl: 'https://libapi.cc/v1', apiKey: 'fixture', variables });
    expect(built.renderedBody).toMatchObject({ params: { input: '你好', voice: 'my_existing_voice', speed: 0.75 } });
    if (id === 'speech-2.8') {
      expect(capability.formats).toBeUndefined();
      expect(built.renderedBody).not.toHaveProperty('params.response_format');
      expect(() => libapiAudioVariables(id, { prompt: '你好', audioVoice: 'my_existing_voice', audioFormat: 'wav' })).toThrow('未公布可选输出格式');
    } else {
      expect(capability.formats).toEqual(['mp3', 'wav']);
      expect(built.renderedBody).toMatchObject({ params: { response_format: 'mp3' } });
    }
  });

  it('普通音乐只接收提示、标题和歌词，不会落到TTS默认操作或静默忽略不支持参数', () => {
    expect(getLibapiAudioCapability('music')).toEqual({ kind: 'music', supportsVoiceReference: false,
      musicControls: { title: true, lyrics: true, bpm: false, duration: false, autoGenerateLyrics: false } });
    const variables = libapiAudioVariables('music', { model: 'music', prompt: '古风钢琴', musicTitle: '晨光', musicLyrics: '第一句\n第二句', n: 1 });
    const built = buildModelProtocolRequest({ protocol: model('music').executionProfile!.protocol!, baseUrl: 'https://libapi.cc/v1', apiKey: 'fixture', variables });
    expect(built.renderedBody).toEqual({ model_id: 'music', modality: 'audio', operation: 'generate',
      params: { prompt: '古风钢琴', title: '晨光', lyrics: '第一句\n第二句' } });
    expect(built.renderedBody).not.toHaveProperty('params.count');
    for (const extra of [{ musicBpm: 120 }, { duration: 60 }, { audioFormat: 'wav' }, { audioVoice: 'alloy' }, { audioSpeed: 1 }]) {
      expect(() => libapiAudioVariables('music', { prompt: '音乐', ...extra })).toThrow('未公布');
    }
    expect(() => libapiAudioVariables('music', { prompt: '音乐', n: 2 })).toThrow('一个音频任务');
    expect(() => libapiAudioVariables('music', { prompt: '   ' })).toThrow('内容不能为空');
    expect(() => libapiAudioVariables('unknown', { prompt: '音乐' })).toThrow('尚未适配');
    expect(() => libapiAudioVariables('gt-4o-mini-tts', { prompt: '你好', musicLyrics: '歌词' })).toThrow('语音合成');
  });
});
