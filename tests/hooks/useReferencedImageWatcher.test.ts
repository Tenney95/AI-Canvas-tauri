import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import {
  collectReferencedImagePaths,
  haveReferencedImageFieldsChanged,
} from '../../src/hooks/useReferencedImageWatcher';

function node(id: string, data: Partial<BaseNodeData> = {}): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-image',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'ai-image', ...data },
  };
}

describe('referenced image watcher projection', () => {
  it('ignores position changes that retain node data', () => {
    const previous = [node('image', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' })];
    const current = [{ ...previous[0], position: { x: 120, y: 80 } }];

    expect(haveReferencedImageFieldsChanged(current, previous)).toBe(false);
  });

  it('ignores unrelated node data changes', () => {
    const previous = [node('image', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' })];
    const current = [{
      ...previous[0],
      data: { ...previous[0].data, label: 'renamed', status: 'loading' as const },
    }];

    expect(haveReferencedImageFieldsChanged(current, previous)).toBe(false);
  });

  it('detects effective main image reference changes', () => {
    const previous = [node('image', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' })];
    const changedPath = [{
      ...previous[0],
      data: { ...previous[0].data, filePath: 'C:/images/b.png' },
    }];
    const hiddenImage = [{
      ...previous[0],
      data: { ...previous[0].data, imageUrl: undefined },
    }];

    expect(haveReferencedImageFieldsChanged(changedPath, previous)).toBe(true);
    expect(haveReferencedImageFieldsChanged(hiddenImage, previous)).toBe(true);
  });

  it('detects storyboard override reference changes', () => {
    const previous = [node('storyboard', {
      type: 'ai-storyboard',
      storyboardOverrides: [{ url: 'asset://a', filePath: 'C:/images/a.png' }],
    })];
    const current = [{
      ...previous[0],
      data: {
        ...previous[0].data,
        storyboardOverrides: [{ url: 'asset://b', filePath: 'C:/images/b.png' }],
      },
    }];

    expect(haveReferencedImageFieldsChanged(current, previous)).toBe(true);
  });

  it('ignores unreferenced node additions but detects referenced additions and removals', () => {
    const textNode = node('text', { type: 'ai-text' });
    const imageNode = node('image', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' });

    expect(haveReferencedImageFieldsChanged([textNode], [])).toBe(false);
    expect(haveReferencedImageFieldsChanged([textNode, imageNode], [textNode])).toBe(true);
    expect(haveReferencedImageFieldsChanged([textNode], [textNode, imageNode])).toBe(true);
  });

  it('ignores node reordering when effective image references stay unchanged', () => {
    const first = node('first', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' });
    const second = node('second', { filePath: 'C:/images/b.png', imageUrl: 'asset://b' });

    expect(haveReferencedImageFieldsChanged([second, first], [first, second])).toBe(false);
  });

  it('collects unique referenced paths in stable order', () => {
    const nodes = [
      node('b', { filePath: 'C:/images/b.png', thumbnailUrl: 'asset://b' }),
      node('storyboard', {
        type: 'ai-storyboard',
        storyboardOverrides: [
          { url: 'asset://a', filePath: 'C:/images/a.png' },
          { url: 'asset://b-copy', filePath: 'C:/images/b.png' },
        ],
      }),
    ];

    expect(collectReferencedImagePaths(nodes)).toEqual([
      'C:/images/a.png',
      'C:/images/b.png',
    ]);
  });
});
