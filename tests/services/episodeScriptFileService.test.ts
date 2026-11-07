/** 分集 TXT 的重名绑定、磁盘冲突和条件恢复；不通过 Store 绕开主窗口文件层。 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetTextSnapshot } from '../../src/services/fileService';
import type { ProjectTextFileReference } from '../../src/types';
import type { EpisodeScriptFileReceipt, EpisodeScriptFileWriteOptions } from '../../src/services/episodeScriptFileService';

const mocks = vi.hoisted(() => ({
  desktop: true, label: 'main', read: vi.fn(), save: vi.fn(), create: vi.fn(), stat: vi.fn(), directory: vi.fn(),
  files: new Map<string, AssetTextSnapshot>(), listeners: new Set<() => void>(),
}));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => mocks.desktop }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: mocks.label }) }));
vi.mock('@tauri-apps/plugin-fs', () => ({ lstat: mocks.stat }));
vi.mock('../../src/services/fileService', () => ({
  readAssetTextFile: mocks.read, saveAssetTextFile: mocks.save, createAssetTextFile: mocks.create, getProjectDataDir: mocks.directory,
  joinPath: (...segments: string[]) => segments.join('/'),
}));

import { prepareEpisodeScriptFileWrite } from '../../src/services/episodeScriptFileService';

let episodeSequence = 0;
function snapshot(content: string): AssetTextSnapshot {
  return { content, digest: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content), modified: 1, bom: false, newline: 'LF' };
}
function reference(content = '旧剧本', name = '第一集.txt'): ProjectTextFileReference {
  return { fileName: name, relativePath: `manuscripts/${name}`, sourceName: name, digest: snapshot(content).digest };
}
function options(overrides: Partial<EpisodeScriptFileWriteOptions> = {}): EpisodeScriptFileWriteOptions {
  return { episodeId: `episode-${++episodeSequence}`, projectId: 'series', exchangeEpoch: 1, episodeExchangeEpoch: 1,
    name: '第一集', previousText: '旧剧本', text: '新剧本', assertCurrent: vi.fn(),
    subscribe: (listener) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); }, ...overrides };
}
function receipt(value: EpisodeScriptFileReceipt | undefined): EpisodeScriptFileReceipt {
  if (!value) throw new Error('Expected desktop TXT receipt');
  return value;
}

beforeEach(() => {
  vi.resetAllMocks(); mocks.files.clear(); mocks.listeners.clear(); mocks.desktop = true; mocks.label = 'main';
  mocks.directory.mockResolvedValue('/project');
  mocks.stat.mockResolvedValue({ isDirectory: true, isSymlink: false });
  mocks.read.mockImplementation(async (path: string) => {
    const value = mocks.files.get(path);
    if (!value) throw new Error('ENOENT: /private/local/path');
    return structuredClone(value);
  });
  mocks.save.mockImplementation(async (path: string, baseline: AssetTextSnapshot, content: string) => {
    if (mocks.files.get(path)?.digest !== baseline.digest) throw new Error('磁盘文件已被修改');
    const saved = snapshot(content); mocks.files.set(path, saved); return structuredClone(saved);
  });
  mocks.create.mockImplementation(async (_projectId: string, content: string, name: string) => {
    const fileName = name.replace(/\.txt$/, '_1.txt');
    const filePath = `/project/manuscripts/${fileName}`;
    const saved = snapshot(content); mocks.files.set(filePath, saved);
    return { fileName, filePath, relativePath: `manuscripts/${fileName}`, snapshot: saved };
  });
});

describe('分集剧本 TXT 同步', () => {
  it('Web 演示不访问文件、不伪造引用，非主窗口拒绝实际写入', async () => {
    mocks.desktop = false;
    await expect(prepareEpisodeScriptFileWrite(options())).resolves.toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.directory).not.toHaveBeenCalled();
    mocks.desktop = true; mocks.label = 'script-workbench';
    await expect(prepareEpisodeScriptFileWrite(options())).rejects.toThrow('主窗口');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('首次同名文件使用唯一名字，后续保存按 sourceName 复用绑定而不再创建副本', async () => {
    const input = options();
    const first = receipt(await prepareEpisodeScriptFileWrite(input));
    expect(first.reference).toMatchObject({ fileName: '第一集_1.txt', relativePath: 'manuscripts/第一集_1.txt', sourceName: '第一集.txt' });
    expect(mocks.create).toHaveBeenCalledWith('series', '新剧本', '第一集.txt', expect.objectContaining({ projectSubdirectory: 'manuscripts' }));
    first.confirm();
    const next = receipt(await prepareEpisodeScriptFileWrite({ ...input, previousText: '新剧本', text: '继续修改', reference: first.reference }));
    expect(next.reference.relativePath).toBe(first.reference.relativePath);
    expect(mocks.files.get('/project/manuscripts/第一集_1.txt')?.content).toBe('继续修改');
    expect(mocks.create).toHaveBeenCalledOnce();
    next.confirm();
  });

  it('已绑定 TXT 被外部修改时保留磁盘文本，正文相同的显式重试可以补交项目记录', async () => {
    const bound = reference();
    mocks.files.set('/project/manuscripts/第一集.txt', snapshot('外部修改'));
    const input = options({ reference: bound });
    await expect(prepareEpisodeScriptFileWrite(input)).rejects.toThrow('已被修改');
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
    mocks.files.set('/project/manuscripts/第一集.txt', snapshot('新剧本'));
    const retried = receipt(await prepareEpisodeScriptFileWrite(input));
    expect(retried.reference.digest).toBe(snapshot('新剧本').digest);
    expect(mocks.save).not.toHaveBeenCalled();
    retried.confirm();
  });

  it('分集改名后另存新的 TXT，原名字的文件继续保留', async () => {
    const bound = reference();
    mocks.files.set('/project/manuscripts/第一集.txt', snapshot('旧剧本'));
    const next = receipt(await prepareEpisodeScriptFileWrite(options({ name: '第一集：回家', reference: bound })));
    expect(next.reference.sourceName).toBe('第一集_回家.txt');
    expect(next.reference.relativePath).toBe('manuscripts/第一集_回家_1.txt');
    expect(mocks.files.get('/project/manuscripts/第一集.txt')?.content).toBe('旧剧本');
    expect(mocks.save).not.toHaveBeenCalled();
    next.confirm();
  });

  it('首次创建后项目绑定失败，显式重试复用待绑定文件并保留其他文件', async () => {
    const input = options();
    const first = receipt(await prepareEpisodeScriptFileWrite(input));
    await expect(first.rollback()).resolves.toBe(false);
    const retried = receipt(await prepareEpisodeScriptFileWrite({ ...input, text: '重试时的新稿' }));
    expect(retried.reference.relativePath).toBe(first.reference.relativePath);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.files.get('/project/manuscripts/第一集_1.txt')?.content).toBe('重试时的新稿');
    retried.confirm();
  });

  it('项目提交失败只恢复仍属于本次写入的既有文件，不撤销较新的外部内容', async () => {
    const bound = reference();
    mocks.files.set('/project/manuscripts/第一集.txt', snapshot('旧剧本'));
    const first = receipt(await prepareEpisodeScriptFileWrite(options({ reference: bound })));
    await expect(first.rollback()).resolves.toBe(true);
    expect(mocks.files.get('/project/manuscripts/第一集.txt')?.content).toBe('旧剧本');
    const second = receipt(await prepareEpisodeScriptFileWrite(options({ reference: bound })));
    mocks.files.set('/project/manuscripts/第一集.txt', snapshot('稍后的外部改稿'));
    await expect(second.rollback()).resolves.toBe(false);
    expect(mocks.files.get('/project/manuscripts/第一集.txt')?.content).toBe('稍后的外部改稿');
  });

  it('拒绝 TXT 父级符号链接，并隐藏未知原生错误里的绝对路径', async () => {
    const bound = reference();
    mocks.files.set('/project/manuscripts/第一集.txt', snapshot('旧剧本'));
    mocks.stat.mockImplementation(async (path: string) => ({ isDirectory: true, isSymlink: path.endsWith('/manuscripts') }));
    await expect(prepareEpisodeScriptFileWrite(options({ reference: bound }))).rejects.toThrow('普通文件夹');
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.stat.mockResolvedValue({ isDirectory: true, isSymlink: false });
    mocks.save.mockRejectedValueOnce(new Error('EACCES /private/local/secret/path'));
    await expect(prepareEpisodeScriptFileWrite(options({ reference: bound }))).rejects.toThrow(/^剧本 TXT 保存未确认完成，草稿已保留，请检查文件权限与磁盘空间$/);
    await expect(prepareEpisodeScriptFileWrite(options({ reference: bound }))).resolves.toBeDefined();
  });

  it('写入后目标才变化时仍交接恢复回执，不把已写入误报为未写入', async () => {
    const bound = reference();
    mocks.files.set('/project/manuscripts/第一集.txt', snapshot('旧剧本'));
    let current = true;
    let started!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.save.mockImplementationOnce(async (path: string, _baseline: AssetTextSnapshot, content: string) => {
      started(); await gate;
      const saved = snapshot(content); mocks.files.set(path, saved); return saved;
    });
    const prepared = vi.fn();
    const saving = prepareEpisodeScriptFileWrite(options({ reference: bound, onPrepared: prepared,
      assertCurrent: () => { if (!current) throw new Error('项目已切换'); } }));
    const rejected = expect(saving).rejects.toThrow('项目或稿件已变化');
    await writing;
    current = false; mocks.listeners.forEach((listener) => listener());
    release(); await rejected;
    expect(prepared).toHaveBeenCalledOnce();
    const saved = prepared.mock.calls[0][0] as EpisodeScriptFileReceipt;
    expect(mocks.files.get('/project/manuscripts/第一集.txt')?.content).toBe('新剧本');
    await expect(saved.rollback()).resolves.toBe(true);
    expect(mocks.files.get('/project/manuscripts/第一集.txt')?.content).toBe('旧剧本');
  });
});
