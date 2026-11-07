/** 大工具结果的有界缓存与显式项目派生产物；网页/文件正文从不落盘。 */
import { useAppStore } from '../../store/useAppStore';
import type { AgentResultPage, AgentResultPolicy, AgentResultReference, AgentResultScope } from '../../types/agentResult';
import { readVerifiedProjectFile, sha256Hex, writeImmutableProjectFile } from '../fs/projectFiles';
import { sanitizeDomainText } from './subAgentMaterials';
import { isGeneralAssistantScope } from './assistantScope';
import { isMcpGlobalContext } from '../mcp/mcpSettingsScope';
import { isWorkbenchAgentTaskInScope, isWorkbenchTeamTaskInScope } from '../episodeWorkspaceScope';
import { assertAgentProjectContext } from './agentProjectContext';

export const AGENT_RESULT_PREVIEW_CHARS = 6000;
export const AGENT_RESULT_PAGE_CHARS = 12000;
export const AGENT_RESULT_TTL_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 1_000_000;
const MAX_TOTAL_CHARS = 4_000_000;
const MAX_RESULTS = 24;
const MAX_READ_CHARS_PER_TASK = 200_000;
const MAX_PROJECT_RESULT_BYTES = 2 * 1024 * 1024;
const RESULT_PATH = /^agent-results\/[A-Za-z0-9_-]{1,160}\/result-[a-f0-9-]{36}-[a-f0-9]{64}\.json$/;
interface Entry {
  scope: AgentResultScope; reference: AgentResultReference; text: string; authorize?: () => boolean;
}
const entries = new Map<string, Entry>();
const readBudgets = new Map<string, number>();

function assertScope(scope: AgentResultScope): void {
  const state = useAppStore.getState();
  const task = state.agentTasks.find((item) => item.id === scope.taskId);
  if (!task || task.projectId !== scope.projectId || task.conversationId !== scope.conversationId
    || (task.workbenchTarget && !isWorkbenchAgentTaskInScope(state, task))
    || (state.currentProjectId !== scope.projectId && !isGeneralAssistantScope(scope.projectId)
      && !isMcpGlobalContext(task) && !isWorkbenchTeamTaskInScope(state, task)
      && !isWorkbenchAgentTaskInScope(state, task))) {
    throw new Error('结果不属于当前项目、对话或任务');
  }
  assertAgentProjectContext(state, task, { checkRevision: false });
}

function sameScope(left: AgentResultScope, right: AgentResultScope): boolean {
  return left.taskId === right.taskId && left.projectId === right.projectId && left.conversationId === right.conversationId;
}

function trimEntries(incomingChars: number): void {
  const now = Date.now();
  for (const [id, entry] of entries) if ((entry.reference.expiresAt ?? Infinity) <= now) entries.delete(id);
  let total = [...entries.values()].reduce((sum, item) => sum + item.text.length, 0);
  for (const [id, entry] of entries) {
    if (entries.size < MAX_RESULTS && total + incomingChars <= MAX_TOTAL_CHARS) break;
    total -= entry.text.length; entries.delete(id);
  }
}

function boundedPreview(text: string): string {
  if (text.length <= AGENT_RESULT_PREVIEW_CHARS) return text;
  return `${text.slice(0, 4500)}\n…（中间内容已省略，按 resultId 分段读取）…\n${text.slice(-1200)}`;
}

export async function captureAgentResult(input: {
  scope: AgentResultScope; toolId: string; text: string; policy?: AgentResultPolicy;
}): Promise<{ modelContent: string; reference?: AgentResultReference; truncated: boolean }> {
  const text = sanitizeDomainText(input.text);
  if (text.length <= AGENT_RESULT_PREVIEW_CHARS) return { modelContent: text, truncated: false };
  assertScope(input.scope);
  const preview = boundedPreview(text);
  const continuation = input.policy?.continuation ? `\n原工具续读：${sanitizeDomainText(input.policy.continuation).slice(0, 800)}` : '';
  if (text.length > MAX_RESULT_CHARS) return { modelContent: `${preview}\n结果超过缓存上限，请使用原工具缩小范围。${continuation}`, truncated: true };
  if (input.policy?.authorize?.() === false) return { modelContent: `${preview}\n原始授权已撤销，未保存可回读引用。`, truncated: true };
  const id = `result-${crypto.randomUUID()}`;
  const createdAt = Date.now();
  let reference: AgentResultReference = { id, storage: 'memory', chars: text.length, createdAt,
    expiresAt: createdAt + AGENT_RESULT_TTL_MS };
  if (input.policy?.storage === 'project') {
    if (input.policy.source !== 'project-derived' || isGeneralAssistantScope(input.scope.projectId)
      || !/^[A-Za-z0-9_-]{1,160}$/.test(input.scope.taskId)) {
      throw new Error('只有显式声明的项目派生产物允许持久化');
    }
    const data = new TextEncoder().encode(JSON.stringify({ version: 1, ...input.scope, id, toolId: input.toolId, text }));
    if (data.byteLength > MAX_PROJECT_RESULT_BYTES) return { modelContent: `${preview}\n结果超过项目保存上限，请缩小原查询。`, truncated: true };
    const hash = await sha256Hex(data);
    const projectFile = { relativePath: `agent-results/${input.scope.taskId}/${id}-${hash}.json`, sha256: hash, bytes: data.byteLength };
    try {
      const assertCurrent = () => { assertScope(input.scope); if (input.policy?.authorize?.() === false) throw new Error('原始授权已撤销'); };
      assertCurrent();
      await writeImmutableProjectFile({ projectId: input.scope.projectId, reference: projectFile, data, maxBytes: MAX_PROJECT_RESULT_BYTES, assertCurrent });
      assertCurrent();
      assertScope(input.scope);
      reference = { id, storage: 'project', chars: text.length, createdAt, projectFile };
    } catch {
      return { modelContent: `${preview}\n结果保存失败，未提供可恢复引用；请检查项目存储后缩小范围读取，不会重复执行原操作。`, truncated: true };
    }
  }
  trimEntries(text.length);
  entries.set(id, { scope: { ...input.scope }, reference, text, authorize: input.policy?.authorize });
  return { modelContent: `${preview}\nresultId=${id}，共 ${text.length} 字；调用 agent_result_read 分段读取。${continuation}`,
    reference, truncated: true };
}

export async function readAgentResult(
  scope: AgentResultScope, resultId: string, offset = 0, limit = AGENT_RESULT_PAGE_CHARS,
): Promise<AgentResultPage> {
  assertScope(scope);
  if (!/^result-[a-f0-9-]{36}$/.test(resultId) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_RESULT_PAGE_CHARS) throw new Error('结果分段读取参数无效');
  const used = readBudgets.get(scope.taskId) ?? 0;
  if (used >= MAX_READ_CHARS_PER_TASK) throw new Error('结果回读达到任务预算，请缩小读取范围');
  let entry = entries.get(resultId);
  if (entry && !sameScope(entry.scope, scope)) throw new Error('结果不属于本任务');
  if (entry?.authorize?.() === false) { entries.delete(resultId); throw new Error('原始授权已撤销，结果已失效'); }
  if (entry?.reference.expiresAt && entry.reference.expiresAt <= Date.now()) { entries.delete(resultId); entry = undefined; }
  if (!entry) {
    const task = useAppStore.getState().agentTasks.find((item) => item.id === scope.taskId)!;
    const reference = task.steps.flatMap((step) => step.toolCall?.resultReference ?? []).find((item) => item.id === resultId);
    const file = reference?.storage === 'project' ? reference.projectFile : undefined;
    if (!reference || !file || !RESULT_PATH.test(file.relativePath) || !file.relativePath.startsWith(`agent-results/${scope.taskId}/`)
      || !file.relativePath.endsWith(`/${resultId}-${file.sha256}.json`)) throw new Error('结果已过期或不可恢复，请用原工具重新读取或重新授权');
    const data = await readVerifiedProjectFile({ projectId: scope.projectId, reference: file, maxBytes: MAX_PROJECT_RESULT_BYTES });
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as Record<string, unknown>;
    if (document.version !== 1 || document.id !== resultId || typeof document.text !== 'string'
      || document.text.length !== reference.chars || document.text.length > MAX_RESULT_CHARS
      || document.taskId !== scope.taskId || document.projectId !== scope.projectId || document.conversationId !== scope.conversationId) {
      throw new Error('结果内容与引用不一致');
    }
    assertScope(scope); trimEntries(document.text.length);
    entry = { scope: { ...scope }, reference, text: document.text }; entries.set(resultId, entry);
  }
  const text = entry.text.slice(offset, offset + Math.min(limit, MAX_READ_CHARS_PER_TASK - used));
  readBudgets.set(scope.taskId, used + text.length);
  return { resultId, text, offset, nextOffset: offset + text.length, totalChars: entry.text.length,
    eof: offset + text.length >= entry.text.length };
}

export function clearAgentResults(scope: Partial<AgentResultScope>): void {
  for (const [id, entry] of entries) if (Object.entries(scope).every(([key, value]) => entry.scope[key as keyof AgentResultScope] === value)) entries.delete(id);
  if (scope.taskId) readBudgets.delete(scope.taskId);
  else if (scope.projectId || scope.conversationId) {
    for (const task of useAppStore.getState().agentTasks) {
      if ((!scope.projectId || task.projectId === scope.projectId) && (!scope.conversationId || task.conversationId === scope.conversationId)) readBudgets.delete(task.id);
    }
  }
}
