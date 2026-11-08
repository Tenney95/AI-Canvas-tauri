/** 新项目更新中，剪辑记录与作品正文必须在同一事务比较并提交。 */
import type { VideoEditorProjectRecord } from '../../types/videoEditor';
import { configValuesEqual } from '../configPatch';
import { validateNativeVideoEditorRecord } from '../videoEditorRecordValidation';
import { safeExchangePath } from '../projectExchangeDomain';
import type { ProjectModelTransferExchange, ProjectModelTransferMedia } from '../../types/projectModelTransfer';

const EDITOR_PREFIX = 'video-editor:';
const LEASE_PREFIX = 'video-editor-lease:';
const REQUEST_LIMIT = 200_000;
type Envelope = { projectId: string; kind: 'video-editor-v1'; ownerProjectId: string; canvasId: string; record: VideoEditorProjectRecord };

function validateRecords(records: readonly VideoEditorProjectRecord[], canvasIds: readonly string[]): VideoEditorProjectRecord[] {
  if (!Array.isArray(records) || records.length > REQUEST_LIMIT || !Array.isArray(canvasIds)) throw new Error('剪辑工程更新材料无效');
  const allowed = new Set(canvasIds), ids = new Set<string>();
  if (allowed.size !== canvasIds.length) throw new Error('画布身份重复');
  return [...records].map((record) => {
    if (!record || !allowed.has(record.projectId) || ids.has(record.id)) throw new Error('剪辑工程画布归属无效或工程重复');
    validateNativeVideoEditorRecord(record, record.projectId);
    ids.add(record.id);
    return structuredClone(record);
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 更新/恢复 journal 独立核验目标工程的每个文件身份，不能只相信 UI 或导入包。 */
export function validateNativeVideoEditorUpdateMedia(input: {
  records: readonly VideoEditorProjectRecord[];
  canvasIds: readonly string[];
  primaryRoot: string;
  exchange: ProjectModelTransferExchange;
  media: readonly ProjectModelTransferMedia[];
  oldAssets: readonly { rootRef: string; path: string; bytes: number; sha256: string }[];
}): void {
  const records = validateRecords(input.records, input.canvasIds);
  if (!input.exchange || !Array.isArray(input.media) || !Array.isArray(input.oldAssets)) throw new Error('剪辑素材清单无效');
  const roots = input.exchange.identities.filter((item) => item.kind === 'storage-root' && item.localId === input.primaryRoot);
  if (roots.length !== 1) throw new Error('剪辑素材根身份不唯一');
  for (const record of records) for (const track of record.tracks) for (const clip of track.clips) {
    if (clip.kind !== 'text' && !clip.relativePath) throw new Error('剪辑素材尚未物化');
    if (!clip.relativePath) continue;
    const path = safeExchangePath(clip.relativePath);
    if (path !== clip.relativePath) throw new Error('剪辑素材路径无效');
    const bindings = input.exchange.fileBindings.filter((item) => item.rootRef === roots[0].sourceId && item.localRelativePath === path);
    if (bindings.length !== 1) throw new Error('剪辑素材缺少唯一的协作文件映射');
    const published = input.media.filter((item) => item.rootRef === input.primaryRoot && item.relativePath === path);
    const retained = input.oldAssets.filter((item) => item.rootRef === input.primaryRoot && item.path === path);
    const candidates = [...published, ...retained];
    if (candidates.length !== 1 || !Number.isSafeInteger(candidates[0].bytes) || candidates[0].bytes < 0
      || !/^[a-f0-9]{64}$/.test(candidates[0].sha256)) throw new Error('剪辑素材缺少唯一核验的发布或原有文件');
  }
}

const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error ?? new Error('剪辑工程事务失败'));
});

/**
 * store 必须来自与作品根、画布和恢复点共用的 readwrite 事务。
 * 严格比较全部本机工程；任何不明归属均失败，不能因扫描异常将工程当作空列表。
 */
export async function replaceNativeVideoEditorInTransaction(store: IDBObjectStore, input: {
  projectId: string;
  expected: readonly VideoEditorProjectRecord[];
  expectedRetired: readonly VideoEditorProjectRecord[];
  next: readonly VideoEditorProjectRecord[];
  oldCanvasIds: readonly string[];
  retiredCanvasIds: readonly string[];
  nextCanvasIds: readonly string[];
}): Promise<void> {
  if (!input.projectId || store.transaction.mode !== 'readwrite') throw new Error('剪辑工程事务无效');
  const expected = validateRecords(input.expected, input.oldCanvasIds), next = validateRecords(input.next, input.nextCanvasIds);
  const expectedRetired = validateRecords(input.expectedRetired, input.retiredCanvasIds);
  const retiredCanvasIds = new Set(input.retiredCanvasIds);
  if (input.oldCanvasIds.some((id) => retiredCanvasIds.has(id)) || input.nextCanvasIds.some((id) => retiredCanvasIds.has(id))) {
    throw new Error('活动与历史画布身份冲突');
  }
  const existing: Envelope[] = [];
  await new Promise<void>((resolve, reject) => {
    const query = store.openCursor(IDBKeyRange.bound(EDITOR_PREFIX, `${EDITOR_PREFIX}\uffff`));
    let count = 0;
    query.onsuccess = () => {
      const cursor = query.result;
      if (!cursor) { resolve(); return; }
      const value = cursor.value as Partial<Envelope>;
      if (++count > REQUEST_LIMIT || !value || value.kind !== 'video-editor-v1'
        || typeof value.ownerProjectId !== 'string' || typeof value.canvasId !== 'string'
        || !value.record || value.projectId !== `${EDITOR_PREFIX}${value.record.id}`
        || value.canvasId !== value.record.projectId || cursor.primaryKey !== value.projectId) {
        reject(new Error('剪辑工程索引损坏，未更新')); return;
      }
      if (value.ownerProjectId === input.projectId) existing.push(value as Envelope);
      cursor.continue();
    };
    query.onerror = () => reject(query.error ?? new Error('剪辑工程扫描失败'));
  });
  const active = existing.filter((item) => input.oldCanvasIds.includes(item.canvasId));
  const retired = existing.filter((item) => retiredCanvasIds.has(item.canvasId));
  if (active.length + retired.length !== existing.length
    || !configValuesEqual(validateRecords(active.map((item) => item.record), input.oldCanvasIds), expected)
    || !configValuesEqual(validateRecords(retired.map((item) => item.record), input.retiredCanvasIds), expectedRetired)) {
    throw new Error('剪辑工程在更新前已变化，请重新对比');
  }
  // 原有墓碑工程始终保留；被本次删除的活动画布同事务变为墓碑，
  // 其工程也必须原样保留，不能因选择了包内版本而静默丢失。
  const nextCanvases = new Set(input.nextCanvasIds);
  for (const row of active) if (nextCanvases.has(row.canvasId)) await request(store.delete(row.projectId));
  for (const record of next) {
    const row: Envelope = { projectId: `${EDITOR_PREFIX}${record.id}`, kind: 'video-editor-v1',
      ownerProjectId: input.projectId, canvasId: record.projectId, record };
    // add 而非覆盖；跨作品异常同键必须终止整个事务。
    await request(store.add(row));
  }
  for (const canvasId of new Set([...input.oldCanvasIds, ...input.nextCanvasIds])) {
    const key = `${LEASE_PREFIX}${canvasId}`;
    const lease = await request(store.get(key)) as { kind?: unknown; ownerProjectId?: unknown; canvasId?: unknown } | undefined;
    if (!lease) continue;
    if (lease.kind !== 'video-editor-lease-v1' || lease.ownerProjectId !== input.projectId || lease.canvasId !== canvasId) {
      throw new Error('剪辑窗口租约归属异常');
    }
    await request(store.delete(key));
  }
}
