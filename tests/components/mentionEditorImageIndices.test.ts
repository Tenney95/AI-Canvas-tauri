import { describe, expect, it } from 'vitest';
import { numberImageReferenceKeys } from '../../src/components/nodes/shared/mentionEditorDom';

describe('mention editor image reference indices', () => {
  it('numbers references by first appearance and reuses the index for duplicates', () => {
    expect(numberImageReferenceKeys([
      'node:image-a',
      undefined,
      'asset:image-b',
      'node:image-a',
    ])).toEqual([1, undefined, 2, 1]);
  });
});
