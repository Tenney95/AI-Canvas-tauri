/** Global user-installed Agent Package catalog. */
import type { StateCreator } from 'zustand';
import type {
  AgentCatalogStatus,
  AgentPackageInstallation,
  AgentPackageSkill,
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
import { loadAgentPackageSkillCatalog } from '../services/agentPackages/agentPackageSkillService';
import type { AppState } from './useAppStore';
import { generateId } from './store.utils';

export interface AgentPackageSlice {
  agentPackages: AgentPackageInstallation[];
  agentCatalogStatus: AgentCatalogStatus;
  agentCatalogErrorCode?: string;
  /** 主窗口运行时只读目录；正文不会写入 Agent Catalog DB。 */
  agentPackageSkills: AgentPackageSkill[];
  agentPackageSkillCatalogStatus: AgentCatalogStatus;
  agentPackageSkillCatalogErrorCode?: string;
  agentPackageSkillCatalogRevision: string;
  installAgentPackagePreview: (
    preview: AgentSourcePreview,
  ) => Promise<AgentPackageInstallation>;
  setAgentPackageEnabled: (id: string, enabled: boolean) => Promise<void>;
  setAgentPackageMcpSkillReadEnabled: (id: string, enabled: boolean) => Promise<void>;
  removeAgentPackageRecord: (id: string) => Promise<void>;
  loadAgentPackages: () => Promise<void>;
  refreshAgentPackageSkills: (force?: boolean) => Promise<void>;
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

function skillCatalogRevision(records: AgentPackageInstallation[]): string {
  return records.map((record) => [
    record.id,
    record.source.sourceId,
    record.contentHash,
    record.enabled ? '1' : '0',
    record.mcpSkillReadEnabled ? '1' : '0',
    record.health,
    record.entrypoints.join(','),
  ].join(':')).sort().join('|');
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
  agentPackageSkills: [],
  agentPackageSkillCatalogStatus: 'idle',
  agentPackageSkillCatalogErrorCode: undefined,
  agentPackageSkillCatalogRevision: '',

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
      (item) => item.source.sourceId === normalized.sourceId,
    ) ?? get().agentPackages.find((item) => item.packageId === packageManifest.id);
    const now = Date.now();
    const sameAuthorizedContent = existing?.source.sourceId === normalized.sourceId
      && existing.contentHash === normalized.contentHash;
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
      mcpSkillReadEnabled: sameAuthorizedContent
        ? existing?.mcpSkillReadEnabled ?? false
        : false,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };

    await putAgentInstallation(installation);
    set((state) => ({
      agentPackages: sortInstallations([
        ...state.agentPackages.filter((item) => item.id !== installation.id),
        installation,
      ]),
      // 新版本/新来源生效时先撤下旧正文，避免异步刷新窗口继续解析旧 Skill。
      agentPackageSkills: state.agentPackageSkills.filter(
        (skill) => skill.installationId !== installation.id,
      ),
      agentCatalogStatus: 'ready',
      agentCatalogErrorCode: undefined,
    }));
    await get().refreshAgentPackageSkills(true);
    return installation;
  },

  setAgentPackageEnabled: async (id, enabled) => {
    const existing = get().agentPackages.find((item) => item.id === id);
    if (!existing) throw new Error('找不到该智能体安装记录');
    if (enabled && (existing.health === 'invalid' || existing.health === 'missing')) {
      throw new Error('智能体包当前不可启用');
    }
    if (existing.enabled === enabled && (enabled || !existing.mcpSkillReadEnabled)) return;

    const updated: AgentPackageInstallation = {
      ...existing,
      enabled,
      mcpSkillReadEnabled: enabled ? existing.mcpSkillReadEnabled : false,
      updatedAt: Date.now(),
    };
    await putAgentInstallation(updated);
    set((state) => ({
      agentPackages: state.agentPackages.map((item) => item.id === id ? updated : item),
      agentPackageSkills: enabled
        ? state.agentPackageSkills
        : state.agentPackageSkills.filter((skill) => skill.installationId !== id),
    }));
    await get().refreshAgentPackageSkills(true);
  },

  setAgentPackageMcpSkillReadEnabled: async (id, enabled) => {
    const existing = get().agentPackages.find((item) => item.id === id);
    if (!existing) throw new Error('找不到该智能体安装记录');
    if (enabled && !existing.enabled) throw new Error('请先启用该智能体');
    if (enabled && (existing.health === 'invalid' || existing.health === 'missing')) {
      throw new Error('智能体包当前不可授权 MCP 读取');
    }
    if (existing.mcpSkillReadEnabled === enabled) return;

    const updated: AgentPackageInstallation = {
      ...existing,
      mcpSkillReadEnabled: enabled,
      updatedAt: Date.now(),
    };
    await putAgentInstallation(updated);
    set((state) => ({
      agentPackages: state.agentPackages.map((item) => item.id === id ? updated : item),
      // 授权状态与安装记录原子更新；目录刷新只负责重建正文，不承担撤权时效。
      agentPackageSkills: state.agentPackageSkills.map((skill) => (
        skill.installationId === id ? { ...skill, mcpSkillReadEnabled: enabled } : skill
      )),
    }));
    await get().refreshAgentPackageSkills(true);
  },

  removeAgentPackageRecord: async (id) => {
    const existing = get().agentPackages.find((item) => item.id === id);
    if (!existing) return;
    await deleteAgentInstallation(id);
    set((state) => ({
      agentPackages: state.agentPackages.filter((item) => item.id !== id),
      agentPackageSkills: state.agentPackageSkills.filter(
        (skill) => skill.installationId !== id,
      ),
    }));
    await get().refreshAgentPackageSkills(true);
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
        // 持久化目录是权威源；先清空旧运行时快照，再按本次记录重建。
        agentPackageSkills: [],
        agentCatalogStatus: rejectedRecord || migrationWriteFailed ? 'degraded' : 'ready',
        agentCatalogErrorCode: rejectedRecord
          ? 'AGENT_CATALOG_RECORD_INVALID'
          : migrationWriteFailed
            ? 'AGENT_CATALOG_MIGRATION_WRITE_FAILED'
            : undefined,
      });
      await get().refreshAgentPackageSkills(true);
    } catch (error) {
      console.warn('[Agent Catalog] 读取失败，已退化为空目录', error);
      set({
        agentPackages: [],
        agentCatalogStatus: 'degraded',
        agentCatalogErrorCode: 'AGENT_CATALOG_LOAD_FAILED',
        agentPackageSkills: [],
        agentPackageSkillCatalogStatus: 'degraded',
        agentPackageSkillCatalogErrorCode: 'AGENT_PACKAGE_SKILL_CATALOG_SOURCE_UNAVAILABLE',
        agentPackageSkillCatalogRevision: '',
      });
    }
  },

  refreshAgentPackageSkills: async (force = false) => {
    const records = get().agentPackages;
    const revision = skillCatalogRevision(records);
    if (
      !force
      && get().agentPackageSkillCatalogRevision === revision
      && get().agentPackageSkillCatalogStatus !== 'idle'
      && get().agentPackageSkillCatalogStatus !== 'loading'
    ) return;

    set({
      agentPackageSkillCatalogStatus: 'loading',
      agentPackageSkillCatalogErrorCode: undefined,
    });
    try {
      const result = await loadAgentPackageSkillCatalog(records);
      if (skillCatalogRevision(get().agentPackages) !== revision) {
        await get().refreshAgentPackageSkills(true);
        return;
      }
      set({
        agentPackageSkills: result.skills,
        agentPackageSkillCatalogStatus: result.failures.length > 0 ? 'degraded' : 'ready',
        agentPackageSkillCatalogErrorCode: result.failures.length > 0
          ? 'AGENT_PACKAGE_SKILL_CATALOG_PARTIAL'
          : undefined,
        agentPackageSkillCatalogRevision: revision,
      });
      if (result.failures.length > 0) {
        console.warn('[Agent Catalog] 部分 Skill 无法加载', result.failures);
      }
    } catch (error) {
      console.warn('[Agent Catalog] Skill 运行时目录加载失败', error);
      set({
        agentPackageSkills: [],
        agentPackageSkillCatalogStatus: 'degraded',
        agentPackageSkillCatalogErrorCode: 'AGENT_PACKAGE_SKILL_CATALOG_LOAD_FAILED',
        agentPackageSkillCatalogRevision: revision,
      });
    }
  },
});
