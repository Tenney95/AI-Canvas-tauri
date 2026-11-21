import { createContext, version } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DefaultEventPriority, DiscreteEventPriority } from 'react-reconciler/constants';

type Props = Record<string, unknown>;
export interface HostNode { type: string; props: Props; children: HostNode[]; text?: string }
type HostConfig = Reconciler.HostConfig<
  string, Props, HostNode, HostNode, HostNode,
  never, never, never, never, HostNode, object, never,
  ReturnType<typeof setTimeout>, -1, null, void, never, never, never, never
>;

export const node = (type: string, props: Props = {}): HostNode => ({ type, props, children: [] });
function place(parent: HostNode, child: HostNode, before?: HostNode) {
  const old = parent.children.indexOf(child);
  if (old >= 0) parent.children.splice(old, 1);
  parent.children.splice(before ? parent.children.indexOf(before) : parent.children.length, 0, child);
}
const remove = (parent: HostNode, child: HostNode) => { parent.children.splice(parent.children.indexOf(child), 1); };

export const text = (value: HostNode): string => value.text ?? value.children.map(text).join('');
export const nodes = (value: HostNode): HostNode[] => [value, ...value.children.flatMap(nodes)];

// 每个测试套件拥有独立的 renderer、事件优先级和宿主上下文，组件使用真实 React hooks。
export function createHostRenderer() {
  const context = {};
  let priority = DefaultEventPriority;
  const renderer = Reconciler({
    rendererVersion: version, rendererPackageName: 'ai-canvas-test-renderer', extraDevToolsConfig: null,
    bindToConsole(methodName, args) {
      const method: unknown = Reflect.get(console, methodName);
      return () => { if (typeof method === 'function') Reflect.apply(method, console, args); };
    },
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
    maySuspendCommit: () => false, maySuspendCommitOnUpdate: () => false, maySuspendCommitInSyncRender: () => false,
    preloadInstance: () => true, startSuspendingCommit() {}, suspendInstance() {}, suspendOnActiveViewTransition() {},
    waitForCommitToBeReady: () => null, getSuspendedCommitReason: () => null,
  } satisfies HostConfig);
  const report = (error: unknown) => { throw error; };
  return {
    createRoot: (container: HostNode) =>
      renderer.createContainer(container, ConcurrentRoot, null, false, null, '', report, report, report, () => {}, null),
    updateContainer: renderer.updateContainer,
  };
}
