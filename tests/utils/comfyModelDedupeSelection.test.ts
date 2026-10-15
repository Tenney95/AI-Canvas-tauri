import { describe, expect, it } from 'vitest';
import type { ComfyDuplicateModelGroup } from '../../src/types/comfyModelDedupe';
import { defaultComfyModelSelection, selectedComfyModelGroups } from '../../src/utils/comfyModelDedupeSelection';

const group = (id: string): ComfyDuplicateModelGroup => ({
  id, hash: 'same-content', size: 1024, reclaimableBytes: 2048,
  files: [
    { id: `${id}-a`, relativePath: 'models/original.pth', alreadyShared: false },
    { id: `${id}-b`, relativePath: 'plugin/renamed.bin', alreadyShared: false },
    { id: `${id}-c`, relativePath: 'other/weights.pth', alreadyShared: false },
  ],
});

describe('模型批量替换选择', () => {
  it('keeps group edits while including defaults for groups outside the visible list', () => {
    const first = group('visible');
    const second = group('hidden');
    const requests = selectedComfyModelGroups([first, second], {
      visible: { keeperId: 'visible-b', targetIds: ['visible-a'], linkType: 'symlink' },
    });
    expect(requests).toEqual([
      { groupId: 'visible', keeperId: 'visible-b', targetIds: ['visible-a'], linkType: 'symlink' },
      { groupId: 'hidden', keeperId: 'hidden-a', targetIds: ['hidden-b', 'hidden-c'], linkType: 'hardlink' },
    ]);
  });

  it('does not reselect groups the user explicitly unchecked', () => {
    const source = group('g');
    expect(selectedComfyModelGroups([source], { g: { ...defaultComfyModelSelection(source), targetIds: [] } })).toEqual([]);
  });

  it('keeps already shared files and excludes keeper, unknown and repeated target identities', () => {
    const source = group('g');
    source.files[2].alreadyShared = true;
    expect(defaultComfyModelSelection(source).keeperId).toBe('g-c');
    expect(selectedComfyModelGroups([source], {
      g: { keeperId: 'g-a', targetIds: ['g-a', 'g-b', 'g-b', 'g-c', 'unknown'], linkType: 'hardlink' },
    })[0].targetIds).toEqual(['g-b']);
  });
});
