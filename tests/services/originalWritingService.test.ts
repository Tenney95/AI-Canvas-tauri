/** 原著编辑会话的正文边界、异步保存与过期候选回归。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject, ProjectOriginalWork } from '../../src/types';
import type { AssetTextSnapshot } from '../../src/services/fileService';
import type { StreamingCallOptions } from '../../src/services/ai/assistantStream';
import type { OriginalWritingDocument } from '../../src/types/originalWriting';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), save: vi.fn(), create: vi.fn(), updateSeries: vi.fn(), stream: vi.fn(), model: vi.fn(), directory: vi.fn(),
  listeners: new Set<() => void>(),
  state: { currentProjectId: 'episode-1', projectLoadStatus: 'ready', isCreatingProject: false,
    isReturningToStartPage: false, switchingProjectName: null as string | null, projects: [] as CanvasProject[] },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: () => ({ ...mocks.state, updateSeriesInfo: mocks.updateSeries }),
  subscribe: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: () => true, getProjectDataDir: mocks.directory,
  joinPath: (...segments: string[]) => segments.join('/'),
  readAssetTextFile: mocks.read, saveAssetTextFile: mocks.save, createAssetTextFile: mocks.create,
}));
vi.mock('../../src/services/ai/assistantStream', () => ({ streamAssistantReply: mocks.stream, resolveAssistantModel: mocks.model }));
vi.mock('../../src/services/seriesSourceService', () => ({ indexSeriesChapters: (text: string) => text ? [{ start: 0, end: text.length }] : [] }));

import { createOriginalWritingSession } from '../../src/services/originalWritingService';

function textSnapshot(content: string, digest = 'initial'): AssetTextSnapshot {
  return { content, digest, size: new TextEncoder().encode(content).length, modified: 1, bom: false, newline: 'LF' };
}
function createdFile(content: string) {
  return { filePath: '/series-data/manuscripts/原文.txt', relativePath: 'manuscripts/原文.txt', fileName: '原文.txt',
    snapshot: textSnapshot(content, 'created') };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const documentResult = (value: OriginalWritingDocument | boolean): OriginalWritingDocument => {
  if (typeof value === 'boolean') throw new Error('Expected document');
  return value;
};
const notify = () => mocks.listeners.forEach((listener) => listener());
const session = () => createOriginalWritingSession({ seriesId: 'series', onChange: vi.fn() });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listeners.clear();
  mocks.state = { currentProjectId: 'episode-1', projectLoadStatus: 'ready', isCreatingProject: false,
    isReturningToStartPage: false, switchingProjectName: null,
    projects: [{ id: 'series', name: '剧集', createdAt: 1, updatedAt: 1, exchangeEpoch: 0,
      series: { originalWork: { fileName: '原著.txt', relativePath: 'manuscripts/source.txt', addedAt: 1 } } },
    { id: 'episode-1', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 }] };
  mocks.directory.mockResolvedValue('/series-data');
  mocks.read.mockResolvedValue(textSnapshot('# 第一章\n秘密原文。'));
  mocks.save.mockImplementation(async (_path: string, _baseline: AssetTextSnapshot, content: string) => textSnapshot(content, 'saved'));
  mocks.create.mockImplementation(async (_projectId: string, content: string) => createdFile(content));
  mocks.updateSeries.mockImplementation(async (info: { originalWork: ProjectOriginalWork }, options?: { assertCurrent?: () => void }) => {
    options?.assertCurrent?.();
    const series = mocks.state.projects[0];
    mocks.state.projects[0] = { ...series, series: { ...series.series, originalWork: info.originalWork } };
    notify();
    options?.assertCurrent?.();
    return true;
  });
  mocks.model.mockReturnValue({ selectionId: 'configured-text-model' });
  mocks.stream.mockImplementation(async (request: StreamingCallOptions) => {
    request.onEvent({ type: 'done', finishReason: 'stop' });
    return '新的正文。';
  });
});

describe('原文主窗口编辑会话', () => {
  it.each([
    { fileName: '旧原文.txt', relativePath: 'old.txt' },
    { fileName: '旧原文.md', relativePath: 'old.md' },
    { fileName: '上传原著.md', relativePath: 'source/uploaded.md' },
    { fileName: '嵌套原文.txt', relativePath: 'manuscripts/nested/old.txt' },
    { fileName: '目录内旧稿.md', relativePath: 'manuscripts/old.md' },
  ])('旧引用 $relativePath 在显式保存时迁为直属 TXT 副本，原文件只读保留', async (legacy) => {
    const original = { ...legacy, addedAt: 1 };
    mocks.state.projects[0].series = { originalWork: original };
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    expect(editor.summary().dirty).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    const migrated = documentResult(await editor.handle({ type: 'original_save' }));
    expect(migrated).toMatchObject({ documentId: opened.documentId, content: opened.content, fileName: '原文.txt', isNew: false });
    expect(mocks.read.mock.calls.filter(([path]) => path === `/series-data/${legacy.relativePath}`)).toHaveLength(3);
    expect(mocks.create).toHaveBeenCalledWith('series', opened.content, '原文.txt',
      expect.objectContaining({ projectSubdirectory: 'manuscripts' }));
    expect(mocks.updateSeries).toHaveBeenCalledWith({ originalWork: expect.objectContaining({ relativePath: 'manuscripts/原文.txt' }) },
      expect.objectContaining({ expectedOriginalWork: original, expectedSeriesId: 'series', expectedExchangeEpoch: 0 }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(editor.summary().dirty).toBe(false);
    await editor.handle({ type: 'original_save' });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('迁移前旧文件已被外部修改时拒绝创建和改绑，保留编辑草稿', async () => {
    const original = { fileName: '旧稿.md', relativePath: 'old.md', addedAt: 1 };
    mocks.state.projects[0].series = { originalWork: original };
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '仍需保留的手写稿' });
    mocks.read.mockResolvedValue(textSnapshot('外部更新的旧文件', 'changed'));
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('磁盘文件已被修改');
    expect(documentResult(await editor.handle({ type: 'original_open' })).content).toBe('仍需保留的手写稿');
    expect(mocks.state.projects[0].series?.originalWork).toBe(original);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.updateSeries).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('创建副本后再次发现旧文件变化时拒绝改绑，恢复旧版本后重试复用副本', async () => {
    const original = { fileName: '旧稿.txt', relativePath: 'old.txt', addedAt: 1 };
    mocks.state.projects[0].series = { originalWork: original };
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '迁移时保留的新稿' });
    mocks.create.mockImplementationOnce(async (_projectId: string, content: string) => {
      mocks.read.mockResolvedValue(textSnapshot('复制期间外部改稿', 'changed'));
      return createdFile(content);
    });
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('磁盘文件已被修改');
    expect(mocks.updateSeries).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(editor.summary().dirty).toBe(true);
    mocks.read.mockResolvedValue(textSnapshot('# 第一章\n秘密原文。'));
    const saved = documentResult(await editor.handle({ type: 'original_save' }));
    expect(saved).toMatchObject({ documentId: opened.documentId, content: '迁移时保留的新稿', fileName: '原文.txt' });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith('/series-data/manuscripts/原文.txt', expect.objectContaining({ content: '迁移时保留的新稿' }),
      '迁移时保留的新稿', expect.any(AbortSignal));
    expect(mocks.save.mock.calls.every(([path]) => path !== '/series-data/old.txt')).toBe(true);
    expect(mocks.updateSeries.mock.calls[0][1]).toMatchObject({ expectedOriginalWork: original });
    editor.dispose();
  });

  it('迁移创建失败保留旧引用和草稿，后续显式保存仍可创建 TXT', async () => {
    const original = { fileName: '旧稿.md', relativePath: 'old.md', addedAt: 1 };
    mocks.state.projects[0].series = { originalWork: original };
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '创建失败也保留的新稿' });
    mocks.create.mockRejectedValueOnce(new Error('权限不足'));
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('保存失败');
    expect(documentResult(await editor.handle({ type: 'original_open' })).content).toBe('创建失败也保留的新稿');
    expect(mocks.state.projects[0].series?.originalWork).toBe(original);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.updateSeries).not.toHaveBeenCalled();
    const saved = documentResult(await editor.handle({ type: 'original_save' }));
    expect(saved).toMatchObject({ documentId: opened.documentId, content: '创建失败也保留的新稿', fileName: '原文.txt' });
    expect(mocks.updateSeries.mock.calls[0][1]).toMatchObject({ expectedOriginalWork: original });
    editor.dispose();
  });

  it('迁移绑定未确认时可恢复既有文档并复用副本，重试只按本次新引用保存', async () => {
    const original = { fileName: '旧稿.md', relativePath: 'old.md', addedAt: 1 };
    mocks.state.projects[0].series = { originalWork: original };
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '迁移绑定未确认的草稿' });
    mocks.updateSeries.mockImplementationOnce(async (info: { originalWork: ProjectOriginalWork }) => {
      mocks.state.projects[0].series = { originalWork: info.originalWork };
      notify();
      return false;
    });
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('原著引用尚未保存');
    const pendingReference = mocks.state.projects[0].series?.originalWork;
    const reopened = documentResult(await editor.handle({ type: 'original_open' }));
    expect(reopened).toMatchObject({ documentId: opened.documentId, fileName: '旧稿.md', isNew: false });
    mocks.stream.mockImplementationOnce(async (request: StreamingCallOptions) => {
      notify();
      expect(request.signal?.aborted).toBe(false);
      request.onEvent({ type: 'done', finishReason: 'stop' });
      return '恢复写作。';
    });
    const generated = documentResult(await editor.handle({ type: 'original_generate', mode: 'continue', start: 0, end: 0,
      instruction: '', expectedSequence: 1 }));
    await editor.handle({ type: 'original_apply', candidateId: generated.candidate!.id });
    const saved = documentResult(await editor.handle({ type: 'original_save' }));
    expect(saved).toMatchObject({ documentId: opened.documentId, content: '恢复写作。迁移绑定未确认的草稿', fileName: '原文.txt' });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.updateSeries.mock.calls[0][1]).toMatchObject({ expectedOriginalWork: original });
    expect(mocks.updateSeries.mock.calls[1][1]).toMatchObject({ expectedOriginalWork: pendingReference });
    expect(mocks.save.mock.calls.every(([path]) => path === '/series-data/manuscripts/原文.txt')).toBe(true);
    editor.dispose();
  });

  it('迁移保存期间继续输入时不覆盖最新稿，后续保存沿用受管 TXT', async () => {
    mocks.state.projects[0].series = { originalWork: { fileName: '旧稿.md', relativePath: 'old.md', addedAt: 1 } };
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '本次迁移稿' });
    const pending = deferred<ReturnType<typeof createdFile>>();
    mocks.create.mockReturnValueOnce(pending.promise);
    const saving = editor.handle({ type: 'original_save' });
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    editor.flush({ documentId: opened.documentId, sequence: 2, content: '迁移期间新输入' });
    pending.resolve(createdFile('本次迁移稿'));
    expect(documentResult(await saving)).toMatchObject({ documentId: opened.documentId, content: '迁移期间新输入', fileName: '原文.txt' });
    expect(editor.summary().dirty).toBe(true);
    await editor.handle({ type: 'original_save' });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith('/series-data/manuscripts/原文.txt', expect.objectContaining({ content: '本次迁移稿' }),
      '迁移期间新输入', expect.any(AbortSignal));
    editor.dispose();
  });

  it('迁移创建期间原著被替换时拒绝改绑，不把 pending 副本授权给其他引用', async () => {
    mocks.state.projects[0].series = { originalWork: { fileName: '旧稿.md', relativePath: 'old.md', addedAt: 1 } };
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '迁移竞态中的草稿' });
    const external = { fileName: '其他原著.txt', relativePath: 'external.txt', addedAt: 2 };
    mocks.create.mockImplementationOnce(async (_projectId: string, content: string) => {
      mocks.state.projects[0].series = { originalWork: external };
      notify();
      return createdFile(content);
    });
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('取消');
    expect(mocks.state.projects[0].series?.originalWork).toBe(external);
    expect(mocks.updateSeries).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(editor.summary().dirty).toBe(true);
    await expect(editor.handle({ type: 'original_open' })).rejects.toThrow('原著引用或剧集版本已变化');
    editor.dispose();
  });

  it('没有原著也可空白开稿，首次保存才创建并绑定，之后沿用已创建文件', async () => {
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    expect(opened).toMatchObject({ content: '', isNew: true, fileName: '原文.txt' });
    expect(editor.summary()).toMatchObject({ loaded: true, dirty: false, isNew: true });
    expect(mocks.directory).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '手写的新原文' });
    const saved = documentResult(await editor.handle({ type: 'original_save' }));
    expect(saved).toMatchObject({ documentId: opened.documentId, content: '手写的新原文', isNew: false });
    expect(editor.summary().dirty).toBe(false);
    expect(mocks.create).toHaveBeenCalledWith('series', '手写的新原文', '原文.txt',
      expect.objectContaining({ assertCurrent: expect.any(Function), projectSubdirectory: 'manuscripts' }));
    expect(mocks.updateSeries).toHaveBeenCalledWith({ originalWork: expect.objectContaining({ relativePath: 'manuscripts/原文.txt' }) },
      expect.objectContaining({ expectedSeriesId: 'series', expectedExchangeEpoch: 0, expectedOriginalWork: null }));
    editor.flush({ documentId: opened.documentId, sequence: 2, content: '继续编辑已保存的原文' });
    await editor.handle({ type: 'original_save' });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.updateSeries).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith('/series-data/manuscripts/原文.txt', expect.objectContaining({ content: '手写的新原文' }),
      '继续编辑已保存的原文', expect.any(AbortSignal));
    editor.dispose();
  });

  it('空白原文可用 AI 起笔，候选采用前后都不自动创建文件', async () => {
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    const generated = documentResult(await editor.handle({ type: 'original_generate', mode: 'continue', start: 0, end: 0,
      instruction: '写一个雨夜开场', expectedSequence: 0 }));
    expect(generated).toMatchObject({ documentId: opened.documentId, isNew: true, content: '' });
    expect(generated.candidate).toMatchObject({ text: '新的正文。', start: 0, end: 0 });
    const applied = documentResult(await editor.handle({ type: 'original_apply', candidateId: generated.candidate!.id }));
    expect(applied.content).toBe('新的正文。');
    expect(editor.summary()).toMatchObject({ isNew: true, dirty: true, hasCandidate: false });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateSeries).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('首次保存期间的新输入保留，文件绑定不会把自身引用变化当作过期', async () => {
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '首次保存内容' });
    const pending = deferred<ReturnType<typeof createdFile>>();
    mocks.create.mockReturnValueOnce(pending.promise);
    const saving = editor.handle({ type: 'original_save' });
    editor.flush({ documentId: opened.documentId, sequence: 2, content: '保存期间继续键入' });
    pending.resolve(createdFile('首次保存内容'));
    const saved = documentResult(await saving);
    expect(saved).toMatchObject({ documentId: opened.documentId, content: '保存期间继续键入', acceptedSequence: 2, isNew: false });
    expect(editor.summary().dirty).toBe(true);
    await editor.handle({ type: 'original_save' });
    expect(mocks.save).toHaveBeenCalledWith('/series-data/manuscripts/原文.txt', expect.objectContaining({ content: '首次保存内容' }),
      '保存期间继续键入', expect.any(AbortSignal));
    expect(mocks.create).toHaveBeenCalledOnce();
    editor.dispose();
  });

  it('绑定失败保留草稿，再次保存复用未绑定文件并写入最新正文', async () => {
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '绑定失败前的草稿' });
    mocks.updateSeries.mockResolvedValueOnce(false);
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('原著引用尚未保存');
    expect(editor.summary()).toMatchObject({ isNew: true, dirty: true });
    editor.flush({ documentId: opened.documentId, sequence: 2, content: '失败后继续写的新稿' });
    const retried = documentResult(await editor.handle({ type: 'original_save' }));
    expect(retried).toMatchObject({ documentId: opened.documentId, isNew: false, content: '失败后继续写的新稿' });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith('/series-data/manuscripts/原文.txt', expect.objectContaining({ content: '绑定失败前的草稿' }),
      '失败后继续写的新稿', expect.any(AbortSignal));
    expect(editor.summary().dirty).toBe(false);
    editor.dispose();
  });

  it('绑定结果未确认但本次引用仍在时，重试按本次引用条件保存而不新建副本', async () => {
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '结果未确认的原文' });
    mocks.updateSeries.mockImplementationOnce(async (info: { originalWork: ProjectOriginalWork }) => {
      mocks.state.projects[0].series = { originalWork: info.originalWork };
      notify();
      return false;
    });
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('原著引用尚未保存');
    const original = mocks.state.projects[0].series?.originalWork;
    const reopened = documentResult(await editor.handle({ type: 'original_open' }));
    expect(reopened).toMatchObject({ documentId: opened.documentId, isNew: true, content: '结果未确认的原文' });
    mocks.stream.mockImplementationOnce(async (request: StreamingCallOptions) => {
      notify();
      expect(request.signal?.aborted).toBe(false);
      request.onEvent({ type: 'done', finishReason: 'stop' });
      return '恢复后继续写作。';
    });
    const generated = documentResult(await editor.handle({ type: 'original_generate', mode: 'continue', start: 0, end: 0,
      instruction: '', expectedSequence: 1 }));
    const applied = documentResult(await editor.handle({ type: 'original_apply', candidateId: generated.candidate!.id }));
    expect(applied.isNew).toBe(true);
    expect(editor.summary()).toMatchObject({ isNew: true, dirty: true });
    const saved = documentResult(await editor.handle({ type: 'original_save' }));
    expect(saved).toMatchObject({ documentId: opened.documentId, isNew: false, content: '恢复后继续写作。结果未确认的原文' });
    expect(mocks.updateSeries.mock.calls[1][1]).toMatchObject({ expectedOriginalWork: original });
    expect(mocks.create).toHaveBeenCalledOnce();
    editor.dispose();
  });

  it('创建失败与已有原著读取失败都保留失败边界，不将旧文件降级成空白覆盖', async () => {
    const existing = session();
    mocks.read.mockRejectedValueOnce(new Error('文件不是有效 UTF-8，已停止编辑以避免乱码'));
    await expect(existing.handle({ type: 'original_open' })).rejects.toThrow('UTF-8');
    expect(existing.summary().loaded).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    existing.dispose();
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '创建失败也保留的草稿' });
    mocks.create.mockRejectedValueOnce(new Error('权限不足'));
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('保存失败');
    expect(documentResult(await editor.handle({ type: 'original_open' })).content).toBe('创建失败也保留的草稿');
    expect(editor.summary()).toMatchObject({ isNew: true, dirty: true });
    expect(mocks.updateSeries).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('创建期间添加了其他原著时拒绝绑定，显式重载才能读取新原著', async () => {
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '不能覆盖其他原著的草稿' });
    const pending = deferred<ReturnType<typeof createdFile>>();
    mocks.create.mockReturnValueOnce(pending.promise);
    const saving = editor.handle({ type: 'original_save' });
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    const external = { fileName: '外部原著.md', relativePath: 'external.md', addedAt: 3 };
    mocks.state.projects[0].series = { originalWork: external };
    notify();
    pending.resolve(createdFile('不能覆盖其他原著的草稿'));
    await expect(saving).rejects.toThrow('取消');
    expect(mocks.updateSeries).not.toHaveBeenCalled();
    expect(mocks.state.projects[0].series?.originalWork).toBe(external);
    expect(editor.summary()).toMatchObject({ isNew: true, dirty: true });
    await expect(editor.handle({ type: 'original_open' })).rejects.toThrow('原著引用或剧集版本已变化');
    await expect(editor.handle({ type: 'original_generate', mode: 'continue', start: 0, end: 0,
      instruction: '', expectedSequence: 1 })).rejects.toThrow('原著引用或剧集版本已变化');
    expect(mocks.stream).not.toHaveBeenCalled();
    const reloaded = documentResult(await editor.handle({ type: 'original_reload', discard: true }));
    expect(reloaded).toMatchObject({ fileName: '外部原著.md', isNew: false, content: '# 第一章\n秘密原文。' });
    editor.dispose();
  });

  it('绑定阶段交换代际改变时保留空白起稿会话且不确认新绑定', async () => {
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '绑定阶段仍受保护' });
    mocks.updateSeries.mockImplementationOnce(async (_info: unknown, options: { assertCurrent: () => void }) => {
      mocks.state.projects[0] = { ...mocks.state.projects[0], exchangeEpoch: 1 };
      notify();
      options.assertCurrent();
      return true;
    });
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('取消');
    expect(editor.summary()).toMatchObject({ isNew: true, dirty: true });
    expect(mocks.state.projects[0].series?.originalWork).toBeUndefined();
    await expect(editor.handle({ type: 'original_open' })).rejects.toThrow('原著引用或剧集版本已变化');
    editor.dispose();
  });

  it('没有原著时重载仍是空白，明确放弃前不会冲掉手写稿或候选', async () => {
    mocks.state.projects[0].series = {};
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '尚未保存的文字' });
    await expect(editor.handle({ type: 'original_reload' })).rejects.toThrow('请先保存草稿');
    const reloaded = documentResult(await editor.handle({ type: 'original_reload', discard: true }));
    expect(reloaded).toMatchObject({ isNew: true, content: '' });
    expect(reloaded.documentId).not.toBe(opened.documentId);
    expect(editor.summary().dirty).toBe(false);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateSeries).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('纯构造不订阅 Store，监听生命周期中止操作但保留正文且只通知当前监听者', async () => {
    const editor = createOriginalWritingSession({ seriesId: 'series' });
    expect(mocks.listeners.size).toBe(0);
    const first = vi.fn();
    const stopFirst = editor.subscribe(first);
    const opening = editor.handle({ type: 'original_open' });
    expect(mocks.listeners.size).toBe(1);
    const opened = documentResult(await opening);
    expect(mocks.listeners.size).toBe(0);
    stopFirst();
    const firstCalls = first.mock.calls.length;
    const second = vi.fn();
    const stopSecond = editor.subscribe(second);
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '重新订阅后继续写作' });
    expect(first).toHaveBeenCalledTimes(firstCalls);
    expect(second).toHaveBeenCalledOnce();
    const pending = deferred<string>();
    mocks.stream.mockReturnValueOnce(pending.promise);
    const generating = editor.handle({ type: 'original_generate', mode: 'continue', start: 0, end: 0,
      instruction: '', expectedSequence: 1 });
    const signal = (mocks.stream.mock.calls[0][0] as StreamingCallOptions).signal!;
    stopSecond();
    expect(signal.aborted).toBe(true);
    expect(mocks.listeners.size).toBe(0);
    const secondCalls = second.mock.calls.length;
    const third = vi.fn();
    const stopThird = editor.subscribe(third);
    pending.resolve('取消后不得采用的正文');
    await expect(generating).rejects.toThrow('原文操作已取消');
    expect(second).toHaveBeenCalledTimes(secondCalls);
    expect(third).toHaveBeenCalled();
    const retained = documentResult(await editor.handle({ type: 'original_open' }));
    expect(retained.documentId).toBe(opened.documentId);
    expect(retained.content).toBe('重新订阅后继续写作');
    expect(retained.candidate).toBeUndefined();
    stopThird();
    editor.dispose();
  });

  it('摘要不含正文、文件路径和候选文本；编辑序列拒绝旧副本覆盖新输入', async () => {
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 2, content: '最新的秘密正文' });
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '迟到的旧副本' });
    expect(documentResult(await editor.handle({ type: 'original_open' })).content).toBe('最新的秘密正文');
    await editor.handle({ type: 'original_generate', mode: 'continue', start: 7, end: 7, instruction: '继续', expectedSequence: 2 });
    const summary = JSON.stringify(editor.summary());
    expect(summary).not.toContain('最新的秘密正文');
    expect(summary).not.toContain('新的正文。');
    expect(summary).not.toContain('/series-data');
    expect(editor.summary()).toMatchObject({ acceptedSequence: 2, revision: 1, dirty: true, hasCandidate: true });
    editor.dispose();
  });

  it('保存时新键入保留为脏草稿，后续保存使用新的磁盘基线', async () => {
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '本次保存的文本' });
    const pending = deferred<AssetTextSnapshot>();
    mocks.save.mockReturnValueOnce(pending.promise);
    const saving = editor.handle({ type: 'original_save' });
    editor.flush({ documentId: opened.documentId, sequence: 2, content: '保存期间的新输入' });
    pending.resolve(textSnapshot('本次保存的文本', 'confirmed-save'));
    expect(documentResult(await saving).content).toBe('保存期间的新输入');
    expect(editor.summary().dirty).toBe(true);
    await editor.handle({ type: 'original_save' });
    expect(mocks.save.mock.calls[1][1]).toMatchObject({ digest: 'confirmed-save' });
    expect(editor.summary().dirty).toBe(false);
    editor.dispose();
  });

  it('超出 UTF-8 字节上限或含空字符的交接不覆盖已接受草稿', async () => {
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '安全草稿' });
    expect(() => editor.flush({ documentId: opened.documentId, sequence: 2, content: '原\0文' })).toThrow('空字符');
    expect(() => editor.flush({ documentId: opened.documentId, sequence: 2, content: '文'.repeat(700_000) })).toThrow('超过 2 MB');
    expect(documentResult(await editor.handle({ type: 'original_open' })).content).toBe('安全草稿');
    expect(editor.summary().acceptedSequence).toBe(1);
    editor.dispose();
  });

  it('跨剧集最后稿仍可交接，但保存和生成失败且不调用文件或模型', async () => {
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    mocks.state.currentProjectId = 'unrelated';
    notify();
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '切换时的最后输入' });
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('当前剧集已切换');
    await expect(editor.handle({ type: 'original_generate', mode: 'continue', start: 0, end: 0, instruction: '', expectedSequence: 1 })).rejects.toThrow('当前剧集已切换');
    expect(editor.summary().dirty).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
    editor.discard();
    expect(editor.summary().loaded).toBe(false);
    editor.dispose();
  });

  it('引用或交换代际变化拒绝旧会话，显式放弃后载入新引用', async () => {
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '需要保留的草稿' });
    mocks.state.projects[0] = { ...mocks.state.projects[0], exchangeEpoch: 1,
      series: { originalWork: { fileName: '新版.md', relativePath: 'original/new.md', addedAt: 2 } } };
    notify();
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('原著引用或剧集版本已变化');
    await expect(editor.handle({ type: 'original_reload' })).rejects.toThrow('请先保存草稿');
    mocks.read.mockResolvedValueOnce(textSnapshot('新版正文'));
    const reloaded = documentResult(await editor.handle({ type: 'original_reload', discard: true }));
    expect(reloaded.content).toBe('新版正文');
    expect(reloaded.fileName).toBe('新版.md');
    expect(reloaded.documentId).not.toBe(opened.documentId);
    expect(editor.summary().dirty).toBe(false);
    editor.dispose();
  });

  it('读取期间的最新稿不会被重新载入覆盖，UTF-8失败也保留草稿', async () => {
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    const pending = deferred<AssetTextSnapshot>();
    mocks.read.mockReturnValueOnce(pending.promise);
    const reloading = editor.handle({ type: 'original_reload', discard: true });
    await Promise.resolve();
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '读取期间继续写作' });
    pending.resolve(textSnapshot('磁盘正文'));
    await expect(reloading).rejects.toThrow('读取期间草稿已变化');
    mocks.read.mockRejectedValueOnce(new Error('文件不是有效 UTF-8，已停止编辑以避免乱码'));
    await expect(editor.handle({ type: 'original_reload', discard: true })).rejects.toThrow('UTF-8');
    expect(documentResult(await editor.handle({ type: 'original_open' })).content).toBe('读取期间继续写作');
    editor.dispose();
  });

  it('生成禁用工具与引用解析并限制材料，编辑后候选拒绝应用', async () => {
    const source = '前'.repeat(20_000) + '@file{素材}';
    mocks.read.mockResolvedValueOnce(textSnapshot(source));
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    const generated = documentResult(await editor.handle({ type: 'original_generate', mode: 'polish', start: 19_000,
      end: source.length, instruction: '保留风格', expectedSequence: 0 }));
    const request = mocks.stream.mock.calls[0][0] as StreamingCallOptions;
    expect(request).toMatchObject({ projectId: 'episode-1', tools: [], resolveVisualReferences: false, trackAbort: false });
    expect(request.userMessage.length).toBeLessThan(12_300);
    editor.flush({ documentId: opened.documentId, sequence: 1, content: source + '新输入' });
    await expect(editor.handle({ type: 'original_apply', candidateId: generated.candidate!.id })).rejects.toThrow('原文已变化');
    expect(documentResult(await editor.handle({ type: 'original_open' })).content).toBe(source + '新输入');
    editor.dispose();
  });

  it('迟到的生成请求不能把旧选区应用于已接受的新正文', async () => {
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '选区前插入了文字' });
    await expect(editor.handle({ type: 'original_generate', mode: 'polish', start: 0, end: 2, instruction: '', expectedSequence: 0 }))
      .rejects.toThrow('请重新选择写作位置或选区');
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(editor.summary().hasCandidate).toBe(false);
    editor.dispose();
  });

  it('项目切换开始立即中止未提交保存，文件冲突错误不丢稿', async () => {
    const editor = session();
    const opened = documentResult(await editor.handle({ type: 'original_open' }));
    editor.flush({ documentId: opened.documentId, sequence: 1, content: '需要保留的草稿' });
    mocks.save.mockRejectedValueOnce(new Error('磁盘文件已被修改，请保留草稿并重新载入后再保存'));
    await expect(editor.handle({ type: 'original_save' })).rejects.toThrow('磁盘文件已被修改');
    const pending = deferred<AssetTextSnapshot>();
    mocks.save.mockReturnValueOnce(pending.promise);
    const saving = editor.handle({ type: 'original_save' });
    const signal = mocks.save.mock.calls[1][3] as AbortSignal;
    mocks.state.switchingProjectName = '其他项目';
    notify();
    expect(signal.aborted).toBe(true);
    pending.resolve(textSnapshot('需要保留的草稿', 'saved'));
    await expect(saving).rejects.toThrow('当前剧集已切换');
    expect(editor.summary().dirty).toBe(true);
    editor.dispose();
  });
});
