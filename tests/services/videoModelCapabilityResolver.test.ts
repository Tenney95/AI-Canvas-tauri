import { describe, expect, it } from 'vitest';
import { resolveVideoModelCapability } from '../../src/services/ai/videoModelCapabilityResolver';
import { useAppStore } from '../../src/store/useAppStore';
import type { AppConfig } from '../../src/types';
import { createSeedanceQuickAdaptTemplate } from '../../src/services/ai/seedanceModelCapabilities';

function config(): AppConfig {
  return { ...useAppStore.getState().config, providers: {}, generalModels: [] };
}

describe('videoModelCapabilityResolver', () => {
  it('uses native duration and operation contracts for SD2.5 and H3', () => {
    expect(resolveVideoModelCapability('apimart/doubao-seedance-2.5', config())).toMatchObject({ maxDuration: 30, maxVideoReferences: 10 });
    expect(resolveVideoModelCapability('volcengine/doubao-seedance-2-5-260628', config())).toMatchObject({
      maxDuration: 30, automaticDurationValue: -1,
      operationCapabilities: { 'video-to-video': { automaticDurationOnly: true } },
    });
    expect(resolveVideoModelCapability('apimart/MiniMax-H3', config())).toMatchObject({ maxDuration: 15, maxVideoReferences: 3 });
  });

  it('uses the selected resolution rather than a model-name-wide H3 limit', () => {
    expect(resolveVideoModelCapability('grsai/minimax-h3', config(), '768p')).toMatchObject({ maxDuration: 15, maxVideoReferences: 0 });
    expect(resolveVideoModelCapability('grsai/minimax-h3', config(), '1080p')).toMatchObject({ maxDuration: 10, maxVideoReferences: 0 });
  });

  it('preserves provider-specific input restrictions', () => {
    expect(resolveVideoModelCapability('sora2u/seedance-2.5', config())).toMatchObject({
      maxDuration: 30,
      inputConstraints: { referenceVideo: { durationSeconds: { max: 15, maxExclusive: true } } },
    });
    expect(resolveVideoModelCapability('dreamina/seedance2.5', config())).toMatchObject({ maxDuration: 30, maxAudioReferences: 10 });
  });

  it('uses internal general-model identity, explicit capability and preset defaults', () => {
    const input = config();
    input.generalModels = [
      { id: 'relay', name: 'SD2.5', modelId: 'private-name', category: 'video', providerConfigId: 'relay',
        videoCapability: createSeedanceQuickAdaptTemplate('2.5', 'apimart').capability },
      { id: 'agnes', name: 'Agnes', modelId: 'agnes', category: 'video', providerConfigId: 'relay', executionProfile: { preset: 'agnes-video' } },
      { id: 'unknown', name: 'SD2.5', modelId: 'sd2.5', category: 'video', providerConfigId: 'relay' },
      { id: 'text', name: 'Text', modelId: 'text', category: 'text', providerConfigId: 'relay', videoCapability: { maxDuration: 30 } },
    ];
    expect(resolveVideoModelCapability('general/relay', input)).toMatchObject({ maxDuration: 30 });
    expect(resolveVideoModelCapability('general/agnes', input)).toBeDefined();
    expect(resolveVideoModelCapability('general/unknown', input)).toBeUndefined();
    expect(resolveVideoModelCapability('general/text', input)).toBeUndefined();
    expect(resolveVideoModelCapability('general/missing', input)).toBeUndefined();
  });

  it('does not invent capabilities for an unknown workflow or model label', () => {
    expect(resolveVideoModelCapability('comfyui/sd2.5', config())).toBeUndefined();
    expect(resolveVideoModelCapability('relay/sd2.5', config())).toBeUndefined();
    expect(resolveVideoModelCapability('sd2.5', config())).toBeUndefined();
  });

  it('returns an independent capability without connection data', () => {
    const input = config();
    input.providers.relay = { name: 'Relay', apiKey: 'private-key', baseUrl: 'https://private.example/v1', selectedModels: [
      { id: 'video', name: 'Video', category: 'video', provider: 'relay', videoCapability: { maxDuration: 12, maxVideoReferences: 1 } },
    ] };
    const result = resolveVideoModelCapability('relay/video', input)!;
    result.maxDuration = 99;
    expect(resolveVideoModelCapability('relay/video', input)?.maxDuration).toBe(12);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('removes unknown nested capability fields from imported configuration', () => {
    const input = config();
    input.generalModels = [{ id: 'safe', name: 'safe', modelId: 'safe', category: 'video', providerConfigId: 'relay',
      videoCapability: Object.assign({ maxDuration: 30, inputConstraints: {
        referenceVideo: Object.assign({ durationSeconds: Object.assign({ max: 15 }, { apiKey: 'nested-private' }) }, { endpoint: 'private.example' }),
      } }, { apiKey: 'private-key' }),
    }];
    const result = resolveVideoModelCapability('general/safe', input);
    expect(result?.inputConstraints?.referenceVideo?.durationSeconds?.max).toBe(15);
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
