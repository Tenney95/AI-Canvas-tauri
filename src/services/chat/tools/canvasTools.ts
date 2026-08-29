/**
 * 注册画布查询与写入工具，并通过命令注册表、项目校验和 revision 防护执行节点操作。
 */
import type { Node } from '@xyflow/react';
import { getLastCanvasPointerPosition } from '../../canvasPointerService';
import { useAppStore } from '../../../store/useAppStore';
import type { BaseNodeData, NodeType } from '../../../types';
import type {
  AgentToolDisplayChange,
  AgentToolDisplaySnapshot,
  AgentToolDisplayValue,
} from '../../../types/agent';
import { MAX_IMAGE_BATCH_COUNT } from '../../../types/aiTypes';
import type { CommandId, CommandPlan } from '../../../types/chat';
import { executeGeneration } from '../../generationService';
import {
  getProjectModelKind,
  parseProjectModelRef,
  PROJECT_IMAGE_ASPECT_RATIOS,
  PROJECT_IMAGE_SIZES,
  PROJECT_VIDEO_ASPECT_RATIOS,
} from '../../projectSettingsService';
import { nodeHeightForAspectRatio } from '../../../utils/nodeBounds';
import { textNodeHeight } from '../../../utils/num';
import { executeCommand, logOperation } from '../commandRegistry';
import {
  registerAgentTool,
  type AgentToolContext,
  type AgentToolExecutionResult,
} from '../toolRegistry';
import { listConfiguredModels } from './appTools';

const NODE_TYPES: NodeType[] = [
  'ai-text',
  'ai-image',
  'ai-video',
  'ai-audio',
  'ai-animation',
  'ai-panorama',
  'ai-markdown',
  'ai-storyboard',
  'ai-shotlist',
  'ai-director',
  'source-image',
  'source-video',
  'source-audio',
  'source-text',
  'comment',
];

/** 宫格分镜只能由已有图片裁切产生，通用 Agent 创建入口不得伪造空宫格。 */
const AGENT_CREATABLE_NODE_TYPES = NODE_TYPES.filter((type) => type !== 'ai-storyboard');

const NODE_STATUSES = ['idle', 'loading', 'success', 'error'] as const;

/** 画面比例对这些节点才有意义；动画/分镜/镜头表的节点框由各自组件按格数算，不在这里改。 */
const VISUAL_NODE_TYPES = new Set<NodeType>([
  'ai-image',
  'ai-video',
  'ai-panorama',
]);

/** source-* 与批注节点的正文直接落进 output，建好就能被下游引用。 */
function isSourceNodeType(type: NodeType): boolean {
  return type.startsWith('source-') || type === 'comment';
}

/**
 * 节点正文：content 是已经写好的定稿，直接进 output，节点建出来就能看、能被 @ 引用。
 * source-* / comment 没有 content 时沿用旧行为，把 prompt 当正文。
 * 生成型节点的 prompt 不是正文——它要等模型跑完才有 output，不能塞进这里。
 */
function resolveNodeBody(input: CreateNodeInput): string | undefined {
  return input.content?.trim() || (isSourceNodeType(input.type) ? input.prompt?.trim() : undefined);
}

/** 画面比例取图片与视频两套项目常量的并集，具体是否支持由生成运行时判断。 */
const ASPECT_RATIOS = [...new Set<string>([
  ...PROJECT_IMAGE_ASPECT_RATIOS,
  ...PROJECT_VIDEO_ASPECT_RATIOS,
])];
/** 只有这些节点的 output 是纯文本，其余节点的 output 可能是本地路径或 URL，不能回传。 */
const TEXT_OUTPUT_NODE_TYPES = new Set<NodeType>([
  'ai-text',
  'ai-markdown',
  'source-text',
  'comment',
]);
const DETAIL_TEXT_LIMIT = 400;
const DETAIL_NODE_LIMIT = 50;
const MAX_RUN_NODES = 5;
const MIN_NODE_SIZE = 120;
const MAX_NODE_SIZE = 4000;
const DISPLAY_PREVIEW_LIMIT = 1_000;

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
    content?: string;
    aspectRatio?: string;
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

interface QueryNodesInput extends NodeTargetInput {
  detail?: boolean;
  limit?: number;
}

interface UpdateNodesInput extends NodeTargetInput {
  label?: string;
  prompt?: string;
  content?: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  width?: number;
  height?: number;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  batchCount?: number;
  /** 统一视频参数名；节点内部继续兼容 seedanceResolution。 */
  videoResolution?: string;
  /** 统一视频参数名；节点内部继续兼容 seedanceDuration。 */
  videoDuration?: number;
}

interface ConnectNodesInput {
  sourceId: string;
  targetId: string;
}

interface DisconnectNodesInput {
  sourceId?: string;
  targetId?: string;
}

interface NodeAuditSnapshot {
  label: string;
  prompt?: string;
  content?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  batchCount?: number;
  videoResolution?: string;
  videoDuration?: number;
}

function displayPreview(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.slice(0, DISPLAY_PREVIEW_LIMIT);
}

function createNodesInputDisplay(input: CreateNodesInput): AgentToolDisplaySnapshot {
  return {
    entities: input.nodes.map((nodeInput) => ({
      title: nodeInput.label.trim(),
      fields: [
        { label: '类型', value: nodeInput.type },
        ...(nodeInput.aspectRatio
          ? [{ label: '比例', value: nodeInput.aspectRatio }]
          : []),
        {
          label: '位置',
          value: nodeInput.x !== undefined && nodeInput.y !== undefined
            ? `(${Math.round(nodeInput.x)}, ${Math.round(nodeInput.y)})`
            : '自动排列',
          source: nodeInput.x !== undefined && nodeInput.y !== undefined
            ? 'user'
            : 'resolved',
        },
      ],
      preview: displayPreview(nodeInput.content ?? nodeInput.prompt),
    })),
  };
}

function captureNodeAudit(node: Node<BaseNodeData>): NodeAuditSnapshot {
  const data = node.data;
  return {
    label: data.label,
    prompt: displayPreview(data.prompt),
    content: TEXT_OUTPUT_NODE_TYPES.has(data.type) ? displayPreview(data.output) : undefined,
    x: Math.round(node.position.x),
    y: Math.round(node.position.y),
    width: Math.round(Number(data.nodeWidth) || node.measured?.width || DEFAULT_NODE_WIDTH),
    height: Math.round(Number(data.nodeHeight) || node.measured?.height || DEFAULT_NODE_HEIGHT),
    model: typeof data.model === 'string' ? data.model : undefined,
    aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : undefined,
    imageSize: typeof data.imageSize === 'string' ? data.imageSize : undefined,
    batchCount: typeof data.batchCount === 'number' ? data.batchCount : undefined,
    videoResolution: typeof data.seedanceResolution === 'string' ? data.seedanceResolution : undefined,
    videoDuration: typeof data.seedanceDuration === 'number' ? data.seedanceDuration : undefined,
  };
}

const UPDATE_DISPLAY_FIELDS: Array<{
  inputKey: keyof UpdateNodesInput;
  auditKey: keyof NodeAuditSnapshot;
  label: string;
}> = [
  { inputKey: 'label', auditKey: 'label', label: '名称' },
  { inputKey: 'prompt', auditKey: 'prompt', label: '提示词' },
  { inputKey: 'content', auditKey: 'content', label: '正文' },
  { inputKey: 'x', auditKey: 'x', label: '位置 X' },
  { inputKey: 'y', auditKey: 'y', label: '位置 Y' },
  { inputKey: 'dx', auditKey: 'x', label: '位置 X' },
  { inputKey: 'dy', auditKey: 'y', label: '位置 Y' },
  { inputKey: 'width', auditKey: 'width', label: '宽度' },
  { inputKey: 'height', auditKey: 'height', label: '高度' },
  { inputKey: 'model', auditKey: 'model', label: '模型' },
  { inputKey: 'aspectRatio', auditKey: 'aspectRatio', label: '画面比例' },
  { inputKey: 'imageSize', auditKey: 'imageSize', label: '图片尺寸' },
  { inputKey: 'batchCount', auditKey: 'batchCount', label: '批量数量' },
  { inputKey: 'videoResolution', auditKey: 'videoResolution', label: '视频分辨率' },
  { inputKey: 'videoDuration', auditKey: 'videoDuration', label: '视频时长' },
];

function buildUpdateChanges(
  input: UpdateNodesInput,
  targets: Node<BaseNodeData>[],
  before: Map<string, NodeAuditSnapshot>,
): AgentToolDisplayChange[] {
  const afterById = new Map(targets.map((target) => [target.id, captureNodeAudit(target)]));
  const changes: AgentToolDisplayChange[] = [];
  for (const target of targets) {
    const previous = before.get(target.id);
    const next = afterById.get(target.id);
    if (!previous || !next) continue;
    const seen = new Set<keyof NodeAuditSnapshot>();
    for (const field of UPDATE_DISPLAY_FIELDS) {
      if (input[field.inputKey] === undefined || seen.has(field.auditKey)) continue;
      seen.add(field.auditKey);
      const beforeValue = previous[field.auditKey] as AgentToolDisplayValue | undefined;
      const afterValue = next[field.auditKey] as AgentToolDisplayValue | undefined;
      if (beforeValue === afterValue) continue;
      changes.push({
        targetId: target.id,
        targetLabel: next.label,
        field: field.label,
        before: beforeValue,
        after: afterValue,
      });
    }
  }
  return changes;
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

/** 素材节点（source-* / comment）只产出内容，没有输入端，不能作为连线终点。 */
function isSourceOnlyNode(node: Node<BaseNodeData>): boolean {
  const role = node.data.role;
  if (role) return role === 'source';
  const type = node.type ?? node.data.type;
  return type === 'comment' || (typeof type === 'string' && type.startsWith('source-'));
}

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

function truncateText(value: string | undefined, limit = DETAIL_TEXT_LIMIT): {
  text: string;
  truncated: boolean;
} | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > limit
    ? { text: text.slice(0, limit), truncated: true }
    : { text, truncated: false };
}

/**
 * 节点详情。绝不回传 imageUrl / filePath / sourceUrl 等字段：
 * 它们带本机绝对路径，而这份内容会经模型和 MCP 客户端离开本机。
 */
function describeNode(node: Node<BaseNodeData>): Record<string, unknown> {
  const data = node.data;
  const outputKind = data.imageUrl || data.thumbnailUrl
    ? 'image'
    : data.videoUrl
      ? 'video'
      : data.audioUrl
        ? 'audio'
        : TEXT_OUTPUT_NODE_TYPES.has(data.type) && data.output
          ? 'text'
          : null;
  return {
    id: node.id,
    displayId: data.displayId,
    type: node.type,
    label: data.label,
    role: data.role,
    status: data.status ?? 'idle',
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    size: {
      width: Math.round(Number(data.nodeWidth) || node.measured?.width || DEFAULT_NODE_WIDTH),
      height: Math.round(Number(data.nodeHeight) || node.measured?.height || DEFAULT_NODE_HEIGHT),
    },
    parentId: node.parentId,
    model: data.model,
    aspectRatio: data.aspectRatio,
    imageSize: data.imageSize,
    batchCount: data.batchCount,
    videoResolution: data.seedanceResolution,
    videoDuration: data.seedanceDuration,
    workflowId: data.workflowId,
    prompt: truncateText(data.prompt),
    outputKind,
    outputText: outputKind === 'text' ? truncateText(data.output) : undefined,
  };
}

function buildCanvasDetail(targetIds: string[], limit?: number): Record<string, unknown> {
  const store = useAppStore.getState();
  const scoped = targetIds.length > 0
    ? store.nodes.filter((node) => targetIds.includes(node.id))
    : store.nodes;
  const maxNodes = Math.min(limit ?? DETAIL_NODE_LIMIT, DETAIL_NODE_LIMIT);
  const nodes = scoped.slice(0, maxNodes);
  const visibleIds = new Set(nodes.map((node) => node.id));
  return {
    revision: store.getCurrentRevision(),
    nodeCount: store.nodes.length,
    edgeCount: store.edges.length,
    selectedNodeIds: store.selectedNodeIds,
    nodes: nodes.map(describeNode),
    // 只给出与返回节点相关的连线，避免整张图铺满上下文
    edges: store.edges
      .filter((edge) => visibleIds.has(edge.source) || visibleIds.has(edge.target))
      .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    truncated: scoped.length > nodes.length,
  };
}

/** 校验模型引用是否已配置且与目标节点类型匹配，返回可直接合并的节点补丁。 */
function resolveModelPatch(
  modelRef: string,
  targets: Node<BaseNodeData>[],
): { patch: Partial<BaseNodeData> } | { error: string } {
  const option = listConfiguredModels(useAppStore.getState())
    .find((model) => model.id === modelRef);
  if (!option) {
    return { error: `模型“${modelRef}”未配置；先用 app_get_state 查询可用模型 ID` };
  }
  const mismatched = targets.filter(
    (node) => getProjectModelKind(node.type) !== option.category,
  );
  if (mismatched.length > 0) {
    return {
      error: `模型“${option.name}”是${option.category}模型，与 ${mismatched.length} 个目标节点的类型不匹配`,
    };
  }
  // ComfyUI 工作流靠 workflowId 走本地执行路径，只写 model 会在生成时找不到工作流
  if (option.provider === 'comfyui') {
    return {
      patch: { model: 'comfyui/workflow', provider: 'comfyui', workflowId: option.id.slice('comfyui/'.length) },
    };
  }
  return {
    patch: {
      model: option.id,
      provider: parseProjectModelRef(option.id)?.provider ?? option.provider,
    },
  };
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

/**
 * 节点框大小按内容推断，避免一批节点全是同样的 280x160：
 * 视觉节点按画面比例撑开，正文已经就位的文本节点按行数撑高，其余用默认值。
 * 布局排布和真正落库的节点共用这里，两边尺寸必须一致，否则会算错碰撞。
 */
function getNodeDimensions(input: CreateNodeInput): { width: number; height: number } {
  if (input.aspectRatio && VISUAL_NODE_TYPES.has(input.type)) {
    return {
      width: DEFAULT_NODE_WIDTH,
      height: nodeHeightForAspectRatio(input.aspectRatio, DEFAULT_NODE_WIDTH),
    };
  }
  const content = resolveNodeBody(input);
  if (content) {
    return {
      width: DEFAULT_NODE_WIDTH,
      height: textNodeHeight(content.split('\n').length),
    };
  }
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
  const body = resolveNodeBody(input);
  const isSource = isSourceNodeType(type) || Boolean(input.content?.trim());
  const prompt = isSourceNodeType(type) && !input.content ? undefined : input.prompt?.trim();
  const dimensions = getNodeDimensions(input);
  return {
    id,
    type,
    position,
    data: {
      label: input.label.trim(),
      type,
      role: isSource ? 'source' : 'generator',
      ...(body ? { output: body } : {}),
      ...(prompt ? { prompt } : {}),
      ...(input.aspectRatio && VISUAL_NODE_TYPES.has(type)
        ? { aspectRatio: input.aspectRatio }
        : {}),
      status: body ? 'success' : 'idle',
      nodeWidth: dimensions.width,
      nodeHeight: dimensions.height,
    },
  };
}

export function registerCanvasAgentTools(): Array<() => void> {
  return [
    registerAgentTool<QueryNodesInput>({
      id: 'canvas_query',
      title: '查询画布',
      description: [
        '读取画布概况或符合条件的节点。无筛选条件时返回整个画布概况。',
        'detail=true 时额外返回结构化节点详情：ID、坐标、尺寸、模型、生成参数、提示词、',
        '文本输出摘要和相关连线，用于精确定位后再调用更新、连接或运行工具。',
        '不会返回本地路径或媒体 URL。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          ...targetProperties,
          detail: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: DETAIL_NODE_LIMIT },
        },
        additionalProperties: false,
      },
      effect: 'read',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `查询画布${resolveTargetIds(input).length ? '中的匹配节点' : '概况'}${input.detail ? '详情' : ''}`,
      execute: async (context, input) => {
        const targetIds = resolveTargetIds(input);
        const result = await executeCanvasCommand('query', targetIds, context, '查询画布');
        if (!input.detail || result.status !== 'success') return result;
        return {
          ...result,
          modelContent: JSON.stringify({
            summary: result.summary,
            ...buildCanvasDetail(targetIds, input.limit),
          }),
        };
      },
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
      description: [
        '在画布上原子创建一个或多个节点；不会自动运行节点模型。',
        'prompt 里可写 @{nodeId:label} 或 @drama{assetId:name} 引用已有节点输出与资产库设定，生成时自动展开。',
        'type 按这个节点最终要产出什么来选，不要因为内容是文字描述就一律建文本节点：',
        '产物是画面的（角色设定图、场景图、道具图、关键帧、单张分镜）用 ai-image，把画面描述写进 prompt；',
        '产物是镜头的用 ai-video，配乐旁白用 ai-audio，多宫格图片也用 ai-image，镜头表用 ai-shotlist。',
        'ai-storyboard 是把已有图片进行宫格裁切后产生的素材节点，本工具不能直接创建，也不能给它提示词或运行生成。',
        '产物本身就是文字的用 ai-text（markdown 排版用 ai-markdown）。',
        '文本节点分 prompt 和 content 两个口，别混：',
        'content 是已经写好的正文（全局提示词、视觉基调、世界观设定、剧本全文、你自己刚写完的段落），',
        '直接落进节点正文，建完就能看见、能被下游 @{nodeId:label} 引用，不需要再跑模型；',
        'prompt 是给模型的生成指令（“把这集拆成镜头表”），节点正文会留空，等用户点生成才有内容。',
        '你已经写出成品文字时一律放 content；放进 prompt 只会让节点显示空白，引用它也只能拿到空内容。',
        '视觉节点要按画面内容给 aspectRatio，不要整批用同一个比例：',
        '人物立绘、定妆图用 3:4，场景板、镜头画面、分镜用 16:9，道具、图标、材质用 1:1，竖屏短视频用 9:16，宽银幕气氛图用 21:9；',
        '项目已经定了画幅（如剧本写明 16:9）时，镜头类节点跟随项目画幅，只有人物、道具这类单体参考图才另选比例。',
        '节点框大小由本地按比例和正文长度自动算，不用也不能自己传宽高。',
      ].join(''),
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
                type: { type: 'string', enum: AGENT_CREATABLE_NODE_TYPES },
                label: { type: 'string', minLength: 1, maxLength: 120 },
                prompt: { type: 'string', maxLength: 8000 },
                content: { type: 'string', maxLength: 40000 },
                aspectRatio: { type: 'string', enum: ASPECT_RATIOS },
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
      buildInputDisplay: createNodesInputDisplay,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const storyboardCount = input.nodes.filter((node) => node.type === 'ai-storyboard').length;
        if (storyboardCount > 0) {
          const message = `宫格分镜只能由已有图片裁切产生，不能直接创建（${storyboardCount} 个无效节点）`;
          return { status: 'error', summary: message, modelContent: message };
        }
        // 媒体节点的 output 存的是本地路径或 URL，写正文进去会直接建出一个坏节点
        const nonText = input.nodes.filter(
          (node) => node.content?.trim() && !TEXT_OUTPUT_NODE_TYPES.has(node.type),
        );
        if (nonText.length > 0) {
          const message = `content 只能用于文本类节点，${nonText.length} 个节点不是文本节点`;
          return { status: 'error', summary: message, modelContent: message };
        }
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
          display: {
            entities: nodes.map((node) => ({
              id: node.id,
              title: node.data.label,
              fields: [
                { label: '类型', value: node.type ?? node.data.type },
                {
                  label: '位置',
                  value: `(${Math.round(node.position.x)}, ${Math.round(node.position.y)})`,
                  source: 'resolved',
                },
              ],
              preview: displayPreview(node.data.prompt ?? node.data.output),
            })),
          },
        };
      },
    }),
    registerAgentTool<UpdateNodesInput>({
      id: 'canvas_update_nodes',
      title: '更新画布节点',
      description: [
        '批量更新匹配节点：名称、提示词、正文内容、位置、尺寸、生成模型和生成参数。',
        '视频节点使用统一字段 videoResolution / videoDuration；内部会映射到对应厂商协议字段。',
        'content 改写节点正文，只能用于文本类节点（ai-text / ai-markdown / source-text / comment）。',
        'prompt 里可写 @{nodeId:label} 引用其他节点输出、@drama{assetId:name} 引用资产库设定，生成时自动展开；ID 必须真实存在。',
        'x/y 是绝对坐标，一次只能移动一个节点；dx/dy 是相对位移，可批量。',
        'model 必须是 app_get_state 返回的模型 ID，且类型要与节点匹配。',
        '不修改已生成的结果，也不会触发生成（生成用 canvas_run_nodes）。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          ...targetProperties,
          label: { type: 'string', minLength: 1, maxLength: 120 },
          prompt: { type: 'string', maxLength: 8000 },
          content: { type: 'string', maxLength: 40000 },
          x: { type: 'number', minimum: -100000, maximum: 100000 },
          y: { type: 'number', minimum: -100000, maximum: 100000 },
          dx: { type: 'number', minimum: -100000, maximum: 100000 },
          dy: { type: 'number', minimum: -100000, maximum: 100000 },
          width: { type: 'number', minimum: MIN_NODE_SIZE, maximum: MAX_NODE_SIZE },
          height: { type: 'number', minimum: MIN_NODE_SIZE, maximum: MAX_NODE_SIZE },
          model: { type: 'string', minLength: 1, maxLength: 240 },
          aspectRatio: { type: 'string', enum: ASPECT_RATIOS },
          imageSize: { type: 'string', enum: [...PROJECT_IMAGE_SIZES] },
          batchCount: { type: 'integer', minimum: 1, maximum: MAX_IMAGE_BATCH_COUNT },
          videoResolution: { type: 'string', minLength: 1, maxLength: 40 },
          videoDuration: { type: 'integer', minimum: 1, maximum: 3600 },
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
        const moveAbsolute = input.x !== undefined || input.y !== undefined;
        const moveRelative = input.dx !== undefined || input.dy !== undefined;
        if (moveAbsolute && targetIds.length > 1) {
          const message = '绝对坐标一次只能移动一个节点，批量移动请用 dx/dy';
          return { status: 'error', summary: message, modelContent: message };
        }

        const patch: Partial<BaseNodeData> = {
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
          ...(input.width !== undefined ? { nodeWidth: Math.round(input.width) } : {}),
          ...(input.height !== undefined ? { nodeHeight: Math.round(input.height) } : {}),
          ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
          ...(input.imageSize !== undefined ? { imageSize: input.imageSize } : {}),
          ...(input.batchCount !== undefined ? { batchCount: input.batchCount } : {}),
          ...(input.videoResolution !== undefined ? { seedanceResolution: input.videoResolution.trim() } : {}),
          ...(input.videoDuration !== undefined ? { seedanceDuration: input.videoDuration } : {}),
        };
        const targets = useAppStore.getState().nodes
          .filter((node) => targetIds.includes(node.id));
        if (input.prompt?.trim() && targets.some((node) => node.data.type === 'ai-storyboard')) {
          const message = '宫格分镜是已有图片的裁切结果，不能设置生成提示词';
          return { status: 'error', summary: message, modelContent: message };
        }
        const beforeAudit = new Map(
          targets.map((node) => [node.id, captureNodeAudit(node)]),
        );
        if (input.videoResolution !== undefined || input.videoDuration !== undefined) {
          const nonVideo = targets.filter((node) => node.data.type !== 'ai-video');
          if (nonVideo.length > 0) {
            const message = `videoResolution / videoDuration 只能用于视频节点，${nonVideo.length} 个目标节点不是视频节点`;
            return { status: 'error', summary: message, modelContent: message };
          }
        }
        if (input.content !== undefined) {
          // 媒体节点的 output 存的是本地路径或 URL，改写会直接破坏节点
          const nonText = targets.filter((node) => !TEXT_OUTPUT_NODE_TYPES.has(node.data.type));
          if (nonText.length > 0) {
            const message = `content 只能改写文本类节点，${nonText.length} 个目标节点不是文本节点`;
            return { status: 'error', summary: message, modelContent: message };
          }
          patch.output = input.content;
        }
        if (input.model !== undefined) {
          const resolved = resolveModelPatch(input.model, targets);
          if ('error' in resolved) {
            return { status: 'error', summary: resolved.error, modelContent: resolved.error };
          }
          Object.assign(patch, resolved.patch);
        }
        if (Object.keys(patch).length === 0 && !moveAbsolute && !moveRelative) {
          return { status: 'error', summary: '没有提供需要更新的字段', modelContent: '没有提供需要更新的字段' };
        }

        const store = useAppStore.getState();
        // updateNodesDataBatch 自带一次 commitToHistory；只移动时才需要单独提交历史
        if (Object.keys(patch).length > 0) store.updateNodesDataBatch(targetIds, patch);
        else store.commitToHistory();
        if (moveAbsolute || moveRelative) {
          const current = useAppStore.getState();
          for (const nodeId of targetIds) {
            const node = current.nodes.find((candidate) => candidate.id === nodeId);
            if (!node) continue;
            current.updateNodePositionTransient(nodeId, {
              x: Math.round(input.x ?? node.position.x + (input.dx ?? 0)),
              y: Math.round(input.y ?? node.position.y + (input.dy ?? 0)),
            });
          }
        }
        useAppStore.getState().incrementRevision();
        const updatedTargets = useAppStore.getState().nodes
          .filter((node) => targetIds.includes(node.id));
        return {
          status: 'success',
          summary: `已更新 ${targetIds.length} 个节点`,
          modelContent: JSON.stringify({
            affectedNodeIds: targetIds,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
          display: {
            changes: buildUpdateChanges(input, updatedTargets, beforeAudit),
          },
        };
      },
    }),
    registerAgentTool<ConnectNodesInput>({
      id: 'canvas_connect_nodes',
      title: '连接画布节点',
      description: [
        '在两个已存在的画布节点之间创建一条连线，方向是 sourceId（提供内容）→ targetId（消费内容）。',
        '连线会把上游节点的输出作为下游生成节点的参考输入，所以 targetId 必须是生成器节点：',
        'source-* 与 comment 只能作为 sourceId。',
      ].join(''),
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
        const sourceNode = store.nodes.find((node) => node.id === input.sourceId);
        const targetNode = store.nodes.find((node) => node.id === input.targetId);
        if (!sourceNode || !targetNode) {
          return { status: 'error', summary: '源节点或目标节点不存在', modelContent: '源节点或目标节点不存在' };
        }
        if (input.sourceId === input.targetId) {
          return { status: 'error', summary: '不能连接节点自身', modelContent: '不能连接节点自身' };
        }
        // 素材节点没有输入，连进去的线永远不会被读取，多半是模型把两端写反了
        if (isSourceOnlyNode(targetNode)) {
          const message = `目标节点「${targetNode.data.label}」是素材节点，只能作为连线起点；两端写反了就交换 sourceId 与 targetId`;
          return { status: 'error', summary: message, modelContent: message };
        }
        if (store.edges.some((edge) => edge.source === input.sourceId && edge.target === input.targetId)) {
          return { status: 'success', summary: '节点已经连接', modelContent: '节点已经连接，无需重复创建' };
        }
        store.onConnect({
          source: input.sourceId,
          target: input.targetId,
          sourceHandle: 'right',
          targetHandle: 'left',
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
    registerAgentTool<DisconnectNodesInput>({
      id: 'canvas_disconnect_nodes',
      title: '断开画布连线',
      description: '删除连线。同时给出 sourceId 和 targetId 时只删这一条；只给一个时删除该节点作为该端的所有连线。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: { type: 'string', minLength: 1, maxLength: 120 },
          targetId: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `断开连线 ${input.sourceId ?? '*'} → ${input.targetId ?? '*'}`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        // 两端都不给会删掉整张图的连线，必须拒绝
        if (!input.sourceId && !input.targetId) {
          const message = '必须至少提供 sourceId 或 targetId';
          return { status: 'error', summary: message, modelContent: message };
        }
        const store = useAppStore.getState();
        const matched = store.edges.filter((edge) => (
          (input.sourceId ? edge.source === input.sourceId : true)
          && (input.targetId ? edge.target === input.targetId : true)
        ));
        if (matched.length === 0) {
          return { status: 'error', summary: '没有找到匹配的连线', modelContent: '没有找到匹配的连线' };
        }
        store.onEdgesChange(matched.map((edge) => ({ type: 'remove' as const, id: edge.id })));
        useAppStore.getState().incrementRevision();
        return {
          status: 'success',
          summary: `已断开 ${matched.length} 条连线`,
          modelContent: JSON.stringify({
            removedEdgeIds: matched.map((edge) => edge.id),
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
      id: 'canvas_ungroup_nodes',
      title: '解散画布分组',
      description: '解散匹配节点所在的分组，节点本身保留在画布上。',
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `解散 ${resolveTargetIds(input).length} 个节点所在的分组`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到匹配节点', modelContent: '没有找到匹配节点' };
        }
        const store = useAppStore.getState();
        const groupCount = new Set(
          store.nodes
            .filter((node) => targetIds.includes(node.id))
            .map((node) => node.parentId ?? (node.data.groupId as string | undefined))
            .filter(Boolean),
        ).size;
        if (groupCount === 0) {
          return { status: 'error', summary: '匹配节点不属于任何分组', modelContent: '匹配节点不属于任何分组' };
        }
        store.setSelectedNodeIds(targetIds);
        store.ungroupSelectedNodes();
        useAppStore.getState().incrementRevision();
        return {
          status: 'success',
          summary: `已解散 ${groupCount} 个分组`,
          modelContent: JSON.stringify({
            affectedNodeIds: targetIds,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<NodeTargetInput>({
      id: 'canvas_run_nodes',
      title: '运行画布节点',
      description: [
        `按节点自身的提示词、模型和连线输入运行生成，一次最多 ${MAX_RUN_NODES} 个节点，串行执行。`,
        '这是真实的付费模型调用，每次都需要用户确认；只想改参数不生成时用 canvas_update_nodes。',
        '正在生成中的节点会被跳过。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: targetProperties,
        additionalProperties: false,
      },
      effect: 'media_generation',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `运行 ${resolveTargetIds(input).length} 个画布节点`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const targetIds = resolveTargetIds(input);
        if (targetIds.length === 0) {
          return { status: 'error', summary: '没有找到匹配节点', modelContent: '没有找到匹配节点' };
        }
        if (targetIds.length > MAX_RUN_NODES) {
          const message = `一次最多运行 ${MAX_RUN_NODES} 个节点，当前匹配 ${targetIds.length} 个`;
          return { status: 'error', summary: message, modelContent: message };
        }
        const storyboardCount = useAppStore.getState().nodes.filter((node) => (
          targetIds.includes(node.id) && node.data.type === 'ai-storyboard'
        )).length;
        if (storyboardCount > 0) {
          const message = `宫格分镜是已有图片的裁切结果，不能运行生成（${storyboardCount} 个无效节点）`;
          return { status: 'error', summary: message, modelContent: message };
        }
        const results: Array<{ nodeId: string; status: string; message?: string }> = [];
        for (const nodeId of targetIds) {
          if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const node = useAppStore.getState().nodes.find((candidate) => candidate.id === nodeId);
          if (!node) {
            results.push({ nodeId, status: 'missing' });
            continue;
          }
          if (node.data.status === 'loading') {
            results.push({ nodeId, status: 'skipped', message: '节点正在生成中' });
            continue;
          }
          const result = await executeGeneration(nodeId);
          // 生成期间用户可能切走项目，后续节点不能再往这张画布写
          if (useAppStore.getState().currentProjectId !== context.projectId) {
            results.push({ nodeId, status: 'aborted', message: '生成期间项目已切换' });
            break;
          }
          useAppStore.getState().incrementRevision();
          results.push({
            nodeId,
            status: result.success ? 'success' : 'failed',
            message: result.message,
          });
        }
        const succeeded = results.filter((item) => item.status === 'success').length;
        return {
          status: succeeded > 0 ? 'success' : 'error',
          summary: `已运行 ${succeeded}/${targetIds.length} 个节点`,
          modelContent: JSON.stringify({
            results,
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<{ nodeId: string }>({
      id: 'canvas_duplicate_node', title: '复制画布节点', description: '复制一个普通节点或画布笔记；分组节点不可复制。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['nodeId'], additionalProperties: false, properties: { nodeId: { type: 'string', minLength: 1, maxLength: 160 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const store = useAppStore.getState();
        const node = store.nodes.find((item) => item.id === input.nodeId);
        if (!node || node.type === 'group') return { status: 'error', summary: '节点不存在或分组节点不可复制', modelContent: '节点不存在或分组节点不可复制' };
        const before = new Set(store.nodes.map((item) => item.id));
        const noteCloneId = node.type === 'canvas-note' ? store.duplicateCanvasNote(node.id) : null;
        if (node.type !== 'canvas-note') store.duplicateNode(node.id);
        const cloneId = noteCloneId ?? useAppStore.getState().nodes.find((item) => !before.has(item.id))?.id;
        if (!cloneId) return { status: 'error', summary: '节点复制失败', modelContent: '节点复制失败' };
        useAppStore.getState().incrementRevision();
        return { status: 'success', summary: `已复制节点“${node.data.label}”`, modelContent: JSON.stringify({ sourceNodeId: node.id, cloneNodeId: cloneId, revision: useAppStore.getState().getCurrentRevision() }) };
      },
    }),
    registerAgentTool<{ nodeId: string; text?: string; width?: number; height?: number; opacity?: number; strokeColor?: string; backgroundColor?: string; fontSize?: 16 | 20 | 28 | 36; textAlign?: 'left' | 'center' | 'right' }>({
      id: 'canvas_update_note', title: '更新画布笔记', description: '更新画布笔记的文字、尺寸和基础样式。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['nodeId'], additionalProperties: false, properties: {
        nodeId: { type: 'string', minLength: 1, maxLength: 160 }, text: { type: 'string', maxLength: 20_000 }, width: { type: 'number', minimum: 20, maximum: 4000 }, height: { type: 'number', minimum: 20, maximum: 4000 }, opacity: { type: 'number', minimum: 0, maximum: 100 }, strokeColor: { type: 'string', minLength: 1, maxLength: 80 }, backgroundColor: { type: 'string', minLength: 1, maxLength: 80 }, fontSize: { type: 'number', enum: [16, 20, 28, 36] }, textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
      } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const { nodeId, text, width, height, ...style } = input;
        const changed = useAppStore.getState().updateCanvasNote(nodeId, { text, width, height, style });
        if (!changed) return { status: 'error', summary: '画布笔记不存在', modelContent: '画布笔记不存在' };
        useAppStore.getState().incrementRevision();
        return { status: 'success', summary: '已更新画布笔记', modelContent: JSON.stringify({ nodeId, revision: useAppStore.getState().getCurrentRevision() }) };
      },
    }),
    registerAgentTool<{ nodeId: string; direction: 'back' | 'backward' | 'forward' | 'front' }>({
      id: 'canvas_move_note_layer', title: '调整画布笔记图层', description: '将画布笔记后移、前移、置底或置顶。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['nodeId', 'direction'], additionalProperties: false, properties: { nodeId: { type: 'string', minLength: 1, maxLength: 160 }, direction: { type: 'string', enum: ['back', 'backward', 'forward', 'front'] } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const moved = useAppStore.getState().moveCanvasNoteLayer(input.nodeId, input.direction); if (!moved) return { status: 'error', summary: '画布笔记不存在或已在目标图层边界', modelContent: '画布笔记不存在或已在目标图层边界' }; useAppStore.getState().incrementRevision(); return { status: 'success', summary: '已调整画布笔记图层', modelContent: JSON.stringify({ nodeId: input.nodeId, direction: input.direction, revision: useAppStore.getState().getCurrentRevision() }) }; },
    }),
    registerAgentTool<{ nodeId: string }>({
      id: 'canvas_convert_image_kind', title: '转换图片节点形态', description: '在图片节点与图片画布笔记之间转换；有连线的普通图片节点不会转换。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['nodeId'], additionalProperties: false, properties: { nodeId: { type: 'string', minLength: 1, maxLength: 160 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const result = useAppStore.getState().convertImageNodeKind(input.nodeId); if (!result || result === 'connected') return { status: 'error', summary: result === 'connected' ? '图片节点有连线，不能转换为画布笔记' : '节点不是可转换的图片节点', modelContent: result === 'connected' ? '图片节点有连线，不能转换为画布笔记' : '节点不是可转换的图片节点' }; useAppStore.getState().incrementRevision(); return { status: 'success', summary: `已${result === 'to-note' ? '转换为图片笔记' : '转换为图片节点'}`, modelContent: JSON.stringify({ nodeId: input.nodeId, result, revision: useAppStore.getState().getCurrentRevision() }) }; },
    }),
    registerAgentTool<{ groupId: string; name: string }>({
      id: 'canvas_rename_group', title: '重命名画布分组', description: '重命名一个现有画布分组。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['groupId', 'name'], additionalProperties: false, properties: { groupId: { type: 'string', minLength: 1, maxLength: 160 }, name: { type: 'string', minLength: 1, maxLength: 120 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const group = useAppStore.getState().groups.find((item) => item.id === input.groupId); if (!group) return { status: 'error', summary: '画布分组不存在', modelContent: '画布分组不存在' }; useAppStore.getState().renameGroup(group.id, input.name.trim()); useAppStore.getState().incrementRevision(); return { status: 'success', summary: `已重命名分组为“${input.name.trim()}”`, modelContent: JSON.stringify({ groupId: group.id, name: input.name.trim(), revision: useAppStore.getState().getCurrentRevision() }) }; },
    }),
    registerAgentTool<{ storyboardId: string; cellIndex: number; sourceNodeId: string }>({
      id: 'canvas_fill_storyboard_cell', title: '填充分镜宫格', description: '把已提取的图片节点填入分镜宫格空位；源图片节点按既有语义从画布移除。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['storyboardId', 'cellIndex', 'sourceNodeId'], additionalProperties: false, properties: { storyboardId: { type: 'string', minLength: 1, maxLength: 160 }, cellIndex: { type: 'integer', minimum: 0, maximum: 399 }, sourceNodeId: { type: 'string', minLength: 1, maxLength: 160 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const before = useAppStore.getState().nodes.some((item) => item.id === input.sourceNodeId); useAppStore.getState().fillStoryboardCell(input.storyboardId, input.cellIndex, input.sourceNodeId); const consumed = before && !useAppStore.getState().nodes.some((item) => item.id === input.sourceNodeId); if (!consumed) return { status: 'error', summary: '宫格、来源图片或目标空位无效', modelContent: '宫格、来源图片或目标空位无效' }; useAppStore.getState().incrementRevision(); return { status: 'success', summary: '已填充分镜宫格', modelContent: JSON.stringify({ storyboardId: input.storyboardId, cellIndex: input.cellIndex, sourceNodeId: input.sourceNodeId, revision: useAppStore.getState().getCurrentRevision() }) }; },
    }),
    registerAgentTool<{ shotlistId: string; rowId: string; sourceNodeId: string }>({
      id: 'canvas_bind_shotlist_frame', title: '绑定镜头表画面', description: '把图片或视频节点绑定到镜头表指定行。', effect: 'canvas_write',
      inputSchema: { type: 'object', required: ['shotlistId', 'rowId', 'sourceNodeId'], additionalProperties: false, properties: { shotlistId: { type: 'string', minLength: 1, maxLength: 160 }, rowId: { type: 'string', minLength: 1, maxLength: 160 }, sourceNodeId: { type: 'string', minLength: 1, maxLength: 160 } } }, authorize: authorizeCurrentProject,
      execute: async (context, input) => { assertCanvasRevision(context); const before = JSON.stringify(useAppStore.getState().nodes.find((item) => item.id === input.shotlistId)?.data.shotlistRows ?? []); useAppStore.getState().bindShotlistFrame(input.shotlistId, input.rowId, input.sourceNodeId); const after = JSON.stringify(useAppStore.getState().nodes.find((item) => item.id === input.shotlistId)?.data.shotlistRows ?? []); if (before === after) return { status: 'error', summary: '镜头表、行或来源媒体无效', modelContent: '镜头表、行或来源媒体无效' }; useAppStore.getState().incrementRevision(); return { status: 'success', summary: '已绑定镜头表画面', modelContent: JSON.stringify({ shotlistId: input.shotlistId, rowId: input.rowId, sourceNodeId: input.sourceNodeId, revision: useAppStore.getState().getCurrentRevision() }) }; },
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
