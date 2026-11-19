import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  lstat: vi.fn(), readDir: vi.fn(), getProjectDataDir: vi.fn(),
  moveToTrash: vi.fn(), readAssetTextFile: vi.fn(), getState: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ lstat: io.lstat, readDir: io.readDir, mkdir: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: io.getState, subscribe: () => () => {} },
}));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: () => true,
  getProjectDataDir: io.getProjectDataDir,
  joinPath: (...parts: string[]) => parts.join('/'),
  stripVerbatimPrefix: (path: string) => path,
  moveToTrash: io.moveToTrash,
  readAssetTextFile: io.readAssetTextFile,
  copyAssetFileToFolder: vi.fn(),
  createAssetTextFile: vi.fn(),
  ensureProjectDataDir: vi.fn(),
  notifyProjectDiskChanged: vi.fn(),
  saveAssetTextFile: vi.fn(),
}));

import { createOutlineDocumentSession } from '../../src/services/outlineDocumentService';

const root = '/work/series';
const folder = `${root}/outline-documents`;
const doc = '旧稿.docx';
const note = '笔记.md';
const external = '/uploads/旧稿.docx';
const stat = (ino: number, isFile: boolean) => ({
  dev: 1, ino, size: isFile ? 12 : 0, mtime: new Date(1000), birthtime: new Date(2000),
  isFile, isDirectory: !isFile, isSymlink: false,
});

let disk: Map<string, ReturnType<typeof stat>>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  disk = new Map([[root, stat(1, false)], [folder, stat(2, false)],
    [`${folder}/${doc}`, stat(3, true)], [`${folder}/${note}`, stat(4, true)], [external, stat(5, true)]]);
  io.getProjectDataDir.mockResolvedValue(root);
  io.getState.mockReturnValue({ currentProjectId: 'episode', projectLoadStatus: 'ready', switchingProjectName: null,
    projects: [{ id: 'series', name: '剧集' }, { id: 'episode', parentId: 'series' }], config: {} });
  io.lstat.mockImplementation(async (path: string) => {
    const info = disk.get(path);
    if (!info) throw new Error('文件不存在');
    return info;
  });
  io.readDir.mockImplementation(async (path: string) => [...disk.entries()]
    .filter(([candidate]) => candidate.slice(0, candidate.lastIndexOf('/')) === path)
    .map(([candidate, info]) => ({ ...info, name: candidate.split('/').at(-1) })));
  io.moveToTrash.mockImplementation(async (path: string) => { disk.delete(path); });
  io.readAssetTextFile.mockResolvedValue({ content: '保存的笔记', digest: 'a'.repeat(64), size: 12, modified: 1000, bom: false, newline: 'LF' });
});

afterEach(() => vi.unstubAllGlobals());

describe('工作台回收大纲资料', () => {
  it('只移动明确选择的项目副本，保留外部上传源文件和当前笔记草稿', async () => {
    const session = createOutlineDocumentSession({ seriesId: 'series' });
    await session.handle({ type: 'outline_list' });
    const opened = await session.handle({ type: 'outline_open', id: note });
    session.flush({ documentId: opened!.documentId, sequence: 1, content: '尚未保存的输入' });
    const file = session.getSummary().files.find((entry) => entry.id === doc)!;

    await session.handle({ type: 'outline_trash', file });

    expect(io.moveToTrash).toHaveBeenCalledExactlyOnceWith(`${folder}/${doc}`, { throwOnError: true });
    expect(disk.has(external)).toBe(true);
    expect(session.getSummary()).toMatchObject({ selected: true, fileId: note, dirty: true, files: [{ id: note }] });
    expect(session.readDraft().content).toBe('尚未保存的输入');
    await expect(session.handle({ type: 'outline_trash', file })).rejects.toThrow('请刷新列表');
    expect(io.moveToTrash).toHaveBeenCalledTimes(1);
  });

  it('拒绝处理有未保存草稿的文件', async () => {
    const session = createOutlineDocumentSession({ seriesId: 'series' });
    await session.handle({ type: 'outline_list' });
    const opened = await session.handle({ type: 'outline_open', id: note });
    session.flush({ documentId: opened!.documentId, sequence: 1, content: '未保存的笔记' });
    const file = session.getSummary().files.find((entry) => entry.id === note)!;

    await expect(session.handle({ type: 'outline_trash', file })).rejects.toThrow('请先保存该文件的草稿');
    expect(io.moveToTrash).not.toHaveBeenCalled();
    expect(session.readDraft().content).toBe('未保存的笔记');
  });

  it('拒绝回收已更换磁盘身份的同名文件及越界目标', async () => {
    const session = createOutlineDocumentSession({ seriesId: 'series' });
    await session.handle({ type: 'outline_list' });
    const file = session.getSummary().files.find((entry) => entry.id === doc)!;
    disk.set(`${folder}/${doc}`, stat(10, true));

    await expect(session.handle({ type: 'outline_trash', file })).rejects.toThrow('文件在确认期间已变化');
    await expect(session.handle({ type: 'outline_trash', file: { ...file, id: `../${doc}` } })).rejects.toThrow('文件身份无效');
    expect(io.moveToTrash).not.toHaveBeenCalled();
    expect(disk.has(`${folder}/${doc}`)).toBe(true);
  });
});
