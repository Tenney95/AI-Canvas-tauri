import { useAppStore } from '../../../store/useAppStore';
import {
  getConfiguredModelGroups,
  getMediaModelOptions,
  isProviderCategoryVisible,
} from '../../../components/nodes/shared/defaultModels';
import { registerAgentTool } from '../toolRegistry';

function listConfiguredModels(store: ReturnType<typeof useAppStore.getState>) {
  const textModels = getConfiguredModelGroups(store.config, 'ai-text')
    .flatMap((group) => group.models.map((model) => ({
      id: model.value,
      name: model.label,
      category: 'text' as const,
      provider: model.provider,
      groupName: group.name,
    })));
  const customTextModels = (store.config.generalModels ?? [])
    .filter((model) => (
      model.category === 'text'
      && isProviderCategoryVisible(store.config, model.providerConfigId, model.category)
    ))
    .map((model) => ({
      id: `general/${model.id}`,
      name: model.name,
      category: 'text' as const,
      provider: 'general',
      groupName: '通用模型',
    }));
  const mediaModels = getMediaModelOptions(
    store.config.generalModels ?? [],
    store.config,
  ).map((model) => ({
    id: model.value,
    name: model.label,
    category: model.mediaKind,
    provider: model.provider,
    groupName: model.groupName,
  }));

  return [...textModels, ...customTextModels, ...mediaModels];
}

export function registerAppAgentTools(): Array<() => void> {
  return [registerAgentTool<Record<string, never>>({
    id: 'app_get_state',
    title: '读取应用状态',
    description: '读取当前项目、画布 revision、节点数量、可用模型、工作流、对话与 Agent 任务摘要。不会返回 API Key、本地绝对路径、工作流正文或消息正文。',
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
        models: listConfiguredModels(store),
        workflows: store.workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          category: workflow.category,
          ioNodeCount: workflow.ioNodes?.length ?? 0,
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
