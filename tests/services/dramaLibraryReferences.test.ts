import { describe, expect, it } from 'vitest';
import { preferredDramaMentionForNode, preferDramaLibraryReferences } from '../../src/services/dramaAssetPrompt';
import { emptyDramaAssetLibrary, type DramaCharacter } from '../../src/types/dramaAssets';

function character(id = 'character-1'): DramaCharacter {
  return { id, kind: 'character', name: '小绘', key: id, identity: '', summary: '', visualNotes: '',
    importance: 'main', confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual',
    primaryReferenceImageId: 'front', referenceImages: [
      { id: 'front', kind: 'primary', imageUrl: 'front.png', prompt: '', createdAt: 1, updatedAt: 1 },
      { id: 'side', kind: 'turnaround', imageUrl: 'side.png', prompt: '', createdAt: 1, updatedAt: 1 },
    ] };
}

const nodes = [
  { id: 'front-node', data: { type: 'source-image', imageUrl: 'front.png' } },
  { id: 'side-node', data: { type: 'ai-image', imageUrl: 'side.png' } },
  { id: 'same-name', data: { type: 'ai-image', label: '小绘', imageUrl: 'different.png' } },
  { id: 'grid', data: { type: 'ai-storyboard', imageUrl: 'front.png' } },
];

describe('library reference preference', () => {
  it('keeps the exact character image and Picture order without replacing plain text or existing library tokens', () => {
    const library = { ...emptyDramaAssetLibrary(), characters: [character()] };
    const prompt = 'Picture 1: @{side-node:侧面}\nPicture 2: @{front-node:正面}\n@drama{character-1#front:原引用}';
    expect(preferDramaLibraryReferences(prompt, nodes, library)).toBe(
      'Picture 1: @drama{character-1#side:小绘}\nPicture 2: @drama{character-1#front:小绘}\n@drama{character-1#front:原引用}',
    );
    expect(preferredDramaMentionForNode('same-name', nodes, library)).toBeUndefined();
    expect(preferDramaLibraryReferences('@{grid/cell/0:第一格}', nodes, library)).toBe('@{grid/cell/0:第一格}');
  });

  it('prefers a unique project card and qualifies global identity when only a global card matches', () => {
    const library = { ...emptyDramaAssetLibrary(), characters: [character()] };
    expect(preferredDramaMentionForNode('side-node', nodes, library, [character()])).toBe('@drama{character-1#side:小绘}');
    expect(preferredDramaMentionForNode('side-node', nodes, emptyDramaAssetLibrary(), [character()]))
      .toBe('@drama{global/character-1#side:小绘}');
  });

  it('leaves ambiguous, unbound, missing and unavailable images as node references', () => {
    const library = { ...emptyDramaAssetLibrary(), characters: [character(), character('character-2')] };
    expect(preferDramaLibraryReferences('@{front-node:图片}', nodes, library)).toBe('@{front-node:图片}');
    expect(preferredDramaMentionForNode('missing', nodes, library)).toBeUndefined();
    expect(preferredDramaMentionForNode('front-node', nodes,
      { ...emptyDramaAssetLibrary(), characters: [{ ...character(), referenceImages: [], imageUrl: undefined }] })).toBeUndefined();
    expect(preferredDramaMentionForNode('front-node', [{ id: 'front-node', data: { type: 'ai-image' } }], library)).toBeUndefined();
    expect(preferredDramaMentionForNode('front-node', nodes,
      { ...emptyDramaAssetLibrary(), characters: [{ ...character(), name: '不能}插入@{其他节点' }] })).toBeUndefined();
  });

  it('resolves a project prop through its current bound source image', () => {
    const library = { ...emptyDramaAssetLibrary(), props: [{ id: 'prop-1', kind: 'prop' as const,
      name: '茶壶', key: '茶壶', summary: '', visualNotes: '', importance: 'supporting' as const,
      confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual' as const, imageNodeId: 'front-node' }] };
    expect(preferredDramaMentionForNode('front-node', nodes, library)).toBe('@drama{prop-1:茶壶}');
    expect(preferDramaLibraryReferences('@{front-node:旧节点名}', nodes, library)).toBe('@drama{prop-1:茶壶}');
  });
});
