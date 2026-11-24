import { nativeGlobalAssetReferenceRows } from './nativeGlobalAssetReferences';
/** 按冻结的文件摘要创建项目内新身份；原索引及全局素材始终保留。 */
import type { ProjectModelTransferAggregate, ProjectModelTransferCapture } from '../types/projectModelTransfer';
import type { VideoEditorProjectRecord } from '../types/videoEditor';
import type { NativeAssetRecord } from './indexedDb/nativeAssetRepository';
import { listNativeRetiredCanvasIds } from './indexedDb/nativeProjectRepository';
import type { NativeRecoveryAssetMapping, NativeRecoveryFileMapping, NativeRecoveryIdentityMapping } from './nativeProjectRawRecovery';
import { getAssetImageRecords, getAssetIndexById, getAssetMetaById, putAssetIndexes } from './indexedDbService';
import type { NativeGlobalRecoveryFile } from './nativeProjectArchiveService';
import type { ProjectModelArchiveAsset } from './projectModelArchiveService';
import { projectArchiveDisplayLabel, safeExchangePath } from './projectExchangeDomain';
import { invoke } from '@tauri-apps/api/core';
import { stripVerbatimPrefix } from './fs/core';

export interface NativeAssetSnapshot {
  assetId: string; rootRef: string; path: string; ownerId: string; bytes: number; sha256: string;
  tags?: NativeAssetRecord['tags']; images?: NativeAssetRecord['images'];
}

type OriginalAssetDescriptor = Pick<ProjectModelArchiveAsset, 'rootRef' | 'path' | 'bytes' | 'sha256' | 'backupSourceRelativePath'>;
const historyFields = new Set(['taskReceipt', 'mediaTaskReceipt', 'executionContext', 'projectScope', 'agentTask', 'mcpOperation', 'dispatchHistory', 'volcengineBinding']);
const assetReferenceFields = [['assetId', 'relativePath'], ['imageAssetId', 'imageRelativePath']] as const;

function slashPath(value: string): string {
  return stripVerbatimPrefix(value).replace(/\\/g, '/').replace(/\/+$/, '');
}

function comparablePath(value: string): string {
  return /^(?:[a-z]:(?:\/|$)|\/\/)/i.test(value) ? value.toLowerCase() : value;
}

function assetProofError(path: string, message = '原素材缺少本项目索引或文件摘要证明'): Error {
  const name = projectArchiveDisplayLabel(path.slice(path.lastIndexOf('/') + 1));
  return new Error(`${message}（${name}）`);
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
  files: readonly OriginalAssetDescriptor[],
  globalFiles: readonly NativeGlobalRecoveryFile[] = []): Promise<NativeAssetSnapshot[]> {
  const references = new Map<string, { rootRef: string; path: string }>();
  let count = 0;
  const walk = (value: unknown, root: string, field = '') => {
    if (++count > 1_000_000) throw new Error('恢复素材引用过多');
    if (historyFields.has(field) || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => walk(item, root, field)); return; }
    const row = value as Record<string, unknown>, bound = typeof row.storageRootRef === 'string' ? row.storageRootRef : root;
    for (const [idKey, pathKey] of assetReferenceFields) {
      const id = row[idKey];
      if (typeof id !== 'string' || !id) continue;
      const path = row[pathKey] ?? row.relativePath;
      if (typeof path !== 'string') throw new Error('素材身份缺少受控相对路径');
      const previous = references.get(id);
      if (previous && (previous.rootRef !== bound || previous.path !== path)) throw new Error('素材身份引用了不同根或路径');
      if (!previous) references.set(id, { rootRef: bound, path });
    }
    for (const key in row) {
      if (Object.hasOwn(row, key)) walk(row[key], bound, key);
    }
  };
  walk(aggregate, aggregate.project.storageRootRef); walk(editors, aggregate.project.storageRootRef);
  if (!references.size) return [];

  const filesByRoot = new Map<string, Map<string, OriginalAssetDescriptor | null | undefined>>();
  for (const { rootRef, path } of references.values()) {
    let paths = filesByRoot.get(rootRef);
    if (!paths) {
      paths = new Map();
      filesByRoot.set(rootRef, paths);
    }
    paths.set(path, undefined);
  }
  for (const file of files) {
    const paths = filesByRoot.get(file.rootRef);
    if (!paths?.has(file.path)) continue;
    // 同一根和路径出现多次时保留歧义，即使两份描述符的内容相同。
    paths.set(file.path, paths.get(file.path) === undefined ? file : null);
  }
  const globalAssetIds = new Set<string>();
  for (const file of globalFiles) {
    const reference = references.get(file.assetId);
    if (reference?.rootRef !== file.rootRef || reference.path !== file.path) continue;
    const descriptor = filesByRoot.get(file.rootRef)?.get(file.path);
    if (descriptor && file.bytes === descriptor.bytes && file.sha256 === descriptor.sha256) globalAssetIds.add(file.assetId);
  }
  const imagesByAsset = new Map<string, NonNullable<NativeAssetSnapshot['images']>>();
  for (const image of await getAssetImageRecords()) {
    if (!references.has(image.assetId)) continue;
    const records = imagesByAsset.get(image.assetId);
    if (records) records.push(image);
    else imagesByAsset.set(image.assetId, [image]);
  }

  const snapshots: NativeAssetSnapshot[] = [];
  const roots = new Map<string, { path: string; comparable: string }>();
  const projectId = aggregate.project.id;
  const activeCanvasIds = new Set(aggregate.canvases.map((canvas) => canvas.id));
  const rootMismatch = '素材索引根与原生文件根不一致';
  let retiredCanvasIds: Set<string> | undefined;
  for (const [assetId, reference] of references) {
    const descriptor = filesByRoot.get(reference.rootRef)?.get(reference.path);
    const global = globalAssetIds.has(assetId);
    let index = await getAssetIndexById(assetId);
    if (!descriptor || !index || index.source !== (global ? 'global' : 'project') || index.size !== descriptor.bytes) {
      throw assetProofError(reference.path);
    }
    let ownerId = projectId;
    if (!global) {
      const repairLocation = (index.rootPath === undefined || index.relativePath === undefined) && !assetId.startsWith('na2-')
        && descriptor.backupSourceRelativePath === undefined && /^[a-f0-9]{64}$/.test(descriptor.sha256);
      if (!index.projectId || (index.relativePath !== reference.path && !(index.relativePath === undefined && repairLocation))) {
        throw assetProofError(reference.path);
      }
      if (activeCanvasIds.has(index.projectId)) ownerId = index.projectId;
      else if (index.projectId !== projectId) {
        retiredCanvasIds ??= new Set(await listNativeRetiredCanvasIds(projectId));
        if (!retiredCanvasIds.has(index.projectId)) throw assetProofError(reference.path);
      }
      let root = roots.get(reference.rootRef);
      if (!root) {
        const resolved = reference.rootRef === aggregate.project.storageRootRef
          ? await invoke<string>('resolve_native_project_media_root', { projectId })
          : await invoke<string>('resolve_native_project_media_subroot', { projectId, rootRef: reference.rootRef, create: false });
        const path = slashPath(resolved);
        root = { path, comparable: comparablePath(path) };
        roots.set(reference.rootRef, root);
      }
      if (comparablePath(slashPath(index.path)) !== comparablePath(slashPath(`${root.path}/${reference.path}`))
        || (index.rootPath !== undefined && comparablePath(slashPath(index.rootPath)) !== root.comparable)) {
        throw assetProofError(reference.path, rootMismatch);
      }
      if (repairLocation && safeExchangePath(reference.path) === reference.path) {
        // 仅补齐已有项目身份的定位字段，事务内复核归属和路径。
        [index] = await putAssetIndexes([{ ...index, rootPath: index.rootPath ?? root.path, relativePath: reference.path }], { repairMissingProjectLocation: true });
      }
      if (index.relativePath !== reference.path || index.size !== descriptor.bytes) throw assetProofError(reference.path);
      if (!index.rootPath || comparablePath(slashPath(index.rootPath)) !== root.comparable) {
        throw assetProofError(reference.path, rootMismatch);
      }
    }
    const tags = await getAssetMetaById(assetId);
    const { path: _path, ...portableTags } = tags ?? {};
    const imageRecords = imagesByAsset.get(assetId);
    snapshots.push({ assetId, ...reference, ownerId, bytes: descriptor.bytes, sha256: descriptor.sha256,
      ...(tags ? { tags: portableTags as NativeAssetSnapshot['tags'] } : {}),
      images: imageRecords ? imageRecords.map((image) => structuredClone(image)) : [] });
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
