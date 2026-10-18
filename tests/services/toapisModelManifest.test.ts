import { describe, expect, it } from 'vitest';
import { TOAPIS_MODEL_MANIFEST, TOAPIS_TEXT_MODEL_IDS, assertToapisImageInput, assertToapisVideoInput,
  matchToapisCatalog, toapisImageReferences, toapisVideoVariables } from '../../src/services/ai/providers/toapisModelManifest';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { buildModelProtocolRequest, previewModelProtocolResponse, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import { findUnusedReferenceVariables } from '../../src/services/ai/modelProtocolRuntime';
import { buildCanonicalVideoProtocolVariables } from '../../src/services/ai/generateVideo';
import { assertVideoModelCapability, resolveCanonicalVideoRequest } from '../../src/services/ai/videoRequestResolver';
import type { MediaReference, ModelProtocolRequestTemplate } from '../../src/types/aiTypes';

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
