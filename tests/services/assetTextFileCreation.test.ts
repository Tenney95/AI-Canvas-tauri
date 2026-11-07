/** 首次保存原文：真实 UTF-8 读回、创建不覆盖与异步项目范围复核。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(), symlinks: new Set<string>(),
  exists: vi.fn(), mkdir: vi.fn(), lstat: vi.fn(), open: vi.fn(), close: vi.fn(), writeFile: vi.fn(),
  ensureProjectDataDir: vi.fn(), resolveUniqueDestPath: vi.fn(), notifyProjectDiskChanged: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({ exists: driver.exists, mkdir: driver.mkdir, lstat: driver.lstat, open: driver.open, writeFile: driver.writeFile }));
vi.mock('../../src/services/fs/core', () => ({
  ensureProjectDataDir: driver.ensureProjectDataDir,
  resolveUniqueDestPath: driver.resolveUniqueDestPath,
  notifyProjectDiskChanged: driver.notifyProjectDiskChanged,
  isTauriEnv: () => true,
  getFileCategory: (name: string) => /\.(?:md|txt)$/i.test(name) ? 'text' : 'other',
  sanitizeFileName: (name: string) => name,
  joinPath: (...parts: string[]) => parts.join('/'),
  stripVerbatimPrefix: (path: string) => path,
  invalidateTextPreview: vi.fn(),
}));

import { createAssetTextFile } from '../../src/services/fs/assetTextFiles';

const directory = '/project/series';
const path = `${directory}/原文.md`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  driver.files.clear();
  driver.directories.clear();
  driver.symlinks.clear();
  driver.exists.mockReset().mockImplementation(async (source: string) => driver.files.has(source) || driver.directories.has(source) || driver.symlinks.has(source));
  driver.mkdir.mockReset().mockImplementation(async (destination: string) => { driver.directories.add(destination); });
  driver.ensureProjectDataDir.mockReset().mockResolvedValue(directory);
  driver.resolveUniqueDestPath.mockReset().mockResolvedValue(path);
  driver.notifyProjectDiskChanged.mockReset();
  driver.close.mockReset().mockResolvedValue(undefined);
  driver.writeFile.mockReset().mockImplementation(async (destination: string, bytes: Uint8Array, options?: { createNew?: boolean }) => {
    if (options?.createNew && driver.files.has(destination)) throw new Error('目标文件已存在');
    driver.files.set(destination, bytes.slice());
  });
  driver.lstat.mockReset().mockImplementation(async (source: string) => {
    if (driver.directories.has(source) || driver.symlinks.has(source)) {
      return { isFile: false, isDirectory: true, isSymlink: driver.symlinks.has(source), size: 0, mtime: new Date(1000) };
    }
    const bytes = driver.files.get(source);
    if (!bytes) throw new Error('文件不存在');
    return { isFile: true, isSymlink: false, size: bytes.length, mtime: new Date(1000) };
  });
  driver.open.mockReset().mockImplementation(async (source: string) => {
    const bytes = driver.files.get(source);
    if (!bytes) throw new Error('文件不存在');
    let position = 0;
    return {
      read: async (buffer: Uint8Array) => {
        const count = Math.min(buffer.length, bytes.length - position, 7);
        buffer.set(bytes.subarray(position, position + count));
        position += count;
        return count || null;
      },
      close: driver.close,
    };
  });
});

describe('createAssetTextFile 首次保存原文', () => {
  it('以 createNew 写入无 BOM 的 UTF-8，并由真实读取器读回唯一目标文件', async () => {
    const destination = `${directory}/原文-2.md`;
    const normalized = '第一章 雨夜\n中文与🙂跨越读取边界。\n';
    driver.resolveUniqueDestPath.mockResolvedValue(destination);
    const result = await createAssetTextFile('series-a', '第一章 雨夜\r\n中文与🙂跨越读取边界。\r\n', '原文.md');

    expect(driver.ensureProjectDataDir).toHaveBeenCalledExactlyOnceWith('series-a', { throwOnError: true });
    expect(driver.resolveUniqueDestPath).toHaveBeenCalledExactlyOnceWith(directory, '原文.md', true);
    expect(driver.writeFile).toHaveBeenCalledExactlyOnceWith(destination, new TextEncoder().encode(normalized), { createNew: true });
    expect(driver.files.get(destination)).toEqual(new TextEncoder().encode(normalized));
    expect(driver.lstat).toHaveBeenCalledExactlyOnceWith(destination);
    expect(driver.open).toHaveBeenCalledExactlyOnceWith(destination, { read: true });
    expect(driver.close).toHaveBeenCalledOnce();
    expect(driver.notifyProjectDiskChanged).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ filePath: destination, relativePath: '原文-2.md', fileName: '原文-2.md',
      snapshot: { content: normalized, size: new TextEncoder().encode(normalized).length, modified: 1000, bom: false, newline: 'LF' } });
    expect(result.snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('在 manuscripts 创建稿件目录，返回带目录的相对路径并真实读回 TXT', async () => {
    const manuscripts = `${directory}/manuscripts`;
    const destination = `${manuscripts}/原文-2.txt`;
    driver.resolveUniqueDestPath.mockResolvedValue(destination);

    const result = await createAssetTextFile('series-a', '新原文正文', '原文.txt', { projectSubdirectory: 'manuscripts' });

    expect(driver.exists).toHaveBeenCalledExactlyOnceWith(manuscripts);
    expect(driver.mkdir).toHaveBeenCalledExactlyOnceWith(manuscripts);
    expect(driver.directories.has(manuscripts)).toBe(true);
    expect(driver.lstat.mock.calls.map(([source]) => source)).toEqual([manuscripts, destination]);
    expect(driver.resolveUniqueDestPath).toHaveBeenCalledExactlyOnceWith(manuscripts, '原文.txt', true);
    expect(driver.writeFile).toHaveBeenCalledExactlyOnceWith(destination, new TextEncoder().encode('新原文正文'), { createNew: true });
    expect(driver.open).toHaveBeenCalledExactlyOnceWith(destination, { read: true });
    expect(result).toMatchObject({ filePath: destination, relativePath: 'manuscripts/原文-2.txt', fileName: '原文-2.txt',
      snapshot: { content: '新原文正文', bom: false, newline: 'LF' } });
  });

  it('已有 manuscripts 是符号链接时拒绝使用，不选择目标或写入正文', async () => {
    const manuscripts = `${directory}/manuscripts`;
    driver.directories.add(manuscripts);
    driver.symlinks.add(manuscripts);

    await expect(createAssetTextFile('series-a', '尚未保存的新稿', '原文.txt', { projectSubdirectory: 'manuscripts' }))
      .rejects.toThrow('稿件目录必须是普通文件夹');
    expect(driver.exists).toHaveBeenCalledExactlyOnceWith(manuscripts);
    expect(driver.mkdir).not.toHaveBeenCalled();
    expect(driver.lstat).toHaveBeenCalledExactlyOnceWith(manuscripts);
    expect(driver.resolveUniqueDestPath).not.toHaveBeenCalled();
    expect(driver.writeFile).not.toHaveBeenCalled();
    expect(driver.files.size).toBe(0);
  });

  it('创建 manuscripts 目录期间项目范围变化时保留目录但不写入正文', async () => {
    const manuscripts = `${directory}/manuscripts`;
    const started = deferred<void>();
    const completed = deferred<void>();
    let current = true;
    driver.mkdir.mockImplementation(async (destination: string) => {
      started.resolve();
      await completed.promise;
      driver.directories.add(destination);
    });
    const task = createAssetTextFile('series-a', '尚未保存的新稿', '原文.txt', {
      projectSubdirectory: 'manuscripts',
      assertCurrent: () => { if (!current) throw new Error('项目范围已变化'); },
    });
    await started.promise;
    current = false;
    completed.resolve();

    await expect(task).rejects.toThrow('项目范围已变化');
    expect(driver.directories.has(manuscripts)).toBe(true);
    expect(driver.lstat).not.toHaveBeenCalled();
    expect(driver.resolveUniqueDestPath).not.toHaveBeenCalled();
    expect(driver.writeFile).not.toHaveBeenCalled();
    expect(driver.files.size).toBe(0);
    expect(driver.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it('异步选择目标路径后项目范围变化时停止，不写入任何文件', async () => {
    const selected = deferred<string>();
    const requested = deferred<void>();
    let current = true;
    driver.resolveUniqueDestPath.mockImplementation(() => { requested.resolve(); return selected.promise; });
    const task = createAssetTextFile('series-a', '尚未保存的新稿', '原文.md', {
      assertCurrent: () => { if (!current) throw new Error('项目范围已变化'); },
    });
    await requested.promise;
    current = false;
    selected.resolve(path);

    await expect(task).rejects.toThrow('项目范围已变化');
    expect(driver.writeFile).not.toHaveBeenCalled();
    expect(driver.files.size).toBe(0);
    expect(driver.open).not.toHaveBeenCalled();
    expect(driver.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it('目标选定后出现同名文件时拒绝覆盖，保留另一写入者的原文件', async () => {
    const previous = new TextEncoder().encode('已经存在且不能覆盖的正文');
    driver.resolveUniqueDestPath.mockImplementation(async () => {
      driver.files.set(path, previous.slice());
      return path;
    });

    await expect(createAssetTextFile('series-a', '待创建的新稿', '原文.md')).rejects.toThrow('新建原文失败，草稿已保留');
    expect(driver.writeFile).toHaveBeenCalledExactlyOnceWith(path, new TextEncoder().encode('待创建的新稿'), { createNew: true });
    expect(driver.files.get(path)).toEqual(previous);
    expect(driver.open).not.toHaveBeenCalled();
    expect(driver.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it.each([
    { name: '含 NUL 的正文', content: '原文\0二进制', error: '文本不能包含二进制空字符' },
    { name: 'UTF-8 字节数超过 2 MB 的正文', content: '中'.repeat(Math.floor(2 * 1024 * 1024 / 3) + 1), error: '内容超过 2 MB，无法保存' },
  ])('在文件操作前拒绝$name', async ({ content, error }) => {
    await expect(createAssetTextFile('series-a', content, '原文.md')).rejects.toThrow(error);
    expect(driver.ensureProjectDataDir).not.toHaveBeenCalled();
    expect(driver.resolveUniqueDestPath).not.toHaveBeenCalled();
    expect(driver.writeFile).not.toHaveBeenCalled();
    expect(driver.files.size).toBe(0);
  });
});
