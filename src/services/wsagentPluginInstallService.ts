import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../store/useAppStore';
import { WSAGENT_NODE_ID, WSAGENT_PLUGIN_ID, isWsagentSharedImagesNode } from '../types/wsagentShared';
import { getCanvasViewportController } from './canvasViewportService';
import { activeWsagentOwner, getWsagentSharedStatus } from './wsagentSharedImages';

interface WsagentPluginInstallRequest {
  requestId: string;
  manifestText: string;
  source: string;
  uiSource: string;
  projectId: string | null;
}

type InstallStatus = 'added' | 'installed' | 'unchanged' | 'failed';

const INSTALL_EVENT = 'wsagent-plugin-install-requested';

async function applyInstallRequest(request: WsagentPluginInstallRequest): Promise<InstallStatus> {
  const initial = useAppStore.getState();
  const ownerId = activeWsagentOwner(initial);
  const { changed, revisionDigest } = await initial.installBundledWsagentPlugin(
    request.manifestText, request.source, request.uiSource,
  );
  const readyStatus = changed ? 'installed' : 'unchanged';
  if (!request.projectId || !ownerId) return readyStatus;

  const isInitialCanvas = (state: typeof initial) => state.currentProjectId === initial.currentProjectId
    && state.projectExecutionContext?.runtimeEpoch === initial.projectExecutionContext?.runtimeEpoch
    && activeWsagentOwner(state) === ownerId;
  if (!isInitialCanvas(useAppStore.getState())) return readyStatus;

  const { createPluginNode, getAvailablePluginNodes } = await import('./plugins/pluginRuntime');
  if (!isInitialCanvas(useAppStore.getState())) return readyStatus;

  // 状态读取可能因切换作品而失效。插件已安装，节点留给用户从菜单添加。
  const binding = await getWsagentSharedStatus(ownerId).catch(() => null);
  if (!binding?.enabled || binding.peerProjectId !== request.projectId) return readyStatus;

  const current = useAppStore.getState();
  if (!isInitialCanvas(current)) return readyStatus;

  const pluginNode = getAvailablePluginNodes(current.installedPlugins).find((item) => (
    item.pluginId === WSAGENT_PLUGIN_ID && item.node.id === WSAGENT_NODE_ID
    && item.revisionDigest === revisionDigest
  ));
  if (!pluginNode) return readyStatus;
  if (current.nodes.some((node) => isWsagentSharedImagesNode(node.data))) return 'added';

  const bounds = getCanvasViewportController()?.getSnapshot().visibleBounds;
  const position = bounds ? {
    x: bounds.x + Math.max(0, bounds.width - 320) / 2,
    y: bounds.y + Math.max(0, bounds.height - 180) / 2,
  } : { x: 80, y: 80 };
  current.addNode(createPluginNode(pluginNode, position));
  return 'added';
}

export function observeWsagentPluginInstall(): () => void {
  const mainWindow = getCurrentWindow();
  if (mainWindow.label !== 'main') return () => undefined;

  let stopped = false;
  let unlisten: (() => void) | undefined;
  let queue = Promise.resolve();

  const drain = () => {
    queue = queue.then(async () => {
      while (!stopped) {
        const request = await invoke<WsagentPluginInstallRequest | null>('wsagent_plugin_install_take');
        if (!request) break;
        let status: InstallStatus = 'failed';
        try {
          status = await applyInstallRequest(request);
        } catch {
          useAppStore.getState().showToast(
            'WSAGENT 互联安装未完成，请在「设置 → 插件」检查现有版本后重试。', 'error',
          );
        }
        await invoke('wsagent_plugin_install_finish', { requestId: request.requestId, status });
      }
    }).catch(() => {
      if (!stopped) useAppStore.getState().showToast('WSAGENT 插件注入通信中断，请重试。', 'error');
    });
  };

  void mainWindow.listen(INSTALL_EVENT, drain).then((dispose) => {
    if (stopped) {
      dispose();
      return;
    }
    unlisten = dispose;
    drain();
  }).catch(() => undefined);

  return () => {
    stopped = true;
    unlisten?.();
  };
}
