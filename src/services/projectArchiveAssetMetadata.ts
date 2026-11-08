/** 可移植素材元数据附件；独立参考图未进入文件闭包前拒绝省略或伪造。 */
import type { ProjectArchiveAssetMetadataV4, ProjectArchiveFileV4 } from '../types/projectArchiveV4';
import type { NativeAssetSnapshot } from './nativeProjectAssetRecovery';
import type { ProjectModelTransferExchange } from '../types/projectModelTransfer';
import { projectExchangeId } from './projectExchangeFormat';
import { configValuesEqual } from './configPatch';
import type { ProjectExchangeMedia } from '../types/projectExchange';

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length || Object.entries(Object.getOwnPropertyDescriptors(value))
      .some(([key, descriptor]) => !allowed.includes(key) || !('value' in descriptor) || !descriptor.enumerable)) throw new Error('素材元数据包含未知或不可序列化字段');
  return value as Record<string, unknown>;
}
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function validateArchiveAssetMetadata(input: unknown, files: readonly ProjectArchiveFileV4[],
  media: readonly ProjectExchangeMedia[] = []): asserts input is ProjectArchiveAssetMetadataV4 | undefined {
  if (input === undefined) return;
  const data = object(input, ['version', 'records']);
  if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > 10_000) throw new Error('素材元数据版本或数量无效');
  const ids = new Set<string>(), available = new Set(files.map((file) => file.id));
  for (const value of data.records) {
    const row = object(value, ['fileId', 'tags', 'images']), id = projectExchangeId(row.fileId);
    if (!available.has(id) || ids.has(id) || row.tags === undefined && row.images === undefined) throw new Error('素材元数据的逻辑文件缺失或重复');
    ids.add(id);
    const ownerFile = files.find((file) => file.id === id)!;
    if (row.tags !== undefined) {
      const tags = object(row.tags, ['tags', 'taggedBy', 'updatedAt']);
      if (!Array.isArray(tags.tags) || tags.tags.length > 16 || tags.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40)
        || !integer(tags.updatedAt) || tags.taggedBy !== undefined && !['manual', 'comfyui', 'vision'].includes(tags.taggedBy as string)) throw new Error('素材标签无效');
    }
    if (row.images !== undefined) {
      if (!Array.isArray(row.images) || row.images.length > 1000) throw new Error('图片元数据版本过多');
      const versions = new Set<string>();
      for (const value of row.images) {
        const image = object(value, ['contentDigest', 'fileName', 'prompt', 'references', 'revision', 'updatedAt']);
        if (typeof image.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(image.contentDigest) || versions.has(image.contentDigest)
          || typeof image.fileName !== 'string' || image.fileName.length > 512 || /[\\/\u0000]/.test(image.fileName)
          || typeof image.prompt !== 'string' || image.prompt.length > 30_000 || !integer(image.revision) || !integer(image.updatedAt)
          || !Array.isArray(image.references) || image.references.length > 16) throw new Error('图片元数据或参考素材闭包无效');
        const refs = new Set<string>();
        for (const value of image.references) {
          const ref = object(value, ['id', 'name', 'fileId', 'digest', 'bytes']);
          const fileId = projectExchangeId(ref.fileId), file = files.find((item) => item.id === fileId);
          const bytes = file && media.find((item) => item.id === file.mediaId);
          if (typeof ref.id !== 'string' || !ref.id || ref.id.length > 256 || refs.has(ref.id)
            || typeof ref.name !== 'string' || ref.name.length > 512 || !file || file.rootRef !== ownerFile.rootRef || !bytes
            || typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest) || ref.bytes !== bytes.bytes) throw new Error('图片参考素材闭包无效');
          refs.add(ref.id);
        }
        versions.add(image.contentDigest);
      }
    }
  }
}

export function captureArchiveAssetMetadata(snapshots: readonly NativeAssetSnapshot[], exchange: ProjectModelTransferExchange,
  files: readonly ProjectArchiveFileV4[], media: readonly ProjectExchangeMedia[] = []): ProjectArchiveAssetMetadataV4 | undefined {
  const records = new Map<string, ProjectArchiveAssetMetadataV4['records'][number]>();
  for (const source of snapshots) {
    const root = exchange.identities.find((item) => item.kind === 'storage-root' && item.localId === source.rootRef)?.sourceId;
    const bindings = exchange.fileBindings.filter((item) => item.rootRef === root && item.localRelativePath === source.path);
    if (!bindings.length) continue; // 保留的历史索引不自动成为当前归档的活动文件。
    if (bindings.length !== 1) throw new Error('素材元数据文件映射不唯一');
    const row: ProjectArchiveAssetMetadataV4['records'][number] = { fileId: bindings[0].id,
      ...(source.tags ? { tags: { tags: [...source.tags.tags], updatedAt: source.tags.updatedAt,
        ...(source.tags.taggedBy ? { taggedBy: source.tags.taggedBy } : {}) } } : {}),
      ...(source.images?.length ? { images: source.images.map(({ assetId: _assetId, id: _id, ...image }):
        NonNullable<ProjectArchiveAssetMetadataV4['records'][number]['images']>[number] => {
        const references = image.references.map(({ relativePath, ...reference }) => {
          const targets = exchange.fileBindings.filter((item) => item.rootRef === root && item.localRelativePath === relativePath);
          if (targets.length !== 1) throw new Error('图片参考素材尚未纳入归档闭包，未导出');
          return { ...reference, fileId: targets[0].id };
        });
        return { ...image, references };
      }) } : {}) };
    if (!row.tags && !row.images) continue;
    const previous = records.get(row.fileId);
    if (previous && !configValuesEqual(previous, row)) throw new Error('同一文件含冲突的素材元数据');
    records.set(row.fileId, row);
  }
  if (!records.size) return undefined;
  const result = { version: 1 as const, records: [...records.values()].sort((a, b) => a.fileId.localeCompare(b.fileId)) };
  validateArchiveAssetMetadata(result, files, media); return result;
}
