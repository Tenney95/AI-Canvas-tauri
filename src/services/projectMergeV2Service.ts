/** 新规范三方比较：只比较确定性领域视图，不改旧 revision 正文或假造共同祖先。 */
import type { ProjectExchangeObject, ProjectExchangeValue } from '../types/projectExchange';
import type { ProjectExchangeEntityV2, ProjectExchangeSnapshotV2 } from '../types/projectArchiveV4';
import type { AnyProjectExchangeSnapshot } from '../types/projectExchangeV2';
import { serializeProjectExchangeValue } from './projectExchangeFormat';
import { exchangeReferencesV2, parseProjectExchangeSnapshotV2, projectExchangeEntityKeyV2 } from './projectExchangeV2Format';
import { adaptSnapshotV1ToV2, assertCompleteLegacyProjection, type LegacyExchangeProjectionProof } from './projectExchangeV2Domain';

export type ProjectMergeSideV2 = 'local' | 'incoming';
export interface ProjectMergeChangeV2 {
  id: string; entityKey: string; kind: ProjectExchangeEntityV2['kind']; scopeId: string; field: string; slot: string;
  base?: ProjectExchangeValue; local?: ProjectExchangeValue; incoming?: ProjectExchangeValue;
  conflict: boolean; automatic?: ProjectMergeSideV2;
}
export interface ProjectMergePlanV2 {
  base: ProjectExchangeSnapshotV2 | null;
  local: ProjectExchangeSnapshotV2;
  incoming: ProjectExchangeSnapshotV2;
  changes: ProjectMergeChangeV2[];
}
const key = projectExchangeEntityKeyV2;
const equal = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : serializeProjectExchangeValue(a) === serializeProjectExchangeValue(b);
type Slots = Map<string, ProjectExchangeValue>;
const slot = (...path: string[]) => JSON.stringify(path);
const group = { geometry: slot('group', 'geometry'), dimensions: slot('group', 'dimensions'),
  media: slot('group', 'media'), manuscript: slot('group', 'manuscript'), whole: slot('whole'), entity: slot('entity') };
function label(encoded: string): string {
  if (encoded === group.geometry) return '位置与分组';
  if (encoded === group.dimensions) return '尺寸';
  if (encoded === group.media) return 'data.媒体产物';
  if (encoded === group.manuscript) return 'content.正文与文件';
  if (encoded === group.whole) return '实体内容';
  if (encoded === group.entity) return '实体';
  const [section, name] = JSON.parse(encoded) as string[];
  return section === 'field' ? name : `${section}.${name}`;
}
const geometry = ['position', 'parentId', 'extent', 'expandParent'];
const dimensions = ['width', 'height', 'style'];
const output = ['relativePath', 'imageRelativePath', 'imageUrl', 'videoUrl', 'audioUrl', 'url', 'output', 'outputs',
  'directorScene', 'directorPrevisScene', 'directorResultManifest', 'directorCaptureUrls', 'storyboardOverrides', 'status'];
function slots(entity: ProjectExchangeEntityV2): Slots {
  if (entity.kind === 'file' || entity.kind === 'edge') return new Map([[group.whole, entity.data]]);
  const result: Slots = new Map();
  if (entity.kind === 'node') {
    result.set(group.geometry, Object.fromEntries(geometry.filter((field) => field in entity.data).map((field) => [field, entity.data[field]])));
    result.set(group.dimensions, Object.fromEntries(dimensions.filter((field) => field in entity.data).map((field) => [field, entity.data[field]])));
  }
  for (const [field, value] of Object.entries(entity.data)) {
    if (entity.kind === 'node' && [...geometry, ...dimensions].includes(field)) continue;
    if (entity.kind === 'node' && field === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
      result.set(group.media, Object.fromEntries(Object.entries(value).filter(([name]) => output.includes(name))));
      for (const [name, item] of Object.entries(value)) if (!output.includes(name)) result.set(slot('data', name), item);
    } else if (field === 'content' && value && typeof value === 'object' && !Array.isArray(value)) {
      const text = Object.fromEntries(['script', 'scriptFile'].filter((name) => name in value).map((name) => [name, value[name]]));
      if (Object.keys(text).length) result.set(group.manuscript, text);
      for (const [name, item] of Object.entries(value)) if (!['script', 'scriptFile'].includes(name)) result.set(slot('content', name), item);
    } else result.set(slot('field', field), value);
  }
  return result;
}
function assemble(entity: ProjectExchangeEntityV2, values: Slots): ProjectExchangeEntityV2 {
  if (entity.kind === 'file' || entity.kind === 'edge') return { ...entity, data: values.get(group.whole) as ProjectExchangeObject };
  // content 是 project/episode 的必需容器；空稿也要在字段重组后保留。
  const data: ProjectExchangeObject = entity.kind === 'project' || entity.kind === 'episode' ? { content: {} } : {};
  for (const [field, value] of values) {
    if (field === group.geometry || field === group.dimensions) Object.assign(data, value);
    else if (field === group.media) data.data = { ...(data.data as ProjectExchangeObject ?? {}), ...(value as ProjectExchangeObject) };
    else if (field === group.manuscript) data.content = { ...(data.content as ProjectExchangeObject ?? {}), ...(value as ProjectExchangeObject) };
    else {
      const [section, name] = JSON.parse(field) as string[];
      if (section === 'field') { data[name] = value; continue; }
      data[section] = { ...(data[section] as ProjectExchangeObject ?? {}), [name]: value };
    }
  }
  return { ...entity, data };
}
function assertMediaIdentity(snapshots: Array<ProjectExchangeSnapshotV2 | null>): void {
  const media = new Map<string, ProjectExchangeSnapshotV2['media'][number]>();
  for (const snapshot of snapshots) for (const item of snapshot?.media ?? []) {
    const previous = media.get(item.id);
    if (previous && !equal(previous, item)) throw new Error('相同素材身份对应不同内容或类型，请核对来源（MEDIA_IDENTITY_CONFLICT）');
    media.set(item.id, item);
  }
}

export async function buildProjectMergePlanV2(base: AnyProjectExchangeSnapshot | null, local: AnyProjectExchangeSnapshot,
  incoming: AnyProjectExchangeSnapshot, proofs: { base?: LegacyExchangeProjectionProof; local?: LegacyExchangeProjectionProof; incoming?: LegacyExchangeProjectionProof } = {}): Promise<ProjectMergePlanV2> {
  const project = async (snapshot: AnyProjectExchangeSnapshot, proof?: LegacyExchangeProjectionProof) => snapshot.canonicalVersion === 1
    ? adaptSnapshotV1ToV2(snapshot, proof) : parseProjectExchangeSnapshotV2(snapshot);
  const [b, l, r] = await Promise.all([base ? project(base, proofs.base) : null, project(local, proofs.local), project(incoming, proofs.incoming)]);
  if (l.lineageId !== r.lineageId || l.rootProjectId !== r.rootProjectId || b && (b.lineageId !== l.lineageId || b.rootProjectId !== l.rootProjectId)) throw new Error('项目协作来源不匹配');
  assertMediaIdentity([b, l, r]);
  for (const snapshot of [b, l, r]) if (snapshot) assertCompleteLegacyProjection(snapshot);
  const index = (snapshot: ProjectExchangeSnapshotV2 | null) => new Map(snapshot?.entities.map((entity) => [key(entity), entity]) ?? []);
  const bi = index(b), li = index(l), ri = index(r), changes: ProjectMergeChangeV2[] = [];
  const add = (entity: ProjectExchangeEntityV2, encoded: string, bv: ProjectExchangeValue | undefined, lv: ProjectExchangeValue | undefined, rv: ProjectExchangeValue | undefined) => {
    if (equal(lv, rv)) return;
    const automatic = b ? equal(lv, bv) ? 'incoming' : equal(rv, bv) ? 'local' : undefined : undefined;
    const entityKey = key(entity);
    changes.push({ id: JSON.stringify([entityKey, encoded]), entityKey, kind: entity.kind, scopeId: entity.scopeId,
      field: label(encoded), slot: encoded, base: bv, local: lv, incoming: rv, conflict: !automatic, ...(automatic ? { automatic } : {}) });
  };
  for (const id of new Set([...bi.keys(), ...li.keys(), ...ri.keys()])) {
    const bv = bi.get(id), lv = li.get(id), rv = ri.get(id), entity = lv ?? rv ?? bv!;
    if (!lv || !rv || entity.kind === 'node' && lv.data.type !== rv.data.type) {
      add(entity, group.entity, bv?.data, lv?.data, rv?.data); continue;
    }
    const bs = bv ? slots(bv) : new Map(), ls = slots(lv), rs = slots(rv);
    for (const field of new Set([...bs.keys(), ...ls.keys(), ...rs.keys()])) add(entity, field, bs.get(field), ls.get(field), rs.get(field));
  }
  // retired 出处不能按“缺失”推断为删除证明；两侧描述必须按自身身份并集保留。
  return { base: b, local: l, incoming: r, changes };
}

export function resolveProjectMergeV2(plan: ProjectMergePlanV2, choices: Readonly<Record<string, ProjectMergeSideV2>>): ProjectExchangeSnapshotV2 {
  assertMediaIdentity([plan.base, plan.local, plan.incoming]);
  const local = new Map(plan.local.entities.map((entity) => [key(entity), entity])), incoming = new Map(plan.incoming.entities.map((entity) => [key(entity), entity]));
  const byKey = new Map(local), pending = new Map<string, Slots>();
  for (const change of plan.changes) {
    const side = choices[change.id] ?? change.automatic;
    if (side !== 'local' && side !== 'incoming') throw new Error('还有冲突未选择');
    const source = side === 'local' ? local.get(change.entityKey) : incoming.get(change.entityKey);
    if (change.slot === group.entity) {
      if (source) byKey.set(change.entityKey, source); else byKey.delete(change.entityKey);
      continue;
    }
    const original = local.get(change.entityKey) ?? incoming.get(change.entityKey);
    if (!original) throw new Error('合并实体缺失');
    const values = pending.get(change.entityKey) ?? slots(original), value = side === 'local' ? change.local : change.incoming;
    if (value === undefined) values.delete(change.slot); else values.set(change.slot, value);
    pending.set(change.entityKey, values);
  }
  for (const [id, values] of pending) { const entity = byKey.get(id); if (!entity) throw new Error('合并结构不完整'); byKey.set(id, assemble(entity, values)); }
  const entities = [...byKey.values()], media = new Map([...plan.local.media, ...plan.incoming.media].map((item) => [item.id, item]));
  const used = new Set(entities.filter((item) => item.kind === 'file').map((item) => item.data.mediaId));
  const historicalTargets = [...new Map([...plan.local.historicalTargets, ...plan.incoming.historicalTargets]
    .map((item) => [JSON.stringify([item.kind, item.projectId, item.id]), item])).values()];
  return parseProjectExchangeSnapshotV2({ ...plan.local, entities: entities.map((entity) => ({ ...entity,
    references: exchangeReferencesV2(entity, entities, plan.local.rootProjectId) })), media: [...media.values()].filter((item) => used.has(item.id)), historicalTargets });
}
