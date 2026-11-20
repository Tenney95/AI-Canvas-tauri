/**
 * assetFileMove — 回归测试：资产文件夹拖放服务。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetFileEntry } from '../../src/services/fs/core';
import type { MediaRelocation } from '../../src/services/indexedDb/mediaRelocations';

const mocks = vi.hoisted(() => ({
  copy: vi.fn(), plan: vi.fn(), finish: vi.fn(), persist: vi.fn(), complete: vi.fn(), pending: vi.fn(), identify: vi.fn(),
  resolve: vi.fn(), stat: vi.fn(), index: vi.fn(), targetIndex: vi.fn(), order: [] as string[],
}));
vi.mock('../../src/services/fileService', () => ({ copyAssetFileToFolder: mocks.copy, finishAssetFileMove: mocks.finish }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: mocks.stat, exists: async () => false }));
vi.mock('../../src/services/indexedDbService', () => ({ getAssetIndexById: mocks.index, getAssetIndexByPath: mocks.targetIndex }));
vi.mock('../../src/services/indexedDb/mediaRelocations', () => ({
  persistMediaRelocation: mocks.persist, completeMediaRelocation: mocks.complete, pendingMediaRelocations: mocks.pending, prepareAssetMoveCopy: mocks.plan,
  releaseAssetMoveCopy: vi.fn(),
  mediaFileAllocationKey: (path: string) => path.replace(/\\/g, '/').toLowerCase(), pendingAssetMoveTargets: async () => new Set(),
}));
vi.mock('../../src/services/fs/assetLibrary', () => ({ getGlobalFilesDir: async () => 'D:/data/file', resolveAssetFolderDirectory: mocks.resolve }));
vi.mock('../../src/services/fs/core', () => ({ getAssetUrlFromPath: async (path: string) => `asset://${path}`,
  stripVerbatimPrefix: (path: string) => path.replace(/^\\\\\?\\/, ''), notifyProjectDiskChanged: vi.fn() }));
vi.mock('../../src/services/fs/assetIndex', async () => ({
  getRelativeAssetPath: (await vi.importActual<typeof import('../../src/services/fs/assetIndex')>('../../src/services/fs/assetIndex')).getRelativeAssetPath,
  identifyAsset: mocks.identify,
}));
import { importAssetFilesToFolder, moveAssetFile } from '../../src/services/fs/assetFileMove';

const file: AssetFileEntry = { name: '图.png', path: 'D:/assets/图.png', category: 'image', size: 4, source: 'folder', assetId: 'stable-id' };
const target = { kind: 'folder' as const, rootPath: 'D:/assets', relativePath: '人物' };
const copied = { path: 'D:/assets/人物/图 (1).png', totalBytes: 4, digest: 'a'.repeat(64) };
beforeEach(() => {
  vi.resetAllMocks(); mocks.order = [];
  mocks.pending.mockResolvedValue([]);
  mocks.resolve.mockResolvedValue('D:/assets/人物');
  mocks.stat.mockResolvedValue({ mtime: new Date(20) });
  mocks.identify.mockResolvedValue({ assetId: 'stable-id' });
  mocks.index.mockResolvedValue(undefined);
  mocks.copy.mockImplementation(async (_path, _directory, _options, mode) => {
    mocks.order.push(mode?.kind === 'plan' ? 'plan' : 'copy');
    return copied;
  });
  mocks.plan.mockImplementation(async (_id, _path, _directory, copy) => {
    mocks.order.push('reserve');
    return { copy, resume: false };
  });
  mocks.persist.mockImplementation(async () => { mocks.order.push('persist'); });
  mocks.finish.mockImplementation(async () => { mocks.order.push('recycle'); });
  mocks.complete.mockImplementation(async () => { mocks.order.push('complete'); });
});

describe('资产文件夹拖放服务', () => {
  it('先复制校验、提交引用、更新内存，最后回收；保留稳定身份', async () => {
    let relocated: MediaRelocation | undefined;
    await expect(moveAssetFile(file, target, ['D:/assets'], (move) => { relocated = move; mocks.order.push('memory'); })).resolves.toEqual({ path: copied.path, moved: true });
    expect(mocks.order).toEqual(['plan', 'reserve', 'copy', 'persist', 'memory', 'recycle', 'complete']);
    expect(mocks.identify).toHaveBeenCalledWith(file.path, expect.objectContaining({ assetId: 'stable-id', rootPath: 'D:/assets' }));
    expect(relocated).toMatchObject({ oldPath: file.path, newPath: copied.path, relativePath: '人物/图 (1).png',
      assetMove: { rootPath: 'D:/assets', source: 'folder', digest: copied.digest, mtimeMs: 20 } });
    expect(mocks.finish).toHaveBeenCalledWith(file.path, copied);
  });
  it('同目录（含 Windows 大小写和分隔符差异）不创建副本', async () => {
    mocks.resolve.mockResolvedValue('d:\\ASSETS');
    await expect(moveAssetFile(file, target, ['D:/assets'], vi.fn())).resolves.toMatchObject({ moved: false });
    expect(mocks.copy).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled();
  });
  it('已移动的过期卡片不重新绑定旧身份或移动后来同名的新文件', async () => {
    mocks.index.mockResolvedValue({ assetId: 'stable-id', path: copied.path });
    await expect(moveAssetFile(file, target, ['D:/assets'], vi.fn())).rejects.toThrow('资产位置已变化');
    expect(mocks.identify).not.toHaveBeenCalled(); expect(mocks.copy).not.toHaveBeenCalled();
  });
  it.each(['copy', 'persist'] as const)('%s 失败不回收原件、不提交内存引用', async (stage) => {
    mocks[stage].mockRejectedValueOnce(new Error('failure'));
    const relocated = vi.fn();
    await expect(moveAssetFile(file, target, ['D:/assets'], relocated)).rejects.toThrow('failure');
    expect(mocks.finish).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled(); expect(relocated).not.toHaveBeenCalled();
  });
  it('回收失败留下已提交日志，重试不重复复制', async () => {
    mocks.finish.mockRejectedValueOnce(new Error('busy'));
    await expect(moveAssetFile(file, target, ['D:/assets'], vi.fn())).rejects.toThrow('busy');
    const pending = mocks.persist.mock.calls[0][0] as MediaRelocation;
    expect(mocks.complete).not.toHaveBeenCalled();
    mocks.pending.mockResolvedValue([pending]);
    await moveAssetFile(file, target, ['D:/assets'], vi.fn());
    expect(mocks.copy).toHaveBeenCalledTimes(2); expect(mocks.persist).toHaveBeenCalledTimes(1); expect(mocks.complete).toHaveBeenCalledWith(pending);
  });
  it('副本完成时取消不迁移或回收原件', async () => {
    const controller = new AbortController();
    mocks.copy.mockResolvedValueOnce(copied).mockImplementationOnce(async () => { controller.abort(); return copied; });
    await expect(moveAssetFile(file, target, ['D:/assets'], vi.fn(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.persist).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('复制后登记失败，重试只核对第一次登记的副本', async () => {
    mocks.stat.mockRejectedValueOnce(new Error('busy'));
    await expect(moveAssetFile(file, target, ['D:/assets'], vi.fn())).rejects.toThrow('busy');
    mocks.plan.mockResolvedValueOnce({ copy: copied, resume: true });
    await moveAssetFile(file, target, ['D:/assets'], vi.fn());
    expect(mocks.copy).toHaveBeenLastCalledWith(file.path, 'D:/assets/人物', undefined, { kind: 'publish', copy: copied, resume: true });
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(file.path, copied);
  });
  it('原计划的文件被替换时另选目标，保留占用文件', async () => {
    const next = { ...copied, path: 'D:/assets/人物/图 (2).png' };
    mocks.plan.mockResolvedValueOnce({ copy: copied, resume: true }).mockResolvedValueOnce({ copy: next, resume: false });
    mocks.copy.mockResolvedValueOnce(next).mockRejectedValueOnce('asset-move-target-occupied').mockResolvedValueOnce(next).mockResolvedValueOnce(next);
    await expect(moveAssetFile(file, target, ['D:/assets'], vi.fn())).resolves.toEqual({ path: next.path, moved: true });
    expect(mocks.plan).toHaveBeenLastCalledWith(file.assetId, file.path, 'D:/assets/人物', next, copied);
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(file.path, next);
  });
  it.each([{ source: 'project' as const }, { availability: 'offline' as const }, { category: 'video' as const }, { path: 'virtual://image' }, { path: 'D:/other/a.png' }])('拒绝非全局在线图片或未登记来源 %o', async (change) => {
    await expect(moveAssetFile({ ...file, ...change }, target, ['D:/assets'], vi.fn())).rejects.toThrow();
    expect(mocks.copy).not.toHaveBeenCalled();
  });
  it('外部多个文件复制导入并去重，从不回收或迁移原文件引用', async () => {
    await expect(importAssetFilesToFolder(['E:/a.png', 'E:/a.png', 'E:/b.mp4'], target, ['D:/assets'])).resolves.toBe(2);
    expect(mocks.copy.mock.calls.map((call) => call[0])).toEqual(['E:/a.png', 'E:/b.mp4']);
    expect(mocks.identify).toHaveBeenCalledWith(copied.path, { rootPath: 'D:/assets', source: 'folder' });
    expect(mocks.finish).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled();
  });
  it('外部导入取消后不再复制下一文件，已完成文件仍登记', async () => {
    const controller = new AbortController();
    mocks.identify.mockImplementationOnce(async () => { controller.abort(); });
    await expect(importAssetFilesToFolder(['E:/a.png', 'E:/b.png'], target, ['D:/assets'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.copy).toHaveBeenCalledTimes(1); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('聚合或失效目录在复制前拒绝', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('请选择具体文件夹'));
    await expect(importAssetFilesToFolder(['E:/a.png'], { kind: 'all' }, [])).rejects.toThrow('请选择具体文件夹');
    expect(mocks.copy).not.toHaveBeenCalled();
  });
});
