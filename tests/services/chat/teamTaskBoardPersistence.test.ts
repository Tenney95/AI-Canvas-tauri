import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import { createTemplateTeamGraph } from '../../../src/services/chat/teams/teamGraphService';
import { createDefaultTeamProfile } from '../../../src/services/chat/teams/teamProfileService';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  vi.resetModules();
});

function task(): AgentTask {
  const graph = createTemplateTeamGraph('outline');
  return { id: 'graph-cas', projectId: 'project', conversationId: 'conv', userMessageId: 'message',
    mode: 'autonomous', goal: '任务', status: 'running', steps: [], modelRounds: 0, toolCallCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET }, createdAt: 1, updatedAt: 1, executionKind: 'team',
    teamRun: { version: 2, revision: 1, boardRevision: 0, graph, id: 'graph-cas', templateId: 'outline', source: 'assistant',
      profile: createDefaultTeamProfile('model'), inputArtifact: { id: 'input', kind: 'input', label: '输入',
        relativePath: 'agent-teams/input.json', sha256: 'a'.repeat(64), bytes: 1, createdAt: 1, parentArtifactIds: [] },
      modelFingerprints: { architect: '', writer: '', continuity: '', dialogue: '', editor: '' },
      stages: graph.nodes.map((node) => ({ id: node.id, title: node.title, roleId: node.roleId, modelId: 'model',
        taskRevision: 0, attempts: 0, usageKnown: false, status: 'pending' })), artifacts: [],
      callsUsed: 0, budgetTokensUsed: 0, usageKnown: false, usageReportedCalls: 0, unknownUsageCalls: 0, createdAt: 1 },
  };
}

describe('团队任务图事务 CAS', () => {
  it('同一版本的并发领取只有一个成功，普通旧快照不能覆盖租约', async () => {
    const db = await import('../../../src/services/indexedDbService');
    const original = task(); await db.putAgentTask(original);
    const claim = () => db.updateTeamRunCAS(original.id, { revision: 1, boardRevision: 0 }, (run) => ({
      ...run, boardRevision: 1, stages: run.stages.map((stage, index) => index === 0
        ? { ...stage, status: 'running', taskRevision: 1, attemptId: crypto.randomUUID() } : stage),
    }));
    const outcomes = await Promise.allSettled([claim(), claim()]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    await db.putAgentTask({ ...original, goal: '普通字段更新' });
    const persisted = await db.getAgentTask(original.id);
    expect(persisted?.goal).toBe('普通字段更新');
    expect(persisted?.teamRun?.boardRevision).toBe(1);
    expect(persisted?.teamRun?.stages[0].attemptId).toBeTruthy();
  });

  it('拒绝不推进board版本的写入，不留下部分任务修改', async () => {
    const db = await import('../../../src/services/indexedDbService'); const original = task(); await db.putAgentTask(original);
    await expect(db.updateTeamRunCAS(original.id, { revision: 1, boardRevision: 0 }, (run) => ({ ...run, callsUsed: 9 }))).rejects.toThrow('推进');
    expect((await db.getAgentTask(original.id))?.teamRun?.callsUsed).toBe(0);
  });
});
