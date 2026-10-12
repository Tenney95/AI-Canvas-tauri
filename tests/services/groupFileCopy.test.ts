import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
const disk = vi.hoisted(() => new Set<string>());
const native = vi.hoisted(() => ({ copy: vi.fn(), rename: vi.fn(), exists: vi.fn(), lstat: vi.fn(), remove: vi.fn(), readDir: vi.fn(), retired: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: native.exists,
  mkdir: vi.fn(async (path: string) => { disk.add(path); }),
  copyFile: native.copy, rename: native.rename,
  lstat: native.lstat, remove: native.remove, readDir: native.readDir,
  readFile: vi.fn(), stat: vi.fn(), watch: vi.fn(), writeFile: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path,
  invoke: (_command: string, args: { sourcePath: string; destinationPath: string }) => native.copy(args.sourcePath, args.destinationPath) }));
vi.mock('../../src/services/indexedDb/mediaRelocations', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/indexedDb/mediaRelocations')>(),
  retiredMediaPaths: native.retired,
}));
let moveProjectFileToFolder: typeof import('../../src/services/fs/core').moveProjectFileToFolder;
let resolveUniqueDestPath: typeof import('../../src/services/fs/core').resolveUniqueDestPath;
let finishProjectFileRelocation: typeof import('../../src/services/fs/core').finishProjectFileRelocation;
let buildNodeFileName: typeof import('../../src/services/fs/core').buildNodeFileName;

beforeEach(async () => {
  vi.stubGlobal('navigator', { platform: 'Win32' });
  vi.resetModules();
  ({ moveProjectFileToFolder, resolveUniqueDestPath, finishProjectFileRelocation, buildNodeFileName } = await import('../../src/services/fs/core'));
  disk.clear();
  disk.add('/p/original.png');
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, dispatchEvent: vi.fn() });
  native.copy.mockReset();
  native.rename.mockReset();
  native.retired.mockReset().mockResolvedValue(new Set());
  native.exists.mockImplementation(async (path: string) => disk.has(path));
  native.lstat.mockReset().mockImplementation(async (path: string) => {
    if (!disk.has(path)) throw new Error('missing');
    return { isFile: path.endsWith('.png'), isDirectory: !path.endsWith('.png'), isSymlink: false, size: 42 };
  });
  native.remove.mockReset().mockImplementation(async (path: string) => { disk.delete(path); });
  native.readDir.mockReset().mockImplementation(async (path: string) => [...disk].filter((file) => file.startsWith(`${path}/`)));
  native.copy.mockImplementation(async (source: string, target: string) => {
    if (!disk.has(source) || disk.has(target)) throw new Error('invalid copy');
    disk.add(target);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('group file allocation', () => {
  it('removes the committed source and empty group directory, keeping the destination', async () => {
    for (const path of ['/p/group', '/p/group/old.png', '/p/new.png']) disk.add(path);
    await finishProjectFileRelocation('/p/group/old.png', '/p/new.png', '/p');
    expect(disk.has('/p/group/old.png')).toBe(false);
    expect(disk.has('/p/group')).toBe(false);
    expect(disk.has('/p/new.png')).toBe(true);
  });

  it('keeps nonempty folders and never removes the project root', async () => {
    for (const path of ['/p/group', '/p/group/old.png', '/p/group/other.png', '/p/new.png']) disk.add(path);
    await finishProjectFileRelocation('/p/group/old.png', '/p/new.png', '/p');
    expect(disk.has('/p/group')).toBe(true);
    await finishProjectFileRelocation('/p/original.png', '/p/new.png', '/p');
    expect(native.remove).not.toHaveBeenCalledWith('/p');
  });

  it('preserves the source when the target is missing or content size changed', async () => {
    await expect(finishProjectFileRelocation('/p/original.png', '/p/missing.png', '/p')).rejects.toThrow();
    disk.add('/p/new.png');
    native.lstat.mockResolvedValueOnce({ isFile: true, size: 99 });
    await expect(finishProjectFileRelocation('/p/original.png', '/p/new.png', '/p')).rejects.toThrow();
    expect(native.remove).not.toHaveBeenCalled();
  });

  it('rejects cleanup outside the project or through traversal paths', async () => {
    await expect(finishProjectFileRelocation('/elsewhere/a.png', '/p/new.png', '/p')).rejects.toThrow();
    await expect(finishProjectFileRelocation('/p/../a.png', '/p/new.png', '/p')).rejects.toThrow();
    expect(native.remove).not.toHaveBeenCalled();
  });
  it('allocates distinct destinations even before concurrent writers create their files', async () => {
    const paths = await Promise.all(Array.from({ length: 20 }, () => resolveUniqueDestPath('/p', 'result.png', true)));
    expect(new Set(paths).size).toBe(20);
    expect(paths).toEqual(Array.from({ length: 20 }, (_, i) => `/p/result${i ? `_${i}` : ''}.png`));
  });

  it('continues existing sequence numbers and preserves the extension', async () => {
    for (const path of ['/p/result_1.png', '/p/result_2.png']) disk.add(path);
    expect(await resolveUniqueDestPath('/p', 'result_1.png', true)).toBe('/p/result_3.png');
    expect(await resolveUniqueDestPath('/p', 'result.jpg', true)).toBe('/p/result.jpg');
  });

  it('keeps retired source names unavailable even after their files have moved away', async () => {
    native.retired.mockResolvedValue(new Set(['/p/result.png', '/p/result_1.png']));
    expect(await resolveUniqueDestPath('/p', 'result.png', true)).toBe('/p/result_2.png');
  });

  it('aborts allocation when the relocation journal cannot be read', async () => {
    native.retired.mockRejectedValueOnce(new Error('journal unavailable'));
    await expect(resolveUniqueDestPath('/p', 'result.png', true)).rejects.toThrow('journal unavailable');
    expect(native.copy).not.toHaveBeenCalled();
  });

  it('rechecks source names retired while allocation was checking the disk', async () => {
    native.retired.mockResolvedValue(new Set(['/p/result.png'])).mockResolvedValueOnce(new Set());
    expect(await resolveUniqueDestPath('/p', 'result.png', true)).toBe('/p/result_1.png');
  });

  it('releases an unwritten reservation when the final journal read fails', async () => {
    native.retired.mockResolvedValue(new Set()).mockResolvedValueOnce(new Set()).mockRejectedValueOnce(new Error('journal unavailable'));
    await expect(resolveUniqueDestPath('/p', 'result.png', true)).rejects.toThrow('journal unavailable');
    expect(await resolveUniqueDestPath('/p', 'result.png', true)).toBe('/p/result.png');
  });

  it('reserves Windows names regardless of path separators and casing', async () => {
    const paths = await Promise.all([
      resolveUniqueDestPath('C:/p', 'Result.png', true),
      resolveUniqueDestPath('c:\\p', 'result.PNG', true),
    ]);
    expect(paths).toEqual(['C:/p/Result.png', 'c:/p/result_1.PNG']);
  });

  it('does not duplicate an extension already included in the node label', () => {
    expect(buildNodeFileName('生成视频.mp4', '.mp4', 'video')).toBe('生成视频.mp4');
    expect(buildNodeFileName('粘贴图像.PNG', 'png', 'image')).toBe('粘贴图像.png');
  });

  it.each(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'nul.资料'])('makes the Windows reserved title %s writable without a hash', async (title) => {
    expect(await resolveUniqueDestPath('/p', `${title}.png`, true)).toBe(`/p/_${title}.png`);
    expect(await resolveUniqueDestPath('/p', `${title}.png`, true)).toBe(`/p/_${title}_1.png`);
  });

  it('does not change ordinary names or valid Unix device-like names', async () => {
    expect(await resolveUniqueDestPath('/p', 'CONNECTION.png', true)).toBe('/p/CONNECTION.png');
    vi.stubGlobal('navigator', { platform: 'Linux' });
    vi.resetModules();
    const unixCore = await import('../../src/services/fs/core');
    expect(await unixCore.resolveUniqueDestPath('/p', 'CON.png', true)).toBe('/p/CON.png');
  });

  it('makes legacy Windows device-like titles safe after removing their random suffix', async () => {
    expect(await resolveUniqueDestPath('/p', `CON--${'a'.repeat(32)}.png`, true)).toBe('/p/_CON.png');
  });

  it.each(['MacIntel', 'Darwin', 'Linux x86_64'])('allocates concurrent numbered files using POSIX paths on %s', async (platform) => {
    vi.stubGlobal('navigator', { platform });
    vi.resetModules();
    const platformCore = await import('../../src/services/fs/core');
    const paths = await Promise.all(Array.from({ length: 5 }, () => platformCore.resolveUniqueDestPath('/home/p', '结果.png', true)));
    expect(paths).toEqual(['/home/p/结果.png', '/home/p/结果_1.png', '/home/p/结果_2.png', '/home/p/结果_3.png', '/home/p/结果_4.png']);
    expect(await platformCore.resolveUniqueDestPath('/home/p', 'CON.png', true)).toBe('/home/p/CON.png');
  });

  it.each([
    ['MacIntel', '/home/p/result_1.PNG'],
    ['Linux x86_64', '/home/p/result.PNG'],
  ])('respects %s filename case semantics for simultaneous allocations', async (platform, expected) => {
    vi.stubGlobal('navigator', { platform });
    const paths = await Promise.all([
      resolveUniqueDestPath('/home/p', 'Result.png', true),
      resolveUniqueDestPath('/home/p', 'result.PNG', true),
    ]);
    expect(paths).toEqual(['/home/p/Result.png', expected]);
  });

  it.each([
    ['MacIntel', '/Users/p/Cafe\u0301_1.png'],
    ['Linux x86_64', '/Users/p/Cafe\u0301.png'],
  ])('respects %s Unicode filename semantics during concurrent generation', async (platform, expected) => {
    vi.stubGlobal('navigator', { platform });
    const paths = await Promise.all([
      resolveUniqueDestPath('/Users/p', 'Café.png', true),
      resolveUniqueDestPath('/Users/p', 'Cafe\u0301.png', true),
    ]);
    expect(paths).toEqual(['/Users/p/Café.png', expected]);
  });

  it('protects retired macOS aliases without rewriting another case-sensitive file', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    vi.stubGlobal('indexedDB', new IDBFactory());
    const journal = await vi.importActual<typeof import('../../src/services/indexedDb/mediaRelocations')>(
      '../../src/services/indexedDb/mediaRelocations');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    const move = { projectId: 'p', oldPath: '/Users/p/Café.png', newPath: '/Users/p/group/Café.png',
      assetUrl: 'asset://group', relativePath: 'group/Café.png' };
    await journal.persistMediaRelocation(move);
    await journal.completeMediaRelocation(move);
    native.retired.mockImplementation(journal.retiredMediaPaths);
    expect(await resolveUniqueDestPath('/Users/p', 'CAFE\u0301.PNG', true)).toBe('/Users/p/CAFE\u0301_1.PNG');
    const existing = { filePath: '/Users/p/café.png' };
    expect(journal.relocateMediaReferences(existing, [move])).toBe(existing);
    (await openDB()).close();
  });

  it('aborts allocation when checking the destination fails', async () => {
    native.exists.mockRejectedValueOnce(new Error('denied'));
    await expect(resolveUniqueDestPath('/p', 'result.png')).rejects.toThrow('denied');
  });

  it('ungroups an older result while a same-named newer result exists without replacing it', async () => {
    disk.add('/p/group/result.png');
    disk.add('/p/result.png');
    const result = await moveProjectFileToFolder('/p/group/result.png', '/p', null, { preserveSource: true });
    expect(result).toBe('/p/result_1.png');
    expect(disk.has('/p/result.png')).toBe(true);
    expect(disk.has('/p/group/result.png')).toBe(true);
  });

  it('ungroups several same-named files as separate sequential destinations', async () => {
    disk.add('/p/result.png');
    const sources = ['one', 'two', 'three'].map((folder) => `/p/${folder}/result.png`);
    for (const source of sources) disk.add(source);
    const results = await Promise.all(sources.map((source) => moveProjectFileToFolder(source, '/p', null, { preserveSource: true })));
    expect(results).toEqual(['/p/result_1.png', '/p/result_2.png', '/p/result_3.png']);
    for (const path of ['/p/result.png', ...sources, ...results]) expect(disk.has(path!)).toBe(true);
  });

  it('drops an old random suffix only when allocating a relocated result', async () => {
    const source = `/p/group/帧动画--${'a'.repeat(32)}.png`;
    disk.add(source);
    disk.add('/p/帧动画.png');
    expect(await moveProjectFileToFolder(source, '/p', null, { preserveSource: true })).toBe('/p/帧动画_1.png');
    expect(disk.has(source)).toBe(true);
  });
  it('puts two legacy shared images in one folder as independent files', async () => {
    const a = await moveProjectFileToFolder('/p/original.png', '/p', 'group', { preserveSource: true, forceCopy: true });
    const b = await moveProjectFileToFolder('/p/original.png', '/p', 'group', { preserveSource: true, forceCopy: true });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(disk.has(a!)).toBe(true);
    expect(disk.has(b!)).toBe(true);
    expect(disk.has('/p/original.png')).toBe(true);
    expect(native.rename).not.toHaveBeenCalled();
    expect(await moveProjectFileToFolder(a!, '/p', 'group', { preserveSource: true })).toBeNull();
  });

  it('leaves an outside reference and old history readable after moving between groups', async () => {
    const grouped = await moveProjectFileToFolder('/p/original.png', '/p', 'one', { preserveSource: true });
    const moved = await moveProjectFileToFolder(grouped!, '/p', 'two', { preserveSource: true });
    expect(disk.has('/p/original.png')).toBe(true);
    expect(disk.has(grouped!)).toBe(true);
    expect(disk.has(moved!)).toBe(true);
  });

  it('keeps grouped and ungrouped references distinct through persisted journals and restart', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const journal = await vi.importActual<typeof import('../../src/services/indexedDb/mediaRelocations')>(
      '../../src/services/indexedDb/mediaRelocations');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    const db = await openDB();
    native.retired.mockImplementation(journal.retiredMediaPaths);
    const original = { id: 'p', nodes: [{ id: 'old', data: {
      filePath: '/p/original.png', imageUrl: 'asset://original', prompt: '原提示词', tags: ['原标签'],
    } }] };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(original);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const grouped = await moveProjectFileToFolder('/p/original.png', '/p', 'group', { preserveSource: true });
    const intoGroup = { projectId: 'p', oldPath: '/p/original.png', newPath: grouped!, oldAssetUrl: 'asset://original', assetUrl: 'asset://group', relativePath: 'group/original.png' };
    await journal.persistMediaRelocation(intoGroup);
    await finishProjectFileRelocation(intoGroup.oldPath, intoGroup.newPath, '/p');
    await journal.completeMediaRelocation(intoGroup);
    const outside = await resolveUniqueDestPath('/p', 'original.png', true);
    expect(outside).toBe('/p/original_1.png');
    disk.add(outside);
    const ungrouped = await moveProjectFileToFolder(grouped!, '/p', null, { preserveSource: true });
    expect(ungrouped).toBe('/p/original_2.png');
    const outOfGroup = { projectId: 'p', oldPath: grouped!, newPath: ungrouped!, oldAssetUrl: 'asset://group', assetUrl: 'asset://ungrouped', relativePath: 'original_2.png' };
    await journal.persistMediaRelocation(outOfGroup);
    await finishProjectFileRelocation(outOfGroup.oldPath, outOfGroup.newPath, '/p');
    await journal.completeMediaRelocation(outOfGroup);
    const lateSave = { ...original, nodes: [...original.nodes, { id: 'new', data: {
      filePath: outside, imageUrl: 'asset://outside', prompt: '新提示词', tags: ['新标签'],
    } }] };
    const saved = await new Promise<typeof lateSave>((resolve, reject) => {
      const tx = db.transaction(['projects', 'metadata'], 'readwrite');
      let result = lateSave;
      journal.withRelocatedMedia(tx, lateSave, (value) => {
        result = value;
        tx.objectStore('projects').put(value);
      });
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
    });
    expect(saved.nodes.map((node) => node.data)).toEqual([
      { filePath: ungrouped, imageUrl: 'asset://ungrouped', relativePath: 'original_2.png', prompt: '原提示词', tags: ['原标签'] },
      { filePath: outside, imageUrl: 'asset://outside', prompt: '新提示词', tags: ['新标签'] },
    ]);
    expect(disk.has(outside)).toBe(true);
    expect(disk.has(ungrouped!)).toBe(true);
    db.close();
    vi.resetModules();
    const reopened = await vi.importActual<typeof import('../../src/services/indexedDb/mediaRelocations')>(
      '../../src/services/indexedDb/mediaRelocations');
    native.retired.mockImplementation(reopened.retiredMediaPaths);
    const freshCore = await import('../../src/services/fs/core');
    expect(await freshCore.resolveUniqueDestPath('/p', 'original.png', true)).toBe('/p/original_3.png');
    const freshSchema = await import('../../src/services/indexedDb/schema');
    (await freshSchema.openDB()).close();
  });

  it.each([{}, { moves: [{}] }, { moves: [{ oldPath: '' }] }])('stops allocation on a malformed persisted journal: %j', async (record) => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const journal = await vi.importActual<typeof import('../../src/services/indexedDb/mediaRelocations')>(
      '../../src/services/indexedDb/mediaRelocations');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put({ id: 'media-relocations', ...record });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    native.retired.mockImplementation(journal.retiredMediaPaths);
    await expect(resolveUniqueDestPath('/p', 'new.png', true)).rejects.toThrow('文件引用迁移记录损坏');
    expect(native.copy).not.toHaveBeenCalled();
    db.close();
  });
});
