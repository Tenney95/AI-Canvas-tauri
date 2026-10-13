import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripVerbatimPrefix } from '../../src/services/fs/core';
import type { AssetFileEntry } from '../../src/services/fileService';
import { relocateMediaReferences } from '../../src/services/indexedDb/mediaRelocations';

const mocks = vi.hoisted(() => ({
  getProjectDataDir: vi.fn(),
  rename: vi.fn(),
  resolveUniqueDestPath: vi.fn(),
  exists: vi.fn(), lstat: vi.fn(), identify: vi.fn(), index: vi.fn(), persist: vi.fn(), complete: vi.fn(),
  readText: vi.fn(), fingerprint: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mocks.exists,
  lstat: mocks.lstat,
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  rename: mocks.rename,
  stat: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: vi.fn(), localDataDir: vi.fn() }));
vi.mock('../../src/services/fs/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/fs/core')>();
  return {
    ...actual,
    CATEGORY_EXTENSIONS: {},
    arrayBufferToBase64: vi.fn(),
    buildNodeFileName: (label: string, ext: string) => `${label}${ext}`,
    ensureProjectDataDir: vi.fn(),
    getConvertFileSrc: () => (path: string) => `asset://${path}`,
    getAssetUrlFromPath: async (path: string) => `asset://${path}`,
    getFileCategory: vi.fn(),
    getMimeType: vi.fn(),
    getProjectDataDir: mocks.getProjectDataDir,
    isTauriEnv: () => true,
    joinPath: (...parts: string[]) => parts.join('/'),
    notifyProjectDiskChanged: vi.fn(),
    resolveUniqueDestPath: mocks.resolveUniqueDestPath,
    sanitizeFileName: (name: string) => name,
    sanitizeFolderName: (name: string) => name,
  };
});
vi.mock('../../src/services/fs/assetTextFiles', () => ({ readAssetTextFile: mocks.readText }));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({ fingerprintAssetImage: mocks.fingerprint }));
vi.mock('../../src/services/fs/assetIndex', async (original) => ({
  ...await original<typeof import('../../src/services/fs/assetIndex')>(), identifyAsset: mocks.identify,
}));
vi.mock('../../src/services/indexedDbService', () => ({
  getAssetIndexById: mocks.index, getAssetIndexByPath: mocks.index,
  savePresetFolderToDb: vi.fn().mockResolvedValue(undefined),
  loadPresetFoldersFromDb: vi.fn().mockResolvedValue([]),
  deletePresetFolderFromDb: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/indexedDb/mediaRelocations', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/mediaRelocations')>(),
  persistMediaRelocation: mocks.persist, completeMediaRelocation: mocks.complete,
}));
vi.mock('../../src/services/fs/assetLibrary', async (original) => ({
  ...await original<typeof import('../../src/services/fs/assetLibrary')>(), getGlobalFilesDir: async () => 'D:/library',
}));

import { renameAssetFile, renameProjectFileToLabel } from '../../src/services/fileService';

const PROJECT_DIR = 'F:\\素材\\项目 3-45b922a1';

describe('stripVerbatimPrefix', () => {
  it('去掉 Windows canonicalize 留下的 \\\\?\\ 前缀，其它路径原样返回', () => {
    expect(stripVerbatimPrefix('\\\\?\\F:\\素材\\a.png')).toBe('F:\\素材\\a.png');
    expect(stripVerbatimPrefix('//?/F:/素材/a.png')).toBe('F:/素材/a.png');
    expect(stripVerbatimPrefix('\\\\?\\UNC\\nas\\share\\a.png')).toBe('\\\\nas\\share\\a.png');
    expect(stripVerbatimPrefix('F:\\素材\\a.png')).toBe('F:\\素材\\a.png');
    expect(stripVerbatimPrefix('/home/me/a.png')).toBe('/home/me/a.png');
  });
});

describe('资源文件改名', () => {
  const document = (name = '原文.md'): AssetFileEntry => ({
    name, path: `D:/library/${name}`, category: 'text', source: 'global', size: 4, assetId: 'document-id', tags: ['剧本'],
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exists.mockResolvedValue(false);
    mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: false, mtime: new Date(20) });
    mocks.identify.mockResolvedValue({ assetId: 'document-id' });
    mocks.index.mockResolvedValue(undefined);
    mocks.readText.mockResolvedValue({ digest: 'text-digest', size: 4, content: '正文' });
    mocks.fingerprint.mockResolvedValue({ digest: 'image-digest', bytes: 4 });
    mocks.rename.mockResolvedValue(undefined);
    mocks.persist.mockResolvedValue(undefined);
    mocks.complete.mockResolvedValue(undefined);
  });
  it.each(['txt', 'md', 'markdown', 'json'])('保留 .%s 扩展名、资产身份及标签，并同步节点路径和名称', async (extension) => {
    const file = document(`原文.${extension}`);
    const nodes = [{ data: { type: extension === 'txt' ? 'ai-text' : 'ai-markdown', label: '旧标题', filePath: file.path, output: '正文' } }];
    const relocated = vi.fn((move) => relocateMediaReferences(nodes, [move]));
    const result = await renameAssetFile(file, '新文档', undefined, [], relocated);
    expect(result.file).toMatchObject({ name: `新文档.${extension}`, path: `D:/library/新文档.${extension}`, assetId: file.assetId, tags: file.tags });
    expect(mocks.rename).toHaveBeenCalledWith(file.path, result.file.path);
    expect(mocks.readText).toHaveBeenCalledWith(file.path);
    expect(mocks.fingerprint).not.toHaveBeenCalled();
    expect(relocated.mock.results[0].value[0].data).toMatchObject({ filePath: result.file.path, label: result.file.name, output: '正文' });
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ renamedFileName: result.file.name, assetMove: expect.objectContaining({ assetId: file.assetId, digest: 'text-digest' }) }));
  });
  it('空文本可以改名，输入原扩展名不会重复追加', async () => {
    mocks.readText.mockResolvedValue({ digest: 'empty-digest', size: 0, content: '' });
    await expect(renameAssetFile(document(), '空文档.md', undefined, [], vi.fn())).resolves.toMatchObject({ file: { name: '空文档.md' } });
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ assetMove: expect.objectContaining({ totalBytes: 0 }) }));
  });
  it('图片仍使用原有内容指纹', async () => {
    await renameAssetFile({ ...document('原图.png'), category: 'image' }, '新图', undefined, [], vi.fn());
    expect(mocks.fingerprint).toHaveBeenCalledOnce();
    expect(mocks.readText).not.toHaveBeenCalled();
  });
  it('项目文档就地改名，保留项目归属和子目录相对路径', async () => {
    mocks.getProjectDataDir.mockResolvedValue('D:/project');
    const file = { ...document(), source: 'project' as const, path: 'D:/project/笔记/原文.md' };
    await expect(renameAssetFile(file, '新文档', 'p', [], vi.fn())).resolves.toMatchObject({ file: { path: 'D:/project/笔记/新文档.md', relativePath: '笔记/新文档.md' } });
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p', renamedFileName: '新文档.md' }));
    expect(mocks.persist.mock.calls[0][0]).not.toHaveProperty('assetMove');
  });
  it.each([`director/previs/${'a'.repeat(64)}.json`, `director/scenes/s/scene-r1-${'a'.repeat(64)}.json`,
    `director/scenes/s/results/manifest-r1-${'a'.repeat(64)}.json`, `ai-apps/${'a'.repeat(64)}.json`])('内部不可变 JSON 保留原名：%s', async (relativePath) => {
    mocks.getProjectDataDir.mockResolvedValue('D:/project');
    const file = { ...document(relativePath.split('/').pop()!), source: 'project' as const, path: `D:/project/${relativePath}` };
    await expect(renameAssetFile(file, '镜头预演', 'p', [], vi.fn())).rejects.toThrow('由应用内部管理');
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it('目标重名时保留原文件', async () => {
    mocks.exists.mockResolvedValue(true);
    await expect(renameAssetFile(document(), '新文档', undefined, [], vi.fn())).rejects.toThrow('已有同名文件');
    expect(mocks.rename).not.toHaveBeenCalled();
  });
  it('引用提交失败时恢复原名，不提交内存引用', async () => {
    mocks.persist.mockRejectedValueOnce(new Error('database failure'));
    const relocated = vi.fn();
    await expect(renameAssetFile(document(), '新文档', undefined, [], relocated)).rejects.toThrow('已恢复磁盘原文件名');
    expect(mocks.rename.mock.calls).toEqual([['D:/library/原文.md', 'D:/library/新文档.md'], ['D:/library/新文档.md', 'D:/library/原文.md']]);
    expect(relocated).not.toHaveBeenCalled();
  });
  it.each([{ availability: 'offline' as const }, { category: 'video' as const }, { path: 'D:/outside/原文.md' }])('拒绝不可用文件或未登记目录：%o', async (change) => {
    await expect(renameAssetFile({ ...document(), ...change }, '新文档', undefined, [], vi.fn())).rejects.toThrow();
    expect(mocks.rename).not.toHaveBeenCalled();
  });
  it('符号链接不改名', async () => {
    mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: true });
    await expect(renameAssetFile(document(), '新文档', undefined, [], vi.fn())).rejects.toThrow('普通');
    expect(mocks.rename).not.toHaveBeenCalled();
  });
});

describe('renameProjectFileToLabel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectDataDir.mockResolvedValue(PROJECT_DIR);
    mocks.resolveUniqueDestPath.mockImplementation(
      async (dir: string, fileName: string) => `${dir}/${fileName}`,
    );
  });

  it('重命名带 \\\\?\\ 前缀的路径（原生命令返回的形式）', async () => {
    const result = await renameProjectFileToLabel(
      `\\\\?\\${PROJECT_DIR}\\生成图像_4.png`,
      'H 氢 · 蜂鸟速射手',
      'project-1',
    );

    expect(mocks.rename).toHaveBeenCalledWith(
      `\\\\?\\${PROJECT_DIR}\\生成图像_4.png`,
      'F:/素材/项目 3-45b922a1/H 氢 · 蜂鸟速射手.png',
    );
    expect(result?.fileName).toBe('H 氢 · 蜂鸟速射手.png');
  });

  it('分组子文件夹内的文件就地改名，不搬回项目根目录', async () => {
    const result = await renameProjectFileToLabel(
      `${PROJECT_DIR}\\分组A\\生成图像_8.png`,
      '角色立绘',
      'project-1',
    );

    expect(result?.filePath).toBe('F:/素材/项目 3-45b922a1/分组A/角色立绘.png');
  });

  it('项目目录外的文件不动', async () => {
    const result = await renameProjectFileToLabel('D:\\别处\\a.png', 'b', 'project-1');
    expect(result).toBeNull();
    expect(mocks.rename).not.toHaveBeenCalled();
  });
});
