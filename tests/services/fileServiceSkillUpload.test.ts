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
const INSTALL_SKILLS = 'C:/AI-Canvas/skills';
const DEST = `${INSTALL_SKILLS}/示例`;
const ENTRY = '# 示例 Skill\n请读取 references/详细/checklist.md';
const RESOURCE = '中文检查清单';
const ARCHIVE_FILES = [
  { relativePath: '示例/SKILL.md', content: ENTRY },
  { relativePath: '示例/references/详细/checklist.md', content: RESOURCE },
];

function expectNoFrontendWrites() {
  expect(mocks.mkdir).not.toHaveBeenCalled();
  expect(mocks.writeFile).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
}

function expectNoNativeSave() {
  expect(mocks.invoke.mock.calls.some(([command]) => command === 'save_skill_files')).toBe(false);
}

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
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'read_skill_archive') return ARCHIVE_FILES;
    if (command === 'register_skill_folder') return { sourceId: 'folder-source', storagePath: SOURCE };
    if (command === 'list_skill_source_files') return ['SKILL.md', 'references/详细/checklist.md'];
    if (command === 'read_skill_source_file') return args.relativePath === 'SKILL.md' ? ENTRY : RESOURCE;
    if (command === 'save_skill_files') return {
      sourceId: 'saved-source',
      storagePath: args.directory ? DEST : `${INSTALL_SKILLS}/${String(args.name)}`,
    };
    throw new Error(`Unexpected Skill command: ${command}`);
  });
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
      nativeSourceId: 'saved-source',
      entryFileName: 'SKILL.md',
    });
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ name: 'Skill 文件或压缩包', extensions: ['md', 'txt', 'json', 'zip', 'tar.gz', 'tgz'] }],
    }));
    expect(mocks.invoke).toHaveBeenCalledWith('read_skill_archive', { archivePath });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('save_skill_files', {
      name: '示例', directory: true,
      files: [
        { relativePath: 'SKILL.md', content: ENTRY },
        { relativePath: 'references/详细/checklist.md', content: RESOURCE },
      ],
    });
    expectNoFrontendWrites();
  });

  it('优先选择根入口，附属资料不改变入口选择', async () => {
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValueOnce([
      { relativePath: 'references/SKILL.md', content: RESOURCE },
      { relativePath: 'SKILL.md', content: ENTRY },
    ]);
    await expect(uploadSkillFile('file')).resolves.toMatchObject({ content: ENTRY, entryFileName: 'SKILL.md' });
    expect(mocks.invoke).toHaveBeenCalledWith('save_skill_files', expect.objectContaining({
      directory: true,
      files: [
        { relativePath: 'SKILL.md', content: ENTRY },
        { relativePath: 'references/SKILL.md', content: RESOURCE },
      ],
    }));
    expectNoFrontendWrites();
  });

  it('缺少 SKILL.md 时沿用文件夹导入的 Markdown 入口回退', async () => {
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValueOnce([{ relativePath: 'demo/README.md', content: ENTRY }]);
    await expect(uploadSkillFile('file')).resolves.toMatchObject({ content: ENTRY, entryFileName: 'README.md' });
  });

  it('分别打包的多个 Skill 不会静默丢失', async () => {
    const errorSpy = captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValueOnce([
      { relativePath: 'one/SKILL.md', content: ENTRY },
      { relativePath: 'two/SKILL.md', content: RESOURCE },
    ]);
    await expect(uploadSkillFile('file')).rejects.toThrow('压缩包包含多个独立 Skill，请分别打包上传');
    expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
    expectNoNativeSave();
    expectNoFrontendWrites();
  });

  it.each([
    { paths: ['../SKILL.md'] },
    { paths: ['SKILL.md', 'skill.md'] },
    { paths: ['SKILL.md', 'references.txt', 'references.txt/checklist.md'] },
  ])('在落盘前拒绝无效或冲突路径 $paths', async ({ paths }) => {
    const errorSpy = captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValueOnce(paths.map((relativePath) => ({ relativePath, content: ENTRY })));
    await expect(uploadSkillFile('file')).rejects.toThrow();
    expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
    expectNoNativeSave();
    expectNoFrontendWrites();
  });

  it('保留原生脱敏错误，拒绝损坏或超限压缩包时不写入', async () => {
    const errorSpy = captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockRejectedValueOnce('Skill ZIP 压缩包格式无效');
    await expect(uploadSkillFile('file')).rejects.toThrow('Skill ZIP 压缩包格式无效');
    expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
    expectNoNativeSave();
    expectNoFrontendWrites();
  });

  it('原生保存失败时显示脱敏提示，前端不自行删除任何目录', async () => {
    const errorSpy = captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/示例.zip`);
    mocks.invoke.mockResolvedValueOnce(ARCHIVE_FILES)
      .mockRejectedValueOnce('Skill 保存失败，请检查安装目录写入权限和存储空间');
    const error = await uploadSkillFile('file').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('保存失败');
    expect((error as Error).message).not.toContain(DEST);
    expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
    expectNoFrontendWrites();
  });

  it('取消文件选择时不读取压缩包', async () => {
    mocks.open.mockResolvedValue(null);
    await expect(uploadSkillFile('file')).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expectNoFrontendWrites();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Skill 文件夹上传', () => {
  it('原生登记所选目录子树并保留原位置，只枚举资料及读取入口而不复制', async () => {
    await expect(uploadSkillFile('folder')).resolves.toEqual({
      fileName: '示例',
      content: ENTRY,
      sourceType: 'folder',
      storagePath: SOURCE,
      nativeSourceId: 'folder-source',
      entryFileName: 'SKILL.md',
    });
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, recursive: true }));
    expect(mocks.invoke).toHaveBeenCalledWith('register_skill_folder', { path: SOURCE });
    expect(mocks.invoke).toHaveBeenCalledWith('list_skill_source_files', { sourceId: 'folder-source', limit: 4096 });
    expect(mocks.invoke).toHaveBeenCalledWith('read_skill_source_file', { sourceId: 'folder-source', relativePath: 'SKILL.md' });
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expectNoNativeSave();
    expectNoFrontendWrites();
  });

  it('保存原生登记的规范化原目录，不把选择器路径当作最终授权来源', async () => {
    mocks.invoke.mockResolvedValueOnce({ sourceId: 'canonical-source', storagePath: 'D:/real-skills/示例' });
    await expect(uploadSkillFile('folder')).resolves.toMatchObject({
      storagePath: 'D:/real-skills/示例', nativeSourceId: 'canonical-source',
    });
    expectNoFrontendWrites();
  });

  it('目录入口非 UTF-8 时不返回成功的导入记录', async () => {
    captureExpectedImportError();
    mocks.invoke.mockResolvedValueOnce({ sourceId: 'folder-source', storagePath: SOURCE })
      .mockResolvedValueOnce(['SKILL.md', 'references.json'])
      .mockRejectedValueOnce('Skill 文件必须是 UTF-8 文本');
    await expect(uploadSkillFile('folder')).rejects.toThrow('UTF-8');
    expect(mocks.invoke).toHaveBeenCalledWith('read_skill_source_file', { sourceId: 'folder-source', relativePath: 'SKILL.md' });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expectNoFrontendWrites();
  });

  it('目录中没有支持的入口文件时不读取正文或写入', async () => {
    captureExpectedImportError();
    mocks.invoke.mockResolvedValueOnce({ sourceId: 'folder-source', storagePath: SOURCE })
      .mockResolvedValueOnce([]);
    await expect(uploadSkillFile('folder')).rejects.toThrow('没有可用');
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'read_skill_source_file')).toBe(false);
    expectNoFrontendWrites();
  });

  it('取消目录选择时不读取或写入文件', async () => {
    mocks.open.mockResolvedValue(null);
    await expect(uploadSkillFile('folder')).resolves.toBeNull();
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expectNoFrontendWrites();
  });

  it('原生登记拒绝时显示脱敏提示，不降级到插件文件系统读取', async () => {
    const errorSpy = captureExpectedImportError();
    try {
      mocks.invoke.mockRejectedValueOnce('Skill 文件夹登记失败，请重新选择并检查读取权限');
      const error = await uploadSkillFile('folder').catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('失败');
      expect((error as Error).message).not.toContain(SOURCE);
      expect(errorSpy.mock.calls).toEqual([['[Skill 上传] 导入失败']]);
      expect(mocks.invoke).toHaveBeenCalledOnce();
      expect(mocks.readDir).not.toHaveBeenCalled();
      expect(mocks.readFile).not.toHaveBeenCalled();
      expectNoFrontendWrites();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('单文件由原生保存至安装根 skills，并保留持久来源身份', async () => {
    mocks.open.mockResolvedValue(`${SOURCE}/SKILL.md`);
    await expect(uploadSkillFile('file')).resolves.toMatchObject({
      sourceType: 'file',
      content: ENTRY,
      entryFileName: 'SKILL.md',
      storagePath: `${INSTALL_SKILLS}/SKILL.md`,
      nativeSourceId: 'saved-source',
    });
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('save_skill_files', {
      name: 'SKILL.md', directory: false, files: [{ relativePath: 'SKILL.md', content: ENTRY }],
    });
    expectNoFrontendWrites();
  });

  it('非 UTF-8 单文件在保存前被拒绝', async () => {
    captureExpectedImportError();
    mocks.open.mockResolvedValue(`${SOURCE}/SKILL.md`);
    mocks.readFile.mockResolvedValue(new Uint8Array([0xff, 0xfe, 0x00]));
    await expect(uploadSkillFile('file')).rejects.toThrow('UTF-8');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expectNoFrontendWrites();
  });

  it('单文件保存保留 UTF-8 BOM，运行时正文继续去掉 BOM', async () => {
    mocks.open.mockResolvedValue(`${SOURCE}/SKILL.md`);
    mocks.readFile.mockResolvedValue(new TextEncoder().encode(`\uFEFF${ENTRY}`));
    await expect(uploadSkillFile('file')).resolves.toMatchObject({ content: ENTRY });
    expect(mocks.invoke).toHaveBeenCalledWith('save_skill_files', {
      name: 'SKILL.md', directory: false, files: [{ relativePath: 'SKILL.md', content: `\uFEFF${ENTRY}` }],
    });
    expectNoFrontendWrites();
  });
});
