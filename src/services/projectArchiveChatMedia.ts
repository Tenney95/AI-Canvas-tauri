import type { NativeArchiveChatMedia } from '../types/media';
import type { ProjectArchiveChatMediaV4, ProjectArchiveFileV4 } from '../types/projectArchiveV4';
import type { ProjectExchangeMedia } from '../types/projectExchange';
import type { ProjectModelTransferExchange, ProjectModelTransferHistoryRow, ProjectModelTransferIdMapEntry,
  ProjectModelTransferMedia } from '../types/projectModelTransfer';
import { isNativeMediaContentPath } from './nativeMediaContentPath';
import { safeExchangePath } from './projectExchangeDomain';

const digest = /^[a-f0-9]{64}$/;
const root = /^r2-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const imported = /^imports\/[A-Za-z0-9][A-Za-z0-9-]{0,127}-root-(?:0|[1-9][0-9]*)\//;
const bindingKeys = new Set(['fileId', 'storageRootRef', 'relativePath', 'sha256', 'bytes', 'kind', 'audioPurpose']);

export function isArchiveChatMediaKind(kind: unknown): kind is NativeArchiveChatMedia['kind'] {
  return kind === 'image' || kind === 'video' || kind === 'audio';
}

export function isArchiveChatAudioPurpose(kind: unknown, purpose: unknown): purpose is NativeArchiveChatMedia['audioPurpose'] {
  return purpose === undefined || kind === 'audio' && (purpose === 'music' || purpose === 'speech');
}

export function isArchiveChatMediaPath(path: string, sha256: string): boolean {
  if (isNativeMediaContentPath(path, sha256)) return true;
  if (!imported.test(path)) return false;
  try { return safeExchangePath(path) === path; } catch { return false; }
}

export function readNativeArchiveChatMedia(row: Partial<Record<'role' | 'id' | 'archiveOriginId' | 'archiveMedia' | 'mediaResult'
  | 'mediaStatus' | 'agentTaskId' | 'requestId', unknown>>): NativeArchiveChatMedia | undefined {
  if (row.role !== 'assistant' || typeof row.id !== 'string' || !/^archive-[a-f0-9]{64}$/.test(row.id)
    || typeof row.archiveOriginId !== 'string' || !digest.test(row.archiveOriginId) || row.mediaResult !== undefined
    || row.mediaStatus !== undefined || row.agentTaskId !== undefined || row.requestId !== undefined) return;
  const value = row.archiveMedia;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !bindingKeys.has(key))) return;
  const { fileId, storageRootRef, relativePath, sha256, bytes, kind, audioPurpose } = value as Record<string, unknown>;
  if (typeof fileId !== 'string' || !fileId || fileId.length > 256 || typeof storageRootRef !== 'string' || !root.test(storageRootRef)
    || typeof sha256 !== 'string' || !digest.test(sha256) || typeof relativePath !== 'string' || !isArchiveChatMediaPath(relativePath, sha256)
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0
    || !isArchiveChatMediaKind(kind) || !isArchiveChatAudioPurpose(kind, audioPurpose)) return;
  return { fileId, storageRootRef, relativePath, sha256, bytes, kind, ...(audioPurpose ? { audioPurpose } : {}) };
}

export function bindNativeArchiveChatMedia(card: ProjectArchiveChatMediaV4, file: ProjectArchiveFileV4 | undefined,
  media: ProjectExchangeMedia | undefined, identities: ProjectModelTransferIdMapEntry[],
  binding: ProjectModelTransferExchange['fileBindings'][number] | undefined): NativeArchiveChatMedia {
  const storageRootRef = identities.find((item) => item.kind === 'storage-root' && item.sourceId === file?.rootRef)?.localId;
  if (!file || !media || media.id !== file.mediaId || card.fileId !== file.id || media.kind !== card.kind || media.bytes <= 0
    || !binding || binding.rootRef !== file.rootRef || binding.relativePath !== file.relativePath || binding.id !== file.id
    || !storageRootRef || !root.test(storageRootRef) || !isArchiveChatMediaPath(binding.localRelativePath, media.sha256)) {
    throw new Error('归档媒体卡片缺少已验证的本地素材绑定');
  }
  return { fileId: file.id, storageRootRef, relativePath: binding.localRelativePath, sha256: media.sha256, bytes: media.bytes,
    kind: card.kind, ...(card.audioPurpose ? { audioPurpose: card.audioPurpose } : {}) };
}

/** 在登记新项目导入前，校验实际待发布文件，避免把普通消息字段当作素材授权。 */
export function validateNativeArchiveChatMediaRows(rows: ProjectModelTransferHistoryRow[], files: ProjectArchiveFileV4[],
  media: readonly ProjectExchangeMedia[], exchange: ProjectModelTransferExchange, publication: ProjectModelTransferMedia[]): void {
  const attachments = rows.filter((row) => row.kind === 'message' && row.value.archiveMedia !== undefined);
  if (!attachments.length) return;
  const byFile = new Map(files.map((file) => [file.id, file]));
  const byMedia = new Map(media.map((item) => [item.id, item]));
  const byBinding = new Map(exchange.fileBindings.map((item) => [item.id, item]));
  const published = new Map(publication.map((item) => [JSON.stringify([item.rootRef, item.relativePath]), item]));
  for (const row of attachments) {
    const value = readNativeArchiveChatMedia(row.value);
    if (!value) throw new Error('归档媒体卡片包含无效的本地素材身份');
    const file = byFile.get(value.fileId);
    const expected = bindNativeArchiveChatMedia({ messageId: row.value.id, fileId: value.fileId, kind: value.kind,
      audioPurpose: value.audioPurpose }, file, file && byMedia.get(file.mediaId), exchange.identities, byBinding.get(value.fileId));
    const stored = published.get(JSON.stringify([expected.storageRootRef, expected.relativePath]));
    if (expected.storageRootRef !== value.storageRootRef || expected.relativePath !== value.relativePath
      || expected.sha256 !== value.sha256 || expected.bytes !== value.bytes || !stored || stored.sha256 !== value.sha256 || stored.bytes !== value.bytes) {
      throw new Error('归档媒体卡片与待发布文件不一致');
    }
  }
}
