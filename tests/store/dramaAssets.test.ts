/**
 * dramaAssets — 回归测试：创作资产包批量导入。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { useAppStore } from '../../src/store/useAppStore';
import {
  countUnreadDramaAssets,
  isEligibleCharacterReferenceNode,
  isEligibleCharacterVoiceNode,
} from '../../src/store/store.dramaAssets';
import { filterHiddenCanvasElements } from '../../src/store/store.nodes';
import type { CharacterActionMedia, DramaAsset, DramaCharacter, DramaProp, DramaScene } from '../../src/types/dramaAssets';
import { emptyDramaAssetLibrary } from '../../src/types/dramaAssets';
import { sortCharactersForLibrary } from '../../src/services/characterOrder';
import type { BaseNodeData } from '../../src/types';

const characterLibraryMocks = vi.hoisted(() => ({
  loadGlobalCharacterCards: vi.fn(async () => [] as DramaCharacter[]),
  saveGlobalCharacterCard: vi.fn(async (character: DramaCharacter) => character),
  saveGlobalCharacterOrder: vi.fn(async (_ids: string[]) => undefined),
  deleteGlobalCharacterCard: vi.fn(async () => undefined),
  clearGlobalCharacterCards: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/characterLibraryService', () => characterLibraryMocks);

const globalDramaMocks = vi.hoisted(() => ({
  addImportedGlobalDramaAssets: vi.fn(async (assets: readonly DramaAsset[]) => [...assets]),
  loadGlobalDramaAssetCards: vi.fn(async () => [] as DramaAsset[]),
  saveGlobalDramaAssetCard: vi.fn(async (asset: DramaAsset) => asset),
  deleteGlobalDramaAssetCard: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/globalDramaAssetService', () => globalDramaMocks);

beforeEach(() => {
  vi.clearAllMocks();
  characterLibraryMocks.loadGlobalCharacterCards.mockResolvedValue([]);
  characterLibraryMocks.saveGlobalCharacterCard.mockImplementation(async (character) => character);
  characterLibraryMocks.saveGlobalCharacterOrder.mockResolvedValue(undefined);
  globalDramaMocks.loadGlobalDramaAssetCards.mockResolvedValue([]);
  globalDramaMocks.addImportedGlobalDramaAssets.mockImplementation(async (assets) => [...assets]);
  globalDramaMocks.saveGlobalDramaAssetCard.mockImplementation(async (asset) => asset);
  globalDramaMocks.deleteGlobalDramaAssetCard.mockResolvedValue(undefined);
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

describe('创作资产包批量导入', () => {
  beforeEach(() => useAppStore.setState({ projectLoadStatus: 'ready' }));

  it('同名条目按新身份一次追加，并等待实际保存完成', async () => {
    const existing = sampleCharacter();
    const imported = sampleCharacter({ id: 'imported-character', libraryOrder: 99, referenceImages: [{
      id: 'new-reference', kind: 'primary', imageUrl: 'asset://new.png', prompt: '', createdAt: 1, updatedAt: 1,
    }], primaryReferenceImageId: 'new-reference' });
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters: [existing] } });
    const pending = deferred<string | undefined>();
    const save = vi.fn(() => pending.promise);
    useAppStore.setState({ saveCurrentProjectSilent: save });
    let finished = false;
    const result = useAppStore.getState().importDramaAssets([imported]).then((count) => { finished = true; return count; });
    expect(useAppStore.getState().dramaAssets.characters.map((asset) => asset.id)).toEqual(['char_1', 'imported-character']);
    expect(finished).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    pending.resolve('p1');
    expect(await result).toBe(1);
    expect(useAppStore.getState().dramaAssets.characters[1].primaryReferenceImageId).toBe('new-reference');
    expect(useAppStore.getState().dramaAssets.characters[1].libraryOrder).toBeUndefined();
    expect(useAppStore.getState().dramaAssets.characters[0]).toBe(existing);
  });

  it('重复身份和提前取消不修改原库或触发保存', async () => {
    const original = { ...emptyDramaAssetLibrary(), characters: [sampleCharacter()] };
    useAppStore.setState({ dramaAssets: original });
    const save = useAppStore.getState().saveCurrentProjectSilent;
    await expect(useAppStore.getState().importDramaAssets([sampleCharacter()])).rejects.toThrow('冲突');
    await expect(useAppStore.getState().importDramaAssets([
      sampleCharacter({ id: 'duplicate' }), sampleCharacter({ id: 'duplicate' }),
    ])).rejects.toThrow('冲突');
    const request = new AbortController(); request.abort();
    await expect(useAppStore.getState().importDramaAssets([sampleCharacter({ id: 'new' })], { signal: request.signal }))
      .rejects.toThrow('取消');
    expect(useAppStore.getState().dramaAssets).toBe(original);
    expect(save).not.toHaveBeenCalled();
  });

  it('保存失败只撤回本批 ID，保留期间其他条目的编辑并尝试恢复保存', async () => {
    const existing = sampleCharacter();
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters: [existing] } });
    const pending = deferred<string | undefined>();
    const save = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue('p1');
    useAppStore.setState({ saveCurrentProjectSilent: save });
    const importing = useAppStore.getState().importDramaAssets([sampleCharacter({ id: 'imported' })]);
    const edited = { ...existing, name: '期间编辑' };
    useAppStore.setState((state) => ({ dramaAssets: {
      ...state.dramaAssets, characters: state.dramaAssets.characters.map((asset) => asset.id === existing.id ? edited : asset),
      scenes: [{ kind: 'scene', id: 'other-scene', name: '另建场景', key: '另建场景', summary: '', visualNotes: '',
        importance: 'main', confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual' }],
    } }));
    pending.resolve(undefined);
    await expect(importing).rejects.toThrow('素材文件已保留');
    expect(useAppStore.getState().dramaAssets.characters).toEqual([edited]);
    expect(useAppStore.getState().dramaAssets.scenes[0].id).toBe('other-scene');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('保存已经接受后切项目或取消，不把已保存结果当失败，也不改新项目库', async () => {
    const pending = deferred<string | undefined>();
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(() => pending.promise) });
    const controller = new AbortController();
    const importing = useAppStore.getState().importDramaAssets([sampleCharacter({ id: 'accepted' })], { signal: controller.signal });
    const other = { ...emptyDramaAssetLibrary(), characters: [sampleCharacter({ id: 'other' })] };
    useAppStore.setState({ currentProjectId: 'p2', dramaAssets: other,
      projects: [...useAppStore.getState().projects, { id: 'p2', name: '另一项目', createdAt: 1, updatedAt: 1 }] });
    controller.abort(); pending.resolve('p1');
    expect(await importing).toBe(1);
    expect(useAppStore.getState().dramaAssets).toBe(other);
  });
});

describe('全局创作资产包批量导入', () => {
  it('不依赖当前项目，一次提交三类并等待元数据成功后更新 Store', async () => {
    const original = sampleCharacter({ id: 'existing-global' });
    globalDramaMocks.loadGlobalDramaAssetCards.mockResolvedValue([original]);
    useAppStore.setState({ currentProjectId: null, projectLoadStatus: 'error' });
    const imported = sampleCharacter({ id: 'imported-global', libraryOrder: 42 });
    const scene: DramaScene = { ...imported, kind: 'scene', id: 'imported-scene', referenceImages: undefined };
    const prop: DramaProp = { ...imported, kind: 'prop', id: 'imported-prop', referenceImages: undefined };
    const pending = deferred<DramaAsset[]>();
    globalDramaMocks.addImportedGlobalDramaAssets.mockReturnValueOnce(pending.promise);
    const importing = useAppStore.getState().importGlobalDramaAssets([imported, scene, prop]);
    await vi.waitFor(() => expect(globalDramaMocks.addImportedGlobalDramaAssets).toHaveBeenCalledOnce());
    expect(useAppStore.getState().globalCharacters.map((asset) => asset.id)).toEqual([original.id]);
    expect(globalDramaMocks.addImportedGlobalDramaAssets.mock.calls[0][0][0].kind).toBe('character');
    expect((globalDramaMocks.addImportedGlobalDramaAssets.mock.calls[0][0][0] as DramaCharacter).libraryOrder).toBeUndefined();
    pending.resolve([{ ...imported, libraryOrder: undefined }, scene, prop]);
    expect(await importing).toBe(3);
    expect(useAppStore.getState().globalCharacters.map((asset) => asset.id)).toEqual([original.id, imported.id]);
    expect(useAppStore.getState().globalScenes).toEqual([scene]);
    expect(useAppStore.getState().globalProps).toEqual([prop]);
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    expect(useAppStore.getState().dramaAssets).toEqual(emptyDramaAssetLibrary());
    expect(globalDramaMocks.saveGlobalDramaAssetCard).not.toHaveBeenCalled();
    expect(characterLibraryMocks.saveGlobalCharacterCard).not.toHaveBeenCalled();
  });

  it('加载失败、提前取消或元数据失败均不追加或清空原库', async () => {
    const original = sampleCharacter({ id: 'existing-global' });
    const imported = sampleCharacter({ id: 'imported-global' });
    useAppStore.setState({ globalCharacters: [original] });
    globalDramaMocks.loadGlobalDramaAssetCards.mockRejectedValueOnce(new Error('read failed'));
    await expect(useAppStore.getState().importGlobalDramaAssets([imported])).rejects.toThrow('加载失败');
    expect(useAppStore.getState().globalCharacters).toEqual([original]);
    expect(globalDramaMocks.addImportedGlobalDramaAssets).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(useAppStore.getState().importGlobalDramaAssets([imported], { signal: controller.signal })).rejects.toThrow('取消');
    globalDramaMocks.loadGlobalDramaAssetCards.mockResolvedValue([original]);
    globalDramaMocks.addImportedGlobalDramaAssets.mockRejectedValueOnce(new Error('transaction failed'));
    await expect(useAppStore.getState().importGlobalDramaAssets([imported])).rejects.toThrow('transaction failed');
    expect(useAppStore.getState().globalCharacters).toEqual([original]);
    expect(useAppStore.getState().globalScenes).toEqual([]);
  });

  it('成功事务后的迟到取消或项目切换不漏掉已持久化的全局条目', async () => {
    const controller = new AbortController();
    const imported = sampleCharacter({ id: 'accepted-global' });
    const projectLibrary = { ...emptyDramaAssetLibrary(), characters: [sampleCharacter({ id: 'other-project' })] };
    globalDramaMocks.addImportedGlobalDramaAssets.mockImplementationOnce(async (assets) => {
      controller.abort();
      useAppStore.setState({ currentProjectId: 'other', dramaAssets: projectLibrary });
      return [...assets];
    });
    expect(await useAppStore.getState().importGlobalDramaAssets([imported], { signal: controller.signal })).toBe(1);
    expect(useAppStore.getState().globalCharacters.map((asset) => asset.id)).toEqual([imported.id]);
    expect(useAppStore.getState().dramaAssets).toBe(projectLibrary);
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('旧角色加载迟到不会覆盖本次已导入的新人物', async () => {
    const original = sampleCharacter({ id: 'existing-global' });
    const imported = sampleCharacter({ id: 'imported-global' });
    useAppStore.setState({ globalCharacters: [original] });
    const loading = deferred<DramaCharacter[]>();
    characterLibraryMocks.loadGlobalCharacterCards.mockReturnValueOnce(loading.promise);
    const legacyLoad = useAppStore.getState().loadGlobalCharacters();
    globalDramaMocks.loadGlobalDramaAssetCards.mockResolvedValue([original]);
    expect(await useAppStore.getState().importGlobalDramaAssets([imported])).toBe(1);
    loading.resolve([original]); await legacyLoad;
    expect(useAppStore.getState().globalCharacters.map((asset) => asset.id)).toEqual([original.id, imported.id]);
  });
});

describe('项目创作资产主图身份同步', () => {
  beforeEach(() => useAppStore.setState({ projectLoadStatus: 'ready' }));

  it.each(['scene', 'prop'] as const)('%s 生成补绑和改绑同步新身份，解绑移除全部主图引用', (kind) => {
    const asset = { kind, id: 'imported', name: '导入资产', key: '导入资产', summary: '', visualNotes: '',
      importance: 'main' as const, source: 'manual' as const, confirmed: true, createdAt: 1, updatedAt: 1,
      imageUrl: 'asset://localhost/old.png', assetId: 'old-index', relativePath: 'old.png',
      filePath: '/project/old.png', imageAssetId: 'old-global', imageRelativePath: 'global.png' };
    const library = emptyDramaAssetLibrary();
    if (kind === 'scene') library.scenes.push(asset as DramaScene);
    else library.props.push(asset as DramaProp);
    useAppStore.setState({ dramaAssets: library, nodes: [{
      id: 'new-image', type: 'source-image', position: { x: 0, y: 0 }, data: {
        type: 'source-image', label: '新图', imageUrl: 'asset://localhost/new.png', assetId: 'new-index',
        relativePath: 'new.png', filePath: '/project/new.png', dramaAssetId: asset.id, dramaAssetKind: kind,
      },
    }] });
    const current = () => kind === 'scene' ? useAppStore.getState().dramaAssets.scenes[0] : useAppStore.getState().dramaAssets.props[0];
    useAppStore.getState().syncDramaAssetImageFromNode('new-image', 'asset://localhost/new.png');
    expect(current()).toMatchObject({ assetId: 'new-index', relativePath: 'new.png', filePath: '/project/new.png' });
    expect(current().imageAssetId).toBeUndefined();
    useAppStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, data: {
      ...node.data, assetId: 'regenerated-index', relativePath: 'regenerated.png', filePath: '/project/regenerated.png',
    } })) }));
    useAppStore.getState().syncDramaAssetImageFromNode('new-image', 'asset://localhost/new.png');
    expect(current()).toMatchObject({ assetId: 'regenerated-index', relativePath: 'regenerated.png', filePath: '/project/regenerated.png' });
    useAppStore.getState().bindDramaAssetImage(kind, asset.id, 'missing-node', 'https://example.com/new.png');
    expect(current().assetId).toBeUndefined(); expect(current().relativePath).toBeUndefined();
    expect(current()).toHaveProperty('filePath', undefined);
    useAppStore.getState().unbindDramaAssetImage(kind, asset.id);
    for (const field of ['imageNodeId', 'imageUrl', 'assetId', 'relativePath', 'filePath', 'imageAssetId', 'imageRelativePath']) {
      expect(current()).not.toHaveProperty(field);
    }
  });

  it.each(['scene', 'prop'] as const)('%s 首次生成从显式空参考图补绑，保留可持久化的主图身份', (kind) => {
    const asset = { kind, id: 'empty-asset', name: '新资产', key: '新资产', summary: '', visualNotes: '',
      importance: 'main' as const, source: 'manual' as const, confirmed: true, createdAt: 1, updatedAt: 1,
      referenceImages: [] };
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(),
      scenes: kind === 'scene' ? [asset as DramaScene] : [], props: kind === 'prop' ? [asset as DramaProp] : [] },
    nodes: [{ id: 'generated-image', type: 'ai-image', position: { x: 0, y: 0 }, data: {
      type: 'ai-image', label: '新图', prompt: '资产外观', assetId: 'generated-index',
      relativePath: 'generated.png', filePath: '/project/generated.png',
      dramaAssetId: asset.id, dramaAssetKind: kind,
    } }] });
    useAppStore.getState().syncDramaAssetImageFromNode('generated-image', 'asset://localhost/generated.png');
    const current = kind === 'scene' ? useAppStore.getState().dramaAssets.scenes[0] : useAppStore.getState().dramaAssets.props[0];
    expect(current.referenceImages).toEqual([expect.objectContaining({
      id: current.primaryReferenceImageId, sourceNodeId: 'generated-image', imageUrl: 'asset://localhost/generated.png',
      assetId: 'generated-index', relativePath: 'generated.png', filePath: '/project/generated.png',
    })]);
    expect(current).toMatchObject({ imageNodeId: 'generated-image', imageUrl: 'asset://localhost/generated.png',
      assetId: 'generated-index', relativePath: 'generated.png', filePath: '/project/generated.png' });
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
    useAppStore.getState().syncDramaAssetImageFromNode('generated-image', 'asset://localhost/generated.png');
    const unchanged = kind === 'scene' ? useAppStore.getState().dramaAssets.scenes[0] : useAppStore.getState().dramaAssets.props[0];
    expect(unchanged).toBe(current);
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
  });

  it.each(['scene', 'prop'] as const)('%s 次参考重新生成只更新自身，不被节点归属兜底抢占主图', (kind) => {
    const primary = { id: 'primary', label: '主图', prompt: '', sourceNodeId: 'primary-node',
      imageUrl: 'asset://localhost/primary.png', assetId: 'primary-index', relativePath: 'primary.png',
      createdAt: 1, updatedAt: 1 };
    const secondary = { id: 'secondary', label: '次图', prompt: '', sourceNodeId: 'secondary-node',
      imageUrl: 'asset://localhost/old.png', assetId: 'old-global-index', relativePath: 'old.png',
      assetSource: 'global' as const, createdAt: 1, updatedAt: 1 };
    const asset = { kind, id: 'multi-image', name: '多图资产', key: '多图资产', summary: '', visualNotes: '',
      importance: 'main' as const, source: 'manual' as const, confirmed: true, createdAt: 1, updatedAt: 1,
      referenceImages: [primary, secondary], primaryReferenceImageId: primary.id,
      imageNodeId: primary.sourceNodeId, imageUrl: primary.imageUrl, assetId: primary.assetId, relativePath: primary.relativePath };
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(),
      scenes: kind === 'scene' ? [asset as DramaScene] : [], props: kind === 'prop' ? [asset as DramaProp] : [] },
    nodes: [{ id: secondary.sourceNodeId, type: 'ai-image', position: { x: 0, y: 0 }, data: {
      type: 'ai-image', label: '次图', assetId: 'regenerated-index', relativePath: 'regenerated.png',
      filePath: '/project/regenerated.png', dramaAssetId: asset.id, dramaAssetKind: kind,
    } }] });
    useAppStore.getState().syncDramaAssetImageFromNode(secondary.sourceNodeId, 'asset://localhost/regenerated.png');
    const current = kind === 'scene' ? useAppStore.getState().dramaAssets.scenes[0] : useAppStore.getState().dramaAssets.props[0];
    expect(current).toMatchObject({ primaryReferenceImageId: primary.id, imageNodeId: primary.sourceNodeId,
      imageUrl: primary.imageUrl, assetId: primary.assetId, relativePath: primary.relativePath });
    expect(current.referenceImages?.[0]).toEqual(primary);
    expect(current.referenceImages?.[1]).toMatchObject({ id: secondary.id, label: secondary.label,
      imageUrl: 'asset://localhost/regenerated.png', assetId: 'regenerated-index',
      relativePath: 'regenerated.png', filePath: '/project/regenerated.png' });
    expect(current.referenceImages?.[1].assetSource).toBeUndefined();
    expect(current.imageAssetId).toBeUndefined();
  });

  it('新增次参考不改变导入主图，替换当前参考或编辑主视觉同步完整身份', async () => {
    const first = { id: 'first', kind: 'primary' as const, imageUrl: 'asset://localhost/first.png', assetId: 'first-index',
      relativePath: 'first.png', filePath: '/project/first.png', prompt: '', createdAt: 1, updatedAt: 1 };
    const second = { ...first, id: 'second', kind: 'other' as const, sourceNodeId: 'secondary-node',
      imageUrl: 'asset://localhost/second.png', assetId: 'second-index', relativePath: 'second.png', filePath: '/project/second.png' };
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters: [sampleCharacter({
      imageUrl: first.imageUrl, assetId: first.assetId, relativePath: first.relativePath,
      referenceImages: [first], primaryReferenceImageId: first.id,
    })] } });
    await useAppStore.getState().addCharacterReferenceImage('project', 'char_1', second);
    let character = useAppStore.getState().dramaAssets.characters[0];
    expect(character).toMatchObject({ imageUrl: first.imageUrl, assetId: first.assetId, relativePath: first.relativePath });
    expect(character.imageNodeId).toBeUndefined();
    await useAppStore.getState().addCharacterReferenceImage('project', 'char_1', { ...first,
      imageUrl: 'asset://localhost/replaced.png', assetId: 'replaced-index', relativePath: 'replaced.png', filePath: '/project/replaced.png' });
    character = useAppStore.getState().dramaAssets.characters[0];
    expect(character).toMatchObject({ imageUrl: 'asset://localhost/replaced.png', assetId: 'replaced-index', relativePath: 'replaced.png', filePath: '/project/replaced.png' });
    await useAppStore.getState().saveCharacterCard('project', { ...character, primaryReferenceImageId: second.id });
    character = useAppStore.getState().dramaAssets.characters[0];
    expect(character).toMatchObject({ imageNodeId: 'secondary-node', imageUrl: second.imageUrl, assetId: second.assetId,
      relativePath: second.relativePath, filePath: second.filePath });
    useAppStore.getState().unbindDramaAssetImage('character', character.id);
    character = useAppStore.getState().dramaAssets.characters[0];
    expect(character.referenceImages).toEqual([]);
    for (const field of ['assetId', 'relativePath', 'filePath', 'imageUrl']) expect(character).not.toHaveProperty(field);
  });
});

describe('全局创作资产作用域与异步保存', () => {
  const scene = (): DramaScene => ({
    kind: 'scene', id: 'global-scene', name: '客厅', key: '客厅', summary: '', visualNotes: '',
    importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1,
  });

  it('加载三类共用一个请求，并保留读取期间已保存的编辑', async () => {
    const original = scene();
    useAppStore.setState({ globalScenes: [original] });
    const pending = deferred<DramaAsset[]>();
    globalDramaMocks.loadGlobalDramaAssetCards.mockReturnValueOnce(pending.promise);
    const loading = useAppStore.getState().loadGlobalDramaAssets();
    expect(useAppStore.getState().loadGlobalDramaAssets()).toBe(loading);
    expect(await useAppStore.getState().saveGlobalDramaAsset({ ...original, name: '编辑后' })).toBe(true);
    pending.resolve([original, sampleCharacter({ id: 'global-character' }), { ...original, kind: 'prop', id: 'global-prop' }]);
    await loading;
    expect(useAppStore.getState().globalScenes[0].name).toBe('编辑后');
    expect(useAppStore.getState().globalCharacters[0].id).toBe('global-character');
    expect(useAppStore.getState().globalProps[0].id).toBe('global-prop');
    expect(useAppStore.getState().dramaAssets).toEqual(emptyDramaAssetLibrary());
  });

  it('加载失败保留原列表、显示可重试错误并阻止保存', async () => {
    const original = scene();
    useAppStore.setState({ globalScenes: [original] });
    globalDramaMocks.loadGlobalDramaAssetCards.mockRejectedValueOnce(new Error('private diagnostics'));
    await expect(useAppStore.getState().loadGlobalDramaAssets()).rejects.toThrow('加载失败');
    expect(useAppStore.getState().globalScenes).toEqual([original]);
    expect(useAppStore.getState().globalDramaAssetsError).toBe('全局创作资产加载失败，请重试');
    expect(await useAppStore.getState().saveGlobalDramaAsset({ ...original, name: '错误空库编辑' })).toBe(false);
    expect(globalDramaMocks.saveGlobalDramaAssetCard).not.toHaveBeenCalled();
    await useAppStore.getState().loadGlobalDramaAssets();
    expect(useAppStore.getState().globalDramaAssetsError).toBeNull();
  });

  it('绑定从真实源节点捕获文件身份，切换项目拒绝迟到写回', async () => {
    const original = scene();
    useAppStore.setState({ globalScenes: [original], nodes: [{ id: 'image-source', type: 'source-image',
      position: { x: 0, y: 0 }, data: { type: 'source-image', label: '图像', imageUrl: 'asset://localhost/source.png',
        filePath: 'D:/project/source.png', assetId: 'project-image' } }] });
    const pending = deferred<DramaAsset>();
    globalDramaMocks.saveGlobalDramaAssetCard.mockReturnValueOnce(pending.promise);
    const binding = useAppStore.getState().bindGlobalDramaAssetImage('scene', original.id, 'image-source');
    expect(globalDramaMocks.saveGlobalDramaAssetCard).toHaveBeenCalledWith(expect.objectContaining({
      referenceImages: [expect.objectContaining({ sourceNodeId: 'image-source', assetId: 'project-image',
        filePath: 'D:/project/source.png', imageUrl: 'asset://localhost/source.png' })],
    }), expect.objectContaining({ signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }));
    const savedInput = globalDramaMocks.saveGlobalDramaAssetCard.mock.calls[0][0];
    expect(savedInput.kind !== 'character' && savedInput.primaryReferenceImageId).toBe(savedInput.referenceImages?.[0].id);
    useAppStore.setState({ currentProjectId: 'p2' });
    pending.resolve({ ...original, imageAssetId: 'global-image', imageUrl: 'asset://localhost/global.png' });
    expect(await binding).toBe(false);
    expect(useAppStore.getState().globalScenes).toEqual([original]);
  });

  it('全局人物委托唯一角色记录，删除场景不改项目库和人物', async () => {
    const character = sampleCharacter({ id: 'global-character' });
    const original = scene();
    expect(await useAppStore.getState().saveGlobalDramaAsset(character)).toBe(true);
    expect(characterLibraryMocks.saveGlobalCharacterCard).toHaveBeenCalledOnce();
    expect(globalDramaMocks.saveGlobalDramaAssetCard).not.toHaveBeenCalled();
    useAppStore.setState({ globalScenes: [original] });
    expect(await useAppStore.getState().deleteGlobalDramaAsset('scene', original.id)).toBe(true);
    expect(useAppStore.getState().globalScenes).toEqual([]);
    expect(useAppStore.getState().globalCharacters[0].id).toBe(character.id);
    expect(useAppStore.getState().dramaAssets).toEqual(emptyDramaAssetLibrary());
  });

  it.each(['delete', 'edit', 'sort'] as const)('人物保存期间%s仅排序允许完成，不复活或覆盖其他编辑', async (change) => {
    const original = sampleCharacter({ id: 'global-character' });
    useAppStore.setState({ globalCharacters: [original] });
    const pending = deferred<DramaCharacter>();
    characterLibraryMocks.saveGlobalCharacterCard.mockReturnValueOnce(pending.promise);
    const saving = useAppStore.getState().saveCharacterCard('global', { ...original, summary: '待保存' });
    useAppStore.setState({ globalCharacters: change === 'delete' ? [] : [{ ...original,
      ...(change === 'edit' ? { name: '其他编辑' } : { libraryOrder: 9 }) }] });
    pending.resolve({ ...original, summary: '待保存' });
    expect(await saving).toBe(change === 'sort');
    const saved = useAppStore.getState().globalCharacters[0];
    if (change === 'delete') expect(saved).toBeUndefined();
    else if (change === 'edit') expect(saved.name).toBe('其他编辑');
    else expect(saved).toMatchObject({ summary: '待保存', libraryOrder: 9 });
  });

  it('项目场景改绑或解绑图片清除复制时的全局主图身份', () => {
    const copied = { ...scene(), imageAssetId: 'global-image', imageRelativePath: 'global.png' };
    useAppStore.setState({ projectLoadStatus: 'ready', dramaAssets: { ...emptyDramaAssetLibrary(), scenes: [copied] }, nodes: [{
      id: 'new-image', type: 'source-image', position: { x: 0, y: 0 },
      data: { type: 'source-image', label: '新图', imageUrl: 'data:image/png;base64,AA==' },
    }] });
    useAppStore.getState().bindDramaAssetImage('scene', copied.id, 'new-image');
    expect(useAppStore.getState().dramaAssets.scenes[0].imageAssetId).toBeUndefined();
    useAppStore.getState().unbindDramaAssetImage('scene', copied.id);
    expect(useAppStore.getState().dramaAssets.scenes[0]).not.toHaveProperty('imageRelativePath');
  });
});

describe('角色库排序保存', () => {
  function setup() {
    const characters = [sampleCharacter({ id: 'a', updatedAt: 3 }),
      sampleCharacter({ id: 'b', updatedAt: 2 }), sampleCharacter({ id: 'c', updatedAt: 1 })];
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters }, globalCharacters: characters });
    return characters;
  }
  const projectIds = () => sortCharactersForLibrary(useAppStore.getState().dramaAssets.characters).map((item) => item.id);

  it('搜索子集排序只保存一次，场景道具和全局角色不受影响', async () => {
    const characters = setup();
    expect(await useAppStore.getState().reorderCharacters('project', ['c', 'a'], 'p1')).toBe(true);
    expect(projectIds()).toEqual(['c', 'b', 'a']);
    expect(useAppStore.getState().globalCharacters).toBe(characters);
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().dramaAssets.characters[0].updatedAt).toBe(3);
  });
  it('旧编辑对象保存后仍保持最新顺序', async () => {
    const characters = setup();
    await useAppStore.getState().reorderCharacters('project', ['b', 'a', 'c'], 'p1');
    await useAppStore.getState().saveCharacterCard('project', { ...characters[0], name: '编辑后', updatedAt: 99 });
    expect(projectIds()).toEqual(['b', 'a', 'c']);
  });
  it('全局排序走独立批量保存，不重写媒体', async () => {
    setup();
    expect(await useAppStore.getState().reorderCharacters('global', ['c', 'b', 'a'], 'p1')).toBe(true);
    expect(characterLibraryMocks.saveGlobalCharacterOrder).toHaveBeenCalledWith(['c', 'b', 'a']);
    expect(characterLibraryMocks.saveGlobalCharacterCard).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    expect(projectIds()).toEqual(['a', 'b', 'c']);
  });
  it('全局保存失败恢复顺序，保留同时修改的正文', async () => {
    setup();
    characterLibraryMocks.saveGlobalCharacterOrder.mockImplementationOnce(async () => {
      useAppStore.setState((state) => ({ globalCharacters: state.globalCharacters.map((item) => ({ ...item, name: '并发编辑' })) }));
      throw new Error('disk full');
    });
    expect(await useAppStore.getState().reorderCharacters('global', ['c', 'b', 'a'], 'p1')).toBe(false);
    expect(sortCharactersForLibrary(useAppStore.getState().globalCharacters).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(useAppStore.getState().globalCharacters.every((item) => item.name === '并发编辑')).toBe(true);
  });
  it('保存失败回退排序字段；项目切换后不污染新项目', async () => {
    setup();
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => undefined) });
    expect(await useAppStore.getState().reorderCharacters('project', ['c', 'b', 'a'], 'p1')).toBe(false);
    expect(projectIds()).toEqual(['a', 'b', 'c']);
    const pending = deferred<string | undefined>();
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(() => pending.promise) });
    const result = useAppStore.getState().reorderCharacters('project', ['c', 'b', 'a'], 'p1');
    const other = { ...emptyDramaAssetLibrary(), characters: [sampleCharacter({ id: 'other' })] };
    useAppStore.setState({ currentProjectId: 'p2', dramaAssets: other });
    pending.resolve(undefined);
    expect(await result).toBe(false);
    expect(useAppStore.getState().dramaAssets).toBe(other);
  });
  it('拒绝过期项目、重复 ID 和并发保存，无变化时不写入', async () => {
    setup();
    const store = useAppStore.getState();
    expect(await store.reorderCharacters('project', ['b', 'a'], 'old')).toBe(false);
    expect(await store.reorderCharacters('project', ['a', 'a'], 'p1')).toBe(false);
    expect(await store.reorderCharacters('project', ['a', 'b', 'c'], 'p1')).toBe(true);
    expect(store.saveCurrentProjectSilent).not.toHaveBeenCalled();
    const pending = deferred<string | undefined>();
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(() => pending.promise) });
    const result = store.reorderCharacters('project', ['c', 'b', 'a'], 'p1');
    expect(await store.reorderCharacters('project', ['b', 'a', 'c'], 'p1')).toBe(false);
    pending.resolve('p1');
    expect(await result).toBe(true);
  });
});

describe('角色声音移除与画布来源', () => {
  function setupVoice(sourceNodeId?: string) {
    const node: Node<BaseNodeData> = {
      id: 'audio-1', type: 'ai-audio', position: { x: 20, y: 30 },
      data: { type: 'ai-audio', label: '生成声音', audioUrl: 'https://cdn/voice.wav', hiddenByCharacterLibrary: true },
    };
    const edge: Edge = { id: 'audio-edge', source: node.id, target: 'next' };
    const character = sampleCharacter({
      primaryVoiceClipId: 'voice',
      voiceClips: [{ id: 'voice', kind: 'timbre', audioUrl: node.data.audioUrl, sourceNodeId, transcript: '', createdAt: 1, updatedAt: 1 }],
    });
    useAppStore.setState({ nodes: [node], edges: [edge], dramaAssets: { ...emptyDramaAssetLibrary(), characters: [character] } });
    return { node, edge, character };
  }

  it('解除关联恢复隐藏节点，保留节点内容和连线', async () => {
    const { node, edge } = setupVoice('audio-1');
    const store = useAppStore.getState();
    expect(await store.removeCharacterVoiceClip('project', 'char_1', 'voice')).toBe(true);
    const state = useAppStore.getState();
    expect(state.dramaAssets.characters[0].voiceClips).toEqual([]);
    expect(state.dramaAssets.characters[0].primaryVoiceClipId).toBeUndefined();
    expect(state.nodes).toEqual([{ ...node, data: { ...node.data, hiddenByCharacterLibrary: false } }]);
    expect(state.edges).toEqual([edge]);
    expect(state.selectedNodeIds).toEqual([]);
  });

  it('移除上传声音只删除条目，不按相同 URL 猜测或恢复画布节点', async () => {
    const { node, edge } = setupVoice();
    expect(await useAppStore.getState().removeCharacterVoiceClip('project', 'char_1', 'voice')).toBe(true);
    expect(useAppStore.getState().dramaAssets.characters[0].voiceClips).toEqual([]);
    expect(useAppStore.getState().nodes).toEqual([node]);
    expect(useAppStore.getState().edges).toEqual([edge]);
  });

  it('用上传声音生成台词不会把音频副本登记为来源关联', () => {
    setupVoice();
    const id = useAppStore.getState().createVoiceOverNodeFromCharacterVoice('project', 'char_1', 'voice');
    const state = useAppStore.getState();
    expect(id).toBeTruthy();
    expect(state.dramaAssets.characters[0].voiceClips?.[0].sourceNodeId).toBeUndefined();
    const edge = state.edges.find((item) => item.target === id);
    expect(edge).toBeDefined();
    expect(state.nodes.find((node) => node.id === edge?.source)?.data.audioUrl).toBe('https://cdn/voice.wav');
  });

  it('原关联节点已删除时可移除声音，不创建替代节点', async () => {
    setupVoice('deleted-node');
    const before = useAppStore.getState().nodes;
    expect(await useAppStore.getState().removeCharacterVoiceClip('project', 'char_1', 'voice')).toBe(true);
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('声音保存失败时不解除关联或恢复节点', async () => {
    const { node, character } = setupVoice('audio-1');
    useAppStore.setState({ saveCharacterCard: vi.fn(async () => false) });
    expect(await useAppStore.getState().removeCharacterVoiceClip('project', 'char_1', 'voice')).toBe(false);
    expect(useAppStore.getState().nodes).toEqual([node]);
    expect(useAppStore.getState().dramaAssets.characters).toEqual([character]);
  });

  it.each(['project', 'revision', 'deleted-node'])('等待保存期间 %s 变化不会恢复过期节点', async (change) => {
    setupVoice('audio-1');
    const pending = deferred<boolean>();
    useAppStore.setState({ saveCharacterCard: vi.fn(() => pending.promise) });
    const result = useAppStore.getState().removeCharacterVoiceClip('project', 'char_1', 'voice');
    if (change === 'project') useAppStore.setState({ currentProjectId: 'p2' });
    if (change === 'revision') useAppStore.getState().setCanvasRevision(1);
    if (change === 'deleted-node') useAppStore.setState({ nodes: [] });
    pending.resolve(true);
    expect(await result).toBe(true);
    expect(useAppStore.getState().nodes[0]?.data.hiddenByCharacterLibrary).not.toBe(false);
  });
});

const actionMedia: CharacterActionMedia = {
  id: 'media-1', kind: 'image', name: '站立', url: 'https://cdn/action.png', createdAt: 1, updatedAt: 1,
};

function setupActionCapture() {
  useAppStore.setState({
    dramaAssets: { ...emptyDramaAssetLibrary(), characters: [sampleCharacter()] },
    globalCharacters: [sampleCharacter()],
    selectedNodeIds: ['action-node'],
    nodes: [{
      id: 'action-node', type: 'source-image', selected: true, position: { x: 0, y: 0 },
      data: { type: 'source-image', label: '动作素材', imageUrl: actionMedia.url },
    }],
  });
}

describe('character action canvas visibility', () => {
  it.each([true, false])('captures a new action with hideNode=%s and keeps its node identity', async (hideNode) => {
    setupActionCapture();
    const pending = deferred<string>();
    const save = vi.fn(async () => 'p1').mockImplementationOnce(() => pending.promise);
    useAppStore.setState({ saveCurrentProjectSilent: save });
    const result = useAppStore.getState().addCharacterAction('project', 'char_1', {
      category: 'standing', name: '站立', prompt: '', media: [actionMedia],
    }, { nodeId: 'action-node', hideNode });
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).not.toBe(true);
    pending.resolve('p1');
    const actionId = await result;
    expect(actionId).toBeTruthy();
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toEqual([
      { scope: 'project', characterId: 'char_1', actionId, mediaId: 'media-1' },
    ]);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary === true).toBe(hideNode);
    expect(useAppStore.getState().selectedNodeIds).toEqual(hideNode ? [] : ['action-node']);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('appends media, preserves reference links and supports showing and hiding repeatedly', async () => {
    setupActionCapture();
    const store = useAppStore.getState();
    store.linkNodeToCharacter('action-node', {
      scope: 'project', characterId: 'char_1', referenceImageId: 'ref-1',
    }, false);
    const actionId = await store.addCharacterAction('project', 'char_1', { category: 'standing', name: '站立', prompt: '' });
    expect(await store.addCharacterActionMedia('project', 'char_1', actionId!, [actionMedia], {
      nodeId: 'action-node', hideNode: true,
    })).toBe(true);
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toHaveLength(2);
    store.setCharacterLibraryNodeHidden('action-node', false);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(false);
    store.setCharacterLibraryNodeHidden('action-node', true);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(true);
    // 再收纳为参考图也不能覆盖动作关联。
    store.linkNodeToCharacter('action-node', {
      scope: 'project', characterId: 'char_1', referenceImageId: 'ref-2',
    }, false);
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toHaveLength(2);
    await store.removeCharacterActionMedia('project', 'char_1', actionId!, 'media-1');
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toEqual([
      { scope: 'project', characterId: 'char_1', referenceImageId: 'ref-2' },
    ]);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(true);
  });

  it.each(['project', 'global'] as const)('does not hide or link a node when %s persistence fails', async (scope) => {
    setupActionCapture();
    if (scope === 'project') useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => undefined) });
    else characterLibraryMocks.saveGlobalCharacterCard.mockRejectedValueOnce(new Error('failed'));
    expect(await useAppStore.getState().addCharacterAction(scope, 'char_1', {
      category: 'standing', name: '站立', prompt: '', media: [actionMedia],
    }, { nodeId: 'action-node', hideNode: true })).toBeNull();
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).not.toBe(true);
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toBeUndefined();
    expect(useAppStore.getState().dramaAssets.characters[0].actions).toBeUndefined();
    expect(useAppStore.getState().selectedNodeIds).toEqual(['action-node']);
  });

  it.each(['project', 'revision', 'deleted-node'])('does not hide stale nodes after a %s change during saving', async (change) => {
    setupActionCapture();
    const pending = deferred<string>();
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(() => pending.promise) });
    const result = useAppStore.getState().addCharacterAction('project', 'char_1', {
      category: 'standing', name: '站立', prompt: '', media: [actionMedia],
    }, { nodeId: 'action-node', hideNode: true });
    if (change === 'project') useAppStore.setState({ currentProjectId: 'p2' });
    if (change === 'revision') useAppStore.getState().setCanvasRevision(1);
    if (change === 'deleted-node') useAppStore.setState({ nodes: [] });
    pending.resolve('p1');
    expect(await result).toBeTruthy();
    expect(useAppStore.getState().nodes[0]?.data.hiddenByCharacterLibrary).not.toBe(true);
    expect(useAppStore.getState().nodes[0]?.data.characterLibraryLinks).toBeUndefined();
  });

  it('links global media by stable ids even when global storage rewrites the media url', async () => {
    setupActionCapture();
    characterLibraryMocks.saveGlobalCharacterCard.mockImplementation(async (character) => ({
      ...character,
      actions: character.actions?.map((action) => ({
        ...action, media: action.media?.map((media) => ({ ...media, url: 'asset://global/action.png' })),
      })),
    }));
    const actionId = await useAppStore.getState().addCharacterAction('global', 'char_1', {
      category: 'standing', name: '站立', prompt: '', media: [actionMedia],
    }, { nodeId: 'action-node', hideNode: true });
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toEqual([
      { scope: 'global', characterId: 'char_1', actionId, mediaId: 'media-1' },
    ]);
    expect(useAppStore.getState().globalCharacters[0].actions?.[0].media?.[0].url).toBe('asset://global/action.png');
  });

  it.each(['media', 'action', 'character'])('restores the node when its last %s association is removed', async (removal) => {
    setupActionCapture();
    const store = useAppStore.getState();
    const actionId = await store.addCharacterAction('project', 'char_1', {
      category: 'standing', name: '站立', prompt: '', media: [actionMedia],
    }, { nodeId: 'action-node', hideNode: true });
    if (removal === 'media') await store.removeCharacterActionMedia('project', 'char_1', actionId!, 'media-1');
    if (removal === 'action') await store.removeCharacterAction('project', 'char_1', actionId!);
    if (removal === 'character') store.deleteDramaAsset('character', 'char_1');
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(false);
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toBeUndefined();
  });

  it('can undo and redo canvas hiding without deleting the saved action', async () => {
    setupActionCapture();
    const store = useAppStore.getState();
    await store.addCharacterAction('project', 'char_1', {
      category: 'standing', name: '站立', prompt: '', media: [actionMedia],
    }, { nodeId: 'action-node', hideNode: true });
    expect(await store.undo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).not.toBe(true);
    expect(useAppStore.getState().dramaAssets.characters[0].actions).toHaveLength(1);
    expect(await store.redo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(true);
  });
});

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

    const contentUpdated = nodes.map((node) => ({ ...node, data: { ...node.data, output: '新正文' } }));
    expect(filterHiddenCanvasElements(contentUpdated, edges).edges).toBe(rendered.edges);
    const revealed = contentUpdated.map((node) => ({
      ...node, data: { ...node.data, hiddenByCharacterLibrary: false },
    }));
    expect(filterHiddenCanvasElements(revealed, edges).edges).toBe(edges);
    expect(filterHiddenCanvasElements(contentUpdated, edges).edges).toBe(rendered.edges);
    const replacedEdges = [{ ...edges[0], source: 'visible' }];
    expect(filterHiddenCanvasElements(contentUpdated, replacedEdges).edges).toBe(replacedEdges);
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
    // 连线后自动 @ 上游素材（autoMentionOnConnect 默认开启），提示词会带上声音节点引用
    expect(voiceOverNode?.data.prompt).toBe('你终于来了。 @{audio-1:旁白音频}');
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


describe('canvas visibility membership cache', () => {
  const make = (id: string, data: Partial<BaseNodeData> = {}, parentId?: string): Node<BaseNodeData> => ({
    id, parentId, type: id === 'group' ? 'group' : 'ai-image', position: { x: 0, y: 0 },
    data: { type: 'ai-image', label: id, ...data },
  });

  it('uses the latest geometry without reading unchanged edges again', () => {
    const nodes = [make('hidden', { hiddenByCharacterLibrary: true }), make('visible')];
    const edge: Edge = { id: 'edge', get source() { return 'hidden'; }, target: 'visible' };
    const reads = vi.spyOn(edge, 'source', 'get');
    const edges = [edge];
    const initial = filterHiddenCanvasElements(nodes, edges);
    reads.mockClear();
    const moved = nodes.map((node) => ({ ...node, position: { x: 120, y: 90 }, data: { ...node.data, output: '新正文' } }));
    const next = filterHiddenCanvasElements(moved, edges);
    expect(next.nodes).toEqual([moved[1]]);
    expect(next.edges).toBe(initial.edges);
    expect(reads).not.toHaveBeenCalled();
  });

  it('invalidates on collapsing, reparenting, reordering and a project with reused ids', () => {
    const group = make('group', { groupCollapsed: true }), child = make('child', {}, 'group'), other = make('other');
    const edges: Edge[] = [{ id: 'edge', source: 'child', target: 'other' }];
    expect(filterHiddenCanvasElements([group, child, other], edges).nodes.map((node) => node.id)).toEqual(['group', 'other']);
    const detached = { ...child, parentId: undefined };
    expect(filterHiddenCanvasElements([other, detached, group], edges).edges).toBe(edges);
    expect(filterHiddenCanvasElements([other, child, group], edges).nodes.map((node) => node.id)).toEqual(['other', 'group']);
    const expanded = { ...group, data: { ...group.data, groupCollapsed: false } };
    expect(filterHiddenCanvasElements([expanded, child, other], edges).edges).toBe(edges);
    expect(filterHiddenCanvasElements([], []).nodes).toEqual([]);
    expect(filterHiddenCanvasElements([make('group'), make('child'), make('other')], edges).edges).toBe(edges);
  });
});
