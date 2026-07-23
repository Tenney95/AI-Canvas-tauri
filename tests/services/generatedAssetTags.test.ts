import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identifyAsset: vi.fn(),
  getAllAssetMeta: vi.fn(),
  putAssetMeta: vi.fn(),
}));

vi.mock('../../src/services/fs/assetIndex', () => ({
  identifyAsset: mocks.identifyAsset,
}));

vi.mock('../../src/services/indexedDbService', () => ({
  getAllAssetMeta: mocks.getAllAssetMeta,
  putAssetMeta: mocks.putAssetMeta,
}));

import {
  extractGeneratedAssetTags,
  tagGeneratedProjectAsset,
  tagGeneratedProjectAssetSafely,
} from '../../src/services/fs/generatedAssetTags';

describe('extractGeneratedAssetTags', () => {
  it('extracts concise Chinese tags in prompt order', () => {
    const tags = extractGeneratedAssetTags(
      '一只戴着红色围巾的橘猫，在雪地里奔跑，电影感，暖色调',
    );

    expect(tags).toEqual(expect.arrayContaining(['红色', '围巾', '橘猫', '雪地']));
    expect(tags).toHaveLength(6);
  });

  it('filters model mentions, URLs, stop words, and duplicate English terms', () => {
    const tags = extractGeneratedAssetTags(
      '@model{openai/image|Image} Create a cinematic portrait portrait with soft lighting https://example.com/ref.png',
    );

    expect(tags).toEqual(['cinematic', 'portrait', 'soft', 'lighting']);
  });
});

describe('tagGeneratedProjectAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identifyAsset.mockResolvedValue({ assetId: 'asset-1' });
    mocks.getAllAssetMeta.mockResolvedValue([]);
    mocks.putAssetMeta.mockResolvedValue(undefined);
  });

  it('persists prompt tags against the stable asset identity', async () => {
    const tagged = await tagGeneratedProjectAsset({
      filePath: 'D:/project/data/generated.png',
      projectId: 'project-1',
      prompt: 'cinematic portrait with soft lighting',
    });

    expect(tagged).toBe(true);
    expect(mocks.identifyAsset).toHaveBeenCalledWith(
      'D:/project/data/generated.png',
      { projectId: 'project-1', source: 'project' },
    );
    expect(mocks.putAssetMeta).toHaveBeenCalledWith(expect.objectContaining({
      assetId: 'asset-1',
      path: 'D:/project/data/generated.png',
      tags: ['cinematic', 'portrait', 'soft', 'lighting'],
    }));
  });

  it('does not overwrite an asset that already has tags', async () => {
    mocks.getAllAssetMeta.mockResolvedValue([{
      assetId: 'asset-1',
      tags: ['手动标签'],
      updatedAt: 1,
    }]);

    const tagged = await tagGeneratedProjectAsset({
      filePath: 'D:/project/data/generated.png',
      projectId: 'project-1',
      prompt: 'cinematic portrait',
    });

    expect(tagged).toBe(false);
    expect(mocks.putAssetMeta).not.toHaveBeenCalled();
  });

  it('does not reject the generation flow when automatic tagging fails', async () => {
    mocks.identifyAsset.mockRejectedValue(new Error('file unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(tagGeneratedProjectAssetSafely({
      filePath: 'D:/project/data/generated.png',
      projectId: 'project-1',
      prompt: 'cinematic portrait',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[generatedAssetTags] 自动标签写入失败');
    warn.mockRestore();
  });
});
