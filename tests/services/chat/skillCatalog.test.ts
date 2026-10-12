import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import {
  buildSkillCatalogPrompt,
  clearSkillCatalogForTests,
  clearSkillCatalogTask,
  claimTaskSkill,
  isSkillModelInvocable,
  listMcpReadableSkills,
  listModelInvocableSkills,
  listUserInvocableSkills,
  projectSkillPickerOptions,
  resolveModelInvocableSkill,
  SKILL_CATALOG_LIMITS,
} from '../../../src/services/chat/skillCatalog';
import type { UserSkill } from '../../../src/types';
import type {
  AgentPackageInstallation,
  AgentPackageSkill,
} from '../../../src/types/agentPackage';

function skill(partial: Partial<UserSkill> = {}): UserSkill {
  return {
    id: 'skill-1',
    name: 'Canvas audit',
    description: 'Audit the canvas',
    fileName: 'SKILL.md',
    content: 'Review the canvas.',
    sourceType: 'file',
    createdAt: 1,
    ...partial,
  };
}

function setSkills(skills: UserSkill[]): void {
  useAppStore.setState({ userSkills: skills, agentPackages: [], agentPackageSkills: [] });
}

function packageSkill(partial: Partial<AgentPackageSkill> = {}): AgentPackageSkill {
  return {
    id: 'ap-skill-1',
    name: '短剧总控',
    description: '路由短剧创作任务',
    fileName: 'SKILL.md',
    content: '# Package Skill',
    sourceType: 'agent-package',
    createdAt: 2,
    installationId: 'installation-1',
    packageId: 'legacy.drama',
    packageName: 'AI短剧知识库',
    packageVersion: '0.0.0-legacy',
    packageContentHash: 'a'.repeat(64),
    sourceId: 'source:opaque-secret',
    entryPath: '00-工作流/short-drama-showrunner/SKILL.md',
    skillRoot: '00-工作流/short-drama-showrunner',
    contentHash: 'b'.repeat(64),
    branch: 'domestic',
    packageUserInvocable: true,
    packageAutoInvoke: false,
    mcpSkillReadEnabled: false,
    readOnly: true,
    ...partial,
  };
}

function packageInstallation(
  skill: AgentPackageSkill,
  partial: Partial<AgentPackageInstallation> = {},
): AgentPackageInstallation {
  return {
    id: skill.installationId,
    packageId: skill.packageId,
    manifest: {
      schemaVersion: 1,
      id: skill.packageId,
      name: skill.packageName,
      version: skill.packageVersion,
      entrypoints: { instructions: 'AGENTS.md' },
      supportedScopes: ['global'],
      supportedSurfaces: ['assistant', 'mcp'],
      routing: {
        userInvocable: skill.packageUserInvocable,
        autoInvoke: skill.packageAutoInvoke,
      },
    },
    source: {
      sourceId: skill.sourceId,
      sourceType: 'folder',
      displayName: skill.packageName,
    },
    entrypoints: [skill.entryPath],
    skillCount: 1,
    fileCount: 1,
    totalBytes: skill.content.length,
    warnings: [],
    health: 'ready',
    contentHash: skill.packageContentHash,
    enabled: true,
    mcpSkillReadEnabled: skill.mcpSkillReadEnabled,
    installedAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

beforeEach(() => {
  clearSkillCatalogForTests();
  setSkills([]);
});

describe('模型可见性', () => {
  it('默认可被模型调用', () => {
    expect(isSkillModelInvocable(skill())).toBe(true);
  });

  it('disable-model-invocation 的 Skill 对模型完全不存在', () => {
    setSkills([skill({ id: 'hidden', manifest: { disableModelInvocation: true } })]);
    expect(listModelInvocableSkills()).toEqual([]);
    expect(resolveModelInvocableSkill('hidden')).toBeUndefined();
    expect(buildSkillCatalogPrompt()).toBe('');
  });

  it('user-invocable: false 仍然对模型可见（两个开关互相独立）', () => {
    setSkills([skill({ id: 'auto', manifest: { userInvocable: false } })]);
    expect(listModelInvocableSkills().map((item) => item.id)).toEqual(['auto']);
    expect(resolveModelInvocableSkill('auto')?.id).toBe('auto');
  });

  it('legacy 包 Skill 只允许用户显式选择，不自动进入模型目录', () => {
    useAppStore.setState({ agentPackageSkills: [packageSkill()] });

    expect(listModelInvocableSkills()).toEqual([]);
    expect(listUserInvocableSkills().map((item) => item.id)).toEqual(['ap-skill-1']);
  });

  it('显式 autoInvoke 的包 Skill 可进入模型目录，但提示词不泄露来源句柄或路径', () => {
    useAppStore.setState({ agentPackageSkills: [packageSkill({ packageAutoInvoke: true })] });

    expect(listModelInvocableSkills().map((item) => item.id)).toEqual(['ap-skill-1']);
    const prompt = buildSkillCatalogPrompt();
    expect(prompt).toContain('AI短剧知识库');
    expect(prompt).not.toContain('source:opaque-secret');
    expect(prompt).not.toContain('00-工作流/short-drama-showrunner/SKILL.md');
  });

  it('MCP 目录只包含显式授权的包 Skill', () => {
    const privateSkill = packageSkill();
    const readableSkill = packageSkill({ id: 'ap-skill-2', mcpSkillReadEnabled: true });
    useAppStore.setState({
      agentPackages: [packageInstallation(readableSkill)],
      agentPackageSkills: [privateSkill, readableSkill],
    });

    expect(listMcpReadableSkills().map((item) => item.id)).toEqual(['ap-skill-2']);
  });

  it('MCP 授权关闭后不等待运行时目录刷新就立即撤权', () => {
    const runtimeSkill = packageSkill({ mcpSkillReadEnabled: true });
    const installation = packageInstallation(runtimeSkill);
    useAppStore.setState({
      agentPackages: [{ ...installation, mcpSkillReadEnabled: false }],
      // 模拟异步 refresh 完成前仍在内存中的旧快照。
      agentPackageSkills: [runtimeSkill],
    });

    expect(listMcpReadableSkills()).toEqual([]);
  });

  it('聊天选择器投影不包含正文、sourceId 或入口路径', () => {
    const options = projectSkillPickerOptions([skill()], [packageSkill()]);
    expect(options).toEqual([
      expect.objectContaining({ sourceKind: 'user', sourceLabel: '我的 Skill' }),
      expect.objectContaining({ sourceKind: 'agent-package', sourceLabel: 'AI短剧知识库' }),
    ]);
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain('# Package Skill');
    expect(serialized).not.toContain('source:opaque-secret');
    expect(serialized).not.toContain('00-工作流/short-drama-showrunner/SKILL.md');
  });
});

describe('buildSkillCatalogPrompt', () => {
  it('目录为空时不产生空标题', () => {
    expect(buildSkillCatalogPrompt()).toBe('');
  });

  it('优先使用 when-to-use，并带不可信边界说明', () => {
    setSkills([skill({
      manifest: { whenToUse: '发布工作流之前使用', description: '不该被选中的描述' },
    })]);
    const prompt = buildSkillCatalogPrompt();
    expect(prompt).toContain('不可信');
    expect(prompt).toContain('skillId: skill-1');
    expect(prompt).toContain('发布工作流之前使用');
    expect(prompt).not.toContain('不该被选中的描述');
  });

  it('把换行、制表符和控制字符折叠为单行纯文本', () => {
    setSkills([skill({
      name: 'Canvas\naudit',
      description: '第一行\n\t第二行\u0007第三行',
      manifest: undefined,
    })]);
    const prompt = buildSkillCatalogPrompt();
    const entry = prompt.split('\n').find((line) => line.includes('skillId: skill-1'));
    expect(entry).toBeDefined();
    expect(entry).toContain('Canvas audit');
    expect(entry).toContain('第一行 第二行 第三行');
    expect(entry).not.toContain('\u0007');
  });

  it('截断超长用途文本', () => {
    setSkills([skill({ description: 'a'.repeat(400), manifest: undefined })]);
    const prompt = buildSkillCatalogPrompt();
    expect(prompt).not.toContain('a'.repeat(SKILL_CATALOG_LIMITS.indexPurposeChars + 1));
  });

  it('按条目数上限保留最新上传的 Skill', () => {
    const total = SKILL_CATALOG_LIMITS.maxIndexEntries + 5;
    setSkills(Array.from({ length: total }, (_, index) => skill({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      description: 'desc',
      createdAt: index,
      manifest: undefined,
    })));
    const prompt = buildSkillCatalogPrompt();
    const entries = prompt.split('\n').filter((line) => line.startsWith('- '));
    expect(entries).toHaveLength(SKILL_CATALOG_LIMITS.maxIndexEntries);
    expect(prompt).toContain(`skillId: skill-${total - 1}`);
    expect(prompt).not.toContain('skillId: skill-0）');
  });

  it('受 token 预算约束', () => {
    setSkills(Array.from({ length: SKILL_CATALOG_LIMITS.maxIndexEntries }, (_, index) => skill({
      id: `skill-${index}`,
      name: `技能名称占位${index}`,
      description: '用途说明'.repeat(20),
      createdAt: index,
      manifest: undefined,
    })));
    const entries = buildSkillCatalogPrompt().split('\n').filter((line) => line.startsWith('- '));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(SKILL_CATALOG_LIMITS.maxIndexEntries);
  });
});

describe('任务级 Skill 数量', () => {
  it('重复读取不占用新的数量配额', () => {
    for (let i = 0; i < 30; i++) expect(claimTaskSkill('task-1', 'skill-1')).toBeUndefined();
  });
  it('不同 Skill 达到上限后拒绝，任务隔离和清理仍有效', () => {
    for (let i = 0; i < 4; i++) expect(claimTaskSkill('task-1', `skill-${i}`)).toBeUndefined();
    expect(claimTaskSkill('task-1', 'extra')).toContain('数量');
    expect(claimTaskSkill('task-2', 'extra')).toBeUndefined();
    clearSkillCatalogTask('task-1');
    expect(claimTaskSkill('task-1', 'extra')).toBeUndefined();
  });
});
