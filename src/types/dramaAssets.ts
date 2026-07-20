/**
 * 短剧资产提取 — 人物 / 场景 / 道具（简介级）
 * 详见 doc/plans/2026-07-20-drama-asset-extract-schema.md
 */

export type DramaAssetKind = 'character' | 'scene' | 'prop';
export type DramaAssetImportance = 'main' | 'supporting' | 'minor';
export type DramaAssetSource = 'ai' | 'manual' | 'merge';

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
  version: 1;
  lastExtract?: DramaExtractMeta;
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
  return { version: 1, characters: [], scenes: [], props: [] };
}

/** @ 引用短剧资产标记：@drama{id:name} */
export const DRAMA_MENTION_PREFIX = '@drama{';

export function formatDramaMention(id: string, name: string): string {
  return `@drama{${id}:${name}}`;
}
