/**
 * historyRecord — 回归测试：project output history。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputHistoryEntry } from '../../src/types';
import type { HistoryPage, HistoryRecord } from '../../src/services/indexedDbService';

const fileServiceMocks = vi.hoisted(() => ({
  recycleHistoryFile: vi.fn(async (_project: string, _path: string, check: (exists: boolean) => void) => { check(true); }),
  exists: vi.fn(async () => true),
  persistMediaUrlToProjectData: vi.fn(async (_source: string) => ({
    filePath: '/project/data/generated.png',
    mediaUrl: 'asset:///project/data/generated.png',
    sourceUrl: 'asset:///project/data/generated.png',
  })),
}));

const historyMocks = vi.hoisted(() => ({
  putGlobalCharacterOrder: vi.fn(async () => undefined),
  putHistoryEntry: vi.fn(async (_record: HistoryRecord) => undefined),
  putHistoryEntries: vi.fn(async (_records: HistoryRecord[]) => undefined),
  deleteHistoryEntryFromDb: vi.fn(async () => undefined),
  getHistoryEntriesPage: vi.fn(async (): Promise<HistoryPage> => ({
    records: [], nextCursor: null, hasMore: false,
  })),
  getHistoryEntriesForExport: vi.fn(async (): Promise<HistoryRecord[]> => []),
  getHistoryEntryCount: vi.fn(async () => 0),
  getNodeHistoryEntries: vi.fn(async (): Promise<HistoryRecord[]> => []),
  hasCompletedHistoryMigration: vi.fn(async () => true),
  markHistoryMigrationCompleted: vi.fn(async () => undefined),
  claimLegacyHistoryEntries: vi.fn(async () => undefined),
  clearAllHistoryEntries: vi.fn(async () => undefined),
  deleteNodeHistoryEntries: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/indexedDbService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/indexedDbService')>(), ...historyMocks,
}));
vi.mock('../../src/services/fs/generatedAssetTags', () => ({
  tagGeneratedProjectAssetSafely: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/fs/core', () => ({
  // 本组夹具均为普通 POSIX 路径，没有 Windows 扩展长度前缀。
  stripVerbatimPrefix: (path: string) => path,
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
  getProjectDataDir: vi.fn(async () => '/project/data'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: fileServiceMocks.exists,
}));
vi.mock('../../src/services/fileService', () => ({
  recycleHistoryFile: fileServiceMocks.recycleHistoryFile,
  collectNodeFileReferences: (data: { filePath?: string }) => new Set(data.filePath ? [data.filePath] : []),
  isTransientMediaUrl: (url?: string) => Boolean(url && (/^data:/i.test(url) || /^blob:/i.test(url))),
  persistMediaUrlToProjectData: fileServiceMocks.persistMediaUrlToProjectData,
}));

import { useAppStore } from '../../src/store/useAppStore';

function historyEntry(index: number): Omit<OutputHistoryEntry, 'id' | 'projectId'> {
  return {
    nodeId: `node-${index}`,
    nodeLabel: `Node ${index}`,
    timestamp: index,
    prompt: `prompt-${index}`,
    output: `output-${index}`,
    nodeType: 'ai-text',
    model: 'model',
    provider: 'provider',
    status: 'success',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  historyMocks.getNodeHistoryEntries.mockReset().mockResolvedValue([]);
  historyMocks.putHistoryEntry.mockReset().mockResolvedValue(undefined);
  fileServiceMocks.recycleHistoryFile.mockImplementation(async (_project, _path, check) => { check(true); });
  fileServiceMocks.exists.mockResolvedValue(true);
  fileServiceMocks.persistMediaUrlToProjectData.mockResolvedValue({
    filePath: '/project/data/generated.png',
    mediaUrl: 'asset:///project/data/generated.png',
    sourceUrl: 'asset:///project/data/generated.png',
  });
  historyMocks.hasCompletedHistoryMigration.mockResolvedValue(true);
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('project output history', () => {
  const receipt = { projectId: 'project-a', nodeId: 'node-1', taskId: 'remote-1', attemptId: 'attempt-1' };
  const pendingDownload = (): OutputHistoryEntry => ({ ...historyEntry(1), id: 'original-history', projectId: 'project-a',
    nodeType: 'ai-image', status: 'download_pending', recoveryTask: receipt, prompt: '原提示词', error: '下载失败' });
  function installPendingDownload() {
    const entry = pendingDownload();
    useAppStore.setState({ currentProjectId: 'project-a', historyProjectId: 'project-a', outputHistoryRecords: [entry], historyTotalCount: 1 });
    historyMocks.getNodeHistoryEntries.mockResolvedValue([entry]);
    return entry;
  }

  it('重新交付更新原历史而非追加，保留原提示词、时间和 ID；重复回填不产生第二条', async () => {
    const original = installPendingDownload();
    const delivered = { ...historyEntry(1), nodeType: 'ai-image' as const, timestamp: 100, prompt: '当前节点的新提示词',
      output: 'asset:///project/data/result.png', mediaUrl: 'asset:///project/data/result.png', filePath: '/project/data/result.png' };
    await useAppStore.getState().recordOutputHistory('node-1', delivered, false, receipt);
    const saved = useAppStore.getState().outputHistoryRecords[0];
    expect(saved).toMatchObject({ id: original.id, timestamp: original.timestamp, prompt: '原提示词', status: 'success', filePath: delivered.filePath });
    expect(saved.error).toBeUndefined(); expect(useAppStore.getState().historyTotalCount).toBe(1);
    historyMocks.getNodeHistoryEntries.mockResolvedValue([saved]);
    await useAppStore.getState().recordOutputHistory('node-1', delivered, false, receipt);
    expect(useAppStore.getState().outputHistoryRecords).toHaveLength(1);
    expect(useAppStore.getState().outputHistoryRecords[0].id).toBe(original.id);
  });
  it('历史更新落盘失败不丢弃原待下载状态，也不替换另一尝试的历史', async () => {
    const original = installPendingDownload();
    historyMocks.putHistoryEntry.mockRejectedValueOnce(new Error('storage full'));
    await expect(useAppStore.getState().recordOutputHistory('node-1', historyEntry(1), false, receipt)).rejects.toThrow('storage full');
    expect(useAppStore.getState().outputHistoryRecords).toEqual([original]);
    await useAppStore.getState().recordOutputHistory('node-1', historyEntry(1), false, { ...receipt, attemptId: 'new-attempt' });
    expect(useAppStore.getState().outputHistoryRecords.find((entry) => entry.id === original.id)?.status).toBe('download_pending');
  });
  it('重试期间互斥，放弃保留历史且不触碰原文件', async () => {
    const original = installPendingDownload();
    const poll = await import('../../src/services/pollManager');
    let finish!: () => void;
    const retry = vi.spyOn(poll, 'retryHistoryMediaDownload').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const abandon = vi.spyOn(poll, 'abandonHistoryMediaDownload').mockImplementation(() => undefined);
    try {
      const first = useAppStore.getState().retryHistoryDownload(original.id);
      const second = useAppStore.getState().retryHistoryDownload(original.id);
      await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
      await expect(useAppStore.getState().abandonHistoryDownload(original.id)).rejects.toThrow('正在重新下载');
      expect(abandon).not.toHaveBeenCalled();
      expect(useAppStore.getState().historyDownloadBusyIds).toContain(original.id);
      finish(); await Promise.all([first, second]);
      expect(retry).toHaveBeenCalledWith(receipt); expect(useAppStore.getState().historyDownloadBusyIds).toEqual([]);
      await useAppStore.getState().abandonHistoryDownload(original.id);
      expect(abandon).toHaveBeenCalledWith(receipt);
      expect(useAppStore.getState().outputHistoryRecords[0]).toMatchObject({ id: original.id, status: 'abandoned' });
      expect(fileServiceMocks.recycleHistoryFile).not.toHaveBeenCalled(); expect(historyMocks.deleteHistoryEntryFromDb).not.toHaveBeenCalled();
    } finally { retry.mockRestore(); abandon.mockRestore(); }
  });
  it('放弃写入失败时不解除原任务，旧失败记录不根据文案绑定任务', async () => {
    const original = installPendingDownload();
    const poll = await import('../../src/services/pollManager');
    const abandon = vi.spyOn(poll, 'abandonHistoryMediaDownload').mockImplementation(() => undefined);
    try {
      historyMocks.putHistoryEntry.mockRejectedValueOnce(new Error('storage full'));
      await expect(useAppStore.getState().abandonHistoryDownload(original.id)).rejects.toThrow('storage full');
      expect(abandon).not.toHaveBeenCalled();
      historyMocks.getNodeHistoryEntries.mockResolvedValue([{ ...original, status: 'error', recoveryTask: undefined } as OutputHistoryEntry]);
      await expect(useAppStore.getState().retryHistoryDownload(original.id)).rejects.toThrow('无法确认原下载任务');
      expect(useAppStore.getState().historyDownloadBusyIds).toEqual([]);
    } finally { abandon.mockRestore(); }
  });

  it('propagates persistence errors when video replacement requires durable history', async () => {
    useAppStore.setState({ currentProjectId: 'project-a' });
    historyMocks.putHistoryEntry.mockRejectedValueOnce(new Error('storage full'));
    await expect(useAppStore.getState().recordOutputHistory('node-1', historyEntry(1), true)).rejects.toThrow('storage full');
    expect(useAppStore.getState().outputHistoryRecords).toHaveLength(0);
  });
  const mediaRecord = (): OutputHistoryEntry => ({ ...historyEntry(1), id: 'delete-me', projectId: 'project-a',
    nodeType: 'ai-image', filePath: '/project/data/old.png' });

  it('recycles the file before deleting the history record', async () => {
    historyMocks.getHistoryEntriesForExport.mockResolvedValueOnce([mediaRecord()]);
    useAppStore.setState({ currentProjectId: 'project-a', historyProjectId: 'project-a', outputHistoryRecords: [mediaRecord()], historyTotalCount: 1 });
    await useAppStore.getState().deleteHistoryEntryFile('project-a', 'delete-me');
    expect(fileServiceMocks.recycleHistoryFile).toHaveBeenCalled();
    expect(historyMocks.deleteHistoryEntryFromDb).toHaveBeenCalledWith('project-a', 'delete-me');
    expect(useAppStore.getState().outputHistoryRecords).toHaveLength(0);
  });

  it('retains the record when file recycling fails', async () => {
    historyMocks.getHistoryEntriesForExport.mockResolvedValueOnce([mediaRecord()]);
    fileServiceMocks.recycleHistoryFile.mockRejectedValueOnce(new Error('failed'));
    useAppStore.setState({ currentProjectId: 'project-a' });
    await expect(useAppStore.getState().deleteHistoryEntryFile('project-a', 'delete-me')).rejects.toThrow('failed');
    expect(historyMocks.deleteHistoryEntryFromDb).not.toHaveBeenCalled();
  });

  it('blocks files still used by canvas nodes', async () => {
    historyMocks.getHistoryEntriesForExport.mockResolvedValueOnce([mediaRecord()]);
    useAppStore.setState({ currentProjectId: 'project-a', nodes: [{ id: 'n', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'image', filePath: '/project/data/old.png' } }] });
    await expect(useAppStore.getState().deleteHistoryEntryFile('project-a', 'delete-me')).rejects.toThrow('仍被画布');
    expect(historyMocks.deleteHistoryEntryFromDb).not.toHaveBeenCalled();
  });

  it('cleans a missing file record even when its old path remains on canvas', async () => {
    historyMocks.getHistoryEntriesForExport.mockResolvedValueOnce([mediaRecord()]);
    fileServiceMocks.recycleHistoryFile.mockImplementationOnce(async (_project, _path, check) => { check(false); });
    useAppStore.setState({ currentProjectId: 'project-a', nodes: [{ id: 'missing', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'missing', filePath: '/project/data/old.png' } }] });
    await useAppStore.getState().deleteHistoryEntryFile('project-a', 'delete-me');
    expect(historyMocks.deleteHistoryEntryFromDb).toHaveBeenCalled();
  });

  it('blocks a file referenced by another history record', async () => {
    historyMocks.getHistoryEntriesForExport.mockResolvedValueOnce([mediaRecord(), { ...mediaRecord(), id: 'other' }]);
    useAppStore.setState({ currentProjectId: 'project-a' });
    await expect(useAppStore.getState().deleteHistoryEntryFile('project-a', 'delete-me')).rejects.toThrow('其他历史');
    expect(historyMocks.deleteHistoryEntryFromDb).not.toHaveBeenCalled();
  });

  it('rejects a stale project request', async () => {
    historyMocks.getHistoryEntriesForExport.mockResolvedValueOnce([mediaRecord()]);
    useAppStore.setState({ currentProjectId: 'project-b' });
    await expect(useAppStore.getState().deleteHistoryEntryFile('project-a', 'delete-me')).rejects.toThrow('项目已切换');
    expect(fileServiceMocks.recycleHistoryFile).not.toHaveBeenCalled();
  });

  it('loads and counts only the current project', async () => {
    const record: OutputHistoryEntry = {
      ...historyEntry(1),
      id: 'history-1',
      projectId: 'project-a',
    };
    historyMocks.getHistoryEntriesPage.mockResolvedValueOnce({
      records: [record],
      nextCursor: null,
      hasMore: false,
    });
    historyMocks.getHistoryEntryCount.mockResolvedValueOnce(1);
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [{
        id: 'node-1',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Node 1', type: 'ai-text', status: 'success' },
      }],
    });

    await useAppStore.getState().loadHistoryFromDb();

    expect(historyMocks.claimLegacyHistoryEntries).toHaveBeenCalledWith('project-a', ['node-1']);
    expect(historyMocks.getHistoryEntriesPage).toHaveBeenCalledWith(
      'project-a',
      16,
      null,
      {},
    );
    expect(historyMocks.getHistoryEntryCount).toHaveBeenCalledWith('project-a');
    expect(useAppStore.getState()).toMatchObject({
      outputHistoryRecords: [record],
      historyProjectId: 'project-a',
      historyTotalCount: 1,
    });
  });

  it('injects the current project and keeps at most 16 records in memory', async () => {
    useAppStore.setState({ currentProjectId: 'project-a' });

    for (let index = 0; index < 17; index++) {
      await useAppStore.getState().recordOutputHistory(`node-${index}`, historyEntry(index));
    }

    const state = useAppStore.getState();
    expect(historyMocks.putHistoryEntry).toHaveBeenCalledTimes(17);
    expect(historyMocks.putHistoryEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'project-a', nodeId: 'node-16' }),
    );
    expect(state.outputHistoryRecords).toHaveLength(16);
    expect(state.outputHistoryRecords.every((record) => record.projectId === 'project-a')).toBe(true);
    expect(state.historyTotalCount).toBe(16);
    expect(state.historyProjectId).toBe('project-a');
  });

  it('replaces the in-memory page when recording in another project', async () => {
    useAppStore.setState({ currentProjectId: 'project-a' });
    await useAppStore.getState().recordOutputHistory('node-a', historyEntry(1));

    useAppStore.setState({ currentProjectId: 'project-b' });
    await useAppStore.getState().recordOutputHistory('node-b', historyEntry(2));

    expect(useAppStore.getState().outputHistoryRecords).toEqual([
      expect.objectContaining({ projectId: 'project-b', nodeId: 'node-2' }),
    ]);
    expect(useAppStore.getState().historyTotalCount).toBe(1);
    expect(useAppStore.getState().historyProjectId).toBe('project-b');
  });

  it.each(['data:image/png;base64,AQID', 'blob:这是生成的文本，不是图片地址'])('文本正文 %s 按纯文本耐久保存并原样读取，不调用媒体持久化', async (output) => {
    useAppStore.setState({ currentProjectId: 'project-a' });
    await useAppStore.getState().recordOutputHistory('node-1', { ...historyEntry(1), output }, true);
    const saved = historyMocks.putHistoryEntry.mock.calls[0][0];
    expect(saved).toMatchObject({ nodeType: 'ai-text', output, status: 'success' });
    expect(saved.mediaUrl).toBeUndefined();
    expect(saved.filePath).toBeUndefined();
    expect(fileServiceMocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
    historyMocks.getHistoryEntriesPage.mockResolvedValueOnce({ records: [saved], nextCursor: null, hasMore: false });
    historyMocks.getHistoryEntryCount.mockResolvedValueOnce(1);
    await useAppStore.getState().loadHistoryFromDb();
    expect(useAppStore.getState().outputHistoryRecords[0]).toMatchObject({ output, status: 'success' });
    expect(historyMocks.putHistoryEntries).not.toHaveBeenCalled();
    expect(fileServiceMocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
  });

  it('文本正文仍保持原文，显式媒体附件继续按原规则持久化', async () => {
    useAppStore.setState({ currentProjectId: 'project-a' });
    const output = 'data:这是正文';
    const mediaUrl = 'data:image/png;base64,AQID';
    await useAppStore.getState().recordOutputHistory('node-1', { ...historyEntry(1), output, mediaUrl }, true);
    expect(fileServiceMocks.persistMediaUrlToProjectData).toHaveBeenCalledOnce();
    expect(fileServiceMocks.persistMediaUrlToProjectData.mock.calls[0][0]).toBe(mediaUrl);
    expect(historyMocks.putHistoryEntry).toHaveBeenCalledWith(expect.objectContaining({ output,
      mediaUrl: 'asset:///project/data/generated.png', filePath: '/project/data/generated.png' }));
  });

  it('replaces inline history media with that record own project-file reference', async () => {
    const inline = 'data:image/png;base64,AQID';
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [{
        id: 'node-inline',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Inline image',
          type: 'ai-image',
          status: 'success',
          filePath: '/project/data/generated.png',
          imageUrl: 'asset:///project/data/generated.png',
        },
      }],
    });

    await useAppStore.getState().recordOutputHistory('node-inline', {
      ...historyEntry(1),
      nodeId: 'node-inline',
      nodeType: 'ai-image',
      output: inline,
      mediaUrl: inline,
      filePath: '/project/data/generated.png',
    });

    expect(historyMocks.putHistoryEntry).toHaveBeenCalledWith(expect.objectContaining({
      output: 'asset:///project/data/generated.png',
      mediaUrl: 'asset:///project/data/generated.png',
      filePath: '/project/data/generated.png',
    }));
    expect(JSON.stringify(historyMocks.putHistoryEntry.mock.calls[0][0])).not.toContain('data:image');
    expect(fileServiceMocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
  });

  it('does not reuse a history file outside the current project directory', async () => {
    const inline = 'data:image/png;base64,AQID';
    useAppStore.setState({ currentProjectId: 'project-a' });

    await useAppStore.getState().recordOutputHistory('node-inline', {
      ...historyEntry(1),
      nodeId: 'node-inline',
      nodeType: 'ai-image',
      output: inline,
      mediaUrl: inline,
      filePath: '/external/generated.png',
    });

    expect(fileServiceMocks.persistMediaUrlToProjectData).toHaveBeenCalledWith(
      inline,
      'project-a',
      'ai-image',
      expect.stringContaining('历史'),
      { deduplicateByContent: true },
    );
    expect(historyMocks.putHistoryEntry).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/project/data/generated.png',
      mediaUrl: 'asset:///project/data/generated.png',
    }));
  });

  it('keeps the successful record intact when the inline media migration fails', async () => {
    const inline = 'data:image/png;base64,AQID';
    const record: OutputHistoryEntry = {
      ...historyEntry(1),
      id: 'history-inline',
      projectId: 'project-a',
      nodeId: 'node-inline',
      nodeType: 'ai-image',
      output: inline,
      mediaUrl: inline,
    };
    historyMocks.getHistoryEntriesPage.mockResolvedValueOnce({
      records: [record],
      nextCursor: null,
      hasMore: false,
    });
    historyMocks.getHistoryEntryCount.mockResolvedValueOnce(1);
    fileServiceMocks.persistMediaUrlToProjectData.mockRejectedValueOnce(new Error('磁盘不可写'));
    useAppStore.setState({ currentProjectId: 'project-a', nodes: [] });

    await useAppStore.getState().loadHistoryFromDb();

    // 磁盘暂时不可写不该把成功记录永久改成 error，下次打开还能再迁一次
    expect(historyMocks.putHistoryEntries).not.toHaveBeenCalled();
    expect(useAppStore.getState().outputHistoryRecords[0]).toMatchObject({
      status: 'error',
      mediaUrl: undefined,
    });
  });

  it('normalizes every legacy record before writing history and never borrows the latest node file', async () => {
    const first = 'data:image/png;base64,AQID';
    const second = 'data:image/png;base64,BAUG';
    historyMocks.hasCompletedHistoryMigration.mockResolvedValue(false);
    fileServiceMocks.persistMediaUrlToProjectData.mockImplementation(async (source: string) => {
      const name = source === first ? 'first.png' : 'second.png';
      return {
        filePath: `/project/data/${name}`,
        mediaUrl: `asset:///project/data/${name}`,
        sourceUrl: `asset:///project/data/${name}`,
      };
    });
    const saveCurrentProjectSilent = vi.fn(async () => 'project-a');
    const legacyRecords: OutputHistoryEntry[] = [
      {
        ...historyEntry(1),
        id: 'legacy-first',
        projectId: '',
        nodeId: 'node-inline',
        nodeType: 'ai-image',
        output: first,
        mediaUrl: first,
      },
      {
        ...historyEntry(2),
        id: 'legacy-second',
        projectId: '',
        nodeId: 'node-inline',
        nodeType: 'ai-image',
        output: second,
        mediaUrl: second,
      },
    ];
    useAppStore.setState({
      currentProjectId: 'project-a',
      projectLoadStatus: 'ready',
      saveCurrentProjectSilent,
      nodes: [{
        id: 'node-inline',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Inline image',
          type: 'ai-image',
          status: 'success',
          filePath: '/project/data/latest.png',
          outputHistory: legacyRecords,
        },
      }],
    });

    await useAppStore.getState().migrateHistoryAndLoad();

    expect(fileServiceMocks.persistMediaUrlToProjectData).toHaveBeenCalledTimes(2);
    expect(historyMocks.putHistoryEntries).toHaveBeenCalledTimes(1);
    const persisted = historyMocks.putHistoryEntries.mock.calls[0][0];
    expect(JSON.stringify(persisted)).not.toContain('data:image');
    expect(persisted.map((record) => record.filePath)).toEqual([
      '/project/data/first.png',
      '/project/data/second.png',
    ]);
    expect(persisted.every((record) => record.filePath !== '/project/data/latest.png')).toBe(true);
    expect(saveCurrentProjectSilent).toHaveBeenCalledTimes(1);
    expect(historyMocks.markHistoryMigrationCompleted).toHaveBeenCalledWith('project-a');
    expect(useAppStore.getState().nodes[0].data).not.toHaveProperty('outputHistory');
  });

  it('keeps legacy node history when any media record cannot be migrated', async () => {
    const inline = 'data:image/png;base64,AQID';
    historyMocks.hasCompletedHistoryMigration.mockResolvedValue(false);
    fileServiceMocks.persistMediaUrlToProjectData.mockRejectedValueOnce(new Error('磁盘不可写'));
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [{
        id: 'node-inline',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Inline image',
          type: 'ai-image',
          status: 'success',
          outputHistory: [{
            ...historyEntry(1),
            id: 'legacy-inline',
            projectId: '',
            nodeId: 'node-inline',
            nodeType: 'ai-image',
            output: inline,
            mediaUrl: inline,
          }],
        },
      }],
    });

    await useAppStore.getState().migrateHistoryAndLoad();

    expect(historyMocks.putHistoryEntries).not.toHaveBeenCalled();
    expect(historyMocks.markHistoryMigrationCompleted).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes[0].data).toHaveProperty('outputHistory');
  });

  it('does not persist history without a current project', async () => {
    useAppStore.setState({ currentProjectId: null });

    await useAppStore.getState().recordOutputHistory('node-a', historyEntry(1));

    expect(historyMocks.putHistoryEntry).not.toHaveBeenCalled();
    expect(useAppStore.getState().outputHistoryRecords).toEqual([]);
  });
});
