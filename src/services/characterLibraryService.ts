/**
 * characterLibraryService - project-independent character card persistence.
 * Global cards never retain project node links; media files are persisted separately.
 */
import {
  clearGlobalCharacters,
  deleteGlobalCharacter,
  getAssetIndexById,
  getAllGlobalCharacters,
  putGlobalCharacter,
} from './indexedDbService';
import type {
  CharacterAction,
  CharacterActionMedia,
  CharacterReferenceImage,
  CharacterVoiceClip,
  DramaCharacter,
} from '../types/dramaAssets';
import { normalizeDramaCharacter } from '../types/dramaAssets';
import {
  getAssetUrlFromPath,
  getGlobalFilesDir,
  identifyAsset,
  isTauriEnv,
  resolveIndexedAssetPath,
  sanitizeFileName,
  saveAssetToPermanent,
  type AssetFileEntry,
} from './fileService';

function detachProjectReference(reference: CharacterReferenceImage): CharacterReferenceImage {
  const persisted = { ...reference };
  delete persisted.sourceNodeId;
  // 全局角色的文件在全局资产目录，不保留项目本地路径
  delete persisted.filePath;
  return persisted;
}

function detachProjectVoiceClip(clip: CharacterVoiceClip): CharacterVoiceClip {
  const persisted = { ...clip };
  delete persisted.sourceNodeId;
  // 全局角色的文件在全局资产目录，不保留项目本地路径
  delete persisted.filePath;
  return persisted;
}

function detachProjectActionMedia(media: CharacterActionMedia): CharacterActionMedia {
  const persisted = { ...media };
  delete persisted.filePath;
  return persisted;
}

function detachProjectAction(action: CharacterAction): CharacterAction {
  return {
    ...action,
    media: (action.media ?? []).map(detachProjectActionMedia),
  };
}

export function prepareGlobalCharacter(character: DramaCharacter): DramaCharacter {
  const normalized = normalizeDramaCharacter(character);
  const detached = { ...normalized };
  delete detached.imageNodeId;
  return {
    ...detached,
    referenceImages: (normalized.referenceImages ?? []).map(detachProjectReference),
    voiceClips: (normalized.voiceClips ?? []).map(detachProjectVoiceClip),
    actions: (normalized.actions ?? []).map(detachProjectAction),
  };
}

/** data URL 的 mime 子类型与浏览器音频容器扩展名不一致，落盘时按此表还原 */
const AUDIO_MIME_EXTENSIONS: Record<string, string> = {
  mpeg: 'mp3',
  mp4: 'm4a',
  'x-m4a': 'm4a',
  'x-wav': 'wav',
  wave: 'wav',
};

function urlExtensionHints(url?: string): { mimeSubtype?: string; pathExtension?: string } {
  return {
    mimeSubtype: url?.match(/^data:[a-z]+\/([a-zA-Z0-9.+-]+);/i)?.[1]?.toLowerCase(),
    pathExtension: url
      ?.split(/[?#]/, 1)[0]
      ?.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]
      ?.toLowerCase(),
  };
}

function extensionForReference(reference: CharacterReferenceImage): string {
  const { mimeSubtype, pathExtension } = urlExtensionHints(reference.imageUrl);
  if (mimeSubtype) return mimeSubtype === 'jpeg' ? 'jpg' : mimeSubtype;
  return pathExtension || 'png';
}

function extensionForVoiceClip(clip: CharacterVoiceClip): string {
  const { mimeSubtype, pathExtension } = urlExtensionHints(clip.audioUrl);
  if (mimeSubtype) return AUDIO_MIME_EXTENSIONS[mimeSubtype] ?? mimeSubtype;
  return pathExtension || 'mp3';
}

function extensionForActionMedia(media: CharacterActionMedia): string {
  const { mimeSubtype, pathExtension } = urlExtensionHints(media.url);
  const nameExtension = media.name.split('.').pop()?.toLowerCase();
  if (nameExtension && nameExtension !== media.name.toLowerCase()) return nameExtension;
  if (mimeSubtype) {
    if (mimeSubtype === 'quicktime') return 'mov';
    if (mimeSubtype === 'x-m4v') return 'm4v';
    return mimeSubtype;
  }
  return pathExtension || (media.kind === 'video' ? 'mp4' : media.kind === 'gif' ? 'gif' : 'png');
}

interface GlobalMediaInput {
  id: string;
  /** 落盘文件名中的用途片段 */
  kind: string;
  assetId?: string;
  /** 项目内共用的本地文件；有它就直接复制该文件，不必回查资产索引 */
  filePath?: string;
  url?: string;
  extension: string;
  category: 'image' | 'video' | 'audio';
}

interface GlobalMediaResult {
  assetId?: string;
  relativePath?: string;
  url?: string;
}

/** 把项目内或内存中的媒体固化到全局资产目录；保存失败返回 null 由调用方决定错误文案。 */
async function persistGlobalMedia(
  characterName: string,
  media: GlobalMediaInput,
): Promise<GlobalMediaResult | null> {
  const existing = media.assetId
    ? await getAssetIndexById(media.assetId)
    : undefined;
  if (existing?.source === 'global') {
    return {
      assetId: media.assetId,
      relativePath: existing.relativePath,
      url: await getAssetUrlFromPath(existing.path),
    };
  }

  const sourcePath = media.filePath
    ?? (media.assetId ? await resolveIndexedAssetPath(media.assetId) : null);
  const fileName = sanitizeFileName(
    `${characterName}-${media.kind}-${media.id}.${media.extension}`,
  );
  const entry: AssetFileEntry = {
    assetId: media.assetId,
    name: sourcePath?.split(/[\\/]/).pop() || fileName,
    path: sourcePath || `virtual://character-${media.category}/${media.id}`,
    assetUrl: media.url,
    size: 0,
    category: media.category,
    availability: 'online',
    source: sourcePath ? 'project' : undefined,
  };
  const savedPath = await saveAssetToPermanent(entry);
  if (!savedPath) return null;

  const globalDir = await getGlobalFilesDir();
  if (!globalDir) throw new Error('全局资产目录不可用');
  const identity = await identifyAsset(savedPath, {
    rootPath: globalDir,
    source: 'global',
  });
  return {
    assetId: identity.assetId,
    relativePath: identity.relativePath,
    url: await getAssetUrlFromPath(savedPath),
  };
}

async function persistGlobalReference(
  characterName: string,
  reference: CharacterReferenceImage,
): Promise<CharacterReferenceImage> {
  const detached = detachProjectReference(reference);
  if (!isTauriEnv()) return detached;

  const persisted = await persistGlobalMedia(characterName, {
    id: reference.id,
    kind: reference.kind,
    assetId: reference.assetId,
    filePath: reference.filePath,
    url: reference.imageUrl,
    extension: extensionForReference(reference),
    category: 'image',
  });
  if (!persisted) throw new Error(`角色参考图 ${reference.id} 保存失败`);
  return {
    ...detached,
    assetId: persisted.assetId ?? detached.assetId,
    relativePath: persisted.relativePath,
    imageUrl: persisted.url,
  };
}

async function persistGlobalVoiceClip(
  characterName: string,
  clip: CharacterVoiceClip,
): Promise<CharacterVoiceClip> {
  const detached = detachProjectVoiceClip(clip);
  if (!isTauriEnv()) return detached;

  const persisted = await persistGlobalMedia(characterName, {
    id: clip.id,
    kind: clip.kind,
    assetId: clip.assetId,
    filePath: clip.filePath,
    url: clip.audioUrl,
    extension: extensionForVoiceClip(clip),
    category: 'audio',
  });
  if (!persisted) throw new Error(`角色声音 ${clip.id} 保存失败`);
  return {
    ...detached,
    assetId: persisted.assetId ?? detached.assetId,
    relativePath: persisted.relativePath,
    audioUrl: persisted.url,
  };
}

async function persistGlobalActionMedia(
  characterName: string,
  action: CharacterAction,
  media: CharacterActionMedia,
): Promise<CharacterActionMedia> {
  const detached = detachProjectActionMedia(media);
  if (!isTauriEnv()) return detached;

  const persisted = await persistGlobalMedia(characterName, {
    id: media.id,
    kind: `${action.category}-${media.kind}`,
    assetId: media.assetId,
    filePath: media.filePath,
    url: media.url,
    extension: extensionForActionMedia(media),
    category: media.kind === 'video' ? 'video' : 'image',
  });
  if (!persisted) throw new Error(`角色动作素材 ${media.id} 保存失败`);
  return {
    ...detached,
    assetId: persisted.assetId ?? detached.assetId,
    relativePath: persisted.relativePath,
    url: persisted.url,
  };
}

async function persistGlobalAction(
  characterName: string,
  action: CharacterAction,
): Promise<CharacterAction> {
  const media: CharacterActionMedia[] = [];
  for (const item of action.media ?? []) {
    media.push(await persistGlobalActionMedia(characterName, action, item));
  }
  return { ...action, media };
}

async function persistGlobalMediaOfCharacter(character: DramaCharacter): Promise<DramaCharacter> {
  const references: CharacterReferenceImage[] = [];
  for (const reference of character.referenceImages ?? []) {
    references.push(await persistGlobalReference(character.name, reference));
  }
  const voiceClips: CharacterVoiceClip[] = [];
  for (const clip of character.voiceClips ?? []) {
    voiceClips.push(await persistGlobalVoiceClip(character.name, clip));
  }
  const actions: CharacterAction[] = [];
  for (const action of character.actions ?? []) {
    actions.push(await persistGlobalAction(character.name, action));
  }
  return { ...character, referenceImages: references, voiceClips, actions };
}

export async function loadGlobalCharacterCards(): Promise<DramaCharacter[]> {
  const characters = await getAllGlobalCharacters();
  return characters
    .map((character) => prepareGlobalCharacter(character))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
}

export async function saveGlobalCharacterCard(character: DramaCharacter): Promise<DramaCharacter> {
  // 先落盘再剥离项目字段：复制到全局目录时还要用项目内共用的 filePath 作为来源
  const persisted = prepareGlobalCharacter(
    await persistGlobalMediaOfCharacter(normalizeDramaCharacter(character)),
  );
  await putGlobalCharacter(persisted);
  return persisted;
}

export async function deleteGlobalCharacterCard(id: string): Promise<void> {
  await deleteGlobalCharacter(id);
}

export async function clearGlobalCharacterCards(): Promise<void> {
  await clearGlobalCharacters();
}
