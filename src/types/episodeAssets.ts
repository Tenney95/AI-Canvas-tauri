/** 本集提取清单与正式创作资产分开保存；绑定只指向所属剧集的业务卡片 ID。 */
import type { CanvasProject } from './index';
import type { DramaAssetLibrary, DramaCharacter, DramaScene, DramaProp } from './dramaAssets';

export type EpisodeAssetKind = 'character' | 'scene' | 'prop';

export interface EpisodeAssetPickerSnapshot {
  library: DramaAssetLibrary;
  globalCharacters: DramaCharacter[];
  globalScenes?: DramaScene[];
  globalProps: DramaProp[];
  nodes: Array<{ id: string; data?: Record<string, unknown> }>;
}

export interface EpisodeAssetPanelSnapshot extends EpisodeAssetPickerSnapshot {
  episode: Pick<CanvasProject, 'id' | 'parentId' | 'name' | 'episodeScript' | 'episodeAssetRoster'> | null;
  ready: boolean;
}

export type EpisodeAssetPanelAction =
  | { type: 'extract' }
  | { type: 'load-global' }
  | { type: 'save-entry'; entry: EpisodeAssetEntry; expectedRevision: number }
  | { type: 'remove-entry'; entryId: string; expectedRevision: number }
  | { type: 'bind'; entryId: string; targetId: string | null; scope: 'project' | 'global'; expectedRevision: number }
  | { type: 'add-library'; targetId: string; scope: 'project' | 'global'; expectedRevision: number }
  | { type: 'promote'; entryIds: string[] }
  | { type: 'merge-candidates'; candidateIds: string[]; expectedRevision: number; fingerprint: string };

export type EpisodeAssetPanelActionResult =
  | { type: 'candidates'; items: EpisodeAssetEntry[]; revision: number; fingerprint: string }
  | { type: 'updated'; count?: number };

export interface EpisodeAssetEntry {
  id: string;
  kind: EpisodeAssetKind;
  name: string;
  summary: string;
  visualNotes: string;
  notes: string;
  aliases?: string[];
  appearances?: string[];
  evidence?: string;
  identity?: string;
  ownerName?: string;
  /** DramaAsset.id；不是本机媒体索引的 assetId，也不接受 global/ 引用。 */
  boundDramaAssetId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EpisodeAssetRoster {
  version: 1;
  revision: number;
  characters: EpisodeAssetEntry[];
  /** 可选增量字段；旧记录缺省为空，不改变旧清单的持久化形状。 */
  scenes?: EpisodeAssetEntry[];
  props: EpisodeAssetEntry[];
  sourceFingerprints?: Partial<Record<EpisodeAssetKind, string>>;
}

export const EPISODE_ASSET_LIMITS = {
  entriesPerKind: 300,
  name: 240,
  summary: 6000,
  visualNotes: 6000,
  notes: 4000,
  evidence: 4000,
  identity: 2000,
  aliases: 32,
  appearances: 64,
} as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function emptyEpisodeAssetRoster(): EpisodeAssetRoster {
  return { version: 1, revision: 0, characters: [], props: [] };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}

/** 只读自有数据属性；外部对象的访问器或继承字段不能参与归一化。 */
function own(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function textList(value: unknown, count: number): string[] | undefined {
  if (!Array.isArray(value)) return;
  const values = [...new Set(value.slice(0, count).map((entry) => text(entry, EPISODE_ASSET_LIMITS.name)).filter(Boolean))];
  return values.length ? values : undefined;
}

/** 不复制模型/归档中的额外属性、媒体、作用域、原型或运行时对象。 */
export function normalizeEpisodeAssetRoster(value: unknown): EpisodeAssetRoster {
  const source = plainRecord(value);
  if (!source || own(source, 'version') !== 1) return emptyEpisodeAssetRoster();
  const seen = new Set<string>();
  const entries = (key: 'characters' | 'scenes' | 'props', kind: EpisodeAssetKind): EpisodeAssetEntry[] => {
    const list = own(source, key);
    if (!Array.isArray(list)) return [];
    const result: EpisodeAssetEntry[] = [];
    for (const raw of list.slice(0, EPISODE_ASSET_LIMITS.entriesPerKind)) {
      const item = plainRecord(raw);
      if (!item || own(item, 'kind') !== kind) continue;
      const id = own(item, 'id');
      const name = text(own(item, 'name'), EPISODE_ASSET_LIMITS.name);
      if (typeof id !== 'string' || !ID.test(id) || !name || seen.has(id)) continue;
      seen.add(id);
      const createdAt = timestamp(own(item, 'createdAt'), 0);
      const entry: EpisodeAssetEntry = {
        id, kind, name,
        summary: text(own(item, 'summary'), EPISODE_ASSET_LIMITS.summary),
        visualNotes: text(own(item, 'visualNotes'), EPISODE_ASSET_LIMITS.visualNotes),
        notes: text(own(item, 'notes'), EPISODE_ASSET_LIMITS.notes),
        createdAt,
        updatedAt: Math.max(createdAt, timestamp(own(item, 'updatedAt'), createdAt)),
      };
      const aliases = textList(own(item, 'aliases'), EPISODE_ASSET_LIMITS.aliases);
      const appearances = textList(own(item, 'appearances'), EPISODE_ASSET_LIMITS.appearances);
      const evidence = text(own(item, 'evidence'), EPISODE_ASSET_LIMITS.evidence);
      const identity = kind === 'character' ? text(own(item, 'identity'), EPISODE_ASSET_LIMITS.identity) : '';
      const ownerName = kind === 'prop' ? text(own(item, 'ownerName'), EPISODE_ASSET_LIMITS.name) : '';
      const boundId = own(item, 'boundDramaAssetId');
      if (aliases) entry.aliases = aliases;
      if (appearances) entry.appearances = appearances;
      if (evidence) entry.evidence = evidence;
      if (identity) entry.identity = identity;
      if (ownerName) entry.ownerName = ownerName;
      if (typeof boundId === 'string' && ID.test(boundId)) entry.boundDramaAssetId = boundId;
      result.push(entry);
    }
    return result;
  };
  const result: EpisodeAssetRoster = {
    version: 1,
    revision: timestamp(own(source, 'revision'), 0),
    characters: entries('characters', 'character'),
    props: entries('props', 'prop'),
  };
  if (own(source, 'scenes') !== undefined) result.scenes = entries('scenes', 'scene');
  const fingerprints = plainRecord(own(source, 'sourceFingerprints'));
  if (fingerprints) {
    for (const kind of ['character', 'scene', 'prop'] as const) {
      const fingerprint = own(fingerprints, kind);
      if (typeof fingerprint === 'string' && /^v1-[0-9a-f]+-[0-9a-f]{16}$/.test(fingerprint) && fingerprint.length <= 64) {
        (result.sourceFingerprints ??= {})[kind] = fingerprint;
      }
    }
  }
  return result;
}

/** 确定性正文版本指纹，只用于拒绝过期提取，不作为文件/资产身份或安全摘要。 */
export function episodeScriptFingerprint(script: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < script.length; index += 1) {
    const code = script.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return `v1-${script.length.toString(16)}-${hex(first)}${hex(second)}`;
}
