import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types/chat';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  stateCursor: 0,
  refCursor: 0,
  layoutEffects: [] as Array<() => void | (() => void)>,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: vi.fn(),
    useLayoutEffect: (effect: () => void | (() => void)) => {
      hooks.layoutEffects.push(effect);
    },
    useMemo: <T,>(factory: () => T) => factory(),
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
        hooks.values[index] = typeof next === 'function'
          ? (next as (value: T) => T)(current)
          : next;
      };
      return [hooks.values[index] as T, setValue] as const;
    },
    useSyncExternalStore: () => 'zh-CN',
  };
});

vi.mock('framer-motion', () => ({
  useReducedMotion: () => false,
}));

vi.mock('../../src/components/chat/MessageBubble', () => ({
  default: vi.fn(() => null),
}));

import ChatMessages from '../../src/components/chat/ChatMessages';
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

function renderChat(messages: ChatMessage[]): ReactElement {
  hooks.stateCursor = 0;
  hooks.refCursor = 0;
  hooks.layoutEffects = [];
  const tree = ChatMessages({
    messages,
    showEmptyState: false,
    detachedInitialized: true,
    onNewConversation: vi.fn(),
    onShowList: vi.fn(),
  });
  hooks.layoutEffects.forEach((effect) => effect());
  return tree;
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

describe('ChatMessages', () => {
  beforeEach(() => {
    hooks.values = [];
    hooks.refs = [];
    hooks.stateCursor = 0;
    hooks.refCursor = 0;
    hooks.layoutEffects = [];
    setLocale('zh-CN');
  });

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
});
