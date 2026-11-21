import type { CharacterLibraryScope, CharacterActionNodeCapture, WsagentCreativeAssetFields } from '../store.dramaAssets';
import { t } from '../../i18n';
import type { StateCreator } from 'zustand';
import type { Node } from '@xyflow/react';
import type { AppState } from '../useAppStore';
import type {
  CharacterActionMedia,
  CharacterReferenceImage,
  CharacterVoiceClip,
  DramaAsset,
  DramaAssetKind,
  DramaAssetLibrary,
  DramaAssetReferenceImage,
  DramaCharacter,
  DramaProp,
} from '../../types/dramaAssets';
import {
  normalizeDramaCharacter,
  normalizeDramaVisualAsset,
  syncDramaVisualAssetPrimary,
  MAX_CHARACTER_REFERENCE_IMAGES,
  MAX_DRAMA_REFERENCE_IMAGES,
  MAX_CHARACTER_WEAPONS,
  normalizeCharacterWeaponIds,
} from '../../types/dramaAssets';
import { normalizeAssetKey } from '../../services/dramaAssetExtract';
import { generateId } from '../store.utils';
import type { BaseNodeData } from '../../types';
import {
  registerCanvasDerivation,
  isCanvasDerivationFresh,
  completeCanvasDerivation,
} from '../../services/canvasDerivationGuard';
import { assertSafeProjectRelativePath } from '../../services/fs/projectFiles';

export function findScopedCharacter(
  state: Pick<AppState, 'dramaAssets' | 'globalCharacters'>,
  scope: CharacterLibraryScope,
  characterId: string,
): DramaCharacter | undefined {
  return (scope === 'project' ? state.dramaAssets.characters : state.globalCharacters)
    .find((character) => character.id === characterId);
}

const CHARACTER_REFERENCE_NODE_TYPES = new Set([
  'ai-image',
  'source-image',
  'ai-panorama',
  'ai-storyboard',
  'ai-animation',
]);

const CHARACTER_VOICE_NODE_TYPES = new Set(['ai-audio', 'source-audio']);

export function isEligibleCharacterReferenceNode(
  node: Pick<Node<BaseNodeData>, 'type' | 'data'> | undefined,
): boolean {
  if (!node?.type || !CHARACTER_REFERENCE_NODE_TYPES.has(node.type)) return false;
  return Boolean(node.data.imageUrl || node.data.thumbnailUrl);
}

/** 可绑定为角色声音的画布节点：生成音频与上传音频，且已有音频产物 */
export function isEligibleCharacterVoiceNode(
  node: Pick<Node<BaseNodeData>, 'type' | 'data'> | undefined,
): boolean {
  if (!node?.type || !CHARACTER_VOICE_NODE_TYPES.has(node.type)) return false;
  return Boolean(node.data.audioUrl);
}

export function countUnreadDramaAssets(library: DramaAssetLibrary): number {
  if (library.lastViewedAt === undefined) return 0;
  const { lastViewedAt } = library;
  return [...library.characters, ...library.scenes, ...library.props]
    .filter((asset) => asset.createdAt > lastViewedAt).length;
}

export function patchList<T extends { id: string; updatedAt: number }>(
  list: T[],
  id: string,
  patch: Partial<T>,
): T[] {
  return list.map((item) =>
    item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
  );
}

export function mapKindList(
  lib: DramaAssetLibrary,
  kind: DramaAssetKind,
  mapper: (list: DramaAsset[]) => DramaAsset[],
): DramaAssetLibrary {
  if (kind === 'character') {
    return { ...lib, characters: mapper(lib.characters) as DramaAssetLibrary['characters'] };
  }
  if (kind === 'scene') {
    return { ...lib, scenes: mapper(lib.scenes) as DramaAssetLibrary['scenes'] };
  }
  return { ...lib, props: mapper(lib.props) as DramaAssetLibrary['props'] };
}

export function silentSave(get: () => AppState) {
  void get().saveCurrentProjectSilent?.();
}

export function checkedCharacterWeapons(character: DramaCharacter, props: readonly DramaProp[], previous?: DramaCharacter): string[] | undefined {
  const raw = character.weaponIds ?? previous?.weaponIds;
  if (raw === undefined) return;
  const ids = normalizeCharacterWeaponIds(raw);
  if (!Array.isArray(raw) || raw.length > MAX_CHARACTER_WEAPONS
    || raw.some((id) => typeof id !== 'string' || !ids.includes(id))
    || ids.some((id) => !props.some((prop) => prop.id === id && prop.propType === 'weapon'))) {
    throw new Error(t('武器绑定无效，请重新选择'));
  }
  return ids;
}

export function removesBoundWeapon(previous: DramaAsset | undefined, next: DramaAsset, characters: readonly DramaCharacter[]): boolean {
  return previous?.kind === 'prop' && previous.propType === 'weapon'
    && next.kind === 'prop' && next.propType !== 'weapon'
    && characters.some((character) => character.weaponIds?.includes(previous.id));
}

export function withoutCharacterWeapons(characters: DramaCharacter[], ids: ReadonlySet<string>): DramaCharacter[] {
  return characters.map((character) => character.weaponIds?.some((id) => ids.has(id))
    ? { ...character, weaponIds: character.weaponIds.filter((id) => !ids.has(id)), updatedAt: Date.now() }
    : character);
}

/** 读取期间发生的增删改优先于旧快照，避免并发加载覆盖已经保存的编辑。 */
export function mergeLoadedGlobalAssets<T extends { id: string }>(before: T[], current: T[], loaded: T[]): T[] {
  const original = new Map(before.map((asset) => [asset.id, asset]));
  const latest = new Map(current.map((asset) => [asset.id, asset]));
  const merged = loaded.filter((asset) => !original.has(asset.id) || latest.has(asset.id))
    .map((asset) => {
      const edited = latest.get(asset.id);
      return edited && edited !== original.get(asset.id) ? edited : asset;
    });
  const loadedIds = new Set(merged.map((asset) => asset.id));
  return [...merged, ...current.filter((asset) => !loadedIds.has(asset.id) && asset !== original.get(asset.id))];
}

/** 排序只改 libraryOrder，不能让在途正文保存覆盖另一份角色编辑。 */
export function sameCharacterContent(left: DramaCharacter | undefined, right: DramaCharacter | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const previous = left as unknown as Record<string, unknown>;
  const current = right as unknown as Record<string, unknown>;
  return Object.keys({ ...previous, ...current })
    .every((key) => key === 'libraryOrder' || previous[key] === current[key]);
}

export async function saveCharacterActionWithNode(
  set: Parameters<StateCreator<AppState>>[0],
  get: () => AppState,
  scope: CharacterLibraryScope,
  character: DramaCharacter,
  actionId: string,
  media: CharacterActionMedia[],
  capture?: CharacterActionNodeCapture,
): Promise<boolean> {
  if (!capture) return get().saveCharacterCard(scope, character);
  if (media.length !== 1) return false;
  const guard = registerCanvasDerivation(get(), capture.nodeId);
  if (!guard) return false;
  const previousCharacter = get().dramaAssets.characters.find((item) => item.id === character.id);
  try {
    if (scope === 'project') {
      if (!previousCharacter) return false;
      set((state) => ({
        dramaAssets: {
          ...state.dramaAssets,
          characters: state.dramaAssets.characters.map((item) => item.id === character.id ? character : item),
        },
      }));
      const savedProjectId = await get().saveCurrentProjectSilent();
      if (savedProjectId !== guard.projectId) throw new Error('动作素材保存失败');
    } else if (!await get().saveCharacterCard(scope, character)) {
      return false;
    }
    if (isCanvasDerivationFresh(guard, get())) {
      const linked = get().linkNodeToCharacter(capture.nodeId, {
        scope,
        characterId: character.id,
        actionId,
        mediaId: media[0].id,
      }, capture.hideNode);
      if (linked) silentSave(get);
    }
    return true;
  } catch {
    // 保存失败仅回退本次角色对象，不覆盖期间的其他角色编辑或已切换项目。
    if (scope === 'project' && get().currentProjectId === guard.projectId && previousCharacter) {
      set((state) => ({
        dramaAssets: {
          ...state.dramaAssets,
          characters: state.dramaAssets.characters.map((item) => item === character ? previousCharacter : item),
        },
      }));
    }
    get().showToast?.('动作素材保存失败，画布节点保持不变', 'error');
    return false;
  } finally {
    completeCanvasDerivation(guard);
  }
}

export function syncCharacterPrimaryImage(character: DramaCharacter): DramaCharacter {
  const primary = character.referenceImages?.find((reference) => reference.id === character.primaryReferenceImageId)
    ?? character.referenceImages?.[0];
  const synced = {
    ...character,
    assetId: primary?.assetId,
    relativePath: primary?.relativePath,
    filePath: primary?.filePath,
    imageNodeId: primary?.sourceNodeId,
    imageUrl: primary?.imageUrl,
    imageAssetId: undefined,
    imageRelativePath: undefined,
  };
  return synced;
}

const WSAGENT_REFERENCE_PREFIX = 'wsagent-image-';
const WSAGENT_VISUAL_HEADING = '### 视觉说明';

function wsagentAssetText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

/** 只投影互通文本与主参考图来源，实际文件读取仍由配对服务验证。 */
export function readWsagentCreativeAsset(asset: DramaAsset, nodes: readonly Node<BaseNodeData>[]) {
  const summary = wsagentAssetText(asset.summary);
  const visualNotes = wsagentAssetText(asset.visualNotes);
  const description = [summary, visualNotes && `${WSAGENT_VISUAL_HEADING}\n\n${visualNotes}`].filter(Boolean).join('\n\n');
  const reference = asset.referenceImages?.find((image) => image.id === asset.primaryReferenceImageId)
    ?? asset.referenceImages?.[0];
  const isGlobal = !!asset.imageAssetId || (reference && 'assetSource' in reference && reference.assetSource === 'global');
  const sourceNodeId = isGlobal ? undefined : reference?.sourceNodeId ?? asset.imageNodeId;
  const node = nodes.find((item) => item.id === sourceNodeId);
  const linked = isEligibleCharacterReferenceNode(node) ? node?.data : undefined;
  // 节点有新产物时，不混用库卡旧文件的路径。
  const imageUrl = linked ? linked.imageUrl ?? linked.thumbnailUrl : reference?.imageUrl ?? asset.imageUrl;
  const filePath = linked ? linked.filePath : reference?.filePath ?? (asset as DramaAsset & { filePath?: string }).filePath;
  const assetId = linked ? linked.assetId : reference?.assetId ?? asset.imageAssetId ?? asset.assetId;
  const relativePath = linked ? linked.relativePath : reference?.relativePath ?? asset.imageRelativePath ?? asset.relativePath;
  const image = imageUrl || filePath || assetId || relativePath ? {
    referenceId: reference?.id ?? null,
    assetSource: isGlobal ? 'global' as const : undefined,
    sourceNodeId, assetId, relativePath, filePath, imageUrl,
  } : undefined;
  return { name: wsagentAssetText(asset.name), description, image };
}

/** 同一张远端原图维持稳定引用 ID，设置新主图时保留旧引用。 */
function wsagentPrimaryReference<T extends CharacterReferenceImage | DramaAssetReferenceImage>(
  references: T[], currentId: string | undefined, image: NonNullable<WsagentCreativeAssetFields['image']> | null,
  maxReferences: number, create: (id: string) => T,
) {
  if (!image) {
    if (!currentId?.startsWith(WSAGENT_REFERENCE_PREFIX)) return null;
    const remaining = references.filter((item) => item.id !== currentId);
    return { referenceImages: remaining, primaryReferenceImageId: remaining[0]?.id };
  }
  const referenceId = `${WSAGENT_REFERENCE_PREFIX}${encodeURIComponent(image.sourceId)}`;
  const existing = references.find((item) => item.id === referenceId
    || (item.relativePath === image.relativePath && !('assetSource' in item && item.assetSource === 'global')));
  if (existing) return existing.id === currentId ? null : { referenceImages: references, primaryReferenceImageId: existing.id };
  if (references.length >= maxReferences) throw new Error('参考图已达上限，请留出一项后再同步');
  return { referenceImages: [...references, create(referenceId)], primaryReferenceImageId: referenceId };
}

export function projectWsagentAsset(
  asset: DramaAsset, input: WsagentCreativeAssetFields, updatedAt: number,
): DramaAsset {
  const name = wsagentAssetText(input.name);
  const description = wsagentAssetText(input.description);
  const heading = /^### 视觉说明[ \t]*$/m.exec(description);
  const summary = heading ? description.slice(0, heading.index).trim() : description;
  const visualNotes = heading ? description.slice(heading.index + heading[0].length).trim() : '';
  if (!name || name.includes('\n')) throw new Error('共享创作资产名称无效');
  const textFields = { name, key: name !== asset.name ? normalizeAssetKey(name) : asset.key, summary, visualNotes, updatedAt };
  const textChanged = name !== asset.name || summary !== asset.summary || visualNotes !== asset.visualNotes;
  const image = input.image;
  if (image === undefined) return textChanged ? { ...asset, ...textFields } : asset;
  if (image) {
    if (!image.sourceId || image.sourceId.length > 180 || !image.filePath || !image.imageUrl) throw new Error('共享参考图无效');
    assertSafeProjectRelativePath(image.relativePath);
  }
  const mediaFields = { relativePath: image?.relativePath, filePath: image?.filePath, imageUrl: image?.imageUrl,
    prompt: '', createdAt: updatedAt, updatedAt };
  if (asset.kind === 'character') {
    const current = normalizeDramaCharacter(asset);
    const change = wsagentPrimaryReference(current.referenceImages ?? [], current.primaryReferenceImageId,
      image, MAX_CHARACTER_REFERENCE_IMAGES, (id) => ({ ...mediaFields, id, kind: 'primary' }));
    return change ? syncCharacterPrimaryImage(normalizeDramaCharacter({ ...current, ...textFields,
      ...change, imageNodeId: undefined, imageUrl: undefined })) : textChanged ? { ...asset, ...textFields } : asset;
  }
  const current = normalizeDramaVisualAsset(asset);
  const change = wsagentPrimaryReference(current.referenceImages ?? [], current.primaryReferenceImageId,
    image, MAX_DRAMA_REFERENCE_IMAGES, (id) => ({ ...mediaFields, id, label: image?.fileName ?? '' }));
  return change ? syncDramaVisualAssetPrimary({ ...current, ...textFields, ...change })
    : textChanged ? { ...asset, ...textFields } : asset;
}

export function sameImageIdentity(
  first: { assetId?: string; relativePath?: string; filePath?: string },
  second: { assetId?: string; relativePath?: string; filePath?: string },
): boolean {
  return first.assetId === second.assetId && first.relativePath === second.relativePath && first.filePath === second.filePath;
}

export function upsertCharacterReference(
  character: DramaCharacter,
  reference: CharacterReferenceImage,
  makePrimary: boolean,
): DramaCharacter {
  const references = [...(character.referenceImages ?? [])];
  const existingIndex = references.findIndex((item) =>
    item.id === reference.id
    || Boolean(reference.sourceNodeId && item.sourceNodeId === reference.sourceNodeId),
  );
  const persistedReference = existingIndex >= 0
    ? { ...references[existingIndex], ...reference, id: references[existingIndex].id }
    : reference;
  if (existingIndex >= 0) references[existingIndex] = persistedReference;
  else references.push(persistedReference);
  return syncCharacterPrimaryImage(normalizeDramaCharacter({
    ...character,
    referenceImages: references,
    primaryReferenceImageId: makePrimary || !character.primaryReferenceImageId
      ? persistedReference.id
      : character.primaryReferenceImageId,
    updatedAt: Date.now(),
  }));
}

export function upsertCharacterVoiceClip(
  character: DramaCharacter,
  clip: CharacterVoiceClip,
  makePrimary: boolean,
): DramaCharacter {
  const clips = [...(character.voiceClips ?? [])];
  const existingIndex = clips.findIndex((item) =>
    item.id === clip.id
    || Boolean(clip.sourceNodeId && item.sourceNodeId === clip.sourceNodeId),
  );
  const persistedClip = existingIndex >= 0
    ? { ...clips[existingIndex], ...clip, id: clips[existingIndex].id }
    : clip;
  if (existingIndex >= 0) clips[existingIndex] = persistedClip;
  else clips.push(persistedClip);
  return normalizeDramaCharacter({
    ...character,
    voiceClips: clips,
    primaryVoiceClipId: makePrimary || !character.primaryVoiceClipId
      ? persistedClip.id
      : character.primaryVoiceClipId,
    updatedAt: Date.now(),
  });
}

export function cloneCharacter(character: DramaCharacter): DramaCharacter {
  const now = Date.now();
  return normalizeDramaCharacter({
    ...character,
    id: `character-${generateId()}`,
    libraryOrder: undefined,
    createdAt: now,
    updatedAt: now,
    source: 'manual',
    referenceImages: (character.referenceImages ?? []).map((reference) => ({
      ...reference,
      sourceNodeId: undefined,
      createdAt: now,
      updatedAt: now,
    })),
    voiceClips: (character.voiceClips ?? []).map((clip) => ({
      ...clip,
      sourceNodeId: undefined,
      createdAt: now,
      updatedAt: now,
    })),
    imageNodeId: undefined,
  });
}

export function pickSpawnPosition(nodes: Node<BaseNodeData>[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 120, y: 120 };
  let maxX = 0;
  let yAtMax = 120;
  for (const n of nodes) {
    const w = (n.data?.nodeWidth as number) || 280;
    const right = n.position.x + w;
    if (right > maxX) {
      maxX = right;
      yAtMax = n.position.y;
    }
  }
  return { x: maxX + 80, y: yAtMax };
}
