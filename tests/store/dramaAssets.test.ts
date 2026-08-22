import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { useAppStore } from '../../src/store/useAppStore';
import {
  countUnreadDramaAssets,
  isEligibleCharacterReferenceNode,
  isEligibleCharacterVoiceNode,
} from '../../src/store/store.dramaAssets';
import { filterHiddenCanvasElements } from '../../src/store/store.nodes';
import type { DramaCharacter } from '../../src/types/dramaAssets';
import { emptyDramaAssetLibrary } from '../../src/types/dramaAssets';
import type { BaseNodeData } from '../../src/types';

const characterLibraryMocks = vi.hoisted(() => ({
  loadGlobalCharacterCards: vi.fn(async () => [] as DramaCharacter[]),
  saveGlobalCharacterCard: vi.fn(async (character: DramaCharacter) => character),
  deleteGlobalCharacterCard: vi.fn(async () => undefined),
  clearGlobalCharacterCards: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/characterLibraryService', () => characterLibraryMocks);

beforeEach(() => {
  vi.clearAllMocks();
  characterLibraryMocks.loadGlobalCharacterCards.mockResolvedValue([]);
  characterLibraryMocks.saveGlobalCharacterCard.mockImplementation(async (character) => character);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('dramaAssets store', () => {
  it('counts only assets created after the library was viewed', () => {
    const library = {
      ...emptyDramaAssetLibrary(),
      lastViewedAt: 10,
      characters: [
        sampleCharacter({ id: 'old', createdAt: 10 }),
        sampleCharacter({ id: 'new', createdAt: 11 }),
      ],
    };

    expect(countUnreadDramaAssets(library)).toBe(1);
    expect(countUnreadDramaAssets({ ...library, lastViewedAt: undefined })).toBe(0);
  });

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
    expect(countUnreadDramaAssets(lib)).toBe(1);
    expect(useAppStore.getState().assetsPanelOpen).toBe(true);
    expect(useAppStore.getState().dramaAssetsPanelOpen).toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it('marks drama assets as viewed and silent-saves', () => {
    const save = useAppStore.getState().saveCurrentProjectSilent as ReturnType<typeof vi.fn>;
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter({ createdAt: Date.now() })],
      },
    });

    useAppStore.getState().markDramaAssetsViewed();

    expect(useAppStore.getState().dramaAssets.lastViewedAt).toEqual(expect.any(Number));
    expect(countUnreadDramaAssets(useAppStore.getState().dramaAssets)).toBe(0);
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
    expect(asset.referenceImages).toEqual([
      expect.objectContaining({
        kind: 'primary',
        sourceNodeId: 'node-img',
        imageUrl: 'https://cdn/x.png',
      }),
    ]);

    useAppStore.getState().syncDramaAssetImageFromNode('node-img', 'https://cdn/y.png');
    asset = useAppStore.getState().dramaAssets.characters[0];
    expect(asset.imageUrl).toBe('https://cdn/y.png');
    expect(asset.referenceImages?.[0].imageUrl).toBe('https://cdn/y.png');

    useAppStore.getState().unbindDramaAssetImage('character', 'char_1');
    asset = useAppStore.getState().dramaAssets.characters[0];
    expect(asset.imageNodeId).toBeUndefined();
    expect(asset.imageUrl).toBeUndefined();
    expect(asset.referenceImages).toEqual([]);
  });

  it('adds multiple references without duplicating the same source node', async () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter()],
      },
    });
    const reference = {
      id: 'ref-full',
      kind: 'full_body' as const,
      imageUrl: 'https://cdn/full.png',
      sourceNodeId: 'node-full',
      prompt: '全身提示词',
      createdAt: 1,
      updatedAt: 1,
    };

    await useAppStore.getState().addCharacterReferenceImage(
      'project',
      'char_1',
      reference,
      { makePrimary: true },
    );
    await useAppStore.getState().addCharacterReferenceImage(
      'project',
      'char_1',
      { ...reference, imageUrl: 'https://cdn/full-v2.png', updatedAt: 2 },
    );

    const character = useAppStore.getState().dramaAssets.characters[0];
    expect(character.referenceImages).toHaveLength(1);
    expect(character.referenceImages?.[0].imageUrl).toBe('https://cdn/full-v2.png');
    expect(character.primaryReferenceImageId).toBe('ref-full');
  });

  it('stores a normalized avatar crop against a reference', async () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter({
          referenceImages: [{
            id: 'ref-avatar',
            kind: 'avatar',
            imageUrl: 'https://cdn/avatar.png',
            prompt: '',
            createdAt: 1,
            updatedAt: 1,
          }],
        })],
      },
    });

    await useAppStore.getState().setCharacterAvatar(
      'project',
      'char_1',
      'ref-avatar',
      { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
    );

    expect(useAppStore.getState().dramaAssets.characters[0]).toEqual(expect.objectContaining({
      avatarReferenceImageId: 'ref-avatar',
      avatarCrop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
    }));
  });

  it('accepts only materialized image nodes as character references', () => {
    expect(isEligibleCharacterReferenceNode({
      type: 'ai-image',
      data: { label: '图像', type: 'ai-image', imageUrl: 'asset://image.png' },
    })).toBe(true);
    expect(isEligibleCharacterReferenceNode({
      type: 'ai-image',
      data: { label: '图像', type: 'ai-image' },
    })).toBe(false);
    expect(isEligibleCharacterReferenceNode({
      type: 'ai-video',
      data: { label: '视频', type: 'ai-video', imageUrl: 'asset://poster.png' },
    })).toBe(false);
  });

  it('persists a project character reference before hiding its source node', async () => {
    const pendingSave = deferred<string | undefined>();
    const commitToHistory = vi.fn();
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter()],
      },
      nodes: [{
        id: 'node-image',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: '角色图',
          type: 'ai-image',
          imageUrl: 'asset://character.png',
          prompt: '银发剑客',
        },
      }],
      saveCurrentProjectSilent: vi.fn(() => pendingSave.promise),
      commitToHistory,
    });

    const capture = useAppStore.getState().captureImageNodeToCharacter({
      nodeId: 'node-image',
      scope: 'project',
      characterId: 'char_1',
      kind: 'full_body',
      prompt: '全身银发剑客',
      hideNode: true,
    });

    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).not.toBe(true);
    expect(commitToHistory).not.toHaveBeenCalled();

    pendingSave.resolve('p1');
    await expect(capture).resolves.toEqual(expect.objectContaining({ characterId: 'char_1' }));
    const state = useAppStore.getState();
    expect(state.dramaAssets.characters[0].referenceImages).toEqual([
      expect.objectContaining({
        kind: 'full_body',
        sourceNodeId: 'node-image',
        imageUrl: 'asset://character.png',
        prompt: '全身银发剑客',
      }),
    ]);
    expect(state.nodes[0].data.hiddenByCharacterLibrary).toBe(true);
    expect(state.nodes[0].data.characterLibraryLinks).toEqual([
      expect.objectContaining({ scope: 'project', characterId: 'char_1' }),
    ]);
    expect(commitToHistory).toHaveBeenCalledOnce();
  });

  it('rolls back a failed project character capture and keeps the node visible', async () => {
    useAppStore.setState({
      dramaAssets: emptyDramaAssetLibrary(),
      nodes: [{
        id: 'node-image',
        type: 'source-image',
        position: { x: 0, y: 0 },
        data: { label: '角色图', type: 'source-image', imageUrl: 'asset://character.png' },
      }],
      saveCurrentProjectSilent: vi.fn(async () => undefined),
      commitToHistory: vi.fn(),
    });

    const result = await useAppStore.getState().captureImageNodeToCharacter({
      nodeId: 'node-image',
      scope: 'project',
      newCharacter: sampleCharacter({ id: 'new-character', name: '新角色' }),
      kind: 'primary',
      prompt: '',
      hideNode: true,
    });

    expect(result).toBeNull();
    expect(useAppStore.getState().dramaAssets.characters).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).not.toBe(true);
    expect(useAppStore.getState().commitToHistory).not.toHaveBeenCalled();
  });

  it('filters hidden nodes and their connected edges without deleting graph data', () => {
    const nodes: Node<BaseNodeData>[] = [
      {
        id: 'hidden',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: { label: '隐藏', type: 'ai-image', hiddenByCharacterLibrary: true },
      },
      {
        id: 'visible',
        type: 'ai-text',
        position: { x: 100, y: 0 },
        data: { label: '显示', type: 'ai-text' },
      },
    ];
    const edges: Edge[] = [{ id: 'edge', source: 'hidden', target: 'visible' }];

    const rendered = filterHiddenCanvasElements(nodes, edges);

    expect(rendered.nodes.map((node) => node.id)).toEqual(['visible']);
    expect(rendered.edges).toEqual([]);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
  });

  it('restores a hidden source and keeps shared nodes hidden until the last character is deleted', () => {
    const commitToHistory = vi.fn();
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter()],
      },
      nodes: [{
        id: 'node-image',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: '角色图',
          type: 'ai-image',
          imageUrl: 'asset://character.png',
          hiddenByCharacterLibrary: true,
          characterLibraryLinks: [
            { scope: 'project', characterId: 'char_1', referenceImageId: 'ref-1' },
            { scope: 'project', characterId: 'char_2', referenceImageId: 'ref-2' },
          ],
        },
      }],
      commitToHistory,
    });

    useAppStore.getState().deleteDramaAsset('character', 'char_1');
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(true);
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toEqual([
      { scope: 'project', characterId: 'char_2', referenceImageId: 'ref-2' },
    ]);

    expect(useAppStore.getState().setCharacterLibraryNodeHidden('node-image', false)).toBe(true);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(false);
    expect(commitToHistory).toHaveBeenCalledTimes(2);

    // 显示之后还能再隐藏回去，不是单向门
    expect(useAppStore.getState().setCharacterLibraryNodeHidden('node-image', true)).toBe(true);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(true);
    expect(useAppStore.getState().selectedNodeIds).not.toContain('node-image');
    // 状态没变化时不提交历史
    expect(useAppStore.getState().setCharacterLibraryNodeHidden('node-image', true)).toBe(false);
    expect(commitToHistory).toHaveBeenCalledTimes(3);
  });

  it('loads permanent characters and copies them into the project independently', async () => {
    characterLibraryMocks.loadGlobalCharacterCards.mockResolvedValue([
      sampleCharacter({ id: 'global-1', name: '永久角色', key: '永久角色' }),
    ]);

    await useAppStore.getState().loadGlobalCharacters();
    expect(useAppStore.getState().globalCharacters).toHaveLength(1);

    const projectId = useAppStore.getState().copyGlobalCharacterToProject('global-1');
    expect(projectId).toBeTruthy();
    expect(projectId).not.toBe('global-1');
    expect(useAppStore.getState().dramaAssets.characters[0].name).toBe('永久角色');
  });

  it('copies a project character to permanent storage before updating state', async () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [sampleCharacter()],
      },
    });
    characterLibraryMocks.saveGlobalCharacterCard.mockImplementation(async (character) => ({
      ...character,
      imageNodeId: undefined,
    }));

    const globalId = await useAppStore.getState().copyCharacterToGlobal('char_1');

    expect(characterLibraryMocks.saveGlobalCharacterCard).toHaveBeenCalledOnce();
    expect(globalId).toBeTruthy();
    expect(globalId).not.toBe('char_1');
    expect(useAppStore.getState().globalCharacters[0].id).toBe(globalId);
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

  it('binds an audio node as a character voice and wires a voice-over node', async () => {
    const audioNode = {
      id: 'audio-1',
      type: 'ai-audio',
      position: { x: 0, y: 0 },
      data: {
        type: 'ai-audio',
        label: '旁白音频',
        audioUrl: 'asset:///project/data/voice.mp3',
        filePath: '/project/data/voice.mp3',
        assetId: 'asset-voice',
      },
    } as unknown as Node<BaseNodeData>;
    useAppStore.setState({
      nodes: [audioNode],
      dramaAssets: { ...emptyDramaAssetLibrary(), characters: [sampleCharacter()] },
    });

    const clipId = await useAppStore.getState().bindAudioNodeToCharacterVoice({
      nodeId: 'audio-1',
      scope: 'project',
      characterId: 'char_1',
      transcript: '你终于来了。',
    });

    expect(clipId).toBeTruthy();
    const character = useAppStore.getState().dramaAssets.characters[0];
    expect(character.primaryVoiceClipId).toBe(clipId);
    // 与节点共用同一份本地文件，不复制副本
    expect(character.voiceClips?.[0]).toEqual(expect.objectContaining({
      sourceNodeId: 'audio-1',
      filePath: '/project/data/voice.mp3',
      assetId: 'asset-voice',
      transcript: '你终于来了。',
    }));

    const voiceOverId = useAppStore.getState()
      .createVoiceOverNodeFromCharacterVoice('project', 'char_1', clipId!);
    expect(voiceOverId).toBeTruthy();

    const state = useAppStore.getState();
    const voiceOverNode = state.nodes.find((node) => node.id === voiceOverId);
    expect(voiceOverNode?.type).toBe('ai-audio');
    expect(voiceOverNode?.data.prompt).toBe('你终于来了。');
    // 连线即引用：音频生成会把这条线上的声音作为音色参考
    expect(state.edges.some((edge) => edge.source === 'audio-1' && edge.target === voiceOverId)).toBe(true);
  });

  it('rejects audio nodes without an audio product', () => {
    expect(isEligibleCharacterVoiceNode({
      type: 'ai-audio',
      data: { type: 'ai-audio', label: '空音频' } as BaseNodeData,
    })).toBe(false);
    expect(isEligibleCharacterVoiceNode({
      type: 'source-image',
      data: { type: 'source-image', label: '图片', audioUrl: 'x' } as unknown as BaseNodeData,
    })).toBe(false);
    expect(isEligibleCharacterVoiceNode({
      type: 'source-audio',
      data: { type: 'source-audio', label: '音频', audioUrl: 'x' } as unknown as BaseNodeData,
    })).toBe(true);
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
