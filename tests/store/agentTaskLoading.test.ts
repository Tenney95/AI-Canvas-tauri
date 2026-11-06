/** 切到工作台后台分集时，迟到的数据库读取不得回退实时任务。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../src/types/agent';
import { createAgentSlice } from '../../src/store/store.agent';

const persistence = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../src/services/chat/agentTaskService', () => ({ loadProjectAgentTasks: persistence.load }));
vi.mock('../../src/services/chat/agentLifecycle', () => ({ emitAgentLifecycleEvent: vi.fn() }));

function task(id: string, projectId: string, updatedAt: number, modelRounds = 1): AgentTask {
  return { id, projectId, conversationId: 'conv-series', userMessageId: `msg-${id}`, mode: 'collaborative',
    executionKind: 'team', goal: '工作台团队', status: 'running', steps: [], modelRounds, toolCallCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET }, createdAt: 1, updatedAt };
}

function slice(initial: AgentTask[]) {
  let state = {} as AppState;
  const set = (next: Partial<AppState> | ((current: AppState) => Partial<AppState>)) => {
    state = { ...state, ...(typeof next === 'function' ? next(state) : next) };
  };
  state = { ...createAgentSlice(set as never, () => state, {} as never), agentTasks: initial } as AppState;
  return { get: () => state, set };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { persistence.load.mockReset(); });

describe('Agent project task loading', () => {
  it('保留读取期间推进的后台团队与尚未落盘的新任务，不影响其他画布', async () => {
    const original = task('team-background', 'episode-b', 10, 1);
    const other = task('team-on-canvas', 'episode-a', 10, 2);
    const store = slice([original, other]);
    const delayed = deferred<AgentTask[]>();
    persistence.load.mockReturnValueOnce(delayed.promise);
    const loading = store.get().loadAgentTasksForProject('episode-b');
    const latest = { ...original, updatedAt: 20, modelRounds: 6,
      budget: { ...original.budget, maxTotalModelRounds: 8 },
      steps: [{ id: 'revision', taskId: original.id, index: 0, kind: 'observation' as const,
        title: '统一修订', status: 'succeeded' as const, createdAt: 10, updatedAt: 20 }] };
    const unsaved = task('team-created-during-read', 'episode-b', 21, 0);
    store.set({ agentTasks: [latest, other, unsaved] });
    delayed.resolve([original]);
    await loading;
    expect(store.get().agentTasks.find((item) => item.id === original.id)).toBe(latest);
    expect(store.get().agentTasks.find((item) => item.id === unsaved.id)).toBe(unsaved);
    expect(store.get().agentTasks.find((item) => item.id === other.id)).toBe(other);
    expect(store.get().agentTasks.filter((item) => item.id === original.id)).toHaveLength(1);
  });

  it('同毫秒快照以live为准，避免快速阶段推进被同时间戳旧记录覆盖', async () => {
    const live = task('team-same-millisecond', 'episode-b', 30, 4);
    const store = slice([live]);
    persistence.load.mockResolvedValueOnce([{ ...live, modelRounds: 1, status: 'queued' }]);
    await store.get().loadAgentTasksForProject('episode-b');
    expect(store.get().agentTasks[0]).toBe(live);
  });

  it('接受更新的持久快照和未加载任务，同时忽略错误项目的返回项', async () => {
    const old = task('team-persisted-newer', 'episode-b', 10);
    const latest = { ...old, updatedAt: 40, modelRounds: 5 };
    const existing = task('team-not-yet-loaded', 'episode-b', 20);
    const wrongScope = task('foreign', 'episode-c', 50);
    const store = slice([old]);
    persistence.load.mockResolvedValueOnce([latest, existing, wrongScope]);
    await store.get().loadAgentTasksForProject('episode-b');
    expect(store.get().agentTasks).toEqual([latest, existing]);
  });
});
