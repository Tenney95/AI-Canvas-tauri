/**
 * episodeAssetService — 回归测试：本集候选提取与显式保存。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const generateText = vi.hoisted(() => vi.fn());
const copyGlobalDramaAssetsToProject = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/ai/generateText', () => ({ generateText }));
vi.mock('../../src/services/dramaAssetTransferService', () => ({ copyGlobalDramaAssetsToProject }));

import { useAppStore, type AppState } from '../../src/store/useAppStore';
import { emptyDramaAssetLibrary, type DramaProp, type DramaScene } from '../../src/types/dramaAssets';
import { emptyEpisodeAssetRoster, type EpisodeAssetEntry } from '../../src/types/episodeAssets';
import type { CopyGlobalDramaAssetsToProjectInput } from '../../src/services/dramaAssetTransferService';
import {
  addLibraryAssetToEpisode, bindEpisodeAsset, extractEpisodeAssetCandidates, mergeEpisodeAssetCandidates,
  promoteEpisodeAssetEntries, removeEpisodeAssetEntry, saveEpisodeAssetEntry,
} from '../../src/services/episodeAssetService';

let saveRoster: ReturnType<typeof vi.fn<AppState['updateEpisodeAssetRoster']>>;
let importAssets: ReturnType<typeof vi.fn<AppState['importDramaAssets']>>;
const script = '第一场 面馆 夜\n周姨把一只旧茶杯放到桌上。';
const entry = (id = 'entry-1', name = '旧茶杯'): EpisodeAssetEntry => ({
  id, kind: 'prop', name, summary: '本集使用的茶杯', visualNotes: '杯沿有缺口', notes: '人工备注', createdAt: 1, updatedAt: 1,
});
const prop = (id = 'formal-1', name = '旧茶杯'): DramaProp => ({
  id, kind: 'prop', key: name, name, summary: '资产库中长期设定', visualNotes: '旧瓷杯',
  importance: 'supporting', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1,
});
const scene = (id = 'scene-1', name = '面馆'): DramaScene => ({
  ...prop(id, name), kind: 'scene', summary: '临街小面馆', visualNotes: '暖色灯光',
});
const roster = () => useAppStore.getState().projects.find((project) => project.id === 'episode-1')!.episodeAssetRoster!;
const setEntries = (entries: EpisodeAssetEntry[]) => useAppStore.setState((state) => ({
  projects: state.projects.map((project) => project.id === 'episode-1'
    ? { ...project, episodeAssetRoster: { ...emptyEpisodeAssetRoster(), props: entries } } : project),
}));

beforeEach(() => {
  generateText.mockReset();
  copyGlobalDramaAssetsToProject.mockReset();
  useAppStore.setState(useAppStore.getInitialState(), true);
  saveRoster = vi.fn<AppState['updateEpisodeAssetRoster']>().mockImplementation(async (id, next, expected) => {
    const current = useAppStore.getState().projects.find((project) => project.id === id);
    if ((current?.episodeAssetRoster?.revision ?? 0) !== expected) return false;
    useAppStore.setState((state) => ({ projects: state.projects.map((project) => project.id === id
      ? { ...project, episodeAssetRoster: { ...next, revision: (expected ?? 0) + 1 } } : project) }));
    return true;
  });
  importAssets = vi.fn<AppState['importDramaAssets']>().mockImplementation(async (assets, options) => {
    options?.assertCurrent?.();
    useAppStore.setState((state) => ({ dramaAssets: { ...state.dramaAssets,
      characters: [...state.dramaAssets.characters, ...assets.filter((asset) => asset.kind === 'character')],
      props: [...state.dramaAssets.props, ...assets.filter((asset) => asset.kind === 'prop')],
      scenes: [...state.dramaAssets.scenes, ...assets.filter((asset) => asset.kind === 'scene')],
    } }));
    return assets.length;
  });
  useAppStore.setState((state) => ({ currentProjectId: 'episode-1', projectLoadStatus: 'ready',
    projects: [{ id: 'series-1', name: '茶馆', createdAt: 1, updatedAt: 1, series: { script } },
      { id: 'episode-1', parentId: 'series-1', name: '第一集', createdAt: 1, updatedAt: 1,
        episodeScript: script, episodeAssetRoster: emptyEpisodeAssetRoster() }],
    dramaAssets: emptyDramaAssetLibrary(),
    updateEpisodeAssetRoster: saveRoster, importDramaAssets: importAssets,
    config: { ...state.config, assistantModelId: 'extract-model',
      providers: { ...state.config.providers, extraction: { name: 'Extraction', apiKey: '', baseUrl: 'https://example.test/v1' } },
      generalModels: [{ id: 'extract-model', name: '提取模型', modelId: 'vendor-model', category: 'text', providerConfigId: 'extraction' }],
    },
  }));
});

describe('本集候选提取与显式保存', () => {
  it('场景提取先预览，合并及正式入库各自显式提交', async () => {
    generateText.mockResolvedValue(JSON.stringify({ kind: 'scene', items: [{ name: '面馆', summary: '夜里的面馆' }] }));
    const candidates = await extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'scene' });
    expect(candidates).toEqual([expect.objectContaining({ name: '面馆', kind: 'scene' })]);
    expect(saveRoster).not.toHaveBeenCalled();
    expect(importAssets).not.toHaveBeenCalled();
    await mergeEpisodeAssetCandidates('episode-1', 'scene', candidates, 0);
    expect(roster().scenes).toHaveLength(1);
    expect(roster().sourceFingerprints?.scene).toMatch(/^v1-/u);
    expect(useAppStore.getState().dramaAssets.scenes).toEqual([]);
    await expect(promoteEpisodeAssetEntries('episode-1', 'scene', [candidates[0].id])).resolves.toBe(1);
    expect(useAppStore.getState().dramaAssets.scenes).toEqual([expect.objectContaining({ kind: 'scene', name: '面馆' })]);
    expect(roster().scenes?.[0].boundDramaAssetId).toBe(useAppStore.getState().dramaAssets.scenes[0].id);
    expect(roster().characters).toEqual([]);
    expect(roster().props).toEqual([]);
  });

  it('可编辑同剧集非画布当前集，始终按目标分集保存', async () => {
    useAppStore.setState((state) => ({ projects: [...state.projects,
      { id: 'episode-2', parentId: 'series-1', name: '第二集', createdAt: 1, updatedAt: 1 }], currentProjectId: 'episode-2' }));
    await saveEpisodeAssetEntry('episode-1', entry(), 0);
    expect(saveRoster).toHaveBeenCalledWith('episode-1', expect.anything(), 0,
      expect.objectContaining({ allowSameSeries: true, assertCommitCurrent: expect.any(Function) }));
    expect(useAppStore.getState().currentProjectId).toBe('episode-2');
    expect(roster().props[0].name).toBe('旧茶杯');
  });

  it('非当前集修改正文后恢复，也使旧提取候选失效', async () => {
    useAppStore.setState((state) => ({ projects: [...state.projects,
      { id: 'episode-2', parentId: 'series-1', name: '第二集', createdAt: 1, updatedAt: 1 }], currentProjectId: 'episode-2' }));
    generateText.mockResolvedValue(JSON.stringify({ kind: 'prop', items: [{ name: '旧茶杯' }] }));
    const candidates = await extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' });
    for (const text of ['改稿', script]) useAppStore.setState((state) => ({ projects: state.projects.map((project) => project.id === 'episode-1'
      ? { ...project, episodeScript: text } : project) }));
    await expect(mergeEpisodeAssetCandidates('episode-1', 'prop', candidates, 0)).rejects.toThrow('提取来源已变化');
    expect(saveRoster).not.toHaveBeenCalled();
  });

  it('提取只返回候选，选择后才加入本集清单，始终不直接入库', async () => {
    generateText.mockResolvedValue(JSON.stringify({ kind: 'prop', items: [{ name: '旧茶杯', summary: '有缺口的茶杯' }] }));
    const candidates = await extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' });
    expect(candidates).toEqual([expect.objectContaining({ name: '旧茶杯', kind: 'prop' })]);
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('原文短引') }));
    expect(saveRoster).not.toHaveBeenCalled();
    expect(importAssets).not.toHaveBeenCalled();
    await mergeEpisodeAssetCandidates('episode-1', 'prop', candidates, 0);
    expect(roster().props).toHaveLength(1);
    expect(roster().sourceFingerprints?.prop).toMatch(/^v1-/u);
    expect(importAssets).not.toHaveBeenCalled();
  });

  it('重复提取保留已有条目的人工编辑和绑定，并能加入不同名称条目', async () => {
    setEntries([{ ...entry(), boundDramaAssetId: 'formal-1', summary: '人工修订' }]);
    generateText.mockResolvedValue(JSON.stringify({ kind: 'prop', items: [{ name: '旧茶杯', summary: 'AI修订' }, { name: '木桌' }] }));
    const candidates = await extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' });
    await mergeEpisodeAssetCandidates('episode-1', 'prop', candidates, 0);
    expect(roster().props).toHaveLength(2);
    expect(roster().props[0]).toEqual(expect.objectContaining({ id: 'entry-1', summary: '人工修订', boundDramaAssetId: 'formal-1' }));
  });

  it('提取期间切走再切回仍拒绝旧结果', async () => {
    let resolve!: (value: string) => void;
    generateText.mockImplementation(() => new Promise<string>((done) => { resolve = done; }));
    const pending = extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' });
    useAppStore.setState({ currentProjectId: 'other' });
    useAppStore.setState({ currentProjectId: 'episode-1' });
    resolve(JSON.stringify({ kind: 'prop', items: [{ name: '旧茶杯' }] }));
    await expect(pending).rejects.toThrow('提取来源已变化');
    expect(saveRoster).not.toHaveBeenCalled();
  });

  it('候选预览后正文修改再恢复也不能把旧候选保存回来', async () => {
    generateText.mockResolvedValue(JSON.stringify({ kind: 'prop', items: [{ name: '旧茶杯' }] }));
    const candidates = await extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' });
    for (const next of ['第二场 空房间', script]) {
      useAppStore.setState((state) => ({ projects: state.projects.map((project) => project.id === 'episode-1'
        ? { ...project, episodeScript: next } : project) }));
    }
    await expect(mergeEpisodeAssetCandidates('episode-1', 'prop', candidates, 0)).rejects.toThrow('提取来源已变化');
  });

  it('不接受伪造候选或过期的本集版本', async () => {
    await expect(mergeEpisodeAssetCandidates('episode-1', 'prop', [entry()], 0)).rejects.toThrow('提取来源已变化');
    await expect(saveEpisodeAssetEntry('episode-1', entry(), 3)).rejects.toThrow('本集清单已变化');
    expect(saveRoster).not.toHaveBeenCalled();
  });

  it('合法空提取不会报错或清空已有本集条目', async () => {
    setEntries([entry()]);
    generateText.mockResolvedValue(JSON.stringify({ kind: 'prop', items: [] }));
    const candidates = await extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' });
    expect(candidates).toEqual([]);
    await mergeEpisodeAssetCandidates('episode-1', 'prop', candidates, 0);
    expect(roster().props).toEqual([entry()]);
    expect(saveRoster).not.toHaveBeenCalled();
  });

  it('空结果仍须类型正确，且不能通过改候选kind转存到另一类', async () => {
    generateText.mockResolvedValueOnce(JSON.stringify({ kind: 'character', items: [] }));
    await expect(extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' })).rejects.toThrow('无法解析');
    generateText.mockResolvedValueOnce(JSON.stringify({ kind: 'prop', items: [{ name: '旧茶杯' }] }));
    const candidates = await extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' });
    candidates[0].kind = 'character';
    await expect(mergeEpisodeAssetCandidates('episode-1', 'character', candidates, 0)).rejects.toThrow('提取来源已变化');
    expect(saveRoster).not.toHaveBeenCalled();
  });

  it('普通项目和导航期间不发起模型或全局复制', async () => {
    useAppStore.setState({ isReturningToStartPage: true });
    await expect(extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' })).rejects.toThrow('项目已切换');
    useAppStore.setState((state) => ({ isReturningToStartPage: false,
      projects: state.projects.map((project) => project.id === 'episode-1' ? { ...project, parentId: undefined } : project) }));
    await expect(extractEpisodeAssetCandidates({ episodeId: 'episode-1', kind: 'prop' })).rejects.toThrow('项目已切换');
    await expect(addLibraryAssetToEpisode('episode-1', 'prop', 'global-prop', 'global')).rejects.toThrow('项目已切换');
    expect(generateText).not.toHaveBeenCalled();
    expect(copyGlobalDramaAssetsToProject).not.toHaveBeenCalled();
  });
});

describe('本集条目和资产库绑定分离', () => {
  it('旧清单可新增场景并绑定无图资产，编辑、解绑和移除不改正式场景', async () => {
    const formal = scene();
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), scenes: [formal] } });
    const draft: EpisodeAssetEntry = { ...entry('scene-entry', '面馆'), kind: 'scene' };
    await saveEpisodeAssetEntry('episode-1', draft, 0);
    await bindEpisodeAsset('episode-1', draft.id, 'scene', formal.id, 'project', 1);
    await saveEpisodeAssetEntry('episode-1', { ...draft, notes: '本集停电', boundDramaAssetId: 'forged' }, 2);
    expect(roster().scenes?.[0]).toMatchObject({ notes: '本集停电', boundDramaAssetId: formal.id });
    await addLibraryAssetToEpisode('episode-1', 'scene', formal.id, 'project', 3);
    expect(roster().scenes).toHaveLength(1);
    await bindEpisodeAsset('episode-1', draft.id, 'scene', null, 'project', 3);
    await removeEpisodeAssetEntry('episode-1', draft.id, 'scene', 4);
    expect(roster().scenes).toEqual([]);
    expect(useAppStore.getState().dramaAssets.scenes).toEqual([formal]);
    expect(importAssets).not.toHaveBeenCalled();
  });

  it('全局场景复制到本剧后加入清单，重复选择复用已保存的本剧身份', async () => {
    const global = { ...scene('global-scene'), imageUrl: 'asset://global-image' };
    useAppStore.setState({ globalScenes: [global] });
    copyGlobalDramaAssetsToProject.mockImplementation(async (input: CopyGlobalDramaAssetsToProjectInput) => {
      await input.commit([{ ...global, id: 'copied-scene', imageUrl: 'asset://local-image',
        assetId: 'local-file-id', relativePath: 'imports/scene.png' }]);
      return { assetCount: 1, mediaCount: 1, assets: [{ kind: 'scene', id: 'copied-scene' }] };
    });
    await addLibraryAssetToEpisode('episode-1', 'scene', global.id, 'global', 0);
    await addLibraryAssetToEpisode('episode-1', 'scene', global.id, 'global', 1);
    expect(copyGlobalDramaAssetsToProject).toHaveBeenCalledTimes(1);
    expect(roster().scenes).toHaveLength(1);
    expect(roster().scenes?.[0].boundDramaAssetId).toBe(useAppStore.getState().dramaAssets.scenes[0].id);
    expect(roster().scenes?.[0].boundDramaAssetId).not.toBe(global.id);
    expect(useAppStore.getState().dramaAssets.scenes[0]).toMatchObject({ assetId: 'local-file-id', imageUrl: 'asset://local-image' });
    expect(useAppStore.getState().globalScenes[0]).toBe(global);
  });

  it('编辑、解绑和移除本集条目都不修改正式资产', async () => {
    const formal = prop();
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), props: [formal] } });
    setEntries([{ ...entry(), boundDramaAssetId: formal.id }]);
    await saveEpisodeAssetEntry('episode-1', { ...entry(), name: '本集专用名', boundDramaAssetId: 'forged' }, 0);
    expect(roster().props[0].boundDramaAssetId).toBe(formal.id);
    await bindEpisodeAsset('episode-1', 'entry-1', 'prop', null, 'project', 1);
    expect(roster().props[0].boundDramaAssetId).toBeUndefined();
    await removeEpisodeAssetEntry('episode-1', 'entry-1', 'prop', 2);
    expect(roster().props).toEqual([]);
    expect(useAppStore.getState().dramaAssets.props).toEqual([formal]);
    expect(importAssets).not.toHaveBeenCalled();
  });

  it('可以绑定和加入没有图片的现有道具，并避免重复加入', async () => {
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), props: [prop()] } });
    setEntries([entry()]);
    await bindEpisodeAsset('episode-1', 'entry-1', 'prop', 'formal-1', 'project', 0);
    expect(roster().props[0].boundDramaAssetId).toBe('formal-1');
    await addLibraryAssetToEpisode('episode-1', 'prop', 'formal-1', 'project', 1);
    expect(roster().props).toHaveLength(1);
    expect(importAssets).not.toHaveBeenCalled();
  });

  it('入库保存失败时不标记条目已绑定', async () => {
    setEntries([entry()]);
    importAssets.mockRejectedValueOnce(new Error('保存失败'));
    await expect(promoteEpisodeAssetEntries('episode-1', 'prop', ['entry-1'])).rejects.toThrow('保存失败');
    expect(roster().props[0].boundDramaAssetId).toBeUndefined();
    expect(saveRoster).not.toHaveBeenCalled();
  });

  it('首轮发布未完成时，第二轮不能读取乐观卡片或启动另一份复制', async () => {
    setEntries([entry()]);
    let reject!: (reason: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    importAssets.mockImplementationOnce(async () => {
      entered();
      return new Promise<number>((_resolve, fail) => { reject = fail; });
    });
    const pending = promoteEpisodeAssetEntries('episode-1', 'prop', ['entry-1']);
    await started;
    await expect(promoteEpisodeAssetEntries('episode-1', 'prop', ['entry-1'])).rejects.toThrow('正在导入创作资产');
    await expect(addLibraryAssetToEpisode('episode-1', 'prop', 'global-prop', 'global')).rejects.toThrow('正在导入创作资产');
    reject(new Error('保存失败'));
    await expect(pending).rejects.toThrow('保存失败');
    expect(copyGlobalDramaAssetsToProject).not.toHaveBeenCalled();
    expect(saveRoster).not.toHaveBeenCalled();
  });

  it('正式资产保存成功而绑定保存失败后，重试复用稳定业务ID', async () => {
    setEntries([entry()]);
    saveRoster.mockResolvedValueOnce(false);
    await expect(promoteEpisodeAssetEntries('episode-1', 'prop', ['entry-1'])).rejects.toThrow('保存失败');
    expect(useAppStore.getState().dramaAssets.props).toHaveLength(1);
    await expect(promoteEpisodeAssetEntries('episode-1', 'prop', ['entry-1'])).resolves.toBe(1);
    expect(importAssets).toHaveBeenCalledTimes(1);
    expect(roster().props[0].boundDramaAssetId).toBe(useAppStore.getState().dramaAssets.props[0].id);
  });

  it('同名已有资产必须显式绑定，不覆盖或重复入库', async () => {
    setEntries([entry()]);
    const formal = prop();
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), props: [formal] } });
    await expect(promoteEpisodeAssetEntries('episode-1', 'prop', ['entry-1'])).rejects.toThrow('请绑定已有资产');
    expect(importAssets).not.toHaveBeenCalled();
    expect(useAppStore.getState().dramaAssets.props[0]).toBe(formal);
  });

  it('不允许绑定含全局路径前缀的伪业务ID', async () => {
    setEntries([entry()]);
    await expect(bindEpisodeAsset('episode-1', 'entry-1', 'prop', 'global/formal-1', 'project', 0)).rejects.toThrow('资产已变化');
    expect(saveRoster).not.toHaveBeenCalled();
  });

  it('全局绑定通过既有物化复制链路拿到本剧正式ID，不留下全局依赖', async () => {
    setEntries([entry()]);
    const global = { ...prop('global-prop'), imageUrl: 'asset://global-image' };
    useAppStore.setState({ globalProps: [global] });
    copyGlobalDramaAssetsToProject.mockImplementation(async (input: CopyGlobalDramaAssetsToProjectInput) => {
      await input.commit([{ ...global, id: 'copied-business-id', imageUrl: 'asset://local-image',
        assetId: 'local-file-id', relativePath: 'imports/local.png' }]);
      return { assetCount: 1, mediaCount: 1, assets: [{ kind: 'prop', id: 'copied-business-id' }] };
    });
    await bindEpisodeAsset('episode-1', 'entry-1', 'prop', global.id, 'global', 0);
    expect(copyGlobalDramaAssetsToProject).toHaveBeenCalledTimes(1);
    expect(roster().props[0].boundDramaAssetId).not.toBe(global.id);
    expect(useAppStore.getState().dramaAssets.props[0]).toEqual(expect.objectContaining({ assetId: 'local-file-id', imageUrl: 'asset://local-image' }));
    expect(useAppStore.getState().globalProps[0]).toBe(global);
  });
});
