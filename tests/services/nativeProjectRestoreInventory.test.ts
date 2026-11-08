/** 恢复素材只在根、路径和字节均一致时复用。 */
import { describe, expect, it } from 'vitest';
import { selectReusableNativeRestoreAssets } from '../../src/services/nativeProjectUpdateMedia';

describe('恢复点原素材清单', () => {
  it('缺失、同名不同根、大小或摘要变化均须使用备份，不可误复用', () => {
    const a = { rootRef: 'root-a', path: 'media/a.png', bytes: 3, sha256: 'a'.repeat(64) };
    const b = { rootRef: 'root-b', path: 'media/a.png', bytes: 4, sha256: 'b'.repeat(64) };
    const c = { rootRef: 'root-b', path: 'media/c.png', bytes: 5, sha256: 'c'.repeat(64) };
    const d = { rootRef: 'root-b', path: 'media/d.png', bytes: 6, sha256: 'd'.repeat(64) };
    expect(selectReusableNativeRestoreAssets([a, b, c, d], [a, { ...b, rootRef: 'root-other' },
      { ...c, sha256: 'e'.repeat(64) }, { ...d, bytes: 7 }])).toEqual([a]);
    expect(selectReusableNativeRestoreAssets([a], [a, { ...a }])).toEqual([]);
  });
});
