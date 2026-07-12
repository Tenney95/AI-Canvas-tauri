/** 节点与对话共用的只读 Skill 提示词展开协议。 */
import type { UserSkill } from '../types';

export const SKILL_REF_REGEX = /@skill\{([^|}]+)\|([^}]+)\}/g;
const TEMPLATE_PLACEHOLDER = '{{ 文章内容 }}';

function fillSkillTemplate(template: string, input: string): string {
  if (template.includes(TEMPLATE_PLACEHOLDER)) {
    return template.replace(TEMPLATE_PLACEHOLDER, input);
  }
  return input ? `${input}\n\n${template}` : template;
}

export function expandSkillReferences(prompt: string, userSkills: UserSkill[]): string {
  const refs = Array.from(prompt.matchAll(SKILL_REF_REGEX));
  if (refs.length === 0) return prompt;

  const skillMap = new Map(userSkills.map((skill) => [skill.id, skill]));
  const promptWithoutSkills = prompt.replace(SKILL_REF_REGEX, '').trim();
  const expandedParts: string[] = [];

  for (const ref of refs) {
    const skill = skillMap.get(ref[1]);
    if (!skill) continue;
    expandedParts.push(fillSkillTemplate(skill.content, promptWithoutSkills));
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
