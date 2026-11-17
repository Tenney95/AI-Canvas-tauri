/** ConversationList — 会话分组的 presence 身份与行保留回归。 */
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatConversation } from '../../src/types/chat';
import type { AgentTask } from '../../src/types/agent';

const driver = vi.hoisted(() => ({
  conversations: [] as ChatConversation[],
  activeConversationId: null as string | null,
  currentProjectId: 'project-1',
  agentTasks: [] as AgentTask[],
  updateConversation: vi.fn(),
  removeConversation: vi.fn(),
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(callback: T) => callback,
  useState: <T,>(initial: T | (() => T)) => [
    typeof initial === 'function' ? (initial as () => T)() : initial,
    vi.fn(),
  ] as const,
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: (selector: (state: typeof driver) => unknown) => selector(driver),
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'animated-button' }));
vi.mock('framer-motion', () => ({
  AnimatePresence: 'animate-presence',
  motion: { div: 'motion-div' },
  useReducedMotion: () => false,
}));

import ConversationList from '../../src/components/chat/ConversationList';

type Element = ReactElement<Record<string, unknown> & { children?: unknown; conv?: ChatConversation }>;

// 只展开数组；Fragment 本身仍是 AnimatePresence 的直接孩子，不能自动补 key。
function directChildren(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(directChildren);
  return isValidElement(value) ? [value as Element] : [];
}

function elements(value: unknown): Element[] {
  return directChildren(value).flatMap((element) => [element, ...elements(element.props.children)]);
}

function renderChildren(conversations: ChatConversation[]): Element[] {
  const tree = ConversationList({
    conversations,
    activeConversationId: conversations[0]?.id ?? null,
    agentTasks: [],
    onSelect: vi.fn(),
    onNew: vi.fn(),
  });
  const presence = elements(tree).find((element) => element.type === 'animate-presence');
  expect(presence).toBeDefined();
  return directChildren(presence!.props.children);
}

function conversation(id: string, pinned: boolean): ChatConversation {
  return {
    id, projectId: 'project-1', title: id, titleSource: 'user', pinned, archived: false,
    agentMode: 'collaborative', createdAt: 1, updatedAt: 1, messageCount: 0,
  };
}

describe('ConversationList presence 身份', () => {
  it.each([
    { name: '置顶与普通同时存在', conversations: [conversation('normal', false), conversation('pinned', true)] },
    { name: '仅置顶', conversations: [conversation('pinned', true)] },
    { name: '仅普通', conversations: [conversation('normal', false)] },
    { name: '空态', conversations: [] },
  ])('$name 的直接孩子 key 非空、唯一且稳定，会话行完整保留', ({ conversations }) => {
    const children = renderChildren(conversations);
    const keys = children.map((child) => child.key);
    expect(children.length).toBeGreaterThan(0);
    expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(renderChildren(conversations).map((child) => child.key)).toEqual(keys);

    const rows = elements(children).filter((element) => element.props.conv !== undefined);
    expect(rows).toHaveLength(conversations.length);
    for (const item of conversations) {
      expect(rows.filter((row) => row.props.conv === item)).toHaveLength(1);
    }
  });
});
