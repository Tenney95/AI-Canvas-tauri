/** 新项目参考图片仅接受内容寻址的可验证本机文件；测试源码未执行。 */
import { describe, expect, it } from 'vitest';
import { validateNativeVideoImageReference } from '../../src/services/nativeVideoImageReference';

describe('原视频图片引用验证', () => {
  const digest = 'a'.repeat(64);
  const valid = { sourceNodeId: 'source', relativePath: `media/${digest}.png`, sha256: digest,
    bytes: 1024, mimeType: 'image/png' as const };
  it('接受受控内容寻址图片，拒绝远端地址、错误摘要、格式和超限', () => {
    expect(() => validateNativeVideoImageReference(valid)).not.toThrow();
    expect(() => validateNativeVideoImageReference({ ...valid, relativePath: 'https://example.test/image.png' })).toThrow();
    expect(() => validateNativeVideoImageReference({ ...valid, sha256: 'b'.repeat(64) })).toThrow();
    expect(() => validateNativeVideoImageReference({ ...valid, mimeType: 'image/jpeg' })).toThrow();
    expect(() => validateNativeVideoImageReference({ ...valid, bytes: 30 * 1024 * 1024 })).toThrow();
  });
});
