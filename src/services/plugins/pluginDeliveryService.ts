import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore, type AppState } from '../../store/useAppStore';
import type { PluginPackageResourcePayload } from '../../types/plugin';
import { t } from '../../i18n';
import { sha256Hex } from '../fs/projectFiles';
import { parsePluginBundle } from './pluginManifest';

interface PluginDelivery {
  requestId: string;
  manifestText: string;
  source: string;
  uiSource?: string;
  resourcePayloads?: PluginPackageResourcePayload[];
  trustedPublisher?: string | null;
}

type DeliveryStatus = 'added' | 'installed' | 'unchanged' | 'cancelled' | 'failed';

export interface PluginDeliveryPlacement {
  pluginId: string;
  placeNode: (request: { requestId: string; initial: AppState; revisionDigest: string }) => Promise<boolean>;
}

class DeliveryWithdrawn extends Error {}

let documentSessionId: string | undefined;

async function applyDelivery(
  request: PluginDelivery,
  sessionId: string,
  placements: readonly PluginDeliveryPlacement[],
): Promise<DeliveryStatus> {
  const initial = useAppStore.getState();
  const manifest = parsePluginBundle(request.manifestText, request.source);
  const previous = initial.installedPlugins.find((plugin) => plugin.id === manifest.id);
  const expectedSourceDigest = await sha256Hex(new TextEncoder().encode(request.source));
  const isDeliveryCurrent = () => invoke<boolean>('plugin_delivery_check', { requestId: request.requestId, sessionId });
  if (!(await isDeliveryCurrent())) return 'cancelled';
  const automatic = Boolean(request.trustedPublisher) && manifest.runtime === 'javascript'
    && (!previous || previous.manifest.version === manifest.version);
  let reviewedRevision: string | null | undefined;
  if (!automatic) {
    const { confirmAction } = await import('../confirmDialog');
    const plainName = manifest.name.replace(/[\p{C}\s]+/gu, ' ').trim();
    const plainVersion = manifest.version.replace(/[\p{C}\s]+/gu, ' ').trim();
    const declaredPermissions = manifest.permissions.join('、') || t('无');
    const capabilitySummary = manifest.network?.allowedOrigins.length
      ? `\n${t('允许访问的来源')}: ${manifest.network.allowedOrigins.join('、')}`
      : '';
    const pythonWarning = manifest.runtime === 'python'
      ? `\n\n${t('Python 插件会以你的当前系统权限运行，可以读取或修改本机文件、访问网络和环境变量，也可以启动其他程序。')}`
      : '';
    if (!(await confirmAction(
      t('来自外部软件的插件「{name}」版本 {version}。', { name: plainName, version: plainVersion })
        + `\n${t('声明权限')}: ${declaredPermissions}${capabilitySummary}\nSHA-256: ${expectedSourceDigest}${pythonWarning}`,
      {
        title: t(previous ? '更新外部插件？' : '安装外部插件？'),
        okLabel: t(previous ? '更新' : '安装'),
      },
    ))) return 'cancelled';
    reviewedRevision = previous ? previous.revisionDigest ?? '' : null;
  }
  const { changed, revisionDigest } = await initial.installDeliveredPluginBundle(request.manifestText, request.source, {
    expectedSourceDigest,
    reviewedRevision,
    trustedPythonConfirmed: manifest.runtime === 'python' && reviewedRevision !== undefined,
    async assertDeliveryCurrent() {
      if (!(await isDeliveryCurrent())) throw new DeliveryWithdrawn();
    },
    uiSource: request.uiSource,
    resourcePayloads: request.resourcePayloads,
  });

  if (automatic) {
    const handler = placements.find((placement) => placement.pluginId === manifest.id);
    if (handler && await isDeliveryCurrent().catch(() => false)
      && await handler.placeNode({ requestId: request.requestId, initial, revisionDigest }).catch(() => false)) {
      return 'added';
    }
  }
  return changed ? 'installed' : 'unchanged';
}

export function observePluginDelivery(placements: readonly PluginDeliveryPlacement[] = []): () => void {
  const mainWindow = getCurrentWindow();
  if (mainWindow.label !== 'main') return () => undefined;
  const sessionId = documentSessionId ??= crypto.randomUUID();

  let stopped = false;
  let unlisten: (() => void) | undefined;
  let queue = Promise.resolve();
  const drain = () => {
    queue = queue.then(async () => {
      while (!stopped) {
        const request = await invoke<PluginDelivery | null>('plugin_delivery_take', { sessionId });
        if (!request) break;
        let status: DeliveryStatus = 'failed';
        try {
          status = await applyDelivery(request, sessionId, placements);
        } catch (error) {
          if (error instanceof DeliveryWithdrawn) status = 'cancelled';
          else useAppStore.getState().showToast(t('插件安装未完成，请在「设置 → 插件」检查当前版本和插件包。'), 'error');
        }
        await invoke('plugin_delivery_finish', { requestId: request.requestId, sessionId, status });
      }
    }).catch(() => {
      if (!stopped) useAppStore.getState().showToast(t('插件包接收中断，请重试。'), 'error');
    });
  };
  void mainWindow.listen('plugin-delivery-requested', drain).then((dispose) => {
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
