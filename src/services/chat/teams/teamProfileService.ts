import type { AgentTeamProfile, AssistantExecutionSelection, TeamExecutionTarget, TeamRoleId, TeamTemplateId } from '../../../types/agentTeam';
import { validateTeamGraph } from './teamGraphService';

export const TEAM_ROLE_LABELS: Record<TeamRoleId, string> = {
  architect: '结构师', writer: '主笔', continuity: '连续性审阅', dialogue: '对白与制作审阅',
  director: '导演', storyboard: '分镜师', editor: '主编',
};
export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRoleId, string> = {
  architect: '提炼原文事实、人物目标与因果，规划本集结构和节奏。',
  writer: '依据原文与大纲写完整剧本，统一人物语言和场景表达。',
  continuity: '核对原文依据、人物关系、时间线与设定连续性。',
  dialogue: '检查潜台词、角色语言、自然语速与台词可演性。',
  director: '审视视觉叙事、表演调度、情绪节奏与制作可行性。',
  storyboard: '提出镜头拆解、景别运镜与跨镜衔接建议，保留剧情和台词。',
  editor: '逐条裁决审阅意见，守住已确认设定并交由主笔统一修订。',
};
export const TEAM_TEMPLATE_LABELS: Record<TeamTemplateId, string> = {
  outline: '优化本集大纲', script: '根据集纲写正文', review: '联合审稿', general: '通用协作',
};
export const TEAM_ROLES = Object.keys(TEAM_ROLE_LABELS) as TeamRoleId[];
export const TEAM_TEMPLATES = Object.keys(TEAM_TEMPLATE_LABELS) as TeamTemplateId[];

export function createDefaultTeamProfile(modelId = ''): AgentTeamProfile {
  return { version: 1, name: '多模型创作团队', roles: {
    architect: modelId, writer: modelId, continuity: modelId, dialogue: modelId,
    director: modelId, storyboard: modelId, editor: modelId,
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
  const roleExecutors: Partial<Record<TeamRoleId, TeamExecutionTarget>> = {};
  for (const role of TEAM_ROLES) {
    const target = raw.roleExecutors?.[role];
    if (!target) continue;
    if (target.kind === 'text-model' && typeof target.modelId === 'string') {
      roleExecutors[role] = { kind: 'text-model', modelId: target.modelId.trim().slice(0, 200) };
    } else {
      roleExecutors[role] = { kind: 'external-agent', providerId: 'codex-app-server',
        modelId: target.kind === 'external-agent' && target.providerId === 'codex-app-server' && typeof target.modelId === 'string'
          ? target.modelId.trim().slice(0, 200) : '' };
    }
  }
  let graph: AgentTeamProfile['graph'];
  if (raw.graph !== undefined) {
    try { graph = validateTeamGraph(raw.graph); }
    // 保留“存在但无效”的图，发起时明确拒绝；不能静默退回固定模板付费执行。
    catch { graph = { version: 1, nodes: [], finalTaskId: '' }; }
  }
  return { version: 1, name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) || defaults.name : defaults.name,
    roles: Object.fromEntries(TEAM_ROLES.map((role) => [role,
      typeof roles[role] === 'string' ? roles[role].trim().slice(0, 200) : '',
    ])) as Record<TeamRoleId, string>,
    ...(Object.keys(roleExecutors).length ? { roleExecutors } : {}),
    ...(graph ? { graph } : {}),
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
