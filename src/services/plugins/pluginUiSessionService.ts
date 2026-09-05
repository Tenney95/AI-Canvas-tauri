/**
 * 主窗口内插件 UI 会话 Broker。
 *
 * 第三方界面运行在 sandboxed iframe 中，不进入宿主 React DOM；所有宿主能力都通过
 * 绑定 frame Window、sessionId、插件 revision、项目、节点和画布 revision 的消息通道。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import type { NodeType } from '../../types';
import type {
  InstalledPlugin,
  PluginInvocationResources,
  PluginJsonValue,
  PluginNodeToolManifest,
} from '../../types/plugin';
import { useAppStore } from '../../store/useAppStore';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from '../canvasDerivationGuard';
import { buildPluginModelCatalog, collectDeclaredModelCategories } from './pluginModelCatalog';
import {
  collectTrustedNodeMediaReferences,
  executeNodePluginTool,
  executePluginUiHostEffect,
} from './pluginRuntime';
import {
  clearPluginInvocationResources,
  mintPluginInvocationResources,
  type PluginResourceReadContext,
} from './pluginResourceService';

const MESSAGE_CHANNEL = 'ai-canvas-plugin-ui-v1';
const MAX_UI_EFFECTS = 4;
const MAX_UI_SESSIONS = 4;
const MAX_UI_REQUESTS = 64;
const MAX_REQUEST_ID_LENGTH = 64;
const MAX_KIND_LENGTH = 32;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 128;
const MAX_JSON_ARRAY = 256;
const MAX_JSON_STRING = 256_000;
const FORBIDDEN_NODE_INPUT_FIELDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'filePath',
  'relativePath',
  'directorCaptureFilePaths',
]);

interface PluginUiRequestEnvelope {
  channel: typeof MESSAGE_CHANNEL;
  direction: 'request';
  sessionId: string;
  requestId: string;
  kind: string;
  payload: unknown;
}

interface PluginUiSession {
  sessionId: string;
  surface: 'tool-dialog';
  pluginId: string;
  sourceDigest: string;
  revisionDigest: string;
  uiDigest: string;
  tool: PluginNodeToolManifest;
  nodeId: string;
  projectId: string;
  parameters: Record<string, PluginJsonValue>;
  resources: PluginInvocationResources;
  guard: CanvasDerivationGuard;
  frameWindow?: Window;
  effectBudget: number;
  requestCount: number;
  requestInFlight: boolean;
  effectAbortController?: AbortController;
  trustedMediaReferences: Set<string>;
  onClose: () => void;
}

export interface PluginUiFrameSession {
  sessionId: string;
  src: string;
  attach: (frameWindow: Window | null) => void;
  updateTheme: (theme: 'dark' | 'light') => void;
  dispose: () => void;
}

const sessions = new Map<string, PluginUiSession>();
let listenerInstalled = false;

function normalizeDigest(value: string | undefined, label: string): string {
  const digest = value?.trim().toLowerCase().replace(/^sha256-/, '');
  if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label}缺失或无效`);
  return digest;
}

function isLocalReference(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('asset:')
    || normalized.startsWith('file:')
    || normalized.startsWith('blob:')
    || normalized.startsWith('data:')
    || normalized.startsWith('http://asset.localhost/')
    || normalized.startsWith('https://asset.localhost/');
}

function normalizeJson(value: unknown, depth = 0): PluginJsonValue | undefined {
  if (depth > MAX_JSON_DEPTH || value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return isLocalReference(value) ? undefined : value.slice(0, MAX_JSON_STRING);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_JSON_ARRAY)
      .map((item) => normalizeJson(item, depth + 1))
      .filter((item): item is PluginJsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    const output: Record<string, PluginJsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_JSON_KEYS)) {
      if (FORBIDDEN_NODE_INPUT_FIELDS.has(key)) continue;
      const normalized = normalizeJson(item, depth + 1);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

function safeNodeData(
  tool: PluginNodeToolManifest,
  nodeData: Record<string, unknown>,
): Record<string, PluginJsonValue> {
  const data: Record<string, PluginJsonValue> = {};
  for (const field of tool.inputFields) {
    if (FORBIDDEN_NODE_INPUT_FIELDS.has(field)) continue;
    const normalized = normalizeJson(nodeData[field]);
    if (normalized !== undefined) data[field] = normalized;
  }
  return data;
}

function resolveLivePlugin(session: PluginUiSession): InstalledPlugin {
  const state = useAppStore.getState();
  const plugin = state.installedPlugins.find((item) => item.id === session.pluginId);
  if (!plugin?.enabled) throw new Error('插件已停用或卸载');
  if (plugin.sourceDigest !== session.sourceDigest || plugin.revisionDigest !== session.revisionDigest) {
    throw new Error('插件 revision 已变化');
  }
  if (normalizeDigest(plugin.uiDigest ?? plugin.manifest.ui?.integrity, '插件界面摘要') !== session.uiDigest) {
    throw new Error('插件界面已更新');
  }
  if (!isCanvasDerivationFresh(session.guard, state)) throw new Error('画布或项目已变化，插件界面会话已失效');
  return plugin;
}

function modelCatalog(plugin: InstalledPlugin, tool: PluginNodeToolManifest) {
  if (!plugin.manifest.permissions.includes('models.read')) return [];
  return buildPluginModelCatalog(
    useAppStore.getState().config,
    collectDeclaredModelCategories(tool.dialog?.fields ?? []),
  );
}

function availableTool(plugin: InstalledPlugin, session: PluginUiSession) {
  return {
    pluginId: plugin.id,
    pluginName: plugin.manifest.name,
    runtime: plugin.manifest.runtime,
    source: plugin.source,
    sourceDigest: plugin.sourceDigest,
    revisionDigest: plugin.revisionDigest,
    tool: session.tool,
    permissions: plugin.manifest.permissions,
  };
}

function resourceReadContext(session: PluginUiSession, plugin: InstalledPlugin): PluginResourceReadContext {
  return {
    pluginId: plugin.id,
    sourceDigest: session.sourceDigest,
    revisionDigest: session.revisionDigest,
    invocationId: session.sessionId,
    projectId: session.projectId,
    nodeId: session.nodeId,
    baseRevision: session.guard.baseRevision,
    permissions: plugin.manifest.permissions,
    state: useAppStore.getState(),
  };
}

function postResponse(
  session: PluginUiSession,
  requestId: string,
  result: { ok: boolean; value?: unknown; error?: string },
): void {
  session.frameWindow?.postMessage({
    channel: MESSAGE_CHANNEL,
    direction: 'response',
    sessionId: session.sessionId,
    requestId,
    ...result,
  }, '*');
}

function closeSession(sessionId: string, notify: boolean): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.effectAbortController?.abort();
  clearPluginInvocationResources(session.sessionId);
  completeCanvasDerivation(session.guard);
  if (notify) queueMicrotask(session.onClose);
}

function parseRequest(data: unknown): PluginUiRequestEnvelope | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  if (raw.channel !== MESSAGE_CHANNEL || raw.direction !== 'request') return null;
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length > 64) return null;
  if (typeof raw.requestId !== 'string' || raw.requestId.length > MAX_REQUEST_ID_LENGTH) return null;
  if (typeof raw.kind !== 'string' || raw.kind.length > MAX_KIND_LENGTH) return null;
  return raw as unknown as PluginUiRequestEnvelope;
}

async function handleRequest(event: MessageEvent): Promise<void> {
  const request = parseRequest(event.data);
  if (!request) return;
  const session = sessions.get(request.sessionId);
  if (!session || event.source !== session.frameWindow) return;
  if (request.kind !== 'close' && session.requestCount >= MAX_UI_REQUESTS) {
    postResponse(session, request.requestId, { ok: false, error: '插件界面请求次数已达上限' });
    return;
  }
  if (request.kind !== 'close') session.requestCount += 1;
  const exclusive = request.kind === 'effect'
    || request.kind === 'set-parameters'
    || request.kind === 'submit';
  if (exclusive && session.requestInFlight) {
    postResponse(session, request.requestId, { ok: false, error: '插件界面已有操作正在执行' });
    return;
  }
  if (exclusive) session.requestInFlight = true;
  try {
    const plugin = resolveLivePlugin(session);
    switch (request.kind) {
      case 'context': {
        const state = useAppStore.getState();
        const node = state.nodes.find((item) => item.id === session.nodeId);
        if (!node) throw new Error('源节点已不存在');
        const data = safeNodeData(session.tool, node.data);
        postResponse(session, request.requestId, {
          ok: true,
          value: {
            surface: session.surface,
            theme: state.config.theme,
            node: { id: session.nodeId, type: node.data.type as NodeType, data },
            models: modelCatalog(plugin, session.tool),
            parameters: session.parameters,
            resources: session.resources,
          },
        });
        return;
      }
      case 'effect': {
        if (session.effectBudget >= MAX_UI_EFFECTS) throw new Error(`宿主操作不能超过 ${MAX_UI_EFFECTS} 次`);
        session.effectBudget += 1;
        const controller = new AbortController();
        session.effectAbortController = controller;
        const result = await executePluginUiHostEffect({
          pluginId: plugin.id,
          projectId: session.projectId,
          title: session.tool.title,
          permissions: plugin.manifest.permissions,
          nodeId: session.nodeId,
          effect: request.payload,
          models: modelCatalog(plugin, session.tool),
          trustedMediaReferences: session.trustedMediaReferences,
          resources: session.resources,
          resourceReadContext: resourceReadContext(session, plugin),
          signal: controller.signal,
        }).finally(() => {
          if (session.effectAbortController === controller) session.effectAbortController = undefined;
        });
        resolveLivePlugin(session);
        postResponse(session, request.requestId, { ok: true, value: result });
        return;
      }
      case 'set-parameters': {
        const patch = normalizeJson(request.payload);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('参数更新必须是对象');
        session.parameters = { ...session.parameters, ...patch };
        postResponse(session, request.requestId, { ok: true, value: true });
        return;
      }
      case 'submit': {
        const payload = normalizeJson(request.payload);
        const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        const submitted = record.data;
        if (submitted !== undefined) {
          if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
            throw new Error('提交参数必须是对象');
          }
          session.parameters = { ...session.parameters, ...submitted };
        }
        await executeNodePluginTool(
          availableTool(plugin, session),
          session.nodeId,
          session.parameters,
          {
            invocationId: session.sessionId,
            guard: session.guard,
            resources: session.resources,
            trustedMediaReferences: session.trustedMediaReferences,
          },
        );
        postResponse(session, request.requestId, { ok: true, value: true });
        closeSession(session.sessionId, true);
        return;
      }
      case 'close': {
        postResponse(session, request.requestId, { ok: true, value: true });
        closeSession(session.sessionId, true);
        return;
      }
      case 'toast': {
        const payload = normalizeJson(request.payload);
        const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        const message = typeof record.message === 'string' ? record.message.slice(0, 240) : '';
        useAppStore.getState().showToast(message, record.type === 'error' ? 'error' : 'success');
        postResponse(session, request.requestId, { ok: true, value: true });
        return;
      }
      default:
        throw new Error(`未知请求: ${request.kind}`);
    }
  } catch (error) {
    postResponse(session, request.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (exclusive) session.requestInFlight = false;
  }
}

function ensureListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('message', (event) => void handleRequest(event));
}

export async function createPluginUiFrameSession(options: {
  plugin: InstalledPlugin;
  tool: PluginNodeToolManifest;
  nodeId: string;
  exportName: string;
  parameters?: Record<string, PluginJsonValue>;
  onClose: () => void;
}): Promise<PluginUiFrameSession> {
  if (sessions.size >= MAX_UI_SESSIONS) throw new Error(`同时最多打开 ${MAX_UI_SESSIONS} 个插件界面`);
  ensureListener();
  const state = useAppStore.getState();
  const plugin = state.installedPlugins.find((item) => item.id === options.plugin.id);
  if (!plugin?.enabled) throw new Error('插件已停用或卸载');
  const sourceDigest = normalizeDigest(plugin.sourceDigest, '插件源码摘要');
  const revisionDigest = normalizeDigest(plugin.revisionDigest, '插件 revision 摘要');
  const ui = plugin.manifest.ui;
  if (!ui) throw new Error('插件没有声明自定义界面');
  const globalExport = ui.exports[options.exportName];
  if (!globalExport) throw new Error(`插件未导出组件: ${options.exportName}`);
  const uiDigest = normalizeDigest(plugin.uiDigest ?? ui.integrity, '插件界面摘要');
  const projectId = state.currentProjectId;
  if (!projectId) throw new Error('当前项目不存在');
  const guard = registerCanvasDerivation(state, options.nodeId);
  if (!guard) throw new Error('无法创建插件界面保护');
  const sessionId = crypto.randomUUID();
  try {
    const resources = await mintPluginInvocationResources({
      pluginId: plugin.id,
      sourceDigest,
      revisionDigest,
      invocationId: sessionId,
      projectId,
      nodeId: options.nodeId,
      baseRevision: guard.baseRevision,
      access: options.tool.resourceAccess,
      packageResources: plugin.manifest.resources,
      state,
    });
    const parameters = normalizeJson(options.parameters ?? {});
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new Error('插件界面初始参数无效');
    }
    const targetNode = state.nodes.find((node) => node.id === options.nodeId);
    if (!targetNode) throw new Error('插件目标节点不存在');
    const trustedMediaReferences = collectTrustedNodeMediaReferences(
      targetNode.data.type as NodeType,
      safeNodeData(options.tool, targetNode.data),
    );
    const session: PluginUiSession = {
      sessionId,
      surface: 'tool-dialog',
      pluginId: plugin.id,
      sourceDigest,
      revisionDigest,
      uiDigest,
      tool: options.tool,
      nodeId: options.nodeId,
      projectId,
      parameters,
      resources,
      guard,
      effectBudget: 0,
      requestCount: 0,
      requestInFlight: false,
      trustedMediaReferences,
      onClose: options.onClose,
    };
    sessions.set(sessionId, session);
    const bundleUrl = new URL(convertFileSrc(plugin.id, 'plugin-ui'));
    bundleUrl.searchParams.set('digest', uiDigest);
    const bundle = bundleUrl.toString();
    const query = new URLSearchParams({ session: sessionId, export: globalExport, bundle });
    return {
      sessionId,
      src: `/plugin-ui-host.html?${query.toString()}`,
      attach: (frameWindow) => {
        const current = sessions.get(sessionId);
        if (current && frameWindow) current.frameWindow = frameWindow;
      },
      updateTheme: (theme) => {
        const current = sessions.get(sessionId);
        current?.frameWindow?.postMessage({
          channel: MESSAGE_CHANNEL,
          direction: 'event',
          sessionId,
          kind: 'theme',
          value: theme,
        }, '*');
      },
      dispose: () => closeSession(sessionId, false),
    };
  } catch (error) {
    clearPluginInvocationResources(sessionId);
    completeCanvasDerivation(guard);
    throw error;
  }
}
