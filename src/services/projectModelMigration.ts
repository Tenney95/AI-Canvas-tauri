/**
 * P1 的显式只读准备入口：备份可读回不等于旧实例已停写。
 * 此文件不升级 schema、不改项目、不应用恢复，也不提供 activeDataModel 的写入口。
 */
import type { LegacyProjectProjection, ProjectModelRestoreScope } from '../types/projectMigration';
import {
  createProjectModelBackupPort, openProjectModelBackupPort,
} from './fileService';
import {
  createProjectModelBackup, readVerifiedProjectModelBackup, writeVerifiedProjectModelBackup,
  type ProjectModelBackupManifest, type ProjectModelBackupSource, type VerifiedProjectModelBackup,
} from './projectModelBackup';
import {
  openExistingProjectDatabase, readLegacyMigrationSnapshot,
  type LegacyMigrationReadDiagnostic, type LegacyMigrationSnapshotOptions,
} from './indexedDb/projectModelMigrationRepository';
import { projectLegacyRecords } from './projectModelCompatibility';
import type { LegacyProjectRecord } from '../types/projectMigration';

export const PROJECT_MODEL_PREPARATION_CAPABILITIES = Object.freeze({
  dataModel: 'legacy',
  automaticMigration: false,
  activation: false,
  restoreWrites: false,
  nativeArchiveV4: false,
  durableMigrationBackup: false,
} as const);

export interface ProjectModelPreparationReport {
  status: 'backed-up';
  operationId: string;
  manifest: ProjectModelBackupManifest;
  projectIds: string[];
  diagnostics: LegacyProjectProjection['diagnostics'];
  quarantinedRecordIds: string[];
  /** P2 必须建立真实 profile 停写证据；只读快照/一次 LS 相等不是该证据。 */
  quiescence: 'not-established';
  durability: 'read-back-only';
  canActivate: false;
}

export class ProjectModelPreparationError extends Error {
  readonly name: string;
  readonly code: 'source-unavailable' | 'incomplete-source' | 'operation-mismatch' | 'invalid-scope' | 'backup-failed' | 'backup-cancelled';
  readonly diagnostics: LegacyMigrationReadDiagnostic[];
  readonly operationId?: string;

  constructor(code: ProjectModelPreparationError['code'], diagnostics: LegacyMigrationReadDiagnostic[] = [], operationId?: string) {
    super('项目模型只读准备未完成：' + code);
    this.name = code === 'backup-cancelled' ? 'AbortError' : 'ProjectModelPreparationError';
    this.code = code;
    this.diagnostics = diagnostics;
    this.operationId = operationId;
  }
}

function sourceRecords(source: ProjectModelBackupSource): LegacyProjectRecord[] {
  const projects = source.stores.find((store) => store.name === 'projects');
  if (!projects) throw new ProjectModelPreparationError('incomplete-source');
  // 完整原值由兼容投影做诊断，不用 summary 补造缺失画布。
  return projects.records.map((row) => row.value as LegacyProjectRecord);
}

/** 候选材料可能含隔离项目；允许备份原始值，不因此宣称这些项目可以迁移。 */
export async function prepareProjectModelBackup(
  options: LegacyMigrationSnapshotOptions & { operationId?: string } = {},
): Promise<ProjectModelPreparationReport> {
  options.signal?.throwIfAborted();
  const database = await openExistingProjectDatabase({ signal: options.signal });
  if (!database) throw new ProjectModelPreparationError('source-unavailable');
  let preparedOperationId: string | undefined;
  try {
    const snapshot = await readLegacyMigrationSnapshot(database, options);
    if (!snapshot.complete) throw new ProjectModelPreparationError('incomplete-source', snapshot.diagnostics);
    const projection = projectLegacyRecords(sourceRecords(snapshot.source));
    const operationId = options.operationId ?? crypto.randomUUID();
    const bundle = await createProjectModelBackup(snapshot.source, { operationId, signal: options.signal });
    preparedOperationId = bundle.manifest.operationId;
    options.signal?.throwIfAborted();
    const port = await createProjectModelBackupPort(operationId);
    const verified = await writeVerifiedProjectModelBackup(bundle, port, { signal: options.signal });
    options.signal?.throwIfAborted();
    if (verified.manifest.operationId !== operationId) throw new ProjectModelPreparationError('operation-mismatch');
    return {
      status: 'backed-up', operationId, manifest: verified.manifest,
      projectIds: projection.projects.map((item) => item.project.id),
      diagnostics: projection.diagnostics, quarantinedRecordIds: projection.quarantinedRecordIds,
      quiescence: 'not-established', durability: 'read-back-only', canActivate: false,
    };
  } catch (error) {
    if (preparedOperationId && !(error instanceof ProjectModelPreparationError)) {
      // 只保留已通过格式校验的操作编号供恢复定位，不透传原生路径或原始异常。
      throw new ProjectModelPreparationError(error instanceof Error && error.name === 'AbortError'
        ? 'backup-cancelled' : 'backup-failed', [], preparedOperationId);
    }
    throw error;
  } finally { database.close(); }
}

/** 只有该操作自己的完成标记和全部材料均验证通过，才能作为恢复准备来源。 */
export async function inspectProjectModelBackup(operationId: string, options: { signal?: AbortSignal } = {}): Promise<VerifiedProjectModelBackup> {
  options.signal?.throwIfAborted();
  const verified = await readVerifiedProjectModelBackup(await openProjectModelBackupPort(operationId), options);
  options.signal?.throwIfAborted();
  if (verified.manifest.operationId !== operationId) throw new ProjectModelPreparationError('operation-mismatch');
  return verified;
}

export interface ProjectModelRestorePreparation {
  status: 'prepared-readonly';
  backupOperationId: string;
  scope: ProjectModelRestoreScope;
  sourceProjectIds: string[];
  currentProjectIds: string[];
  diagnostics: LegacyProjectProjection['diagnostics'];
  quarantinedRecordIds: string[];
  /** 这些项目不会因局部恢复切换到只有一个项目的新全局 generation 而消失。 */
  unaffectedProjectIds: string[];
  retainedAudit: Array<{ store: string; currentRecordCount: number; policy: 'preserve-current-and-reconcile' }>;
  pendingTaskPolicy: 'preserve-current-and-reconcile';
  requiresPreRestoreBackup: true;
  requiresVerifiedMedia: true;
  requiresQuiescence: true;
  canApply: false;
}

/**
 * 只形成恢复范围和必须保留的侧表清单，不返回可直接 put 的旧记录。
 * 真正恢复的代际/媒体/审计协调在 P2/P5 完成前始终禁止应用。
 */
export async function prepareProjectModelRestore(input: {
  operationId: string;
  scope: ProjectModelRestoreScope;
  signal?: AbortSignal;
  localStorage?: Pick<Storage, 'getItem'> | null;
}): Promise<ProjectModelRestorePreparation> {
  input.signal?.throwIfAborted();
  const verified = await inspectProjectModelBackup(input.operationId, { signal: input.signal });
  input.signal?.throwIfAborted();
  const source = projectLegacyRecords(sourceRecords(verified.source));
  const requestedProjectId = input.scope?.kind === 'project' ? input.scope.projectId : null;
  if (!input.scope || !['project', 'all-projects'].includes(input.scope.kind)
    || input.scope.kind === 'project' && !source.projects.some((item) => item.project.id === requestedProjectId)) {
    throw new ProjectModelPreparationError('invalid-scope');
  }
  const database = await openExistingProjectDatabase({ signal: input.signal });
  if (!database) throw new ProjectModelPreparationError('source-unavailable');
  try {
    const current = await readLegacyMigrationSnapshot(database, { signal: input.signal, localStorage: input.localStorage });
    if (!current.complete) throw new ProjectModelPreparationError('incomplete-source', current.diagnostics);
    const currentProjection = projectLegacyRecords(sourceRecords(current.source));
    const targetId = input.scope.kind === 'project' ? input.scope.projectId : null;
    const currentProjectIds = currentProjection.projects.map((item) => item.project.id);
    const contentStores = new Set(['projects', 'projectSummaries']);
    return {
      status: 'prepared-readonly', backupOperationId: input.operationId,
      scope: targetId === null ? { kind: 'all-projects' } : { kind: 'project', projectId: targetId },
      sourceProjectIds: source.projects.filter((item) => targetId === null || item.project.id === targetId).map((item) => item.project.id),
      currentProjectIds,
      diagnostics: [...source.diagnostics, ...currentProjection.diagnostics],
      quarantinedRecordIds: [...new Set([...source.quarantinedRecordIds, ...currentProjection.quarantinedRecordIds])],
      unaffectedProjectIds: targetId === null ? [] : currentProjectIds.filter((id) => id !== targetId),
      retainedAudit: current.source.stores.filter((store) => !contentStores.has(store.name)).map((store) => ({
        store: store.name, currentRecordCount: store.records.length, policy: 'preserve-current-and-reconcile',
      })),
      pendingTaskPolicy: 'preserve-current-and-reconcile',
      requiresPreRestoreBackup: true, requiresVerifiedMedia: true, requiresQuiescence: true, canApply: false,
    };
  } finally { database.close(); }
}
