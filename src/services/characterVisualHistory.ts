import { t } from '../i18n';
import type { CharacterVisualRun, CharacterVisualTarget } from './characterVisualWorkbenchService';
import type { CharacterImageTaskRecovery } from '../types/media';
import { getRelativeAssetPath, resolveIndexedAssetPath } from './fs/assetIndex';
import { joinPath } from './fs/core';
import { openDB, STORE_METADATA } from './indexedDb/schema';

export interface StoredCharacterVisualCandidate {
  id: string;
  relativePath: string;
  assetId?: string;
  bytes: number;
  digest: string;
}

export interface StoredCharacterVisualRun extends Omit<CharacterVisualRun, 'id' | 'candidates'> {
  id: string;
  operationId: string;
  name: string;
  sent: boolean;
  native: boolean;
  nativeLocal?: boolean;
  draft: boolean;
  projectEpoch?: number;
  fingerprint: string;
  candidates: StoredCharacterVisualCandidate[];
  recovery?: CharacterImageTaskRecovery;
}

const HISTORY_PREFIX = 'character-visual-run-v1:';
const operationIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const legacyCandidateName = /^Library\/character-visual-[0-9a-f-]{36}-\d+\.(?:png|jpg|webp)$/;

export const characterVisualOperations = new Set<CharacterVisualRun['operation']>(['appearance', 'turnaround', 'edit']);
export const isSafeCharacterVisualId = (id: string | undefined) => Boolean(id && /^[A-Za-z0-9_.-]{1,256}$/.test(id));

export function characterVisualScopePrefix(target: Pick<CharacterVisualTarget, 'scope' | 'ownerId'>): string {
  if (target.scope === 'global') return `${HISTORY_PREFIX}global:`;
  if (target.scope !== 'project' || !isSafeCharacterVisualId(target.ownerId)) throw new Error(t('角色素材归属已变化'));
  return `${HISTORY_PREFIX}project:${target.ownerId}:`;
}

export function readCharacterVisualRows<T>(prefix: string, visit: (row: StoredCharacterVisualRun) => boolean, finish: () => T): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_METADATA, 'readonly');
    const cursor = transaction.objectStore(STORE_METADATA).openCursor(
      IDBKeyRange.bound(prefix, `${prefix}\uffff`), 'prev',
    );
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      const row = item.value as StoredCharacterVisualRun;
      if (row?.target && row.id === item.key && operationIdPattern.test(row.operationId)
        && characterVisualOperations.has(row.operation) && Array.isArray(row.candidates) && Array.isArray(row.references)
        && !visit(row)) return;
      item.continue();
    };
    transaction.oncomplete = () => resolve(finish());
    transaction.onabort = () => reject(transaction.error ?? new Error(t('角色生成历史读取失败')));
  }));
}

export function characterVisualCandidateFolder(row: StoredCharacterVisualRun): string {
  return row.target.scope === 'global' ? row.operationId : row.nativeLocal ? 'imports/character-visual' : 'Library';
}

export function matchesOriginalCharacterVisualCandidatePath(row: StoredCharacterVisualRun, candidate: StoredCharacterVisualCandidate): boolean {
  const folder = characterVisualCandidateFolder(row);
  const stem = row.target.scope === 'global' ? candidate.id : `character-visual-${candidate.id}`;
  const extension = candidate.relativePath.split('.').at(-1);
  return !!extension && ['png', 'jpg', 'webp'].includes(extension) && /^\d+$/.test(candidate.id.slice(row.operationId.length + 1))
    && candidate.id.startsWith(`${row.operationId}-`) && candidate.relativePath === `${folder}/${stem}.${extension}`;
}

export function isLegacyCharacterVisualCandidatePath(path: string): boolean {
  return legacyCandidateName.test(path);
}

/** 存储健康只读取所属项目的候选相对路径，保留历史与已改名的索引原件。 */
export async function collectLegacyCharacterVisualPaths(ownerId: string, root: string): Promise<string[]> {
  const candidates: StoredCharacterVisualCandidate[] = [];
  await readCharacterVisualRows(characterVisualScopePrefix({ scope: 'project', ownerId }), (row) => {
    if (!row.native && row.target.scope === 'project' && row.target.ownerId === ownerId) {
      for (const candidate of row.candidates) {
        if (matchesOriginalCharacterVisualCandidatePath(row, candidate)) candidates.push(candidate);
      }
    }
    return true;
  }, () => undefined);
  return Promise.all(candidates.map(async (candidate) => {
    const indexedPath = candidate.assetId ? await resolveIndexedAssetPath(candidate.assetId) : undefined;
    return indexedPath && getRelativeAssetPath(indexedPath, root) ? indexedPath : joinPath(root, candidate.relativePath);
  }));
}
