import { describe, expect, it } from 'vitest';
import {
  captureExplicitSkillBindings,
  expandSkillBindings,
  expandSkillReferences,
  resolveSkillBindingToolAllowlist,
  SKILL_CONTENT_LIMITS,
  truncateSkillContent,
} from '../../src/services/skillPromptService';
import type { UserSkill } from '../../src/types';
import type { AgentPackageSkill } from '../../src/types/agentPackage';

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

function body(char: string, length: number): string {
  return char.repeat(length);
}

describe('truncateSkillContent', () => {
  it('keeps content untouched below the limit', () => {
    const result = truncateSkillContent('short body', 100);
    expect(result).toEqual({ content: 'short body', truncated: false });
  });

  it('cuts to the limit and appends a Chinese truncation notice', () => {
    const result = truncateSkillContent(body('a', 30), 10);
    expect(result.truncated).toBe(true);
    expect(result.content.startsWith(body('a', 10))).toBe(true);
    expect(result.content).toContain('已截断');
    expect(result.content).not.toContain(body('a', 11));
  });

  it('keeps only the notice when the limit is zero', () => {
    const result = truncateSkillContent(body('a', 30), 0);
    expect(result.truncated).toBe(true);
    expect(result.content).not.toContain('a');
    expect(result.content).toContain('已截断');
  });
});

describe('expandSkillReferences budget', () => {
  it('leaves short expansions byte-identical to the raw skill body', () => {
    const skills = [skill({ content: '# Audit\n\nReview every node.' })];
    expect(expandSkillReferences('@skill{skill-1|Canvas audit}', skills))
      .toBe('# Audit\n\nReview every node.');
  });

  it('truncates a single oversized skill body', () => {
    const oversized = body('a', SKILL_CONTENT_LIMITS.singleSkillChars + 500);
    const expanded = expandSkillReferences(
      '@skill{skill-1|Canvas audit}',
      [skill({ content: oversized })],
    );
    expect(expanded).toContain('已截断');
    expect(expanded.length).toBeLessThan(oversized.length);
    expect(expanded).not.toContain(body('a', SKILL_CONTENT_LIMITS.singleSkillChars + 1));
  });

  it('truncates later skills instead of dropping them once the total budget runs out', () => {
    const skills = [
      skill({ id: 'skill-1', content: body('a', SKILL_CONTENT_LIMITS.singleSkillChars) }),
      skill({ id: 'skill-2', content: body('b', SKILL_CONTENT_LIMITS.singleSkillChars) }),
      skill({ id: 'skill-3', content: body('c', SKILL_CONTENT_LIMITS.singleSkillChars) }),
    ];
    const expanded = expandSkillReferences(
      '@skill{skill-1|A}@skill{skill-2|B}@skill{skill-3|C}',
      skills,
    );

    expect(expanded).toContain('aaa');
    expect(expanded).toContain('bbb');
    // 第三个 Skill 仍然出现，只是内容被截断为提示行。
    expect(expanded).not.toContain('ccc');
    expect(expanded.split('已截断').length - 1).toBeGreaterThanOrEqual(1);
    expect(expanded.length).toBeLessThanOrEqual(
      SKILL_CONTENT_LIMITS.expansionTotalChars + 500,
    );
  });

  it('still substitutes the template placeholder after truncation', () => {
    const oversized = `${body('a', SKILL_CONTENT_LIMITS.singleSkillChars + 100)}{{ 文章内容 }}`;
    const expanded = expandSkillReferences(
      '总结这段话 @skill{skill-1|Canvas audit}',
      [skill({ content: oversized })],
    );
    // 占位符本身被截掉时，用户输入必须回退为前缀，不能整体丢失。
    expect(expanded).toContain('总结这段话');
    expect(expanded).toContain('已截断');
  });

  it('keeps the placeholder substitution when the body fits', () => {
    const expanded = expandSkillReferences(
      '总结这段话 @skill{skill-1|Canvas audit}',
      [skill({ content: '规则：\n{{ 文章内容 }}\n输出摘要。' })],
    );
    expect(expanded).toBe('规则：\n总结这段话\n输出摘要。');
  });
});

describe('explicit Skill task bindings', () => {
  it('captures a sanitized immutable snapshot with manifest restrictions', () => {
    const skills = [skill({
      content: '---\nname: ignored\n---\n\n# Bound instructions',
      manifest: {
        version: '1.2.3',
        allowedTools: ['canvas_get_state', 'canvas_get_state', 'canvas_list_nodes'],
      },
    })];

    const bindings = captureExplicitSkillBindings(
      '检查画布 @skill{skill-1|Canvas audit}',
      skills,
    );

    expect(bindings).toEqual([{
      skillId: 'skill-1',
      name: 'Canvas audit',
      version: '1.2.3',
      content: '# Bound instructions',
      origin: 'user',
      allowedTools: ['canvas_get_state', 'canvas_list_nodes'],
    }]);

    skills[0].content = '# Changed later';
    expect(expandSkillBindings(
      '检查画布 @skill{skill-1|Canvas audit}',
      bindings,
    )).toContain('# Bound instructions');
    expect(expandSkillBindings(
      '检查画布 @skill{skill-1|Canvas audit}',
      bindings,
    )).not.toContain('# Changed later');
  });

  it('captures package origin metadata without binding sibling Skills', () => {
    const packageSkill: AgentPackageSkill = {
      id: 'ap-skill-1',
      name: '海外剧本优化',
      description: '优化海外短剧剧本',
      fileName: 'SKILL.md',
      content: '---\nversion: 2.1.0\n---\n# Package instructions',
      sourceType: 'agent-package',
      manifest: { version: '2.1.0', allowedTools: ['canvas_get_state'] },
      createdAt: 2,
      installationId: 'installation-1',
      packageId: 'legacy.package',
      packageName: 'AI短剧知识库',
      packageVersion: '0.0.0-legacy',
      packageContentHash: 'a'.repeat(64),
      sourceId: 'source:opaque',
      entryPath: '海外短剧/02-剧本创作/overseas-script-optimizer/SKILL.md',
      skillRoot: '海外短剧/02-剧本创作/overseas-script-optimizer',
      contentHash: 'b'.repeat(64),
      branch: 'overseas',
      packageUserInvocable: true,
      packageAutoInvoke: false,
      mcpSkillReadEnabled: false,
      readOnly: true,
    };

    const bindings = captureExplicitSkillBindings(
      '优化剧本 @skill{ap-skill-1|海外剧本优化}',
      [packageSkill],
    );

    expect(bindings).toEqual([{
      skillId: 'ap-skill-1',
      name: '海外剧本优化',
      version: '2.1.0',
      content: '# Package instructions',
      origin: 'agent-package',
      packageId: 'legacy.package',
      packageName: 'AI短剧知识库',
      packageVersion: '0.0.0-legacy',
      entryPath: '海外短剧/02-剧本创作/overseas-script-optimizer/SKILL.md',
      contentHash: 'b'.repeat(64),
      allowedTools: ['canvas_get_state'],
    }]);
    packageSkill.content = '# Changed after task creation';
    expect(expandSkillBindings('优化剧本', bindings)).toContain('# Package instructions');
    expect(expandSkillBindings('优化剧本', bindings)).not.toContain('Changed after');
  });

  it('caps explicit bindings and their captured content budget', () => {
    const skills = Array.from({ length: 5 }, (_, index) => skill({
      id: `skill-${index + 1}`,
      name: `Skill ${index + 1}`,
      content: body(String(index + 1), 7000),
    }));
    const refs = skills.map((item) => `@skill{${item.id}|${item.name}}`).join(' ');

    const bindings = captureExplicitSkillBindings(refs, skills);

    expect(bindings.map((item) => item.skillId)).toEqual([
      'skill-1',
      'skill-2',
      'skill-3',
      'skill-4',
    ]);
    expect(bindings.reduce((sum, item) => sum + item.content.length, 0))
      .toBeLessThanOrEqual(SKILL_CONTENT_LIMITS.expansionTotalChars + 200);
    expect(bindings[3].content).toContain('已截断');
  });

  it('wraps bound content as untrusted instructions and removes reference tokens', () => {
    const bindings = captureExplicitSkillBindings(
      '总结材料 @skill{skill-1|Canvas audit}',
      [skill({ content: '规则：{{ 文章内容 }}' })],
    );

    const expanded = expandSkillBindings(
      '总结材料 @skill{skill-1|Canvas audit}',
      bindings,
    );

    expect(expanded).toContain('显式 Skill：Canvas audit');
    expect(expanded).toContain('不可信说明资料');
    expect(expanded).toContain('规则：总结材料');
    expect(expanded).not.toContain('@skill{');
  });

  it('derives the task tool allowlist from captured bindings only', () => {
    const bindings = captureExplicitSkillBindings(
      '@skill{skill-1|A}@skill{skill-2|B}',
      [
        skill({ id: 'skill-1', manifest: { allowedTools: ['tool-a', 'tool-b'] } }),
        skill({ id: 'skill-2', manifest: { allowedTools: ['tool-b', 'tool-c'] } }),
      ],
    );

    expect(resolveSkillBindingToolAllowlist(bindings)).toEqual([
      'tool-a',
      'tool-b',
      'tool-c',
    ]);
    expect(resolveSkillBindingToolAllowlist(
      captureExplicitSkillBindings('@skill{skill-1|A}', [skill()]),
    )).toBeUndefined();
  });
});
