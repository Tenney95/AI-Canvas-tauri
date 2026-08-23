/**
 * 短剧资产提取 — 人物 / 场景 / 道具（简介级）
 * 详见 doc/plans/2026-07-20-drama-asset-extract-schema.md
 */

export type DramaAssetKind = 'character' | 'scene' | 'prop';
export type DramaAssetImportance = 'main' | 'supporting' | 'minor';
export type DramaAssetSource = 'ai' | 'manual' | 'merge';

export type CharacterReferenceKind =
  | 'primary'
  | 'avatar'
  | 'full_body'
  | 'expression'
  | 'turnaround'
  | 'outfit'
  | 'other';

export type CharacterVoiceKind =
  | 'timbre'
  | 'line'
  | 'emotion'
  | 'other';

export type CharacterActionCategory =
  | 'standing'
  | 'walking'
  | 'running'
  | 'jumping'
  | 'sitting'
  | 'crouching'
  | 'lying'
  | 'climbing'
  | 'swimming'
  | 'attacking'
  | 'defending'
  | 'hit'
  | 'death'
  | 'casting'
  | 'interacting'
  | 'dancing'
  | 'expression'
  | 'custom';

export type CharacterActionMediaKind = 'image' | 'gif' | 'video';

/** 头像裁剪区域，坐标与尺寸均为相对原图的 0-1 值。 */
export interface CharacterCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CharacterReferenceImage {
  id: string;
  kind: CharacterReferenceKind;
  assetId?: string;
  relativePath?: string;
  /** 运行期本地绝对路径；保存项目时与画布节点一样收敛为 assetId + relativePath */
  filePath?: string;
  imageUrl?: string;
  /** 仅项目角色可关联来源节点；全局角色不得依赖该字段。 */
  sourceNodeId?: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

/** 角色声音片段：上传的音频文件或画布音频节点的产物。 */
export interface CharacterVoiceClip {
  id: string;
  kind: CharacterVoiceKind;
  /** 展示名，缺省时回退到用途标签 */
  label?: string;
  assetId?: string;
  relativePath?: string;
  /** 运行期本地绝对路径；保存项目时与画布节点一样收敛为 assetId + relativePath */
  filePath?: string;
  audioUrl?: string;
  /** 仅项目角色可关联来源节点；全局角色不得依赖该字段。 */
  sourceNodeId?: string;
  /** 台词文本或音色描述 */
  transcript: string;
  /** 音频时长（秒），读取失败时缺省 */
  durationSec?: number;
  createdAt: number;
  updatedAt: number;
}

/** 单个动作可绑定多份静态图片、GIF 或视频素材。 */
export interface CharacterActionMedia {
  id: string;
  kind: CharacterActionMediaKind;
  name: string;
  mimeType?: string;
  assetId?: string;
  relativePath?: string;
  /** 运行期本地绝对路径；全局角色保存时必须剥离。 */
  filePath?: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

/** 绑定在角色卡上的动作定义，可作为后续图像/视频生成的动作提示词。 */
export interface CharacterAction {
  id: string;
  category: CharacterActionCategory;
  /** 自定义分类的显示名；预置分类不使用该字段。 */
  customCategory?: string;
  name: string;
  prompt: string;
  media?: CharacterActionMedia[];
  createdAt: number;
  updatedAt: number;
}

export interface DramaAssetBase {
  id: string;
  name: string;
  key: string;
  summary: string;
  visualNotes: string;
  storyRole?: string;
  importance: DramaAssetImportance;
  firstSeen?: string;
  appearances?: string[];
  imageNodeId?: string;
  imageUrl?: string;
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
  source: DramaAssetSource;
}

export interface DramaCharacter extends DramaAssetBase {
  kind: 'character';
  aliases?: string[];
  identity: string;
  ageBand?: string;
  gender?: string;
  personality?: string;
  relationships?: Array<{ targetName: string; relation: string }>;
  wardrobeDefault?: string;
  /** 音色 / 口音 / 语速等声音特征，供 TTS 与配音提示词使用 */
  voiceNotes?: string;
  referenceImages?: CharacterReferenceImage[];
  primaryReferenceImageId?: string;
  avatarReferenceImageId?: string;
  avatarCrop?: CharacterCropRect;
  voiceClips?: CharacterVoiceClip[];
  /** 主音色片段 id，配音与音色参考默认取它 */
  primaryVoiceClipId?: string;
  /** 与角色绑定的动作库。 */
  actions?: CharacterAction[];
}

export interface DramaScene extends DramaAssetBase {
  kind: 'scene';
  placeType?: string;
  timeOfDay?: string;
  atmosphere?: string;
  spatialNotes?: string;
}

export interface DramaProp extends DramaAssetBase {
  kind: 'prop';
  ownerName?: string;
  category?: string;
  significance?: string;
}

export type DramaAsset = DramaCharacter | DramaScene | DramaProp;

/** 模型提取响应（未补客户端字段前） */
export interface DramaExtractModelResponse {
  kind: DramaAssetKind;
  items: Array<Record<string, unknown>>;
  notes?: string;
}

export interface DramaExtractMeta {
  at: number;
  sourceNodeId?: string;
  scopeNote?: string;
  modelId?: string;
  kinds: DramaAssetKind[];
}

export interface DramaAssetLibrary {
  version: 2;
  lastExtract?: DramaExtractMeta;
  /** 用户最近一次打开资产管理「短剧资产」页签的时间。 */
  lastViewedAt?: number;
  characters: DramaCharacter[];
  scenes: DramaScene[];
  props: DramaProp[];
}

export const DRAMA_ASSET_KIND_LABEL: Record<DramaAssetKind, string> = {
  character: '人物',
  scene: '场景',
  prop: '道具',
};

/** 提示词中的标记，生成完成后用于识别并格式化输出 */
export const DRAMA_EXTRACT_MARKER: Record<DramaAssetKind, string> = {
  character: '[[DRAMA_EXTRACT:character]]',
  scene: '[[DRAMA_EXTRACT:scene]]',
  prop: '[[DRAMA_EXTRACT:prop]]',
};

export function emptyDramaAssetLibrary(): DramaAssetLibrary {
  return { version: 2, characters: [], scenes: [], props: [] };
}

const CHARACTER_REFERENCE_KINDS = new Set<CharacterReferenceKind>([
  'primary',
  'avatar',
  'full_body',
  'expression',
  'turnaround',
  'outfit',
  'other',
]);

const CHARACTER_VOICE_KINDS = new Set<CharacterVoiceKind>([
  'timbre',
  'line',
  'emotion',
  'other',
]);

const CHARACTER_ACTION_CATEGORIES = new Set<CharacterActionCategory>([
  'standing',
  'walking',
  'running',
  'jumping',
  'sitting',
  'crouching',
  'lying',
  'climbing',
  'swimming',
  'attacking',
  'defending',
  'hit',
  'death',
  'casting',
  'interacting',
  'dancing',
  'expression',
  'custom',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeCropRect(value: unknown): CharacterCropRect | undefined {
  const crop = asRecord(value);
  if (!crop) return undefined;
  const clamp = (number: number) => Math.min(1, Math.max(0, number));
  const x = clamp(finiteNumber(crop.x, 0));
  const y = clamp(finiteNumber(crop.y, 0));
  const width = clamp(finiteNumber(crop.width, 1));
  const height = clamp(finiteNumber(crop.height, 1));
  if (width <= 0 || height <= 0) return undefined;
  return {
    x: Math.min(x, 1 - width),
    y: Math.min(y, 1 - height),
    width,
    height,
  };
}

function normalizeReferenceImage(
  value: unknown,
  characterId: string,
  index: number,
  fallbackTime: number,
): CharacterReferenceImage | null {
  const reference = asRecord(value);
  if (!reference) return null;
  const imageUrl = typeof reference.imageUrl === 'string' ? reference.imageUrl : undefined;
  const assetId = typeof reference.assetId === 'string' ? reference.assetId : undefined;
  const relativePath = typeof reference.relativePath === 'string' ? reference.relativePath : undefined;
  const filePath = typeof reference.filePath === 'string' ? reference.filePath : undefined;
  const sourceNodeId = typeof reference.sourceNodeId === 'string' ? reference.sourceNodeId : undefined;
  if (!imageUrl && !assetId && !relativePath && !filePath && !sourceNodeId) return null;
  const rawKind = typeof reference.kind === 'string' ? reference.kind : '';
  const kind = CHARACTER_REFERENCE_KINDS.has(rawKind as CharacterReferenceKind)
    ? rawKind as CharacterReferenceKind
    : 'other';
  return {
    id: typeof reference.id === 'string' && reference.id.trim()
      ? reference.id
      : `ref-${characterId}-${index}`,
    kind,
    assetId,
    relativePath,
    filePath,
    imageUrl,
    sourceNodeId,
    prompt: typeof reference.prompt === 'string' ? reference.prompt : '',
    createdAt: finiteNumber(reference.createdAt, fallbackTime),
    updatedAt: finiteNumber(reference.updatedAt, fallbackTime),
  };
}

function normalizeVoiceClip(
  value: unknown,
  characterId: string,
  index: number,
  fallbackTime: number,
): CharacterVoiceClip | null {
  const clip = asRecord(value);
  if (!clip) return null;
  const audioUrl = typeof clip.audioUrl === 'string' ? clip.audioUrl : undefined;
  const assetId = typeof clip.assetId === 'string' ? clip.assetId : undefined;
  const relativePath = typeof clip.relativePath === 'string' ? clip.relativePath : undefined;
  const filePath = typeof clip.filePath === 'string' ? clip.filePath : undefined;
  const sourceNodeId = typeof clip.sourceNodeId === 'string' ? clip.sourceNodeId : undefined;
  if (!audioUrl && !assetId && !relativePath && !filePath && !sourceNodeId) return null;
  const rawKind = typeof clip.kind === 'string' ? clip.kind : '';
  const kind = CHARACTER_VOICE_KINDS.has(rawKind as CharacterVoiceKind)
    ? rawKind as CharacterVoiceKind
    : 'other';
  const durationSec = typeof clip.durationSec === 'number' && Number.isFinite(clip.durationSec)
    && clip.durationSec > 0
    ? clip.durationSec
    : undefined;
  const label = typeof clip.label === 'string' && clip.label.trim() ? clip.label : undefined;
  return {
    id: typeof clip.id === 'string' && clip.id.trim() ? clip.id : `voice-${characterId}-${index}`,
    kind,
    label,
    assetId,
    relativePath,
    filePath,
    audioUrl,
    sourceNodeId,
    transcript: typeof clip.transcript === 'string' ? clip.transcript : '',
    durationSec,
    createdAt: finiteNumber(clip.createdAt, fallbackTime),
    updatedAt: finiteNumber(clip.updatedAt, fallbackTime),
  };
}

function normalizeCharacterAction(
  value: unknown,
  characterId: string,
  index: number,
  fallbackTime: number,
): CharacterAction | null {
  const action = asRecord(value);
  if (!action) return null;
  const rawCategory = typeof action.category === 'string' ? action.category : '';
  const category = CHARACTER_ACTION_CATEGORIES.has(rawCategory as CharacterActionCategory)
    ? rawCategory as CharacterActionCategory
    : 'custom';
  const name = typeof action.name === 'string' ? action.name.trim() : '';
  const prompt = typeof action.prompt === 'string' ? action.prompt.trim() : '';
  if (!name && !prompt) return null;
  const customCategory = category === 'custom' && typeof action.customCategory === 'string'
    ? action.customCategory.trim() || undefined
    : undefined;
  const media = (Array.isArray(action.media) ? action.media : [])
    .map((value, mediaIndex): CharacterActionMedia | null => {
      const item = asRecord(value);
      if (!item) return null;
      const url = typeof item.url === 'string' ? item.url : undefined;
      const assetId = typeof item.assetId === 'string' ? item.assetId : undefined;
      const relativePath = typeof item.relativePath === 'string' ? item.relativePath : undefined;
      const filePath = typeof item.filePath === 'string' ? item.filePath : undefined;
      if (!url && !assetId && !relativePath && !filePath) return null;
      const rawKind = item.kind === 'image' || item.kind === 'gif' || item.kind === 'video'
        ? item.kind
        : undefined;
      const mimeType = typeof item.mimeType === 'string' ? item.mimeType : undefined;
      const kind: CharacterActionMediaKind = rawKind
        ?? (mimeType?.startsWith('video/')
          ? 'video'
          : mimeType === 'image/gif'
            ? 'gif'
            : 'image');
      const mediaId = typeof item.id === 'string' && item.id.trim()
        ? item.id
        : `action-media-${characterId}-${index}-${mediaIndex}`;
      return {
        id: mediaId,
        kind,
        name: typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : `${kind === 'video' ? '视频' : kind === 'gif' ? '动图' : '图片'} ${mediaIndex + 1}`,
        mimeType,
        assetId,
        relativePath,
        filePath,
        url,
        createdAt: finiteNumber(item.createdAt, fallbackTime),
        updatedAt: finiteNumber(item.updatedAt, fallbackTime),
      };
    })
    .filter((item): item is CharacterActionMedia => item !== null);
  return {
    id: typeof action.id === 'string' && action.id.trim()
      ? action.id
      : `action-${characterId}-${index}`,
    category,
    customCategory,
    name: name || prompt,
    prompt,
    media,
    createdAt: finiteNumber(action.createdAt, fallbackTime),
    updatedAt: finiteNumber(action.updatedAt, fallbackTime),
  };
}

export function normalizeDramaCharacter(character: DramaCharacter): DramaCharacter {
  const rawReferences = Array.isArray(character.referenceImages)
    ? character.referenceImages
    : [];
  const referenceImages = rawReferences
    .map((reference, index) => normalizeReferenceImage(
      reference,
      character.id,
      index,
      character.updatedAt || character.createdAt,
    ))
    .filter((reference): reference is CharacterReferenceImage => reference !== null);

  if (referenceImages.length === 0 && (character.imageNodeId || character.imageUrl)) {
    referenceImages.push({
      id: `ref-${character.id}-legacy`,
      kind: 'primary',
      imageUrl: character.imageUrl,
      sourceNodeId: character.imageNodeId,
      prompt: '',
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
    });
  }

  const referenceIds = new Set(referenceImages.map((reference) => reference.id));
  const primaryReferenceImageId = character.primaryReferenceImageId
    && referenceIds.has(character.primaryReferenceImageId)
    ? character.primaryReferenceImageId
    : referenceImages[0]?.id;
  const avatarReferenceImageId = character.avatarReferenceImageId
    && referenceIds.has(character.avatarReferenceImageId)
    ? character.avatarReferenceImageId
    : referenceImages.find((reference) => reference.kind === 'avatar')?.id;

  const voiceClips = (Array.isArray(character.voiceClips) ? character.voiceClips : [])
    .map((clip, index) => normalizeVoiceClip(
      clip,
      character.id,
      index,
      character.updatedAt || character.createdAt,
    ))
    .filter((clip): clip is CharacterVoiceClip => clip !== null);
  const voiceClipIds = new Set(voiceClips.map((clip) => clip.id));
  const primaryVoiceClipId = character.primaryVoiceClipId
    && voiceClipIds.has(character.primaryVoiceClipId)
    ? character.primaryVoiceClipId
    : voiceClips[0]?.id;
  const actions = (Array.isArray(character.actions) ? character.actions : [])
    .map((action, index) => normalizeCharacterAction(
      action,
      character.id,
      index,
      character.updatedAt || character.createdAt,
    ))
    .filter((action): action is CharacterAction => action !== null);

  return {
    ...character,
    referenceImages,
    primaryReferenceImageId,
    avatarReferenceImageId,
    avatarCrop: avatarReferenceImageId ? normalizeCropRect(character.avatarCrop) : undefined,
    voiceClips,
    primaryVoiceClipId,
    actions,
  };
}

/** 将持久化的旧版或部分损坏数据收敛为当前可用的 v2 结构。 */
export function normalizeDramaAssetLibrary(value: unknown): DramaAssetLibrary {
  const library = asRecord(value);
  if (!library) return emptyDramaAssetLibrary();
  const characters = Array.isArray(library.characters)
    ? (library.characters as DramaCharacter[]).map(normalizeDramaCharacter)
    : [];
  const scenes = Array.isArray(library.scenes) ? library.scenes as DramaScene[] : [];
  const props = Array.isArray(library.props) ? library.props as DramaProp[] : [];
  return {
    version: 2,
    lastExtract: asRecord(library.lastExtract)
      ? library.lastExtract as unknown as DramaExtractMeta
      : undefined,
    lastViewedAt: finiteNumber(library.lastViewedAt, 0) || undefined,
    characters,
    scenes,
    props,
  };
}

export function formatDramaMention(id: string, name: string): string {
  return `@drama{${id}:${name}}`;
}

/** 角色多参考图时的选图后缀：`资产id#参考图id`，`#all` 表示拼成一张 */
export const DRAMA_MENTION_MERGE_ALL = 'all';

export function buildDramaMentionId(assetId: string, pick?: string): string {
  return pick ? `${assetId}#${pick}` : assetId;
}

export function parseDramaMentionId(raw: string): {
  assetId: string;
  referenceImageId?: string;
  mergeAll: boolean;
} {
  const separator = raw.indexOf('#');
  if (separator < 0) return { assetId: raw, mergeAll: false };
  const pick = raw.slice(separator + 1);
  return {
    assetId: raw.slice(0, separator),
    referenceImageId: pick === DRAMA_MENTION_MERGE_ALL ? undefined : pick,
    mergeAll: pick === DRAMA_MENTION_MERGE_ALL,
  };
}
