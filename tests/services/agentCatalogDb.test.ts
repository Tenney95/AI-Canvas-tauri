import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPackageInstallation } from '../../src/types/agentPackage';

function installation(
  id = 'installation-1',
  packageId = 'com.example.agent',
): AgentPackageInstallation {
  return {
    id,
    packageId,
    manifest: {
      schemaVersion: 1,
      id: packageId,
      name: '测试智能体',
      version: '1.0.0',
      entrypoints: { instructions: 'AGENTS.md' },
      supportedScopes: ['global', 'project'],
      supportedSurfaces: ['assistant'],
      routing: { userInvocable: true, autoInvoke: false },
    },
    source: {
      sourceId: `source:${id}`,
      sourceType: 'folder',
      displayName: '测试智能体',
    },
    entrypoints: ['AGENTS.md'],
    skillCount: 1,
    fileCount: 2,
    totalBytes: 1024,
    warnings: [],
    health: 'ready',
    contentHash: 'a'.repeat(64),
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

describe('independent Agent Catalog IndexedDB', () => {
  it('creates only the v1 installations catalog and expected indexes', async () => {
    const catalog = await import('../../src/services/agentPackages/agentCatalogDb');
    const db = await catalog.openAgentCatalogDb();

    expect(db.name).toBe('ai-canvas-agent-catalog');
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames]).toEqual(['installations']);
    const store = db.transaction('installations', 'readonly').objectStore('installations');
    expect([...store.indexNames]).toEqual(['health', 'packageId', 'updatedAt']);
  });

  it('persists, lists and deletes sanitized installation records', async () => {
    const catalog = await import('../../src/services/agentPackages/agentCatalogDb');
    const record = installation();

    await catalog.putAgentInstallation(record);
    await expect(catalog.getAllAgentInstallations()).resolves.toEqual([record]);

    await catalog.deleteAgentInstallation(record.id);
    await expect(catalog.getAllAgentInstallations()).resolves.toEqual([]);
  });

  it('enforces one installed record per packageId', async () => {
    const catalog = await import('../../src/services/agentPackages/agentCatalogDb');
    await catalog.putAgentInstallation(installation('installation-1'));

    await expect(catalog.putAgentInstallation(installation('installation-2')))
      .rejects.toBeTruthy();
    await expect(catalog.getAllAgentInstallations()).resolves.toHaveLength(1);
  });
});
