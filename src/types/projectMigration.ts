/** 项目模型迁移的只读源、诊断与阶段合同；恢复内容与审计事实必须分域。 */
import type { CanvasProject } from './index';
import type { DramaAssetLibrary } from './dramaAssets';
import type { ProjectAggregate } from './project';

/** 完整旧记录，不是项目摘要。未知字段只在源/备份中保留，不自动升级为执行能力。 */
export interface LegacyProjectRecord extends CanvasProject {
  nodes: unknown;
  edges: unknown;
  groups?: unknown;
  dramaAssets?: DramaAssetLibrary;
  [field: string]: unknown;
}
export type ProjectMigrationDiagnosticCode =
  | 'invalid_record' | 'duplicate_record_id' | 'invalid_field' | 'invalid_canvas'
  | 'missing_owner' | 'nested_parent' | 'owner_has_canvas' | 'owner_has_episode_fields' | 'child_has_series' | 'ambiguous_childless_series'
  | 'unsafe_folder' | 'non_standard_episode_no' | 'duplicate_episode_no'
  | 'child_asset_copy' | 'unknown_legacy_fields';
export interface ProjectMigrationDiagnostic {
  code: ProjectMigrationDiagnosticCode;
  severity: 'blocking' | 'warning';
  recordIds: string[];
  /** 仅字段名和固定原因，不包含正文、原始路径或凭据。 */
  field?: string;
  message: string;
}
export interface LegacyProjectProjection {
  projects: ProjectAggregate[];
  diagnostics: ProjectMigrationDiagnostic[];
  quarantinedRecordIds: string[];
  /** 原值副本仅用于兼容/恢复，不能作为新表 DTO 或归档可执行记录。 */
  sourceRecords: LegacyProjectRecord[];
}
export type ProjectModelMigrationStage =
  | 'preflight' | 'backed_up' | 'schema_ready' | 'staging' | 'verifying'
  | 'ready' | 'activated' | 'failed' | 'quarantined';
export type ProjectModelRestoreScope = { kind: 'project'; projectId: string } | { kind: 'all-projects' };
export type ProjectModelRestoreStage =
  | 'prepared' | 'staged' | 'idb_committed' | 'side_stores_reconciled' | 'ready' | 'failed';
export interface ProjectModelMigrationManifestEntry {
  store: string;
  keys: string[];
  sha256: string;
}
export interface ProjectModelMigrationLedger {
  operationId: string;
  sourceSchemaVersion: number;
  targetModelVersion: 2;
  adapterVersion: 1;
  targetGeneration: number;
  stage: ProjectModelMigrationStage;
  sourceDigest: string;
  backupRef: string;
  manifest: ProjectModelMigrationManifestEntry[];
  quarantinedRecordIds: string[];
}
