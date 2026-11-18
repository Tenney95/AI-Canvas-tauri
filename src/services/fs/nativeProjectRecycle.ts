/** 整项目已删除后，凭本次确认的根目录和墓碑回执尝试系统回收。 */
import { invoke } from '@tauri-apps/api/core';
import { transitionNativeProjectRecycle } from '../indexedDb/nativeProjectRepository';
import { moveToTrash } from './trash';
import { assertNativeProjectRecycleReferences } from './nativeProjectRecycleReferences';

export type NativeProjectRecycleResult = 'recycled' | 'retained' | 'unconfirmed';

/** 只解析既有根目录，读取失败时仍可删除项目记录。 */
export async function readNativeProjectRecycleRoot(projectId: string): Promise<string | undefined> {
  try {
    const root = await invoke<string>('resolve_native_project_media_root', { projectId });
    return typeof root === 'string' && root ? root : undefined;
  }
  catch { return undefined; }
}

export async function recycleRetiredNativeProjectDirectory(
  projectId: string, requestId: string, expectedRoot: string | undefined, assertCurrent: () => void,
): Promise<NativeProjectRecycleResult> {
  let recycling = false;
  let requestedSystemMove = false;
  try {
    if (!expectedRoot || await readNativeProjectRecycleRoot(projectId) !== expectedRoot) throw new Error('原素材目录不可用');
    const assertReferencesCurrent = await assertNativeProjectRecycleReferences(projectId, expectedRoot);
    assertCurrent();
    recycling = await transitionNativeProjectRecycle(projectId, requestId, 'pending', 'recycling');
    if (!recycling) throw new Error('原回收记录已更新');
    assertCurrent();
    assertReferencesCurrent();
    requestedSystemMove = true;
    await moveToTrash(expectedRoot, { throwOnError: true, nativeProjectId: projectId });
  } catch {
    // IPC 中断后若无法重新核对原位置，保留处理中状态，避免对后来出现的目录重试。
    if (requestedSystemMove && await readNativeProjectRecycleRoot(projectId) !== expectedRoot) return 'unconfirmed';
    await transitionNativeProjectRecycle(projectId, requestId, recycling ? 'recycling' : 'pending', 'retained').catch(() => false);
    return 'retained';
  }
  await transitionNativeProjectRecycle(projectId, requestId, 'recycling', 'recycled').catch(() => false);
  return 'recycled';
}
