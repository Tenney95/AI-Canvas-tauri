/** 主窗口独占的原生插件窗口调度；不向插件暴露 Store、事件总线或路径。 */
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import type {
  InstalledPlugin, PluginJsonValue, PluginNodeToolManifest, PluginUiRequestKind,
  PluginUiWindowBinding, PluginUiWindowEvent,
} from '../../types/plugin';
import { createPluginUiNativeSession } from './pluginUiSessionService';

// 发布门禁，不是权限开关：真实 WebView2 CSP/存储/第一方窗口验收前不得改为 true。
// 不接受 Manifest、环境变量、URL、localStorage 或插件请求绕过。
const NATIVE_WINDOW_ACCEPTED = false;
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
}
interface WindowRecord {
  key: string;
  session?: NativeSession;
  channel: Channel<PluginUiWindowEvent>;
  ready: Promise<PluginUiWindowBinding>;
  disposed: boolean;
  nativeStarted: boolean;
  seenRequests: Set<string>;
  pending: number;
  awaitingClose?: boolean;
  closeTimer?: ReturnType<typeof setTimeout>;
}
const windows = new Map<string, WindowRecord>();
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const REQUEST_KINDS = new Set<PluginUiRequestKind>(['context', 'effect', 'set-parameters', 'submit', 'close', 'toast']);

function sameBinding(value: unknown, expected: PluginUiWindowBinding): boolean {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Partial<PluginUiWindowBinding>;
  return binding.sessionId === expected.sessionId && binding.projectId === expected.projectId
    && binding.nodeId === expected.nodeId && binding.canvasRevision === expected.canvasRevision
    && binding.identity?.pluginId === expected.identity.pluginId
    && binding.identity?.toolId === expected.identity.toolId
    && binding.identity?.sourceDigest === expected.identity.sourceDigest
    && binding.identity?.revisionDigest === expected.identity.revisionDigest
    && binding.identity?.uiDigest === expected.identity.uiDigest;
}

async function closeNative(record: WindowRecord): Promise<void> {
  if (!record.nativeStarted || !record.session) return;
  try {
    await invoke('close_plugin_ui_window', { binding: record.session.binding });
  } catch {
    // 前端租约已同步作废；原生请求超时仍会撤销窗口，不能把失败说成关闭成功。
    useAppStore.getState().showToast('插件会话已撤销，但未确认系统窗口关闭，请手动关闭该窗口', 'error');
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
  if (event.type !== 'request' || !REQUEST_ID.test(event.requestId)
    || !REQUEST_KINDS.has(event.kind) || record.seenRequests.has(event.requestId)
    || record.pending >= 8 || (record.seenRequests.size >= 192 && event.kind !== 'close')
    || record.seenRequests.size >= 193) {
    disposeRecord(record, true);
    return;
  }
  record.seenRequests.add(event.requestId);
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

function nativeOpenOptions(record: WindowRecord, options: OpenWindowOptions) {
  if (!record.session?.isActive()) throw new Error('插件窗口会话已失效');
  return {
    binding: record.session.binding, exportName: options.exportName,
    title: (options.tool.dialog?.title ?? options.tool.title).slice(0, 80),
  };
}

/** 仅供受发布门禁保护的主窗口入口调用；窗口生命周期不随启动组件卸载而结束。 */
export async function openPluginUiWindow(options: OpenWindowOptions): Promise<PluginUiWindowBinding> {
  if (!isTauri()) throw new Error('插件独立窗口仅支持 Tauri 桌面环境');
  const projectId = useAppStore.getState().currentProjectId;
  if (!projectId) throw new Error('当前项目不存在');
  const livePlugin = useAppStore.getState().installedPlugins.find((plugin) => plugin.id === options.plugin.id);
  if (!livePlugin?.enabled || livePlugin.sourceDigest !== options.plugin.sourceDigest
    || livePlugin.revisionDigest !== options.plugin.revisionDigest) throw new Error('插件 revision 已变化');
  const key = JSON.stringify([projectId, options.nodeId, options.plugin.id, options.tool.id]);
  const existing = windows.get(key);
  if (existing) {
    const binding = await existing.ready;
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
    key, channel, disposed: false, nativeStarted: false, seenRequests: new Set(), pending: 0,
    // 推迟到 microtask，先完成登记；重复调用共享同一创建 Promise，不重复 mint。
    ready: Promise.resolve().then(async () => {
      try {
        if (useAppStore.getState().currentProjectId !== projectId) throw new Error('当前项目已变化');
        const session = await createPluginUiNativeSession({
          ...options, onClose: () => disposeRecord(record, true),
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
        return session.binding;
      } catch (error) {
        disposeRecord(record, true);
        throw error;
      }
    }),
  };
  channel.onmessage = (event) => { void receive(record, event); };
  windows.set(key, record);
  return record.ready;
}
