/** 授权文本读取保持真实字节上限、UTF-8 及取消后的句柄回收。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  native: true, bytes: new Uint8Array(), position: 0, shortRead: Infinity,
  stat: vi.fn(), open: vi.fn(), read: vi.fn(), close: vi.fn(), readFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-fs')>(),
  stat: driver.stat, open: driver.open, readFile: driver.readFile,
}));
vi.mock('../../src/services/fs/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/core')>(),
  isTauriEnv: () => driver.native,
}));

import { readAgentAuthorizedTextFile } from '../../src/services/fileService';

const path = '/authorized/正文.txt';
const handle = () => ({ read: driver.read, close: driver.close });
beforeEach(() => {
  driver.native = true;
  driver.bytes = new TextEncoder().encode('已授权的中文正文');
  driver.position = 0; driver.shortRead = Infinity;
  driver.stat.mockReset().mockImplementation(async () => ({ isFile: true, size: driver.bytes.length }));
  driver.close.mockReset().mockResolvedValue(undefined);
  driver.readFile.mockReset();
  driver.open.mockReset().mockImplementation(async () => handle());
  driver.read.mockReset().mockImplementation(async (buffer: Uint8Array) => {
    const count = Math.min(buffer.length, driver.bytes.length - driver.position, driver.shortRead);
    buffer.set(driver.bytes.subarray(driver.position, driver.position + count));
    driver.position += count;
    return count || null;
  });
});

describe('bounded authorized UTF-8 text reads', () => {
  it('does not access the filesystem outside the desktop runtime', async () => {
    driver.native = false;
    await expect(readAgentAuthorizedTextFile(path, 1024)).rejects.toThrow('仅在 Tauri 桌面环境可用');
    expect(driver.stat).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid byte budget %s before filesystem access', async (maxBytes) => {
    await expect(readAgentAuthorizedTextFile(path, maxBytes)).rejects.toThrow('文件读取限制无效');
    expect(driver.stat).not.toHaveBeenCalled();
    expect(driver.open).not.toHaveBeenCalled();
  });

  it('preserves multibyte UTF-8 across chunks and short reads, including a limit-sized file', async () => {
    const text = `${'a'.repeat(65_535)}中文🙂\r\n${'后续'.repeat(40_000)}`;
    driver.bytes = new TextEncoder().encode(text);
    driver.shortRead = 997;
    expect(await readAgentAuthorizedTextFile(path, driver.bytes.length)).toBe(text);
    expect(driver.position).toBe(driver.bytes.length);
    expect(driver.read.mock.calls.every(([buffer]) => (buffer as Uint8Array).length <= 64 * 1024)).toBe(true);
    expect((driver.read.mock.calls.at(-1)![0] as Uint8Array).length).toBe(1);
    expect(driver.close).toHaveBeenCalledOnce();
    expect(driver.readFile).not.toHaveBeenCalled();
  });

  it('reads at most one extra byte when a file grows after its size check', async () => {
    driver.bytes = new TextEncoder().encode('0123456789abcdef');
    driver.stat.mockResolvedValue({ isFile: true, size: 3 });
    driver.shortRead = 2;
    await expect(readAgentAuthorizedTextFile(path, 8)).rejects.toThrow('文件超过 0 KB 读取限制');
    expect(driver.position).toBe(9);
    expect(driver.close).toHaveBeenCalledOnce();
    expect(driver.readFile).not.toHaveBeenCalled();
  });

  it.each([
    { info: { isFile: false, size: 0 }, error: '授权目标已不再是文件' },
    { info: { isFile: true, size: 1025 }, error: '文件超过 1 KB 读取限制' },
  ])('rejects a disallowed file before opening a handle: $error', async ({ info, error }) => {
    driver.stat.mockResolvedValue(info);
    await expect(readAgentAuthorizedTextFile(path, 1024)).rejects.toThrow(error);
    expect(driver.open).not.toHaveBeenCalled();
    expect(driver.readFile).not.toHaveBeenCalled();
  });

  it('returns an empty file with a zero-byte budget and still releases the handle', async () => {
    driver.bytes = new Uint8Array();
    expect(await readAgentAuthorizedTextFile(path, 0)).toBe('');
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it('does not allocate a caller-sized buffer for a tiny file with a very large budget', async () => {
    expect(await readAgentAuthorizedTextFile(path, 2 ** 40)).toBe('已授权的中文正文');
    expect(driver.read.mock.calls.every(([buffer]) => (buffer as Uint8Array).length <= 64 * 1024)).toBe(true);
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid UTF-8 instead of returning replacement characters', async () => {
    driver.bytes = new Uint8Array([0xc3, 0x28]); driver.shortRead = 1;
    await expect(readAgentAuthorizedTextFile(path, 1024)).rejects.toThrow('文件不是有效的 UTF-8 文本');
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it('stops an already cancelled request before filesystem access', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readAgentAuthorizedTextFile(path, 1024, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(driver.stat).not.toHaveBeenCalled();
    expect(driver.open).not.toHaveBeenCalled();
  });

  it('does not open a handle after cancellation during stat', async () => {
    const controller = new AbortController();
    driver.stat.mockImplementationOnce(async () => { controller.abort(); return { isFile: true, size: 1 }; });
    await expect(readAgentAuthorizedTextFile(path, 1024, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(driver.open).not.toHaveBeenCalled();
  });

  it('closes a handle acquired after cancellation while opening', async () => {
    const controller = new AbortController();
    driver.open.mockImplementationOnce(async () => { controller.abort(); return handle(); });
    await expect(readAgentAuthorizedTextFile(path, 1024, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(driver.read).not.toHaveBeenCalled();
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it('closes the handle when cancellation arrives during a short read', async () => {
    const controller = new AbortController();
    driver.read.mockImplementationOnce(async () => { controller.abort(); return 1; });
    await expect(readAgentAuthorizedTextFile(path, 1024, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(driver.read).toHaveBeenCalledOnce();
    expect(driver.close).toHaveBeenCalledOnce();
    expect(driver.readFile).not.toHaveBeenCalled();
  });

  it('propagates a read failure after closing without a whole-file fallback', async () => {
    const failure = new Error('read unavailable');
    driver.read.mockRejectedValueOnce(failure);
    await expect(readAgentAuthorizedTextFile(path, 1024)).rejects.toBe(failure);
    expect(driver.close).toHaveBeenCalledOnce();
    expect(driver.readFile).not.toHaveBeenCalled();
  });

  it('preserves cancellation when a pending open rejects', async () => {
    const controller = new AbortController();
    driver.open.mockImplementationOnce(async () => { controller.abort(); throw new Error('open unavailable'); });
    await expect(readAgentAuthorizedTextFile(path, 1024, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(driver.close).not.toHaveBeenCalled();
  });

  it('observes cancellation while the completed read is closing', async () => {
    const controller = new AbortController();
    driver.close.mockImplementationOnce(async () => { controller.abort(); });
    await expect(readAgentAuthorizedTextFile(path, 1024, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(driver.close).toHaveBeenCalledOnce();
  });
});
