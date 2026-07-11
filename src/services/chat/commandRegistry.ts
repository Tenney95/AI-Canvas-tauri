/**
 * commandRegistry — 命令注册表
 * 将 CommandId 映射为具体执行函数，直接操作 Store。
 * 每个命令接收解析后的 CommandPlan，返回 CommandResult。
 */
import { useAppStore } from '../../store/useAppStore';
import type {
  CommandId,
  CommandPlan,
  CommandResult,
  NodeSelector,
  OperationLog,
} from '../../types/chat';
import type { BaseNodeData } from '../../types';

// ============================================
// Command executor type
// ============================================

export type CommandExecutor = (plan: CommandPlan) => Promise<CommandResult>;

// ============================================
// Selector resolution helper
// ============================================

/**
 * 将 NodeSelector AST 解析为具体的节点 ID 数组。
 * 不走服务器端，直接操作 Store 中的当前节点集。
 */
export function resolveNodeSelector(selector: NodeSelector): string[] {
  const store = useAppStore.getState();
  const allNodes = store.nodes;

  function resolve(s: NodeSelector): Set<string> {
    switch (s.op) {
      case 'selected':
        return new Set(store.selectedNodeIds);

      case 'displayId': {
        const node = allNodes.find((n) => (n.data as BaseNodeData).displayId === s.value);
        return node ? new Set([node.id]) : new Set<string>();
      }

      case 'type': {
        const ids = allNodes
          .filter((n) => n.type === s.value)
          .map((n) => n.id);
        return new Set(ids);
      }

      case 'status': {
        const ids = allNodes
          .filter((n) => (n.data as BaseNodeData).status === s.value)
          .map((n) => n.id);
        return new Set(ids);
      }

      case 'and': {
        if (s.items.length === 0) return new Set<string>();
        let result = resolve(s.items[0]);
        for (let i = 1; i < s.items.length; i++) {
          const other = resolve(s.items[i]);
          result = new Set([...result].filter((id) => other.has(id)));
          if (result.size === 0) break;
        }
        return result;
      }

      case 'or': {
        const result = new Set<string>();
        for (const item of s.items) {
          for (const id of resolve(item)) result.add(id);
        }
        return result;
      }

      case 'not': {
        const inner = resolve(s.item);
        return new Set(allNodes.map((n) => n.id).filter((id) => !inner.has(id)));
      }

      default:
        return new Set<string>();
    }
  }

  return [...resolve(selector)];
}

// ============================================
// Command registry
// ============================================

/**
 * 命令注册表：CommandId → 执行函数。
 * 每个 executor 直接操作 Zustand Store。
 */
const registry = new Map<CommandId, CommandExecutor>();

// ── query ──
registry.set('query', async (plan) => {
  const store = useAppStore.getState();
  const nodes = store.nodes;
  const targetIds = new Set(plan.targetNodeIds);

  let matchCount = 0;
  const summaryParts: string[] = [];

  if (targetIds.size > 0) {
    matchCount = targetIds.size;
    summaryParts.push(`找到 ${matchCount} 个匹配节点`);
    const matchedNodes = nodes.filter((n) => targetIds.has(n.id));
    for (const n of matchedNodes) {
      const data = n.data as BaseNodeData;
      summaryParts.push(
        `· #${data.displayId ?? '?'} 【${data.label || n.type}】 — ${data.status === 'success' ? '已完成' : data.status === 'error' ? '失败' : data.status === 'loading' ? '进行中' : '空闲'}`,
      );
    }
  } else {
    summaryParts.push(`画布上共 ${nodes.length} 个节点，${store.edges.length} 条连线`);
    // 按类型统计
    const typeCounts = new Map<string, number>();
    for (const n of nodes) {
      typeCounts.set(n.type ?? 'unknown', (typeCounts.get(n.type ?? 'unknown') || 0) + 1);
    }
    for (const [type, count] of typeCounts) {
      summaryParts.push(`· ${type}: ${count} 个`);
    }
    // 按状态统计
    const statusCounts = new Map<string, number>();
    for (const n of nodes) {
      const s = (n.data as BaseNodeData).status || 'idle';
      statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
    }
    if (statusCounts.size > 1) {
      summaryParts.push('状态分布：');
      for (const [status, count] of statusCounts) {
        const label =
          status === 'error' ? '失败' : status === 'loading' ? '进行中' : status === 'success' ? '已完成' : '空闲';
        summaryParts.push(`  ${label}: ${count} 个`);
      }
    }
    matchCount = nodes.length;
  }

  return {
    planId: plan.id,
    status: 'success',
    affectedNodeIds: [...targetIds],
    message: summaryParts.join('\n'),
  };
});

// ── select ──
registry.set('select', async (plan) => {
  const store = useAppStore.getState();
  const targetIds = plan.targetNodeIds;

  if (targetIds.length === 0) {
    return {
      planId: plan.id,
      status: 'partial',
      affectedNodeIds: [],
      message: '未找到匹配的节点',
    };
  }

  store.setSelectedNodeIds(targetIds);

  return {
    planId: plan.id,
    status: 'success',
    affectedNodeIds: targetIds,
    message: `已选中 ${targetIds.length} 个节点`,
  };
});

// ── deleteNodes ──
registry.set('deleteNodes', async (plan) => {
  const store = useAppStore.getState();
  const targetIds = plan.targetNodeIds;

  if (targetIds.length === 0) {
    return {
      planId: plan.id,
      status: 'partial',
      affectedNodeIds: [],
      message: '没有需要删除的节点',
    };
  }

  store.deleteNodesBatch(targetIds);

  return {
    planId: plan.id,
    status: 'success',
    affectedNodeIds: targetIds,
    message: `已删除 ${targetIds.length} 个节点`,
  };
});

// ── undo ──
registry.set('undo', async (plan) => {
  const store = useAppStore.getState();
  if (store.historyIndex < 0) {
    return {
      planId: plan.id,
      status: 'partial',
      affectedNodeIds: [],
      message: '没有可撤销的操作',
    };
  }
  store.undo();
  return {
    planId: plan.id,
    status: 'success',
    affectedNodeIds: [],
    message: '已撤销上一步操作',
    historyIndex: store.historyIndex,
  };
});

// ── redo ──
registry.set('redo', async (plan) => {
  const store = useAppStore.getState();
  if (store.historyIndex >= store.history.length - 1) {
    return {
      planId: plan.id,
      status: 'partial',
      affectedNodeIds: [],
      message: '没有可重做的操作',
    };
  }
  store.redo();
  return {
    planId: plan.id,
    status: 'success',
    affectedNodeIds: [],
    message: '已重做',
    historyIndex: store.historyIndex,
  };
});

// ── cancelTask ──
registry.set('cancelTask', async (plan) => {
  const store = useAppStore.getState();
  if (store.activeRequestAbort) {
    store.activeRequestAbort.abort();
    store.setActiveRequestAbort(null);
  }
  return {
    planId: plan.id,
    status: 'success',
    affectedNodeIds: [],
    message: '已取消当前任务',
  };
});

// ============================================
// Public API
// ============================================

/** 检查命令是否已注册 */
export function hasCommand(commandId: CommandId): boolean {
  return registry.has(commandId);
}

/** 获取已注册命令列表 */
export function getRegisteredCommands(): CommandId[] {
  return [...registry.keys()];
}

/**
 * 执行一条 CommandPlan。
 * 自动处理 revision 校验：计划修订号落后则返回 rejected。
 */
export async function executeCommand(plan: CommandPlan): Promise<CommandResult> {
  const executor = registry.get(plan.commandId);
  if (!executor) {
    return {
      planId: plan.id,
      status: 'failed',
      affectedNodeIds: [],
      message: `未知命令: ${plan.commandId}`,
      errorCode: 'UNKNOWN_COMMAND',
    };
  }

  // Revision 校验：当前 revision 必须与计划生成时的 baseRevision 一致
  const store = useAppStore.getState();
  const currentRevision = store.getCurrentRevision();
  if (currentRevision !== plan.baseRevision) {
    return {
      planId: plan.id,
      status: 'rejected',
      affectedNodeIds: [],
      message: `画布已变更（rev ${currentRevision} ≠ ${plan.baseRevision}），请重新确认操作`,
      errorCode: 'REVISION_MISMATCH',
    };
  }

  return executor(plan);
}

/**
 * 记录操作日志到 Store
 */
export function logOperation(log: Omit<OperationLog, 'id'>): string {
  const id = `oplog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  useAppStore.getState().addOperationLog({ id, ...log });
  return id;
}
