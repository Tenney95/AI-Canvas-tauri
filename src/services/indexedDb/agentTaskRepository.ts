import type { AgentTask, McpOperationBinding, McpOperationIdentity, McpOperationUpdate } from '../../types/agent';
import type { AgentTeamRun } from '../../types/agentTeam';
import { withRelocatedMedia } from './mediaRelocations';
import { openDB, STORE_AGENT_TASKS, STORE_METADATA } from './schema';

// ============================================
// Agent Tasks CRUD
// ============================================

export type AgentTaskRecord = AgentTask;

const MCP_OPERATION_DIGEST = /^[a-f0-9]{64}$/;

function sameMcpOperationIdentity(a: McpOperationIdentity, b: McpOperationIdentity): boolean {
  return a.bindingId === b.bindingId && a.projectId === b.projectId && a.keyDigest === b.keyDigest
    && a.inputDigest === b.inputDigest && a.toolId === b.toolId && a.effect === b.effect;
}

function checkedMcpBinding(value: unknown): McpOperationBinding {
  const binding = value as McpOperationBinding | null;
  if (!binding || binding.kind !== 'mcp-operation-binding' || binding.version !== 1
    || typeof binding.id !== 'string' || binding.id !== binding.bindingId
    || typeof binding.projectId !== 'string' || !binding.projectId || typeof binding.taskId !== 'string' || !binding.taskId
    || typeof binding.toolId !== 'string' || !binding.toolId
    || (binding.lastSequence !== undefined && (!Number.isSafeInteger(binding.lastSequence) || binding.lastSequence < 0))
    || !MCP_OPERATION_DIGEST.test(binding.keyDigest) || !MCP_OPERATION_DIGEST.test(binding.inputDigest)
    || !['canvas_write', 'media_generation'].includes(binding.effect)) {
    throw new Error('MCP 操作绑定损坏，停止提交并请只读核实');
  }
  return binding;
}

function mcpOperationTransaction(db: IDBDatabase): IDBTransaction {
  const stores = [STORE_AGENT_TASKS, STORE_METADATA];
  try { return db.transaction(stores, 'readwrite', { durability: 'strict' }); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'NotSupportedError')) throw error;
    return db.transaction(stores, 'readwrite');
  }
}

export interface McpOperationClaim {
  claimed: boolean;
  binding: McpOperationBinding;
  task: AgentTask | null;
}

/** 同一事务保留 key 墓碑和任务；事务确认完成前调用方不能启动副作用。 */
export async function claimMcpAgentTask(record: AgentTask): Promise<McpOperationClaim> {
  const operation = record.mcpOperation;
  if (!operation || operation.version !== 1 || operation.phase !== 'reserved' || operation.sequence !== 0
    || operation.projectId !== record.projectId || record.conversationId !== `mcp-control-${record.projectId}`) {
    throw new Error('MCP 操作占位无效');
  }
  const candidate = checkedMcpBinding({ id: operation.bindingId, bindingId: operation.bindingId,
    projectId: operation.projectId, keyDigest: operation.keyDigest, inputDigest: operation.inputDigest,
    toolId: operation.toolId, effect: operation.effect, version: 1,
    kind: 'mcp-operation-binding', taskId: record.id, createdAt: operation.createdAt });
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = mcpOperationTransaction(db);
    const metadata = tx.objectStore(STORE_METADATA);
    let failure: unknown;
    let result: McpOperationClaim | undefined;
    const fail = (error: unknown) => { failure = error; tx.abort(); };
    const deleted = metadata.get(`project-deleted:${record.projectId}`);
    deleted.onsuccess = () => {
      if (deleted.result) { fail(new Error('项目已删除，不能提交 MCP 操作')); return; }
      const bindingRequest = metadata.get(candidate.id);
      bindingRequest.onsuccess = () => {
        try {
          if (bindingRequest.result !== undefined) {
            const binding = checkedMcpBinding(bindingRequest.result);
            if (!sameMcpOperationIdentity(binding, candidate)) throw new Error('MCP_OPERATION_KEY_CONFLICT');
            const task = tx.objectStore(STORE_AGENT_TASKS).get(binding.taskId);
            task.onsuccess = () => {
              const existing = binding.taskDeletedAt ? null : (task.result as AgentTask | undefined) ?? null;
              if (existing && (existing.projectId !== binding.projectId
                || existing.conversationId !== `mcp-control-${binding.projectId}`
                || !existing.mcpOperation || !sameMcpOperationIdentity(existing.mcpOperation, binding))) {
                fail(new Error('MCP 操作任务身份不一致，请只读核实')); return;
              }
              result = { claimed: false, binding, task: existing };
            };
            return;
          }
          const binding: McpOperationBinding = { ...candidate, createdAt: operation.createdAt, lastSequence: 0 };
          metadata.add(binding);
          withRelocatedMedia(tx, record, (next) => tx.objectStore(STORE_AGENT_TASKS).add(next));
          result = { claimed: true, binding, task: record };
        } catch (error) { fail(error); }
      };
    };
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('MCP 操作占位没有返回结果'));
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('MCP 操作占位未持久化，未开始执行'));
  });
}

export async function getMcpOperationBinding(id: string): Promise<McpOperationBinding | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly').objectStore(STORE_METADATA).get(id);
    request.onsuccess = () => {
      try { resolve(request.result === undefined ? null : checkedMcpBinding(request.result)); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error);
  });
}

function mergeMcpOperationProgress(operation: NonNullable<AgentTask['mcpOperation']>, changes: McpOperationUpdate): McpOperationUpdate {
  const next = { ...changes };
  if (operation.phase === 'running' && next.phase === 'reserved') delete next.phase;
  const stages = ['preparing', 'started', 'generated', 'delivered'];
  if (operation.mediaStage && next.mediaStage && stages.indexOf(next.mediaStage) < stages.indexOf(operation.mediaStage)) {
    delete next.mediaStage;
  }
  if (operation.persistence && operation.persistence !== 'pending') delete next.persistence;
  for (const key of ['canvasNodeId', 'messageId', 'artifactId'] as const) {
    if (operation[key] !== undefined && next[key] !== undefined && operation[key] !== next[key]) {
      throw new Error('MCP 操作引用身份不能变更');
    }
  }
  if (next.items) {
    if (new Set(next.items.map((item) => item.nodeId)).size !== next.items.length) throw new Error('MCP 操作条目不能重复');
    if (operation.items) {
      const incoming = new Map(next.items.map((item) => [item.nodeId, item]));
      if (next.items.some((item) => !operation.items!.some((existing) => existing.nodeId === item.nodeId))) {
        throw new Error('MCP 操作目标集合不能变更');
      }
      next.items = operation.items.map((item) => {
        const changed = incoming.get(item.nodeId);
        return !changed || ['succeeded', 'failed', 'unknown'].includes(item.status)
          || (item.status === 'started' && changed.status === 'not_started') ? item : changed;
      });
    }
  }
  return next;
}

/** 只有这个事务能推进操作 sequence；普通任务快照保存不能改写回执。 */
export async function updateMcpOperationTask(taskId: string, changes: McpOperationUpdate): Promise<AgentTask | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = mcpOperationTransaction(db);
    const metadata = tx.objectStore(STORE_METADATA);
    const tasks = tx.objectStore(STORE_AGENT_TASKS);
    let result: AgentTask | null = null;
    let failure: unknown;
    const request = tasks.get(taskId);
    request.onsuccess = () => {
      const task = request.result as AgentTask | undefined;
      if (!task?.mcpOperation) return;
      const operation = task.mcpOperation;
      const bindingRequest = metadata.get(operation.bindingId);
      bindingRequest.onsuccess = () => {
        try {
          const binding = checkedMcpBinding(bindingRequest.result);
          if (!sameMcpOperationIdentity(binding, operation) || binding.taskId !== taskId
            || task.projectId !== binding.projectId || task.conversationId !== `mcp-control-${binding.projectId}`) {
            throw new Error('MCP 操作任务身份不一致');
          }
          if (binding.taskDeletedAt) return;
          if (!['reserved', 'running'].includes(operation.phase)) { result = task; return; }
          const now = Date.now();
          const sequence = Math.max(operation.sequence, binding.lastSequence ?? 0) + 1;
          result = { ...task, mcpOperation: { ...operation, ...mergeMcpOperationProgress(operation, changes), sequence, updatedAt: now } };
          tasks.put(result);
          metadata.put({ ...binding, lastSequence: sequence });
        } catch (error) { failure = error; tx.abort(); }
      };
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('MCP 操作回执未保存'));
  });
}

export function markMcpTaskDeleted(tx: IDBTransaction, task: AgentTask | undefined): void {
  if (!task?.mcpOperation) return;
  const metadata = tx.objectStore(STORE_METADATA);
  const request = metadata.get(task.mcpOperation.bindingId);
  request.onsuccess = () => {
    if (!request.result) return;
    const binding = checkedMcpBinding(request.result);
    if (binding.taskId === task.id) metadata.put({ ...binding, taskDeletedAt: binding.taskDeletedAt ?? Date.now(),
      lastSequence: Math.max(binding.lastSequence ?? 0, task.mcpOperation!.sequence) + 1 });
  };
}

export async function putAgentTask(record: AgentTaskRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AGENT_TASKS, STORE_METADATA], 'readwrite');
    withRelocatedMedia(tx, record, (next) => {
      const tasks = tx.objectStore(STORE_AGENT_TASKS);
      const metadata = tx.objectStore(STORE_METADATA);
      const deleted = metadata.get(`project-deleted:${next.projectId}`);
      deleted.onsuccess = () => {
        if (deleted.result) return;
        const currentRequest = tasks.get(next.id);
        currentRequest.onsuccess = () => {
          const current = currentRequest.result as AgentTask | undefined;
          const operation = current?.mcpOperation ?? next.mcpOperation;
          // v2 图只由下方 CAS 事务推进；后台旧快照不能覆盖已领取的节点租约。
          const protectedTask = current?.teamRun?.version === 2 ? { ...next, teamRun: current.teamRun } : next;
          if (!operation) { tasks.put(protectedTask); return; }
          const bindingRequest = metadata.get(operation.bindingId);
          bindingRequest.onsuccess = () => {
            try {
              const binding = checkedMcpBinding(bindingRequest.result);
              if (!sameMcpOperationIdentity(binding, operation) || binding.taskId !== next.id
                || next.projectId !== binding.projectId || next.conversationId !== `mcp-control-${binding.projectId}`
                || (next.mcpOperation && !sameMcpOperationIdentity(next.mcpOperation, binding))) {
                throw new Error('MCP 操作任务身份不一致');
              }
              if (binding.taskDeletedAt || !current?.mcpOperation) return;
              tasks.put({ ...protectedTask, mcpOperation: current.mcpOperation });
            } catch { tx.abort(); }
          };
        };
      };
    });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 同一事务比较并推进图版本。结构变更/节点领取/完成均不能借普通 put 绕过。 */
export async function updateTeamRunCAS(
  taskId: string,
  expected: { revision: number; boardRevision: number },
  update: (run: AgentTeamRun) => AgentTeamRun,
): Promise<AgentTask> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AGENT_TASKS, STORE_METADATA], 'readwrite');
    const tasks = tx.objectStore(STORE_AGENT_TASKS);
    let result: AgentTask | undefined;
    let failure: Error | undefined;
    const request = tasks.get(taskId);
    request.onsuccess = () => {
      const task = request.result as AgentTask | undefined;
      const run = task?.teamRun;
      if (!task || task.executionKind !== 'team' || !run || run.version !== 2
        || run.revision !== expected.revision || (run.boardRevision ?? 0) !== expected.boardRevision) {
        failure = new Error('TEAM_GRAPH_CAS_CONFLICT'); tx.abort(); return;
      }
      const deleted = tx.objectStore(STORE_METADATA).get(`project-deleted:${task.projectId}`);
      deleted.onsuccess = () => {
        try {
          if (deleted.result) throw new Error('项目已删除');
          const next = update(structuredClone(run));
          if (next.id !== run.id || next.version !== 2 || !Number.isSafeInteger(next.revision)
            || next.revision < run.revision || !Number.isSafeInteger(next.boardRevision)
            || next.boardRevision! <= (run.boardRevision ?? 0)) throw new Error('团队图 CAS 必须推进有效版本');
          result = { ...task, teamRun: structuredClone(next), updatedAt: Date.now() }; tasks.put(result);
        } catch (error) { failure = error instanceof Error ? error : new Error('团队图更新失败'); tx.abort(); }
      };
    };
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('团队图更新未完成'));
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('团队图事务失败'));
  });
}

export async function getAgentTask(id: string): Promise<AgentTaskRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const request = tx.objectStore(STORE_AGENT_TASKS).get(id);
    request.onsuccess = () => resolve((request.result as AgentTaskRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function getProjectAgentTasks(projectId: string): Promise<AgentTaskRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as AgentTaskRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function getConversationAgentTasks(
  conversationId: string,
): Promise<AgentTaskRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('conversationId_updatedAt');
    const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as AgentTaskRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteAgentTask(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AGENT_TASKS, STORE_METADATA], 'readwrite');
    const tasks = tx.objectStore(STORE_AGENT_TASKS);
    const request = tasks.get(id);
    request.onsuccess = () => { markMcpTaskDeleted(tx, request.result); tasks.delete(id); };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteConversationAgentTasks(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AGENT_TASKS, STORE_METADATA], 'readwrite');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('conversationId_updatedAt');
    const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Infinity]);
    const cursorRequest = index.openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        markMcpTaskDeleted(tx, cursor.value as AgentTask);
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProjectAgentTasks(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AGENT_TASKS, STORE_METADATA], 'readwrite');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const cursorRequest = index.openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        markMcpTaskDeleted(tx, cursor.value as AgentTask);
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
