/**
 * assetRepair — 回归测试：asset repair validation and commit boundary。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';
const io = vi.hoisted(() => ({ indexes: vi.fn(), index: vi.fn(), images: vi.fn(), lstat: vi.fn(), stat: vi.fn(),
  open: vi.fn(), hash: vi.fn(), persist: vi.fn(), copy: vi.fn(), mkdir: vi.fn(), notify: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ lstat: io.lstat, stat: io.stat, mkdir: io.mkdir }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: io.open }));
vi.mock('../../src/services/indexedDbService', () => ({ getAllAssetIndexes: io.indexes, getAssetIndexById: io.index, getAssetImageRecords: io.images }));
vi.mock('../../src/services/indexedDb/mediaRelocations', () => ({ persistAssetRepairBatch: io.persist, retiredMediaPaths: async () => new Set() }));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({ fingerprintAssetImage: io.hash }));
vi.mock('../../src/services/fileService', () => ({ copyAssetFileToFolder: io.copy }));
vi.mock('../../src/services/fs/assetLibrary', () => ({ getGlobalFilesDir: async () => '/global' }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true, joinPath: (...parts: string[]) => parts.join('/'),
  stripVerbatimPrefix: (path: string) => path, getAssetUrlFromPath: async (path: string) => `asset://localhost/${path}`,
  getProjectDataDir: async () => '/project', notifyProjectDiskChanged: io.notify,
  getFileCategory: (path: string) => path.endsWith('.png') ? 'image' : path.endsWith('.mp4') ? 'video' : 'other' }));
import { applyAssetRepairs, listUnavailableAssetIndexes, previewAssetRepair, type AssetRepairPreview } from '../../src/services/fs/assetRepair';
const digest = 'a'.repeat(64);
const index: AssetIndexRecord = { assetId: 'a', path: '/old/image.png', relativePath: 'image.png', rootPath: '/old',
  source: 'folder', size: 3, mtimeMs: 10, fingerprint: '3:10', status: 'online', updatedAt: 1 };
const info = { isFile: true, isSymlink: false, size: 3, mtime: new Date(10) };
beforeEach(() => {
  vi.clearAllMocks(); io.indexes.mockResolvedValue([index]); io.index.mockResolvedValue(index); io.images.mockResolvedValue([]);
  io.lstat.mockImplementation(async (path: string) => { if (path.startsWith('/old/')) throw new Error('ENOENT'); return info; });
  io.stat.mockResolvedValue(info); io.open.mockResolvedValue('/new/image.png'); io.hash.mockResolvedValue({ bytes: 3, digest });
  io.persist.mockResolvedValue(undefined); io.mkdir.mockResolvedValue(undefined);
});
describe('asset repair validation and commit boundary', () => {
  it('失效索引隐藏原生暂存件，不掩盖普通 pending 和真实素材缺失', async () => {
    const hash = 'a'.repeat(64);
    const records = [`.native-media-${hash}.pending`, `.native-media-${hash}.mp4.pending`, 'ordinary.pending', '.notes', 'image.png']
      .map((name, ordinal) => ({ ...index, assetId: `asset-${ordinal}`, path: `/old/${name}`, relativePath: name }));
    io.indexes.mockResolvedValue(records);
    const result = await listUnavailableAssetIndexes({ kind: 'all' });
    expect(result.candidates.map((candidate) => candidate.index.relativePath)).toEqual(['ordinary.pending', '.notes', 'image.png']);
    expect(result.candidates.every((candidate) => candidate.status === 'missing')).toBe(true);
    expect(result.truncated).toBe(false);
    for (const record of records.slice(0, 2)) expect(io.lstat).not.toHaveBeenCalledWith(record.path);
    expect(records).toHaveLength(5);
    expect(io.persist).not.toHaveBeenCalled();
  });

  it('does not turn permission failures into missing files', async () => {
    io.lstat.mockRejectedValue(new Error('Permission denied'));
    expect((await listUnavailableAssetIndexes({ kind: 'all' })).candidates[0]).toMatchObject({ status: 'error' });
  });
  it('does not reject a large mostly-online library before finding its one missing file', async () => {
    io.indexes.mockResolvedValue([...Array.from({ length: 510 }, (_, id) => ({ ...index, assetId: `online-${id}`, path: `/online/${id}.png` })), index]);
    const result = await listUnavailableAssetIndexes({ kind: 'all' });
    expect(result.truncated).toBe(false);
    expect(result.candidates.filter((candidate) => candidate.status !== 'online')).toHaveLength(1);
  });
  it('labels legacy records as metadata-only and rejects a known digest mismatch', async () => {
    const target = { kind: 'file' as const, assetId: 'a', path: index.path, name: '图' };
    expect((await previewAssetRepair(target))?.candidates[0]).toMatchObject({ status: 'ready', match: 'metadata' });
    io.indexes.mockResolvedValue([{ ...index, contentDigest: 'b'.repeat(64) }]);
    expect((await previewAssetRepair(target))?.candidates[0].status).toBe('error');
    expect(io.persist).not.toHaveBeenCalled();
  });
  it('maps a chosen directory by exact relative path instead of searching same-named files', async () => {
    io.open.mockResolvedValue('/new');
    io.lstat.mockImplementation(async (path: string) => {
      if (path.startsWith('/old/')) throw new Error('ENOENT');
      return path === '/new' ? { isDirectory: true, isSymlink: false } : info;
    });
    io.indexes.mockResolvedValue([{ ...index, path: '/old/sub/image.png', relativePath: 'sub/image.png' }]);
    expect((await previewAssetRepair({ kind: 'folder', path: '/old', name: '旧目录' }))?.candidates[0].targetPath).toBe('/new/sub/image.png');
  });
  it('rejects two selected identities targeting one new file before writing anything', async () => {
    const preview: AssetRepairPreview = { target: { kind: 'all' }, candidates: ['a', 'b'].map((assetId) => ({
      index: { ...index, assetId }, status: 'ready', match: 'metadata', digest, targetPath: '/new/image.png', targetRoot: '/new',
    })) };
    await expect(applyAssetRepairs(preview, ['a', 'b'], ['/new'], vi.fn())).rejects.toThrow('同一个目标');
    expect(io.persist).not.toHaveBeenCalled(); expect(io.copy).not.toHaveBeenCalled();
  });
  it('keeps the committed repair even if the caller cancels as the transaction resolves', async () => {
    const controller = new AbortController();
    io.persist.mockImplementation(async () => { controller.abort(); });
    const preview: AssetRepairPreview = { target: { kind: 'all' }, candidates: [{ index, status: 'ready', match: 'metadata',
      digest, targetPath: '/new/image.png', targetRoot: '/new' }] };
    const committed = vi.fn();
    expect(await applyAssetRepairs(preview, ['a'], ['/new'], committed, { signal: controller.signal })).toBe(1);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(io.persist.mock.calls[0][0][0]).toMatchObject({ oldPath: index.path, newPath: '/new/image.png', assetMove: { assetId: 'a', source: 'folder', repair: true } });
  });
});
