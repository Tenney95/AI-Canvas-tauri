/**
 * mentionEditorSources — 回归测试：mentionEditorSources。
 */
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import { runningHubInputNodes } from '../../src/services/runninghubWorkflowService';
import type { DramaAsset, DramaAssetBase, DramaAssetLibrary, DramaCharacter } from '../../src/types/dramaAssets';
import {
  matchesMentionQuery,
  resolveCanvasMentionNodes,
  resolveDramaMentionItems,
  resolveGlobalAssetPickerItems,
  resolveWorkflowMentionNodes,
  filterWorkflowMentions,
  workflowMentionFilterChips,
} from '../../src/components/nodes/shared/mentionEditorSources';

it('RH 的同一远端节点多个字段作为不同 @ 目标，普通参数不进入候选', () => {
  const inputs = runningHubInputNodes({ version: 1, kind: 'workflow', remoteId: '123', connectionId: 'runninghub', parameters: [
    { nodeId: '9', fieldName: 'first', label: '首帧', type: 'string', defaultValue: '', source: 'image' },
    { nodeId: '9', fieldName: 'last', label: '尾帧', type: 'string', defaultValue: '', source: 'image' },
    { nodeId: '9', fieldName: 'model', label: '模型', type: 'string', defaultValue: 'model', source: 'value', sourceExplicit: true },
  ] });
  expect(resolveWorkflowMentionNodes('rh', inputs).map((item) => item._ioNodeId)).toEqual(['9::first', '9::last']);
});

function node(
  id: string,
  type: BaseNodeData['type'],
  data: Partial<BaseNodeData> = {},
  parentId?: string,
): Node<BaseNodeData> {
  return {
    id,
    type,
    parentId,
    position: { x: 0, y: 0 },
    data: { label: id, type, ...data },
  };
}

describe('mentionEditorSources', () => {
  const globalPickerAssets = (): DramaAsset[] => {
    const base: DramaAssetBase = {
      id: 'hero', key: '同名', name: '同名', summary: '可复用创作素材', visualNotes: '银色纹理',
      importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1,
    };
    return [
      { ...base, kind: 'character', identity: '侦探', aliases: ['夜行者'], imageNodeId: 'project-node' },
      { ...base, id: 'scene', kind: 'scene', placeType: '车站', atmosphere: '雨夜' },
      { ...base, id: 'prop', kind: 'prop', ownerName: '守卫', significance: '开门钥匙' },
    ];
  };

  it('全局弹框三类筛选与空搜索保留顺序，同名项目资产不混入且只添加一层作用域', () => {
    const assets = globalPickerAssets();
    const project: DramaAssetLibrary = {
      version: 2, characters: [{ ...(assets[0] as DramaCharacter), name: '同名项目人物' }], scenes: [], props: [],
    };
    expect(resolveDramaMentionItems(project, '', 'ai-image', assets).map((item) => item.id))
      .toEqual(['hero', 'global/hero', 'global/scene', 'global/prop']);
    expect(resolveGlobalAssetPickerItems(assets, null, '   ').map((item) => item.id))
      .toEqual(['global/hero', 'global/scene', 'global/prop']);
    for (const [kind, id] of [['character', 'hero'], ['scene', 'scene'], ['prop', 'prop']] as const) {
      expect(resolveGlobalAssetPickerItems(assets, kind, '')).toMatchObject([{ id: `global/${id}`, kind }]);
      expect(resolveGlobalAssetPickerItems(assets, kind, '')).toHaveLength(1);
    }
    expect(resolveGlobalAssetPickerItems(assets, 'character', '')[0].imageNodeId).toBeUndefined();
    expect(assets[0].id).toBe('hero');
    expect(assets[0].imageNodeId).toBe('project-node');
  });

  it('全局弹框在原始资产上按简介、外观、别名及领域字段组合搜索', () => {
    const assets = globalPickerAssets();
    expect(resolveGlobalAssetPickerItems(assets, null, '创作素材 银色纹理')).toHaveLength(3);
    expect(resolveGlobalAssetPickerItems(assets, 'character', '夜行者 侦探')[0].id).toBe('global/hero');
    expect(resolveGlobalAssetPickerItems(assets, 'scene', '车站 雨夜')[0].id).toBe('global/scene');
    expect(resolveGlobalAssetPickerItems(assets, 'prop', '守卫 开门钥匙')[0].id).toBe('global/prop');
    expect(resolveGlobalAssetPickerItems(assets, null, 'ＨＥＲＯ')[0].id).toBe('global/hero');
    expect(resolveGlobalAssetPickerItems(assets, 'scene', '夜行者')).toEqual([]);
  });

  it('全局弹框沿用音频引用限制，只返回有可用声音的人物', () => {
    const assets = globalPickerAssets();
    const character = assets[0] as DramaCharacter;
    const voiced: DramaCharacter = { ...character, id: 'voiced', voiceClips: [{
      id: 'voice-1', kind: 'timbre', audioUrl: 'asset://voice.wav', transcript: '', createdAt: 1, updatedAt: 1,
    }] };
    const candidates = [...assets, voiced];
    expect(resolveGlobalAssetPickerItems(candidates, null, '', 'ai-audio'))
      .toMatchObject([{ id: 'global/voiced', voice: { id: 'voice-1' } }]);
    expect(resolveGlobalAssetPickerItems(candidates, null, '', 'ai-audio')).toHaveLength(1);
    expect(resolveGlobalAssetPickerItems(candidates, 'scene', '', 'ai-audio')).toEqual([]);
    expect(resolveGlobalAssetPickerItems(candidates, 'prop', '', 'ai-audio')).toEqual([]);
  });

  it('ComfyUI 输入按图片、视频、音乐和文本筛选，全部保留原有顺序', () => {
    const items = resolveWorkflowMentionNodes('workflow', [
      { nodeId: 'text', title: '角色提示词', type: 'prompt' },
      { nodeId: 'image', title: '参考图片', type: 'image' },
      { nodeId: 'audio-a', title: '角色声音', type: 'audio' },
      { nodeId: 'video', title: '动作视频', type: 'video' },
      { nodeId: 'audio-b', title: '背景音乐', type: 'audio' },
    ]);
    expect(workflowMentionFilterChips(items)).toEqual([
      { id: 'all', label: '全部', count: 5 }, { id: 'image', label: '图片', count: 1 },
      { id: 'video', label: '视频', count: 1 }, { id: 'audio', label: '音乐', count: 2 },
      { id: 'prompt', label: '文本', count: 1 },
    ]);
    expect(filterWorkflowMentions(items, 'all')).toBe(items);
    expect(filterWorkflowMentions(items, 'audio').map((item) => item._ioNodeId)).toEqual(['audio-a', 'audio-b']);
    expect(filterWorkflowMentions(items, 'prompt')[0]._ioNodeId).toBe('text');
    const searched = items.filter((item) => matchesMentionQuery('角色', [item.label, item._ioNodeId]));
    const displayed = filterWorkflowMentions(searched, 'audio');
    // MentionEditor 的卡片与 Enter 首项都消费 displayed，搜索后不再选择隐藏的文本输入。
    expect(displayed.map((item) => item._ioNodeId)).toEqual(['audio-a']);
    expect(displayed.find(() => true)?._ioNodeId).toBe('audio-a');
    expect(workflowMentionFilterChips(searched)[0].count).toBe(2);
  });
  it('按节点编号、实际 ID 和文件名分词匹配，兼容全角与大小写', () => {
    const values = ['node-uuid-39', '角色参考', 39, '#39', '角色形象.PNG'];
    expect(matchesMentionQuery('  ＃３９  形象.png  ', values)).toBe(true);
    expect(matchesMentionQuery('UUID 参考', values)).toBe(true);
    expect(matchesMentionQuery('39 不存在', values)).toBe(false);
    expect(matchesMentionQuery('   ', [null, undefined])).toBe(true);
    expect(matchesMentionQuery('39', [null, undefined])).toBe(false);
  });

  it('全局搜索可找到未连线节点，普通候选仍只含连线与自身', () => {
    const nodes = [
      node('connected', 'ai-image', { imageUrl: 'asset://connected.png' }),
      node('unconnected', 'ai-image', { imageUrl: 'asset://other.png' }),
      node('hidden', 'ai-image', { imageUrl: 'asset://hidden.png', hiddenByCharacterLibrary: true }),
      { ...node('group', 'comment'), type: 'group' },
      node('note', 'canvas-note'),
      node('empty', 'ai-text'),
      node('target', 'ai-video', { videoUrl: 'asset://target.mp4' }),
    ];
    const edges: Edge[] = [{ id: 'connected-target', source: 'connected', target: 'target' }];

    expect(resolveCanvasMentionNodes('target', nodes, edges).map((item) => item.id))
      .toEqual(['target', 'connected']);
    expect(resolveCanvasMentionNodes('target', nodes, edges, 'project').map((item) => item.id))
      .toEqual(['target', 'connected', 'unconnected', 'empty']);
    expect(resolveCanvasMentionNodes(undefined, nodes, edges)).toEqual([]);
    expect(resolveCanvasMentionNodes(undefined, nodes, edges, 'project').map((item) => item.id))
      .toEqual(['connected', 'unconnected', 'empty', 'target']);
  });

  it('节点搜索包含真实文件名，但不匹配或展示完整本地路径', () => {
    const candidates = resolveCanvasMentionNodes('target', [
      node('image-node', 'ai-image', {
        label: '画布展示标题', displayId: 39, fileName: '上传参考.PNG',
        filePath: 'C:\\private-directory\\archive\\实际文件.jpg', imageUrl: 'asset://image.png',
      }),
      node('target', 'ai-image'),
    ], [], 'project');
    expect(candidates[0].label).toBe('画布展示标题');
    expect(matchesMentionQuery('#39 上传参考', candidates[0].searchValues ?? [])).toBe(true);
    expect(matchesMentionQuery('实际文件.JPG', candidates[0].searchValues ?? [])).toBe(true);
    expect(matchesMentionQuery('private-directory', candidates[0].searchValues ?? [])).toBe(false);
  });

  it('视频候选保留真实视频源，旧视频地址不作为图片封面，自引用保持一致', () => {
    const videoUrl = 'https://media.test/clip.mp4?token=preview';
    const nodes = [
      node('video', 'source-video', { videoUrl, thumbnailUrl: videoUrl, filePath: 'C:/media/clip.mp4' }),
      node('covered', 'ai-video', { videoUrl: 'asset://covered.mp4', thumbnailUrl: 'asset://cover.png' }),
      node('pending', 'ai-video'),
    ];
    const items = resolveCanvasMentionNodes('video', nodes, [], 'project');
    expect(items.find((item) => item.id === 'video')).toMatchObject({
      isSelf: true, outputType: 'video', videoUrl, filePath: 'C:/media/clip.mp4', thumbnailUrl: undefined,
    });
    expect(items.find((item) => item.id === 'covered')).toMatchObject({
      outputType: 'video', videoUrl: 'asset://covered.mp4', thumbnailUrl: 'asset://cover.png',
    });
    expect(items.find((item) => item.id === 'pending')).toMatchObject({ outputType: 'video', videoUrl: undefined });
  });

  it('全局角色保留独立身份，可按名称、别名与 ID 搜索，默认不混入', () => {
    const character: DramaCharacter = {
      id: 'hero-id', key: 'hero', name: '水行女侠', aliases: ['银发女性'], kind: 'character', identity: '',
      summary: '', visualNotes: '', importance: 'main', confirmed: true,
      createdAt: 0, updatedAt: 0, source: 'manual', imageUrl: 'asset://global.png',
    };
    const library: DramaAssetLibrary = {
      version: 2, characters: [{ ...character, name: '项目角色' }], scenes: [], props: [],
    };

    expect(resolveDramaMentionItems(library, '').map((item) => item.id)).toEqual(['hero-id']);
    expect(resolveDramaMentionItems(library, '', 'ai-image', [character]).map((item) => item.id))
      .toEqual(['hero-id', 'global/hero-id']);
    expect(resolveDramaMentionItems(library, '水行 银发', 'ai-image', [character]))
      .toMatchObject([{ id: 'global/hero-id', name: '水行女侠' }]);
    expect(resolveDramaMentionItems(library, 'GLOBAL/hero-id', 'ai-image', [character]))
      .toMatchObject([{ id: 'global/hero-id' }]);
    expect(resolveDramaMentionItems(library, '', 'ai-audio', [character])).toEqual([]);

    const voicedCharacter: DramaCharacter = { ...character, voiceClips: [{
      id: 'voice-id', kind: 'timbre', audioUrl: 'asset://voice.wav', transcript: '', createdAt: 0, updatedAt: 0,
    }] };
    expect(resolveDramaMentionItems(library, '水行', 'ai-audio', [voicedCharacter]))
      .toMatchObject([{ id: 'global/hero-id', voice: { id: 'voice-id', url: 'asset://voice.wav' } }]);
  });

  it('完整保留 9 个角色、10 个场景、9 个道具，空搜索和同名搜索均不截断候选', () => {
    const base: Omit<DramaAssetBase, 'id' | 'key' | 'name'> = {
      summary: '', visualNotes: '', importance: 'supporting', confirmed: true,
      createdAt: 0, updatedAt: 0, source: 'manual',
    };
    const library: DramaAssetLibrary = {
      version: 2,
      characters: Array.from({ length: 9 }, (_, index) => ({
        ...base, id: `character-${index}`, key: `character-${index}`, name: `资产角色${index}`,
        kind: 'character', identity: '',
      })),
      scenes: Array.from({ length: 10 }, (_, index) => ({
        ...base, id: `scene-${index}`, key: `scene-${index}`, name: `资产场景${index}`, kind: 'scene',
      })),
      props: Array.from({ length: 9 }, (_, index) => ({
        ...base, id: `prop-${index}`, key: `prop-${index}`, name: `资产道具${index}`, kind: 'prop',
      })),
    };

    for (const query of ['', '资产']) {
      const candidates = resolveDramaMentionItems(library, query, 'ai-image');
      expect(candidates).toHaveLength(28);
      expect(candidates.filter((item) => item.kind === 'character')).toHaveLength(9);
      expect(candidates.filter((item) => item.kind === 'scene')).toHaveLength(10);
      expect(candidates.filter((item) => item.kind === 'prop').map((item) => item.id))
        .toEqual(library.props.map((item) => item.id));
    }
    expect(resolveDramaMentionItems(library, '道具8')).toMatchObject([{ id: 'prop-8' }]);
    expect(resolveDramaMentionItems(library, '不存在')).toEqual([]);
  });

  it('expands connected groups and storyboard cells into mention candidates', () => {
    const nodes = [
      { ...node('group', 'comment'), type: 'group' },
      node('storyboard', 'ai-storyboard', {
        imageUrl: 'asset://storyboard.png',
        storyboardCols: 2,
        storyboardRows: 1,
        storyboardExtracted: [false, true],
      }, 'group'),
      node('target', 'ai-text'),
    ];
    const edges: Edge[] = [{ id: 'edge-group-target', source: 'group', target: 'target' }];

    const candidates = resolveCanvasMentionNodes('target', nodes, edges);

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'storyboard',
      'storyboard/cell/0',
    ]);
    expect(candidates[1]).toMatchObject({
      type: 'ai-image',
      label: 'storyboard · 第1行1列',
      thumbnailUrl: 'asset://storyboard.png',
    });
  });

  it('places a node with its own output before connected candidates', () => {
    const nodes = [
      node('source', 'ai-text', { output: 'source output' }),
      node('target', 'ai-image', { imageUrl: 'asset://target.png' }),
    ];
    const edges: Edge[] = [{ id: 'edge-source-target', source: 'source', target: 'target' }];

    const candidates = resolveCanvasMentionNodes('target', nodes, edges);

    expect(candidates.map((candidate) => candidate.id)).toEqual(['target', 'source']);
    expect(candidates[0]).toMatchObject({ isSelf: true, outputType: 'image' });
  });

  it('按稳定镜头 ID 展开分镜表，可按当前镜号和对白搜索，重排不改变引用身份', () => {
    const sheet = node('sheet', 'ai-shotlist', { label: '第一场', displayId: 47, shotlistRows: [
      { id: 'row-a', shotNo: '1', content: '走入房间', dialogue: '你回来了。' },
      { id: 'row/b', shotNo: '2', content: '关上门', dialogue: '先别开灯。' },
    ] });
    const target = node('target', 'ai-video');
    const edges = [{ id: 'e', source: 'sheet', target: 'target' }];
    const candidates = resolveCanvasMentionNodes('target', [sheet, target], edges);
    expect(candidates.map((item) => item.id)).toEqual(['sheet', 'sheet/shot/row-a', 'sheet/shot/row%2Fb']);
    expect(candidates[2]).toMatchObject({ label: '镜2 · 第一场', outputType: 'text', displayId: undefined, hasOutput: true });
    expect(matchesMentionQuery('#47 第2镜 先别开灯', candidates[2].searchValues ?? [])).toBe(true);
    const reordered = { ...sheet, data: { ...sheet.data, shotlistRows: [
      { ...sheet.data.shotlistRows![1], shotNo: '1' }, { ...sheet.data.shotlistRows![0], shotNo: '2' },
    ] } };
    expect(resolveCanvasMentionNodes('target', [reordered, target], edges)[2])
      .toMatchObject({ id: 'sheet/shot/row-a', label: '镜2 · 第一场' });
  });

  it('maps workflow IO nodes only when a workflow is selected', () => {
    const ioNodes = [{ nodeId: '12', title: '提示词', type: 'prompt' as const }];

    expect(resolveWorkflowMentionNodes(undefined, ioNodes)).toEqual([]);
    expect(resolveWorkflowMentionNodes('workflow-a', ioNodes)).toEqual([{
      id: 'wf:12',
      label: '提示词',
      _ioNodeId: '12',
      _ioType: 'prompt',
    }]);
  });
});
