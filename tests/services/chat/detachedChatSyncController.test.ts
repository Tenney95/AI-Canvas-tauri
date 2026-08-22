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
  createDetachedChatSyncController,
} from '../../../src/services/chat/detachedChatSyncController';
import { applyChatStatePatch } from '../../../src/services/chat/chatWindowService';
import { useAppStore } from '../../../src/store/useAppStore';

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

  it('emits an initial snapshot followed by revisioned patches', async () => {
    const emitSync = vi.fn(async () => undefined);
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

  it('routes detached actions and restores the main panel on close', async () => {
    let onAction: ((action: ChatAction) => void) | undefined;
    let onDetachClosed: (() => void) | undefined;
    const emitSync = vi.fn(async () => undefined);
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
      chatOpen: true,
      chatPanelDetached: false,
      hoveredMentionNodeId: null,
    });

    controller.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('mirrors canvas slices to the detached window without leaking node bodies', async () => {
    useAppStore.setState({
      nodes: [{
        id: 'node-1',
        type: 'image',
        position: { x: 120, y: 240 },
        data: {
          label: '主角立绘',
          type: 'image',
          displayId: 3,
          thumbnailUrl: 'asset://thumb-1',
          prompt: '不应跨窗口传输的提示词',
        },
      }],
      chatComposerLiveDraft: '内嵌浮窗里没发出去的草稿',
    });

    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());
    expect(snapshot.composerDraft).toBe('内嵌浮窗里没发出去的草稿');
    expect(snapshot.nodes).toEqual([{
      id: 'node-1',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: '主角立绘',
        type: 'image',
        displayId: 3,
        imageUrl: undefined,
        thumbnailUrl: 'asset://thumb-1',
      },
    }]);

    const emitSync = vi.fn(async () => undefined);
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

    // 节点改名要作为补丁推到独立窗口
    useAppStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({
        ...node,
        data: { ...node.data, label: '主角立绘 v2' },
      })),
    }));
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(2));
    const second = emitSync.mock.calls[1][0] as { patch: Parameters<typeof applyChatStatePatch>[1] };
    const patched = applyChatStatePatch(snapshot, second.patch);
    expect(patched.nodes[0].data.label).toBe('主角立绘 v2');

    // 独立窗口回写草稿，收回内嵌时接得上
    onAction?.({ type: 'set_composer_draft', draft: '独立窗口里改过的草稿' });
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('独立窗口里改过的草稿');

    controller.dispose();
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
