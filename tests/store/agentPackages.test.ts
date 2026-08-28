import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type {
  AgentPackageInstallation,
  AgentPackageManifest,
  AgentSourcePreview,
} from '../../src/types/agentPackage';

const dbMocks = vi.hoisted(() => ({
  deleteAgentInstallation: vi.fn(),
  getAllAgentInstallations: vi.fn(),
  putAgentInstallation: vi.fn(),
}));

vi.mock('../../src/services/agentPackages/agentCatalogDb', () => dbMocks);

import { createAgentPackageSlice } from '../../src/store/store.agentPackages';

const HASH = 'b'.repeat(64);

function manifest(): AgentPackageManifest {
  return {
    schemaVersion: 1,
    id: 'com.example.agent',
    name: '全局智能体',
    version: '1.0.0',
    entrypoints: { instructions: 'AGENTS.md' },
    supportedScopes: ['global', 'project'],
    supportedSurfaces: ['assistant'],
    routing: { userInvocable: true, autoInvoke: false },
  };
}

function preview(partial: Partial<AgentSourcePreview> = {}): AgentSourcePreview {
  return {
    sourceId: 'agent-source:1',
    sourceType: 'folder',
    name: '全局智能体',
    version: '1.0.0',
    manifest: manifest(),
    entrypoints: ['AGENTS.md'],
    instructionText: '# 全局智能体说明',
    skillCount: 3,
    fileCount: 10,
    totalBytes: 2048,
    warnings: [],
    health: 'ready',
    contentHash: HASH,
    ...partial,
  };
}

function installation(partial: Partial<AgentPackageInstallation> = {}): AgentPackageInstallation {
  return {
    id: 'agent-package-existing',
    packageId: manifest().id,
    manifest: manifest(),
    source: {
      sourceId: 'agent-source:1',
      sourceType: 'folder',
      displayName: '全局智能体',
    },
    entrypoints: ['AGENTS.md'],
    skillCount: 3,
    fileCount: 10,
    totalBytes: 2048,
    warnings: [],
    health: 'ready',
    contentHash: HASH,
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function createSlice(initial: AgentPackageInstallation[] = []) {
  let state = {
    agentPackages: initial,
    agentCatalogStatus: 'idle',
    agentCatalogErrorCode: undefined,
  } as unknown as AppState;
  const set = (next: Partial<AppState> | ((current: AppState) => Partial<AppState>)) => {
    const patch = typeof next === 'function' ? next(state) : next;
    state = { ...state, ...patch };
  };
  const slice = createAgentPackageSlice(set as never, () => state, {} as never);
  state = { ...state, ...slice, agentPackages: initial };
  return { slice, getState: () => state };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getAllAgentInstallations.mockResolvedValue([]);
  dbMocks.putAgentInstallation.mockResolvedValue(undefined);
  dbMocks.deleteAgentInstallation.mockResolvedValue(undefined);
});

describe('Agent Package Store', () => {
  it('installs a native preview as a global record without persisting a path', async () => {
    const { slice, getState } = createSlice();

    const result = await slice.installAgentPackagePreview(preview());

    expect(result).toMatchObject({
      packageId: 'com.example.agent',
      enabled: true,
      source: {
        sourceId: 'agent-source:1',
        sourceType: 'folder',
        displayName: '全局智能体',
      },
    });
    expect(result).not.toHaveProperty('instructionText');
    expect(JSON.stringify(result)).not.toContain('G:\\');
    expect(dbMocks.putAgentInstallation).toHaveBeenCalledWith(result);
    expect(getState()).toMatchObject({
      agentPackages: [result],
      agentCatalogStatus: 'ready',
      agentCatalogErrorCode: undefined,
    });
  });

  it('preserves the installation id and enabled state when updating a package', async () => {
    const current = installation({ enabled: false });
    const { slice } = createSlice([current]);

    const result = await slice.installAgentPackagePreview(preview({
      version: '1.1.0',
      manifest: { ...manifest(), version: '1.1.0' },
      contentHash: 'c'.repeat(64),
    }));

    expect(result.id).toBe(current.id);
    expect(result.enabled).toBe(false);
    expect(result.manifest.version).toBe('1.1.0');
  });

  it('creates a disabled host-side manifest for legacy folders without writing to source', async () => {
    const { slice } = createSlice();

    const result = await slice.installAgentPackagePreview(preview({
      manifest: null,
      health: 'degraded',
    }));

    expect(result).toMatchObject({
      packageId: `legacy.${HASH.slice(0, 16)}`,
      enabled: false,
      manifest: {
        entrypoints: { instructions: 'AGENTS.md' },
        routing: { userInvocable: true, autoInvoke: false },
      },
    });
    expect(dbMocks.putAgentInstallation).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid package previews before persistence', async () => {
    const { slice } = createSlice();

    await expect(slice.installAgentPackagePreview(preview({ health: 'invalid' })))
      .rejects.toThrow('不可安装');
    expect(dbMocks.putAgentInstallation).not.toHaveBeenCalled();
  });

  it('persists enable changes and removes only the local catalog record', async () => {
    const current = installation();
    const { slice, getState } = createSlice([current]);

    await slice.setAgentPackageEnabled(current.id, false);
    expect(dbMocks.putAgentInstallation).toHaveBeenCalledWith(expect.objectContaining({
      id: current.id,
      enabled: false,
    }));
    expect(getState().agentPackages[0].enabled).toBe(false);

    await slice.removeAgentPackageRecord(current.id);
    expect(dbMocks.deleteAgentInstallation).toHaveBeenCalledWith(current.id);
    expect(getState().agentPackages).toEqual([]);
  });

  it('degrades to an empty catalog when the optional database cannot load', async () => {
    dbMocks.getAllAgentInstallations.mockRejectedValue(new Error('catalog unavailable'));
    const { slice, getState } = createSlice([installation()]);

    await expect(slice.loadAgentPackages()).resolves.toBeUndefined();

    expect(getState()).toMatchObject({
      agentPackages: [],
      agentCatalogStatus: 'degraded',
      agentCatalogErrorCode: 'AGENT_CATALOG_LOAD_FAILED',
    });
  });

  it('keeps valid records but marks the catalog degraded when one record is corrupt', async () => {
    dbMocks.getAllAgentInstallations.mockResolvedValue([
      installation(),
      { ...installation({ id: 'broken' }), source: { path: 'G:\\secret' } },
    ]);
    const { slice, getState } = createSlice();

    await slice.loadAgentPackages();

    expect(getState().agentPackages).toEqual([installation()]);
    expect(getState()).toMatchObject({
      agentCatalogStatus: 'degraded',
      agentCatalogErrorCode: 'AGENT_CATALOG_RECORD_INVALID',
    });
  });
});
