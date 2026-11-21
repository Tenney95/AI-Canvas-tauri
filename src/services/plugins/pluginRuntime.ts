/**
 * pluginRuntime — 执行插件工具、节点与宿主能力并管理版本租约。
 */
import { invoke } from '@tauri-apps/api/core';
import { isLocalMediaUrl as isLocalMediaReference } from '../../utils/mediaUrl';
import { getLocale } from '../../i18n';
import type { Edge, Node } from '@xyflow/react';
import { isWsagentPluginTool } from './pluginWsagentSharedImages';
import type { BaseNodeData, NodeType } from '../../types';
import type {
  AvailablePluginNode,
  AvailableNodePluginTool,
  InstalledPlugin,
  NodePluginInvocationInput,
  PluginCustomNodePortManifest,
  PluginModelSummary,
  PluginNodeHostEffect,
  PluginNodeHostEffectResult,
  PluginNodeInvocationInput,
  PluginJsonValue,
  PluginPermission,
  PluginPlacement,
  PluginInvocationResources,
  PluginInvocationIdentity,
  PythonPluginRuntimeStatus,
} from '../../types/plugin';
import { useAppStore } from '../../store/useAppStore';
import type { CanvasContext } from '../../types/project';
import { isProjectExpectedContextCurrent } from '../projectExecutionContext';
import { resolvePluginDependencies } from './pluginDependencyService';
import { createPluginLifecycleScope } from './pluginLifecycleScope';
import { derivedNodePlacement, generateId } from '../../store/store.utils';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from '../canvasDerivationGuard';
import { generateText } from '../ai/generateText';
import { generateImage } from '../ai/generateImage';
import { generateVideo } from '../ai/generateVideo';
import { generateAudio } from '../ai/generateAudio';
import { moveToTrash, saveBinaryToProjectData } from '../fileService';
import { inspectVideoNode } from '../videoBatchPlanning';
import type { VideoPreflightItem } from '../../types/videoBatch';
import {
  clearPluginInvocationResources,
  mintPluginInvocationResources,
  assertPluginResourceContextCurrent,
  readPluginResourceRange,
  readPluginResourceText,
  readPluginDerivedResourceForOutput,
  getPluginLineArtResource,
  setPluginLineArtResource,
  registerPluginDerivedResource,
  getPluginPlaybackResource,
  registerPluginPlaybackResource,
  readPluginPlaybackRange,
  replacePluginDerivedResources,
  resolvePluginResourceHostUrl,
  resolvePluginMediaWorkspaceInputs,
  type PluginResourceReadContext,
} from './pluginResourceService';
import { buildPluginModelCatalog, collectDeclaredModelCategories } from './pluginModelCatalog';
import { createPluginLineArtImage } from './pluginImageService';
import { detectPluginVideoShots, extractPluginVideoFrames, inspectPluginVideoFrame } from './pluginVideoFrameService';
import { assertPluginCompatibility, PLUGIN_HOST } from './pluginHost';
import { queryPluginPromptMentions, resolvePluginPromptReferencesForModel } from './pluginPromptReferenceService';
import {
  toPluginJson,
  buildInvocationInput,
  validateResult,
  recordValue,
  preserveHostShotVideos,
  collectNodeToolMediaReferences,
  collectPluginNodeMediaReferences,
  addTrustedModelEffectReference,
  parseHostEffect,
  validatePluginNodeResult,
  normalizePluginToolParameters,
} from './pluginRuntimeContract';
import { type PluginMaterialLayout, preparePluginNodeSet } from './pluginNodeSetPreparation';

export { collectTrustedNodeMediaReferences, parsePluginVideoReplicaEffect } from './pluginRuntimeContract';

const MAX_HOST_EFFECTS = PLUGIN_HOST.limits.tool.total;

function reserveToolEffect(counts: Record<string, number>, effect: PluginNodeHostEffect): void {
  const category = effect.type === 'model.generate' ? 'model'
    : effect.type === 'network.request' ? 'network'
      : effect.type.startsWith('settings.') ? 'settings'
        : effect.type === 'resource.readText' || effect.type === 'resource.readRange' ? 'resourceRead'
          : effect.type === 'resource.export' || effect.type === 'resource.createText' ? 'resourceWrite' : 'media';
  const limit = PLUGIN_HOST.limits.tool[category];
  if ((counts[category] ?? 0) >= limit) throw new Error(`插件 ${category} 操作不能超过 ${limit} 次`);
  counts[category] = (counts[category] ?? 0) + 1;
}

function requirePluginSourceDigest(
  plugins: InstalledPlugin[],
  pluginId: string,
  expectedDigest: string | undefined,
): string {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('插件描述符缺少已登记的源码摘要，请重新选择插件后再执行');
  }
  const plugin = plugins.find((item) => item.id === pluginId);
  if (!plugin?.enabled) throw new Error('插件已被禁用或卸载');
  const digest = plugin.sourceDigest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('插件缺少已登记的源码摘要，请重新安装或完成迁移后再执行');
  }
  if (digest !== expectedDigest) {
    throw new Error('插件版本已更新，请重新选择插件后再执行');
  }
  return digest;
}

function requirePluginRevisionDigest(
  plugins: InstalledPlugin[],
  pluginId: string,
  expectedDigest: string | undefined,
): string {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('插件描述符缺少完整 revision 摘要，请重新选择插件后再执行');
  }
  const plugin = plugins.find((item) => item.id === pluginId);
  const digest = plugin?.revisionDigest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('插件缺少完整 revision 摘要，请重新安装后再执行');
  }
  if (digest !== expectedDigest) throw new Error('插件版本已更新，请重新选择插件后再执行');
  return digest;
}

function requireCurrentPluginRevision(pluginId: string, sourceDigest: string, revisionDigest: string) {
  const current = useAppStore.getState();
  requirePluginSourceDigest(current.installedPlugins, pluginId, sourceDigest);
  requirePluginRevisionDigest(current.installedPlugins, pluginId, revisionDigest);
  assertPluginCompatibility(current.installedPlugins.find((plugin) => plugin.id === pluginId)!.manifest);
  if (!resolvePluginDependencies(current.installedPlugins, pluginId).ready) throw new Error('插件依赖已失效');
  return current;
}

function createPluginInvocationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${generateId()}-${generateId()}`;
}

function watchPluginExecution(
  pluginId: string, sourceDigest: string, revisionDigest: string,
  guard: CanvasDerivationGuard, upstream?: AbortSignal,
) {
  const scope = createPluginLifecycleScope();
  const dependencyFingerprint = resolvePluginDependencies(useAppStore.getState().installedPlugins, pluginId).fingerprint;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  upstream?.addEventListener('abort', cancel, { once: true });
  const check = () => {
    if (controller.signal.aborted || !scope.isActive()) return;
    try {
      const state = requireCurrentPluginRevision(pluginId, sourceDigest, revisionDigest);
      if (resolvePluginDependencies(state.installedPlugins, pluginId).fingerprint !== dependencyFingerprint) cancel();
      if (!isCanvasDerivationFresh(guard, state)) cancel();
    } catch { cancel(); }
  };
  const unsubscribe = useAppStore.subscribe(check);
  scope.defer(() => upstream?.removeEventListener('abort', cancel));
  scope.defer(unsubscribe);
  if (upstream?.aborted) cancel();
  check();
  return {
    signal: controller.signal,
    dispose: () => { cancel(); void scope.dispose().catch(() => undefined); },
  };
}

async function invokePluginTool(
  identity: { pluginId: string; sourceDigest: string; revisionDigest: string; toolId: string; invocationId: string },
  input: PluginNodeInvocationInput | NodePluginInvocationInput,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error('插件操作已取消');
  const cancel = () => {
    void invoke('cancel_node_plugin_tool', { pluginId: identity.pluginId, invocationId: identity.invocationId })
      .catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await invoke<unknown>('execute_node_plugin_tool', { ...identity, input });
    if (signal.aborted) throw new Error('插件操作已取消');
    return result;
  } catch (error) {
    // Rust command 的错误会以字符串返回，转成 Error 才能让界面显示原生诊断。
    throw typeof error === 'string' ? new Error(error) : error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export function getAvailableNodePluginTools(
  plugins: InstalledPlugin[],
  nodeType: NodeType | undefined,
  placement: PluginPlacement = 'node-context-menu',
  wsagentDialogOnly = false,
): AvailableNodePluginTool[] {
  if (!nodeType) return [];
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    return (plugin.manifest.contributes.nodeTools ?? [])
      .filter((tool) => tool.nodeTypes.includes(nodeType) && tool.placements.includes(placement)
        && isWsagentPluginTool(plugin.id, tool.id) === wsagentDialogOnly)
      .map((tool) => ({
        pluginId: plugin.id,
        pluginName: plugin.manifest.name,
        sourceDigest: plugin.sourceDigest,
        revisionDigest: plugin.revisionDigest,
        runtime: plugin.manifest.runtime ?? 'javascript',
        source: plugin.source,
        tool,
        permissions: plugin.manifest.permissions,
      }));
  });
}

/** 节点工具的模型目录：只在声明 models.read 时给出，且始终不含凭据。 */
export function buildNodeToolModelCatalog(
  pluginTool: AvailableNodePluginTool,
): PluginModelSummary[] {
  if (!pluginTool.permissions.includes('models.read')) return [];
  return buildPluginModelCatalog(
    useAppStore.getState().config,
    collectDeclaredModelCategories(pluginTool.tool.dialog?.fields ?? []),
  );
}

export function getAvailablePluginNodes(plugins: InstalledPlugin[]): AvailablePluginNode[] {
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    return (plugin.manifest.contributes.nodes ?? []).map((node) => ({
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
      sourceDigest: plugin.sourceDigest,
      revisionDigest: plugin.revisionDigest,
      runtime: plugin.manifest.runtime ?? 'javascript',
      source: plugin.source,
      node,
      permissions: plugin.manifest.permissions,
    }));
  });
}

export function createPluginNode(
  pluginNode: AvailablePluginNode,
  position: { x: number; y: number },
): Node<BaseNodeData> {
  const pluginValues = Object.fromEntries(
    pluginNode.node.fields.flatMap((field) => (
      field.defaultValue === undefined ? [] : [[field.id, field.defaultValue]]
    )),
  );
  return {
    id: `node-${generateId()}`,
    type: 'plugin-node',
    position,
    data: {
      label: pluginNode.node.title,
      type: 'plugin-node',
      status: 'idle',
      nodeWidth: 320,
      nodeHeight: Math.min(520, Math.max(180, 132 + (pluginNode.node.fields.length * 58))),
      pluginId: pluginNode.pluginId,
      pluginNodeId: pluginNode.node.id,
      pluginValues,
      pluginOutputs: {},
    },
  };
}

function pluginHandlePortId(handle: string | null | undefined, prefix: 'plugin-in-' | 'plugin-out-'): string | undefined {
  if (!handle?.startsWith(prefix)) return undefined;
  const portId = handle.slice(prefix.length);
  return portId || undefined;
}

function connectedInputValue(data: BaseNodeData, type: string): PluginJsonValue | undefined {
  if (type === 'resource') return undefined;
  const value = type === 'image'
    ? data.imageUrl ?? data.thumbnailUrl ?? data.output
    : type === 'video'
      ? data.videoUrl ?? data.output
      : type === 'audio'
        ? data.audioUrl ?? data.output
        : type === 'json'
          ? data.pluginOutputs ?? data.output
          : data.output ?? data.prompt;
  if (typeof value === 'string' && isLocalMediaReference(value)) return undefined;
  return toPluginJson(value, 0, true);
}

function connectedEdgeValue(
  source: Node<BaseNodeData>,
  sourceHandle: string | null | undefined,
  targetPort: PluginCustomNodePortManifest,
  plugins: InstalledPlugin[],
): PluginJsonValue | undefined {
  const sourcePortId = pluginHandlePortId(sourceHandle, 'plugin-out-');
  if (source.data.type !== 'plugin-node' || !sourcePortId) {
    return connectedInputValue(source.data, targetPort.type);
  }

  const pluginId = typeof source.data.pluginId === 'string' ? source.data.pluginId : undefined;
  const pluginNodeId = typeof source.data.pluginNodeId === 'string' ? source.data.pluginNodeId : undefined;
  const installedPlugin = plugins.find((item) => item.id === pluginId);
  if (!installedPlugin) throw new Error('来源插件未安装或已卸载，请重新连接端口');
  const sourceNode = installedPlugin.manifest.contributes.nodes?.find((item) => item.id === pluginNodeId);
  if (!sourceNode) throw new Error('来源插件节点已不存在，请重新连接端口');
  const sourcePort = sourceNode.outputs.find((item) => item.id === sourcePortId);
  if (!sourcePort) throw new Error(`来源插件输出端口「${sourcePortId}」已不存在，请重新连接端口`);
  if (sourcePort.type !== targetPort.type) {
    throw new Error(
      `端口类型不兼容：来源「${sourcePort.label}」为 ${sourcePort.type}，目标「${targetPort.label}」为 ${targetPort.type}`,
    );
  }

  return toPluginJson(recordValue(source.data.pluginOutputs)[sourcePortId]);
}

function buildPluginNodeInputs(pluginNode: AvailablePluginNode, nodeId: string): Record<string, PluginJsonValue> {
  const state = useAppStore.getState();
  const values: Record<string, PluginJsonValue[]> = {};
  for (const edge of state.edges.filter((item) => item.target === nodeId)) {
    const portId = pluginHandlePortId(edge.targetHandle, 'plugin-in-');
    const port = pluginNode.node.inputs.find((item) => item.id === portId);
    const source = state.nodes.find((item) => item.id === edge.source);
    if (!port || !source) continue;
    const value = connectedEdgeValue(source, edge.sourceHandle, port, state.installedPlugins);
    if (value === undefined) continue;
    (values[port.id] ??= []).push(value);
  }
  const output: Record<string, PluginJsonValue> = {};
  for (const port of pluginNode.node.inputs) {
    const portValues = values[port.id] ?? [];
    if (!port.multiple && portValues.length > 1) throw new Error(`输入「${port.label}」只允许一条连线`);
    if (portValues.length > 0) output[port.id] = port.multiple ? portValues : portValues[0];
  }
  return output;
}

function stringParameter(parameters: Record<string, PluginJsonValue>, key: string): string | undefined {
  return typeof parameters[key] === 'string' ? parameters[key] : undefined;
}

function numberParameter(parameters: Record<string, PluginJsonValue>, key: string): number | undefined {
  return typeof parameters[key] === 'number' && Number.isFinite(parameters[key])
    ? parameters[key] as number
    : undefined;
}

async function executeModelEffect(
  effect: Extract<PluginNodeHostEffect, { type: 'model.generate' }>,
  models: PluginModelSummary[],
  nodeId: string,
  /** 已通过来源校验的参考图：连线输入与插件显式提交的 imageUrls。 */
  imageUrls: string[],
  signal?: AbortSignal,
): Promise<PluginJsonValue> {
  const model = models.find((item) => item.id === effect.modelId);
  if (!model) throw new Error('插件请求的模型不在当前可调用列表中');
  const parameters = effect.parameters ?? {};
  const common = { prompt: effect.prompt, model: model.id, provider: model.provider, nodeId };
  if (model.category === 'text') {
    return { text: await generateText({ ...common, imageUrls, signal }) };
  }
  if (model.category === 'image') {
    const result = await generateImage({
      ...common,
      imageSize: stringParameter(parameters, 'imageSize'),
      aspectRatio: stringParameter(parameters, 'aspectRatio'),
      image_urls: imageUrls,
    }, signal);
    return { url: result.url };
  }
  if (model.category === 'video') {
    const result = await generateVideo({
      ...common,
      videoResolution: numberParameter(parameters, 'videoResolution'),
      videoFps: numberParameter(parameters, 'videoFps'),
      videoFrames: numberParameter(parameters, 'videoFrames'),
      seedanceResolution: stringParameter(parameters, 'resolution'),
      seedanceRatio: stringParameter(parameters, 'aspectRatio'),
      seedanceDuration: numberParameter(parameters, 'duration'),
      generateAudio: typeof parameters.generateAudio === 'boolean' ? parameters.generateAudio : undefined,
    }, signal);
    return { url: result.url };
  }
  const result = await generateAudio({
    ...common,
    audioVoice: stringParameter(parameters, 'voice') as never,
    audioFormat: stringParameter(parameters, 'format') as never,
    audioSpeed: numberParameter(parameters, 'speed'),
    musicTitle: stringParameter(parameters, 'title'),
    musicLyrics: stringParameter(parameters, 'lyrics'),
    musicBpm: numberParameter(parameters, 'bpm'),
    musicDuration: numberParameter(parameters, 'duration'),
  }, signal);
  return { url: result.url, title: result.title ?? null, lyrics: result.lyrics ?? null };
}

/**
 * 宿主操作的执行上下文。节点工具没有输入端口，因此连线输入是可选的；
 * 缺少连线时参考图只来自插件显式提交并通过来源校验的 imageUrls。
 */
interface PluginHostEffectContext {
  pluginId: string;
  toolId?: string;
  projectId: string;
  title: string;
  permissions: PluginPermission[];
  resources?: PluginInvocationResources;
  resourceReadContext?: PluginResourceReadContext;
  pluginNode?: AvailablePluginNode;
  inputs?: Record<string, PluginJsonValue>;
  signal?: AbortSignal;
}

function allResourceRefs(resources: PluginInvocationResources | undefined) {
  if (!resources) return [];
  return [
    ...resources.self,
    ...resources.incoming,
    ...resources.package,
    ...resources.derived,
  ];
}

function connectedImageValues(
  pluginNode: AvailablePluginNode,
  inputs: Record<string, PluginJsonValue>,
): string[] {
  return pluginNode.node.inputs
    .filter((port) => port.type === 'image')
    .flatMap((port) => {
      const value = inputs[port.id];
      return (Array.isArray(value) ? value : [value])
        .filter((item): item is string => typeof item === 'string');
    });
}

async function executeHostEffect(
  context: PluginHostEffectContext,
  nodeId: string,
  effect: PluginNodeHostEffect,
  models: PluginModelSummary[],
): Promise<PluginNodeHostEffectResult> {
  const assertFresh = () => {
    if (context.signal?.aborted) throw new Error('插件操作已取消');
    const lease = context.resourceReadContext;
    if (!lease) throw new Error('插件资源会话已失效');
    const current = requireCurrentPluginRevision(context.pluginId, lease.sourceDigest, lease.revisionDigest);
    assertPluginResourceContextCurrent({ ...lease, state: current });
    if (current.currentProjectId !== context.projectId || current.getCurrentRevision() !== lease.baseRevision
      || !current.nodes.some((node) => node.id === nodeId)) throw new Error('画布已变化，插件操作已撤销');
  };
  try {
    if (context.signal?.aborted) throw new Error('插件操作已取消');
    if (effect.type === 'video.replicaJob.start' || effect.type === 'video.replicaJob.status' || effect.type === 'video.replicaJob.cancel' || effect.type === 'video.replicaJob.restart') {
      throw new Error('完整复刻任务必须通过已绑定的插件界面会话执行');
    }
    if (effect.type === 'prompt.mentions') {
      if (!context.permissions.includes('prompt.references.read')) throw new Error('插件未声明 prompt.references.read 权限');
      assertFresh();
      if (!context.resources || !context.resourceReadContext) throw new Error('插件引用会话已失效');
      const value = await queryPluginPromptMentions({ context: context.resourceReadContext, resources: context.resources,
        source: effect.source, query: effect.query, offset: effect.offset, preview: effect.preview, signal: context.signal });
      assertFresh();
      return { type: effect.type, ok: true, value: toPluginJson(value) };
    }
    if (effect.type === 'network.request' || effect.type === 'settings.get' || effect.type === 'settings.set' || effect.type === 'settings.delete') {
      const permission = effect.type === 'network.request' ? 'network.request' : effect.type === 'settings.get' ? 'settings.read' : 'settings.write';
      if (!context.permissions.includes(permission)) throw new Error(`插件未声明 ${permission} 权限`);
      assertFresh();
      const lease = context.resourceReadContext!;
      if (!context.toolId) throw new Error('插件工具身份缺失');
      const identity = { pluginId: context.pluginId, sourceDigest: lease.sourceDigest, revisionDigest: lease.revisionDigest, toolId: context.toolId, invocationId: lease.invocationId };
      const requestId = createPluginInvocationId();
      const cancel = () => { void invoke('cancel_plugin_host_effect', { pluginId: context.pluginId, requestId }).catch(() => undefined); };
      context.signal?.addEventListener('abort', cancel, { once: true });
      try {
        assertFresh();
        const value = await invoke<unknown>('execute_plugin_host_effect', { identity, requestId, effect });
        assertFresh();
        return { type: effect.type, ok: true, value: toPluginJson(value) };
      } finally {
        context.signal?.removeEventListener('abort', cancel);
      }
    }
    if (effect.type === 'model.generate') {
      if (!context.permissions.includes('models.invoke')) throw new Error('插件未声明 models.invoke 权限');
      const resourceImageUrls = await Promise.all((effect.resourceIds ?? []).map(async (resourceId) => {
        const resource = allResourceRefs(context.resources).find((item) => item.resourceId === resourceId);
        if (!resource) throw new Error('模型调用引用了当前调用范围外的资源');
        if (!resource.mediaType.startsWith('image/')) throw new Error('模型参考资源必须是图像');
        if (!context.resourceReadContext) throw new Error('插件资源会话已失效');
        return resolvePluginResourceHostUrl(context.resourceReadContext, resourceId);
      }));
      const imageUrls = [
        ...(context.pluginNode && context.inputs
          ? connectedImageValues(context.pluginNode, context.inputs)
          : []),
        ...(effect.imageUrls ?? []),
        ...resourceImageUrls,
      ];
      assertFresh();
      let modelEffect = effect;
      if (context.permissions.includes('prompt.references.read')) {
        if (!context.resources || !context.resourceReadContext) throw new Error('插件引用会话已失效');
        const resolved = await resolvePluginPromptReferencesForModel(effect.prompt, { context: context.resourceReadContext, resources: context.resources });
        modelEffect = { ...effect, prompt: resolved.prompt };
        imageUrls.push(...resolved.imageUrls);
      } else if (/@\{plugin-ref-/u.test(effect.prompt)) throw new Error('插件未声明 prompt.references.read 权限');
      assertFresh();
      const value = await executeModelEffect(modelEffect, models, nodeId, [...new Set(imageUrls)], context.signal);
      assertFresh();
      return {
        type: effect.type,
        ok: true,
        value,
      };
    }
    if (effect.type === 'resource.readText') {
      if (!context.resourceReadContext) throw new Error('插件资源会话已失效');
      const value = await readPluginResourceText(
        context.resourceReadContext,
        effect.resourceId,
        effect.maxBytes,
      );
      return { type: effect.type, ok: true, value: toPluginJson(value) };
    }
    if (effect.type === 'resource.readRange' || effect.type === 'video.readPlayback') {
      if (!context.resourceReadContext) throw new Error('插件资源会话已失效');
      assertFresh();
      const value = await (effect.type === 'video.readPlayback' ? readPluginPlaybackRange : readPluginResourceRange)(
        context.resourceReadContext,
        effect.resourceId,
        effect.offset,
        effect.length,
      );
      assertFresh();
      return { type: effect.type, ok: true, value: toPluginJson(value) };
    }
    if (effect.type === 'image.lineArt') {
      if (!context.permissions.includes('files.connected.read') || !context.permissions.includes('files.output.create')) {
        throw new Error('线稿转换要求 files.connected.read 与 files.output.create 权限');
      }
      assertFresh();
      const lease = context.resourceReadContext!;
      if (!context.resources?.derived.some((resource) => resource.resourceId === effect.resourceId)) {
        throw new Error('线稿转换只能读取当前调用的派生图像');
      }
      let image = getPluginLineArtResource(lease, effect.resourceId);
      if (!image) {
        const original = readPluginDerivedResourceForOutput(lease, effect.resourceId);
        image = await createPluginLineArtImage({ bytes: original.bytes, mediaType: original.resource.mediaType }, {
          signal: context.signal,
          assertFresh,
        });
        assertFresh();
        setPluginLineArtResource(lease, effect.resourceId, image);
      }
      assertFresh();
      return { type: effect.type, ok: true, value: {
        resourceId: effect.resourceId,
        representation: 'lineart',
        width: image.width,
        height: image.height,
        previewDataUrl: image.previewDataUrl,
      } };
    }
    if (effect.type === 'video.extractFrames' || effect.type === 'video.detectShots' || effect.type === 'video.inspectFrame' || effect.type === 'video.preparePlayback') {
      if (
        !context.permissions.includes('files.connected.read')
        || !context.permissions.includes('files.output.create')
      ) {
        throw new Error('视频抽帧要求 files.connected.read 与 files.output.create 权限');
      }
      if (!context.resources || !context.resourceReadContext) throw new Error('插件资源会话已失效');
      const source = context.resources.self.find((resource) => resource.resourceId === effect.resourceId);
      if (
        !source
        || source.origin !== 'node-self'
        || source.source?.nodeId !== nodeId
        || !source.mediaType.startsWith('video/')
      ) {
        throw new Error('视频抽帧只能读取当前节点的 self 视频资源');
      }
      const url = await resolvePluginResourceHostUrl(context.resourceReadContext, effect.resourceId);
      assertFresh();
      if (effect.type === 'video.preparePlayback') {
        const cached = getPluginPlaybackResource(context.resourceReadContext, effect.resourceId);
        if (cached) return { type: effect.type, ok: true, value: toPluginJson(cached) };
        const { createPluginVideoPlayback } = await import('./pluginVideoPlaybackService');
        const preview = await createPluginVideoPlayback({ url, signal: context.signal, assertFresh });
        assertFresh();
        await resolvePluginResourceHostUrl(context.resourceReadContext, effect.resourceId);
        assertFresh();
        const resource = registerPluginPlaybackResource(context.resourceReadContext, effect.resourceId, preview);
        return { type: effect.type, ok: true, value: toPluginJson({ resource, duration: preview.duration, hasAudio: preview.hasAudio }) };
      }
      if (effect.type === 'video.detectShots' || effect.type === 'video.inspectFrame') {
        const value = effect.type === 'video.detectShots'
          ? await detectPluginVideoShots({ ...effect, url, signal: context.signal })
          : await inspectPluginVideoFrame({ ...effect, url, signal: context.signal });
        assertFresh();
        return { type: effect.type, ok: true, value: toPluginJson(value) };
      }
      const batch = await extractPluginVideoFrames({
        url,
        mode: effect.mode,
        count: effect.count,
        samples: effect.samples,
        signal: context.signal,
      });
      assertFresh();
      const entries = batch.frames.flatMap((frame) => !('error' in frame) && frame.bytes ? [{
        displayName: `${frame.key}.jpg`, mediaType: frame.mediaType, bytes: frame.bytes,
      }] : []);
      if (batch.contactSheet) entries.push({ displayName: 'frame-contact-sheet.jpg', ...batch.contactSheet });
      const refs = effect.replaceDerived
        ? replacePluginDerivedResources(context.resourceReadContext, context.resources, entries)
        : entries.map((entry) => registerPluginDerivedResource(context.resourceReadContext!, context.resources!, entry));
      let resourceIndex = 0;
      const frames = batch.frames.map((frame) => {
        if ('error' in frame) return frame;
        const resource = frame.bytes ? refs[resourceIndex++] : undefined;
        return {
          key: frame.key,
          requestedTime: frame.requestedTime,
          actualTime: frame.actualTime,
          frameDuration: frame.frameDuration,
          width: frame.width,
          height: frame.height,
          previewDataUrl: frame.previewDataUrl,
          resourceId: resource?.resourceId,
        };
      });
      const contactSheet = batch.contactSheet ? refs[resourceIndex] : undefined;
      return {
        type: effect.type,
        ok: true,
        value: toPluginJson({
          video: batch.video,
          frames,
          contactSheetResourceId: contactSheet?.resourceId,
        }),
      };
    }
    if (!context.permissions.includes('files.output.create')) {
      throw new Error('插件未声明 files.output.create 权限');
    }
    if (effect.type !== 'resource.export' && effect.type !== 'resource.createText') {
      throw new Error('此宿主操作不能创建文件');
    }
    // 导出只接受当前 invocation 的派生图像，不暴露任意路径读写。
    if (effect.type === 'resource.export' && !context.resourceReadContext) throw new Error('插件资源会话已失效');
    if (context.resourceReadContext) assertFresh();
    const exported = effect.type === 'resource.export' && context.resourceReadContext
      ? readPluginDerivedResourceForOutput(context.resourceReadContext, effect.resourceId)
      : undefined;
    const safeCharacters = Array.from(
      (effect.suggestedName || exported?.resource.displayName || 'plugin-output.txt').replace(/[<>:"/\\|?*]/gu, '_'),
      (character) => (character.codePointAt(0)! <= 0x1f ? '_' : character),
    ).join('');
    const suggestedName = safeCharacters
      .replace(/^\.+/u, '')
      .trim()
      .slice(0, 120) || 'plugin-output.txt';
    const bytes = exported?.bytes ?? new TextEncoder().encode(effect.type === 'resource.createText' ? effect.content : '');
    const saved = await saveBinaryToProjectData(bytes, context.projectId, suggestedName);
    if (!saved) throw new Error(`无法在当前项目中创建「${context.title}」输出`);
    if (context.resourceReadContext) {
      try { assertFresh(); } catch (error) { await moveToTrash(saved.filePath); throw error; }
    }
    const fileName = saved.filePath.replace(/\\/gu, '/').split('/').at(-1) ?? suggestedName;
    return {
      type: effect.type,
      ok: true,
      value: { fileName, bytes: bytes.byteLength },
    };
  } catch (error) {
    return {
      type: effect.type,
      ok: false,
      error: error instanceof Error ? error.message : '宿主操作失败',
    };
  }
}

function outputPatch(
  pluginNode: AvailablePluginNode,
  outputs: Record<string, PluginJsonValue>,
): Partial<BaseNodeData> {
  const patch: Partial<BaseNodeData> = { pluginOutputs: outputs };
  for (const port of pluginNode.node.outputs) {
    const value = outputs[port.id];
    if (typeof value !== 'string') continue;
    if (port.type === 'image' && patch.imageUrl === undefined) patch.imageUrl = value;
    else if (port.type === 'video' && patch.videoUrl === undefined) patch.videoUrl = value;
    else if (port.type === 'audio' && patch.audioUrl === undefined) patch.audioUrl = value;
    else if ((port.type === 'text' || port.type === 'json') && patch.output === undefined) patch.output = value;
  }
  return patch;
}

export async function executePluginNode(
  pluginNode: AvailablePluginNode,
  nodeId: string,
  models: PluginModelSummary[],
): Promise<void> {
  const before = useAppStore.getState();
  const projectId = before.currentProjectId;
  const sourceNode = before.nodes.find((node) => node.id === nodeId);
  if (!projectId || !sourceNode) throw new Error('插件节点或项目不存在');
  const sourceDigest = requirePluginSourceDigest(
    before.installedPlugins,
    pluginNode.pluginId,
    pluginNode.sourceDigest,
  );
  const revisionDigest = requirePluginRevisionDigest(
    before.installedPlugins,
    pluginNode.pluginId,
    pluginNode.revisionDigest,
  );
  const installedPlugin = before.installedPlugins.find((item) => item.id === pluginNode.pluginId);
  if (!installedPlugin) throw new Error('插件已被卸载');
  const invocationId = createPluginInvocationId();
  const values = toPluginJson(sourceNode.data.pluginValues) as Record<string, PluginJsonValue> | undefined;
  for (const field of pluginNode.node.fields) {
    const value = values?.[field.id];
    const missing = value === undefined || value === null || value === '' || (field.type === 'boolean' && value !== true);
    if (field.required && missing) throw new Error(`请填写「${field.label}」`);
  }
  const inputs = buildPluginNodeInputs(pluginNode, nodeId);
  const cancellation = new AbortController();
  const guard = registerCanvasDerivation(before, nodeId, { onCancel: () => cancellation.abort() });
  if (!guard) throw new Error('无法创建插件执行保护');
  const execution = watchPluginExecution(pluginNode.pluginId, sourceDigest, revisionDigest, guard, cancellation.signal);
  const assertFresh = () => {
    const current = requireCurrentPluginRevision(pluginNode.pluginId, sourceDigest, revisionDigest);
    if (!isCanvasDerivationFresh(guard, current)) throw new Error('画布已变化，插件结果未写入');
    if (execution.signal.aborted) throw new Error('插件操作已取消');
    return current;
  };
  const trustedMediaReferences = pluginNode.runtime === 'javascript'
    ? collectPluginNodeMediaReferences(pluginNode, inputs)
    : undefined;
  let effectResult: PluginNodeHostEffectResult | undefined;
  const effectCounts: Record<string, number> = {};

  try {
    const resources = await mintPluginInvocationResources({
      pluginId: pluginNode.pluginId,
      sourceDigest,
      revisionDigest,
      invocationId,
      projectId,
      nodeId,
      baseRevision: guard.baseRevision,
      expectedContext: guard.expectedContext,
      getState: useAppStore.getState,
      access: pluginNode.node.resourceAccess,
      inputPorts: pluginNode.node.inputs,
      packageResources: installedPlugin.manifest.resources,
      state: before,
    });
    for (const port of pluginNode.node.inputs) {
      const connectedResources = resources.inputs[port.id] ?? [];
      const connectedValues = inputs[port.id];
      const valueCount = Array.isArray(connectedValues)
        ? connectedValues.length
        : connectedValues === undefined ? 0 : 1;
      if (!port.multiple && connectedResources.length > 1) {
        throw new Error(`输入「${port.label}」只允许一条连线`);
      }
      if (port.required && valueCount === 0 && connectedResources.length === 0) {
        throw new Error(`缺少必填输入「${port.label}」`);
      }
    }
    const resourceReadContext = (): PluginResourceReadContext => ({
      pluginId: pluginNode.pluginId,
      sourceDigest,
      revisionDigest,
      invocationId,
      projectId,
      nodeId,
      baseRevision: guard.baseRevision,
      expectedContext: guard.expectedContext,
      getState: useAppStore.getState,
      permissions: pluginNode.permissions,
      state: useAppStore.getState(),
    });
    for (let iteration = 0; iteration <= MAX_HOST_EFFECTS; iteration += 1) {
      assertFresh();
      const input: PluginNodeInvocationInput = {
        host: PLUGIN_HOST,
        projectId,
        locale: getLocale(),
        iteration,
        node: { id: nodeId, values: values ?? {} },
        inputs,
        models: pluginNode.permissions.includes('models.read') ? models : [],
        resources,
        effectResult,
      };
      const rawResult = await invokePluginTool({
        pluginId: pluginNode.pluginId,
        sourceDigest,
        revisionDigest,
        toolId: pluginNode.node.id,
        invocationId,
      }, input, execution.signal);
      assertFresh();
      const result = validatePluginNodeResult(rawResult, pluginNode, trustedMediaReferences);
      if (result.effect) {
        if (iteration === MAX_HOST_EFFECTS) throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
        reserveToolEffect(effectCounts, result.effect);
        effectResult = await executeHostEffect(
          {
            pluginId: pluginNode.pluginId,
            toolId: pluginNode.node.id,
            projectId,
            title: pluginNode.node.title,
            permissions: pluginNode.permissions,
            resources,
            resourceReadContext: resourceReadContext(),
            pluginNode,
            inputs,
            signal: execution.signal,
          },
          nodeId,
          result.effect,
          models,
        );
        assertFresh();
        if (trustedMediaReferences && result.effect.type === 'model.generate') {
          addTrustedModelEffectReference(result.effect, effectResult, models, trustedMediaReferences);
        }
        continue;
      }

      const current = assertFresh();
      const nextValues = { ...(values ?? {}), ...(result.data?.values ?? {}) };
      const nextOutputs = result.data?.outputs ?? {};
      current.updateNodeData(nodeId, {
        pluginValues: nextValues,
        status: 'success',
        ...outputPatch(pluginNode, nextOutputs),
      });
      current.showToast(result.message || `插件节点「${pluginNode.node.title}」执行完成`);
      return;
    }
  } finally {
    execution.dispose();
    clearPluginInvocationResources(invocationId);
    completeCanvasDerivation(guard);
  }
}

function dispatchPluginVideoBatch(identity: PluginInvocationIdentity, projectId: string,
  batch: { items: VideoPreflightItem[]; assertModelsFresh: () => void }, expectedContext?: Readonly<CanvasContext>): void {
  try {
    const assertFresh = () => {
      const state = requireCurrentPluginRevision(identity.pluginId, identity.sourceDigest, identity.revisionDigest);
      if (state.currentProjectId !== projectId) throw new Error('项目已切换');
      if (expectedContext && !isProjectExpectedContextCurrent(expectedContext, state, { checkCanvasRevision: false })) {
        throw new Error('视频批次目标上下文已变化');
      }
      batch.assertModelsFresh();
    };
    assertFresh();
    void useAppStore.getState().startVideoBatch(projectId, batch.items, { assertFresh }).catch(() => {
      useAppStore.getState().showToast('视频批次未完成，请检查已创建的视频节点；未自动重新提交');
    });
  } catch {
    useAppStore.getState().showToast('视频节点已创建，批次未启动；请检查项目、插件或模型配置');
  }
}

export async function executeNodePluginTool(
  pluginTool: AvailableNodePluginTool,
  nodeId: string,
  parameters: Record<string, PluginJsonValue> = {},
  executionLease?: {
    invocationId: string;
    guard: CanvasDerivationGuard;
    resources: PluginInvocationResources;
    trustedMediaReferences?: Set<string>;
    signal?: AbortSignal;
  },
  /** 仅宿主后台任务使用，不从插件 JSON、SDK 或 UI 请求反序列化。 */
  hostTask?: { materialsOnly: true; materialLayout?: PluginMaterialLayout },
): Promise<void | { nodes: Node<BaseNodeData>[]; edges: Edge[]; nodeIdsByKey: Record<string, string> }> {
  const before = useAppStore.getState();
  const projectId = before.currentProjectId;
  const sourceNode = before.nodes.find((node) => node.id === nodeId);
  if (!projectId || !sourceNode) throw new Error('目标节点或项目不存在');
  const sourceDigest = requirePluginSourceDigest(
    before.installedPlugins,
    pluginTool.pluginId,
    pluginTool.sourceDigest,
  );
  const revisionDigest = requirePluginRevisionDigest(
    before.installedPlugins,
    pluginTool.pluginId,
    pluginTool.revisionDigest,
  );
  const installedPlugin = before.installedPlugins.find((item) => item.id === pluginTool.pluginId);
  if (!installedPlugin) throw new Error('插件已被卸载');
  const ownsExecutionLease = !executionLease;
  const invocationId = executionLease?.invocationId ?? createPluginInvocationId();
  const cancellation = new AbortController();
  const guard = executionLease?.guard ?? registerCanvasDerivation(before, nodeId, { onCancel: () => cancellation.abort() });
  if (!guard) throw new Error('无法创建插件执行保护');
  if (
    guard.projectId !== projectId
    || guard.sourceNodeId !== nodeId
    || !isCanvasDerivationFresh(guard, before)
  ) {
    throw new Error('插件界面会话已失效');
  }
  const models = buildNodeToolModelCatalog(pluginTool);
  // JavaScript 沙箱没有任意网络能力，媒体引用只能来自本次输入与本轮宿主模型结果。
  // 该集合跨 effect 轮次累积，让后续轮次可以引用前面模型生成的媒体。
  const trustedMediaReferences = pluginTool.runtime === 'javascript'
    ? executionLease?.trustedMediaReferences ?? new Set<string>()
    : undefined;
  let effectResult: PluginNodeHostEffectResult | undefined;
  const effectCounts: Record<string, number> = {};
  const execution = watchPluginExecution(pluginTool.pluginId, sourceDigest, revisionDigest, guard, executionLease?.signal ?? cancellation.signal);
  const assertExecutionFresh = () => {
    const current = requireCurrentPluginRevision(pluginTool.pluginId, sourceDigest, revisionDigest);
    if (!isCanvasDerivationFresh(guard, current)) throw new Error('画布已变化，插件结果未写入');
    if (execution.signal.aborted) throw new Error('插件操作已取消');
    return current;
  };
  const identity: PluginInvocationIdentity = {
    pluginId: pluginTool.pluginId, sourceDigest, revisionDigest, toolId: pluginTool.tool.id, invocationId,
  };
  const usesNativeMedia = pluginTool.tool.pythonExecution?.mediaWorkspace === true;
  let mediaWorkspaceAttempted = false;
  let pendingVideoBatch: { items: VideoPreflightItem[]; assertModelsFresh: () => void } | undefined;

  try {
    assertExecutionFresh();
    if (pluginTool.tool.output.generateVideos && (installedPlugin.manifest.apiVersion !== 2
      || !installedPlugin.manifest.requiredCapabilities?.includes('video.nodeSetGeneration')
      || !installedPlugin.manifest.permissions.includes('models.read')
      || !installedPlugin.manifest.permissions.includes('models.invoke')
      || pluginTool.tool.output.mode !== 'create-node-set')) {
      throw new Error('插件未获准生成视频节点集');
    }
    const normalizedParameters = normalizePluginToolParameters(parameters);
    const resources = executionLease?.resources ?? await mintPluginInvocationResources({
      pluginId: pluginTool.pluginId,
      sourceDigest,
      revisionDigest,
      invocationId,
      projectId,
      nodeId,
      baseRevision: guard.baseRevision,
      expectedContext: guard.expectedContext,
      getState: useAppStore.getState,
      access: pluginTool.tool.resourceAccess,
      packageResources: installedPlugin.manifest.resources,
      state: before,
    });
    const resourceReadContext = (): PluginResourceReadContext => ({
      pluginId: pluginTool.pluginId,
      sourceDigest,
      revisionDigest,
      invocationId,
      projectId,
      nodeId,
      baseRevision: guard.baseRevision,
      expectedContext: guard.expectedContext,
      getState: useAppStore.getState,
      permissions: pluginTool.permissions,
      state: useAppStore.getState(),
    });
    if (usesNativeMedia) {
      if (pluginTool.runtime !== 'python' || installedPlugin.manifest.apiVersion !== 2
        || !installedPlugin.manifest.requiredCapabilities?.includes('python.mediaWorkspace')
        || pluginTool.tool.resourceAccess?.self !== true) throw new Error('Python 媒体工作区声明无效');
      const inputs = await resolvePluginMediaWorkspaceInputs(resourceReadContext(), resources);
      assertExecutionFresh();
      mediaWorkspaceAttempted = true;
      const cancelPrepare = () => {
        void invoke('cancel_node_plugin_tool', { pluginId: identity.pluginId, invocationId: identity.invocationId }).catch(() => undefined);
      };
      execution.signal.addEventListener('abort', cancelPrepare, { once: true });
      try {
        await invoke<void>('prepare_plugin_media_workspace', { identity, inputs });
        assertExecutionFresh();
      } finally {
        execution.signal.removeEventListener('abort', cancelPrepare);
      }
    }
    for (let iteration = 0; iteration <= MAX_HOST_EFFECTS; iteration += 1) {
      assertExecutionFresh();
      const input = buildInvocationInput(
        projectId,
        sourceNode,
        pluginTool.tool.inputFields,
        normalizedParameters,
        { iteration, models, resources, effectResult },
      );
      input.host = PLUGIN_HOST;
      if (trustedMediaReferences) {
        for (const reference of collectNodeToolMediaReferences(input)) {
          trustedMediaReferences.add(reference);
        }
      }
      const rawResult = await invokePluginTool({
        pluginId: pluginTool.pluginId,
        sourceDigest,
        revisionDigest,
        toolId: pluginTool.tool.id,
        invocationId,
      }, input, execution.signal);
      assertExecutionFresh();
      const outputNodeType = pluginTool.tool.output.mode === 'create-node'
        ? pluginTool.tool.output.nodeType ?? sourceNode.data.type
        : sourceNode.data.type;
      const result = validateResult(
        rawResult,
        pluginTool.tool.output,
        trustedMediaReferences,
        outputNodeType,
        usesNativeMedia,
        installedPlugin.manifest.apiVersion === 2
          && installedPlugin.manifest.requiredCapabilities?.includes('prompt.mentions') === true
          && pluginTool.permissions.includes('prompt.references.read'),
      );
      if (result.effect) {
        if (iteration === MAX_HOST_EFFECTS) throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
        reserveToolEffect(effectCounts, result.effect);
        effectResult = await executeHostEffect(
          {
            pluginId: pluginTool.pluginId,
            toolId: pluginTool.tool.id,
            projectId,
            title: pluginTool.tool.title,
            permissions: pluginTool.permissions,
            resources,
            resourceReadContext: resourceReadContext(),
            signal: execution.signal,
          },
          nodeId,
          result.effect,
          models,
        );
        assertExecutionFresh();
        if (trustedMediaReferences && result.effect.type === 'model.generate') {
          addTrustedModelEffectReference(result.effect, effectResult, models, trustedMediaReferences);
        }
        continue;
      }

      const current = assertExecutionFresh();
      const data = preserveHostShotVideos(result.data ?? {}, pluginTool.tool.output.mode === 'update-current'
        ? current.nodes.find((node) => node.id === nodeId)?.data.shotlistRows : undefined);

      if (pluginTool.tool.output.mode === 'update-current') {
        current.updateNodeData(nodeId, data as Partial<BaseNodeData>);
      } else if (pluginTool.tool.output.mode === 'create-node') {
        const nodeType = pluginTool.tool.output.nodeType ?? sourceNode.data.type;
        const placement = derivedNodePlacement(sourceNode);
        current.addNode({
          id: `node-${generateId()}`,
          type: nodeType,
          ...placement,
          data: {
            label: typeof data.label === 'string'
              ? data.label
              : `${sourceNode.data.label} · ${pluginTool.tool.title}`,
            type: nodeType,
            role: 'source',
            status: 'success',
            ...data,
          } as BaseNodeData,
        });
      } else {
        if (!result.nodeSet) throw new Error('插件没有返回有效节点集');
        const assertFresh = () => {
          assertExecutionFresh();
        };
        let nodeSet = result.nodeSet;
        if (hostTask) {
          if (nodeSet.nodes.some((item) => item.generation)
            || !installedPlugin.manifest.requiredCapabilities?.includes('video.replicaPipeline')) {
            throw new Error('后台素材调用不能提交生成，且必须声明全片任务能力');
          }
          // 已完整校验插件返回结构；丢弃显示节点前仍检查其资源租约，不将其图像另存到项目。
          for (const item of nodeSet.nodes) if (item.resourceId) {
            readPluginDerivedResourceForOutput(resourceReadContext(), item.resourceId, item.representation ?? 'original');
          }
          const nodes = nodeSet.nodes.filter((item) => item.nodeType === 'source-video' || item.nodeType === 'source-audio');
          const keys = new Set(nodes.map((item) => item.key));
          nodeSet = { nodes, edges: nodeSet.edges?.filter((edge) => keys.has(edge.sourceKey) && keys.has(edge.targetKey)) };
        }
        const prepared = await preparePluginNodeSet({
          nodeSet,
          sourceNode,
          projectId,
          resourceContext: resourceReadContext(),
          assertFresh,
          artifacts: result.artifacts,
          identity: usesNativeMedia ? identity : undefined,
          models,
          resources,
          ...(hostTask?.materialLayout ? { materialLayout: hostTask.materialLayout } : {}),
        });
        try {
          if (hostTask && (prepared.videoPreflight.length || !installedPlugin.manifest.requiredCapabilities?.includes('video.replicaPipeline'))) {
            throw new Error('后台素材调用不能提交生成，且必须声明全片任务能力');
          }
          await prepared.assertReferencesFresh();
          assertFresh();
          prepared.assertGenerationModelsFresh();
          if (prepared.videoPreflight.length && useAppStore.getState().videoBatchBusy) throw new Error('已有视频批次正在执行');
          requireCurrentPluginRevision(pluginTool.pluginId, sourceDigest, revisionDigest)
            .addNodesWithEdges(prepared.nodes, prepared.edges);
        } catch (error) {
          await prepared.rollback();
          throw error;
        }
        if (hostTask) return { nodes: prepared.nodes, edges: prepared.edges, nodeIdsByKey: prepared.nodeIdsByKey };
        if (prepared.videoPreflight.length) {
          // Store 会分配 displayId 并按设置补本批参考 @；以其最终节点生成提交指纹。
          const committed = useAppStore.getState();
          const items = prepared.videoPreflight.map((item) => {
            const node = committed.nodes.find((entry) => entry.id === item.nodeId);
            return node ? inspectVideoNode(node, committed) : { ...item, issues: ['生成节点未写入'] };
          });
          pendingVideoBatch = { items, assertModelsFresh: prepared.assertGenerationModelsFresh };
        }
      }
      current.showToast(result.message || `插件工具「${pluginTool.tool.title}」执行完成`);
      return;
    }
    throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
  } finally {
    if (mediaWorkspaceAttempted) {
      await invoke<void>('release_plugin_media_workspace', { identity }).catch(() => undefined);
    }
    execution.dispose();
    if (ownsExecutionLease) {
      clearPluginInvocationResources(invocationId);
      completeCanvasDerivation(guard);
    }
    if (pendingVideoBatch) {
      // 画布已提交；新视频归宿主批次管理，不能再用提交前的 revision/界面取消信号守卫。
      dispatchPluginVideoBatch(identity, projectId, pendingVideoBatch, guard.expectedContext);
    }
  }
}

export async function getPythonPluginRuntimeStatus(): Promise<PythonPluginRuntimeStatus> {
  return invoke<PythonPluginRuntimeStatus>('get_python_plugin_runtime_status');
}

/**
 * 供插件自定义界面使用：先按宿主规则校验 effect，再执行。
 *
 * 界面组件跑在主窗口内的 sandboxed iframe 中，传来的 effect 是未经信任的 JSON，所以必须走与
 * 插件返回值完全相同的 parseHostEffect 校验；权限检查留在 executeHostEffect 内部。
 * JavaScript 没有任意网络能力，媒体来源校验对它生效；可信 Python 本身就能联网，
 * 不在此约束范围内——这与直接执行入口的处理保持一致。
 */
export async function executePluginUiHostEffect(options: {
  pluginId: string;
  toolId?: string;
  projectId: string;
  title: string;
  permissions: PluginPermission[];
  nodeId: string;
  effect: unknown;
  models: PluginModelSummary[];
  trustedMediaReferences: Set<string>;
  resources?: PluginInvocationResources;
  resourceReadContext?: PluginResourceReadContext;
  signal?: AbortSignal;
}): Promise<PluginNodeHostEffectResult> {
  const parsed = parseHostEffect(options.effect, options.trustedMediaReferences);
  const result = await executeHostEffect(
    {
      pluginId: options.pluginId,
      toolId: options.toolId,
      projectId: options.projectId,
      title: options.title,
      permissions: options.permissions,
      resources: options.resources,
      resourceReadContext: options.resourceReadContext,
      signal: options.signal,
    },
    options.nodeId,
    parsed,
    options.models,
  );
  if (parsed.type === 'model.generate') {
    addTrustedModelEffectReference(
      parsed,
      result,
      options.models,
      options.trustedMediaReferences,
    );
  }
  return result;
}
