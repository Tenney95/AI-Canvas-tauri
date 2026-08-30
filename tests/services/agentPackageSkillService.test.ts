import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readAgentPackageSourceTextMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/agentPackages/agentPackageImportService', () => ({
  readAgentPackageSourceText: readAgentPackageSourceTextMock,
}));

import {
  AGENT_PACKAGE_SKILL_LIMITS,
  classifyAgentPackageSkillBranch,
  clearAgentPackageSkillCacheForTests,
  createAgentPackageSkillId,
  listAgentPackageSkillResources,
  loadAgentPackageSkillCatalog,
  readAgentPackageSkillResource,
  resolveAgentPackageSkillResourcePath,
} from '../../src/services/agentPackages/agentPackageSkillService';
import type {
  AgentPackageInstallation,
  AgentPackageManifest,
  AgentPackageSkill,
} from '../../src/types/agentPackage';

const PACKAGE_HASH = 'a'.repeat(64);
const ENTRY_HASH = 'b'.repeat(64);

function manifest(
  partial: Partial<AgentPackageManifest> = {},
): AgentPackageManifest {
  return {
    schemaVersion: 1,
    id: 'legacy.short-drama',
    name: 'AI 短剧知识库',
    version: '1.0.0',
    entrypoints: { instructions: 'AGENTS.md' },
    supportedScopes: ['global'],
    supportedSurfaces: ['assistant'],
    routing: {
      userInvocable: true,
      autoInvoke: false,
    },
    ...partial,
  };
}

function installation(
  partial: Partial<AgentPackageInstallation> = {},
): AgentPackageInstallation {
  const packageManifest = partial.manifest ?? manifest();
  return {
    id: 'agent-package-1',
    packageId: packageManifest.id,
    manifest: packageManifest,
    source: {
      sourceId: 'opaque-source-1',
      sourceType: 'folder',
      displayName: '短剧知识库',
    },
    entrypoints: [
      'AGENTS.md',
      '00-工作流/short-drama-showrunner/SKILL.md',
    ],
    skillCount: 1,
    fileCount: 10,
    totalBytes: 10_000,
    warnings: [],
    health: 'ready',
    contentHash: PACKAGE_HASH,
    enabled: true,
    mcpSkillReadEnabled: false,
    installedAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

function sourceText(
  relativePath: string,
  content = [
    '---',
    'name: short-drama-showrunner',
    'description: 短剧总导演',
    '---',
    '# 短剧总导演',
  ].join('\n'),
) {
  return {
    relativePath,
    content,
    sha256: ENTRY_HASH,
  };
}

function packageSkill(
  partial: Partial<AgentPackageSkill> = {},
): AgentPackageSkill {
  return {
    id: 'ap-skill-test',
    name: '短剧总导演',
    description: '短剧总导演',
    fileName: 'SKILL.md',
    content: '# 短剧总导演',
    sourceType: 'agent-package',
    createdAt: 2,
    installationId: 'agent-package-1',
    packageId: 'legacy.short-drama',
    packageName: 'AI 短剧知识库',
    packageVersion: '1.0.0',
    packageContentHash: PACKAGE_HASH,
    sourceId: 'opaque-source-1',
    entryPath: '00-工作流/short-drama-showrunner/SKILL.md',
    skillRoot: '00-工作流/short-drama-showrunner',
    contentHash: ENTRY_HASH,
    branch: 'domestic',
    packageUserInvocable: true,
    packageAutoInvoke: false,
    mcpSkillReadEnabled: false,
    readOnly: true,
    ...partial,
  };
}

beforeEach(() => {
  clearAgentPackageSkillCacheForTests();
  readAgentPackageSourceTextMock.mockReset().mockImplementation(
    async (_sourceId: string, relativePath: string) => sourceText(relativePath),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentPackage Skill 目录加载', () => {
  it('只读取 SKILL.md，并遵守 skillRoots 与 excludePaths', async () => {
    const current = installation({
      manifest: manifest({
        contributes: {
          skillRoots: ['skills', '海外短剧'],
          excludePaths: ['skills/archive'],
        },
      }),
      entrypoints: [
        'AGENTS.md',
        'README.md',
        'skills/writer/SKILL.md',
        'skills/archive/old/SKILL.md',
        '海外短剧/reviewer/skill.MD',
        '00-工作流/short-drama-showrunner/SKILL.md',
      ],
    });

    const result = await loadAgentPackageSkillCatalog([current]);

    expect(result.failures).toEqual([]);
    expect(result.skills.map((skill) => skill.entryPath)).toEqual(expect.arrayContaining([
      'skills/writer/SKILL.md',
      '海外短剧/reviewer/skill.MD',
    ]));
    expect(result.skills).toHaveLength(2);
    expect(readAgentPackageSourceTextMock).toHaveBeenCalledTimes(2);
    expect(readAgentPackageSourceTextMock).toHaveBeenCalledWith(
      'opaque-source-1',
      'skills/writer/SKILL.md',
      AGENT_PACKAGE_SKILL_LIMITS.maxEntryBytes,
    );
  });

  it('稳定 ID 不随包版本、内容哈希或入口正文变化', async () => {
    const entryPath = '00-工作流/short-drama-showrunner/SKILL.md';
    readAgentPackageSourceTextMock
      .mockResolvedValueOnce(sourceText(entryPath, '# 第一版'))
      .mockResolvedValueOnce({
        ...sourceText(entryPath, '# 第二版'),
        sha256: 'c'.repeat(64),
      });
    const first = installation();
    const second = installation({
      manifest: manifest({ version: '9.9.9' }),
      contentHash: 'd'.repeat(64),
      updatedAt: 99,
    });

    const firstSkill = (await loadAgentPackageSkillCatalog([first])).skills[0];
    const secondSkill = (await loadAgentPackageSkillCatalog([second])).skills[0];

    expect(firstSkill.id).toBe(secondSkill.id);
    expect(firstSkill.id).toBe(await createAgentPackageSkillId(first.id, entryPath));
    expect(firstSkill.content).toBe('# 第一版');
    expect(secondSkill.content).toBe('# 第二版');
    expect(secondSkill.packageVersion).toBe('9.9.9');
    expect(secondSkill.packageContentHash).toBe('d'.repeat(64));
  });

  it('从兼容目录路径识别四类 branch，未知布局安全回退 shared', () => {
    expect(classifyAgentPackageSkillBranch('00-工作流/showrunner/SKILL.md'))
      .toBe('domestic');
    expect(classifyAgentPackageSkillBranch('海外短剧/00-工作流/SKILL.md'))
      .toBe('overseas');
    expect(classifyAgentPackageSkillBranch(
      '实验对照_B方案_20260706/B方案增强版/skills/00-工作流/showrunner/SKILL.md',
    )).toBe('experimental-b');
    expect(classifyAgentPackageSkillBranch('skills/skill-creator/SKILL.md'))
      .toBe('shared');
    expect(classifyAgentPackageSkillBranch('custom-layout/writer/SKILL.md'))
      .toBe('shared');
  });

  it('单个坏入口只记为失败，其余 Skill 继续进入目录', async () => {
    const goodPath = '00-工作流/good/SKILL.md';
    const badPath = '00-工作流/bad/SKILL.md';
    readAgentPackageSourceTextMock.mockImplementation(
      async (_sourceId: string, relativePath: string) => {
        if (relativePath === badPath) throw new Error('智能体文本资源必须是 UTF-8');
        return sourceText(relativePath, '# 可用 Skill');
      },
    );

    const result = await loadAgentPackageSkillCatalog([installation({
      entrypoints: [goodPath, badPath],
    })]);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].entryPath).toBe(goodPath);
    expect(result.failures).toEqual([{
      installationId: 'agent-package-1',
      entryPath: badPath,
      reason: '智能体文本资源必须是 UTF-8',
    }]);
  });

  it.each([
    { enabled: false, health: 'ready' as const },
    { enabled: true, health: 'invalid' as const },
    { enabled: true, health: 'missing' as const },
  ])('禁用或不可用安装不加载：%o', async ({ enabled, health }) => {
    const result = await loadAgentPackageSkillCatalog([
      installation({ enabled, health }),
    ]);

    expect(result).toEqual({ skills: [], failures: [] });
    expect(readAgentPackageSourceTextMock).not.toHaveBeenCalled();
  });
});

describe('AgentPackage Skill 包内资料边界', () => {
  it('允许 SKILL.md 明示的国内到海外跨根资料', () => {
    const skill = packageSkill({
      content: '海外路线读取 `../../海外短剧/00-工作流/阶段交接规范.md`。',
    });

    expect(listAgentPackageSkillResources(skill)).toContain(
      '../../海外短剧/00-工作流/阶段交接规范.md',
    );
    expect(resolveAgentPackageSkillResourcePath(
      skill,
      '../../海外短剧/00-工作流/阶段交接规范.md',
    )).toBe('海外短剧/00-工作流/阶段交接规范.md');
  });

  it('允许 SKILL.md 明示的海外到国内跨根资料', () => {
    const skill = packageSkill({
      branch: 'overseas',
      entryPath: '海外短剧/02-剧本创作/optimizer/SKILL.md',
      skillRoot: '海外短剧/02-剧本创作/optimizer',
      content: '共用规范 `../../../02-剧本创作/methodology/references/标准.md`。',
    });

    expect(resolveAgentPackageSkillResourcePath(
      skill,
      '../../../02-剧本创作/methodology/references/标准.md',
    )).toBe('02-剧本创作/methodology/references/标准.md');
  });

  it('拒绝未在当前 SKILL.md 明示的跨 Skill 目录读取', () => {
    const skill = packageSkill({ content: '# 没有外部资料引用' });

    expect(() => resolveAgentPackageSkillResourcePath(
      skill,
      '../other/references/private.md',
    )).toThrow('必须由当前 SKILL.md 明确引用');
  });

  it.each([
    ['包根逃逸', '../../../../outside.md'],
    ['盘符路径', 'C:/secrets.md'],
    ['反斜杠路径', '..\\..\\海外短剧\\README.md'],
    ['脚本扩展', 'references/check.py'],
  ])('拒绝%s：%s', (_label, requestedPath) => {
    const skill = packageSkill({
      content: `资料 \`${requestedPath}\``,
    });

    expect(() => resolveAgentPackageSkillResourcePath(skill, requestedPath)).toThrow();
  });

  it('常规 Skill 与实验 B 方案之间双向隔离', () => {
    const bPath = '../../实验对照_B方案_20260706/B方案增强版/skills/规则.md';
    const regular = packageSkill({ content: `实验资料 \`${bPath}\`` });
    expect(() => resolveAgentPackageSkillResourcePath(regular, bPath))
      .toThrow('常规 Skill 不能读取实验 B 方案资源');

    const bSkill = packageSkill({
      branch: 'experimental-b',
      entryPath: '实验对照_B方案_20260706/B方案增强版/skills/00-工作流/showrunner/SKILL.md',
      skillRoot: '实验对照_B方案_20260706/B方案增强版/skills/00-工作流/showrunner',
      content: '常规资料 `../../../../../00-工作流/规范.md`',
    });
    expect(() => resolveAgentPackageSkillResourcePath(
      bSkill,
      '../../../../../00-工作流/规范.md',
    )).toThrow('实验 B 方案 Skill 不能读取常规路线资源');
  });

  it('读取只传 opaque sourceId 与包内相对路径，响应不泄露绝对路径', async () => {
    const requestedPath = '../../海外短剧/00-工作流/阶段交接规范.md';
    const skill = packageSkill({
      content: `海外路线读取 \`${requestedPath}\`。`,
    });
    readAgentPackageSourceTextMock.mockResolvedValue({
      relativePath: '海外短剧/00-工作流/阶段交接规范.md',
      content: '阶段交接正文',
      sha256: 'e'.repeat(64),
    });

    const result = await readAgentPackageSkillResource(skill, requestedPath);

    expect(readAgentPackageSourceTextMock).toHaveBeenCalledWith(
      'opaque-source-1',
      '海外短剧/00-工作流/阶段交接规范.md',
      AGENT_PACKAGE_SKILL_LIMITS.maxResourceBytes,
    );
    expect(result.relativePath).toBe('海外短剧/00-工作流/阶段交接规范.md');
    expect(JSON.stringify(result)).not.toContain('G:\\');
    expect(JSON.stringify(result)).not.toContain('C:\\');
  });
});
