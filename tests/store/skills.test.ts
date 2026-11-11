import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { UserSkill } from '../../src/types';
import type { AgentPackageInstallation, AgentPackageSkill } from '../../src/types/agentPackage';

const mocks = vi.hoisted(() => ({
  saveRecentSkillIds: vi.fn<(ids: readonly string[]) => Promise<void>>(),
  loadRecentSkillIds: vi.fn<() => Promise<string[]>>(),
  loadSkills: vi.fn<() => Promise<UserSkill[]>>(),
  saveSkill: vi.fn<() => Promise<void>>(),
  deleteSkill: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../src/i18n', () => ({ t: (key: string) => key }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: vi.fn(() => { throw new Error('隔离 slice 不应读取全局 Store'); }) },
}));
vi.mock('../../src/store/store.utils', () => ({ generateId: () => 'new-skill' }));
vi.mock('../../src/services/fileService', () => ({
  loadSkills: mocks.loadSkills, saveSkill: mocks.saveSkill, deleteSkill: mocks.deleteSkill,
}));
vi.mock('../../src/services/indexedDb/skillUsageRepository', () => ({
  loadRecentSkillIds: mocks.loadRecentSkillIds, saveRecentSkillIds: mocks.saveRecentSkillIds,
}));

import { createSkillSlice } from '../../src/store/store.skills';

function skill(id: string, manifest?: UserSkill['manifest']): UserSkill {
  return { id, name: id, description: '已有简介', content: '# Skill\n正文保持原样。', fileName: `${id}.md`,
    sourceType: 'file', createdAt: 1, ...(manifest ? { manifest } : {}) };
}

function packageSkill(id: string): AgentPackageSkill {
  return { id, name: id, description: '包内 Skill 简介', content: '# 包内 Skill', fileName: 'SKILL.md',
    sourceType: 'agent-package', createdAt: 1, installationId: `installation-${id}`, packageId: `example.${id}`,
    packageName: id, packageVersion: '1.0.0', packageContentHash: 'a'.repeat(64), sourceId: `source-${id}`,
    entryPath: `skills/${id}/SKILL.md`, skillRoot: `skills/${id}`, contentHash: 'b'.repeat(64), branch: 'shared',
    packageUserInvocable: true, packageAutoInvoke: false, mcpSkillReadEnabled: false, readOnly: true };
}

function installation(item: AgentPackageSkill): AgentPackageInstallation {
  return { id: item.installationId, packageId: item.packageId,
    manifest: { schemaVersion: 1, id: item.packageId, name: item.packageName, version: item.packageVersion,
      entrypoints: { instructions: 'AGENTS.md' }, supportedScopes: ['global'], supportedSurfaces: ['assistant'],
      routing: { userInvocable: true, autoInvoke: false } },
    source: { sourceId: item.sourceId, sourceType: 'folder', displayName: item.packageName },
    entrypoints: [item.entryPath], skillCount: 1, fileCount: 1, totalBytes: item.content.length, warnings: [],
    health: 'ready', contentHash: item.packageContentHash, enabled: true, mcpSkillReadEnabled: false,
    installedAt: 1, updatedAt: 1 };
}

function store(skills: UserSkill[] = []) {
  const state = createStore<AppState>()((set, get, api) => ({ ...createSkillSlice(set, get, api), showToast: vi.fn() }) as unknown as AppState);
  state.setState({ userSkills: skills, agentPackages: [], agentPackageSkills: [] });
  return state;
}

beforeEach(() => {
  mocks.saveRecentSkillIds.mockReset().mockResolvedValue(undefined);
  mocks.loadRecentSkillIds.mockReset().mockResolvedValue([]);
  mocks.loadSkills.mockReset().mockResolvedValue([]);
  mocks.saveSkill.mockReset().mockResolvedValue(undefined);
  mocks.deleteSkill.mockReset().mockResolvedValue(undefined);
});

describe('Skill 的独立最近使用记录', () => {
  it('只记录可显式调用的已有 Skill，去重前置并最多保留五项，不改正文或声明', async () => {
    const skills = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => skill(id));
    skills.push(skill('hidden', { userInvocable: false }));
    const original = structuredClone(skills), state = store(skills);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'c', 'missing', 'hidden']) await state.getState().markSkillUsed(id);

    expect(state.getState().recentSkillIds).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect(mocks.saveRecentSkillIds).toHaveBeenCalledTimes(7);
    expect(state.getState().userSkills).toEqual(original);
    expect(mocks.saveSkill).not.toHaveBeenCalled();
  });

  it('两个已安装包 Skill 连续使用后与上传 Skill 共用顺序，重复选择前置且不改 Skill', async () => {
    const uploaded = skill('uploaded'), first = packageSkill('package-first'), second = packageSkill('package-second');
    const state = store([uploaded]);
    const agentPackages = [installation(first), installation(second)], agentPackageSkills = [first, second];
    state.setState({ agentPackages, agentPackageSkills });
    const original = structuredClone({ userSkills: [uploaded], agentPackages, agentPackageSkills });
    for (const id of [first.id, second.id, uploaded.id, first.id]) await state.getState().markSkillUsed(id);

    expect(state.getState().recentSkillIds).toEqual([first.id, uploaded.id, second.id]);
    expect(mocks.saveRecentSkillIds.mock.calls.map(([ids]) => ids)).toEqual([
      [first.id], [second.id, first.id], [uploaded.id, second.id, first.id], [first.id, uploaded.id, second.id],
    ]);
    expect(state.getState()).toMatchObject(original);
    expect(mocks.saveSkill).not.toHaveBeenCalled();
  });

  it.each(['missing-installation', 'disabled', 'routing', 'invalid', 'missing', 'changed-hash'] as const)(
    '包 Skill 当前安装状态为 %s 时不记录，旧运行时目录不能代替当前授权', async (unavailable) => {
      const packaged = packageSkill('unavailable-package'), record = installation(packaged), state = store([skill('uploaded')]);
      if (unavailable === 'disabled') record.enabled = false;
      if (unavailable === 'routing') record.manifest.routing.userInvocable = false;
      if (unavailable === 'invalid' || unavailable === 'missing') record.health = unavailable;
      if (unavailable === 'changed-hash') record.contentHash = 'c'.repeat(64);
      state.setState({ agentPackages: unavailable === 'missing-installation' ? [] : [record], agentPackageSkills: [packaged],
        recentSkillIds: ['uploaded'] });
      await state.getState().markSkillUsed(packaged.id);

      expect(state.getState().recentSkillIds).toEqual(['uploaded']);
      expect(mocks.saveRecentSkillIds).not.toHaveBeenCalled();
    },
  );

  it('串行读取最新顺序，持久化完成前不改变最近使用状态', async () => {
    let finish!: () => void;
    mocks.saveRecentSkillIds.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const state = store([skill('a'), skill('b')]);
    const first = state.getState().markSkillUsed('a');
    const second = state.getState().markSkillUsed('b');
    await Promise.resolve();
    expect(mocks.saveRecentSkillIds).toHaveBeenCalledOnce();
    expect(state.getState().recentSkillIds).toEqual([]);
    finish();
    await Promise.all([first, second]);

    expect(mocks.saveRecentSkillIds.mock.calls.map(([ids]) => ids)).toEqual([['a'], ['b', 'a']]);
    expect(state.getState().recentSkillIds).toEqual(['b', 'a']);
  });

  it('保存失败保留原状态，后续使用仍可正常记录', async () => {
    const state = store([skill('a'), skill('b')]);
    mocks.saveRecentSkillIds.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(state.getState().markSkillUsed('a')).rejects.toThrow('storage unavailable');
    expect(state.getState().recentSkillIds).toEqual([]);
    await state.getState().markSkillUsed('b');
    expect(state.getState().recentSkillIds).toEqual(['b']);
  });

  it('加载只恢复仓储规范化的近期 ID，不按上传目录过滤，同时修复旧 JSON 简介', async () => {
    const uploaded = { ...skill('json'), description: '{', content: '{"description":"分析人物关系。"}' };
    mocks.loadSkills.mockResolvedValue([uploaded, skill('hidden', { userInvocable: false })]);
    mocks.loadRecentSkillIds.mockResolvedValue(['deleted', 'hidden', 'json']);
    const state = store();
    await state.getState().loadSkills();

    expect(state.getState().recentSkillIds).toEqual(['deleted', 'hidden', 'json']);
    expect(mocks.saveRecentSkillIds).not.toHaveBeenCalled();
    expect(state.getState().userSkills[0]).toMatchObject({ description: '分析人物关系。', content: uploaded.content });
  });

  it('空上传目录加载清除上传 Skill，但不覆盖未解析的近期 ID', async () => {
    const state = store([skill('deleted')]);
    state.setState({ recentSkillIds: ['deleted'] });
    mocks.loadRecentSkillIds.mockResolvedValue(['deleted']);
    await state.getState().loadSkills();
    expect(state.getState().userSkills).toEqual([]);
    expect(state.getState().recentSkillIds).toEqual(['deleted']);
    expect(mocks.saveRecentSkillIds).not.toHaveBeenCalled();
  });

  it('重启时上传目录先加载，包目录尚未就绪也保留两个包 Skill 的近期 ID，不写修复', async () => {
    const first = packageSkill('package-first'), second = packageSkill('package-second'), uploaded = skill('uploaded');
    mocks.loadSkills.mockResolvedValue([uploaded]);
    mocks.loadRecentSkillIds.mockResolvedValue([second.id, uploaded.id, first.id]);
    const state = store();
    await state.getState().loadSkills();

    expect(state.getState().userSkills).toEqual([uploaded]);
    expect(state.getState().agentPackages).toEqual([]);
    expect(state.getState().agentPackageSkills).toEqual([]);
    expect(state.getState().recentSkillIds).toEqual([second.id, uploaded.id, first.id]);
    expect(mocks.saveRecentSkillIds).not.toHaveBeenCalled();
  });

  it('最近记录读取失败不阻断 Skill 加载，不以空记录覆盖原偏好', async () => {
    const state = store([skill('a')]);
    state.setState({ recentSkillIds: ['a'] });
    mocks.loadSkills.mockResolvedValue([skill('a'), skill('b')]);
    mocks.loadRecentSkillIds.mockRejectedValueOnce(new Error('corrupt recent metadata'));

    await expect(state.getState().loadSkills()).resolves.toBeUndefined();

    expect(state.getState().userSkills.map((item) => item.id)).toEqual(['a', 'b']);
    expect(state.getState().recentSkillIds).toEqual(['a']);
    expect(state.getState().showToast).toHaveBeenCalledWith('最近 Skill 使用记录读取失败', 'error');
    expect(mocks.saveRecentSkillIds).not.toHaveBeenCalled();
  });

  it.each([false, true])('删除 Skill 保留其他近期项，偏好保存失败不阻断删除（失败：%s）', async (failed) => {
    const state = store([skill('a'), skill('b')]);
    state.setState({ recentSkillIds: ['a', 'package-not-loaded', 'b'] });
    if (failed) mocks.saveRecentSkillIds.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(state.getState().deleteSkill('a')).resolves.toBeUndefined();
    expect(state.getState().recentSkillIds).toEqual(['package-not-loaded', 'b']);
    expect(state.getState().userSkills.map((item) => item.id)).toEqual(['b']);
    expect(mocks.saveRecentSkillIds).toHaveBeenLastCalledWith(['package-not-loaded', 'b']);
    expect(mocks.deleteSkill).toHaveBeenCalledWith('a');
    if (failed) expect(state.getState().showToast).toHaveBeenCalledWith('最近 Skill 使用记录保存失败', 'error');
  });

  it('新上传的 JSON 内容复用简介提取，不把 JSON 声明作为执行权限', async () => {
    const state = store();
    const content = '{"description":"梳理故事线。","user-invocable":false,"allowed-tools":["canvas_query"]}';
    const created = await state.getState().createSkillFromContent('story.json', content);
    expect(created).toMatchObject({ description: '梳理故事线。', content });
    expect(created.manifest).toBeUndefined();
  });
});
