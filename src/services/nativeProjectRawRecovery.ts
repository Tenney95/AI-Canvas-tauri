/** 原生恢复点的受控重映射：保留原始字段，不从便携投影重建用户内容。 */
import type { ProjectModelTransferAggregate } from '../types/projectModelTransfer';
import type { VideoEditorProjectRecord } from '../types/videoEditor';
import { safeExchangePath } from './projectExchangeDomain';
import { validateNativeVideoEditorRecord } from './videoEditorRecordValidation';

export interface NativeRecoveryIdentityMapping { from: string; to: string }
export interface NativeRecoveryFileMapping { rootRef: string; from: string; to: string }
export interface NativeRecoveryAssetMapping { from: string; to: string; rootRef: string; fromPath: string; toPath: string }
export interface NativeRawRecoveryInput {
  original: ProjectModelTransferAggregate;
  /** 用校验后的目标描述证明所有目标 ID 及保留的存储根。 */
  target: ProjectModelTransferAggregate;
  episodeIds: readonly NativeRecoveryIdentityMapping[];
  canvasIds: readonly NativeRecoveryIdentityMapping[];
  files: readonly NativeRecoveryFileMapping[];
  editors: readonly VideoEditorProjectRecord[];
  assets?: readonly NativeRecoveryAssetMapping[];
  knownAssets?: readonly NativeRecoveryAssetMapping[];
}

export function referencedNativeRecoveryAssets(original: ProjectModelTransferAggregate, editors: readonly VideoEditorProjectRecord[],
  mappings: readonly NativeRecoveryAssetMapping[]): NativeRecoveryAssetMapping[] {
  const found = new Set<string>(), skip = new Set(['taskId', 'agentTaskId', 'pollTaskId', 'requestId', 'executionContext', 'projectScope',
    'taskReceipt', 'mediaTaskReceipt', 'agentTask', 'mcpOperation', 'dispatchHistory', 'volcengineBinding']);
  let count = 0;
  const walk = (value: unknown, root: string, field = '', depth = 0): void => {
    if (++count > 1_000_000 || depth > 64) throw new Error('恢复素材引用过多');
    if (skip.has(field) || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => walk(item, root, field, depth + 1)); return; }
    const row = value as Record<string, unknown>, bound = typeof row.storageRootRef === 'string' ? row.storageRootRef : root;
    for (const [idKey, pathKey] of [['assetId', 'relativePath'], ['imageAssetId', 'imageRelativePath']] as const) {
      const mapping = mappings.find((item) => item.from === row[idKey]);
      if (mapping && mapping.rootRef === bound && (row[pathKey] ?? row.relativePath) === mapping.fromPath) found.add(mapping.from);
    }
    Object.entries(row).forEach(([key, item]) => walk(item, bound, key, depth + 1));
  };
  walk(original, original.project.storageRootRef); walk(editors, original.project.storageRootRef);
  return mappings.filter((mapping) => found.has(mapping.from));
}

function identityMap(rows: readonly NativeRecoveryIdentityMapping[], before: readonly string[], after: readonly string[]): Map<string, string> {
  if (!Array.isArray(rows) || rows.length !== before.length || before.length !== after.length) throw new Error('恢复身份映射不完整');
  const map = new Map<string, string>(), targets = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.from !== 'string' || typeof row.to !== 'string' || !before.includes(row.from)
      || !after.includes(row.to) || map.has(row.from) || targets.has(row.to)) throw new Error('恢复身份映射不唯一');
    map.set(row.from, row.to); targets.add(row.to);
  }
  if (map.size !== before.length || targets.size !== after.length) throw new Error('恢复身份映射不完整');
  return map;
}

/**
 * 调用方必须先按原恢复点与目标 exchange 的 fileBinding 验证 files，并冻结全部输入。
 * 未明确建模的字段包含被替换身份或素材路径时失败，不能猜测其业务含义。
 */
export function materializeNativeRawRecovery(input: NativeRawRecoveryInput): {
  aggregate: ProjectModelTransferAggregate; editors: VideoEditorProjectRecord[];
} {
  const { original, target } = input;
  if (!original || !target || original.project.id !== target.project.id || original.project.kind !== target.project.kind
    || original.project.dataFolder !== target.project.dataFolder || original.project.storageRootRef !== target.project.storageRootRef
    || original.previews.length || target.previews.length || target.bindings.length
    || original.bindings.some((item) => item.namespace !== 'legacy-canvas' || !item.retired
      || item.projectId !== original.project.id || !item.canvasId)) throw new Error('原恢复点项目身份不一致');
  for (const binding of original.project.storageBindings) if (!target.project.storageBindings.some((item) =>
    item.rootRef === binding.rootRef && item.folderName === binding.folderName && item.source === binding.source)) throw new Error('原恢复点素材根已变化');
  const episodes = identityMap(input.episodeIds, original.episodes.map((item) => item.id), target.episodes.map((item) => item.id));
  const canvases = identityMap(input.canvasIds, original.canvases.map((item) => item.id), target.canvases.map((item) => item.id));
  for (const episode of original.episodes) {
    const nextEpisode = target.episodes.find((item) => item.id === episodes.get(episode.id));
    if (!nextEpisode || nextEpisode.projectId !== original.project.id || nextEpisode.canvasId !== canvases.get(episode.canvasId)) {
      throw new Error('恢复分集与目标画布映射不一致');
    }
  }
  for (const canvas of original.canvases) {
    const nextCanvas = target.canvases.find((item) => item.id === canvases.get(canvas.id));
    const episodeId = canvas.episodeId === null ? null : episodes.get(canvas.episodeId);
    if (!nextCanvas || nextCanvas.projectId !== original.project.id || nextCanvas.episodeId !== episodeId
      || nextCanvas.storageRootRef !== canvas.storageRootRef) throw new Error('恢复画布与原身份映射不一致');
  }
  if (original.episodeContents.length !== target.episodeContents.length
    || original.episodeContents.some((body) => !episodes.has(body.episodeId)
      || target.episodeContents.filter((item) => item.episodeId === episodes.get(body.episodeId)).length !== 1)) {
    throw new Error('恢复正文与分集身份不一致');
  }
  const changedIds = [...episodes, ...canvases].filter(([from, to]) => from !== to).map(([from]) => from);
  if (new Set(changedIds).size !== changedIds.length) throw new Error('不同领域的旧身份冲突');
  const files = new Map<string, string>(), destinations = new Set<string>();
  for (const row of input.files) {
    if (!row || !original.project.storageBindings.some((root) => root.rootRef === row.rootRef)
      || safeExchangePath(row.from) !== row.from || safeExchangePath(row.to) !== row.to) throw new Error('恢复素材映射无效');
    const key = JSON.stringify([row.rootRef, row.from]);
    const destination = JSON.stringify([row.rootRef, row.to.normalize('NFC').toLowerCase()]);
    if (files.has(key) || destinations.has(destination)) throw new Error('恢复素材映射重复');
    files.set(key, row.to); destinations.add(destination);
  }
  const changedFiles = input.files.filter((item) => item.from !== item.to);
  const usedAssets = new Set<string>();
  const assets = new Map<string, NativeRecoveryAssetMapping>();
  const targets = new Set<string>();
  for (const asset of input.assets ?? []) {
    if (!asset.from || !/^na2-[a-f0-9-]{36}$/.test(asset.to) || assets.has(asset.from) || targets.has(asset.to)
      || !input.files.some((file) => file.rootRef === asset.rootRef && file.from === asset.fromPath && file.to === asset.toPath)) throw new Error('恢复素材身份映射无效');
    assets.set(asset.from, asset); targets.add(asset.to);
  }
  const historicalKeys = new Set(['taskId', 'agentTaskId', 'pollTaskId', 'requestId', 'executionContext', 'projectScope',
    'taskReceipt', 'mediaTaskReceipt', 'agentTask', 'mcpOperation', 'dispatchHistory', 'volcengineBinding']);
  const pathKeys = new Set(['relativePath', 'imageRelativePath', 'directorCaptureRelativePaths']);
  // 这些媒体字段既可能是项目相对路径，也可能是远端 URL 或自由输出；只对完整匹配的已验证路径重写。
  const projectMediaKeys = new Set(['videoUrl', 'imageUrl', 'audioUrl', 'output']);
  let count = 0;
  const visit = (value: unknown, root: string, field = '', depth = 0): unknown => {
    if (++count > 1_000_000 || depth > 64) throw new Error('恢复内容过大或嵌套异常');
    if (historicalKeys.has(field)) return structuredClone(value);
    if (typeof value === 'string') {
      if (pathKeys.has(field)) {
        const key = JSON.stringify([root, value]);
        if (value && !files.has(key)) throw new Error('原恢复点素材缺少经核验的映射');
        return files.get(key) ?? value;
      }
      if (projectMediaKeys.has(field)) {
        const mapped = files.get(JSON.stringify([root, value]));
        if (mapped !== undefined) return mapped;
      }
      if (changedIds.some((id) => value === id || value.includes(id))) throw new Error('未知字段包含待重绑的旧分集或画布身份');
      if ((input.knownAssets ?? input.assets ?? []).some((asset) => value.includes(asset.from))) throw new Error('未知字段包含待重绑的旧素材身份');
      // Tauri URL 可把盘符和分隔符百分号编码；查询串不能掩盖需要重绑的绝对路径。
      let decoded = value;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; }
      }
      const normalized = decoded.replace(/\\/g, '/').toLowerCase().split(/[?#]/, 1)[0];
      if (changedFiles.some((item) => item.rootRef === root && (decoded === item.from
        || normalized.endsWith('/' + item.from.toLowerCase())))) throw new Error('未知或绝对路径需要重新绑定，无法安全恢复');
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, root, field, depth + 1));
    if (!value || typeof value !== 'object') return value;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('恢复内容包含不支持的对象');
    const record = value as Record<string, unknown>;
    const bound = typeof record.storageRootRef === 'string' ? record.storageRootRef : root;
    const replacements = new Map<string, string>();
    for (const [idKey, pathKey] of [['assetId', 'relativePath'], ['imageAssetId', 'imageRelativePath']] as const) {
      const id = record[idKey], replacement = typeof id === 'string' ? assets.get(id) : undefined;
      if (replacement) {
        const path = record[pathKey] ?? record.relativePath;
        if (replacement.rootRef !== bound || path !== replacement.fromPath) throw new Error('恢复素材身份与原路径不一致');
        replacements.set(idKey, replacement.to);
        usedAssets.add(replacement.from);
      }
    }
    if ((typeof record.assetId === 'string' && record.assetId || typeof record.imageAssetId === 'string' && record.imageAssetId)
      && ['relativePath', 'imageRelativePath', 'videoUrl', 'imageUrl', 'audioUrl', 'output'].some((key) => typeof record[key] === 'string'
        && files.has(JSON.stringify([bound, record[key]])) && files.get(JSON.stringify([bound, record[key]])) !== record[key])
      && !replacements.size) {
      throw new Error('恢复素材路径变化但原索引身份仍被引用，无法安全重绑');
    }
    const localizedPrimary = replacements.has('imageAssetId');
    return Object.fromEntries(Object.entries(record).filter(([key]) => !(replacements.size && key === 'assetSource'))
      .map(([key, entry]) => [localizedPrimary && key === 'imageAssetId' ? 'assetId' : localizedPrimary && key === 'imageRelativePath' ? 'relativePath' : key,
        replacements.has(key) ? replacements.get(key) : visit(entry, bound, key, depth + 1)]));
  };
  const remapStory = (raw: typeof original.content.storyGraph) => {
    if (!raw) return raw;
    const graph = structuredClone(raw);
    const remap = (id: string) => episodes.get(id) ?? id;
    for (const node of graph.nodes) {
      node.episodeIds = node.episodeIds.map(remap);
      node.evidence = node.evidence.map((item) => ({ ...item, episodeId: remap(item.episodeId) }));
    }
    for (const edge of graph.edges) {
      edge.episodeIds = edge.episodeIds.map(remap);
      edge.evidence = edge.evidence.map((item) => ({ ...item, episodeId: remap(item.episodeId) }));
      if (edge.fromEpisodeId) edge.fromEpisodeId = remap(edge.fromEpisodeId);
      if (edge.toEpisodeId) edge.toEpisodeId = remap(edge.toEpisodeId);
    }
    return graph;
  };
  const { storageBindings: _bindings, lastOpenedCanvasId, ...projectFields } = original.project;
  const project = { ...visit(projectFields, original.project.storageRootRef) as typeof projectFields,
    storageBindings: structuredClone(target.project.storageBindings),
    ...(lastOpenedCanvasId ? { lastOpenedCanvasId } : {}) };
  if (project.lastOpenedCanvasId) {
    const id = canvases.get(project.lastOpenedCanvasId);
    if (!id) throw new Error('恢复的当前画布身份缺失');
    project.lastOpenedCanvasId = id;
  }
  const { storyGraph, ...content } = original.content;
  const resultContent = visit({ ...content, ...(storyGraph ? { storyGraph: remapStory(storyGraph) } : {}) }, original.project.storageRootRef) as typeof original.content;
  const resultEpisodes = original.episodes.map((source) => {
    const { id, canvasId, ...rest } = source;
    return { ...visit(rest, original.project.storageRootRef) as typeof rest, id: episodes.get(id)!, canvasId: canvases.get(canvasId)! };
  });
  const resultContents = original.episodeContents.map((source) => {
    const { episodeId, ...rest } = source;
    const id = episodes.get(episodeId); if (!id) throw new Error('恢复正文身份缺失');
    return { ...visit(rest, source.storageRootRef) as typeof rest, episodeId: id };
  });
  const resultCanvases = original.canvases.map((source) => {
    const { id, episodeId, ...rest } = source;
    const next = canvases.get(id), episode = episodeId === null ? null : episodes.get(episodeId);
    if (!next || episodeId !== null && !episode) throw new Error('恢复画布身份缺失');
    return { ...visit(rest, source.storageRootRef) as typeof rest, id: next, episodeId: episode ?? null };
  });
  const editorIds = new Set<string>();
  const editors = input.editors.map((source) => {
    validateNativeVideoEditorRecord(source, source.projectId);
    const canvasId = canvases.get(source.projectId);
    if (!canvasId) throw new Error('恢复剪辑所属画布身份缺失');
    const { id: _id, projectId: _projectId, ...rest } = source;
    const record = { ...visit(rest, original.project.storageRootRef) as typeof rest, projectId: canvasId, id: `${canvasId}::${source.nodeId}` };
    if (editorIds.has(record.id)) throw new Error('恢复剪辑身份重复');
    validateNativeVideoEditorRecord(record, canvasId); editorIds.add(record.id);
    return record;
  });
  if (usedAssets.size !== assets.size) throw new Error('恢复素材身份映射包含未使用项');
  return { aggregate: { project, content: resultContent, episodes: resultEpisodes, episodeContents: resultContents,
    canvases: resultCanvases, previews: [], bindings: [] }, editors };
}
