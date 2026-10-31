/**
 * indexedDbService IndexedDB 持久化服务 — 浏览器端本地存储，保存项目、工作流、应用配置等数据
 */
import type { HistoryQuery } from '../types';
import { matchesHistoryQuery } from '../utils/historyQuery';
import type { AgentMode, AgentTask } from '../types/agent';
import type { ConversationContextSummary } from '../types/chat';
import type { ProjectMemory } from '../types/memory';
import type { DramaAsset, DramaAssetWriteOptions, DramaCharacter, DramaProp, DramaScene } from '../types/dramaAssets';
import { assertDramaAssetWriteCurrent, MAX_CHARACTER_WEAPONS, normalizeCharacterWeaponIds } from '../types/dramaAssets';
import { t } from '../i18n';
import type { ProjectVisualDescription } from '../types/visualMemory';
import type { AssetUsageRecord } from '../types/assetUsage';
import { StorageError } from './storageDiagnostics';
import { configValuesEqual } from './configPatch';
import { createDurableSettingsTransaction } from './indexedDb/catalogRepository';
import {
  openDB,
  STORE_AGENT_TASKS,
  STORE_ASSET_INDEX,
  STORE_ASSET_META,
  STORE_ASSET_META_V2,
  STORE_CHAT_CONVERSATIONS,
  STORE_CHAT_MESSAGES,
  STORE_GLOBAL_CHARACTERS,
  STORE_GLOBAL_DRAMA_ASSETS,
  STORE_HISTORY,
  STORE_METADATA,
  STORE_PROJECT_MEMORIES,
  STORE_PROJECT_VISUAL_DESCRIPTIONS,
  STORE_PROJECT_SUMMARIES,
  STORE_PROJECTS,
  STORE_PROJECT_EXCHANGE_STATES,
  STORE_TOOLBAR_LAYOUTS,
} from './indexedDb/schema';
import {
  toProjectSummaryRecord,
  type ProjectSummaryRecord,
} from './indexedDb/projectSummary';

import { withRelocatedMedia } from './indexedDb/mediaRelocations';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import { stripVerbatimPrefix } from './fs/core';
import { isProjectSnapshotDataUrl } from './projectSnapshotValidation';

const LAST_ACTIVE_PROJECT_KEY = 'last-active-project';
const RECENT_ASSET_USAGE_KEY = 'recent-asset-usage';
const MAX_RECENT_ASSET_USAGE = 10;
const FORGOTTEN_ASSET_PREFIX = 'forgotten-missing-asset:';
const FORGOTTEN_PATH_PREFIX = 'forgotten-missing-path:';
const FORGOTTEN_HISTORY_PREFIX = 'forgotten-missing-history:';
const forgottenAssetKey = (assetId: string) => `${FORGOTTEN_ASSET_PREFIX}${encodeURIComponent(assetId)}`;
const forgottenPathKey = (path: string) => `${FORGOTTEN_PATH_PREFIX}${encodeURIComponent(path)}`;
const forgottenHistoryKey = (historyId: string) => `${FORGOTTEN_HISTORY_PREFIX}${encodeURIComponent(historyId)}`;
const MEDIA_HISTORY_TYPES = new Set(['ai-image', 'ai-animation', 'ai-panorama', 'ai-storyboard', 'ai-video', 'ai-audio',
  'source-image', 'source-video', 'source-audio']);

function cleanupTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = value && typeof value === 'object' && 'forgottenAt' in value ? value.forgottenAt : undefined;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error('失效素材清理记录无效，请检查存储');
  }
  return timestamp;
}

/** Old identities stay retired; an explicit new import receives an independent asset ID. */
export function withActiveAsset(tx: IDBTransaction, assetId: string, write: () => void, onForgotten: () => void): void {
  const request = tx.objectStore(STORE_METADATA).get(forgottenAssetKey(assetId));
  request.onsuccess = () => {
    if (request.result !== undefined) {
      onForgotten();
      try { tx.abort(); } catch { /* 调用方可能已经中止事务。 */ }
      return;
    }
    write();
  };
}

/** Only output identity fields count; prompt text and input/reference fields are never matched. */
function historyOutputKeys(record: HistoryRecord): string[] {
  const localKey = (reference: string | undefined) => {
    if (typeof reference !== 'string' || !reference.trim()) return undefined;
    const path = localMediaUrlToPath(reference) ?? reference;
    if (!/^[a-z]:[/\\]/i.test(path) && !path.startsWith('/') && !path.startsWith('\\\\')) return undefined;
    return imageHistoryReferenceKey(path);
  };
  // A saved copy owns its history even when its original remote/output URL is shared.
  if (typeof record.filePath === 'string' && record.filePath.trim()) {
    const path = localKey(record.filePath);
    return path ? [path] : [];
  }
  return [...new Set([record.mediaUrl, MEDIA_HISTORY_TYPES.has(record.nodeType) ? record.output : undefined]
    .map(localKey).filter((key): key is string => !!key))];
}

function withActiveHistory(tx: IDBTransaction, records: readonly HistoryRecord[], write: (active: HistoryRecord[]) => void): void {
  const paths = [...new Set(records.flatMap(historyOutputKeys))];
  const historyIds = [...new Set(records.map((record) => record.id))];
  if (!paths.length && !historyIds.length) { write([]); return; }
  const cutoffs = new Map<string, number>();
  const forgotten = new Set<string>();
  let remaining = paths.length + historyIds.length;
  const finish = () => {
    if (--remaining !== 0) return;
    write(records.filter((record) => !forgotten.has(record.id) && historyOutputKeys(record)
      .every((key) => !cutoffs.has(key) || record.timestamp > cutoffs.get(key)!)));
  };
  for (const historyId of historyIds) {
    const request = tx.objectStore(STORE_METADATA).get(forgottenHistoryKey(historyId));
    request.onsuccess = () => {
      if (request.result !== undefined) forgotten.add(historyId);
      finish();
    };
  }
  for (const path of paths) {
    const request = tx.objectStore(STORE_METADATA).get(forgottenPathKey(path));
    request.onsuccess = () => {
      try {
        const cutoff = cleanupTimestamp(request.result);
        if (cutoff !== undefined) cutoffs.set(path, cutoff);
        finish();
      } catch { tx.abort(); }
    };
  }
}

/** A cleared path must not recover its old prompt from an unchanged canvas node. */
export async function getAssetCleanupTime(references: readonly string[], signal?: AbortSignal): Promise<number | undefined> {
  signal?.throwIfAborted();
  const paths = [...new Set(references.map(imageHistoryReferenceKey).filter((key): key is string => !!key))];
  if (!paths.length) return undefined;
  const db = await openDB();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    let latest: number | undefined;
    let failure: unknown;
    const abort = () => { try { tx.abort(); } catch { /* 已结束。 */ } };
    signal?.addEventListener('abort', abort, { once: true });
    for (const path of paths) {
      const request = tx.objectStore(STORE_METADATA).get(forgottenPathKey(path));
      request.onsuccess = () => {
        try {
          const cutoff = cleanupTimestamp(request.result);
          if (cutoff !== undefined) latest = latest === undefined ? cutoff : Math.max(latest, cutoff);
        } catch (error) { failure = error; abort(); }
      };
    }
    const cleanup = () => signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(latest); };
    tx.onerror = tx.onabort = () => {
      cleanup(); reject(signal?.aborted ? new DOMException('失效素材清理已取消', 'AbortError')
        : failure ?? new Error('失效素材清理读取失败'));
    };
    if (signal?.aborted) abort();
  });
}

export async function isAssetHistoryRecordActive(record: HistoryRecord): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    let active = false;
    withActiveHistory(tx, [record], (records) => { active = records.length === 1; });
    tx.oncomplete = () => resolve(active);
    tx.onerror = tx.onabort = () => reject(new Error('失效素材清理读取失败'));
  });
}

function validAssetUsageTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function latestAssetUsageTime(...values: unknown[]): number | undefined {
  let latest: number | undefined;
  for (const value of values) {
    if (validAssetUsageTime(value) && (latest === undefined || value > latest)) latest = value;
  }
  return latest;
}

function normalizeAssetUsage(value: unknown): AssetUsageRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((entry): entry is AssetUsageRecord => {
    if (!entry || typeof entry !== 'object' || typeof entry.assetId !== 'string'
      || !entry.assetId.trim() || entry.assetId.length > 256
      || !validAssetUsageTime(entry.usedAt)) return false;
    return true;
  }).sort((a, b) => b.usedAt - a.usedAt).filter((entry) => {
    if (seen.has(entry.assetId)) return false;
    seen.add(entry.assetId);
    return true;
  }).slice(0, MAX_RECENT_ASSET_USAGE).map(({ assetId, usedAt }) => ({ assetId, usedAt }));
}

export async function getRecentAssetUsage(): Promise<AssetUsageRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    const request = tx.objectStore(STORE_METADATA).get(RECENT_ASSET_USAGE_KEY);
    request.onsuccess = () => resolve(normalizeAssetUsage(request.result?.entries));
    request.onerror = () => reject(request.error);
  });
}

/** 只读取当前列表的稳定 ID；旧库仍保留的最近十项可作为时间回退，不补造更早历史。 */
export async function getAssetLastUsedTimes(assetIds: readonly string[]): Promise<Map<string, number>> {
  const ids = new Set(assetIds.filter((id) => typeof id === 'string' && id.trim() && id.length <= 256));
  if (!ids.size) return new Map<string, number>();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ASSET_INDEX, STORE_METADATA], 'readonly');
    const times = new Map<string, number>();
    const merge = (assetId: string, time: unknown) => {
      const latest = latestAssetUsageTime(times.get(assetId), time);
      if (latest !== undefined) times.set(assetId, latest);
    };
    const recent = tx.objectStore(STORE_METADATA).get(RECENT_ASSET_USAGE_KEY);
    recent.onsuccess = () => {
      for (const entry of normalizeAssetUsage(recent.result?.entries)) {
        if (ids.has(entry.assetId)) merge(entry.assetId, entry.usedAt);
      }
    };
    const store = tx.objectStore(STORE_ASSET_INDEX);
    for (const assetId of ids) {
      const request = store.get(assetId);
      request.onsuccess = () => merge(assetId, request.result?.lastUsedAt);
    }
    tx.oncomplete = () => resolve(times);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('资产使用时间读取失败'));
  });
}

/** 原子维护最近十项与全量索引时间，多个窗口/旧扫描不能覆盖较新的使用记录。 */
export async function recordRecentAssetUsage(assetId: string, usedAt = Date.now()): Promise<void> {
  if (normalizeAssetUsage([{ assetId, usedAt }]).length !== 1) throw new Error('最近使用记录无效');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_METADATA, STORE_ASSET_INDEX], 'readwrite');
    const store = tx.objectStore(STORE_METADATA);
    let forgotten = false;
    withActiveAsset(tx, assetId, () => {
      const request = store.get(RECENT_ASSET_USAGE_KEY);
      request.onsuccess = () => {
        const previous = normalizeAssetUsage(request.result?.entries);
        const existing = previous.find((entry) => entry.assetId === assetId);
        const assetStore = tx.objectStore(STORE_ASSET_INDEX);
        // 旧库只在 metadata 留有十项；裁剪前保留仍可恢复的真实时间，不为缺失资产造索引。
        for (const entry of previous) {
          if (entry.assetId === assetId) continue;
          const legacy = assetStore.get(entry.assetId);
          legacy.onsuccess = () => {
            const record = legacy.result as AssetIndexRecord | undefined;
            if (!record) return;
            const lastUsedAt = latestAssetUsageTime(record.lastUsedAt, entry.usedAt)!;
            if (lastUsedAt !== record.lastUsedAt) assetStore.put({ ...record, lastUsedAt });
          };
        }
        const indexed = assetStore.get(assetId);
        indexed.onsuccess = () => {
          const record = indexed.result as AssetIndexRecord | undefined;
          const lastUsedAt = latestAssetUsageTime(usedAt, existing?.usedAt, record?.lastUsedAt)!;
          const entries = normalizeAssetUsage([
            { assetId, usedAt: lastUsedAt },
            ...previous.filter((entry) => entry.assetId !== assetId),
          ]);
          store.put({ id: RECENT_ASSET_USAGE_KEY, entries });
          if (record) assetStore.put({ ...record, lastUsedAt });
        };
      };
    }, () => { forgotten = true; });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error(forgotten ? '素材已被清理，请重新加载后重试' : '最近使用记录保存失败'));
  });
}

export interface ProjectRecord extends ProjectSummaryRecord {
  nodes: unknown;
  edges: unknown;
  dramaAssets?: unknown;
}

export * from './indexedDb/catalogRepository';
export * from './indexedDb/videoEditorRepository';

/** 保存整个项目（含 nodes/edges）到 IndexedDB */
export async function saveProjectToDb(record: ProjectRecord): Promise<void> {
  const summary = toProjectSummaryRecord(record);
  if (!summary) throw new Error('项目摘要无效，无法写入 IndexedDB');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA], 'readwrite');
    let failure: Error | undefined;
    const current = tx.objectStore(STORE_PROJECTS).get(record.id);
    current.onsuccess = () => {
      const before = current.result as ProjectRecord | undefined;
      const tombstone = tx.objectStore(STORE_METADATA).get(`project-deleted:${record.id}`);
      tombstone.onsuccess = () => {
        if ((before?.exchangeEpoch ?? 0) !== (record.exchangeEpoch ?? 0) || (!before && tombstone.result)) {
          failure = new Error('项目已被导入更新或删除，请重新打开项目后保存'); tx.abort(); return;
        }
        withRelocatedMedia(tx, record, (next) => tx.objectStore(STORE_PROJECTS).put(next));
        tx.objectStore(STORE_PROJECT_SUMMARIES).put(summary);
      };
    };
    let settled = false;
    const fail = (error: DOMException | null) => {
      if (settled) return;
      settled = true;
      reject(failure ?? error ?? new Error(`项目 ${record.id} 的 IndexedDB 写入失败`));
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });
}

/** 缩略图迟到时只更新最新记录的图片；不重存旧画布，也不重新创建已删除项目。 */
export async function updateProjectSnapshot(id: string, snapshot: string | undefined): Promise<boolean> {
  if (typeof id !== 'string' || !id.trim() || (snapshot !== undefined && !isProjectSnapshotDataUrl(snapshot))) {
    throw new Error('项目缩略图参数无效');
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_SUMMARIES], 'readwrite');
    const projects = tx.objectStore(STORE_PROJECTS);
    const request = projects.get(id);
    let updated = false;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error('项目缩略图保存失败'));
    };
    request.onsuccess = () => {
      const current = request.result as ProjectRecord | undefined;
      if (!current) return;
      try {
        const next = { ...current, snapshot };
        const summary = toProjectSummaryRecord(next);
        if (!summary) throw new Error('项目摘要无效，无法更新缩略图');
        projects.put(next);
        tx.objectStore(STORE_PROJECT_SUMMARIES).put(summary);
        updated = true;
      } catch (error) {
        tx.abort();
        fail(error);
      }
    };
    request.onerror = () => fail(request.error);
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(updated);
    };
    tx.onerror = tx.onabort = () => fail(tx.error);
  });
}

// ============================================
// Global character library CRUD
// ============================================

function checkedGlobalWeaponIds(value: unknown): string[] {
  const ids = normalizeCharacterWeaponIds(value);
  if (!Array.isArray(value) || value.length > MAX_CHARACTER_WEAPONS
    || value.some((id) => typeof id !== 'string' || !ids.includes(id))) throw new Error(t('武器绑定无效，请重新选择'));
  return ids;
}

async function putGlobalLibraryRecord(
  storeName: string,
  asset: DramaCharacter | DramaScene | DramaProp,
  options: DramaAssetWriteOptions = {},
): Promise<void> {
  assertDramaAssetWriteCurrent(options);
  const db = await openDB();
  assertDramaAssetWriteCurrent(options);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_GLOBAL_CHARACTERS, STORE_GLOBAL_DRAMA_ASSETS, STORE_METADATA], 'readwrite');
    const store = tx.objectStore(storeName);
    const abort = () => { try { tx.abort(); } catch { /* 已结束的事务无需再次中止。 */ } };
    options.signal?.addEventListener('abort', abort, { once: true });
    const current = store.get(asset.id);
    current.onsuccess = () => {
      try {
        assertDramaAssetWriteCurrent(options);
        if (current.result && current.result.kind !== asset.kind) throw new Error('资产分类已变化，请重新加载');
        // 编辑器可能早于一次排序打开，人物正文保存不能覆盖最新手动顺序。
        const next = asset.kind === 'character'
          ? { ...asset, libraryOrder: current.result ? (current.result as DramaCharacter).libraryOrder : asset.libraryOrder,
            weaponIds: asset.weaponIds ?? (current.result as DramaCharacter | undefined)?.weaponIds } : asset;
        const save = () => withRelocatedMedia(tx, next, (relocated) => {
          try {
            assertDramaAssetWriteCurrent(options);
            store.put(relocated);
          } catch (error) {
            tx.abort();
            reject(error);
          }
        });
        const fail = (error: unknown) => { tx.abort(); reject(error); };
        if (next.kind === 'character' && next.weaponIds !== undefined) {
          const ids = checkedGlobalWeaponIds(next.weaponIds);
          next.weaponIds = ids;
          let pending = ids.length;
          if (!pending) save();
          for (const id of ids) {
            const weapon = tx.objectStore(STORE_GLOBAL_DRAMA_ASSETS).get(id);
            weapon.onsuccess = () => {
              try {
                assertDramaAssetWriteCurrent(options);
                if (weapon.result?.kind !== 'prop' || weapon.result.propType !== 'weapon') throw new Error(t('武器绑定无效，请重新选择'));
                if (--pending === 0) save();
              } catch (error) { fail(error); }
            };
          }
        } else if (current.result?.kind === 'prop' && current.result.propType === 'weapon'
          && next.kind === 'prop' && next.propType !== 'weapon') {
          const characters = tx.objectStore(STORE_GLOBAL_CHARACTERS).getAll();
          characters.onsuccess = () => {
            try {
              assertDramaAssetWriteCurrent(options);
              if ((characters.result as DramaCharacter[]).some((character) => character.weaponIds?.includes(next.id))) {
                throw new Error(t('请先解除角色的武器绑定，再改为普通道具'));
              }
              save();
            } catch (error) { fail(error); }
          };
        } else save();
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(); };
    tx.onerror = tx.onabort = () => { cleanup(); reject(tx.error ?? new Error('全局创作资产保存失败')); };
  });
}

export async function putGlobalCharacter(character: DramaCharacter, options?: DramaAssetWriteOptions): Promise<void> {
  return putGlobalLibraryRecord(STORE_GLOBAL_CHARACTERS, character, options);
}

/** 绑定只改关联字段；与武器删除/分类转换共用两表事务，不重写媒体或角色正文。 */
export async function putGlobalCharacterWeapons(characterId: string, weaponIds: string[], options: DramaAssetWriteOptions = {}): Promise<void> {
  const ids = checkedGlobalWeaponIds(weaponIds);
  assertDramaAssetWriteCurrent(options);
  const db = await openDB();
  assertDramaAssetWriteCurrent(options);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_GLOBAL_CHARACTERS, STORE_GLOBAL_DRAMA_ASSETS], 'readwrite');
    let failure: unknown;
    const fail = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* 已结束事务不再撤销。 */ } };
    const abort = () => fail(new Error(t('角色武器保存失败，请重试')));
    options.signal?.addEventListener('abort', abort, { once: true });
    const character = tx.objectStore(STORE_GLOBAL_CHARACTERS).get(characterId);
    let remaining = ids.length + 1;
    const checked = () => {
      if (--remaining || failure) return;
      try {
        assertDramaAssetWriteCurrent(options);
        if (character.result?.kind !== 'character') throw new Error(t('角色或项目已变化，请重新选择武器'));
        tx.objectStore(STORE_GLOBAL_CHARACTERS).put({ ...character.result, weaponIds: ids, updatedAt: Date.now() });
      } catch (error) { fail(error); }
    };
    character.onsuccess = checked;
    for (const id of ids) {
      const weapon = tx.objectStore(STORE_GLOBAL_DRAMA_ASSETS).get(id);
      weapon.onsuccess = () => {
        if (weapon.result?.kind !== 'prop' || weapon.result.propType !== 'weapon') fail(new Error(t('武器绑定无效，请重新选择')));
        else checked();
      };
    }
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(); };
    tx.onerror = tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? new Error(t('角色武器保存失败，请重试'))); };
  });
}

export async function putGlobalDramaAsset(asset: DramaScene | DramaProp, options?: DramaAssetWriteOptions): Promise<void> {
  return putGlobalLibraryRecord(STORE_GLOBAL_DRAMA_ASSETS, asset, options);
}

interface ImportedGlobalMediaReference { assetId: string; relativePath: string; path: string }

function inspectImportedGlobalAssets(assets: readonly DramaAsset[]): ImportedGlobalMediaReference[] {
  const invalid = () => { throw new Error('全局创作资产导入记录无效'); };
  if (!Array.isArray(assets) || assets.length > 500) invalid();
  const ids = new Set<string>();
  const media = new Map<string, ImportedGlobalMediaReference>();
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
  };
  const detached = (value: Record<string, unknown>) => {
    if (['filePath', 'sourceNodeId', 'imageNodeId'].some((key) => value[key] !== undefined)) invalid();
  };
  const relative = (value: unknown): value is string => typeof value === 'string' && !!value
    && !value.includes('\\') && !value.includes(':') && ![...value].some((character) => character.charCodeAt(0) < 32)
    && !value.split('/').some((part) => !part || part === '.' || part === '..');
  const addMedia = (assetId: unknown, relativePath: unknown, url: unknown) => {
    if (typeof assetId !== 'string' || !assetId.trim() || !relative(relativePath) || typeof url !== 'string') return invalid();
    const path = localMediaUrlToPath(url);
    if (!path) return invalid();
    const previous = media.get(assetId);
    if (previous && (previous.relativePath !== relativePath || imageHistoryReferenceKey(previous.path) !== imageHistoryReferenceKey(path))) invalid();
    media.set(assetId, { assetId, relativePath, path });
    if (media.size > 5000) invalid();
  };
  const members = (value: unknown): Record<string, unknown>[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1000) return invalid();
    const seen = new Set<string>();
    return value.map((item) => {
      const entry = record(item); detached(entry);
      if (typeof entry.id !== 'string' || !entry.id.trim() || seen.has(entry.id)) invalid();
      seen.add(entry.id as string); return entry;
    });
  };
  for (const asset of assets) {
    const value = record(asset); detached(value);
    if (!['character', 'scene', 'prop'].includes(asset.kind) || typeof asset.id !== 'string' || !asset.id.trim()
      || typeof asset.name !== 'string' || !asset.name.trim() || ids.has(asset.id)
      || value.assetId !== undefined || value.relativePath !== undefined) invalid();
    ids.add(asset.id);
    if (asset.kind !== 'character') {
      if (asset.imageUrl !== undefined || asset.imageAssetId !== undefined || asset.imageRelativePath !== undefined) {
        addMedia(asset.imageAssetId, asset.imageRelativePath, asset.imageUrl);
      }
      const references = members(asset.referenceImages);
      for (const reference of references) addMedia(reference.assetId, reference.relativePath, reference.imageUrl);
      if (asset.primaryReferenceImageId !== undefined && !references.some((reference) => reference.id === asset.primaryReferenceImageId)) invalid();
      if (references.length && asset.imageUrl !== undefined
        && !references.some((reference) => reference.id === asset.primaryReferenceImageId
          && reference.imageUrl === asset.imageUrl && reference.assetId === asset.imageAssetId
          && reference.relativePath === asset.imageRelativePath)) invalid();
      continue;
    }
    if (asset.imageAssetId !== undefined || asset.imageRelativePath !== undefined || asset.volcengineBinding !== undefined
      || (asset.refmods !== undefined && (!Array.isArray(asset.refmods) || asset.refmods.length))) invalid();
    const references = members(asset.referenceImages);
    const voices = members(asset.voiceClips);
    for (const reference of references) addMedia(reference.assetId, reference.relativePath, reference.imageUrl);
    for (const voice of voices) addMedia(voice.assetId, voice.relativePath, voice.audioUrl);
    for (const action of members(asset.actions)) {
      for (const item of members(action.media)) {
        if (!['image', 'gif', 'video'].includes(item.kind as string)) invalid();
        addMedia(item.assetId, item.relativePath, item.url);
      }
    }
    for (const [pointer, entries] of [[asset.primaryReferenceImageId, references], [asset.avatarReferenceImageId, references], [asset.primaryVoiceClipId, voices]] as const) {
      if (pointer !== undefined && !entries.some((entry) => entry.id === pointer)) invalid();
    }
    if (asset.imageUrl !== undefined && !references.some((reference) => reference.imageUrl === asset.imageUrl)) invalid();
  }
  return [...media.values()];
}

/** 已固化全局媒体的导入批次只追加；两表及身份检查共用事务，不覆盖已有卡片。 */
export async function addImportedGlobalDramaAssets(
  assets: readonly DramaAsset[], options: DramaAssetWriteOptions = {},
): Promise<DramaAsset[]> {
  assertDramaAssetWriteCurrent(options);
  const snapshot = structuredClone(assets).map((asset) => asset.kind === 'character' ? { ...asset, libraryOrder: undefined } : asset);
  inspectImportedGlobalAssets(snapshot);
  if (!snapshot.length) return [];
  const db = await openDB();
  assertDramaAssetWriteCurrent(options);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_GLOBAL_CHARACTERS, STORE_GLOBAL_DRAMA_ASSETS, STORE_ASSET_INDEX, STORE_METADATA], 'readwrite');
    let failure: unknown;
    let saved: DramaAsset[] = [];
    const fail = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* 已结束事务不再撤销。 */ } };
    const abort = () => fail(new Error('全局创作资产导入已取消'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(saved); };
    tx.onerror = tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? new Error('全局创作资产导入保存失败')); };
    withRelocatedMedia(tx, snapshot, (relocated) => {
      try {
        assertDramaAssetWriteCurrent(options);
        const references = inspectImportedGlobalAssets(relocated);
        let pending = relocated.length * 2 + references.length;
        const checked = () => {
          if (--pending !== 0 || failure) return;
          try {
            assertDramaAssetWriteCurrent(options);
            saved = relocated;
            for (const asset of relocated) {
              tx.objectStore(asset.kind === 'character' ? STORE_GLOBAL_CHARACTERS : STORE_GLOBAL_DRAMA_ASSETS).add(asset);
            }
          } catch (error) { fail(error); }
        };
        for (const asset of relocated) {
          for (const storeName of [STORE_GLOBAL_CHARACTERS, STORE_GLOBAL_DRAMA_ASSETS]) {
            const request = tx.objectStore(storeName).getKey(asset.id);
            request.onsuccess = () => {
              if (request.result !== undefined) fail(new Error('全局创作资产身份已存在，请重新导入'));
              else checked();
            };
          }
        }
        for (const reference of references) {
          const request = tx.objectStore(STORE_ASSET_INDEX).get(reference.assetId);
          request.onsuccess = () => {
            const indexed = request.result as AssetIndexRecord | undefined;
            if (!indexed || indexed.source !== 'global' || indexed.status !== 'online' || indexed.projectId !== undefined
              || indexed.relativePath !== reference.relativePath
              || imageHistoryReferenceKey(indexed.path) !== imageHistoryReferenceKey(reference.path)) {
              fail(new Error('全局创作资产导入记录无效'));
            } else checked();
          };
        }
      } catch (error) { fail(error); }
    });
  });
}

export async function getAllGlobalDramaAssets(): Promise<Array<DramaScene | DramaProp>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_GLOBAL_DRAMA_ASSETS, 'readonly')
      .objectStore(STORE_GLOBAL_DRAMA_ASSETS).getAll();
    request.onsuccess = () => resolve(request.result as Array<DramaScene | DramaProp>);
    request.onerror = () => reject(request.error);
  });
}

async function deleteGlobalLibraryRecord(storeName: string, id: string, options: DramaAssetWriteOptions = {}): Promise<void> {
  assertDramaAssetWriteCurrent(options);
  const db = await openDB();
  assertDramaAssetWriteCurrent(options);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const abort = () => { try { tx.abort(); } catch { /* 已结束的事务无需再次中止。 */ } };
    options.signal?.addEventListener('abort', abort, { once: true });
    const request = store.get(id);
    request.onsuccess = () => {
      try { assertDramaAssetWriteCurrent(options); store.delete(id); }
      catch (error) { tx.abort(); reject(error); }
    };
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(); };
    tx.onerror = tx.onabort = () => { cleanup(); reject(tx.error ?? new Error('全局创作资产删除失败')); };
  });
}

export async function deleteGlobalDramaAsset(id: string, options?: DramaAssetWriteOptions): Promise<void> {
  assertDramaAssetWriteCurrent(options);
  const db = await openDB();
  assertDramaAssetWriteCurrent(options);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_GLOBAL_DRAMA_ASSETS, STORE_GLOBAL_CHARACTERS], 'readwrite');
    let failure: unknown;
    const fail = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* 已结束事务不再撤销。 */ } };
    const abort = () => fail(new Error(t('角色武器保存失败，请重试')));
    options?.signal?.addEventListener('abort', abort, { once: true });
    const characters = tx.objectStore(STORE_GLOBAL_CHARACTERS).getAll();
    characters.onsuccess = () => {
      try {
        assertDramaAssetWriteCurrent(options);
        for (const character of characters.result as DramaCharacter[]) {
          if (!character.weaponIds?.includes(id)) continue;
          tx.objectStore(STORE_GLOBAL_CHARACTERS).put({ ...character,
            weaponIds: character.weaponIds.filter((weaponId) => weaponId !== id), updatedAt: Date.now() });
        }
        tx.objectStore(STORE_GLOBAL_DRAMA_ASSETS).delete(id);
      } catch (error) { fail(error); }
    };
    const cleanup = () => options?.signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(); };
    tx.onerror = tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? new Error(t('全局创作资产删除失败'))); };
  });
}

export async function getAllGlobalCharacters(): Promise<DramaCharacter[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_GLOBAL_CHARACTERS, 'readonly')
      .objectStore(STORE_GLOBAL_CHARACTERS)
      .getAll();
    request.onsuccess = () => resolve(request.result as DramaCharacter[]);
    request.onerror = () => reject(request.error);
  });
}

/** 单事务只更新排序字段；失败整体回滚，不重存媒体或覆盖并发编辑。 */
export async function putGlobalCharacterOrder(ids: string[]): Promise<void> {
  if (new Set(ids).size !== ids.length) throw new Error('角色顺序含重复项');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_GLOBAL_CHARACTERS, 'readwrite');
    const store = tx.objectStore(STORE_GLOBAL_CHARACTERS);
    ids.forEach((id, libraryOrder) => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) { tx.abort(); return; }
        store.put({ ...request.result, libraryOrder });
      };
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('角色列表已变化，请重试排序'));
  });
}

export async function deleteGlobalCharacter(id: string, options?: DramaAssetWriteOptions): Promise<void> {
  return deleteGlobalLibraryRecord(STORE_GLOBAL_CHARACTERS, id, options);
}

export async function clearGlobalCharacters(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_GLOBAL_CHARACTERS, 'readwrite');
    tx.objectStore(STORE_GLOBAL_CHARACTERS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 原子删除项目及其项目域持久化数据。 */
export async function deleteProjectFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([
      STORE_PROJECTS,
      STORE_PROJECT_SUMMARIES,
      STORE_CHAT_CONVERSATIONS,
      STORE_CHAT_MESSAGES,
      STORE_AGENT_TASKS,
      STORE_PROJECT_MEMORIES,
      STORE_PROJECT_VISUAL_DESCRIPTIONS,
      STORE_HISTORY,
      STORE_METADATA,
      STORE_PROJECT_EXCHANGE_STATES,
    ], 'readwrite');

    tx.objectStore(STORE_PROJECTS).delete(id);
    tx.objectStore(STORE_PROJECT_EXCHANGE_STATES).delete(id);
    tx.objectStore(STORE_METADATA).put({ id: `project-deleted:${id}`, deletedAt: Date.now() });
    tx.objectStore(STORE_METADATA).delete(`video-batches:${id}`);
    tx.objectStore(STORE_METADATA).delete(`video-replica-jobs:${id}`);
    tx.objectStore(STORE_PROJECT_SUMMARIES).delete(id);

    const conversationStore = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const conversationRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const conversationCursor = conversationStore
      .index('projectId_updatedAt')
      .openCursor(conversationRange);
    conversationCursor.onsuccess = () => {
      const cursor = conversationCursor.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    // chatMessages 没有 projectId 索引；项目删除是低频操作，事务内全表扫描
    // 可以清理会话记录已损坏时留下的孤儿消息，同时避免为此升级 schema。
    const messageCursor = tx.objectStore(STORE_CHAT_MESSAGES).openCursor();
    messageCursor.onsuccess = () => {
      const cursor = messageCursor.result;
      if (!cursor) return;
      if ((cursor.value as ChatMessageRecord).projectId === id) cursor.delete();
      cursor.continue();
    };

    const taskRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const taskCursor = tx.objectStore(STORE_AGENT_TASKS)
      .index('projectId_updatedAt')
      .openCursor(taskRange);
    taskCursor.onsuccess = () => {
      const cursor = taskCursor.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    const memoryRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const memoryCursor = tx.objectStore(STORE_PROJECT_MEMORIES)
      .index('projectId_updatedAt')
      .openCursor(memoryRange);
    memoryCursor.onsuccess = () => {
      const cursor = memoryCursor.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    const historyCursor = tx.objectStore(STORE_HISTORY)
      .index('projectId_timestamp_id')
      .openCursor(projectHistoryRange(id));
    historyCursor.onsuccess = () => {
      const cursor = historyCursor.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    const visualRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const visualCursor = tx.objectStore(STORE_PROJECT_VISUAL_DESCRIPTIONS)
      .index('projectId_updatedAt')
      .openCursor(visualRange);
    visualCursor.onsuccess = () => {
      const cursor = visualCursor.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error(`删除项目 ${id} 的持久化数据失败`));
  });
}

/** 获取全部项目列表摘要；不会读取 projects store 中的 nodes/edges。 */
export async function getAllProjects(): Promise<ProjectSummaryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_SUMMARIES, 'readonly');
    const store = tx.objectStore(STORE_PROJECT_SUMMARIES);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 获取单个项目（含 nodes/edges） */
export async function getProjectById(id: string): Promise<ProjectRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ============================================
// History CRUD — AI 输出历史记录
// ============================================

export interface HistoryRecord {
  id: string;
  projectId: string;
  nodeId: string;
  nodeLabel: string;
  timestamp: number;
  prompt: string;
  output: string;
  nodeType: string;
  model: string;
  provider: string;
  status: string;
  error?: string;
  mediaUrl?: string;
  filePath?: string;
  params?: Record<string, unknown>;
}

export interface HistoryPageCursor {
  timestamp: number;
  id: string;
}

export type { HistoryQuery } from '../types';

export interface HistoryPage {
  records: HistoryRecord[];
  nextCursor: HistoryPageCursor | null;
  hasMore: boolean;
}

/** 图片身份比较仅使用完整路径/地址；不按文件名猜测来源。 */
export function imageHistoryReferenceKey(reference: string | undefined): string | undefined {
  if (!reference || reference.startsWith('data:') || reference.startsWith('blob:')) return undefined;
  const path = stripVerbatimPrefix(localMediaUrlToPath(reference) ?? reference);
  if (/^[a-z]:[/\\]/i.test(path) || path.startsWith('/') || path.startsWith('\\\\')) {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  }
  // 普通网络地址保持查询参数与大小写，签名不同的地址不能推断为同一图片。
  return reference;
}

/** 预览时只读查询匹配的最新成功图片记录；不加载或切换 Store 历史面板。 */
export async function findImageHistoryByReferences(references: string[], projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  return findMediaHistoryByReferences(references, 'ai-image', projectId, signal);
}

export async function findVideoHistoryByReferences(references: string[], projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  return findMediaHistoryByReferences(references, 'ai-video', projectId, signal);
}

async function findMediaHistoryByReferences(references: string[], nodeType: 'ai-image' | 'ai-video', projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  const keys = new Set(references.map(imageHistoryReferenceKey).filter((key): key is string => !!key));
  if (!keys.size) return null;
  if (signal?.aborted) throw new DOMException('Preview closed', 'AbortError');
  const db = await openDB();
  if (signal?.aborted) throw new DOMException('Preview closed', 'AbortError');
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readonly');
    const store = tx.objectStore(STORE_HISTORY);
    const request = projectId
      ? store.index('projectId_timestamp_id').openCursor(projectHistoryRange(projectId), 'prev')
      : store.openCursor();
    let latest: HistoryRecord | null = null;
    let scanned = 0;
    const abort = () => { try { tx.abort(); } catch { /* 事务已结束 */ } };
    signal?.addEventListener('abort', abort, { once: true });
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(latest); };
    tx.onabort = () => {
      signal?.removeEventListener('abort', abort);
      reject(signal?.aborted ? new DOMException('Preview closed', 'AbortError') : tx.error ?? new Error('生成记录读取失败'));
    };
    request.onerror = () => { /* 由事务统一报告读取失败 */ };
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (++scanned > 100_000) {
        reject(new Error('生成记录过多，无法完成媒体来源查询'));
        abort(); return;
      }
      const record = cursor.value as HistoryRecord;
      if ((record.nodeType === nodeType || nodeType === 'ai-image' && record.nodeType === 'ai-animation') && record.status === 'success'
        && [record.filePath, record.mediaUrl, record.output].some((reference) => {
          const key = imageHistoryReferenceKey(reference); return !!key && keys.has(key);
        }) && (!latest || record.timestamp > latest.timestamp || record.timestamp === latest.timestamp && record.id > latest.id)) {
        withActiveHistory(tx, [record], (active) => {
          if (active.length) latest = record;
          cursor.continue();
        });
        return;
      }
      cursor.continue();
    };
    if (signal?.aborted) abort();
  });
}

const HISTORY_MIGRATION_PREFIX = 'output-history-v1:';
const MAX_PROJECT_HISTORY = 16;

function projectHistoryRange(
  projectId: string,
  cursor?: HistoryPageCursor | null,
): IDBKeyRange {
  const lower: [string, number, string] = [projectId, 0, ''];
  const upper: [string, number, string] = cursor
    ? [projectId, cursor.timestamp, cursor.id]
    : [projectId, Number.MAX_SAFE_INTEGER, '\uffff'];
  return IDBKeyRange.bound(lower, upper, false, Boolean(cursor));
}

function pruneProjectHistory(store: IDBObjectStore, projectId: string): void {
  const request = store.index('projectId_timestamp_id').openCursor(
    projectHistoryRange(projectId),
    'prev',
  );
  let retained = 0;
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (retained >= MAX_PROJECT_HISTORY) cursor.delete();
    else retained += 1;
    cursor.continue();
  };
}

async function trimProjectHistory(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    pruneProjectHistory(tx.objectStore(STORE_HISTORY), projectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 保存单条历史记录 */
export async function putHistoryEntry(record: HistoryRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    withRelocatedMedia(tx, record, (next) => {
      withActiveHistory(tx, [next], (active) => {
        for (const entry of active) store.put(entry);
        if (active.length) pruneProjectHistory(store, record.projectId);
      });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 在同一事务内写入旧节点中的历史记录。 */
export async function putHistoryEntries(records: HistoryRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    withRelocatedMedia(tx, records, (next) => {
      withActiveHistory(tx, next, (active) => {
        for (const record of active) store.put(record);
        for (const projectId of new Set(active.map((record) => record.projectId))) pruneProjectHistory(store, projectId);
      });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 删除单条历史记录 */
export async function deleteHistoryEntryFromDb(projectId: string, id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as HistoryRecord | undefined;
      if (record?.projectId === projectId) store.delete(id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 按时间倒序读取一页历史；筛选在游标扫描期间完成，不保留未命中记录。 */
export async function getHistoryEntriesPage(
  projectId: string,
  limit: number,
  cursor: HistoryPageCursor | null = null,
  query: HistoryQuery = {},
): Promise<HistoryPage> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readonly');
    const index = tx.objectStore(STORE_HISTORY).index('projectId_timestamp_id');
    const request = index.openCursor(projectHistoryRange(projectId, cursor), 'prev');
    const records: HistoryRecord[] = [];
    let nextCursor: HistoryPageCursor | null = null;
    let hasMore = false;
    tx.oncomplete = () => resolve({ records, nextCursor: hasMore ? nextCursor : null, hasMore });
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('生成记录读取失败'));

    request.onsuccess = () => {
      const current = request.result;
      if (!current) return;
      if (records.length >= limit) {
        hasMore = true;
        return;
      }

      const record = current.value as HistoryRecord;
      if (matchesHistoryQuery(record, query)) {
        withActiveHistory(tx, [record], (active) => {
          if (active.length) {
            records.push(record);
            nextCursor = { timestamp: record.timestamp, id: record.id };
          }
          current.continue();
        });
        return;
      }
      current.continue();
    };
    request.onerror = () => { /* 事务统一报告。 */ };
  });
}

/** 仅在用户显式导出时扫描并返回全部匹配记录。 */
export async function getHistoryEntriesForExport(
  projectId: string,
  query: HistoryQuery = {},
): Promise<HistoryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readonly');
    const request = tx.objectStore(STORE_HISTORY)
      .index('projectId_timestamp_id')
      .openCursor(projectHistoryRange(projectId), 'prev');
    const records: HistoryRecord[] = [];
    tx.oncomplete = () => resolve(records);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('生成记录读取失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as HistoryRecord;
      if (matchesHistoryQuery(record, query)) {
        withActiveHistory(tx, [record], (active) => { records.push(...active); cursor.continue(); });
        return;
      }
      cursor.continue();
    };
    request.onerror = () => { /* 事务统一报告。 */ };
  });
}

/** 使用 nodeId 索引读取指定节点的全部历史记录，按生成时间倒序返回。 */
export async function getNodeHistoryEntries(projectId: string, nodeId: string): Promise<HistoryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readonly');
    let records: HistoryRecord[] = [];
    const request = tx.objectStore(STORE_HISTORY)
      .index('projectId_nodeId')
      .getAll(IDBKeyRange.only([projectId, nodeId]));
    request.onsuccess = () => {
      withActiveHistory(tx, request.result as HistoryRecord[], (active) => {
        records = active.sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id));
      });
    };
    tx.oncomplete = () => resolve(records);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('生成记录读取失败'));
  });
}

export async function getHistoryEntryCount(projectId: string): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_HISTORY, 'readonly')
      .objectStore(STORE_HISTORY)
      .index('projectId_timestamp_id')
      .count(projectHistoryRange(projectId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function hasCompletedHistoryMigration(projectId: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly')
      .objectStore(STORE_METADATA)
      .get(`${HISTORY_MIGRATION_PREFIX}${projectId}`);
    request.onsuccess = () => resolve(Boolean(request.result));
    request.onerror = () => reject(request.error);
  });
}

export async function markHistoryMigrationCompleted(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    tx.objectStore(STORE_METADATA).put({
      id: `${HISTORY_MIGRATION_PREFIX}${projectId}`,
      completedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 读取上次成功打开的项目；复用 metadata store，不需要升级 schema。 */
export async function getLastActiveProjectId(): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly')
      .objectStore(STORE_METADATA)
      .get(LAST_ACTIVE_PROJECT_KEY);
    request.onsuccess = () => {
      const projectId = (request.result as { projectId?: unknown } | undefined)?.projectId;
      resolve(typeof projectId === 'string' && projectId.trim() ? projectId : null);
    };
    request.onerror = () => reject(request.error);
  });
}

/** 仅在项目成功载入后更新，避免把加载失败的空状态记成最近项目。 */
export async function setLastActiveProjectId(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    tx.objectStore(STORE_METADATA).put({
      id: LAST_ACTIVE_PROJECT_KEY,
      projectId,
      updatedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 把 v14 及更早版本中可由节点 ID 确定归属的历史记录认领到当前项目。 */
export async function claimLegacyHistoryEntries(
  projectId: string,
  nodeIds: readonly string[],
): Promise<void> {
  const uniqueNodeIds = [...new Set(nodeIds)];
  if (uniqueNodeIds.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const nodeIndex = tx.objectStore(STORE_HISTORY).index('nodeId');
    for (const nodeId of uniqueNodeIds) {
      const request = nodeIndex.openCursor(IDBKeyRange.only(nodeId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value as HistoryRecord & { projectId?: string };
        if (!record.projectId) cursor.update({ ...record, projectId });
        cursor.continue();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await trimProjectHistory(projectId);
}

/** 清空指定项目的全部历史记录 */
export async function clearAllHistoryEntries(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const request = tx.objectStore(STORE_HISTORY)
      .index('projectId_timestamp_id')
      .openCursor(projectHistoryRange(projectId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 使用 nodeId 索引批量删除指定节点的历史记录。 */
export async function deleteNodeHistoryEntries(projectId: string, nodeId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const request = tx.objectStore(STORE_HISTORY)
      .index('projectId_nodeId')
      .openCursor(IDBKeyRange.only([projectId, nodeId]));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Asset Meta CRUD — 稳定资产标签（v2 以 assetId 为键；v1 path 仅用于迁移）
// ============================================

export interface AssetMetaRecord {
  assetId: string;
  path?: string;         // 最近路径，仅用于诊断和旧数据迁移
  tags: string[];        // 标签
  taggedBy?: 'manual' | 'comfyui' | 'vision'; // 标签来源
  updatedAt: number;
}

// 图片编辑信息按资产身份及内容摘要独立存放，避免标签更新或历史裁剪覆盖它。
const ASSET_IMAGE_PREFIX = 'asset-image:';

export async function getAssetImageRecords(signal?: AbortSignal): Promise<import('../types/assetImage').AssetImageRecord[]> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const db = await openDB();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    const records: import('../types/assetImage').AssetImageRecord[] = [];
    const abort = () => { try { tx.abort(); } catch { /* 已结束 */ } };
    signal?.addEventListener('abort', abort, { once: true });
    const request = tx.objectStore(STORE_METADATA).openCursor(IDBKeyRange.bound(ASSET_IMAGE_PREFIX, `${ASSET_IMAGE_PREFIX}\uffff`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (records.length >= 10_000) { reject(new Error('图片信息过多，请先整理')); abort(); return; }
      records.push(cursor.value); cursor.continue();
    };
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(records); };
    tx.onabort = () => { signal?.removeEventListener('abort', abort); reject(signal?.aborted ? new DOMException('Cancelled', 'AbortError') : tx.error ?? new Error('图片信息读取失败')); };
    if (signal?.aborted) abort();
  });
}

/** 事务内比较 revision；批量反推可同时比较标签基线并原子替换，失败保留原信息。 */
export async function putAssetImageRecord(record: import('../types/assetImage').AssetImageRecord, expectedRevision: number,
  options?: { tagReplacement?: import('../types/assetImage').AssetImageTagReplacement; signal?: AbortSignal }): Promise<void> {
  if (!record.id.startsWith(ASSET_IMAGE_PREFIX) || !/^[a-f0-9]{64}$/.test(record.contentDigest)
    || record.revision !== expectedRevision + 1) throw new Error('图片信息无效');
  const replacement = options?.tagReplacement;
  if (replacement && (replacement.tags.length > 16 || replacement.tags.some((tag) => !tag.trim() || tag.length > 40))) throw new Error('标签信息无效');
  options?.signal?.throwIfAborted();
  const db = await openDB();
  options?.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(replacement ? [STORE_METADATA, STORE_ASSET_META_V2] : STORE_METADATA, 'readwrite');
    const store = tx.objectStore(STORE_METADATA);
    let conflict = false;
    let forgotten = false;
    const abort = () => { try { tx.abort(); } catch { /* 事务已完成 */ } };
    const cleanup = () => options?.signal?.removeEventListener('abort', abort);
    options?.signal?.addEventListener('abort', abort, { once: true });
    withActiveAsset(tx, record.assetId, () => {
      const request = store.get(record.id);
      request.onsuccess = () => {
        const current = request.result as import('../types/assetImage').AssetImageRecord | undefined;
        if ((current?.revision ?? 0) !== expectedRevision || current && current.contentDigest !== record.contentDigest) {
          conflict = true; tx.abort(); return;
        }
        withRelocatedMedia(tx, record, (next) => store.put(next));
      };
      if (replacement) {
        const tags = tx.objectStore(STORE_ASSET_META_V2);
        const baseline = tags.get(record.assetId);
        baseline.onsuccess = () => {
          const current = baseline.result as AssetMetaRecord | undefined;
          if (replacement.expected ? !current || current.updatedAt !== replacement.expected.updatedAt
            || JSON.stringify(current.tags) !== JSON.stringify(replacement.expected.tags) : !!current) {
            conflict = true; abort(); return;
          }
          tags.put({ assetId: record.assetId, tags: [...replacement.tags], taggedBy: 'vision', updatedAt: Date.now() } satisfies AssetMetaRecord);
        };
      }
    }, () => { forgotten = true; });
    tx.oncomplete = () => { cleanup(); resolve(); };
    tx.onabort = tx.onerror = () => {
      cleanup(); reject(options?.signal?.aborted ? new DOMException('Cancelled', 'AbortError')
        : new Error(forgotten ? '素材已被清理，请重新加载后重试'
          : conflict ? '提示词或标签已被其他操作修改，请重新读取后重试' : '图片信息保存失败'));
    };
    if (options?.signal?.aborted) abort();
  });
}

/** 获取全部资产元数据（一次性读入，组件侧建 Map 合并） */
export async function getAllAssetMeta(): Promise<AssetMetaRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META_V2, 'readonly');
    const store = tx.objectStore(STORE_ASSET_META_V2);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as AssetMetaRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/** 批量任务逐项捕获当前标签基线，避免为每张图片读取整个标签目录。 */
export async function getAssetMetaById(assetId: string): Promise<AssetMetaRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_ASSET_META_V2, 'readonly').objectStore(STORE_ASSET_META_V2).get(assetId);
    request.onsuccess = () => resolve(request.result as AssetMetaRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** 写入/更新单个文件的标签元数据 */
export async function putAssetMeta(record: AssetMetaRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ASSET_META_V2, STORE_METADATA], 'readwrite');
    let forgotten = false;
    withActiveAsset(tx, record.assetId, () => {
      withRelocatedMedia(tx, record, (next) => tx.objectStore(STORE_ASSET_META_V2).put(next));
    }, () => { forgotten = true; });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error(forgotten ? '素材已被清理，请重新加载后重试' : '文件引用写入事务失败'));
  });
}

/** 删除单个文件的标签元数据 */
export async function deleteAssetMeta(assetId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META_V2, 'readwrite');
    tx.objectStore(STORE_ASSET_META_V2).delete(assetId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Chat Conversations CRUD
// ============================================

export interface ChatConversationRecord {
  archiveOriginId?: string;
  id: string;
  projectId: string;
  title: string;
  titleSource: 'auto' | 'user';
  pinned: boolean;
  archived: boolean;
  agentMode: AgentMode;
  mcpServerIds?: string[];
  mcpSelectionRevision?: string;
  contextSummary?: ConversationContextSummary;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  messageCount: number;
  deletedAt?: number;
}

/** 保存 / 更新会话 */
export async function putChatConversation(record: ChatConversationRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readwrite');
    tx.objectStore(STORE_CHAT_CONVERSATIONS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 获取指定项目的全部会话（不含已删除） */
export async function getProjectConversations(projectId: string): Promise<ChatConversationRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const index = store.index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => {
      const all = request.result as ChatConversationRecord[];
      // 过滤掉已删除的
      resolve(all.filter((c) => !c.deletedAt));
    };
    request.onerror = () => reject(request.error);
  });
}

/** 获取回收站中的会话 */
export async function getTrashConversations(projectId: string): Promise<ChatConversationRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const index = store.index('deletedAt');
    const range = IDBKeyRange.lowerBound(1);
    const request = index.getAll(range);
    request.onsuccess = () => {
      const all = request.result as ChatConversationRecord[];
      resolve(all.filter((c) => c.projectId === projectId));
    };
    request.onerror = () => reject(request.error);
  });
}

// ============================================
// Chat Messages CRUD
// ============================================

export interface ChatMessageRecord {
  archiveOriginId?: string;
  id: string;
  projectId: string;
  conversationId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: string;
  requestId?: string;
  agentTaskId?: string;
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  finishReason?: string;
  commands?: unknown;
  executionResults?: unknown;
  mediaStatus?: string;
  mediaError?: string;
  mediaResult?: unknown;
  canvasStatus?: string;
  canvasNodeId?: string;
  canvasError?: string;
  sources?: unknown;
}

export interface LegacyAssetMetaRecord {
  path: string;
  tags: string[];
  taggedBy?: 'manual' | 'comfyui' | 'vision';
  updatedAt: number;
}

export async function getLegacyAssetMeta(path: string): Promise<LegacyAssetMetaRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META, 'readonly');
    const request = tx.objectStore(STORE_ASSET_META).get(path);
    request.onsuccess = () => resolve(request.result as LegacyAssetMetaRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

export interface AssetIndexRecord {
  assetId: string;
  path: string;
  relativePath?: string;
  rootPath?: string;
  projectId?: string;
  source: 'project' | 'global' | 'folder';
  fingerprint: string;
  size: number;
  mtimeMs: number;
  /** 固定块 asset-image-sha256-chain-v1 全内容摘要；旧索引可以没有，不从元数据补造。 */
  contentDigest?: string;
  /** 最近一次真实使用时间（毫秒）；扫描刷新不产生或清空使用记录。 */
  lastUsedAt?: number;
  status: 'online' | 'offline';
  updatedAt: number;
}

export async function getAssetIndexById(assetId: string): Promise<AssetIndexRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).get(assetId);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllAssetIndexes(): Promise<AssetIndexRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_ASSET_INDEX, 'readonly').objectStore(STORE_ASSET_INDEX).getAll();
    request.onsuccess = () => resolve(request.result as AssetIndexRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function getAssetIndexByPath(path: string): Promise<AssetIndexRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).index('path').get(path);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function getAssetIndexesByFingerprint(fingerprint: string): Promise<AssetIndexRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).index('fingerprint').getAll(fingerprint);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/** 目录扫描的小批路径查询；一次事务读取，按输入顺序返回，不扫描整张索引表。 */
export async function getAssetIndexesByPaths(paths: readonly string[]): Promise<Array<AssetIndexRecord | undefined>> {
  if (!paths.length) return [];
  if (paths.length > 128) throw new Error('资产索引查询批次过大');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const index = tx.objectStore(STORE_ASSET_INDEX).index('path');
    const records: Array<AssetIndexRecord | undefined> = new Array(paths.length);
    paths.forEach((path, position) => {
      const request = index.get(path);
      request.onsuccess = () => { records[position] = request.result as AssetIndexRecord | undefined; };
    });
    tx.oncomplete = () => resolve(records);
    tx.onerror = tx.onabort = () => reject(new Error('资产索引读取失败'));
  });
}

/** 扫描刷新合并小批事务；同值免写仍在墓碑与迁移日志校验之后执行。 */
export async function putAssetIndexes(
  records: readonly AssetIndexRecord[],
  options: { skipUnchanged?: boolean; migrateLegacyTags?: boolean; requireExistingPath?: boolean } = {},
): Promise<AssetIndexRecord[]> {
  if (!records.length) return [];
  if (records.length > 128) throw new Error('资产索引保存批次过大');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const stores = options.migrateLegacyTags
      ? [STORE_ASSET_INDEX, STORE_METADATA, STORE_ASSET_META, STORE_ASSET_META_V2]
      : [STORE_ASSET_INDEX, STORE_METADATA];
    const tx = db.transaction(stores, 'readwrite');
    let forgotten = false;
    let identityChanged = false;
    const saved: AssetIndexRecord[] = new Array(records.length);
    records.forEach((record, position) => {
      withActiveAsset(tx, record.assetId, () => {
        withRelocatedMedia(tx, record, (next) => {
          const store = tx.objectStore(STORE_ASSET_INDEX);
          const request = store.get(next.assetId);
          request.onsuccess = () => {
            const current = request.result as AssetIndexRecord | undefined;
            if (options.requireExistingPath && current?.path !== next.path) {
              identityChanged = true;
              tx.abort();
              return;
            }
            const lastUsedAt = latestAssetUsageTime(next.lastUsedAt, current?.lastUsedAt);
            const merged = { ...next };
            if (!merged.contentDigest && current?.size === next.size && current.mtimeMs === next.mtimeMs) {
              merged.contentDigest = current.contentDigest;
            }
            if (lastUsedAt === undefined) delete merged.lastUsedAt;
            else merged.lastUsedAt = lastUsedAt;
            const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(merged)] as Array<keyof AssetIndexRecord>);
            keys.delete('updatedAt');
            const unchanged = options.skipUnchanged && current
              && [...keys].every((key) => Object.is(current[key], merged[key]));
            saved[position] = unchanged && current ? current : merged;
            if (!unchanged) store.put(merged);
          };
          if (options.migrateLegacyTags) {
            const tags = tx.objectStore(STORE_ASSET_META_V2);
            const currentTags = tags.get(next.assetId);
            currentTags.onsuccess = () => {
              // 已有标签（包括用户主动清空的标签）不再被旧路径标签覆盖。
              if (currentTags.result) return;
              const legacy = tx.objectStore(STORE_ASSET_META).get(record.path);
              legacy.onsuccess = () => {
                const old = legacy.result as LegacyAssetMetaRecord | undefined;
                if (old?.tags?.length) tags.put({ assetId: next.assetId, path: next.path,
                  tags: old.tags, taggedBy: old.taggedBy, updatedAt: old.updatedAt } satisfies AssetMetaRecord);
              };
            };
          }
        });
      }, () => { forgotten = true; });
    });
    tx.oncomplete = () => resolve(saved);
    tx.onerror = tx.onabort = () => reject(new Error(forgotten ? '素材已被清理，请重新加载后重试'
      : identityChanged ? '资产身份已变化，请重新扫描' : '文件引用写入事务失败'));
  });
}

export async function putAssetIndex(record: AssetIndexRecord): Promise<void> {
  await putAssetIndexes([record]);
}

/** Forget only identities already verified missing by the file service; never delete disk files. */
export async function forgetMissingAssetRecords(
  expected: readonly AssetIndexRecord[], options: DramaAssetWriteOptions = {},
): Promise<{ assetIds: string[]; historyIds: string[]; deletedHistoryCounts: Record<string, number> }> {
  assertDramaAssetWriteCurrent(options);
  const snapshot = expected.map((record) => ({ ...record }));
  const assetIds = new Set(snapshot.map((record) => record.assetId));
  if (snapshot.length > 500 || assetIds.size !== snapshot.length || snapshot.some((record) => (
    typeof record.assetId !== 'string' || !record.assetId.trim() || record.assetId.length > 256
    || typeof record.path !== 'string' || !record.path.trim() || !imageHistoryReferenceKey(record.path)
  ))) throw new Error('失效素材清理批次无效');
  if (!snapshot.length) return { assetIds: [], historyIds: [], deletedHistoryCounts: {} };
  const paths = new Set(snapshot.map((record) => imageHistoryReferenceKey(record.path)!));
  const db = await openDB();
  assertDramaAssetWriteCurrent(options);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ASSET_INDEX, STORE_ASSET_META, STORE_ASSET_META_V2, STORE_METADATA, STORE_HISTORY], 'readwrite');
    const indexes = tx.objectStore(STORE_ASSET_INDEX);
    const metadata = tx.objectStore(STORE_METADATA);
    const historyIds: string[] = [];
    const counts = new Map<string, number>();
    let failure: unknown;
    let scanned = 0;
    let remaining = snapshot.length;
    const fail = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* 已有终态。 */ } };
    const abort = () => fail(new DOMException('失效素材清理已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => {
      cleanup();
      // The committed removal is authoritative even if the view has just closed.
      resolve({ assetIds: [...assetIds], historyIds, deletedHistoryCounts: Object.fromEntries(counts) });
    };
    tx.onerror = tx.onabort = () => { cleanup(); reject(failure ?? new Error('失效素材清理保存失败')); };
    const scan = (store: IDBObjectStore, visit: (cursor: IDBCursorWithValue) => void, range?: IDBKeyRange) => {
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          assertDramaAssetWriteCurrent(options);
          if (++scanned > 100_000) throw new Error('失效素材清理扫描超过上限，请按目录分批处理');
          visit(cursor); cursor.continue();
        } catch (error) { fail(error); }
      };
    };
    const remove = () => {
      assertDramaAssetWriteCurrent(options);
      const forgottenAt = Date.now();
      for (const record of snapshot) {
        indexes.delete(record.assetId);
        tx.objectStore(STORE_ASSET_META_V2).delete(record.assetId);
        metadata.put({ id: forgottenAssetKey(record.assetId), assetId: record.assetId, forgottenAt });
      }
      for (const path of paths) {
        const marker = metadata.get(forgottenPathKey(path));
        marker.onsuccess = () => {
          try {
            assertDramaAssetWriteCurrent(options);
            const previous = cleanupTimestamp(marker.result);
            metadata.put({ id: forgottenPathKey(path), forgottenAt: Math.max(forgottenAt, previous ?? 0) });
          } catch (error) { fail(error); }
        };
      }
      const recent = metadata.get(RECENT_ASSET_USAGE_KEY);
      recent.onsuccess = () => {
        try {
          assertDramaAssetWriteCurrent(options);
          if (recent.result === undefined) return;
          if (!Array.isArray(recent.result.entries)) throw new Error('失效素材清理记录无效，请检查存储');
          metadata.put({ ...recent.result, entries: recent.result.entries.filter((entry: AssetUsageRecord) => !assetIds.has(entry?.assetId)) });
        } catch (error) { fail(error); }
      };
      scan(tx.objectStore(STORE_ASSET_META), (cursor) => {
        const path = imageHistoryReferenceKey(cursor.value.path);
        if (path && paths.has(path)) cursor.delete();
      });
      scan(metadata, (cursor) => {
        if (assetIds.has(cursor.value.assetId)) cursor.delete();
      }, IDBKeyRange.bound(ASSET_IMAGE_PREFIX, `${ASSET_IMAGE_PREFIX}\uffff`));
      scan(tx.objectStore(STORE_HISTORY), (cursor) => {
        const record = cursor.value as HistoryRecord;
        if (!historyOutputKeys(record).some((path) => paths.has(path))) return;
        if (typeof record.id !== 'string' || typeof record.projectId !== 'string') throw new Error('失效素材清理记录无效，请检查存储');
        historyIds.push(record.id);
        counts.set(record.projectId, (counts.get(record.projectId) ?? 0) + 1);
        metadata.put({ id: forgottenHistoryKey(record.id), historyId: record.id, forgottenAt });
        cursor.delete();
      });
    };
    for (const before of snapshot) {
      const request = indexes.get(before.assetId);
      request.onsuccess = () => {
        try {
          assertDramaAssetWriteCurrent(options);
          const current = request.result as AssetIndexRecord | undefined;
          if (!current || imageHistoryReferenceKey(current.path) !== imageHistoryReferenceKey(before.path)
            || current.fingerprint !== before.fingerprint || current.size !== before.size || current.mtimeMs !== before.mtimeMs
            || current.contentDigest !== before.contentDigest || current.updatedAt !== before.updatedAt || current.status !== before.status
            || current.source !== before.source || current.projectId !== before.projectId || current.rootPath !== before.rootPath
            || current.relativePath !== before.relativePath) throw new Error('素材身份或位置已变化，请重新预览');
          if (--remaining === 0) remove();
        } catch (error) { fail(error); }
      };
    }
    if (options.signal?.aborted) abort();
  });
}

/** 仅回收尚未提交的资产包索引；位置已改变的记录不属于本轮可清理范围。 */
export async function deleteImportedAssetIndexes(entries: readonly { assetId: string; path: string }[]): Promise<void> {
  if (!entries.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readwrite');
    const store = tx.objectStore(STORE_ASSET_INDEX);
    for (const entry of entries) {
      const request = store.get(entry.assetId);
      request.onsuccess = () => {
        if (request.result?.assetId === entry.assetId && request.result.path === entry.path) store.delete(entry.assetId);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('导入资产索引清理失败'));
  });
}

/** 保存 / 更新单条消息 */
export async function putChatMessage(record: ChatMessageRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_MESSAGES, STORE_METADATA], 'readwrite');
    withRelocatedMedia(tx, record, (next) => tx.objectStore(STORE_CHAT_MESSAGES).put(next));
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 获取指定会话的消息（分页，按 sequence 倒序） */
export async function getConversationMessages(
  conversationId: string,
  offset: number = 0,
  limit: number = 50,
): Promise<{ messages: ChatMessageRecord[]; total: number }> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readonly');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    const index = store.index('conversationId_sequence');
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Infinity],
    );
    // 先获取总数
    const countReq = index.count(range);
    countReq.onsuccess = () => {
      const total = countReq.result;
      // 再获取分页数据（cursor 倒序）
      const cursorReq = index.openCursor(range, 'prev');
      const messages: ChatMessageRecord[] = [];
      let skipped = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve({ messages, total });
          return;
        }
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }
        if (messages.length < limit) {
          messages.push(cursor.value as ChatMessageRecord);
          cursor.continue();
        } else {
          resolve({ messages, total });
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
  });
}

/**
 * 保存单条消息，并在同一读写事务内分配 sequence：
 * - 已存在的消息（同 id）保留原 sequence，避免更新时被重排到末尾；
 * - 新消息取当前会话最大 sequence + 1。
 *
 * 事务内读改写让 IndexedDB 串行化并发调用（如用户消息与助手占位同时落盘），
 * 从而不会分配到重复 sequence。返回最终写入的 sequence。
 */
export async function putChatMessageWithSequence(
  record: ChatMessageRecord,
): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_MESSAGES, STORE_METADATA], 'readwrite');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    let sequence = record.sequence;
    const existingReq = store.get(record.id);
    existingReq.onsuccess = () => {
      const existing = existingReq.result as ChatMessageRecord | undefined;
      if (existing) {
        sequence = existing.sequence;
        withRelocatedMedia(tx, { ...record, sequence }, (next) => store.put(next));
        return;
      }
      const index = store.index('conversationId_sequence');
      const range = IDBKeyRange.bound(
        [record.conversationId, 0],
        [record.conversationId, Infinity],
      );
      const cursorReq = index.openCursor(range, 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        sequence = cursor ? (cursor.value as ChatMessageRecord).sequence + 1 : 0;
        withRelocatedMedia(tx, { ...record, sequence }, (next) => store.put(next));
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    existingReq.onerror = () => reject(existingReq.error);
    tx.oncomplete = () => resolve(sequence);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 删除指定会话的全部消息 */
export async function deleteConversationMessages(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readwrite');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    const index = store.index('conversationId_sequence');
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Infinity],
    );
    const cursorReq = index.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 在事务中同时删除会话和全部消息 */
export async function permanentlyDeleteConversation(convId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_AGENT_TASKS],
      'readwrite',
    );
    // 删除会话
    tx.objectStore(STORE_CHAT_CONVERSATIONS).delete(convId);
    // 删除消息
    const msgStore = tx.objectStore(STORE_CHAT_MESSAGES);
    const msgIndex = msgStore.index('conversationId_sequence');
    const range = IDBKeyRange.bound([convId, 0], [convId, Infinity]);
    const cursorReq = msgIndex.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    // 删除该会话的 Agent 任务。
    const taskStore = tx.objectStore(STORE_AGENT_TASKS);
    const taskIndex = taskStore.index('conversationId_updatedAt');
    const taskRange = IDBKeyRange.bound([convId, 0], [convId, Infinity]);
    const taskCursorReq = taskIndex.openCursor(taskRange);
    taskCursorReq.onsuccess = () => {
      const cursor = taskCursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Agent Tasks CRUD
// ============================================

export type AgentTaskRecord = AgentTask;

export async function putAgentTask(record: AgentTaskRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AGENT_TASKS, STORE_METADATA], 'readwrite');
    withRelocatedMedia(tx, record, (next) => tx.objectStore(STORE_AGENT_TASKS).put(next));
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

export async function getAgentTask(id: string): Promise<AgentTaskRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const request = tx.objectStore(STORE_AGENT_TASKS).get(id);
    request.onsuccess = () => resolve((request.result as AgentTaskRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function getProjectAgentTasks(projectId: string): Promise<AgentTaskRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as AgentTaskRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function getConversationAgentTasks(
  conversationId: string,
): Promise<AgentTaskRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('conversationId_updatedAt');
    const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as AgentTaskRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteAgentTask(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readwrite');
    tx.objectStore(STORE_AGENT_TASKS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteConversationAgentTasks(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readwrite');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('conversationId_updatedAt');
    const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Infinity]);
    const cursorRequest = index.openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProjectAgentTasks(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readwrite');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const cursorRequest = index.openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Project Memory CRUD
// ============================================

export type ProjectMemoryRecord = ProjectMemory;

export async function putProjectMemory(record: ProjectMemoryRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    tx.objectStore(STORE_PROJECT_MEMORIES).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProjectMemories(projectId: string): Promise<ProjectMemoryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readonly');
    const index = tx.objectStore(STORE_PROJECT_MEMORIES).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as ProjectMemoryRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteProjectMemory(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    tx.objectStore(STORE_PROJECT_MEMORIES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProjectMemories(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    const index = tx.objectStore(STORE_PROJECT_MEMORIES).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const cursorRequest = index.openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 把某会话来源的记忆标记为来源不可用，不删除记忆本身。 */
export async function markConversationMemoriesUnavailable(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    const index = tx.objectStore(STORE_PROJECT_MEMORIES).index('conversationId');
    const cursorRequest = index.openCursor(IDBKeyRange.only(conversationId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        const record = cursor.value as ProjectMemoryRecord;
        if (!record.source.unavailable) {
          cursor.update({ ...record, source: { ...record.source, unavailable: true } });
        }
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Toolbar Layouts persistence (single record)
// ============================================

const TOOLBAR_LAYOUTS_KEY = 'layouts';

export async function saveToolbarLayoutsToDb(data: Record<string, unknown>): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = createDurableSettingsTransaction(db, STORE_TOOLBAR_LAYOUTS);
    tx.objectStore(STORE_TOOLBAR_LAYOUTS).put({ id: TOOLBAR_LAYOUTS_KEY, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Toolbar transaction aborted', 'AbortError'));
  });
}

function toolbarRecordData(record: unknown): Record<string, unknown> | null {
  if (record === undefined) return null;
  const data = (record as { data?: unknown } | null)?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new StorageError('toolbar-read', 'corrupt');
  }
  return data as Record<string, unknown>;
}

/** 同一事务内读取最新记录，只更新一个节点类型，保留其他实例保存的布局。 */
export async function saveToolbarLayoutToDb(nodeType: string, layout: unknown | null, expected?: { baseline: unknown }): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = createDurableSettingsTransaction(db, STORE_TOOLBAR_LAYOUTS);
    const store = tx.objectStore(STORE_TOOLBAR_LAYOUTS);
    const request = store.get(TOOLBAR_LAYOUTS_KEY);
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const next = { ...toolbarRecordData(request.result) };
        if (expected && !configValuesEqual(next[nodeType] ?? null, expected.baseline)
          && !configValuesEqual(next[nodeType] ?? null, layout)) throw new StorageError('toolbar-write', 'conflict');
        if (layout === null) delete next[nodeType];
        else Object.defineProperty(next, nodeType, { value: layout, enumerable: true, configurable: true, writable: true });
        store.put({ id: TOOLBAR_LAYOUTS_KEY, data: next });
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('Toolbar transaction aborted', 'AbortError'));
  });
}

export async function loadToolbarLayoutsFromDb(): Promise<Record<string, unknown> | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TOOLBAR_LAYOUTS, 'readonly');
    const request = tx.objectStore(STORE_TOOLBAR_LAYOUTS).get(TOOLBAR_LAYOUTS_KEY);
    let data: Record<string, unknown> | null = null;
    let failure: unknown;
    request.onsuccess = () => {
      try { data = toolbarRecordData(request.result); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(data);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('Toolbar transaction aborted', 'AbortError'));
  });
}

// ============================================
// Project visual descriptions
// ============================================

export async function getProjectVisualDescription(
  projectId: string,
  fingerprint: string,
): Promise<ProjectVisualDescription | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_PROJECT_VISUAL_DESCRIPTIONS, 'readonly')
      .objectStore(STORE_PROJECT_VISUAL_DESCRIPTIONS)
      .index('projectId_fingerprint')
      .get([projectId, fingerprint]);
    request.onsuccess = () => resolve(request.result as ProjectVisualDescription | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function putProjectVisualDescription(
  record: ProjectVisualDescription,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_VISUAL_DESCRIPTIONS, 'readwrite');
    tx.objectStore(STORE_PROJECT_VISUAL_DESCRIPTIONS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
