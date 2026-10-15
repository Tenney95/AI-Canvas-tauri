import { describe, expect, it } from 'vitest';
import {
  applyH3TemplateDefaults,
  createH3QuickAdaptTemplate,
  getOfficialH3Capability,
  H3_QUICK_ADAPT_OPTIONS,
  inferH3ModelVariant,
  resolveH3AutoTemplate,
} from '../../src/services/ai/h3ModelCapabilities';
import { buildGeneralVideoProtocolVariables } from '../../src/services/ai/generateVideo';
import { buildModelProtocolRequest } from '../../src/services/ai/modelProtocol';
import type { VideoModelCapability } from '../../src/types/aiTypes';
import type { ProviderModelSelection } from '../../src/types';

describe('MiniMax H3 capability templates', () => {
  it('separates H3 and H3-Max official capability limits', () => {
    expect(getOfficialH3Capability('h3-standard')).toMatchObject({
      resolutions: ['768P', '2K'],
      minDuration: 4,
      maxDuration: 15,
      maxImageReferences: 9,
      maxVideoReferences: 3,
      maxAudioReferences: 3,
      allowFrameAndReferenceMix: false,
      inputModeCapabilities: {
        text: { requiresRatio: true },
        keyframe: { ratios: ['adaptive'] },
        reference: { defaultRatio: 'adaptive' },
      },
    });
    expect(getOfficialH3Capability('h3-max')).toMatchObject({
      resolutions: ['480P', '768P'],
      minDuration: 5,
      maxDuration: 15,
    });
  });

  it('builds MiniMax and AI Ping content-array transports with distinct paths', () => {
    const minimax = createH3QuickAdaptTemplate('h3-standard', 'minimax');
    const aiping = createH3QuickAdaptTemplate('h3-max', 'aiping');
    expect(minimax.executionProfile.protocol).toMatchObject({
      submit: { path: '/v2/video_generation', pathMode: 'origin' },
      response: { taskIdPath: 'task_id' },
      poll: {
        path: '/v2/query/video_generation/{{submit.task_id}}',
        response: { result: { urlPath: 'task.content.url' } },
      },
    });
    expect(aiping.executionProfile.protocol).toMatchObject({
      submit: { path: '/api/v1/multimodal/minimax/videos/video_generation' },
      poll: {
        path: '/api/v1/multimodal/minimax/videos/query/video_generation/{{submit.task_id}}',
      },
    });
  });

  it('expands all H3 reference media exactly once in the official content body', () => {
    const template = createH3QuickAdaptTemplate('h3-standard', 'minimax');
    const protocol = template.executionProfile.protocol;
    if (!protocol) throw new Error('H3 template protocol missing');
    const variables = buildGeneralVideoProtocolVariables('MiniMax-H3', {
      provider: 'general',
      model: 'general/MiniMax-H3',
      prompt: '参考素材驱动镜头',
      seedanceResolution: '2K',
      seedanceRatio: 'adaptive',
      seedanceDuration: 5,
    }, {
      prompt: '参考素材驱动镜头',
      imageUrls: ['https://assets.example/ref.png'],
      videoUrls: ['https://assets.example/ref.mp4'],
      audioUrls: ['https://assets.example/ref.mp3'],
      operation: 'video-to-video',
      references: [
        { kind: 'image', url: 'https://assets.example/ref.png', origin: 'connection', role: 'reference' },
        { kind: 'video', url: 'https://assets.example/ref.mp4', origin: 'connection', role: 'reference' },
        { kind: 'audio', url: 'https://assets.example/ref.mp3', origin: 'connection', role: 'reference_audio' },
      ],
    }, template.capability);
    const request = buildModelProtocolRequest({
      apiKey: 'test-key',
      baseUrl: 'https://api.minimax.io',
      protocol,
      variables,
    });

    expect(request.url).toBe('https://api.minimax.io/v2/video_generation');
    expect(request.renderedBody).toMatchObject({
      model: 'MiniMax-H3',
      resolution: '2K',
      duration: 5,
      ratio: 'adaptive',
      content: [
        { type: 'text', text: '参考素材驱动镜头' },
        { type: 'image_url', role: 'reference_image' },
        { type: 'video_url', role: 'reference_video' },
        { type: 'audio_url', role: 'reference_audio' },
      ],
    });
  });

  it('keeps APIMart flat fields and concrete ratio overlay', () => {
    const template = createH3QuickAdaptTemplate('h3-standard', 'apimart');
    expect(template.capability.ratios).not.toContain('adaptive');
    expect(template.executionProfile.protocol).toMatchObject({
      submit: {
        path: '/v1/videos/generations',
        body: {
          first_frame_image: '{{firstImage}}',
          image_urls: '{{referenceImageUrls}}',
        },
      },
      poll: { path: '/v1/tasks/{{submit.data.0.task_id}}' },
    });
  });

  it('matches verified gateways', () => {
    expect(resolveH3AutoTemplate({
      modelId: 'MiniMax-H3-Max',
      baseUrl: 'https://api.aiping.cn/v1',
    })).toMatchObject({
      model: 'h3-max',
      templateId: 'h3-max:aiping',
      executionProfile: { preset: 'custom' },
    });
  });

  it.each([undefined, 'https://relay.example.com/v1', 'invalid-url'])(
    'does not infer capabilities or a protocol for an unverified relay: %s', (baseUrl) => {
      expect(resolveH3AutoTemplate({ modelId: 'MiniMax-H3', baseUrl })).toBeUndefined();
      const input: ProviderModelSelection = {
        id: 'MiniMax-H3', name: 'H3', provider: 'custom-test', category: 'video',
      };
      expect(applyH3TemplateDefaults(input, baseUrl)).toBe(input);
    },
  );

  it('uses an explicit template for an unverified relay and clones explicit capabilities', () => {
    const capability: VideoModelCapability = { operations: ['text-to-video'], durations: [8] };
    const before = structuredClone(capability);
    const match = resolveH3AutoTemplate({
      modelId: 'MiniMax-H3', baseUrl: 'https://relay.example.com/v1',
      templateId: 'h3-standard:minimax', capability,
    });
    expect(match?.templateId).toBe('h3-standard:minimax');
    expect(match?.executionProfile?.protocol?.submit.path).toBe('/v2/video_generation');
    expect(match?.capability).toEqual(capability);
    expect(match?.capability).not.toBe(capability);
    expect(capability).toEqual(before);
  });

  it('fills capabilities together with a verified transport when no protocol was configured', () => {
    const model = applyH3TemplateDefaults({
      id: 'MiniMax-H3', name: 'H3', provider: 'custom-test', category: 'video',
    }, 'https://api.minimax.io');
    expect(model.videoCapability?.resolutions).toEqual(['768P', '2K']);
    expect(model.videoCapability?.supportsAudio).toBeUndefined();
    expect(model.executionProfile?.protocol?.submit.path).toBe('/v2/video_generation');
  });

  it.each([undefined, true, false])(
    'does not mix capabilities into an existing protocol or mutate an explicit audio value: %s', (supportsAudio) => {
      const input: ProviderModelSelection = {
        id: 'MiniMax-H3', name: 'H3', provider: 'custom-test', category: 'video',
        executionProfile: { preset: 'custom', protocol: {
          version: 2, mode: 'sync', submit: { method: 'POST', path: '/private/video' },
          response: { type: 'json', result: { urlPath: 'url' } },
        } },
        ...(supportsAudio === undefined ? {} : { videoCapability: { supportsAudio } }),
      };
      const before = structuredClone(input);
      const model = applyH3TemplateDefaults(input, 'https://api.minimax.io');
      expect(model.videoCapability).toBe(input.videoCapability);
      expect(model.executionProfile).toBe(input.executionProfile);
      expect(input).toEqual(before);
    },
  );

  it('respects an explicit non-video manual category', () => {
    const input: ProviderModelSelection = {
      id: 'MiniMax-H3', name: 'Not a video model here', provider: 'custom-test',
      category: 'text', categoryManual: true,
    };
    expect(applyH3TemplateDefaults(input, 'https://api.minimax.io')).toBe(input);
  });

  it('does not accept an invalid explicit template as evidence of an unknown transport', () => {
    expect(resolveH3AutoTemplate({
      modelId: 'MiniMax-H3', baseUrl: 'https://relay.example.com/v1', templateId: 'invalid-template',
    })).toBeUndefined();
  });

  it('does not treat Context-IR or Regeneration as ordinary video generation', () => {
    expect(inferH3ModelVariant('MiniMax-H3')).toBe('h3-standard');
    expect(inferH3ModelVariant('minimax/hailuo-h3-max')).toBe('h3-max');
    expect(inferH3ModelVariant('MiniMax-H3-Context-IR')).toBeUndefined();
    expect(inferH3ModelVariant('MiniMax-H3-Regeneration')).toBeUndefined();
  });

  it('preserves explicit configuration and exposes all six templates', () => {
    const capability: VideoModelCapability = {
      operations: ['text-to-video'],
      durations: [8],
    };
    const model = applyH3TemplateDefaults({
      id: 'MiniMax-H3',
      name: 'H3',
      provider: 'custom-test',
      category: 'video',
      videoCapability: capability,
    }, 'https://api.minimax.io');
    expect(model.videoCapability).toBe(capability);
    expect(model.executionProfile?.protocol?.submit.path).toBe('/v2/video_generation');
    expect(H3_QUICK_ADAPT_OPTIONS).toHaveLength(6);
  });
});
