/** 迁移源身份不含备份操作号/制作时间；同一原值可在重启后重新核对。 */
import type { ProjectModelBackupManifest } from './projectModelBackup';
import { sha256BytesHex } from './mediaDataUrl';

export function fingerprintProjectModelSource(manifest: ProjectModelBackupManifest): Promise<string> {
  const source = {
    format: manifest.format,
    databaseName: manifest.databaseName,
    schemaVersion: manifest.schemaVersion,
    databaseStoreNames: manifest.databaseStoreNames,
    stores: manifest.stores,
    localStorage: manifest.localStorage,
    files: manifest.files,
    totalBytes: manifest.totalBytes,
  };
  return sha256BytesHex(new TextEncoder().encode(JSON.stringify(source)));
}
