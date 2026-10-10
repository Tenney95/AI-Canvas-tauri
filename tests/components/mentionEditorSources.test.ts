import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import type { DramaAssetBase, DramaAssetLibrary } from '../../src/types/dramaAssets';
import {
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
