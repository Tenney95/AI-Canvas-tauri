/**
 * episodeAssetRoster — 回归测试：本集资产清单格式。
 */
import { createStore } from 'zustand/vanilla';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { ProjectSaveData } from '../../src/services/storageService';
import {
  emptyEpisodeAssetRoster,
  EPISODE_ASSET_LIMITS,
  episodeScriptFingerprint,
  normalizeEpisodeAssetRoster,
  type EpisodeAssetEntry,
} from '../../src/types/episodeAssets';
import { toProjectSummaryRecord } from '../../src/services/indexedDb/projectSummary';

const mocks = vi.hoisted(() => ({ saveProject: vi.fn() }));
vi.mock('../../src/services/fileService', () => ({
  saveProject: mocks.saveProject, setBaseDataDir: vi.fn(), syncAuthorizedDirectories: vi.fn(),
}));
vi.mock('../../src/services/storageService', () => ({ serializeProjectRecord: vi.fn() }));
vi.mock('../../src/services/projectSnapshotService', () => ({ captureCurrentCanvasSnapshot: vi.fn() }));
vi.mock('../../src/services/pollManager', () => ({ resumePendingTasks: vi.fn(), clearProjectTasks: vi.fn(), cancelNodePolling: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: vi.fn() } }));

import { createProjectSlice } from '../../src/store/store.projects';

const entry = (patch: Partial<EpisodeAssetEntry> = {}): EpisodeAssetEntry => ({
  id: 'entry-1', kind: 'character', name: '林夏', summary: '本集登上末班车',
  visualNotes: '蓝色外套', notes: '本集需要车票', createdAt: 1, updatedAt: 1, ...patch,
});
const roster = () => ({ ...emptyEpisodeAssetRoster(), characters: [entry()] });

function captureExpectedSaveWarning(error: Error) {
  const originalWarn = console.warn.bind(console);
  return vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (args.length !== 2 || args[0] !== '[项目元数据] 保存失败:' || args[1] !== error) originalWarn(...args);
  });
}

function arrange() {
  return createStore<AppState>()((...args) => ({ ...createProjectSlice(...args),
    projects: [
      { id: 'owner', name: '末班车', createdAt: 1, updatedAt: 1 },
      { id: 'episode-1', parentId: 'owner', name: '第一集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-2', parentId: 'owner', name: '第二集', createdAt: 1, updatedAt: 1 },
    ],
    currentProjectId: 'episode-1', projectName: '第一集', projectLoadStatus: 'ready', projectInitialized: true,
    config: { baseDataDir: '' },
    nodes: [], edges: [], groups: [], dramaAssets: { version: 2, characters: [], scenes: [], props: [] },
    showToast: vi.fn(),
  } as unknown as AppState));
}

beforeEach(() => {
  mocks.saveProject.mockReset();
  mocks.saveProject.mockImplementation(async (record: ProjectSaveData) => record.id);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('本集资产清单格式', () => {
  it('旧项目和未知格式缺省为空，不共享可变数组', () => {
    expect(normalizeEpisodeAssetRoster(undefined)).toEqual(emptyEpisodeAssetRoster());
    expect(normalizeEpisodeAssetRoster({ version: 2, characters: [entry()] })).toEqual(emptyEpisodeAssetRoster());
    expect(emptyEpisodeAssetRoster().characters).not.toBe(emptyEpisodeAssetRoster().characters);
    expect(normalizeEpisodeAssetRoster(roster())).toEqual(roster());
    expect(normalizeEpisodeAssetRoster(roster())).not.toHaveProperty('scenes');
  });

  it('场景清单独立归一化，保留绑定与来源版本并拒绝跨类别重复 ID', () => {
    const normalized = normalizeEpisodeAssetRoster({
      ...roster(),
      scenes: [
        entry({ id: 'scene-entry', kind: 'scene', name: ' 末班车站台 ', boundDramaAssetId: 'scene-1',
          appearances: [' 第一场 ', '第一场'], identity: '人物专属字段', ownerName: '道具专属字段' }),
        entry({ kind: 'scene', name: '与角色重复的 ID' }),
        entry({ id: 'wrong-scene-kind', kind: 'prop' }),
      ],
      sourceFingerprints: { scene: episodeScriptFingerprint('第一场 站台 夜') },
    });
    expect(normalized.scenes).toEqual([expect.objectContaining({
      id: 'scene-entry', kind: 'scene', name: '末班车站台', boundDramaAssetId: 'scene-1', appearances: ['第一场'],
    })]);
    expect(normalized.scenes?.[0]).not.toHaveProperty('identity');
    expect(normalized.scenes?.[0]).not.toHaveProperty('ownerName');
    expect(normalized.sourceFingerprints?.scene).toBe(episodeScriptFingerprint('第一场 站台 夜'));
    expect(normalizeEpisodeAssetRoster(normalized)).toEqual(normalized);
  });

  it('只保留白名单文本和本剧业务 ID，去重 ID 并拒绝种类混用', () => {
    const normalized = normalizeEpisodeAssetRoster({
      ...roster(), revision: 3,
      characters: [
        { ...entry(), aliases: [' 夏夏 ', '夏夏', ''], boundDramaAssetId: 'character-1',
          assetId: 'machine-file', filePath: 'not-a-field', ownerName: '不是人物字段' },
        entry({ name: '重复 ID' }),
        entry({ id: 'wrong-kind', kind: 'prop' }),
        entry({ id: 'entry-2', boundDramaAssetId: 'global/character-1' }),
      ],
      props: [entry({ id: 'prop-entry', kind: 'prop', name: '车票', ownerName: '林夏', identity: '不是道具字段' })],
      arbitrary: { secret: 'discard' },
      sourceFingerprints: { character: episodeScriptFingerprint('林夏登车'), scene: 'discard' },
    });
    expect(normalized.revision).toBe(3);
    expect(normalized.characters).toHaveLength(2);
    expect(normalized.characters[0]).toMatchObject({ aliases: ['夏夏'], boundDramaAssetId: 'character-1' });
    expect(normalized.characters[0]).not.toHaveProperty('assetId');
    expect(normalized.characters[0]).not.toHaveProperty('filePath');
    expect(normalized.characters[0]).not.toHaveProperty('ownerName');
    expect(normalized.characters[1]).not.toHaveProperty('boundDramaAssetId');
    expect(normalized.props[0]).toMatchObject({ ownerName: '林夏' });
    expect(normalized.props[0]).not.toHaveProperty('identity');
    expect(normalized).not.toHaveProperty('arbitrary');
    expect(normalized.sourceFingerprints).toEqual({ character: episodeScriptFingerprint('林夏登车') });
  });

  it('限制条目和文本尺寸，拒绝非纯对象与访问器，归一化不修改原值', () => {
    let getterCalled = false;
    const accessor = { ...entry(), id: 'accessor' };
    Object.defineProperty(accessor, 'name', { get: () => { getterCalled = true; return '不应读取'; } });
    const inherited = Object.create(entry()) as EpisodeAssetEntry;
    const raw = {
      ...roster(), revision: -1,
      characters: [accessor, inherited, ...Array.from({ length: 400 }, (_, index) => entry({
        id: `entry-${index}`, name: '字'.repeat(300), notes: '注'.repeat(5000), createdAt: -1, updatedAt: Number.NaN,
      }))],
    };
    const normalized = normalizeEpisodeAssetRoster(raw);
    expect(getterCalled).toBe(false);
    expect(normalized.revision).toBe(0);
    expect(normalized.characters.length).toBeLessThanOrEqual(EPISODE_ASSET_LIMITS.entriesPerKind);
    expect(normalized.characters[0]).toMatchObject({ createdAt: 0, updatedAt: 0 });
    expect(normalized.characters[0].name).toHaveLength(EPISODE_ASSET_LIMITS.name);
    expect(normalized.characters[0].notes).toHaveLength(EPISODE_ASSET_LIMITS.notes);
    expect(raw.characters[2].name).toHaveLength(300);
    expect(normalizeEpisodeAssetRoster(Object.create(roster()))).toEqual(emptyEpisodeAssetRoster());
  });

  it('正文指纹稳定且精确区分内容变化', () => {
    expect(episodeScriptFingerprint('林夏：上车。')).toBe(episodeScriptFingerprint('林夏：上车。'));
    expect(episodeScriptFingerprint('林夏：上车。')).not.toBe(episodeScriptFingerprint('林夏：下车。'));
    expect(episodeScriptFingerprint('台词\r\n')).not.toBe(episodeScriptFingerprint('台词\n'));
  });

  it('分集摘要保留已归一化清单和绑定，顶层项目不持有本集清单', () => {
    const record = { id: 'episode', parentId: 'owner', name: '第一集', episodeAssetRoster: {
      ...roster(), characters: [entry({ boundDramaAssetId: 'character-1' })],
      scenes: [entry({ id: 'scene-entry', kind: 'scene', name: '站台', boundDramaAssetId: 'scene-1' })],
    } };
    const summary = toProjectSummaryRecord(record);
    expect(summary?.episodeAssetRoster?.characters[0].boundDramaAssetId).toBe('character-1');
    expect(summary?.episodeAssetRoster?.scenes?.[0].boundDramaAssetId).toBe('scene-1');
    expect(toProjectSummaryRecord({ ...record, parentId: undefined })).not.toHaveProperty('episodeAssetRoster');
  });
});

describe('本集资产清单持久化门禁', () => {
  it('保存到准确分集并递增版本，正式剧集资产库保持分离', async () => {
    const store = arrange();
    await expect(store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0)).resolves.toBe(true);
    expect(mocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'episode-1', episodeAssetRoster: expect.objectContaining({ revision: 1, characters: [entry()] }),
      dramaAssets: undefined,
    }));
    expect(mocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner', dramaAssets: { version: 2, characters: [], scenes: [], props: [] } }));
    expect(store.getState().projects.find((project) => project.id === 'episode-2')?.episodeAssetRoster).toBeUndefined();
    await expect(store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0)).resolves.toBe(false);
  });

  it('切到同剧另一集、加载中、导航中或失去父项目时都拒绝旧写入', async () => {
    const store = arrange();
    store.setState({ currentProjectId: 'episode-2' });
    await expect(store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0)).resolves.toBe(false);
    store.setState({ currentProjectId: 'episode-1', projectLoadStatus: 'loading' });
    await expect(store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0)).resolves.toBe(false);
    store.setState({ projectLoadStatus: 'ready', switchingProjectName: '第二集' });
    await expect(store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0)).resolves.toBe(false);
    store.setState((state) => ({ switchingProjectName: null, projects: state.projects.filter((project) => project.id !== 'owner') }));
    await expect(store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0)).resolves.toBe(false);
    expect(mocks.saveProject).not.toHaveBeenCalled();
  });

  it('保存失败只撤回本次清单，保留期间修改的正文', async () => {
    const saveError = new Error('模拟保存失败');
    const warningSpy = captureExpectedSaveWarning(saveError);
    const store = arrange();
    let rejectSave!: (reason: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    store.setState({ saveCurrentProjectSilent: () => new Promise<string | undefined>((_, reject) => { rejectSave = reject; entered(); }) });
    const saving = store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0);
    await started;
    store.setState((state) => ({ projects: state.projects.map((project) => project.id === 'episode-1'
      ? { ...project, episodeScript: '后来修改的剧本' } : project) }));
    rejectSave(saveError);
    await expect(saving).resolves.toBe(false);
    expect(store.getState().projects.find((project) => project.id === 'episode-1'))
      .toMatchObject({ episodeScript: '后来修改的剧本', episodeAssetRoster: undefined });
    expect(warningSpy.mock.calls).toEqual([['[项目元数据] 保存失败:', saveError]]);
  });

  it('清单按分集串行保存，旧保存失败后再接受下一份明确版本', async () => {
    const saveError = new Error('旧保存失败');
    const warningSpy = captureExpectedSaveWarning(saveError);
    const store = arrange();
    let rejectSave!: (reason: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const save = vi.fn<AppState['saveCurrentProjectSilent']>()
      .mockImplementationOnce(() => new Promise<string | undefined>((_, reject) => { rejectSave = reject; entered(); }))
      .mockResolvedValue('episode-1');
    store.setState({ saveCurrentProjectSilent: save });
    const oldSave = store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0);
    await started;
    const newer = { ...roster(), characters: [entry({ notes: '后来确认的新备注' })] };
    const nextSave = store.getState().updateEpisodeAssetRoster('episode-1', newer, 0);
    expect(save).toHaveBeenCalledTimes(1);
    rejectSave(saveError);
    await expect(oldSave).resolves.toBe(false);
    await expect(nextSave).resolves.toBe(true);
    expect(store.getState().projects.find((project) => project.id === 'episode-1')?.episodeAssetRoster)
      .toMatchObject({ revision: 1, characters: [expect.objectContaining({ notes: '后来确认的新备注' })] });
    expect(warningSpy.mock.calls).toEqual([['[项目元数据] 保存失败:', saveError]]);
  });

  it('先前正文保存失败不能连带撤销后来已经接受的清单', async () => {
    const saveError = new Error('正文保存失败');
    const warningSpy = captureExpectedSaveWarning(saveError);
    const store = arrange();
    let rejectSave!: (reason: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    store.setState({ saveCurrentProjectSilent: vi.fn<AppState['saveCurrentProjectSilent']>()
      .mockImplementationOnce(() => new Promise<string | undefined>((_, reject) => { rejectSave = reject; entered(); }))
      .mockResolvedValue('episode-1'),
    });
    const savingText = store.getState().updateEpisodeCreative('episode-1', { script: '尚未保存的正文' });
    await started;
    const savingRoster = store.getState().updateEpisodeAssetRoster('episode-1', roster(), 0);
    rejectSave(saveError);
    await expect(savingText).resolves.toBe(false);
    await expect(savingRoster).resolves.toBe(true);
    expect(store.getState().projects.find((project) => project.id === 'episode-1')?.episodeAssetRoster?.revision).toBe(1);
    expect(warningSpy.mock.calls).toEqual([['[项目元数据] 保存失败:', saveError]]);
  });
});
