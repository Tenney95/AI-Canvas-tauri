/** Global user-installed Agent Package catalog. */
import type { StateCreator } from 'zustand';
import type {
  AgentCatalogStatus,
  AgentPackageInstallation,
  AgentSourcePreview,
} from '../types/agentPackage';
import {
  AgentPackageValidationError,
  createLegacyAgentPackageManifest,
  normalizeAgentPackageInstallation,
  normalizeAgentSourcePreview,
} from '../services/agentPackages/agentPackageManifest';
import {
  deleteAgentInstallation,
  getAllAgentInstallations,
  putAgentInstallation,
} from '../services/agentPackages/agentCatalogDb';
import type { AppState } from './useAppStore';
import { generateId } from './store.utils';

export interface AgentPackageSlice {
  agentPackages: AgentPackageInstallation[];
  agentCatalogStatus: AgentCatalogStatus;
  agentCatalogErrorCode?: string;
  installAgentPackagePreview: (
    preview: AgentSourcePreview,
  ) => Promise<AgentPackageInstallation>;
  setAgentPackageEnabled: (id: string, enabled: boolean) => Promise<void>;
  removeAgentPackageRecord: (id: string) => Promise<void>;
  loadAgentPackages: () => Promise<void>;
}

function sortInstallations(records: AgentPackageInstallation[]): AgentPackageInstallation[] {
  return [...records].sort((left, right) => (
    left.manifest.name.localeCompare(right.manifest.name)
      || left.packageId.localeCompare(right.packageId)
  ));
}

function createInstallationId(): string {
  return `agent-package-${generateId()}`;
}

const OBSOLETE_MANIFESTLESS_WARNING = '未找到 ai-canvas-agent.json，已按兼容目录模式载入';

/**
 * v1 首批切片曾把所有无根清单来源标成 degraded。仅迁移带有精确旧提示的
 * legacy 记录，避免把其他真实受限状态误提升为 ready；用户的启停选择保持不变。
 */
function migrateManifestlessInstallation(
  installation: AgentPackageInstallation,
): AgentPackageInstallation {
  if (
    installation.health !== 'degraded'
    || !installation.packageId.startsWith('legacy.')
    || !installation.warnings.includes(OBSOLETE_MANIFESTLESS_WARNING)
  ) {
    return installation;
  }
  return {
    ...installation,
    warnings: installation.warnings.filter(
      (warning) => warning !== OBSOLETE_MANIFESTLESS_WARNING,
    ),
    health: 'ready',
  };
}

export const createAgentPackageSlice: StateCreator<AppState, [], [], AgentPackageSlice> = (
  set,
  get,
) => ({
  agentPackages: [],
  agentCatalogStatus: 'idle',
  agentCatalogErrorCode: undefined,

  installAgentPackagePreview: async (preview) => {
    const normalized = normalizeAgentSourcePreview(preview);
    if (normalized.health === 'invalid' || normalized.health === 'missing') {
      throw new AgentPackageValidationError('智能体包当前不可安装');
    }
    if (!normalized.instructionText.trim()) {
      throw new AgentPackageValidationError('智能体包入口说明为空');
    }
    const packageManifest = normalized.manifest
      ?? createLegacyAgentPackageManifest(normalized);

    const existing = get().agentPackages.find(
      (item) => item.packageId === packageManifest.id,
    );
    const now = Date.now();
    const installation: AgentPackageInstallation = {
      id: existing?.id ?? createInstallationId(),
      packageId: packageManifest.id,
      manifest: packageManifest,
      source: {
        sourceId: normalized.sourceId,
        sourceType: normalized.sourceType,
        displayName: normalized.name,
      },
      entrypoints: [...normalized.entrypoints],
      skillCount: normalized.skillCount,
      fileCount: normalized.fileCount,
      totalBytes: normalized.totalBytes,
      warnings: [...normalized.warnings],
      health: normalized.health,
      contentHash: normalized.contentHash,
      enabled: existing?.enabled ?? normalized.health === 'ready',
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };

    await putAgentInstallation(installation);
    set((state) => ({
      agentPackages: sortInstallations([
        ...state.agentPackages.filter((item) => item.id !== installation.id),
        installation,
      ]),
      agentCatalogStatus: 'ready',
      agentCatalogErrorCode: undefined,
    }));
    return installation;
  },

  setAgentPackageEnabled: async (id, enabled) => {
    const existing = get().agentPackages.find((item) => item.id === id);
    if (!existing) throw new Error('找不到该智能体安装记录');
    if (enabled && (existing.health === 'invalid' || existing.health === 'missing')) {
      throw new Error('智能体包当前不可启用');
    }
    if (existing.enabled === enabled) return;

    const updated: AgentPackageInstallation = {
      ...existing,
      enabled,
      updatedAt: Date.now(),
    };
    await putAgentInstallation(updated);
    set((state) => ({
      agentPackages: state.agentPackages.map((item) => item.id === id ? updated : item),
    }));
  },

  removeAgentPackageRecord: async (id) => {
    const existing = get().agentPackages.find((item) => item.id === id);
    if (!existing) return;
    await deleteAgentInstallation(id);
    set((state) => ({
      agentPackages: state.agentPackages.filter((item) => item.id !== id),
    }));
  },

  loadAgentPackages: async () => {
    set({ agentCatalogStatus: 'loading', agentCatalogErrorCode: undefined });
    try {
      const records = await getAllAgentInstallations();
      const valid: AgentPackageInstallation[] = [];
      let rejectedRecord = false;
      let migrationWriteFailed = false;
      for (const record of records) {
        try {
          const normalized = normalizeAgentPackageInstallation(record);
          const migrated = migrateManifestlessInstallation(normalized);
          valid.push(migrated);
          if (migrated !== normalized) {
            try {
              await putAgentInstallation(migrated);
            } catch (error) {
              // 内存态仍使用修正后的语义；下次启动可再次尝试持久化。
              migrationWriteFailed = true;
              console.warn('[Agent Catalog] 无清单目录兼容状态迁移保存失败', error);
            }
          }
        } catch (error) {
          rejectedRecord = true;
          console.warn('[Agent Catalog] 已忽略损坏的安装记录', error);
        }
      }
      set({
        agentPackages: sortInstallations(valid),
        agentCatalogStatus: rejectedRecord || migrationWriteFailed ? 'degraded' : 'ready',
        agentCatalogErrorCode: rejectedRecord
          ? 'AGENT_CATALOG_RECORD_INVALID'
          : migrationWriteFailed
            ? 'AGENT_CATALOG_MIGRATION_WRITE_FAILED'
            : undefined,
      });
    } catch (error) {
      console.warn('[Agent Catalog] 读取失败，已退化为空目录', error);
      set({
        agentPackages: [],
        agentCatalogStatus: 'degraded',
        agentCatalogErrorCode: 'AGENT_CATALOG_LOAD_FAILED',
      });
    }
  },
});
