import { describe, expect, it } from 'vitest';
import type {
  AIVideoGenParams,
  MediaReference,
  VideoModelCapability,
} from '../../src/types/aiTypes';
import {
  resolveCanonicalVideoRequest,
  resolveVideoSubmissionControls,
  toResolvedVideoCompatibilityValues,
  VideoRequestResolutionError,
  type VideoRequestResolutionErrorCode,
} from '../../src/services/ai/videoRequestResolver';

describe('resolveVideoSubmissionControls', () => {
  it('preserves unspecified fields and a 30 second request for direct general protocols', () => {
    expect(resolveVideoSubmissionControls({
      provider: 'general',
      videoFrames: 77,
      seedanceDuration: 30,
    })).toEqual({
      videoResolution: undefined,
      videoFps: undefined,
      videoFrames: undefined,
      seedanceResolution: undefined,
      seedanceRatio: undefined,
      seedanceDuration: 30,
    });
  });

  it('keeps legacy defaults and duration normalization for built-in/workflow paths', () => {
    expect(resolveVideoSubmissionControls({
      provider: 'volcengine',
      seedanceDuration: 30,
    })).toEqual({
      videoResolution: 832,
      videoFps: 24,
      videoFrames: 361,
      seedanceResolution: '720p',
      seedanceRatio: '16:9',
      seedanceDuration: 15,
    });
  });
});

function params(overrides: Partial<AIVideoGenParams> = {}): AIVideoGenParams {
  return {
    prompt: '镜头缓慢向前推进',
    model: 'custom-video-model',
    provider: 'custom-provider',
    ...overrides,
  };
}

function reference(
  kind: MediaReference['kind'],
  url: string,
  role: MediaReference['role'] = kind === 'audio' ? 'reference_audio' : 'reference',
): MediaReference {
  return {
    kind,
    url,
    role,
    origin: 'connection',
  };
}

function expectResolutionError(
  action: () => unknown,
  code: VideoRequestResolutionErrorCode,
): VideoRequestResolutionError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(VideoRequestResolutionError);
    expect(error).toMatchObject({ code });
    return error as VideoRequestResolutionError;
  }
  throw new Error(`Expected ${code} but no error was thrown`);
}

const CAPABILITY: VideoModelCapability = {
  resolutions: ['720p', '1080p'],
  defaultResolution: '720p',
  ratios: ['16:9', '9:16'],
  defaultRatio: '16:9',
  frameRates: [24, 30],
  defaultFrameRate: 30,
  minDuration: 5,
  maxDuration: 30,
  defaultDuration: 6,
  supportsAudio: true,
  maxImageReferences: 2,
  maxVideoReferences: 1,
  maxAudioReferences: 1,
};

describe('resolveCanonicalVideoRequest', () => {
  it('uses capability defaults and emits provider-neutral output fields', () => {
    const result = resolveCanonicalVideoRequest(params(), { capability: CAPABILITY });

    expect(result).toMatchObject({
      modelId: 'custom-video-model',
      prompt: '镜头缓慢向前推进',
      operation: 'text-to-video',
      output: {
        aspectRatio: '16:9',
        resolutionPreset: '720p',
        pixelDimensions: null,
        durationSeconds: 6,
        requestedFrameRate: 30,
        frameCount: null,
        candidateCount: 1,
        audio: { policy: 'model-default', referenceCount: 0 },
      },
      sources: {
        aspectRatio: 'capability-default',
        resolutionPreset: 'capability-default',
        durationSeconds: 'capability-default',
        requestedFrameRate: 'capability-default',
        frameCount: 'unspecified',
      },
    });
    expect(result.output).not.toHaveProperty('seedanceResolution');
    expect(result.output).not.toHaveProperty('seedanceDuration');
  });

  it('accepts a declared 30 second request without the legacy global 15 second clamp', () => {
    const result = resolveCanonicalVideoRequest(params({
      seedanceRatio: '16:9',
      seedanceResolution: '1080p',
      seedanceDuration: 30,
      videoResolution: 1280,
      videoFps: 24,
      generateAudio: true,
    }), { capability: CAPABILITY });

    expect(result.output).toEqual({
      aspectRatio: '16:9',
      resolutionPreset: '1080p',
      pixelDimensions: { width: 1280, height: 720 },
      durationSeconds: 30,
      requestedFrameRate: 24,
      frameCount: null,
      candidateCount: 1,
      audio: { policy: 'generate', referenceCount: 0 },
    });
    expect(toResolvedVideoCompatibilityValues(result).frameCount).toBe(721);
  });

  it('keeps explicit frame count separate and only derives duration for legacy frame-only input', () => {
    const result = resolveCanonicalVideoRequest(params({ videoFrames: 121, videoFps: 24 }), {
      capability: { ...CAPABILITY, defaultDuration: undefined },
    });

    expect(result.output.durationSeconds).toBe(5);
    expect(result.output.frameCount).toBe(121);
    expect(result.sources.durationSeconds).toBe('derived');
    expect(result.sources.frameCount).toBe('request');
  });

  it('rejects conflicting explicit duration and frame count', () => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params({
        seedanceDuration: 6,
        videoFps: 30,
        videoFrames: 129,
      })),
      'INVALID_PARAMETER',
    );
  });

  it.each([
    { label: 'no references', references: [], operation: 'text-to-video' },
    {
      label: 'audio-only reference',
      references: [reference('audio', 'https://assets.example/voice.mp3')],
      operation: 'text-to-video',
    },
    {
      label: 'image reference',
      references: [reference('image', 'https://assets.example/first.png')],
      operation: 'image-to-video',
    },
    {
      label: 'video takes precedence in mixed input',
      references: [
        reference('image', 'https://assets.example/style.png'),
        reference('video', 'https://assets.example/motion.mp4'),
      ],
      operation: 'video-to-video',
    },
  ])('resolves $label as $operation', ({ references, operation }) => {
    const result = resolveCanonicalVideoRequest(params(), { references });
    expect(result.operation).toBe(operation);
  });

  it('preserves the same image in distinct roles and removes only exact duplicate bindings', () => {
    const first = reference('image', ' https://assets.example/frame.png ', 'first_frame');
    const last = reference('image', 'https://assets.example/frame.png', 'last_frame');
    const result = resolveCanonicalVideoRequest(params(), {
      references: [first, first, last],
    });

    expect(result.references.counts).toEqual({ image: 2, video: 0, audio: 0, total: 2 });
    expect(result.references.images.map((item) => item.role)).toEqual(['first_frame', 'last_frame']);
    expect(toResolvedVideoCompatibilityValues(result)).toMatchObject({
      imageUrls: [
        'https://assets.example/frame.png',
        'https://assets.example/frame.png',
      ],
      firstImageUrl: 'https://assets.example/frame.png',
      lastImageUrl: 'https://assets.example/frame.png',
    });
  });

  it('uses exact dimensions declared as a resolution preset without treating them as a ratio', () => {
    const result = resolveCanonicalVideoRequest(params({ seedanceResolution: '1280x720' }), {
      capability: {
        resolutions: ['1280x720'],
        defaultResolution: '1280x720',
        defaultDuration: 5,
      },
    });

    expect(result.output.resolutionPreset).toBe('1280x720');
    expect(result.output.pixelDimensions).toEqual({ width: 1280, height: 720 });
  });

  it('requires a reference when the capability declares it', () => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(), {
        capability: { ...CAPABILITY, requiresReference: true },
      }),
      'REQUIRED_REFERENCE',
    );
  });

  it('rejects an operation outside the model capability', () => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(), {
        capability: { operations: ['image-to-video'] },
      }),
      'UNSUPPORTED_OPERATION',
    );
  });

  it('rejects frame/reference mixing when the model declares the modes exclusive', () => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(), {
        references: [
          reference('image', 'https://assets.example/first.png', 'first_frame'),
          reference('video', 'https://assets.example/motion.mp4'),
        ],
        capability: {
          operations: ['video-to-video'],
          allowFrameAndReferenceMix: false,
        },
      }),
      'REFERENCE_COMBINATION_UNSUPPORTED',
    );
  });

  it('resolves ratio defaults and allowed values per input mode', () => {
    const capability: VideoModelCapability = {
      ratios: ['adaptive', '16:9', '9:16'],
      inputModeCapabilities: {
        text: { ratios: ['16:9', '9:16'], defaultRatio: '16:9', requiresRatio: true },
        keyframe: { ratios: ['adaptive'], defaultRatio: 'adaptive' },
        reference: { ratios: ['adaptive', '16:9', '9:16'], defaultRatio: 'adaptive' },
      },
    };

    const textRequest = resolveCanonicalVideoRequest(params(), { capability });
    expect(textRequest.inputMode).toBe('text');
    expect(textRequest.output.aspectRatio).toBe('16:9');

    const keyframeRequest = resolveCanonicalVideoRequest(params(), {
      capability,
      references: [reference('image', 'https://assets.example/first.png', 'first_frame')],
    });
    expect(keyframeRequest.inputMode).toBe('keyframe');
    expect(keyframeRequest.output.aspectRatio).toBe('adaptive');

    const referenceRequest = resolveCanonicalVideoRequest(params(), {
      capability,
      references: [reference('video', 'https://assets.example/reference.mp4')],
    });
    expect(referenceRequest.inputMode).toBe('reference');
    expect(referenceRequest.output.aspectRatio).toBe('adaptive');

    const explicitReferenceRatio = resolveCanonicalVideoRequest(params({ seedanceRatio: '16:9' }), {
      capability,
      references: [reference('video', 'https://assets.example/reference.mp4')],
    });
    expect(explicitReferenceRatio.output.aspectRatio).toBe('16:9');

    expectResolutionError(
      () => resolveCanonicalVideoRequest(params({ seedanceRatio: 'adaptive' }), {
        capability,
      }),
      'UNSUPPORTED_ASPECT_RATIO',
    );
  });

  it.each([
    {
      label: 'image',
      references: [
        reference('image', 'https://assets.example/1.png'),
        reference('image', 'https://assets.example/2.png'),
      ],
      capability: { maxImageReferences: 1 },
    },
    {
      label: 'video',
      references: [reference('video', 'https://assets.example/1.mp4')],
      capability: { maxVideoReferences: 0 },
    },
    {
      label: 'audio',
      references: [
        reference('audio', 'https://assets.example/1.mp3'),
        reference('audio', 'https://assets.example/2.mp3'),
      ],
      capability: { maxAudioReferences: 1 },
    },
  ])('enforces the declared $label reference maximum', ({ references, capability }) => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(), { references, capability }),
      'REFERENCE_LIMIT_EXCEEDED',
    );
  });

  it('rejects audio-only input when standalone audio is explicitly unsupported', () => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(), {
        references: [reference('audio', 'https://assets.example/voice.mp3')],
        capability: { supportsStandaloneAudio: false, maxAudioReferences: 1 },
      }),
      'STANDALONE_AUDIO_UNSUPPORTED',
    );
  });

  it('rejects explicit audio generation when the model cannot produce audio', () => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params({ generateAudio: true }), {
        capability: { supportsAudio: false },
      }),
      'AUDIO_GENERATION_UNSUPPORTED',
    );
  });

  it('turns an unspecified audio policy into mute for a silent-only model', () => {
    const result = resolveCanonicalVideoRequest(params(), {
      capability: { supportsAudio: false },
    });
    expect(result.output.audio.policy).toBe('mute');
    expect(result.sources.audioPolicy).toBe('capability-default');
  });

  it('rejects an unsupported discrete duration instead of snapping it to a nearby value', () => {
    const error = expectResolutionError(
      () => resolveCanonicalVideoRequest(params({ seedanceDuration: 12 }), {
        capability: { durations: [10, 15], defaultDuration: 10 },
      }),
      'UNSUPPORTED_DURATION',
    );
    expect(error.details).toMatchObject({ value: 12, allowed: [10, 15] });
  });

  it.each([
    { duration: 4, code: 'DURATION_OUT_OF_RANGE' as const },
    { duration: 31, code: 'DURATION_OUT_OF_RANGE' as const },
  ])('rejects duration $duration outside the declared 5..30 range', ({ duration, code }) => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params({ seedanceDuration: duration }), {
        capability: { minDuration: 5, maxDuration: 30, defaultDuration: 5 },
      }),
      code,
    );
  });

  it.each([
    {
      label: 'ratio',
      input: { seedanceRatio: '1:1' },
      capability: { ratios: ['16:9'], defaultRatio: '16:9' },
      code: 'UNSUPPORTED_ASPECT_RATIO' as const,
    },
    {
      label: 'resolution',
      input: { seedanceResolution: '4K' },
      capability: { resolutions: ['720p'], defaultResolution: '720p' },
      code: 'UNSUPPORTED_RESOLUTION' as const,
    },
    {
      label: 'frame rate',
      input: { videoFps: 60 },
      capability: { frameRates: [24, 30], defaultFrameRate: 24 },
      code: 'UNSUPPORTED_FRAME_RATE' as const,
    },
  ])('rejects an unsupported $label', ({ input, capability, code }) => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(input), { capability }),
      code,
    );
  });

  it('validates capability defaults before they can reach a paid request', () => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(), {
        capability: {
          frameRates: [24],
          defaultFrameRate: 30,
        },
      }),
      'INVALID_CAPABILITY',
    );

    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(), {
        capability: {
          durations: [10, 15],
          defaultDuration: 12,
        },
      }),
      'INVALID_CAPABILITY',
    );

    expectResolutionError(
      () => resolveCanonicalVideoRequest(params(), {
        capability: {
          ratios: ['adaptive', '16:9'],
          defaultRatio: '16:9',
          inputModeCapabilities: {
            keyframe: { ratios: ['adaptive'] },
          },
        },
      }),
      'INVALID_CAPABILITY',
    );
  });

  it('keeps partial capability constraints unspecified when no default was declared', () => {
    const discrete = resolveCanonicalVideoRequest(params(), {
      capability: {
        resolutions: ['2K'],
        ratios: ['16:9'],
        frameRates: [30],
        durations: [10, 15],
      },
    });

    expect(discrete.output).toMatchObject({
      resolutionPreset: null,
      aspectRatio: null,
      requestedFrameRate: 24,
      durationSeconds: 5,
    });
    expect(discrete.sources).toMatchObject({
      resolutionPreset: 'unspecified',
      aspectRatio: 'unspecified',
      requestedFrameRate: 'compatibility-default',
      durationSeconds: 'compatibility-default',
    });

    const ranged = resolveCanonicalVideoRequest(params(), {
      capability: { minDuration: 10, maxDuration: 30 },
    });
    expect(ranged.sources.durationSeconds).toBe('compatibility-default');
  });

  it('does not turn a frame-only request into an explicit fps or duration without declared defaults', () => {
    const result = resolveCanonicalVideoRequest(params({ videoFrames: 121 }), {
      capability: {
        frameRates: [30],
        durations: [10, 15],
      },
    });

    expect(result.output.frameCount).toBe(121);
    expect(result.sources).toMatchObject({
      frameCount: 'request',
      requestedFrameRate: 'compatibility-default',
      durationSeconds: 'compatibility-default',
    });
  });

  it('enforces the capability prompt minimum', () => {
    expectResolutionError(
      () => resolveCanonicalVideoRequest(params({ prompt: '短' }), {
        capability: { inputConstraints: { promptMinCharacters: 2 } },
      }),
      'INVALID_PARAMETER',
    );
  });
});
