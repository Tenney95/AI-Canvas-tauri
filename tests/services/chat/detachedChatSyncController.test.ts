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

import { createDetachedChatSyncController } from '../../../src/services/chat/detachedChatSyncController';
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
