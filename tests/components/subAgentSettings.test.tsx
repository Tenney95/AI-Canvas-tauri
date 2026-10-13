import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/indexedDbService', () => ({
  savePresetFolderToDb: vi.fn().mockResolvedValue(undefined),
  loadPresetFoldersFromDb: vi.fn().mockResolvedValue([]),
  deletePresetFolderFromDb: vi.fn().mockResolvedValue(undefined),
  saveSubAgentProfileToDb: vi.fn().mockResolvedValue(undefined),
  getAllSubAgentProfiles: vi.fn().mockResolvedValue([]),
  deleteSubAgentProfileFromDb: vi.fn().mockResolvedValue(undefined),
  putGlobalCharacterOrder: vi.fn().mockResolvedValue(undefined),
}));

import SubAgentSettings, {
  SubAgentProfileList,
} from '../../src/components/settings/SubAgentSettings';
import { useAppStore } from '../../src/store/useAppStore';
import {
  duplicateProfileAsDraft,
  listBuiltInSubAgentProfiles,
  mergeSubAgentProfiles,
} from '../../src/services/chat/subAgentProfileService';
import { SUB_AGENT_LIMITS, type SubAgentProfile } from '../../src/types/subAgent';

function customProfile(partial: Partial<SubAgentProfile> = {}): SubAgentProfile {
  return {
    id: 'custom-1',
    name: '台词润色师',
    description: '润色台词口语度',
    instructions: '润色台词',
    materials: ['mentioned_nodes'],
    maxRounds: 2,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

beforeEach(() => {
  useAppStore.setState({ subAgentProfiles: [], userSkills: [] });
});

describe('SubAgentSettings', () => {
  it('列出内置典范并标记为内置', () => {
    const markup = renderToStaticMarkup(<SubAgentSettings />);
    expect(markup).toContain('剧本分析师');
    expect(markup).toContain('分镜师');
    expect(markup).toContain('内置');
  });

  it('内置典范只给复制入口，不给编辑和删除', () => {
    const markup = renderToStaticMarkup(<SubAgentSettings />);
    expect(markup).toContain('aria-label="复制 剧本分析师"');
    expect(markup).not.toContain('aria-label="编辑 剧本分析师"');
    expect(markup).not.toContain('aria-label="删除 剧本分析师"');
  });

  it('说明只读边界与落地责任', () => {
    const markup = renderToStaticMarkup(<SubAgentSettings />);
    expect(markup).toContain('不能修改画布或生成媒体');
    expect(markup).toContain('经你确认');
  });

});

describe('SubAgentProfileList', () => {
  const noop = () => {};
  const render = (profiles: SubAgentProfile[]) => renderToStaticMarkup(
    <SubAgentProfileList
      profiles={profiles}
      onEdit={noop}
      onDuplicate={noop}
      onDelete={noop}
    />,
  );

  it('自定义配置给出编辑与删除入口', () => {
    const markup = render([customProfile()]);
    expect(markup).toContain('台词润色师');
    expect(markup).toContain('aria-label="编辑 台词润色师"');
    expect(markup).toContain('aria-label="删除 台词润色师"');
  });

  it('内置典范只给复制入口', () => {
    const markup = render(mergeSubAgentProfiles([]));
    expect(markup).toContain('aria-label="复制 剧本分析师"');
    expect(markup).not.toContain('aria-label="编辑 剧本分析师"');
    expect(markup).not.toContain('aria-label="删除 剧本分析师"');
  });

  it('展示材料与轮数摘要', () => {
    const markup = render([
      customProfile({ materials: ['mentioned_nodes', 'drama_assets'] }),
    ]);
    expect(markup).toContain('用户 @ 引用的节点正文');
    expect(markup).toContain('当前项目的短剧资产');
    expect(markup).toContain('最多 2 轮');
  });

  it('绑定 Skill 的配置有标记', () => {
    expect(render([customProfile({ skillId: 'skill-1' })])).toContain('绑定 Skill');
  });

  it('没有说明时给出占位文案', () => {
    expect(render([customProfile({ description: '' })])).toContain('（未填写说明）');
  });
});

describe('复制内置典范', () => {
  it('生成带副本后缀的草稿并保留角色提示词', () => {
    const source = listBuiltInSubAgentProfiles()[0];
    const copy = duplicateProfileAsDraft(source);
    expect(copy.name).toContain('副本');
    expect(copy.instructions).toBe(source.instructions);
    expect(copy.materials).toEqual(source.materials);
  });

  it('轮数上限与配额常量一致', () => {
    expect(SUB_AGENT_LIMITS.maxRounds).toBeGreaterThanOrEqual(SUB_AGENT_LIMITS.minRounds);
    expect(SUB_AGENT_LIMITS.defaultRounds).toBeLessThanOrEqual(SUB_AGENT_LIMITS.maxRounds);
  });
});

describe('SubAgentPanel', () => {
  it('作为 AI 助手内的面板渲染，标题不与内部标题重复', async () => {
    const { default: SubAgentPanel } = await import('../../src/components/chat/SubAgentPanel');
    const markup = renderToStaticMarkup(<SubAgentPanel onClose={() => {}} />);
    // 标题由面板标题栏承担，内部 h3 被 hideHeading 抑制，避免重复标题
    expect(markup).not.toContain('<h3');
    expect(markup).toContain('2 个');
    expect(markup).toContain('剧本分析师');
    expect(markup).toContain('新建');
  });
});
