import { describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import { getGroupChildImageKey } from '../../src/utils/groupChildImageKey';

function node(id: string, parentId?: string, imageUrl?: string, thumbnailUrl?: string): Node<BaseNodeData> {
  return { id, parentId, position: { x: 0, y: 0 }, data: { label: id, type: 'ai-image', imageUrl, thumbnailUrl } };
}

describe('分组封面共享索引', () => {
  it('只收集直接子节点，按节点顺序保留缩略图优先、空值回退与重复图片', () => {
    const nodes = [node('a', 'g', 'full-a', 'thumb-a'), node('b', 'other', 'other'),
      node('c', 'g', 'full-c', ''), node('d', 'g'), node('e', 'g', 'full-c'),
      node('f', 'nested', 'grandchild'), node('outside', undefined, 'outside')];
    expect(getGroupChildImageKey(nodes, 'g')).toBe('thumb-a|full-c|full-c');
    expect(getGroupChildImageKey(nodes, 'missing')).toBe('');
    expect(getGroupChildImageKey([], 'g')).toBe('');
  });

  it('多个分组及无关状态更新复用同一轮扫描', () => {
    const nodes = [node('a', 'g1', 'one'), node('b', 'g2', 'two')];
    const iterate = vi.spyOn(nodes, Symbol.iterator);
    for (let i = 0; i < 40; i++) {
      expect(getGroupChildImageKey(nodes, 'g1')).toBe('one');
      expect(getGroupChildImageKey(nodes, 'g2')).toBe('two');
    }
    expect(iterate).toHaveBeenCalledOnce();
  });

  it('节点数组变化后更新图片、归组与删除，切换项目不保留旧封面', () => {
    const original = [node('a', 'g1', 'one'), node('b', 'g2', 'two')];
    expect(getGroupChildImageKey(original, 'g1')).toBe('one');
    const updated = [node('a', 'g2', 'new', 'new-thumb')];
    expect(getGroupChildImageKey(updated, 'g1')).toBe('');
    expect(getGroupChildImageKey(updated, 'g2')).toBe('new-thumb');
    expect(getGroupChildImageKey([node('new-project', 'g1', 'project-image')], 'g1')).toBe('project-image');
    expect(getGroupChildImageKey(original, 'g2')).toBe('two');
  });

  it('只读取完整 Store 节点，不修改节点数据或生成持久化缓存', () => {
    const source = node('a', 'g', 'full', 'thumb');
    Object.freeze(source.data); Object.freeze(source);
    const nodes = Object.freeze([source]);
    expect(getGroupChildImageKey(nodes, 'g')).toBe('thumb');
    expect(source.data).toEqual({ label: 'a', type: 'ai-image', imageUrl: 'full', thumbnailUrl: 'thumb' });
  });
});
