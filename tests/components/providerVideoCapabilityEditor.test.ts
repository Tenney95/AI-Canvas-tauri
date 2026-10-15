import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import VideoCapabilityEditor from '../../src/components/settings/providerConnection/VideoCapabilityEditor';
import {
  assertProviderModelsVideoCapabilities,
  createEditableVideoCapability,
  keepDeclaredVideoCapabilityDefault,
} from '../../src/components/settings/providerConnection/providerConnectionModels';
import type { ProviderModelSelection } from '../../src/types';
import type { VideoModelCapability } from '../../src/types/aiTypes';

describe('provider video capability editor normalization', () => {
  it('preserves partial capability fields without inventing defaults', () => {
    const capability: VideoModelCapability = {
      ratios: ['7:4'],
      resolutions: ['2K'],
      frameRates: [30],
      durations: [10, 15],
      supportsAudio: true,
      inputConstraints: { promptMinCharacters: 3 },
    };

    const editable = createEditableVideoCapability(capability);

    expect(editable).toEqual(capability);
    expect(editable).not.toHaveProperty('defaultRatio');
    expect(editable).not.toHaveProperty('defaultResolution');
    expect(editable).not.toHaveProperty('defaultFrameRate');
    expect(editable).not.toHaveProperty('defaultDuration');
    expect(editable).not.toHaveProperty('minDuration');
    expect(editable).not.toHaveProperty('maxDuration');
  });

  it('keeps an empty capability empty instead of applying Seedance presets', () => {
    expect(createEditableVideoCapability()).toEqual({});
  });

  it.each([
    [undefined, ''],
    [true, 'supported'],
    [false, 'unsupported'],
  ] as const)('exposes the saved audio declaration %s without replacing it with a default', (supportsAudio, value) => {
    const html = renderToStaticMarkup(createElement(VideoCapabilityEditor, {
      model: { id: 'video', name: 'Video', category: 'video', provider: 'custom', videoCapability: { supportsAudio } },
      onChange: () => undefined, onApplySeedanceTemplate: () => undefined,
      onApplyH3Template: () => undefined, onClose: () => undefined,
    }));
    const audioSelect = html.match(/<select[^>]*name="video-audio-capability"[^>]*>[\s\S]*?<\/select>/)?.[0];
    expect(audioSelect).toBeDefined();
    expect(audioSelect).toContain(`value="${value}" selected=""`);
    expect(audioSelect).toContain('未声明（接口默认）');
    expect(audioSelect).toContain('支持（可切换有声/无声）');
    expect(audioSelect).toContain('不支持生成音轨');
  });

  it('allows correcting a legacy hidden audio toggle without losing reference audio settings', () => {
    const model: ProviderModelSelection = {
      id: 'dreamina-seedance-2-0-260128-max', name: 'Seedance', category: 'video', provider: 'custom',
      videoCapability: { supportsAudio: true, supportsStandaloneAudio: true, maxAudioReferences: 3 },
      executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
        submit: { method: 'POST', path: '/videos', body: { model: '{{model}}', prompt: '{{prompt}}' } },
        response: { type: 'json', result: { urlPath: 'url' } } } },
    };
    expect(() => assertProviderModelsVideoCapabilities([model])).toThrow('音频开关');
    const corrected = { ...model, videoCapability: createEditableVideoCapability({ ...model.videoCapability, supportsAudio: undefined }) };
    expect(() => assertProviderModelsVideoCapabilities([corrected])).not.toThrow();
    expect(corrected.videoCapability).toMatchObject({ supportsStandaloneAudio: true, maxAudioReferences: 3 });
    expect(model.videoCapability?.supportsAudio).toBe(true);
    expect(() => assertProviderModelsVideoCapabilities([{ ...model, videoCapability: undefined }])).not.toThrow();
  });

  it('clones nested operation and input-mode overrides before editing', () => {
    const source: VideoModelCapability = {
      ratios: ['adaptive'],
      inputModeCapabilities: { keyframe: { ratios: ['adaptive'] } },
      operationCapabilities: { 'video-to-video': { automaticDurationOnly: true } },
      automaticDurationValue: -1,
    };
    const editable = createEditableVideoCapability(source);
    editable.inputModeCapabilities!.keyframe!.ratios!.push('test-only');

    expect(source.inputModeCapabilities?.keyframe?.ratios).toEqual(['adaptive']);
  });

  it('shows all explicit Seedance and MiniMax H3 transport templates', () => {
    const html = renderToStaticMarkup(createElement(VideoCapabilityEditor, {
      model: {
        id: 'custom-video',
        name: 'Custom Video',
        category: 'video',
        provider: 'custom-provider',
      },
      onChange: () => undefined,
      onApplySeedanceTemplate: () => undefined,
      onApplyH3Template: () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain('Seedance 快速适配');
    expect(html).toContain('Seedance 2.5 · 火山原生');
    expect(html).toContain('Seedance 2.0 Mini · APIMart 兼容');
    expect(html).toContain('不会根据模型名称自动猜测');
    expect(html).toContain('MiniMax H3 快速适配');
    expect(html).toContain('MiniMax H3-Max · AI Ping 兼容');
    expect(html).toContain('Context-IR 与 Regeneration 不属于普通视频生成模板');
  });

  it('does not turn the first allowed value into an undeclared default', () => {
    expect(keepDeclaredVideoCapabilityDefault(undefined, ['2K', '4K'])).toBeUndefined();
    expect(keepDeclaredVideoCapabilityDefault('2K', ['2K', '4K'])).toBe('2K');
    expect(keepDeclaredVideoCapabilityDefault('2K', ['4K'])).toBeUndefined();
    expect(keepDeclaredVideoCapabilityDefault(undefined, [24, 30])).toBeUndefined();
  });

  it('validates edited capabilities before save while allowing documented long durations', () => {
    const model = (videoCapability: VideoModelCapability): ProviderModelSelection => ({
      id: 'long-video',
      name: 'Long Video',
      category: 'video',
      provider: 'custom-long-video',
      videoCapability,
    });

    expect(() => assertProviderModelsVideoCapabilities([
      model({ minDuration: 60, maxDuration: 120, defaultDuration: 90 }),
    ])).not.toThrow();
    expect(() => assertProviderModelsVideoCapabilities([
      model({ minDuration: 120, maxDuration: 60 }),
    ])).toThrow('minDuration 不能大于 maxDuration');
  });
});
