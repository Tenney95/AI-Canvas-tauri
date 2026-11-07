/** 主窗口独占的原生插件窗口调度；不向插件暴露 Store、事件总线或路径。 */
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import type {
  InstalledPlugin, PluginJsonValue, PluginNodeToolManifest, PluginUiRequestKind,
  PluginUiWindowBinding, PluginUiWindowEvent,
} from '../../types/plugin';
import { createPluginUiNativeSession } from './pluginUiSessionService';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent, parseProjectExpectedContext } from '../projectExecutionContext';

// Windows WebView2 实机已验证专用窗口、CSP/IPC 拒绝、桥接与写回；详见插件实施记录。
// 点击入口与 MCP 共用该发布状态；原生注册、会话租约和 capability 校验仍独立执行。
// 不接受 Manifest、环境变量、URL、localStorage 或插件请求绕过。
const NATIVE_WINDOW_ACCEPTED = true;
export function pluginUiWindowUnavailableReason(): string | null {
  if (!isTauri()) return '当前不是 Tauri 桌面环境，将使用主窗口弹窗';
  return NATIVE_WINDOW_ACCEPTED ? null : '独立窗口尚待真实 WebView 隔离验收，暂用主窗口弹窗';
}

type NativeSession = Awaited<ReturnType<typeof createPluginUiNativeSession>>;
interface OpenWindowOptions {
  plugin: InstalledPlugin;
  tool: PluginNodeToolManifest;
  nodeId: string;
  exportName: string;
  parameters?: Record<string, PluginJsonValue>;
  /** 仅宿主重开协调器设置；新会话仍复核后台任务状态并重新签发资源。 */
  startNewReplica?: boolean;
  signal?: AbortSignal;
}
interface WindowRecord {
  key: string;
  target: Pick<PluginUiWindowBinding, 'projectId' | 'nodeId'>
    & Pick<PluginUiWindowBinding['identity'], 'pluginId' | 'toolId'>;
  expectedContext: PluginUiWindowBinding['expectedContext'];
  session?: NativeSession;
  channel: Channel<PluginUiWindowEvent>;
  ready: Promise<PluginUiWindowBinding>;
  disposed: boolean;
  nativeStarted: boolean;
  opened: boolean;
  contextResponded: boolean;
  seenRequests: Set<string>;
  replicaStatusRequests: number;
  closeRequested: boolean;
  pending: number;
  awaitingClose?: boolean;
  closeTimer?: ReturnType<typeof setTimeout>;
}
const windows = new Map<string, WindowRecord>();
const restarting = new Map<string, Promise<boolean>>();
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const REQUEST_KINDS = new Set<PluginUiRequestKind>(['context', 'effect', 'set-parameters', 'submit', 'close', 'toast']);
const MAX_REQUESTS = 192;
const MAX_REPLICA_STATUS_REQUESTS = 2048;

function isReplicaStatusRequest(request: { kind: PluginUiRequestKind; payload: unknown }): boolean {
  if (request.kind !== 'effect' || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) return false;
  const payload = request.payload as Record<string, unknown>;
  const keys = Object.keys(payload);
  return keys.length === 2 && keys.every((key) => key === 'type' || key === 'jobId') && payload.type === 'video.replicaJob.status'
    && typeof payload.jobId === 'string' && /^video-replica-[a-zA-Z0-9-]{1,80}$/u.test(payload.jobId);
}

function sameBinding(value: unknown, expected: PluginUiWindowBinding): boolean {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Partial<PluginUiWindowBinding>;
  try {
    if (binding.expectedContext !== undefined || expected.expectedContext !== undefined) {
      const actualContext = parseProjectExpectedContext(binding.expectedContext);
      const expectedContext = parseProjectExpectedContext(expected.expectedContext);
      if (!isProjectExpectedContextCurrent(expectedContext, actualContext)) return false;
    }
  } catch { return false; }
  return binding.sessionId === expected.sessionId && binding.projectId === expected.projectId
    && binding.nodeId === expected.nodeId && binding.canvasRevision === expected.canvasRevision
    && binding.identity?.pluginId === expected.identity.pluginId
    && binding.identity?.toolId === expected.identity.toolId
    && binding.identity?.sourceDigest === expected.identity.sourceDigest
    && binding.identity?.revisionDigest === expected.identity.revisionDigest
    && binding.identity?.uiDigest === expected.identity.uiDigest;
}

async function closeNative(record: WindowRecord): Promise<boolean> {
  if (!record.nativeStarted || !record.session) return false;
  try {
    await invoke('close_plugin_ui_window', { binding: record.session.binding });
    return true;
  } catch {
    // 前端租约已同步作废；原生请求超时仍会撤销窗口，不能把失败说成关闭成功。
    useAppStore.getState().showToast('插件会话已撤销，但未确认系统窗口关闭，请手动关闭该窗口', 'error');
    return false;
  }
}

function disposeRecord(record: WindowRecord, closeWindow: boolean): void {
  if (record.disposed) return;
  record.disposed = true;
  if (record.closeTimer) clearTimeout(record.closeTimer);
  if (windows.get(record.key) === record) windows.delete(record.key);
  record.session?.dispose();
  record.channel.onmessage = () => {};
  if (closeWindow) void closeNative(record);
}

async function restartRecord(record: WindowRecord, options: OpenWindowOptions): Promise<void> {
  if (record.disposed) return;
  disposeRecord(record, false);
  // 原生 open 可能尚在返回途中；确认旧绑定已关闭后，才允许相同目标重新创建窗口。
  const closed = record.ready.catch(() => undefined).then(() => closeNative(record));
  restarting.set(record.key, closed);
  try {
    if (!await closed) return;
    const state = useAppStore.getState();
    const plugin = state.installedPlugins.find((item) => item.id === options.plugin.id);
    if (state.currentProjectId !== record.target.projectId || !plugin?.enabled
      || (record.expectedContext && !isProjectExpectedContextCurrent(record.expectedContext, state, { checkCanvasRevision: false }))
      || plugin.sourceDigest !== options.plugin.sourceDigest || plugin.revisionDigest !== options.plugin.revisionDigest
      || plugin.uiDigest !== options.plugin.uiDigest) throw new Error('插件重开身份已变化');
    if (restarting.get(record.key) === closed) restarting.delete(record.key);
    await openPluginUiWindow({ ...options, plugin, startNewReplica: true });
  } catch {
    useAppStore.getState().showToast('插件新会话未能打开，请从当前项目节点重新打开', 'error');
  } finally {
    if (restarting.get(record.key) === closed) restarting.delete(record.key);
  }
}

async function receive(record: WindowRecord, event: PluginUiWindowEvent): Promise<void> {
  const session = record.session;
  if (record.disposed || !session) return;
  // Channel 已由 Rust 登记来源；这里再次核对完整租约，绝不信任普通 postMessage/emit。
  if (!event || !sameBinding(event.binding, session.binding)) {
    disposeRecord(record, true);
    return;
  }
  if (event.type === 'closed') {
    disposeRecord(record, false);
    return;
  }
  // 只读状态查询不挤占普通操作额度；任务身份和查询间隔仍由主窗口 Broker 复核。
  const replicaStatus = event.type === 'request' && isReplicaStatusRequest(event);
  const ordinaryRequests = record.seenRequests.size - record.replicaStatusRequests - Number(record.closeRequested);
  if (event.type !== 'request' || !REQUEST_ID.test(event.requestId)
    || !REQUEST_KINDS.has(event.kind) || record.seenRequests.has(event.requestId)
    || record.pending >= 8
    || (replicaStatus ? record.replicaStatusRequests >= MAX_REPLICA_STATUS_REQUESTS
      : event.kind !== 'close' && ordinaryRequests >= MAX_REQUESTS)
    || (event.kind === 'close' && record.closeRequested)
    || record.seenRequests.size >= MAX_REQUESTS + MAX_REPLICA_STATUS_REQUESTS + 1) {
    disposeRecord(record, true);
    return;
  }
  record.seenRequests.add(event.requestId);
  if (replicaStatus) record.replicaStatusRequests += 1;
  if (event.kind === 'close') record.closeRequested = true;
  record.pending += 1;
  try {
    const reply = record.awaitingClose
      ? (event.kind === 'close' ? { ok: true, value: true } : { ok: false, error: '插件已提交，请重新打开' })
      : await session.request(event.kind, event.payload);
    if (record.disposed || (!record.awaitingClose && !session.isActive())) return;
    if (event.kind === 'submit' && reply.ok) {
      // 回复管理命令成功不代表 WebView 已收到成功。先撤销宿主资源，保留只接收 close 的收尾通道。
      // 引导脚本收到 submit 成功才发送 close；未收到确认也会有界回收，不靠任意延迟猜测 IPC 时序。
      record.awaitingClose = true;
      session.dispose();
      record.closeTimer = setTimeout(() => disposeRecord(record, true), 30_000);
    }
    await invoke('respond_plugin_ui_window_request', {
      binding: session.binding, requestId: event.requestId,
      reply: reply.error ? { ...reply, error: reply.error.slice(0, 1024) } : reply,
    });
    if (!record.disposed && event.kind === 'context' && reply.ok) record.contextResponded = true;
    if (!record.disposed) {
      if (record.awaitingClose) {
        if (event.kind === 'close') disposeRecord(record, true);
      } else session.finishRequest();
    }
  } catch {
    if (!record.disposed) {
      disposeRecord(record, true);
      useAppStore.getState().showToast('插件窗口桥接失败，会话已撤销，请重新打开', 'error');
    }
  } finally {
    record.pending -= 1;
  }
}

/** 只读的主窗口会话投影；不返回绑定秘密、资源、参数或插件页面正文。 */
export function getPluginUiWindowStates(projectId: string, nodeId?: string) {
  if (useAppStore.getState().currentProjectId !== projectId) throw new Error('当前项目已变化');
  return [...windows.values()]
    .filter((record) => !record.disposed && record.target.projectId === projectId
      && (nodeId === undefined || record.target.nodeId === nodeId))
    .map((record) => ({
      ...record.target,
      phase: record.awaitingClose ? 'awaiting-close' as const : record.opened ? 'open' as const : 'opening' as const,
      contextResponded: record.contextResponded,
      requestCount: record.seenRequests.size,
      pendingRequests: record.pending,
    }));
}

/** 只能按当前项目的已登记目标撤销；调用方不能提供原生标签或 session binding。 */
export async function closePluginUiWindow(projectId: string, nodeId: string, pluginId: string, toolId: string) {
  if (useAppStore.getState().currentProjectId !== projectId) throw new Error('当前项目已变化');
  const record = windows.get(JSON.stringify([projectId, nodeId, pluginId, toolId]));
  if (!record) return { found: false, revoked: false, closeCommandAccepted: false, pendingOpen: false };
  const pendingOpen = record.nativeStarted && !record.opened;
  disposeRecord(record, false);
  const closeCommandAccepted = await closeNative(record);
  // 这只是命令回执，不等于操作系统窗口已销毁；迟到 open 仍由原创建链再次关闭。
  return { found: true, revoked: true, closeCommandAccepted, pendingOpen };
}

function nativeOpenOptions(record: WindowRecord, options: OpenWindowOptions) {
  if (!record.session?.isActive()) throw new Error('插件窗口会话已失效');
  return {
    binding: record.session.binding, exportName: record.session.globalExport,
    title: (options.tool.dialog?.title ?? options.tool.title).slice(0, 80),
  };
}

/** 仅供主窗口入口/开发构建 MCP 验收调用；窗口生命周期不随启动组件卸载而结束。 */
export async function openPluginUiWindow(options: OpenWindowOptions): Promise<PluginUiWindowBinding> {
  options.signal?.throwIfAborted();
  if (!isTauri()) throw new Error('插件独立窗口仅支持 Tauri 桌面环境');
  const projectId = useAppStore.getState().currentProjectId;
  if (!projectId) throw new Error('当前项目不存在');
  const expectedContext = captureLegacyCanvasContext(useAppStore.getState());
  if (!expectedContext) throw new Error('项目上下文已失效，请重新打开');
  const assertTargetCurrent = () => {
    if (!isProjectExpectedContextCurrent(expectedContext, useAppStore.getState(), { checkCanvasRevision: false })) {
      throw new Error('项目上下文已变化，请从当前节点重新打开');
    }
  };
  const livePlugin = useAppStore.getState().installedPlugins.find((plugin) => plugin.id === options.plugin.id);
  if (!livePlugin?.enabled || livePlugin.sourceDigest !== options.plugin.sourceDigest
    || livePlugin.revisionDigest !== options.plugin.revisionDigest) throw new Error('插件 revision 已变化');
  const key = JSON.stringify([projectId, options.nodeId, options.plugin.id, options.tool.id]);
  const closing = restarting.get(key);
  if (closing) {
    if (!await closing) throw new Error('旧插件窗口尚未确认关闭，请先手动关闭后重试');
    assertTargetCurrent();
    if (useAppStore.getState().currentProjectId !== projectId) throw new Error('当前项目已变化');
    return openPluginUiWindow(options);
  }
  const existing = windows.get(key);
  if (existing) {
    const binding = await existing.ready;
    assertTargetCurrent();
    options.signal?.throwIfAborted();
    if (existing.disposed || !existing.session?.isActive()) throw new Error('插件窗口会话已失效');
    try {
      const result = await invoke<{ binding: PluginUiWindowBinding; reused: boolean }>('open_plugin_ui_window', {
        options: nativeOpenOptions(existing, options), channel: existing.channel,
      });
      if (existing.disposed) await closeNative(existing);
      if (existing.disposed || !sameBinding(result?.binding, binding) || result.reused !== true) {
        throw new Error('插件窗口复用身份不匹配');
      }
      return binding;
    } catch (error) {
      disposeRecord(existing, true);
      throw error;
    }
  }
  const channel = new Channel<PluginUiWindowEvent>();
  const record: WindowRecord = {
    key, target: { projectId, nodeId: options.nodeId, pluginId: options.plugin.id, toolId: options.tool.id }, expectedContext,
    channel, disposed: false, nativeStarted: false, opened: false, contextResponded: false,
    seenRequests: new Set(), replicaStatusRequests: 0, closeRequested: false, pending: 0,
    // 推迟到 microtask，先完成登记；重复调用共享同一创建 Promise，不重复 mint。
    ready: Promise.resolve().then(async () => {
      try {
        if (record.disposed) throw new Error('插件窗口启动已取消');
        assertTargetCurrent();
        if (useAppStore.getState().currentProjectId !== projectId) throw new Error('当前项目已变化');
        const session = await createPluginUiNativeSession({
          ...options, onClose: () => disposeRecord(record, true),
          onRestart: () => { void restartRecord(record, options); },
        });
        record.session = session;
        if (record.disposed || !session.isActive()) {
          session.dispose();
          throw new Error('插件窗口会话已失效');
        }
        record.nativeStarted = true;
        const result = await invoke<{ binding: PluginUiWindowBinding; reused: boolean }>('open_plugin_ui_window', {
          options: nativeOpenOptions(record, options), channel,
        });
        if (record.disposed) {
          // close 可能先于原生异步 open 登记完成；落地后按同一绑定再次撤销。
          await closeNative(record);
          throw new Error('插件窗口会话已失效');
        }
        if (!sameBinding(result?.binding, session.binding) || result.reused !== false) {
          throw new Error('插件窗口创建身份不匹配，请关闭旧窗口后重试');
        }
        record.opened = true;
        return session.binding;
      } catch (error) {
        disposeRecord(record, true);
        throw error;
      }
    }),
  };
  channel.onmessage = (event) => { void receive(record, event); };
  windows.set(key, record);
  const abort = () => disposeRecord(record, true);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try { return await record.ready; }
  finally { options.signal?.removeEventListener('abort', abort); }
}
