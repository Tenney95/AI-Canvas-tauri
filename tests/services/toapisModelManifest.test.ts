/**
 * toapisModelManifest — 回归测试：ToAPIs 已核对的渠道合同。
 */
import { describe, expect, it } from 'vitest';
import { TOAPIS_MODEL_MANIFEST, TOAPIS_TEXT_MODEL_IDS, assertToapisImageInput, assertToapisVideoInput,
  matchToapisCatalog, resolveToapisImageModelContract, toapisImageReferences, toapisVideoVariables } from '../../src/services/ai/providers/toapisModelManifest';
import { assertConfiguredImageReferences, assertModelCapabilityProtocol, resolveConfiguredImageBackground,
  resolveConfiguredImageParameters, resolveConfiguredImageQuality } from '../../src/services/ai/modelCapabilityValidation';
import { buildModelProtocolRequest, previewModelProtocolResponse, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import { findUnusedReferenceVariables } from '../../src/services/ai/modelProtocolRuntime';
import { buildCanonicalVideoProtocolVariables } from '../../src/services/ai/generateVideo';
import { assertVideoModelCapability, resolveCanonicalVideoRequest } from '../../src/services/ai/videoRequestResolver';
import type { MediaReference, ModelProtocolRequestTemplate, ProtocolJsonValue } from '../../src/types/aiTypes';

function model(id: string) {
  const value = TOAPIS_MODEL_MANIFEST.find((item) => item.id === id);
  if (!value?.executionProfile) throw new Error(`missing fixture: ${id}`);
  return value;
}
function video(id: string, references: MediaReference[], duration?: number) {
  return resolveCanonicalVideoRequest({ model: id, provider: 'general', prompt: '图片1参考造型，视频1参考运动', seedanceDuration: duration }, {
    capability: model(id).videoCapability, references,
  });
}
function ref(kind: MediaReference['kind'], number: number, role: MediaReference['role'] = 'reference'): MediaReference {
  return { kind, role, origin: 'connection', url: `https://cdn.example/${kind}-${number}` };
}

describe('ToAPIs 已核对的渠道合同', () => {
  it('只保留用户指定的九个文本型号，并以远端实际返回的精确 ID 决定可用性', () => {
    expect(TOAPIS_TEXT_MODEL_IDS).toEqual(['gemini-3.8-flash', 'gemini-4-argon', 'qwen3.8-flash', 'deepseek-v4.1-flash',
      'gpt-6.1-sol', 'grok-4.7', 'qwen3.8-27b', 'claude-opus-5-5', 'glm-5.3-flash']);
    const result = matchToapisCatalog(['gpt-6.1-sol', 'gpt-5.6-sol', 'MiniMax-H3', 'suno', 'unknown-video'].map((id) => ({
      id, name: id, provider: 'toapis-user', category: 'text',
    })));
    expect(result.map((item) => [item.id, item.category])).toEqual([
      ['gpt-6.1-sol', 'text'], ['MiniMax-H3', 'video'], ['suno', 'audio'],
    ]);
    expect(result.every((item) => item.provider === 'toapis-user')).toBe(true);
    expect(result.find((item) => item.id === 'qwen3.8-27b')).toBeUndefined();
  });

  it('每个内置媒体合同都可解析，动态选项必须有请求映射，不混入官方音频开关', () => {
    for (const item of TOAPIS_MODEL_MANIFEST) {
      if (item.videoCapability) expect(() => assertVideoModelCapability(item.videoCapability!), item.id).not.toThrow();
      expect(() => assertModelCapabilityProtocol(item), item.id).not.toThrow();
      const protocol = item.executionProfile?.protocol;
      if (protocol) expect(validateModelExecutionProtocol(protocol), item.id).toEqual([]);
    }
    expect(model('MiniMax-H3').videoCapability?.supportsAudio).toBeUndefined();
    expect(model('MiniMax-H3-Max').videoCapability).toMatchObject({ resolutions: ['480P', '768P'], minDuration: 5 });
    expect(model('gemini-3.1-flash-image-official').imageCapability?.resolutions).not.toContain('0.5K');
  });

  it('Seedance 2.5 完整发送图片/视频/音频，保留每个参考素材编号和角色', () => {
    const request = video('seedance-2-5', [ref('image', 1), ref('image', 2),
      ref('video', 1), ref('video', 2), ref('audio', 1, 'reference_audio'), ref('audio', 2, 'reference_audio')]);
    assertToapisVideoInput(request);
    const variables = toapisVideoVariables(request, buildCanonicalVideoProtocolVariables(request));
    const protocol = model(request.modelId).executionProfile!.protocol!;
    expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
    const built = buildModelProtocolRequest({ protocol, baseUrl: 'https://toapis.cn/v1', apiKey: 'fixture', variables });
    expect(built.url).toBe('https://toapis.cn/v1/videos/generations');
    expect(built.renderedBody).toMatchObject({
      duration: 5, aspect_ratio: '16:9', resolution: '720p',
      image_with_roles: [{ url: 'https://cdn.example/image-1', role: 'reference_image' }, { url: 'https://cdn.example/image-2', role: 'reference_image' }],
      video_with_roles: [{ url: 'https://cdn.example/video-1', role: 'reference_video' }, { url: 'https://cdn.example/video-2', role: 'reference_video' }],
      audio_with_roles: [{ url: 'https://cdn.example/audio-1', role: 'reference_audio' }, { url: 'https://cdn.example/audio-2', role: 'reference_audio' }],
    });
  });

  it('Veo 官方的普通参考图不会冒充首帧，Wan 的普通参考图不会混入帧数组', () => {
    for (const id of ['Veo3.1-quality-official', 'wan3.0-video']) {
      const request = video(id, [ref('image', 1)]);
      const variables = toapisVideoVariables(request, buildCanonicalVideoProtocolVariables(request));
      const protocol = model(id).executionProfile!.protocol!;
      expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables), id).toEqual([]);
      const built = buildModelProtocolRequest({ protocol, baseUrl: 'https://toapis.com/v1', apiKey: 'fixture', variables });
      if (id === 'wan3.0-video') expect(built.renderedBody).toMatchObject({ reference_images: ['https://cdn.example/image-1'] });
      else expect(built.renderedBody).toMatchObject({ image_urls: [], metadata: { referenceImages: ['https://cdn.example/image-1'] } });
    }
  });

  it('严格区分 GPT 普通版比例、VIP 像素和 Gemini VIP 对象参考图', () => {
    for (const [id, expected] of [
      ['gpt-image-2.5-sunburst', { size: '16:9', resolution: '2K' }],
      ['gpt-image-2.5-sunburst-vip', { size: '2048x1152' }],
    ] as const) {
      const built = buildModelProtocolRequest({ protocol: model(id).executionProfile!.protocol!, baseUrl: 'https://toapis.cn/v1', apiKey: 'fixture',
        variables: { model: id, prompt: 'test', n: 1, aspectRatio: '16:9', size: '2048x1152', imageSize: '2K' } });
      expect(built.renderedBody).toMatchObject(expected);
      if (id.endsWith('-vip')) expect(built.renderedBody).not.toHaveProperty('resolution');
    }
    const id = 'gemini-3-pro-image-preview-vip';
    const variables = { model: id, prompt: 'edit', n: 1, imageUrls: toapisImageReferences(id, ['https://cdn.example/a', 'https://cdn.example/b']) };
    const protocol = model(id).executionProfile!.protocol!;
    expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
    expect(buildModelProtocolRequest({ protocol, baseUrl: 'https://toapis.cn/v1', apiKey: 'fixture', variables }).renderedBody)
      .toMatchObject({ image_urls: [{ url: 'https://cdn.example/a' }, { url: 'https://cdn.example/b' }] });
  });

  it.each([
    ['gpt-image-2', undefined, undefined],
    ['gpt-image-2-vip', ['low', 'medium', 'high'], 'medium'],
    ['gpt-image-2-official', ['low', 'medium', 'high'], 'high'],
    ['gpt-image-2.5-flare', ['high'], 'high'],
    ['gpt-image-2.5-sunburst', ['high'], 'high'],
    ['gpt-image-2.5-flare-vip', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'high'],
    ['gpt-image-2.5-sunburst-official', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'high'],
  ])('%s 的质量取值不会从同名渠道推断', (id, qualities, defaultQuality) => {
    expect(model(id as string).imageCapability?.qualities).toEqual(qualities);
    expect(model(id as string).imageCapability?.defaultQuality).toBe(defaultQuality);
  });

  it('可调质量进入请求而普通 GPT 2.5 继续固定 high', () => {
    for (const [id, imageQuality, expected] of [
      ['gpt-image-2-vip', 'low', 'low'],
      ['gpt-image-2.5-sunburst-vip', 'max', 'max'],
      ['gpt-image-2.5-sunburst', 'low', 'high'],
    ]) {
      const request = buildModelProtocolRequest({ protocol: model(id).executionProfile!.protocol!,
        baseUrl: 'https://toapis.cn/v1', apiKey: 'fixture', variables: {
          model: id, prompt: 'test', imageQuality, imageSize: '2K', aspectRatio: '16:9', size: '2048x1152', n: 1,
        } });
      expect(request.renderedBody).toMatchObject({ quality: expected });
    }
  });

  it.each(['gpt-image-2.6-flare-official', 'gpt-image-2.6-sunburst-official'])(
    '%s 使用独立的普通 PNG 合同，当前站点和输入顺序保持不变', (id) => {
      const current = model(id);
      expect(current.imageCapability).toMatchObject({ resolutions: ['1k', '2k', '4k'], defaultResolution: '1k',
        ratios: ['auto', '1:1', '3:2', '2:3', '16:9', '9:16'],
        qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'medium',
        backgrounds: ['auto', 'opaque', 'transparent'], supportsBatch: true, maxBatchCount: 4,
        supportsImageReference: true, maxImageReferences: 16, supportsDataUrlReference: false });
      expect(current.imageCapability?.dimensionPresets).toBeUndefined();
      const references = Array.from({ length: 16 }, (_, index) => `https://cdn.example/ref-${index}.png`);
      const protocol = current.executionProfile!.protocol!;
      const variables = { model: id, prompt: 'retain the subject', n: 4, aspectRatio: '9:16', imageSize: '2k',
        imageQuality: 'max', imageBackground: 'transparent', imageUrls: toapisImageReferences(id, references) };
      expect(findUnusedReferenceVariables(JSON.stringify(protocol), variables)).toEqual([]);
      for (const baseUrl of ['https://toapis.cn/v1', 'https://toapis.com/v1']) {
        const built = buildModelProtocolRequest({ protocol, baseUrl, apiKey: 'fixture-key', variables });
        expect(built.url).toBe(`${baseUrl}/images/generations`);
        expect(built.renderedBody).toEqual({ model: id, prompt: 'retain the subject', n: 4, size: '9:16',
          resolution: '2k', quality: 'max', background: 'transparent', image_urls: references, output_format: 'png' });
      }
      expect(protocol).toMatchObject({ mode: 'async', response: { taskIdPath: 'id' }, poll: {
        path: '/images/generations/{{submit.id}}', maxDurationMs: 3_600_000,
        response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed', 'cancelled'],
          result: { urlPath: 'result.data.*.url' } },
      } });
    },
  );

  it.each(['gpt-image-2.6-flare-official', 'gpt-image-2.6-sunburst-official'])(
    '%s 的默认质量、枚举、单次四张及参考上限在提交前校验', (id) => {
      const current = model(id);
      const capability = current.imageCapability!;
      const defaults = resolveConfiguredImageParameters(capability, { count: 1 });
      expect(defaults).toEqual({ imageSize: '1k', aspectRatio: '1:1', imageQuality: 'medium' });
      const request = (imageQuality: string, imageBackground?: string) => buildModelProtocolRequest({
        protocol: current.executionProfile!.protocol!, baseUrl: 'https://toapis.cn/v1', apiKey: 'fixture', variables: {
          model: id, prompt: 'test', n: 1, ...defaults, imageQuality, imageBackground,
        } }).renderedBody;
      expect(request(defaults.imageQuality!)).toEqual({ model: id, prompt: 'test', n: 1, size: '1:1',
        resolution: '1k', quality: 'medium', output_format: 'png' });
      for (const quality of capability.qualities!) {
        expect(request(resolveConfiguredImageQuality(capability, quality)!)).toMatchObject({ quality });
      }
      for (const background of capability.backgrounds!) {
        expect(request('medium', resolveConfiguredImageBackground(capability, background))).toMatchObject({ background, output_format: 'png' });
      }
      expect(resolveConfiguredImageParameters(capability, { imageSize: '4K', aspectRatio: 'auto', count: 4 }))
        .toMatchObject({ imageSize: '4k', aspectRatio: 'auto' });
      expect(() => resolveConfiguredImageParameters(capability, { count: 5 })).toThrow('最多生成 4');
      expect(() => resolveConfiguredImageParameters(capability, { imageSize: '8k', count: 1 })).toThrow('分辨率');
      expect(() => resolveConfiguredImageParameters(capability, { aspectRatio: '21:9', count: 1 })).toThrow('比例');
      expect(() => resolveConfiguredImageQuality(capability, 'ultra')).toThrow('质量');
      expect(() => resolveConfiguredImageBackground(capability, 'green')).toThrow('背景');
      expect(() => assertConfiguredImageReferences(capability, 16)).not.toThrow();
      expect(() => assertConfiguredImageReferences(capability, 17)).toThrow('最多支持 16');
    },
  );

  it('2.6 仅接受已公布的两个 official ID，认证目录仍决定是否可选', () => {
    const result = matchToapisCatalog(['gpt-image-2.6-flare-official', 'gpt-image-2.6-sunburst-official',
      'gpt-image-2.6-official', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'].map((id) => ({
      id, name: id, provider: 'my-toapis', category: 'text',
    })));
    expect(result.map((item) => [item.id, item.category, item.provider])).toEqual([
      ['gpt-image-2.6-flare-official', 'image', 'my-toapis'],
      ['gpt-image-2.6-sunburst-official', 'image', 'my-toapis'],
    ]);
  });

  it('2.6 用户修改过的路径或删掉质量／背景时不套用 2.5 旧协议升级', () => {
    const current = model('gpt-image-2.6-sunburst-official');
    for (const change of ['path', 'background', 'quality']) {
      const profile = structuredClone(current.executionProfile!);
      if (change === 'path') profile.protocol!.submit.path = '/custom/images';
      else delete (profile.protocol!.submit.body as Record<string, ProtocolJsonValue>)[change];
      const saved = JSON.stringify(profile);
      const resolved = resolveToapisImageModelContract(current.id, profile, {
        qualities: ['medium', 'high'], defaultQuality: 'high', backgrounds: ['opaque'],
      });
      expect(resolved.executionProfile).toBe(profile);
      expect(JSON.stringify(profile)).toBe(saved);
      if (change === 'quality') expect(resolved.imageCapability?.qualities).toBeUndefined();
      else expect(resolved.imageCapability?.qualities).toEqual(['medium', 'high']);
      if (change === 'background') expect(resolved.imageCapability?.backgrounds).toBeUndefined();
      else expect(resolved.imageCapability?.backgrounds).toEqual(['opaque']);
    }
  });

  it('只升级完整旧内置合同，保留持久化对象和用户自定义协议', () => {
    const current = model('gpt-image-2.5-sunburst-vip');
    const previous = structuredClone(current.executionProfile!);
    (previous.protocol!.submit.body as Record<string, ProtocolJsonValue>).quality = 'high';
    delete (previous.protocol!.submit.body as Record<string, ProtocolJsonValue>).background;
    const saved = JSON.stringify(previous);
    const resolved = resolveToapisImageModelContract(current.id, previous, { resolutions: ['2K'] });
    expect(resolved.executionProfile).toEqual(current.executionProfile);
    expect(resolved.imageCapability).toMatchObject({ resolutions: ['2K'],
      qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'high' });
    expect(JSON.stringify(previous)).toBe(saved);
    previous.protocol!.submit.path = '/custom/images/generations';
    const customized = resolveToapisImageModelContract(current.id, previous, { qualities: ['low', 'high'], defaultQuality: 'low' });
    expect(customized.executionProfile).toBe(previous);
    expect(customized.imageCapability).toMatchObject({ qualities: ['high'], defaultQuality: 'high' });
  });

  it('旧内置 GPT 2 VIP 无质量字段也精确升级，缺少查询字段的自定义协议保持原样', () => {
    const current = model('gpt-image-2-vip');
    const previous = structuredClone(current.executionProfile!);
    delete (previous.protocol!.submit.body as Record<string, ProtocolJsonValue>).quality;
    expect(resolveToapisImageModelContract(current.id, previous).executionProfile).toEqual(current.executionProfile);
    delete previous.protocol!.poll!.retry;
    const customized = resolveToapisImageModelContract(current.id, previous, { qualities: ['low', 'high'] });
    expect(customized.executionProfile).toBe(previous);
    expect(customized.imageCapability?.qualities).toBeUndefined();
  });

  it('用户自定义动态质量保留显式声明，不注入目录默认或更宽的选项', () => {
    const profile = structuredClone(model('gpt-image-2.5-sunburst-vip').executionProfile!);
    profile.protocol!.submit.path = '/custom/images/generations';
    const capability = { qualities: ['low', 'high'], defaultQuality: 'low' };
    expect(resolveToapisImageModelContract('gpt-image-2.5-sunburst-vip', profile, capability))
      .toEqual({ executionProfile: profile, imageCapability: capability });
    expect(resolveToapisImageModelContract('gpt-image-2.5-sunburst-vip', profile).imageCapability).toBeUndefined();
  });

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-vip', 'gpt-image-2.5-sunburst-vip',
    'gpt-image-2.5-flare-official', 'gpt-image-2.5-sunburst-official'])('%s 只声明透明背景且不默认发送背景或未公布的输出格式', (id) => {
    const current = model(id);
    expect(current.imageCapability?.backgrounds).toEqual(['transparent']);
    expect(current.imageCapability?.defaultBackground).toBeUndefined();
    const variables = { model: id, prompt: 'portrait', size: '2048x1152', imageSize: '2K', aspectRatio: '16:9', n: 1 };
    const request = (imageBackground?: string) => buildModelProtocolRequest({ protocol: current.executionProfile!.protocol!,
      baseUrl: 'https://toapis.cn/v1', apiKey: 'fixture', variables: { ...variables, imageBackground } }).renderedBody;
    expect(request()).not.toHaveProperty('background');
    expect(request()).not.toHaveProperty('output_format');
    expect(request('transparent')).toMatchObject({ background: 'transparent' });
    expect(request('transparent')).not.toHaveProperty('output_format');
  });

  it.each(['dynamic-quality', 'fixed-quality'])('完整兼容 %s 无背景旧合同，且不修改已保存对象', (version) => {
    const current = model('gpt-image-2.5-sunburst-vip');
    const previous = structuredClone(current.executionProfile!);
    const body = previous.protocol!.submit.body as Record<string, ProtocolJsonValue>;
    delete body.background;
    if (version === 'fixed-quality') body.quality = 'high';
    const saved = JSON.stringify(previous);
    const effective = resolveToapisImageModelContract(current.id, previous, { backgrounds: undefined });
    expect(effective.executionProfile).toEqual(current.executionProfile);
    expect(effective.imageCapability?.backgrounds).toEqual(['transparent']);
    expect(effective.imageCapability?.defaultBackground).toBeUndefined();
    expect(JSON.stringify(previous)).toBe(saved);
  });

  it('自定义背景按动态、固定和未映射三态处理，不把固定值变成可调', () => {
    const current = model('gpt-image-2.5-sunburst-vip');
    const profile = structuredClone(current.executionProfile!);
    profile.protocol!.submit.path = '/custom/images';
    const capability = { backgrounds: ['opaque', 'transparent'], defaultBackground: 'transparent' };
    expect(resolveToapisImageModelContract(current.id, profile, capability).imageCapability)
      .toMatchObject(capability);
    (profile.protocol!.submit.body as Record<string, ProtocolJsonValue>).background = 'opaque';
    const fixed = resolveToapisImageModelContract(current.id, profile, capability);
    expect(fixed.executionProfile).toBe(profile);
    expect(fixed.imageCapability).toMatchObject({ backgrounds: ['opaque'], defaultBackground: 'opaque' });
    delete (profile.protocol!.submit.body as Record<string, ProtocolJsonValue>).background;
    const unmapped = resolveToapisImageModelContract(current.id, profile, capability);
    expect(unmapped.executionProfile).toBe(profile);
    expect(unmapped.imageCapability?.backgrounds).toBeUndefined();
    expect(unmapped.imageCapability?.defaultBackground).toBeUndefined();
  });

  it('在付费提交前拒绝总数量与渠道组合错误，并明确修正项', () => {
    expect(() => assertToapisImageInput('doubao-seedream-5-0', 10, 6)).toThrow('合计最多 15');
    expect(() => assertToapisVideoInput(video('MiniMax-H3', [
      ...Array.from({ length: 9 }, (_, i) => ref('image', i)), ...Array.from({ length: 3 }, (_, i) => ref('video', i)), ref('audio', 0, 'reference_audio'),
    ]))).toThrow('合计最多 12');
    expect(() => assertToapisVideoInput(video('sora-2-official', [ref('image', 1)]))).toThrow('参考帧');
    expect(() => assertToapisVideoInput(video('seedance-2.5-ext', [ref('video', 1)], 15))).toThrow('不支持 15 秒');
  });

  it('Omni VIP 视频参考时省略不被接口接收的时长，Vidu Q4 音频位于 metadata', () => {
    const request = video('gemini-omni-1.1-flash-preview-vip', [ref('video', 1)]);
    const built = buildModelProtocolRequest({ protocol: model(request.modelId).executionProfile!.protocol!,
      baseUrl: 'https://toapis.com/v1', apiKey: 'fixture', variables: toapisVideoVariables(request, buildCanonicalVideoProtocolVariables(request)) });
    expect(built.renderedBody).not.toHaveProperty('duration');
    expect(built.renderedBody).toMatchObject({ video_urls: ['https://cdn.example/video-1'], aspect_ratio: '16:9' });
    const vidu = video('viduq4-preview', [ref('image', 1), ref('audio', 1, 'reference_audio')]);
    const viduBody = buildModelProtocolRequest({ protocol: model(vidu.modelId).executionProfile!.protocol!,
      baseUrl: 'https://toapis.cn/v1', apiKey: 'fixture', variables: toapisVideoVariables(vidu, buildCanonicalVideoProtocolVariables(vidu)) }).renderedBody;
    expect(viduBody).toMatchObject({ metadata: { sounds: ['https://cdn.example/audio-1'] } });
    expect(viduBody).not.toHaveProperty('sounds');
  });

  it('音乐查询从 result.music 提取音频，不把封面当生成结果', () => {
    const protocol = model('suno').executionProfile!.protocol!;
    expect((protocol.submit as ModelProtocolRequestTemplate).path).toBe('/music/generations/generation');
    const entries = previewModelProtocolResponse(protocol, { status: 'completed', result: { music: [
      { audio_url: 'https://cdn.example/one.mp3', image_url: 'https://cdn.example/cover.png' },
      { audio_url: 'https://cdn.example/two.mp3' },
    ] } });
    expect(entries.find((entry) => entry.id === 'poll-result-url')).toMatchObject({ values: ['https://cdn.example/one.mp3', 'https://cdn.example/two.mp3'] });
  });
});
