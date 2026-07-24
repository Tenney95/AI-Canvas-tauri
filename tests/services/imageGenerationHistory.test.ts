import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../../src/services/indexedDbService';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

function historyRecord(
  id: string,
  nodeId: string,
  timestamp: number,
  projectId = 'project-a',
): HistoryRecord {
  return {
    id,
    projectId,
    nodeId,
    nodeLabel: nodeId,
    timestamp,
    prompt: `prompt-${id}`,
    output: `https://example.com/${id}.png`,
    nodeType: 'ai-image',
    model: 'image-model',
    provider: 'provider',
    status: 'success',
    mediaUrl: `https://example.com/${id}.png`,
  };
}

describe('getNodeHistoryEntries', () => {
  it('returns only the requested node history in reverse chronological order', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries([
      historyRecord('node-a-old', 'node-a', 100),
      historyRecord('node-b', 'node-b', 300),
      historyRecord('node-a-new', 'node-a', 200),
    ]);

    const records = await service.getNodeHistoryEntries('project-a', 'node-a');

    expect(records.map((record) => record.id)).toEqual(['node-a-new', 'node-a-old']);
  });

  it('isolates records by project and caps each project at 16 entries', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries([
      ...Array.from({ length: 17 }, (_, index) => (
        historyRecord(`a-${index}`, 'node-a', index, 'project-a')
      )),
      historyRecord('b-1', 'node-a', 100, 'project-b'),
    ]);

    const projectAPage = await service.getHistoryEntriesPage('project-a', 16);
    const projectBPage = await service.getHistoryEntriesPage('project-b', 16);

    expect(projectAPage.records).toHaveLength(16);
    expect(projectAPage.records.map((record) => record.id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `a-${16 - index}`),
    );
    expect(projectAPage.hasMore).toBe(false);
    expect(projectBPage.records.map((record) => record.id)).toEqual(['b-1']);
    await expect(service.getHistoryEntryCount('project-a')).resolves.toBe(16);
    await expect(service.getHistoryEntryCount('project-b')).resolves.toBe(1);
  });

  it('clears and deletes history only inside the target project', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.saveProjectToDb({
      id: 'project-a', name: 'A', createdAt: 1, updatedAt: 1, nodes: [], edges: [],
    });
    await service.saveProjectToDb({
      id: 'project-b', name: 'B', createdAt: 1, updatedAt: 1, nodes: [], edges: [],
    });
    await service.putHistoryEntries([
      historyRecord('a-1', 'node-a', 1, 'project-a'),
      historyRecord('b-1', 'node-b', 1, 'project-b'),
    ]);

    await service.clearAllHistoryEntries('project-a');
    await expect(service.getHistoryEntryCount('project-a')).resolves.toBe(0);
    await expect(service.getHistoryEntryCount('project-b')).resolves.toBe(1);

    await service.putHistoryEntry(historyRecord('a-2', 'node-a', 2, 'project-a'));
    await service.deleteProjectFromDb('project-a');

    await expect(service.getHistoryEntryCount('project-a')).resolves.toBe(0);
    await expect(service.getHistoryEntryCount('project-b')).resolves.toBe(1);
  });
});
