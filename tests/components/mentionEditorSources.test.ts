import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import type { DramaAssetBase, DramaAssetLibrary, DramaCharacter } from '../../src/types/dramaAssets';
import {
  matchesMentionQuery,
  resolveCanvasMentionNodes,
  resolveDramaMentionItems,
  resolveWorkflowMentionNodes,
} from '../../src/components/nodes/shared/mentionEditorSources';

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
