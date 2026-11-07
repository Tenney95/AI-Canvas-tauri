/** P5 原生演练文件始终位于独立 fixture 资产根，不能复用真实项目 dataFolder 的物理目录。 */
import { appDataDir } from '@tauri-apps/api/path';
import { exists, lstat, mkdir } from '@tauri-apps/plugin-fs';
import { joinPath } from './core';
import { safeExchangePath } from '../projectExchangeDomain';
import { getProjectModelMaintenanceLease, verifyProjectModelMaintenanceLease } from '../projectModelNativeSafety';

export async function projectArchiveFixtureDirectory(databaseName: string, relative: string, create = false): Promise<string> {
  if (!/^ai-canvas-model-fixture-[A-Za-z0-9-]{1,128}$/.test(databaseName)) throw new Error('归档文件只接受隔离 fixture 数据库');
  const safe = safeExchangePath(relative);
  const lease = await getProjectModelMaintenanceLease();
  if (lease.productionAllowed !== false || lease.mode !== 'isolated-fixture' || !lease.coldStart
    || databaseName !== `ai-canvas-model-fixture-${lease.profileId}` || !/^[A-Za-z0-9-]{1,128}$/.test(lease.profileId)) {
    throw new Error('归档文件演练需要独立冷维护 fixture，不能访问真实项目目录');
  }
  const dataRoot = await appDataDir(), root = joinPath(dataRoot, 'project-model-fixture-assets', lease.profileId);
  const path = joinPath(root, safe);
  await verifyProjectModelMaintenanceLease(lease.leaseId);
  // 逐级核普通目录，拒绝符号链接；原生命令还会再次核真实路径及私有目录祖先。
  let current = dataRoot;
  for (const segment of ['project-model-fixture-assets', lease.profileId, ...safe.split('/')]) {
    current = joinPath(current, segment);
    if (!(await exists(current))) {
      if (create) await mkdir(current);
      else { await verifyProjectModelMaintenanceLease(lease.leaseId); return path; }
    }
    const info = await lstat(current);
    if (!info.isDirectory || info.isSymlink) throw new Error('fixture 素材根不是普通目录');
  }
  await verifyProjectModelMaintenanceLease(lease.leaseId);
  return path;
}

/** 每次预览独占新目录；失败或journal仍引用的暂存均保留，不能猜测安全后自动删除。 */
export async function createProjectArchiveFixturePreviewDirectory(databaseName: string, operationId: string): Promise<{ sourceRef: string; directory: string }> {
  if (!/^ai-canvas-model-fixture-[A-Za-z0-9-]{1,128}$/.test(databaseName)) throw new Error('归档文件只接受隔离 fixture 数据库');
  if (!/^[A-Za-z0-9-]{1,100}$/.test(operationId)) throw new Error('归档预览操作身份无效');
  await projectArchiveFixtureDirectory(databaseName, 'archive-previews', true);
  const sourceRef = `archive-previews/${operationId}`, directory = await projectArchiveFixtureDirectory(databaseName, sourceRef);
  // mkdir 非recursive，在竞争/已有目录时失败，不能复用另一份包的来源。
  await mkdir(directory);
  await projectArchiveFixtureDirectory(databaseName, sourceRef);
  return { sourceRef, directory };
}
