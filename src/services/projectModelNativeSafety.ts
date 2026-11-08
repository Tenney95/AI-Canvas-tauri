/** 冷维护原生桥；普通主窗口和正式数据 profile 永远不能获得 fixture 写入租约。 */
import { invoke } from '@tauri-apps/api/core';
import type { ProjectModelBackupPort } from './projectModelBackup';

/** JSON IPC 暂不传送超大二进制；超限保留来源并拒绝，不分片后伪称完整。 */
export const PROJECT_MODEL_NATIVE_ENTRY_LIMIT = 8 * 1024 * 1024;

export interface ProjectModelMaintenanceLease {
  leaseId: string;
  profileId: string;
  mode: 'isolated-fixture';
  coldStart: true;
  productionAllowed: false;
  /** true：本次固定合成容器往返完成；false：未能完成或达到保留上限，不能据此阻止迁移恢复。 */
  fixtureArchiveContainer?: boolean;
}
export interface ProjectModelDurableBackupSeal {
  format: 'project-model-durable-seal-v1';
  operationId: string;
  profileId: string;
  manifestSha256: string;
  completeSha256: string;
  durability: 'fsync-and-directory-barrier';
  canActivate: false;
}
export interface ProjectModelProductionStopEvidence {
  mode: 'production-proof-only';
  exclusiveEnvironment: true;
  coldStart: true;
  productionAllowed: false;
}

export function getProjectModelMaintenanceLease(): Promise<ProjectModelMaintenanceLease> {
  return invoke('project_model_get_maintenance_lease');
}
export function verifyProjectModelMaintenanceLease(leaseId: string): Promise<ProjectModelMaintenanceLease> {
  return invoke('project_model_verify_maintenance_lease', { leaseId });
}
/** 仅 debug 冷维护证明路径可读取，不授予正式数据库或迁移写入能力。 */
export function getProjectModelProductionStopEvidence(): Promise<ProjectModelProductionStopEvidence> {
  return invoke('project_model_get_production_stop_evidence');
}

async function nativePort(leaseId: string, operationId: string, create: boolean): Promise<ProjectModelBackupPort> {
  await invoke('project_model_open_backup', { leaseId, operationId, create });
  return {
    writeExclusive: async (path, bytes) => {
      if (!create || !(bytes instanceof Uint8Array) || bytes.byteLength > PROJECT_MODEL_NATIVE_ENTRY_LIMIT) {
        throw new Error('备份端口只读或条目超过原生传输预算');
      }
      await invoke('project_model_write_backup_entry', { leaseId, operationId, path, bytes: Array.from(bytes), complete: false });
    },
    read: async (path, maxBytes) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PROJECT_MODEL_NATIVE_ENTRY_LIMIT) {
        throw new Error('备份条目超过原生读取预算');
      }
      return new Uint8Array(await invoke<number[]>('project_model_read_backup_entry', { leaseId, operationId, path, maxBytes }));
    },
    publishComplete: async (path, bytes) => {
      if (!create || path !== 'complete.json' || bytes.byteLength > 4096) throw new Error('备份完成标记路径或端口无效');
      await invoke('project_model_write_backup_entry', {
        leaseId, operationId, path, bytes: Array.from(bytes), complete: true,
      });
    },
  };
}
export function createNativeProjectModelBackupPort(leaseId: string, operationId: string): Promise<ProjectModelBackupPort> {
  return nativePort(leaseId, operationId, true);
}
export function openNativeProjectModelBackupPort(leaseId: string, operationId: string): Promise<ProjectModelBackupPort> {
  return nativePort(leaseId, operationId, false);
}
/** 原生重新核对 manifest/complete/全部材料后发布独占耐久封印；不能由 renderer 自报成功。 */
export function sealNativeProjectModelBackup(leaseId: string, operationId: string): Promise<ProjectModelDurableBackupSeal> {
  return invoke('project_model_seal_backup', { leaseId, operationId });
}
export function verifyNativeProjectModelBackupSeal(leaseId: string, operationId: string): Promise<ProjectModelDurableBackupSeal> {
  return invoke('project_model_verify_backup_seal', { leaseId, operationId });
}
