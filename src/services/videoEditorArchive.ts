/** 剪辑工程在 v4 附件中使用协作文件 ID，绝不携带本机路径或资产索引身份。 */
import type { VideoEditorProjectRecord } from '../types/videoEditor';
import type { ProjectArchiveFileV4, ProjectArchiveVideoEditorV4 } from '../types/projectArchiveV4';
import type { ProjectModelTransferExchange, ProjectModelTransferIdMapEntry } from '../types/projectModelTransfer';
import { serializeProjectExchangeValue } from './projectExchangeFormat';
import { validateNativeVideoEditorRecord } from './videoEditorRecordValidation';

const prefix = 'exchange-file:';

export function captureArchiveVideoEditorProjects(records: VideoEditorProjectRecord[], canvasIds: string[], primaryRoot: string,
  identities: ProjectModelTransferIdMapEntry[], bindings: ProjectModelTransferExchange['fileBindings'],
  assets: Array<{ rootRef: string; path: string; aliases?: string[] }>,
  retiredRecords: VideoEditorProjectRecord[] = [], retiredCanvasIds: string[] = []): ProjectArchiveVideoEditorV4 | undefined {
  if (!records.length && !retiredRecords.length) return undefined;
  const logicalRoot = identities.find((entry) => entry.kind === 'storage-root' && entry.localId === primaryRoot)?.sourceId;
  if (!logicalRoot) throw new Error('剪辑素材缺少归档根映射');
  const capture = (input: VideoEditorProjectRecord, allowed: readonly string[]) => {
    validateNativeVideoEditorRecord(input, input.projectId);
    if (!allowed.includes(input.projectId)) throw new Error('已删除或未知画布的剪辑工程缺少墓碑身份');
    const canvas = identities.find((entry) => entry.kind === 'canvas' && entry.localId === input.projectId)?.sourceId;
    if (!canvas) throw new Error('剪辑工程缺少画布映射');
    const record = JSON.parse(JSON.stringify(input)) as VideoEditorProjectRecord;
    record.projectId = canvas; record.id = `${canvas}::${record.nodeId}`;
    for (const track of record.tracks) for (const clip of track.clips) {
      if (clip.relativePath) {
        const asset = assets.find((entry) => entry.rootRef === primaryRoot && (entry.path === clip.relativePath || entry.aliases?.includes(clip.relativePath!)));
        const matches = bindings.filter((entry) => entry.rootRef === logicalRoot && asset
          && (entry.localRelativePath === asset.path || asset.aliases?.includes(entry.localRelativePath)));
        if (matches.length !== 1) throw new Error('剪辑素材缺少唯一的归档文件映射');
        clip.relativePath = `${prefix}${matches[0].id}`;
        delete clip.assetId; delete clip.sourceUrl;
      } else if (clip.assetId || clip.sourceUrl || clip.kind !== 'text') {
        throw new Error('剪辑素材未物化，无法完整导出');
      }
    }
    return record;
  };
  const output = records.map((record) => capture(record, canvasIds));
  const retired = retiredRecords.map((record) => capture(record, retiredCanvasIds));
  const allIds = [...output, ...retired].map((record) => record.id);
  if (new Set(allIds).size !== allIds.length) throw new Error('剪辑工程身份重复');
  serializeProjectExchangeValue([output, retired]);
  return { records: output, ...(retired.length ? { retiredRecords: retired } : {}) };
}

export function validateArchiveVideoEditorProjects(value: ProjectArchiveVideoEditorV4 | undefined, canvasIds: string[], files: ProjectArchiveFileV4[],
  primaryRoot?: string, retiredCanvasIds: readonly string[] = []): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'records' && key !== 'retiredRecords')
    || !Array.isArray(value.records) || value.retiredRecords !== undefined && !Array.isArray(value.retiredRecords)
    || value.records.length + (value.retiredRecords?.length ?? 0) > 200_000) throw new Error('项目包剪辑记录无效');
  serializeProjectExchangeValue(value);
  const ids = new Set<string>();
  const all = [...value.records.map((source) => ({ source, allowed: canvasIds })),
    ...(value.retiredRecords ?? []).map((source) => ({ source, allowed: retiredCanvasIds }))];
  if (retiredCanvasIds.some((id) => canvasIds.includes(id))) throw new Error('活动画布与历史画布身份冲突');
  for (const { source, allowed } of all) {
    if (!source || !allowed.includes(source.projectId) || ids.has(source.id)) throw new Error('项目包剪辑画布或工程重复');
    const record = structuredClone(source);
    for (const track of record.tracks ?? []) for (const clip of track.clips ?? []) {
      if (clip.assetId || clip.sourceUrl) throw new Error('项目包剪辑工程包含本机素材身份或临时地址');
      if (clip.kind !== 'text' && !clip.relativePath) throw new Error('项目包剪辑素材缺少文件引用');
      if (clip.relativePath !== undefined) {
        if (typeof clip.relativePath !== 'string' || !clip.relativePath.startsWith(prefix)
          || files.filter((file) => file.id === clip.relativePath!.slice(prefix.length)
            && (primaryRoot === undefined || file.rootRef === primaryRoot)).length !== 1) throw new Error('项目包剪辑素材引用无效');
        clip.relativePath = 'archive-reference';
      }
    }
    validateNativeVideoEditorRecord(record, source.projectId); ids.add(source.id);
  }
}

function materializeRecords(records: readonly VideoEditorProjectRecord[],
  identities: ProjectModelTransferIdMapEntry[], bindings: ProjectModelTransferExchange['fileBindings']): VideoEditorProjectRecord[] {
  return records.map((source) => {
    const canvas = identities.find((entry) => entry.kind === 'canvas' && entry.sourceId === source.projectId)?.localId;
    if (!canvas) throw new Error('项目包剪辑画布缺少目标映射');
    const record = structuredClone(source); record.projectId = canvas; record.id = `${canvas}::${record.nodeId}`;
    for (const track of record.tracks) for (const clip of track.clips) if (clip.relativePath) {
      const id = clip.relativePath.slice(prefix.length), matches = bindings.filter((entry) => entry.id === id);
      if (!clip.relativePath.startsWith(prefix) || matches.length !== 1) throw new Error('项目包剪辑素材缺少目标映射');
      clip.relativePath = matches[0].localRelativePath;
    }
    validateNativeVideoEditorRecord(record, canvas);
    return record;
  });
}

export function materializeArchiveVideoEditorProjects(value: ProjectArchiveVideoEditorV4 | undefined,
  identities: ProjectModelTransferIdMapEntry[], bindings: ProjectModelTransferExchange['fileBindings']): VideoEditorProjectRecord[] {
  return materializeRecords(value?.records ?? [], identities, bindings);
}
/** 历史工程的目标必须是事务已建立的墓碑画布，不能用于创建活动编辑租约。 */
export function materializeArchiveRetiredVideoEditorProjects(value: ProjectArchiveVideoEditorV4 | undefined,
  identities: ProjectModelTransferIdMapEntry[], bindings: ProjectModelTransferExchange['fileBindings']): VideoEditorProjectRecord[] {
  return materializeRecords(value?.retiredRecords ?? [], identities, bindings);
}

/** 独立于画布正文的人工选择键；不能把旧包缺少附件猜成未发生变化。 */
export const NATIVE_EDITOR_CHOICE_KEY = '__native_video_editor__';
export type NativeEditorUpdateChoice = 'local' | 'incoming';

/** V4 剪辑附件没有三方历史基线；存在工程时要求用户选择。 */
export function nativeEditorChoiceRequired(local: ProjectArchiveVideoEditorV4 | undefined,
  incoming: ProjectArchiveVideoEditorV4 | undefined): boolean {
  // 即使工程描述相同，文件 ID 指向的字节也可能在两侧变化；缺基线时不能猜要保留哪一版。
  return !!local?.records.length || !!incoming?.records.length;
}

/**
 * 以用户选择构造原子提交材料，不对剪辑工程猜测三方合并。
 * 若画布结构的选择与工程选择冲突则拒绝，不能把工程重绑到别的画布。
 */
export function resolveNativeEditorUpdate(input: {
  required: boolean;
  choice?: NativeEditorUpdateChoice;
  currentRecords: readonly VideoEditorProjectRecord[];
  incoming: ProjectArchiveVideoEditorV4 | undefined;
  identityMappings: ProjectModelTransferIdMapEntry[];
  fileBindings: ProjectModelTransferExchange['fileBindings'];
  targetCanvasIds: readonly string[];
  /** 删除画布的本机工程由同一事务保留为墓碑历史。 */
  originalCanvasIds?: readonly string[];
}): VideoEditorProjectRecord[] {
  if (input.required && input.choice !== 'local' && input.choice !== 'incoming') {
    throw new Error('剪辑工程没有共同版本，请先选择保留本机工程或使用项目包工程');
  }
  if (input.choice !== undefined && input.choice !== 'local' && input.choice !== 'incoming') throw new Error('剪辑工程选择无效');
  const canvases = new Set(input.targetCanvasIds), originalCanvases = new Set(input.originalCanvasIds ?? input.targetCanvasIds);
  // 本机工程若随画布删除，留在原 tombstone 下；不能把它绑定到别的画布。
  const local = input.currentRecords.filter((record) => {
    if (!originalCanvases.has(record.projectId)) throw new Error('本机剪辑缺少原活动画布');
    return canvases.has(record.projectId);
  });
  const result = input.choice === 'incoming'
    ? materializeArchiveVideoEditorProjects(input.incoming, input.identityMappings, input.fileBindings)
    : structuredClone(local);
  const ids = new Set<string>();
  if (canvases.size !== input.targetCanvasIds.length) throw new Error('目标画布身份重复');
  for (const record of result) {
    if (!canvases.has(record.projectId)) {
      throw new Error('剪辑工程所属画布未包含在所选更新中；请调整画布或剪辑工程选择');
    }
    validateNativeVideoEditorRecord(record, record.projectId);
    if (ids.has(record.id)) throw new Error('剪辑工程身份重复');
    ids.add(record.id);
  }
  return result;
}
