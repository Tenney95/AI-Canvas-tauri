/**
 * fileServiceSkillResource — 回归测试：assertSafeSkillRelativePath。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const readDirMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, convertFileSrc: vi.fn() }));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: existsMock,
  readFile: readFileMock,
  readDir: readDirMock,
  writeFile: vi.fn(),
  stat: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
}));

import {
  assertSafeSkillRelativePath,
  listSkillResourceFiles,
  readSkillResourceFile,
} from '../../src/services/fileService';

const ROOT = '/Users/tester/Library/Application Support/ai-canvas/skill/audit';

beforeEach(() => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  existsMock.mockReset().mockResolvedValue(true);
  readFileMock.mockReset().mockResolvedValue(new TextEncoder().encode('参考资料正文'));
  readDirMock.mockReset().mockResolvedValue([]);
  invokeMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assertSafeSkillRelativePath', () => {
  it('接受普通相对路径并统一分隔符', () => {
    expect(assertSafeSkillRelativePath('references/checklist.md'))
      .toBe('references/checklist.md');
    expect(assertSafeSkillRelativePath('references\\checklist.md'))
      .toBe('references/checklist.md');
    expect(assertSafeSkillRelativePath('  notes.txt  ')).toBe('notes.txt');
  });

  it.each([
    ['空路径', ''],
    ['仅空白', '   '],
    ['父级穿越', '../secrets.md'],
    ['中间父级穿越', 'references/../../secrets.md'],
    ['当前目录段', './notes.md'],
    ['POSIX 绝对路径', '/etc/passwd.txt'],
    ['家目录', '~/notes.md'],
    ['Windows 盘符', 'C:/Windows/system.txt'],
    ['file scheme', 'file:///etc/hosts.txt'],
    ['http scheme', 'https://example.com/a.md'],
    ['空路径段', 'references//notes.md'],
  ])('拒绝 %s', (_label, input) => {
    expect(() => assertSafeSkillRelativePath(input)).toThrow('路径无效');
  });

  it('拒绝非白名单扩展名', () => {
    expect(() => assertSafeSkillRelativePath('run.sh')).toThrow('只支持');
    expect(() => assertSafeSkillRelativePath('references/photo.png')).toThrow('只支持');
  });
});

describe('readSkillResourceFile', () => {
  it('读取 Skill 子树内的文本资料', async () => {
    await expect(readSkillResourceFile(ROOT, 'references/checklist.md'))
      .resolves.toBe('参考资料正文');
    expect(readFileMock).toHaveBeenCalledWith(`${ROOT}/references/checklist.md`);
  });

  it('容忍结尾斜杠的 storagePath', async () => {
    await readSkillResourceFile(`${ROOT}/`, 'notes.md');
    expect(readFileMock).toHaveBeenCalledWith(`${ROOT}/notes.md`);
  });

  it('拒绝越权路径且不读取任何文件', async () => {
    await expect(readSkillResourceFile(ROOT, '../other-skill/secret.md'))
      .rejects.toThrow('路径无效');
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('文件缺失时的错误只含相对路径，不泄露绝对路径', async () => {
    existsMock.mockResolvedValue(false);
    await expect(readSkillResourceFile(ROOT, 'references/missing.md'))
      .rejects.toThrow(/^Skill 资料不存在: references\/missing\.md$/);
  });

  it('非 UTF-8 内容报错而不是返回乱码', async () => {
    readFileMock.mockResolvedValue(new Uint8Array([0xff, 0xfe, 0x00]));
    await expect(readSkillResourceFile(ROOT, 'notes.md')).rejects.toThrow('UTF-8');
  });

  it('重启后凭持久来源身份读取外部目录，不依赖旧的选择器插件授权', async () => {
    invokeMock.mockResolvedValue('原位置的参考资料');
    await expect(readSkillResourceFile('D:/user-skills/audit', 'references/checklist.md', 'saved-source'))
      .resolves.toBe('原位置的参考资料');
    expect(invokeMock).toHaveBeenCalledWith('read_skill_source_file', {
      sourceId: 'saved-source', relativePath: 'references/checklist.md',
    });
    expect(existsMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('带来源身份的相对路径仍先经过本地校验', async () => {
    await expect(readSkillResourceFile('D:/user-skills/audit', '../other/secret.md', 'saved-source'))
      .rejects.toThrow('路径无效');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('未知 IPC 异常只返回固定提示，不传播绝对路径和嵌套 cause', async () => {
    invokeMock.mockRejectedValue(new Error('permission denied: D:/private/secret.md', {
      cause: new Error('native path: D:/private/secret.md'),
    }));
    const error = await readSkillResourceFile('D:/user-skills/audit', 'notes.md', 'saved-source')
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ message: 'Skill 资料读取失败' });
    expect(error).not.toHaveProperty('cause');
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it.each(['Skill 来源不存在或已失效', 'Skill 文件必须是 UTF-8 文本'])(
    '原生拒绝附属资料读取时保留脱敏原因且不降级读取：%s', async (message) => {
      invokeMock.mockRejectedValue(message);
      await expect(readSkillResourceFile('D:/user-skills/audit', 'references/checklist.md', 'saved-source'))
        .rejects.toThrow(message);
      expect(existsMock).not.toHaveBeenCalled();
      expect(readFileMock).not.toHaveBeenCalled();
    },
  );
});

describe('listSkillResourceFiles', () => {
  it('返回相对路径并按上限截断', async () => {
    readDirMock.mockResolvedValue([
      { name: 'SKILL.md', isFile: true, isDirectory: false },
      { name: 'notes.txt', isFile: true, isDirectory: false },
      { name: 'cover.png', isFile: true, isDirectory: false },
    ]);
    // 排序口径由 collectSkillFiles 的 localeCompare 决定，这里只校验白名单与上限。
    expect([...await listSkillResourceFiles(ROOT, 10)].sort())
      .toEqual(['SKILL.md', 'notes.txt']);
    expect(await listSkillResourceFiles(ROOT, 1)).toHaveLength(1);
  });

  it('storagePath 缺失或目录不存在时返回空数组', async () => {
    expect(await listSkillResourceFiles(undefined, 10)).toEqual([]);
    existsMock.mockResolvedValue(false);
    expect(await listSkillResourceFiles(ROOT, 10)).toEqual([]);
  });

  it('读取失败时降级为空数组而不是抛错', async () => {
    readDirMock.mockRejectedValue(new Error('目录不可读'));
    expect(await listSkillResourceFiles(ROOT, 10)).toEqual([]);
  });

  it('持久来源身份枚举安装根或原位置目录时只向原生传身份和上限', async () => {
    invokeMock.mockResolvedValue(['SKILL.md', 'references/checklist.md']);
    await expect(listSkillResourceFiles('C:/AI-Canvas/skills/audit', 10, 'saved-source'))
      .resolves.toEqual(['SKILL.md', 'references/checklist.md']);
    expect(invokeMock).toHaveBeenCalledWith('list_skill_source_files', { sourceId: 'saved-source', limit: 10 });
    expect(existsMock).not.toHaveBeenCalled();
    expect(readDirMock).not.toHaveBeenCalled();
  });

  it('原生来源失效时仍返回空资料清单，不回退到任意路径枚举', async () => {
    invokeMock.mockRejectedValue('Skill 来源不存在或已失效');
    expect(await listSkillResourceFiles('D:/user-skills/audit', 10, 'missing-source')).toEqual([]);
    expect(existsMock).not.toHaveBeenCalled();
    expect(readDirMock).not.toHaveBeenCalled();
  });

  it('零上限不会触发原生目录读取', async () => {
    expect(await listSkillResourceFiles('D:/user-skills/audit', 0, 'saved-source')).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(readDirMock).not.toHaveBeenCalled();
  });
});
