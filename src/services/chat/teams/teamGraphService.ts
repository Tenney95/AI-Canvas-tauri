/** 有界的声明式团队任务图；不执行脚本，也不授予宿主工具。 */
import type {
  AgentTeamProfile, AgentTeamRun, TeamExecutionTarget, TeamGraphDefinition, TeamGraphNode, TeamRoleId, TeamTemplateId,
} from '../../../types/agentTeam';

export const ROLE_KINDS: Record<TeamRoleId, readonly TeamGraphNode['kind'][]> = {
  architect: ['outline', 'revision'], writer: ['draft', 'revision'],
  continuity: ['review'], dialogue: ['review'], editor: ['decision'],
};
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function teamGraphAncestors(graph: TeamGraphDefinition, id: string): Set<string> {
  const result = new Set<string>();
  const visit = (current: string) => {
    for (const parent of graph.nodes.find((node) => node.id === current)?.dependsOn ?? []) {
      if (result.has(parent)) continue;
      result.add(parent); visit(parent);
    }
  };
  visit(id);
  return result;
}

export function validateTeamGraph(value: unknown): TeamGraphDefinition {
  const fail = (message: string): never => { throw new Error(message); };
  if (!object(value) || value.version !== 1 || Object.keys(value).some((key) => !['version', 'nodes', 'finalTaskId'].includes(key))
    || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 12
    || typeof value.finalTaskId !== 'string' || !ID.test(value.finalTaskId)) return fail('团队任务图格式或节点数量无效');
  const ids = new Set<string>();
  const nodes = value.nodes.map((raw): TeamGraphNode => {
    if (!object(raw) || Object.keys(raw).some((key) => !['id', 'roleId', 'title', 'kind', 'dependsOn', 'sourceTaskId', 'modelId'].includes(key))
      || typeof raw.id !== 'string' || !ID.test(raw.id) || ids.has(raw.id)
      || typeof raw.roleId !== 'string' || !Object.hasOwn(ROLE_KINDS, raw.roleId)
      || typeof raw.kind !== 'string' || !ROLE_KINDS[raw.roleId as TeamRoleId].includes(raw.kind as TeamGraphNode['kind'])
      || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 180
      || !Array.isArray(raw.dependsOn) || raw.dependsOn.length > 12
      || raw.dependsOn.some((id) => typeof id !== 'string' || !ID.test(id))
      || new Set(raw.dependsOn).size !== raw.dependsOn.length
      || (raw.sourceTaskId !== undefined && (typeof raw.sourceTaskId !== 'string' || !ID.test(raw.sourceTaskId)))
      || (raw.modelId !== undefined && (typeof raw.modelId !== 'string' || !raw.modelId.trim() || raw.modelId.length > 200))) {
      return fail('团队任务节点、角色或依赖格式无效');
    }
    ids.add(raw.id);
    return { id: raw.id, roleId: raw.roleId as TeamRoleId, kind: raw.kind as TeamGraphNode['kind'],
      title: raw.title.trim(), dependsOn: [...raw.dependsOn] as string[],
      ...(raw.sourceTaskId ? { sourceTaskId: raw.sourceTaskId as string } : {}),
      ...(raw.modelId ? { modelId: (raw.modelId as string).trim() } : {}) };
  });
  const graph: TeamGraphDefinition = { version: 1, nodes, finalTaskId: value.finalTaskId };
  if (!ids.has(graph.finalTaskId) || nodes.some((node) => node.dependsOn.some((id) => !ids.has(id) || id === node.id))) return fail('团队任务依赖引用不存在');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) return fail('团队任务图不能包含循环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of nodes.find((node) => node.id === id)!.dependsOn) visit(parent);
    visiting.delete(id); visited.add(id);
  };
  for (const node of nodes) visit(node.id);
  for (const node of nodes) {
    if (!node.sourceTaskId && node.dependsOn.length && ['review', 'decision', 'revision'].includes(node.kind)
      && nodes.some((entry) => teamGraphAncestors(graph, node.id).has(entry.id) && ['outline', 'draft', 'revision'].includes(entry.kind))) {
      return fail('审阅、裁决和修订必须显式指定上游正文来源');
    }
    if (node.sourceTaskId) {
      const source = nodes.find((entry) => entry.id === node.sourceTaskId);
      if (!source || !teamGraphAncestors(graph, node.id).has(source.id) || !['outline', 'draft', 'revision'].includes(source.kind)) return fail('正文来源必须是已声明的上游正文任务');
    }
    if (node.kind === 'decision') {
      const reviews = nodes.filter((entry) => node.dependsOn.includes(entry.id) && entry.kind === 'review');
      if (!reviews.length || reviews.some((review) => review.sourceTaskId !== node.sourceTaskId)) return fail('主编必须依赖同一正文来源的审阅任务');
    }
    if (node.kind === 'revision') {
      const decisions = nodes.filter((entry) => node.dependsOn.includes(entry.id) && entry.kind === 'decision');
      if (decisions.length !== 1 || decisions[0].sourceTaskId !== node.sourceTaskId) return fail('修订任务必须依赖同稿的唯一主编裁决');
    }
  }
  const ancestors = teamGraphAncestors(graph, graph.finalTaskId);
  if (nodes.some((node) => node.id !== graph.finalTaskId && !ancestors.has(node.id))
    || nodes.find((node) => node.id === graph.finalTaskId)?.kind === 'review') return fail('所有任务必须参与最终交付，审阅不能直接作为最终稿');
  return graph;
}

export function createTemplateTeamGraph(template: TeamTemplateId): TeamGraphDefinition {
  const nodes: TeamGraphNode[] = [];
  if (template === 'outline' || template === 'general') nodes.push({ id: 'structure', roleId: 'architect', title: '梳理结构与约束', kind: 'outline', dependsOn: [] });
  if (template === 'script' || template === 'general') nodes.push({ id: 'draft', roleId: 'writer', title: '主笔起草', kind: 'draft',
    dependsOn: template === 'general' ? ['structure'] : [], ...(template === 'general' ? { sourceTaskId: 'structure' } : {}) });
  const sourceTaskId = template === 'outline' ? 'structure' : template === 'review' ? undefined : 'draft';
  const source = sourceTaskId ? { sourceTaskId } : {};
  for (const roleId of ['continuity', 'dialogue'] as const) nodes.push({ id: roleId, roleId, title: roleId === 'continuity' ? '独立检查因果与连续性' : '独立检查表达与可拍性',
    kind: 'review', dependsOn: sourceTaskId ? [sourceTaskId] : [], ...source });
  nodes.push({ id: 'decision', roleId: 'editor', title: '主编逐条裁决', kind: 'decision', dependsOn: ['continuity', 'dialogue'], ...source });
  if (template !== 'review') nodes.push({ id: 'revision', roleId: template === 'outline' ? 'architect' : 'writer', title: '主笔统一修订', kind: 'revision', dependsOn: ['decision'], ...source });
  return validateTeamGraph({ version: 1, nodes, finalTaskId: template === 'review' ? 'decision' : 'revision' });
}

export function teamGraphInvalidation(graph: TeamGraphDefinition, changed: readonly string[]): Set<string> {
  const affected = new Set(changed);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of graph.nodes) {
      if (!affected.has(node.id) && node.dependsOn.some((id) => affected.has(id))) { affected.add(node.id); expanded = true; }
    }
  }
  return affected;
}

export function getReadyTeamGraphNodes(run: AgentTeamRun): TeamGraphNode[] {
  if (run.version !== 2 || !run.graph) return [];
  return run.graph.nodes.filter((node) => {
    const stage = run.stages.find((entry) => entry.id === node.id);
    return stage && (stage.status === 'pending' || stage.status === 'failed')
      && node.dependsOn.every((id) => run.stages.some((entry) => entry.id === id && entry.status === 'completed' && !!entry.artifactId));
  });
}

export function getTeamNodeTarget(profile: AgentTeamProfile, node: Pick<TeamGraphNode, 'roleId' | 'modelId'>): TeamExecutionTarget {
  const selected = profile.roleExecutors?.[node.roleId];
  if (selected?.kind === 'external-agent') {
    if (node.modelId && node.modelId !== selected.modelId) throw new Error('外部成员模型必须在角色执行器中显式配置');
    return { ...selected };
  }
  return { kind: 'text-model', modelId: node.modelId ?? selected?.modelId ?? profile.roles[node.roleId] };
}
