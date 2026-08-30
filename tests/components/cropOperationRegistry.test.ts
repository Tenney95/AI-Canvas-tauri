import { describe, expect, it } from 'vitest';
import { beginCropOperation } from '../../src/components/nodes/shared/image/cropOperationRegistry';

describe('crop operation registry', () => {
  it('rejects a second operation for the same node until async delivery completes', () => {
    const first = beginCropOperation('image-node:1');
    const second = beginCropOperation('image-node:1');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first!.isCurrent()).toBe(true);
    first!.complete();
    const afterCompletion = beginCropOperation('image-node:1');
    expect(afterCompletion?.isCurrent()).toBe(true);
    afterCompletion?.complete();
  });

  it('keeps simultaneous operations for different nodes isolated', () => {
    const first = beginCropOperation('image-node:1');
    const second = beginCropOperation('image-node:2');
    expect(first?.isCurrent()).toBe(true);
    expect(second?.isCurrent()).toBe(true);
    first?.cancel();
    second?.cancel();
  });
});
