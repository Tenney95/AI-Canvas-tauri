/** 真实 React 生命周期回归：清理失败保留所有暂存句柄，业务提交成功不被清理错误覆盖。 */
import { act, createContext, type ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DefaultEventPriority, DiscreteEventPriority } from 'react-reconciler/constants';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PreparedProjectImport } from '../../src/services/projectImportService';

const driver = vi.hoisted(() => ({
  prepare: vi.fn<() => Promise<PreparedProjectImport | null>>(), compare: vi.fn(), apply: vi.fn(),
  cleanup: vi.fn<(session: PreparedProjectImport) => Promise<void>>(), toast: vi.fn(),
  onClose: vi.fn(), onImported: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => {
  const state = { projects: [], prepareProjectImport: driver.prepare, previewProjectImport: driver.compare,
    importProject: driver.apply, showToast: driver.toast };
  return { useAppStore: Object.assign(<T,>(selector: (value: typeof state) => T) => selector(state), { getState: () => state }) };
});
vi.mock('../../src/services/projectImportService', () => ({ closePreparedProjectImport: driver.cleanup, projectImportMediaPreview: () => null }));
vi.mock('../../src/services/projectMergeService', () => ({ resolveProjectMerge: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../../src/i18n', () => ({ useT: () => (key: string) => key }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: ({ children }: { children: ReactNode }) => <section>{children}</section> }));
vi.mock('../../src/components/shared/Select', () => ({ default: ({ children }: { children: ReactNode }) => <select>{children}</select> }));

import ProjectImportDialog from '../../src/components/projectImport/ProjectImportDialog';

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
// 使用现有 reconciler 的真实 Fiber/hooks；宿主只保存节点和事件，不模拟组件状态或浏览器布局。
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
  // createContext 的运行时包含 reconciler 使用的私有字段，React 公共 Context 声明不暴露它们。
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
function session(id: string): PreparedProjectImport {
  return { id, stagingProjectId: `stage-${id}`, stagingFolder: id, archivePath: `${id}.aicanvas`, directory: id,
    manifest: { formatVersion: 2, exportedAt: 0, projectId: id, projectName: id },
    records: [{ id, name: id, nodes: [], edges: [], createdAt: 0, updatedAt: 0 }], chat: [], assets: [],
    bundle: null, sourceState: null, disposed: false };
}
async function mount() {
  container = node('root');
  const report = (error: Error) => { throw error; };
  root = renderer.createContainer(container, ConcurrentRoot, null, false, null, '', report, report, report, () => {});
  await act(async () => { renderer.updateContainer(<ProjectImportDialog onClose={driver.onClose} onImported={driver.onImported} />, root!, null); });
}
async function click(label: string) {
  const button = nodes(container).find((value) => value.type === 'button' && (text(value) === label || value.props['aria-label'] === label));
  expect(button, `缺少按钮：${label}`).toBeDefined();
  expect(button!.props.disabled).not.toBe(true);
  await act(async () => { (button!.props.onClick as () => void)(); });
}

beforeEach(() => {
  vi.clearAllMocks(); driver.prepare.mockReset(); driver.cleanup.mockReset(); driver.apply.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  driver.cleanup.mockImplementation(async (prepared) => { prepared.disposed = true; });
});
afterEach(async () => {
  if (root) await act(async () => { renderer.updateContainer(null, root!, null); });
  root = undefined;
  vi.unstubAllGlobals();
});

it.each(['关闭', '重新选择'] as const)('旧、新暂存均清理失败后，%s会重试两个句柄', async (retry) => {
  const old = session('旧项目包'), next = session('新项目包'), third = session('第三个项目包');
  driver.prepare.mockResolvedValueOnce(old).mockResolvedValueOnce(next).mockResolvedValueOnce(third);
  const attempted = new Set<PreparedProjectImport>();
  driver.cleanup.mockImplementation(async (prepared) => {
    prepared.disposed = true;
    if ((prepared === old || prepared === next) && !attempted.has(prepared)) {
      attempted.add(prepared); throw new Error('暂存目录正被占用');
    }
  });
  await mount(); await click('选择项目包'); await click('重新选择项目包');
  expect(driver.cleanup).toHaveBeenCalledWith(old); expect(driver.cleanup).toHaveBeenCalledWith(next);
  expect(old.disposed).toBe(true); expect(next.disposed).toBe(true);
  expect(text(container)).toContain('清理暂存素材失败，请重试关闭或重新选择项目包');
  expect(driver.onClose).not.toHaveBeenCalled(); expect(driver.onImported).not.toHaveBeenCalled();
  expect(driver.prepare).toHaveBeenCalledTimes(2);
  await click(retry === '关闭' ? '取消' : '重新选择项目包');
  expect(driver.cleanup.mock.calls.filter(([value]) => value === old).length).toBeGreaterThanOrEqual(2);
  expect(driver.cleanup.mock.calls.filter(([value]) => value === next)).toHaveLength(2);
  if (retry === '重新选择') {
    expect(text(container)).toContain(third.manifest.projectName);
    expect(third.disposed).toBe(false); expect(driver.onClose).not.toHaveBeenCalled();
    await click('取消'); expect(driver.cleanup).toHaveBeenCalledWith(third);
  }
  expect(driver.onClose).toHaveBeenCalledOnce();
});

it('导入已提交后清理失败只提示，不误报业务导入失败', async () => {
  const prepared = session('已导入项目包');
  driver.prepare.mockResolvedValueOnce(prepared); driver.apply.mockResolvedValueOnce('imported-project');
  driver.cleanup.mockImplementationOnce(async (value) => { value.disposed = true; throw new Error('暂存目录正被占用'); });
  await mount(); await click('选择项目包'); await click('导入为新项目');
  expect(driver.apply).toHaveBeenCalledWith(prepared, null, {}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(driver.toast).toHaveBeenCalledWith('项目已导入，暂存目录清理失败，可在存储健康中检查', 'info');
  expect(driver.onImported).toHaveBeenCalledOnce(); expect(driver.onClose).not.toHaveBeenCalled();
  expect(nodes(container).filter((value) => value.props.role === 'alert')).toHaveLength(0);
});
