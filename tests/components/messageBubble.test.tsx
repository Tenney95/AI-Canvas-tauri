/** MessageBubble — 普通文本隔离媒体订阅，保留旧消息恢复入口。 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types/chat';
import type { MediaTaskSnapshot } from '../../src/services/pollManager';

const mocks = vi.hoisted(() => ({
  projectId: 'project-1' as string | null,
  states: [] as unknown[], stateIndex: 0,
  effectDeps: undefined as readonly unknown[] | undefined,
  cleanup: undefined as (() => void) | undefined,
  pendingEffects: [] as Array<() => void>,
  knownMessages: new Set<string>(),
  recovery: undefined as MediaTaskSnapshot | undefined,
  initialize: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  hasTask: vi.fn(), snapshot: vi.fn(), mediaHook: vi.fn(), subscribe: vi.fn(),
}));

// A small hook driver keeps effect identity/cleanup; rendering and bubble markup remain real.
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.states)) mocks.states[index] = initial;
    return [mocks.states[index] as T, (value: T) => { mocks.states[index] = value; }];
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    if (mocks.effectDeps?.length === deps.length && deps.every((value, index) => Object.is(value, mocks.effectDeps?.[index]))) return;
    mocks.effectDeps = deps;
    mocks.pendingEffects.push(() => { mocks.cleanup?.(); mocks.cleanup = effect() ?? undefined; });
  },
  useSyncExternalStore: <T,>(subscribe: unknown, getSnapshot: () => T) => {
    mocks.mediaHook(subscribe);
    return getSnapshot();
  },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: { currentProjectId: string | null }) => unknown) =>
  selector({ currentProjectId: mocks.projectId }) }));
vi.mock('../../src/services/pollManager', () => ({
  initializeMediaTaskSnapshot: mocks.initialize, hasPendingMessageMediaTask: mocks.hasTask, subscribeMediaTasks: mocks.subscribe,
}));
vi.mock('../../src/services/ai/generationRuntime', () => ({ getRecoverableMessageTaskSnapshot: mocks.snapshot }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('../../src/components/chat/MascotAvatar', () => ({ default: () => null }));
vi.mock('../../src/components/chat/AgentTaskTimeline', () => ({ default: () => null }));
vi.mock('../../src/components/chat/ChatReferenceText', () => ({ default: ({ value }: { value: string }) => value }));
vi.mock('../../src/components/chat/ChatMarkdown', () => ({ default: ({ value }: { value: string }) => value }));
vi.mock('../../src/components/chat/SourceList', () => ({ default: () => null }));
vi.mock('../../src/components/chat/ReasoningPanel', () => ({ default: () => null }));
vi.mock('../../src/components/chat/AssistantActivity', () => ({ default: ({ label }: { label: string }) => label }));
vi.mock('../../src/components/chat/ChatImageAttachments', () => ({ default: () => null }));
vi.mock('../../src/components/shared/ViewportImage', () => ({ default: () => null }));
vi.mock('../../src/components/shared/ViewportVideo', () => ({ default: () => null }));
vi.mock('../../src/components/shared/ViewportAudio', () => ({ default: () => null }));
import MessageBubble from '../../src/components/chat/MessageBubble';

const message: ChatMessage = { id: 'message-1', conversationId: 'conversation-1', role: 'assistant',
  content: 'ordinary text', timestamp: 1, status: 'done' };
const retry = vi.fn<() => Promise<void>>();
function render(value = message) {
  mocks.stateIndex = 0;
  return renderToStaticMarkup(<MessageBubble message={value} onRetryMediaSave={retry} />);
}
async function flushEffects() {
  mocks.pendingEffects.splice(0).forEach((effect) => effect());
  await Promise.resolve();
}

beforeEach(() => {
  mocks.projectId = 'project-1'; mocks.states = []; mocks.stateIndex = 0;
  mocks.effectDeps = undefined; mocks.cleanup = undefined; mocks.pendingEffects = [];
  mocks.knownMessages.clear(); mocks.recovery = undefined;
  mocks.initialize.mockReset().mockResolvedValue(undefined);
  mocks.hasTask.mockReset().mockImplementation((projectId: string, conversationId: string, messageId: string) =>
    mocks.knownMessages.has(JSON.stringify([projectId, conversationId, messageId])));
  mocks.snapshot.mockReset().mockImplementation(() => mocks.recovery);
  mocks.mediaHook.mockClear();
});
afterEach(() => { mocks.cleanup?.(); });

describe('message media recovery subscription', () => {
  it.each(['user', 'system'] as const)('%s text never initializes or subscribes to the media ledger', async (role) => {
    expect(render({ ...message, role })).toContain('ordinary text');
    await flushEffects();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.hasTask).not.toHaveBeenCalled();
    expect(mocks.mediaHook).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('only probes an unmarked assistant on identity change, with no media subscription while typing', async () => {
    render(); await flushEffects();
    render({ ...message, content: 'ordinary text continues', status: 'streaming' }); await flushEffects();
    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.hasTask).toHaveBeenCalledOnce();
    expect(mocks.mediaHook).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('finds a cold detached legacy message after effect initialization and drops its old project identity immediately', async () => {
    mocks.knownMessages.add(JSON.stringify(['project-1', message.conversationId, message.id]));
    mocks.recovery = { projectId: 'project-1', nodeId: 'tracking-node', taskId: 'original-task', attemptId: 'original-attempt',
      submitted: true, mediaRecoveryState: 'query_paused', historyDownloadPending: false };
    expect(render()).not.toContain('继续查询 / 保存');
    expect(mocks.snapshot).not.toHaveBeenCalled();
    await flushEffects();
    expect(render()).toContain('继续查询 / 保存');
    expect(mocks.snapshot).toHaveBeenLastCalledWith(message, 'project-1');
    mocks.projectId = 'project-2'; mocks.mediaHook.mockClear(); mocks.snapshot.mockClear();
    expect(render()).not.toContain('继续查询 / 保存');
    await flushEffects();
    expect(render()).not.toContain('继续查询 / 保存');
    expect(mocks.mediaHook).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('keeps uncertain submissions non-actionable and exposes continuation only for the original known task', () => {
    mocks.recovery = { projectId: 'project-1', nodeId: 'tracking-node', taskId: '', attemptId: 'original-attempt',
      submitted: false, mediaSubmissionUncertain: true, mediaRecoveryState: 'submit_unknown', historyDownloadPending: false };
    const value = { ...message, mediaStatus: 'paused' as const };
    const uncertain = render(value);
    expect(uncertain).toContain('提交状态未知');
    expect(uncertain).not.toContain('继续查询 / 保存');
    mocks.recovery = { ...mocks.recovery, taskId: 'accepted-task', submitted: true,
      mediaSubmissionUncertain: false, mediaRecoveryState: 'query_paused' };
    expect(render(value)).toContain('继续查询 / 保存');
    expect(mocks.mediaHook).toHaveBeenCalledWith(mocks.subscribe);
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});
