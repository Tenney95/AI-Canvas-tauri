import type { Node } from '@xyflow/react';
import { getLastCanvasPointerPosition } from '../../canvasPointerService';
import { useAppStore } from '../../../store/useAppStore';
import type { BaseNodeData, NodeType } from '../../../types';
import type { CommandId, CommandPlan } from '../../../types/chat';
import { executeCommand, logOperation } from '../commandRegistry';
import {
  registerAgentTool,
  type AgentToolContext,
  type AgentToolExecutionResult,
} from '../toolRegistry';

const NODE_TYPES: NodeType[] = [
  'ai-text',
  'ai-image',
  'ai-video',
  'ai-audio',
  'ai-animation',
  'ai-panorama',
  'ai-markdown',
  'ai-storyboard',
  'source-image',
  'source-video',
  'source-audio',
  'source-text',
  'comment',
];

const NODE_STATUSES = ['idle', 'loading', 'success', 'error'] as const;

interface NodeTargetInput {
  nodeIds?: string[];
  displayIds?: number[];
  nodeType?: NodeType;
  status?: typeof NODE_STATUSES[number];
  selected?: boolean;
}

interface CreateNodesInput {
  nodes: Array<{
    type: NodeType;
    label: string;
    prompt?: string;
    x?: number;
    y?: number;
  }>;
}

type CreateNodeInput = CreateNodesInput['nodes'][number];

interface CanvasPoint {
  x: number;
  y: number;
}

interface CanvasRect extends CanvasPoint {
  width: number;
  height: number;
}

const DEFAULT_NODE_WIDTH = 280;
const DEFAULT_NODE_HEIGHT = 160;
const COMMENT_NODE_HEIGHT = 120;
const AGENT_NODE_COLUMN_GAP = 56;
const AGENT_NODE_ROW_GAP = 48;
const AGENT_NODE_ANCHOR_GAP = 72;
const AGENT_NODE_COLLISION_GAP = 24;
const NODE_REFERENCE_PATTERN = /@\{([^:}\r\n]+):[^}\r\n]+\}/g;

interface UpdateNodesInput extends NodeTargetInput {
  label?: string;
  prompt?: string;
}

interface ConnectNodesInput {
  sourceId: string;
  targetId: string;
}

const targetProperties = {
  nodeIds: {
    type: 'array' as const,
    items: { type: 'string' as const, minLength: 1, maxLength: 120 },
    maxItems: 50,
  },
  displayIds: {
    type: 'array' as const,
    items: { type: 'integer' as const, minimum: 1 },
    maxItems: 50,
  },
  nodeType: { type: 'string' as const, enum: NODE_TYPES },
  status: { type: 'string' as const, enum: [...NODE_STATUSES] },
  selected: { type: 'boolean' as const },
};

function isCurrentProject(projectId: string): boolean {
  return useAppStore.getState().currentProjectId === projectId;
}

function authorizeCurrentProject(context: { projectId: string }) {
  return isCurrentProject(context.projectId)
    ? { allowed: true }
    : { allowed: false, reason: '目标项目当前未加载，不能操作其他项目的画布' };
}

function assertCanvasRevision(context: AgentToolContext): void {
  const currentRevision = useAppStore.getState().getCurrentRevision();
  if (
    context.baseRevision !== undefined
    && currentRevision !== context.baseRevision
  ) {
    throw new Error(
      `画布已变更（rev ${currentRevision} ≠ ${context.baseRevision}），请重新规划`,
    );
  }
}

function resolveTargetIds(input: NodeTargetInput): string[] {
  const store = useAppStore.getState();
  const matched = new Set<string>();
  const hasFilter = Boolean(
    input.nodeIds?.length
    || input.displayIds?.length
    || input.nodeType
    || input.status
    || input.selected,
  );
  if (!hasFilter) return [];

  for (const node of store.nodes) {
    const matches = [
      input.nodeIds?.length ? input.nodeIds.includes(node.id) : true,
      input.displayIds?.length ? input.displayIds.includes(Number(node.data.displayId)) : true,
      input.nodeType ? node.type === input.nodeType : true,
      input.status ? node.data.status === input.status : true,
      input.selected ? store.selectedNodeIds.includes(node.id) : true,
    ].every(Boolean);
    if (matches) matched.add(node.id);
  }
  return [...matched];
}

function buildCommandPlan(
  commandId: CommandId,
  targetNodeIds: string[],
  context: AgentToolContext,
  summary: string,
): CommandPlan {
  return {
    id: `agent-plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: context.projectId,
    baseRevision: context.baseRevision ?? useAppStore.getState().getCurrentRevision(),
    commandId,
    targetNodeIds,
    params: {},
    summary,
    risk: commandId === 'query' || commandId === 'select' ? 'read' : 'low',
    requiresConfirm: false,
  };
}

async function executeCanvasCommand(
  commandId: CommandId,
  targetNodeIds: string[],
  context: AgentToolContext,
  summary: string,
): Promise<AgentToolExecutionResult> {
  const result = await executeCommand(buildCommandPlan(
    commandId,
    targetNodeIds,
    context,
    summary,
  ));
  const succeeded = result.status === 'success' || result.status === 'partial';
  if (
    succeeded
    && !['query', 'select'].includes(commandId)
    && result.status === 'success'
  ) {
    useAppStore.getState().incrementRevision();
  }
  logOperation({
    projectId: context.projectId,
    conversationId: context.conversationId,
    commandId,
    summary,
    targetNodeIds: result.affectedNodeIds,
    parseSource: 'llm',
    status: result.status === 'rejected' ? 'failed' : result.status,
    undoable: !['query', 'select'].includes(commandId),
    historyIndex: result.historyIndex,
    errorCode: result.errorCode,
    timestamp: Date.now(),
  });
  return {
    status: succeeded ? 'success' : 'error',
    summary: result.message,
    modelContent: JSON.stringify({
      affectedNodeIds: result.affectedNodeIds,
      message: result.message,
      revision: useAppStore.getState().getCurrentRevision(),
    }),
    errorCode: result.errorCode,
  };
}

function getNodeDimensions(input: CreateNodeInput): { width: number; height: number } {
  return {
    width: DEFAULT_NODE_WIDTH,
    height: input.type === 'comment' ? COMMENT_NODE_HEIGHT : DEFAULT_NODE_HEIGHT,
  };
}

function getAbsoluteNodePosition(node: Node<BaseNodeData>, nodes: Node<BaseNodeData>[]): CanvasPoint {
  const position = { ...node.position };
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    position.x += parent.position.x;
    position.y += parent.position.y;
    parentId = parent.parentId;
  }
  return position;
}

function getExistingNodeRect(node: Node<BaseNodeData>, nodes: Node<BaseNodeData>[]): CanvasRect {
  const position = getAbsoluteNodePosition(node, nodes);
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : undefined;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : undefined;
  return {
    ...position,
    width: Number(node.data?.nodeWidth) || node.measured?.width || styleWidth || DEFAULT_NODE_WIDTH,
    height: Number(node.data?.nodeHeight) || node.measured?.height || styleHeight || DEFAULT_NODE_HEIGHT,
  };
}

function getRectBounds(rects: CanvasRect[]): CanvasRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function rectsOverlap(first: CanvasRect, second: CanvasRect): boolean {
  return first.x < second.x + second.width + AGENT_NODE_COLLISION_GAP
    && first.x + first.width + AGENT_NODE_COLLISION_GAP > second.x
    && first.y < second.y + second.height + AGENT_NODE_COLLISION_GAP
    && first.y + first.height + AGENT_NODE_COLLISION_GAP > second.y;
}

function resolveReferencedNodes(taskId: string, nodes: Node<BaseNodeData>[]): Node<BaseNodeData>[] {
  const task = useAppStore.getState().agentTasks.find((candidate) => candidate.id === taskId);
  if (!task) return [];
  const referencedIds = new Set(
    [...task.goal.matchAll(NODE_REFERENCE_PATTERN)].map((match) => match[1]),
  );
  return nodes.filter((node) => referencedIds.has(node.id));
}

function resolveCreateNodePositions(
  context: AgentToolContext,
  inputs: CreateNodeInput[],
): CanvasPoint[] {
  const store = useAppStore.getState();
  const existingNodes = store.nodes;
  const obstacles = existingNodes.map((node) => getExistingNodeRect(node, existingNodes));
  const autoEntries = inputs
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => input.x === undefined || input.y === undefined);
  const positions = inputs.map((input) => ({
    x: input.x ?? 0,
    y: input.y ?? 0,
  }));
  if (autoEntries.length === 0) return positions;

  const columns = Math.min(3, autoEntries.length);
  const rows = Math.ceil(autoEntries.length / columns);
  const maxNodeHeight = Math.max(...autoEntries.map(({ input }) => getNodeDimensions(input).height));
  const clusterWidth = columns * DEFAULT_NODE_WIDTH + (columns - 1) * AGENT_NODE_COLUMN_GAP;
  const clusterHeight = rows * maxNodeHeight + (rows - 1) * AGENT_NODE_ROW_GAP;

  const buildLayout = (anchor: CanvasPoint) => autoEntries.map(({ input, index }, layoutIndex) => {
    const column = layoutIndex % columns;
    const row = Math.floor(layoutIndex / columns);
    const dimensions = getNodeDimensions(input);
    return {
      index,
      position: {
        x: input.x ?? Math.round(anchor.x + column * (DEFAULT_NODE_WIDTH + AGENT_NODE_COLUMN_GAP)),
        y: input.y ?? Math.round(anchor.y + row * (maxNodeHeight + AGENT_NODE_ROW_GAP)),
      },
      dimensions,
    };
  });

  const isLayoutFree = (anchor: CanvasPoint) => {
    const layoutRects = buildLayout(anchor).map(({ position, dimensions }) => ({
      ...position,
      width: dimensions.width,
      height: dimensions.height,
    }));
    return layoutRects.every((rect, index) => (
      obstacles.every((obstacle) => !rectsOverlap(rect, obstacle))
      && layoutRects.slice(index + 1).every((other) => !rectsOverlap(rect, other))
    ));
  };

  const referencedNodes = resolveReferencedNodes(context.taskId, existingNodes);
  const referencedBounds = getRectBounds(
    referencedNodes.map((node) => getExistingNodeRect(node, existingNodes)),
  );
  const canvasBounds = getRectBounds(obstacles);
  const candidates: CanvasPoint[] = [];

  if (referencedBounds) {
    const centeredX = referencedBounds.x + (referencedBounds.width - clusterWidth) / 2;
    const centeredY = referencedBounds.y + (referencedBounds.height - clusterHeight) / 2;
    candidates.push(
      { x: referencedBounds.x + referencedBounds.width + AGENT_NODE_ANCHOR_GAP, y: centeredY },
      { x: centeredX, y: referencedBounds.y + referencedBounds.height + AGENT_NODE_ANCHOR_GAP },
      { x: centeredX, y: referencedBounds.y - clusterHeight - AGENT_NODE_ANCHOR_GAP },
      { x: referencedBounds.x - clusterWidth - AGENT_NODE_ANCHOR_GAP, y: centeredY },
    );
  } else {
    const pointerPosition = getLastCanvasPointerPosition();
    if (pointerPosition) candidates.push(pointerPosition);
  }

  if (canvasBounds) {
    candidates.push({
      x: canvasBounds.x + canvasBounds.width + AGENT_NODE_ANCHOR_GAP,
      y: referencedBounds?.y ?? canvasBounds.y,
    });
  }
  if (candidates.length === 0) candidates.push({ x: 300, y: 200 });

  const anchor = candidates.find(isLayoutFree) ?? candidates[candidates.length - 1];
  for (const entry of buildLayout(anchor)) positions[entry.index] = entry.position;
  return positions;
}

function createCanvasNode(
  input: CreateNodeInput,
  index: number,
  position: CanvasPoint,
): Node<BaseNodeData> {
  const id = `node-agent-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 7)}`;
  const type = input.type;
  return {
    id,
    type,
    position,
    data: {
      label: input.label.trim(),
      type,
      role: type.startsWith('source-') ? 'source' : 'generator',
      prompt: input.prompt?.trim(),
      status: 'idle',
      nodeWidth: DEFAULT_NODE_WIDTH,
      nodeHeight: type === 'comment' ? COMMENT_NODE_HEIGHT : DEFAULT_NODE_HEIGHT,
    },
  };
}

export function registerCanvasAgentTools(): Array<() => void> {
  return [
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_query',
      title: '查询画布',
      description: '读取画布概况或符合条件的节点。无筛选条件时返回整个画布概况。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'read',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `查询画布${resolveTargetIds(input).length ? '中的匹配节点' : '概况'}`,
      execute: async (context, input) => executeCanvasCommand(
        'query',
        resolveTargetIds(input),
        context,
        '查询画布',
      ),
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_select',
      title: '选择节点',
      description: '按节点 ID、展示编号、类型、状态或当前选择集选择画布节点。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'read',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `选择 ${resolveTargetIds(input).length} 个节点`,
      execute: async (context, input) => {
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到匹配节点', modelContent: '没有找到匹配节点' };
        }
        return executeCanvasCommand('select', targetIds, context, '选择节点');
      },
    }),
    registerAgentTool<CreateNodesInput>({
      id: 'canvas_create_nodes',
      title: '新建画布节点',
      description: '在画布上原子创建一个或多个节点；不会自动运行节点模型。',
      inputSchema: {
        type: 'object',
        required: ['nodes'],
        additionalProperties: false,
        properties: {
          nodes: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              required: ['type', 'label'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: NODE_TYPES },
                label: { type: 'string', minLength: 1, maxLength: 120 },
                prompt: { type: 'string', maxLength: 8000 },
                x: { type: 'number', minimum: -100000, maximum: 100000 },
                y: { type: 'number', minimum: -100000, maximum: 100000 },
              },
            },
          },
        },
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `新建 ${input.nodes.length} 个画布节点`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const positions = resolveCreateNodePositions(context, input.nodes);
        const nodes = input.nodes.map((nodeInput, index) => createCanvasNode(
          nodeInput,
          index,
          positions[index],
        ));
        useAppStore.getState().addNodes(nodes);
        useAppStore.getState().incrementRevision();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('canvas-focus-nodes', {
            detail: { nodeIds: nodes.map((node) => node.id) },
          }));
        }
        return {
          status: 'success',
          summary: `已新建 ${nodes.length} 个节点`,
          modelContent: JSON.stringify({
            nodes: nodes.map((node) => ({
              id: node.id,
              type: node.type,
              label: node.data.label,
              position: node.position,
            })),
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<UpdateNodesInput>({
      id: 'canvas_update_nodes',
      title: '更新画布节点',
      description: '批量更新匹配节点的名称或提示词，不修改生成结果和模型配置。',
      inputSchema: {
        type: 'object',
        properties: {
          ...targetProperties,
          label: { type: 'string', minLength: 1, maxLength: 120 },
          prompt: { type: 'string', maxLength: 8000 },
        },
        additionalProperties: false,
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `更新 ${resolveTargetIds(input).length} 个节点`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到匹配节点', modelContent: '没有找到匹配节点' };
        }
        if (input.label === undefined && input.prompt === undefined) {
          return { status: 'error', summary: '没有提供需要更新的字段', modelContent: '没有提供需要更新的字段' };
        }
        useAppStore.getState().updateNodesDataBatch(targetIds, {
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
        });
        useAppStore.getState().incrementRevision();
        return {
          status: 'success',
          summary: `已更新 ${targetIds.length} 个节点`,
          modelContent: JSON.stringify({
            affectedNodeIds: targetIds,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<ConnectNodesInput>({
      id: 'canvas_connect_nodes',
      title: '连接画布节点',
      description: '在两个已存在的画布节点之间创建一条连线。',
      inputSchema: {
        type: 'object',
        required: ['sourceId', 'targetId'],
        additionalProperties: false,
        properties: {
          sourceId: { type: 'string', minLength: 1, maxLength: 120 },
          targetId: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `连接 ${input.sourceId} → ${input.targetId}`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const store = useAppStore.getState();
        const existingIds = new Set(store.nodes.map((node) => node.id));
        if (!existingIds.has(input.sourceId) || !existingIds.has(input.targetId)) {
          return { status: 'error', summary: '源节点或目标节点不存在', modelContent: '源节点或目标节点不存在' };
        }
        if (input.sourceId === input.targetId) {
          return { status: 'error', summary: '不能连接节点自身', modelContent: '不能连接节点自身' };
        }
        if (store.edges.some((edge) => edge.source === input.sourceId && edge.target === input.targetId)) {
          return { status: 'success', summary: '节点已经连接', modelContent: '节点已经连接，无需重复创建' };
        }
        store.onConnect({
          source: input.sourceId,
          target: input.targetId,
          sourceHandle: null,
          targetHandle: null,
        });
        useAppStore.getState().incrementRevision();
        return {
          status: 'success',
          summary: '已创建节点连线',
          modelContent: JSON.stringify({
            sourceId: input.sourceId,
            targetId: input.targetId,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_group_nodes',
      title: '组合画布节点',
      description: '把两个或更多匹配节点放入一个画布分组。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `组合 ${resolveTargetIds(input).length} 个节点`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const targetIds = resolveTargetIds(input);
        if (targetIds.length < 2) {
          return { status: 'error', summary: '分组至少需要两个节点', modelContent: '分组至少需要两个节点' };
        }
        const store = useAppStore.getState();
        store.setSelectedNodeIds(targetIds);
        store.groupSelectedNodes();
        useAppStore.getState().incrementRevision();
        return {
          status: 'success',
          summary: `已组合 ${targetIds.length} 个节点`,
          modelContent: JSON.stringify({
            affectedNodeIds: targetIds,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_delete_nodes',
      title: '删除画布节点',
      description: '删除符合条件的画布节点；删除可通过画布撤销恢复，不是永久删除项目文件。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `删除 ${resolveTargetIds(input).length} 个节点`,
      execute: async (context, input) => {
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到待删除节点', modelContent: '没有找到待删除节点' };
        }
        return executeCanvasCommand('deleteNodes', targetIds, context, '删除画布节点');
      },
    }),
    registerAgentTool<Record<string, never>>({
      id: 'canvas_undo',
      title: '撤销画布操作',
      description: '撤销最近一次可撤销的画布操作。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: () => '撤销画布操作',
      execute: async (context) => executeCanvasCommand('undo', [], context, '撤销画布操作'),
    }),
    registerAgentTool<Record<string, never>>({
      id: 'canvas_redo',
      title: '重做画布操作',
      description: '恢复最近一次被撤销的画布操作。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: () => '重做画布操作',
      execute: async (context) => executeCanvasCommand('redo', [], context, '重做画布操作'),
    }),
  ];
}
