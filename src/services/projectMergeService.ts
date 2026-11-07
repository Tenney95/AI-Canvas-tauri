/** 纯三方比较：领域原子组，显式冲突选择，最后重新校验整张依赖图。 */
import type { ProjectExchangeEntity, ProjectExchangeObject, ProjectExchangeSnapshot, ProjectExchangeValue } from '../types/projectExchange';
import { projectExchangeEntityKey } from './projectExchangeFormat';
import { exchangeEqual, validateExchangeDomain } from './projectExchangeDomain';

export type ProjectMergeSide = 'local' | 'incoming';
export interface ProjectMergeChange {
  id: string; entityKey: string; kind: ProjectExchangeEntity['kind']; scopeId: string; label: string; field: string;
  base?: ProjectExchangeValue; local?: ProjectExchangeValue; incoming?: ProjectExchangeValue;
  conflict: boolean; automatic?: ProjectMergeSide;
  merged?: ProjectExchangeValue;
}
export interface ProjectMergePlan {
  base: ProjectExchangeSnapshot | null; local: ProjectExchangeSnapshot; incoming: ProjectExchangeSnapshot;
  changes: ProjectMergeChange[]; alreadyApplied: boolean;
}
type Slots = Map<string, ProjectExchangeValue>;
const geometry = ['position', 'parentId', 'extent', 'expandParent'];
const dimensions = ['width', 'height', 'style'];
const output = ['relativePath', 'imageRelativePath', 'imageUrl', 'videoUrl', 'audioUrl', 'url', 'output', 'outputs',
  'directorScene', 'directorPrevisScene', 'directorResultManifest', 'directorCaptureUrls', 'storyboardOverrides', 'status'];
const episodeScriptFields = ['episodeScript', 'episodeScriptFile'];
function partition(entity: ProjectExchangeEntity): Slots {
  const data = entity.data, slots: Slots = new Map();
  if (entity.kind === 'file') { slots.set('文件内容', data); return slots; }
  if (entity.kind === 'edge') {
    const keys = ['source', 'target', 'sourceHandle', 'targetHandle', 'type'];
    slots.set('连接结构', Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])));
    Object.entries(data).filter(([key]) => !keys.includes(key)).forEach(([key, value]) => slots.set(key, value)); return slots;
  }
  if (entity.kind === 'node') {
    slots.set('位置与分组', Object.fromEntries(geometry.filter((key) => key in data).map((key) => [key, data[key]])));
    slots.set('尺寸', Object.fromEntries(dimensions.filter((key) => key in data).map((key) => [key, data[key]])));
    for (const [key, value] of Object.entries(data)) {
      if (geometry.includes(key) || dimensions.includes(key)) continue;
      if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
        slots.set('data.媒体产物', Object.fromEntries(Object.entries(value).filter(([field]) => output.includes(field))));
        Object.entries(value).filter(([field]) => !output.includes(field)).forEach(([field, item]) => slots.set(`data.${field}`, item));
      } else slots.set(key, value);
    }
    return slots;
  }
  if (entity.kind === 'project' && episodeScriptFields.some((field) => field in data)) {
    slots.set('本集剧本与文件', Object.fromEntries(episodeScriptFields.filter((field) => field in data).map((field) => [field, data[field]])));
  }
  for (const [key, value] of Object.entries(data)) {
    if (entity.kind === 'project' && episodeScriptFields.includes(key)) continue;
    if (entity.kind === 'project' && ['settings', 'series'].includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      // 故事图整体为一个原子槽，不能把不同版本的节点/边拆开拼接。
      Object.entries(value).forEach(([field, item]) => slots.set(`${key}.${field}`, item));
    } else slots.set(key, value);
  }
  return slots;
}
function assemble(entity: ProjectExchangeEntity, slots: Slots): ProjectExchangeEntity {
  if (entity.kind === 'file') return { ...entity, data: slots.get('文件内容') as ProjectExchangeObject };
  const data: ProjectExchangeObject = {};
  for (const [key, value] of slots) {
    if (['位置与分组', '尺寸', '连接结构', '本集剧本与文件'].includes(key)) Object.assign(data, value);
    else if (key === 'data.媒体产物') data.data = { ...(data.data as ProjectExchangeObject ?? {}), ...value as ProjectExchangeObject };
    else if (key.startsWith('data.') || key.startsWith('settings.') || key.startsWith('series.')) {
      const [section, field] = key.split('.');
      data[section] = { ...(data[section] as ProjectExchangeObject ?? {}), [field]: value };
    } else data[key] = value;
  }
  return { ...entity, data };
}
const entityValue = (value: ProjectExchangeEntity | undefined): ProjectExchangeValue | undefined => value?.data;
export function buildProjectMergePlan(base: ProjectExchangeSnapshot | null, local: ProjectExchangeSnapshot, incoming: ProjectExchangeSnapshot): ProjectMergePlan {
  if (local.lineageId !== incoming.lineageId || local.rootProjectId !== incoming.rootProjectId) throw new Error('项目协作来源不匹配');
  const index = (snapshot: ProjectExchangeSnapshot | null) => new Map(snapshot?.entities.map((item) => [projectExchangeEntityKey(item), item]) ?? []);
  const b = index(base), l = index(local), r = index(incoming), changes: ProjectMergeChange[] = [];
  const add = (entity: ProjectExchangeEntity, field: string, bv: ProjectExchangeValue | undefined, lv: ProjectExchangeValue | undefined, rv: ProjectExchangeValue | undefined) => {
    if (exchangeEqual(lv, rv)) return;
    const key = projectExchangeEntityKey(entity);
    const automatic = base ? exchangeEqual(lv, bv) ? 'incoming' : exchangeEqual(rv, bv) ? 'local' : undefined : undefined;
    let merged: ProjectExchangeValue | undefined;
    if (base && !automatic && field.endsWith('Ids') && Array.isArray(bv) && Array.isArray(lv) && Array.isArray(rv)
      && [...bv, ...lv, ...rv].every((value) => typeof value === 'string')) {
      const baseIds = new Set(bv), surviving = bv.filter((id) => lv.includes(id) && rv.includes(id));
      if (exchangeEqual(lv.filter((id) => surviving.includes(id)), surviving) && exchangeEqual(rv.filter((id) => surviving.includes(id)), surviving)) {
        merged = [...surviving, ...new Set([...lv, ...rv].filter((id) => !baseIds.has(id)))];
      }
    }
    const title = typeof entity.data.name === 'string' ? entity.data.name : typeof (entity.data.data as ProjectExchangeObject | undefined)?.label === 'string'
      ? String((entity.data.data as ProjectExchangeObject).label) : entity.id;
    changes.push({ id: JSON.stringify([key, field]), entityKey: key, scopeId: entity.scopeId, kind: entity.kind,
      label: title, field, base: bv, local: lv, incoming: rv, conflict: !automatic && merged === undefined, automatic: merged === undefined ? automatic : 'local', merged });
  };
  for (const key of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    const bv = b.get(key), lv = l.get(key), rv = r.get(key), entity = lv ?? rv ?? bv!;
    // 新增/删除/节点类型变化以完整实体处理，不能把不存在的一侧拆成字段。
    if (!lv || !rv || entity.kind === 'node' && (lv.data.type !== rv.data.type)) {
      add(entity, '实体', entityValue(bv), entityValue(lv), entityValue(rv)); continue;
    }
    const bs = bv ? partition(bv) : new Map(), ls = partition(lv), rs = partition(rv);
    for (const field of new Set([...bs.keys(), ...ls.keys(), ...rs.keys()])) add(entity, field, bs.get(field), ls.get(field), rs.get(field));
  }
  return { base, local, incoming, changes, alreadyApplied: false };
}
export function resolveProjectMerge(plan: ProjectMergePlan, choices: Readonly<Record<string, ProjectMergeSide>>): ProjectExchangeSnapshot {
  const byKey = new Map(plan.local.entities.map((item) => [projectExchangeEntityKey(item), item]));
  const incoming = new Map(plan.incoming.entities.map((item) => [projectExchangeEntityKey(item), item]));
  const slots = new Map<string, Slots>();
  for (const change of plan.changes) {
    const side = choices[change.id] ?? change.automatic; if (!side) throw new Error('还有冲突未选择');
    const source = side === 'local' ? byKey.get(change.entityKey) : incoming.get(change.entityKey);
    if (change.field === '实体') {
      if (source) byKey.set(change.entityKey, source); else byKey.delete(change.entityKey); continue;
    }
    const original = byKey.get(change.entityKey) ?? incoming.get(change.entityKey); if (!original) throw new Error('合并实体缺失');
    const values = slots.get(change.entityKey) ?? partition(original);
    const value = !choices[change.id] && change.merged !== undefined ? change.merged : side === 'local' ? change.local : change.incoming;
    if (value === undefined) values.delete(change.field); else values.set(change.field, value);
    slots.set(change.entityKey, values);
  }
  for (const [key, values] of slots) byKey.set(key, assemble(byKey.get(key)!, values));
  const media = new Map([...plan.local.media, ...plan.incoming.media].map((item) => [item.id, item]));
  const used = new Set([...byKey.values()].filter((item) => item.kind === 'file').map((item) => item.data.mediaId));
  return validateExchangeDomain({ ...plan.local, entities: [...byKey.values()], media: [...media.values()].filter((item) => used.has(item.id)) });
}
