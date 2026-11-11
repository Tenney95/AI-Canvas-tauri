/**
 * fileServiceSkillUpload — 回归测试：Skill 压缩包上传。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('C:/app-data'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  ...mocks,
  lstat: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  watch: vi.fn(),
}));

import { uploadSkillFile } from '../../src/services/fs/skillFiles';

const SOURCE = 'D:/skills/示例';
const DEST = 'C:/app-data/skill/示例';
const ENTRY = '# 示例 Skill\n请读取 references/详细/checklist.md';
const RESOURCE = '中文检查清单';

function captureExpectedImportError() {
  const originalError = console.error.bind(console);
  return vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args.length !== 1 || args[0] !== '[Skill 上传] 导入失败') originalError(...args);
  });
}

beforeEach(() => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  vi.clearAllMocks();
  mocks.open.mockReset().mockResolvedValue(SOURCE);
  mocks.exists.mockReset().mockResolvedValue(false);
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
  mocks.readDir.mockReset().mockResolvedValue([]);
  mocks.readFile.mockReset().mockResolvedValue(new TextEncoder().encode(ENTRY));
  mocks.writeFile.mockReset().mockResolvedValue(undefined);
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.invoke.mockReset().mockResolvedValue([
    { relativePath: '示例/SKILL.md', content: ENTRY },
    { relativePath: '示例/references/详细/checklist.md', content: RESOURCE },
  ]);
});

describe('Skill 压缩包上传', () => {
  it.each(['zip', 'tar.gz', 'tgz', 'ZIP', 'TAR.GZ'])('支持 .%s，去掉包装目录并保留相对资料路径', async (extension) => {
    const archivePath = `${SOURCE}/示例.${extension}`;
    mocks.open.mockResolvedValue(archivePath);
    await expect(uploadSkillFile('file')).resolves.toEqual({
      fileName: '示例',
      content: ENTRY,
      sourceType: 'folder',
      storagePath: DEST,
      entryFileName: 'SKILL.md',
    });
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ name: 'Skill 文件或压缩包', extensions: ['md', 'txt', 'json', 'zip', 'tar.gz', 'tgz'] }],
    }));
    expect(mocks.invoke).toHaveBeenCalledWith('read_skill_archive', { archivePath });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(`${DEST}/SKILL.md`, new TextEncoder().encode(ENTRY));
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `${DEST}/references/详细/checklist.md`, new TextEncoder().encode(RESOURCE),
    );
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });

  it('优先选择根入口，附属资料不改变入口选择', async () => {
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValue([
      { relativePath: 'references/SKILL.md', content: RESOURCE },
      { relativePath: 'SKILL.md', content: ENTRY },
    ]);
    await expect(uploadSkillFile('file')).resolves.toMatchObject({ content: ENTRY, entryFileName: 'SKILL.md' });
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });

  it('缺少 SKILL.md 时沿用文件夹导入的 Markdown 入口回退', async () => {
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValue([{ relativePath: 'demo/README.md', content: ENTRY }]);
    await expect(uploadSkillFile('file')).resolves.toMatchObject({ content: ENTRY, entryFileName: 'README.md' });
  });

  it('分别打包的多个 Skill 不会静默丢失', async () => {
    const errorSpy = captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValue([
      { relativePath: 'one/SKILL.md', content: ENTRY },
      { relativePath: 'two/SKILL.md', content: RESOURCE },
    ]);
    await expect(uploadSkillFile('file')).rejects.toThrow('压缩包包含多个独立 Skill，请分别打包上传');
    expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });

  it.each([
    { paths: ['../SKILL.md'] },
    { paths: ['SKILL.md', 'skill.md'] },
    { paths: ['SKILL.md', 'references.txt', 'references.txt/checklist.md'] },
  ])('在落盘前拒绝无效或冲突路径 $paths', async ({ paths }) => {
    const errorSpy = captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValue(paths.map((relativePath) => ({ relativePath, content: ENTRY })));
    await expect(uploadSkillFile('file')).rejects.toThrow();
    expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('保留原生脱敏错误，拒绝损坏或超限压缩包时不写入', async () => {
    const errorSpy = captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockRejectedValue('Skill ZIP 压缩包格式无效');
    await expect(uploadSkillFile('file')).rejects.toThrow('Skill ZIP 压缩包格式无效');
    expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('保存中断时清理本次新建目录，错误提示不包含本地路径', async () => {
    const errorSpy = captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.writeFile.mockRejectedValue(`permission denied: ${DEST}`);
    await expect(uploadSkillFile('file')).rejects.toThrow('Skill 压缩包保存失败，请检查存储空间和写入权限后重试');
    expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
    expect(mocks.remove).toHaveBeenCalledWith(DEST, { recursive: true });
  });

  it('取消文件选择时不读取压缩包', async () => {
    mocks.open.mockResolvedValue(null);
    await expect(uploadSkillFile('file')).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Skill 文件夹上传', () => {
  it('授权所选目录的子树，保存入口与多级附属资料', async () => {
    mocks.readDir.mockImplementation(async (path: string) => {
      // 模拟目录选择器未递归授权时，读取子目录被 Tauri scope 拒绝。
      if (path !== SOURCE && !mocks.open.mock.calls[0]?.[0]?.recursive) {
        throw new Error('forbidden path: not allowed on the scope');
      }
      if (path === SOURCE) return [
        { name: 'SKILL.md', isFile: true, isDirectory: false },
        { name: 'references', isFile: false, isDirectory: true },
      ];
      if (path === `${SOURCE}/references`) return [
        { name: '详细', isFile: false, isDirectory: true },
      ];
      return [
        { name: 'checklist.md', isFile: true, isDirectory: false },
        { name: 'cover.png', isFile: true, isDirectory: false },
      ];
    });
    mocks.readFile.mockImplementation(async (path: string) => (
      new TextEncoder().encode(path.endsWith('/SKILL.md') ? ENTRY : RESOURCE)
    ));

    await expect(uploadSkillFile('folder')).resolves.toEqual({
      fileName: '示例',
      content: ENTRY,
      sourceType: 'folder',
      storagePath: DEST,
      entryFileName: 'SKILL.md',
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(`${DEST}/SKILL.md`, new TextEncoder().encode(ENTRY));
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `${DEST}/references/详细/checklist.md`, new TextEncoder().encode(RESOURCE),
    );
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });

  it('取消目录选择时不读取或写入文件', async () => {
    mocks.open.mockResolvedValue(null);
    await expect(uploadSkillFile('folder')).resolves.toBeNull();
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('将原生字符串错误转换为可见提示，日志和提示不包含本地路径', async () => {
    const errorSpy = captureExpectedImportError();
    try {
      mocks.readDir.mockRejectedValue(`forbidden path: ${SOURCE}`);
      await expect(uploadSkillFile('folder')).rejects.toThrow(
        'Skill 文件夹导入失败，请重新选择文件夹并检查读取权限',
      );
      expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
      expect(mocks.writeFile).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('仍支持单文件上传', async () => {
    mocks.open.mockResolvedValue(`${SOURCE}/SKILL.md`);
    await expect(uploadSkillFile('file')).resolves.toMatchObject({
      sourceType: 'file',
      content: ENTRY,
      entryFileName: 'SKILL.md',
    });
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      'C:/app-data/skill/SKILL.md', new TextEncoder().encode(ENTRY),
    );
  });
});
