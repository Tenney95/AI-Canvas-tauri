import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCanvasViewport, restoreCanvasViewport, saveCanvasViewport } from '../../src/services/canvasViewportPersistence';

const saved = { x: -3200, y: -8400, zoom: 0.57, width: 1200, height: 800 };
let records: Map<string, string>;

beforeEach(() => {
  records = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('canvas viewport persistence', () => {
  it('keeps each project and episode separate, and missing records use initial fit', () => {
    saveCanvasViewport('episode-1', saved);
    saveCanvasViewport('episode-2', { ...saved, x: -20, y: 60, zoom: 1.2 });
    expect(readCanvasViewport('episode-1')).toEqual(saved);
    expect(readCanvasViewport('episode-2')).toMatchObject({ x: -20, y: 60, zoom: 1.2 });
    expect(readCanvasViewport('new-project')).toBeNull();
    expect(readCanvasViewport(null)).toBeNull();
  });

  it('restores both translation and the project zoom instead of another project global zoom', () => {
    const viewport = restoreCanvasViewport(saved, saved, { canvasViewportMode: 'manual', canvasViewportZoom: 1.5 });
    expect(viewport.x).toBeCloseTo(saved.x);
    expect(viewport.y).toBeCloseTo(saved.y);
    expect(viewport.zoom).toBe(saved.zoom);
  });

  it('retains the same world center after resizing or constraining the zoom', () => {
    const size = { width: 1600, height: 900 };
    const viewport = restoreCanvasViewport(saved, size, { canvasViewportMinZoom: 0.75, canvasViewportMaxZoom: 1 });
    expect(viewport.zoom).toBe(0.75);
    expect((size.width / 2 - viewport.x) / viewport.zoom).toBeCloseTo((saved.width / 2 - saved.x) / saved.zoom);
    expect((size.height / 2 - viewport.y) / viewport.zoom).toBeCloseTo((saved.height / 2 - saved.y) / saved.zoom);
    const locked = restoreCanvasViewport(saved, size, { canvasViewportMode: 'locked', canvasViewportZoom: 1.2 });
    expect(locked.zoom).toBe(1.2);
    expect((size.width / 2 - locked.x) / locked.zoom).toBeCloseTo((saved.width / 2 - saved.x) / saved.zoom);
  });

  it.each(['{', '{}', 'null', JSON.stringify({ ...saved, zoom: 0 }), JSON.stringify({ ...saved, x: '0' }),
    JSON.stringify({ ...saved, height: -1 })])('ignores malformed or invalid saved viewports: %s', (raw) => {
    records.set('ai-canvas.viewport.v1:project', raw);
    expect(readCanvasViewport('project')).toBeNull();
  });

  it('does not overwrite a valid record with an unmeasured or invalid viewport', () => {
    saveCanvasViewport('project', saved);
    saveCanvasViewport('project', { ...saved, x: Infinity });
    saveCanvasViewport('project', { ...saved, width: 0 });
    expect(readCanvasViewport('project')).toEqual(saved);
  });

  it('does not block canvas use when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage disabled'); },
      setItem: () => { throw new Error('storage full'); },
    });
    expect(readCanvasViewport('project')).toBeNull();
    expect(() => saveCanvasViewport('project', saved)).not.toThrow();
  });
});
