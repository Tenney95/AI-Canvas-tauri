import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTeamRun, TeamArtifactReference, TeamGraphDefinition } from '../../../src/types/agentTeam';
import type { TeamModelResult } from '../../../src/services/chat/teams/teamModelExecutor';

const model = vi.hoisted(() => ({ execute: vi.fn(), saveArtifact: vi.fn(), readArtifact: vi.fn() }));
vi.mock('../../../src/services/chat/teams/teamModelExecutor', async (original) => ({
  ...await original<typeof import('../../../src/services/chat/teams/teamModelExecutor')>(), executeTeamModel: model.execute,
  fingerprintTeamModel: vi.fn(async () => 'a'.repeat(64)) }));
vi.mock('../../../src/services/chat/agentTaskService', async (original) => ({
  ...await original<typeof import('../../../src/services/chat/agentTaskService')>(), saveAgentTask: vi.fn(async () => {}) }));
vi.mock('../../../src/services/indexedDbService', async (original) => ({
  ...await original<typeof import('../../../src/services/indexedDbService')>(), updateTeamRunCAS: vi.fn(async () => {}) }));
vi.mock('../../../src/services/chat/teams/teamArtifactService', () => ({
  readTeamArtifactText: model.readArtifact,
  hashTeamText: vi.fn(async () => 'a'.repeat(64)), saveTeamArtifact: model.saveArtifact }));
vi.mock('../../../src/services/chat/contextManager', async (original) => ({
  ...await original<typeof import('../../../src/services/chat/contextManager')>(), resolveAssistantContextSpec: () => ({ inputBudget: 100000 }) }));

import { useAppStore } from '../../../src/store/useAppStore';
import { captureAgentProjectScope } from '../../../src/services/chat/agentProjectContext';
import { createDefaultTeamProfile } from '../../../src/services/chat/teams/teamProfileService';
import { executeTeamRun } from '../../../src/services/chat/teams/teamRuntime';
import { unmaterializedTeamDispatches } from '../../../src/services/chat/agentDurabilityService';
import { TeamModelReturnedError } from '../../../src/services/chat/teams/teamModelExecutor';

const artifact = (id: string, stageId?: string): TeamArtifactReference => ({ id, kind: stageId ? 'outline' : 'input',
  label: id, relativePath: `agent-teams/run/${id}.json`, sha256: 'a'.repeat(64), bytes: 1, createdAt: 1,
  stageId, roleId: stageId ? 'architect' : undefined, parentArtifactIds: [] });

function arrangeTeam(): string {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'episode-a', projectLoadStatus: 'ready', switchingProjectName: null,
    projects: [{ id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-a', parentId: 'series', name: '画布 A', createdAt: 1, updatedAt: 1 },
      { id: 'episode-b', parentId: 'series', name: '工作台 B', createdAt: 1, updatedAt: 1 },
      { id: 'other', name: '其他项目', createdAt: 1, updatedAt: 1 }] });
  const graph: TeamGraphDefinition = { version: 1, finalTaskId: 'structure', nodes: [
    { id: 'structure', roleId: 'architect', title: '结构', kind: 'outline', dependsOn: [] }] };
  const profile = { ...createDefaultTeamProfile('model'), graph };
  const task = useAppStore.getState().createAgentTask({ taskId: 'team-context-run', executionKind: 'team', projectId: 'episode-b',
    conversationId: 'conv-team', userMessageId: 'user-team', mode: 'autonomous', goal: '整理本集' });
  const teamRun: AgentTeamRun = { version: 2, revision: 1, boardRevision: 0, id: task.id, graph, templateId: 'outline',
    source: 'script-workbench', target: { kind: 'episode', seriesId: 'series', episodeId: 'episode-b', field: 'outline',
      expectedHash: 'a'.repeat(64), label: '本集' }, profile, inputArtifact: artifact('input'),
    modelFingerprints: { architect: 'a'.repeat(64), writer: '', continuity: '', dialogue: '', editor: '' },
    stages: [{ id: 'structure', roleId: 'architect', title: '结构', modelId: 'model', modelFingerprint: 'a'.repeat(64),
      executionTarget: { kind: 'text-model', modelId: 'model' }, taskRevision: 0, status: 'pending', attempts: 0, usageKnown: false }],
    artifacts: [], callsUsed: 0, budgetTokensUsed: 0, usageKnown: false, usageReportedCalls: 0, unknownUsageCalls: 0, createdAt: 1 };
  useAppStore.getState().updateAgentTask(task.id, { status: 'running', teamRun,
    projectScope: captureAgentProjectScope(useAppStore.getState(), { ...task, teamRun }) });
  return task.id;
}

beforeEach(() => {
  model.execute.mockReset();
  model.readArtifact.mockReset().mockResolvedValue(JSON.stringify({ version: 1, prompt: '整理本集', materials: '' }));
  model.saveArtifact.mockReset().mockImplementation(async (input: { kind: string; stageId: string; assertCurrent?: () => void }) => {
    input.assertCurrent?.(); return artifact(`${input.kind}-result`, input.stageId);
  });
});

describe('团队项目租约与真实调用回执', () => {
  it('旧任务没有 scope 时整段执行只捕获一次，等待读取后不从新 epoch 取得付费权限', async () => {
    const taskId = arrangeTeam();
    useAppStore.getState().updateAgentTask(taskId, { projectScope: undefined });
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    model.readArtifact.mockImplementationOnce(async () => { enter(); await gate; return JSON.stringify({ version: 1, prompt: '原请求', materials: '' }); });
    const executing = executeTeamRun(taskId, new AbortController().signal);
    await entered;
    useAppStore.setState((state) => ({ projects: state.projects.map((project) => project.id === 'episode-b' ? { ...project, exchangeEpoch: 1 } : project) }));
    finish();
    await expect(executing).resolves.toBe('paused');
    expect(model.execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks.find((item) => item.id === taskId)?.teamRun?.callsUsed).toBe(0);
  });

  it('完整返回后本地长度/取消复核失败仍结算已知失败与实际用量，不自动修正重试', async () => {
    const taskId = arrangeTeam();
    model.execute.mockRejectedValueOnce(new TeamModelReturnedError('输出未完成', {
      text: '部分正文', usageKnown: true, inputTokens: 10, outputTokens: 20 }, false));
    await expect(executeTeamRun(taskId, new AbortController().signal)).resolves.toBe('paused');
    const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId)!;
    expect(task.teamRun).toMatchObject({ callsUsed: 1, budgetTokensUsed: 30, usageReportedCalls: 1, unknownUsageCalls: 0 });
    expect(task.dispatches?.[0]).toMatchObject({ phase: 'settled', outcome: 'failed', materializationBlocked: true });
    expect(unmaterializedTeamDispatches(task)).toHaveLength(1);
    expect(model.execute).toHaveBeenCalledTimes(1);
    expect(model.saveArtifact).not.toHaveBeenCalled();
    await expect(executeTeamRun(taskId, new AbortController().signal)).resolves.toBe('paused');
    expect(model.execute).toHaveBeenCalledTimes(1);
  });
  it('画布 A 的同剧工作台 B 使用 Episode scope，可执行原团队且预算只累计一次', async () => {
    const taskId = arrangeTeam();
    model.execute.mockResolvedValue({ text: '本集候选', usageKnown: true, inputTokens: 10, outputTokens: 20 });
    await expect(executeTeamRun(taskId, new AbortController().signal)).resolves.toBe('completed');
    const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId)!;
    expect(task.projectScope).toMatchObject({ kind: 'episode', episodeId: 'episode-b' });
    expect(task.teamRun).toMatchObject({ callsUsed: 1, budgetTokensUsed: 30, usageReportedCalls: 1, unknownUsageCalls: 0 });
    expect(useAppStore.getState().currentProjectId).toBe('episode-a');
    expect(model.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['switch', 'epoch'] as const)('模型返回后发生 %s，保留实际用量/settled 回执，拒绝旧产物和普通继续重投', async (boundary) => {
    const taskId = arrangeTeam();
    let enter!: () => void;
    let finish!: (result: TeamModelResult) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    model.execute.mockImplementationOnce(() => new Promise<TeamModelResult>((resolve) => { finish = resolve; enter(); }));
    const executing = executeTeamRun(taskId, new AbortController().signal);
    await entered;
    const projects = useAppStore.getState().projects;
    if (boundary === 'switch') useAppStore.setState({ currentProjectId: 'other' });
    else useAppStore.setState({ projects: projects.map((project) => project.id === 'episode-b' ? { ...project, exchangeEpoch: 1 } : project) });
    finish({ text: '迟到旧候选', usageKnown: true, inputTokens: 10, outputTokens: 20 });
    await expect(executing).resolves.toBe('paused');
    const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId)!;
    expect(task.teamRun).toMatchObject({ callsUsed: 1, budgetTokensUsed: 30, usageReportedCalls: 1, unknownUsageCalls: 0 });
    expect(task.dispatches?.[0]).toMatchObject({ phase: 'settled', outcome: 'succeeded' });
    expect(unmaterializedTeamDispatches(task)).toHaveLength(1);
    expect(model.saveArtifact).not.toHaveBeenCalled();
    useAppStore.setState({ currentProjectId: 'episode-a', projects });
    await expect(executeTeamRun(taskId, new AbortController().signal)).resolves.toBe('paused');
    expect(model.execute).toHaveBeenCalledTimes(1);
  });
});
