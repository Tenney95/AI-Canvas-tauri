/**
 * 主窗口内插件 UI 会话 Broker。
 *
 * iframe 与专用原生 Channel 使用不同的来源验证，共用同一个资源/effect/写回权威。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import type { NodeType } from '../../types';
import type {
  InstalledPlugin,
  PluginInvocationResources,
  PluginJsonValue,
  PluginNodeToolManifest,
  PluginUiReply,
  PluginUiRequestKind,
  PluginUiWindowBinding,
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
const MAX_UI_MEDIA_EFFECTS = 96;
const MAX_UI_EXPORT_EFFECTS = 12;
const MAX_UI_SESSIONS = 4;
const MAX_UI_REQUESTS = 192;
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
  transport: 'frame' | 'native';
  ready: boolean;
  submitting: boolean;
  completed: boolean;
  unsubscribe?: () => void;
  effectBudget: number;
  mediaEffectBudget?: number;
  exportEffectBudget?: number;
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

function resolveLivePlugin(session: PluginUiSession, checkCanvas = true): InstalledPlugin {
  if (sessions.get(session.sessionId) !== session) throw new Error('插件界面会话已关闭');
  const state = useAppStore.getState();
  const plugin = state.installedPlugins.find((item) => item.id === session.pluginId);
  if (!plugin?.enabled) throw new Error('插件已停用或卸载');
  if (plugin.sourceDigest !== session.sourceDigest || plugin.revisionDigest !== session.revisionDigest) {
    throw new Error('插件 revision 已变化');
  }
  if (normalizeDigest(plugin.uiDigest ?? plugin.manifest.ui?.integrity, '插件界面摘要') !== session.uiDigest) {
    throw new Error('插件界面已更新');
  }
  if (state.currentProjectId !== session.projectId || !state.nodes.some((node) => node.id === session.nodeId)
    || (checkCanvas && !isCanvasDerivationFresh(session.guard, state))) {
    throw new Error('画布或项目已变化，插件界面会话已失效');
  }
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
  session.unsubscribe?.();
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
  if (!session || session.transport !== 'frame' || !session.frameWindow || event.source !== session.frameWindow) return;
  const reply = await dispatchRequest(session, request);
  if (sessions.get(session.sessionId) !== session) return;
  postResponse(session, request.requestId, reply);
  finishRequest(session);
}

function finishRequest(session: PluginUiSession): void {
  if (session.completed) closeSession(session.sessionId, true);
}

async function dispatchRequest(
  session: PluginUiSession,
  request: { kind: string; payload: unknown },
): Promise<PluginUiReply> {
  if (!session.ready || session.completed || sessions.get(session.sessionId) !== session) {
    return { ok: false, error: '插件界面会话不可用' };
  }
  if (request.kind !== 'close' && session.requestCount >= MAX_UI_REQUESTS) {
    return { ok: false, error: '插件界面请求次数已达上限' };
  }
  if (request.kind !== 'close') session.requestCount += 1;
  const exclusive = request.kind === 'effect'
    || request.kind === 'set-parameters'
    || request.kind === 'submit';
  if (exclusive && session.requestInFlight) {
    return { ok: false, error: '插件界面已有操作正在执行' };
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
        return {
          ok: true,
          value: {
            surface: session.surface,
            theme: state.config.theme,
            node: { id: session.nodeId, type: node.data.type as NodeType, data },
            models: modelCatalog(plugin, session.tool),
            parameters: session.parameters,
            resources: session.resources,
          },
        };
      }
      case 'effect': {
        const effectType = request.payload && typeof request.payload === 'object' && 'type' in request.payload
          ? request.payload.type : undefined;
        if (effectType === 'video.extractFrames' || effectType === 'video.detectShots' || effectType === 'video.inspectFrame') {
          if ((session.mediaEffectBudget ?? 0) >= MAX_UI_MEDIA_EFFECTS) throw new Error('本地视频操作达到 96 次上限，请重新打开插件');
          session.mediaEffectBudget = (session.mediaEffectBudget ?? 0) + 1;
        } else if (effectType === 'resource.export' || effectType === 'resource.createText') {
          if ((session.exportEffectBudget ?? 0) >= MAX_UI_EXPORT_EFFECTS) throw new Error('本次会话导出达到 12 次上限');
          session.exportEffectBudget = (session.exportEffectBudget ?? 0) + 1;
        } else {
          if (session.effectBudget >= MAX_UI_EFFECTS) throw new Error(`宿主操作不能超过 ${MAX_UI_EFFECTS} 次`);
          session.effectBudget += 1;
        }
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
        return { ok: true, value: result };
      }
      case 'set-parameters': {
        const patch = normalizeJson(request.payload);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('参数更新必须是对象');
        session.parameters = { ...session.parameters, ...patch };
        return { ok: true, value: true };
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
        const controller = new AbortController();
        session.effectAbortController = controller;
        session.submitting = true;
        await executeNodePluginTool(
          availableTool(plugin, session),
          session.nodeId,
          session.parameters,
          {
            invocationId: session.sessionId,
            guard: session.guard,
            resources: session.resources,
            trustedMediaReferences: session.trustedMediaReferences,
            signal: controller.signal,
          },
        );
        // 工具自身已在提交前检查 guard；成功写回会推进 revision，不能把自己的提交误判为过期。
        resolveLivePlugin(session, false);
        session.completed = true;
        return { ok: true, value: true };
      }
      case 'close': {
        session.completed = true;
        return { ok: true, value: true };
      }
      case 'toast': {
        const payload = normalizeJson(request.payload);
        const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        const message = typeof record.message === 'string' ? record.message.slice(0, 240) : '';
        useAppStore.getState().showToast(message, record.type === 'error' ? 'error' : 'success');
        return { ok: true, value: true };
      }
      default:
        throw new Error(`未知请求: ${request.kind}`);
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (exclusive) session.requestInFlight = false;
    if (request.kind === 'submit') {
      session.submitting = false;
      session.effectAbortController = undefined;
    }
    if (!session.completed) {
      try { resolveLivePlugin(session, !session.submitting); } catch { closeSession(session.sessionId, true); }
    }
  }
}

function ensureListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('message', (event) => void handleRequest(event));
}

interface CreatePluginUiSessionOptions {
  plugin: InstalledPlugin;
  tool: PluginNodeToolManifest;
  nodeId: string;
  exportName: string;
  parameters?: Record<string, PluginJsonValue>;
  onClose: () => void;
}

async function createSession(
  options: CreatePluginUiSessionOptions,
  transport: PluginUiSession['transport'],
): Promise<{ session: PluginUiSession; globalExport: string }> {
  if (sessions.size >= MAX_UI_SESSIONS) throw new Error(`同时最多打开 ${MAX_UI_SESSIONS} 个插件界面`);
  const state = useAppStore.getState();
  const plugin = state.installedPlugins.find((item) => item.id === options.plugin.id);
  if (!plugin?.enabled) throw new Error('插件已停用或卸载');
  const sourceDigest = normalizeDigest(plugin.sourceDigest, '插件源码摘要');
  const revisionDigest = normalizeDigest(plugin.revisionDigest, '插件 revision 摘要');
  if (normalizeDigest(options.plugin.sourceDigest, '插件源码摘要') !== sourceDigest
    || normalizeDigest(options.plugin.revisionDigest, '插件 revision 摘要') !== revisionDigest) {
    throw new Error('插件 revision 已变化');
  }
  const tool = plugin.manifest.contributes.nodeTools.find((item) => item.id === options.tool.id);
  if (!tool || tool.dialog?.ui !== options.exportName || !plugin.manifest.permissions.includes('ui.custom')) {
    throw new Error('插件工具界面声明不匹配');
  }
  const ui = plugin.manifest.ui;
  if (!ui) throw new Error('插件没有声明自定义界面');
  const globalExport = ui.exports[options.exportName];
  if (!globalExport) throw new Error(`插件未导出组件: ${options.exportName}`);
  const uiDigest = normalizeDigest(plugin.uiDigest ?? ui.integrity, '插件界面摘要');
  const projectId = state.currentProjectId;
  if (!projectId) throw new Error('当前项目不存在');
  const sessionId = crypto.randomUUID();
  const guard = registerCanvasDerivation(state, options.nodeId, {
    onCancel: () => closeSession(sessionId, true),
  });
  if (!guard) throw new Error('无法创建插件界面保护');
  try {
    const parameters = normalizeJson(options.parameters ?? {});
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new Error('插件界面初始参数无效');
    }
    const targetNode = state.nodes.find((node) => node.id === options.nodeId);
    if (!targetNode || !tool.nodeTypes.includes(targetNode.data.type as NodeType)) throw new Error('插件目标节点无效');
    const session: PluginUiSession = {
      sessionId, surface: 'tool-dialog', pluginId: plugin.id, sourceDigest, revisionDigest, uiDigest,
      tool, nodeId: options.nodeId, projectId, parameters, guard, transport,
      resources: { self: [], incoming: [], inputs: {}, package: [], derived: [] },
      ready: false, submitting: false, completed: false,
      effectBudget: 0, requestCount: 0, requestInFlight: false,
      trustedMediaReferences: collectTrustedNodeMediaReferences(
        targetNode.data.type as NodeType, safeNodeData(tool, targetNode.data),
      ),
      onClose: options.onClose,
    };
    // 在异步 mint 前占用配额并监听失效，避免关闭/切项目后再注册一个迟到会话。
    sessions.set(sessionId, session);
    session.unsubscribe = useAppStore.subscribe(() => {
      try {
        // 提交中的普通 revision 变更由执行链每轮/写回前的 guard 检查负责。
        resolveLivePlugin(session, !session.submitting && !session.completed);
      } catch { closeSession(sessionId, true); }
    });
    session.resources = await mintPluginInvocationResources({
      pluginId: plugin.id,
      sourceDigest,
      revisionDigest,
      invocationId: sessionId,
      projectId,
      nodeId: options.nodeId,
      baseRevision: guard.baseRevision,
      access: tool.resourceAccess,
      packageResources: plugin.manifest.resources,
      state,
    });
    resolveLivePlugin(session);
    session.ready = true;
    return { session, globalExport };
  } catch (error) {
    closeSession(sessionId, false);
    // mint 可能在撤销之后才返回，必须再清理一次新增的 grant。
    clearPluginInvocationResources(sessionId);
    completeCanvasDerivation(guard);
    throw error;
  }
}

export async function createPluginUiFrameSession(options: CreatePluginUiSessionOptions): Promise<PluginUiFrameSession> {
  ensureListener();
  const { session, globalExport } = await createSession(options, 'frame');
  const { sessionId, uiDigest, pluginId } = session;
  try {
    const bundleUrl = new URL(convertFileSrc(pluginId, 'plugin-ui'));
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
    closeSession(sessionId, false);
    throw error;
  }
}

/** 仅交给主窗口窗口服务；不在 window、事件总线或持久化状态上暴露。 */
export async function createPluginUiNativeSession(options: CreatePluginUiSessionOptions) {
  const { session } = await createSession(options, 'native');
  const binding: PluginUiWindowBinding = Object.freeze({
    sessionId: session.sessionId,
    identity: Object.freeze({
      pluginId: session.pluginId, sourceDigest: session.sourceDigest, revisionDigest: session.revisionDigest,
      uiDigest: session.uiDigest, toolId: session.tool.id,
    }),
    projectId: session.projectId, nodeId: session.nodeId, canvasRevision: session.guard.baseRevision,
  });
  return {
    binding,
    isActive: () => sessions.get(session.sessionId) === session,
    request: (kind: PluginUiRequestKind, payload: unknown) => dispatchRequest(session, { kind, payload }),
    finishRequest: () => finishRequest(session),
    dispose: () => closeSession(session.sessionId, false),
  };
}
