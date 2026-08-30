import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type {
  AgentPackageInstallation,
  AgentPackageManifest,
  AgentPackageSkill,
  AgentSourcePreview,
} from '../../src/types/agentPackage';

const dbMocks = vi.hoisted(() => ({
  deleteAgentInstallation: vi.fn(),
  getAllAgentInstallations: vi.fn(),
  putAgentInstallation: vi.fn(),
}));
const skillCatalogMocks = vi.hoisted(() => ({
  loadAgentPackageSkillCatalog: vi.fn(),
}));

vi.mock('../../src/services/agentPackages/agentCatalogDb', () => dbMocks);
vi.mock('../../src/services/agentPackages/agentPackageSkillService', () => skillCatalogMocks);

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
    mcpSkillReadEnabled: false,
    installedAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function runtimeSkill(
  source: AgentPackageInstallation = installation(),
  partial: Partial<AgentPackageSkill> = {},
): AgentPackageSkill {
  return {
    id: 'ap-skill-existing',
    name: '短剧 Skill',
    description: '短剧创作资料',
    fileName: 'SKILL.md',
    content: '# 短剧 Skill',
    sourceType: 'agent-package',
    createdAt: 1,
    installationId: source.id,
    packageId: source.packageId,
    packageName: source.manifest.name,
    packageVersion: source.manifest.version,
    packageContentHash: source.contentHash,
    sourceId: source.source.sourceId,
    entryPath: 'skills/drama/SKILL.md',
    skillRoot: 'skills/drama',
    contentHash: 'd'.repeat(64),
    branch: 'shared',
    packageUserInvocable: true,
    packageAutoInvoke: false,
    mcpSkillReadEnabled: source.mcpSkillReadEnabled,
    readOnly: true,
    ...partial,
  };
}

function createSlice(
  initial: AgentPackageInstallation[] = [],
  initialSkills: AgentPackageSkill[] = [],
) {
  let state = {
    agentPackages: initial,
    agentCatalogStatus: 'idle',
    agentCatalogErrorCode: undefined,
    agentPackageSkills: initialSkills,
    agentPackageSkillCatalogStatus: 'idle',
    agentPackageSkillCatalogRevision: '',
  } as unknown as AppState;
  const set = (next: Partial<AppState> | ((current: AppState) => Partial<AppState>)) => {
    const patch = typeof next === 'function' ? next(state) : next;
    state = { ...state, ...patch };
  };
  const slice = createAgentPackageSlice(set as never, () => state, {} as never);
  state = {
    ...state,
    ...slice,
    agentPackages: initial,
    agentPackageSkills: initialSkills,
  };
  return { slice, getState: () => state };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getAllAgentInstallations.mockResolvedValue([]);
  dbMocks.putAgentInstallation.mockResolvedValue(undefined);
  dbMocks.deleteAgentInstallation.mockResolvedValue(undefined);
  skillCatalogMocks.loadAgentPackageSkillCatalog.mockResolvedValue({ skills: [], failures: [] });
});

describe('Agent Package Store', () => {
  it('installs a native preview as a global record without persisting a path', async () => {
    const { slice, getState } = createSlice();

    const result = await slice.installAgentPackagePreview(preview());

    expect(result).toMatchObject({
      packageId: 'com.example.agent',
      enabled: true,
      mcpSkillReadEnabled: false,
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
    expect(result.mcpSkillReadEnabled).toBe(false);
  });

  it('persists an explicit MCP read grant and revokes it when the package is disabled', async () => {
    const current = installation();
    const currentSkill = runtimeSkill(current);
    const { slice, getState } = createSlice([current], [currentSkill]);

    await slice.setAgentPackageMcpSkillReadEnabled(current.id, true);
    expect(getState().agentPackages[0].mcpSkillReadEnabled).toBe(true);
    expect(dbMocks.putAgentInstallation).toHaveBeenLastCalledWith(expect.objectContaining({
      id: current.id,
      mcpSkillReadEnabled: true,
    }));

    await slice.setAgentPackageEnabled(current.id, false);
    expect(getState().agentPackages[0]).toMatchObject({
      enabled: false,
      mcpSkillReadEnabled: false,
    });
    expect(getState().agentPackageSkills).toEqual([]);
  });

  it('revokes an MCP Skill snapshot before the asynchronous catalog rebuild finishes', async () => {
    const current = installation({ mcpSkillReadEnabled: true });
    const staleSkill = runtimeSkill(current, { mcpSkillReadEnabled: true });
    let finishCatalog!: (value: { skills: AgentPackageSkill[]; failures: [] }) => void;
    skillCatalogMocks.loadAgentPackageSkillCatalog.mockReturnValueOnce(new Promise((resolve) => {
      finishCatalog = resolve;
    }));
    const { slice, getState } = createSlice([current], [staleSkill]);

    const revoke = slice.setAgentPackageMcpSkillReadEnabled(current.id, false);
    await vi.waitFor(() => {
      expect(getState().agentPackages[0].mcpSkillReadEnabled).toBe(false);
    });
    expect(getState().agentPackageSkills[0].mcpSkillReadEnabled).toBe(false);

    finishCatalog({ skills: [], failures: [] });
    await revoke;
  });

  it('removes package Skill snapshots immediately when disabling the installation', async () => {
    const current = installation({ mcpSkillReadEnabled: true });
    const staleSkill = runtimeSkill(current, { mcpSkillReadEnabled: true });
    let finishCatalog!: (value: { skills: AgentPackageSkill[]; failures: [] }) => void;
    skillCatalogMocks.loadAgentPackageSkillCatalog.mockReturnValueOnce(new Promise((resolve) => {
      finishCatalog = resolve;
    }));
    const { slice, getState } = createSlice([current], [staleSkill]);

    const disable = slice.setAgentPackageEnabled(current.id, false);
    await vi.waitFor(() => {
      expect(getState().agentPackages[0].enabled).toBe(false);
    });
    expect(getState().agentPackageSkills).toEqual([]);

    finishCatalog({ skills: [], failures: [] });
    await disable;
  });

  it('reuses a legacy installation by sourceId but revokes MCP access after content changes', async () => {
    const current = installation({
      packageId: `legacy.${HASH.slice(0, 16)}`,
      manifest: {
        ...manifest(),
        id: `legacy.${HASH.slice(0, 16)}`,
        version: '0.0.0-legacy',
      },
      mcpSkillReadEnabled: true,
    });
    const { slice, getState } = createSlice([current]);
    const nextHash = 'c'.repeat(64);

    const result = await slice.installAgentPackagePreview(preview({
      manifest: null,
      contentHash: nextHash,
    }));

    expect(result.id).toBe(current.id);
    expect(result.packageId).toBe(`legacy.${nextHash.slice(0, 16)}`);
    expect(result.mcpSkillReadEnabled).toBe(false);
    expect(getState().agentPackages).toHaveLength(1);
  });

  it('creates an enabled host-side manifest for a ready manifestless folder', async () => {
    const { slice } = createSlice();

    const result = await slice.installAgentPackagePreview(preview({
      manifest: null,
      health: 'ready',
    }));

    expect(result).toMatchObject({
      packageId: `legacy.${HASH.slice(0, 16)}`,
      enabled: true,
      health: 'ready',
      manifest: {
        entrypoints: { instructions: 'AGENTS.md' },
        routing: { userInvocable: true, autoInvoke: false },
      },
    });
    expect(dbMocks.putAgentInstallation).toHaveBeenCalledTimes(1);
  });

  it('migrates the obsolete manifest warning without changing the user enable state', async () => {
    const legacyId = `legacy.${HASH.slice(0, 16)}`;
    const unrelatedDegradedId = 'legacy.unrelated-degraded';
    const obsoleteWarning = '未找到 ai-canvas-agent.json，已按兼容目录模式载入';
    const existingWarning = '指令入口预览已截断';
    const legacy = installation({
      packageId: legacyId,
      manifest: {
        ...manifest(),
        id: legacyId,
        version: '0.0.0-legacy',
      },
      warnings: [obsoleteWarning, existingWarning],
      health: 'degraded',
      enabled: false,
    });
    const unrelatedDegraded = installation({
      id: 'agent-package-unrelated-degraded',
      packageId: unrelatedDegradedId,
      manifest: {
        ...manifest(),
        id: unrelatedDegradedId,
        version: '0.0.0-legacy',
      },
      warnings: [existingWarning],
      health: 'degraded',
      enabled: true,
    });
    dbMocks.getAllAgentInstallations.mockResolvedValue([legacy, unrelatedDegraded]);
    const { slice, getState } = createSlice();

    await slice.loadAgentPackages();

    expect(getState().agentPackages.find((item) => item.packageId === legacyId)).toMatchObject({
      warnings: [existingWarning],
      health: 'ready',
      enabled: false,
    });
    expect(getState().agentPackages.find(
      (item) => item.packageId === unrelatedDegradedId,
    )).toMatchObject({
      warnings: [existingWarning],
      health: 'degraded',
      enabled: true,
    });
    expect(dbMocks.putAgentInstallation).toHaveBeenCalledTimes(1);
    expect(dbMocks.putAgentInstallation).toHaveBeenCalledWith(expect.objectContaining({
      packageId: legacyId,
      warnings: [existingWarning],
      health: 'ready',
      enabled: false,
    }));
  });

  it.each(['invalid', 'missing'] as const)(
    'does not migrate a manifestless record whose health is %s',
    async (health) => {
      const legacyId = `legacy.${health}`;
      const obsoleteWarning = '未找到 ai-canvas-agent.json，已按兼容目录模式载入';
      const record = installation({
        packageId: legacyId,
        manifest: {
          ...manifest(),
          id: legacyId,
          version: '0.0.0-legacy',
        },
        warnings: [obsoleteWarning],
        health,
        enabled: false,
      });
      dbMocks.getAllAgentInstallations.mockResolvedValue([record]);
      const { slice, getState } = createSlice();

      await slice.loadAgentPackages();

      expect(getState().agentPackages[0]).toMatchObject({
        packageId: legacyId,
        warnings: [obsoleteWarning],
        health,
        enabled: false,
      });
      expect(dbMocks.putAgentInstallation).not.toHaveBeenCalled();
    },
  );

  it('keeps migrated records visible but reports a failed migration write', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const legacyId = `legacy.${HASH.slice(0, 16)}`;
    const record = installation({
      packageId: legacyId,
      manifest: {
        ...manifest(),
        id: legacyId,
        version: '0.0.0-legacy',
      },
      warnings: ['未找到 ai-canvas-agent.json，已按兼容目录模式载入'],
      health: 'degraded',
      enabled: false,
    });
    dbMocks.getAllAgentInstallations.mockResolvedValue([record]);
    dbMocks.putAgentInstallation.mockRejectedValue(new Error('write failed'));
    const { slice, getState } = createSlice();

    await slice.loadAgentPackages();

    expect(getState().agentPackages[0]).toMatchObject({
      packageId: legacyId,
      warnings: [],
      health: 'ready',
      enabled: false,
    });
    expect(getState()).toMatchObject({
      agentCatalogStatus: 'degraded',
      agentCatalogErrorCode: 'AGENT_CATALOG_MIGRATION_WRITE_FAILED',
    });
    warning.mockRestore();
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
