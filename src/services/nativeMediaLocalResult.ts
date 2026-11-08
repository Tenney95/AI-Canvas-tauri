/** 本机同步产物只认受控目录内的内容摘要身份，不保存远端URL或伪造taskId。 */
import { invoke } from '@tauri-apps/api/core';
import type { NativeMediaLocalResult } from '../types/media';
import { getProjectDataDir, getRelativeAssetPath } from './fileService';

export async function readNativeMediaLocalResult(canvasId: string, expected: NativeMediaLocalResult): Promise<void> {
  const root = await getProjectDataDir(canvasId);
  const match = /^media\/([a-f0-9]{64})\.[a-z0-9]{1,16}$/.exec(expected.relativePath);
  if (!root || !match || match[1] !== expected.sha256) throw new Error('原同步产物缺少受控内容身份');
  const rows = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', {
    assetsDir: root, selectedPaths: [expected.relativePath],
  });
  if (rows.length !== 1 || rows[0].path !== expected.relativePath || rows[0].bytes !== expected.bytes
    || rows[0].sha256 !== expected.sha256) throw new Error('原同步产物缺失或已变化，原操作保留，不会重新生成');
}
export async function captureNativeMediaLocalResult(canvasId: string, filePath: string): Promise<NativeMediaLocalResult> {
  const root = await getProjectDataDir(canvasId), relativePath = root && getRelativeAssetPath(filePath, root);
  const match = relativePath && /^media\/([a-f0-9]{64})\.[a-z0-9]{1,16}$/.exec(relativePath);
  if (!root || !relativePath || !match) throw new Error('同步结果尚未保存为原项目内容文件');
  const rows = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', {
    assetsDir: root, selectedPaths: [relativePath],
  });
  if (rows.length !== 1 || rows[0].path !== relativePath || rows[0].sha256 !== match[1] || !Number.isSafeInteger(rows[0].bytes) || rows[0].bytes <= 0) throw new Error('同步结果文件身份无法核验');
  return { relativePath, bytes: rows[0].bytes, sha256: rows[0].sha256 };
}
