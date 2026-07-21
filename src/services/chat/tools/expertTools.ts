import {
  AGENT_EXPERT_ROLES,
  type AgentExpertRole,
} from '../../../types/agent';
import { useAppStore } from '../../../store/useAppStore';
import {
  AGENT_EXPERT_ROLE_LABELS,
  ExpertTaskError,
  runExpertReview,
} from '../expertTaskService';
import { registerAgentTool } from '../toolRegistry';

interface ExpertReviewInput {
  role: AgentExpertRole;
}

export function registerExpertAgentTools(): Array<() => void> {
  return [registerAgentTool<ExpertReviewInput>({
    id: 'agent_run_expert_review',
    title: '运行只读专家审阅',
    description: [
      '启动一个独立、无工具的只读专家审阅当前画布结构。',
      '可选角色：canvas_structure（结构）、workflow_risk（流程风险）、asset_reuse（资产复用）。',
      '每个主任务最多 3 次；专家任务不能嵌套，也不会修改画布或读取节点正文。',
    ].join(''),
    effect: 'read',
    inputSchema: {
      type: 'object',
      required: ['role'],
      additionalProperties: false,
      properties: {
        role: { type: 'string', enum: [...AGENT_EXPERT_ROLES] },
      },
    },
    authorize: (context) => {
      const store = useAppStore.getState();
      const parent = store.agentTasks.find((task) => task.id === context.taskId);
      if (store.currentProjectId !== context.projectId) {
        return { allowed: false, reason: '专家任务只能审阅当前项目' };
      }
      if (!parent || parent.conversationId !== context.conversationId) {
        return { allowed: false, reason: '专家任务的父任务上下文已失效' };
      }
      return { allowed: true };
    },
    summarizeInput: (input) => `运行${AGENT_EXPERT_ROLE_LABELS[input.role]}`,
    execute: async (context, input) => {
      try {
        const review = await runExpertReview(context.taskId, input.role, context.signal);
        return {
          status: 'success',
          summary: `${AGENT_EXPERT_ROLE_LABELS[input.role]}已完成`,
          modelContent: [
            `专家子任务 ${review.childTaskId} 已完成。`,
            review.result,
          ].join('\n'),
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return {
          status: 'error',
          summary: error instanceof Error ? error.message : '专家审阅失败',
          modelContent: error instanceof Error ? error.message : '专家审阅失败',
          retryable: false,
          errorCode: error instanceof ExpertTaskError
            ? error.code
            : 'EXPERT_TASK_ERROR',
        };
      }
    },
  })];
}
