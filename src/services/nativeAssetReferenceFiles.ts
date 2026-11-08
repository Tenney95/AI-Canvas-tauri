/** 图片专属参考图转成项目自有副本；原全局目录及素材索引不改写。 */
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import type { NativeAssetSnapshot } from './nativeProjectAssetRecovery';
import { isNativeAssetId } from './indexedDb/nativeAssetRepository';
import { readNativeProjectContent } from './indexedDb/nativeProjectRepository';
import { getAssetIndexById } from './indexedDbService';
import { fingerprintAssetImage } from './fs/assetImageMetadata';
import { getBaseDir, joinPath, stripVerbatimPrefix } from './fs/core';
import { safeExchangePath } from './projectExchangeDomain';

type ReferenceFile = { rootRef: string; path: string; bytes: number; sha256: string };
type Digest = { path: string; bytes: number; sha256: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const samePath = (a: string, b: string) => {
  const normalize = (value: string) => { const path = stripVerbatimPrefix(value).replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path; };
  return normalize(a) === normalize(b);
};
export async function freezeNativeAssetImageReferences(projectId: string, operationId: string, snapshots: readonly NativeAssetSnapshot[]): Promise<{
  snapshots: NativeAssetSnapshot[]; referenceFiles: ReferenceFile[];
}> {
  if (!uuid.test(operationId) || snapshots.length > 100_000) throw new Error('参考素材冻结操作无效');
  const result = structuredClone(snapshots) as NativeAssetSnapshot[];
  if (!result.some((snapshot) => snapshot.images?.some((image) => image.references.length))) return { snapshots: result, referenceFiles: [] };
  const target = await readNativeProjectContent(projectId);
  if (!target) throw new Error('原项目不存在，未冻结参考图');
  const publicationId = `asset-refs-${operationId}`, referenceFiles = new Map<string, ReferenceFile>();
  const batches = new Map<string, { root: string; sources: Map<string, string>; assets: Map<string, { path: string; sourceRootRef: string; destinationPath: string; bytes: number; sha256: string }> }>();
  const verify: Array<{ reference: { relativePath: string; digest: string; bytes: number }; originalDigest: string; originalBytes: number; root: string }> = [];
  const sourceIdentities: Array<{ assetId: string; root: string }> = [];
  const legacyBase = await getBaseDir();
  for (const snapshot of result) {
    if (!snapshot.images?.some((image) => image.references.length)) continue;
    if (!target.project.storageBindings.some((binding) => binding.rootRef === snapshot.rootRef)) throw new Error('参考图目标根不属于原项目');
    const index = isNativeAssetId(snapshot.assetId) ? await getAssetIndexById(snapshot.assetId) : undefined;
    if (isNativeAssetId(snapshot.assetId) && (!index?.rootPath || index.source !== 'project')) throw new Error('原生参考图缺少受控素材索引');
    const sourceRoot = index?.rootPath ?? (legacyBase && joinPath(legacyBase, 'asset-image-references'));
    if (!sourceRoot) throw new Error('原参考图目录不可用');
    sourceIdentities.push({ assetId: snapshot.assetId, root: sourceRoot });
    let batch = batches.get(snapshot.rootRef);
    if (!batch) {
      const root = snapshot.rootRef === target.project.storageRootRef
        ? await invoke<string>('resolve_native_project_media_root', { projectId })
        : await invoke<string>('resolve_native_project_media_subroot', { projectId, rootRef: snapshot.rootRef, create: false });
      batch = { root, sources: new Map(), assets: new Map() }; batches.set(snapshot.rootRef, batch);
    }
    let sourceRef = [...batch.sources].find(([, directory]) => samePath(directory, sourceRoot))?.[0];
    if (!sourceRef) { sourceRef = `source-${batch.sources.size}`; batch.sources.set(sourceRef, sourceRoot); }
    for (const image of snapshot.images) for (const reference of image.references) {
      const oldPath = reference.relativePath;
      const relative = index ? safeExchangePath(oldPath) : /^asset-image-references\/[a-f0-9-]{36}\.[a-z0-9]{1,8}$/.test(oldPath) ? oldPath.slice('asset-image-references/'.length) : undefined;
      if (!relative) throw new Error('旧参考图路径无效');
      const original = await fingerprintAssetImage(joinPath(sourceRoot, relative));
      if (original.digest !== reference.digest || original.bytes !== reference.bytes) throw new Error('原图片专属参考图已变化，未冻结');
      const scanned = await invoke<Digest[]>('inspect_project_archive_assets', { assetsDir: sourceRoot, selectedPaths: [relative] });
      if (scanned.length !== 1 || scanned[0].path !== relative || scanned[0].bytes !== reference.bytes || !/^[a-f0-9]{64}$/.test(scanned[0].sha256)) throw new Error('原参考图摘要无法确认');
      const extension = relative.split('.').at(-1)?.toLowerCase();
      if (!extension || !/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('参考图扩展名无效');
      const name = `ref-${scanned[0].sha256}.${extension}`, path = `imports/${publicationId}/${name}`;
      const assetKey = name.toLowerCase();
      if (!batch.assets.has(assetKey)) batch.assets.set(assetKey, { path: relative, sourceRootRef: sourceRef, destinationPath: name,
        bytes: scanned[0].bytes, sha256: scanned[0].sha256 });
      reference.relativePath = path;
      referenceFiles.set(JSON.stringify([snapshot.rootRef, path]), { rootRef: snapshot.rootRef, path, bytes: scanned[0].bytes, sha256: scanned[0].sha256 });
      verify.push({ reference, originalDigest: original.digest, originalBytes: original.bytes, root: batch.root });
    }
  }
  for (const batch of batches.values()) {
    const assets = [...batch.assets.values()];
    if (!await exists(joinPath(batch.root, `imports/${publicationId}`))) {
      try { await invoke('publish_project_import_assets', { stagingDir: batch.sources.values().next().value!, projectDir: batch.root,
        operationId: publicationId, sourceRoots: [...batch.sources].map(([rootRef, directory]) => ({ rootRef, directory })), assets }); }
      catch (error) { if (!await exists(joinPath(batch.root, `imports/${publicationId}`))) throw error; }
    }
    const scanned = await invoke<Digest[]>('inspect_project_archive_assets', { assetsDir: batch.root,
      selectedPaths: assets.map((asset) => `imports/${publicationId}/${asset.destinationPath}`) });
    if (scanned.length !== assets.length || assets.some((asset) => !scanned.some((file) => file.path === `imports/${publicationId}/${asset.destinationPath}`
      && file.bytes === asset.bytes && file.sha256 === asset.sha256))) throw new Error('发布后的参考素材摘要不一致，保留原操作');
  }
  for (const item of verify) {
    const copied = await fingerprintAssetImage(joinPath(item.root, item.reference.relativePath));
    if (copied.digest !== item.originalDigest || copied.bytes !== item.originalBytes) throw new Error('参考图副本内容与原元数据不一致');
  }
  for (const identity of sourceIdentities) {
    const current = isNativeAssetId(identity.assetId) ? (await getAssetIndexById(identity.assetId))?.rootPath
      : await getBaseDir().then((base) => base && joinPath(base, 'asset-image-references'));
    if (!current || !samePath(current, identity.root)) throw new Error('原参考图目录身份已变化，未提交元数据');
  }
  return { snapshots: result, referenceFiles: [...referenceFiles.values()].sort((a, b) => `${a.rootRef}/${a.path}`.localeCompare(`${b.rootRef}/${b.path}`)) };
}
