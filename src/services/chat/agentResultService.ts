/** 大工具结果的有界缓存与显式项目派生产物；网页/文件正文从不落盘。 */
import { useAppStore } from '../../store/useAppStore';
import type { AgentResultPage, AgentResultPolicy, AgentResultReference, AgentResultScope } from '../../types/agentResult';
import { readVerifiedProjectFile, sha256Hex, writeImmutableProjectFile } from '../fs/projectFiles';
import { sanitizeDomainText } from './subAgentMaterials';
import { isGeneralAssistantScope } from './assistantScope';
import { isMcpGlobalContext } from '../mcp/mcpSettingsScope';
import { isWorkbenchAgentTaskInScope, isWorkbenchTeamTaskInScope } from '../episodeWorkspaceScope';
import { assertAgentProjectContext, captureAgentProjectScope } from './agentProjectContext';
import { ProjectExecutionContextError } from '../projectExecutionContext';
import { getAgentTool, prepareAgentToolCall, type AgentToolContext } from './toolRegistry';
import { evaluateAgentToolPolicy } from './policyEngine';
import { configValuesEqual } from '../configPatch';
import { nativeAgentResumeContext } from './agentResumeContext';

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
  /** 文件中有摘要保护的来源工具 ID；只在宿主内存中使用。 */
  originToolId?: string;
  /** 旧引用的原始范围来自已验证文件，不能回写或替换旧任务引用。 */
  binding?: Pick<AgentResultReference, 'executionContext' | 'projectScope'>;
}
class AgentResultScopeError extends Error {}
const entries = new Map<string, Entry>();
const readBudgets = new Map<string, number>();
const activeGenerations = new Map<string, { scope: AgentResultScope; generation: number; active: number }>();

/** 清理撤销进行中的读写；同任务以后重新开始的操作使用新代次。 */
function beginResultLease(scope: AgentResultScope) {
  const key = JSON.stringify([scope.taskId, scope.projectId, scope.conversationId]);
  let state = activeGenerations.get(key);
  if (!state) {
    state = { scope: { taskId: scope.taskId, projectId: scope.projectId, conversationId: scope.conversationId }, generation: 0, active: 0 };
    activeGenerations.set(key, state);
  }
  const record = state, generation = record.generation;
  record.active++;
  return {
    assert() {
      if (record.generation !== generation) throw new DOMException('结果已撤销，不能交付旧内容', 'AbortError');
    },
    release() {
      record.active--;
      if (record.active === 0 && activeGenerations.get(key) === record) activeGenerations.delete(key);
    },
  };
}

function scopeTask(scope: AgentResultScope) {
  const state = useAppStore.getState();
  const task = state.agentTasks.find((item) => item.id === scope.taskId);
  if (!task || task.projectId !== scope.projectId || task.conversationId !== scope.conversationId
    || (task.workbenchTarget && !isWorkbenchAgentTaskInScope(state, task))
    || (state.currentProjectId !== scope.projectId && !isGeneralAssistantScope(scope.projectId)
      && !isMcpGlobalContext(task) && !isWorkbenchTeamTaskInScope(state, task)
      && !isWorkbenchAgentTaskInScope(state, task))) {
    throw new AgentResultScopeError('结果不属于当前项目、对话或任务');
  }
  return task;
}

function assertScope(scope: AgentResultScope, binding?: Pick<AgentResultReference, 'executionContext' | 'projectScope'>): void {
  const task = scopeTask(scope);
  const state = useAppStore.getState();
  if (task.executionContext || task.projectScope || !binding?.executionContext && !binding?.projectScope) {
    assertAgentProjectContext(state, task, { checkRevision: false });
  }
  if (binding?.executionContext || binding?.projectScope) {
    // 原文件/引用仍保留旧租约；仅已显式继续的同任务可按持久身份验证后读取历史结果。
    const historicalNative = (binding.executionContext ?? binding.projectScope)?.modelGeneration === 1;
    const effective = historicalNative && (task.resumeCount ?? 0) > 0
      ? { ...binding, ...nativeAgentResumeContext(state, { ...task, executionContext: binding.executionContext, projectScope: binding.projectScope }) }
      : binding;
    assertAgentProjectContext(state, { projectId: task.projectId, ...effective }, { checkRevision: false });
  }
}

function taskContextSignature(task: ReturnType<typeof scopeTask>): unknown {
  return structuredClone([task.executionContext ?? null, task.projectScope ?? null, task.workbenchTarget ?? null]);
}

function sameScope(left: AgentResultScope, right: AgentResultScope): boolean {
  return left.taskId === right.taskId && left.projectId === right.projectId && left.conversationId === right.conversationId;
}

/** 旧文件只保存工具 ID 而未保存原始输入；当前仅空输入的剧集状态可安全重验。 */
function projectResultAuthorization(scope: AgentResultScope, reference: AgentResultReference, originToolId: string,
  binding: Pick<AgentResultReference, 'executionContext' | 'projectScope'> = reference): () => boolean {
  const original = getAgentTool(originToolId);
  const expectedReference = structuredClone(reference);
  return () => {
    try {
      const task = scopeTask(scope);
      const state = useAppStore.getState();
      const matches = task.steps.filter((step) => step.toolCall?.resultReference?.id === reference.id);
      const toolCall = matches[0]?.toolCall;
      if (matches.length !== 1 || matches[0].kind !== 'tool' || matches[0].status !== 'succeeded'
        || toolCall?.toolId !== originToolId || !configValuesEqual(toolCall.resultReference, expectedReference)
        || originToolId !== 'series_get_state' || !original || getAgentTool(originToolId) !== original
        || original.effect !== 'read' || original.resultPolicy?.storage !== 'project'
        || original.resultPolicy.source !== 'project-derived' || typeof original.authorize !== 'function' || original.resolveInput
        || original.inputSchema.type !== 'object' || original.inputSchema.additionalProperties !== false
        || Object.keys(original.inputSchema.properties ?? {}).length !== 0 || (original.inputSchema.required?.length ?? 0) !== 0
        || task.workbenchTarget && !isWorkbenchAgentTaskInScope(state, task, originToolId)) return false;
      assertScope(scope, binding);
      const mode = state.conversations?.find((item) => item.id === task.conversationId)?.agentMode ?? task.mode;
      if (mode !== 'plan' && mode !== 'collaborative' && mode !== 'autonomous') return false;
      const context: Omit<AgentToolContext, 'signal'> = {
        taskId: task.id, projectId: task.projectId, conversationId: task.conversationId, mode,
        toolAllowlist: task.toolAllowlist,
        executionContext: task.executionContext ?? binding.executionContext,
        projectScope: task.projectScope ?? binding.projectScope,
      };
      const call = { callId: toolCall.callId, toolId: originToolId, input: {} };
      const prepared = prepareAgentToolCall(call, context);
      return prepared.ok && prepared.prepared.definition === original
        && evaluateAgentToolPolicy(original, prepared.prepared.input, context).outcome === 'allow';
    } catch { return false; }
  };
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
  /** 仅宿主确认的导航/结构工具可在有意改变目标后返回有界结果。 */
  navigationContextChange?: boolean;
}): Promise<{ modelContent: string; reference?: AgentResultReference; truncated: boolean }> {
  const lease = beginResultLease(input.scope);
  try {
  const text = sanitizeDomainText(input.text);
  if (input.navigationContextChange) {
    if (!/^(?:project_(?:create|open|switch|delete|rename)|episode_(?:move|delete)|series_split_episodes)$/.test(input.toolId)) {
      throw new Error('该工具不能绕过原项目上下文');
    }
    lease.assert();
    return { modelContent: boundedPreview(text), truncated: text.length > AGENT_RESULT_PREVIEW_CHARS };
  }
  const task = scopeTask(input.scope);
  const supplied = input.scope as AgentResultScope & Pick<AgentResultReference, 'executionContext' | 'projectScope'>;
  const executionContext = supplied.executionContext ?? task.executionContext;
  const projectScope = supplied.projectScope ?? task.projectScope ?? (executionContext ? undefined : captureAgentProjectScope(useAppStore.getState(), task));
  const binding = structuredClone({ ...(executionContext ? { executionContext } : {}), ...(projectScope ? { projectScope } : {}) });
  const taskContext = taskContextSignature(task);
  const assertCapturedScope = () => {
    lease.assert();
    assertScope(input.scope, binding);
    if (!configValuesEqual(taskContextSignature(scopeTask(input.scope)), taskContext)) throw new ProjectExecutionContextError();
  };
  assertCapturedScope();
  if (input.policy?.authorize?.() === false) throw new DOMException('原始授权已撤销', 'AbortError');
  if (text.length <= AGENT_RESULT_PREVIEW_CHARS) return { modelContent: text, truncated: false };
  const preview = boundedPreview(text);
  const continuation = input.policy?.continuation ? `\n原工具续读：${sanitizeDomainText(input.policy.continuation).slice(0, 800)}` : '';
  if (text.length > MAX_RESULT_CHARS) return { modelContent: `${preview}\n结果超过缓存上限，请使用原工具缩小范围。${continuation}`, truncated: true };
  const id = `result-${crypto.randomUUID()}`;
  const createdAt = Date.now();
  let reference: AgentResultReference = { id, storage: 'memory', chars: text.length, createdAt, ...binding,
    expiresAt: createdAt + AGENT_RESULT_TTL_MS };
  if (input.policy?.storage === 'project') {
    if (input.policy.source !== 'project-derived' || isGeneralAssistantScope(input.scope.projectId)
      || !/^[A-Za-z0-9_-]{1,160}$/.test(input.scope.taskId)) {
      throw new Error('只有显式声明的项目派生产物允许持久化');
    }
    const data = new TextEncoder().encode(JSON.stringify({ version: 1, taskId: input.scope.taskId, projectId: input.scope.projectId,
      conversationId: input.scope.conversationId, id, toolId: input.toolId, text, resultContext: binding }));
    if (data.byteLength > MAX_PROJECT_RESULT_BYTES) return { modelContent: `${preview}\n结果超过项目保存上限，请缩小原查询。`, truncated: true };
    const hash = await sha256Hex(data);
    lease.assert();
    const projectFile = { relativePath: `agent-results/${input.scope.taskId}/${id}-${hash}.json`, sha256: hash, bytes: data.byteLength };
    const assertCurrent = () => { assertCapturedScope(); if (input.policy?.authorize?.() === false) throw new DOMException('原始授权已撤销', 'AbortError'); };
    try {
      assertCurrent();
      await writeImmutableProjectFile({ projectId: input.scope.projectId, reference: projectFile, data, maxBytes: MAX_PROJECT_RESULT_BYTES, assertCurrent });
      assertCurrent();
      assertCapturedScope();
      reference = { id, storage: 'project', chars: text.length, createdAt, projectFile, ...binding };
    } catch (error) {
      if (error instanceof ProjectExecutionContextError || error instanceof AgentResultScopeError
        || error instanceof DOMException && error.name === 'AbortError') throw error;
      assertCurrent();
      return { modelContent: `${preview}\n结果保存失败，未提供可恢复引用；请检查项目存储后缩小范围读取，不会重复执行原操作。`, truncated: true };
    }
  }
  lease.assert();
  trimEntries(text.length);
  entries.set(id, { scope: { ...input.scope }, reference: structuredClone(reference), text,
    authorize: input.policy?.authorize, ...(reference.storage === 'project' ? { originToolId: input.toolId } : {}) });
  return { modelContent: `${preview}\nresultId=${id}，共 ${text.length} 字；调用 agent_result_read 分段读取。${continuation}`,
    reference, truncated: true };
  } finally { lease.release(); }
}

export async function readAgentResult(
  scope: AgentResultScope, resultId: string, offset = 0, limit = AGENT_RESULT_PAGE_CHARS,
  onAuthorize?: (authorize: () => boolean) => void,
): Promise<AgentResultPage> {
  const lease = beginResultLease(scope);
  try {
  scopeTask(scope);
  if (!/^result-[a-f0-9-]{36}$/.test(resultId) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_RESULT_PAGE_CHARS) throw new Error('结果分段读取参数无效');
  if ((readBudgets.get(scope.taskId) ?? 0) >= MAX_READ_CHARS_PER_TASK) throw new Error('结果回读达到任务预算，请缩小读取范围');
  let entry = entries.get(resultId);
  if (entry && !sameScope(entry.scope, scope)) throw new Error('结果不属于本任务');
  let originAuthorization: (() => boolean) | undefined;
  if (entry) {
    assertScope(scope, entry.binding ?? entry.reference);
    if (entry.reference.storage === 'project') {
      originAuthorization = projectResultAuthorization(scope, entry.reference, entry.originToolId ?? '', entry.binding ?? entry.reference);
      if (!originAuthorization()) throw new Error('原始工具授权或上下文已变化，无法验证');
    }
  }
  if (entry?.authorize?.() === false) { entries.delete(resultId); throw new Error('原始授权已撤销，结果已失效'); }
  if (entry?.reference.expiresAt && entry.reference.expiresAt <= Date.now()) { entries.delete(resultId); entry = undefined; }
  if (!entry) {
    const task = scopeTask(scope);
    const taskContext = taskContextSignature(task);
    const matches = task.steps.filter((step) => step.toolCall?.resultReference?.id === resultId);
    const reference = matches.length === 1 ? matches[0].toolCall?.resultReference : undefined;
    const originToolId = matches.length === 1 ? matches[0].toolCall?.toolId : undefined;
    const file = reference?.storage === 'project' ? reference.projectFile : undefined;
    if (!reference || !file || !RESULT_PATH.test(file.relativePath) || !file.relativePath.startsWith(`agent-results/${scope.taskId}/`)
      || !file.relativePath.endsWith(`/${resultId}-${file.sha256}.json`)) throw new Error('结果已过期或不可恢复，请用原工具重新读取或重新授权');
    originAuthorization = projectResultAuthorization(scope, reference, originToolId ?? '');
    if (!originAuthorization()) throw new Error('原始工具授权或上下文已变化，无法验证');
    const referenceBinding = { ...(reference.executionContext ? { executionContext: reference.executionContext } : {}),
      ...(reference.projectScope ? { projectScope: reference.projectScope } : {}) };
    const hasReferenceBinding = !!(reference.executionContext || reference.projectScope);
    if (hasReferenceBinding) assertScope(scope, referenceBinding);
    else if (task.executionContext || task.projectScope) assertScope(scope);
    else if (useAppStore.getState().projects !== undefined) throw new ProjectExecutionContextError();
    const data = await readVerifiedProjectFile({ projectId: scope.projectId, reference: file, maxBytes: MAX_PROJECT_RESULT_BYTES });
    lease.assert();
    if (!configValuesEqual(taskContextSignature(scopeTask(scope)), taskContext)) throw new ProjectExecutionContextError();
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as Record<string, unknown>;
    if (document.version !== 1 || document.id !== resultId || document.toolId !== originToolId || typeof document.text !== 'string'
      || document.text.length !== reference.chars || document.text.length > MAX_RESULT_CHARS
      || document.taskId !== scope.taskId || document.projectId !== scope.projectId || document.conversationId !== scope.conversationId) {
      throw new Error('结果内容与引用不一致');
    }
    const savedContext = document.resultContext && typeof document.resultContext === 'object'
      ? document.resultContext as Pick<AgentResultReference, 'executionContext' | 'projectScope'>
      : { ...(document.executionContext ? { executionContext: document.executionContext as AgentResultReference['executionContext'] } : {}),
        ...(document.projectScope ? { projectScope: document.projectScope as AgentResultReference['projectScope'] } : {}) };
    if (!savedContext.executionContext && !savedContext.projectScope && useAppStore.getState().projects !== undefined) {
      throw new ProjectExecutionContextError();
    }
    if (hasReferenceBinding && !configValuesEqual(savedContext, referenceBinding)) {
      throw new Error('结果上下文与原始记录不一致');
    }
    if (!hasReferenceBinding && (task.executionContext && !configValuesEqual(savedContext.executionContext, task.executionContext)
      || task.projectScope && !configValuesEqual(savedContext.projectScope, task.projectScope))) {
      throw new Error('结果上下文与原始记录不一致');
    }
    assertScope(scope, savedContext); lease.assert();
    if (!originAuthorization()) throw new Error('原始工具授权或上下文已变化，无法验证');
    const cached = entries.get(resultId);
    const cachedBinding = cached?.binding ?? (cached ? {
      ...(cached.reference.executionContext ? { executionContext: cached.reference.executionContext } : {}),
      ...(cached.reference.projectScope ? { projectScope: cached.reference.projectScope } : {}),
    } : undefined);
    if (cached && (!sameScope(cached.scope, scope) || !configValuesEqual(cached.reference, reference)
      || !configValuesEqual(cachedBinding, savedContext) || cached.text !== document.text || cached.originToolId !== originToolId)) {
      throw new Error('结果缓存与原始记录不一致');
    }
    if (cached) entry = cached;
    else {
      trimEntries(document.text.length);
      entry = { scope: { ...scope }, reference: structuredClone(reference), binding: structuredClone(savedContext), text: document.text, originToolId };
      entries.set(resultId, entry);
    }
  }
  // 文件读取可能并发；预算检查与计数必须在最后一次 await 后连续完成。
  lease.assert();
  const used = readBudgets.get(scope.taskId) ?? 0;
  if (used >= MAX_READ_CHARS_PER_TASK) throw new Error('结果回读达到任务预算，请缩小读取范围');
  const text = entry.text.slice(offset, offset + Math.min(limit, MAX_READ_CHARS_PER_TASK - used));
  readBudgets.set(scope.taskId, used + text.length);
  const selectedEntry = entry;
  const deliveryScope = { taskId: scope.taskId, projectId: scope.projectId, conversationId: scope.conversationId };
  onAuthorize?.(() => {
    try {
      if (entries.get(resultId) !== selectedEntry || !sameScope(selectedEntry.scope, deliveryScope)) return false;
      assertScope(deliveryScope, selectedEntry.binding ?? selectedEntry.reference);
      return selectedEntry.authorize?.() !== false && originAuthorization?.() !== false
        && (!selectedEntry.reference.expiresAt || selectedEntry.reference.expiresAt > Date.now());
    } catch { return false; }
  });
  return { resultId, text, offset, nextOffset: offset + text.length, totalChars: entry.text.length,
    eof: offset + text.length >= entry.text.length };
  } finally { lease.release(); }
}

export function clearAgentResults(scope: Partial<AgentResultScope>): void {
  for (const state of activeGenerations.values()) {
    if (Object.entries(scope).every(([key, value]) => state.scope[key as keyof AgentResultScope] === value)) {
      state.generation++;
      readBudgets.delete(state.scope.taskId);
    }
  }
  for (const [id, entry] of entries) if (Object.entries(scope).every(([key, value]) => entry.scope[key as keyof AgentResultScope] === value)) entries.delete(id);
  if (scope.taskId) readBudgets.delete(scope.taskId);
  else if (scope.projectId || scope.conversationId) {
    for (const task of useAppStore.getState().agentTasks) {
      if ((!scope.projectId || task.projectId === scope.projectId) && (!scope.conversationId || task.conversationId === scope.conversationId)) readBudgets.delete(task.id);
    }
  }
  else readBudgets.clear();
}
