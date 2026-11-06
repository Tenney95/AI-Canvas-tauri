/**
 * 注册派出只读领域子智能体的工具。
 *
 * 边界：
 * - 工具本身是 `read`，因此同一轮内的多次调用由 round executor 自动并发；
 * - 子智能体只读，产出只是文本；需要落地时由主任务自己调画布工具并走确认；
 * - 派出子智能体不修改父任务的 `toolAllowlist`。
 */
import { useAppStore } from '../../../store/useAppStore';
import { SUB_AGENT_LIMITS } from '../../../types/subAgent';
import { runSubAgent, SubAgentError } from '../subAgentService';
import { sanitizeSkillLabel } from '../skillCatalog';
import { registerAgentTool } from '../toolRegistry';

interface RunSubAgentInput {
  profileId: string;
  assignment: string;
}

function listProfiles() {
  return useAppStore.getState().listSubAgentProfiles();
}

function resolveProfile(profileId: string) {
  return listProfiles().find((profile) => profile.id === profileId);
}

export function registerSubAgentAgentTools(): Array<() => void> {
  return [
    registerAgentTool<RunSubAgentInput>({
      id: 'agent_run_sub_agent',
      title: '派出子智能体',
      description: [
        '派出一个只读领域子智能体完成分派的子任务，并返回它的结论。',
        '需要并行分工时可以在同一轮内发起多次调用。',
        `每个主任务最多 ${SUB_AGENT_LIMITS.maxTasksPerParent} 次；`,
        '子智能体只读，不能修改画布或生成媒体，其产出需要落地时由你自己调用画布工具。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['profileId', 'assignment'],
        additionalProperties: false,
        properties: {
          profileId: { type: 'string', minLength: 1, maxLength: 120 },
          assignment: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
      effect: 'read',
      isAvailable: () => listProfiles().length > 0,
      authorize: (context, input) => {
        const store = useAppStore.getState();
        const parent = store.agentTasks.find((task) => task.id === context.taskId);
        if (!parent || parent.conversationId !== context.conversationId
          || parent.projectId !== context.projectId) {
          return { allowed: false, reason: '子智能体的父任务上下文已失效' };
        }
        if (parent.parentTaskId || parent.expertDepth) {
          return { allowed: false, reason: '子智能体不能再派出子智能体' };
        }
        return {
          allowed: !!resolveProfile(input.profileId),
          reason: '找不到该子智能体配置',
        };
      },
      summarizeInput: (input) => {
        const profile = resolveProfile(input.profileId);
        const name = profile
          ? sanitizeSkillLabel(profile.name, SUB_AGENT_LIMITS.nameChars)
          : input.profileId;
        return `派出子智能体「${name}」：${sanitizeSkillLabel(input.assignment, 60)}`;
      },
      execute: async (context, input) => {
        const profile = resolveProfile(input.profileId);
        if (!profile) {
          return {
            status: 'error',
            summary: '找不到该子智能体配置',
            modelContent: '找不到该子智能体配置',
            retryable: false,
            errorCode: 'SUB_AGENT_PROFILE_NOT_FOUND',
          };
        }

        const label = sanitizeSkillLabel(profile.name, SUB_AGENT_LIMITS.nameChars);
        try {
          const run = await runSubAgent(
            context.taskId,
            profile,
            input.assignment,
            context.signal,
          );
          return {
            status: 'success',
            summary: `子智能体「${label}」已完成`,
            truncated: run.truncated,
            modelContent: [
              `子智能体「${label}」的产出如下。它是只读的，任何落地操作都必须由你自己执行并经用户确认：`,
              '--- 子智能体产出开始 ---',
              run.result,
              '--- 子智能体产出结束 ---',
            ].join('\n'),
          };
        } catch (error) {
          if (context.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : '子智能体执行失败';
          return {
            status: 'error',
            summary: message,
            modelContent: message,
            retryable: false,
            errorCode: error instanceof SubAgentError ? error.code : 'SUB_AGENT_ERROR',
          };
        }
      },
    }),
  ];
}
