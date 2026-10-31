/** 资源搜索的总并发、增量展示、重叠来源优先级与取消回归。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetFileEntry, AssetScanOptions } from '../../src/services/fileService';
const scans = vi.hoisted(() => ({ project: vi.fn(), global: vi.fn(), folder: vi.fn() }));
vi.mock('../../src/services/fileService', () => ({
  listProjectFiles: scans.project, listGlobalFiles: scans.global, listExternalFolderContents: scans.folder,
}));
import { loadAssetSearchFiles } from '../../src/services/assetSearchService';

const file = (path: string): AssetFileEntry => ({ name: path, path, size: 1, category: 'image' });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  scans.global.mockResolvedValue([]);
  scans.folder.mockResolvedValue({ files: [] });
});

describe('asset search scanning', () => {
  it('shows the first result before completion and caps total source concurrency at three', async () => {
    const pending = gate();
    let active = 0;
    let maximum = 0;
    scans.project.mockImplementation(async (id: string, options: AssetScanOptions) => {
      maximum = Math.max(maximum, ++active);
      const files = [file(id)];
      options.onFiles?.(files);
      await pending.promise;
      active--;
      return files;
    });
    const publish = vi.fn();
    const result = loadAssetSearchFiles(Array.from({ length: 5 }, (_, index) => ({ id: `${index}`, name: `${index}` })), [], {
      signal: new AbortController().signal, onFiles: publish,
    });
    expect(scans.project).toHaveBeenCalledTimes(3);
    expect(scans.global).not.toHaveBeenCalled();
    expect(publish.mock.calls[0][0]).toMatchObject([{ projectId: '0' }]);
    pending.resolve();
    expect((await result).map((entry) => entry.projectId)).toEqual(['0', '1', '2', '3', '4']);
    expect(maximum).toBe(3);
  });

  it('preserves project priority even when overlapping global and folder scans finish first', async () => {
    const pending = gate();
    scans.project.mockImplementation(async () => { await pending.promise; return [file('/same')]; });
    scans.global.mockResolvedValue([{ ...file('/same'), source: 'global' }]);
    scans.folder.mockResolvedValue({ files: [{ ...file('/same'), source: 'folder', folderRoot: '/' }] });
    const result = loadAssetSearchFiles([{ id: 'project', name: '项目' }], ['/'], {
      signal: new AbortController().signal, onFiles: vi.fn(),
    });
    await Promise.resolve();
    pending.resolve();
    expect(await result).toMatchObject([{ path: '/same', projectId: 'project', source: 'project' }]);
  });

  it('drops late results and stops scheduling sources after cancellation', async () => {
    const pending = gate();
    scans.project.mockImplementation(async (_id: string, options: AssetScanOptions) => {
      await pending.promise;
      options.onFiles?.([file('/late')]);
      return [file('/late')];
    });
    const controller = new AbortController();
    const publish = vi.fn();
    const result = loadAssetSearchFiles(Array.from({ length: 6 }, (_, index) => ({ id: `${index}`, name: `${index}` })), [], {
      signal: controller.signal, onFiles: publish,
    });
    controller.abort();
    pending.resolve();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(scans.project).toHaveBeenCalledTimes(3);
    expect(publish).not.toHaveBeenCalled();
  });
});
