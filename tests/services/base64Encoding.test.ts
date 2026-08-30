import { describe, expect, it } from 'vitest';
import {
  arrayBufferToBase64,
  bytePartsToBase64,
  bytePartsToBase64Async,
  getMimeType,
} from '../../src/services/fs/core';

describe('分块 Base64 编码', () => {
  it('跨 24 KiB 和 parts 边界时与标准 Base64 完全一致', async () => {
    const first = Uint8Array.from({ length: 3 * 0x2000 - 1 }, (_, index) => index % 251);
    const second = Uint8Array.from({ length: 3 * 0x2000 + 5 }, (_, index) => (index * 7) % 256);
    const expected = Buffer.concat([Buffer.from(first), Buffer.from(second)]).toString('base64');

    expect(bytePartsToBase64([first, second])).toBe(expected);
    const merged = Buffer.concat([Buffer.from(first), Buffer.from(second)]);
    expect(arrayBufferToBase64(merged.buffer.slice(
      merged.byteOffset,
      merged.byteOffset + merged.byteLength,
    ))).toBe(expected);
    await expect(bytePartsToBase64Async([first, second])).resolves.toBe(expected);
  });

  it('异步分块编码会在让出事件循环后响应取消', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('取消编码', 'AbortError')), 0);
    const bytes = new Uint8Array(2 * 1024 * 1024);

    await expect(bytePartsToBase64Async([bytes], controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('补充的常见音视频扩展名具有正确 MIME', () => {
    expect(getMimeType('m4a')).toBe('audio/mp4');
    expect(getMimeType('m4v')).toBe('video/x-m4v');
    expect(getMimeType('opus')).toBe('audio/opus');
    expect(getMimeType('wma')).toBe('audio/x-ms-wma');
    expect(getMimeType('wmv')).toBe('video/x-ms-wmv');
    expect(getMimeType('flv')).toBe('video/x-flv');
  });
});
