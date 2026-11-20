/**
 * nodeMediaCopy — 回归测试：independent node media files。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const mock = vi.hoisted(() => ({ copy: vi.fn(), persist: vi.fn(), trash: vi.fn() }));
vi.mock('../../src/services/fileService', () => ({
  copyFileToProjectData: mock.copy, persistMediaUrlToProjectData: mock.persist, moveToUndoTrash: mock.trash,
}));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true }));
import { copyNodeMedia, discardCopiedNodeMedia, isNodeMediaCopySource, needsNodeMediaCopy } from '../../src/services/nodeMediaCopy';

const source: BaseNodeData = { type: 'ai-image', label: 'image', filePath: '/p/source.png',
  imageUrl: 'asset:///p/source.png', thumbnailUrl: 'asset:///p/source.png', assetId: 'old', relativePath: 'source.png',
  artifactId: 'chat-result', storageRootRef: 'original-root', outputHistory: [{ id: 'old-record' }] };

beforeEach(() => {
  vi.clearAllMocks();
  let sequence = 0;
  mock.copy.mockImplementation(async () => {
    const filePath = `/p/copy-${++sequence}.png`;
    return { filePath, assetUrl: `asset://${filePath}` };
  });
});

describe('independent node media files', () => {
  it('does not invent media fields for a file-only node', async () => {
    const result = await copyNodeMedia({ type: 'ai-text', label: 'text', filePath: '/p/text.txt', output: 'text' }, 'p');
    expect(result.imageUrl).toBeUndefined();
    expect(result.videoUrl).toBeUndefined();
    expect(result.audioUrl).toBeUndefined();
    expect(result.output).toBe('text');
  });
  it('allocates separate files for repeated copies without changing the source', async () => {
    const [a, b] = await Promise.all([copyNodeMedia(source, 'p'), copyNodeMedia(source, 'p')]);
    expect(a.filePath).not.toBe(b.filePath);
    expect(a.filePath).not.toBe(source.filePath);
    expect(a.assetId).toBeUndefined();
    expect(a.relativePath).toBeUndefined();
    expect(a.artifactId).toBeUndefined();
    expect(a.storageRootRef).toBeUndefined();
    expect(a.outputHistory).toBeUndefined();
    expect(source.artifactId).toBe('chat-result');
    expect(source.outputHistory).toEqual([{ id: 'old-record' }]);
    expect(a.thumbnailUrl).toBe(a.imageUrl);
    expect(source.filePath).toBe('/p/source.png');
  });

  it('pins the source while queued and in progress, then releases it', async () => {
    let finish!: (value: unknown) => void;
    mock.copy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = copyNodeMedia(source, 'p');
    expect(isNodeMediaCopySource('/p/source.png')).toBe(true);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish({ filePath: '/p/new.png', assetUrl: 'asset:///p/new.png' });
    await pending;
    expect(isNodeMediaCopySource('/p/source.png')).toBe(false);
  });

  it('copies every storyboard cell even when they originally share one file', async () => {
    const result = await copyNodeMedia({ ...source, storyboardOverrides: [
      { filePath: source.filePath, url: source.imageUrl! },
      { filePath: source.filePath, url: source.imageUrl! },
    ] }, 'p');
    expect(new Set([result.filePath, ...result.storyboardOverrides!.map((cell) => cell!.filePath)]).size).toBe(3);
  });

  it('recycles only staged files after partial failure', async () => {
    mock.copy.mockResolvedValueOnce({ filePath: '/p/new.png', assetUrl: 'asset:///p/new.png' }).mockResolvedValueOnce(null);
    await expect(copyNodeMedia({ ...source, storyboardOverrides: [{ filePath: '/p/cell.png', url: 'asset:///p/cell.png' }] }, 'p')).rejects.toThrow('复制失败');
    expect(mock.trash).toHaveBeenCalledExactlyOnceWith('/p/new.png');
    expect(isNodeMediaCopySource('/p/source.png')).toBe(false);
  });

  it('does not publish a shotlist with an unresolved source-project binding', async () => {
    const sheet: BaseNodeData = { type: 'ai-shotlist', label: '分镜', shotlistRows: [
      { id: 'row', shotNo: '1', frame: { nodeId: 'frame', kind: 'image', filePath: '/a/frame.png' },
        video: { nodeId: 'missing', kind: 'video', assetId: 'original-asset', relativePath: 'lost.mp4' } },
    ] };
    expect(needsNodeMediaCopy(sheet)).toBe(false);
    expect(needsNodeMediaCopy(sheet, true)).toBe(true);
    await expect(copyNodeMedia(sheet, 'b', { copiedSources: new Map(), targetId: (id) => `new-${id}` })).rejects.toThrow();
    expect(mock.trash).toHaveBeenCalledExactlyOnceWith('/p/copy-1.png');
  });

  it('persists remote media and does not allow content deduplication', async () => {
    mock.persist.mockResolvedValueOnce({ filePath: '/p/download.png', mediaUrl: 'asset:///p/download.png' });
    const result = await copyNodeMedia({ type: 'ai-image', label: 'remote', imageUrl: 'https://example.com/image.png' }, 'p');
    expect(result.filePath).toBe('/p/download.png');
    expect(mock.persist).toHaveBeenCalledWith(expect.any(String), 'p', 'copy', undefined, { deduplicateByContent: false, redactErrors: true });
  });

  it('copies and pins an internal outpaint input without inheriting the source project identity', async () => {
    const original: BaseNodeData = { type: 'ai-image', label: 'expanded', outpaintInput: {
      url: 'asset://localhost/p/padding.png', assetId: 'source-padding', relativePath: 'padding.png', storageRootRef: 'source-root', width: 1024, height: 768,
    } };
    Object.assign(original.outpaintInput!, { filePath: '/p/padding.png' });
    expect(needsNodeMediaCopy(original)).toBe(true);
    let finish!: (value: unknown) => void;
    mock.copy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = copyNodeMedia(original, 'other-project');
    expect(isNodeMediaCopySource('/p/padding.png')).toBe(true);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish({ filePath: '/other/padding-copy.png', assetUrl: 'asset://localhost/other/padding-copy.png' });
    const result = await pending;
    expect(mock.copy).toHaveBeenCalledWith('/p/padding.png', 'other-project', { redactErrors: true });
    expect(result.outpaintInput).toEqual({ url: 'asset://localhost/other/padding-copy.png', width: 1024, height: 768 });
    expect(original.outpaintInput).toMatchObject({ assetId: 'source-padding', relativePath: 'padding.png', storageRootRef: 'source-root', filePath: '/p/padding.png' });
    expect(isNodeMediaCopySource('/p/padding.png')).toBe(false);
    await discardCopiedNodeMedia(result, original);
    expect(mock.trash).toHaveBeenCalledExactlyOnceWith('/other/padding-copy.png');
  });

  it('does not publish a copy with an unavailable internal outpaint input', async () => {
    const original = { ...source, outpaintInput: { assetId: 'missing-padding', relativePath: 'missing.png', width: 1024, height: 768 } };
    await expect(copyNodeMedia(original, 'p')).rejects.toThrow('素材复制失败');
    expect(mock.trash).toHaveBeenCalledExactlyOnceWith('/p/copy-1.png');
    expect(original.outpaintInput.assetId).toBe('missing-padding');
  });
});
