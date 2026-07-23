import { describe, expect, it } from 'vitest';
import {
  getButtonRegistry,
  migrateToolbarLayout,
} from '../../src/components/nodes/shared/toolbar/toolbarRegistry';

describe('toolbar layout migration', () => {
  it('registers Camera Studio and history without the superseded angle tool', () => {
    const keys = getButtonRegistry('ai-image').map((button) => button.key);
    expect(keys).toContain('cameraStudio');
    expect(keys).toContain('history');
    expect(keys.indexOf('fullscreen')).toBeLessThan(keys.indexOf('history'));
    expect(keys).not.toContain('multiAngle');
  });

  it('replaces the old angle tool with Camera Studio in v1 image layouts', () => {
    const migrated = migrateToolbarLayout('ai-image', {
      version: 1,
      zones: [
        { id: 'custom', name: '自定义', buttonKeys: ['crop', 'multiAngle', 'upload'] },
      ],
    });

    expect(migrated).toEqual({
      version: 5,
      zones: [
        { id: 'custom', name: '自定义', buttonKeys: ['crop', 'cameraStudio', 'upload', 'history'] },
      ],
    });
  });

  it('removes the old angle tool from current Camera Studio layouts', () => {
    expect(migrateToolbarLayout('ai-image', {
      version: 2,
      zones: [
        { id: 'custom', name: '自定义', buttonKeys: ['multiAngle', 'cameraStudio', 'upload'] },
      ],
    })).toEqual({
      version: 5,
      zones: [
        { id: 'custom', name: '自定义', buttonKeys: ['cameraStudio', 'upload', 'history'] },
      ],
    });
  });

  it('does not alter current layouts or unrelated node types', () => {
    const current = { version: 5, zones: [{ id: 'custom', name: '自定义', buttonKeys: ['crop', 'history'] }] };
    expect(migrateToolbarLayout('ai-image', current)).toBe(current);
    expect(migrateToolbarLayout('ai-video', { ...current, version: 1 })).toEqual({ ...current, version: 1 });
  });

  it('adds history to existing v3 image layouts once', () => {
    expect(migrateToolbarLayout('ai-image', {
      version: 3,
      zones: [{ id: 'secondary', name: 'Secondary', buttonKeys: ['crop'] }],
    })).toEqual({
      version: 5,
      zones: [{ id: 'secondary', name: 'Secondary', buttonKeys: ['crop', 'history'] }],
    });
  });

  it('swaps the old v4 default fullscreen and history positions', () => {
    expect(migrateToolbarLayout('ai-image', {
      version: 4,
      zones: [{
        id: 'secondary',
        name: 'Secondary',
        buttonKeys: ['upload', 'copyFile', 'history', 'fullscreen'],
      }],
    })).toEqual({
      version: 5,
      zones: [{
        id: 'secondary',
        name: 'Secondary',
        buttonKeys: ['upload', 'copyFile', 'fullscreen', 'history'],
      }],
    });
  });
});
