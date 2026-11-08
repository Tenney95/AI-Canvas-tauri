/** 历史剪辑素材 pin 的纯数据验证，不访问实际项目。 */
import { expect, it } from 'vitest';
import type { ProjectArchiveBusinessV4 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange } from '../../src/types/projectModelTransfer';
import type { VideoEditorProjectRecord } from '../../src/types/videoEditor';
import { buildProjectExchangeSnapshotV2 } from '../../src/services/projectArchiveV4';
import { pinNativeHistoricalEditorMedia } from '../../src/services/nativeProjectHistoricalEditorMedia';

it('删集时把历史剪辑依赖的原文件固定到协作快照，遇到同 ID 不同版本则拒绝', () => {
  const project = { id: 'P', name: '项目', kind: 'series' as const, storageRoots: [{ id: 'root', role: 'shared' as const }] };
  const empty: ProjectArchiveBusinessV4 = { project, episodes: [], canvases: [], contents: { project: { projectId: 'P', data: {} }, episodes: [] } };
  const full: ProjectArchiveBusinessV4 = { ...empty,
    episodes: [{ id: 'E', projectId: 'P', canvasId: 'C', name: '第一集', orderRank: 0, settingsPolicy: { mode: 'inherit', overrides: {} } }],
    canvases: [{ id: 'C', projectId: 'P', episodeId: 'E', storageRootRef: 'root', nodes: [], edges: [], groups: [] }],
    contents: { ...empty.contents, episodes: [{ episodeId: 'E', data: { storageRootRef: 'root' } }] } };
  const media = { id: 'media', kind: 'video' as const, extension: 'mp4', bytes: 12, sha256: 'a'.repeat(64) };
  const file = { id: 'file', rootRef: 'root', relativePath: 'media/a.mp4', mediaId: media.id };
  const local = buildProjectExchangeSnapshotV2(full, 'lineage', [media], [file]);
  const selected = buildProjectExchangeSnapshotV2(empty, 'lineage', [], []);
  const editor: VideoEditorProjectRecord = { id: 'c2-local::node', projectId: 'c2-local', nodeId: 'node', schemaVersion: 1,
    name: '工程', createdAt: 1, updatedAt: 1, tracks: [{ id: 'track', name: '轨道', kind: 'video', clips: [{ id: 'clip',
      kind: 'video', fileName: 'a.mp4', relativePath: 'media/a.mp4', timelineStart: 0, sourceIn: 0, sourceOut: 1 }] }] };
  const exchange = { lineageId: 'lineage', identities: [{ kind: 'canvas', sourceId: 'C', localId: 'c2-local' },
    { kind: 'storage-root', sourceId: 'root', localId: 'r2-local' }], fileBindings: [{ ...file, localRelativePath: file.relativePath }] } as unknown as ProjectModelTransferExchange;
  const expected = { aggregate: { project: { storageRootRef: 'r2-local' } }, editorRecords: [editor], retiredEditorRecords: [] } as unknown as ProjectModelTransferCapture;
  const pinned = pinNativeHistoricalEditorMedia({ selected, local, localExchange: exchange, expected });
  expect(pinned.entities.find((item) => item.kind === 'file' && item.id === 'file')?.data.mediaId).toBe('media');
  expect(pinned.media).toContainEqual(media);
  expect(pinned.historicalTargets).toContainEqual({ state: 'retired', kind: 'canvas', projectId: 'P', id: 'C' });
  const other = { ...media, id: 'different', sha256: 'b'.repeat(64) };
  const conflicted = buildProjectExchangeSnapshotV2(empty, 'lineage', [other], [{ ...file, mediaId: other.id }]);
  expect(() => pinNativeHistoricalEditorMedia({ selected: conflicted, local, localExchange: exchange, expected })).toThrow('版本冲突');
});
