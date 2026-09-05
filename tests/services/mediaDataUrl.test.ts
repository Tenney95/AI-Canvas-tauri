import { describe, expect, it } from 'vitest';
import { decodeDataUrlBytesAsync, sha256BytesHex } from '../../src/services/mediaDataUrl';

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}

describe('mediaDataUrl', () => {
  it('decodes base64 across internal chunks without changing bytes', async () => {
    const expected = Uint8Array.from({ length: 300 * 1024 }, (_, index) => index % 251);
    const encoded = encodeBase64(expected);
    const payload = Array.from(
      { length: Math.ceil(encoded.length / 70_001) },
      (_, index) => encoded.slice(index * 70_001, (index + 1) * 70_001),
    ).join('\n');

    const actual = await decodeDataUrlBytesAsync(`data:image/png;base64,${payload}`, {
      expectedBytes: expected.byteLength,
      maxBytes: expected.byteLength,
    });

    expect(actual.byteLength).toBe(expected.byteLength);
    expect(await sha256BytesHex(actual)).toBe(await sha256BytesHex(expected));
  });

  it('rejects an oversized payload before allocating the decoded output', async () => {
    await expect(decodeDataUrlBytesAsync('data:image/png;base64,AQIDBA==', {
      maxBytes: 3,
      label: '测试图片',
    })).rejects.toThrow('测试图片大小超过允许的内存转换上限');
  });
});
