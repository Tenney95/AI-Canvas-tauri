/** 批量节点调度：工作流及依赖串行、独立任务有界并发，统一复用节点生成执行器。 */
import type { Node, Edge } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { useAppStore, type AppState } from '../store/useAppStore';
import { resolveGenerationNodeData } from './nodeGeneration';
import { resolveGenerationSelection } from '../services/generationInput';
import { runBatchTasks } from '../services/ai/batchUtils';
import { registerCanvasImport, isCanvasDerivationFresh, completeCanvasDerivation } from '../services/canvasDerivationGuard';

export type BatchContext = Pick<AppState, 'commitToHistory' | 'currentProjectId'>;

const EXECUTABLE_NODE_TYPES = new Set(['ai-text', 'ai-image', 'ai-animation', 'ai-panorama', 'ai-video', 'ai-audio']);

function isExecutableNode(node: Node<BaseNodeData>, nodeIdSet: Set<string>, state: AppState): boolean {
  const data = resolveGenerationNodeData(node.data);
  return Boolean(nodeIdSet.has(node.id) && node.type !== 'group' && data
    && EXECUTABLE_NODE_TYPES.has(data.type) && data.status !== 'loading'
    && !resolveGenerationSelection(data, state).error);
}

export function hasBatchExecutableNodes(nodeIds: string[], nodes: Node<BaseNodeData>[]): boolean {
  const state = useAppStore.getState();
  const nodeIdSet = new Set(nodeIds);
  return nodes.some((node) => isExecutableNode(node, nodeIdSet, state));
}

/** 排队时固定提交条件；上游产物更新不改变下游节点本身的输入快照。 */
function queueContext(state: AppState): string {
  return JSON.stringify([
    state.projects.find((project) => project.id === state.currentProjectId)?.settings,
    state.customStyles,
    state.edges.map(({ source, target, sourceHandle, targetHandle }) => [source, target, sourceHandle, targetHandle]),
  ]);
}

// ── 拓扑排序（先压缩强连通分量，确保环内节点也进入结果）──
function topologicalSort(
  nodeIds: string[],
  edges: { source: string; target: string }[],
): string[] {
  const idSet = new Set(nodeIds);
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
  }
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adjacency.get(e.source)!.push(e.target);
    }
  }

  const inputOrder = new Map(nodeIds.map((id, index) => [id, index]));
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (id: string) => {
    indices.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of adjacency.get(id) || []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort((left, right) => inputOrder.get(left)! - inputOrder.get(right)!);
    components.push(component);
  };

  for (const id of nodeIds) {
    if (!indices.has(id)) visit(id);
  }

  const componentByNode = new Map<string, number>();
  const componentRank = components.map((component, componentIndex) => {
    for (const id of component) componentByNode.set(id, componentIndex);
    return Math.min(...component.map((id) => inputOrder.get(id)!));
  });
  const outgoing = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  for (const [source, targets] of adjacency) {
    const sourceComponent = componentByNode.get(source)!;
    for (const target of targets) {
      const targetComponent = componentByNode.get(target)!;
      if (
        sourceComponent !== targetComponent
        && !outgoing[sourceComponent].has(targetComponent)
      ) {
        outgoing[sourceComponent].add(targetComponent);
        indegree[targetComponent] += 1;
      }
    }
  }

  const queue = components
    .map((_, index) => index)
    .filter((index) => indegree[index] === 0)
    .sort((left, right) => componentRank[left] - componentRank[right]);
  const order: string[] = [];
  while (queue.length > 0) {
    const componentIndex = queue.shift()!;
    order.push(...components[componentIndex]);
    for (const targetComponent of outgoing[componentIndex]) {
      indegree[targetComponent] -= 1;
      if (indegree[targetComponent] === 0) {
        queue.push(targetComponent);
        queue.sort((left, right) => componentRank[left] - componentRank[right]);
      }
    }
  }

  return order;
}

// ── 主入口 ──
export async function batchExecuteNodes(
  nodeIds: string[],
  nodes: Node<BaseNodeData>[],
  edges: Edge[],
  ctx: BatchContext,
): Promise<{ ok: number; fail: number; skipped: number }> {
  const initial = useAppStore.getState();
  if (initial.currentProjectId !== ctx.currentProjectId) return { ok: 0, fail: 0, skipped: nodeIds.length };
  const selectedIds = new Set(nodeIds);
  const executable = nodes.filter((node) => isExecutableNode(node, selectedIds, initial));
  const selections = new Map(executable.map((node) => [node.id,
    JSON.stringify(resolveGenerationSelection(resolveGenerationNodeData(node.data)!, initial))]));
  const isWorkflow = (node: Node<BaseNodeData>) => Boolean(resolveGenerationSelection(resolveGenerationNodeData(node.data)!, initial).workflowId);
  // 使用用户看到的 #编号，而非随机内部 ID。未编号节点稳定地排在最后。
  const workflows = executable.filter(isWorkflow).sort((a, b) => (
    (a.data.displayId ?? Number.MAX_SAFE_INTEGER) - (b.data.displayId ?? Number.MAX_SAFE_INTEGER)
  ));
  let workflowIndex = 0;
  // 只重排工作流所占的位置，保留普通节点原顺序；环内也按此顺序执行。
  const toRun = executable.map((node) => isWorkflow(node) ? workflows[workflowIndex++] : node);
  if (toRun.length === 0) return { ok: 0, fail: 0, skipped: 0 };
  ctx.commitToHistory();
  const guard = registerCanvasImport(initial);
  const context = queueContext(initial);

  // 仅在调度图添加串行约束，不修改画布连线。复用现有依赖排序，避免
  // 将工作流拆出独立队列后，与其普通上游/下游节点同时执行。
  const schedulingEdges: { source: string; target: string }[] = [...edges];
  for (let index = 1; index < workflows.length; index++) {
    schedulingEdges.push({ source: workflows[index - 1].id, target: workflows[index].id });
  }

  // Identify which nodes have edges between them
  const executableIds = new Set(toRun.map((node) => node.id));
  const connectedIds = new Set<string>();
  for (const e of schedulingEdges) {
    if (executableIds.has(e.source) && executableIds.has(e.target)) {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }
  }

  // Split: connected vs isolated
  const connectedNodes = toRun.filter((n) => connectedIds.has(n.id));
  const isolatedNodes = toRun.filter((n) => !connectedIds.has(n.id));

  // Topological sort for connected nodes
  const order = topologicalSort(
    connectedNodes.map((n) => n.id),
    schedulingEdges,
  );
  const orderedConnected = order
    .map((id) => connectedNodes.find((n) => n.id === id))
    .filter(Boolean) as Node<BaseNodeData>[];

  let ok = 0, fail = 0, skipped = 0;
  try {
    const { executeGeneration } = await import('../services/generationService');
    const runNode = async (queued: Node<BaseNodeData>) => {
      const current = useAppStore.getState();
      const node = current.nodes.find((item) => item.id === queued.id);
      if (!guard || !isCanvasDerivationFresh(guard, current) || !node || node.type !== queued.type
        || node.data !== queued.data || node.data.status === 'loading' || queueContext(current) !== context
        || JSON.stringify(resolveGenerationSelection(resolveGenerationNodeData(node.data)!, current)) !== selections.get(node.id)) {
        skipped++;
        return;
      }
      try {
        const result = await executeGeneration(node.id, undefined, undefined, undefined, undefined,
          { history: 'transient', silent: true });
        if (result.success) ok++;
        else fail++;
      } catch { fail++; }
    };
    // 依赖链占一个 worker，其余独立节点共用同一并发上限，不重试付费请求。
    const jobs = [
      ...(orderedConnected.length ? [async () => { for (const node of orderedConnected) await runNode(node); }] : []),
      ...isolatedNodes.map((node) => () => runNode(node)),
    ];
    await runBatchTasks(jobs.length, 3, (index) => jobs[index]());
    return { ok, fail, skipped };
  } catch {
    return { ok, fail: toRun.length - ok - skipped, skipped };
  } finally { if (guard) completeCanvasDerivation(guard); }
}
