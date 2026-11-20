import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import { WSAGENT_NODE_ID, WSAGENT_PLUGIN_ID, isWsagentSharedImagesNode } from '../types/wsagentShared';
import { getCanvasViewportController } from './canvasViewportService';
import type { PluginDeliveryPlacement } from './plugins/pluginDeliveryService';
import { activeWsagentOwner, getWsagentSharedStatus } from './wsagentSharedImages';

/** Project placement is authorized by the existing WSAGENT pairing after installation. */
export const wsagentPluginPlacement: PluginDeliveryPlacement = {
  pluginId: WSAGENT_PLUGIN_ID,
  async placeNode({ requestId, initial, revisionDigest }) {
    const ownerId = activeWsagentOwner(initial);
    if (!ownerId) return false;
    const isInitialCanvas = (state: typeof initial) => state.currentProjectId === initial.currentProjectId
      && state.projectExecutionContext?.runtimeEpoch === initial.projectExecutionContext?.runtimeEpoch
      && activeWsagentOwner(state) === ownerId;
    if (!isInitialCanvas(useAppStore.getState())) return false;

    const [projectId, { createPluginNode, getAvailablePluginNodes }] = await Promise.all([
      invoke<string | null>('wsagent_plugin_install_project', { requestId }),
      import('./plugins/pluginRuntime'),
    ]);
    if (!projectId || !isInitialCanvas(useAppStore.getState())) return false;
    const binding = await getWsagentSharedStatus(ownerId).catch(() => null);
    if (!binding?.enabled || binding.peerProjectId !== projectId) return false;

    const current = useAppStore.getState();
    if (!isInitialCanvas(current)) return false;
    const pluginNode = getAvailablePluginNodes(current.installedPlugins).find((item) => (
      item.pluginId === WSAGENT_PLUGIN_ID && item.node.id === WSAGENT_NODE_ID
      && item.revisionDigest === revisionDigest
    ));
    if (!pluginNode) return false;
    if (current.nodes.some((node) => isWsagentSharedImagesNode(node.data))) return true;

    const bounds = getCanvasViewportController()?.getSnapshot().visibleBounds;
    const position = bounds ? {
      x: bounds.x + Math.max(0, bounds.width - 320) / 2,
      y: bounds.y + Math.max(0, bounds.height - 180) / 2,
    } : { x: 80, y: 80 };
    current.addNode(createPluginNode(pluginNode, position));
    return true;
  },
};
