import type { AgentTeamProfile, AssistantExecutionSelection, TeamRoleId, TeamTemplateId } from '../../../types/agentTeam';

export const TEAM_ROLE_LABELS: Record<TeamRoleId, string> = {
  architect: '结构师', writer: '主笔', continuity: '连续性审阅', dialogue: '对白与制作审阅', editor: '主编',
};
export const TEAM_TEMPLATE_LABELS: Record<TeamTemplateId, string> = {
  outline: '优化本集大纲', script: '根据集纲写正文', review: '联合审稿', general: '通用协作',
};
export const TEAM_ROLES = Object.keys(TEAM_ROLE_LABELS) as TeamRoleId[];
export const TEAM_TEMPLATES = Object.keys(TEAM_TEMPLATE_LABELS) as TeamTemplateId[];

export function createDefaultTeamProfile(modelId = ''): AgentTeamProfile {
  return { version: 1, name: '多模型创作团队', roles: {
    architect: modelId, writer: modelId, continuity: modelId, dialogue: modelId, editor: modelId,
  }, maxCalls: 8, maxTotalTokens: 240000, maxOutputChars: 16000 };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

/** 仅保留允许的非敏感模型引用，不从普通配置继承地址、Key 或执行参数。 */
export function normalizeTeamProfile(value: unknown): AgentTeamProfile {
  const defaults = createDefaultTeamProfile();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const raw = value as Partial<AgentTeamProfile>;
  const roles = raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles) ? raw.roles : defaults.roles;
  return { version: 1, name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) || defaults.name : defaults.name,
    roles: Object.fromEntries(TEAM_ROLES.map((role) => [role,
      typeof roles[role] === 'string' ? roles[role].trim().slice(0, 200) : '',
    ])) as Record<TeamRoleId, string>,
    maxCalls: boundedInteger(raw.maxCalls, defaults.maxCalls, 4, 12),
    maxTotalTokens: boundedInteger(raw.maxTotalTokens, defaults.maxTotalTokens, 20000, 1000000),
    maxOutputChars: boundedInteger(raw.maxOutputChars, defaults.maxOutputChars, 2000, 64000),
  };
}

export function normalizeExecutionSelection(value: unknown): AssistantExecutionSelection {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'team'
    && 'templateId' in value && TEAM_TEMPLATES.includes(value.templateId as TeamTemplateId)) {
    return { kind: 'team', templateId: value.templateId as TeamTemplateId };
  }
  return { kind: 'single' };
}
