import { describe, expect, it } from 'vitest';
import {
  readMentionPreviewSource,
  resolveDramaMentionPreview,
} from '../../src/components/nodes/shared/mentionEditorPreview';
import {
  buildDramaActionMentionId,
  buildDramaVoiceMentionId,
  emptyDramaAssetLibrary,
  type DramaCharacter,
  type DramaProp,
  type DramaScene,
} from '../../src/types/dramaAssets';

function character(overrides: Partial<DramaCharacter> = {}): DramaCharacter {
  return {
    id: 'same-id', kind: 'character', name: '项目人物', key: 'person', summary: '人物简介', visualNotes: '',
    importance: 'main', confirmed: true, createdAt: 0, updatedAt: 0, source: 'manual', identity: '创作者',
    imageUrl: 'primary.png', primaryReferenceImageId: 'front',
    referenceImages: [
      { id: 'front', kind: 'primary', imageUrl: 'front.png', prompt: '', createdAt: 0, updatedAt: 0 },
      { id: 'side', kind: 'turnaround', imageUrl: 'side.png', prompt: '', createdAt: 0, updatedAt: 0 },
    ],
    ...overrides,
  };
}

function library(asset = character()) {
  return { ...emptyDramaAssetLibrary(), characters: [asset] };
}

describe('胶囊预览来源', () => {
  const element = (attributes: Record<string, string>) => ({ getAttribute: (name: string) => attributes[name] ?? null });

  it('区分节点、资产库和文件引用，保留精确身份', () => {
    expect(readMentionPreviewSource(element({ 'data-ref-id': 'node/cell/1', 'data-ref-label': '单格' })))
      .toEqual({ kind: 'node', id: 'node/cell/1', label: '单格' });
    expect(readMentionPreviewSource(element({ 'data-drama-id': 'global/same-id#side', 'data-drama-label': '人物' })))
      .toEqual({ kind: 'drama', id: 'global/same-id#side', label: '人物' });
    expect(readMentionPreviewSource(element({ 'data-asset-path': 'C:\\pictures\\图片.png' })))
      .toEqual({ kind: 'asset', id: 'C:\\pictures\\图片.png', label: '图片.png' });
    expect(readMentionPreviewSource(element({ 'data-asset-path': '/assets/a.png' }))?.label).toBe('a.png');
    expect(readMentionPreviewSource(element({ 'data-wf-id': 'workflow' }))).toBeNull();
    expect(readMentionPreviewSource(element({ 'data-ref-id': '' }))).toBeNull();
  });
});

describe('资产库胶囊预览', () => {
  it('相同 ID 的项目与全局角色隔离，全局不读取项目来源节点', () => {
    const global = character({ name: '全局人物', referenceImages: [{ ...character().referenceImages![0], sourceNodeId: 'collision', imageUrl: 'global.png' }] });
    const nodes = [{ id: 'collision', data: { imageUrl: 'project-node.png' } }];
    expect(resolveDramaMentionPreview(library(), [global], nodes, 'same-id', '旧名称'))
      .toMatchObject({ label: '项目人物', thumbnailUrl: 'front.png', description: '创作资产库 · 人物参考图' });
    expect(resolveDramaMentionPreview(library(), [global], nodes, 'global/same-id', '旧名称'))
      .toMatchObject({ label: '全局人物', thumbnailUrl: 'global.png', description: '全局角色库 · 人物参考图' });
    expect(resolveDramaMentionPreview(library(), [], nodes, 'global/same-id', '全局人物'))
      .toMatchObject({ label: '全局人物', missing: true, thumbnailUrl: undefined });
  });

  it('显示指定图而非主图，指定图删除或无产物时不回落', () => {
    expect(resolveDramaMentionPreview(library(), [], [], 'same-id#side', '人物'))
      .toMatchObject({ thumbnailUrl: 'side.png', missing: false, description: '创作资产库 · 指定参考图' });
    expect(resolveDramaMentionPreview(library(), [], [], 'same-id#deleted', '人物'))
      .toMatchObject({ thumbnailUrl: undefined, missing: true, description: '创作资产库 · 参考图引用已失效' });
    const asset = character({ referenceImages: [{ ...character().referenceImages![1], imageUrl: undefined }] });
    expect(resolveDramaMentionPreview(library(asset), [], [], 'same-id#side', '人物'))
      .toMatchObject({ thumbnailUrl: undefined, missing: true });
    const bound = character({ referenceImages: [{ ...character().referenceImages![1], sourceNodeId: 'side-node' }] });
    expect(resolveDramaMentionPreview(library(bound), [], [{ id: 'side-node', data: { imageUrl: 'latest-side.png' } }], 'same-id#side', '人物').thumbnailUrl)
      .toBe('latest-side.png');
  });

  it('场景与道具使用绑定图，图片缺失时显示当前简介', () => {
    const common = { id: 'entry', key: 'entry', name: '库内条目', summary: '当前简介', visualNotes: '', importance: 'supporting', confirmed: true, createdAt: 0, updatedAt: 0, source: 'manual' } as const;
    const scene: DramaScene = { ...common, kind: 'scene', imageNodeId: 'scene-node' };
    const prop: DramaProp = { ...common, id: 'prop', kind: 'prop', imageUrl: 'prop.png' };
    const assets = { ...emptyDramaAssetLibrary(), scenes: [scene], props: [prop] };
    expect(resolveDramaMentionPreview(assets, [], [{ id: 'scene-node', data: { imageUrl: 'scene.png' } }], 'entry', '旧名'))
      .toMatchObject({ label: '库内条目', thumbnailUrl: 'scene.png', description: '创作资产库 · 场景参考图' });
    expect(resolveDramaMentionPreview(assets, [], [], 'prop', '旧名'))
      .toMatchObject({ thumbnailUrl: 'prop.png', description: '创作资产库 · 道具参考图' });
    const noImage = resolveDramaMentionPreview(assets, [], [], 'entry', '旧名');
    expect(noImage).toMatchObject({ missing: false, thumbnailUrl: undefined, description: '创作资产库 · 场景简介（暂无图片）' });
    expect(noImage.text).toContain('当前简介');
  });

  it('全部参考图保留顺序与绑定更新，不生成拼图或混入主视觉', () => {
    const asset = character({ referenceImages: [{ ...character().referenceImages![0], sourceNodeId: 'front-node' }, character().referenceImages![1]] });
    expect(resolveDramaMentionPreview(library(asset), [], [{ id: 'front-node', data: { imageUrl: 'latest-front.png' } }], 'same-id#all', '人物'))
      .toMatchObject({ thumbnailUrl: 'latest-front.png', thumbnailUrls: ['latest-front.png', 'side.png'], missing: false, description: '创作资产库 · 全部参考图（2 张）' });
    expect(resolveDramaMentionPreview(library(character({ referenceImages: [] })), [], [], 'same-id#all', '人物'))
      .toMatchObject({ thumbnailUrl: undefined, thumbnailUrls: [], missing: true });
  });

  it('动作图、GIF 和视频按确切素材预览，损坏或删除时不回主图', () => {
    const asset = character({ actions: [{
      id: 'run', category: 'running', name: '奔跑', prompt: '向前跑', createdAt: 0, updatedAt: 0,
      media: [
        { id: 'image', name: '姿态', kind: 'image', url: 'pose.png', createdAt: 0, updatedAt: 0 },
        { id: 'gif', name: '循环', kind: 'gif', url: 'run.gif', createdAt: 0, updatedAt: 0 },
        { id: 'video', name: '演示', kind: 'video', url: 'run.mp4', createdAt: 0, updatedAt: 0 },
      ],
    }] });
    const preview = (mediaId: string) => resolveDramaMentionPreview(library(asset), [], [], buildDramaActionMentionId(asset.id, 'run', mediaId), '奔跑');
    expect(preview('image')).toMatchObject({ outputType: 'image', thumbnailUrl: 'pose.png', missing: false });
    expect(preview('gif')).toMatchObject({ outputType: 'image', thumbnailUrl: 'run.gif', description: '创作资产库 · 动作 GIF' });
    expect(preview('video')).toMatchObject({ outputType: 'video', thumbnailUrl: undefined, text: '', missing: false });
    expect(preview('deleted')).toMatchObject({ thumbnailUrl: undefined, missing: true, description: '创作资产库 · 动作素材引用已失效' });
    expect(resolveDramaMentionPreview(library(asset), [], [], 'same-id#action/broken', '损坏动作'))
      .toMatchObject({ label: '损坏动作', thumbnailUrl: undefined, missing: true });
  });

  it('声音显示精确片段转录，删除或损坏不取主音色或主图', () => {
    const asset = character({ primaryVoiceClipId: 'main', voiceClips: [
      { id: 'main', kind: 'timbre', audioUrl: 'main.wav', transcript: '主音色', createdAt: 0, updatedAt: 0 },
      { id: 'line', kind: 'line', label: '台词样本', audioUrl: 'line.wav', transcript: '选中的台词', createdAt: 0, updatedAt: 0 },
    ] });
    expect(resolveDramaMentionPreview(library(asset), [], [], buildDramaVoiceMentionId(asset.id, 'line'), '声音'))
      .toMatchObject({ label: '项目人物 · 台词样本', outputType: 'audio', text: '选中的台词', thumbnailUrl: undefined, missing: false });
    for (const id of [buildDramaVoiceMentionId(asset.id, 'deleted'), 'same-id#voice/%']) {
      expect(resolveDramaMentionPreview(library(asset), [], [], id, '声音'))
        .toMatchObject({ outputType: 'audio', text: '', thumbnailUrl: undefined, missing: true, description: '创作资产库 · 声音引用已失效' });
    }
  });

  it('无图人物保留简介，删除资产显示可辨认的失效状态', () => {
    const asset = character({ imageUrl: undefined, referenceImages: [], summary: '新的人物简介' });
    const preview = resolveDramaMentionPreview(library(asset), [], [], asset.id, '旧名');
    expect(preview).toMatchObject({ label: '项目人物', thumbnailUrl: undefined, missing: false, description: '创作资产库 · 人物简介（暂无图片）' });
    expect(preview.text).toContain('新的人物简介');
    expect(resolveDramaMentionPreview(emptyDramaAssetLibrary(), [], [], asset.id, '已删除人物'))
      .toMatchObject({ label: '已删除人物', thumbnailUrl: undefined, missing: true, description: '创作资产库 · 引用资产已不存在' });
  });
});
