/**
 * chatMessages — 回归测试：ChatMessages。
 */
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types/chat';
import type { AppState } from '../../src/store/useAppStore';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  stateCursor: 0,
  refCursor: 0,
  layoutEffects: [] as Array<() => void | (() => void)>,
  effectsEnabled: false,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  pendingEffects: [] as Array<() => void>,
  effectCursor: 0,
  memos: [] as Array<{ deps: readonly unknown[]; value: unknown }>,
  memoCursor: 0,
  dirty: false,
  container: null as HTMLDivElement | null,
  panelState: {} as AppState,
  submit: vi.fn((_options: { content: string; conversationId: string; onProgress?: () => void }) => ({
    status: 'started', userMessageId: 'sent-user', assistantMessageId: 'sent-assistant',
  })),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const index = hooks.memoCursor++;
    const previous = hooks.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks.memos[index] = { deps, value: factory() };
    }
    return hooks.memos[index].value as T;
  };
  return {
    ...actual,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.effectCursor++;
      if (!hooks.effectsEnabled) return;
      const previous = hooks.effects[index];
      if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      hooks.pendingEffects.push(() => {
        previous?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    },
    useLayoutEffect: (effect: () => void | (() => void)) => {
      hooks.layoutEffects.push(effect);
    },
    useMemo: memo,
    useRef: <T,>(initialValue: T) => {
      const index = hooks.refCursor;
      hooks.refCursor += 1;
      if (!hooks.refs[index]) hooks.refs[index] = { current: initialValue };
      return hooks.refs[index] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = hooks.stateCursor;
      hooks.stateCursor += 1;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initialValue === 'function'
          ? (initialValue as () => T)()
          : initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        const current = hooks.values[index] as T;
        const value = typeof next === 'function' ? (next as (value: T) => T)(current) : next;
        hooks.dirty ||= !Object.is(value, current);
        hooks.values[index] = value;
      };
      return [hooks.values[index] as T, setValue] as const;
    },
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  };
});

vi.mock('framer-motion', () => ({
  useReducedMotion: () => false,
  motion: { aside: 'aside', div: 'div' },
  AnimatePresence: 'animate-presence',
}));

vi.mock('../../src/components/chat/MessageBubble', () => ({
  default: vi.fn(() => null),
}));

vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign(
  (selector: (state: AppState) => unknown) => selector(hooks.panelState),
  { getState: () => hooks.panelState, subscribe: () => () => {} },
) }));
vi.mock('../../src/services/chat/conversationExecutionController', () => ({
  submitConversationMessage: hooks.submit, resumeAgentTaskExecution: vi.fn(() => ({ ok: true })),
  getAgentModeToast: vi.fn(), resolveConversationAgentApproval: vi.fn(),
}));
vi.mock('../../src/services/chat/agentRuntime', () => ({
  pauseAgentTask: vi.fn(), stopAgentTask: vi.fn(), skipAgentStep: vi.fn(), requestAgentReplan: vi.fn(),
}));
vi.mock('../../src/services/ai/generationRuntime', () => ({
  completeMediaMessageDelivery: vi.fn(), getRecoverableMessageTask: vi.fn(),
  retryMediaArtifactPersist: vi.fn(), retryMediaMessageTask: vi.fn(),
}));
vi.mock('../../src/services/chat/contextManager', () => ({ estimateConversationUsage: () => null }));
vi.mock('../../src/services/chat/detachedChatSyncController', () => ({
  buildChatModelCatalog: () => ({ assistantModelGroups: [], mediaModelOptions: [], mediaModelAvailability: {} }),
  createDetachedChatSyncController: () => ({ start: async () => {}, dispose: () => {} }),
}));
vi.mock('../../src/components/chat/ChatInput', () => ({ default: 'chat-input' }));
vi.mock('../../src/components/chat/ChatHeader', () => ({ default: 'chat-header' }));
vi.mock('../../src/components/chat/ConversationList', () => ({ default: 'conversation-list' }));
vi.mock('../../src/components/chat/ProjectMemoryPanel', () => ({ default: 'project-memory' }));
vi.mock('../../src/components/chat/SubAgentPanel', () => ({ default: 'sub-agents' }));
vi.mock('../../src/components/chat/AgentCenterPanel', () => ({ default: 'agent-center' }));
vi.mock('../../src/components/chat/AgentTaskCenter', () => ({ default: 'agent-tasks' }));

import ChatMessages from '../../src/components/chat/ChatMessages';
import ChatPanel from '../../src/components/chat/ChatPanel';
import * as chatImages from '../../src/services/chat/chatImageReferenceService';
import MessageBubble from '../../src/components/chat/MessageBubble';
import { setLocale } from '../../src/i18n';

function createMessage(
  id: string,
  role: ChatMessage['role'],
  content: string,
  conversationId = 'conversation-1',
): ChatMessage {
  return {
    id,
    conversationId,
    role,
    content,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    status: 'done',
  };
}

function collectElements(node: ReactNode, elements: ReactElement[] = []): ReactElement[] {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    elements.push(child);
    collectElements((child.props as { children?: ReactNode }).children, elements);
  });
  return elements;
}

function renderChat(messages: ChatMessage[], props: Partial<ComponentProps<typeof ChatMessages>> = {}): ReactElement {
  let tree!: ReactElement;
  for (let pass = 0; pass < 5; pass += 1) {
    hooks.stateCursor = 0;
    hooks.refCursor = 0;
    hooks.memoCursor = 0;
    hooks.effectCursor = 0;
    hooks.layoutEffects = [];
    hooks.pendingEffects = [];
    hooks.dirty = false;
    tree = ChatMessages({ messages, showEmptyState: false, detachedInitialized: true,
      onNewConversation: vi.fn(), onShowList: vi.fn(), ...props });
    const container = findMessagesContainer(tree);
    (container.props as { ref: { current: HTMLDivElement | null } }).ref.current = hooks.container;
    hooks.layoutEffects.forEach((effect) => effect());
    hooks.pendingEffects.forEach((effect) => effect());
    if (!hooks.dirty) return tree;
  }
  throw new Error('ChatMessages did not settle');
}

function collectMessageBubbles(tree: ReactNode): ReactElement[] {
  return collectElements(tree).filter((element) => element.type === MessageBubble);
}

function findLoadOlderButton(tree: ReactNode): ReactElement {
  const button = collectElements(tree).find((element) => (
    element.type === 'button'
    && String((element.props as { className?: string }).className).includes('mx-auto min-h-8')
  ));
  if (!button) throw new Error('load older button not found');
  return button;
}

function findMessagesContainer(tree: ReactNode): ReactElement {
  const container = collectElements(tree).find((element) => (
    element.type === 'div'
    && String((element.props as { className?: string }).className).includes('chat-panel-messages h-full')
  ));
  if (!container) throw new Error('messages container not found');
  return container;
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
function flushFrames() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}
function scrollContainer(): HTMLDivElement {
  const container = { scrollHeight: 2_000, scrollTop: 1_600, clientHeight: 400,
    style: { scrollBehavior: 'smooth' }, scrollTo: vi.fn() };
  container.scrollTo.mockImplementation(({ top }: ScrollToOptions) => { container.scrollTop = top ?? 0; });
  return container as unknown as HTMLDivElement;
}

function renderPanel(): ReactElement {
  hooks.stateCursor = hooks.refCursor = hooks.memoCursor = hooks.effectCursor = 0;
  hooks.pendingEffects = [];
  const tree = ChatPanel();
  hooks.pendingEffects.forEach((effect) => effect());
  return tree;
}
function panelChild<T>(tree: ReactElement, type: unknown): T {
  const element = collectElements(tree).find((candidate) => candidate.type === type);
  if (!element) throw new Error(`panel child missing: ${String(type)}`);
  return element.props as T;
}
function preparePanel(messages: ChatMessage[]) {
  hooks.effectsEnabled = true;
  hooks.panelState = { chatOpen: true, chatPanelDetached: false, chatPanelView: 'chat',
    chatComposerDrafts: {}, chatComposerLiveDraft: '', chatImageDrafts: {},
    activeConversationId: 'conversation-1', currentProjectId: 'project', configHydrated: true,
    conversations: [{ id: 'conversation-1', projectId: 'project', title: 'Chat', agentMode: 'collaborative' }],
    messages, agentTasks: [], projects: [{ id: 'project', name: 'Project' }], projectMemories: [], workflows: [],
    config: { providers: {}, generalModels: [] }, setChatComposerLiveDraft: vi.fn(),
  } as unknown as AppState;
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', {
    body: { classList: { remove: vi.fn() } },
    documentElement: { dataset: { theme: 'dark' } },
  });
  vi.spyOn(chatImages, 'prepareChatImagePreviews').mockResolvedValue(undefined);
  return vi.spyOn(chatImages, 'parseChatImageReferences');
}

describe('ChatMessages', () => {
  beforeEach(() => {
    hooks.values = [];
    hooks.refs = [];
    hooks.stateCursor = 0;
    hooks.refCursor = 0;
    hooks.layoutEffects = [];
    hooks.effectsEnabled = false;
    hooks.effects = [];
    hooks.pendingEffects = [];
    hooks.memos = [];
    hooks.memoCursor = 0;
    hooks.container = null;
    hooks.submit.mockClear();
    frames.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    setLocale('zh-CN');
  });

  afterEach(() => hooks.effects.forEach((effect) => effect?.cleanup?.()));

  it('associates assistant messages with the latest user prompt in one message scan', () => {
    const messages = [
      createMessage('message-1', 'assistant', 'orphan answer'),
      createMessage('message-2', 'user', 'first prompt'),
      createMessage('message-3', 'system', 'system note'),
      createMessage('message-4', 'assistant', 'first answer'),
      createMessage('message-5', 'assistant', 'follow-up answer'),
      createMessage('message-6', 'user', 'second prompt'),
      createMessage('message-7', 'assistant', 'second answer'),
    ];
    const originalIterator = messages[Symbol.iterator].bind(messages);
    const iterator = vi.fn(originalIterator);
    Object.defineProperty(messages, Symbol.iterator, { value: iterator });

    const tree = renderChat(messages);
    const messageBubbles = collectMessageBubbles(tree);

    expect(messageBubbles.map((element) => ({
      id: (element.props as { message: ChatMessage }).message.id,
      regeneratePrompt: (element.props as { regeneratePrompt?: string }).regeneratePrompt,
    }))).toEqual([
      { id: 'message-1', regeneratePrompt: undefined },
      { id: 'message-2', regeneratePrompt: undefined },
      { id: 'message-3', regeneratePrompt: undefined },
      { id: 'message-4', regeneratePrompt: 'first prompt' },
      { id: 'message-5', regeneratePrompt: 'first prompt' },
      { id: 'message-6', regeneratePrompt: undefined },
      { id: 'message-7', regeneratePrompt: 'second prompt' },
    ]);
    expect(iterator).toHaveBeenCalledTimes(1);
  });

  it('only mounts the latest message batch and preserves the preceding user prompt', () => {
    const messages = [createMessage('message-1', 'user', 'earlier prompt')];
    for (let index = 2; index <= 91; index += 1) {
      messages.push(createMessage(`message-${index}`, 'assistant', `answer ${index}`));
    }

    const tree = renderChat(messages);
    const messageBubbles = collectMessageBubbles(tree);

    expect(messageBubbles).toHaveLength(80);
    expect((messageBubbles[0].props as { message: ChatMessage }).message.id).toBe('message-12');
    expect((messageBubbles[0].props as { regeneratePrompt?: string }).regeneratePrompt).toBe('earlier prompt');
  });

  it('loads older messages in batches and translates the control', () => {
    const messages = Array.from({ length: 150 }, (_, index) => createMessage(
      `message-${index + 1}`,
      index === 0 ? 'user' : 'assistant',
      `message ${index + 1}`,
    ));

    let tree = renderChat(messages);
    expect(collectMessageBubbles(tree)).toHaveLength(80);
    (findLoadOlderButton(tree).props as { onClick: () => void }).onClick();

    tree = renderChat(messages);
    const loadedBubbles = collectMessageBubbles(tree);
    expect(loadedBubbles).toHaveLength(140);
    expect((loadedBubbles[0].props as { message: ChatMessage }).message.id).toBe('message-11');

    setLocale('en-US');
    tree = renderChat(messages);
    expect(String((findLoadOlderButton(tree).props as { children?: ReactNode }).children))
      .toBe('Load earlier messages (10 remaining)');
  });

  it('resets the scroll window on conversation switches, including when switching back', () => {
    const makeConversation = (conversationId: string) => Array.from(
      { length: 150 },
      (_, index) => createMessage(
        `${conversationId}-${index + 1}`,
        index === 0 ? 'user' : 'assistant',
        `message ${index + 1}`,
        conversationId,
      ),
    );
    const firstConversation = makeConversation('conversation-a');
    const secondConversation = makeConversation('conversation-b');

    let tree = renderChat(firstConversation);
    (findLoadOlderButton(tree).props as { onClick: () => void }).onClick();
    tree = renderChat(firstConversation);
    expect(collectMessageBubbles(tree)).toHaveLength(140);

    const container = findMessagesContainer(tree);
    (container.props as { onScroll: (event: unknown) => void }).onScroll({
      currentTarget: { scrollHeight: 2_000, scrollTop: 200, clientHeight: 400 },
    });
    tree = renderChat(firstConversation);
    expect(collectElements(tree).some((element) => (
      element.type === 'button'
      && String((element.props as { className?: string }).className).includes('absolute bottom-3')
    ))).toBe(true);

    tree = renderChat(secondConversation);
    expect(collectMessageBubbles(tree)).toHaveLength(80);
    expect(collectElements(tree).some((element) => (
      element.type === 'button'
      && String((element.props as { className?: string }).className).includes('absolute bottom-3')
    ))).toBe(false);

    tree = renderChat(firstConversation);
    expect(collectMessageBubbles(tree)).toHaveLength(80);
  });

  it('keeps the visible top message anchored when new messages arrive away from the bottom', () => {
    const messages = Array.from({ length: 100 }, (_, index) => createMessage(
      `message-${index + 1}`,
      index === 0 ? 'user' : 'assistant',
      `message ${index + 1}`,
    ));
    let tree = renderChat(messages);
    const firstVisibleId = (
      collectMessageBubbles(tree)[0].props as { message: ChatMessage }
    ).message.id;

    const container = findMessagesContainer(tree);
    (container.props as { onScroll: (event: unknown) => void }).onScroll({
      currentTarget: { scrollHeight: 2_000, scrollTop: 200, clientHeight: 400 },
    });
    const withNewMessage = [
      ...messages,
      createMessage('message-101', 'assistant', 'new answer'),
    ];
    tree = renderChat(withNewMessage);
    const visible = collectMessageBubbles(tree);
    expect((visible[0].props as { message: ChatMessage }).message.id).toBe(firstVisibleId);
    expect(visible).toHaveLength(81);
  });

  it('keeps historical reading during streaming and follows only an explicit latest request', () => {
    hooks.effectsEnabled = true;
    const container = scrollContainer();
    hooks.container = container;
    const messages = [createMessage('m1', 'user', 'prompt'), createMessage('m2', 'assistant', 'part')];
    let tree = renderChat(messages);
    flushFrames();
    container.scrollTop = 200;
    (findMessagesContainer(tree).props as { onScroll: (event: unknown) => void }).onScroll({ currentTarget: container });
    renderChat(messages);
    const streamed = [messages[0], { ...messages[1], content: 'part two' }];
    tree = renderChat(streamed);
    flushFrames();
    expect(container.scrollTop).toBe(200);
    expect(container.scrollTo).not.toHaveBeenCalled();
    expect(collectElements(tree).some((element) => String((element.props as { 'aria-label'?: string })['aria-label']).includes('1 条未读'))).toBe(true);
    tree = renderChat(streamed, { scrollRequest: { conversationId: 'conversation-1', sequence: 1 } });
    flushFrames();
    expect(container.scrollTo).toHaveBeenCalledOnce();
    expect(container.scrollTop).toBe(container.scrollHeight);
    expect(collectElements(tree).some((element) => String((element.props as { className?: string }).className).includes('absolute bottom-3'))).toBe(false);
  });

  it('cancels old scroll frames across conversation changes and drops requests for another conversation', () => {
    hooks.effectsEnabled = true;
    hooks.container = scrollContainer();
    const first = [createMessage('a', 'assistant', 'first', 'a')];
    renderChat(first, { conversationId: 'a' });
    const oldFrame = [...frames.values()][0];
    const secondContainer = scrollContainer();
    hooks.container = secondContainer;
    renderChat([], { conversationId: 'b', scrollRequest: { conversationId: 'a', sequence: 1 } });
    secondContainer.scrollTop = 123;
    oldFrame(0);
    expect(secondContainer.scrollTop).toBe(123);
    expect(secondContainer.scrollTo).not.toHaveBeenCalled();
    renderChat(first, { conversationId: 'a', scrollRequest: { conversationId: 'a', sequence: 1 } });
    expect(secondContainer.scrollTo).not.toHaveBeenCalled();
  });

  it('binds requests to an empty conversation and cancels pending work on unmount', () => {
    hooks.effectsEnabled = true;
    const container = scrollContainer();
    hooks.container = container;
    renderChat([], { conversationId: 'empty', scrollRequest: { conversationId: 'empty', sequence: 1 } });
    expect(container.scrollTo).toHaveBeenCalledOnce();
    expect(frames.size).toBe(1);
    hooks.effects.forEach((effect) => effect?.cleanup?.());
    expect(frames.size).toBe(0);
  });

  it('typing leaves historical message identity and image parsing/preview preparation unchanged', () => {
    const history = [createMessage('m1', 'user', 'history'), createMessage('m2', 'assistant', 'answer')];
    const parse = preparePanel(history);
    let tree = renderPanel();
    const previousMessages = panelChild<ComponentProps<typeof ChatMessages>>(tree, ChatMessages).messages;
    parse.mockClear();
    vi.mocked(chatImages.prepareChatImagePreviews).mockClear();
    panelChild<{ onInputChange: (value: string) => void }>(tree, 'chat-input').onInputChange('中文草稿');
    tree = renderPanel();
    expect(panelChild<ComponentProps<typeof ChatMessages>>(tree, ChatMessages).messages).toBe(previousMessages);
    expect(parse.mock.calls.map(([content]) => content)).toEqual(['中文草稿']);
    expect(chatImages.prepareChatImagePreviews).not.toHaveBeenCalled();

    parse.mockClear();
    hooks.panelState = { ...hooks.panelState, messages: [history[0], { ...history[1], content: 'answer continued' }] };
    renderPanel();
    expect(parse.mock.calls.map(([content]) => content)).toEqual(['answer continued']);
    expect(chatImages.prepareChatImagePreviews).not.toHaveBeenCalled();
    hooks.panelState = { ...hooks.panelState, chatImageDrafts: { 'conversation-1': [
      { fileName: 'chat-ref-00000000-0000-0000-0000-000000000000.png', label: 'Image', size: 1 },
    ] } };
    renderPanel();
    expect(chatImages.prepareChatImagePreviews).toHaveBeenLastCalledWith('project', [
      'chat-ref-00000000-0000-0000-0000-000000000000.png',
    ]);
    hooks.panelState = { ...hooks.panelState, chatImageDrafts: {} };
    renderPanel();
    expect(chatImages.prepareChatImagePreviews).toHaveBeenLastCalledWith('project', []);
  });

  it('sending requests latest only for the submitted conversation and does not pass a streaming scroll callback', () => {
    preparePanel([createMessage('m1', 'user', 'history')]);
    let tree = renderPanel();
    panelChild<{ onInputChange: (value: string) => void }>(tree, 'chat-input').onInputChange('send');
    tree = renderPanel();
    panelChild<{ onSend: () => void }>(tree, 'chat-input').onSend();
    tree = renderPanel();
    expect(hooks.submit).toHaveBeenCalledWith(expect.objectContaining({ content: 'send', conversationId: 'conversation-1' }));
    expect(hooks.submit.mock.calls[0][0]).not.toHaveProperty('onProgress');
    expect(panelChild<ComponentProps<typeof ChatMessages>>(tree, ChatMessages).scrollRequest)
      .toMatchObject({ conversationId: 'conversation-1', sequence: 1 });
  });
});
