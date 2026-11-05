/** 项目共享的纯格式边界：不读取文件、历史、配置或全局资产。 */
import type { DramaAsset, DramaCharacter } from '../types/dramaAssets';
import { MAX_CHARACTER_WEAPONS, normalizeDramaVisualAsset, parseDramaMentionId } from '../types/dramaAssets';
import type { SharedSyncCardPayload, SharedSyncDraft, SharedSyncFilePayload, SharedSyncMedia,
  SharedSyncMediaKind, SharedSyncMemberKind, SharedSyncRevision } from '../types/assetSync';
import { DRAMA_ASSET_TRANSFER_FORMAT, DRAMA_ASSET_TRANSFER_VERSION, DRAMA_ASSET_TRANSFER_LIMITS,
  parseDramaAssetTransferDocument } from './dramaAssetTransferFormat';
import { localMediaUrlToPath } from '../utils/mediaUrl';

export const SHARED_ASSET_SYNC_FORMAT = 'ai-canvas-shared-asset';
export const SHARED_ASSET_SYNC_VERSION = 1;
const encoder = new TextEncoder();
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MEDIA_EXTENSIONS: Record<SharedSyncMediaKind, readonly string[]> = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'svg', 'ico', 'apng'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'aiff', 'aif', 'wma', 'webm', 'mp4', 'weba', 'm4b', 'caf'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg', 'wmv', 'flv', '3gp', 'ts', 'mts', 'm2ts'],
};
const BASE = ['id', 'kind', 'name', 'key', 'summary', 'visualNotes', 'storyRole', 'importance', 'firstSeen',
  'appearances', 'imageUrl', 'confirmed', 'createdAt', 'updatedAt', 'source'];
const CHARACTER = ['aliases', 'identity', 'ageBand', 'gender', 'personality', 'relationships', 'wardrobeDefault',
  'voiceNotes', 'referenceImages', 'primaryReferenceImageId', 'avatarReferenceImageId', 'avatarCrop',
  'voiceClips', 'primaryVoiceClipId', 'actions', 'weaponIds'];
const VISUAL = ['referenceImages', 'primaryReferenceImageId'];
const REFERENCE = ['id', 'kind', 'imageUrl', 'prompt', 'createdAt', 'updatedAt'];
const VISUAL_REFERENCE = ['id', 'label', 'imageUrl', 'prompt', 'createdAt', 'updatedAt'];
const VOICE = ['id', 'kind', 'label', 'audioUrl', 'transcript', 'durationSec', 'createdAt', 'updatedAt'];
const ACTION = ['id', 'category', 'customCategory', 'name', 'prompt', 'media', 'createdAt', 'updatedAt'];
const ACTION_MEDIA = ['id', 'kind', 'name', 'mimeType', 'url', 'createdAt', 'updatedAt'];
const DRAMA_MENTION = /@drama\{([^:}\r\n]+):([^}\r\n]*)\}/g;
type Data = Record<string, unknown>;
type FormatStage = 'format' | 'restoreText' | 'restoreMedia';
const fail = (reason = 'invalidFormat', fieldPath = 'revision', stage: FormatStage = 'format'): never => {
  throw new Error(`项目共享资产格式无效（${stage}/${reason}；字段：${fieldPath}）`, { cause: { reason, fieldPath, stage } });
};
const object = (value: unknown): Data => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  return value as Data;
};
const keys = (value: Data, allowed: readonly string[]) => { if (Object.keys(value).some((key) => !allowed.includes(key))) fail(); };
const id = (value: unknown): string => { if (typeof value !== 'string' || !ID.test(value)) return fail(); return value; };
const localId = (value: unknown, fieldPath = 'identity', stage: FormatStage = 'restoreText'): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.startsWith('global/')
    || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return fail('invalidLocalIdentity', fieldPath, stage);
  }
  return value;
};
const text = (value: unknown, max = DRAMA_ASSET_TRANSFER_LIMITS.textBytes, local = false, fieldPath = 'text'): string => {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > max || value.includes('\0')) {
    return fail('invalidText', fieldPath, local ? 'restoreText' : 'format');
  }
  // 本机执行引用不能随项目元数据出境；共享 @drama 由调用方明确转换身份。
  if (/@(?:asset|wf|refmod|skill|model|image)?\{/.test(value) || /@drama\{global\//.test(value)) {
    throw new Error('资产包含尚未纳入共享的本机或全局引用，请先移除或物化为项目资产');
  }
  if (value.replace(DRAMA_MENTION, '').includes('@drama{')) throw new Error('资产包含损坏的引用，请先修复后共享');
  for (const match of value.matchAll(DRAMA_MENTION)) {
    const readId = local ? (value: unknown) => localId(value, fieldPath) : id;
    const mention = parseDramaMentionId(match[1]); readId(mention.assetId);
    for (const member of [mention.referenceImageId, mention.voiceClipId, mention.actionId, mention.actionMediaId]) {
      if (member !== undefined) readId(member);
    }
  }
  return value;
};
const list = (value: unknown, max: number): unknown[] => { if (!Array.isArray(value) || value.length > max) return fail(); return value; };
const pick = (value: unknown, fields: readonly string[]): Data => {
  const source = object(value);
  return Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
};
const unique = (values: readonly string[]) => { if (new Set(values).size !== values.length) fail(); };
export const sharedSyncMediaToken = (mediaId: string): string => `aicsync-media:${id(mediaId)}`;
function tokenId(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('aicsync-media:')) return fail();
  return id(value.slice('aicsync-media:'.length));
}
function strings(value: unknown): void {
  if (typeof value === 'string') text(value);
  else if (Array.isArray(value)) value.forEach(strings);
  else if (value && typeof value === 'object') Object.values(value).forEach(strings);
}

/** 路径仅作目录展示；绝不能直接作为下载目标路径。 */
function displayPath(value: unknown): string {
  const result = text(value, 1024);
  if (!result || /[\\<>:"|?*]/.test(result)
    || Array.from(result).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || result.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return fail();
  return result;
}

function cardMedia(asset: DramaAsset): Array<{ value: string; kind: SharedSyncMediaKind }> {
  const result: Array<{ value: string; kind: SharedSyncMediaKind }> = [];
  if (asset.imageUrl !== undefined) result.push({ value: asset.imageUrl, kind: 'image' });
  for (const reference of asset.referenceImages ?? []) {
    if (reference.imageUrl !== undefined) result.push({ value: reference.imageUrl, kind: 'image' });
  }
  if (asset.kind === 'character') {
    for (const voice of asset.voiceClips ?? []) if (voice.audioUrl !== undefined) result.push({ value: voice.audioUrl, kind: 'audio' });
    for (const action of asset.actions ?? []) for (const media of action.media ?? []) {
      if (media.url !== undefined) result.push({ value: media.url, kind: media.kind === 'video' ? 'video' : 'image' });
    }
  }
  return result;
}

export function getSharedAssetSyncMediaIds(payload: SharedSyncRevision['payload']): string[] {
  return [...new Set(payload.kind === 'file'
    ? [payload.mediaId, ...(payload.imageMetadata?.references ?? []).map((reference) => reference.mediaId)]
    : cardMedia(payload.data).map((entry) => tokenId(entry.value)))];
}

/** 武器是独立卡片依赖，不属于参考图、声音或动作成员。 */
export function getSharedAssetSyncDependencies(payload: SharedSyncRevision['payload']): string[] {
  const mentions = [...JSON.stringify(payload).matchAll(/@drama\{([^:}]+):/g)]
    .map((match) => parseDramaMentionId(match[1]).assetId);
  return [...new Set([...mentions, ...(payload.kind === 'character' && payload.data.kind === 'character' ? payload.data.weaponIds ?? [] : [])])];
}

function mapWeaponIds(value: readonly string[], mapId?: (value: string) => string, reverse = false): string[] {
  const readLocalId = (value: unknown) => localId(value, 'payload.data.weaponIds', reverse ? 'restoreText' : 'format');
  const ids = list(value, MAX_CHARACTER_WEAPONS).map(reverse ? id : readLocalId);
  unique(ids);
  if (!ids.length) return [];
  if (!mapId) throw new Error('角色武器尚未建立共享映射，请先纳入对应项目资产');
  const mapped = ids.map((value) => (reverse ? readLocalId : id)(mapId(value)));
  unique(mapped);
  return mapped;
}

function validateCard(payload: SharedSyncCardPayload, media: readonly SharedSyncMedia[]): void {
  if (payload.data.kind !== payload.kind) fail();
  keys(object(payload.data), [...BASE, ...(payload.kind === 'character' ? CHARACTER : [...VISUAL,
    ...(payload.kind === 'scene' ? ['placeType', 'timeOfDay', 'atmosphere', 'spatialNotes'] : ['ownerName', 'category', 'significance', 'propType'])])]);
  const asset = JSON.parse(JSON.stringify(payload.data)) as DramaAsset;
  const rewrite = (value: string | undefined) => value === undefined ? undefined : `aicasset-media:${tokenId(value)}`;
  asset.imageUrl = rewrite(asset.imageUrl);
  for (const reference of asset.referenceImages ?? []) reference.imageUrl = rewrite(reference.imageUrl);
  if (asset.kind === 'character') {
    for (const voice of asset.voiceClips ?? []) voice.audioUrl = rewrite(voice.audioUrl);
    for (const action of asset.actions ?? []) for (const item of action.media ?? []) item.url = rewrite(item.url);
  }
  // 复用领域白名单、枚举、主素材指针及闭包校验。其文本脱引用输出不用于共享数据。
  parseDramaAssetTransferDocument({ format: DRAMA_ASSET_TRANSFER_FORMAT, version: DRAMA_ASSET_TRANSFER_VERSION,
    exportedAt: 1, name: 'shared', assets: [asset], media: media.map((entry) => ({ id: entry.id, kind: entry.kind,
      path: `media/${entry.id}.${entry.extension}`, bytes: entry.bytes, sha256: entry.sha256 })) });
  strings(payload.data);
  id(payload.data.id);
  if (payload.data.kind === 'character' && payload.data.weaponIds !== undefined) {
    const weapons = list(payload.data.weaponIds, MAX_CHARACTER_WEAPONS).map(id);
    unique(weapons);
    if (weapons.includes(payload.data.id)) fail();
  }
  const memberIds: string[] = [];
  for (const reference of payload.data.referenceImages ?? []) memberIds.push(id(reference.id));
  if (payload.data.kind === 'character') {
    for (const voice of payload.data.voiceClips ?? []) memberIds.push(id(voice.id));
    for (const action of payload.data.actions ?? []) {
      memberIds.push(id(action.id));
      for (const item of action.media ?? []) memberIds.push(id(item.id));
    }
  }
  unique(memberIds);
}

function readPayload(value: unknown, media: readonly SharedSyncMedia[]): SharedSyncRevision['payload'] {
  const payload = object(value);
  if (payload.kind !== 'file') {
    if (!['character', 'scene', 'prop'].includes(String(payload.kind))) return fail();
    keys(payload, ['kind', 'data']);
    object(payload.data);
    validateCard(payload as unknown as SharedSyncCardPayload, media);
    return payload as unknown as SharedSyncCardPayload;
  }
  keys(payload, ['kind', 'name', 'displayRelativePath', 'mediaId', 'tags', 'taggedBy', 'imageMetadata']);
  const name = displayPath(payload.name);
  if (name.includes('/')) fail();
  displayPath(payload.displayRelativePath); id(payload.mediaId);
  const tags = list(payload.tags, 16).map((tag) => text(tag, 160));
  if (tags.some((tag) => !tag.trim() || tag.length > 40)) fail();
  unique(tags);
  if (payload.taggedBy !== undefined && !['manual', 'comfyui', 'vision'].includes(String(payload.taggedBy))) fail();
  const byId = new Map(media.map((entry) => [entry.id, entry]));
  if (!byId.has(payload.mediaId as string)) fail();
  if (payload.imageMetadata !== undefined) {
    if (byId.get(payload.mediaId as string)?.kind !== 'image') fail();
    const metadata = object(payload.imageMetadata); keys(metadata, ['prompt', 'references']);
    if (text(metadata.prompt).length > 30_000) fail();
    const ids = list(metadata.references, 16).map((entry) => {
      const reference = object(entry); keys(reference, ['id', 'name', 'mediaId']);
      text(reference.name, 1024); id(reference.mediaId);
      if (byId.get(reference.mediaId as string)?.kind !== 'image') fail();
      return id(reference.id);
    });
    unique(ids);
  }
  return payload as unknown as SharedSyncFilePayload;
}

function parseRevision(input: unknown, draft: boolean): SharedSyncRevision | SharedSyncDraft {
  let raw = input;
  if (typeof input === 'string') {
    if (encoder.encode(input).byteLength > DRAMA_ASSET_TRANSFER_LIMITS.manifestBytes) fail('manifestTooLarge');
    try { raw = JSON.parse(input); } catch { fail('invalidJson'); }
  }
  const value = object(raw);
  keys(value, ['format', 'version', 'libraryId', 'sharedProjectId', 'sharedAssetId', 'revisionId', 'parentRevisionId',
    'operationId', 'createdAt', 'payload', 'media']);
  if (value.format !== SHARED_ASSET_SYNC_FORMAT || value.version !== SHARED_ASSET_SYNC_VERSION) fail('unsupportedVersion', 'version');
  for (const field of ['libraryId', 'sharedProjectId', 'sharedAssetId', 'revisionId', 'operationId', 'parentRevisionId']) {
    if (field === 'parentRevisionId' && value[field] === undefined) continue;
    if (typeof value[field] !== 'string' || !ID.test(value[field] as string)) fail('invalidIdentity', field);
  }
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) fail('invalidTimestamp', 'createdAt');
  let totalBytes = 0;
  const media = list(value.media, DRAMA_ASSET_TRANSFER_LIMITS.media).map((entry, index): SharedSyncMedia => {
    const item = object(entry); keys(item, draft ? ['id', 'kind', 'extension'] : ['id', 'kind', 'extension', 'sha256', 'bytes']);
    if (typeof item.id !== 'string' || !ID.test(item.id)) fail('invalidIdentity', `media[${index}].id`);
    if (!['image', 'audio', 'video'].includes(String(item.kind)) || typeof item.extension !== 'string'
      || !MEDIA_EXTENSIONS[item.kind as SharedSyncMediaKind].includes(item.extension)) fail('invalidMediaType', `media[${index}].kind/extension`);
    if (!draft && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.bytes) || (item.bytes as number) <= 0)) fail('invalidMediaDigestOrSize', `media[${index}]`);
    totalBytes += draft ? 1 : item.bytes as number;
    return { ...item, ...(draft ? { sha256: '0'.repeat(64), bytes: 1 } : {}) } as unknown as SharedSyncMedia;
  });
  if (totalBytes > DRAMA_ASSET_TRANSFER_LIMITS.mediaBytes) fail('mediaTooLarge', 'media');
  unique(media.map((entry) => entry.id));
  const payload = readPayload(value.payload, media);
  if (payload.kind !== 'file' && payload.data.id !== value.sharedAssetId) fail('assetIdentityMismatch', 'payload.data.id');
  const used = getSharedAssetSyncMediaIds(payload);
  if (used.length !== media.length || used.some((mediaId) => !media.some((entry) => entry.id === mediaId))) fail('mediaReferenceMismatch', 'media');
  const result = { ...value, payload, media: draft ? media.map(({ id: mediaId, kind, extension }) => ({ id: mediaId, kind, extension })) : media };
  const json = JSON.stringify(result);
  if (encoder.encode(json).byteLength > DRAMA_ASSET_TRANSFER_LIMITS.manifestBytes) fail();
  return JSON.parse(json) as SharedSyncRevision | SharedSyncDraft;
}

export function parseSharedAssetSyncRevision(input: unknown): SharedSyncRevision {
  return parseRevision(input, false) as SharedSyncRevision;
}
export function parseSharedAssetSyncDraft(input: unknown): SharedSyncDraft {
  return parseRevision(input, true) as SharedSyncDraft;
}
export const buildSharedAssetSyncRevision = parseSharedAssetSyncRevision;
export const parseSharedAssetSyncSnapshot = parseSharedAssetSyncRevision;
export const buildSharedAssetSyncSnapshot = parseSharedAssetSyncRevision;

export interface SharedDramaAssetSerialization {
  memberId: (kind: SharedSyncMemberKind, localId: string, parentLocalId?: string) => string;
  mediaId: (source: { assetId?: string; relativePath?: string; filePath?: string; sourceNodeId?: string;
    url?: string; assetSource?: 'global'; kind: SharedSyncMediaKind; label: string }) => string | Promise<string>;
  mapMentionId?: (localMentionId: string) => string;
  mapWeaponId?: (localWeaponId: string) => string;
  /** 仅出站时把已确定归属项目资产的节点胶囊转换为本机 @drama，随后仍须映射共享身份。 */
  mapProjectNodeReferences?: (value: string) => string;
}

function mapText(value: unknown, mentionId?: (value: string) => string, mapProjectNodeReferences?: (value: string) => string,
  local = false, fieldPath = 'text'): unknown {
  if (typeof value === 'string') {
    const prepared = value.includes('@{') && mapProjectNodeReferences ? mapProjectNodeReferences(value) : value;
    const mapped = prepared.replace(DRAMA_MENTION, (_token, identity: string, label: string) => {
      if (identity.startsWith('global/')) throw new Error('全局资产引用须先物化为项目资产后共享');
      if (!mentionId) throw new Error('资产引用尚未建立共享映射，请先纳入对应项目资产');
      const mappedId = mentionId(identity);
      if (local && (typeof mappedId !== 'string' || /[{}:\r\n]/.test(mappedId))) return fail('invalidLocalMention', fieldPath, 'restoreText');
      return `@drama{${mappedId}:${label}}`;
    });
    return text(mapped, DRAMA_ASSET_TRANSFER_LIMITS.textBytes, local, fieldPath);
  }
  if (Array.isArray(value)) return value.map((entry, index) => mapText(entry, mentionId, mapProjectNodeReferences, local, `${fieldPath}[${index}]`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, mapText(entry, mentionId, mapProjectNodeReferences, local, `${fieldPath}.${key}`)]));
  return value;
}

export function mapSharedAssetSyncText(value: string, mapMentionId?: (value: string) => string, mapProjectNodeReferences?: (value: string) => string): string {
  return mapText(value, mapMentionId, mapProjectNodeReferences) as string;
}

/** 先验证共享身份，再恢复本机项目引用；本机 ID 不沿用 wire 的 ASCII 限制。 */
export function restoreSharedAssetSyncText(value: string, mapMentionId?: (value: string) => string): string {
  text(value);
  return mapText(value, mapMentionId, undefined, true) as string;
}

/** 只换显式映射身份；同名、同图不产生任何合并。媒体回调必须先物化到当前项目。 */
export async function serializeSharedDramaAsset(
  input: DramaAsset, sharedAssetId: string, mapping: SharedDramaAssetSerialization,
): Promise<SharedSyncCardPayload> {
  const source = input.kind === 'character' ? input : normalizeDramaVisualAsset(input);
  if (source.imageAssetId) throw new Error('资产包含全局主图，请先物化为项目资产后共享');
  const fields = source.kind === 'character' ? CHARACTER : [...VISUAL,
    ...(source.kind === 'scene' ? ['placeType', 'timeOfDay', 'atmosphere', 'spatialNotes'] : ['ownerName', 'category', 'significance', 'propType'])];
  const result = pick(source, [...BASE, ...fields]); result.id = id(sharedAssetId);
  const media = async (reference: { assetId?: string; relativePath?: string; filePath?: string; sourceNodeId?: string;
    imageUrl?: string; audioUrl?: string; url?: string; assetSource?: 'global' }, kind: SharedSyncMediaKind, label: string) => {
    if (reference.assetSource === 'global') throw new Error('全局参考图须先物化为项目资产后共享');
    return sharedSyncMediaToken(await mapping.mediaId({ assetId: reference.assetId, relativePath: reference.relativePath,
      filePath: reference.filePath, sourceNodeId: reference.sourceNodeId, assetSource: reference.assetSource,
      url: reference.imageUrl ?? reference.audioUrl ?? reference.url, kind, label }));
  };
  if (source.referenceImages !== undefined) result.referenceImages = await Promise.all(source.referenceImages.map(async (reference) => ({
    ...pick(reference, source.kind === 'character' ? REFERENCE : VISUAL_REFERENCE),
    id: id(mapping.memberId('referenceImage', reference.id)), imageUrl: await media(reference, 'image', `${source.name} · 参考图`),
  })));
  if (source.imageUrl || source.assetId || source.relativePath || source.imageNodeId) {
    result.imageUrl = await media({ assetId: source.assetId, relativePath: source.relativePath,
      imageUrl: source.imageUrl, sourceNodeId: source.imageNodeId }, 'image', `${source.name} · 主图`);
  }
  if (source.primaryReferenceImageId) result.primaryReferenceImageId = id(mapping.memberId('referenceImage', source.primaryReferenceImageId));
  if (source.kind === 'character') {
    if (source.weaponIds !== undefined) result.weaponIds = mapWeaponIds(source.weaponIds, mapping.mapWeaponId);
    if (source.relationships) result.relationships = source.relationships.map((relation) => pick(relation, ['targetName', 'relation']));
    if (source.avatarCrop) result.avatarCrop = pick(source.avatarCrop, ['x', 'y', 'width', 'height']);
    result.voiceClips = await Promise.all((source.voiceClips ?? []).map(async (voice) => ({ ...pick(voice, VOICE),
      id: id(mapping.memberId('voiceClip', voice.id)), audioUrl: await media(voice, 'audio', `${source.name} · 声音`) })));
    result.actions = await Promise.all((source.actions ?? []).map(async (action) => ({ ...pick(action, ACTION),
      id: id(mapping.memberId('action', action.id)), media: await Promise.all((action.media ?? []).map(async (item) => ({
        ...pick(item, ACTION_MEDIA), id: id(mapping.memberId('actionMedia', item.id, action.id)),
        url: await media(item, item.kind === 'video' ? 'video' : 'image', `${source.name} · ${action.name} · ${item.name}`),
      }))) })));
    if (source.avatarReferenceImageId) result.avatarReferenceImageId = id(mapping.memberId('referenceImage', source.avatarReferenceImageId));
    if (source.primaryVoiceClipId) result.primaryVoiceClipId = id(mapping.memberId('voiceClip', source.primaryVoiceClipId));
  }
  return { kind: source.kind, data: mapText(result, mapping.mapMentionId, mapping.mapProjectNodeReferences) as DramaAsset };
}

export interface SharedDramaAssetRestoration {
  memberId: (kind: SharedSyncMemberKind, sharedId: string, parentSharedId?: string) => string;
  mediaById: ReadonlyMap<string, { assetId: string; relativePath: string; url: string }>;
  mapMentionId?: (sharedMentionId: string) => string;
  mapWeaponId?: (sharedWeaponId: string) => string;
}

/** 远端新媒体不保留源节点指针，避免当前画布旧输出遮蔽已下载内容。 */
export function restoreSharedDramaAsset(payload: SharedSyncCardPayload, localEntityId: string, mapping: SharedDramaAssetRestoration): DramaAsset {
  const media = new Map<string, SharedSyncMedia>();
  for (const entry of cardMedia(payload.data)) {
    const mediaId = tokenId(entry.value);
    if (media.has(mediaId) && media.get(mediaId)!.kind !== entry.kind) fail();
    media.set(mediaId, { id: mediaId, kind: entry.kind, extension: 'bin', sha256: '0'.repeat(64), bytes: 1 });
  }
  validateCard(payload, [...media.values()]);
  const asset = mapText(JSON.parse(JSON.stringify(payload.data)), mapping.mapMentionId, undefined, true, 'payload.data') as DramaAsset;
  asset.id = localId(localEntityId, 'payload.data.id');
  const bind = (token: string | undefined, field: 'imageUrl' | 'audioUrl' | 'url', fieldPath: string) => {
    if (token === undefined) return {};
    const local = mapping.mediaById.get(tokenId(token));
    if (!local?.assetId || !local.relativePath) return fail('missingLocalMedia', fieldPath, 'restoreMedia');
    if (!localMediaUrlToPath(local.url)) return fail('invalidLocalMediaUrl', fieldPath, 'restoreMedia');
    return { assetId: local.assetId, relativePath: local.relativePath, [field]: local.url };
  };
  Object.assign(asset, bind(asset.imageUrl, 'imageUrl', 'payload.data.imageUrl'));
  const referenceIds = new Map<string, string>();
  const references = asset.referenceImages?.map((reference, index) => {
    const nextId = localId(mapping.memberId('referenceImage', reference.id), `payload.data.referenceImages[${index}].id`);
    referenceIds.set(reference.id, nextId);
    return { ...reference, ...bind(reference.imageUrl, 'imageUrl', `payload.data.referenceImages[${index}].imageUrl`), id: nextId };
  });
  asset.referenceImages = references as DramaAsset['referenceImages'];
  asset.primaryReferenceImageId = asset.primaryReferenceImageId ? referenceIds.get(asset.primaryReferenceImageId) : undefined;
  if (asset.kind === 'character') {
    if (asset.weaponIds !== undefined) asset.weaponIds = mapWeaponIds(asset.weaponIds, mapping.mapWeaponId, true);
    asset.avatarReferenceImageId = asset.avatarReferenceImageId ? referenceIds.get(asset.avatarReferenceImageId) : undefined;
    const voices = new Map<string, string>();
    asset.voiceClips = asset.voiceClips?.map((voice, index) => {
      const nextId = localId(mapping.memberId('voiceClip', voice.id), `payload.data.voiceClips[${index}].id`);
      voices.set(voice.id, nextId);
      return { ...voice, ...bind(voice.audioUrl, 'audioUrl', `payload.data.voiceClips[${index}].audioUrl`), id: nextId };
    });
    asset.primaryVoiceClipId = asset.primaryVoiceClipId ? voices.get(asset.primaryVoiceClipId) : undefined;
    asset.actions = asset.actions?.map((action, actionIndex) => ({ ...action,
      id: localId(mapping.memberId('action', action.id), `payload.data.actions[${actionIndex}].id`),
      media: action.media?.map((item, mediaIndex) => ({ ...item, ...bind(item.url, 'url', `payload.data.actions[${actionIndex}].media[${mediaIndex}].url`),
        id: localId(mapping.memberId('actionMedia', item.id, action.id), `payload.data.actions[${actionIndex}].media[${mediaIndex}].id`) })) }));
    const primary = asset.referenceImages?.find((reference) => reference.id === asset.primaryReferenceImageId) ?? asset.referenceImages?.[0];
    if (primary) Object.assign(asset, { imageUrl: primary.imageUrl, assetId: primary.assetId, relativePath: primary.relativePath });
    return asset as DramaCharacter;
  }
  return asset;
}
