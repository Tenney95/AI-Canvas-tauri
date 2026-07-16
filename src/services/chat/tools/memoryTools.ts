import { useAppStore } from '../../../store/useAppStore';
import { registerAgentTool } from '../toolRegistry';
import {
  PROJECT_MEMORY_CONTENT_LIMIT,
  PROJECT_MEMORY_KIND_LABELS,
  type ProjectMemoryKind,
} from '../../../types/memory';

interface MemorySuggestInput {
  kind: ProjectMemoryKind;
  content: string;
}

const KIND_ENUM: ProjectMemoryKind[] = ['preference', 'fact', 'constraint', 'decision'];

/**
 * memory_suggest — Agent 提出候选项目记忆。
 *
 * effect=memory_write，始终经 Policy 请求用户确认；确认后 execute 写入当前项目记忆。
 * 只能保存简短事实，正文写入前统一脱敏并截断，禁止文件/网页全文或密钥进入长期记忆。
 */
export function registerMemoryAgentTools(): Array<() => void> {
  return [
    registerAgentTool<MemorySuggestInput>({
      id: 'memory_suggest',
      title: '保存项目记忆',
      description: [
        '提议把一条简短的项目长期记忆保存下来，供后续对话使用。必须由用户确认后才会保存。',
        '只在用户表达稳定偏好、确定事实、明确约束或做出决定时调用，且内容要精简成一句话。',
        '禁止把文件全文、网页正文、密钥、绝对路径或临时结果作为记忆内容。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['kind', 'content'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: KIND_ENUM, description: '记忆类别：preference/fact/constraint/decision' },
          content: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_CONTENT_LIMIT },
        },
      },
      effect: 'memory_write',
      // 只有当前项目已加载时才可提议，确保写入的是当前项目
      isAvailable: (context) => useAppStore.getState().currentProjectId === context.projectId,
      summarizeInput: (input) =>
        `记住[${PROJECT_MEMORY_KIND_LABELS[input.kind] ?? input.kind}]：${input.content}`,
      execute: async (context, input) => {
        const store = useAppStore.getState();
        if (store.currentProjectId !== context.projectId) {
          return {
            status: 'error',
            summary: '目标项目当前未加载，未保存记忆',
            modelContent: '目标项目当前未加载，未保存记忆',
            errorCode: 'MEMORY_PROJECT_NOT_ACTIVE',
          };
        }
        const task = store.agentTasks.find((item) => item.id === context.taskId);
        const memory = store.createProjectMemory({
          projectId: context.projectId,
          kind: input.kind,
          content: input.content,
          source: {
            conversationId: context.conversationId,
            messageId: task?.userMessageId,
            taskId: context.taskId,
          },
        });
        return {
          status: 'success',
          summary: `已保存${PROJECT_MEMORY_KIND_LABELS[input.kind] ?? ''}记忆`,
          modelContent: JSON.stringify({
            saved: true,
            memoryId: memory.id,
            kind: memory.kind,
            content: memory.content,
          }),
        };
      },
    }),
  ];
}
