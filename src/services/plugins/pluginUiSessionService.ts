/**
 * 主窗口内插件 UI 会话 Broker。
 *
 * iframe 与专用原生 Channel 使用不同的来源验证，共用同一个资源/effect/写回权威。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { isLocalMediaUrl as isLocalReference } from '../../utils/mediaUrl';
import { getLocale, type Locale } from '../../i18n';
import type { NodeType } from '../../types';
import type {
  InstalledPlugin,
  PluginInvocationResources,
  PluginJsonValue,
  PluginNodeToolManifest,
  PluginUiReply,
  PluginUiRequestKind,
  PluginUiWindowBinding,
  PluginVideoReplicaJobSummary,
} from '../../types/plugin';
import { useAppStore } from '../../store/useAppStore';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from '../canvasDerivationGuard';
import { buildPluginModelCatalog, collectDeclaredModelCategories } from './pluginModelCatalog';
import { assertPluginCompatibility, PLUGIN_HOST } from './pluginHost';
import {
  collectTrustedNodeMediaReferences,
  executeNodePluginTool,
  executePluginUiHostEffect,
  parsePluginVideoReplicaEffect,
} from './pluginRuntime';
import {
  clearPluginInvocationResources,
  mintPluginInvocationResources,
  type PluginResourceReadContext,
} from './pluginResourceService';

const MESSAGE_CHANNEL = 'ai-canvas-plugin-ui-v1';
const MAX_UI_EFFECTS = PLUGIN_HOST.limits.ui.ordinary;
const MAX_UI_RANGE_READS = PLUGIN_HOST.limits.ui.resourceRangeRead;
const MAX_UI_RANGE_BYTES = PLUGIN_HOST.limits.ui.resourceRangeBytes;
const MAX_UI_MEDIA_EFFECTS = PLUGIN_HOST.limits.ui.media;
const MAX_UI_EXPORT_EFFECTS = PLUGIN_HOST.limits.ui.resourceWrite;
const MAX_UI_SESSIONS = 4;
const MAX_UI_REQUESTS = PLUGIN_HOST.limits.ui.total;
const MAX_UI_NETWORK_EFFECTS = PLUGIN_HOST.limits.ui.network;
const MAX_REPLICA_JOB_QUERIES = 2048;
const MIN_REPLICA_JOB_QUERY_INTERVAL_MS = 250;
const MAX_UI_SETTINGS_EFFECTS = PLUGIN_HOST.limits.ui.settings;
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
  rangeReadBudget?: number;
  rangeReadBytes?: number;
  mediaEffectBudget?: number;
  exportEffectBudget?: number;
  networkEffectBudget?: number;
  settingsEffectBudget?: number;
  mentionEffectBudget?: number;
  requestCount: number;
  requestInFlight: boolean;
  /** 后台任务观察会话不再拥有原 UI 的文件 grant 或画布写入租约。 */
  replicaJobId?: string;
  replicaJobLookupPending?: boolean;
  replicaJobQueryCount?: number;
  lastReplicaJobQueryAt?: number;
  effectAbortController?: AbortController;
  trustedMediaReferences: Set<string>;
  onClose: () => void;
}

export interface PluginUiFrameSession {
  sessionId: string;
  src: string;
  attach: (frameWindow: Window | null) => void;
  updateTheme: (theme: 'dark' | 'light') => void;
  updateLocale: (locale: Locale) => void;
  dispose: () => void;
}

const sessions = new Map<string, PluginUiSession>();
let listenerInstalled = false;

function normalizeDigest(value: string | undefined, label: string): string {
  const digest = value?.trim().toLowerCase().replace(/^sha256-/, '');
  if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label}缺失或无效`);
  return digest;
}

function normalizeJson(value: unknown, depth = 0): PluginJsonValue | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (depth > MAX_JSON_DEPTH) throw new Error(`插件界面数据嵌套深度不能超过 ${MAX_JSON_DEPTH} 层`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    if (isLocalReference(value)) return undefined;
    if (value.length > MAX_JSON_STRING) throw new Error(`插件界面数据字符串不能超过 ${MAX_JSON_STRING} 个字符`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) throw new Error(`插件界面数据数组不能超过 ${MAX_JSON_ARRAY} 项`);
    return value
      .map((item) => normalizeJson(item, depth + 1))
      .filter((item): item is PluginJsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    const output: Record<string, PluginJsonValue> = {};
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_KEYS) throw new Error(`插件界面数据对象不能超过 ${MAX_JSON_KEYS} 个键`);
    for (const [key, item] of entries) {
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
  assertPluginCompatibility(plugin.manifest);
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

function replicaJobIdentity(session: PluginUiSession) {
  return {
    projectId: session.projectId, pluginId: session.pluginId, nodeId: session.nodeId,
    sourceDigest: session.sourceDigest, revisionDigest: session.revisionDigest,
  };
}

function supportsReplicaJobs(plugin: InstalledPlugin): boolean {
  return plugin.manifest.apiVersion === 2 && plugin.manifest.runtime === 'python'
    && plugin.manifest.requiredCapabilities?.includes('video.replicaPipeline') === true;
}

function updateReplicaJobParameter(session: PluginUiSession, summary: PluginVideoReplicaJobSummary): void {
  if (session.replicaJobId && summary.jobId !== session.replicaJobId) throw new Error('复刻任务摘要与当前观察任务不匹配');
  if (Object.entries(replicaJobIdentity(session)).some(([key, value]) => summary[key as keyof PluginVideoReplicaJobSummary] !== value)) {
    throw new Error('复刻任务不属于当前插件界面会话');
  }
  const normalized = normalizeJson(summary);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new Error('复刻任务摘要无效');
  session.parameters = { ...session.parameters, replicaJob: normalized };
}

function observeReplicaJob(session: PluginUiSession, summary: PluginVideoReplicaJobSummary): void {
  if (typeof summary.jobId !== 'string' || !/^video-replica-[a-zA-Z0-9-]{1,80}$/u.test(summary.jobId)) throw new Error('复刻任务 ID 无效');
  updateReplicaJobParameter(session, summary);
  session.replicaJobId = summary.jobId;
  session.replicaJobLookupPending = false;
  clearPluginInvocationResources(session.sessionId);
  session.resources = { self: [], incoming: [], inputs: {}, package: [], derived: [] };
  session.trustedMediaReferences.clear();
  completeCanvasDerivation(session.guard);
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
  const effectType = request.kind === 'effect' && request.payload && typeof request.payload === 'object' && 'type' in request.payload
    ? request.payload.type : undefined;
  const replicaObservation = !!session.replicaJobId && request.kind === 'effect'
    && (effectType === 'video.replicaJob.status' || effectType === 'video.replicaJob.cancel');
  if (request.kind !== 'close' && !replicaObservation && session.requestCount >= MAX_UI_REQUESTS) {
    return { ok: false, error: '插件界面请求次数已达上限' };
  }
  if (request.kind !== 'close' && !replicaObservation) session.requestCount += 1;
  const exclusive = request.kind === 'effect'
    || request.kind === 'set-parameters'
    || request.kind === 'submit';
  if (exclusive && session.requestInFlight) {
    return { ok: false, error: '插件界面已有操作正在执行' };
  }
  if (exclusive) session.requestInFlight = true;
  try {
    const plugin = resolveLivePlugin(session, !session.replicaJobId);
    if (session.replicaJobId && (request.kind === 'set-parameters' || request.kind === 'submit'
      || (request.kind === 'effect' && !replicaObservation))) {
      throw new Error('当前界面仅观察已启动任务；不能执行普通操作或再次提交');
    }
    switch (request.kind) {
      case 'context': {
        if (session.replicaJobId) {
          const { getPluginVideoReplicaJob } = await import('./pluginVideoReplicaJobService');
          const summary = await getPluginVideoReplicaJob(replicaJobIdentity(session), session.replicaJobId);
          resolveLivePlugin(session, false);
          updateReplicaJobParameter(session, summary);
        }
        const state = useAppStore.getState();
        const node = state.nodes.find((item) => item.id === session.nodeId);
        if (!node) throw new Error('源节点已不存在');
        const data = safeNodeData(session.tool, node.data);
        return {
          ok: true,
          value: {
            host: PLUGIN_HOST,
            surface: session.surface,
            theme: state.config.theme,
            locale: getLocale(),
            node: { id: session.nodeId, type: node.data.type as NodeType, data },
            models: modelCatalog(plugin, session.tool),
            parameters: session.parameters,
            resources: session.resources,
          },
        };
      }
      case 'effect': {
        if (effectType === 'video.replicaJob.start' || effectType === 'video.replicaJob.status' || effectType === 'video.replicaJob.cancel') {
          if (!supportsReplicaJobs(plugin)) throw new Error('插件未声明完整视频任务能力');
          const effect = parsePluginVideoReplicaEffect(request.payload);
          const service = await import('./pluginVideoReplicaJobService');
          resolveLivePlugin(session, !session.replicaJobId);
          if (effect.type === 'video.replicaJob.start') {
            const controller = new AbortController();
            session.effectAbortController = controller;
            const summary = await service.startPluginVideoReplicaJob({
              ...replicaJobIdentity(session), tool: availableTool(plugin, session),
              resources: session.resources, resourceReadContext: resourceReadContext(session, plugin), signal: controller.signal,
            }, effect).finally(() => {
              if (session.effectAbortController === controller) session.effectAbortController = undefined;
            });
            resolveLivePlugin(session);
            if ('jobId' in summary) observeReplicaJob(session, summary);
            return { ok: true, value: { type: effect.type, ok: true, value: summary } };
          }
          if (!session.replicaJobId || effect.jobId !== session.replicaJobId) throw new Error('只能查询或取消当前界面绑定的复刻任务');
          if ((session.replicaJobQueryCount ?? 0) >= MAX_REPLICA_JOB_QUERIES) throw new Error('复刻任务查询达到 2048 次上限，请重新打开插件');
          const now = Date.now();
          if (effect.type === 'video.replicaJob.status' && session.lastReplicaJobQueryAt !== undefined
            && now - session.lastReplicaJobQueryAt < MIN_REPLICA_JOB_QUERY_INTERVAL_MS) {
            throw new Error('复刻任务查询间隔不能小于 250 毫秒');
          }
          session.replicaJobQueryCount = (session.replicaJobQueryCount ?? 0) + 1;
          if (effect.type === 'video.replicaJob.status') session.lastReplicaJobQueryAt = now;
          const summary = effect.type === 'video.replicaJob.cancel'
            ? await service.cancelPluginVideoReplicaJob(replicaJobIdentity(session), effect.jobId)
            : await service.getPluginVideoReplicaJob(replicaJobIdentity(session), effect.jobId);
          resolveLivePlugin(session, false);
          updateReplicaJobParameter(session, summary);
          return { ok: true, value: { type: effect.type, ok: true, value: summary } };
        }
        if (effectType === 'prompt.mentions') {
          if ((session.mentionEffectBudget ?? 0) >= PLUGIN_HOST.limits.ui.promptMentions) throw new Error('本次会话引用查询达到 96 次上限，请重新打开插件');
          session.mentionEffectBudget = (session.mentionEffectBudget ?? 0) + 1;
        } else if (effectType === 'network.request') {
          if ((session.networkEffectBudget ?? 0) >= MAX_UI_NETWORK_EFFECTS) throw new Error('本次会话网络请求达到 16 次上限');
          session.networkEffectBudget = (session.networkEffectBudget ?? 0) + 1;
        } else if (effectType === 'settings.get' || effectType === 'settings.set' || effectType === 'settings.delete') {
          if ((session.settingsEffectBudget ?? 0) >= MAX_UI_SETTINGS_EFFECTS) throw new Error('本次会话设置操作达到 64 次上限');
          session.settingsEffectBudget = (session.settingsEffectBudget ?? 0) + 1;
        } else if (effectType === 'resource.readRange') {
          const length = (request.payload as Record<string, unknown>).length;
          if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0 || length > 256 * 1024) {
            throw new Error('资源单次读取必须为 1–256 KiB 范围内的整数字节数');
          }
          if ((session.rangeReadBudget ?? 0) >= MAX_UI_RANGE_READS
            || (session.rangeReadBytes ?? 0) + length > MAX_UI_RANGE_BYTES) {
            throw new Error('本次会话分段读取达到 96 次或 16 MiB 上限');
          }
          // 按请求量预留额度，失败也计数；不占用模型调用额度，不改变资源授权校验。
          session.rangeReadBudget = (session.rangeReadBudget ?? 0) + 1;
          session.rangeReadBytes = (session.rangeReadBytes ?? 0) + length;
        } else if (effectType === 'video.extractFrames' || effectType === 'video.detectShots' || effectType === 'video.inspectFrame'
          || effectType === 'image.lineArt') {
          if ((session.mediaEffectBudget ?? 0) >= MAX_UI_MEDIA_EFFECTS) throw new Error('本地媒体操作达到 96 次上限，请重新打开插件');
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
          toolId: session.tool.id,
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
        session.parameters = normalizeJson({ ...session.parameters, ...patch }) as Record<string, PluginJsonValue>;
        return { ok: true, value: true };
      }
      case 'submit': {
        const record = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
          ? request.payload as Record<string, unknown> : {};
        const submitted = record.data;
        if (submitted !== undefined) {
          if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
            throw new Error('提交参数必须是对象');
          }
          const data = normalizeJson(submitted) as Record<string, PluginJsonValue>;
          session.parameters = normalizeJson({ ...session.parameters, ...data }) as Record<string, PluginJsonValue>;
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
      try { resolveLivePlugin(session, !session.submitting && !session.replicaJobId); } catch { closeSession(session.sessionId, true); }
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
    // 此字段只能由宿主绑定的任务摘要注入，不能采信调用方传来的观察身份。
    delete parameters.replicaJob;
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
        resolveLivePlugin(session, !session.submitting && !session.completed && !session.replicaJobId && !session.replicaJobLookupPending);
      } catch { closeSession(sessionId, true); }
    });
    if (supportsReplicaJobs(plugin)) {
      // 尚未 ready，不允许 effect；查找期间只保持版本/项目/节点身份，找到任务后完成旧 guard。
      session.replicaJobLookupPending = true;
      const { findPluginVideoReplicaJob } = await import('./pluginVideoReplicaJobService');
      const summary = await findPluginVideoReplicaJob(replicaJobIdentity(session));
      resolveLivePlugin(session, false);
      session.replicaJobLookupPending = false;
      if (summary) {
        observeReplicaJob(session, summary);
        session.ready = true;
        return { session, globalExport };
      }
      resolveLivePlugin(session);
    }
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
      updateLocale: (locale) => {
        const current = sessions.get(sessionId);
        current?.frameWindow?.postMessage({
          channel: MESSAGE_CHANNEL,
          direction: 'event',
          sessionId,
          kind: 'locale',
          value: locale,
        }, '*');
      },
    };
  } catch (error) {
    closeSession(sessionId, false);
    throw error;
  }
}

/** 仅交给主窗口窗口服务；不在 window、事件总线或持久化状态上暴露。 */
export async function createPluginUiNativeSession(options: CreatePluginUiSessionOptions) {
  const { session, globalExport } = await createSession(options, 'native');
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
    globalExport,
    isActive: () => sessions.get(session.sessionId) === session,
    request: (kind: PluginUiRequestKind, payload: unknown) => dispatchRequest(session, { kind, payload }),
    finishRequest: () => finishRequest(session),
    dispose: () => closeSession(session.sessionId, false),
  };
}
