/** MCP 专用工作流 CRUD；复用 Workflow Store 持久化。 */
import { useAppStore } from '../../../store/useAppStore';
import type { WorkflowCategory, WorkflowDefinition, WorkflowIONodeType } from '../../../types';
import { registerAgentTool, type AgentToolExecutionResult } from '../toolRegistry';

const MCP_PREFIX = 'mcp-control-';
const CATEGORIES: WorkflowCategory[] = ['ai-text', 'ai-image', 'ai-video', 'ai-audio'];
const IO_TYPES: WorkflowIONodeType[] = ['prompt', 'image', 'video', 'audio'];

function mcpOnly(context: { conversationId: string }): boolean {
  return context.conversationId.startsWith(MCP_PREFIX);
}

function authorize(context: { projectId: string; conversationId: string }) {
  return { allowed: mcpOnly(context) && useAppStore.getState().currentProjectId === context.projectId, reason: '工作流管理只允许当前项目的 MCP 控制会话调用' };
}

function error(summary: string, errorCode: string): AgentToolExecutionResult {
  return { status: 'error', summary, modelContent: summary, errorCode };
}

function publicWorkflow(workflow: WorkflowDefinition, includeContent = false) {
  return {
    id: workflow.id,
    name: workflow.name,
    category: workflow.category,
    adapterType: workflow.adapterType || 'comfyui',
    ...(workflow.runninghub ? { runninghub: workflow.runninghub } : {}),
    ioNodes: workflow.ioNodes,
    defaultNodes: workflow.defaultNodes,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    ...(includeContent ? { fileContent: workflow.fileContent, editableContent: workflow.editableContent } : {}),
  };
}

function validateJson(content: string): string | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '工作流 JSON 顶层必须是对象';
  } catch { return '工作流内容不是有效 JSON'; }
  if (/[A-Za-z]:\\|\/(?:Users|home)\//.test(content)) return '工作流内容不能包含本地绝对路径';
  return undefined;
}

const ioNodeSchema = {
  type: 'object' as const,
  required: ['nodeId', 'title', 'type'],
  additionalProperties: false,
  properties: {
    nodeId: { type: 'string' as const, minLength: 1, maxLength: 160 },
    title: { type: 'string' as const, minLength: 1, maxLength: 200 },
    type: { type: 'string' as const, enum: IO_TYPES },
  },
};

interface WorkflowInput {
  workflowId?: string;
  name: string;
  category: WorkflowCategory;
  fileContent: string;
  editableContent?: string;
  ioNodes?: Array<{ nodeId: string; title: string; type: WorkflowIONodeType }>;
}

export function registerWorkflowAgentTools(): Array<() => void> {
  const common = { isAvailable: mcpOnly, authorize };
  return [
    registerAgentTool<Record<string, never>>({
      id: 'workflow_list', title: '列出工作流', description: '列出已安装工作流的安全元数据和 IO 节点。', effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, ...common,
      execute: async () => { const workflows = useAppStore.getState().workflows.map((item) => publicWorkflow(item)); return { status: 'success', summary: `找到 ${workflows.length} 个工作流`, modelContent: JSON.stringify({ workflows }) }; },
    }),
    registerAgentTool<{ workflowId: string }>({
      id: 'workflow_get', title: '读取工作流', description: '读取一个工作流定义；大型 JSON 可能受 MCP 单次工具结果预算裁剪。', effect: 'read',
      inputSchema: { type: 'object', required: ['workflowId'], additionalProperties: false, properties: { workflowId: { type: 'string', minLength: 1, maxLength: 160 } } }, ...common,
      execute: async (_context, input) => {
        const workflow = useAppStore.getState().workflows.find((item) => item.id === input.workflowId);
        if (!workflow) return error('工作流不存在', 'WORKFLOW_NOT_FOUND');
        return { status: 'success', summary: `已读取工作流“${workflow.name}”`, modelContent: JSON.stringify({ workflow: publicWorkflow(workflow, true) }) };
      },
    }),
    registerAgentTool<WorkflowInput>({
      id: 'workflow_create', title: '创建工作流', description: '从有效 ComfyUI JSON 创建并持久化工作流。', effect: 'config_write',
      inputSchema: { type: 'object', required: ['name', 'category', 'fileContent'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 }, category: { type: 'string', enum: CATEGORIES }, fileContent: { type: 'string', minLength: 2, maxLength: 1_500_000 }, editableContent: { type: 'string', maxLength: 1_500_000 },
        ioNodes: { type: 'array', maxItems: 100, items: ioNodeSchema },
      } }, ...common,
      execute: async (_context, input) => {
        const invalid = validateJson(input.fileContent) || (input.editableContent ? validateJson(input.editableContent) : undefined);
        if (invalid) return error(invalid, 'WORKFLOW_INVALID');
        const now = Date.now();
        const workflow: WorkflowDefinition = { id: `workflow-mcp-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: input.name.trim(), category: input.category, fileName: 'mcp-workflow.json', fileContent: input.fileContent, editableContent: input.editableContent, ioNodes: input.ioNodes, createdAt: now, updatedAt: now };
        await useAppStore.getState().addWorkflow(workflow);
        return { status: 'success', summary: `已创建工作流“${workflow.name}”`, modelContent: JSON.stringify({ workflow: publicWorkflow(workflow) }) };
      },
    }),
    registerAgentTool<Partial<WorkflowInput> & { workflowId: string }>({
      id: 'workflow_update', title: '更新工作流', description: '更新已有工作流的名称、分类、JSON 或 IO 节点。', effect: 'config_write',
      inputSchema: { type: 'object', required: ['workflowId'], additionalProperties: false, properties: {
        workflowId: { type: 'string', minLength: 1, maxLength: 160 }, name: { type: 'string', minLength: 1, maxLength: 160 }, category: { type: 'string', enum: CATEGORIES }, fileContent: { type: 'string', minLength: 2, maxLength: 1_500_000 }, editableContent: { type: 'string', maxLength: 1_500_000 }, ioNodes: { type: 'array', maxItems: 100, items: ioNodeSchema },
      } }, ...common,
      execute: async (_context, input) => {
        const existing = useAppStore.getState().workflows.find((item) => item.id === input.workflowId);
        if (!existing) return error('工作流不存在', 'WORKFLOW_NOT_FOUND');
        if (existing.adapterType === 'runninghub' && (input.fileContent !== undefined || input.editableContent !== undefined || input.ioNodes !== undefined)) return error('云工作流请通过 RunningHub 导入表单编辑参数定义', 'WORKFLOW_INVALID');
        const invalid = (input.fileContent ? validateJson(input.fileContent) : undefined) || (input.editableContent ? validateJson(input.editableContent) : undefined);
        if (invalid) return error(invalid, 'WORKFLOW_INVALID');
        const { workflowId: _workflowId, ...changes } = input;
        await useAppStore.getState().updateWorkflow(existing.id, { ...changes, ...(changes.name !== undefined ? { name: changes.name.trim() } : {}), updatedAt: Date.now() });
        const updated = useAppStore.getState().workflows.find((item) => item.id === existing.id)!;
        return { status: 'success', summary: `已更新工作流“${updated.name}”`, modelContent: JSON.stringify({ workflow: publicWorkflow(updated) }) };
      },
    }),
    registerAgentTool<{ workflowId: string }>({
      id: 'workflow_delete', title: '删除工作流', description: '永久删除一个用户工作流。', effect: 'permanent_delete',
      inputSchema: { type: 'object', required: ['workflowId'], additionalProperties: false, properties: { workflowId: { type: 'string', minLength: 1, maxLength: 160 } } }, ...common,
      execute: async (_context, input) => {
        const existing = useAppStore.getState().workflows.find((item) => item.id === input.workflowId);
        if (!existing) return error('工作流不存在', 'WORKFLOW_NOT_FOUND');
        await useAppStore.getState().deleteWorkflow(existing.id);
        return { status: 'success', summary: `已删除工作流“${existing.name}”`, modelContent: JSON.stringify({ deleted: true, workflowId: existing.id }) };
      },
    }),
  ];
}
