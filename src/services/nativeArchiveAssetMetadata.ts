/** 将已验证的便携素材附件绑定到本次物化文件；本机同文件元数据优先保留。 */
import type { ProjectArchivePayloadV4, ProjectExchangeSnapshotV2 } from '../types/projectArchiveV4';
import type { ProjectModelTransferAggregate, ProjectModelTransferExchange } from '../types/projectModelTransfer';
import type { VideoEditorProjectRecord } from '../types/videoEditor';
import type { NativeAssetRecord } from './indexedDb/nativeAssetRepository';
import type { NativeAssetSnapshot } from './nativeProjectAssetRecovery';
import { readProjectArchiveV4Files } from './projectArchiveV4';
import { configValuesEqual } from './configPatch';

export function materializeNativeArchiveAssetMetadata(input: {
  aggregate: ProjectModelTransferAggregate; editors: VideoEditorProjectRecord[];
  identities: ProjectModelTransferExchange['identities']; bindings: ProjectModelTransferExchange['fileBindings'];
  selected: ProjectExchangeSnapshotV2; source: ProjectExchangeSnapshotV2;
  metadata: ProjectArchivePayloadV4['assetMetadata']; local?: readonly NativeAssetSnapshot[];
}): NativeAssetRecord[] {
  if (!input.metadata) return [];
  const records: NativeAssetRecord[] = [], byPath = new Map<string, string>();
  const selectedFiles = readProjectArchiveV4Files(input.selected), sourceFiles = readProjectArchiveV4Files(input.source);
  for (const metadata of input.metadata.records) {
    const source = sourceFiles.find((file) => file.id === metadata.fileId), selected = selectedFiles.find((file) => file.id === metadata.fileId);
    const sourceMedia = input.source.media.find((media) => media.id === source?.mediaId), selectedMedia = input.selected.media.find((media) => media.id === selected?.mediaId);
    if (!source || !selected || !sourceMedia || !selectedMedia || !configValuesEqual(source, selected) || !configValuesEqual(sourceMedia, selectedMedia)) continue;
    const binding = input.bindings.find((file) => file.id === metadata.fileId && file.rootRef === selected.rootRef && file.relativePath === selected.relativePath);
    const root = input.identities.find((identity) => identity.kind === 'storage-root' && identity.sourceId === selected.rootRef)?.localId;
    if (!binding || !root) throw new Error('便携素材元数据缺少目标文件绑定');
    // 同一个本机文件已有信息时默认保留；附件不参与内容三方合并，不能无声覆盖标签。
    if (input.local?.some((asset) => asset.rootRef === root && asset.path === binding.localRelativePath
      && asset.bytes === selectedMedia.bytes && asset.sha256 === selectedMedia.sha256)) continue;
    const pathKey = JSON.stringify([root, binding.localRelativePath]);
    if (byPath.has(pathKey)) throw new Error('多个素材附件指向同一文件');
    const assetId = `na2-${crypto.randomUUID()}`; byPath.set(pathKey, assetId);
    records.push({ assetId, projectId: input.aggregate.project.id, ownerId: input.aggregate.project.id, rootRef: root,
      primary: root === input.aggregate.project.storageRootRef, relativePath: binding.localRelativePath, bytes: selectedMedia.bytes,
      sha256: selectedMedia.sha256, createdAt: Date.now(), ...(metadata.tags ? { tags: { ...structuredClone(metadata.tags), assetId } } : {}),
      images: metadata.images?.map((image) => ({ ...structuredClone(image), assetId,
        id: `asset-image:${encodeURIComponent(assetId)}:${image.contentDigest}`,
        references: image.references.map((reference) => {
          const original = sourceFiles.find((file) => file.id === reference.fileId && file.rootRef === selected.rootRef);
          const next = selectedFiles.find((file) => file.id === reference.fileId && file.rootRef === selected.rootRef);
          const beforeMedia = input.source.media.find((media) => media.id === original?.mediaId);
          const afterMedia = input.selected.media.find((media) => media.id === next?.mediaId);
          const destination = input.bindings.find((file) => file.id === reference.fileId && file.rootRef === selected.rootRef);
          if (!original || !next || !beforeMedia || !afterMedia || !destination || !configValuesEqual(original, next)
            || !configValuesEqual(beforeMedia, afterMedia) || afterMedia.bytes !== reference.bytes) throw new Error('图片元数据参考文件与选中版本不一致');
          const { fileId: _fileId, ...rest } = reference;
          return { ...rest, relativePath: destination.localRelativePath };
        }) })) ?? [] });
  }
  const history = new Set(['taskReceipt', 'mediaTaskReceipt', 'executionContext', 'projectScope', 'agentTask', 'mcpOperation', 'dispatchHistory', 'volcengineBinding']);
  const walk = (value: unknown, root: string, field = '', depth = 0): void => {
    if (depth > 64) throw new Error('素材引用嵌套异常');
    if (history.has(field) || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => walk(item, root, field, depth + 1)); return; }
    const row = value as Record<string, unknown>, bound = typeof row.storageRootRef === 'string' ? row.storageRootRef : root;
    const path = typeof row.relativePath === 'string' ? row.relativePath : row.imageRelativePath;
    const id = typeof path === 'string' ? byPath.get(JSON.stringify([bound, path])) : undefined;
    if (id) { row.assetId = id; if (row.imageAssetId) { delete row.imageAssetId; delete row.imageRelativePath; row.relativePath = path; } delete row.assetSource; }
    Object.entries(row).forEach(([key, item]) => walk(item, bound, key, depth + 1));
  };
  walk(input.aggregate, input.aggregate.project.storageRootRef); walk(input.editors, input.aggregate.project.storageRootRef);
  return records;
}
