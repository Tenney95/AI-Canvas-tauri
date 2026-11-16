/**
 * agentActivity — 回归测试：Agent visible activity and recovery。
 */
import { act, createContext, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DefaultEventPriority, DiscreteEventPriority } from 'react-reconciler/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentTaskTimeline from '../../src/components/chat/AgentTaskTimeline';
import AgentStepCard from '../../src/components/chat/AgentStepCard';
import ReasoningPanel from '../../src/components/chat/ReasoningPanel';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentStep, type AgentTask } from '../../src/types/agent';

vi.mock('@iconify/react', () => ({ Icon: () => null }));

const task: AgentTask = {
  id: 'task', projectId: 'project', conversationId: 'conversation', userMessageId: 'user',
  mode: 'collaborative', goal: 'inspect', status: 'failed', steps: [], modelRounds: 1,
  toolCallCount: 0, budget: DEFAULT_AGENT_TASK_BUDGET, createdAt: 1, updatedAt: 2,
};
const controls = {
  onResolveApproval: vi.fn(), mediaModelOptions: [], mediaModelAvailability: {},
  onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onSkip: vi.fn(), onReplan: vi.fn(), onRewind: vi.fn(),
};

type Props = Record<string, unknown>;
interface HostNode { type: string; props: Props; children: HostNode[]; text?: string }
type HostConfig = Reconciler.HostConfig<string, Props, HostNode, HostNode, HostNode, never, never, never,
  HostNode, object, never, ReturnType<typeof setTimeout>, -1, null>;
const context = {};
let priority = DefaultEventPriority;
const node = (type: string, props: Props = {}): HostNode => ({ type, props, children: [] });
function place(parent: HostNode, child: HostNode, before?: HostNode) {
  const old = parent.children.indexOf(child);
  if (old >= 0) parent.children.splice(old, 1);
  parent.children.splice(before ? parent.children.indexOf(before) : parent.children.length, 0, child);
}
const remove = (parent: HostNode, child: HostNode) => { parent.children.splice(parent.children.indexOf(child), 1); };
// 真实 Fiber/hooks 保持同一组件实例，覆盖“首次展开、完成后仍未收起”的生命周期回归。
const renderer = Reconciler({
  supportsMutation: true, supportsPersistence: false, supportsHydration: false, isPrimaryRenderer: true,
  getRootHostContext: () => context, getChildHostContext: () => context, getPublicInstance: (value: HostNode) => value,
  createInstance: node, createTextInstance: (text: string) => ({ ...node('#text'), text }),
  appendInitialChild: place, appendChild: place, appendChildToContainer: place,
  insertBefore: place, insertInContainerBefore: place, removeChild: remove, removeChildFromContainer: remove,
  finalizeInitialChildren: () => false, shouldSetTextContent: () => false, prepareForCommit: () => null,
  resetAfterCommit() {}, preparePortalMount() {}, detachDeletedInstance() {},
  commitUpdate: (value: HostNode, _type: string, _old: Props, props: Props) => { value.props = props; },
  commitTextUpdate: (value: HostNode, _old: string, text: string) => { value.text = text; },
  clearContainer: (value: HostNode) => { value.children = []; },
  scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  setCurrentUpdatePriority: (value: typeof priority) => { priority = value; }, getCurrentUpdatePriority: () => priority,
  resolveUpdatePriority: () => DiscreteEventPriority, NotPendingTransition: null,
  HostTransitionContext: createContext(null) as unknown as HostConfig['HostTransitionContext'],
  getInstanceFromNode: () => null, getInstanceFromScope: () => null, beforeActiveInstanceBlur() {}, afterActiveInstanceBlur() {},
  prepareScopeUpdate() {}, resetFormInstance() {}, requestPostPaintCallback() {}, shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent() {}, resolveEventType: () => null, resolveEventTimeStamp: () => 0,
  maySuspendCommit: () => false, preloadInstance: () => true, startSuspendingCommit() {}, suspendInstance() {}, waitForCommitToBeReady: () => null,
} satisfies HostConfig);
let container: HostNode;
let root: ReturnType<typeof renderer.createContainer> | undefined;
const text = (value: HostNode): string => value.text ?? value.children.map(text).join('');
const nodes = (value: HostNode): HostNode[] => [value, ...value.children.flatMap(nodes)];
const disclosures = () => nodes(container).filter((value) => value.type === 'button' && 'aria-expanded' in value.props);
async function render(element: ReactNode) {
  if (!root) {
    container = node('root');
    const report = (error: Error) => { throw error; };
    root = renderer.createContainer(container, ConcurrentRoot, null, false, null, '', report, report, report, () => {});
  }
  await act(async () => { renderer.updateContainer(element, root!, null); });
}
async function click(button: HostNode) {
  await act(async () => { (button.props.onClick as () => void)(); });
}
function step(status: AgentStep['status'] = 'running', id = 'step'): AgentStep {
  return { id, taskId: task.id, index: 0, kind: 'tool', title: '读取资料', status, createdAt: 1, updatedAt: 2,
    outputSummary: '已读取项目资料', toolCall: { callId: 'call', toolId: 'file_read_text', retryCount: 0,
      inputSummary: '读取已授权文件', startedAt: 1, finishedAt: 201 } };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { setInterval, clearInterval });
});
afterEach(async () => {
  if (root) await act(async () => { renderer.updateContainer(null, root!, null); });
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Agent visible activity and recovery', () => {
  it('keeps failed details and the recovery action visible', () => {
    const html = renderToStaticMarkup(<AgentTaskTimeline task={task} {...controls} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="继续"');
    expect(html).toContain('ui-btn--primary');
  });
  it('shows the real compression activity instead of planning', () => {
    const html = renderToStaticMarkup(<AgentTaskTimeline task={{ ...task, status: 'planning' }} {...controls} activity="compressing" activityStartedAt={Date.now()} />);
    expect(html).toContain('正在压缩上下文');
  });
  it('uses native keyboard-accessible disclosure and omits missing reasoning', () => {
    expect(renderToStaticMarkup(<ReasoningPanel content="" />)).toBe('');
    const html = renderToStaticMarkup(<ReasoningPanel content="provider summary" truncated />);
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('provider summary');
    expect(html).toContain('展示已截断');
    expect(html).not.toContain(' open=');
  });

  it.each(['completed', 'stopped'] as const)('实时收起 %s 任务及执行依据，并允许手动重新展开', async (status) => {
    const active: AgentTask = { ...task, status: 'running', steps: [step()],
      events: [{ id: 'event', taskId: task.id, sequence: 0, type: 'model_round_start', timestamp: 1 }] };
    await render(<AgentTaskTimeline task={active} {...controls} />);
    expect(disclosures().map((button) => button.props['aria-expanded'])).toEqual([true, true, true]);
    const settled = { ...active, status };
    await render(<AgentTaskTimeline task={settled} {...controls} />);
    expect(disclosures().map((button) => button.props['aria-expanded'])).toEqual([false, false]);
    await click(disclosures()[0]);
    await click(disclosures()[1]);
    expect(text(container)).toContain('已读取项目资料');
    expect(text(container)).toContain('来自可验证的任务事件');
    await render(<AgentTaskTimeline task={{ ...settled, updatedAt: 3 }} {...controls} />);
    expect(disclosures().every((button) => button.props['aria-expanded'])).toBe(true);
    await render(<AgentTaskTimeline task={{ ...settled, id: 'other-task' }} {...controls} />);
    expect(disclosures().map((button) => button.props['aria-expanded'])).toEqual([false, false]);
  });

  it.each(['succeeded', 'skipped'] as const)('工具步骤变为 %s 后收起摘要，重展开不嵌套调用详情按钮', async (status) => {
    const active = step();
    await render(<AgentStepCard step={active} />);
    expect(text(container)).toContain('读取已授权文件');
    const settled = { ...active, status, toolCall: { ...active.toolCall!, inputDisplay: { note: '调用详情快照' } } };
    await render(<AgentStepCard step={settled} />);
    expect(disclosures()[0].props['aria-expanded']).toBe(false);
    expect(text(container)).not.toContain('已读取项目资料');
    expect(text(container)).toContain('200ms');
    await click(disclosures()[0]);
    expect(text(container)).toContain('已读取项目资料');
    expect(nodes(disclosures()[0]).filter((value) => value.type === 'button')).toHaveLength(1);
    await render(<AgentStepCard step={{ ...settled, updatedAt: 4 }} />);
    expect(disclosures()[0].props['aria-expanded']).toBe(true);
    await render(<AgentStepCard step={{ ...settled, id: 'other-step' }} />);
    expect(disclosures()[0].props['aria-expanded']).toBe(false);
    await render(<AgentStepCard step={settled} />);
    expect(disclosures()[0].props['aria-expanded']).toBe(false);
    await render(<AgentStepCard step={{ ...settled, status: 'failed', errorMessage: '读取失败，请核对授权' }} />);
    expect(disclosures()[0].props['aria-expanded']).toBe(true);
    expect(text(container)).toContain('读取失败，请核对授权');
  });

  it('进入暂停、失败和待审批时展开，手动收起仍保留错误与审批', async () => {
    const active = { ...task, status: 'running' as const };
    await render(<AgentTaskTimeline task={active} {...controls} />);
    await click(disclosures()[0]);
    await render(<AgentTaskTimeline task={{ ...active, status: 'paused', pausedReason: 'user_paused' }} {...controls} />);
    expect(disclosures()[0].props['aria-expanded']).toBe(true);
    expect(text(container)).toContain('你已暂停');
    await click(disclosures()[0]);
    await render(<AgentTaskTimeline task={{ ...active, status: 'failed', errorMessage: '工具执行失败' }} {...controls} />);
    expect(disclosures()[0].props['aria-expanded']).toBe(true);
    await click(disclosures()[0]);
    expect(text(container)).toContain('工具执行失败');
    const pending: AgentStep = { ...step('waiting_approval'), approval: { id: 'approval', kind: 'canvas_write',
      status: 'pending', summary: '请确认画布修改', requestedAt: 1 } };
    await render(<AgentTaskTimeline task={{ ...active, status: 'waiting_approval', steps: [pending] }} {...controls} />);
    expect(disclosures()[0].props['aria-expanded']).toBe(true);
    await click(disclosures()[0]);
    expect(text(container)).toContain('请确认画布修改');
  });
});
