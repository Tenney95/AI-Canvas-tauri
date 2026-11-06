import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import type { TeamArtifactReference } from '../../../src/types/agentTeam';
import { createDefaultTeamProfile } from '../../../src/services/chat/teams/teamProfileService';

const db = vi.hoisted(() => ({
  records: new Map<string, AgentTask>(),
  put: vi.fn<(task: AgentTask) => Promise<void>>(),
  get: vi.fn<(id: string) => Promise<AgentTask | null>>(),
  project: vi.fn<(id: string) => Promise<AgentTask[]>>(),
  conversation: vi.fn<(id: string) => Promise<AgentTask[]>>(),
  deleteTask: vi.fn<(id: string) => Promise<void>>(),
  deleteConversation: vi.fn<(id: string) => Promise<void>>(),
  deleteProject: vi.fn<(id: string) => Promise<void>>(),
  claim: vi.fn(),
}));

vi.mock(import('../../../src/services/indexedDbService'), async (importOriginal) => ({
  ...await importOriginal(),
  putAgentTask: db.put, getAgentTask: db.get, getProjectAgentTasks: db.project,
  getConversationAgentTasks: db.conversation, deleteAgentTask: db.deleteTask,
  deleteConversationAgentTasks: db.deleteConversation, deleteProjectAgentTasks: db.deleteProject,
  claimMcpAgentTask: db.claim,
  updateTeamRunCAS: vi.fn(),
}));

import { removeConversationAgentTasks, removeProjectAgentTasks, repairInterruptedAgentTasks, saveAgentTask } from '../../../src/services/chat/agentTaskService';

function task(id: string, conversationId = 'conversation', projectId = 'project'): AgentTask {
  return { id, conversationId, projectId, userMessageId: `msg-${id}`, mode: 'collaborative', goal: '旧目标',
    status: 'queued', steps: [], modelRounds: 0, toolCallCount: 0, budget: { ...DEFAULT_AGENT_TASK_BUDGET },
    createdAt: 1, updatedAt: 1 };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  db.records.clear();
  db.put.mockReset().mockImplementation(async (record) => { db.records.set(record.id, structuredClone(record)); });
  db.get.mockReset().mockImplementation(async (id) => db.records.get(id) ?? null);
  db.project.mockReset().mockImplementation(async (id) => [...db.records.values()].filter((record) => record.projectId === id));
  db.conversation.mockReset().mockImplementation(async (id) => [...db.records.values()].filter((record) => record.conversationId === id));
  db.deleteTask.mockReset().mockImplementation(async (id) => { db.records.delete(id); });
  db.deleteConversation.mockReset().mockImplementation(async (id) => {
    for (const record of db.records.values()) if (record.conversationId === id) db.records.delete(record.id);
  });
  db.deleteProject.mockReset().mockImplementation(async (id) => {
    for (const record of db.records.values()) if (record.projectId === id) db.records.delete(record.id);
  });
});

describe('Agent 任务保存的顺序与删除边界', () => {
  it('同一任务的新快照不会被较慢的旧快照覆盖', async () => {
    const started = deferred();
    const release = deferred();
    db.put.mockImplementationOnce(async (record) => { started.resolve(); await release.promise; db.records.set(record.id, record); });
    const oldTask = task('serial-task');
    const first = saveAgentTask(oldTask);
    await started.promise;
    const second = saveAgentTask({ ...oldTask, goal: '新目标', updatedAt: 2 });
    expect(db.put).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(db.records.get(oldTask.id)?.goal).toBe('新目标');
  });

  it('清空会话只封禁旧任务，新任务等删除结束后仍可保存', async () => {
    const started = deferred();
    const release = deferred();
    db.put.mockImplementationOnce(async (record) => { started.resolve(); await release.promise; db.records.set(record.id, record); });
    const previous = task('conversation-old', 'cleared-conversation', 'scope-project');
    const first = saveAgentTask(previous);
    await started.promise;
    const deleting = removeConversationAgentTasks(previous.conversationId);
    const fresh = task('conversation-new', previous.conversationId, previous.projectId);
    const savingFresh = saveAgentTask(fresh);
    const lateOld = expect(saveAgentTask({ ...previous, goal: '迟到结果' })).rejects.toThrow('任务已删除');
    release.resolve();
    await Promise.all([first, deleting, savingFresh, lateOld]);
    expect(db.records.has(previous.id)).toBe(false);
    expect(db.records.has(fresh.id)).toBe(true);
    await saveAgentTask(task('conversation-next', previous.conversationId, previous.projectId));
    expect(db.records.has('conversation-next')).toBe(true);
  });

  it('同 ID 项目重新使用后可保存新任务，但旧任务不能复活', async () => {
    const previous = task('project-old', 'old-conversation', 'restored-project');
    await saveAgentTask(previous);
    await removeProjectAgentTasks(previous.projectId);
    const fresh = task('project-new', 'new-conversation', previous.projectId);
    await saveAgentTask(fresh);
    await expect(saveAgentTask(previous)).rejects.toThrow('任务已删除');
    expect(db.records.has(fresh.id)).toBe(true);
  });

  it('保存失败对调用者可见，失败链不会吞掉后续合法保存', async () => {
    db.put.mockRejectedValueOnce(new Error('disk unavailable'));
    const value = task('retry-local-save');
    await expect(saveAgentTask(value)).rejects.toThrow('disk unavailable');
    await saveAgentTask({ ...value, goal: '后续本地保存' });
    expect(db.records.get(value.id)?.goal).toBe('后续本地保存');
  });

  it('重启暂停团队的在途阶段，保留已完成产物与累计预算', async () => {
    const value = task('team-restart', 'restart-conversation', 'restart-project');
    const reference: TeamArtifactReference = { id: 'input', kind: 'input', label: '材料', relativePath: 'input.json',
      sha256: 'a'.repeat(64), bytes: 1, parentArtifactIds: [], createdAt: 1 };
    value.status = 'running'; value.executionKind = 'team'; value.modelRounds = 2;
    value.teamRun = { id: value.id, version: 1, revision: 1, templateId: 'general', source: 'assistant',
      profile: createDefaultTeamProfile('model'), inputArtifact: reference,
      modelFingerprints: { architect: '', writer: '', continuity: '', dialogue: '', editor: '' },
      stages: [
        { id: 'structure', title: '结构', roleId: 'architect', modelId: 'model', status: 'completed', attempts: 1,
          artifactId: 'completed-outline', usageKnown: true },
        { id: 'draft', title: '主笔', roleId: 'writer', modelId: 'model', status: 'running', attempts: 1, usageKnown: false },
      ], artifacts: [], callsUsed: 2, budgetTokensUsed: 2000, usageReportedCalls: 1, unknownUsageCalls: 0,
      usageKnown: false, createdAt: 1 };
    db.records.set(value.id, value);
    await repairInterruptedAgentTasks(value.projectId);
    const saved = db.records.get(value.id)!;
    expect(saved.status).toBe('paused');
    expect(saved.teamRun?.stages.map((stage) => stage.status)).toEqual(['completed', 'pending']);
    expect(saved.teamRun?.callsUsed).toBe(2);
    expect(saved.teamRun?.budgetTokensUsed).toBe(2000);
    expect(saved.teamRun?.unknownUsageCalls).toBe(1);
    expect(saved.teamRun?.stages[0].artifactId).toBe('completed-outline');
  });
});
