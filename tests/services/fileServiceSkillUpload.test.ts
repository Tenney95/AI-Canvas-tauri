import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('C:/app-data'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  ...mocks,
  lstat: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  watch: vi.fn(),
}));

import { uploadSkillFile } from '../../src/services/fs/skillFiles';

const SOURCE = 'D:/skills/示例';
const DEST = 'C:/app-data/skill/示例';
const ENTRY = '# 示例 Skill\n请读取 references/详细/checklist.md';
const RESOURCE = '中文检查清单';

beforeEach(() => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  vi.clearAllMocks();
  mocks.open.mockReset().mockResolvedValue(SOURCE);
  mocks.exists.mockReset().mockResolvedValue(false);
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
  mocks.readDir.mockReset().mockResolvedValue([]);
  mocks.readFile.mockReset().mockResolvedValue(new TextEncoder().encode(ENTRY));
  mocks.writeFile.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mocks.readDir.mockRejectedValue(`forbidden path: ${SOURCE}`);
      await expect(uploadSkillFile('folder')).rejects.toThrow(
        'Skill 文件夹导入失败，请重新选择文件夹并检查读取权限',
      );
      expect(errorSpy).toHaveBeenCalledWith('[Skill 上传] 导入失败');
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
