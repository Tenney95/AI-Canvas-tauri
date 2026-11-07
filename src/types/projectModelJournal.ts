/** P2 隔离样本迁移合同；不改变正式数据库版本或启动模型。 */
import type { ProjectMigrationDiagnostic } from './projectMigration';

export const PROJECT_MODEL_FIXTURE_DATABASE_PREFIX = 'ai-canvas-model-fixture-' as const;
export function isProjectModelFixtureDatabaseName(name: unknown): name is string {
  return typeof name === 'string' && /^ai-canvas-model-fixture-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name);
}
export const PROJECT_MODEL_STAGING_VERSION = 28 as const;
export const PROJECT_MODEL_SOURCE_FREEZE_KEY = 'project-model-source-freeze' as const;
export const PROJECT_MODEL_ACTIVE_MARKER_KEY = 'activeDataModel' as const;
export const PROJECT_MODEL_STAGING_STORES = [
  'projectRoots', 'projectContents', 'episodes', 'episodeContents', 'canvasDocuments',
  'canvasPreviews', 'legacyProjectBindings', 'archiveHistoryBindings', 'projectModelMigrations',
] as const;
export const PROJECT_MODEL_GENERATION_STORES = [
  'projectRoots', 'projectContents', 'episodes', 'episodeContents', 'canvasDocuments',
  'canvasPreviews', 'legacyProjectBindings',
] as const;
export type ProjectModelGenerationStore = typeof PROJECT_MODEL_GENERATION_STORES[number];
export type ProjectModelStagingStage = 'schema_ready' | 'staging' | 'verifying' | 'ready'
  | 'failed' | 'quarantined' | 'rolled_back';
export interface ProjectModelStagingRow {
  store: ProjectModelGenerationStore;
  key: IDBValidKey;
  value: Record<string, unknown>;
  /** 用于事务内精确条件比较；不是跨设备规范快照或可执行内容。 */
  token: string;
  sha256: string;
}
export interface ProjectModelStagingJournal {
  operationId: string;
  generation: number;
  sourceSchemaVersion: number;
  targetModelVersion: 2;
  adapterVersion: 1;
  sourceDigest: string;
  backupOperationId: string;
  backupManifestDigest: string;
  stage: ProjectModelStagingStage;
  sequence: number;
  nextRow: number;
  createdAt: number;
  updatedAt: number;
  projectIds: string[];
  /** 全部已分类旧关联表的精确比较材料，仅落本机journal，不进入日志/归档/运行授权。 */
  sourceStores: Array<{ name: string; schemaToken: string; records: Array<{ key: IDBValidKey; token: string }> }>;
  rows: ProjectModelStagingRow[];
  manifestDigest: string;
  diagnostics: ProjectMigrationDiagnostic[];
  quarantinedRecordIds: string[];
  failureCode?: 'source-changed' | 'staging-conflict' | 'verification-failed' | 'transaction-failed';
  activationAllowed: false;
}
export interface ProjectModelSourceFreeze {
  id: typeof PROJECT_MODEL_SOURCE_FREEZE_KEY;
  operationId: string;
  generation: number;
  sourceDigest: string;
  state: 'frozen';
}
