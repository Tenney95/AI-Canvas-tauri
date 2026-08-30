import { describe, expect, it } from 'vitest';
import type { Layer } from '../../src/types/composerTypes';
import {
  releaseUnreachableComposerObjectUrls,
  trimComposerHistoryToImageBudget,
} from '../../src/components/nodes/shared/image/composer/composerHistoryBudget';

const MEBIBYTE = 1024 * 1024;

function imageLayer(id: string, image: object, pixels = 1024): Layer {
  return {
    id,
    name: id,
    type: 'image',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    visible: true,
    locked: false,
    blendMode: 'source-over',
    src: id,
    image: image as HTMLImageElement,
    width: pixels,
    height: pixels,
    adjustments: {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      hue: 0,
      blur: 0,
      luminance: 0,
      grayscale: false,
      invert: false,
      sepia: false,
    },
  };
}

describe('composer decoded-image history budget', () => {
  it('drops the oldest snapshots first while keeping the current and nearest undo state', () => {
    const current = imageLayer('current', {});
    const oldest = { layers: [imageLayer('oldest', {})] };
    const middle = { layers: [imageLayer('middle', {})] };
    const nearest = { layers: [imageLayer('nearest', {})] };

    const result = trimComposerHistoryToImageBudget(
      [current],
      [oldest, middle, nearest],
      [],
      8 * MEBIBYTE,
    );

    expect(result.past).toEqual([nearest]);
    expect(result.future).toEqual([]);
    expect(result.totalBytes).toBe(8 * MEBIBYTE);
  });

  it('deduplicates the same decoded image shared by current and history snapshots', () => {
    const sharedImage = {};
    const current = imageLayer('current', sharedImage);
    const result = trimComposerHistoryToImageBudget(
      [current],
      [{ layers: [imageLayer('past', sharedImage)] }],
      [{ layers: [imageLayer('future', sharedImage)] }],
      4 * MEBIBYTE,
    );

    expect(result.past).toHaveLength(1);
    expect(result.future).toHaveLength(1);
    expect(result.totalBytes).toBe(4 * MEBIBYTE);
  });

  it('cannot evict the currently visible decoded image even when it alone exceeds the limit', () => {
    const result = trimComposerHistoryToImageBudget(
      [imageLayer('current', {}, 2048)],
      [{ layers: [imageLayer('old', {})] }],
      [],
      4 * MEBIBYTE,
    );

    expect(result.past).toEqual([]);
    expect(result.totalBytes).toBe(16 * MEBIBYTE);
  });

  it('evicts history before a prospective image is decoded and counts the old replacement image', () => {
    const current = imageLayer('current', {});
    const nearest = { layers: [imageLayer('nearest', {})] };
    const result = trimComposerHistoryToImageBudget(
      [current],
      [nearest],
      [],
      8 * MEBIBYTE,
      4 * MEBIBYTE,
    );

    expect(result.past).toEqual([]);
    expect(result.totalBytes).toBe(8 * MEBIBYTE);
  });
});

describe('composer owned object URL reachability', () => {
  it('keeps URLs referenced by current/history layers and revokes evicted URLs', () => {
    const owned = new Set(['blob:current', 'blob:history', 'blob:evicted']);
    const revoked: string[] = [];

    releaseUnreachableComposerObjectUrls(
      owned,
      new Set(),
      [
        [imageLayer('blob:current', {})],
        [imageLayer('blob:history', {})],
      ],
      (url) => revoked.push(url),
    );

    expect(owned).toEqual(new Set(['blob:current', 'blob:history']));
    expect(revoked).toEqual(['blob:evicted']);
  });

  it('protects queued imports until pending is cleared, then revokes them when unreachable', () => {
    const owned = new Set(['blob:queued']);
    const pending = new Set(['blob:queued']);
    const revoked: string[] = [];

    releaseUnreachableComposerObjectUrls(owned, pending, [], (url) => revoked.push(url));
    expect(owned).toEqual(new Set(['blob:queued']));
    expect(revoked).toEqual([]);

    pending.clear();
    releaseUnreachableComposerObjectUrls(owned, pending, [], (url) => revoked.push(url));
    expect(owned).toEqual(new Set());
    expect(revoked).toEqual(['blob:queued']);
  });
});
