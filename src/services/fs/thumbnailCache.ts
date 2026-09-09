import { invoke } from '@tauri-apps/api/core';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { getProjectDataDir, isTauriEnv } from './core';

const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_WRITES = 64;

interface PendingWrite {
  blob: Blob;
  signal: AbortSignal;
  args: { projectDir: string; sourcePath: string; maxEdge: number; sourceVersion: string };
  resolve: () => void;
}

const pendingWrites: PendingWrite[] = [];
let queuedBytes = 0;
let writing = false;

async function drainWrites(): Promise<void> {
  if (writing) return;
  writing = true;
  try {
    while (pendingWrites.length > 0) {
      const job = pendingWrites.shift()!;
      queuedBytes -= job.blob.size;
      try {
        if (job.signal.aborted) continue;
        const bytes = new Uint8Array(await job.blob.arrayBuffer());
        if (job.signal.aborted) continue;
        await invoke<boolean>('write_project_thumbnail', { ...job.args, bytes: Array.from(bytes) });
      } catch { /* 缓存写入失败不影响已显示的内存预览。 */ }
      finally { job.resolve(); }
    }
  } finally { writing = false; }
}

function enqueueWrite(job: Omit<PendingWrite, 'resolve'>): Promise<void> {
  // 排队只持有编码 Blob；满时放弃可重建缓存，绝不阻塞画布或无限积累 IPC。
  if (job.signal.aborted || job.blob.size === 0 || job.blob.size > MAX_THUMBNAIL_BYTES
    || pendingWrites.length >= MAX_QUEUED_WRITES || queuedBytes + job.blob.size > MAX_QUEUED_BYTES) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    pendingWrites.push({ ...job, resolve });
    queuedBytes += job.blob.size;
    void drainWrites();
  });
}

interface NativeThumbnail {
  sourceVersion: string;
  cachedBytes: number[] | null;
  width: number | null;
  height: number | null;
}

export interface ProjectThumbnailSession {
  cached: { blob: Blob; width: number; height: number } | null;
  persist: (blob: Blob) => Promise<void>;
}

/** 项目缓存只处理已落盘的真实显示源；路径与源版本由原生命令再次校验。 */
export async function prepareProjectThumbnail(
  projectId: string | null | undefined,
  source: string,
  maxEdge: number,
  signal: AbortSignal,
): Promise<ProjectThumbnailSession | null> {
  if (!projectId || !isTauriEnv() || signal.aborted || ![256, 512, 1024].includes(maxEdge)) return null;
  const sourcePath = localMediaUrlToPath(source);
  if (!sourcePath) return null;
  try {
    const projectDir = await getProjectDataDir(projectId);
    if (!projectDir || signal.aborted) return null;
    const result = await invoke<NativeThumbnail>('prepare_project_thumbnail', { projectDir, sourcePath, maxEdge });
    if (signal.aborted) return null;
    let cached: ProjectThumbnailSession['cached'] = null;
    if (result.cachedBytes && result.cachedBytes.length > 0 && result.cachedBytes.length <= MAX_THUMBNAIL_BYTES
      && Number.isInteger(result.width) && Number.isInteger(result.height)
      && result.width! > 0 && result.height! > 0 && result.width! <= maxEdge && result.height! <= maxEdge) {
      const bytes = Uint8Array.from(result.cachedBytes);
      cached = {
        blob: new Blob([bytes], { type: bytes[0] === 0x89 ? 'image/png' : 'image/webp' }),
        width: result.width!, height: result.height!,
      };
    }
    return {
      cached,
      // 固定捕获的项目目录、源版本；切换项目绝不改用新的当前项目。
      persist: (blob) => enqueueWrite({
        blob, signal, args: { projectDir, sourcePath, maxEdge, sourceVersion: result.sourceVersion },
      }),
    };
  } catch {
    // 缓存失败保持内存派生；不记录项目路径，不触发资产变更或自动保存。
    return null;
  }
}
