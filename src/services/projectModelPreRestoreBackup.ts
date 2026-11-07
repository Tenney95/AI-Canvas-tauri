/** P5 专用恢复前安全备份；只处理已冷停写的fixture，绝不回写审计/LS或切换全局模型。 */
import type { ProjectModelFixtureBusinessSession } from '../types/projectModelBusiness';
import type { ProjectModelTransferCapture, ProjectModelTransferImportJournal, ProjectModelVerifiedRestoreProof } from '../types/projectModelTransfer';
import { isProjectModelFixtureDatabaseName, PROJECT_MODEL_STAGING_VERSION } from '../types/projectModelJournal';
import { createProjectModelTransferRepository } from './indexedDb/projectModelTransferRepository';
import { projectModelSourceToken } from './indexedDb/projectModelStagingRepository';
import { createProjectModelBackup, readVerifiedProjectModelBackup, writeVerifiedProjectModelBackup,
  PROJECT_MODEL_BACKUP_LIMITS, PROJECT_MODEL_FIXTURE_BACKUP_FORMAT, type ProjectModelBackupPort } from './projectModelBackup';
import { createNativeProjectModelBackupPort, openNativeProjectModelBackupPort,
  getProjectModelMaintenanceLease, verifyProjectModelMaintenanceLease, sealNativeProjectModelBackup,
  verifyNativeProjectModelBackupSeal, PROJECT_MODEL_NATIVE_ENTRY_LIMIT,
  type ProjectModelMaintenanceLease, type ProjectModelDurableBackupSeal } from './projectModelNativeSafety';
import { fingerprintProjectModelSource } from './projectModelSourceFingerprint';
import { sha256BytesHex } from './mediaDataUrl';

export interface ProjectModelPreRestoreNativePort {
  getLease: () => Promise<ProjectModelMaintenanceLease>;
  verifyLease: (leaseId: string) => Promise<ProjectModelMaintenanceLease>;
  createBackup: (leaseId: string, operationId: string) => Promise<ProjectModelBackupPort>;
  openBackup: (leaseId: string, operationId: string) => Promise<ProjectModelBackupPort>;
  seal: (leaseId: string, operationId: string) => Promise<ProjectModelDurableBackupSeal>;
  verifySeal: (leaseId: string, operationId: string) => Promise<ProjectModelDurableBackupSeal>;
}
const nativePort: ProjectModelPreRestoreNativePort = {
  getLease: getProjectModelMaintenanceLease, verifyLease: verifyProjectModelMaintenanceLease,
  createBackup: createNativeProjectModelBackupPort, openBackup: openNativeProjectModelBackupPort,
  seal: sealNativeProjectModelBackup, verifySeal: verifyNativeProjectModelBackupSeal,
};
const fail = (code: string): never => { throw new Error('项目恢复前安全备份未完成：' + code); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const operation = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
function assertLease(database: IDBDatabase, lease: ProjectModelMaintenanceLease, expectedId?: string): void {
  if (!lease || lease.mode !== 'isolated-fixture' || lease.productionAllowed !== false || lease.coldStart !== true
    || database.name !== 'ai-canvas-model-fixture-' + lease.profileId || expectedId !== undefined && lease.leaseId !== expectedId) fail('cold-maintenance-required');
}
function tokenFor(capture: ProjectModelTransferCapture, expected: ProjectModelTransferCapture): string {
  const { sourceToken: _token, sessionRevision: _revision, ...material } = capture;
  return projectModelSourceToken({ ...material, includesHistory: expected.includesHistory,
    history: expected.includesHistory ? capture.history : [] });
}

/** 原生端口只在内存注入；测试替身不代表正式维护授权，数据库名/版本仍双重拒绝。 */
export function createProjectModelPreRestoreBackupService(database: IDBDatabase, session: ProjectModelFixtureBusinessSession,
  options: { localStorage?: Pick<Storage, 'getItem'>; native?: ProjectModelPreRestoreNativePort } = {}) {
  if (!isProjectModelFixtureDatabaseName(database.name) || database.version !== PROJECT_MODEL_STAGING_VERSION) fail('fixture-only');
  projectModelSourceToken(session); session = structuredClone(session);
  const repository = createProjectModelTransferRepository(database, session), native = { ...(options.native ?? nativePort) };
  const storage = options.localStorage ?? globalThis.localStorage;
  const pending = () => { try { return storage.getItem('ai_canvas_pending_tasks'); } catch { return fail('pending-source-unavailable'); } };
  async function source(expected: ProjectModelTransferCapture, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const before = pending();
    const current = await repository.captureBackupSource(expected.aggregate.project.id, before, { signal });
    if (pending() !== before || tokenFor(current.capture, expected) !== expected.sourceToken) fail('source-changed');
    return current.source;
  }
  async function checkedBackup(lease: ProjectModelMaintenanceLease, proof: ProjectModelVerifiedRestoreProof, signal?: AbortSignal) {
    const port = await native.openBackup(lease.leaseId, proof.backupOperationId);
    const checked = await readVerifiedProjectModelBackup(port, { signal });
    const manifestBytes = await port.read('manifest.json', PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes);
    const completeBytes = await port.read('complete.json', PROJECT_MODEL_BACKUP_LIMITS.maxCompleteBytes);
    const manifestDigest = await sha256BytesHex(manifestBytes), seal = await native.verifySeal(lease.leaseId, proof.backupOperationId);
    if (checked.manifest.format !== PROJECT_MODEL_FIXTURE_BACKUP_FORMAT || checked.manifest.databaseName !== database.name
      || checked.manifest.schemaVersion !== PROJECT_MODEL_STAGING_VERSION || checked.manifest.operationId !== proof.backupOperationId
      || manifestDigest !== proof.manifestDigest || !seal || seal.format !== 'project-model-durable-seal-v1'
      || seal.operationId !== proof.backupOperationId || seal.profileId !== lease.profileId || seal.manifestSha256 !== manifestDigest
      || seal.completeSha256 !== await sha256BytesHex(completeBytes)
      || seal.durability !== 'fsync-and-directory-barrier' || seal.canActivate !== false
      || await fingerprintProjectModelSource(checked.manifest) !== proof.backupSourceDigest) fail('backup-seal-mismatch');
    return checked;
  }
  async function verify(proof: ProjectModelVerifiedRestoreProof, expected: ProjectModelTransferCapture, signal?: AbortSignal): Promise<void> {
    projectModelSourceToken(proof); projectModelSourceToken(expected);
    proof = structuredClone(proof); expected = structuredClone(expected);
    if (!proof || proof.kind !== 'project-model-pre-restore' || proof.verified !== true || proof.auditPolicy !== 'preserve-current'
      || !operation(proof.backupOperationId) || !hash(proof.manifestDigest) || !hash(proof.backupSourceDigest)
      || proof.sourceMediaDigest !== undefined && !hash(proof.sourceMediaDigest)
      || proof.sourceToken !== expected.sourceToken) fail('invalid-proof');
    const lease = await native.getLease(); assertLease(database, lease);
    const checked = await checkedBackup(lease, proof, signal);
    const current = await source(expected, signal);
    const bundle = await createProjectModelBackup(current, { operationId: proof.backupOperationId, createdAt: checked.manifest.createdAt, signal });
    if (await fingerprintProjectModelSource(bundle.manifest) !== proof.backupSourceDigest || pending() !== current.localStorage[0].value) fail('source-changed');
    assertLease(database, await native.verifyLease(lease.leaseId), lease.leaseId);
  }
  async function create(expected: ProjectModelTransferCapture, input: { operationId: string; signal?: AbortSignal }): Promise<ProjectModelVerifiedRestoreProof> {
    projectModelSourceToken(expected); expected = structuredClone(expected); input = { ...input };
    if (!operation(input.operationId)) fail('invalid-operation');
    const lease = await native.getLease(); assertLease(database, lease);
    const captured = await source(expected, input.signal);
    const bundle = await createProjectModelBackup(captured, { operationId: input.operationId, signal: input.signal });
    if (bundle.manifest.files.some((file) => file.bytes > PROJECT_MODEL_NATIVE_ENTRY_LIMIT)) fail('native-entry-capacity');
    assertLease(database, await native.verifyLease(lease.leaseId), lease.leaseId);
    if (pending() !== captured.localStorage[0].value) fail('source-changed');
    const port = await native.createBackup(lease.leaseId, input.operationId);
    await writeVerifiedProjectModelBackup(bundle, port, { signal: input.signal });
    input.signal?.throwIfAborted();
    await native.seal(lease.leaseId, input.operationId);
    const manifestBytes = await port.read('manifest.json', PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes);
    const proof: ProjectModelVerifiedRestoreProof = { kind: 'project-model-pre-restore', backupOperationId: input.operationId,
      manifestDigest: await sha256BytesHex(manifestBytes), backupSourceDigest: await fingerprintProjectModelSource(bundle.manifest),
      sourceToken: expected.sourceToken, verified: true, auditPolicy: 'preserve-current' };
    await verify(proof, expected, input.signal);
    return proof;
  }
  async function verifyCommit(proof: ProjectModelVerifiedRestoreProof, expected: ProjectModelTransferCapture,
    journal: ProjectModelTransferImportJournal, signal?: AbortSignal): Promise<void> {
    projectModelSourceToken({ proof, expected, journal });
    proof = structuredClone(proof); expected = structuredClone(expected); journal = structuredClone(journal);
    if (!proof || proof.kind !== 'project-model-pre-restore' || proof.verified !== true || proof.auditPolicy !== 'preserve-current'
      || !operation(proof.backupOperationId) || !hash(proof.manifestDigest) || !hash(proof.backupSourceDigest)
      || proof.sourceMediaDigest !== undefined && !hash(proof.sourceMediaDigest)
      || proof.sourceToken !== expected.sourceToken || journal.mode !== 'restore-content' || journal.phase !== 'media_ready'
      || journal.generation !== session.generation || journal.sessionId !== session.sessionId
      || journal.targetProjectId !== expected.aggregate.project.id || journal.expected?.sourceToken !== expected.sourceToken
      || projectModelSourceToken(journal.restoreProof) !== projectModelSourceToken(proof)) fail('invalid-commit-proof');
    signal?.throwIfAborted();
    const lease = await native.getLease(); assertLease(database, lease);
    await checkedBackup(lease, proof, signal);
    // 等待媒体时任务预算和真实回执可前进；提交仅恢复业务稿，保留此刻审计与LS。
    assertLease(database, await native.verifyLease(lease.leaseId), lease.leaseId);
  }
  return { create, verify, verifyCommit };
}
