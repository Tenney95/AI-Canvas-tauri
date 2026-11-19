/** 新旧项目目录的只读判别；未知、损坏或身份冲突时不得回退到另一份数据。 */
import { getAllProjects, getProjectById } from './indexedDbService';
import { openDB, STORE_METADATA, STORE_PROJECTS } from './indexedDb/schema';
import { configValuesEqual } from './configPatch';
import type { NativeProjectAggregate, NativeProjectIdentities } from './indexedDb/nativeProjectRepository';

type LegacySummary = Awaited<ReturnType<typeof getAllProjects>>[number];
type LegacyProject = NonNullable<Awaited<ReturnType<typeof getProjectById>>>;
type NativeProject = NativeProjectAggregate;

export type ProjectCatalogEntry =
  | { dataModel: 'legacy'; project: LegacySummary }
  | { dataModel: 'native'; project: NativeProject['project']; episodes: NativeProject['episodes']; episodeIds: string[]; canvasIds: string[] };
export type ResolvedProjectModel =
  | { dataModel: 'legacy'; project: LegacyProject }
  | { dataModel: 'native'; target: 'project' | 'episode' | 'canvas'; aggregate: NativeProject }
  | { dataModel: 'missing' };

/**
 * 同一身份属于多个对象时拒绝；打开时再次核对项目目录与聚合，
 * 不凭 ID 前缀、缺失摘要或旧表查询失败推断来源。新库探测不会创建新库；
 * 旧库沿用应用现有 openDB 初始化规则，不对旧记录做结构迁移。
 * 两库只读快照不是跨库原子证明或写入授权；任何写入仍须在权威事务中复核。
 */
function nativeEntryIds(entry: NativeProjectIdentities): string[] {
  return [entry.project.id, ...entry.episodeIds, ...entry.canvasIds];
}

async function readNativeCatalog(isolateInvalidProjects: boolean) {
  const repository = await import('./indexedDb/nativeProjectRepository');
  const catalog = isolateInvalidProjects ? await repository.readNativeProjectIdentityCatalog()
    : { entries: await repository.listNativeProjectIdentities(), unavailableIds: new Set<string>() };
  const identities = new Set<string>();
  for (const entry of catalog.entries) {
    for (const id of nativeEntryIds(entry)) {
      if (identities.has(id)) throw new Error('新项目或画布身份重复，无法安全判别');
      identities.add(id);
    }
  }
  return catalog;
}

/** 摘要可能缺行；单个只读事务只取旧项目键和删除墓碑，不加载旧画布正文。 */
async function occupiedLegacyIds(ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_PROJECTS, STORE_METADATA], 'readonly');
    const store = transaction.objectStore(STORE_PROJECTS), metadata = transaction.objectStore(STORE_METADATA), occupied = new Set<string>();
    for (const id of ids) {
      const request = store.getKey(id);
      request.onsuccess = () => { if (request.result !== undefined) occupied.add(id); };
      const tombstone = metadata.getKey(`project-deleted:${id}`);
      tombstone.onsuccess = () => { if (tombstone.result !== undefined) occupied.add(id); };
    }
    transaction.oncomplete = () => resolve(occupied);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('无法核对旧项目身份'));
  });
}

/** 批量核对待分配身份。保留损坏记录的占用，实际新库写入仍须在事务里再次验证。 */
export async function readOccupiedProjectIds(ids: readonly string[]): Promise<Set<string>> {
  const candidates = new Set(ids);
  if (!candidates.size) return new Set();
  const [occupied, catalog] = await Promise.all([occupiedLegacyIds([...candidates]), readNativeCatalog(true)]);
  for (const id of catalog.unavailableIds) if (candidates.has(id)) occupied.add(id);
  for (const entry of catalog.entries) {
    for (const id of nativeEntryIds(entry)) if (candidates.has(id)) occupied.add(id);
  }
  return occupied;
}

export async function listProjectCatalog(options: { isolateInvalidNativeProjects?: boolean } = {}): Promise<ProjectCatalogEntry[]> {
  const isolate = options.isolateInvalidNativeProjects === true;
  const [legacy, native] = await Promise.all([getAllProjects(), readNativeCatalog(isolate)]);
  // 旧摘要是可重建缓存，不能凭它的缺行断言新旧 ID 没有碰撞。
  const nativeIds = native.entries.flatMap(nativeEntryIds);
  const legacyIds = new Set(legacy.map((item) => item.id));
  const occupied = await occupiedLegacyIds(nativeIds);
  const unavailableIds = new Set(native.unavailableIds);
  const nativeEntries = native.entries.filter((entry) => {
    const ids = nativeEntryIds(entry);
    if (!ids.some((id) => legacyIds.has(id) || occupied.has(id))) return true;
    if (!isolate) throw new Error('新旧项目身份冲突，请先核对原始数据');
    ids.forEach((id) => unavailableIds.add(id));
    return false;
  });
  // 旧剧集的分集和项目根也需要保持同一套可用身份。
  for (const project of legacy) {
    if (unavailableIds.has(project.id) && project.parentId) unavailableIds.add(project.parentId);
  }
  return [
    ...legacy.filter((project) => !unavailableIds.has(project.id) && !(project.parentId && unavailableIds.has(project.parentId)))
      .map((project): ProjectCatalogEntry => ({ dataModel: 'legacy', project })),
    ...nativeEntries.map(({ project, episodes, episodeIds, canvasIds }): ProjectCatalogEntry => ({ dataModel: 'native', project, episodes, episodeIds, canvasIds })),
  ];
}

export async function resolveProjectModel(id: string): Promise<ResolvedProjectModel> {
  if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error('项目身份无效');
  const [legacy, native] = await Promise.all([getProjectById(id), readNativeCatalog(true)]);
  if (native.unavailableIds.has(id) || legacy?.parentId && native.unavailableIds.has(legacy.parentId)) {
    throw new Error('新项目身份不可用，请核对原始数据');
  }
  const matches = native.entries.filter((item) => nativeEntryIds(item).includes(id));
  if (matches.length > 1 || legacy && matches.length) throw new Error('新旧项目身份冲突，请先核对原始数据');
  if (legacy) return { dataModel: 'legacy', project: legacy };
  if (matches[0]) {
    const { readNativeProject } = await import('./indexedDb/nativeProjectRepository');
    const selected = matches[0], aggregate = await readNativeProject(selected.project.id);
    const sorted = (ids: string[]) => [...ids].sort();
    if (!aggregate || !configValuesEqual(selected.project, aggregate.project)
      || !configValuesEqual(selected.episodes, aggregate.episodes)
      || !configValuesEqual(sorted(selected.episodeIds), sorted(aggregate.episodes.map((item) => item.id)))
      || !configValuesEqual(sorted(selected.canvasIds), sorted(aggregate.canvases.map((item) => item.id)))) {
      throw new Error('新项目目录在读取期间变化，请重试');
    }
    const occupied = await occupiedLegacyIds(nativeEntryIds(selected));
    if (occupied.size) throw new Error('新旧项目身份冲突，请先核对原始数据');
    return { dataModel: 'native', target: selected.project.id === id ? 'project'
      : selected.episodeIds.includes(id) ? 'episode' : 'canvas', aggregate };
  }
  return { dataModel: 'missing' };
}
