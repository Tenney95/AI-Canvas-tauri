/** 固定归档 JSON Worker；失败时拒绝导出，不回退到主线程处理大型正文。 */
import { normalizeProjectSeriesInfo } from './indexedDb/projectSummary';

function normalizeRecordGraph(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!record.series || typeof record.series !== 'object' || !Object.hasOwn(record.series, 'storyGraph')) return value;
  return { ...record, series: normalizeProjectSeriesInfo(record.series) };
}
export interface ProjectArchiveJsonEntry {
  path: string;
  value: unknown;
}

export interface ProjectArchiveTextEntry {
  path: string;
  content: string;
}

export type ProjectArchiveSerializationResponse =
  | { ok: true; entries: ProjectArchiveTextEntry[] }
  | { ok: false };

const SERIALIZATION_TIMEOUT_MS = 60_000;
let serializationActive = false;

/** 同时最多一个归档序列化任务；每次调用独占 Worker，完成或失败立即回收。 */
export async function serializeProjectArchiveEntries(entries: ProjectArchiveJsonEntry[]): Promise<ProjectArchiveTextEntry[]> {
  // 只规范化固定项目条目中的有界图；大型正文的 JSON 整理仍交给 Worker。
  entries = entries.map((entry) => entry.path === 'project.json'
    ? { ...entry, value: normalizeRecordGraph(entry.value) }
    : entry.path === 'episodes.json' && Array.isArray(entry.value)
      ? { ...entry, value: entry.value.map((episode: unknown) => episode && typeof episode === 'object' && !Array.isArray(episode)
        ? { ...episode, project: normalizeRecordGraph((episode as Record<string, unknown>).project) } : episode) } : entry);
  if (serializationActive) throw new Error('已有项目归档正在整理，请稍后重试');
  if (typeof Worker === 'undefined') throw new Error('当前环境无法启动项目导出后台任务，请重启应用后重试');
  serializationActive = true;
  try {
    return await new Promise<ProjectArchiveTextEntry[]>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./projectArchiveSerializationWorker.ts', import.meta.url), { type: 'module' });
      } catch {
        reject(new Error('项目导出后台任务启动失败，请重试'));
        return;
      }
      let finished = false;
      const finish = (result?: ProjectArchiveTextEntry[], error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(() => finish(undefined, new Error('项目导出整理超时，请重试')), SERIALIZATION_TIMEOUT_MS);
      worker.onmessage = (event: MessageEvent<ProjectArchiveSerializationResponse>) => {
        const result = event.data;
        if (!result?.ok || !Array.isArray(result.entries) || result.entries.length !== entries.length
          || result.entries.some((entry, index) => entry?.path !== entries[index].path || typeof entry.content !== 'string')) {
          finish(undefined, new Error('项目导出整理失败，请重试'));
          return;
        }
        finish(result.entries);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish(undefined, new Error('项目导出后台任务失败，请重试'));
      };
      worker.onmessageerror = () => finish(undefined, new Error('项目导出后台结果读取失败，请重试'));
      try {
        worker.postMessage(entries);
      } catch {
        finish(undefined, new Error('项目导出数据无法交给后台任务，请重试'));
      }
    });
  } finally {
    serializationActive = false;
  }
}
