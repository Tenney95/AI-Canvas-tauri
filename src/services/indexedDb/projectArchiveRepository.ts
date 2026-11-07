/** 旧模型归档的一致捕获；作品、可见历史和协作状态来自同一个只读事务。 */
import type { ProjectSaveData } from '../storageService';
import type { ProjectArchiveChatPayload } from '../projectTransferService';
import type { ProjectExchangeState, ProjectExchangeStoredRevision } from '../../types/projectExchange';
import { configValuesEqual } from '../configPatch';
import { portableArchiveChat } from '../projectArchiveValidation';
import { PROJECT_EXCHANGE_LIMITS } from '../projectExchangeFormat';
import { openDB, STORE_PROJECTS, STORE_METADATA, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES,
  STORE_PROJECT_MEMORIES, STORE_PROJECT_EXCHANGE_STATES, STORE_PROJECT_EXCHANGE_SNAPSHOTS } from './schema';
import { withLegacyProjectWrite } from './legacyProjectWriteGuard';
import { sha256BytesHex } from '../mediaDataUrl';

export interface LegacyProjectArchiveCapture {
  records: ProjectSaveData[];
  chat: ProjectArchiveChatPayload[];
  state: ProjectExchangeState | null;
  graph: ProjectExchangeStoredRevision[];
}

export async function captureLegacyProjectArchive(projectId: string): Promise<LegacyProjectArchiveCapture> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_METADATA, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES,
      STORE_PROJECT_MEMORIES, STORE_PROJECT_EXCHANGE_STATES, STORE_PROJECT_EXCHANGE_SNAPSHOTS], 'readonly');
    let failure: unknown;
    let ownerId: string;
    const records: ProjectSaveData[] = [], graph: ProjectExchangeStoredRevision[] = [];
    const history = new Map<string, ProjectArchiveChatPayload>();
    let state: ProjectExchangeState | null = null, bytes = 0, rows = 0;
    const guard = (work: () => void) => { try { work(); } catch (error) { failure = error; tx.abort(); } };
    const account = (value: unknown) => {
      bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (++rows > PROJECT_EXCHANGE_LIMITS.values || bytes > PROJECT_EXCHANGE_LIMITS.bundleBytes) {
        throw new Error('项目与历史超过归档捕获上限，未截断导出');
      }
    };
    const readHistory = (id: string) => {
      const payload: ProjectArchiveChatPayload = { conversations: [], messages: [], memories: [] };
      history.set(id, payload);
      const range = IDBKeyRange.bound([id, 0], [id, Infinity]);
      const conversations = tx.objectStore(STORE_CHAT_CONVERSATIONS).index('projectId_updatedAt').openCursor(range);
      conversations.onsuccess = () => guard(() => {
        const cursor = conversations.result; if (!cursor) return;
        const conversation = cursor.value as ProjectArchiveChatPayload['conversations'][number];
        if (!conversation.deletedAt) {
          account(conversation); payload.conversations.push(conversation);
          if (payload.conversations.length > 100_000) throw new Error('项目会话超过归档上限');
          let count = 0;
          const messages = tx.objectStore(STORE_CHAT_MESSAGES).index('conversationId_sequence')
            .openCursor(IDBKeyRange.bound([conversation.id, 0], [conversation.id, Infinity]));
          messages.onsuccess = () => guard(() => {
            const message = messages.result; if (!message) return;
            if (++count > 100_000) throw new Error('会话消息超过归档上限，未截断导出');
            if (message.value.projectId !== id) throw new Error('会话消息归属异常，未导出');
            account(message.value); payload.messages.push(message.value); message.continue();
          });
        }
        cursor.continue();
      });
      const memories = tx.objectStore(STORE_PROJECT_MEMORIES).index('projectId_updatedAt').openCursor(range);
      memories.onsuccess = () => guard(() => {
        const cursor = memories.result; if (!cursor) return;
        account(cursor.value); payload.memories.push(cursor.value); cursor.continue();
      });
    };
    withLegacyProjectWrite(tx, () => {
      const source = tx.objectStore(STORE_PROJECTS).get(projectId);
      source.onsuccess = () => guard(() => {
        if (!source.result) throw new Error('未找到项目数据，无法捕获归档');
        ownerId = source.result.parentId ?? source.result.id;
        const projects = tx.objectStore(STORE_PROJECTS).openCursor();
        projects.onsuccess = () => guard(() => {
          const cursor = projects.result; if (!cursor) return;
          const record = cursor.value as ProjectSaveData;
          if (record.id === ownerId || record.parentId === ownerId) {
            account(record); records.push(record); readHistory(record.id);
          }
          cursor.continue();
        });
        const exchange = tx.objectStore(STORE_PROJECT_EXCHANGE_STATES).get(ownerId);
        exchange.onsuccess = () => guard(() => {
          state = exchange.result ?? null;
          if (!state) return;
          account(state);
          const revisions = tx.objectStore(STORE_PROJECT_EXCHANGE_SNAPSHOTS).index('lineageId').openCursor(state.lineageId);
          revisions.onsuccess = () => guard(() => {
            const cursor = revisions.result; if (!cursor) return;
            account(cursor.value); graph.push(cursor.value);
            if (graph.length > PROJECT_EXCHANGE_LIMITS.revisions) throw new Error('协作历史超过归档上限');
            cursor.continue();
          });
        });
      });
    }, (error) => { failure = error; });
    tx.oncomplete = () => {
      try {
        const owner = records.find((record) => record.id === ownerId);
        if (!owner || owner.parentId) throw new Error('所属项目缺失，无法捕获归档');
        const sorted = [owner, ...records.filter((record) => record !== owner).sort((a, b) =>
          (a.episodeNo ?? 0) - (b.episodeNo ?? 0) || a.id.localeCompare(b.id))];
        const capture = { records: sorted, chat: sorted.map((record) => portableArchiveChat(history.get(record.id)!)), state, graph };
        const bindOrigins = async () => {
          for (const payload of capture.chat) for (const [kind, values] of [['conversation', payload.conversations], ['message', payload.messages], ['memory', payload.memories]] as const) {
            for (const value of values) value.archiveOriginId ??= await sha256BytesHex(new TextEncoder().encode(JSON.stringify([`legacy-project:${ownerId}`, kind, value.id])));
          }
          return capture;
        };
        void bindOrigins().then(resolve, reject);
      } catch (error) { reject(error); }
    };
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('项目归档捕获失败'));
  });
}

/** 包含集合/历史/状态；不能只比较根项目的 updatedAt。 */
export async function assertLegacyProjectArchiveCurrent(capture: LegacyProjectArchiveCapture): Promise<void> {
  const current = await captureLegacyProjectArchive(capture.records[0].id);
  if (!configValuesEqual(current, capture)) throw new Error('项目、分集、历史或协作版本在导出期间变化，请重新导出');
}
