import { describe, expect, it } from 'vitest';
import {
  getButtonRegistry,
  migrateToolbarLayout,
} from '../../src/components/nodes/shared/toolbar/toolbarRegistry';

describe('toolbar layout migration', () => {
  it('registers Camera Studio without the superseded angle tool', () => {
    const keys = getButtonRegistry('ai-image').map((button) => button.key);
    expect(keys).toContain('cameraStudio');
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
      version: 3,
      zones: [
        { id: 'custom', name: '自定义', buttonKeys: ['crop', 'cameraStudio', 'upload'] },
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
      version: 3,
      zones: [
        { id: 'custom', name: '自定义', buttonKeys: ['cameraStudio', 'upload'] },
      ],
    });
  });

  it('does not alter current layouts or unrelated node types', () => {
    const current = { version: 3, zones: [{ id: 'custom', name: '自定义', buttonKeys: ['crop'] }] };
    expect(migrateToolbarLayout('ai-image', current)).toBe(current);
    expect(migrateToolbarLayout('ai-video', { ...current, version: 1 })).toEqual({ ...current, version: 1 });
  });
});
