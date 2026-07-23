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

function historyRecord(id: string, nodeId: string, timestamp: number): HistoryRecord {
  return {
    id,
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

    const records = await service.getNodeHistoryEntries('node-a');

    expect(records.map((record) => record.id)).toEqual(['node-a-new', 'node-a-old']);
  });
});
