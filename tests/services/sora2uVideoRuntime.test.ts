import { describe, expect, it } from 'vitest';
import {
  assertVideoReferenceLimits,
  buildGeneralVideoProtocolVariables,
} from '../../src/services/ai/generateVideo';
import { SORA2U_MODEL_MANIFEST } from '../../src/services/ai/providers/sora2uModelManifest';
import type { VideoGenerationReferenceInput } from '../../src/types/aiTypes';

function capabilityFor(modelId: string) {
  const capability = SORA2U_MODEL_MANIFEST.find((model) => model.id === modelId)
    ?.videoCapability;
  if (!capability) throw new Error(`模型 ${modelId} 没有视频能力`);
  return capability;
}

describe('Sora2U 通用视频运行时映射', () => {
  it('为全部 Sora2U 视频模型声明统一的提交前素材约束', () => {
    const videoCapabilities = SORA2U_MODEL_MANIFEST
      .filter((model) => model.category === 'video')
      .map((model) => model.videoCapability?.inputConstraints);

    expect(videoCapabilities).toHaveLength(7);
    for (const constraints of videoCapabilities) {
      expect(constraints).toEqual({
        promptMinCharacters: 10,
        maxBase64DecodedBytes: 20 * 1024 * 1024,
        referenceVideo: {
          width: { min: 300 },
          durationSeconds: { max: 15, maxExclusive: true },
        },
        referenceAudio: {
          durationSeconds: { min: 3, max: 15, maxExclusive: true },
        },
      });
    }
  });

  it('把公网和 data URL 参考素材拆到对应请求数组', () => {
    const references: VideoGenerationReferenceInput = {
      prompt: '保持角色与动作一致',
      imageUrls: ['https://assets.example/character.png'],
      videoUrls: ['data:video/mp4;base64,VklERU8='],
      audioUrls: ['https://assets.example/voice.mp3'],
      operation: 'video-to-video',
    };

    const variables = buildGeneralVideoProtocolVariables('seedance-2.0', {
      model: 'general/sora2u-seedance',
      provider: 'general',
      prompt: references.prompt,
      seedanceDuration: 12,
      seedanceRatio: '9:16',
      seedanceResolution: '720p',
      generateAudio: false,
    }, references, capabilityFor('seedance-2.0'));

    expect(variables.referenceUrls).toEqual([
      'https://assets.example/character.png',
      'https://assets.example/voice.mp3',
    ]);
    expect(variables.inlineReferences).toEqual(['data:video/mp4;base64,VklERU8=']);
    expect(variables.disableAudio).toBe(true);
  });

  it('允许 Seedance 2.0 文生视频，但阻止 1.5 与 2.5 无参考提交', () => {
    const empty: VideoGenerationReferenceInput = {
      prompt: '电影感城市航拍镜头',
      imageUrls: [],
      videoUrls: [],
      audioUrls: [],
      operation: 'text-to-video',
    };

    expect(() => assertVideoReferenceLimits(empty, capabilityFor('seedance-2.0'), 'Seedance 2.0'))
      .not.toThrow();
    expect(() => assertVideoReferenceLimits(empty, capabilityFor('seedance-1.5'), 'Seedance 1.5'))
      .toThrow('至少需要一份参考素材');
    expect(() => assertVideoReferenceLimits(empty, capabilityFor('seedance-2.5'), 'Seedance 2.5'))
      .toThrow('至少需要一份参考素材');
  });
});
