/** 可调用 Skill 的本机最近使用偏好；不修改 Skill 正文或读取租约。 */
import { hasControlCharacters } from '../../utils/controlCharacters';
import { openDB, STORE_METADATA } from './schema';

export const RECENT_SKILL_IDS_KEY = 'recent-skill-ids';
const MAX_RECENT_SKILLS = 5;
const MAX_STORED_IDS = 100;

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_STORED_IDS
    || value.some((id) => typeof id === 'string' && id.length > 256 || typeof id === 'object' && id !== null)) {
    throw new Error('最近使用 Skill 记录格式异常');
  }
  const ids = value.filter((id): id is string => typeof id === 'string' && !!id
    && id === id.trim() && !hasControlCharacters(id));
  return [...new Set(ids)].slice(0, MAX_RECENT_SKILLS);
}

export async function loadRecentSkillIds(): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    let ids: string[] = [], failure: unknown;
    const request = tx.objectStore(STORE_METADATA).get(RECENT_SKILL_IDS_KEY);
    request.onsuccess = () => {
      if (request.result === undefined) return;
      try {
        const record: unknown = request.result;
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || Object.keys(record).some((key) => key !== 'id' && key !== 'skillIds')
          || !('skillIds' in record)) throw new Error('最近使用 Skill 记录格式异常');
        ids = normalizeIds(record.skillIds);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(ids);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('最近使用 Skill 读取已中止', 'AbortError'));
  });
}

export async function saveRecentSkillIds(skillIds: readonly string[]): Promise<void> {
  const ids = normalizeIds(skillIds);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    let failure: unknown;
    tx.objectStore(STORE_METADATA).put({ id: RECENT_SKILL_IDS_KEY, skillIds: ids });
    tx.oncomplete = () => resolve();
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('最近使用 Skill 保存已中止', 'AbortError'));
  });
}
