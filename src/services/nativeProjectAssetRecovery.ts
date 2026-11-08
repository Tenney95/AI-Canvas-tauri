import { nativeGlobalAssetReferenceRows } from './nativeGlobalAssetReferences';
/** 按冻结的文件摘要创建项目内新身份；原索引及全局素材始终保留。 */
import type { ProjectModelTransferAggregate, ProjectModelTransferCapture } from '../types/projectModelTransfer';
import type { VideoEditorProjectRecord } from '../types/videoEditor';
import type { NativeAssetRecord } from './indexedDb/nativeAssetRepository';
import type { NativeRecoveryAssetMapping, NativeRecoveryFileMapping, NativeRecoveryIdentityMapping } from './nativeProjectRawRecovery';
import { getAssetImageRecords, getAssetIndexById, getAssetMetaById } from './indexedDbService';
import type { NativeGlobalRecoveryFile } from './nativeProjectArchiveService';
import { invoke } from '@tauri-apps/api/core';
import { stripVerbatimPrefix } from './fs/core';

export interface NativeAssetSnapshot {
  assetId: string; rootRef: string; path: string; ownerId: string; bytes: number; sha256: string;
  tags?: NativeAssetRecord['tags']; images?: NativeAssetRecord['images'];
}
export function remapNativeAssetImageReferences(images: NonNullable<NativeAssetSnapshot['images']>, rootRef: string,
  files: readonly NativeRecoveryFileMapping[]): NonNullable<NativeAssetSnapshot['images']> {
  return images.map((image) => ({ ...structuredClone(image), references: image.references.map((reference) => {
    const matches = files.filter((file) => file.rootRef === rootRef && file.from === reference.relativePath);
    if (matches.length !== 1) throw new Error('图片专属参考素材缺少唯一恢复映射');
    return { ...reference, relativePath: matches[0].to };
  }) }));
}
export function rebindNativeAssetReferenceFiles(capture: ProjectModelTransferCapture,
  references: readonly { rootRef: string; path: string }[]): void {
  if (!capture.exchange) return;
  for (const reference of references) {
    const logical = capture.exchange.identities.find((identity) => identity.kind === 'storage-root' && identity.localId === reference.rootRef)?.sourceId;
    if (!logical) continue;
    const name = reference.path.split('/').at(-1);
    const matches = capture.exchange.fileBindings.filter((binding) => binding.rootRef === logical
      && /^imports\/asset-refs-[a-f0-9-]{36}\//.test(binding.localRelativePath) && binding.localRelativePath.split('/').at(-1) === name);
    if (matches.length > 1) throw new Error('图片参考素材的历史文件身份不唯一');
    if (matches[0]) matches[0].localRelativePath = reference.path;
  }
}

export async function captureNativeAssetSnapshots(aggregate: ProjectModelTransferAggregate, editors: readonly VideoEditorProjectRecord[],
  files: readonly { rootRef: string; path: string; bytes: number; sha256: string }[], globalFiles: readonly NativeGlobalRecoveryFile[] = []): Promise<NativeAssetSnapshot[]> {
  const references = new Map<string, { rootRef: string; path: string }>();
  let count = 0;
  const history = new Set(['taskReceipt', 'mediaTaskReceipt', 'executionContext', 'projectScope', 'agentTask', 'mcpOperation', 'dispatchHistory', 'volcengineBinding']);
  const walk = (value: unknown, root: string, field = '') => {
    if (++count > 1_000_000) throw new Error('恢复素材引用过多');
    if (history.has(field) || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => walk(item, root, field)); return; }
    const row = value as Record<string, unknown>, bound = typeof row.storageRootRef === 'string' ? row.storageRootRef : root;
    for (const [idKey, pathKey] of [['assetId', 'relativePath'], ['imageAssetId', 'imageRelativePath']] as const) {
      if (typeof row[idKey] !== 'string' || !row[idKey]) continue;
      const id = row[idKey] as string, path = row[pathKey] ?? row.relativePath;
      if (typeof path !== 'string') throw new Error('素材身份缺少受控相对路径');
      const previous = references.get(id);
      if (previous && (previous.rootRef !== bound || previous.path !== path)) throw new Error('素材身份引用了不同根或路径');
      references.set(id, { rootRef: bound, path });
    }
    Object.entries(row).forEach(([key, item]) => walk(item, bound, key));
  };
  walk(aggregate, aggregate.project.storageRootRef); walk(editors, aggregate.project.storageRootRef);
  if (!references.size) return [];
  const images = await getAssetImageRecords();
  const snapshots: NativeAssetSnapshot[] = [];
  const roots = new Map<string, string>();
  for (const [assetId, reference] of references) {
    const descriptors = files.filter((item) => item.rootRef === reference.rootRef && item.path === reference.path);
    const index = await getAssetIndexById(assetId);
    const global = globalFiles.some((file) => file.assetId === assetId && file.rootRef === reference.rootRef && file.path === reference.path
      && file.bytes === descriptors[0]?.bytes && file.sha256 === descriptors[0]?.sha256);
    if (descriptors.length !== 1 || !index || (global ? index.source !== 'global' : index.source !== 'project' || index.relativePath !== reference.path)
      || !global && index.projectId !== aggregate.project.id && !aggregate.canvases.some((canvas) => canvas.id === index.projectId)
      || index.size !== descriptors[0].bytes) throw new Error('原素材缺少本项目索引或文件摘要证明');
    if (!global) {
      let root = roots.get(reference.rootRef);
      if (!root) {
        root = reference.rootRef === aggregate.project.storageRootRef
          ? await invoke<string>('resolve_native_project_media_root', { projectId: aggregate.project.id })
          : await invoke<string>('resolve_native_project_media_subroot', { projectId: aggregate.project.id, rootRef: reference.rootRef, create: false });
        roots.set(reference.rootRef, root);
      }
      const normalize = (value: string) => { const path = stripVerbatimPrefix(value).replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path; };
      if (!index.rootPath || normalize(index.rootPath) !== normalize(root) || normalize(index.path) !== normalize(`${root}/${reference.path}`)) throw new Error('素材索引根与原生文件根不一致');
    }
    const tags = await getAssetMetaById(assetId), descriptor = descriptors[0];
    const { path: _path, ...portableTags } = tags ?? {};
    const imageRecords = images.filter((image) => image.assetId === assetId);
    snapshots.push({ assetId, ...reference, ownerId: global ? aggregate.project.id : index.projectId!, bytes: descriptor.bytes, sha256: descriptor.sha256,
      ...(tags ? { tags: portableTags as NativeAssetSnapshot['tags'] } : {}),
      images: imageRecords.map((image) => structuredClone(image)) });
  }
  return snapshots.sort((a, b) => a.assetId.localeCompare(b.assetId));
}

/** 独立重算全局素材的本机副本投影，仅改已建模的素材定位字段。 */
export function applyNativeGlobalRecoveryFiles(capture: ProjectModelTransferCapture, files: readonly NativeGlobalRecoveryFile[]): ProjectModelTransferCapture {
  if (!files.length) return structuredClone(capture);
  const result = structuredClone(capture), used = new Set<string>();
  for (const row of nativeGlobalAssetReferenceRows(result)) {
    const id = row.imageAssetId ?? row.assetId;
    const mapping = files.find((file) => file.assetId === id);
    if (!mapping) continue;
    if (mapping.rootRef !== result.aggregate.project.storageRootRef || !/^imports\/global-[a-f0-9-]{36}\/global-[a-f0-9]{64}\.[a-z0-9]{1,16}$/.test(mapping.path)) throw new Error('全局素材恢复副本映射无效');
    row.assetSource = 'project'; if (row.imageAssetId) row.imageRelativePath = mapping.path;
    delete row.filePath; delete row.imageUrl; delete row.audioUrl; delete row.videoUrl; delete row.url; delete row.output; delete row.imageNodeId; delete row.sourceNodeId;
    row.storageRootRef = result.aggregate.project.storageRootRef; row.relativePath = mapping.path; used.add(mapping.assetId);
  }
  if (used.size !== files.length) throw new Error('全局素材恢复副本未绑定原引用');
  const logical = result.exchange?.identities.find((item) => item.kind === 'storage-root' && item.localId === result.aggregate.project.storageRootRef)?.sourceId;
  if (logical) for (const file of files) {
    const name = file.path.split('/').at(-1)!.replace(/\.[^.]+$/, '');
    const previous = result.exchange!.fileBindings.filter((item) => item.rootRef === logical
      && /^imports\/global-[a-f0-9-]{36}\//.test(item.localRelativePath)
      && item.localRelativePath.split('/').at(-1)?.replace(/\.[^.]+$/, '') === name);
    if (previous.length > 1) throw new Error('全局素材旧映射不唯一');
    if (previous[0]) previous[0].localRelativePath = file.path;
  }
  return result;
}

export function allocateNativeRecoveryAssets(projectId: string, primaryRoot: string, snapshots: readonly NativeAssetSnapshot[],
  files: readonly NativeRecoveryFileMapping[], canvases: readonly NativeRecoveryIdentityMapping[], retiredOwners: readonly string[] = []): { records: NativeAssetRecord[]; mappings: NativeRecoveryAssetMapping[] } {
  const records: NativeAssetRecord[] = [], mappings: NativeRecoveryAssetMapping[] = [];
  const paths = new Set<string>();
  for (const source of snapshots) {
    const matches = files.filter((file) => file.rootRef === source.rootRef && file.from === source.path);
    if (matches.length !== 1) throw new Error('恢复素材身份缺少唯一文件映射');
    const target = matches[0], pathKey = JSON.stringify([source.rootRef, target.to]);
    if (paths.has(pathKey)) throw new Error('同一恢复文件关联多个不同素材身份，需先明确元数据归属');
    paths.add(pathKey);
    const ownerId = source.ownerId === projectId || retiredOwners.includes(source.ownerId) ? projectId : canvases.find((canvas) => canvas.from === source.ownerId)?.to;
    if (!ownerId) throw new Error('恢复素材归属已变化');
    const assetId = `na2-${crypto.randomUUID()}`;
    records.push({ assetId, projectId, ownerId, rootRef: source.rootRef, primary: source.rootRef === primaryRoot,
      relativePath: target.to, bytes: source.bytes, sha256: source.sha256, createdAt: Date.now(),
      ...(source.tags ? { tags: { ...structuredClone(source.tags), assetId } } : {}),
      images: remapNativeAssetImageReferences(source.images ?? [], source.rootRef, files)
        .map((image) => ({ ...image, assetId, id: `asset-image:${encodeURIComponent(assetId)}:${image.contentDigest}` })) });
    mappings.push({ from: source.assetId, to: assetId, rootRef: source.rootRef, fromPath: source.path, toPath: target.to });
  }
  return { records, mappings };
}
