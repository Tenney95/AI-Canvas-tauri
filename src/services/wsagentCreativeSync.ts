import { invoke } from '@tauri-apps/api/core';
import { readWsagentCreativeAsset } from '../store/store.dramaAssets';
import { useAppStore, type AppState } from '../store/useAppStore';
import type { DramaAsset } from '../types/dramaAssets';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import {
  WSAGENT_IMAGE_EXTENSIONS, WSAGENT_MAX_IMAGE_BYTES,
  type WsagentCreativeEdit, type WsagentCreativeEntity, type WsagentCreativeSyncState, type WsagentSharedStatus,
} from '../types/wsagentShared';
import { getRelativeAssetPath, resolveIndexedAssetPath } from './fs/assetIndex';
import { ensureProjectDataDir, getAssetUrlFromPath, getMimeType, getProjectDataDir, notifyProjectDiskChanged } from './fs/core';
import { readBoundedProjectFile } from './fs/projectFiles';
import { sha256BytesHex } from './mediaDataUrl';
import {
  canvasSectionId, creativeSnapshot, mergeCreativeAsset, wsagentAssetId,
  type CreativeLink, type CreativeSnapshot, type CreativeText,
} from './wsagentCreativeMerge';
import { activeWsagentOwner, activateWsagentOwnerForCommand, getWsagentSharedStatus, observeWsagentBinding, publishWsagentImage } from './wsagentSharedImages';
import {
  getWsagentCreativeSyncState, getWsagentScriptSyncState,
  reportWsagentCreativeSync as report, reportWsagentScriptSync,
} from './wsagentCreativeStatus';
import { syncWsagentScripts } from './wsagentScriptSync';

const INTERVAL = 3000;
const DEBOUNCE = 350;
const encoder = new TextEncoder();

function cards(state: AppState): DramaAsset[] {
  const { characters, scenes, props } = state.dramaAssets;
  return [...characters, ...scenes, ...props];
}

type LocalAsset = ReturnType<typeof readWsagentCreativeAsset>;
type ApplyInput = Parameters<AppState['applyWsagentCreativeAsset']>[4];

interface Scope {
  owner: string;
  project: string;
  peer: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}

function linkStorage(scope: Scope) {
  const key = `wsagent-creative-links-v1:${JSON.stringify([scope.owner, scope.peer])}`;
  const raw = localStorage.getItem(key);
  const links = new Map<string, CreativeLink>(raw ? JSON.parse(raw) as Array<[string, CreativeLink]> : []);
  return {
    links,
    accept(id: string, link: CreativeLink) {
      if (JSON.stringify(links.get(id)) === JSON.stringify(link)) return;
      links.set(id, link);
      localStorage.setItem(key, JSON.stringify([...links]));
    },
  };
}

async function snapshotLocal(asset: LocalAsset): Promise<CreativeSnapshot> {
  const image = asset.image;
  const identity = image ? await sha256BytesHex(encoder.encode(JSON.stringify([
    image.referenceId, image.relativePath ?? image.assetId ?? image.filePath ?? localMediaUrlToPath(image.imageUrl) ?? image.imageUrl,
  ]))) : null;
  return creativeSnapshot(asset, identity);
}

async function receiveImage(scope: Scope, remote: WsagentCreativeEntity): Promise<Exclude<ApplyInput['image'], undefined>> {
  if (!remote.imageId) return null;
  const directory = await ensureProjectDataDir(scope.project, { throwOnError: true });
  scope.assertCurrent();
  if (!directory) throw new Error('项目素材目录不可用');
  const result = await invoke<{ filePath: string; fileName: string; mime: string }>('wsagent_shared_media_import', {
    ownerId: scope.owner, assetId: remote.imageId, projectDirectory: directory, name: remote.name,
  });
  scope.assertCurrent();
  const relativePath = getRelativeAssetPath(result.filePath, directory);
  if (!relativePath || !result.mime.startsWith('image/')) throw new Error('参考图片不可用');
  notifyProjectDiskChanged();
  const imageUrl = await getAssetUrlFromPath(result.filePath);
  scope.assertCurrent();
  return { ...result, sourceId: remote.imageId, relativePath, imageUrl };
}

async function readImageFile(scope: Scope, image: NonNullable<LocalAsset['image']>) {
  if (image.assetSource === 'global') throw new Error('请先将参考图复制到当前项目');
  const root = await getProjectDataDir(scope.project);
  const filePath = image.filePath ?? (image.assetId ? await resolveIndexedAssetPath(image.assetId) : undefined)
    ?? localMediaUrlToPath(image.imageUrl);
  const relativePath = image.relativePath ?? (root && filePath ? getRelativeAssetPath(filePath, root) : undefined);
  const mime = getMimeType(relativePath?.split('.').at(-1)?.toLowerCase() ?? '');
  if (!relativePath || !Object.hasOwn(WSAGENT_IMAGE_EXTENSIONS, mime)) throw new Error('请将主参考图保存为项目内的 PNG、JPEG 或 WebP');
  const bytes = await readBoundedProjectFile({ projectId: scope.project, relativePath, maxBytes: WSAGENT_MAX_IMAGE_BYTES });
  scope.assertCurrent();
  return { mime, bytes };
}

async function sendImage(scope: Scope, image: LocalAsset['image'], name: string): Promise<NonNullable<WsagentCreativeEdit['image']>> {
  if (!image) return { type: 'clear' };
  const { mime, bytes } = await readImageFile(scope, image);
  const result = await publishWsagentImage(scope.owner, { name, mime, bytes }, scope.assertCurrent, scope.signal);
  return { type: 'shared', id: result.asset.id };
}

async function applyRemote(scope: Scope, edit: WsagentCreativeEdit): Promise<WsagentCreativeEntity> {
  scope.assertCurrent();
  const result = await invoke<{ entity: WsagentCreativeEntity }>('wsagent_shared_entities_apply', {
    ownerId: scope.owner, entity: edit,
  });
  scope.assertCurrent();
  return result.entity;
}

function guardedCard(scope: Scope, id: string, expected: DramaAsset | null): Scope {
  return { ...scope, assertCurrent: () => {
    scope.assertCurrent();
    const state = useAppStore.getState();
    if ((cards(state).find((asset) => asset.id === id) ?? null) !== expected) {
      throw new Error('素材在同步期间已修改');
    }
  } };
}

const equalText = (left: CreativeText, right: CreativeText) => left.name === right.name && left.description === right.description;

async function attemptImage<T>(scope: Scope, transfer: () => Promise<T>, pending: () => void): Promise<T | undefined> {
  try {
    return await transfer();
  } catch {
    scope.assertCurrent();
    pending();
    return undefined;
  }
}

async function syncCard(scope: Scope, asset: DramaAsset, current: LocalAsset, local: CreativeSnapshot, remote: WsagentCreativeEntity | undefined,
  remoteId: string, base: CreativeLink | undefined, pending: () => void,
): Promise<CreativeLink | null> {
  const checked = guardedCard(scope, asset.id, asset);
  const remoteVersion = remote && await creativeSnapshot(remote, remote.imageId);
  let merge = remote && remoteVersion && mergeCreativeAsset(current, local, remote, remoteVersion, base);
  if (!merge && remote?.imageDigest && remoteVersion && remote.kind === asset.kind && current.image) {
    const image = current.image;
    const mergeWithMatchingImage = mergeCreativeAsset(current, local, remote, remoteVersion, base, true);
    if (mergeWithMatchingImage) {
      const digest = await attemptImage(checked, async () => sha256BytesHex((await readImageFile(checked, image)).bytes), pending);
      if (digest === remote.imageDigest) merge = mergeWithMatchingImage;
    }
  }
  if (remote && (!merge || remote.kind !== asset.kind)) return null;

  const localText = merge?.localText ?? current;
  const remoteText = merge?.remoteText ?? current;
  const pushImage = merge?.image === 'push' || (!remote && !!current.image);
  const pullImage = merge?.image === 'pull';
  const received = pullImage && remote ? await attemptImage(checked, () => receiveImage(checked, remote), pending) : undefined;
  const sent = pushImage ? await attemptImage(checked, () => sendImage(checked, current.image, remoteText.name), pending) : undefined;
  checked.assertCurrent();
  const accepted = !remote || sent || !equalText(remote, remoteText)
    ? await applyRemote(checked, {
      id: remoteId, kind: asset.kind, name: remoteText.name, description: remoteText.description,
      expectedRevision: remote?.revision ?? null, image: sent,
    }) : remote;
  let acceptedLocal = local;
  if (received !== undefined || !equalText(current, localText)) {
    const next = await useAppStore.getState().applyWsagentCreativeAsset(
      scope.project, asset.id, asset.kind, asset, { ...localText, image: received }, scope.assertCurrent,
    );
    acceptedLocal = await snapshotLocal(readWsagentCreativeAsset(next, useAppStore.getState().nodes));
  }
  scope.assertCurrent();
  if (pushImage && sent === undefined) acceptedLocal = { ...acceptedLocal, image: base?.local.image ?? null };
  const remoteImage = pullImage && received === undefined ? base?.remote.image ?? null : accepted.imageId;
  return { remoteId, local: acceptedLocal, remote: await creativeSnapshot(accepted, remoteImage) };
}

async function importCard(scope: Scope, id: string, remote: WsagentCreativeEntity, pending: () => void): Promise<CreativeLink> {
  const checked = guardedCard(scope, id, null);
  const image = await attemptImage(checked, () => receiveImage(checked, remote), pending);
  checked.assertCurrent();
  const next = await useAppStore.getState().applyWsagentCreativeAsset(scope.project, id, remote.kind, null, {
    name: remote.name, description: remote.description, image,
  }, scope.assertCurrent);
  const local = await snapshotLocal(readWsagentCreativeAsset(next, useAppStore.getState().nodes));
  return { remoteId: remote.id, local, remote: await creativeSnapshot(remote, image === undefined ? null : remote.imageId) };
}

function errorCode(cause: unknown): unknown {
  return cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
}

async function syncProject(scope: Scope): Promise<WsagentCreativeSyncState> {
  await activateWsagentOwnerForCommand(scope.owner);
  scope.assertCurrent();
  const { entities } = await invoke<{ entities: WsagentCreativeEntity[] }>('wsagent_shared_entities_list', { ownerId: scope.owner });
  scope.assertCurrent();
  const storage = linkStorage(scope);
  const remote = new Map(entities.map((item) => [item.id, item]));
  const reserved = new Set([...storage.links.values()].map((link) => link.remoteId));
  const local = cards(useAppStore.getState());
  const remoteOrigins = new Map(await Promise.all(entities.map(async (item) => [
    await wsagentAssetId(scope.owner, scope.peer, item.id), item.id,
  ] as const)));
  let conflict = false;
  let failed = false;
  let saved = false;
  const pendingImage = () => { failed = true; };
  async function reconcile(id: string, operation: () => Promise<CreativeLink | null>) {
    scope.assertCurrent();
    try {
      const link = await operation();
      scope.assertCurrent();
      if (link) storage.accept(id, link);
      else conflict = true;
    } catch (cause: unknown) {
      scope.assertCurrent();
      if (errorCode(cause) === 'conflict') conflict = true;
      else failed = true;
    }
  }
  for (const asset of local) {
    const base = storage.links.get(asset.id);
    const remoteId = base?.remoteId ?? remoteOrigins.get(asset.id) ?? await canvasSectionId(scope.owner, asset.id);
    if (!base && reserved.has(remoteId)) { conflict = true; continue; }
    reserved.add(remoteId);
    const peer = remote.get(remoteId);
    if (base && !peer) continue;
    await reconcile(asset.id, async () => {
      const current = readWsagentCreativeAsset(asset, useAppStore.getState().nodes);
      const snapshot = await snapshotLocal(current);
      if ((!base || JSON.stringify(base.local) !== JSON.stringify(snapshot)) && !saved) {
        if (await useAppStore.getState().saveCurrentProjectSilent(guardedCard(scope, asset.id, asset).assertCurrent) !== scope.project) {
          throw new Error('项目资产尚未保存');
        }
        saved = true;
      }
      return syncCard(scope, asset, current, snapshot, peer, remoteId, base, pendingImage);
    });
  }
  for (const [id, remoteId] of remoteOrigins) {
    if (reserved.has(remoteId) || storage.links.has(id)) continue;
    await reconcile(id, () => importCard(scope, id, remote.get(remoteId)!, pendingImage));
  }
  return conflict ? 'conflict' : failed ? 'offline' : 'ready';
}

/** 跟随主窗口打开的作品，同一轮只操作捕获的配对项目。 */
export function observeWsagentCreativeSync() {
  let current: {
    owner: string; project: string; runtimeEpoch?: string; schedule: (delay: number) => void; dispose: () => void;
  } | undefined;
  const refresh = () => current?.schedule(0);
  const change = (state: AppState, previous?: AppState) => {
    const owner = activeWsagentOwner(state);
    const project = state.currentProjectId;
    const runtimeEpoch = state.projectExecutionContext?.runtimeEpoch;
    if (!owner || !project) { current?.dispose(); current = undefined; return; }
    if (current?.owner === owner && current.project === project && current.runtimeEpoch === runtimeEpoch) {
      if (previous?.dramaAssets !== state.dramaAssets || previous?.projects !== state.projects) current.schedule(DEBOUNCE);
      return;
    }
    current?.dispose();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let binding: WsagentSharedStatus | undefined;
    let pairingEpoch = 0;
    let busy = false;
    let pending = false;
    const schedule = (delay: number) => {
      if (controller.signal.aborted) return;
      if (busy) { pending = true; return; }
      clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };
    const run = async () => {
      busy = true;
      const epoch = pairingEpoch;
      try {
        const next = binding ?? await getWsagentSharedStatus(owner);
        const assertCurrent = () => {
          controller.signal.throwIfAborted();
          const latest = useAppStore.getState();
          if (epoch !== pairingEpoch || latest.currentProjectId !== project || activeWsagentOwner(latest) !== owner
            || latest.projectExecutionContext?.runtimeEpoch !== runtimeEpoch) {
            throw new Error('当前互联作品已切换');
          }
        };
        assertCurrent();
        binding = next;
        if (next.enabled && next.peerProjectId) {
          if (getWsagentCreativeSyncState(owner) === 'idle') report(owner, 'syncing');
          if (getWsagentScriptSyncState(owner) === 'idle') reportWsagentScriptSync(owner, 'syncing');
          await activateWsagentOwnerForCommand(owner);
          assertCurrent();
          const scope = { owner, project, peer: next.peerProjectId, signal: controller.signal, assertCurrent };
          const [assets, scripts] = await Promise.allSettled([syncProject(scope), syncWsagentScripts(scope)]);
          assertCurrent();
          if ([assets, scripts].some((result) => result.status === 'rejected' && errorCode(result.reason) === 'pairing')) {
            binding = undefined;
          }
          report(owner, assets.status === 'fulfilled' ? assets.value : 'offline');
          reportWsagentScriptSync(owner, scripts.status === 'fulfilled' ? scripts.value : 'offline');
        } else {
          report(owner, 'idle');
          reportWsagentScriptSync(owner, 'idle');
        }
      } catch (cause: unknown) {
        if (!controller.signal.aborted && epoch === pairingEpoch) {
          if (errorCode(cause) === 'pairing') binding = undefined;
          report(owner, 'offline');
          reportWsagentScriptSync(owner, 'offline');
        }
      } finally {
        busy = false;
        const delay = pending ? DEBOUNCE : INTERVAL;
        pending = false;
        schedule(delay);
      }
    };
    const unsubscribe = observeWsagentBinding(owner, (next) => {
      binding = next;
      pairingEpoch += 1;
      schedule(0);
    });
    current = { owner, project, runtimeEpoch, schedule, dispose: () => {
      controller.abort();
      clearTimeout(timer);
      unsubscribe();
      report(owner, 'idle');
      reportWsagentScriptSync(owner, 'idle');
    } };
    schedule(0);
  };
  const unsubscribe = useAppStore.subscribe(change);
  window.addEventListener('focus', refresh);
  change(useAppStore.getState());
  return () => {
    unsubscribe();
    window.removeEventListener('focus', refresh);
    current?.dispose();
  };
}
