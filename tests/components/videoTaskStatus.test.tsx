/**
 * videoTaskStatus — 回归测试：video task retry entry。
 */
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
  getPendingTasksForProject: () => mocks.tasks, resumeMediaNodeTask: mocks.resume, discardMediaTask: vi.fn(),
  hasMuseQueryIdentity: () => false,
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
import VideoTaskStatus from '../../src/components/nodes/shared/VideoTaskStatus';
import { GenerationWaitTime } from '../../src/components/nodes/shared/NodeGenerationProgress';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
const render = (overlay = false) => VideoTaskStatus({ nodeId: 'video', overlay });
const retryButton = () => elements(render()).find((element) => element.type === 'button')!;

beforeEach(() => {
  mocks.busy = false; mocks.state.currentProjectId = 'project'; mocks.state.nodes[0].data.videoTaskState = 'paused';
  mocks.tasks = [{ nodeId: 'video', nodeType: 'ai-video', submitted: true, taskId: 'task', videoRecoveryState: 'paused' }];
  mocks.resume.mockReset(); mocks.state.showToast.mockReset();
});

describe('video task retry entry', () => {
  it('uses the shared preview overlay and wait timer for a paused video', () => {
    const root = elements(render(true))[0];
    expect(root.props.className).toContain('generation-progress-overlay--interactive');
    expect(root.props.className).not.toContain('ui-card');
    expect(elements(root).some((element) => element.type === GenerationWaitTime)).toBe(true);
    const event = { stopPropagation: vi.fn() };
    (root.props.onDoubleClick as (input: typeof event) => void)(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('keeps a safe download failure reason visible alongside the retry entry', () => {
    const reason = '生成媒体未能写入项目目录：视频下载返回空文件，可重试下载原任务';
    mocks.tasks[0].videoRecoveryMessage = reason;
    expect(elements(render()).find((element) => element.type === 'span')?.props.children).toBe(reason);
    expect(retryButton().props.disabled).toBe(false);
  });

  it('only queries submitted tasks and keeps unknown submission distinct', () => {
    expect(retryButton().props['aria-label']).toBe('继续查询 / 保存');
    mocks.tasks[0].taskId = '';
    expect(elements(render(true)).some((element) => element.props['aria-label'] === '继续查询 / 保存')).toBe(false);
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
