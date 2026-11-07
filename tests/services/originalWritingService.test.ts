/** 原著编辑会话的正文边界、异步保存与过期候选回归。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject } from '../../src/types';
import type { AssetTextSnapshot } from '../../src/services/fileService';
import type { StreamingCallOptions } from '../../src/services/ai/assistantStream';
import type { OriginalWritingDocument } from '../../src/types/originalWriting';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), save: vi.fn(), stream: vi.fn(), model: vi.fn(), directory: vi.fn(),
  listeners: new Set<() => void>(),
  state: { currentProjectId: 'episode-1', projectLoadStatus: 'ready', isCreatingProject: false,
    isReturningToStartPage: false, switchingProjectName: null as string | null, projects: [] as CanvasProject[] },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: () => mocks.state,
  subscribe: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: () => true, getProjectDataDir: mocks.directory,
  joinPath: (...segments: string[]) => segments.join('/'),
  readAssetTextFile: mocks.read, saveAssetTextFile: mocks.save,
}));
vi.mock('../../src/services/ai/assistantStream', () => ({ streamAssistantReply: mocks.stream, resolveAssistantModel: mocks.model }));
vi.mock('../../src/services/seriesSourceService', () => ({ indexSeriesChapters: (text: string) => text ? [{ start: 0, end: text.length }] : [] }));

import { createOriginalWritingSession } from '../../src/services/originalWritingService';

function textSnapshot(content: string, digest = 'initial'): AssetTextSnapshot {
  return { content, digest, size: new TextEncoder().encode(content).length, modified: 1, bom: false, newline: 'LF' };
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
      series: { originalWork: { fileName: '原著.md', relativePath: 'original/source.md', addedAt: 1 } } },
    { id: 'episode-1', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 }] };
  mocks.directory.mockResolvedValue('/series-data');
  mocks.read.mockResolvedValue(textSnapshot('# 第一章\n秘密原文。'));
  mocks.save.mockImplementation(async (_path: string, _baseline: AssetTextSnapshot, content: string) => textSnapshot(content, 'saved'));
  mocks.model.mockReturnValue({ selectionId: 'configured-text-model' });
  mocks.stream.mockImplementation(async (request: StreamingCallOptions) => {
    request.onEvent({ type: 'done', finishReason: 'stop' });
    return '新的正文。';
  });
});

describe('原文主窗口编辑会话', () => {
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
