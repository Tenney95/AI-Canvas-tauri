import { t } from '../../i18n';
import type { DramaAsset, DramaAssetWriteOptions, DramaCharacter, DramaProp, DramaScene } from '../../types/dramaAssets';
import { assertDramaAssetWriteCurrent, MAX_CHARACTER_WEAPONS, normalizeCharacterWeaponIds } from '../../types/dramaAssets';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import type { AssetIndexRecord } from '../indexedDbService';
import { withRelocatedMedia } from './mediaRelocations';
import { imageHistoryReferenceKey } from './outputHistoryRepository';
import { openDB, STORE_ASSET_INDEX, STORE_GLOBAL_CHARACTERS, STORE_GLOBAL_DRAMA_ASSETS, STORE_METADATA } from './schema';

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
