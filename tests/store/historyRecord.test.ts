import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputHistoryEntry } from '../../src/types';
import type { HistoryPage, HistoryRecord } from '../../src/services/indexedDbService';

const fileServiceMocks = vi.hoisted(() => ({
  exists: vi.fn(async () => true),
  persistMediaUrlToProjectData: vi.fn(async (_source: string) => ({
    filePath: '/project/data/generated.png',
    mediaUrl: 'asset:///project/data/generated.png',
    sourceUrl: 'asset:///project/data/generated.png',
  })),
}));

const historyMocks = vi.hoisted(() => ({
  putHistoryEntry: vi.fn(async (_record: HistoryRecord) => undefined),
  putHistoryEntries: vi.fn(async (_records: HistoryRecord[]) => undefined),
  deleteHistoryEntryFromDb: vi.fn(async () => undefined),
  getHistoryEntriesPage: vi.fn(async (): Promise<HistoryPage> => ({
    records: [], nextCursor: null, hasMore: false,
  })),
  getHistoryEntriesForExport: vi.fn(async () => []),
  getHistoryEntryCount: vi.fn(async () => 0),
  hasCompletedHistoryMigration: vi.fn(async () => true),
  markHistoryMigrationCompleted: vi.fn(async () => undefined),
  claimLegacyHistoryEntries: vi.fn(async () => undefined),
  clearAllHistoryEntries: vi.fn(async () => undefined),
  deleteNodeHistoryEntries: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/indexedDbService', () => historyMocks);
vi.mock('../../src/services/fs/generatedAssetTags', () => ({
  tagGeneratedProjectAssetSafely: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/fs/core', () => ({
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
  getProjectDataDir: vi.fn(async () => '/project/data'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: fileServiceMocks.exists,
}));
vi.mock('../../src/services/fileService', () => ({
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
