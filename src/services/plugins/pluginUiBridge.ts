/**
 * pluginUiBridge — 宿主侧的插件自定义界面窗口管理与 IPC 桥。
 *
 * 插件界面跑在独立 webview 进程里，只能通过 Tauri 事件与主窗口通信。这里负责：
 *   - 打开/关闭界面窗口、维护会话；
 *   - 把模型调用等请求交给 executePluginUiHostEffect（复用权限与媒体来源校验）；
 *   - 把「提交」转成一次标准的 executeNodePluginTool（复用 output 白名单与写回逻辑）。
 *
 * 隔离边界说明：Tauri 事件不携带可靠的发送者身份，这里用不可枚举的会话 ID 作为
 * 承载凭据——每个窗口只能从自己的 URL 读到自己的 sessionId，无法伪造成其它会话。
 * 更强的进程级隔离来自协议 handler（只认 plugin-ui-* 窗口）与 capability 最小授权。
 */
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import type {
  InstalledPlugin,
  PluginJsonValue,
  PluginNodeToolManifest,
  PluginUISurface,
} from '../../types/plugin';
import { useAppStore } from '../../store/useAppStore';
import { buildPluginModelCatalog, collectDeclaredModelCategories } from './pluginModelCatalog';
import { executeNodePluginTool, executePluginUiHostEffect } from './pluginRuntime';

interface PluginUiSession {
  sessionId: string;
  surface: PluginUISurface;
  plugin: InstalledPlugin;
  tool: PluginNodeToolManifest;
  nodeId: string;
  projectId: string | null;
  parameters: Record<string, PluginJsonValue>;
  effectBudget: number;
}

interface PluginUiRequest {
  sessionId: string;
  requestId: string;
  kind: string;
  payload: unknown;
}

const MAX_UI_EFFECTS = 4;
const MAX_REQUEST_ID_LEN = 64;
const MAX_KIND_LEN = 32;
const MAX_PARAMETER_KEYS = 128;
const WINDOW_LABEL_PREFIX = 'plugin-ui-';

const sessions = new Map<string, PluginUiSession>();
let listenerInstalled = false;

function windowLabel(sessionId: string): string {
  return `${WINDOW_LABEL_PREFIX}${sessionId}`;
}

function normalizeUiDigest(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('sha256-') ? normalized.slice(7) : normalized;
}

function parseRequest(raw: unknown): PluginUiRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId.length > 64) return null;
  if (typeof record.requestId !== 'string' || record.requestId.length > MAX_REQUEST_ID_LEN) {
    return null;
  }
  if (typeof record.kind !== 'string' || record.kind.length > MAX_KIND_LEN) return null;
  return { sessionId: record.sessionId, requestId: record.requestId, kind: record.kind, payload: record.payload };
}

async function reply(
  sessionId: string,
  requestId: string,
  result: { ok: boolean; value?: unknown; error?: string },
): Promise<void> {
  await emitTo(windowLabel(sessionId), 'plugin-ui:response', {
    requestId,
    ok: result.ok,
    value: result.value,
    error: result.error,
  });
}

/**
 * 每次请求都重新核对会话与宿主状态，而不是信任安装时抓取的快照：
 * 插件停用、更新、卸载、项目切换或源节点被删后，旧窗口立即失效。
 */
function resolveLivePlugin(session: PluginUiSession): InstalledPlugin {
  const state = useAppStore.getState();
  const plugin = state.installedPlugins.find((item) => item.id === session.plugin.id);
  if (!plugin) throw new Error('插件已卸载');
  if (!plugin.enabled) throw new Error('插件已停用');
  if (plugin.sourceDigest !== session.plugin.sourceDigest) throw new Error('插件版本已变化');
  if (plugin.uiDigest !== session.plugin.uiDigest) throw new Error('插件界面已更新');
  if (state.currentProjectId !== session.projectId) throw new Error('项目已切换');
  if (!state.nodes.some((node) => node.id === session.nodeId)) throw new Error('源节点已不存在');
  return plugin;
}

function modelCatalog(plugin: InstalledPlugin, tool: PluginNodeToolManifest) {
  if (!plugin.manifest.permissions.includes('models.read')) return [];
  const config = useAppStore.getState().config;
  return buildPluginModelCatalog(config, collectDeclaredModelCategories(tool.dialog?.fields ?? []));
}

function availableTool(plugin: InstalledPlugin, session: PluginUiSession) {
  return {
    pluginId: plugin.id,
    pluginName: plugin.manifest.name,
    runtime: plugin.manifest.runtime,
    source: plugin.source,
    sourceDigest: plugin.sourceDigest,
    tool: session.tool,
    permissions: plugin.manifest.permissions,
  };
}

async function closeSession(sessionId: string, closeWindow: boolean): Promise<void> {
  sessions.delete(sessionId);
  if (closeWindow) {
    await invoke('close_plugin_ui_window', { sessionId }).catch(() => undefined);
  }
}

async function handleRequest(raw: unknown): Promise<void> {
  const request = parseRequest(raw);
  if (!request) return;
  const session = sessions.get(request.sessionId);
  if (!session) {
    await reply(request.sessionId, request.requestId, { ok: false, error: '插件界面会话已失效' });
    return;
  }
  try {
    // 除了纯查询，任何涉及宿主能力的请求都先复核租约。
    const plugin = resolveLivePlugin(session);
    switch (request.kind) {
      case 'context': {
        const state = useAppStore.getState();
        const node = state.nodes.find((item) => item.id === session.nodeId);
        const data: Record<string, PluginJsonValue> = {};
        for (const field of session.tool.inputFields) {
          const value = node?.data[field];
          if (value !== undefined) data[field] = value as PluginJsonValue;
        }
        await reply(request.sessionId, request.requestId, {
          ok: true,
          value: {
            surface: session.surface,
            node: { id: session.nodeId, type: node?.data?.type ?? node?.type, data },
            models: modelCatalog(plugin, session.tool),
            parameters: session.parameters,
            values: {},
          },
        });
        return;
      }
      case 'effect': {
        if (session.effectBudget >= MAX_UI_EFFECTS) {
          throw new Error(`宿主操作不能超过 ${MAX_UI_EFFECTS} 次`);
        }
        session.effectBudget += 1;
        const result = await executePluginUiHostEffect({
          pluginId: plugin.id,
          title: session.tool.title,
          permissions: plugin.manifest.permissions,
          runtime: plugin.manifest.runtime,
          nodeId: session.nodeId,
          effect: request.payload,
          models: modelCatalog(plugin, session.tool),
          // JavaScript 没有任意网络能力，媒体来源校验对它生效（空集合 = 只能引用受信来源）。
          trustedMediaReferences:
            plugin.manifest.runtime === 'javascript' ? new Set<string>() : undefined,
        });
        await reply(request.sessionId, request.requestId, { ok: true, value: result });
        return;
      }
      case 'set-parameters': {
        const patch = (request.payload ?? {}) as Record<string, PluginJsonValue>;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('参数更新必须是对象');
        }
        if (Object.keys(patch).length > MAX_PARAMETER_KEYS) {
          throw new Error('参数更新项过多');
        }
        session.parameters = { ...session.parameters, ...patch };
        await reply(request.sessionId, request.requestId, { ok: true, value: true });
        return;
      }
      case 'submit': {
        // 提交语义：以当前 parameters 重新执行插件工具（复用 output 白名单与写回）。
        // data/message 暂未直接写回，保留给未来的直接提交通道。
        await executeNodePluginTool(availableTool(plugin, session), session.nodeId, session.parameters);
        await reply(request.sessionId, request.requestId, { ok: true, value: true });
        await closeSession(request.sessionId, true);
        return;
      }
      case 'close': {
        await reply(request.sessionId, request.requestId, { ok: true, value: true });
        await closeSession(request.sessionId, true);
        return;
      }
      case 'toast': {
        const { message, type } = (request.payload ?? {}) as {
          message?: string;
          type?: 'success' | 'error';
        };
        useAppStore
          .getState()
          .showToast((message ?? '').slice(0, 240), type === 'error' ? 'error' : 'success');
        await reply(request.sessionId, request.requestId, { ok: true, value: true });
        return;
      }
      default:
        throw new Error(`未知请求: ${request.kind}`);
    }
  } catch (error) {
    await reply(request.sessionId, request.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function ensureListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  void listen<unknown>('plugin-ui:request', (event) => {
    void handleRequest(event.payload);
  });
}

/**
 * 打开插件自定义界面窗口并建立会话。
 *
 * @param exportName 引用 manifest.ui.exports 的**键**（例如 dialog.ui 的值）。
 */
export async function openPluginUiSurface(options: {
  plugin: InstalledPlugin;
  tool: PluginNodeToolManifest;
  nodeId: string;
  surface: PluginUISurface;
  exportName: string;
  parameters?: Record<string, PluginJsonValue>;
}): Promise<void> {
  ensureListener();
  const ui = options.plugin.manifest.ui;
  if (!ui) throw new Error('插件没有声明自定义界面');
  const globalExport = ui.exports[options.exportName];
  if (!globalExport) throw new Error(`插件未导出组件: ${options.exportName}`);
  const uiDigest = options.plugin.uiDigest ?? normalizeUiDigest(ui.integrity);
  const projectId = useAppStore.getState().currentProjectId;
  const sessionId = crypto.randomUUID();

  // 先预登记会话，避免窗口先于 session 就位而让首次 context 请求落空。
  sessions.set(sessionId, {
    sessionId,
    surface: options.surface,
    plugin: options.plugin,
    tool: options.tool,
    nodeId: options.nodeId,
    projectId,
    parameters: options.parameters ?? {},
    effectBudget: 0,
  });
  try {
    await invoke('open_plugin_ui_window', {
      sessionId,
      pluginId: options.plugin.id,
      uiDigest,
      exportName: globalExport,
      title: options.tool.title,
    });
  } catch (error) {
    sessions.delete(sessionId);
    throw error;
  }
}
