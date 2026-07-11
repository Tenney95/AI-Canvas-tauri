/**
 * canvasPlanner — 画布规划器
 * 将 CommandIntent 解析为可执行的 CommandPlan：
 * 1. 解析 Selector → 具体节点 ID 集合
 * 2. 快照当前 revision
 * 3. 评估操作风险等级
 * 4. 生成人类可读的 plan.summary
 */
import { useAppStore } from '../../store/useAppStore';
import { resolveNodeSelector } from './commandRegistry';
import { BATCH_NODE_LIMIT } from '../../store/store.chat';
import type {
  CommandIntent,
  CommandPlan,
  ExternalDataDisclosure,
} from '../../types/chat';

// ============================================
// Risk assessment
// ============================================

const READ_COMMANDS = new Set(['query', 'select']);
const DESTRUCTIVE_COMMANDS = new Set(['deleteNodes']);
const EXTERNAL_COMMANDS = new Set(['connect', 'groupByType', 'translatePrompt', 'regenerate', 'describe']);

function assessRisk(commandId: string, targetCount: number): CommandPlan['risk'] {
  if (READ_COMMANDS.has(commandId)) return 'read';
  if (DESTRUCTIVE_COMMANDS.has(commandId)) return targetCount > 3 ? 'destructive' : 'low';
  if (EXTERNAL_COMMANDS.has(commandId)) return 'external';
  return 'low';
}

// ============================================
// Summary generation
// ============================================

function generateSummary(intent: CommandIntent, targetIds: string[]): string {
  const store = useAppStore.getState();
  const nodes = store.nodes;

  switch (intent.commandId) {
    case 'query': {
      if (targetIds.length === 0) return '查询画布状态';
      const labels = targetIds
        .slice(0, 5)
        .map((id) => nodes.find((n) => n.id === id)?.data?.label || `#${id}`)
        .join('、');
      const suffix = targetIds.length > 5 ? ` 等${targetIds.length}个节点` : '';
      return `查询${labels}${suffix}`;
    }
    case 'select':
      return targetIds.length > 0
        ? `选中 ${targetIds.length} 个节点`
        : '未找到匹配节点';
    case 'deleteNodes':
      return targetIds.length > 0
        ? `删除 ${targetIds.length} 个节点`
        : '没有需要删除的节点';
    case 'undo':
      return '撤销上一步操作';
    case 'redo':
      return '重做';
    case 'cancelTask':
      return '取消当前任务';
    default:
      return `执行 ${intent.commandId}`;
  }
}

// ============================================
// Public API
// ============================================

export interface PlanResult {
  plan: CommandPlan;
  /** 是否需要外部数据披露（LLM 模式才需要） */
  disclosure?: ExternalDataDisclosure;
}

/**
 * 将 CommandIntent 规划为可执行的 CommandPlan。
 *
 * 步骤：
 * 1. Resolve selector → 节点 ID 集合
 * 2. 如果意图没有 selector 且命令需要 target，补充全量节点（用于 deleteNodes 无 selector）
 * 3. 快照 revision
 * 4. 计算风险等级 & requiresConfirm
 */
export function planCommand(intent: CommandIntent): PlanResult {
  const store = useAppStore.getState();
  const baseRevision = store.getCurrentRevision();
  const projectId = store.currentProjectId ?? '';

  // 1. 解析 selector
  let targetIds: string[] = [];
  if (intent.selector) {
    targetIds = resolveNodeSelector(intent.selector);
  }

  // 2. 无 selector 的写命令 → 需要确认（防止误操作）
  const risk = assessRisk(intent.commandId, targetIds.length);

  // 3. 数量限制
  if (targetIds.length > BATCH_NODE_LIMIT) {
    targetIds = targetIds.slice(0, BATCH_NODE_LIMIT);
  }

  const summary = generateSummary(intent, targetIds);
  const requiresConfirm =
    risk === 'destructive' ||
    intent.confidence < 0.85 ||
    (intent.parseSource === 'llm' && intent.confidence < 0.9);

  const plan: CommandPlan = {
    id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    projectId,
    baseRevision,
    commandId: intent.commandId,
    targetNodeIds: targetIds,
    params: intent.params ?? {},
    summary,
    risk,
    requiresConfirm,
  };

  // LLM 来源时附加外部数据披露
  const disclosure: ExternalDataDisclosure | undefined =
    intent.parseSource === 'llm'
      ? {
          modelId: (intent.params as { modelId?: string })?.modelId,
          fieldsSent: ['canvasContext', 'userMessage'],
          mediaSent: false,
          estimatedCost: '≈ ¥0.01',
        }
      : undefined;

  return { plan, disclosure };
}
