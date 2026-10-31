/**
 * detachedChatSyncController — 回归测试：detached chat sync controller。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAction } from '../../../src/services/chat/chatWindowService';

const conversationControllerMocks = vi.hoisted(() => ({
  submit: vi.fn(),
  resolveApproval: vi.fn(() => true),
  resume: vi.fn(() => ({ ok: true as const })),
}));

vi.mock('../../../src/services/chat/conversationExecutionController', () => ({
  getAgentModeToast: vi.fn(() => 'mode changed'),
  resolveConversationAgentApproval: conversationControllerMocks.resolveApproval,
  resumeAgentTaskExecution: conversationControllerMocks.resume,
  submitConversationMessage: conversationControllerMocks.submit,
}));

import {
  buildDetachedChatSnapshot,
  buildChatModelCatalog,
  createDetachedChatSyncController,
  handleDetachedChatAction,
  projectChatNodes,
} from '../../../src/services/chat/detachedChatSyncController';
import { applyChatStatePatch, createChatStatePatch, receiveChatStateSync, type ChatStateSync, type ChatWindowState } from '../../../src/services/chat/chatWindowService';
import { runAgentTask } from '../../../src/services/chat/agentTaskControl';
import { useAppStore } from '../../../src/store/useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../../src/services/chat/assistantScope';

function arrangeDetachedState(): void {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    chatOpen: false,
    chatPanelDetached: true,
    currentProjectId: 'project-1',
    activeConversationId: 'conversation-1',
    projects: [{
      id: 'project-1',
      name: 'Detached project',
      createdAt: 1,
      updatedAt: 1,
    }],
    conversations: [{
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Detached conversation',
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
  arrangeDetachedState();
  conversationControllerMocks.submit.mockReset();
  conversationControllerMocks.resolveApproval.mockReset();
  conversationControllerMocks.resolveApproval.mockReturnValue(true);
  conversationControllerMocks.resume.mockReset();
  conversationControllerMocks.resume.mockReturnValue({ ok: true });
});

describe('detached chat sync controller', () => {
  it('creates and sends the first general conversation through the main store on the start page', () => {
    useAppStore.setState({ currentProjectId: null, activeConversationId: null, conversations: [] });
    handleDetachedChatAction({ type: 'send_message', content: '帮我写一份提纲' }, vi.fn());
    const state = useAppStore.getState();
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].projectId).toBe(GENERAL_ASSISTANT_SCOPE_ID);
    expect(conversationControllerMocks.submit).toHaveBeenCalledWith(expect.objectContaining({
      projectId: GENERAL_ASSISTANT_SCOPE_ID, conversationId: state.conversations[0].id,
    }));
    expect(state.projects.map((project) => project.id)).toEqual(['project-1']);
  });

  it('keeps an image request bound to the active episode when its conversation belongs to the series', () => {
    useAppStore.setState({ currentProjectId: 'episode-1', projects: [
      ...useAppStore.getState().projects,
      { id: 'episode-1', parentId: 'project-1', episodeNo: 1, name: 'Episode', createdAt: 1, updatedAt: 1 },
    ] });
    handleDetachedChatAction({ type: 'send_message', conversationId: 'conversation-1', content: '看看', imageFileNames: [] }, vi.fn());
    expect(conversationControllerMocks.submit).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'episode-1' }));
  });

  it('retains detached text when image validation rejects the submission', () => {
    conversationControllerMocks.submit.mockReturnValueOnce({ status: 'ignored' });
    handleDetachedChatAction({ type: 'send_message', content: '保留我的输入', conversationId: 'conversation-1',
      imageFileNames: ['chat-ref-11111111-1111-4111-8111-111111111111.png'] }, vi.fn());
    expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('保留我的输入');
  });

  it('synchronizes pending image metadata through snapshots and patches and routes removal to the main store', () => {
    const fileName = 'chat-ref-11111111-1111-4111-8111-111111111111.png';
    const before = buildDetachedChatSnapshot(useAppStore.getState());
    useAppStore.getState().addChatImageDraft('conversation-1', { fileName, label: '参考图.png', size: 4 });
    const withImage = buildDetachedChatSnapshot(useAppStore.getState());
    const patched = applyChatStatePatch(before, createChatStatePatch(before, withImage));
    expect(patched.imageDrafts).toEqual([{ fileName, label: '参考图.png', size: 4 }]);
    handleDetachedChatAction({ type: 'send_message', conversationId: 'conversation-1', content: '', imageFileNames: [fileName] }, vi.fn());
    expect(conversationControllerMocks.submit).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1', content: '', imageFileNames: [fileName],
    }));
    handleDetachedChatAction({ type: 'remove_image_attachment', conversationId: 'conversation-1', fileName }, vi.fn());
    const removed = buildDetachedChatSnapshot(useAppStore.getState());
    expect(applyChatStatePatch(patched, createChatStatePatch(withImage, removed)).imageDrafts).toEqual([]);
  });

  it('synchronizes submit shortcuts after config hydration and saves detached changes in the main store', async () => {
    const saveConfig = vi.fn(async () => undefined);
    useAppStore.setState((state) => ({
      config: { ...state.config, promptSubmitShortcut: 'alt-enter' },
      saveConfig,
    }));
    let mirror: ChatWindowState | null = null;
    const readMirror = (): ChatWindowState | null => mirror;
    let onAction!: (action: ChatAction) => void;
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { mirror = receiveChatStateSync(mirror, structuredClone(sync)); },
      initListener: async (handler) => { onAction = handler; return () => undefined; },
    });
    await controller.start();
    try {
      await vi.waitFor(() => expect(readMirror()).not.toBeNull());
      expect(readMirror()?.snapshot.promptSubmitShortcut).toBeUndefined();
      useAppStore.setState({ configHydrated: true });
      await vi.waitFor(() => expect(readMirror()?.snapshot.promptSubmitShortcut).toBe('alt-enter'));

      onAction({ type: 'set_prompt_submit_shortcut', shortcut: 'ctrl-enter' });
      expect(useAppStore.getState().config.promptSubmitShortcut).toBe('ctrl-enter');
      expect(saveConfig).toHaveBeenCalledWith({ silent: true });
      await vi.waitFor(() => expect(readMirror()?.snapshot.promptSubmitShortcut).toBe('ctrl-enter'));

      useAppStore.setState({ configHydrated: false });
      await vi.waitFor(() => expect(readMirror()?.snapshot.promptSubmitShortcut).toBeUndefined());
    } finally {
      controller.dispose();
    }
  });

  it('rejects shortcut changes before config hydration and rejects unsupported event values', () => {
    const saveConfig = vi.fn(async () => undefined);
    const requestSync = vi.fn();
    useAppStore.setState({ saveConfig });
    const originalConfig = useAppStore.getState().config;
    handleDetachedChatAction({ type: 'set_prompt_submit_shortcut', shortcut: 'alt-enter' }, requestSync);
    expect(useAppStore.getState().config).toBe(originalConfig);

    useAppStore.setState({ configHydrated: true });
    handleDetachedChatAction({ type: 'set_prompt_submit_shortcut', shortcut: 'meta-enter' } as unknown as ChatAction, requestSync);
    expect(useAppStore.getState().config).toBe(originalConfig);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('uses the same branded and visible model options as the embedded chat, including workflows', () => {
    useAppStore.setState((state) => ({
      config: { ...state.config, providers: {
        cccapi: { name: 'CCC API', apiKey: 'do-not-sync-key', baseUrl: 'https://private.example/v1', catalogId: 'cccapi', visibleModelCategories: ['text', 'image'] },
      }, generalModels: [
        { id: 'text-1', name: '文本模型', modelId: 'text-model', category: 'text', providerConfigId: 'cccapi' },
        { id: 'image-1', name: '图片模型', modelId: 'image-model', category: 'image', providerConfigId: 'cccapi' },
        { id: 'hidden-video', name: '隐藏视频', modelId: 'video-model', category: 'video', providerConfigId: 'cccapi' },
      ] },
      workflows: [{ id: 'local-image', name: '本地图像工作流', category: 'ai-image', fileName: 'local.json', fileContent: 'PRIVATE_WORKFLOW_BODY', createdAt: 1 }],
    }));
    const state = useAppStore.getState();
    const catalog = buildChatModelCatalog(state);
    const snapshot = buildDetachedChatSnapshot(state);
    expect(snapshot.assistantModelGroups).toBe(catalog.assistantModelGroups);
    expect(snapshot.assistantModelGroups).toContainEqual(expect.objectContaining({
      id: 'general-provider-cccapi', models: [expect.objectContaining({ value: 'general/text-1' })],
    }));
    expect(snapshot.mediaModelOptions).toBe(catalog.mediaModelOptions);
    expect(snapshot.mediaModelOptions).toContainEqual(expect.objectContaining({ value: 'comfyui/local-image', workflowId: 'local-image' }));
    expect(snapshot.mediaModelOptions.some((option) => option.value === 'general/hidden-video')).toBe(false);
    expect(snapshot.mediaModelAvailability?.['comfyui/local-image']).toBe(true);
    for (const secret of ['do-not-sync-key', 'private.example', 'PRIVATE_WORKFLOW_BODY']) expect(JSON.stringify(snapshot)).not.toContain(secret);
    useAppStore.setState({ workflows: [] });
    expect(buildDetachedChatSnapshot(useAppStore.getState()).mediaModelOptions.some((option) => option.workflowId === 'local-image')).toBe(false);
  });

  it('receives only valid revision chains and ignores old snapshots without reverting progress', () => {
    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());
    const current = receiveChatStateSync(null, { type: 'snapshot', revision: 10, snapshot })!;
    useAppStore.getState().setChatPanelView('tasks');
    const nextSnapshot = buildDetachedChatSnapshot(useAppStore.getState());
    const patch = createChatStatePatch(snapshot, nextSnapshot);
    expect(receiveChatStateSync(null, { type: 'patch', baseRevision: 0, revision: 1, patch })).toBeNull();
    expect(receiveChatStateSync(current, { type: 'patch', baseRevision: 9, revision: 11, patch })).toBeNull();
    const next = receiveChatStateSync(current, { type: 'patch', baseRevision: 10, revision: 11, patch })!;
    expect(next.snapshot.panelView).toBe('tasks');
    expect(receiveChatStateSync(next, { type: 'snapshot', revision: 10, snapshot })).toBe(next);
    expect(receiveChatStateSync(next, { type: 'patch', baseRevision: 10, revision: 11, patch })).toBe(next);
  });

  it('keeps one running task and its streamed messages when docking and reopening', async () => {
    const task = useAppStore.getState().createAgentTask({
      projectId: 'project-1', conversationId: 'conversation-1', userMessageId: 'user-1',
      mode: 'collaborative', goal: '继续回答',
    });
    let finish!: (outcome: 'completed') => void;
    const executor = vi.fn((_signal: AbortSignal) => new Promise<'completed'>((resolve) => { finish = resolve; }));
    const running = runAgentTask(task.id, executor);
    let mirror: ChatWindowState | null = null;
    const readMirror = (): ChatWindowState | null => mirror;
    let onAction!: (action: ChatAction) => void;
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { mirror = receiveChatStateSync(mirror, structuredClone(sync)); },
      initListener: async (handler) => { onAction = handler; return () => undefined; },
    });
    await controller.start();
    try {
      await vi.waitFor(() => expect(readMirror()?.snapshot.agentTasks[0].status).toBe('running'));
      useAppStore.setState({ messages: [{
        id: 'answer-1', conversationId: 'conversation-1', role: 'assistant',
        content: '开始回答', timestamp: 1, status: 'streaming', agentTaskId: task.id,
      }] });
      await vi.waitFor(() => expect(readMirror()?.snapshot.messages[0].content).toBe('开始回答'));
      onAction({ type: 'dock_window', composerDraft: { conversationId: 'conversation-1', draft: '追加问题' } });
      expect(useAppStore.getState()).toMatchObject({ chatPanelDetached: false, chatComposerLiveDraft: '追加问题' });
      expect(useAppStore.getState().agentTasks[0].status).toBe('running');
      expect(executor.mock.calls[0][0].aborted).toBe(false);
      useAppStore.setState((state) => ({ messages: state.messages.map((message) => ({ ...message, content: '回答继续更新' })) }));
      useAppStore.getState().setChatPanelDetached(true);
      await vi.waitFor(() => expect(readMirror()?.snapshot.messages[0].content).toBe('回答继续更新'));
      expect(readMirror()?.snapshot.composerDraft).toBe('追加问题');
      expect(readMirror()?.snapshot.agentTasks[0].status).toBe('running');
      finish('completed');
      await running;
      await vi.waitFor(() => expect(readMirror()?.snapshot.agentTasks[0].status).toBe('completed'));
      expect(executor).toHaveBeenCalledTimes(1);
    } finally {
      finish('completed');
      await running;
      controller.dispose();
    }
  });

  it('binds delayed drafts to their original conversation and carries final edits on close', async () => {
    useAppStore.setState((state) => ({ conversations: [...state.conversations, { ...state.conversations[0], id: 'conversation-2' }] }));
    useAppStore.getState().setActiveConversation('conversation-2');
    useAppStore.getState().setChatComposerLiveDraft('乙的草稿');
    let onAction!: (action: ChatAction) => void;
    let onClose!: (draft?: { conversationId: string | null; draft: string }) => void;
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0, emitSync: async () => undefined,
      initListener: async (action, close) => { onAction = action; onClose = close; return () => undefined; },
    });
    await controller.start();
    onAction({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: '甲的迟到输入' });
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('乙的草稿');
    onClose({ conversationId: 'conversation-1', draft: '甲的最后一次输入' });
    expect(buildDetachedChatSnapshot(useAppStore.getState()).composerDrafts).toEqual({
      'conversation-1': '甲的最后一次输入', 'conversation-2': '乙的草稿',
    });
    onAction({ type: 'set_panel_view', view: 'tasks' });
    onAction({ type: 'dock_window', composerDraft: { conversationId: 'conversation-2', draft: '' } });
    expect(useAppStore.getState()).toMatchObject({ chatComposerLiveDraft: '', chatPanelView: 'tasks', chatPanelDetached: false });
    controller.dispose();
  });

  it('uses a newer snapshot after a dock during an unfinished emission', async () => {
    let release!: () => void;
    const frames: ChatStateSync[] = [];
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => {
        frames.push(sync);
        if (frames.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      },
      initListener: async () => () => undefined,
    });
    await controller.start();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    useAppStore.getState().setChatPanelDetached(false);
    useAppStore.getState().setChatPanelView('tasks');
    useAppStore.getState().setChatPanelDetached(true);
    release();
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    const latest = frames[1];
    expect(latest.type).toBe('snapshot');
    expect(latest.revision).toBeGreaterThan(frames[0].revision);
    const mirror = receiveChatStateSync(null, latest)!;
    expect(mirror.snapshot.panelView).toBe('tasks');
    expect(receiveChatStateSync(mirror, frames[0])).toBe(mirror);
    useAppStore.getState().setChatPanelView('list');
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[2]).toMatchObject({ type: 'patch', baseRevision: latest.revision });
    expect(receiveChatStateSync(mirror, frames[2])?.snapshot.panelView).toBe('list');
    controller.dispose();
  });

  it('refreshes workflow model choices when workflows change without a config change', async () => {
    const frames: ChatStateSync[] = [];
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { frames.push(sync); }, initListener: async () => () => undefined,
    });
    await controller.start();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const mirror = receiveChatStateSync(null, frames[0])!;
    const config = useAppStore.getState().config;
    useAppStore.setState({ workflows: [{ id: 'new-flow', name: '新工作流', category: 'ai-image', fileName: 'new.json', fileContent: 'PRIVATE_BODY', createdAt: 1 }] });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(useAppStore.getState().config).toBe(config);
    expect(receiveChatStateSync(mirror, frames[1])?.snapshot.mediaModelOptions).toContainEqual(expect.objectContaining({ workflowId: 'new-flow' }));
    expect(JSON.stringify(frames[1])).not.toContain('PRIVATE_BODY');
    controller.dispose();
  });

  it('publishes and updates the current project text model', async () => {
    const updateProjectSettings = vi.fn(async () => true);
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        settings: { defaultModels: { text: 'general/project-model' } },
      })),
      config: { ...state.config, assistantModelId: 'general/application-model' },
      updateProjectSettings,
    }));
    expect(buildDetachedChatSnapshot(useAppStore.getState()).assistantModelId)
      .toBe('general/project-model');

    let onAction: ((action: ChatAction) => void) | undefined;
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync: vi.fn(async () => undefined),
      initListener: vi.fn(async (handler) => {
        onAction = handler;
        return () => undefined;
      }),
    });
    await controller.start();
    onAction?.({ type: 'select_model', category: 'text', modelId: 'general/next-model' });
    expect(updateProjectSettings).toHaveBeenCalledWith(expect.objectContaining({
      defaultModels: { text: 'general/next-model' },
    }));
    expect(useAppStore.getState().config.assistantModelId).toBe('general/application-model');
    controller.dispose();
  });

  it('projects configured text model groups without provider credentials', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          apimart: {
            name: 'APIMart',
            apiKey: 'provider-secret-key',
            baseUrl: 'https://private-gateway.example/v1',
            selectedModels: [{
              id: 'apimart/gpt-5.4',
              name: 'GPT-5.4',
              category: 'text',
              provider: 'apimart',
            }],
          },
        },
      },
    }));

    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());

    expect(snapshot.assistantModelGroups).toEqual([
      expect.objectContaining({
        id: 'apimart',
        models: [expect.objectContaining({ value: 'apimart/gpt-5.4' })],
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('provider-secret-key');
    expect(JSON.stringify(snapshot)).not.toContain('private-gateway.example');
  });

  it('emits an initial snapshot followed by revisioned patches', async () => {
    const emitSync = vi.fn(async (_sync: ChatStateSync) => undefined);
    const initListener = vi.fn(async () => () => undefined);
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync,
      initListener,
      now: () => 1,
    });

    await controller.start();
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(1));
    expect(emitSync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'snapshot',
      revision: 1,
    }));

    useAppStore.setState({
      messages: [{
        id: 'message-1',
        conversationId: 'conversation-1',
        role: 'user',
        content: 'hello',
        timestamp: 2,
        status: 'done',
      }],
    });

    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(2));
    expect(emitSync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'patch',
      baseRevision: 1,
      revision: 2,
    }));
    controller.dispose();
  });

  it('routes detached actions, keeps detached mode on close, and only docks explicitly', async () => {
    let onAction: ((action: ChatAction) => void) | undefined;
    let onDetachClosed: (() => void) | undefined;
    const emitSync = vi.fn(async (_sync: ChatStateSync) => undefined);
    const cleanup = vi.fn();
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync,
      initListener: vi.fn(async (actionHandler, closeHandler) => {
        onAction = actionHandler;
        onDetachClosed = closeHandler;
        return cleanup;
      }),
      now: () => 1,
    });

    await controller.start();
    onAction?.({
      type: 'send_message',
      conversationId: 'conversation-1',
      content: 'from detached window',
      dispatchMode: 'interject',
    });
    expect(conversationControllerMocks.submit).toHaveBeenCalledWith({
      content: 'from detached window',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      mode: 'collaborative',
      dispatchMode: 'interject',
    });

    onAction?.({ type: 'request_sync' });
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalled());

    onDetachClosed?.();
    expect(useAppStore.getState()).toMatchObject({
      chatOpen: false,
      chatPanelDetached: true,
      hoveredMentionNodeId: null,
    });

    onAction?.({ type: 'dock_window' });
    expect(useAppStore.getState()).toMatchObject({
      chatOpen: true,
      chatPanelDetached: false,
      hoveredMentionNodeId: null,
    });

    controller.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('projects task Skill bindings without syncing frozen bodies or package audit paths', () => {
    const task = {
      id: 'task-with-package-skill',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      mode: 'collaborative' as const,
      goal: '检查剧本',
      status: 'completed' as const,
      steps: [],
      modelRounds: 1,
      toolCallCount: 0,
      budget: {
        maxModelRounds: 12,
        maxToolCalls: 24,
        maxParallelReadTools: 3,
        maxReadRetries: 3,
      },
      skillBindings: [{
        skillId: 'ap-skill-secret',
        name: '短剧检查',
        version: '1.0.0',
        content: '冻结的任务 Skill 正文不应跨窗口',
        origin: 'agent-package' as const,
        packageId: 'com.example.secret',
        packageName: 'AI短剧知识库',
        packageVersion: '1.4.1',
        entryPath: '04-分镜设计/secret/SKILL.md',
        contentHash: 'binding-content-hash-secret',
        allowedTools: ['canvas_get_state'],
      }],
      createdAt: 1,
      updatedAt: 2,
    };
    useAppStore.setState({ agentTasks: [task] });

    const first = buildDetachedChatSnapshot(useAppStore.getState());
    expect(first.agentTasks[0].skillBindings).toEqual([{
      skillId: 'ap-skill-secret',
      name: '短剧检查',
      version: '1.0.0',
      content: '',
      allowedTools: ['canvas_get_state'],
    }]);
    const serialized = JSON.stringify(first.agentTasks);
    expect(serialized).not.toContain('冻结的任务 Skill 正文');
    expect(serialized).not.toContain('04-分镜设计/secret/SKILL.md');
    expect(serialized).not.toContain('binding-content-hash-secret');
    expect(serialized).not.toContain('com.example.secret');
    expect(serialized).not.toContain('AI短剧知识库');

    // Store 只换数组但任务对象未变时，沿用投影数组，避免无意义的时间线 patch。
    useAppStore.setState({ agentTasks: [task] });
    const second = buildDetachedChatSnapshot(useAppStore.getState());
    expect(second.agentTasks).toBe(first.agentTasks);
  });

  it('mirrors canvas slices to the detached window without leaking node bodies', async () => {
    useAppStore.setState({
      nodes: [{
        id: 'node-1',
        type: 'ai-image',
        position: { x: 120, y: 240 },
        data: {
          label: '主角立绘',
          type: 'ai-image',
          displayId: 3,
          thumbnailUrl: 'asset://thumb-1',
          prompt: '不应跨窗口传输的提示词',
        },
      }],
      chatComposerLiveDraft: '内嵌浮窗里没发出去的草稿',
      chatComposerDrafts: { 'conversation-1': '内嵌浮窗里没发出去的草稿' },
      userSkills: [{
        id: 'skill-1',
        name: '分镜脚本',
        description: '把剧本拆成分镜',
        fileName: 'storyboard.md',
        content: '技能正文很长，不该跨窗口传',
        sourceType: 'file',
        createdAt: 1,
      }],
      agentPackageSkills: [{
        id: 'ap-skill-1',
        name: '短剧开场钩子',
        description: '为短剧设计前三秒钩子',
        fileName: 'SKILL.md',
        content: '智能体 Skill 正文不应跨窗口传输',
        sourceType: 'agent-package',
        createdAt: 2,
        installationId: 'agent-package-1',
        packageId: 'com.example.drama',
        packageName: 'AI短剧知识库',
        packageVersion: '1.4.1',
        packageContentHash: 'package-hash',
        sourceId: 'opaque-source-secret',
        entryPath: '01-国内短剧/开场钩子/SKILL.md',
        skillRoot: '01-国内短剧/开场钩子',
        contentHash: 'skill-hash',
        branch: 'domestic',
        packageUserInvocable: true,
        packageAutoInvoke: false,
        mcpSkillReadEnabled: false,
        readOnly: true,
      }],
    });

    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());
    expect(snapshot.composerDraft).toBe('内嵌浮窗里没发出去的草稿');
    // 独立窗口只同步可选择元数据；用户与智能体 Skill 正文都留在主窗口。
    expect(snapshot.skillOptions).toEqual([
      {
        id: 'skill-1',
        name: '分镜脚本',
        description: '把剧本拆成分镜',
        fileName: 'storyboard.md',
        sourceKind: 'user',
        sourceGroupId: 'user-skills',
        sourceLabel: '我的 Skill',
      },
      {
        id: 'ap-skill-1',
        name: '短剧开场钩子',
        description: '为短剧设计前三秒钩子',
        fileName: 'SKILL.md',
        sourceKind: 'agent-package',
        sourceGroupId: 'agent-package-1',
        sourceLabel: 'AI短剧知识库',
      },
    ]);
    expect(snapshot).not.toHaveProperty('userSkills');
    expect(JSON.stringify(snapshot)).not.toContain('技能正文很长');
    expect(JSON.stringify(snapshot)).not.toContain('智能体 Skill 正文');
    expect(JSON.stringify(snapshot)).not.toContain('opaque-source-secret');
    expect(JSON.stringify(snapshot)).not.toContain('01-国内短剧/开场钩子/SKILL.md');
    expect(snapshot.nodes).toEqual([{
      id: 'node-1',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: '主角立绘',
        type: 'ai-image',
        displayId: 3,
        imageUrl: undefined,
        videoUrl: undefined,
        thumbnailUrl: 'asset://thumb-1',
      },
    }]);

    const emitSync = vi.fn(async (_sync: ChatStateSync) => undefined);
    let onAction: ((action: ChatAction) => void) | undefined;
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync,
      initListener: vi.fn(async (handler) => {
        onAction = handler;
        return () => undefined;
      }),
      now: () => 1,
    });
    await controller.start();
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(1));

    // 智能体停用后运行时目录会移除包内 Skill，独立窗口应收到精简删除补丁。
    useAppStore.setState({ agentPackageSkills: [] });
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(2));
    const skillRemoval = emitSync.mock.calls[1][0];
    expect(skillRemoval.type).toBe('patch');
    if (skillRemoval.type !== 'patch') throw new Error('expected skill removal patch');
    const withoutPackageSkill = applyChatStatePatch(snapshot, skillRemoval.patch);
    expect(withoutPackageSkill.skillOptions.map((option) => option.id)).toEqual(['skill-1']);

    // 节点改名要作为补丁推到独立窗口
    useAppStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({
        ...node,
        data: { ...node.data, label: '主角立绘 v2' },
      })),
    }));
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(3));
    const third = emitSync.mock.calls[2][0];
    expect(third.type).toBe('patch');
    if (third.type !== 'patch') throw new Error('expected patch sync');
    const patched = applyChatStatePatch(withoutPackageSkill, third.patch);
    expect(patched.nodes[0].data.label).toBe('主角立绘 v2');

    // 独立窗口回写草稿，收回内嵌时接得上
    onAction?.({ type: 'set_composer_draft', draft: '独立窗口里改过的草稿' });
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('独立窗口里改过的草稿');

    controller.dispose();
  });

  it('projects playable video URLs and patches source changes without leaking file paths or bodies', () => {
    const node = (videoUrl: string, x = 0) => ({
      id: 'video-node', type: 'source-video', position: { x, y: 0 },
      data: { label: '源视频', type: 'source-video' as const, videoUrl, thumbnailUrl: 'asset://localhost/poster.png',
        filePath: 'PRIVATE_FILE_PATH', prompt: 'PRIVATE_PROMPT', output: 'PRIVATE_OUTPUT' },
    });
    useAppStore.setState({ nodes: [node('asset://localhost/first.mp4')] });
    const first = buildDetachedChatSnapshot(useAppStore.getState());
    expect(first.nodes[0].data.videoUrl).toBe('asset://localhost/first.mp4');
    expect(JSON.stringify(first.nodes)).not.toContain('PRIVATE_');
    useAppStore.setState({ nodes: [node('asset://localhost/first.mp4', 120)] });
    expect(buildDetachedChatSnapshot(useAppStore.getState()).nodes).toBe(first.nodes);
    useAppStore.setState({ nodes: [node('asset://localhost/second.mp4', 120)] });
    const next = buildDetachedChatSnapshot(useAppStore.getState());
    const patch = createChatStatePatch(first, next);
    expect(patch.nodes?.upserted[0].data.videoUrl).toBe('asset://localhost/second.mp4');
    expect(applyChatStatePatch(first, patch).nodes[0].data.videoUrl).toBe('asset://localhost/second.mp4');
    expect(JSON.stringify(patch.nodes)).not.toContain('PRIVATE_');
  });

  it('keeps the node projection stable across canvas drags', () => {
    const node = (id: string, label: string, x: number) => ({
      id,
      type: 'ai-image',
      position: { x, y: 0 },
      data: { label, type: 'ai-image' as const, displayId: 1 },
    });

    const first = projectChatNodes([node('a', '甲', 0), node('b', '乙', 0)]);
    // 拖动只换坐标与数组引用，投影必须原样返回，才能让补丁层的 Object.is 短路
    const dragged = projectChatNodes([node('a', '甲', 120), node('b', '乙', 40)]);
    expect(dragged).toBe(first);

    const renamed = projectChatNodes([node('a', '甲 v2', 120), node('b', '乙', 40)]);
    expect(renamed).not.toBe(first);
    expect(renamed[0].data.label).toBe('甲 v2');
    expect(renamed[1]).toBe(first[1]);

    // 顺序变化也算变化，否则 @ 列表会停在旧次序
    const reordered = projectChatNodes([node('b', '乙', 40), node('a', '甲 v2', 120)]);
    expect(reordered).not.toBe(renamed);
    expect(reordered.map((item) => item.id)).toEqual(['b', 'a']);

    const removed = projectChatNodes([node('b', '乙', 40)]);
    expect(removed).toHaveLength(1);
  });

  it('retries a failed emission with the same revision as a full snapshot', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emitSync = vi.fn()
      .mockRejectedValueOnce(new Error('event bus unavailable'))
      .mockResolvedValue(undefined);
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync,
      initListener: vi.fn(async () => () => undefined),
      now: () => 1,
    });

    await controller.start();
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(2));
    expect(emitSync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'snapshot',
      revision: 1,
    }));
    expect(emitSync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'snapshot',
      revision: 1,
    }));

    controller.dispose();
    warning.mockRestore();
  });
});

it('includes bounded reasoning and independent errors in main-window snapshots and patches', () => {
  arrangeDetachedState();
  useAppStore.setState({ messages: [{ id: 'reasoning-msg', conversationId: 'conversation-1', role: 'assistant', content: 'partial answer', status: 'streaming', timestamp: 1, reasoning: 'sanitized summary', responseError: 'network error' }] });
  const first = buildDetachedChatSnapshot(useAppStore.getState());
  expect(first.messages[0]).toMatchObject({ reasoning: 'sanitized summary', responseError: 'network error' });
  useAppStore.getState().updateMessageTransient('reasoning-msg', { reasoning: 'updated summary', activity: 'compressing' });
  const next = buildDetachedChatSnapshot(useAppStore.getState());
  const patch = createChatStatePatch(first, next);
  expect(applyChatStatePatch(first, patch).messages[0]).toMatchObject({ reasoning: 'updated summary', content: 'partial answer', activity: 'compressing' });
});

it('reuses the newly created conversation for rapid MCP selections and projects no endpoint', () => {
  arrangeDetachedState();
  const makeConnection = (id: string) => ({ id, name: id, url: 'https://private.example/mcp', enabled: true, revision: 'rev-1', authHeader: 'authorization' as const, hasSecret: true, tools: { lookup: { access: 'read' as const, fingerprint: 'digest' } } });
  useAppStore.setState({ activeConversationId: null, conversations: [], config: { ...useAppStore.getState().config, mcpClientConnections: [makeConnection('one'), makeConnection('two')] } });
  const sync = vi.fn();
  handleDetachedChatAction({ type: 'set_mcp_connection', scopeId: 'project-1', serverId: 'one', enabled: true, draft: 'keep this draft' }, sync);
  handleDetachedChatAction({ type: 'set_mcp_connection', scopeId: 'project-1', serverId: 'two', enabled: true, draft: 'stale draft' }, sync);
  const state = useAppStore.getState();
  expect(state.conversations).toHaveLength(1);
  expect(state.conversations[0].mcpServerIds).toEqual(['one', 'two']);
  expect(state.chatComposerLiveDraft).toBe('keep this draft');
  const snapshot = buildDetachedChatSnapshot(state);
  expect(snapshot.mcpClientOptions).toEqual([{ id: 'one', name: 'one', toolCount: 1 }, { id: 'two', name: 'two', toolCount: 1 }]);
  expect(JSON.stringify(snapshot.mcpClientOptions)).not.toContain('private.example');
});


it('keeps unchanged entity arrays and applies only changed nodes, including ordering and removal', () => {
  const node = (id: string) => ({ id, type: 'ai-text', position: { x: 0, y: 0 }, data: { label: id, type: 'ai-text' as const } });
  useAppStore.setState({ nodes: [node('a'), node('b'), node('c')] });
  const first = buildDetachedChatSnapshot(useAppStore.getState());
  const unchanged = applyChatStatePatch(first, createChatStatePatch(first, first));
  expect(unchanged.messages).toBe(first.messages);
  expect(unchanged.conversations).toBe(first.conversations);
  expect(unchanged.agentTasks).toBe(first.agentTasks);
  expect(unchanged.nodes).toBe(first.nodes);
  useAppStore.setState({ nodes: [node('c'), { ...node('a'), data: { type: 'ai-text', label: '新名' } }, node('d')] });
  const next = buildDetachedChatSnapshot(useAppStore.getState());
  const patch = createChatStatePatch(first, next);
  expect(patch.fields.nodes).toBeUndefined();
  expect(patch.nodes?.upserted.map((item) => item.id)).toEqual(['a', 'd']);
  expect(patch.nodes?.removedIds).toEqual(['b']);
  expect(applyChatStatePatch(first, patch).nodes).toEqual(next.nodes);
  const oldPatch = createChatStatePatch(first, first);
  oldPatch.fields.nodes = [];
  expect(applyChatStatePatch(first, oldPatch).nodes).toEqual([]);
});

it('does not reparse unchanged historical message bodies on canvas or streaming updates', () => {
  const old = { id: 'old', conversationId: 'conversation-1', role: 'user' as const,
    status: 'done' as const, timestamp: 1, get content() { return '历史正文'; } };
  const read = vi.spyOn(old, 'content', 'get');
  const message = { id: 'stream', conversationId: 'conversation-1', role: 'assistant' as const,
    status: 'streaming' as const, timestamp: 2, content: '第一段' };
  useAppStore.setState({ messages: [old, message] });
  buildDetachedChatSnapshot(useAppStore.getState());
  const initial = read.mock.calls.length;
  buildDetachedChatSnapshot(useAppStore.getState());
  useAppStore.setState({ messages: [old, { ...message, content: '第一段，第二段' }] });
  buildDetachedChatSnapshot(useAppStore.getState());
  expect(read.mock.calls.length).toBe(initial);
  read.mockRestore();
});
