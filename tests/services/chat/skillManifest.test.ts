import { describe, expect, it } from 'vitest';
import {
  parseSkillDocument,
  stripSkillFrontmatter,
} from '../../../src/services/chat/skillManifest';
import {
  expandSkillReferences,
  resolveSkillToolAllowlist,
} from '../../../src/services/skillPromptService';
import type { UserSkill } from '../../../src/types';

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

describe('skillManifest', () => {
  it('parses supported scalar and allowed-tools fields', () => {
    const parsed = parseSkillDocument([
      '---',
      'name: Canvas audit',
      'description: Review the current canvas',
      'when-to-use: Before publishing a workflow',
      'allowed-tools:',
      '  - canvas_query',
      '  - preset_list',
      'user-invocable: true',
      'disable-model-invocation: true',
      'version: "1.2"',
      '---',
      '# Instructions',
      'Review the canvas.',
    ].join('\n'));

    expect(parsed.manifest).toEqual({
      name: 'Canvas audit',
      description: 'Review the current canvas',
      whenToUse: 'Before publishing a workflow',
      allowedTools: ['canvas_query', 'preset_list'],
      userInvocable: true,
      disableModelInvocation: true,
      version: '1.2',
    });
    expect(parsed.content).toBe('# Instructions\nReview the canvas.');
  });

  it('keeps legacy Skill files compatible', () => {
    const source = '# Legacy Skill\nDo the work.';
    expect(parseSkillDocument(source)).toEqual({ content: source });
    expect(stripSkillFrontmatter(source)).toBe(source);
  });

  it('accepts an explicit empty tool allowlist', () => {
    const parsed = parseSkillDocument('---\nallowed-tools: []\n---\nRead only.');
    expect(parsed.manifest?.allowedTools).toEqual([]);
  });

  it('rejects malformed security-relevant fields', () => {
    expect(() => parseSkillDocument([
      '---',
      'allowed-tools: canvas query',
      '---',
      'Bad manifest',
    ].join('\n'))).toThrow('无效工具 ID');
    expect(() => parseSkillDocument([
      '---',
      'user-invocable: yes',
      '---',
      'Bad manifest',
    ].join('\n'))).toThrow('必须是 true 或 false');
  });

  it('strips frontmatter before prompt expansion and resolves tool limits', () => {
    const userSkills = [skill({
      content: '---\nallowed-tools: [canvas_query]\n---\nReview the canvas.',
      manifest: { allowedTools: ['canvas_query'] },
    })];
    const prompt = 'Check this @skill{skill-1|Canvas%20audit}';

    expect(expandSkillReferences(prompt, userSkills)).toContain('Review the canvas.');
    expect(expandSkillReferences(prompt, userSkills)).not.toContain('allowed-tools');
    expect(resolveSkillToolAllowlist(prompt, userSkills)).toEqual(['canvas_query']);
  });

  it('does not expand a Skill that is not user invocable', () => {
    const prompt = 'Check this @skill{skill-1|Canvas%20audit}';
    const hidden = skill({ manifest: { userInvocable: false, allowedTools: [] } });

    expect(expandSkillReferences(prompt, [hidden])).toBe('Check this');
    expect(resolveSkillToolAllowlist(prompt, [hidden])).toBeUndefined();
  });
});
