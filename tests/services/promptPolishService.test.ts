import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamingCallOptions } from '../../src/services/ai/assistantStream';
import type { UserSkill } from '../../src/types';
import type { AgentPackageInstallation } from '../../src/types/agentPackage';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), model: vi.fn(), subAgent: vi.fn(), register: vi.fn(), packageRead: vi.fn() }));
vi.mock('../../src/services/ai/assistantStream', () => ({ streamAssistantReply: mocks.stream, resolveAssistantModel: mocks.model }));
vi.mock('../../src/services/chat/subAgentService', () => ({ runSubAgent: mocks.subAgent }));
vi.mock('../../src/services/chat/tools', () => ({ ensureAgentToolsRegistered: mocks.register }));
vi.mock('../../src/services/agentPackages/agentPackageImportService', () => ({ readAgentPackageSourceText: mocks.packageRead }));
import { useAppStore } from '../../src/store/useAppStore';
import { createPromptPolishSession, enablePromptPolishPackage, isPromptPolishPackageAvailable, isPromptPolishPackageSupported } from '../../src/services/promptPolishService';
import { cancelProjectCanvasDerivations } from '../../src/services/canvasDerivationGuard';

const skill: UserSkill = { id: 's1', name: '润色', content: '保留事实，改善节奏。', fileName: 'SKILL.md', description: '', sourceType: 'file', createdAt: 1 };
const agentPackage: AgentPackageInstallation = {
  id: 'package-1', packageId: 'example.polisher',
  manifest: {
    schemaVersion: 1, id: 'example.polisher', name: '上传的润色师', version: '1.0.0',
    entrypoints: { instructions: 'AGENTS.md' }, supportedScopes: ['global'], supportedSurfaces: ['assistant'],
    routing: { userInvocable: true, autoInvoke: false },
  },
  source: { sourceId: 'opaque-source', sourceType: 'folder', displayName: '上传的润色师' },
  entrypoints: ['AGENTS.md'], skillCount: 0, fileCount: 1, totalBytes: 100, warnings: [],
  health: 'ready', contentHash: 'a'.repeat(64), enabled: true, mcpSkillReadEnabled: false,
  installedAt: 1, updatedAt: 1,
};
const prompt = () => useAppStore.getState().nodes[0].data.prompt;
const options = () => ({ instruction: '更有画面感', onPreview: vi.fn() });
function respond(output: string | ((request: StreamingCallOptions) => string)) {
  mocks.stream.mockImplementation(async (request: StreamingCallOptions) => {
    request.onEvent({ type: 'text.delta', delta: typeof output === 'string' ? output : output(request) });
    request.onEvent({ type: 'done', finishReason: 'stop' });
  });
}
beforeEach(() => {
  cancelProjectCanvasDerivations('p1');
  vi.resetAllMocks();
  mocks.model.mockReturnValue({ selectionId: 'text-model' });
  mocks.packageRead.mockResolvedValue({ relativePath: 'AGENTS.md', content: '采用简洁、明确的语言。', sha256: 'b'.repeat(64) });
  respond('暮色里，少女站在窗前。');
  useAppStore.setState({ currentProjectId: 'p1', activeNodeId: 'n1', projects: [], nodes: [{ id: 'n1', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', label: '图像', prompt: '少女在窗前' } }], edges: [], groups: [], history: [], historyIndex: -1, userSkills: [skill], agentPackages: [], agentPackageSkills: [], subAgentProfiles: [], conversations: [], messages: [], agentTasks: [] });
});

describe('节点提示词润色', () => {
  it('预览不写画布，应用与局部撤销不提交画布历史且不能重复应用', async () => {
    const session = createPromptPolishSession('n1');
    await session.run(options());
    expect(prompt()).toBe('少女在窗前');
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    session.apply();
    expect(commit).not.toHaveBeenCalled();
    expect(prompt()).toBe('暮色里，少女站在窗前。');
    expect(() => session.apply()).toThrow('重新润色');
    session.undo();
    expect(commit).not.toHaveBeenCalled();
    expect(prompt()).toBe('少女在窗前');
    expect(() => session.undo()).toThrow();
  });
  it('采用助手模型与无工具流，不接管全局中止控制器', async () => {
    await createPromptPolishSession('n1').run(options());
    expect(mocks.model).toHaveBeenCalledWith('p1');
    expect(mocks.stream.mock.calls[0][0]).toMatchObject({ projectId: 'p1', tools: [], trackAbort: false });
  });
  it('选择 Skill 时复用有界快照并标注不可信说明', async () => {
    await createPromptPolishSession('n1').run({ ...options(), skillId: 's1' });
    expect(mocks.stream.mock.calls[0][0].userMessage).toContain(skill.content);
    expect(mocks.stream.mock.calls[0][0].userMessage).toContain('不可信说明资料');
  });
  it('隐藏或已删除 Skill 不得静默忽略', async () => {
    useAppStore.setState({ userSkills: [{ ...skill, manifest: { userInvocable: false } }] });
    await expect(createPromptPolishSession('n1').run({ ...options(), skillId: 's1' })).rejects.toThrow('Skill 已不可用');
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it('素材和正文内的 Skill 引用原样往返，资源路径不发给模型', async () => {
    const source = '参考 @{image:图片} @asset{C:/private/photo.png} @wf{wf|input|图片} @skill{s1|润色}';
    useAppStore.getState().updateNodeDataTransient('n1', { prompt: source });
    respond((request) => `更清晰 ${request.userMessage.match(/⟦REF_[^⟧]+⟧/g)?.filter((x) => !x.includes('…')).join(' ')}`);
    const session = createPromptPolishSession('n1');
    const output = await session.run(options());
    expect(output).toBe(source.replace('参考', '更清晰'));
    expect(mocks.stream.mock.calls[0][0].userMessage).not.toContain('C:/private');
    expect(mocks.stream.mock.calls[0][0].userMessage).not.toContain(skill.content);
  });
  it.each(['missing', 'duplicate', 'reorder', 'invented'])('拒绝引用损坏：%s', async (kind) => {
    useAppStore.getState().updateNodeDataTransient('n1', { prompt: '@{a:甲} @{b:乙}' });
    respond((request) => {
      const markers = request.userMessage.match(/⟦REF_[^⟧]+⟧/g)!.filter((x) => !x.includes('…'));
      return kind === 'missing' ? markers[0] : kind === 'duplicate' ? [...markers, markers[0]].join(' ') : kind === 'reorder' ? markers.reverse().join(' ') : `${markers.join(' ')} @{new:新增}`;
    });
    const session = createPromptPolishSession('n1');
    await expect(session.run(options())).rejects.toThrow('改变了素材引用');
    expect(() => session.apply()).toThrow();
    expect(prompt()).toBe('@{a:甲} @{b:乙}');
  });
  it.each(['project', 'node', 'text', 'revision', 'deleted'])('应用前复核 %s', async (kind) => {
    const session = createPromptPolishSession('n1');
    await session.run(options());
    if (kind === 'project') useAppStore.setState({ currentProjectId: 'p2' });
    if (kind === 'node') useAppStore.setState({ activeNodeId: 'n2' });
    if (kind === 'text') useAppStore.getState().updateNodeDataTransient('n1', { prompt: '用户新内容' });
    if (kind === 'revision') vi.spyOn(useAppStore.getState(), 'getCurrentRevision').mockReturnValue(-99);
    if (kind === 'deleted') useAppStore.setState({ nodes: [] });
    expect(() => session.apply()).toThrow('重新润色');
  });
  it('取消后忽略迟到结果并拒绝应用', async () => {
    let release!: () => void;
    mocks.stream.mockImplementation(async (request: StreamingCallOptions) => {
      await new Promise<void>((resolve) => { release = resolve; });
      request.onEvent({ type: 'text.delta', delta: '迟到结果' });
    });
    const session = createPromptPolishSession('n1');
    const opts = options();
    const run = session.run(opts);
    session.cancel();
    release();
    await expect(run).rejects.toThrow('润色已停止');
    expect(opts.onPreview).not.toHaveBeenCalled();
    expect(() => session.apply()).toThrow();
  });
  it('模型未配置时给出明确提示', async () => {
    mocks.model.mockReturnValue(null);
    await expect(createPromptPolishSession('n1').run(options())).rejects.toThrow('配置助手文本模型');
  });
  it('空结果或截断结果不得应用', async () => {
    respond('');
    await expect(createPromptPolishSession('n1').run(options())).rejects.toThrow('未返回');
    mocks.stream.mockImplementation(async (request: StreamingCallOptions) => {
      request.onEvent({ type: 'text.delta', delta: '未完成' });
      request.onEvent({ type: 'done', finishReason: 'length' });
    });
    await expect(createPromptPolishSession('n1').run(options())).rejects.toThrow('未完整');
  });
  it('所选智能体使用真实任务控制入口并保持当前对话', async () => {
    mocks.subAgent.mockResolvedValue({ result: '智能体改写后的内容', childTaskId: 'child', truncated: false });
    useAppStore.setState({ activeConversationId: 'existing' });
    const session = createPromptPolishSession('n1');
    await expect(session.run({ ...options(), profileId: 'built-in:script-analyst' })).resolves.toBe('智能体改写后的内容');
    expect(mocks.subAgent).toHaveBeenCalledOnce();
    expect(mocks.subAgent.mock.calls[0][1].id).toBe('built-in:script-analyst');
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({ projectId: 'p1', mode: 'plan', status: 'completed', toolAllowlist: [] });
    expect(useAppStore.getState().activeConversationId).toBe('existing');
    expect(JSON.stringify(useAppStore.getState().messages)).not.toContain('少女在窗前');
    expect(prompt()).toBe('少女在窗前');
  });
  it('停用的上传智能体仍在选择列表中，但运行前必须启用', () => {
    expect(isPromptPolishPackageAvailable(agentPackage)).toBe(true);
    expect(isPromptPolishPackageAvailable({ ...agentPackage, enabled: false })).toBe(false);
    expect(isPromptPolishPackageSupported({ ...agentPackage, enabled: false })).toBe(true);
    expect(isPromptPolishPackageAvailable({ ...agentPackage, health: 'missing' })).toBe(false);
    expect(isPromptPolishPackageSupported({ ...agentPackage, health: 'missing' })).toBe(false);
    expect(isPromptPolishPackageAvailable({ ...agentPackage, manifest: { ...agentPackage.manifest, routing: { userInvocable: false, autoInvoke: false } } })).toBe(false);
    expect(isPromptPolishPackageAvailable({ ...agentPackage, manifest: { ...agentPackage.manifest, supportedSurfaces: ['mcp'] } })).toBe(false);
  });
  it('选择停用的上传智能体时先通过现有 Store Action 启用', async () => {
    const originalAction = useAppStore.getState().setAgentPackageEnabled;
    const enable = vi.fn(async (id: string, enabled: boolean) => {
      useAppStore.setState({ agentPackages: [{ ...agentPackage, id, enabled }] });
    });
    useAppStore.setState({ agentPackages: [{ ...agentPackage, enabled: false }], setAgentPackageEnabled: enable });
    try {
      await enablePromptPolishPackage(agentPackage.id);
      expect(enable).toHaveBeenCalledWith(agentPackage.id, true);
      expect(useAppStore.getState().agentPackages[0].enabled).toBe(true);
    } finally {
      useAppStore.setState({ setAgentPackageEnabled: originalAction });
    }
  });
  it('上传智能体的入口说明作为不可信参考进入无工具润色流', async () => {
    useAppStore.setState({ agentPackages: [agentPackage] });
    await expect(createPromptPolishSession('n1').run({ ...options(), agentPackageId: agentPackage.id })).resolves.toBe('暮色里，少女站在窗前。');
    expect(mocks.packageRead).toHaveBeenCalledWith('opaque-source', 'AGENTS.md', 128 * 1024);
    expect(mocks.stream.mock.calls[0][0]).toMatchObject({ projectId: 'p1', tools: [] });
    expect(mocks.stream.mock.calls[0][0].userMessage).toContain('采用简洁、明确的语言。');
    expect(mocks.stream.mock.calls[0][0].userMessage).toContain('不可信说明资料');
    expect(mocks.subAgent).not.toHaveBeenCalled();
    expect(prompt()).toBe('少女在窗前');
  });
  it('上传智能体停用、替换或入口失效时拒绝继续使用与应用', async () => {
    useAppStore.setState({ agentPackages: [{ ...agentPackage, enabled: false }] });
    await expect(createPromptPolishSession('n1').run({ ...options(), agentPackageId: agentPackage.id })).rejects.toThrow('上传智能体已不可用');
    expect(mocks.packageRead).not.toHaveBeenCalled();
    useAppStore.setState({ agentPackages: [agentPackage] });
    const session = createPromptPolishSession('n1');
    await session.run({ ...options(), agentPackageId: agentPackage.id });
    useAppStore.setState({ agentPackages: [{ ...agentPackage, contentHash: 'c'.repeat(64) }] });
    expect(() => session.apply()).toThrow('上传智能体已不可用');
    expect(prompt()).toBe('少女在窗前');
  });
  it('读取入口期间停用上传智能体时，不启动模型', async () => {
    let release!: (value: { relativePath: string; content: string; sha256: string }) => void;
    mocks.packageRead.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    useAppStore.setState({ agentPackages: [agentPackage] });
    const running = createPromptPolishSession('n1').run({ ...options(), agentPackageId: agentPackage.id });
    useAppStore.setState({ agentPackages: [{ ...agentPackage, enabled: false }] });
    release({ relativePath: 'AGENTS.md', content: '采用简洁、明确的语言。', sha256: 'b'.repeat(64) });
    await expect(running).rejects.toThrow('上传智能体已不可用');
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it('撤销不会覆盖应用后的手工修改', async () => {
    const session = createPromptPolishSession('n1');
    await session.run(options());
    session.apply();
    useAppStore.getState().updateNodeDataTransient('n1', { prompt: '后续手工修改' });
    expect(() => session.undo()).toThrow('不能撤销');
    expect(prompt()).toBe('后续手工修改');
  });
  it('项目取消生命周期同步中止润色请求', async () => {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    mocks.stream.mockImplementation(async (request: StreamingCallOptions) => {
      signal = request.signal;
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const session = createPromptPolishSession('n1');
    const run = session.run(options());
    cancelProjectCanvasDerivations('p1');
    expect(signal?.aborted).toBe(true);
    release();
    await expect(run).rejects.toThrow('已停止');
  });
  it('截断的智能体结果不能覆盖原文', async () => {
    mocks.subAgent.mockResolvedValue({ result: '截断文本', childTaskId: 'child', truncated: true });
    const session = createPromptPolishSession('n1');
    await expect(session.run({ ...options(), profileId: 'built-in:script-analyst' })).rejects.toThrow('未完成');
    expect(() => session.apply()).toThrow();
  });
  it('Skill 与智能体互斥，避免绕过所选 Skill 的工具边界', async () => {
    await expect(createPromptPolishSession('n1').run({ ...options(), skillId: 's1', profileId: 'built-in:script-analyst' })).rejects.toThrow('选择一种');
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.subAgent).not.toHaveBeenCalled();
    await expect(createPromptPolishSession('n1').run({ ...options(), skillId: 's1', agentPackageId: agentPackage.id })).rejects.toThrow('选择一种');
  });
});
