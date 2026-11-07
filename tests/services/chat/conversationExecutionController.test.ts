/**
 * conversationExecutionController — 回归测试：ordinary conversation media recovery。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentScheduleResult, ConversationAgentExecution } from '../../../src/services/chat/agentScheduler';

const schedulerMocks = vi.hoisted(() => {
  // 记录已入队的任务，让 isAgentExecutionScheduled 能反映真实调度器的去重行为
  const scheduledTaskIds = new Set<string>();
  return {
    activeTaskId: undefined as string | undefined,
    scheduledTaskIds,
    schedule: vi.fn((execution: { taskId: string }): AgentScheduleResult => {
      scheduledTaskIds.add(execution.taskId);
      return { state: 'started', position: 0 };
    }),
    isScheduled: vi.fn((taskId: string) => scheduledTaskIds.has(taskId)),
  };
});

const interjectionMocks = vi.hoisted(() => ({
  enqueue: vi.fn(() => true),
}));

const mediaRuntimeMocks = vi.hoisted(() => ({ generate: vi.fn(), complete: vi.fn() }));
const mediaHistoryMocks = vi.hoisted(() => ({ persist: vi.fn() }));
const creationMocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../../src/services/creationProfiles/creationProfileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/creationProfiles/creationProfileService')>(),
  captureCreationProfile: creationMocks.capture,
}));
vi.mock('../../../src/services/ai/generationRuntime', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/ai/generationRuntime')>(),
  runMediaGeneration: mediaRuntimeMocks.generate,
  completeMediaMessageDelivery: mediaRuntimeMocks.complete,
}));

vi.mock('../../../src/services/chat/agentScheduler', () => ({
  getActiveConversationAgentTaskId: () => schedulerMocks.activeTaskId,
  scheduleConversationAgentExecution: schedulerMocks.schedule,
  isAgentExecutionScheduled: schedulerMocks.isScheduled,
}));

vi.mock('../../../src/services/chat/agentInterjection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/chat/agentInterjection')>(),
  enqueueAgentInterjection: interjectionMocks.enqueue,
}));

vi.mock('../../../src/services/chat/tools', () => ({
  ensureAgentToolsRegistered: vi.fn(),
}));

// 本组验证调度与响应状态；历史读取固定为空，避免相同会话 ID 的异步落盘污染后续用例。
vi.mock('../../../src/services/chat/chatHistoryService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/chat/chatHistoryService')>(),
  loadMessages: vi.fn(async () => ({ messages: [], total: 0 })),
  persistMessage: mediaHistoryMocks.persist,
}));

import {
  resumeAgentTaskExecution,
  submitConversationMessage,
  triggerMediaGeneration,
} from '../../../src/services/chat/conversationExecutionController';
import { useAppStore } from '../../../src/store/useAppStore';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import { GENERAL_ASSISTANT_SCOPE_ID, isGeneralAssistantTool } from '../../../src/services/chat/assistantScope';
import { getPendingTasksForProject, MediaTaskPausedError, savePendingTask } from '../../../src/services/pollManager';
import { imageBatchArtifactId } from '../../../src/services/imageBatchService';
import type { MediaGenerationResult } from '../../../src/types/media';
import type { ChatMessage } from '../../../src/types/chat';
import type { CreationProfileSnapshot } from '../../../src/types/creationProfile';
import { pauseAgentTask } from '../../../src/services/chat/agentTaskControl';
import { WORKBENCH_AGENT_READ_TOOLS } from '../../../src/services/episodeWorkspaceScope';

function arrangeConversation(): void {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    projectLoadStatus: 'ready',
    projects: [{ id: 'project-1', name: 'Controller test', createdAt: 1, updatedAt: 1 }],
    activeConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Controller test',
      titleSource: 'auto',
      pinned: false,
      archived: false,
      agentMode: 'collaborative',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    }],
    messages: [],
    agentTasks: [],
  });
}

beforeEach(() => {
  localStorage.removeItem('ai_canvas_pending_tasks');
  mediaRuntimeMocks.generate.mockReset();
  mediaRuntimeMocks.complete.mockReset();
  mediaHistoryMocks.persist.mockReset();
  mediaHistoryMocks.persist.mockResolvedValue(undefined);
  creationMocks.capture.mockReset().mockResolvedValue({ skillBindings: [] });
  arrangeConversation();
  schedulerMocks.activeTaskId = undefined;
  schedulerMocks.scheduledTaskIds.clear();
  schedulerMocks.schedule.mockReset();
  schedulerMocks.schedule.mockImplementation((execution: { taskId: string }) => {
    schedulerMocks.scheduledTaskIds.add(execution.taskId);
    return { state: 'started', position: 0 };
  });
  schedulerMocks.isScheduled.mockReset();
  schedulerMocks.isScheduled.mockImplementation(
    (taskId: string) => schedulerMocks.scheduledTaskIds.has(taskId),
  );
  interjectionMocks.enqueue.mockReset();
  interjectionMocks.enqueue.mockReturnValue(true);
});

describe('creation profile preparation and scheduling', () => {
  const selection = { id: 'creation', version: '1.0.0', sha256: 'a'.repeat(64) };
  const snapshot: CreationProfileSnapshot = { ...selection, name: '组合', contextPolicyRef: 'explicit-materials',
    pluginRefs: [], agentPackageRefs: [], skillRefs: [] };
  const select = () => useAppStore.setState({ conversations: useAppStore.getState().conversations.map((conversation) => ({ ...conversation, creationProfile: selection })) });

  it('keeps the original synchronous scheduling path without a selected profile', () => {
    const result = submitConversationMessage({ content: '普通请求', conversationId: 'conversation-1' });
    expect(result.status).toBe('started'); expect(schedulerMocks.schedule).toHaveBeenCalledTimes(1);
    expect(creationMocks.capture).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].creationProfilePreparation).toBeUndefined();
  });

  it('does not dispatch before preparation and cannot resume around a paused preparation', async () => {
    select();
    let complete!: (value: { snapshot: CreationProfileSnapshot; skillBindings: [] }) => void;
    const preparing = new Promise<{ snapshot: CreationProfileSnapshot; skillBindings: [] }>((resolve) => { complete = resolve; });
    creationMocks.capture.mockReturnValueOnce(preparing);
    const result = submitConversationMessage({ content: '使用选定组合', conversationId: 'conversation-1' });
    if (result.status !== 'started' || !result.taskId) throw new Error('Expected queued preparation');
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].creationProfilePreparation).toBe('pending');
    pauseAgentTask(result.taskId);
    expect(resumeAgentTaskExecution(result.taskId)).toMatchObject({ ok: false, errorCode: 'CREATION_PROFILE_NOT_PREPARED' });
    complete({ snapshot, skillBindings: [] }); await preparing;
    const task = useAppStore.getState().agentTasks.find((entry) => entry.id === result.taskId)!;
    expect(task.creationProfilePreparation).toBe('ready'); expect(task.creationProfile).toEqual(snapshot);
    expect(task.status).toBe('paused'); expect(schedulerMocks.schedule).not.toHaveBeenCalled();
    expect(resumeAgentTaskExecution(result.taskId).ok).toBe(true);
    expect(schedulerMocks.schedule).toHaveBeenCalledTimes(1);
  });

  it('preparation rejection stops the queued task without running the legacy path', async () => {
    select(); creationMocks.capture.mockRejectedValueOnce(new Error('组合能力不可用'));
    const result = submitConversationMessage({ content: '使用选定组合', conversationId: 'conversation-1' });
    await Promise.resolve(); await Promise.resolve();
    expect(result.status).toBe('started'); expect(schedulerMocks.schedule).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({ status: 'stopped', creationProfilePreparation: 'failed', errorCode: 'CREATION_PROFILE_PREPARATION_FAILED' });
  });
});

describe('工作台分集 Agent 接线', () => {
  const target = { seriesId: 'series', episodeId: 'episode-b' };
  const episodeSelection = { id: 'episode-profile', version: '1.0.0', sha256: 'b'.repeat(64) };
  const conversationSelection = { id: 'conversation-profile', version: '1.0.0', sha256: 'c'.repeat(64) };
  const snapshot: CreationProfileSnapshot = { ...episodeSelection, name: '本集组合', contextPolicyRef: 'explicit-materials',
    pluginRefs: [], agentPackageRefs: [], skillRefs: [], toolAllowlist: ['episode_read', 'skill_load', 'canvas_query', 'media_generate'] };

  beforeEach(() => {
    useAppStore.setState({
      currentProjectId: 'episode-a', projectLoadStatus: 'ready', isCreatingProject: false,
      isReturningToStartPage: false, switchingProjectName: null,
      projects: [
        { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-a', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-b', parentId: 'series', name: '第二集', createdAt: 1, updatedAt: 1 },
        { id: 'other-series', name: '其他剧集', createdAt: 1, updatedAt: 1 },
      ],
      conversations: useAppStore.getState().conversations.map((conversation) => ({ ...conversation, projectId: 'series',
        creationProfile: conversationSelection, executionSelection: { kind: 'team' as const, templateId: 'review' as const } })),
    });
  });

  const submit = () => submitConversationMessage({ content: '检查本集结构', projectId: 'episode-b',
    conversationId: 'conversation-1', workbenchTarget: target, executionSelection: { kind: 'single' } });

  it('允许离画布同剧集分集任务，仅开放固定只读工具，不继承会话组合或团队', () => {
    const result = submit();
    expect(result.status).toBe('started');
    const task = useAppStore.getState().agentTasks[0];
    expect(task).toMatchObject({ projectId: 'episode-b', conversationId: 'conversation-1', workbenchTarget: target,
      toolAllowlist: [...WORKBENCH_AGENT_READ_TOOLS] });
    expect(task.executionKind).toBeUndefined();
    expect(task.creationProfile).toBeUndefined();
    expect(creationMocks.capture).not.toHaveBeenCalled();
    expect(schedulerMocks.schedule).toHaveBeenCalledOnce();
    expect(useAppStore.getState().currentProjectId).toBe('episode-a');
  });

  it('准备本集组合包后仍与只读固定集合及显式 Skill 限制取交集', async () => {
    useAppStore.setState({
      projects: useAppStore.getState().projects.map((project) => project.id === 'episode-b'
        ? { ...project, creationProfile: episodeSelection } : project),
      userSkills: [{ id: 'restrict', name: '只读规则', description: '', fileName: 'SKILL.md', sourceType: 'file', createdAt: 1,
        content: '按证据分析', manifest: { allowedTools: ['skill_load', 'canvas_query'] } }],
    });
    let finish!: (value: { snapshot: CreationProfileSnapshot; skillBindings: [] }) => void;
    const preparing = new Promise<{ snapshot: CreationProfileSnapshot; skillBindings: [] }>((resolve) => { finish = resolve; });
    creationMocks.capture.mockReturnValueOnce(preparing);
    const result = submitConversationMessage({ content: '检查本集 @skill{restrict|只读规则}', projectId: 'episode-b',
      conversationId: 'conversation-1', workbenchTarget: target, executionSelection: { kind: 'single' } });
    if (result.status !== 'started' || !result.taskId) throw new Error('Expected workbench task');
    expect(creationMocks.capture).toHaveBeenCalledWith(episodeSelection, 'episode-b');
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({ creationProfilePreparation: 'pending', toolAllowlist: ['skill_load'] });
    finish({ snapshot, skillBindings: [] });
    await preparing;
    const task = useAppStore.getState().agentTasks.find((entry) => entry.id === result.taskId)!;
    expect(task).toMatchObject({ creationProfile: snapshot, creationProfilePreparation: 'ready', toolAllowlist: ['skill_load'], workbenchTarget: target });
    expect(task.toolAllowlist).not.toContain('canvas_query');
    expect(task.toolAllowlist).not.toContain('media_generate');
    expect(schedulerMocks.schedule).toHaveBeenCalledOnce();
    expect(useAppStore.getState().currentProjectId).toBe('episode-a');
  });

  it('清理旧任务后续聊仍继承会话分集，当前画布参数不能改变只读目标', () => {
    const first = submit();
    expect(first.status).toBe('started');
    useAppStore.getState().updateConversation('conversation-1', { executionSelection: { kind: 'single' } });
    useAppStore.setState({ agentTasks: [] });
    const next = submitConversationMessage({ content: '继续检查人物动机', projectId: 'episode-a', conversationId: 'conversation-1' });
    expect(next.status).toBe('started');
    expect(useAppStore.getState().conversations[0].workbenchTarget).toEqual(target);
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({ projectId: 'episode-b', workbenchTarget: target,
      toolAllowlist: [...WORKBENCH_AGENT_READ_TOOLS] });
    expect(useAppStore.getState().currentProjectId).toBe('episode-a');
  });

  it('已绑定会话不能通过新提交参数改绑另一个分集', () => {
    submit();
    const before = useAppStore.getState();
    expect(submitConversationMessage({ content: '换一集', projectId: 'episode-a', conversationId: 'conversation-1',
      executionSelection: { kind: 'single' }, workbenchTarget: { seriesId: 'series', episodeId: 'episode-a' } }))
      .toEqual({ status: 'ignored' });
    expect(useAppStore.getState().conversations[0].workbenchTarget).toEqual(target);
    expect(useAppStore.getState().agentTasks).toHaveLength(before.agentTasks.length);
    expect(useAppStore.getState().messages).toHaveLength(before.messages.length);
  });

  it('离开所属剧集后插话也不能绕过绑定范围进入旧任务', () => {
    const first = submit();
    if (first.status !== 'started' || !first.taskId) throw new Error('Expected workbench task');
    schedulerMocks.activeTaskId = first.taskId;
    useAppStore.getState().updateConversation('conversation-1', { executionSelection: { kind: 'single' } });
    useAppStore.setState({ currentProjectId: 'other-series' });
    expect(submitConversationMessage({ content: '继续分析', conversationId: 'conversation-1', dispatchMode: 'interject' }))
      .toEqual({ status: 'ignored' });
    expect(interjectionMocks.enqueue).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks).toHaveLength(1);
    expect(useAppStore.getState().messages).toHaveLength(2);
  });

  it.each(['global', 'wrong-series', 'deleted-conversation', 'missing-conversation'] as const)('%s 不能声明工作台分集授权', (reason) => {
    if (reason === 'global') useAppStore.setState({ conversations: useAppStore.getState().conversations.map((conversation) => ({ ...conversation, projectId: GENERAL_ASSISTANT_SCOPE_ID })) });
    if (reason === 'wrong-series') useAppStore.setState({ currentProjectId: 'other-series' });
    if (reason === 'deleted-conversation') useAppStore.setState({ conversations: useAppStore.getState().conversations.map((conversation) => ({ ...conversation, deletedAt: 2 })) });
    if (reason === 'missing-conversation') useAppStore.setState({ conversations: [] });
    expect(submit()).toEqual({ status: 'ignored' });
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    expect(useAppStore.getState().messages).toHaveLength(0);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
    expect(creationMocks.capture).not.toHaveBeenCalled();
  });

  it.each(['wrong-series', 'deleted-conversation'] as const)('组合包准备期间 %s 不再调度', async (reason) => {
    useAppStore.setState({ projects: useAppStore.getState().projects.map((project) => project.id === 'episode-b'
      ? { ...project, creationProfile: episodeSelection } : project) });
    let finish!: (value: { snapshot: CreationProfileSnapshot; skillBindings: [] }) => void;
    const preparing = new Promise<{ snapshot: CreationProfileSnapshot; skillBindings: [] }>((resolve) => { finish = resolve; });
    creationMocks.capture.mockReturnValueOnce(preparing);
    const result = submit();
    expect(result.status).toBe('started');
    if (reason === 'wrong-series') useAppStore.setState({ currentProjectId: 'other-series' });
    else useAppStore.setState({ conversations: useAppStore.getState().conversations.map((conversation) => ({ ...conversation, deletedAt: 2 })) });
    finish({ snapshot, skillBindings: [] });
    await preparing;
    await Promise.resolve();
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({ status: 'stopped', creationProfilePreparation: 'failed' });
  });
});

describe('ordinary conversation media recovery', () => {
  it('普通对话把同一作业四张候选拆成独立消息并整组确认', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'mj-tracking', taskId: 'mj-task', attemptId: 'mj-attempt' };
    const artifacts: MediaGenerationResult[] = Array.from({ length: 4 }, (_, index) => ({
      id: imageBatchArtifactId(receipt, index), kind: 'image', deliveryMode: 'chat', taskReceipt: receipt,
      url: `asset://candidate-${index}.png`, sourceUrl: `https://cdn.test/candidate-${index}.png`,
      filePath: `candidate-${index}.png`, persistence: 'saved', prompt: '猫', provider: 'general', modelId: 'general/mj', createdAt: 1,
    }));
    useAppStore.getState().addMessage({ id: 'mj-message', conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1, status: 'done' });
    savePendingTask({ ...receipt, nodeType: 'ai-image', taskType: 'custom-protocol', provider: 'general', submitted: true,
      batchCount: 4, expectedImageOutputs: 4, resultUrls: artifacts.map((artifact) => artifact.sourceUrl),
      mediaContext: { projectId: 'project-1', messageId: 'mj-message', conversationId: 'conversation-1', deliveryMode: 'message' } });
    const writes = artifacts.map(() => {
      let finish!: () => void;
      const promise = new Promise<void>((resolve) => { finish = resolve; });
      return { promise, finish };
    });
    const durableMessageIds = new Set<string>();
    mediaHistoryMocks.persist.mockImplementation(async (message: ChatMessage) => {
      const index = artifacts.findIndex((item) => item.id === message.mediaResult?.id);
      if (index < 0) return;
      await writes[index].promise;
      durableMessageIds.add(message.id);
    });
    mediaRuntimeMocks.generate.mockResolvedValue({ ...artifacts[0], expectedOutputCount: 4, additionalResults: artifacts.slice(1) });
    let settled = false;
    const running = triggerMediaGeneration('mj-message', { kind: 'image', prompt: '猫', modelRef: 'general/mj', deliveryMode: 'chat' })
      .then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(useAppStore.getState().messages.filter((message) => message.mediaResult)).toHaveLength(4));
      expect(durableMessageIds.size).toBe(0);
      expect(settled).toBe(false);
      expect(getPendingTasksForProject('project-1')).toHaveLength(1);
      for (const [index, write] of writes.slice(0, 3).entries()) {
        write.finish();
        await vi.waitFor(() => expect(durableMessageIds.size).toBe(index + 1));
        expect(settled).toBe(false);
        expect(getPendingTasksForProject('project-1')).toHaveLength(1);
      }
    } finally { writes.forEach((write) => write.finish()); }
    await running;
    const messages = useAppStore.getState().messages.filter((message) => message.mediaResult);
    expect(messages.map((message) => message.mediaResult?.id)).toEqual(artifacts.map((artifact) => artifact.id));
    expect(messages.every((message) => !('additionalResults' in message.mediaResult!)
      && !('expectedOutputCount' in message.mediaResult!))).toBe(true);
    expect(new Set(messages.map((message) => message.id)).size).toBe(4);
    expect(durableMessageIds).toEqual(new Set(messages.map((message) => message.id)));
    for (const message of messages) expect(mediaHistoryMocks.persist).toHaveBeenCalledWith(expect.objectContaining({ id: message.id,
      mediaResult: artifacts.find((item) => item.id === message.mediaResult?.id) }), 'project-1', 'conversation-1');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(mediaRuntimeMocks.generate).toHaveBeenCalledOnce();
  });

  it('passes message context to ordinary providers and acknowledges only after message delivery', async () => {
    const artifact = { id: 'artifact-1', kind: 'image', deliveryMode: 'chat', url: 'asset://saved.png', sourceUrl: 'https://cdn.test/image.png',
      persistence: 'saved', prompt: '猫', provider: 'general', modelId: 'general/image', createdAt: 1,
      taskReceipt: { projectId: 'project-1', nodeId: 'tracking-1', taskId: 'remote-1', attemptId: 'attempt-1' } };
    mediaRuntimeMocks.generate.mockResolvedValue(artifact);
    useAppStore.getState().addMessage({ id: 'media-message', conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1, status: 'done' });
    await triggerMediaGeneration('media-message', { kind: 'image', prompt: '猫', modelRef: 'general/image', deliveryMode: 'chat' });
    expect(mediaRuntimeMocks.generate).toHaveBeenCalledWith(expect.anything(), 'project-1', undefined, undefined,
      expect.objectContaining({ projectId: 'project-1', messageId: 'media-message', conversationId: 'conversation-1' }));
    expect(useAppStore.getState().messages.find((message) => message.id === 'media-message')?.mediaResult).toEqual(artifact);
    expect(mediaRuntimeMocks.complete).toHaveBeenCalledWith('media-message', artifact, true);
  });

  it('shows a paused original task instead of reporting generation failure', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'tracking-1', taskId: 'remote-1', attemptId: 'attempt-1' };
    mediaRuntimeMocks.generate.mockRejectedValue(new MediaTaskPausedError(receipt, 'query_timeout'));
    useAppStore.getState().addMessage({ id: 'media-message', conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1, status: 'done' });
    await triggerMediaGeneration('media-message', { kind: 'image', prompt: '猫', modelRef: 'general/image', deliveryMode: 'chat' });
    expect(useAppStore.getState().messages.find((message) => message.id === 'media-message')?.mediaStatus).toBe('paused');
    expect(mediaRuntimeMocks.complete).not.toHaveBeenCalled();
  });

  it.each(['chat', 'both'] as const)('completes a RunningHub %s task only after its message is saved', async (deliveryMode) => {
    const artifact = { id: 'runninghub-artifact', kind: 'image', deliveryMode, url: 'asset://saved.png', sourceUrl: 'https://cdn.test/image.png',
      filePath: 'saved.png', persistence: 'saved', prompt: '猫', provider: 'runninghubwf', modelId: 'runninghubwf/image', createdAt: 1 };
    let trackingId = '';
    mediaRuntimeMocks.generate.mockImplementation(async (_intent, _projectId, _signal, targetNodeId, taskContext) => {
      trackingId = targetNodeId ?? 'runninghub-message-media-message';
      savePendingTask({ projectId: 'project-1', nodeId: trackingId, nodeType: 'ai-image', provider: 'runninghubwf',
        taskType: 'runninghub-workflow', taskId: 'runninghub-original', submitted: true,
        runninghubRecoveryState: 'save_pending', runninghubMessage: taskContext });
      return artifact;
    });
    let finishSave!: () => void;
    const saved = new Promise<void>((resolve) => { finishSave = resolve; });
    mediaHistoryMocks.persist.mockImplementation((message) => message.mediaResult?.id === artifact.id ? saved : Promise.resolve());
    useAppStore.getState().addMessage({ id: 'media-message', conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1, status: 'done' });
    const generation = triggerMediaGeneration('media-message', { kind: 'image', prompt: '猫', modelRef: 'runninghubwf/image', deliveryMode });
    await Promise.resolve();
    await Promise.resolve();
    expect(getPendingTasksForProject('project-1')).toHaveLength(1);
    if (deliveryMode === 'both') expect(useAppStore.getState().nodes.find((node) => node.id === trackingId)?.data.imageUrl).toBe(artifact.url);
    finishSave();
    await generation;
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('retains a RunningHub task when saving its completed message fails', async () => {
    const artifact = { id: 'runninghub-artifact', kind: 'image', deliveryMode: 'chat', url: 'asset://saved.png', sourceUrl: 'https://cdn.test/image.png',
      filePath: 'saved.png', persistence: 'saved', prompt: '猫', provider: 'runninghubwf', modelId: 'runninghubwf/image', createdAt: 1 };
    mediaRuntimeMocks.generate.mockImplementation(async (_intent, _projectId, _signal, _targetNodeId, taskContext) => {
      savePendingTask({ projectId: 'project-1', nodeId: 'runninghub-message-media-message', nodeType: 'ai-image', provider: 'runninghubwf',
        taskType: 'runninghub-workflow', taskId: 'runninghub-original', submitted: true,
        runninghubRecoveryState: 'save_pending', runninghubMessage: taskContext });
      return artifact;
    });
    mediaHistoryMocks.persist.mockImplementation((message) => message.mediaResult?.id === artifact.id
      ? Promise.reject(new Error('message save failed')) : Promise.resolve());
    useAppStore.getState().addMessage({ id: 'media-message', conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1, status: 'done' });
    await triggerMediaGeneration('media-message', { kind: 'image', prompt: '猫', modelRef: 'runninghubwf/image', deliveryMode: 'chat' });
    expect(getPendingTasksForProject('project-1')).toEqual([expect.objectContaining({ taskId: 'runninghub-original', runninghubRecoveryState: 'save_pending' })]);
  });
});

describe('conversation execution controller', () => {
  it('binds a general request to application scope and caps its tools', () => {
    useAppStore.setState({ currentProjectId: null, projects: [], conversations: [], activeConversationId: null });
    const conversationId = useAppStore.getState().createConversation(GENERAL_ASSISTANT_SCOPE_ID);
    useAppStore.setState({ currentProjectId: 'newly-opened-project' });
    const result = submitConversationMessage({ content: '帮我拟一份学习计划', conversationId, projectId: 'newly-opened-project' });
    if (result.status !== 'started') throw new Error('Expected a general conversation task');
    const task = useAppStore.getState().agentTasks.find((item) => item.id === result.taskId)!;
    expect(task.projectId).toBe(GENERAL_ASSISTANT_SCOPE_ID);
    expect(task.toolAllowlist).toContain('file_read_text');
    expect(task.toolAllowlist?.every(isGeneralAssistantTool)).toBe(true);
    expect(task.toolAllowlist).not.toContain('media_generate');
    expect(useAppStore.getState().projects).toEqual([]);
  });

  it.each(['plan', 'collaborative', 'autonomous'] as const)(
    'fails an unhandled request without a model in %s mode instead of reporting completion', async (mode) => {
      useAppStore.setState((state) => ({
        conversations: state.conversations.map((conversation) => ({ ...conversation, agentMode: mode })),
      }));
      let execution: ConversationAgentExecution | undefined;
      schedulerMocks.schedule.mockImplementation((scheduled) => {
        execution = scheduled as ConversationAgentExecution;
        return { state: 'started', position: 0 };
      });
      const result = submitConversationMessage({
        content: '请检查接口文档并调用 provider_config_preview 生成配置草稿。',
        conversationId: 'conversation-1', mode,
      });
      if (result.status !== 'started') throw new Error('Expected a scheduled request');
      execution!.onStart?.();
      await execution!.run();
      const state = useAppStore.getState();
      expect(state.agentTasks.find((task) => task.id === result.taskId)?.status).toBe('failed');
      if (mode !== 'plan') expect(state.agentTasks.find((task) => task.id === result.taskId)?.dispatches)
        .toEqual([expect.objectContaining({ phase: 'settled', outcome: 'failed' })]);
      const reply = state.messages.find((message) => message.id === result.assistantMessageId)!;
      expect(reply).toMatchObject({ status: 'error', finishReason: 'error' });
      expect(reply.content).toContain('文本模型');
      expect(reply.content).not.toContain('不太确定');
      expect(state.nodes).toEqual([]);
    },
  );

  it('retains image drafts when a long interjection would truncate the image reference', () => {
    const fileName = 'chat-ref-11111111-1111-4111-8111-111111111111.png';
    useAppStore.getState().addChatImageDraft('conversation-1', { fileName, label: '图', size: 4 });
    expect(submitConversationMessage({ content: 'x'.repeat(8_000), conversationId: 'conversation-1',
      imageFileNames: [fileName], dispatchMode: 'interject' })).toEqual({ status: 'ignored' });
    expect(useAppStore.getState().chatImageDrafts['conversation-1']).toHaveLength(1);
    expect(interjectionMocks.enqueue).not.toHaveBeenCalled();
  });

  it('submits an image-only message with a durable reference and consumes only its own pending images', () => {
    const fileName = 'chat-ref-11111111-1111-4111-8111-111111111111.png';
    const otherFile = 'chat-ref-22222222-2222-4222-8222-222222222222.jpg';
    useAppStore.getState().addChatImageDraft('conversation-1', { fileName, label: '角色.png', size: 4 });
    useAppStore.getState().addChatImageDraft('conversation-other', { fileName: otherFile, label: 'Other', size: 4 });
    const result = submitConversationMessage({ content: '', conversationId: 'conversation-1', imageFileNames: [fileName] });
    expect(result.status).toBe('started');
    const state = useAppStore.getState();
    expect(state.messages[0].content).toBe(`@image{${fileName}|${encodeURIComponent('角色.png')}}`);
    expect(state.agentTasks[0].goal).toBe(state.messages[0].content);
    expect(state.chatImageDrafts['conversation-1']).toEqual([]);
    expect(state.chatImageDrafts['conversation-other']).toHaveLength(1);
    expect(JSON.stringify([state.messages, state.agentTasks])).not.toContain('base64');
    expect(schedulerMocks.schedule).toHaveBeenCalledOnce();
  });

  it('rejects an attachment from another conversation before creating messages or tasks', () => {
    const fileName = 'chat-ref-22222222-2222-4222-8222-222222222222.jpg';
    useAppStore.getState().addChatImageDraft('conversation-other', { fileName, label: 'Other', size: 4 });
    expect(submitConversationMessage({ content: '看看', conversationId: 'conversation-1', imageFileNames: [fileName] }))
      .toEqual({ status: 'ignored' });
    expect(useAppStore.getState().messages).toEqual([]);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
    expect(useAppStore.getState().chatImageDrafts['conversation-other']).toHaveLength(1);
  });

  it.each([
    { body: 'data: [DONE]\n\n', contentType: 'text/event-stream', status: 'failed', messageStatus: 'error', text: '未返回' },
    { body: 'data: {"error":{"message":"Provider unavailable"}}\n\n', contentType: 'text/event-stream', status: 'failed', messageStatus: 'error', text: 'Provider unavailable' },
    { body: '{"choices":[{"message":{"content":"已收到你的要求"},"finish_reason":"stop"}]}', contentType: 'application/json', status: 'completed', messageStatus: 'done', text: '已收到你的要求' },
    { body: 'data:{"choices":[{"delta":{"content":"已收到你的要求"},"finish_reason":"stop"}]}\n\n', contentType: 'text/event-stream', status: 'completed', messageStatus: 'done', text: '已收到你的要求' },
    { body: 'data:{"choices":[{"delta":{"content":"尚未完成的回复"},"finish_reason":"length"}]}\n\n', contentType: 'text/event-stream', status: 'paused', messageStatus: 'partial', text: '尚未完成的回复' },
    { body: 'data:{"choices":[{"delta":{"reasoning_content":"api_key=secret-only C:\\\\private\\\\file inspect"}}]}\n\ndata:{"choices":[{"delta":{"content":"已经收到的正文"}}]}\n\ndata:{"error":{"message":"network interrupted"}}\n\n', contentType: 'text/event-stream', status: 'failed', messageStatus: 'error', text: '已经收到的正文' },
  ])('keeps a visible final message for $body', async ({ body, contentType, status, messageStatus, text }) => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        assistantModelId: 'reply-test',
        providers: { ...state.config.providers, reply: { name: 'Reply test', baseUrl: 'https://example.invalid/v1', apiKey: 'test-only' } },
        generalModels: [{ id: 'reply-test', name: 'Reply test', category: 'text', providerConfigId: 'reply', modelId: 'reply-model' }],
      },
      conversations: state.conversations.map((conversation) => ({ ...conversation, agentMode: 'plan' as const })),
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': contentType } }));
    vi.stubGlobal('fetch', fetchMock);
    let execution: ConversationAgentExecution | undefined;
    schedulerMocks.schedule.mockImplementation((scheduled) => {
      execution = scheduled as ConversationAgentExecution;
      return { state: 'started', position: 0 };
    });
    const result = submitConversationMessage({ content: '你好', conversationId: 'conversation-1' });
    if (result.status !== 'started') throw new Error('Expected a scheduled assistant reply');
    expect(execution).toBeDefined();
    execution!.onStart?.();
    await execution!.run();
    const state = useAppStore.getState();
    expect(state.agentTasks.find((task) => task.id === result.taskId)?.status).toBe(status);
    expect(state.messages.find((message) => message.id === result.assistantMessageId)).toMatchObject({
      status: messageStatus,
      content: expect.stringContaining(text),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (body.includes('network interrupted')) {
      const reply = state.messages.find((message) => message.id === result.assistantMessageId)!;
      expect(reply.responseError).toContain('network interrupted');
      expect(reply.reasoning).toContain('[已脱敏凭据]');
      expect(reply.reasoning).not.toContain('secret-only');
      expect(reply.reasoning).not.toContain('C:');
    }
    if (status === 'paused') {
      expect(state.agentTasks.find((task) => task.id === result.taskId)?.pausedReason).toBe('model_output_truncated');
      expect(state.messages.find((message) => message.id === result.assistantMessageId)?.finishReason).toBe('length');
    }
  });

  it('creates the message pair and schedules one Agent task', () => {
    const result = submitConversationMessage({
      content: '  update the canvas  ',
      conversationId: 'conversation-1',
    });

    expect(result.status).toBe('started');
    const state = useAppStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))).toEqual([
      { role: 'user', content: 'update the canvas' },
      { role: 'assistant', content: '' },
    ]);
    expect(state.agentTasks).toHaveLength(1);
    expect(state.messages[1].agentTaskId).toBe(state.agentTasks[0].id);
    expect(schedulerMocks.schedule).toHaveBeenCalledWith(expect.objectContaining({
      taskId: state.agentTasks[0].id,
      conversationId: 'conversation-1',
    }));
  });

  it('captures explicit Skill content and tool restrictions when the task is created', () => {
    useAppStore.setState({
      userSkills: [{
        id: 'skill-1',
        name: 'Canvas audit',
        description: 'Audit the canvas',
        fileName: 'SKILL.md',
        content: '---\nname: Canvas audit\n---\n\n# Fixed audit rules',
        sourceType: 'file',
        manifest: {
          version: '2.0.0',
          allowedTools: ['canvas_get_state'],
        },
        createdAt: 1,
      }],
    });

    submitConversationMessage({
      content: '检查当前项目 @skill{skill-1|Canvas audit}',
      conversationId: 'conversation-1',
    });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.skillBindings).toEqual([{
      skillId: 'skill-1',
      name: 'Canvas audit',
      version: '2.0.0',
      content: '# Fixed audit rules',
      origin: 'user',
      allowedTools: ['canvas_get_state'],
    }]);
    expect(task.toolAllowlist).toEqual(['canvas_get_state']);
  });

  it('snapshots an explicitly selected AgentPackage Skill before the package is disabled', () => {
    useAppStore.setState({
      agentPackageSkills: [{
        id: 'ap-skill-1',
        name: '短剧分镜',
        description: '生成短剧分镜',
        fileName: 'SKILL.md',
        content: '---\nversion: 1.4.1\n---\n# 固定分镜规则',
        sourceType: 'agent-package',
        manifest: { version: '1.4.1', allowedTools: ['canvas_get_state'] },
        createdAt: 2,
        installationId: 'installation-1',
        packageId: 'legacy.drama',
        packageName: 'AI短剧知识库',
        packageVersion: '0.0.0-legacy',
        packageContentHash: 'a'.repeat(64),
        sourceId: 'source:opaque',
        entryPath: '04-分镜设计/storyboard-script/SKILL.md',
        skillRoot: '04-分镜设计/storyboard-script',
        contentHash: 'b'.repeat(64),
        branch: 'domestic',
        packageUserInvocable: true,
        packageAutoInvoke: false,
        mcpSkillReadEnabled: false,
        readOnly: true,
      }],
    });

    submitConversationMessage({
      content: '生成分镜 @skill{ap-skill-1|短剧分镜}',
      conversationId: 'conversation-1',
    });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.skillBindings).toEqual([expect.objectContaining({
      skillId: 'ap-skill-1',
      content: '# 固定分镜规则',
      origin: 'agent-package',
      packageName: 'AI短剧知识库',
      entryPath: '04-分镜设计/storyboard-script/SKILL.md',
      contentHash: 'b'.repeat(64),
    })]);
    useAppStore.setState({ agentPackageSkills: [] });
    expect(task.skillBindings?.[0].content).toBe('# 固定分镜规则');
  });

  it('rejects more explicit Skills than can be represented by the task snapshot', () => {
    useAppStore.setState({
      userSkills: Array.from({ length: 5 }, (_, index) => ({
        id: `skill-${index + 1}`,
        name: `Skill ${index + 1}`,
        description: 'Test skill',
        fileName: 'SKILL.md',
        content: `# Skill ${index + 1}`,
        sourceType: 'file' as const,
        createdAt: index + 1,
      })),
    });
    const refs = useAppStore.getState().userSkills
      .map((item) => `@skill{${item.id}|${item.name}}`)
      .join(' ');

    const result = submitConversationMessage({
      content: `检查画布 ${refs}`,
      conversationId: 'conversation-1',
    });

    expect(result).toMatchObject({ status: 'started', taskId: undefined });
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    expect(useAppStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'error',
      content: '处理失败: 单个任务最多注入 4 个 Skill',
    });
  });

  it('records an interjection without creating another assistant task', () => {
    schedulerMocks.activeTaskId = 'task-active';

    const result = submitConversationMessage({
      content: 'also use the selected nodes',
      conversationId: 'conversation-1',
      dispatchMode: 'interject',
    });

    expect(result).toEqual({ status: 'interjected', taskId: 'task-active' });
    expect(useAppStore.getState().messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'also use the selected nodes',
        agentTaskId: 'task-active',
      }),
    ]);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
  });
});

function arrangePausedTask(partial: Partial<AgentTask> = {}): AgentTask {
  const task: AgentTask = {
    id: 'task-paused',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-user',
    mode: 'autonomous',
    goal: 'keep going',
    status: 'paused',
    steps: [],
    modelRounds: 12,
    toolCallCount: 24,
    resumeCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET },
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
  useAppStore.setState({
    agentTasks: [task],
    messages: [{
      id: 'message-assistant',
      conversationId: 'conversation-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'done',
      agentTaskId: task.id,
    }],
  });
  return task;
}

describe('agent task resume budget', () => {
  it('counts the resume and widens the segment budget within the lifetime cap', () => {
    arrangePausedTask();

    expect(resumeAgentTaskExecution('task-paused')).toEqual({ ok: true });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.resumeCount).toBe(1);
    expect(task.budget).toMatchObject({ maxModelRounds: 24, maxToolCalls: 48 });
    expect(schedulerMocks.schedule).toHaveBeenCalledTimes(1);
  });

  it('refuses a second resume while the task is still queued', () => {
    arrangePausedTask();

    expect(resumeAgentTaskExecution('task-paused')).toEqual({ ok: true });
    expect(resumeAgentTaskExecution('task-paused')).toMatchObject({
      ok: false,
      errorCode: 'AGENT_RESUME_ALREADY_SCHEDULED',
    });

    // 第二次点击既不能重复入队，也不能再吃掉一次继续额度
    expect(schedulerMocks.schedule).toHaveBeenCalledTimes(1);
    const task = useAppStore.getState().agentTasks[0];
    expect(task.resumeCount).toBe(1);
    expect(task.budget.maxModelRounds).toBe(24);
  });

  it('marks a queued resume as queued so the UI stops offering 继续', () => {
    arrangePausedTask();
    schedulerMocks.schedule.mockImplementationOnce((execution: { taskId: string }) => {
      schedulerMocks.scheduledTaskIds.add(execution.taskId);
      return { state: 'queued', position: 1 };
    });

    expect(resumeAgentTaskExecution('task-paused')).toEqual({ ok: true });

    expect(useAppStore.getState().agentTasks[0].status).toBe('queued');
    expect(useAppStore.getState().messages[0].status).toBe('queued');
  });

  it('refuses to resume and stops widening the budget at the lifetime cap', () => {
    const spent = DEFAULT_AGENT_TASK_BUDGET.maxTotalModelRounds;
    arrangePausedTask({
      modelRounds: spent,
      resumeCount: 4,
      budget: { ...DEFAULT_AGENT_TASK_BUDGET, maxModelRounds: spent },
    });

    expect(resumeAgentTaskExecution('task-paused')).toMatchObject({
      ok: false,
      errorCode: 'AGENT_LIFETIME_BUDGET_EXHAUSTED',
    });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.resumeCount).toBe(4);
    expect(task.budget.maxModelRounds).toBe(spent);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
  });
});
