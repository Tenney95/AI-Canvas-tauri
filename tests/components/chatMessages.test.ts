import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types/chat';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: vi.fn(),
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initialValue: T) => ({ current: initialValue }),
    useState: <T,>(initialValue: T) => [initialValue, vi.fn()],
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

function createMessage(
  id: string,
  role: ChatMessage['role'],
  content: string,
): ChatMessage {
  return {
    id,
    conversationId: 'conversation-1',
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

describe('ChatMessages', () => {
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

    const tree = ChatMessages({
      messages,
      showEmptyState: false,
      detachedInitialized: true,
      onNewConversation: vi.fn(),
      onShowList: vi.fn(),
    });
    const messageBubbles = collectElements(tree).filter(
      (element) => element.type === MessageBubble,
    );

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
});
