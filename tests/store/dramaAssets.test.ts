import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import type { DramaCharacter } from '../../src/types/dramaAssets';
import { emptyDramaAssetLibrary } from '../../src/types/dramaAssets';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    saveCurrentProjectSilent: vi.fn(async () => 'p1'),
    showToast: vi.fn(),
    currentProjectId: 'p1',
    projects: [{ id: 'p1', name: 'Test', createdAt: 1, updatedAt: 1 }],
  });
});

function sampleCharacter(overrides: Partial<DramaCharacter> = {}): DramaCharacter {
  return {
    kind: 'character',
    id: 'char_1',
    key: '主角',
    name: '主角',
    summary: '简介',
    visualNotes: '外形',
    identity: '身份',
    importance: 'main',
    confirmed: false,
    createdAt: 1,
    updatedAt: 1,
    source: 'ai',
    ...overrides,
  };
}

describe('dramaAssets store', () => {
  it('merges extract into library and silent-saves', () => {
    const save = useAppStore.getState().saveCurrentProjectSilent as ReturnType<typeof vi.fn>;
    useAppStore.getState().mergeDramaExtract({
      kind: 'character',
      characters: [sampleCharacter()],
      scenes: [],
      props: [],
    });
    const lib = useAppStore.getState().dramaAssets;
    expect(lib.characters).toHaveLength(1);
    expect(lib.characters[0].name).toBe('主角');
    expect(save).toHaveBeenCalled();
  });

  it('bind / unbind image and sync from node', () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter()],
      },
      nodes: [
        {
          id: 'node-img',
          type: 'ai-image',
          position: { x: 0, y: 0 },
          data: { label: '图', type: 'ai-image', imageUrl: 'https://cdn/x.png' },
        },
      ],
    });

    useAppStore.getState().bindDramaAssetImage('character', 'char_1', 'node-img');
    let asset = useAppStore.getState().dramaAssets.characters[0];
    expect(asset.imageNodeId).toBe('node-img');
    expect(asset.imageUrl).toBe('https://cdn/x.png');

    useAppStore.getState().syncDramaAssetImageFromNode('node-img', 'https://cdn/y.png');
    asset = useAppStore.getState().dramaAssets.characters[0];
    expect(asset.imageUrl).toBe('https://cdn/y.png');

    useAppStore.getState().unbindDramaAssetImage('character', 'char_1');
    asset = useAppStore.getState().dramaAssets.characters[0];
    expect(asset.imageNodeId).toBeUndefined();
    expect(asset.imageUrl).toBeUndefined();
  });

  it('createImageNodeFromDramaAsset creates node, fills prompt, binds', () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter()],
      },
      nodes: [],
    });

    const nodeId = useAppStore.getState().createImageNodeFromDramaAsset('character', 'char_1');
    expect(nodeId).toBeTruthy();

    const nodes = useAppStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(node.type).toBe('ai-image');
    expect(node.data.dramaAssetId).toBe('char_1');
    expect(node.data.prompt).toContain('定妆');
    expect(node.data.prompt).toContain('主角');
    expect(node.data.aspectRatio).toBe('3:4');

    const asset = useAppStore.getState().dramaAssets.characters[0];
    expect(asset.imageNodeId).toBe(nodeId);
  });

  it('confirm and delete asset', () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter()],
      },
    });
    useAppStore.getState().confirmDramaAsset('character', 'char_1', true);
    expect(useAppStore.getState().dramaAssets.characters[0].confirmed).toBe(true);
    useAppStore.getState().deleteDramaAsset('character', 'char_1');
    expect(useAppStore.getState().dramaAssets.characters).toHaveLength(0);
  });

  it('renaming updates key for future merge', () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter({ name: '旧名', key: '旧名' })],
      },
    });
    useAppStore.getState().updateDramaAssetFields('character', 'char_1', {
      name: '新 角色',
      summary: '简介',
      visualNotes: '外形',
    });
    const asset = useAppStore.getState().dramaAssets.characters[0];
    expect(asset.name).toBe('新 角色');
    expect(asset.key).toBe('新角色');
  });

  it('unbind fully removes image fields', () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter({ imageNodeId: 'n1', imageUrl: 'http://x' })],
      },
    });
    useAppStore.getState().unbindDramaAssetImage('character', 'char_1');
    const asset = useAppStore.getState().dramaAssets.characters[0];
    expect(asset).not.toHaveProperty('imageNodeId');
    expect(asset).not.toHaveProperty('imageUrl');
  });
});
