import { useAppStore } from '../../../store/useAppStore';
import { registerAgentTool } from '../toolRegistry';

export function registerAppAgentTools(): Array<() => void> {
  return [registerAgentTool<Record<string, never>>({
    id: 'app_get_state',
    title: '读取应用状态',
    description: '读取当前项目、画布 revision、节点数量、对话与 Agent 任务摘要。不会返回 API Key、本地绝对路径或消息正文。',
    effect: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    authorize: (context) => ({
      allowed: useAppStore.getState().currentProjectId === context.projectId,
      reason: '目标项目当前未加载',
    }),
    execute: async (context) => {
      const store = useAppStore.getState();
      const project = store.projects.find((item) => item.id === context.projectId);
      const tasks = store.agentTasks
        .filter((task) => task.projectId === context.projectId)
        .slice(-24)
        .map((task) => ({
          id: task.id,
          conversationId: task.conversationId,
          status: task.status,
          mode: task.mode,
          toolCallCount: task.toolCallCount,
          stepCount: task.steps.length,
          updatedAt: task.updatedAt,
          errorCode: task.errorCode,
        }));
      const state = {
        project: project ? { id: project.id, name: project.name } : { id: context.projectId },
        canvas: {
          revision: store.getCurrentRevision(),
          nodeCount: store.nodes.length,
          edgeCount: store.edges.length,
          selectedNodeIds: store.nodes.filter((node) => node.selected).map((node) => node.id),
        },
        conversations: store.conversations.map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          mode: conversation.agentMode,
          archived: conversation.archived,
          updatedAt: conversation.updatedAt,
        })),
        tasks,
        models: (store.config.generalModels ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          category: model.category,
        })),
      };
      const content = JSON.stringify(state);
      return {
        status: 'success',
        summary: `已读取项目“${project?.name ?? context.projectId}”的脱敏应用状态`,
        modelContent: content,
      };
    },
  })];
}
