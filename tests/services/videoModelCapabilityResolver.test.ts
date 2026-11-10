/**
 * videoModelCapabilityResolver — 回归测试：videoModelCapabilityResolver。
 */
import { describe, expect, it } from 'vitest';
import { resolveVideoModelCapability } from '../../src/services/ai/videoModelCapabilityResolver';
import { useAppStore } from '../../src/store/useAppStore';
import type { AppConfig } from '../../src/types';
import { createSeedanceQuickAdaptTemplate } from '../../src/services/ai/seedanceModelCapabilities';
import { RELAYON_MODEL_MANIFEST } from '../../src/services/ai/providers/relayonModelManifest';

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
    expect(resolveVideoModelCapability('sora2u/seedance-2.0', config())).toMatchObject({
      minDuration: 5, maxDuration: 15, maxVideoAudioReferences: 3,
    });
    expect(resolveVideoModelCapability('sora2u/seedance-2.5', config())).toMatchObject({
      maxDuration: 30,
      inputConstraints: { referenceVideo: { durationSeconds: { max: 15, maxExclusive: true } } },
    });
    expect(resolveVideoModelCapability('dreamina/seedance2.5', config())).toMatchObject({ maxDuration: 30, maxAudioReferences: 10 });
  });

  it('补齐旧 Sora2U 模型的联合名额，保留显式值与厂商身份边界', () => {
    const input = config();
    input.providers.saved = { name: 'Saved Sora2U', catalogId: 'sora2u', apiKey: 'fixture', baseUrl: 'https://sora2u.com' };
    input.providers.sora2u = { name: 'Custom', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://custom.example' };
    input.generalModels = [
      { id: 'old', name: 'Old', modelId: 'seedance-2.0', category: 'video', providerConfigId: 'saved',
        videoCapability: { maxVideoReferences: 3, maxAudioReferences: 3 } },
      { id: 'explicit', name: 'Explicit', modelId: 'seedance-2.0-character', category: 'video', providerConfigId: 'saved',
        videoCapability: { maxVideoAudioReferences: 2 } },
      { id: 'custom', name: 'Custom', modelId: 'seedance-2.0', category: 'video', providerConfigId: 'sora2u',
        videoCapability: { maxVideoReferences: 3, maxAudioReferences: 3 } },
      { id: 'mono', name: 'Mono', modelId: 'seedance-2.0-character-mono', category: 'video', providerConfigId: 'saved',
        videoCapability: { maxVideoReferences: 3, maxAudioReferences: 3 } },
    ];
    expect(resolveVideoModelCapability('general/old', input)?.maxVideoAudioReferences).toBe(3);
    expect(resolveVideoModelCapability('general/explicit', input)?.maxVideoAudioReferences).toBe(2);
    expect(resolveVideoModelCapability('general/custom', input)?.maxVideoAudioReferences).toBeUndefined();
    expect(resolveVideoModelCapability('general/mono', input)?.maxVideoAudioReferences).toBeUndefined();
    expect(resolveVideoModelCapability('sora2u/seedance-2.0', input)).toBeUndefined();
    expect(input.generalModels[0].videoCapability).not.toHaveProperty('maxVideoAudioReferences');
  });

  it('真实万象连接的通用引用和厂商引用共用旧 Seedance 比例补正且不修改配置', () => {
    const input = config();
    const selected = structuredClone(RELAYON_MODEL_MANIFEST.find((model) => model.id === 'sd-2.5-c1')!);
    selected.provider = 'relay-video';
    selected.videoCapability!.ratios = ['16:9'];
    input.providers['relay-video'] = { name: '万象视频', catalogId: 'relayonapi', apiKey: 'fixture', selectedModels: [selected] };
    input.generalModels = [{ id: 'saved-relay', name: selected.name, modelId: selected.id, category: 'video',
      providerConfigId: 'relay-video', executionProfile: selected.executionProfile, videoCapability: selected.videoCapability }];
    const before = structuredClone(input);
    const ratios = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'];
    for (const reference of ['general/saved-relay', 'relay-video/sd-2.5-c1']) {
      const effective = resolveVideoModelCapability(reference, input)!;
      expect(effective).toMatchObject({ ratios, defaultRatio: '16:9', minDuration: 4, maxDuration: 30,
        resolutions: ['720p'], maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10 });
      effective.ratios!.push('2:1');
      expect(resolveVideoModelCapability(reference, input)?.ratios).toEqual(ratios);
    }
    expect(input).toEqual(before);
  });

  it('万象已保存的完整 H3 15 秒快照在节点与 Agent/MCP 参数入口开放 30 秒，不写回配置', () => {
    const input = config();
    const selected = structuredClone(RELAYON_MODEL_MANIFEST.find((model) => model.id === 'minimax-h3')!);
    selected.videoCapability!.maxDuration = 15;
    input.providers['relay-h3'] = { name: '万象 H3', catalogId: 'relayonapi', apiKey: 'fixture', selectedModels: [selected] };
    input.generalModels = [{ id: 'legacy-h3', name: selected.name, modelId: selected.id, category: 'video',
      providerConfigId: 'relay-h3', executionProfile: selected.executionProfile, videoCapability: selected.videoCapability }];
    const before = structuredClone(input);
    for (const reference of ['general/legacy-h3', 'relay-h3/minimax-h3']) {
      expect(resolveVideoModelCapability(reference, input)).toMatchObject({ minDuration: 4, maxDuration: 30 });
    }
    expect(input).toEqual(before);
    input.generalModels[0].videoCapability = { ...selected.videoCapability, maxDuration: 10 };
    expect(resolveVideoModelCapability('general/legacy-h3', input)?.maxDuration).toBe(10);
  });

  it('仅为万象完整内置协议恢复缺失能力，不覆盖同名自定义连接或显式比例', () => {
    const input = config();
    const selected = structuredClone(RELAYON_MODEL_MANIFEST.find((model) => model.id === 'sd-2.0-A')!);
    const legacy = { ...selected.videoCapability, ratios: ['16:9'] };
    const c1 = structuredClone(RELAYON_MODEL_MANIFEST.find((model) => model.id === 'sd-2.0-c1')!);
    const customProfile = structuredClone(selected.executionProfile!);
    customProfile.protocol!.submit.path = '/custom/videos';
    input.providers.real = { name: '万象视频', catalogId: 'relayonapi', apiKey: 'fixture' };
    input.providers.relayonapi = { name: '同名自定义', catalogId: 'custom-openai', apiKey: 'fixture', selectedModels: [
      { ...selected, provider: 'relayonapi', videoCapability: legacy },
    ] };
    input.generalModels = [
      { id: 'missing', name: selected.name, modelId: selected.id, category: 'video', providerConfigId: 'real',
        executionProfile: selected.executionProfile },
      { id: 'custom-connection', name: selected.name, modelId: selected.id, category: 'video', providerConfigId: 'relayonapi',
        executionProfile: selected.executionProfile, videoCapability: legacy },
      { id: 'custom-protocol', name: selected.name, modelId: selected.id, category: 'video', providerConfigId: 'real',
        executionProfile: customProfile, videoCapability: legacy },
      { id: 'explicit', name: selected.name, modelId: selected.id, category: 'video', providerConfigId: 'real',
        executionProfile: selected.executionProfile, videoCapability: { ...legacy, ratios: ['1:1'], defaultRatio: '1:1' } },
      { id: 'custom-capability', name: selected.name, modelId: selected.id, category: 'video', providerConfigId: 'real',
        executionProfile: selected.executionProfile, videoCapability: { ...legacy, maxDuration: 14 } },
      { id: 'narrow-c1', name: c1.name, modelId: c1.id, category: 'video', providerConfigId: 'real',
        executionProfile: c1.executionProfile, videoCapability: { ...c1.videoCapability, ratios: ['16:9'] } },
    ];
    expect(resolveVideoModelCapability('general/missing', input)).toMatchObject({
      ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'], minDuration: 4, maxDuration: 15,
    });
    for (const reference of ['general/custom-connection', 'relayonapi/sd-2.0-A', 'general/custom-protocol']) {
      expect(resolveVideoModelCapability(reference, input)?.ratios).toEqual(['16:9']);
    }
    expect(resolveVideoModelCapability('general/explicit', input)?.ratios).toEqual(['1:1']);
    expect(resolveVideoModelCapability('general/custom-capability', input)).toMatchObject({ ratios: ['16:9'], maxDuration: 14 });
    expect(resolveVideoModelCapability('general/narrow-c1', input)?.ratios).toEqual(['16:9']);
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
