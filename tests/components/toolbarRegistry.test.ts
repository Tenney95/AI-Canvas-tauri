import { describe, expect, it } from 'vitest';
import {
  getDefaultLayout,
  getButtonRegistry,
  getHiddenDefaultToolbarButtons,
  getPluginToolbarButtonRegistry,
  migrateToolbarLayout,
} from '../../src/components/nodes/shared/toolbar/toolbarRegistry';
import type { InstalledPlugin } from '../../src/types/plugin';

describe('toolbar layout migration', () => {
  it('registers Camera Studio and history without the superseded angle tool', () => {
    const keys = getButtonRegistry('ai-image').map((button) => button.key);
    expect(keys).toContain('cameraStudio');
    expect(keys).toContain('history');
    expect(keys.indexOf('copyFile')).toBeLessThan(keys.indexOf('history'));
    expect(keys.indexOf('history')).toBeLessThan(keys.indexOf('fullscreen'));
    expect(keys.indexOf('compose') + 1).toBe(keys.indexOf('more'));
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
      version: 8,
      zones: [
        { id: 'custom', name: '自定义', buttonKeys: ['crop', 'cameraStudio', 'upload', 'history', 'more'] },
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
      version: 8,
      zones: [
        { id: 'custom', name: '自定义', buttonKeys: ['cameraStudio', 'upload', 'history', 'more'] },
      ],
    });
  });

  it('keeps custom button zoning while advancing the image layout version', () => {
    const current = { version: 5, zones: [{ id: 'custom', name: '自定义', buttonKeys: ['crop', 'history'] }] };
    expect(migrateToolbarLayout('ai-image', current)).toEqual({
      version: 8,
      zones: [{ id: 'custom', name: '自定义', buttonKeys: ['crop', 'history', 'more'] }],
    });
    expect(migrateToolbarLayout('ai-video', { ...current, version: 1 })).toEqual({
      version: 2,
      zones: [{ id: 'custom', name: '自定义', buttonKeys: ['crop', 'history', 'more'] }],
    });
  });

  it('adds history to existing v3 image layouts once', () => {
    expect(migrateToolbarLayout('ai-image', {
      version: 3,
      zones: [{ id: 'secondary', name: 'Secondary', buttonKeys: ['crop'] }],
    })).toEqual({
      version: 8,
      zones: [{ id: 'secondary', name: 'Secondary', buttonKeys: ['crop', 'history', 'more'] }],
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
      version: 8,
      zones: [{
        id: 'secondary',
        name: 'Secondary',
        buttonKeys: ['upload', 'copyFile', 'fullscreen', 'history', 'more'],
      }],
    });
  });

  it('places copy, history, and fullscreen after the image toolbar divider', () => {
    expect(getDefaultLayout('ai-image')).toEqual({
      version: 8,
      zones: [
        {
          id: 'zone-0',
          name: 'Primary',
          buttonKeys: [
            'matting', 'expand', 'multiGrid', 'cameraStudio', 'repaint', 'upscale',
            'subjectMatting', 'annotate', 'crop', 'compose', 'more', 'upload', 'reversePrompt',
          ],
        },
        {
          id: 'zone-1',
          name: 'Secondary',
          buttonKeys: ['copyFile', 'history', 'fullscreen'],
        },
      ],
    });
  });

  it('adds More once to legacy layouts and preserves an intentional current-version removal', () => {
    const migrated = migrateToolbarLayout('ai-text', {
      version: 1,
      zones: [{ id: 'primary', name: '常用', buttonKeys: ['copy'] }],
    });
    expect(migrated).toEqual({
      version: 2,
      zones: [{ id: 'primary', name: '常用', buttonKeys: ['copy', 'more'] }],
    });

    const hiddenMore = {
      version: 2,
      zones: [{ id: 'primary', name: '常用', buttonKeys: ['copy'] }],
    };
    expect(migrateToolbarLayout('ai-text', hiddenMore)).toBe(hiddenMore);
  });

  it('collects only hidden built-in buttons inside More', () => {
    const registry = getButtonRegistry('ai-text');
    const hidden = getHiddenDefaultToolbarButtons(registry, new Set(['copy', 'more']));
    expect(hidden.map((button) => button.key)).toEqual([
      'clearEmptyLines', 'showPrompt', 'fullscreen',
    ]);
  });

  it('registers enabled plugin buttons without adding them to the default layout', () => {
    const plugin: InstalledPlugin = {
      id: 'example.plugin',
      source: 'main.js',
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      manifest: {
        apiVersion: 1,
        runtime: 'javascript',
        id: 'example.plugin',
        name: '示例插件',
        version: '1.0.0',
        category: 'utility',
        entry: 'main.js',
        permissions: ['node.read'],
        contributes: {
          nodeTools: [{
            id: 'uppercase',
            title: '输出转大写',
            placements: ['node-toolbar'],
            icon: 'mdi:format-letter-case-upper',
            dialog: { fields: [] },
            nodeTypes: ['ai-text'],
            inputFields: ['output'],
            output: { mode: 'update-current', fields: ['output'] },
          }],
        },
      },
    };

    const pluginButtons = getPluginToolbarButtonRegistry([plugin], 'ai-text');
    expect(pluginButtons).toEqual([expect.objectContaining({
      key: 'example.plugin:uppercase',
      label: '输出转大写 · 示例插件',
      defaultZone: '更多',
    })]);
    expect(getDefaultLayout('ai-text').zones.flatMap((zone) => zone.buttonKeys))
      .not.toContain('example.plugin:uppercase');

    const registry = [...getButtonRegistry('ai-text'), ...pluginButtons];
    const hidden = getHiddenDefaultToolbarButtons(
      registry,
      new Set(getDefaultLayout('ai-text').zones.flatMap((zone) => zone.buttonKeys)),
    );
    expect(hidden.map((button) => button.key)).toContain('example.plugin:uppercase');
  });

  it('adds the local speech-to-text button to legacy audio layouts', () => {
    const migrated = migrateToolbarLayout('ai-audio', {
      version: 2,
      zones: [{ id: 'primary', name: '常用', buttonKeys: ['togglePlay', 'transcribe', 'more'] }],
    });
    expect(migrated).toEqual({
      version: 3,
      zones: [{
        id: 'primary',
        name: '常用',
        buttonKeys: ['togglePlay', 'speechToText', 'transcribe', 'more'],
      }],
    });
  });

  it('does not re-add a speech-to-text button the user removed', () => {
    const migrated = migrateToolbarLayout('ai-audio', {
      version: 3,
      zones: [{ id: 'primary', name: '常用', buttonKeys: ['togglePlay', 'more'] }],
    });
    expect(migrated.version).toBe(3);
    expect(migrated.zones[0].buttonKeys).not.toContain('speechToText');
  });

  it('places speech-to-text right after play/pause in the default audio layout', () => {
    expect(getDefaultLayout('ai-audio')).toEqual({
      version: 3,
      zones: [{
        id: 'zone-0',
        name: '常用',
        buttonKeys: [
          'togglePlay', 'speechToText', 'transcribe', 'copyFile', 'upload', 'fullscreen', 'more',
        ],
      }],
    });
  });

  it('registers More in every editable node toolbar', () => {
    for (const nodeType of ['ai-text', 'ai-image', 'ai-video', 'ai-audio', 'ai-panorama']) {
      expect(getButtonRegistry(nodeType).map((button) => button.key)).toContain('more');
    }
  });

  it('updates the old default image layout without changing custom layouts', () => {
    const migrated = migrateToolbarLayout('ai-image', {
      version: 5,
      zones: [
        {
          id: 'zone-0',
          name: 'Primary',
          buttonKeys: ['matting', 'expand', 'multiGrid', 'cameraStudio', 'repaint', 'upscale', 'subjectMatting'],
        },
        {
          id: 'zone-1',
          name: 'Secondary',
          buttonKeys: ['annotate', 'crop', 'compose', 'upload', 'copyFile', 'fullscreen', 'history'],
        },
      ],
    });

    expect(migrated).toEqual(getDefaultLayout('ai-image'));
  });

  it('updates the previous v6 default image layout', () => {
    expect(migrateToolbarLayout('ai-image', {
      version: 6,
      zones: [
        {
          id: 'zone-0',
          name: 'Primary',
          buttonKeys: [
            'matting', 'expand', 'multiGrid', 'cameraStudio', 'repaint', 'upscale',
            'subjectMatting', 'annotate', 'crop', 'compose', 'upload', 'copyFile',
          ],
        },
        {
          id: 'zone-1',
          name: 'Secondary',
          buttonKeys: ['fullscreen', 'history'],
        },
      ],
    })).toEqual(getDefaultLayout('ai-image'));
  });
});
