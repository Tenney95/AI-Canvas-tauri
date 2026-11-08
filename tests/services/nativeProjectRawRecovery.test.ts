/** 原生恢复点只使用合成数据；不访问真实项目。 */
import { describe, expect, it } from 'vitest';
import type { ProjectModelTransferAggregate } from '../../src/types/projectModelTransfer';
import type { VideoEditorProjectRecord } from '../../src/types/videoEditor';
import { materializeNativeRawRecovery, referencedNativeRecoveryAssets, type NativeRawRecoveryInput } from '../../src/services/nativeProjectRawRecovery';

function fixture(): NativeRawRecoveryInput {
  const root = 'r2-root', oldEpisode = 'e2-old', oldCanvas = 'c2-old';
  const original = {
    project: { id: 'p2-project', name: '项目', kind: 'series', dataFolder: 'project-data', storageRootRef: root,
      storageBindings: [{ rootRef: root, folderName: 'project-data', sourceRecordIds: [], source: 'project-managed' }],
      createdAt: 1, updatedAt: 2, epoch: 4, lastOpenedCanvasId: oldCanvas },
    content: { projectId: 'p2-project', revisions: { source: 0, script: 0, storyGraph: 1, assets: 0 }, script: '原全剧',
      storyGraph: { schemaVersion: 1, id: 'graph', revision: 4, positions: {}, nodes: [{ id: 'n', kind: 'event',
        label: '故事', description: '', aliases: [], episodeIds: [oldEpisode], evidence: [{ episodeId: oldEpisode, part: 'script',
          quote: '原句', sourceHash: 'a'.repeat(64) }], origin: 'manual', certainty: 'confirmed' }], edges: [] } },
    episodes: [{ id: oldEpisode, canvasId: oldCanvas, projectId: 'p2-project', name: '一', orderRank: 0,
      createdAt: 1, updatedAt: 2, epoch: 1, revision: 0, settingsPolicy: { mode: 'inherit', overrides: {} } }],
    episodeContents: [{ episodeId: oldEpisode, revision: 0, storageRootRef: root, outline: '原文' }],
    canvases: [{ id: oldCanvas, projectId: 'p2-project', episodeId: oldEpisode, storageRootRef: root, revisionScope: 'project',
      epoch: 1, revision: 0, nodes: [{ id: 'node', data: { relativePath: 'media/a.mp4', custom: '完整保留',
        taskReceipt: { projectId: oldCanvas, taskId: '旧任务' } } }], edges: [], groups: [] }], previews: [], bindings: [],
  } as unknown as ProjectModelTransferAggregate;
  const target = structuredClone(original);
  target.episodes[0].id = 'e2-new'; target.episodes[0].canvasId = 'c2-new';
  target.episodeContents[0].episodeId = 'e2-new'; target.canvases[0].id = 'c2-new'; target.canvases[0].episodeId = 'e2-new';
  const editors: VideoEditorProjectRecord[] = [{ id: `${oldCanvas}::node`, projectId: oldCanvas, nodeId: 'node', schemaVersion: 1,
    name: '剪辑', tracks: [{ id: 'track', kind: 'video', name: '轨道', clips: [{ id: 'clip', kind: 'video', fileName: 'a.mp4',
      relativePath: 'media/a.mp4', timelineStart: 0, sourceIn: 0, sourceOut: 1 }] }], createdAt: 1, updatedAt: 2 }];
  return { original, target, episodeIds: [{ from: oldEpisode, to: 'e2-new' }], canvasIds: [{ from: oldCanvas, to: 'c2-new' }],
    files: [{ rootRef: root, from: 'media/a.mp4', to: 'imports/op/a.mp4' }], editors };
}

describe('原生恢复点原文重映射', () => {
  it('只改身份、故事图和受核验的素材路径，保留其他字段及旧任务回执', () => {
    const input = fixture(), before = structuredClone(input.original);
    const result = materializeNativeRawRecovery(input);
    expect(result.aggregate.project.lastOpenedCanvasId).toBe('c2-new');
    expect(result.aggregate.episodes[0]).toMatchObject({ id: 'e2-new', canvasId: 'c2-new', name: '一' });
    expect(result.aggregate.content.storyGraph?.nodes[0].episodeIds).toEqual(['e2-new']);
    expect(result.aggregate.content.storyGraph?.nodes[0].evidence[0].episodeId).toBe('e2-new');
    expect(result.aggregate.canvases[0].nodes[0]).toMatchObject({ data: { relativePath: 'imports/op/a.mp4', custom: '完整保留',
      taskReceipt: { projectId: 'c2-old', taskId: '旧任务' } } });
    expect(result.editors[0]).toMatchObject({ id: 'c2-new::node', projectId: 'c2-new' });
    expect(result.editors[0].tracks[0].clips[0].relativePath).toBe('imports/op/a.mp4');
    expect(input.original).toEqual(before);
  });
  it('只重写明确媒体字段中精确匹配的受验项目相对路径，不改提示词或远端 URL', () => {
    const input = fixture();
    const data = (input.original.canvases[0].nodes as Array<{ data: Record<string, unknown> }>)[0].data;
    Object.assign(data, { videoUrl: 'media/a.mp4', imageUrl: 'media/a.mp4', audioUrl: 'media/a.mp4',
      output: 'media/a.mp4', prompt: '请参考 media/a.mp4 制作画面', unrelatedUrl: 'https://example.invalid/image/b.png?version=old' });
    const restored = materializeNativeRawRecovery(input);
    expect(restored.aggregate.canvases[0].nodes[0]).toMatchObject({ data: {
      videoUrl: 'imports/op/a.mp4', imageUrl: 'imports/op/a.mp4', audioUrl: 'imports/op/a.mp4', output: 'imports/op/a.mp4',
      prompt: '请参考 media/a.mp4 制作画面', unrelatedUrl: 'https://example.invalid/image/b.png?version=old',
    } });
    data.assetId = 'local-index';
    expect(() => materializeNativeRawRecovery(input)).toThrow('索引身份');
    delete data.relativePath; delete data.imageUrl; delete data.audioUrl; delete data.output;
    expect(() => materializeNativeRawRecovery(input)).toThrow('索引身份');
  });

  it('未知引用、绝对路径、重复目标与素材映射缺失均失败关闭', () => {
    const input = fixture();
    (input.original.canvases[0].nodes as Array<{ data: Record<string, unknown> }>)[0].data.customReference = 'e2-old';
    expect(() => materializeNativeRawRecovery(input)).toThrow('未知字段');
    delete (input.original.canvases[0].nodes as Array<{ data: Record<string, unknown> }>)[0].data.customReference;
    (input.original.canvases[0].nodes as Array<{ data: Record<string, unknown> }>)[0].data.filePath = 'C:\\data\\media\\a.mp4';
    expect(() => materializeNativeRawRecovery(input)).toThrow('绝对路径');
    delete (input.original.canvases[0].nodes as Array<{ data: Record<string, unknown> }>)[0].data.filePath;
    (input.original.canvases[0].nodes as Array<{ data: Record<string, unknown> }>)[0].data.imageUrl = 'asset://localhost/C%3A%2Fdata%2Fmedia%2Fa.mp4?token=hidden';
    expect(() => materializeNativeRawRecovery(input)).toThrow('绝对路径');
    delete (input.original.canvases[0].nodes as Array<{ data: Record<string, unknown> }>)[0].data.imageUrl;
    expect(() => materializeNativeRawRecovery({ ...input, files: [] })).toThrow('素材缺少');
    expect(() => materializeNativeRawRecovery({ ...input, canvasIds: [] })).toThrow('身份映射');
  });
  it('新身份必须同时绑定原文件；仅metadata条目不冒充正文引用，旧回执不重写', () => {
    const input = fixture(), id = 'na2-00000000-0000-4000-8000-000000000001';
    const data = (input.original.canvases[0].nodes as Array<{ data: Record<string, unknown> }>)[0].data;
    data.assetId = 'old-asset'; data.taskReceipt = { assetId: 'old-asset', taskId: '原回执' };
    const mappings = [{ from: 'old-asset', to: id, rootRef: 'r2-root', fromPath: 'media/a.mp4', toPath: 'imports/op/a.mp4' },
      { from: 'catalog-only', to: 'na2-00000000-0000-4000-8000-000000000002', rootRef: 'r2-root', fromPath: 'media/a.mp4', toPath: 'imports/op/a.mp4' }];
    const used = referencedNativeRecoveryAssets(input.original, input.editors, mappings);
    expect(used).toEqual([mappings[0]]);
    const restored = materializeNativeRawRecovery({ ...input, assets: used, knownAssets: mappings });
    expect(restored.aggregate.canvases[0].nodes[0]).toMatchObject({ data: { assetId: id, relativePath: 'imports/op/a.mp4',
      taskReceipt: { assetId: 'old-asset', taskId: '原回执' } } });
    data.customReference = 'catalog-only';
    expect(() => materializeNativeRawRecovery({ ...input, assets: used, knownAssets: mappings })).toThrow('未知字段');
    delete data.customReference;
    expect(() => materializeNativeRawRecovery({ ...input, assets: [{ ...mappings[0], fromPath: 'other.mp4' }] })).toThrow('映射');
  });
});
