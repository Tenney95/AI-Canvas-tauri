import { describe, expect, it } from 'vitest';
import { captureArchiveVideoEditorProjects, materializeArchiveVideoEditorProjects, validateArchiveVideoEditorProjects,
  nativeEditorChoiceRequired, resolveNativeEditorUpdate, materializeArchiveRetiredVideoEditorProjects } from '../../src/services/videoEditorArchive';
import type { VideoEditorProjectRecord } from '../../src/types/videoEditor';

describe('剪辑工程归档映射', () => {
  it('以文件身份携带素材，并在副本中映射画布和已发布素材', () => {
    const record: VideoEditorProjectRecord = { id: 'c2-old::node', projectId: 'c2-old', nodeId: 'node', schemaVersion: 1,
      name: '剪辑', createdAt: 1, updatedAt: 1, tracks: [{ id: 'track', kind: 'video', name: '视频', clips: [
        { id: 'clip', kind: 'video', fileName: '素材.mp4', relativePath: 'media/clip.mp4', assetId: 'local-index', sourceUrl: 'https://example.invalid/video?secret=temporary', timelineStart: 0, sourceIn: 0, sourceOut: 1 },
      ] }] };
    const sourceIds = [{ kind: 'canvas' as const, localId: 'c2-old', sourceId: 'canvas-source' },
      { kind: 'storage-root' as const, localId: 'r2-old', sourceId: 'root-source' }];
    const sourceBindings = [{ id: 'file1', rootRef: 'root-source', relativePath: 'media/clip.mp4', localRelativePath: 'media/clip.mp4' }];
    const archive = captureArchiveVideoEditorProjects([record], ['c2-old'], 'r2-old', sourceIds, sourceBindings,
      [{ rootRef: 'r2-old', path: 'media/clip.mp4' }])!;
    const files = [{ id: 'file1', rootRef: 'root-source', relativePath: 'media/clip.mp4', mediaId: 'media1' }];
    validateArchiveVideoEditorProjects(archive, ['canvas-source'], files);
    expect(archive.records[0].tracks[0].clips[0]).toMatchObject({ relativePath: 'exchange-file:file1' });
    expect(archive.records[0].tracks[0].clips[0].assetId).toBeUndefined();
    expect(archive.records[0].tracks[0].clips[0].sourceUrl).toBeUndefined();
    const result = materializeArchiveVideoEditorProjects(archive,
      [{ kind: 'canvas', sourceId: 'canvas-source', localId: 'c2-copy' }],
      [{ ...sourceBindings[0], localRelativePath: 'imports/copy/clip.mp4' }]);
    expect(result[0].id).toBe('c2-copy::node');
    expect(result[0].tracks[0].clips[0].relativePath).toBe('imports/copy/clip.mp4');
    expect(() => validateArchiveVideoEditorProjects(archive, ['canvas-source'], [])).toThrow('素材引用');
    expect(() => captureArchiveVideoEditorProjects([record], [], 'r2-old', sourceIds, sourceBindings, [])).toThrow('已删除');
    const remote = structuredClone(record);
    delete remote.tracks[0].clips[0].relativePath;
    delete remote.tracks[0].clips[0].assetId;
    expect(() => captureArchiveVideoEditorProjects([remote], ['c2-old'], 'r2-old', sourceIds, sourceBindings, [])).toThrow('未物化');
  });

  it('墓碑画布剪辑以独立只读附件携带，不能伪装成活动画布', () => {
    const record: VideoEditorProjectRecord = { id: 'c2-old::node', projectId: 'c2-old', nodeId: 'node', schemaVersion: 1,
      name: '历史工程', createdAt: 1, updatedAt: 1, tracks: [] };
    const ids = [{ kind: 'canvas' as const, localId: 'c2-old', sourceId: 'canvas-old' },
      { kind: 'storage-root' as const, localId: 'r2-old', sourceId: 'root-source' }];
    const archive = captureArchiveVideoEditorProjects([], [], 'r2-old', ids, [], [], [record], ['c2-old'])!;
    expect(archive.records).toEqual([]);
    expect(archive.retiredRecords?.[0]).toMatchObject({ projectId: 'canvas-old', id: 'canvas-old::node' });
    expect(() => validateArchiveVideoEditorProjects(archive, [], [], 'root-source')).toThrow('画布');
    validateArchiveVideoEditorProjects(archive, [], [], 'root-source', ['canvas-old']);
    expect(() => validateArchiveVideoEditorProjects(archive, ['canvas-old'], [], 'root-source', ['canvas-old'])).toThrow('冲突');
    const copied = materializeArchiveRetiredVideoEditorProjects(archive,
      [{ kind: 'canvas', sourceId: 'canvas-old', localId: 'c2-retired-copy' }], []);
    expect(copied[0]).toMatchObject({ projectId: 'c2-retired-copy', id: 'c2-retired-copy::node' });
  });

  it('剪辑没有共同版本时要求明确选择，且不能重绑定未选中的画布', () => {
    const local: VideoEditorProjectRecord = { id: 'c2-local::node', projectId: 'c2-local', nodeId: 'node', schemaVersion: 1,
      name: '本机', createdAt: 1, updatedAt: 1, tracks: [] };
    const incoming = { records: [{ ...local, id: 'logical::node', projectId: 'logical', name: '项目包' }] };
    const input = { required: true, currentRecords: [local], incoming,
      identityMappings: [{ kind: 'canvas' as const, sourceId: 'logical', localId: 'c2-local' }],
      fileBindings: [], targetCanvasIds: ['c2-local'] };
    expect(nativeEditorChoiceRequired(undefined, incoming)).toBe(true);
    expect(nativeEditorChoiceRequired(incoming, structuredClone(incoming))).toBe(true);
    expect(nativeEditorChoiceRequired(undefined, undefined)).toBe(false);
    expect(() => resolveNativeEditorUpdate(input)).toThrow('选择');
    expect(resolveNativeEditorUpdate({ ...input, choice: 'local' })).toEqual([local]);
    expect(resolveNativeEditorUpdate({ ...input, choice: 'incoming' })[0]).toMatchObject({ id: local.id, name: '项目包' });
    expect(() => resolveNativeEditorUpdate({ ...input, choice: 'local', targetCanvasIds: ['other'] })).toThrow('画布');
    expect(resolveNativeEditorUpdate({ ...input, choice: 'local', targetCanvasIds: ['other'], originalCanvasIds: ['c2-local'] })).toEqual([]);
    expect(() => resolveNativeEditorUpdate({ ...input, choice: 'incoming', identityMappings: [] })).toThrow('映射');
  });
});
