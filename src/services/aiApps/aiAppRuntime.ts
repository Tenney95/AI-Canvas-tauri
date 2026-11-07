/**
 * aiAppRuntime — 校验 AI 应用候选并管理隔离界面会话与动作。
 */
import type { AiAppDefinition, AiAppJson, AiAppUiSession, AiAppUiSnapshot } from '../../types/aiApp';
import { useAppStore } from '../../store/useAppStore';
import { validateAgentToolInput } from '../chat/agentToolSchemas';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../canvasDerivationGuard';
import { captureLegacyCanvasContext, assertProjectExpectedContextCurrent } from '../projectExecutionContext';
import { assertAiAppContext, captureAiAppResources, getAiAppNode, loadAiAppDefinition, readAiAppImage, saveAiAppState, type AiAppMutationContext } from './aiAppService';
import { normalizeAiAppJson } from './aiAppSchema';

const CHANNEL = 'ai-canvas-app-v1';
const activeSessions = new Set<() => void>();
interface ExecutionGuard { assertFresh: () => void; dispose: () => void }
interface PendingExecution extends ExecutionGuard {
  resolve?: (result: AiAppJson) => void;
  reject?: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function sandbox(options: {
  definition: AiAppDefinition;
  inputNodeIds: string[];
  initialState: AiAppJson;
  initialResult?: AiAppJson;
  assertFresh: () => void;
  beginExecution: () => ExecutionGuard;
  readImage: (nodeId: string) => Promise<string>;
  onChange?: (snapshot: AiAppUiSnapshot) => void;
  onDispose?: () => void;
  signal?: AbortSignal;
}) {
  if (typeof document === 'undefined' || typeof window === 'undefined') throw new Error('AI 应用需要主窗口运行环境');
  if (activeSessions.size >= 4) throw new Error('同时最多运行 4 个 AI 应用，请先关闭其他应用');
  options.signal?.throwIfAborted();
  options.assertFresh();
  const sessionId = crypto.randomUUID();
  const src = `/ai-app-host.html#${sessionId}`;
  const pending = new Map<string, PendingExecution>();
  const resourceRequests = new Set<string>();
  let frame: Window | null = null;
  let disposed = false;
  let initialized = false;
  let initializing = false;
  let state = normalizeAiAppJson(options.initialState);
  let result = options.initialResult;
  let messageCount = 0;
  let resourceCount = 0;
  let theme: 'dark' | 'light' = 'dark';
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const notify = (snapshot: Partial<AiAppUiSnapshot> = {}) => options.onChange?.({ busy: !initialized || pending.size > 0, closed: disposed, result, ...snapshot });
  const post = (kind: string, payload: Record<string, unknown> = {}) => {
    frame?.postMessage({ channel: CHANNEL, sessionId, kind, ...payload }, '*');
  };
  const dispose = (error?: Error) => {
    if (disposed) return;
    disposed = true;
    clearTimeout(startupTimer);
    window.removeEventListener('message', handleMessage);
    options.signal?.removeEventListener('abort', onAbort);
    try { post('cancel'); } catch { /* 页面断开时仍要释放本地会话。 */ }
    frame = null;
    const cause = error ?? new Error('应用会话已关闭');
    rejectReady(cause);
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.dispose();
      operation.reject?.(cause);
    }
    pending.clear();
    resourceRequests.clear();
    activeSessions.delete(close);
    options.onDispose?.();
    if (error) notify({ busy: false, error: error.message });
  };
  const close = () => dispose();
  const onAbort = () => dispose(new Error('操作已取消'));
  const assertFresh = () => {
    if (disposed) throw new Error('应用会话已关闭，请重新加载');
    options.signal?.throwIfAborted();
    options.assertFresh();
    for (const operation of pending.values()) operation.assertFresh();
  };
  const check = () => {
    try { assertFresh(); } catch { dispose(new Error('应用、绑定素材或画布已变化，请重新加载')); }
  };
  const begin = (requestId: string, callbacks: Pick<PendingExecution, 'resolve' | 'reject'> = {}) => {
    assertFresh();
    if (pending.size) throw new Error('应用已有动作正在执行');
    const guard = options.beginExecution();
    const timer = setTimeout(() => dispose(new Error('应用动作超时，已停止')), 12_000);
    pending.set(requestId, { ...guard, ...callbacks, timer });
    notify({ error: undefined });
  };
  const updateTheme = (value: 'dark' | 'light') => {
    theme = value;
    const variables: Record<string, string> = {};
    const computed = getComputedStyle(document.documentElement);
    for (const token of ['bg', 'surface', 'card', 'border', 'text', 'text-secondary', 'text-muted']) {
      const current = computed.getPropertyValue(`--theme-${token}`).trim();
      if (current) variables[`--canvas-${token}`] = current;
    }
    if (!disposed) post('theme', { theme, variables });
  };
  async function receive(event: MessageEvent) {
    if (disposed || !frame || event.source !== frame) return;
    const raw = event.data as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.channel !== CHANNEL || raw.sessionId !== sessionId) return;
    if (++messageCount > 512) throw new Error('应用请求达到会话上限，请重新加载');
    if (Object.keys(raw).some((key) => !['channel', 'sessionId', 'kind', 'requestId', 'actionId', 'value', 'message', 'nodeId'].includes(key))) {
      throw new Error('应用消息包含不支持的字段');
    }
    // 数据额度按 payload 计算，消息外壳不挤占合法结果的大小和层级。
    const data = raw;
    assertFresh();
    switch (data.kind) {
      case 'ready':
        if (initializing) throw new Error('应用界面已重载，请重新打开');
        initializing = true;
        post('init', { definition: options.definition, state,
          inputs: normalizeAiAppJson(captureAiAppResources(options.inputNodeIds).snapshots, 192 * 1024) });
        updateTheme(theme);
        break;
      case 'initialized':
        if (!initializing || initialized) throw new Error('应用初始化响应无效');
        initialized = true;
        clearTimeout(startupTimer);
        resolveReady();
        notify({ error: undefined });
        break;
      case 'executing': {
        if (!initialized || typeof data.requestId !== 'string') throw new Error('应用动作请求无效');
        if (!pending.has(data.requestId)) {
          if (!/^e[a-zA-Z0-9_-]{1,100}$/u.test(data.requestId)) throw new Error('应用动作身份无效');
          begin(data.requestId);
        }
        break;
      }
      case 'state':
        state = normalizeAiAppJson(data.value);
        notify();
        break;
      case 'result': {
        if (typeof data.requestId !== 'string') throw new Error('应用结果身份无效');
        const operation = pending.get(data.requestId);
        if (!operation) return;
        operation.assertFresh();
        result = normalizeAiAppJson(data.value);
        clearTimeout(operation.timer);
        operation.dispose();
        pending.delete(data.requestId);
        operation.resolve?.(result);
        notify({ error: undefined });
        break;
      }
      case 'error': {
        const message = typeof data.message === 'string' ? data.message.slice(0, 240) : '应用执行失败';
        if (typeof data.requestId !== 'string') { dispose(new Error(message)); return; }
        const operation = pending.get(data.requestId);
        if (!operation) return;
        clearTimeout(operation.timer);
        operation.dispose();
        pending.delete(data.requestId);
        operation.reject?.(new Error(message));
        notify({ error: message });
        break;
      }
      case 'resource-request': {
        if (typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(data.requestId)
          || typeof data.nodeId !== 'string' || resourceRequests.has(data.requestId)
          || resourceRequests.size >= 8 || ++resourceCount > 32) throw new Error('应用图片请求无效或超过读取额度');
        const requestId = data.requestId;
        resourceRequests.add(requestId);
        try {
          const value = await options.readImage(data.nodeId);
          assertFresh();
          post('resource-response', { requestId, ok: true, value });
        } catch {
          if (!disposed) { assertFresh(); post('resource-response', { requestId, ok: false, message: '图片未保存到当前项目、已变化或超过读取上限' }); }
        } finally {
          resourceRequests.delete(requestId);
        }
        break;
      }
      default: throw new Error('应用发送了未授权的请求');
    }
  }
  function handleMessage(event: MessageEvent) {
    void receive(event).catch(() => dispose(new Error('应用请求无效或上下文已变化，请重新加载')));
  }
  window.addEventListener('message', handleMessage);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  activeSessions.add(close);
  return {
    src, ready, check, assertFresh, dispose: close,
    attach(value: Window | null) {
      if (!value || disposed || frame === value) return;
      if (frame) { dispose(new Error('应用界面已替换，请重新加载')); return; }
      frame = value;
      startupTimer = setTimeout(() => dispose(new Error('应用启动超时，请重新加载')), 8000);
    },
    async run(actionId: string, input: AiAppJson = {}): Promise<AiAppJson> {
      const action = options.definition.actions.find((entry) => entry.id === actionId);
      if (!action) throw new Error('应用动作未声明');
      const normalized = normalizeAiAppJson(input);
      const validation = validateAgentToolInput(action.inputSchema, normalized);
      if (!validation.valid) throw new Error(`动作参数无效：${validation.errors.join('；')}`);
      await ready;
      assertFresh();
      return new Promise<AiAppJson>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        try {
          begin(requestId, { resolve, reject });
          post('run', { requestId, actionId, input: normalized });
        } catch (error) {
          const cause = error instanceof Error ? error : new Error('动作执行失败');
          if (pending.has(requestId)) dispose(cause);
          reject(cause);
        }
      });
    },
    cancel: () => dispose(new Error('操作已停止，请重新加载应用')),
    updateTheme,
    getState: () => normalizeAiAppJson(state),
    getResult: () => result === undefined ? undefined : normalizeAiAppJson(result),
    isBusy: () => !initialized || pending.size > 0,
  };
}

function mountHidden(session: Pick<AiAppUiSession, 'src' | 'attach'>) {
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.sandbox.add('allow-scripts');
  iframe.referrerPolicy = 'no-referrer';
  iframe.src = session.src;
  iframe.title = 'AI 应用动作运行器';
  document.body.appendChild(iframe);
  session.attach(iframe.contentWindow);
  return () => iframe.remove();
}

export async function validateAiAppCandidate(options: {
  definition: AiAppDefinition;
  inputNodeIds: string[];
  savedState: AiAppJson;
  assertFresh: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  options.assertFresh();
  const projectId = useAppStore.getState().currentProjectId;
  if (!projectId) throw new Error('当前项目不存在');
  const session = sandbox({ ...options, initialState: options.savedState,
    beginExecution: () => ({ assertFresh: options.assertFresh, dispose: () => undefined }),
    readImage: (nodeId) => readAiAppImage(projectId, options.inputNodeIds, nodeId),
  });
  let unmount: (() => void) | undefined;
  try { unmount = mountHidden(session); await session.ready; session.assertFresh(); }
  finally { session.dispose(); unmount?.(); }
}

export async function createAiAppUiSession(options: {
  nodeId: string;
  onChange: (snapshot: AiAppUiSnapshot) => void;
  signal?: AbortSignal;
}): Promise<AiAppUiSession> {
  const initial = getAiAppNode(options.nodeId);
  let app = initial.app;
  const projectId = initial.projectId;
  const expectedContext = captureLegacyCanvasContext(useAppStore.getState());
  if (!expectedContext) throw new Error('应用目标画布上下文已失效');
  let identity = JSON.stringify(app);
  const inputs = captureAiAppResources(app.inputNodeIds, options.nodeId);
  const assertFresh = () => {
    options.signal?.throwIfAborted();
    assertProjectExpectedContextCurrent(expectedContext, useAppStore.getState(), { checkCanvasRevision: false });
    const current = getAiAppNode(options.nodeId, projectId).app;
    if (JSON.stringify(current) !== identity
      || captureAiAppResources(app.inputNodeIds, options.nodeId).fingerprint !== inputs.fingerprint) {
      throw new Error('应用或绑定素材已变化');
    }
  };
  const definition = await loadAiAppDefinition(projectId, app);
  assertFresh();
  let saving = false;
  const session = sandbox({
    definition, inputNodeIds: app.inputNodeIds, initialState: app.savedState, initialResult: app.savedResult,
    signal: options.signal, assertFresh, onChange: options.onChange, onDispose: () => unsubscribe(),
    readImage: (nodeId) => readAiAppImage(projectId, app.inputNodeIds, nodeId),
    beginExecution: () => {
      const guard = registerCanvasDerivation(useAppStore.getState(), options.nodeId);
      if (!guard) throw new Error('应用节点已失效');
      return {
        assertFresh: () => {
          assertFresh();
          if (!isCanvasDerivationFresh(guard, useAppStore.getState())) throw new Error('动作执行期间画布已变化');
        },
        dispose: () => completeCanvasDerivation(guard),
      };
    },
  });
  const unsubscribe = useAppStore.subscribe(() => { if (!saving) session.check(); });
  session.check();
  return {
    src: session.src, attach: session.attach, dispose: session.dispose,
    run: session.run, cancel: session.cancel, updateTheme: session.updateTheme,
    async save() {
      await session.ready;
      session.assertFresh();
      if (session.isBusy()) throw new Error('请等待当前动作完成后再保存');
      saving = true;
      try {
        saveAiAppState(options.nodeId, session.getState(), session.getResult(), app.revision,
          { projectId, expectedContext, baseRevision: useAppStore.getState().getCurrentRevision(), signal: options.signal });
        app = getAiAppNode(options.nodeId, projectId).app;
        identity = JSON.stringify(app);
      } finally { saving = false; }
    },
  };
}

export async function runAiAppAction(nodeId: string, actionId: string, input: AiAppJson,
  context: AiAppMutationContext): Promise<AiAppJson> {
  assertAiAppContext(context);
  const session = await createAiAppUiSession({ nodeId, onChange: () => undefined, signal: context.signal });
  let unmount: (() => void) | undefined;
  try { unmount = mountHidden(session); assertAiAppContext(context); return await session.run(actionId, input); }
  finally { session.dispose(); unmount?.(); }
}
