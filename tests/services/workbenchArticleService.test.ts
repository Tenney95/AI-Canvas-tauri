/** 文章候选不覆盖后续编辑，也不把停止或未完整返回的内容当作新稿。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamingCallOptions } from '../../src/services/ai/assistantStream';
import type { AgentTaskStatus } from '../../src/types/agent';
import type { AgentTeamProfile } from '../../src/types/agentTeam';
import type { WorkbenchArticleCapture, WorkbenchArticleTarget } from '../../src/types/workbenchArticle';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), model: vi.fn(), windowLabel: 'main', startTeam: vi.fn(), readArtifact: vi.fn(),
  stopTask: vi.fn(), cancelScheduled: vi.fn(), listeners: new Set<() => void>(),
  tasks: [] as Array<{ id: string; status: AgentTaskStatus; errorMessage?: string;
    executionKind?: 'team'; projectId?: string; conversationId?: string;
    teamRun?: { resultArtifactId?: string; artifacts: Array<{ id: string; kind: string }> } }> }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: mocks.windowLabel }) }));
vi.mock('../../src/services/fileService', () => ({ isTauriEnv: () => true }));
vi.mock('../../src/services/ai/assistantStream', () => ({ streamAssistantReply: mocks.stream, resolveAssistantModel: mocks.model }));
vi.mock('../../src/services/chat/subAgentMaterials', () => ({ sanitizeDomainText: (value: string) => value }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: () => ({ agentTasks: mocks.tasks }),
  subscribe: (listener: () => void) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; },
} }));
vi.mock('../../src/services/chat/teams/teamInvocationService', () => ({ startTeamInvocation: mocks.startTeam, readTeamTaskArtifact: mocks.readArtifact }));
vi.mock('../../src/services/chat/agentTaskControl', () => ({ stopAgentTask: mocks.stopTask }));
vi.mock('../../src/services/chat/agentScheduler', () => ({ cancelScheduledAgentExecution: mocks.cancelScheduled }));

import { createWorkbenchArticleSession } from '../../src/services/workbenchArticleService';

const target: WorkbenchArticleTarget = { kind: 'outline', episodeId: 'episode' };
function session(content = '原稿', getExecution?: NonNullable<Parameters<typeof createWorkbenchArticleSession>[0]>['getExecution']) {
  let current: WorkbenchArticleCapture = { target, projectId: 'episode', key: 'series:epoch:episode:outline',
    label: '本集大纲', content, version: 1 };
  const apply = vi.fn();
  const editor = createWorkbenchArticleSession({ readTarget: () => ({ ...current }), applyTarget: apply, getExecution });
  return { editor, apply, change: (patch: Partial<WorkbenchArticleCapture>) => { current = { ...current, ...patch }; } };
}
const profile: AgentTeamProfile = { version: 1, name: '助手团队', roles: { architect: 'general/architect', writer: 'general/writer',
  continuity: 'general/continuity', dialogue: 'general/dialogue', director: 'general/director', storyboard: 'general/storyboard', editor: 'general/editor' },
  maxCalls: 12, maxTotalTokens: 24000, maxOutputChars: 32000 };
function teamExecution() {
  return { projectId: 'actual-canvas', conversationId: 'same-series-conversation', selection: { kind: 'team' as const, templateId: 'script' as const },
    mode: 'collaborative' as const, profile };
}
function notifyTasks() { [...mocks.listeners].forEach((listener) => listener()); }
const taskIdentity = { executionKind: 'team' as const, projectId: 'actual-canvas', conversationId: 'same-series-conversation' };
function completeTeam(requestId: string, kind = 'revision') {
  const taskId = `team-${requestId}`;
  mocks.tasks = [{ ...taskIdentity, id: taskId, status: 'completed', teamRun: { resultArtifactId: 'final', artifacts: [{ id: 'final', kind }] } }];
  notifyTasks();
  return { taskId, conversationId: 'same-series-conversation', userMessageId: 'user', assistantMessageId: 'assistant' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.windowLabel = 'main';
  mocks.tasks = []; mocks.listeners.clear();
  mocks.readArtifact.mockResolvedValue('团队修改后的完整文章');
  mocks.stopTask.mockImplementation((taskId: string) => {
    const task = mocks.tasks.find((item) => item.id === taskId);
    if (task) task.status = 'stopped';
    notifyTasks();
  });
  mocks.model.mockReturnValue({ selectionId: 'assistant-text-model' });
  mocks.stream.mockImplementation(async (request: StreamingCallOptions) => {
    request.onEvent({ type: 'done', finishReason: 'stop' });
    return '修改后的完整文章';
  });
});

describe('工作台文章改写', () => {
  it('提交视图后接入的团队和单模型选择均使用最新执行入口', async () => {
    const editor = createWorkbenchArticleSession();
    const source: WorkbenchArticleCapture = { target, projectId: 'episode', key: 'article', label: '大纲', content: '原稿', version: 1 };
    const apply = vi.fn();
    editor.setTargetAccess({ readTarget: () => source, applyTarget: apply,
      getExecution: () => ({ ...teamExecution(), selection: { kind: 'single' }, modelId: 'general/old' }) });
    const execution = teamExecution();
    editor.setTargetAccess({ readTarget: () => source, applyTarget: apply, getExecution: () => execution });
    mocks.startTeam.mockImplementationOnce(async (input: { requestId: string }) => completeTeam(input.requestId));
    const candidate = await editor.handle({ type: 'article_generate', target, instruction: '整理结构' });
    expect(candidate).toMatchObject({ text: '团队修改后的完整文章' });
    expect(mocks.startTeam).toHaveBeenCalledWith(expect.objectContaining({ projectId: execution.projectId,
      conversationId: execution.conversationId, mode: execution.mode, templateId: execution.selection.templateId, profile }));
    expect(mocks.model).not.toHaveBeenCalled();
    await editor.handle({ type: 'article_discard_candidate' });
    editor.setTargetAccess({ readTarget: () => source, applyTarget: apply,
      getExecution: () => ({ ...teamExecution(), selection: { kind: 'single' }, modelId: 'general/new' }) });
    await editor.handle({ type: 'article_generate', target, instruction: '精简' });
    expect(mocks.model).toHaveBeenCalledExactlyOnceWith('episode', 'general/new');
    expect(mocks.startTeam).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('单模型沿用显式选择，不借用其他模型或团队运行器', async () => {
    const { editor } = session('原稿', () => ({ ...teamExecution(), selection: { kind: 'single' }, modelId: 'general/chosen' }));
    await editor.handle({ type: 'article_generate', target, instruction: '增强冲突' });
    expect(mocks.model).toHaveBeenCalledWith('episode', 'general/chosen');
    expect(mocks.startTeam).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('助手没有已选择模型时阻止回退到文章所属分集的其他模型', async () => {
    const { editor } = session('原稿', () => ({ ...teamExecution(), selection: { kind: 'single' } }));
    await expect(editor.handle({ type: 'article_generate', target, instruction: '增强冲突' })).rejects.toThrow('选择可用');
    expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('团队按实际助手项目、模式和模板执行，完整文章只作为材料，成果仍需显式采用', async () => {
    mocks.startTeam.mockImplementation(async (input: { requestId: string }) => completeTeam(input.requestId));
    const { editor, apply } = session('不得出现在聊天消息的原稿', teamExecution);
    const candidate = await editor.handle({ type: 'article_generate', target, instruction: '增强冲突' });
    const input = mocks.startTeam.mock.calls[0][0];
    expect(input).toMatchObject({ projectId: 'actual-canvas', conversationId: 'same-series-conversation', mode: 'collaborative',
      profile, templateId: 'script', context: { source: 'script-workbench' }, creationProfileSource: 'conversation' });
    expect(input.context).not.toHaveProperty('target');
    expect(input.content).not.toContain('不得出现在聊天消息的原稿');
    expect(input.materials).toContain('不得出现在聊天消息的原稿');
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.readArtifact).toHaveBeenCalledWith(`team-${input.requestId}`, 'final');
    expect(apply).not.toHaveBeenCalled();
    if (typeof candidate === 'boolean') throw new Error('Expected article candidate');
    await editor.handle({ type: 'article_apply', candidateId: candidate.id });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ content: '不得出现在聊天消息的原稿' }), '团队修改后的完整文章');
    expect(mocks.listeners.size).toBe(0);
    editor.dispose();
  });

  it('等待真实团队完成；生成期间文章变更会拒绝结果', async () => {
    let requestId = '';
    mocks.startTeam.mockImplementation(async (input: { requestId: string }) => {
      requestId = input.requestId;
      mocks.tasks = [{ ...taskIdentity, id: `team-${requestId}`, status: 'running' }]; notifyTasks();
      return { taskId: `team-${requestId}`, conversationId: taskIdentity.conversationId };
    });
    const { editor, apply, change } = session('原稿', teamExecution);
    const generating = editor.handle({ type: 'article_generate', target, instruction: '整理结构' });
    await vi.waitFor(() => expect(mocks.startTeam).toHaveBeenCalledOnce());
    expect(editor.summary().generating).toBe(true);
    expect(mocks.readArtifact).not.toHaveBeenCalled();
    change({ content: '手写新稿', version: 2 });
    completeTeam(requestId);
    await expect(generating).rejects.toThrow('已变化');
    expect(apply).not.toHaveBeenCalled();
    expect(editor.summary().hasCandidate).toBe(false);
    expect(mocks.listeners.size).toBe(0);
    editor.dispose();
  });

  it.each(['paused', 'failed', 'stopped'] as const)('团队%s时失败关闭，不自动继续或读取不完整产物', async (status) => {
    mocks.startTeam.mockImplementation(async (input: { requestId: string }) => {
      const taskId = `team-${input.requestId}`; mocks.tasks = [{ ...taskIdentity, id: taskId, status }]; notifyTasks();
      return { taskId, conversationId: taskIdentity.conversationId };
    });
    const { editor } = session('原稿', teamExecution);
    await expect(editor.handle({ type: 'article_generate', target, instruction: '修改' })).rejects.toThrow('未完成');
    expect(mocks.readArtifact).not.toHaveBeenCalled();
    expect(mocks.startTeam).toHaveBeenCalledOnce();
    expect(editor.summary().hasCandidate).toBe(false);
    expect(mocks.listeners.size).toBe(0);
    editor.dispose();
  });

  it('团队完成但缺失正文或只返回审稿报告时，不能用报告覆盖文章', async () => {
    for (const kind of ['missing', 'review', 'decision']) {
      mocks.startTeam.mockImplementationOnce(async (input: { requestId: string }) => {
        const result = completeTeam(input.requestId, kind);
        if (kind === 'missing') mocks.tasks[0].teamRun!.resultArtifactId = undefined;
        return result;
      });
      const { editor, apply } = session('原稿', teamExecution);
      await expect(editor.handle({ type: 'article_generate', target, instruction: '修改' })).rejects.toThrow(kind === 'missing' ? '完整正文' : '审稿报告');
      expect(apply).not.toHaveBeenCalled(); expect(editor.summary().hasCandidate).toBe(false); editor.dispose();
    }
    expect(mocks.readArtifact).not.toHaveBeenCalled();
  });

  it('默认审稿模板在发起付费团队前拒绝，自定义正文交付图按真实图执行', async () => {
    const review = session('原稿', () => ({ ...teamExecution(), selection: { kind: 'team', templateId: 'review' } }));
    await expect(review.editor.handle({ type: 'article_generate', target, instruction: '修改' })).rejects.toThrow('审稿报告');
    expect(mocks.startTeam).not.toHaveBeenCalled(); review.editor.dispose();
    mocks.startTeam.mockImplementationOnce(async (input: { requestId: string }) => completeTeam(input.requestId, 'draft'));
    const custom = session('原稿', () => ({ ...teamExecution(), selection: { kind: 'team', templateId: 'review' },
      profile: { ...profile, graph: { version: 1, finalTaskId: 'article', nodes: [
        { id: 'article', roleId: 'writer', title: '完整文章', kind: 'draft', dependsOn: [] },
      ] } } }));
    await expect(custom.editor.handle({ type: 'article_generate', target, instruction: '修改' })).resolves.toMatchObject({ text: '团队修改后的完整文章' });
    expect(mocks.startTeam).toHaveBeenCalledOnce(); custom.editor.dispose();
  });

  it('自定义图无效或最终交付只有裁决时，发起前失败且不退回默认正文模板', async () => {
    const invalid = session('原稿', () => ({ ...teamExecution(), profile: { ...profile, graph: { version: 1, finalTaskId: 'missing', nodes: [] } } }));
    await expect(invalid.editor.handle({ type: 'article_generate', target, instruction: '修改' })).rejects.toThrow('团队任务图');
    invalid.editor.dispose();
    const { createTemplateTeamGraph } = await import('../../src/services/chat/teams/teamGraphService');
    const report = session('原稿', () => ({ ...teamExecution(), profile: { ...profile, graph: createTemplateTeamGraph('review') } }));
    await expect(report.editor.handle({ type: 'article_generate', target, instruction: '修改' })).rejects.toThrow('审稿报告');
    expect(mocks.startTeam).not.toHaveBeenCalled(); report.editor.dispose();
  });

  it.each(['projectId', 'conversationId'] as const)('团队任务%s不匹配时拒绝读取其他任务的结果', async (field) => {
    mocks.startTeam.mockImplementation(async (input: { requestId: string }) => {
      const result = completeTeam(input.requestId); mocks.tasks[0][field] = 'other-owner'; return result;
    });
    const { editor, apply } = session('原稿', teamExecution);
    await expect(editor.handle({ type: 'article_generate', target, instruction: '修改' })).rejects.toThrow('身份已变化');
    expect(mocks.readArtifact).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    expect(mocks.listeners.size).toBe(0); editor.dispose();
  });

  it('团队准备失败后释放订阅并保留原稿', async () => {
    mocks.startTeam.mockRejectedValueOnce(new Error('团队模型尚未配置'));
    const { editor, apply } = session('原稿', teamExecution);
    await expect(editor.handle({ type: 'article_generate', target, instruction: '修改' })).rejects.toThrow('尚未配置');
    expect(mocks.readArtifact).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    expect(editor.summary().generating).toBe(false); expect(mocks.listeners.size).toBe(0); editor.dispose();
  });

  it.each(['cancel', 'dispose'] as const)('准备期间%s后，迟到创建的本次团队被停止且不读取成果', async (action) => {
    const ready = deferred<{ taskId: string; conversationId: string }>();
    let requestId = '';
    mocks.startTeam.mockImplementation((input: { requestId: string }) => { requestId = input.requestId; return ready.promise; });
    const { editor, apply } = session('原稿', teamExecution);
    const generating = editor.handle({ type: 'article_generate', target, instruction: '修改' });
    await vi.waitFor(() => expect(mocks.startTeam).toHaveBeenCalledOnce());
    if (action === 'dispose') editor.dispose(); else await editor.handle({ type: 'article_cancel' });
    const taskId = `team-${requestId}`;
    mocks.tasks = [{ id: 'another-task', status: 'running' }, { ...taskIdentity, id: taskId, status: 'queued' }]; notifyTasks();
    expect(mocks.tasks.find((task) => task.id === taskId)?.status).toBe('stopped');
    expect(mocks.tasks[0].status).toBe('running');
    ready.resolve({ taskId, conversationId: taskIdentity.conversationId });
    await expect(generating).rejects.toThrow(action === 'dispose' ? '已关闭' : '已停止');
    expect(mocks.stopTask).toHaveBeenCalledWith(taskId);
    expect(mocks.stopTask).not.toHaveBeenCalledWith('another-task');
    expect(mocks.cancelScheduled).toHaveBeenCalledWith(taskId);
    expect(mocks.readArtifact).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    expect(mocks.listeners.size).toBe(0);
    editor.dispose();
  });

  it('提交视图后接入编辑器，回执和采用始终使用最新入口', async () => {
    const editor = createWorkbenchArticleSession();
    await expect(editor.handle({ type: 'article_generate', target, instruction: '增强冲突' })).rejects.toThrow('当前没有可编辑的文章');
    const source: WorkbenchArticleCapture = { target, projectId: 'episode', key: 'article', label: '本集大纲', content: '原稿', version: 1 };
    const oldApply = vi.fn();
    editor.setTargetAccess({ readTarget: () => source, applyTarget: oldApply });
    const result = deferred<string>();
    mocks.stream.mockReturnValueOnce(result.promise);
    const generating = editor.handle({ type: 'article_generate', target, instruction: '精简' });
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledOnce());
    const newApply = vi.fn();
    editor.setTargetAccess({ readTarget: () => ({ ...source, content: '继续手写', version: 2 }), applyTarget: newApply });
    result.resolve('迟到的旧结果');
    await expect(generating).rejects.toThrow('已变化');
    const candidate = await editor.handle({ type: 'article_generate', target, instruction: '精简' });
    if (typeof candidate === 'boolean') throw new Error('Expected article candidate');
    await editor.handle({ type: 'article_apply', candidateId: candidate.id });
    expect(oldApply).not.toHaveBeenCalled();
    expect(newApply).toHaveBeenCalledWith(expect.objectContaining({ content: '继续手写', version: 2 }), '修改后的完整文章');
    editor.dispose();
  });

  it('生成只返回预览，显式采用后才交给原编辑器；摘要不携带正文', async () => {
    const { editor, apply } = session();
    const candidate = await editor.handle({ type: 'article_generate', target, instruction: '增强冲突' });
    if (typeof candidate === 'boolean') throw new Error('Expected article candidate');
    expect(apply).not.toHaveBeenCalled();
    expect(editor.summary()).toEqual({ generating: false, hasCandidate: true, targetLabel: '本集大纲' });
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ tools: [], sensitive: true,
      resolveVisualReferences: false, projectId: 'episode', modelId: 'assistant-text-model' }));
    await expect(editor.handle({ type: 'article_apply', candidateId: candidate.id })).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ content: '原稿', version: 1 }), '修改后的完整文章');
    editor.dispose();
  });

  it('采用前正文或版本变化时拒绝旧候选，不覆盖后续手写输入', async () => {
    const { editor, apply, change } = session();
    const candidate = await editor.handle({ type: 'article_generate', target, instruction: '精简表达' });
    if (typeof candidate === 'boolean') throw new Error('Expected article candidate');
    change({ content: '继续手写的稿件', version: 2 });
    await expect(editor.handle({ type: 'article_apply', candidateId: candidate.id })).rejects.toThrow('已变化');
    expect(apply).not.toHaveBeenCalled();
    expect(editor.summary().hasCandidate).toBe(false);
    editor.dispose();
  });

  it('生成期间切换文章后拒绝旧回执；停止后也不采纳忽略中止的模型结果', async () => {
    const first = deferred<string>();
    mocks.stream.mockReturnValueOnce(first.promise);
    const { editor, apply, change } = session();
    const generating = editor.handle({ type: 'article_generate', target, instruction: '整理结构' });
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledOnce());
    change({ key: 'another-article' });
    first.resolve('旧文章结果');
    await expect(generating).rejects.toThrow('已变化');
    const second = deferred<string>();
    mocks.stream.mockReturnValueOnce(second.promise);
    const stopped = editor.handle({ type: 'article_generate', target, instruction: '调整节奏' });
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(2));
    await editor.handle({ type: 'article_cancel' });
    second.resolve('停止后迟到的结果');
    await expect(stopped).rejects.toThrow('已停止');
    expect(apply).not.toHaveBeenCalled();
    expect(editor.summary().hasCandidate).toBe(false);
    editor.dispose();
  });

  it('超长文章拒绝整篇改写，空白文章可按需求起稿，旧候选ID不能丢弃当前结果', async () => {
    const long = session('字'.repeat(12_001));
    await expect(long.editor.handle({ type: 'article_generate', target, instruction: '改写' })).rejects.toThrow('12000');
    expect(mocks.stream).not.toHaveBeenCalled();
    long.editor.dispose();
    const blank = session('');
    const candidate = await blank.editor.handle({ type: 'article_generate', target, instruction: '写一段悬疑开场' });
    if (typeof candidate === 'boolean') throw new Error('Expected article candidate');
    await expect(blank.editor.handle({ type: 'article_discard_candidate', candidateId: 'previous-candidate' })).resolves.toBe(false);
    expect(blank.editor.summary().hasCandidate).toBe(true);
    blank.editor.dispose();
  });

  it('模型length结束、工具调用或超长输出都不能成为候选', async () => {
    const events: Parameters<StreamingCallOptions['onEvent']>[0][] = [{ type: 'done', finishReason: 'length' },
      { type: 'tool.call.final', call: { callId: 'call', toolId: 'unexpected-tool', input: {} } }];
    for (const event of events) {
      mocks.stream.mockImplementationOnce(async (request: StreamingCallOptions) => {
        request.onEvent(event);
        return '不完整结果';
      });
      const { editor } = session();
      await expect(editor.handle({ type: 'article_generate', target, instruction: '改写' })).rejects.toThrow('未完整');
      expect(editor.summary().hasCandidate).toBe(false);
      editor.dispose();
    }
    mocks.stream.mockResolvedValueOnce('字'.repeat(32_001));
    const { editor } = session();
    await expect(editor.handle({ type: 'article_generate', target, instruction: '改写' })).rejects.toThrow('过长');
    editor.dispose();
  });

  it('独立窗口不能自行创建模型改写会话', () => {
    mocks.windowLabel = 'script-workbench';
    expect(() => session()).toThrow('主窗口');
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});
