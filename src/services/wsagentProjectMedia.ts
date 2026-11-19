import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import {
  isWsagentSharedImagesNode, WSAGENT_PLUGIN_ID,
  WSAGENT_MEDIA_CAPABILITY,
  type WsagentProjectMediaFilter, type WsagentProjectMediaItem, type WsagentProjectMediaPage, type WsagentProjectMediaTarget,
} from '../types/wsagentShared';
import { activateWsagentOwnerForCommand, assertWsagentOwner } from './wsagentSharedImages';
import { getRelativeAssetPath } from './fs/assetIndex';
import { ensureProjectDataDir, getAssetUrlFromPath, notifyProjectDiskChanged } from './fs/core';

export async function openWsagentDesktop(ownerId: string): Promise<void> {
  await activateWsagentOwnerForCommand(ownerId);
  return invoke<void>('wsagent_shared_open', { ownerId });
}

/** 同作品里多个互联节点共享正在查询的请求。结果不保留到下一个项目会话。 */
const activeLists = new Map<string, Promise<WsagentProjectMediaPage>>();

export async function readWsagentProjectMedia(ownerId: string, kind: WsagentProjectMediaFilter, offset: number) {
  await activateWsagentOwnerForCommand(ownerId);
  const key = JSON.stringify([ownerId, kind, offset]);
  const existing = activeLists.get(key);
  if (existing) return existing;
  const pending = invoke<WsagentProjectMediaPage>('wsagent_shared_media_list', { ownerId, kind, offset }).then((page) => {
    assertWsagentOwner(ownerId);
    return page;
  }).finally(() => { activeLists.delete(key); });
  activeLists.set(key, pending);
  return pending;
}

export async function previewWsagentProjectMedia(ownerId: string, assetId: string): Promise<string> {
  await activateWsagentOwnerForCommand(ownerId);
  const data = await invoke<string>('wsagent_shared_media_preview', { ownerId, assetId });
  assertWsagentOwner(ownerId);
  return data;
}

interface WsagentImportedFile {
  filePath: string;
  fileName: string;
  mime: string;
  bytes: number;
}

/** 插件只提供已选素材身份。桌面宿主下载原件，再用标准媒体节点建立连线。 */
export async function insertWsagentProjectMedia(
  ownerId: string,
  media: Pick<WsagentProjectMediaItem, 'id' | 'kind'> & { name?: string },
  sourceNodeId: string,
  signal: AbortSignal,
  target?: WsagentProjectMediaTarget,
  position?: { x: number; y: number },
) {
  assertWsagentOwner(ownerId);
  const initial = useAppStore.getState();
  const projectId = initial.currentProjectId;
  const revision = initial.getCurrentRevision();
  const source = initial.installedPlugins.find((plugin) => plugin.id === WSAGENT_PLUGIN_ID && plugin.enabled);
  if (!projectId || !source?.manifest.requiredCapabilities?.includes(WSAGENT_MEDIA_CAPABILITY)
    || !/^[a-f0-9]{64}$/.test(source.sourceDigest ?? '') || !/^[a-f0-9]{64}$/.test(source.revisionDigest ?? '')) {
    throw new Error('当前项目的 WSAGENT 互联节点不可用，请重新加载插件');
  }
  const check = (activeSignal: AbortSignal) => {
    assertWsagentOwner(ownerId);
    const state = useAppStore.getState();
    if (activeSignal.aborted || state.currentProjectId !== projectId || state.getCurrentRevision() !== revision
      || !isWsagentSharedImagesNode(state.nodes.find((node) => node.id === sourceNodeId)?.data)
      || !state.installedPlugins.some((plugin) => plugin.id === source.id && plugin.enabled
        && plugin.sourceDigest === source.sourceDigest && plugin.revisionDigest === source.revisionDigest)) {
      throw new Error('当前画布或插件已切换，请重新选择素材');
    }
  };
  check(signal);
  const { importWsagentProjectMedia } = await import('./canvasResourceImportService');
  const outcome = await importWsagentProjectMedia({ projectId, signal, baseRevision: revision }, async (activeSignal) => {
    const projectDirectory = await ensureProjectDataDir(projectId, { throwOnError: true });
    if (!projectDirectory) throw new Error('未找到当前项目素材目录');
    await activateWsagentOwnerForCommand(ownerId);
    check(activeSignal);
    const result = await invoke<WsagentImportedFile>('wsagent_shared_media_import', {
      ownerId, assetId: media.id, projectDirectory, name: media.name,
    });
    check(activeSignal);
    const relativePath = getRelativeAssetPath(result.filePath, projectDirectory);
    if (!relativePath || !result.mime.startsWith(`${media.kind}/`) || result.bytes < 1) throw new Error('WSAGENT 返回的素材身份无效');
    const assetUrl = await getAssetUrlFromPath(result.filePath);
    check(activeSignal);
    return { filePath: result.filePath, fileName: result.fileName, assetUrl, relativePath, label: media.name || result.fileName };
  }, sourceNodeId, media.kind, target, () => check(signal), position);
  notifyProjectDiskChanged();
  return outcome;
}
