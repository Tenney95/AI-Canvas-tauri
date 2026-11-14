import type { UserSkill } from '../types';
import type { AgentPackageInstallation, AgentPackageSkill, RuntimeSkill } from '../types/agentPackage';
import { isSkillAvailableOnSurface, projectSkillPickerOptions, resolveSkillForSurface, sanitizeSkillLabel } from './chat/skillCatalog';
import { stripSkillFrontmatter } from './chat/skillManifest';
import { sanitizeDomainText } from './chat/subAgentMaterials';

export interface SeriesSplitSkillOption {
  id: string;
  name: string;
  description: string;
}

function canReadSplitSource(skill: RuntimeSkill): boolean {
  const allowedTools = skill.manifest?.allowedTools;
  return (allowedTools === undefined || allowedTools.includes('series_read'))
    && Boolean(stripSkillFrontmatter(skill.content).trim());
}

function splitSkillLabel(name: string): string {
  return sanitizeSkillLabel(sanitizeDomainText(name), 120).replace(/[\uD800-\uDFFF]/gu, '') || 'Skill';
}

/** 仅投影弹窗所需的元数据，Skill 正文和来源路径留在主窗口。 */
export function getSeriesSplitSkillOptions(
  userSkills: UserSkill[],
  agentPackageSkills: AgentPackageSkill[],
  installations: AgentPackageInstallation[],
): SeriesSplitSkillOption[] {
  return projectSkillPickerOptions(
    userSkills.filter(canReadSplitSource),
    agentPackageSkills.filter((skill) => isSkillAvailableOnSurface(skill, 'assistant-user', installations) && canReadSplitSource(skill)),
  ).map(({ id, name, description }) => ({
    id,
    name: splitSkillLabel(name),
    description: sanitizeDomainText(description),
  }));
}

/** 自定义 Skill 沿用助手已有的显式引用、正文快照与工具上限。 */
export function getSeriesSplitSkillPrompt(skillId: string): string | undefined {
  const skill = resolveSkillForSurface(skillId, 'assistant-user');
  if (!skill || !canReadSplitSource(skill)) return undefined;
  return `@skill{${skill.id}|${encodeURIComponent(splitSkillLabel(skill.name))}}`;
}
