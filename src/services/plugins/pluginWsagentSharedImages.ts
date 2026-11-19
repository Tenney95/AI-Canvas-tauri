import type { BaseNodeData } from '../../types';
import type { InstalledPlugin, PluginInvocationResources, WsagentPluginEffect } from '../../types/plugin';
import {
  WSAGENT_IMAGE_EXTENSIONS, WSAGENT_IMAGE_PORT, WSAGENT_MAX_IMAGE_BYTES, WSAGENT_NODE_ID, WSAGENT_PLUGIN_ID,
  WSAGENT_SHARED_CAPABILITY, WSAGENT_SHARED_PERMISSION,
} from '../../types/wsagentShared';
import { useAppStore } from '../../store/useAppStore';
import { readConnectedPluginResourceForHost, type PluginResourceReadContext } from './pluginResourceService';

export function isWsagentPluginTool(pluginId: string, toolId: string): boolean {
  return pluginId === WSAGENT_PLUGIN_ID && toolId === WSAGENT_NODE_ID;
}

export function getWsagentPluginNode(plugin: InstalledPlugin, toolId: string, data: BaseNodeData) {
  if (!isWsagentPluginTool(plugin.id, toolId) || plugin.manifest.apiVersion !== 2
    || data.type !== 'plugin-node' || data.pluginId !== plugin.id || data.pluginNodeId !== WSAGENT_NODE_ID
    || !plugin.manifest.permissions.includes(WSAGENT_SHARED_PERMISSION)
    || !plugin.manifest.requiredCapabilities?.includes(WSAGENT_SHARED_CAPABILITY)) return undefined;
  return plugin.manifest.contributes.nodes?.find((node) => node.id === WSAGENT_NODE_ID);
}

const EFFECTS = ['wsagent.sharedImages.list', 'wsagent.sharedImages.preview',
  'wsagent.sharedImages.insert', 'wsagent.sharedImages.publish'] as const;

export function isWsagentPluginEffect(type: unknown): type is WsagentPluginEffect['type'] {
  return EFFECTS.some((item) => item === type);
}

function parseEffect(type: WsagentPluginEffect['type'], payload: unknown): WsagentPluginEffect {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('共享素材请求无效');
  const raw = payload as Record<string, unknown>;
  const hasOtherKeys = (...allowed: string[]) => Object.keys(raw).some((key) => key !== 'type' && !allowed.includes(key));
  if (type === 'wsagent.sharedImages.list') {
    const offset = raw.offset ?? 0;
    if (hasOtherKeys('offset') || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      throw new Error('共享素材分页无效');
    }
    return { type, offset };
  }
  if (type === 'wsagent.sharedImages.publish') {
    if (hasOtherKeys('resourceId', 'name') || typeof raw.resourceId !== 'string' || !raw.resourceId || raw.resourceId.length > 160
      || (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 120))) throw new Error('待发布的图片参数无效');
    return { type, resourceId: raw.resourceId, name: raw.name as string | undefined };
  }
  if (hasOtherKeys('assetId') || typeof raw.assetId !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.assetId)) throw new Error('共享素材标识无效');
  return { type, assetId: raw.assetId };
}

export async function executeWsagentPluginEffect(input: {
  type: WsagentPluginEffect['type'];
  payload: unknown;
  resources: PluginInvocationResources;
  context: PluginResourceReadContext;
  signal: AbortSignal;
  assertFresh: () => void;
}) {
  const effect = parseEffect(input.type, input.payload);
  const service = await import('../wsagentSharedImages');
  const check = () => {
    if (input.signal.aborted) throw new Error('共享素材操作已取消');
    input.assertFresh();
  };
  check();
  const ownerId = service.activeWsagentOwner(useAppStore.getState());
  if (!ownerId) throw new Error('当前作品尚未加载');
  if (effect.type === 'wsagent.sharedImages.insert') {
    return service.insertWsagentImage(ownerId, effect.assetId, input.signal, input.context.baseRevision);
  }
  if (effect.type === 'wsagent.sharedImages.preview') return service.previewWsagentImage(ownerId, effect.assetId);
  if (effect.type === 'wsagent.sharedImages.list') {
    const [status, page] = await Promise.all([
      service.getWsagentSharedStatus(ownerId), service.listWsagentSharedImages(ownerId, effect.offset),
    ]);
    return { ownerId: status.ownerId, peerProjectId: status.peerProjectId, enabled: status.enabled, ...page };
  }
  const resource = input.resources.inputs[WSAGENT_IMAGE_PORT]?.find((item) => item.resourceId === effect.resourceId);
  if (!resource || !Object.hasOwn(WSAGENT_IMAGE_EXTENSIONS, resource.mediaType)) throw new Error('只能发布图像端口已授权的项目图片');
  const bytes = await readConnectedPluginResourceForHost(input.context, resource.resourceId, WSAGENT_MAX_IMAGE_BYTES);
  return service.publishWsagentImage(ownerId,
    { name: effect.name?.trim() || resource.displayName, mime: resource.mediaType, bytes }, check, input.signal);
}
