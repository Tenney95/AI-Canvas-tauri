/**
 * 注册项目记忆建议工具；候选内容裁剪后，由 Policy 按当前模式决定是否确认。
 */
import { useAppStore } from '../../../store/useAppStore';
import { projectMemoryOwnerId } from '../../../store/store.utils';
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
 * effect=memory_write，B 模式等待确认，C 模式自动执行；execute 写入当前项目记忆。
 * 只能保存简短事实，正文写入前统一脱敏并截断，禁止文件/网页全文或密钥进入长期记忆。
 */
export function registerMemoryAgentTools(): Array<() => void> {
  return [
    registerAgentTool<MemorySuggestInput>({
      id: 'memory_suggest',
      title: '保存项目记忆',
      description: [
        '提议把一条简短的项目长期记忆保存下来，供后续对话使用。B 协作模式由 Policy 请求确认，C 自主模式直接保存。',
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
          // 记忆整部剧共用，写在剧集项目上，换集也读得到
          projectId: projectMemoryOwnerId(store.projects, context.projectId),
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
    registerAgentTool<Record<string, never>>({
      id: 'memory_list',
      title: '列出项目记忆',
      description: '列出当前项目或剧集共享的长期记忆。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read',
      isAvailable: (context) => context.conversationId.startsWith('mcp-control-'),
      authorize: (context) => ({ allowed: useAppStore.getState().currentProjectId === context.projectId && context.conversationId.startsWith('mcp-control-'), reason: '项目记忆管理只允许当前项目的 MCP 控制会话调用' }),
      execute: async (context) => {
        const store = useAppStore.getState();
        const ownerId = projectMemoryOwnerId(store.projects, context.projectId);
        const memories = store.projectMemories.filter((memory) => memory.projectId === ownerId).map((memory) => ({ id: memory.id, kind: memory.kind, content: memory.content, enabled: memory.enabled, sourceUnavailable: memory.source.unavailable === true, createdAt: memory.createdAt, updatedAt: memory.updatedAt }));
        return { status: 'success', summary: `找到 ${memories.length} 条项目记忆`, modelContent: JSON.stringify({ projectId: ownerId, memories }) };
      },
    }),
    registerAgentTool<{ memoryId: string }>({
      id: 'memory_get',
      title: '读取项目记忆',
      description: '读取当前项目或剧集共享的一条长期记忆。',
      inputSchema: { type: 'object', required: ['memoryId'], additionalProperties: false, properties: { memoryId: { type: 'string', minLength: 1, maxLength: 160 } } },
      effect: 'read',
      isAvailable: (context) => context.conversationId.startsWith('mcp-control-'),
      authorize: (context, input) => { const store = useAppStore.getState(); const ownerId = projectMemoryOwnerId(store.projects, context.projectId); return { allowed: context.conversationId.startsWith('mcp-control-') && store.projectMemories.some((memory) => memory.id === input.memoryId && memory.projectId === ownerId), reason: '记忆不存在或不属于当前项目' }; },
      execute: async (_context, input) => {
        const memory = useAppStore.getState().projectMemories.find((item) => item.id === input.memoryId);
        if (!memory) return { status: 'error', summary: '项目记忆不存在', modelContent: '项目记忆不存在', errorCode: 'MEMORY_NOT_FOUND' };
        return { status: 'success', summary: '已读取项目记忆', modelContent: JSON.stringify({ memory: { id: memory.id, kind: memory.kind, content: memory.content, enabled: memory.enabled, sourceUnavailable: memory.source.unavailable === true, createdAt: memory.createdAt, updatedAt: memory.updatedAt } }) };
      },
    }),
    registerAgentTool<{ memoryId: string; kind?: ProjectMemoryKind; content?: string; enabled?: boolean }>({
      id: 'memory_update',
      title: '更新项目记忆',
      description: '更新当前项目的一条长期记忆内容、类别或启用状态。',
      inputSchema: { type: 'object', required: ['memoryId'], additionalProperties: false, properties: { memoryId: { type: 'string', minLength: 1, maxLength: 160 }, kind: { type: 'string', enum: KIND_ENUM }, content: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_CONTENT_LIMIT }, enabled: { type: 'boolean' } } },
      effect: 'memory_write',
      isAvailable: (context) => context.conversationId.startsWith('mcp-control-'),
      authorize: (context, input) => { const store = useAppStore.getState(); const ownerId = projectMemoryOwnerId(store.projects, context.projectId); return { allowed: context.conversationId.startsWith('mcp-control-') && store.projectMemories.some((memory) => memory.id === input.memoryId && memory.projectId === ownerId), reason: '记忆不存在或不属于当前项目' }; },
      execute: async (_context, input) => {
        const { memoryId, ...changes } = input;
        if (Object.keys(changes).length === 0) return { status: 'error', summary: '没有提供需要修改的字段', modelContent: '没有提供需要修改的字段', errorCode: 'MEMORY_NO_CHANGES' };
        useAppStore.getState().updateProjectMemory(memoryId, changes);
        const memory = useAppStore.getState().projectMemories.find((item) => item.id === memoryId)!;
        return { status: 'success', summary: '已更新项目记忆', modelContent: JSON.stringify({ memory: { id: memory.id, kind: memory.kind, content: memory.content, enabled: memory.enabled, updatedAt: memory.updatedAt } }) };
      },
    }),
    registerAgentTool<{ memoryId: string }>({
      id: 'memory_delete',
      title: '删除项目记忆',
      description: '永久删除当前项目的一条长期记忆。',
      inputSchema: { type: 'object', required: ['memoryId'], additionalProperties: false, properties: { memoryId: { type: 'string', minLength: 1, maxLength: 160 } } },
      effect: 'permanent_delete',
      isAvailable: (context) => context.conversationId.startsWith('mcp-control-'),
      authorize: (context, input) => { const store = useAppStore.getState(); const ownerId = projectMemoryOwnerId(store.projects, context.projectId); return { allowed: context.conversationId.startsWith('mcp-control-') && store.projectMemories.some((memory) => memory.id === input.memoryId && memory.projectId === ownerId), reason: '记忆不存在或不属于当前项目' }; },
      execute: async (_context, input) => {
        const memory = useAppStore.getState().projectMemories.find((item) => item.id === input.memoryId);
        if (!memory) return { status: 'error', summary: '项目记忆不存在', modelContent: '项目记忆不存在', errorCode: 'MEMORY_NOT_FOUND' };
        useAppStore.getState().removeProjectMemory(memory.id);
        return { status: 'success', summary: '已删除项目记忆', modelContent: JSON.stringify({ deleted: true, memoryId: memory.id }) };
      },
    }),
  ];
}
