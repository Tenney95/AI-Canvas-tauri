import { describe, expect, it } from 'vitest';
import {
  MINIMAX_BASE_URL, MINIMAX_MODEL_MANIFEST, assertMinimaxResponse, assertMinimaxQueryResponse,
  getMinimaxAudioCapability, minimaxAudioVariables, minimaxVideoVariables, resolveMinimaxBaseUrl,
  resolveMinimaxExecutionProfile, usesMinimaxModelProtocol, usesMinimaxResolvedVideoPoll,
  getMinimaxMediaAccessHint,
} from '../../src/services/ai/providers/minimaxModelManifest';
import { resolveCanonicalVideoRequest } from '../../src/services/ai/videoRequestResolver';
import { buildModelProtocolRequest, resolveModelExecutionProfile, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import { resolvePoll } from '../../src/services/ai/modelProtocolPoll';
import type { MediaReference } from '../../src/types/aiTypes';

describe('MiniMax 官方目录与协议', () => {
  it('只列出四种 H3 和两种 Speech，不携带凭据或冒充远端目录', () => {
    expect(MINIMAX_MODEL_MANIFEST.map((model) => [model.id, model.category])).toEqual([
      ['MiniMax-H3', 'video'], ['MiniMax-H3-Highspeed', 'video'], ['MiniMax-H3-Lite', 'video'], ['MiniMax-H3-Max', 'video'],
      ['speech-2.8-hd', 'audio'], ['speech-2.8-turbo', 'audio'],
    ]);
    for (const model of MINIMAX_MODEL_MANIFEST) {
      expect(validateModelExecutionProtocol(model.executionProfile!.protocol!)).toEqual([]);
      expect(model).not.toHaveProperty('apiKey');
      expect(model.videoCapability?.supportsAudio).toBeUndefined();
    }
  });

  it.each([
    ['MiniMax-H3', ['768P', '2K'], 4], ['MiniMax-H3-Highspeed', ['480P', '768P'], 4],
    ['MiniMax-H3-Lite', ['480P', '768P'], 4], ['MiniMax-H3-Max', ['480P', '768P'], 5],
  ] as const)('%s 具有自己的分辨率与时长合同', (id, resolutions, minimum) => {
    const model = MINIMAX_MODEL_MANIFEST.find((item) => item.id === id)!;
    expect(model.videoCapability).toMatchObject({ resolutions: [...resolutions], minDuration: minimum, maxDuration: 15,
      maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3, allowFrameAndReferenceMix: false });
    expect(model.videoCapability!.inputModeCapabilities!.reference!.ratios!.includes('adaptive')).toBe(id !== 'MiniMax-H3-Lite');
  });

  it('缺省协议使用临时副本；自定义的相同型号和显式修改不被重写', () => {
    const profile = resolveMinimaxExecutionProfile('MiniMax-H3')!;
    expect(usesMinimaxModelProtocol('MiniMax-H3', profile)).toBe(true);
    expect(usesMinimaxModelProtocol('MiniMax-H3')).toBe(false);
    profile.protocol!.submit.path = '/my-task';
    expect(resolveMinimaxExecutionProfile('MiniMax-H3', profile)).toBe(profile);
    expect(usesMinimaxModelProtocol('MiniMax-H3', profile)).toBe(false);
    expect(resolveMinimaxExecutionProfile('MiniMax-H3')!.protocol!.submit.path).toBe('/v2/video_generation');
    expect(resolveMinimaxExecutionProfile('minimax-h3')).toBeUndefined();
  });

  it('国内／国际站使用独立官方 origin，不接受别站、凭据或地址参数', () => {
    expect(resolveMinimaxBaseUrl()).toBe(MINIMAX_BASE_URL);
    expect(resolveMinimaxBaseUrl(' https://api.minimax.io/v1/ ')).toBe('https://api.minimax.io');
    for (const url of ['http://api.minimax.cn', 'https://api.minimax.cn.attacker.example', 'https://api.minimax.cn/path',
      'https://api.minimax.cn?key=fixture', 'https://api.minimax.cn/#x', 'https://user:secret@api.minimax.cn', 'https://api.minimaxi.com']) {
      expect(() => resolveMinimaxBaseUrl(url)).toThrow('MiniMax');
    }
  });

  it('首帧引用保留已上传的 mm_file 地址，尾帧单独输入在提交前拒绝', () => {
    const references: MediaReference[] = [{ kind: 'image', url: 'https://reference.example/first.png', origin: 'prompt', role: 'first_frame' }];
    const request = resolveCanonicalVideoRequest({ provider: 'general', model: 'MiniMax-H3', prompt: '人物自然眨眼',
      seedanceResolution: '768P', seedanceDuration: 5, seedanceRatio: 'adaptive' }, { references });
    const variables = minimaxVideoVariables(request, { prompt: request.prompt, firstImage: 'mm_file://9223372036854775806' });
    expect(variables).toMatchObject({ firstImage: 'mm_file://9223372036854775806', aspectRatio: 'adaptive', duration: 5, seedanceResolution: '768P' });
    request.references.images[0].role = 'last_frame';
    expect(() => minimaxVideoVariables(request, variables)).toThrow('尾帧须与首帧配对');
  });

  it('官方生成与原任务查询合同完整匹配，后改协议、跨站身份和额外头均不能借用原生恢复', () => {
    const profile = resolveMinimaxExecutionProfile('MiniMax-H3')!;
    const protocol = resolveModelExecutionProfile(profile)!;
    const poll = resolvePoll(MINIMAX_BASE_URL, protocol.poll!, protocol.auth, { submit: { task_id: 'original-task' } });
    expect(usesMinimaxResolvedVideoPoll(poll, 'original-task', MINIMAX_BASE_URL)).toBe(true);
    expect(usesMinimaxResolvedVideoPoll({ ...poll, intervalMs: 1, maxDurationMs: 999, retry: { maxRetries: 0 } }, 'original-task')).toBe(true);
    expect(usesMinimaxResolvedVideoPoll(poll, 'other-task')).toBe(false);
    expect(usesMinimaxResolvedVideoPoll(poll, 'original-task', 'https://api.minimax.io')).toBe(false);
    expect(usesMinimaxResolvedVideoPoll({ ...poll, url: `${poll.url}?key=fixture` }, 'original-task')).toBe(false);
    expect(usesMinimaxResolvedVideoPoll({ ...poll, headers: { 'X-Extra': 'fixture' } }, 'original-task')).toBe(false);
    expect(usesMinimaxResolvedVideoPoll({ ...poll, resultUrlPath: 'another.url' }, 'original-task')).toBe(false);
  });
});

describe('MiniMax 官方语音', () => {
  it.each(['speech-2.8-hd', 'speech-2.8-turbo'])('%s 使用真实音色 ID、语速和 URL 交付', (modelId) => {
    const capability = getMinimaxAudioCapability(modelId)!;
    expect(capability).toMatchObject({ kind: 'speech', voiceInput: 'id', formats: ['mp3', 'wav', 'flac'],
      speed: { min: 0.5, max: 2 }, supportsVoiceReference: false });
    const variables = minimaxAudioVariables(modelId, { prompt: '你好', audioVoice: 'my-existing-voice', audioFormat: 'flac', audioSpeed: 1.25 });
    const request = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: MINIMAX_BASE_URL,
      protocol: resolveMinimaxExecutionProfile(modelId)!.protocol!, variables });
    expect(request.url).toBe(`${MINIMAX_BASE_URL}/v1/t2a_v2`);
    expect(JSON.parse(String(request.init.body))).toEqual({ model: modelId, text: '你好', stream: false, output_format: 'url',
      voice_setting: { voice_id: 'my-existing-voice', speed: 1.25 }, audio_setting: { format: 'flac' } });
    expect(minimaxAudioVariables(modelId, { prompt: '你好' })).toMatchObject({ audioVoice: 'male-qn-qingse', audioFormat: 'mp3', audioSpeed: 1 });
  });

  it('提交前拒绝克隆引用、PCM、音乐参数和非法语速', () => {
    for (const patch of [{ audioFormat: 'pcm' }, { audioSpeed: 2.1 }, { musicDuration: 30 }, { musicLyrics: '歌词' },
      { audioUrls: ['https://reference.example/voice.wav'] }]) {
      expect(() => minimaxAudioVariables('speech-2.8-hd', { prompt: '你好', ...patch })).toThrow('MiniMax');
    }
    expect(getMinimaxAudioCapability('speech-2.8-other')).toBeUndefined();
  });
});

describe('MiniMax 业务状态与安全原因', () => {
  it.each([1004, 1008, 2013, 2049])('明确拒绝码 %s 保留终态分类而不回显上游敏感文本', (code) => {
    expect(() => assertMinimaxResponse({ base_resp: { status_code: code, status_msg: 'https://secret.example/raw?key=private' } }))
      .toThrow(expect.objectContaining({ definitiveFailure: true, status: 200 }));
    try { assertMinimaxResponse({ base_resp: { status_code: code, status_msg: 'private-fixture' } }); }
    catch (error) { expect(String(error)).not.toContain('private-fixture'); }
  });

  it.each([1000, 1001, 1024, 1033, 2066, 9999])('未知或服务端处理码 %s 不声称确定未提交', (code) => {
    expect(() => assertMinimaxResponse({ base_resp: { status_code: code, status_msg: 'media url unreachable' } }))
      .toThrow(expect.objectContaining({ definitiveFailure: false }));
  });

  it('code0 可交付，查询终态先让任务失败判定执行，素材不可达提示不带原链接', () => {
    expect(getMinimaxMediaAccessHint('media url unreachable: https://secret.example/image?token=private')).toContain('重新上传');
    expect(getMinimaxMediaAccessHint('media url unreachable: https://secret.example/image?token=private')).not.toContain('secret.example');
    expect(getMinimaxMediaAccessHint('a different error')).toBeUndefined();
    expect(() => assertMinimaxResponse({ base_resp: { status_code: 0 } })).not.toThrow();
    expect(() => assertMinimaxResponse({ data: { audio: 'https://cdn.example/unconfirmed.mp3' } }, true)).toThrow('有效业务状态码');
    expect(() => assertMinimaxQueryResponse({ task: { status: 'failed' }, base_resp: { status_code: 1000 } })).not.toThrow();
    expect(() => assertMinimaxQueryResponse({ task: { status: 'succeeded' }, base_resp: { status_code: 1004 } }))
      .toThrow(expect.objectContaining({ definitiveFailure: true }));
    expect(() => assertMinimaxQueryResponse({ task: { status: 'failed', error: {
      message: 'media url unreachable: https://secret.example/image?token=private',
    } } })).toThrow(expect.objectContaining({ name: 'PollTaskFailedError', message: expect.stringContaining('重新上传') }));
  });
});
