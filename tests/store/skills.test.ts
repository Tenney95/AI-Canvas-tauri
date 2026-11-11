import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { UserSkill } from '../../src/types';

const mocks = vi.hoisted(() => ({
  saveRecentSkillIds: vi.fn<(ids: readonly string[]) => Promise<void>>(),
  loadRecentSkillIds: vi.fn<() => Promise<string[]>>(),
  loadSkills: vi.fn<() => Promise<UserSkill[]>>(),
  saveSkill: vi.fn<() => Promise<void>>(),
  deleteSkill: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../src/i18n', () => ({ t: (key: string) => key }));
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

function store(skills: UserSkill[] = []) {
  const state = createStore<AppState>()((set, get, api) => ({ ...createSkillSlice(set, get, api), showToast: vi.fn() }) as AppState);
  state.setState({ userSkills: skills });
  return state;
}

beforeEach(() => {
  mocks.saveRecentSkillIds.mockReset().mockResolvedValue(undefined);
  mocks.loadRecentSkillIds.mockReset().mockResolvedValue([]);
  mocks.loadSkills.mockReset().mockResolvedValue([]);
  mocks.saveSkill.mockReset().mockResolvedValue(undefined);
  mocks.deleteSkill.mockReset().mockResolvedValue(undefined);
});

describe('上传 Skill 的独立最近使用记录', () => {
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

  it('加载时过滤已删除、不可显式调用和重复项，并修复旧 JSON 简介', async () => {
    const uploaded = { ...skill('json'), description: '{', content: '{"description":"分析人物关系。"}' };
    mocks.loadSkills.mockResolvedValue([uploaded, skill('hidden', { userInvocable: false })]);
    mocks.loadRecentSkillIds.mockResolvedValue(['deleted', 'hidden', 'json', 'json']);
    const state = store();
    await state.getState().loadSkills();

    expect(state.getState().recentSkillIds).toEqual(['json']);
    expect(mocks.saveRecentSkillIds).toHaveBeenCalledWith(['json']);
    expect(state.getState().userSkills[0]).toMatchObject({ description: '分析人物关系。', content: uploaded.content });
  });

  it('空目录加载清除已不存在的 Skill 和最近记录', async () => {
    const state = store([skill('deleted')]);
    state.setState({ recentSkillIds: ['deleted'] });
    mocks.loadRecentSkillIds.mockResolvedValue(['deleted']);
    await state.getState().loadSkills();
    expect(state.getState().userSkills).toEqual([]);
    expect(state.getState().recentSkillIds).toEqual([]);
    expect(mocks.saveRecentSkillIds).toHaveBeenCalledWith([]);
  });

  it.each(['read', 'repair'])('最近记录 %s 失败不阻断 Skill 加载，不以空记录覆盖原偏好', async (failure) => {
    const state = store([skill('a')]);
    state.setState({ recentSkillIds: ['a'] });
    mocks.loadSkills.mockResolvedValue([skill('a'), skill('b')]);
    if (failure === 'read') mocks.loadRecentSkillIds.mockRejectedValueOnce(new Error('corrupt recent metadata'));
    else {
      mocks.loadRecentSkillIds.mockResolvedValue(['deleted', 'b']);
      mocks.saveRecentSkillIds.mockRejectedValueOnce(new Error('recent metadata write failed'));
    }

    await expect(state.getState().loadSkills()).resolves.toBeUndefined();

    expect(state.getState().userSkills.map((item) => item.id)).toEqual(['a', 'b']);
    expect(state.getState().recentSkillIds).toEqual(['a']);
    expect(state.getState().showToast).toHaveBeenCalledWith('最近 Skill 使用记录读取失败', 'error');
    if (failure === 'read') expect(mocks.saveRecentSkillIds).not.toHaveBeenCalled();
    else expect(mocks.saveRecentSkillIds).toHaveBeenCalledWith(['b']);
    expect(mocks.saveRecentSkillIds).not.toHaveBeenCalledWith([]);
  });

  it.each([false, true])('删除 Skill 保留其他近期项，偏好保存失败不阻断删除（失败：%s）', async (failed) => {
    const state = store([skill('a'), skill('b')]);
    state.setState({ recentSkillIds: ['a', 'b'] });
    if (failed) mocks.saveRecentSkillIds.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(state.getState().deleteSkill('a')).resolves.toBeUndefined();
    expect(state.getState().recentSkillIds).toEqual(['b']);
    expect(state.getState().userSkills.map((item) => item.id)).toEqual(['b']);
    expect(mocks.saveRecentSkillIds).toHaveBeenLastCalledWith(['b']);
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
