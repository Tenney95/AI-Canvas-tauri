import { beforeEach, describe, expect, it } from 'vitest';
import { buildGeneralVideoProtocolVariables } from '../../src/services/ai/generateVideo';
import { buildModelProtocolRequest } from '../../src/services/ai/modelProtocol';
import {
  clearProviderConfigDraftsForTests,
  createProviderConfigDraft,
  type ProviderConfigDraftInput,
} from '../../src/services/chat/providerConfigDraftService';
import type {
  ModelExecutionProtocol,
  VideoGenerationReferenceInput,
  VideoModelCapability,
} from '../../src/types/aiTypes';

const AGNES_CAPABILITY: VideoModelCapability = {
  operations: ['text-to-video', 'image-to-video'],
  resolutions: ['720P'],
  defaultResolution: '720P',
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  defaultRatio: '16:9',
  minDuration: 4,
  maxDuration: 12,
  defaultDuration: 5,
  allowFrameAndReferenceMix: false,
  maxImageReferences: 5,
  maxVideoReferences: 0,
};

const AGNES_PROTOCOL: ModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  auth: { type: 'bearer' },
  submit: {
    method: 'POST',
    path: '/videos',
    bodyEncoding: 'json',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      seconds: '{{durationText}}',
      mode: '{{videoInputMode}}',
      size: '{{seedanceResolution}}',
      aspect_ratio: '{{aspectRatio}}',
      n: 1,
      first_frame: '{{firstImage}}',
      last_frame: '{{lastImage}}',
      images: '{{referenceImageUrls}}',
      audios: '{{referenceAudioUrls}}',
    },
  },
  response: { type: 'json', taskIdPath: 'video_id' },
  poll: {
    method: 'GET',
    path: '/agnesapi',
    pathMode: 'origin',
    query: {
      video_id: '{{submit.video_id}}',
      model_name: '{{model}}',
    },
    response: {
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed', 'error'],
      result: { urlPath: 'metadata.url', mimeType: 'video/mp4' },
      errorPath: 'error.message',
      progressPath: 'progress',
    },
    intervalMs: 10_000,
  },
};

const METASO_CAPABILITY: VideoModelCapability = {
  operations: ['text-to-video', 'image-to-video', 'video-to-video'],
  resolutions: ['768P', '2K'],
  defaultResolution: '2K',
  ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  inputModeCapabilities: {
    text: {
      ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      defaultRatio: '16:9',
      requiresRatio: true,
    },
    keyframe: { ratios: ['adaptive'], defaultRatio: 'adaptive' },
    reference: {
      ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      defaultRatio: 'adaptive',
    },
  },
  minDuration: 4,
  maxDuration: 15,
  defaultDuration: 5,
  allowFrameAndReferenceMix: false,
  maxImageReferences: 9,
  maxVideoReferences: 3,
  maxAudioReferences: 3,
  inputConstraints: {
    referenceVideo: {
      durationSeconds: { min: 2, max: 15 },
      totalDurationSeconds: { max: 15 },
    },
    referenceAudio: {
      durationSeconds: { min: 2, max: 15 },
      totalDurationSeconds: { max: 15 },
    },
  },
};

const METASO_PROTOCOL: ModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  auth: { type: 'bearer' },
  submit: {
    method: 'POST',
    path: '/video_generation',
    bodyEncoding: 'json',
    maxBodyBytes: 64 * 1024 * 1024,
    body: {
      model: '{{model}}',
      content: [
        { type: 'text', text: '{{prompt}}' },
        {
          $whenPresent: '{{firstImage}}',
          $value: {
            type: 'image_url',
            image_url: { url: '{{firstImage}}' },
            role: 'first_frame',
          },
        },
        {
          $whenPresent: '{{lastImage}}',
          $value: {
            type: 'image_url',
            image_url: { url: '{{lastImage}}' },
            role: 'last_frame',
          },
        },
        {
          $forEach: '{{referenceImageUrls}}',
          $value: {
            type: 'image_url',
            image_url: { url: '{{referenceImageUrls}}' },
            role: 'reference_image',
          },
        },
        {
          $forEach: '{{referenceVideoUrls}}',
          $value: {
            type: 'video_url',
            video_url: { url: '{{referenceVideoUrls}}' },
            role: 'reference_video',
          },
        },
        {
          $forEach: '{{referenceAudioUrls}}',
          $value: {
            type: 'audio_url',
            audio_url: { url: '{{referenceAudioUrls}}' },
            role: 'reference_audio',
          },
        },
      ],
      resolution: '{{seedanceResolution}}',
      duration: '{{duration}}',
      ratio: '{{aspectRatio}}',
    },
  },
  response: { type: 'json', taskIdPath: 'task_id' },
  poll: {
    method: 'GET',
    path: '/query/video_generation/{{submit.task_id}}',
    response: {
      statusPath: 'task.status',
      successValues: ['completed', 'succeeded', 'success', 'done'],
      failureValues: ['failed', 'error', 'canceled', 'cancelled'],
      result: { urlPath: 'task.content.url', mimeType: 'video/mp4' },
      errorPath: 'task.error.message',
    },
    intervalMs: 3_000,
  },
};

function previewModel(input: ProviderConfigDraftInput) {
  const draft = createProviderConfigDraft('custom-video-contract', input);
  const model = draft.config.selectedModels?.[0];
  if (model?.executionProfile?.preset !== 'custom' || !model.executionProfile.protocol) {
    throw new Error('配置草稿没有生成可执行协议');
  }
  return { draft, model, protocol: model.executionProfile.protocol };
}

function variables(
  modelId: string,
  capability: VideoModelCapability,
  referenceInput: VideoGenerationReferenceInput,
) {
  return buildGeneralVideoProtocolVariables(modelId, {
    provider: 'general',
    model: `general/${modelId}`,
    prompt: referenceInput.prompt,
  }, referenceInput, capability);
}

beforeEach(() => clearProviderConfigDraftsForTests());

describe('custom video relay contracts', () => {
  it('previews Agnes 2.5 with /videos, string seconds and mutually exclusive input fields', () => {
    const { draft, protocol } = previewModel({
      connectionName: 'Agnes AI',
      baseUrl: 'https://api.agnes-ai.cn/v1',
      models: [{
        protocolSource: 'declarative',
        modelId: 'agnes-video-2.5-flash',
        name: 'Agnes Video 2.5 Flash',
        category: 'video',
        videoCapability: AGNES_CAPABILITY,
        executionProtocol: AGNES_PROTOCOL,
      }],
    });

    const keyframeVariables = variables('agnes-video-2.5-flash', AGNES_CAPABILITY, {
      prompt: '首尾帧过渡',
      imageUrls: ['https://assets.example/first.png', 'https://assets.example/last.png'],
      videoUrls: [],
      audioUrls: [],
      operation: 'image-to-video',
      references: [
        { kind: 'image', url: 'https://assets.example/first.png', origin: 'connection', role: 'first_frame' },
        { kind: 'image', url: 'https://assets.example/last.png', origin: 'connection', role: 'last_frame' },
      ],
    });
    const request = buildModelProtocolRequest({
      apiKey: 'test-key',
      baseUrl: draft.baseUrl,
      protocol,
      variables: keyframeVariables,
    });

    expect(request.url).toBe('https://api.agnes-ai.cn/v1/videos');
    expect(request.renderedBody).toEqual({
      model: 'agnes-video-2.5-flash',
      prompt: '首尾帧过渡',
      seconds: '5',
      mode: 'keyframe',
      size: '720P',
      aspect_ratio: '16:9',
      n: 1,
      first_frame: 'https://assets.example/first.png',
      last_frame: 'https://assets.example/last.png',
    });
    expect(protocol.version).toBe(2);
    if (protocol.version !== 2) throw new Error('Agnes 草稿必须归一化为 V2 协议');
    expect(protocol.poll?.response.result.urlPath).toBe('metadata.url');
    expect(protocol.poll?.response.errorPath).toBe('error.message');
  });

  it('previews MetaSo MiniMax-H3 with full content-array expansion and dynamic task polling', () => {
    const { draft, protocol } = previewModel({
      connectionName: 'MetaSo MiniMax',
      baseUrl: 'https://metaso.cn/api/minimax/v2',
      models: [{
        protocolSource: 'declarative',
        modelId: 'MiniMax-H3',
        name: 'MiniMax H3',
        category: 'video',
        videoCapability: METASO_CAPABILITY,
        executionProtocol: METASO_PROTOCOL,
      }],
    });
    const referenceVariables = variables('MiniMax-H3', METASO_CAPABILITY, {
      prompt: '参考素材驱动的镜头',
      imageUrls: ['https://assets.example/ref-1.png', 'https://assets.example/ref-2.png'],
      videoUrls: ['https://assets.example/ref.mp4'],
      audioUrls: ['https://assets.example/ref.mp3'],
      operation: 'video-to-video',
      references: [
        { kind: 'image', url: 'https://assets.example/ref-1.png', origin: 'connection', role: 'reference' },
        { kind: 'image', url: 'https://assets.example/ref-2.png', origin: 'connection', role: 'reference' },
        { kind: 'video', url: 'https://assets.example/ref.mp4', origin: 'connection', role: 'reference' },
        { kind: 'audio', url: 'https://assets.example/ref.mp3', origin: 'connection', role: 'reference_audio' },
      ],
    });
    const request = buildModelProtocolRequest({
      apiKey: 'test-key',
      baseUrl: draft.baseUrl,
      protocol,
      variables: referenceVariables,
    });

    expect(request.url).toBe('https://metaso.cn/api/minimax/v2/video_generation');
    expect(request.renderedBody).toEqual({
      model: 'MiniMax-H3',
      content: [
        { type: 'text', text: '参考素材驱动的镜头' },
        { type: 'image_url', image_url: { url: 'https://assets.example/ref-1.png' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'https://assets.example/ref-2.png' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'https://assets.example/ref.mp4' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'https://assets.example/ref.mp3' }, role: 'reference_audio' },
      ],
      resolution: '2K',
      duration: 5,
      ratio: 'adaptive',
    });
    expect(protocol.poll?.path).toBe('/query/video_generation/{{submit.task_id}}');
  });
});
