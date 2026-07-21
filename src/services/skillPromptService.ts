/** 节点与对话共用的只读 Skill 提示词展开协议。 */
import type { UserSkill } from '../types';
import { stripSkillFrontmatter } from './chat/skillManifest';

export const SKILL_REF_REGEX = /@skill\{([^|}]+)\|([^}]+)\}/g;
const TEMPLATE_PLACEHOLDER = '{{ 文章内容 }}';

function fillSkillTemplate(template: string, input: string): string {
  if (template.includes(TEMPLATE_PLACEHOLDER)) {
    return template.replace(TEMPLATE_PLACEHOLDER, input);
  }
  return input ? `${input}\n\n${template}` : template;
}

export function isSkillUserInvocable(skill: UserSkill): boolean {
  return skill.manifest?.userInvocable !== false;
}

export function resolveReferencedSkills(
  prompt: string,
  userSkills: UserSkill[],
): UserSkill[] {
  const skillMap = new Map(userSkills.map((skill) => [skill.id, skill]));
  const ids = [...prompt.matchAll(SKILL_REF_REGEX)].map((match) => match[1]);
  return [...new Set(ids)]
    .map((id) => skillMap.get(id))
    .filter((skill): skill is UserSkill => !!skill && isSkillUserInvocable(skill));
}

/**
 * 合并显式引用 Skill 的工具声明。多个声明取并集，以满足组合 Skill；
 * 只要存在至少一个声明，结果就作为任务级上限，未声明 Skill 不会扩大该集合。
 */
export function resolveSkillToolAllowlist(
  prompt: string,
  userSkills: UserSkill[],
): string[] | undefined {
  const declared = resolveReferencedSkills(prompt, userSkills)
    .filter((skill) => skill.manifest?.allowedTools !== undefined);
  if (declared.length === 0) return undefined;
  return [...new Set(declared.flatMap((skill) => skill.manifest?.allowedTools ?? []))];
}

export function expandSkillReferences(prompt: string, userSkills: UserSkill[]): string {
  const refs = Array.from(prompt.matchAll(SKILL_REF_REGEX));
  if (refs.length === 0) return prompt;

  const skillMap = new Map(
    resolveReferencedSkills(prompt, userSkills).map((skill) => [skill.id, skill]),
  );
  const promptWithoutSkills = prompt.replace(SKILL_REF_REGEX, '').trim();
  const expandedParts: string[] = [];

  for (const ref of refs) {
    const skill = skillMap.get(ref[1]);
    if (!skill) continue;
    expandedParts.push(fillSkillTemplate(
      stripSkillFrontmatter(skill.content),
      promptWithoutSkills,
    ));
  }

  if (expandedParts.length === 0) return promptWithoutSkills;
  const shouldPrefixPrompt = promptWithoutSkills
    && expandedParts.every((part) => !part.includes(promptWithoutSkills));
  return [shouldPrefixPrompt ? promptWithoutSkills : '', ...expandedParts]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
