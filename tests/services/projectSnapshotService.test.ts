import { describe, expect, it, vi } from 'vitest';
import {
  encodeProjectSnapshot,
  getProjectSnapshotBitmapSize,
  isProjectSnapshotDataUrl,
  PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH,
  shouldIncludeProjectSnapshotNode,
  toProjectSnapshotRect,
} from '../../src/services/projectSnapshotService';

function fakeElement(classes: string[] = [], tagName = 'DIV'): HTMLElement {
  return {
    tagName,
    classList: {
      contains: (value: string) => classes.includes(value),
    },
  } as unknown as HTMLElement;
}

describe('projectSnapshotService', () => {
  it('accepts bounded image data URLs only', () => {
    expect(isProjectSnapshotDataUrl('data:image/webp;base64,AAAA')).toBe(true);
    expect(isProjectSnapshotDataUrl('https://example.com/preview.webp')).toBe(false);
    expect(isProjectSnapshotDataUrl(`data:image/webp;base64,${'A'.repeat(PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH)}`)).toBe(false);
  });

  it('filters React Flow chrome while keeping canvas content', () => {
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['react-flow__node']))).toBe(true);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['react-flow__controls']))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['react-flow__minimap']))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['react-flow__panel']))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['gooey-btn-wrapper']))).toBe(false);
  });

  it('skips media surfaces that can taint the snapshot canvas', () => {
    expect(shouldIncludeProjectSnapshotNode(fakeElement([], 'VIDEO'))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement([], 'canvas'))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement([], 'IFRAME'))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement([], 'IMG'))).toBe(true);
  });

  it('reduces WebP quality until the snapshot fits the persistence limit', () => {
    const oversized = `data:image/webp;base64,${'A'.repeat(PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH)}`;
    const compact = 'data:image/webp;base64,COMPACT';
    const canvas = {
      toDataURL: vi.fn((_type: string, quality?: number) => (
        quality === 0.7 ? oversized : compact
      )),
    };

    expect(encodeProjectSnapshot(canvas)).toBe(compact);
    expect(canvas.toDataURL).toHaveBeenNthCalledWith(1, 'image/webp', 0.7);
    expect(canvas.toDataURL).toHaveBeenNthCalledWith(2, 'image/webp', 0.5);
  });

  it('maps visible DOM bounds into canvas-relative worker coordinates', () => {
    const root = { left: 100, top: 50, right: 900, bottom: 500, width: 800, height: 450 };
    expect(toProjectSnapshotRect({
      left: 220,
      top: 140,
      right: 420,
      bottom: 300,
      width: 200,
      height: 160,
    }, root)).toEqual({ x: 120, y: 90, width: 200, height: 160 });
    expect(toProjectSnapshotRect({
      left: 920,
      top: 140,
      right: 1020,
      bottom: 300,
      width: 100,
      height: 160,
    }, root)).toBeNull();
  });

  it('downsamples media to its thumbnail footprint while preserving its aspect ratio', () => {
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 300,
      displayWidth: 400,
      fit: 'contain',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 2_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 240, height: 120 });
  });

  it('keeps enough pixels for cover media without retaining the full source image', () => {
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 300,
      displayWidth: 400,
      fit: 'cover',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 2_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 360, height: 180 });
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 450,
      displayWidth: 800,
      fit: 'cover',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 8_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 240, height: 480 });
  });
});
