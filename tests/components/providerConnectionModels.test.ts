import { describe, expect, it } from 'vitest';
import { materializeLegacyImageProtocolDefault, mergeModels } from '../../src/components/settings/providerConnection/providerConnectionModels';

it('preserves configured image tiers and video limits when refreshing a raw catalog', () => {
  const configured = [
    { id: 'image', name: 'Image', category: 'image' as const, provider: 'custom', imageCapability: { resolutions: ['1K'], maxBatchCount: 2 } },
    { id: 'video', name: 'Video', category: 'video' as const, provider: 'custom', videoCapability: { minDuration: 4, maxDuration: 30 } },
  ];
  const refreshed = mergeModels(configured, configured.map(({ id, category, provider }) => ({ id, name: id, category, provider,
    imageCapability: undefined, videoCapability: undefined })));
  expect(refreshed[0].imageCapability).toEqual(configured[0].imageCapability);
  expect(refreshed[1].videoCapability).toEqual(configured[1].videoCapability);
});

describe('legacy connection image protocol', () => {
  it('copies a saved connection default only to selected image models without overrides', () => {
    const models = materializeLegacyImageProtocolDefault([
      { id: 'image-a', name: '图片 A', category: 'image', provider: 'gateway' },
      { id: 'image-b', name: '图片 B', category: 'image', provider: 'gateway',
        executionProfile: { preset: 'openai-gpt-image' },
        imageReferenceRequestMode: 'edits-multipart' },
      { id: 'text-a', name: '文本 A', category: 'text', provider: 'gateway' },
    ], {
      imageProtocolDefault: { preset: 'gpt-image-gateway-json' },
      imageReferenceRequestModeDefault: 'generation-json-image-data-urls',
    });
    expect(models[0]).toMatchObject({
      executionProfile: { preset: 'gpt-image-gateway-json' },
      imageReferenceRequestMode: 'generation-json-image-data-urls',
    });
    expect(models[1]).toMatchObject({
      executionProfile: { preset: 'openai-gpt-image' },
      imageReferenceRequestMode: 'edits-multipart',
    });
    expect(models[2].executionProfile).toBeUndefined();
  });
});
