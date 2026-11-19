import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type AppState } from '../store/useAppStore';
import { projectMemoryOwnerId, seriesOwnerId } from '../store/store.utils';
import {
  WSAGENT_IMAGE_EXTENSIONS, WSAGENT_MAX_IMAGE_BYTES,
  type WsagentSharedImage, type WsagentSharedPage, type WsagentSharedStatus,
} from '../types/wsagentShared';
import { getRelativeAssetPath } from './fs/assetIndex';
import { bytePartsToBase64Async, getMimeType, getProjectDataDir, isTauriEnv } from './fs/core';
import { readBoundedProjectFile } from './fs/projectFiles';

export function activeWsagentOwner(state: AppState): string | null {
  const { currentProjectId, projectInitialized, projectLoadStatus, projects } = state;
  return currentProjectId && projectInitialized && projectLoadStatus === 'ready'
    && !state.isReturningToStartPage && !state.switchingProjectName && projects.some((item) => item.id === currentProjectId)
    ? projectMemoryOwnerId(projects, currentProjectId) : null;
}

export function assertWsagentOwner(ownerId: string): void {
  if (!isTauriEnv()) throw new Error('WSAGENT 互联需要桌面端');
  if (activeWsagentOwner(useAppStore.getState()) !== ownerId) throw new Error('当前项目已切换');
}

let announcedOwner: string | null | undefined;
let announcing: Promise<void> = Promise.resolve();
const bindingEvents = new EventTarget();

export function observeWsagentBinding(ownerId: string, listener: (status: WsagentSharedStatus) => void) {
  const onChange = (event: Event) => {
    const status = (event as CustomEvent<WsagentSharedStatus>).detail;
    if (status.ownerId === ownerId) listener(status);
  };
  bindingEvents.addEventListener('change', onChange);
  return () => bindingEvents.removeEventListener('change', onChange);
}

function reportBinding(status: WsagentSharedStatus) {
  bindingEvents.dispatchEvent(new CustomEvent('change', { detail: status }));
  return status;
}

/** 串行更新原生服务的活动作品，避免切换过程中旧 IPC 迟到覆盖新作品。 */
function announceActiveOwner(): Promise<void> {
  const ownerId = activeWsagentOwner(useAppStore.getState());
  if (announcedOwner === ownerId) return announcing;
  announcedOwner = ownerId;
  const request = announcing.then(() => invoke<void>('wsagent_shared_activate', { ownerId }));
  announcing = request.catch(() => { if (announcedOwner === ownerId) announcedOwner = undefined; });
  return request;
}

export function observeWsagentOwner(): () => void {
  if (!isTauriEnv()) return () => undefined;
  let observedOwner = activeWsagentOwner(useAppStore.getState());
  void announceActiveOwner().catch(() => undefined);
  return useAppStore.subscribe((state) => {
    const ownerId = activeWsagentOwner(state);
    if (ownerId === observedOwner) return;
    observedOwner = ownerId;
    void announceActiveOwner().catch(() => undefined);
  });
}

/** 原生项目互联命令统一等待活动作品登记完成。 */
export async function activateWsagentOwnerForCommand(ownerId: string): Promise<void> {
  assertWsagentOwner(ownerId);
  await announceActiveOwner();
  assertWsagentOwner(ownerId);
}

export async function getWsagentSharedStatus(ownerId: string) {
  await activateWsagentOwnerForCommand(ownerId);
  return invoke<WsagentSharedStatus>('wsagent_shared_status', { ownerId });
}

export async function connectWsagentProject(ownerId: string) {
  await activateWsagentOwnerForCommand(ownerId);
  const { currentProjectId, projects } = useAppStore.getState();
  const localOwner = currentProjectId ? seriesOwnerId(projects, currentProjectId) : null;
  const name = projects.find((project) => project.id === localOwner)?.name;
  if (!name?.trim()) throw new Error('当前作品名称不可用');
  const status = await invoke<WsagentSharedStatus>('wsagent_shared_connect', { ownerId, name });
  assertWsagentOwner(ownerId);
  return reportBinding(status);
}

export async function revokeWsagentPairing(ownerId: string) {
  await activateWsagentOwnerForCommand(ownerId);
  const status = await invoke<WsagentSharedStatus>('wsagent_shared_revoke', { ownerId });
  assertWsagentOwner(ownerId);
  return reportBinding(status);
}

export async function listWsagentSharedImages(ownerId: string, offset = 0) {
  assertWsagentOwner(ownerId);
  return invoke<WsagentSharedPage>('wsagent_shared_list', { ownerId, offset });
}

export async function previewWsagentImage(ownerId: string, assetId: string) {
  assertWsagentOwner(ownerId);
  return invoke<{ dataUrl: string }>('wsagent_shared_preview', { ownerId, assetId });
}

export async function insertWsagentImage(ownerId: string, assetId: string, signal: AbortSignal, baseRevision: number) {
  assertWsagentOwner(ownerId);
  const projectId = useAppStore.getState().currentProjectId!;
  const { importSharedProjectImage } = await import('./canvasResourceImportService');
  const result = await importSharedProjectImage({ projectId, signal, baseRevision }, async () => {
    assertWsagentOwner(ownerId);
    return invoke<{ asset: WsagentSharedImage; base64: string }>('wsagent_shared_read', { ownerId, assetId });
  });
  return { nodeId: result.nodes[0].nodeId };
}

/** bytes 来自当前项目文件入口，或经连接租约验证的节点资源。 */
export async function publishWsagentImage(ownerId: string, input: { name: string; mime: string; bytes: Uint8Array },
  assertCurrent: () => void, signal?: AbortSignal) {
  assertWsagentOwner(ownerId);
  if (!Object.hasOwn(WSAGENT_IMAGE_EXTENSIONS, input.mime) || input.bytes.byteLength < 1
    || input.bytes.byteLength > WSAGENT_MAX_IMAGE_BYTES) throw new Error('请选择不超过 20 MiB 的 PNG、JPEG 或 WebP 图片');
  const base64 = await bytePartsToBase64Async([input.bytes], signal);
  await announceActiveOwner();
  assertCurrent();
  assertWsagentOwner(ownerId);
  return invoke<{ asset: WsagentSharedImage }>('wsagent_shared_publish', {
    ownerId, name: input.name, mime: input.mime, base64,
  });
}

export async function publishWsagentProjectFile(ownerId: string, fileProjectId: string, path: string, name: string) {
  const canvasId = useAppStore.getState().currentProjectId;
  const check = () => {
    assertWsagentOwner(ownerId);
    const state = useAppStore.getState();
    if (state.currentProjectId !== canvasId || !state.projects.some((item) => item.id === fileProjectId)
      || projectMemoryOwnerId(state.projects, fileProjectId) !== ownerId) throw new Error('项目文件范围已切换');
  };
  check();
  const root = await getProjectDataDir(fileProjectId);
  const relativePath = root && getRelativeAssetPath(path, root);
  if (!relativePath) throw new Error('请选择当前项目的图片文件');
  const mime = getMimeType(relativePath.split('.').pop()?.toLowerCase() ?? '');
  if (!Object.hasOwn(WSAGENT_IMAGE_EXTENSIONS, mime)) throw new Error('仅支持 PNG、JPEG 和 WebP 图片');
  const bytes = await readBoundedProjectFile({ projectId: fileProjectId, relativePath, maxBytes: WSAGENT_MAX_IMAGE_BYTES });
  return publishWsagentImage(ownerId, { name, mime, bytes }, check);
}
