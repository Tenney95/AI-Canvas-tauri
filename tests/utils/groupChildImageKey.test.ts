/**
 * groupChildImageKey — 回归测试：分组封面共享索引。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import { getGroupChildImageKey, type GroupCoverItem } from '../../src/utils/groupChildImageKey';

function node(id: string, parentId?: string, imageUrl?: string, thumbnailUrl?: string): Node<BaseNodeData> {
  return { id, parentId, position: { x: 0, y: 0 }, data: { label: id, type: 'ai-image', imageUrl, thumbnailUrl } };
}

function covers(nodes: readonly Node<BaseNodeData>[], groupId: string): GroupCoverItem[] {
  const key = getGroupChildImageKey(nodes, groupId);
  return key ? JSON.parse(key) : [];
}

describe('分组封面共享索引', () => {
  it('只收集直接子节点，按节点顺序保留缩略图优先、空值回退与重复图片', () => {
    const nodes = [node('a', 'g', 'full-a', 'thumb-a'), node('b', 'other', 'other'),
      node('c', 'g', 'full-c', ''), node('d', 'g'), node('e', 'g', 'full-c'),
      node('f', 'nested', 'grandchild'), node('outside', undefined, 'outside')];
    expect(covers(nodes, 'g')).toEqual([
      { id: 'a', kind: 'image', url: 'thumb-a' },
      { id: 'c', kind: 'image', url: 'full-c' },
      { id: 'e', kind: 'image', url: 'full-c' },
    ]);
    expect(getGroupChildImageKey(nodes, 'missing')).toBe('');
    expect(getGroupChildImageKey([], 'g')).toBe('');
  });

  it('视频始终使用图标候选，不把缩略图或视频地址当成图片，无缩略图也保留', () => {
    const video = node('video', 'g', 'stale-image', 'video.mp4');
    video.type = 'ai-video';
    video.data.type = 'ai-video';
    video.data.videoUrl = 'video.mp4';
    const sourceVideo = node('source-video', 'g');
    sourceVideo.data.type = 'source-video';
    sourceVideo.data.videoUrl = 'source.mp4';
    expect(covers([node('image', 'g', 'image.png'), video, sourceVideo], 'g')).toEqual([
      { id: 'image', kind: 'image', url: 'image.png' },
      { id: 'video', kind: 'video' },
      { id: 'source-video', kind: 'video' },
    ]);
  });

  it('多个分组及无关状态更新复用同一轮扫描', () => {
    const nodes = [node('a', 'g1', 'one'), node('b', 'g2', 'two')];
    const iterate = vi.spyOn(nodes, Symbol.iterator);
    for (let i = 0; i < 40; i++) {
      expect(covers(nodes, 'g1')).toEqual([{ id: 'a', kind: 'image', url: 'one' }]);
      expect(covers(nodes, 'g2')).toEqual([{ id: 'b', kind: 'image', url: 'two' }]);
    }
    expect(iterate).toHaveBeenCalledOnce();
  });

  it('移动、选中或改名后沿用全部分组的封面字符串', () => {
    const a = node('a', 'g1', 'full', 'thumb');
    const b = node('b', 'g2', 'other');
    const nodes = [a, b];
    const before = [getGroupChildImageKey(nodes, 'g1'), getGroupChildImageKey(nodes, 'g2')];
    const updated = [{ ...a, position: { x: 15, y: 30 }, selected: true },
      { ...b, data: { ...b.data, label: 'new label' } }];
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const after = [getGroupChildImageKey(updated, 'g1'), getGroupChildImageKey(updated, 'g2')];
      expect(stringify).not.toHaveBeenCalled();
      expect(after).toEqual(before);
    } finally {
      stringify.mockRestore();
    }
  });

  it('同一组成员换序或切到同 ID 的另一张画布时更新封面', () => {
    const a = node('a', 'g', 'full-a', 'thumb-a');
    const b = node('b', 'g', 'full-b');
    const nodes = [a, b];
    const original = covers(nodes, 'g');
    expect(covers([b, a], 'g')).toEqual([...original].reverse());
    const nextCanvas = [{ ...b, type: 'source-video' }, node('a', 'g', 'new-full')];
    expect(covers(nextCanvas, 'g')).toEqual([
      { id: 'b', kind: 'video' }, { id: 'a', kind: 'image', url: 'new-full' },
    ]);
    expect(covers(nodes, 'g')).toEqual(original);
  });

  it('节点数组变化后更新图片、归组与删除，切换项目不保留旧封面', () => {
    const original = [node('a', 'g1', 'one'), node('b', 'g2', 'two')];
    expect(covers(original, 'g1')).toEqual([{ id: 'a', kind: 'image', url: 'one' }]);
    const updated = [node('a', 'g2', 'new', 'new-thumb')];
    expect(getGroupChildImageKey(updated, 'g1')).toBe('');
    expect(covers(updated, 'g2')).toEqual([{ id: 'a', kind: 'image', url: 'new-thumb' }]);
    expect(covers([node('new-project', 'g1', 'project-image')], 'g1')).toEqual([
      { id: 'new-project', kind: 'image', url: 'project-image' },
    ]);
    expect(covers(original, 'g2')).toEqual([{ id: 'b', kind: 'image', url: 'two' }]);
  });

  it('只读取完整 Store 节点，不修改节点数据或生成持久化缓存', () => {
    const source = node('a', 'g', 'full', 'thumb');
    Object.freeze(source.data); Object.freeze(source);
    const nodes = Object.freeze([source]);
    expect(covers(nodes, 'g')).toEqual([{ id: 'a', kind: 'image', url: 'thumb' }]);
    expect(source.data).toEqual({ label: 'a', type: 'ai-image', imageUrl: 'full', thumbnailUrl: 'thumb' });
  });
});
