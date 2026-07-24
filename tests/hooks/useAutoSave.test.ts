import { describe, expect, it } from 'vitest';
import {
  captureNodeDataReferences,
  hasNodeDataReferenceChanges,
} from '../../src/hooks/useAutoSave';

describe('useAutoSave node data tracking', () => {
  it('detects immutable node content updates', () => {
    const originalData = { label: '原内容', output: '第一版' };
    const baseline = captureNodeDataReferences([{ id: 'node-1', data: originalData }]);

    expect(hasNodeDataReferenceChanges([
      { id: 'node-1', data: { ...originalData, output: '第二版' } },
    ], baseline)).toBe(true);
  });

  it('ignores node wrapper changes when data is unchanged', () => {
    const data = { label: '文本节点', output: '内容' };
    const baseline = captureNodeDataReferences([{ id: 'node-1', data }]);

    expect(hasNodeDataReferenceChanges([{ id: 'node-1', data }], baseline)).toBe(false);
  });

  it('detects added nodes', () => {
    const baseline = captureNodeDataReferences([]);

    expect(hasNodeDataReferenceChanges([
      { id: 'node-1', data: { label: '新节点' } },
    ], baseline)).toBe(true);
  });
});
