import { describe, expect, it } from 'vitest';
import {
  assertProviderModelsVideoCapabilities,
  createEditableVideoCapability,
  keepDeclaredVideoCapabilityDefault,
} from '../../src/components/settings/ProviderConnectionDialog';
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
