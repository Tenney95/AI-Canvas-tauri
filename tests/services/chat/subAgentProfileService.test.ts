import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getAllMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const deleteMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/services/indexedDbService', () => ({
  savePresetFolderToDb: vi.fn().mockResolvedValue(undefined),
  loadPresetFoldersFromDb: vi.fn().mockResolvedValue([]),
  deletePresetFolderFromDb: vi.fn().mockResolvedValue(undefined),
  saveSubAgentProfileToDb: saveMock,
  getAllSubAgentProfiles: getAllMock,
  deleteSubAgentProfileFromDb: deleteMock,
  putGlobalCharacterOrder: vi.fn().mockResolvedValue(undefined),
}));

import { useAppStore } from '../../../src/store/useAppStore';
import {
  duplicateProfileAsDraft,
  isBuiltInSubAgentProfileId,
  listBuiltInSubAgentProfiles,
  mergeSubAgentProfiles,
  normalizeStoredSubAgentProfile,
  normalizeSubAgentDraft,
} from '../../../src/services/chat/subAgentProfileService';
import { SUB_AGENT_LIMITS, type SubAgentProfileDraft } from '../../../src/types/subAgent';

function draft(partial: Partial<SubAgentProfileDraft> = {}): SubAgentProfileDraft {
  return {
    name: '台词润色师',
    description: '润色台词口语度',
    instructions: '润色台词，保持人物语气。',
    materials: ['mentioned_nodes'],
    maxRounds: 2,
    ...partial,
  };
}

beforeEach(() => {
  saveMock.mockClear();
  deleteMock.mockClear();
  getAllMock.mockReset().mockResolvedValue([]);
  useAppStore.setState({ subAgentProfiles: [] });
});

describe('内置典范', () => {
  it('提供剧本分析师与分镜师两个典范', () => {
    const names = listBuiltInSubAgentProfiles().map((item) => item.name);
    expect(names).toEqual(['剧本分析师', '分镜师']);
  });

  it('分镜师同时读取引用节点与短剧资产', () => {
    const storyboard = listBuiltInSubAgentProfiles()
      .find((item) => item.name === '分镜师');
    expect(storyboard?.materials).toEqual(['mentioned_nodes', 'drama_assets']);
    expect(storyboard?.builtIn).toBe(true);
  });

  it('返回的是副本，外部改动不影响内置定义', () => {
    listBuiltInSubAgentProfiles()[0].materials.push('drama_assets');
    expect(listBuiltInSubAgentProfiles()[0].materials).toEqual(['mentioned_nodes']);
  });

  it('可识别内置 id', () => {
    expect(isBuiltInSubAgentProfileId('built-in:script-analyst')).toBe(true);
    expect(isBuiltInSubAgentProfileId('custom-1')).toBe(false);
  });

  it('可复制为自定义草稿', () => {
    const source = listBuiltInSubAgentProfiles()[0];
    const copy = duplicateProfileAsDraft(source);
    expect(copy.name).toBe('剧本分析师 副本');
    expect(copy.instructions).toBe(source.instructions);
  });
});

describe('normalizeSubAgentDraft', () => {
  it('把名称与说明压成单行并截断', () => {
    const normalized = normalizeSubAgentDraft(draft({
      name: '台词\n润色师',
      description: 'x'.repeat(400),
    }));
    expect(normalized.name).toBe('台词 润色师');
    expect(normalized.description.length).toBe(SUB_AGENT_LIMITS.descriptionChars);
  });

  it('名称为空时报错', () => {
    expect(() => normalizeSubAgentDraft(draft({ name: '   ' }))).toThrow('名称');
  });

  it('既没有 Skill 也没有提示词时报错', () => {
    expect(() => normalizeSubAgentDraft(draft({ instructions: undefined, skillId: undefined })))
      .toThrow('Skill');
  });

  it('绑定 Skill 时不再要求内联提示词', () => {
    const normalized = normalizeSubAgentDraft(
      draft({ instructions: undefined, skillId: 'skill-1' }),
    );
    expect(normalized.skillId).toBe('skill-1');
  });

  it('轮数越界被夹紧', () => {
    expect(normalizeSubAgentDraft(draft({ maxRounds: 99 })).maxRounds)
      .toBe(SUB_AGENT_LIMITS.maxRounds);
    expect(normalizeSubAgentDraft(draft({ maxRounds: 0 })).maxRounds)
      .toBe(SUB_AGENT_LIMITS.minRounds);
    expect(normalizeSubAgentDraft(draft({ maxRounds: Number.NaN })).maxRounds)
      .toBe(SUB_AGENT_LIMITS.defaultRounds);
  });

  it('材料去重、过滤非法值，为空时回退到引用节点', () => {
    const normalized = normalizeSubAgentDraft(draft({
      materials: ['drama_assets', 'drama_assets', 'nope' as never],
    }));
    expect(normalized.materials).toEqual(['drama_assets']);
    expect(normalizeSubAgentDraft(draft({ materials: [] })).materials)
      .toEqual(['mentioned_nodes']);
  });
});

describe('normalizeStoredSubAgentProfile', () => {
  it('容忍缺失时间戳', () => {
    const restored = normalizeStoredSubAgentProfile({
      id: 'custom-1',
      name: '台词润色师',
      description: '',
      instructions: '润色',
      materials: ['mentioned_nodes'],
      maxRounds: 2,
    });
    expect(restored?.id).toBe('custom-1');
    expect(typeof restored?.createdAt).toBe('number');
  });

  it('无法修复的坏记录返回 null 而不是抛错', () => {
    expect(normalizeStoredSubAgentProfile({ id: 'broken' })).toBeNull();
  });
});

describe('mergeSubAgentProfiles', () => {
  it('内置在前，自定义按更新时间倒序', () => {
    const merged = mergeSubAgentProfiles([
      { ...normalizeSubAgentDraft(draft({ name: '旧' })), id: 'a', createdAt: 1, updatedAt: 1 },
      { ...normalizeSubAgentDraft(draft({ name: '新' })), id: 'b', createdAt: 2, updatedAt: 9 },
    ]);
    expect(merged.map((item) => item.name))
      .toEqual(['剧本分析师', '分镜师', '新', '旧']);
  });
});

describe('Store 行为', () => {
  it('新建后进入列表并持久化', async () => {
    const created = await useAppStore.getState().createSubAgentProfile(draft());
    expect(useAppStore.getState().subAgentProfiles).toHaveLength(1);
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ id: created.id }));
    expect(useAppStore.getState().listSubAgentProfiles().map((item) => item.name))
      .toContain('台词润色师');
  });

  it('内置典范不可编辑也不可删除', async () => {
    await expect(
      useAppStore.getState().updateSubAgentProfile('built-in:script-analyst', draft()),
    ).rejects.toThrow('不可编辑');
    await expect(
      useAppStore.getState().deleteSubAgentProfile('built-in:script-analyst'),
    ).rejects.toThrow('不可删除');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('编辑不存在的配置报错', async () => {
    await expect(useAppStore.getState().updateSubAgentProfile('missing', draft()))
      .rejects.toThrow('找不到');
  });

  it('删除自定义配置会同步清理持久化', async () => {
    const created = await useAppStore.getState().createSubAgentProfile(draft());
    await useAppStore.getState().deleteSubAgentProfile(created.id);
    expect(useAppStore.getState().subAgentProfiles).toHaveLength(0);
    expect(deleteMock).toHaveBeenCalledWith(created.id);
  });

  it('加载时丢弃坏记录并保留可用记录', async () => {
    getAllMock.mockResolvedValue([
      {
        id: 'ok',
        name: '可用',
        description: '',
        instructions: '做事',
        materials: ['mentioned_nodes'],
        maxRounds: 2,
        createdAt: 1,
        updatedAt: 1,
      },
      { id: 'broken', name: '', description: '', materials: [], maxRounds: 1, createdAt: 1, updatedAt: 1 },
    ]);
    await useAppStore.getState().loadSubAgentProfiles();
    expect(useAppStore.getState().subAgentProfiles.map((item) => item.id)).toEqual(['ok']);
  });

  it('读取失败时降级为空列表而不是抛错', async () => {
    getAllMock.mockRejectedValue(new Error('db closed'));
    await expect(useAppStore.getState().loadSubAgentProfiles()).resolves.toBeUndefined();
    expect(useAppStore.getState().subAgentProfiles).toEqual([]);
  });
});
