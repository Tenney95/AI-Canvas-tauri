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
  projectChatNodes,
} from '../../../src/services/chat/detachedChatSyncController';
import { applyChatStatePatch, type ChatStateSync } from '../../../src/services/chat/chatWindowService';
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

  it('routes detached actions and restores the main panel on close', async () => {
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
      userSkills: [{
        id: 'skill-1',
        name: '分镜脚本',
        description: '把剧本拆成分镜',
        fileName: 'storyboard.md',
        content: '技能正文很长，不该跨窗口传',
        sourceType: 'file',
        createdAt: 1,
      }],
    });

    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());
    expect(snapshot.composerDraft).toBe('内嵌浮窗里没发出去的草稿');
    // 独立窗口只用技能做 @ 选择，正文留在主窗口
    expect(snapshot.userSkills).toEqual([
      expect.objectContaining({ id: 'skill-1', name: '分镜脚本', content: '' }),
    ]);
    expect(snapshot.nodes).toEqual([{
      id: 'node-1',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: '主角立绘',
        type: 'ai-image',
        displayId: 3,
        imageUrl: undefined,
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

    // 节点改名要作为补丁推到独立窗口
    useAppStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({
        ...node,
        data: { ...node.data, label: '主角立绘 v2' },
      })),
    }));
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(2));
    const second = emitSync.mock.calls[1][0];
    expect(second.type).toBe('patch');
    if (second.type !== 'patch') throw new Error('expected patch sync');
    const patched = applyChatStatePatch(snapshot, second.patch);
    expect(patched.nodes[0].data.label).toBe('主角立绘 v2');

    // 独立窗口回写草稿，收回内嵌时接得上
    onAction?.({ type: 'set_composer_draft', draft: '独立窗口里改过的草稿' });
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('独立窗口里改过的草稿');

    controller.dispose();
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
