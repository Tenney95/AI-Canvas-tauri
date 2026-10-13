import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { currentProjectId: 'project' as string | null,
    nodes: [{ id: 'video', data: { videoTaskState: 'paused' as string | undefined } }], showToast: vi.fn() },
  resume: vi.fn(), tasks: [] as Array<Record<string, unknown>>, busy: false,
}));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(component: T) => component,
  useState: () => [mocks.busy, (value: boolean) => { mocks.busy = value; }],
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }));
vi.mock('../../src/services/pollManager', () => ({
  getPendingTasksForProject: () => mocks.tasks, resumeVideoNodeTask: mocks.resume,
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
import VideoTaskStatus from '../../src/components/nodes/shared/VideoTaskStatus';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
const render = () => VideoTaskStatus({ nodeId: 'video' });
const retryButton = () => elements(render()).find((element) => element.type === 'button')!;

beforeEach(() => {
  mocks.busy = false; mocks.state.currentProjectId = 'project'; mocks.state.nodes[0].data.videoTaskState = 'paused';
  mocks.tasks = [{ nodeId: 'video', nodeType: 'ai-video', submitted: true, taskId: 'task', videoRecoveryState: 'paused' }];
  mocks.resume.mockReset(); mocks.state.showToast.mockReset();
});

describe('video task retry entry', () => {
  it('is available only for a paused, submitted task in the current project', () => {
    expect(retryButton().props['aria-label']).toBe('重试查询视频任务');
    mocks.tasks[0].taskId = ''; expect(render()).toBeNull();
    mocks.tasks[0].taskId = 'task'; mocks.state.currentProjectId = null; expect(render()).toBeNull();
  });

  it('continues querying the node task and disables duplicate clicks until it finishes', async () => {
    let finish!: () => void;
    mocks.resume.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    (retryButton().props.onClick as () => void)();
    expect(mocks.resume).toHaveBeenCalledWith('video');
    expect(retryButton().props.disabled).toBe(true);
    (retryButton().props.onClick as () => void)();
    expect(mocks.resume).toHaveBeenCalledOnce();
    finish(); await vi.waitFor(() => expect(mocks.busy).toBe(false));
  });

  it('leaves the retry entry available when the query cannot start', async () => {
    mocks.resume.mockRejectedValue(new Error('configuration unavailable'));
    (retryButton().props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.state.showToast).toHaveBeenCalledWith('暂时无法继续查询，请检查连接配置', 'error'));
    expect(render()).not.toBeNull();
  });
});
