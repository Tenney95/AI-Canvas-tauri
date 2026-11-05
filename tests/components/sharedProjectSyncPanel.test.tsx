/** 真实 React 生命周期回归：共享资产逐项操作、确认边界与过期预览。 */
import { act, createContext } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DefaultEventPriority, DiscreteEventPriority } from 'react-reconciler/constants';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { SharedAssetSyncStatus } from '../../src/types/assetSync';

const driver = vi.hoisted(() => ({
  state: {} as AppState, listeners: new Set<() => void>(),
  load: vi.fn(), preview: vi.fn(), sync: vi.fn(), remove: vi.fn(), cancel: vi.fn(), confirm: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', async () => {
  const { useSyncExternalStore } = await import('react');
  return { useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => {
    const state = useSyncExternalStore((notify) => {
      driver.listeners.add(notify); return () => { driver.listeners.delete(notify); };
    }, () => driver.state);
    return selector(state);
  }, { getState: () => driver.state }) };
});
vi.mock('../../src/i18n', () => ({ useT: () => (key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), key) }));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: driver.confirm }));

import SharedProjectSyncPanel from '../../src/components/assets/SharedProjectSyncPanel';

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
// 宿主只保存节点和事件，组件与 Store 订阅仍使用真实 React hooks/Fiber。
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
function status(stage: SharedAssetSyncStatus['stage'] = 'preview'): SharedAssetSyncStatus {
  return { ownerId: 'owner', stage, completed: 0, total: 2, items: [
    { id: 'upload', name: '待上传角色', kind: 'character', direction: 'upload' },
    { id: 'download', name: '待下载图片.png', kind: 'file', direction: 'download', canDelete: true },
    { id: 'unchanged', name: '已同步人物', kind: 'character', direction: 'unchanged', canDelete: true },
    { id: 'conflict', name: '冲突素材', kind: 'file', direction: 'conflict', canDelete: true },
    { id: 'blocked', name: '受阻素材', kind: 'file', direction: 'blocked' },
  ] };
}
function setStatus(next: SharedAssetSyncStatus) {
  driver.state = { ...driver.state, sharedAssetSyncStatus: { ...driver.state.sharedAssetSyncStatus, owner: next } };
  driver.listeners.forEach((notify) => notify());
}
async function mount(ownerId = 'owner', enabled = true) {
  if (!root) {
    container = node('root');
    const report = (error: Error) => { throw error; };
    root = renderer.createContainer(container, ConcurrentRoot, null, false, null, '', report, report, report, () => {});
  }
  await act(async () => { renderer.updateContainer(<SharedProjectSyncPanel ownerId={ownerId} enabled={enabled} />, root!, null); });
}
function button(label: string): HostNode {
  const found = nodes(container).find((value) => value.type === 'button' && (value.props['aria-label'] === label || text(value) === label));
  expect(found, `缺少按钮：${label}`).toBeDefined();
  return found!;
}
async function click(label: string) {
  const found = button(label);
  expect(found.props.disabled).not.toBe(true);
  await act(async () => { (found.props.onClick as () => void)(); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const mock of [driver.load, driver.preview, driver.sync, driver.remove, driver.cancel, driver.confirm]) mock.mockReset();
  for (const mock of [driver.load, driver.preview, driver.sync, driver.remove, driver.cancel]) mock.mockResolvedValue(undefined);
  driver.confirm.mockResolvedValue(false);
  driver.listeners.clear();
  driver.state = { sharedAssetSyncStatus: { owner: status() }, loadSharedProjectSyncState: driver.load,
    previewSharedProjectSync: driver.preview, syncSharedProjectNow: driver.sync,
    deleteSharedProjectAsset: driver.remove, cancelSharedProjectSync: driver.cancel } as unknown as AppState;
});
afterEach(async () => {
  if (root) await act(async () => { renderer.updateContainer(null, root!, null); });
  root = undefined; driver.listeners.clear(); vi.unstubAllGlobals();
});

it('逐行显示操作并只允许预览方向；无变化的远端条目可删，本地新条目不可删', async () => {
  await mount();
  expect(button('上传「待上传角色」').props.disabled).toBe(false);
  expect(button('下载「待上传角色」').props.disabled).toBe(true);
  expect(button('从云端删除「待上传角色」').props.disabled).toBe(true);
  expect(button('从云端删除「待上传角色」').props.title).toBe('此条目尚无可删除的云端版本。');
  expect(button('下载「待下载图片.png」').props.disabled).toBe(false);
  expect(button('上传「待下载图片.png」').props.disabled).toBe(true);
  expect(button('从云端删除「已同步人物」').props.disabled).toBe(false);
  for (const name of ['冲突素材', '受阻素材']) {
    for (const action of ['上传', '下载']) {
      const found = button(`${action}「${name}」`);
      expect(found.props.disabled).toBe(true);
      expect(found.props.title).toBe('冲突或受阻条目需先处理，不能直接覆盖。');
      await act(async () => { (found.props.onClick as () => void)(); });
    }
  }
  expect(driver.sync).not.toHaveBeenCalled();
  const list = nodes(container).find((value) => value.type === 'ul')!;
  expect(list.props.className).toContain('ui-scroll');
  expect(list.props.className).toContain('max-h-64');
});

it('单项上传/下载只提交所选身份与方向，保留未选条目的展示', async () => {
  await mount();
  await click('上传「待上传角色」');
  expect(driver.sync).toHaveBeenCalledExactlyOnceWith('owner', 'upload', 'upload');
  expect(driver.confirm).not.toHaveBeenCalled();
  expect(text(container)).toContain('待下载图片.png');
  await click('下载「待下载图片.png」');
  expect(driver.sync).toHaveBeenLastCalledWith('owner', 'download', 'download');
  expect(text(container)).toContain('已同步人物');
  expect(driver.preview).not.toHaveBeenCalled();
});

it('云端单项删除需确认资产名称和保留范围，确认等待期间禁止重复操作', async () => {
  await mount();
  await click('从云端删除「已同步人物」');
  expect(driver.remove).not.toHaveBeenCalled();
  expect(driver.confirm).toHaveBeenCalledWith('从云端删除「已同步人物」？只移除云端当前可见条目，本地资产和历史版本保留。',
    { title: '从云端删除资产', okLabel: '从云端删除', cancelLabel: '取消' });
  const pending = deferred<boolean>(); driver.confirm.mockReturnValueOnce(pending.promise);
  const originalButton = button('从云端删除「已同步人物」');
  await click('从云端删除「已同步人物」');
  expect(button('上传「待上传角色」').props.disabled).toBe(true);
  expect(button('从云端删除「已同步人物」').props.disabled).toBe(true);
  await act(async () => { (originalButton.props.onClick as () => void)(); });
  expect(driver.confirm).toHaveBeenCalledTimes(2);
  await act(async () => { pending.resolve(true); });
  expect(driver.remove).toHaveBeenCalledExactlyOnceWith('owner', 'unchanged');
  expect(driver.sync).not.toHaveBeenCalled();
  expect(text(container)).toContain('待上传角色');
});

it.each(['重新预览', '切换项目', '共享不可用', '关闭视图'] as const)('删除确认期间%s，旧行不会提交', async (change) => {
  const pending = deferred<boolean>(); driver.confirm.mockReturnValueOnce(pending.promise);
  await mount(); await click('从云端删除「已同步人物」');
  if (change === '重新预览') await act(async () => { setStatus(status()); });
  else if (change === '切换项目') await mount('other');
  else if (change === '共享不可用') await mount('owner', false);
  else await act(async () => { renderer.updateContainer(null, root!, null); });
  await act(async () => { pending.resolve(true); });
  expect(driver.remove).not.toHaveBeenCalled();
});

it.each(['scanning', 'syncing', 'paused', 'failed', 'completed'] as const)('%s阶段禁用逐项写入，需先核对预览', async (stage) => {
  driver.state.sharedAssetSyncStatus.owner = status(stage);
  await mount();
  for (const label of ['上传「待上传角色」', '下载「待下载图片.png」', '从云端删除「已同步人物」']) {
    const found = button(label); expect(found.props.disabled).toBe(true);
    await act(async () => { (found.props.onClick as () => void)(); });
  }
  expect(driver.sync).not.toHaveBeenCalled(); expect(driver.confirm).not.toHaveBeenCalled(); expect(driver.remove).not.toHaveBeenCalled();
});

it('共享不可用时禁用单项操作，保留Store给出的安全字段诊断', async () => {
  await mount('owner', false);
  expect(button('上传「待上传角色」').props.disabled).toBe(true);
  expect(button('从云端删除「已同步人物」').props.disabled).toBe(true);
  await mount();
  driver.sync.mockImplementationOnce(async () => {
    setStatus({ ...status('failed'), error: '资产「待上传角色」：restoreMedia/missingLocalMedia；字段：payload.data.imageUrl' });
    throw new Error('同步未完成');
  });
  await click('上传「待上传角色」');
  expect(text(container)).toContain('资产「待上传角色」：restoreMedia/missingLocalMedia；字段：payload.data.imageUrl');
  expect(text(container)).not.toContain('此资产操作未完成，请重新预览后重试。');
});

it.each(['en-US', 'ja-JP', 'ko-KR'])('逐项操作与删除保留范围在%s中有翻译', async (locale) => {
  const i18n = await vi.importActual<typeof import('../../src/i18n')>('../../src/i18n');
  try {
    i18n.setLocale(locale);
    for (const key of ['上传此项', '下载此项', '从云端删除', '从云端删除资产', '此条目尚无可删除的云端版本。',
      '冲突或受阻条目需先处理，不能直接覆盖。']) expect(i18n.t(key)).not.toBe(key);
    const confirmation = i18n.t('从云端删除「{name}」？只移除云端当前可见条目，本地资产和历史版本保留。', { name: '角色甲' });
    expect(confirmation).toContain('角色甲'); expect(confirmation).not.toContain('只移除云端当前可见条目');
  } finally { i18n.setLocale('zh-CN'); }
});
