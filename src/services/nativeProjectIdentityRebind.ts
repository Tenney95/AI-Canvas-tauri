/** 退役分集恢复为新逻辑对象；历史映射保留，不能复活旧执行身份。 */
import type { ProjectExchangeSnapshotV2, ProjectArchiveVideoEditorV4 } from '../types/projectArchiveV4';
import type { ProjectModelTransferExchange } from '../types/projectModelTransfer';
import { normalizeStoryGraph } from './storyGraphService';
import { remapStoryGraphBindings } from './projectExchangeDomain';
import { exchangeReferencesV2, parseProjectExchangeSnapshotV2 } from './projectExchangeV2Format';

export function rebindRetiredNativeSnapshot(input: ProjectExchangeSnapshotV2, exchange: ProjectModelTransferExchange,
  retiredIds: readonly string[], editor?: ProjectArchiveVideoEditorV4): {
    snapshot: ProjectExchangeSnapshotV2; editor?: ProjectArchiveVideoEditorV4;
    rebindings: Array<{ kind: 'episode' | 'canvas'; from: string; to: string }>;
  } {
  const snapshot = parseProjectExchangeSnapshotV2(input), retired = new Set(retiredIds);
  const replacements = new Map<string, string>();
  for (const mapping of exchange.identities) {
    if ((mapping.kind !== 'episode' && mapping.kind !== 'canvas') || !retired.has(mapping.localId)) continue;
    if (snapshot.entities.some((entity) => entity.kind === mapping.kind && entity.id === mapping.sourceId)) {
      const key = `${mapping.kind}:${mapping.sourceId}`;
      if (replacements.has(key)) throw new Error('退役项目身份映射重复');
      replacements.set(key, `${mapping.kind}-${crypto.randomUUID()}`);
    }
  }
  if (!replacements.size) return { snapshot, rebindings: [], ...(editor ? { editor: structuredClone(editor) } : {}) };
  const resolve = (kind: 'episode' | 'canvas', id: string) => replacements.get(`${kind}:${id}`) ?? id;
  const root = snapshot.rootProjectId;
  const entities = snapshot.entities.map((source) => {
    const entity = structuredClone(source);
    if (entity.kind === 'episode') {
      entity.id = resolve('episode', entity.id);
      if (typeof entity.data.canvasId !== 'string') throw new Error('分集画布身份无效');
      entity.data.canvasId = resolve('canvas', entity.data.canvasId);
    } else if (entity.kind === 'canvas') {
      entity.id = resolve('canvas', entity.id);
      if (typeof entity.data.episodeId === 'string') entity.data.episodeId = resolve('episode', entity.data.episodeId);
    } else if (['node', 'edge', 'group', 'shot'].includes(entity.kind)) {
      entity.scopeId = resolve('canvas', entity.scopeId);
    } else if (entity.kind === 'project') {
      if (typeof entity.data.standaloneCanvasId === 'string') entity.data.standaloneCanvasId = resolve('canvas', entity.data.standaloneCanvasId);
      const content = entity.data.content;
      if (content && typeof content === 'object' && !Array.isArray(content) && content.storyGraph) {
        const raw = content.storyGraph;
        if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('故事图身份无效');
        const graph = normalizeStoryGraph({ ...raw, revision: 0 });
        const rebound = remapStoryGraphBindings(graph, (id) => resolve('episode', id), (asset) => asset.id);
        const { revision: _revision, ...portable } = rebound;
        content.storyGraph = portable as unknown as typeof content.storyGraph;
      }
    }
    return entity;
  });
  const historical = new Map(snapshot.historicalTargets.map((item) => [JSON.stringify([item.kind, item.id]), item]));
  for (const key of replacements.keys()) {
    const separator = key.indexOf(':'), kind = key.slice(0, separator) as 'episode' | 'canvas', id = key.slice(separator + 1);
    historical.set(JSON.stringify([kind, id]), { state: 'retired', kind, projectId: root, id });
  }
  const rebound = parseProjectExchangeSnapshotV2({ ...snapshot, entities: entities.map((item) => ({ ...item,
    references: exchangeReferencesV2(item, entities, root) })), historicalTargets: [...historical.values()] });
  const editorRecords = editor?.records.map((source) => {
    const record = structuredClone(source), id = resolve('canvas', record.projectId);
    record.projectId = id; record.id = `${id}::${record.nodeId}`; return record;
  });
  // 历史工程继续绑定原墓碑；重绑只应用于恢复后的活动画布。
  const rebindings = [...replacements].map(([key, to]) => {
    const separator = key.indexOf(':');
    return { kind: key.slice(0, separator) as 'episode' | 'canvas', from: key.slice(separator + 1), to };
  });
  return { snapshot: rebound, rebindings, ...(editorRecords ? { editor: { records: editorRecords,
    ...(editor?.retiredRecords ? { retiredRecords: structuredClone(editor.retiredRecords) } : {}) } } : {}) };
}
