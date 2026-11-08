/** 本机同步产物只认受控目录内的内容摘要身份，不保存远端URL或伪造taskId。 */
import { invoke } from '@tauri-apps/api/core';
import type { NativeMediaLocalResult } from '../types/media';
import { getProjectDataDir, getRelativeAssetPath } from './fileService';
import { exists } from '@tauri-apps/plugin-fs';
import { safeExchangePath } from './projectExchangeDomain';
import { isNativeMediaContentPath } from './nativeMediaContentPath';

export async function readNativeMediaLocalResult(canvasId: string, expected: NativeMediaLocalResult): Promise<void> {
  const root = await getProjectDataDir(canvasId);
  if (!root || !isNativeMediaContentPath(expected.relativePath, expected.sha256)) throw new Error('原同步产物缺少受控内容身份');
  const rows = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', {
    assetsDir: root, selectedPaths: [expected.relativePath],
  });
  if (rows.length !== 1 || rows[0].path !== expected.relativePath || rows[0].bytes !== expected.bytes
    || rows[0].sha256 !== expected.sha256) throw new Error('原同步产物缺失或已变化，原操作保留，不会重新生成');
}
export async function captureNativeMediaLocalResult(canvasId: string, filePath: string): Promise<NativeMediaLocalResult> {
  const root = await getProjectDataDir(canvasId), relativePath = root && getRelativeAssetPath(filePath, root);
  if (!root || !relativePath || safeExchangePath(relativePath) !== relativePath) throw new Error('同步结果尚未保存为原项目内容文件');
  const rows = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', {
    assetsDir: root, selectedPaths: [relativePath],
  });
  if (rows.length !== 1 || rows[0].path !== relativePath || !/^[a-f0-9]{64}$/.test(rows[0].sha256)
    || !Number.isSafeInteger(rows[0].bytes) || rows[0].bytes <= 0) throw new Error('同步结果文件身份无法核验');
  const { bytes, sha256 } = rows[0];
  if (isNativeMediaContentPath(relativePath, sha256)) return { relativePath, bytes, sha256 };
  if (/^media\/[a-f0-9]{64}\./.test(relativePath) || /^imports\/retained-[a-f0-9]{64}\//.test(relativePath)) {
    throw new Error('原摘要产物字节已变化，未将替换内容绑定到原任务');
  }
  const suffix = relativePath.split('.').at(-1)?.toLowerCase();
  const extension = suffix && /^[a-z0-9]{1,16}$/.test(suffix) ? suffix : 'bin';
  const operationId = `retained-${sha256}`, name = `${sha256}.${extension}`;
  const directory = `${root.replace(/[\\/]+$/, '')}/imports/${operationId}`;
  if (!await exists(directory)) {
    try { await invoke('publish_project_import_assets', { stagingDir: root, projectDir: root, operationId,
      assets: [{ path: relativePath, destinationPath: name, bytes, sha256 }] }); }
    catch (error) { if (!await exists(directory)) throw error; }
  }
  const frozen = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', { assetsDir: directory });
  if (frozen.length !== 1 || !new RegExp(`^${sha256}\\.[a-z0-9]{1,16}$`).test(frozen[0].path)
    || frozen[0].bytes !== bytes || frozen[0].sha256 !== sha256) throw new Error('已保留产物目录与原字节不一致，未覆盖文件');
  // 同一字节以不同扩展名下载时复用首个摘要副本，不改名或覆盖已有产物。
  return { relativePath: `imports/${operationId}/${frozen[0].path}`, bytes, sha256 };
}
