/**
 * store.dramaAssets — 管理项目与全局短剧资产及其画布关联。
 */
import { t } from '../i18n';
/**
 * 项目级短剧资产库（人物 / 场景 / 道具）
 */
import type { StateCreator } from 'zustand';
import type { Node } from '@xyflow/react';
import type { AppState } from './useAppStore';
import type {
  CharacterAction,
  CharacterActionMedia,
  CharacterCropRect,
  CharacterReferenceImage,
  CharacterReferenceKind,
  CharacterVoiceClip,
  CharacterVoiceKind,
  DramaAsset,
  DramaAssetKind,
  DramaAssetCategory,
  DramaAssetLibrary,
  DramaAssetWriteOptions,
  DramaAssetReferenceImage,
  DramaCharacter,
  DramaProp,
  DramaScene,
} from '../types/dramaAssets';
import { assertDramaAssetWriteCurrent, emptyDramaAssetLibrary, normalizeDramaCharacter, normalizeDramaVisualAsset, syncDramaVisualAssetPrimary, MAX_DRAMA_REFERENCE_IMAGES, MAX_CHARACTER_WEAPONS, normalizeCharacterWeaponIds } from '../types/dramaAssets';
import type { DramaExtractParseResult } from '../services/dramaAssetExtract';
import { mergeDramaExtractIntoLibrary, normalizeAssetKey } from '../services/dramaAssetExtract';
import {
  buildDramaAssetImagePrompt,
  defaultAspectRatioForAsset,
  defaultPurposeForKind,
  findDramaAssetByKind,
  purposeLabel,
} from '../services/dramaAssetPrompt';
import { generateId, seriesOwnerId } from './store.utils';
import { nodeHeightForAspectRatio } from '../utils/nodeBounds';
import type { BaseNodeData, CharacterLibraryNodeLink } from '../types';
import {
  registerCanvasDerivation,
  isCanvasDerivationFresh,
  completeCanvasDerivation,
} from '../services/canvasDerivationGuard';
import {
  clearGlobalCharacterCards,
  deleteGlobalCharacterCard,
  loadGlobalCharacterCards,
  saveGlobalCharacterCard,
  saveGlobalCharacterOrder,
} from '../services/characterLibraryService';
import {
  addImportedGlobalDramaAssets,
  deleteGlobalDramaAssetCard,
  loadGlobalDramaAssetCards,
  saveGlobalDramaAssetCard,
  type GlobalDramaAssetSaveOptions,
} from '../services/globalDramaAssetService';
import { reorderCharacterSubset, sortCharactersForLibrary } from '../services/characterOrder';
import { putGlobalCharacterWeapons } from '../services/indexedDbService';
import { configValuesEqual } from '../services/configPatch';

const characterOrderSaves = new Set<string>();
const dramaAssetImports = new Set<string>();

export type CharacterLibraryScope = 'project' | 'global';

function findScopedCharacter(
  state: Pick<AppState, 'dramaAssets' | 'globalCharacters'>,
  scope: CharacterLibraryScope,
  characterId: string,
): DramaCharacter | undefined {
  return (scope === 'project' ? state.dramaAssets.characters : state.globalCharacters)
    .find((character) => character.id === characterId);
}

/** 从画布收纳一份动作素材；关联仅保存在来源项目的节点上。 */
export interface CharacterActionNodeCapture {
  nodeId: string;
  hideNode: boolean;
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

export interface CaptureImageNodeToCharacterInput {
  nodeId: string;
  scope: CharacterLibraryScope;
  characterId?: string;
  newCharacter?: DramaCharacter;
  kind: CharacterReferenceKind;
  prompt: string;
  hideNode: boolean;
}

export interface CaptureImageNodeToCharacterResult {
  characterId: string;
  referenceImageId: string;
}

export interface BindAudioNodeToCharacterVoiceInput {
  nodeId: string;
  scope: CharacterLibraryScope;
  characterId: string;
  kind?: CharacterVoiceKind;
  label?: string;
  transcript?: string;
  durationSec?: number;
  makePrimary?: boolean;
  hideNode?: boolean;
}

export interface DramaAssetsSlice {
  dramaAssets: DramaAssetLibrary;
  globalCharacters: DramaCharacter[];
  globalCharactersLoading: boolean;
  globalScenes: DramaScene[];
  globalProps: DramaProp[];
  globalDramaAssetsLoading: boolean;
  globalDramaAssetsError: string | null;
  dramaAssetsPanelOpen: boolean;
  setDramaAssetsPanelOpen: (open: boolean) => void;
  markDramaAssetsViewed: () => void;
  setDramaAssets: (library: DramaAssetLibrary) => void;
  resetDramaAssets: () => void;
  /** 提取成功后合并入库 */
  mergeDramaExtract: (
    parsed: DramaExtractParseResult,
    meta?: { sourceNodeId?: string; modelId?: string },
  ) => void;
  /** 按 id 新增或整体覆盖一个资产；角色建议走 saveCharacterCard 以便归一化参考图。 */
  upsertDramaAsset: (asset: DramaAsset) => boolean;
  /** 追加资产包生成的新身份，等待项目/剧集落盘；不按名称覆盖现有条目。 */
  importDramaAssets: (assets: readonly DramaAsset[], options?: DramaAssetWriteOptions) => Promise<number>;
  confirmDramaAsset: (kind: DramaAssetKind, id: string, confirmed?: boolean) => void;
  deleteDramaAsset: (kind: DramaAssetKind, id: string) => void;
  updateDramaAssetFields: (
    kind: DramaAssetKind,
    id: string,
    patch: Partial<Pick<DramaAsset, 'summary' | 'visualNotes' | 'storyRole' | 'name'>> & { propType?: 'weapon' },
  ) => boolean;
  clearDramaAssetsByKind: (kind: DramaAssetCategory) => void;
  setCharacterWeapons: (scope: CharacterLibraryScope, characterId: string, weaponIds: string[], options?: DramaAssetWriteOptions) => Promise<boolean>;
  /** 绑定画布图像节点 */
  bindDramaAssetImage: (
    kind: DramaAssetKind,
    id: string,
    imageNodeId: string,
    imageUrl?: string,
  ) => void;
  unbindDramaAssetImage: (kind: DramaAssetKind, id: string) => void;
  /** 生成成功后：按 imageNodeId / dramaAssetId 回写 imageUrl，音频节点则刷新已绑定的角色声音 */
  syncDramaAssetImageFromNode: (imageNodeId: string, imageUrl: string) => void;
  /**
   * 从资产创建图像节点并填入定妆/场景/道具 prompt，自动绑定。
   * 返回新节点 id；失败返回 null。
   */
  createImageNodeFromDramaAsset: (kind: DramaAssetKind, id: string) => string | null;
  loadGlobalCharacters: () => Promise<void>;
  loadGlobalDramaAssets: () => Promise<void>;
  importGlobalDramaAssets: (assets: readonly DramaAsset[], options?: DramaAssetWriteOptions) => Promise<number>;
  saveGlobalDramaAsset: (asset: DramaAsset, options?: GlobalDramaAssetSaveOptions) => Promise<boolean>;
  deleteGlobalDramaAsset: (kind: DramaAssetKind, id: string, options?: DramaAssetWriteOptions) => Promise<boolean>;
  bindGlobalDramaAssetImage: (kind: DramaAssetKind, id: string, nodeId: string, options?: DramaAssetWriteOptions) => Promise<boolean>;
  saveDramaVisualAsset: (scope: CharacterLibraryScope, asset: DramaScene | DramaProp, options?: DramaAssetWriteOptions) => Promise<boolean>;
  addDramaAssetReferenceImage: (scope: CharacterLibraryScope, kind: 'scene' | 'prop', id: string, reference: DramaAssetReferenceImage,
    options?: DramaAssetWriteOptions & { makePrimary?: boolean }) => Promise<boolean>;
  updateDramaAssetReferenceImage: (scope: CharacterLibraryScope, kind: 'scene' | 'prop', id: string, referenceId: string,
    patch: Partial<Pick<DramaAssetReferenceImage, 'label' | 'prompt'>>, options?: DramaAssetWriteOptions) => Promise<boolean>;
  removeDramaAssetReferenceImage: (scope: CharacterLibraryScope, kind: 'scene' | 'prop', id: string, referenceId: string, options?: DramaAssetWriteOptions) => Promise<boolean>;
  setDramaAssetPrimaryReference: (scope: CharacterLibraryScope, kind: 'scene' | 'prop', id: string, referenceId: string, options?: DramaAssetWriteOptions) => Promise<boolean>;
  reorderCharacters: (scope: CharacterLibraryScope, ids: string[], projectId: string | null) => Promise<boolean>;
  saveCharacterCard: (
    scope: CharacterLibraryScope,
    character: DramaCharacter,
    options?: DramaAssetWriteOptions,
  ) => Promise<boolean>;
  addCharacterReferenceImage: (
    scope: CharacterLibraryScope,
    characterId: string,
    reference: CharacterReferenceImage,
    options?: DramaAssetWriteOptions & { makePrimary?: boolean },
  ) => Promise<boolean>;
  setCharacterAvatar: (
    scope: CharacterLibraryScope,
    characterId: string,
    referenceImageId: string,
    crop: CharacterCropRect,
  ) => Promise<boolean>;
  copyCharacterToGlobal: (characterId: string) => Promise<string | null>;
  copyGlobalCharacterToProject: (characterId: string) => string | null;
  deleteGlobalCharacter: (characterId: string, options?: DramaAssetWriteOptions) => Promise<boolean>;
  clearGlobalCharacters: () => Promise<boolean>;
  captureImageNodeToCharacter: (
    input: CaptureImageNodeToCharacterInput,
  ) => Promise<CaptureImageNodeToCharacterResult | null>;
  createImageNodeFromCharacterReference: (
    scope: CharacterLibraryScope,
    characterId: string,
    referenceImageId: string,
  ) => string | null;
  addCharacterVoiceClip: (
    scope: CharacterLibraryScope,
    characterId: string,
    clip: CharacterVoiceClip,
    options?: DramaAssetWriteOptions & { makePrimary?: boolean },
  ) => Promise<boolean>;
  updateCharacterVoiceClip: (
    scope: CharacterLibraryScope,
    characterId: string,
    clipId: string,
    patch: Partial<Pick<CharacterVoiceClip, 'kind' | 'label' | 'transcript'>>,
    options?: DramaAssetWriteOptions,
  ) => Promise<boolean>;
  removeCharacterVoiceClip: (
    scope: CharacterLibraryScope,
    characterId: string,
    clipId: string,
    options?: DramaAssetWriteOptions,
  ) => Promise<boolean>;
  setCharacterPrimaryVoice: (
    scope: CharacterLibraryScope,
    characterId: string,
    clipId: string,
    options?: DramaAssetWriteOptions,
  ) => Promise<boolean>;
  addCharacterAction: (
    scope: CharacterLibraryScope,
    characterId: string,
    action: Pick<CharacterAction, 'category' | 'customCategory' | 'name' | 'prompt' | 'media'>,
    capture?: CharacterActionNodeCapture,
  ) => Promise<string | null>;
  addCharacterActionMedia: (
    scope: CharacterLibraryScope,
    characterId: string,
    actionId: string,
    media: CharacterActionMedia[],
    capture?: CharacterActionNodeCapture,
  ) => Promise<boolean>;
  removeCharacterActionMedia: (
    scope: CharacterLibraryScope,
    characterId: string,
    actionId: string,
    mediaId: string,
  ) => Promise<boolean>;
  removeCharacterAction: (
    scope: CharacterLibraryScope,
    characterId: string,
    actionId: string,
  ) => Promise<boolean>;
  /** 把画布音频节点绑定为角色声音，返回声音片段 id */
  bindAudioNodeToCharacterVoice: (
    input: BindAudioNodeToCharacterVoiceInput,
  ) => Promise<string | null>;
  createAudioNodeFromCharacterVoice: (
    scope: CharacterLibraryScope,
    characterId: string,
    clipId: string,
  ) => string | null;
  /**
   * 用角色声音配台词：把声音节点连到新建的生成音频节点，
   * 音频生成会把连线上的音频作为音色参考。返回生成节点 id。
   */
  createVoiceOverNodeFromCharacterVoice: (
    scope: CharacterLibraryScope,
    characterId: string,
    clipId: string,
  ) => string | null;
}

export function countUnreadDramaAssets(library: DramaAssetLibrary): number {
  if (library.lastViewedAt === undefined) return 0;
  const { lastViewedAt } = library;
  return [...library.characters, ...library.scenes, ...library.props]
    .filter((asset) => asset.createdAt > lastViewedAt).length;
}

function patchList<T extends { id: string; updatedAt: number }>(
  list: T[],
  id: string,
  patch: Partial<T>,
): T[] {
  return list.map((item) =>
    item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
  );
}

function mapKindList(
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

function silentSave(get: () => AppState) {
  void get().saveCurrentProjectSilent?.();
}

function checkedCharacterWeapons(character: DramaCharacter, props: readonly DramaProp[], previous?: DramaCharacter): string[] | undefined {
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

function removesBoundWeapon(previous: DramaAsset | undefined, next: DramaAsset, characters: readonly DramaCharacter[]): boolean {
  return previous?.kind === 'prop' && previous.propType === 'weapon'
    && next.kind === 'prop' && next.propType !== 'weapon'
    && characters.some((character) => character.weaponIds?.includes(previous.id));
}

function withoutCharacterWeapons(characters: DramaCharacter[], ids: ReadonlySet<string>): DramaCharacter[] {
  return characters.map((character) => character.weaponIds?.some((id) => ids.has(id))
    ? { ...character, weaponIds: character.weaponIds.filter((id) => !ids.has(id)), updatedAt: Date.now() }
    : character);
}

/** 读取期间发生的增删改优先于旧快照，避免并发加载覆盖已经保存的编辑。 */
function mergeLoadedGlobalAssets<T extends { id: string }>(before: T[], current: T[], loaded: T[]): T[] {
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
function sameCharacterContent(left: DramaCharacter | undefined, right: DramaCharacter | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const previous = left as unknown as Record<string, unknown>;
  const current = right as unknown as Record<string, unknown>;
  return Object.keys({ ...previous, ...current })
    .every((key) => key === 'libraryOrder' || previous[key] === current[key]);
}

async function saveCharacterActionWithNode(
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

function syncCharacterPrimaryImage(character: DramaCharacter): DramaCharacter {
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

function sameImageIdentity(
  first: { assetId?: string; relativePath?: string; filePath?: string },
  second: { assetId?: string; relativePath?: string; filePath?: string },
): boolean {
  return first.assetId === second.assetId && first.relativePath === second.relativePath && first.filePath === second.filePath;
}

function upsertCharacterReference(
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

function upsertCharacterVoiceClip(
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

function cloneCharacter(character: DramaCharacter): DramaCharacter {
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

function pickSpawnPosition(nodes: Node<BaseNodeData>[]): { x: number; y: number } {
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

export const createDramaAssetsSlice: StateCreator<AppState, [], [], DramaAssetsSlice> = (set, get, api) => {
  let globalAssetsLoad: Promise<void> | undefined;
  let globalAssetsImporting = false;
  return ({
  dramaAssets: emptyDramaAssetLibrary(),
  globalCharacters: [],
  globalCharactersLoading: false,
  globalScenes: [],
  globalProps: [],
  globalDramaAssetsLoading: false,
  globalDramaAssetsError: null,
  dramaAssetsPanelOpen: false,

  setDramaAssetsPanelOpen: (open) => set(open
    ? {
        dramaAssetsPanelOpen: true,
        assetsPanelOpen: true,
        characterLibraryOpen: false,
        historyPanelOpen: false,
        settingsOpen: false,
        chatOpen: false,
      }
    : { dramaAssetsPanelOpen: false }),

  markDramaAssetsViewed: () => {
    set((state) => ({
      dramaAssets: { ...state.dramaAssets, lastViewedAt: Date.now() },
    }));
    silentSave(get);
  },

  setDramaAssets: (library) => set({ dramaAssets: library ?? emptyDramaAssetLibrary() }),

  resetDramaAssets: () => set({ dramaAssets: emptyDramaAssetLibrary() }),

  mergeDramaExtract: (parsed, meta) => {
    const previous = get().dramaAssets;
    const existingAssets = [
      ...previous.characters,
      ...previous.scenes,
      ...previous.props,
    ];
    const legacyBaseline = existingAssets.reduce(
      (latest, asset) => Math.max(latest, asset.createdAt),
      0,
    );
    const next = {
      ...mergeDramaExtractIntoLibrary(previous, parsed, meta),
      lastViewedAt: previous.lastViewedAt ?? legacyBaseline,
    };
    set({ dramaAssets: next });
    silentSave(get);
    // 提取成功后自动打开面板，避免用户找不到入口
    const total =
      next.characters.length + next.scenes.length + next.props.length;
    if (total > 0) {
      get().setDramaAssetsPanelOpen(true);
    }
  },

  importDramaAssets: async (assets, options) => {
    assertDramaAssetWriteCurrent(options);
    const initial = get();
    const projectId = initial.currentProjectId;
    if (!projectId || initial.projectLoadStatus !== 'ready') throw new Error('请先打开并保存项目');
    const ownerId = seriesOwnerId(initial.projects, projectId);
    if (dramaAssetImports.has(ownerId)) throw new Error('正在导入创作资产，请稍后重试');
    if (!assets.length) return 0;
    const ids = new Set<string>();
    const existing = new Set([...initial.dramaAssets.characters, ...initial.dramaAssets.scenes, ...initial.dramaAssets.props]
      .map((asset) => asset.id));
    const availableWeapons = [...initial.dramaAssets.props, ...assets.filter((asset): asset is DramaProp => asset.kind === 'prop')];
    const additions = assets.map((asset) => {
      if (!asset || !['character', 'scene', 'prop'].includes(asset.kind) || !asset.id?.trim()
        || typeof asset.name !== 'string' || !asset.name.trim() || ids.has(asset.id) || existing.has(asset.id)) {
        throw new Error('导入资产身份无效或与当前资产冲突');
      }
      ids.add(asset.id);
      return asset.kind === 'character'
        ? syncCharacterPrimaryImage(normalizeDramaCharacter({ ...asset, libraryOrder: undefined,
          weaponIds: checkedCharacterWeapons(asset, availableWeapons) })) : asset;
    });
    assertDramaAssetWriteCurrent(options);
    dramaAssetImports.add(ownerId);
    try {
      set((state) => ({ dramaAssets: {
        ...state.dramaAssets,
        characters: [...state.dramaAssets.characters, ...additions.filter((asset): asset is DramaCharacter => asset.kind === 'character')],
        scenes: [...state.dramaAssets.scenes, ...additions.filter((asset): asset is DramaScene => asset.kind === 'scene')],
        props: [...state.dramaAssets.props, ...additions.filter((asset): asset is DramaProp => asset.kind === 'prop')],
      } }));
      // saveCurrentProjectSilent 同步捕获当前画布与所属剧集库；已接受的保存不因关闭界面而撤销。
      if (await get().saveCurrentProjectSilent() !== projectId) throw new Error('保存失败');
      return additions.length;
    } catch {
      const latest = get();
      if (latest.currentProjectId && latest.projectLoadStatus === 'ready'
        && seriesOwnerId(latest.projects, latest.currentProjectId) === ownerId) {
        set((state) => ({ dramaAssets: {
          ...state.dramaAssets,
          characters: state.dramaAssets.characters.filter((asset) => !ids.has(asset.id)),
          scenes: state.dramaAssets.scenes.filter((asset) => !ids.has(asset.id)),
          props: state.dramaAssets.props.filter((asset) => !ids.has(asset.id)),
        } }));
        // 撤回只涉及本批新 ID；恢复保存失败时保留素材，避免已落盘的共享库引用失效。
        await get().saveCurrentProjectSilent().catch(() => undefined);
      }
      throw new Error('创作资产导入保存失败，素材文件已保留，请重试');
    } finally {
      dramaAssetImports.delete(ownerId);
    }
  },

  upsertDramaAsset: (asset) => {
    if (asset.kind !== 'character') asset = syncDramaVisualAssetPrimary(asset);
    const lib = get().dramaAssets;
    const previous = findDramaAssetByKind(lib, asset.kind, asset.id);
    if (removesBoundWeapon(previous, asset, lib.characters)) {
      get().showToast?.(t('请先解除角色的武器绑定，再改为普通道具'), 'error');
      return false;
    }
    if (asset.kind === 'character') {
      try { asset = { ...asset, weaponIds: checkedCharacterWeapons(asset, lib.props, previous?.kind === 'character' ? previous : undefined) }; }
      catch { get().showToast?.(t('武器绑定无效，请重新选择'), 'error'); return false; }
    }
    set({
      dramaAssets: mapKindList(lib, asset.kind, (list) => (
        list.some((item) => item.id === asset.id)
          ? list.map((item) => item.id === asset.id
            ? { ...item, ...asset, updatedAt: Date.now() } as DramaAsset
            : item)
          : [...list, asset]
      )),
    });
    silentSave(get);
    return true;
  },

  confirmDramaAsset: (kind, id, confirmed = true) => {
    const lib = get().dramaAssets;
    set({
      dramaAssets: mapKindList(lib, kind, (list) =>
        patchList(list, id, { confirmed } as Partial<DramaAsset>),
      ),
    });
    silentSave(get);
  },

  deleteDramaAsset: (kind, id) => {
    const lib = get().dramaAssets;
    if (kind === 'character') {
      get().releaseCharacterLibraryNodes('project', id);
      set({ dramaAssets: { ...lib, characters: lib.characters.filter((c) => c.id !== id) } });
    } else if (kind === 'scene') {
      set({ dramaAssets: { ...lib, scenes: lib.scenes.filter((c) => c.id !== id) } });
    } else {
      set({ dramaAssets: { ...lib, props: lib.props.filter((c) => c.id !== id),
        characters: withoutCharacterWeapons(lib.characters, new Set([id])) } });
    }
    silentSave(get);
  },

  updateDramaAssetFields: (kind, id, patch) => {
    const lib = get().dramaAssets;
    const previous = findDramaAssetByKind(lib, kind, id);
    if (!previous || ('propType' in patch && (kind !== 'prop' || (patch.propType !== undefined && patch.propType !== 'weapon')))) return false;
    if (removesBoundWeapon(previous, { ...previous, ...patch } as DramaAsset, lib.characters)) {
      get().showToast?.(t('请先解除角色的武器绑定，再改为普通道具'), 'error');
      return false;
    }
    // 改名时同步 key，保证后续重提取 merge 仍能对上
    const nextPatch: Partial<DramaAsset> = { ...patch };
    if (typeof patch.name === 'string' && patch.name.trim()) {
      nextPatch.key = normalizeAssetKey(patch.name);
    }
    set({
      dramaAssets: mapKindList(lib, kind, (list) =>
        patchList(list, id, nextPatch),
      ),
    });
    silentSave(get);
    return true;
  },

  clearDramaAssetsByKind: (kind) => {
    const lib = get().dramaAssets;
    if (kind === 'character') {
      get().releaseCharacterLibraryNodes('project');
      set({ dramaAssets: { ...lib, characters: [] } });
    }
    else if (kind === 'scene') set({ dramaAssets: { ...lib, scenes: [] } });
    else {
      const removed = new Set(lib.props.filter((prop) => kind === 'weapon' ? prop.propType === 'weapon' : prop.propType !== 'weapon').map((prop) => prop.id));
      set({ dramaAssets: { ...lib, props: lib.props.filter((prop) => !removed.has(prop.id)),
        characters: withoutCharacterWeapons(lib.characters, removed) } });
    }
    silentSave(get);
  },

  bindDramaAssetImage: (kind, id, imageNodeId, imageUrl) => {
    const lib = get().dramaAssets;
    const node = get().nodes.find((n) => n.id === imageNodeId);
    const resolvedUrl =
      imageUrl
      || (node?.data?.imageUrl as string | undefined)
      || (node?.data?.thumbnailUrl as string | undefined);
    if (kind !== 'character') {
      const asset = findDramaAssetByKind(lib, kind, id);
      if (!asset || asset.kind === 'character') return;
      const existing = normalizeDramaVisualAsset(asset).referenceImages?.find((reference) => reference.sourceNodeId === imageNodeId);
      void get().addDramaAssetReferenceImage('project', kind, id, {
        id: existing?.id ?? `reference-${generateId()}`, label: existing?.label ?? node?.data.label ?? '',
        prompt: existing?.prompt ?? node?.data.prompt ?? '', imageUrl: resolvedUrl, sourceNodeId: imageNodeId,
        assetId: node?.data.assetId, relativePath: node?.data.relativePath, filePath: node?.data.filePath,
        createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
      }, { makePrimary: true });
      return;
    }
    set({
      dramaAssets: mapKindList(lib, kind, (list) =>
        patchList(list, id, {
          imageNodeId,
          imageUrl: resolvedUrl,
          assetId: node?.data.assetId,
          relativePath: node?.data.relativePath,
          filePath: node?.data.filePath,
          imageAssetId: undefined,
          imageRelativePath: undefined,
        } as Partial<DramaAsset>),
      ),
    });
    if (kind === 'character') {
      const prompt = typeof node?.data?.prompt === 'string' ? node.data.prompt : '';
      void get().addCharacterReferenceImage('project', id, {
        id: `reference-${generateId()}`,
        kind: 'primary',
        assetId: node?.data?.assetId as string | undefined,
        relativePath: node?.data?.relativePath as string | undefined,
        filePath: node?.data?.filePath as string | undefined,
        imageUrl: resolvedUrl,
        sourceNodeId: imageNodeId,
        prompt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }, { makePrimary: true });
      return;
    }
    silentSave(get);
  },

  unbindDramaAssetImage: (kind, id) => {
    const lib = get().dramaAssets;
    const strip = (list: DramaAsset[]): DramaAsset[] =>
      list.map((item) => {
        if (item.id !== id) return item;
        const rest = { ...item } as DramaAsset & { filePath?: string };
        delete rest.imageNodeId;
        delete rest.imageUrl;
        delete rest.assetId;
        delete rest.relativePath;
        delete rest.filePath;
        delete rest.imageAssetId;
        delete rest.imageRelativePath;
        return item.kind === 'character'
          ? {
              ...rest,
              referenceImages: [],
              primaryReferenceImageId: undefined,
              avatarReferenceImageId: undefined,
              avatarCrop: undefined,
              updatedAt: Date.now(),
            } as DramaAsset
          : { ...rest, referenceImages: [], primaryReferenceImageId: undefined, updatedAt: Date.now() } as DramaAsset;
      });
    set({ dramaAssets: mapKindList(lib, kind, strip) });
    silentSave(get);
  },

  syncDramaAssetImageFromNode: (imageNodeId, imageUrl) => {
    const lib = get().dramaAssets;
    const node = get().nodes.find((n) => n.id === imageNodeId);
    // 重新生成会换一份本地文件，绑定关系跟着节点走
    const nodeFileIdentity = {
      assetId: node?.data?.assetId as string | undefined,
      relativePath: node?.data?.relativePath as string | undefined,
      filePath: node?.data?.filePath as string | undefined,
    };
    let changed = false;

    const syncList = <T extends DramaAsset>(list: T[]): T[] =>
      list.map((item) => {
        if (item.kind !== 'character') {
          const visual = normalizeDramaVisualAsset(item);
          const references = visual.referenceImages ?? [];
          const matching = references.find((reference) => reference.sourceNodeId === imageNodeId);
          const ownsNode = node?.data.dramaAssetId === item.id && node?.data.dramaAssetKind === item.kind;
          if (!matching && (!ownsNode || references.length >= MAX_DRAMA_REFERENCE_IMAGES)) return item;
          const now = Date.now();
          const reference: DramaAssetReferenceImage = {
            ...matching,
            id: matching?.id ?? `reference-${generateId()}`,
            label: matching?.label ?? node?.data.label ?? '',
            prompt: matching?.prompt ?? node?.data.prompt ?? '',
            ...nodeFileIdentity,
            assetSource: undefined,
            imageUrl,
            sourceNodeId: imageNodeId,
            createdAt: matching?.createdAt ?? now,
            updatedAt: now,
          };
          const updated = syncDramaVisualAssetPrimary({
            ...visual,
            referenceImages: matching
              ? references.map((entry) => entry.id === matching.id ? reference : entry)
              : [...references, reference],
            // 已绑定的次参考只刷新自身；首次补绑才选择新图为主图。
            primaryReferenceImageId: matching ? visual.primaryReferenceImageId : reference.id,
            updatedAt: now,
          });
          if (matching && item.referenceImages && matching.imageUrl === imageUrl
            && sameImageIdentity(matching, nodeFileIdentity) && !matching.assetSource
            && item.primaryReferenceImageId === updated.primaryReferenceImageId
            && item.imageNodeId === updated.imageNodeId && item.imageUrl === updated.imageUrl
            && sameImageIdentity(item, updated) && item.imageAssetId === updated.imageAssetId
            && item.imageRelativePath === updated.imageRelativePath) return item;
          changed = true;
          return updated as T;
        }
        // 音频节点重新生成后刷新已绑定的角色声音（同一节点不会既是图像又是音频来源）
        const voiceClips: CharacterVoiceClip[] = item.voiceClips ?? [];
        const matchingVoiceClip = voiceClips.find((clip) => clip.sourceNodeId === imageNodeId);
        if (matchingVoiceClip) {
          if (matchingVoiceClip.audioUrl === imageUrl) return item;
          changed = true;
          return {
            ...item,
            voiceClips: voiceClips.map((clip) =>
              clip.sourceNodeId === imageNodeId
                ? { ...clip, ...nodeFileIdentity, audioUrl: imageUrl, updatedAt: Date.now() }
                : clip,
            ),
            updatedAt: Date.now(),
          };
        }
        const matchingReference = item.referenceImages?.find((reference) => reference.sourceNodeId === imageNodeId);
        if (item.imageNodeId === imageNodeId || matchingReference) {
          const primary = item.referenceImages?.find((reference) => reference.id === item.primaryReferenceImageId) ?? item.referenceImages?.[0];
          const syncPrimary = item.imageNodeId === imageNodeId || primary?.sourceNodeId === imageNodeId;
          const referencesUnchanged = (item.referenceImages ?? []).every((reference) => (
            reference.sourceNodeId !== imageNodeId || reference.imageUrl === imageUrl && sameImageIdentity(reference, nodeFileIdentity)
          ));
          if ((!syncPrimary || item.imageUrl === imageUrl && sameImageIdentity(item, nodeFileIdentity)
            && !item.imageAssetId && !item.imageRelativePath) && referencesUnchanged) return item;
          changed = true;
          return {
            ...item,
            ...(syncPrimary ? { ...nodeFileIdentity, imageUrl, imageAssetId: undefined, imageRelativePath: undefined } : {}),
            ...{
              referenceImages: (item.referenceImages ?? []).map((reference) =>
                reference.sourceNodeId === imageNodeId
                  ? { ...reference, ...nodeFileIdentity, imageUrl, updatedAt: Date.now() }
                  : reference,
              ),
            },
            updatedAt: Date.now(),
          };
        }
        return item;
      });

    const next: DramaAssetLibrary = {
      ...lib,
      characters: syncList(lib.characters),
      scenes: syncList(lib.scenes),
      props: syncList(lib.props),
    };

    // 按节点 data.dramaAssetId 补绑（一键创建路径兜底）
    const dramaAssetId = node?.data?.dramaAssetId as string | undefined;
    const dramaAssetKind = node?.data?.dramaAssetKind as DramaAssetKind | undefined;
    if (dramaAssetId && dramaAssetKind === 'character') {
      const asset = findDramaAssetByKind(next, dramaAssetKind, dramaAssetId);
      if (asset && (asset.imageNodeId !== imageNodeId || asset.imageUrl !== imageUrl || !sameImageIdentity(asset, nodeFileIdentity))) {
        changed = true;
        const bindPatch = { ...nodeFileIdentity, imageNodeId, imageUrl,
          imageAssetId: undefined, imageRelativePath: undefined, updatedAt: Date.now() };
        next.characters = next.characters.map((c) =>
          c.id === dramaAssetId ? { ...c, ...bindPatch } : c,
        );
      }
    }

    if (!changed) return;
    set({ dramaAssets: next });
    silentSave(get);
  },

  createImageNodeFromDramaAsset: (kind, id) => {
    const asset = findDramaAssetByKind(get().dramaAssets, kind, id);
    if (!asset) {
      get().showToast?.('未找到该资产', 'error');
      return null;
    }

    const purpose = defaultPurposeForKind(kind);
    const prompt = buildDramaAssetImagePrompt(asset, purpose);
    const nodeId = `node-${generateId()}`;
    const pos = pickSpawnPosition(get().nodes as Node<BaseNodeData>[]);
    const aspectRatio = defaultAspectRatioForAsset(kind);
    const label = `${asset.name} · ${purposeLabel(purpose)}`;

    const nodeWidth = 280;
    const nodeHeight = nodeHeightForAspectRatio(aspectRatio, nodeWidth);

    const newNode: Node<BaseNodeData> = {
      id: nodeId,
      type: 'ai-image',
      position: pos,
      data: {
        label,
        type: 'ai-image',
        role: 'generator',
        prompt,
        status: 'idle',
        aspectRatio,
        imageSize: '2K',
        nodeWidth,
        nodeHeight,
        dramaAssetId: asset.id,
        dramaAssetKind: kind,
      },
    };

    // 回填本地偏好模型（与侧栏添加图像节点一致）
    try {
      const raw = localStorage.getItem('canvas-model-prefs');
      if (raw) {
        const prefs: Record<string, string> = JSON.parse(raw);
        const modelValue = prefs['ai-image'];
        if (modelValue && modelValue.includes('::')) {
          const [provider, model] = modelValue.split('::');
          if (provider && model) {
            newNode.data.provider = provider;
            newNode.data.model = model;
          }
        }
      }
    } catch { /* ignore */ }

    get().addNode(newNode);
    get().bindDramaAssetImage(kind, id, nodeId);
    get().setAssetsPanelOpen(false);
    get().setSelectedNodeIds([nodeId]);
    get().showToast(t('已创建「{name}」图像节点，可直接生成', { name: label }));

    return nodeId;
  },

  loadGlobalCharacters: async () => {
    const before = get().globalCharacters;
    set({ globalCharactersLoading: true });
    try {
      const loaded = await loadGlobalCharacterCards();
      set((current) => ({ globalCharacters: mergeLoadedGlobalAssets(before, current.globalCharacters, loaded) }));
    } catch {
      get().showToast?.('全局角色加载失败', 'error');
    } finally {
      set({ globalCharactersLoading: false });
    }
  },

  loadGlobalDramaAssets: () => {
    if (globalAssetsLoad) return globalAssetsLoad;
    const before = get();
    set({ globalDramaAssetsLoading: true });
    globalAssetsLoad = (async () => {
      try {
        const assets = await loadGlobalDramaAssetCards();
        set((current) => ({
          globalCharacters: mergeLoadedGlobalAssets(before.globalCharacters, current.globalCharacters,
            assets.filter((asset): asset is DramaCharacter => asset.kind === 'character')),
          globalScenes: mergeLoadedGlobalAssets(before.globalScenes, current.globalScenes,
            assets.filter((asset): asset is DramaScene => asset.kind === 'scene')),
          globalProps: mergeLoadedGlobalAssets(before.globalProps, current.globalProps,
            assets.filter((asset): asset is DramaProp => asset.kind === 'prop')),
          globalDramaAssetsError: null,
        }));
      } catch {
        const message = '全局创作资产加载失败，请重试';
        set({ globalDramaAssetsError: message });
        throw new Error(message);
      } finally {
        set({ globalDramaAssetsLoading: false });
        globalAssetsLoad = undefined;
      }
    })();
    return globalAssetsLoad;
  },

  importGlobalDramaAssets: async (assets, options) => {
    assertDramaAssetWriteCurrent(options);
    if (globalAssetsImporting) throw new Error('正在导入全局创作资产，请稍后重试');
    if (!assets.length) return 0;
    globalAssetsImporting = true;
    try {
      await get().loadGlobalDramaAssets();
      assertDramaAssetWriteCurrent(options);
      if (get().globalDramaAssetsError) throw new Error(get().globalDramaAssetsError!);
      const existing = new Set([...get().globalCharacters, ...get().globalScenes, ...get().globalProps].map((asset) => asset.id));
      if (assets.some((asset) => existing.has(asset.id))) throw new Error('全局创作资产身份已存在，请重新导入');
      const additions = assets.map((asset) => asset.kind === 'character' ? { ...asset, libraryOrder: undefined } : asset);
      const saved = await addImportedGlobalDramaAssets(additions, options);
      // 成功事务已经接受本批；迟到关闭或取消不能让全局 Store 漏掉已持久化的记录。
      set((current) => ({
        globalCharacters: [...current.globalCharacters, ...saved.filter((asset): asset is DramaCharacter => asset.kind === 'character')],
        globalScenes: [...current.globalScenes, ...saved.filter((asset): asset is DramaScene => asset.kind === 'scene')],
        globalProps: [...current.globalProps, ...saved.filter((asset): asset is DramaProp => asset.kind === 'prop')],
      }));
      return saved.length;
    } finally { globalAssetsImporting = false; }
  },

  saveGlobalDramaAsset: async (asset, options = {}) => {
    if (get().globalDramaAssetsError) return false;
    if (asset.kind === 'character') return get().saveCharacterCard('global', asset, options);
    const initial = get();
    const previous = (asset.kind === 'scene' ? initial.globalScenes : initial.globalProps)
      .find((item) => item.id === asset.id);
    if (removesBoundWeapon(previous, asset, initial.globalCharacters)) {
      get().showToast?.(t('请先解除角色的武器绑定，再改为普通道具'), 'error');
      return false;
    }
    const normalized = normalizeDramaVisualAsset(asset);
    const sourceIds = [...new Set((normalized.referenceImages ?? []).flatMap((reference) => reference.sourceNodeId ? [reference.sourceNodeId] : []))];
    const sources = sourceIds.map((id) => initial.nodes.find((node) => node.id === id));
    if (sources.some((source) => !isEligibleCharacterReferenceNode(source))) return false;
    const controller = new AbortController();
    const guards = sources.flatMap((source) => {
      const guard = source && registerCanvasDerivation(initial, source.id, { onCancel: () => controller.abort() });
      return guard ? [guard] : [];
    });
    if (guards.length !== sources.length) { guards.forEach(completeCanvasDerivation); return false; }
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const assertCurrent = () => {
      assertDramaAssetWriteCurrent(options);
      if (controller.signal.aborted || guards.some((guard) => !isCanvasDerivationFresh(guard, get()))) {
        throw new Error('画布已变化，创作资产未保存');
      }
      const current = (asset.kind === 'scene' ? get().globalScenes : get().globalProps)
        .find((item) => item.id === asset.id);
      if (current !== previous) throw new Error('创作资产已变化，请重新保存');
    };
    const unsubscribe = api.subscribe(() => {
      try { assertCurrent(); } catch { controller.abort(); }
    });
    try {
      assertCurrent();
      const input = { ...normalized, referenceImages: normalized.referenceImages?.map((reference) => {
        const source = sources.find((node) => node?.id === reference.sourceNodeId);
        return source ? { ...reference, assetSource: undefined, imageUrl: source.data.imageUrl || source.data.thumbnailUrl,
          assetId: source.data.assetId, relativePath: source.data.relativePath, filePath: source.data.filePath } : reference;
      }) };
      const persisted = await saveGlobalDramaAssetCard(input, {
        ...options, signal: controller.signal, assertCurrent,
      });
      assertCurrent();
      unsubscribe();
      if (persisted.kind === 'scene') {
        set((current) => ({ globalScenes: [...current.globalScenes.filter((item) => item.id !== persisted.id), persisted] }));
      } else if (persisted.kind === 'prop') {
        set((current) => ({ globalProps: [...current.globalProps.filter((item) => item.id !== persisted.id), persisted] }));
      }
      return true;
    } catch {
      if (!controller.signal.aborted && !options.signal?.aborted) get().showToast?.('全局创作资产保存失败，原资产保持不变', 'error');
      return false;
    } finally {
      unsubscribe();
      options.signal?.removeEventListener('abort', abort);
      guards.forEach(completeCanvasDerivation);
    }
  },

  deleteGlobalDramaAsset: async (kind, id, options) => {
    if (kind === 'character') return get().deleteGlobalCharacter(id, options);
    try {
      assertDramaAssetWriteCurrent(options);
      await deleteGlobalDramaAssetCard(kind, id, options);
      assertDramaAssetWriteCurrent(options);
      if (kind === 'scene') set((current) => ({ globalScenes: current.globalScenes.filter((asset) => asset.id !== id) }));
      else set((current) => ({ globalProps: current.globalProps.filter((asset) => asset.id !== id),
        globalCharacters: withoutCharacterWeapons(current.globalCharacters, new Set([id])) }));
      return true;
    } catch {
      if (!options?.signal?.aborted) get().showToast?.('全局创作资产删除失败', 'error');
      return false;
    }
  },

  bindGlobalDramaAssetImage: async (kind, id, nodeId, options = {}) => {
    const initial = get();
    const source = initial.nodes.find((node) => node.id === nodeId);
    if (!isEligibleCharacterReferenceNode(source) || !source) return false;
    const asset = (kind === 'character' ? initial.globalCharacters
      : kind === 'scene' ? initial.globalScenes : initial.globalProps).find((item) => item.id === id);
    if (!asset || initial.globalDramaAssetsError) return false;
    if (kind !== 'character') {
      const normalized = normalizeDramaVisualAsset(asset as DramaScene | DramaProp);
      const existing = normalized.referenceImages?.find((reference) => reference.assetId && reference.assetId === source.data.assetId);
      return get().addDramaAssetReferenceImage('global', kind, id, {
        id: existing?.id ?? `reference-${generateId()}`, label: existing?.label ?? source.data.label ?? '',
        prompt: existing?.prompt ?? source.data.prompt ?? '', sourceNodeId: source.id,
        assetId: source.data.assetId, relativePath: source.data.relativePath, filePath: source.data.filePath,
        imageUrl: source.data.imageUrl || source.data.thumbnailUrl,
        createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
      }, { ...options, makePrimary: true });
    }
    const controller = new AbortController();
    const guard = registerCanvasDerivation(initial, nodeId, { onCancel: () => controller.abort() });
    if (!guard) return false;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const assertCurrent = () => {
      assertDramaAssetWriteCurrent(options);
      if (controller.signal.aborted || !isCanvasDerivationFresh(guard, get())) throw new Error('角色图片绑定已过期');
    };
    const unsubscribe = api.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
    try {
      assertCurrent();
      const now = Date.now();
      const saved = await get().addCharacterReferenceImage('global', id, {
        id: `reference-${generateId()}`, kind: 'primary', imageUrl: source.data.imageUrl || source.data.thumbnailUrl,
        assetId: source.data.assetId, relativePath: source.data.relativePath, filePath: source.data.filePath,
        prompt: source.data.prompt || '', createdAt: now, updatedAt: now,
      }, { makePrimary: true, signal: controller.signal, assertCurrent });
      assertCurrent();
      return saved;
    } catch {
      return false;
    } finally {
      unsubscribe();
      options.signal?.removeEventListener('abort', abort);
      completeCanvasDerivation(guard);
    }
  },

  reorderCharacters: async (scope, ids, projectId) => {
    const state = get();
    if (state.currentProjectId !== projectId || (scope === 'project' && !projectId)) return false;
    const key = scope === 'global' ? 'global' : `project:${projectId}`;
    if (characterOrderSaves.has(key)) return false;
    const previous = scope === 'project' ? state.dramaAssets.characters : state.globalCharacters;
    const next = reorderCharacterSubset(previous, ids);
    if (!next) return false;
    if (sortCharactersForLibrary(previous).every((item, index) => item.id === next[index].id)) return true;
    characterOrderSaves.add(key);
    const patchOrder = (characters: DramaCharacter[], source: DramaCharacter[]) => {
      const ranks = new Map(source.map((item) => [item.id, item.libraryOrder]));
      return characters.map((item) => ranks.has(item.id) ? { ...item, libraryOrder: ranks.get(item.id) } : item);
    };
    if (scope === 'project') {
      set({ dramaAssets: { ...state.dramaAssets, characters: patchOrder(previous, next) } });
    } else {
      set({ globalCharacters: patchOrder(previous, next) });
    }
    try {
      if (scope === 'project') {
        if (await get().saveCurrentProjectSilent() !== projectId) throw new Error('角色顺序保存失败');
      } else {
        await saveGlobalCharacterOrder(next.map((item) => item.id));
      }
      return true;
    } catch {
      // 只撤销本次排序字段，保留保存期间的角色编辑；不回写其他项目。
      if (scope === 'global') {
        set((current) => ({ globalCharacters: patchOrder(current.globalCharacters, previous) }));
      } else if (get().currentProjectId === projectId) {
        set((current) => ({ dramaAssets: {
          ...current.dramaAssets, characters: patchOrder(current.dramaAssets.characters, previous),
        } }));
      }
      get().showToast?.('角色顺序保存失败，已恢复原顺序', 'error');
      return false;
    } finally {
      characterOrderSaves.delete(key);
    }
  },

  saveDramaVisualAsset: async (scope, asset, options) => {
    try { assertDramaAssetWriteCurrent(options); } catch { return false; }
    if (scope === 'global') return get().saveGlobalDramaAsset(normalizeDramaVisualAsset(asset), options);
    const normalized = syncDramaVisualAssetPrimary(asset);
    const initial = get();
    const projectId = initial.currentProjectId;
    if (!projectId || initial.projectLoadStatus !== 'ready') return false;
    const previous = findDramaAssetByKind(initial.dramaAssets, asset.kind, asset.id);
    if (removesBoundWeapon(previous, asset, initial.dramaAssets.characters)) {
      get().showToast?.(t('请先解除角色的武器绑定，再改为普通道具'), 'error');
      return false;
    }
    set((state) => ({ dramaAssets: mapKindList(state.dramaAssets, asset.kind, (list) =>
      list.some((item) => item.id === asset.id) ? list.map((item) => item.id === asset.id ? normalized : item) : [...list, normalized]) }));
    try {
      if (await get().saveCurrentProjectSilent() !== projectId) throw new Error('保存失败');
      return true;
    } catch {
      if (get().currentProjectId === projectId && findDramaAssetByKind(get().dramaAssets, asset.kind, asset.id) === normalized) {
        set((state) => ({ dramaAssets: mapKindList(state.dramaAssets, asset.kind, (list) =>
          previous ? list.map((item) => item.id === asset.id ? previous : item) : list.filter((item) => item.id !== asset.id)) }));
      }
      get().showToast?.(t('参考图保存失败，素材文件已保留，请重试'), 'error');
      return false;
    }
  },

  addDramaAssetReferenceImage: async (scope, kind, id, reference, options) => {
    const state = get();
    const asset = (scope === 'global' ? kind === 'scene' ? state.globalScenes : state.globalProps
      : kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props).find((item) => item.id === id);
    if (!asset) return false;
    const normalized = normalizeDramaVisualAsset(asset);
    const references = normalized.referenceImages ?? [];
    if (!references.some((item) => item.id === reference.id) && references.length >= MAX_DRAMA_REFERENCE_IMAGES) return false;
    const referenceImages = references.some((item) => item.id === reference.id)
      ? references.map((item) => item.id === reference.id ? reference : item) : [...references, reference];
    return get().saveDramaVisualAsset(scope, { ...normalized, referenceImages,
      primaryReferenceImageId: options?.makePrimary || !normalized.primaryReferenceImageId ? reference.id : normalized.primaryReferenceImageId,
      updatedAt: Date.now() }, options);
  },

  updateDramaAssetReferenceImage: async (scope, kind, id, referenceId, patch, options) => {
    const state = get();
    const asset = (scope === 'global' ? kind === 'scene' ? state.globalScenes : state.globalProps
      : kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props).find((item) => item.id === id);
    if (!asset) return false;
    const normalized = normalizeDramaVisualAsset(asset);
    if (!normalized.referenceImages?.some((item) => item.id === referenceId)) return false;
    return get().saveDramaVisualAsset(scope, { ...normalized, updatedAt: Date.now(), referenceImages: normalized.referenceImages.map((reference) =>
      reference.id === referenceId ? { ...reference, ...patch, updatedAt: Date.now() } : reference) }, options);
  },

  removeDramaAssetReferenceImage: async (scope, kind, id, referenceId, options) => {
    const state = get();
    const asset = (scope === 'global' ? kind === 'scene' ? state.globalScenes : state.globalProps
      : kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props).find((item) => item.id === id);
    if (!asset) return false;
    const normalized = normalizeDramaVisualAsset(asset);
    if (!normalized.referenceImages?.some((item) => item.id === referenceId)) return false;
    const referenceImages = normalized.referenceImages.filter((reference) => reference.id !== referenceId);
    return get().saveDramaVisualAsset(scope, { ...normalized, referenceImages, updatedAt: Date.now(),
      primaryReferenceImageId: normalized.primaryReferenceImageId === referenceId ? referenceImages[0]?.id : normalized.primaryReferenceImageId }, options);
  },

  setDramaAssetPrimaryReference: async (scope, kind, id, referenceId, options) => {
    const state = get();
    const asset = (scope === 'global' ? kind === 'scene' ? state.globalScenes : state.globalProps
      : kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props).find((item) => item.id === id);
    if (!asset || !normalizeDramaVisualAsset(asset).referenceImages?.some((item) => item.id === referenceId)) return false;
    return get().saveDramaVisualAsset(scope, { ...asset, primaryReferenceImageId: referenceId, updatedAt: Date.now() }, options);
  },

  setCharacterWeapons: async (scope, characterId, weaponIds, options = {}) => {
    if (scope !== 'project' && scope !== 'global') return false;
    const initial = get();
    const projectId = initial.currentProjectId;
    const ownerId = projectId ? seriesOwnerId(initial.projects, projectId) : undefined;
    const owner = initial.projects.find((project) => project.id === ownerId);
    const characters = scope === 'project' ? initial.dramaAssets.characters : initial.globalCharacters;
    const original = characters.find((character) => character.id === characterId);
    if (!original || (scope === 'project' && (!projectId || initial.projectLoadStatus !== 'ready' || !owner || owner.parentId))) return false;
    let ids: string[];
    try { ids = checkedCharacterWeapons({ ...original, weaponIds }, scope === 'project' ? initial.dramaAssets.props : initial.globalProps) ?? []; }
    catch { initial.showToast?.(t('武器绑定无效，请重新选择'), 'error'); return false; }
    let expected = original;
    let accepted = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const assertCurrent = () => {
      assertDramaAssetWriteCurrent(options);
      if (controller.signal.aborted) throw new Error(t('角色或项目已变化，请重新选择武器'));
      const current = get();
      if (current.currentProjectId !== projectId || current.isCreatingProject || current.isReturningToStartPage
        || current.switchingProjectName !== null || (scope === 'project'
          && (current.projectLoadStatus !== 'ready' || !projectId || seriesOwnerId(current.projects, projectId) !== ownerId))) {
        throw new Error(t('角色或项目已变化，请重新选择武器'));
      }
      checkedCharacterWeapons({ ...original, weaponIds: ids }, scope === 'project' ? current.dramaAssets.props : current.globalProps);
      if (!configValuesEqual((scope === 'project' ? current.dramaAssets.characters : current.globalCharacters).find((character) => character.id === characterId), expected)) {
        throw new Error(t('角色或项目已变化，请重新选择武器'));
      }
    };
    const unsubscribe = api.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
    try {
      assertCurrent();
      if (scope === 'global') {
        await putGlobalCharacterWeapons(characterId, ids, { ...options, assertCurrent, signal: controller.signal });
        assertCurrent();
        unsubscribe();
        set((state) => ({ globalCharacters: state.globalCharacters.map((character) => character.id === characterId
          ? { ...character, weaponIds: ids, updatedAt: Date.now() } : character) }));
        return true;
      }
      const next = { ...original, weaponIds: ids, updatedAt: Date.now() };
      expected = next;
      set((state) => ({ dramaAssets: { ...state.dramaAssets,
        characters: state.dramaAssets.characters.map((character) => character.id === characterId ? next : character) } }));
      if (await get().saveCurrentProjectSilent() !== projectId) throw new Error(t('角色武器保存失败，请重试'));
      accepted = true;
      assertCurrent();
      return true;
    } catch {
      const current = get();
      if (!accepted && scope === 'project' && current.currentProjectId
        && seriesOwnerId(current.projects, current.currentProjectId) === ownerId) {
        set((state) => ({ dramaAssets: { ...state.dramaAssets, characters: state.dramaAssets.characters.map((character) =>
          character.id === characterId && character.weaponIds === ids
            ? { ...character, weaponIds: original.weaponIds } : character) } }));
      }
      if (!controller.signal.aborted) get().showToast?.(t('角色武器保存失败，请重试'), 'error');
      return false;
    } finally {
      unsubscribe();
      options.signal?.removeEventListener('abort', abort);
    }
  },

  saveCharacterCard: async (scope, character, options) => {
    if (scope !== 'project' && scope !== 'global') return false;
    const characters = scope === 'project' ? get().dramaAssets.characters : get().globalCharacters;
    const existing = characters.find((item) => item.id === character.id);
    try { character = { ...character, weaponIds: checkedCharacterWeapons(character,
      scope === 'project' ? get().dramaAssets.props : get().globalProps, existing) }; }
    catch { get().showToast?.(t('武器绑定无效，请重新选择'), 'error'); return false; }
    const normalized = syncCharacterPrimaryImage(normalizeDramaCharacter(existing
      ? { ...character, libraryOrder: existing.libraryOrder } : character));
    if (scope === 'project') {
      try { assertDramaAssetWriteCurrent(options); } catch { return false; }
      const current = get().dramaAssets;
      const exists = current.characters.some((item) => item.id === normalized.id);
      set({
        dramaAssets: {
          ...current,
          characters: exists
            ? current.characters.map((item) => item.id === normalized.id ? normalized : item)
            : [...current.characters, normalized],
        },
      });
      silentSave(get);
      return true;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options?.signal?.addEventListener('abort', abort, { once: true });
    const assertCurrent = () => {
      assertDramaAssetWriteCurrent(options);
      checkedCharacterWeapons(normalized, get().globalProps);
      const current = get().globalCharacters.find((item) => item.id === character.id);
      if (controller.signal.aborted || !sameCharacterContent(existing, current)) {
        throw new Error('角色已修改或删除，请重新保存');
      }
    };
    const unsubscribe = api.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
    try {
      assertCurrent();
      const persisted = await saveGlobalCharacterCard(normalized, { ...options, signal: controller.signal, assertCurrent });
      assertCurrent();
      unsubscribe();
      set((state) => ({
        globalCharacters: state.globalCharacters.some((item) => item.id === persisted.id)
          ? state.globalCharacters.map((item) => item.id === persisted.id
            ? { ...persisted, libraryOrder: item.libraryOrder } : item)
          : [persisted, ...state.globalCharacters],
      }));
      return true;
    } catch {
      if (!controller.signal.aborted && !options?.signal?.aborted) get().showToast?.('全局角色保存失败', 'error');
      return false;
    } finally {
      unsubscribe();
      options?.signal?.removeEventListener('abort', abort);
    }
  },

  addCharacterReferenceImage: async (scope, characterId, reference, options) => {
    const character = findScopedCharacter(get(), scope, characterId);
    if (!character) return false;
    const next = upsertCharacterReference(character, reference, options?.makePrimary === true);
    return get().saveCharacterCard(scope, next, options);
  },

  setCharacterAvatar: async (scope, characterId, referenceImageId, crop) => {
    const character = findScopedCharacter(get(), scope, characterId);
    if (!character?.referenceImages?.some((reference) => reference.id === referenceImageId)) {
      return false;
    }
    return get().saveCharacterCard(scope, normalizeDramaCharacter({
      ...character,
      avatarReferenceImageId: referenceImageId,
      avatarCrop: crop,
      updatedAt: Date.now(),
    }));
  },

  copyCharacterToGlobal: async (characterId) => {
    const character = get().dramaAssets.characters.find((item) => item.id === characterId);
    if (!character) return null;
    if (character.weaponIds?.length) { get().showToast?.(t('请使用资产复制入口一并复制角色武器'), 'info'); return null; }
    const copy = cloneCharacter(character);
    return await get().saveCharacterCard('global', copy) ? copy.id : null;
  },

  copyGlobalCharacterToProject: (characterId) => {
    const character = get().globalCharacters.find((item) => item.id === characterId);
    if (!character) return null;
    if (character.weaponIds?.length) { get().showToast?.(t('请使用资产复制入口一并复制角色武器'), 'info'); return null; }
    const copy = cloneCharacter(character);
    void get().saveCharacterCard('project', copy);
    return copy.id;
  },

  deleteGlobalCharacter: async (characterId, options) => {
    try {
      assertDramaAssetWriteCurrent(options);
      await deleteGlobalCharacterCard(characterId, options);
      assertDramaAssetWriteCurrent(options);
      set((state) => ({
        globalCharacters: state.globalCharacters.filter((item) => item.id !== characterId),
      }));
      get().releaseCharacterLibraryNodes('global', characterId);
      return true;
    } catch {
      if (!options?.signal?.aborted) get().showToast?.('全局角色删除失败', 'error');
      return false;
    }
  },

  clearGlobalCharacters: async () => {
    try {
      await clearGlobalCharacterCards();
      set({ globalCharacters: [] });
      get().releaseCharacterLibraryNodes('global');
      return true;
    } catch {
      get().showToast?.('全局角色清空失败', 'error');
      return false;
    }
  },

  captureImageNodeToCharacter: async (input) => {
    const initialState = get();
    const sourceNode = initialState.nodes.find((node) => node.id === input.nodeId);
    if (!sourceNode || !isEligibleCharacterReferenceNode(sourceNode)) {
      initialState.showToast?.('该节点没有可用的角色图片', 'error');
      return null;
    }
    const projectId = initialState.currentProjectId;
    if (!projectId) return null;

    const characters = input.scope === 'project'
      ? initialState.dramaAssets.characters
      : initialState.globalCharacters;
    const baseCharacter = input.characterId
      ? characters.find((character) => character.id === input.characterId)
      : input.newCharacter;
    if (!baseCharacter) {
      initialState.showToast?.('请选择角色', 'error');
      return null;
    }

    const previousLink = sourceNode.data.characterLibraryLinks?.find((link) => (
      link.scope === input.scope && link.characterId === baseCharacter.id && link.referenceImageId !== undefined
    ));
    const previousReference = baseCharacter.referenceImages?.find((reference) => (
      reference.id === previousLink?.referenceImageId
      || (input.scope === 'project' && reference.sourceNodeId === sourceNode.id)
    ));
    const now = Date.now();
    const reference: CharacterReferenceImage = {
      id: previousReference?.id ?? `reference-${generateId()}`,
      kind: input.kind,
      assetId: sourceNode.data.assetId,
      relativePath: sourceNode.data.relativePath,
      // 与节点共用同一份本地文件，不复制副本
      filePath: sourceNode.data.filePath,
      imageUrl: sourceNode.data.imageUrl ?? sourceNode.data.thumbnailUrl,
      sourceNodeId: sourceNode.id,
      prompt: input.prompt,
      createdAt: previousReference?.createdAt ?? now,
      updatedAt: now,
    };
    const nextCharacter = upsertCharacterReference(
      baseCharacter,
      reference,
      !baseCharacter.primaryReferenceImageId || input.kind === 'primary',
    );

    if (input.scope === 'project') {
      const previousLibrary = initialState.dramaAssets;
      const exists = previousLibrary.characters.some((item) => item.id === nextCharacter.id);
      set({
        dramaAssets: {
          ...previousLibrary,
          characters: exists
            ? previousLibrary.characters.map((item) => item.id === nextCharacter.id ? nextCharacter : item)
            : [...previousLibrary.characters, nextCharacter],
        },
      });
      const persistedProjectId = await get().saveCurrentProjectSilent();
      if (!persistedProjectId) {
        if (get().currentProjectId === projectId) set({ dramaAssets: previousLibrary });
        get().showToast?.('角色保存失败，画布节点保持显示', 'error');
        return null;
      }
    } else {
      try {
        const persisted = await saveGlobalCharacterCard(nextCharacter);
        set((state) => ({
          globalCharacters: state.globalCharacters.some((item) => item.id === persisted.id)
            ? state.globalCharacters.map((item) => item.id === persisted.id
              ? { ...persisted, libraryOrder: item.libraryOrder } : item)
            : [persisted, ...state.globalCharacters],
        }));
      } catch {
        get().showToast?.('全局角色保存失败，画布节点保持显示', 'error');
        return null;
      }
    }

    if (get().currentProjectId === projectId && get().nodes.some((node) => node.id === sourceNode.id)) {
      const link: CharacterLibraryNodeLink = {
        scope: input.scope,
        characterId: nextCharacter.id,
        referenceImageId: reference.id,
      };
      const linked = get().linkNodeToCharacter(sourceNode.id, link, input.hideNode);
      if (linked) void get().saveCurrentProjectSilent();
    }
    return { characterId: nextCharacter.id, referenceImageId: reference.id };
  },

  createImageNodeFromCharacterReference: (scope, characterId, referenceImageId) => {
    const state = get();
    const character = findScopedCharacter(state, scope, characterId);
    const reference = character?.referenceImages?.find((item) => item.id === referenceImageId);
    if (!character || !reference?.imageUrl) {
      state.showToast?.('参考图不可用', 'error');
      return null;
    }
    const linkedNode = state.nodes.find((node) => (
      node.id === reference.sourceNodeId
      || node.data.characterLibraryLinks?.some((link) => (
        link.scope === scope
        && link.characterId === characterId
        && link.referenceImageId === referenceImageId
      ))
    ));
    if (linkedNode) return linkedNode.id;

    const nodeId = `node-${generateId()}`;
    const link: CharacterLibraryNodeLink = { scope, characterId, referenceImageId };
    state.addNode({
      id: nodeId,
      type: 'source-image',
      position: pickSpawnPosition(state.nodes as Node<BaseNodeData>[]),
      data: {
        label: `${character.name} · 参考图`,
        type: 'source-image',
        role: 'source',
        status: 'success',
        prompt: reference.prompt,
        imageUrl: reference.imageUrl,
        thumbnailUrl: reference.imageUrl,
        assetId: reference.assetId,
        relativePath: reference.relativePath,
        filePath: reference.filePath,
        nodeWidth: 280,
        nodeHeight: 280,
        characterLibraryLinks: [link],
      },
    });
    if (scope === 'project') {
      void state.addCharacterReferenceImage('project', characterId, {
        ...reference,
        sourceNodeId: nodeId,
        updatedAt: Date.now(),
      });
    }
    return nodeId;
  },

  addCharacterVoiceClip: async (scope, characterId, clip, options) => {
    const character = findScopedCharacter(get(), scope, characterId);
    if (!character) return false;
    return get().saveCharacterCard(
      scope,
      upsertCharacterVoiceClip(character, clip, options?.makePrimary === true),
      options,
    );
  },

  updateCharacterVoiceClip: async (scope, characterId, clipId, patch, options) => {
    const character = findScopedCharacter(get(), scope, characterId);
    if (!character?.voiceClips?.some((clip) => clip.id === clipId)) return false;
    return get().saveCharacterCard(scope, normalizeDramaCharacter({
      ...character,
      voiceClips: character.voiceClips.map((clip) =>
        clip.id === clipId ? { ...clip, ...patch, updatedAt: Date.now() } : clip,
      ),
      updatedAt: Date.now(),
    }), options);
  },

  removeCharacterVoiceClip: async (scope, characterId, clipId, options) => {
    const state = get();
    const character = findScopedCharacter(state, scope, characterId);
    const clip = character?.voiceClips?.find((item) => item.id === clipId);
    if (!character || !clip) return false;
    const rest = (character.voiceClips ?? []).filter((item) => item.id !== clipId);
    const sourceNodeId = scope === 'project' ? clip.sourceNodeId : undefined;
    const guard = sourceNodeId ? registerCanvasDerivation(state, sourceNodeId) : null;
    try {
      const saved = await get().saveCharacterCard(scope, normalizeDramaCharacter({
        ...character,
        voiceClips: rest,
        primaryVoiceClipId: character.primaryVoiceClipId === clipId
          ? rest[0]?.id
          : character.primaryVoiceClipId,
        updatedAt: Date.now(),
      }), options);
      // 声音条目与来源节点共用素材，解除关联只恢复显隐，不删除节点、连线或文件。
      if (saved && sourceNodeId && guard && isCanvasDerivationFresh(guard, get())) {
        if (get().setCharacterLibraryNodeHidden(sourceNodeId, false)) silentSave(get);
      }
      return saved;
    } finally {
      if (guard) completeCanvasDerivation(guard);
    }
  },

  setCharacterPrimaryVoice: async (scope, characterId, clipId, options) => {
    const character = findScopedCharacter(get(), scope, characterId);
    if (!character?.voiceClips?.some((clip) => clip.id === clipId)) return false;
    return get().saveCharacterCard(scope, normalizeDramaCharacter({
      ...character,
      primaryVoiceClipId: clipId,
      updatedAt: Date.now(),
    }), options);
  },

  addCharacterAction: async (scope, characterId, action, capture) => {
    const character = findScopedCharacter(get(), scope, characterId);
    const name = action.name.trim();
    const prompt = action.prompt.trim();
    if (!character || !name) return null;
    const now = Date.now();
    const actionId = `action-${generateId()}`;
    const saved = await saveCharacterActionWithNode(set, get, scope, normalizeDramaCharacter({
      ...character,
      actions: [
        ...(character.actions ?? []),
        {
          id: actionId,
          category: action.category,
          customCategory: action.category === 'custom'
            ? action.customCategory?.trim() || undefined
            : undefined,
          name,
          prompt,
          media: action.media ?? [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }), actionId, action.media ?? [], capture);
    return saved ? actionId : null;
  },

  addCharacterActionMedia: async (scope, characterId, actionId, media, capture) => {
    if (media.length === 0) return false;
    const character = findScopedCharacter(get(), scope, characterId);
    if (!character?.actions?.some((action) => action.id === actionId)) return false;
    const now = Date.now();
    return saveCharacterActionWithNode(set, get, scope, normalizeDramaCharacter({
      ...character,
      actions: character.actions.map((action) => action.id === actionId
        ? {
            ...action,
            media: [...(action.media ?? []), ...media],
            updatedAt: now,
          }
        : action),
      updatedAt: now,
    }), actionId, media, capture);
  },

  removeCharacterActionMedia: async (scope, characterId, actionId, mediaId) => {
    const projectId = get().currentProjectId;
    const character = findScopedCharacter(get(), scope, characterId);
    const action = character?.actions?.find((item) => item.id === actionId);
    if (!character || !action?.media?.some((item) => item.id === mediaId)) return false;
    const now = Date.now();
    const saved = await get().saveCharacterCard(scope, normalizeDramaCharacter({
      ...character,
      actions: character.actions?.map((item) => item.id === actionId
        ? {
            ...item,
            media: item.media?.filter((mediaItem) => mediaItem.id !== mediaId),
            updatedAt: now,
          }
        : item),
      updatedAt: now,
    }));
    if (saved && get().currentProjectId === projectId) {
      get().releaseCharacterLibraryNodes(scope, characterId, actionId, mediaId);
      silentSave(get);
    }
    return saved;
  },

  removeCharacterAction: async (scope, characterId, actionId) => {
    const projectId = get().currentProjectId;
    const character = findScopedCharacter(get(), scope, characterId);
    if (!character?.actions?.some((action) => action.id === actionId)) return false;
    const saved = await get().saveCharacterCard(scope, normalizeDramaCharacter({
      ...character,
      actions: character.actions.filter((action) => action.id !== actionId),
      updatedAt: Date.now(),
    }));
    if (saved && get().currentProjectId === projectId) {
      get().releaseCharacterLibraryNodes(scope, characterId, actionId);
      silentSave(get);
    }
    return saved;
  },

  bindAudioNodeToCharacterVoice: async (input) => {
    const state = get();
    const sourceNode = state.nodes.find((node) => node.id === input.nodeId);
    if (!sourceNode || !isEligibleCharacterVoiceNode(sourceNode)) {
      state.showToast?.('该节点没有可用的音频', 'error');
      return null;
    }
    const character = findScopedCharacter(state, input.scope, input.characterId);
    if (!character) {
      state.showToast?.('请选择角色', 'error');
      return null;
    }

    const existing = character.voiceClips?.find((clip) => (
      (input.scope === 'project' && clip.sourceNodeId === sourceNode.id)
      || Boolean(sourceNode.data.assetId && clip.assetId === sourceNode.data.assetId)
    ));
    const now = Date.now();
    const clip: CharacterVoiceClip = {
      id: existing?.id ?? `voice-${generateId()}`,
      kind: input.kind ?? existing?.kind ?? 'timbre',
      label: input.label?.trim() || existing?.label || sourceNode.data.label || undefined,
      assetId: sourceNode.data.assetId,
      relativePath: sourceNode.data.relativePath,
      // 与节点共用同一份本地文件，不复制副本
      filePath: sourceNode.data.filePath,
      audioUrl: sourceNode.data.audioUrl,
      // 全局角色不保存项目节点 ID
      sourceNodeId: input.scope === 'project' ? sourceNode.id : undefined,
      transcript: input.transcript
        ?? existing?.transcript
        ?? (typeof sourceNode.data.prompt === 'string' ? sourceNode.data.prompt : ''),
      durationSec: input.durationSec ?? existing?.durationSec,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const guard = input.hideNode ? registerCanvasDerivation(state, sourceNode.id) : null;
    try {
      const saved = await get().addCharacterVoiceClip(input.scope, character.id, clip, {
        makePrimary: input.makePrimary === true,
      });
      if (saved && guard && isCanvasDerivationFresh(guard, get())) {
        if (get().setCharacterLibraryNodeHidden(sourceNode.id, true)) silentSave(get);
      }
      return saved ? clip.id : null;
    } finally {
      if (guard) completeCanvasDerivation(guard);
    }
  },

  createAudioNodeFromCharacterVoice: (scope, characterId, clipId) => {
    const state = get();
    const character = findScopedCharacter(state, scope, characterId);
    const clip = character?.voiceClips?.find((item) => item.id === clipId);
    if (!character || !clip?.audioUrl) {
      state.showToast?.('角色声音不可用', 'error');
      return null;
    }
    const linkedNode = clip.sourceNodeId
      ? state.nodes.find((node) => node.id === clip.sourceNodeId)
      : undefined;
    if (linkedNode) return linkedNode.id;

    const nodeId = `node-${generateId()}`;
    state.addNode({
      id: nodeId,
      type: 'source-audio',
      position: pickSpawnPosition(state.nodes as Node<BaseNodeData>[]),
      data: {
        label: `${character.name} · ${clip.label?.trim() || '角色声音'}`,
        type: 'source-audio',
        role: 'source',
        status: 'success',
        prompt: clip.transcript,
        audioUrl: clip.audioUrl,
        assetId: clip.assetId,
        relativePath: clip.relativePath,
        filePath: clip.filePath,
        nodeWidth: 260,
        nodeHeight: 160,
      },
    });
    if (scope === 'project' && clip.sourceNodeId) {
      void state.addCharacterVoiceClip('project', characterId, {
        ...clip,
        sourceNodeId: nodeId,
        updatedAt: Date.now(),
      });
    }
    return nodeId;
  },

  createVoiceOverNodeFromCharacterVoice: (scope, characterId, clipId) => {
    const voiceNodeId = get().createAudioNodeFromCharacterVoice(scope, characterId, clipId);
    if (!voiceNodeId) return null;

    const state = get();
    const character = findScopedCharacter(state, scope, characterId);
    if (!character) return null;
    const clip = character.voiceClips?.find((item) => item.id === clipId);
    const voiceNode = state.nodes.find((node) => node.id === voiceNodeId);

    const nodeId = `node-${generateId()}`;
    const position = voiceNode
      ? { x: voiceNode.position.x + 340, y: voiceNode.position.y }
      : pickSpawnPosition(state.nodes as Node<BaseNodeData>[]);
    const newNode: Node<BaseNodeData> = {
      id: nodeId,
      type: 'ai-audio',
      position,
      data: {
        label: `${character.name} · 配音`,
        type: 'ai-audio',
        role: 'generator',
        status: 'idle',
        prompt: clip?.transcript ?? '',
        audioPurpose: 'speech',
        nodeWidth: 260,
        nodeHeight: 160,
      },
    };

    // 回填本地偏好模型（与侧栏添加音频节点一致）
    try {
      const raw = localStorage.getItem('canvas-model-prefs');
      if (raw) {
        const prefs: Record<string, string> = JSON.parse(raw);
        const modelValue = prefs['ai-audio'];
        if (modelValue && modelValue.includes('::')) {
          const [provider, model] = modelValue.split('::');
          if (provider && model) {
            newNode.data.provider = provider;
            newNode.data.model = model;
          }
        }
      }
    } catch { /* ignore */ }

    state.addNode(newNode);
    // 连线即引用：生成音频时这条线上的声音会作为音色参考
    // 句柄留空时 React Flow 会挑到两端各自的第一个（左）句柄，画出「左连左」的错线
    state.onConnect({
      source: voiceNodeId,
      target: nodeId,
      sourceHandle: 'right',
      targetHandle: 'left',
    });
    return nodeId;
  },
  });
};
