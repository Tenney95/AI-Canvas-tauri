/** 给保留的历史剪辑固定原文件身份，不能因删除分集而丢失素材。 */
import type { ProjectExchangeSnapshotV2 } from '../types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange } from '../types/projectModelTransfer';
import type { VideoEditorProjectRecord } from '../types/videoEditor';
import { configValuesEqual } from './configPatch';
import { exchangeReferencesV2, parseProjectExchangeSnapshotV2 } from './projectExchangeV2Format';

/**
 * 保留本机原墓碑及本次删除画布的剪辑工程引用。
 * 同一 fileId 两侧是不同文件时不能猜版本；调用方须先明确处理冲突。
 */
export function pinNativeHistoricalEditorMedia(input: {
  selected: ProjectExchangeSnapshotV2;
  local: ProjectExchangeSnapshotV2;
  localExchange: ProjectModelTransferExchange;
  expected: ProjectModelTransferCapture;
}): ProjectExchangeSnapshotV2 {
  const selected = parseProjectExchangeSnapshotV2(input.selected), local = parseProjectExchangeSnapshotV2(input.local);
  if (selected.rootProjectId !== local.rootProjectId || selected.lineageId !== local.lineageId
    || input.localExchange.lineageId !== local.lineageId) throw new Error('历史剪辑来源不一致');
  const canvasId = (id: string) => {
    const matches = input.localExchange.identities.filter((item) => item.kind === 'canvas' && item.localId === id);
    if (matches.length !== 1) throw new Error('历史剪辑画布缺少唯一来源身份');
    return matches[0].sourceId;
  };
  const roots = input.localExchange.identities.filter((item) => item.kind === 'storage-root'
    && item.localId === input.expected.aggregate.project.storageRootRef);
  if (roots.length !== 1) throw new Error('历史剪辑素材根无效');
  const active = new Set(selected.entities.filter((item) => item.kind === 'canvas').map((item) => item.id));
  const historical: VideoEditorProjectRecord[] = [...(input.expected.retiredEditorRecords ?? []),
    ...(input.expected.editorRecords ?? []).filter((record) => !active.has(canvasId(record.projectId)))];
  if (!historical.length) return selected;
  const entities = [...selected.entities], media = [...selected.media];
  const retired = new Map(selected.historicalTargets.map((item) => [JSON.stringify([item.kind, item.id]), item]));
  for (const editor of historical) {
    const logicalCanvas = canvasId(editor.projectId);
    if (active.has(logicalCanvas)) throw new Error('历史剪辑画布不能作为活动画布');
    retired.set(JSON.stringify(['canvas', logicalCanvas]), { state: 'retired', kind: 'canvas',
      projectId: selected.rootProjectId, id: logicalCanvas });
    for (const track of editor.tracks) for (const clip of track.clips) {
      if (clip.kind !== 'text' && !clip.relativePath) throw new Error('历史剪辑素材未物化');
      if (!clip.relativePath) continue;
      const bindings = input.localExchange.fileBindings.filter((item) => item.rootRef === roots[0].sourceId
        && item.localRelativePath === clip.relativePath);
      if (bindings.length !== 1) throw new Error('历史剪辑素材缺少唯一原绑定');
      const binding = bindings[0];
      const source = local.entities.filter((item) => item.kind === 'file' && item.id === binding.id
        && item.data.rootRef === binding.rootRef && item.data.relativePath === binding.relativePath);
      if (source.length !== 1 || typeof source[0].data.mediaId !== 'string') throw new Error('历史剪辑素材缺少原版本');
      const originalMedia = local.media.filter((item) => item.id === source[0].data.mediaId);
      if (originalMedia.length !== 1) throw new Error('历史剪辑素材摘要缺失');
      const existing = entities.filter((item) => item.kind === 'file' && item.id === binding.id);
      if (existing.length > 1 || existing.length === 1 && !configValuesEqual(existing[0].data, source[0].data)) {
        throw new Error('历史剪辑素材与本次选择的文件版本冲突，请保留原版本或先导入为新项目');
      }
      if (!existing.length) entities.push(structuredClone(source[0]));
      const present = media.filter((item) => item.id === originalMedia[0].id);
      if (present.length > 1 || present.length === 1 && !configValuesEqual(present[0], originalMedia[0])) {
        throw new Error('历史剪辑素材摘要冲突');
      }
      if (!present.length) media.push(structuredClone(originalMedia[0]));
    }
  }
  return parseProjectExchangeSnapshotV2({ ...selected, entities: entities.map((item) => ({ ...item,
    references: exchangeReferencesV2(item, entities, selected.rootProjectId) })), media,
    historicalTargets: [...retired.values()] });
}
