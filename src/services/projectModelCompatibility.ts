/** 旧完整项目记录到新领域的纯只读投影：不读文件、不落库、不补发身份。 */
import type {
  CanvasDocument, CanvasPreview, EpisodeContent, LegacyProjectBinding, ProjectAggregate,
  ProjectContent, ProjectCreativeContent, ProjectStorageBinding,
} from '../types/project';
import type {
  LegacyProjectProjection, LegacyProjectRecord, ProjectMigrationDiagnostic,
  ProjectMigrationDiagnosticCode,
} from '../types/projectMigration';
import { normalizeProjectTextFileReference } from '../utils/manuscriptFileReference';
import { normalizeStoryGraph } from './storyGraphService';

const knownFields = new Set(['id', 'name', 'createdAt', 'updatedAt', 'exchangeEpoch', 'snapshot', 'dataFolder',
  'revisionScope', 'settings', 'parentId', 'episodeNo', 'episodeOutline', 'episodeScript', 'episodeScriptFile',
  'episodeCreative', 'episodeAssetRoster', 'creationProfile', 'teamProfileOverride', 'series',
  'nodes', 'edges', 'groups', 'dramaAssets']);
const creativeFields = ['episodeOutline', 'episodeScript', 'episodeScriptFile', 'episodeCreative',
  'episodeAssetRoster', 'creationProfile', 'teamProfileOverride'] as const;
const objectFields = ['settings', 'series', 'episodeCreative', 'episodeAssetRoster',
  'creationProfile', 'teamProfileOverride', 'dramaAssets'] as const;
const stringFields = ['name', 'snapshot', 'episodeOutline', 'episodeScript', 'dataFolder', 'parentId'] as const;

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\s/\\:]/u.test(value) && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    && value !== '.' && value !== '..';
}
function safeFolder(value: string): boolean {
  return !!value.trim() && !/^(?:[a-z]:|[/\\])/i.test(value)
    && ![...value].some((char) => char.charCodeAt(0) < 32)
    && value.split(/[/\\]/).every((part) => part !== '' && part !== '.' && part !== '..'
      && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part));
}
function validCollection(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}
function hasSeriesInfo(source: LegacyProjectRecord): boolean {
  return !!source.series && Object.values(source.series).some((value) => value !== undefined && value !== null);
}
function epoch(source: LegacyProjectRecord): number { return source.exchangeEpoch ?? 0; }
function creative(source: LegacyProjectRecord, storageRootRef: string): ProjectCreativeContent {
  return {
    ...(source.episodeOutline !== undefined ? { outline: source.episodeOutline } : {}),
    ...(source.episodeScript !== undefined ? { script: source.episodeScript } : {}),
    ...(source.episodeScriptFile !== undefined ? { scriptFile: normalizeProjectTextFileReference(source.episodeScriptFile) } : {}),
    ...(source.episodeCreative !== undefined ? { creative: source.episodeCreative } : {}),
    ...(source.episodeAssetRoster !== undefined ? { assetRoster: source.episodeAssetRoster } : {}),
    revision: 0, storageRootRef,
  };
}
function canvas(source: LegacyProjectRecord, ownerId: string, storageRootRef: string): CanvasDocument {
  return { id: source.id, projectId: ownerId, episodeId: source.parentId ? source.id : null,
    storageRootRef, nodes: source.nodes as unknown[], edges: source.edges as unknown[],
    groups: source.groups === undefined ? [] : source.groups as unknown[],
    epoch: epoch(source), revision: 0, revisionScope: source.revisionScope ?? 'project' };
}
function preview(source: LegacyProjectRecord): CanvasPreview | undefined {
  return source.snapshot === undefined ? undefined
    : { canvasId: source.id, snapshot: source.snapshot, updatedAt: source.updatedAt };
}

/** 沿用启动注册规则：父 dataFolder 有值才继承，否则仍按子集自身字段/ID 定位。 */
export function resolveLegacyProjectFolder(source: LegacyProjectRecord, owner?: LegacyProjectRecord): string {
  const selected = source.parentId && owner?.dataFolder ? owner.dataFolder : source.dataFolder;
  // registerProjectFolder 只登记 trim 后的非空值；冷启动时空值继续按原记录 ID 回退。
  return typeof selected === 'string' && selected.trim() ? selected.trim() : source.id;
}

export function projectLegacyRecords(records: readonly LegacyProjectRecord[]): LegacyProjectProjection {
  const diagnostics: ProjectMigrationDiagnostic[] = [];
  const quarantined = new Set<string>();
  const sourceRecords: LegacyProjectRecord[] = [];
  const byId = new Map<string, LegacyProjectRecord>();
  const note = (code: ProjectMigrationDiagnosticCode, severity: 'blocking' | 'warning',
    recordIds: string[], message: string, field?: string) => {
    diagnostics.push({ code, severity, recordIds, message, ...(field ? { field } : {}) });
    if (severity === 'blocking') recordIds.forEach((id) => quarantined.add(id));
  };
  for (const input of records) {
    const ids = record(input) && identifier(input.id) ? [input.id] : [];
    if (!record(input) || !ids.length) {
      note('invalid_record', 'blocking', ids, '旧项目记录身份或对象类型无效');
      continue;
    }
    let source: LegacyProjectRecord;
    try { source = structuredClone(input); }
    catch { note('invalid_record', 'blocking', ids, '旧项目包含不可持久化的值'); continue; }
    sourceRecords.push(source);
    if (byId.has(source.id)) note('duplicate_record_id', 'blocking', ids, '旧项目身份重复');
    else byId.set(source.id, source);
    const bad = (field: string) => note('invalid_field', 'blocking', ids, '旧项目已知字段格式无效', field);
    for (const field of stringFields) if (source[field] !== undefined && typeof source[field] !== 'string') bad(field);
    if (typeof source.name !== 'string') bad('name');
    for (const field of ['createdAt', 'updatedAt'] as const) {
      if (typeof source[field] !== 'number' || !Number.isFinite(source[field])) bad(field);
    }
    if (source.exchangeEpoch !== undefined && (!Number.isSafeInteger(source.exchangeEpoch) || source.exchangeEpoch < 0)) bad('exchangeEpoch');
    if (source.episodeNo !== undefined && (typeof source.episodeNo !== 'number' || !Number.isFinite(source.episodeNo))) bad('episodeNo');
    if (source.revisionScope !== undefined && !['project', 'global'].includes(source.revisionScope)) bad('revisionScope');
    for (const field of objectFields) if (source[field] !== undefined && !record(source[field])) bad(field);
    if (source.parentId !== undefined && !identifier(source.parentId)) bad('parentId');
    if (source.episodeScriptFile !== undefined && !normalizeProjectTextFileReference(source.episodeScriptFile)) bad('episodeScriptFile');
    if (record(source.episodeScriptFile) && Object.keys(source.episodeScriptFile)
      .some((field) => !['fileName', 'relativePath', 'digest', 'sourceName'].includes(field))) {
      note('unknown_legacy_fields', 'warning', ids, '稿件引用额外字段只保留在源材料', 'episodeScriptFile');
    }
    if (source.series?.script !== undefined && typeof source.series.script !== 'string') bad('series.script');
    if (source.series?.storyGraph !== undefined) {
      try { normalizeStoryGraph(source.series.storyGraph); } catch { bad('series.storyGraph'); }
    }
    if (source.series?.originalWork !== undefined && (!record(source.series.originalWork)
      || typeof source.series.originalWork.fileName !== 'string' || typeof source.series.originalWork.relativePath !== 'string'
      || !safeFolder(source.series.originalWork.relativePath))) bad('series.originalWork');
    if (!validCollection(source.nodes) || !validCollection(source.edges)
      || source.groups !== undefined && !validCollection(source.groups)) {
      note('invalid_canvas', 'blocking', ids, '旧画布不是完整数组或元素身份重复/缺失');
    }
    if (Object.keys(source).some((field) => !knownFields.has(field))) {
      note('unknown_legacy_fields', 'warning', ids, '未映射的旧字段只保留在源材料，不作为执行能力');
    }
  }
  const childrenByOwner = new Map<string, LegacyProjectRecord[]>();
  for (const source of sourceRecords) {
    if (source.parentId) {
      const children = childrenByOwner.get(source.parentId) ?? [];
      children.push(source); childrenByOwner.set(source.parentId, children);
    }
  }
  for (const source of sourceRecords) {
    if (!source.parentId) continue;
    const owner = byId.get(source.parentId);
    if (!owner) note('missing_owner', 'blocking', [source.id], '分集所属项目不存在', 'parentId');
    else if (owner.parentId || owner.id === source.id) {
      note('nested_parent', 'blocking', [source.id, owner.id], '旧父链有多层、环或自引用', 'parentId');
    }
    if (hasSeriesInfo(source)) note('child_has_series', 'blocking', [source.id], '分集同时持有共享剧集资料，需显式恢复', 'series');
  }
  for (const source of byId.values()) {
    const children = childrenByOwner.get(source.id) ?? [];
    const hasCanvasContent = Array.isArray(source.nodes) && source.nodes.length > 0
      || Array.isArray(source.edges) && source.edges.length > 0
      || Array.isArray(source.groups) && source.groups.length > 0;
    const hasEpisodeContent = creativeFields.some((field) => source[field] !== undefined);
    // 旧转换先写空 owner、后写子集 parentId；中断残留与空普通画布无法可靠区分。
    if (!source.parentId && children.length === 0 && hasSeriesInfo(source) && !hasCanvasContent && !hasEpisodeContent) {
      note('ambiguous_childless_series', 'blocking', [source.id], '无分集且无画布或集级内容，不能区分普通项目与转换中断的剧集');
    }
    // 旧模型允许普通画布先保存全剧稿/原文；仅有 series 字段并不证明它已转为容器。
    if (!source.parentId && children.length > 0 && hasCanvasContent) {
      note('owner_has_canvas', 'blocking', [source.id], '剧集容器仍有真实画布内容，不能静默丢弃');
    }
    if (!source.parentId && children.length > 0 && hasEpisodeContent) {
      note('owner_has_episode_fields', 'blocking', [source.id], '剧集容器同时持有集级资料，需明确其目标后恢复');
    }
    const owner = source.parentId ? byId.get(source.parentId) : undefined;
    const folder = resolveLegacyProjectFolder(source, owner);
    if (typeof folder !== 'string' || !safeFolder(folder)) {
      note('unsafe_folder', 'blocking', [source.id], '旧目录定位不符合安全相对目录规则', 'dataFolder');
    }
  }
  // 一个 owner 是一个迁移单元；坏子项不能导致剩余子项被当成完整整剧激活。
  const affected = [...quarantined];
  for (let index = 0; index < affected.length; index++) {
    const id = affected[index], parentId = byId.get(id)?.parentId;
    const related = [...(parentId && byId.has(parentId) ? [parentId] : []),
      ...(childrenByOwner.get(id) ?? []).map((child) => child.id)];
    for (const relatedId of related) if (!quarantined.has(relatedId)) {
      quarantined.add(relatedId); affected.push(relatedId);
    }
  }
  const projects: ProjectAggregate[] = [];
  for (const owner of byId.values()) {
    if (owner.parentId || quarantined.has(owner.id)) continue;
    const children = [...(childrenByOwner.get(owner.id) ?? [])];
    // 旧版本以父子记录区分画布与剧集，不能仅凭共享资料丢掉普通画布。
    const isSeries = children.length > 0;
    const storageBindings: ProjectStorageBinding[] = [];
    const roots = new Map<string, ProjectStorageBinding>();
    const storage = (source: LegacyProjectRecord) => {
      const folderName = resolveLegacyProjectFolder(source, owner);
      let binding = roots.get(folderName);
      if (!binding) {
        binding = { rootRef: `legacy-root:${source.id}`, folderName, sourceRecordIds: [], source: 'legacy-folder-rule' };
        roots.set(folderName, binding); storageBindings.push(binding);
      }
      if (!binding.sourceRecordIds.includes(source.id)) binding.sourceRecordIds.push(source.id);
      return binding.rootRef;
    };
    const ownerRoot = storage(owner);
    const bindings: LegacyProjectBinding[] = [{ namespace: 'legacy-root', legacyId: owner.id, projectId: owner.id,
      storageRootRef: ownerRoot, sourceEpoch: epoch(owner) }];
    const content: ProjectContent = { projectId: owner.id,
      ...(owner.series?.originalWork !== undefined ? { originalWork: owner.series.originalWork } : {}),
      ...(owner.series?.script !== undefined ? { script: owner.series.script } : {}),
      ...(owner.series?.storyGraph !== undefined ? { storyGraph: owner.series.storyGraph } : {}),
      ...(owner.dramaAssets !== undefined ? { dramaAssets: owner.dramaAssets } : {}),
      ...(!isSeries && creativeFields.some((field) => owner[field] !== undefined)
        ? { standaloneCreative: { ...creative(owner, ownerRoot),
          ...(owner.creationProfile !== undefined ? { creationProfile: owner.creationProfile } : {}),
          ...(owner.teamProfileOverride !== undefined ? { teamProfileOverride: owner.teamProfileOverride } : {}) } } : {}),
      revisions: { source: 0, script: 0, storyGraph: owner.series?.storyGraph?.revision ?? 0, assets: 0 } };
    const aggregate: ProjectAggregate = { access: 'legacy-readonly', project: { id: owner.id, name: owner.name,
      kind: isSeries ? 'series' : 'standalone', createdAt: owner.createdAt, updatedAt: owner.updatedAt,
      epoch: epoch(owner), dataFolder: resolveLegacyProjectFolder(owner), storageRootRef: ownerRoot,
      storageBindings, ...(owner.settings !== undefined ? { defaultSettings: owner.settings } : {}) },
      content, episodes: [], bindings };
    if (!isSeries) {
      aggregate.standaloneCanvas = canvas(owner, owner.id, ownerRoot);
      aggregate.standalonePreview = preview(owner);
      bindings.push({ namespace: 'legacy-canvas', legacyId: owner.id, projectId: owner.id, canvasId: owner.id,
        storageRootRef: ownerRoot, sourceEpoch: epoch(owner) });
    }
    // 稳定 sort 保留输入次序中的同集号次序，不以名称/本机重新发号猜测顺序。
    children.sort((a, b) => (a.episodeNo ?? 0) - (b.episodeNo ?? 0));
    const seenNos = new Set<number>();
    for (const [index, child] of children.entries()) {
      const canvasRoot = storage(child);
      const episodeContent: EpisodeContent = { episodeId: child.id, ...creative(child, ownerRoot) };
      aggregate.episodes.push({ episode: { id: child.id, projectId: owner.id, canvasId: child.id, name: child.name,
        orderRank: index, ...(child.episodeNo !== undefined ? { displayNo: child.episodeNo } : {}),
        createdAt: child.createdAt, updatedAt: child.updatedAt, epoch: epoch(child), revision: 0,
        settingsPolicy: { mode: 'legacy-pinned', snapshot: child.settings ?? {} },
        ...(child.creationProfile !== undefined ? { creationProfile: child.creationProfile } : {}),
        ...(child.teamProfileOverride !== undefined ? { teamProfileOverride: child.teamProfileOverride } : {}) },
      content: episodeContent, canvas: canvas(child, owner.id, canvasRoot), preview: preview(child) });
      for (const namespace of ['legacy-episode', 'legacy-canvas'] as const) bindings.push({ namespace,
        legacyId: child.id, projectId: owner.id, episodeId: child.id, canvasId: child.id,
        storageRootRef: namespace === 'legacy-episode' ? ownerRoot : canvasRoot, sourceEpoch: epoch(child) });
      if (!Number.isSafeInteger(child.episodeNo) || (child.episodeNo ?? 0) < 1) {
        note('non_standard_episode_no', 'warning', [child.id], '旧集号缺失或不规范，保留原值与实际顺序', 'episodeNo');
      } else if (typeof child.episodeNo === 'number' && seenNos.has(child.episodeNo)) {
        note('duplicate_episode_no', 'warning', [child.id], '旧集号重复，未合并分集或重写显示集号', 'episodeNo');
      }
      if (typeof child.episodeNo === 'number') seenNos.add(child.episodeNo);
      if (child.dramaAssets !== undefined) note('child_asset_copy', 'warning', [child.id], '分集资产副本保留在源材料，共享权威仍属于项目', 'dramaAssets');
    }
    projects.push(aggregate);
  }
  return { projects, diagnostics, quarantinedRecordIds: [...quarantined].sort(), sourceRecords };
}

/** 不在无匹配/已隔离时制造空项目；调用者可通过完整投影读取诊断。 */
export function readLegacyProjectAggregate(records: readonly LegacyProjectRecord[], legacyOrOwnerId: string): ProjectAggregate | null {
  return projectLegacyRecords(records).projects.find((aggregate) => aggregate.project.id === legacyOrOwnerId
    || aggregate.bindings.some((binding) => binding.legacyId === legacyOrOwnerId)) ?? null;
}
