/** RH 定向输入：工作流字段身份复用 nodeId::fieldName，值在提交前才解析。 */
import type { WorkflowDefinition, WorkflowIONodeType } from '../../../types';
import { isLocalMediaUrl, isRemoteMediaUrl } from '../../../utils/mediaUrl';
import { runningHubInputNodes } from '../../runninghubWorkflowService';

export interface RunningHubInputRouting {
  bindings: Map<string, { value: string; mediaSource?: string }>;
  mentionedTypes: Set<WorkflowIONodeType>;
  nodeMode: boolean;
  defaults: WorkflowDefinition['defaultNodes'];
}

/** 括号可嵌套，避免文本或 URL 中的括号截断芯片赋值。 */
export function splitRunningHubPrompt(raw: string) {
  const assignments: Array<{ key: string; type: string; value: string }> = [];
  const head = /@wf\{([^|}]+)\|([^|}]+)\|([^|}]+)\}\(/g;
  const parts: string[] = [];
  let position = 0;
  for (let match = head.exec(raw); match; match = head.exec(raw)) {
    let depth = 1;
    let end = head.lastIndex;
    for (; end < raw.length && depth; end++) {
      if (raw[end] === '(') depth++;
      else if (raw[end] === ')') depth--;
    }
    if (depth) throw new Error('工作流输入括号未闭合，请检查 @ 输入');
    parts.push(raw.slice(position, match.index));
    assignments.push({ key: match[1], type: match[3], value: raw.slice(head.lastIndex, end - 1).replace(/\n$/, '') });
    position = end;
    head.lastIndex = end;
  }
  parts.push(raw.slice(position));
  const prompt = parts.join('').trim();
  if (prompt.includes('@wf{')) throw new Error('工作流输入格式无效，请重新选择 @ 输入节点');
  return { prompt, assignments };
}

export async function resolveRunningHubInputRouting(workflow: WorkflowDefinition, rawPrompt: string, inputs: Record<string, string> = {}, signal?: AbortSignal): Promise<RunningHubInputRouting> {
  const nodes = runningHubInputNodes(workflow.runninghub!);
  const { assignments } = splitRunningHubPrompt(rawPrompt);
  const values = new Map(nodes.filter((node) => inputs[node.nodeId] !== undefined).map((node) => [node.nodeId, inputs[node.nodeId]]));
  const chips = new Set<string>();
  for (const assignment of assignments) {
    const node = nodes.find((item) => item.nodeId === assignment.key);
    if (!node || node.type !== assignment.type) throw new Error('工作流输入映射已失效，请重新选择 @ 输入节点');
    if (chips.has(assignment.key)) throw new Error('同一工作流输入重复指定，请合并到一个 @ 输入中');
    chips.add(assignment.key);
    values.set(assignment.key, assignment.value);
  }
  const bindings: RunningHubInputRouting['bindings'] = new Map();
  const mentionedTypes = new Set<WorkflowIONodeType>();
  for (const [key, raw] of values) {
    signal?.throwIfAborted();
    if (raw.includes('@wf{')) throw new Error('工作流输入不能嵌套工作流输入，请直接填写文字或引用素材');
    const node = nodes.find((item) => item.nodeId === key)!;
    const { resolvePromptWithMediaRefs } = await import('../promptResolver');
    const resolved = await resolvePromptWithMediaRefs(raw);
    signal?.throwIfAborted();
    if (resolved.prompt.includes('@wf{')) throw new Error('引用内容包含工作流输入标记，请检查引用的文本');
    mentionedTypes.add(node.type);
    if (node.type === 'prompt') {
      if (resolved.references.length) throw new Error(`文本输入 ${node.title} 请填写文字或引用文本节点`);
      bindings.set(key, { value: resolved.prompt });
    } else {
      const urls = [...new Set(resolved.references.filter((reference) => reference.kind === node.type).map((reference) => reference.url))];
      if (!urls.length && (isLocalMediaUrl(raw.trim()) || isRemoteMediaUrl(raw.trim()))) urls.push(raw.trim());
      if (resolved.references.some((reference) => reference.kind !== node.type) || urls.length > 1 || (!urls.length && raw.trim())) {
        throw new Error(`输入 ${node.title} 需要一份对应类型的素材`);
      }
      bindings.set(key, { value: '', mediaSource: urls[0] });
    }
  }
  return { bindings, mentionedTypes, nodeMode: workflow.runninghub?.inputBindingMode === 'nodes', defaults: workflow.defaultNodes };
}
