/** 本机字段不属于协作快照；更新前检查物化结果，不能静默丢弃。 */
import type { ProjectModelTransferAggregate, ProjectModelTransferCapture, ProjectModelTransferExchange } from '../types/projectModelTransfer';
import type { ProjectExchangeEntityV2, ProjectExchangeKindV2, ProjectExchangeSnapshotV2 } from '../types/projectArchiveV4';
import { configValuesEqual } from './configPatch';

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
const localOnlyFields = new Set(['filepath', 'imagefilepath', 'directorcapturefilepaths', 'assetid', 'imageassetid',
  'taskid', 'agenttaskid', 'polltaskid', 'requestid', 'volcenginebinding', 'videotaskstate', 'mediataskstate',
  'mediataskstage', 'runninghubstage', 'workflowapistage', 'generationstartedat', 'apikey', 'apikeyref', 'token',
  'accesstoken', 'refreshtoken', 'password', 'authorization', 'abortcontroller']);
const mediaFields = new Set(['url', 'imageUrl', 'videoUrl', 'audioUrl', 'sourceUrl', 'output', 'directorCaptureUrls']);

/** 只比较仍然存在的对象；显式删除整个节点/分集由合并选择决定。 */
function assertNoDroppedFields(before: unknown, after: unknown, field = ''): void {
  const normalized = field.replace(/[_-]/g, '').toLowerCase();
  if (localOnlyFields.has(normalized) && !configValuesEqual(before, after)) {
    throw new Error('更新会改变本机任务或素材身份，未修改项目');
  }
  if (field === 'status' && typeof before === 'string' && ['loading', 'generating', 'running', 'pending', 'polling'].includes(before)
    && before !== after) throw new Error('更新会改变本机运行状态，未修改项目');
  if (mediaFields.has(field) && typeof before === 'string'
    && /^(?:file:|asset:|blob:|https?:\/\/(?:asset\.localhost|tauri\.localhost)|[a-z]:[\\/]|\\\\)/i.test(before)
    && before !== after) throw new Error('更新会改变本机媒体引用，未修改项目');
  if (Array.isArray(before) && !Array.isArray(after)) throw new Error('更新可能丢失本机列表数据，未修改项目');
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < before.length; index++) {
      const item = before[index];
      const id = object(item) && typeof item.id === 'string' ? item.id : undefined;
      const candidate = id ? after.find((value) => object(value) && value.id === id) : after[index];
      if (candidate === undefined && item !== undefined) throw new Error('更新可能丢失本机列表数据，未修改项目');
      if (candidate !== undefined) assertNoDroppedFields(item, candidate, field);
    }
    return;
  }
  if (object(before) && !object(after)) throw new Error('更新可能丢失本机对象数据，未修改项目');
  if (!object(before) || !object(after)) return;
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(after, key)) throw new Error('更新会丢失本机专用字段，请先导出副本并人工处理；原项目未改变');
    assertNoDroppedFields(value, after[key], key);
  }
}

/** 当前节点所引用的每个素材须保留相同字节；其他新增素材不影响原节点。 */
function sameReferencedMedia(value: unknown, local: ProjectExchangeSnapshotV2, selected: ProjectExchangeSnapshotV2): boolean {
  const pending = [value], ids = new Set<string>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && item.startsWith('exchange-file:')) ids.add(item.slice('exchange-file:'.length));
    else if (Array.isArray(item)) pending.push(...item);
    else if (object(item)) pending.push(...Object.values(item));
  }
  return [...ids].every((id) => {
    const before = local.entities.find((item) => item.kind === 'file' && item.id === id);
    const after = selected.entities.find((item) => item.kind === 'file' && item.id === id);
    if (!before || !after || !configValuesEqual(before, after)) return false;
    const left = local.media.find((item) => item.id === before.data.mediaId);
    const right = selected.media.find((item) => item.id === after.data.mediaId);
    return !!left && !!right && configValuesEqual(left, right);
  });
}

/** 内容字段可更新；同一已验证素材字节的本机索引/云端绑定继续保留。 */
function preserveAssetIdentityFields(before: unknown, after: unknown, local: ProjectExchangeSnapshotV2, selected: ProjectExchangeSnapshotV2): void {
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < before.length; index++) {
      const source = before[index], id = object(source) && typeof source.id === 'string' ? source.id : undefined;
      const target = id ? after.find((item) => object(item) && item.id === id) : after[index];
      if (target !== undefined) preserveAssetIdentityFields(source, target, local, selected);
    }
    return;
  }
  if (!object(before) || !object(after)) return;
  if (typeof before.id === 'string' && before.id === after.id) {
    const matches = local.entities.filter((entity) => entity.id === before.id);
    const previous = matches.length === 1 ? matches[0] : undefined;
    const result = previous ? selected.entities.find((entity) => entity.id === previous.id && entity.kind === previous.kind && entity.scopeId === previous.scopeId) : undefined;
    if (previous && result && sameReferencedMedia(previous.data, local, selected)
      && sameReferencedMedia(result.data, selected, local)) {
      for (const key of ['assetId', 'imageAssetId', 'assetSource', 'relativePath', 'imageRelativePath', 'filePath', 'imageFilePath', 'imageUrl', 'audioUrl', 'volcengineBinding']) {
        if (Object.hasOwn(before, key)) after[key] = structuredClone(before[key]);
      }
    }
  }
  for (const [key, value] of Object.entries(before)) if (Object.hasOwn(after, key)) preserveAssetIdentityFields(value, after[key], local, selected);
}

/** 归档将这些列表拆为独立实体；比较父对象时必须连同完整子树核对。 */
const ownedCollections: ReadonlyArray<readonly [string, ProjectExchangeKindV2]> = [
  ['charactersIds', 'character'], ['scenesIds', 'scene'], ['propsIds', 'prop'],
  ['referenceImagesIds', 'referenceImage'], ['voiceClipsIds', 'voiceClip'],
  ['actionsIds', 'action'], ['mediaIds', 'actionMedia'], ['shotlistRowsIds', 'shot'],
];
function sameOwnedClosure(before: ProjectExchangeEntityV2, after: ProjectExchangeEntityV2,
  local: ProjectExchangeSnapshotV2, selected: ProjectExchangeSnapshotV2, visited = new Set<string>()): boolean {
  const parent = JSON.stringify([before.kind, before.scopeId, before.id]);
  if (visited.has(parent)) return false;
  visited.add(parent);
  try {
    for (const [field, kind] of ownedCollections) {
      const ids = before.data[field], selectedIds = after.data[field];
      if (!configValuesEqual(ids, selectedIds)) return false;
      if (ids === undefined) continue;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return false;
      for (const id of ids) {
        const oldMatches = local.entities.filter((entity) => entity.kind === kind && entity.scopeId === before.scopeId && entity.id === id);
        const newMatches = selected.entities.filter((entity) => entity.kind === kind && entity.scopeId === after.scopeId && entity.id === id);
        if (oldMatches.length !== 1 || newMatches.length !== 1 || !configValuesEqual(oldMatches[0], newMatches[0])
          || !sameReferencedMedia(oldMatches[0].data, local, selected)
          || !sameOwnedClosure(oldMatches[0], newMatches[0], local, selected, visited)) return false;
      }
    }
    return true;
  } finally { visited.delete(parent); }
}

/**
 * 原协作实体和引用素材均未变化的节点可直接保留原生记录；变化时拒绝丢字段。
 * 不把当前画布对象按位置套用到其他分集，ID 与画布映射必须同时匹配。
 */
export function preserveNativeUpdateFields(expected: ProjectModelTransferCapture, next: ProjectModelTransferAggregate,
  local: ProjectExchangeSnapshotV2, selected: ProjectExchangeSnapshotV2, exchange: ProjectModelTransferExchange): void {
  const oldCanvases = new Map(expected.aggregate.canvases.map((canvas) => [canvas.id, canvas]));
  for (const canvas of next.canvases) {
    const old = oldCanvases.get(canvas.id); if (!old) continue;
    const logicalCanvas = exchange.identities.find((item) => item.kind === 'canvas' && item.localId === canvas.id)?.sourceId;
    if (!logicalCanvas) throw new Error('画布协作身份缺失，不能安全更新');
    for (const [field, kind] of [['nodes', 'node'], ['edges', 'edge'], ['groups', 'group']] as const) {
      const source = old[field], target = canvas[field];
      for (let index = 0; index < target.length; index++) {
        const candidate = target[index];
        if (!object(candidate) || typeof candidate.id !== 'string') continue;
        const original = source.find((item) => object(item) && item.id === candidate.id);
        if (!original) continue;
        const previous = local.entities.find((item) => item.kind === kind && item.scopeId === logicalCanvas && item.id === candidate.id);
        const result = selected.entities.find((item) => item.kind === kind && item.scopeId === logicalCanvas && item.id === candidate.id);
        if (previous && result && configValuesEqual(previous, result) && sameReferencedMedia(previous.data, local, selected)
          && sameOwnedClosure(previous, result, local, selected)) target[index] = structuredClone(original);
        else { preserveAssetIdentityFields(original, candidate, local, selected); assertNoDroppedFields(original, candidate); }
      }
    }
  }
  const oldProject = local.entities.find((item) => item.kind === 'project' && item.id === local.rootProjectId);
  const newProject = selected.entities.find((item) => item.kind === 'project' && item.id === selected.rootProjectId);
  if (oldProject && newProject && configValuesEqual(oldProject.data.content, newProject.data.content)
    && sameReferencedMedia(oldProject.data.content, local, selected)
    && sameOwnedClosure(oldProject, newProject, local, selected)) next.content = structuredClone(expected.aggregate.content);
  else { preserveAssetIdentityFields(expected.aggregate.content, next.content, local, selected); assertNoDroppedFields(expected.aggregate.content, next.content); }
  if (oldProject && newProject && configValuesEqual(oldProject.data.defaultSettings, newProject.data.defaultSettings)
    && sameReferencedMedia(oldProject.data.defaultSettings, local, selected)) {
    next.project.defaultSettings = structuredClone(expected.aggregate.project.defaultSettings);
  } else if (expected.aggregate.project.defaultSettings && next.project.defaultSettings) {
    assertNoDroppedFields(expected.aggregate.project.defaultSettings, next.project.defaultSettings);
  } else if (expected.aggregate.project.defaultSettings && !next.project.defaultSettings) {
    throw new Error('更新会移除本机项目设置，未修改项目');
  }
  for (const episode of next.episodes) {
    const original = expected.aggregate.episodes.find((item) => item.id === episode.id);
    if (!original) continue;
    const logical = exchange.identities.find((item) => item.kind === 'episode' && item.localId === episode.id)?.sourceId;
    const previous = local.entities.find((item) => item.kind === 'episode' && item.id === logical);
    const result = selected.entities.find((item) => item.kind === 'episode' && item.id === logical);
    if (previous && result && configValuesEqual(previous.data.settingsPolicy, result.data.settingsPolicy)
      && sameReferencedMedia(previous.data.settingsPolicy, local, selected)) episode.settingsPolicy = structuredClone(original.settingsPolicy);
    else assertNoDroppedFields(original.settingsPolicy, episode.settingsPolicy);
    const before = expected.aggregate.episodeContents.find((item) => item.episodeId === episode.id);
    const index = next.episodeContents.findIndex((item) => item.episodeId === episode.id);
    const after = next.episodeContents[index];
    if (before && after && previous && result && configValuesEqual(previous.data.content, result.data.content)
      && sameReferencedMedia(previous.data.content, local, selected)) next.episodeContents[index] = structuredClone(before);
    else if (before && after) assertNoDroppedFields(before, after);
  }
}
