import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputHistoryEntry } from '../../src/types';
import type { HistoryPage } from '../../src/services/indexedDbService';

const historyMocks = vi.hoisted(() => ({
  putHistoryEntry: vi.fn(async () => undefined),
  putHistoryEntries: vi.fn(async () => undefined),
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

  it('does not persist history without a current project', async () => {
    useAppStore.setState({ currentProjectId: null });

    await useAppStore.getState().recordOutputHistory('node-a', historyEntry(1));

    expect(historyMocks.putHistoryEntry).not.toHaveBeenCalled();
    expect(useAppStore.getState().outputHistoryRecords).toEqual([]);
  });
});
