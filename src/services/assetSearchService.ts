/** 独立资源搜索的有界扫描：分批发布，来源顺序稳定，取消后不再发布旧结果。 */
import { listProjectFiles, listGlobalFiles, listExternalFolderContents, type AssetFileEntry } from './fileService';

export interface AssetSearchEntry extends AssetFileEntry {
  projectId?: string;
  projectName?: string;
}

export async function loadAssetSearchFiles(
  projects: readonly { id: string; name: string }[],
  folders: readonly string[],
  options: { signal: AbortSignal; onFiles: (files: AssetSearchEntry[]) => void },
): Promise<AssetSearchEntry[]> {
  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  type Scan = (onFiles: (files: AssetSearchEntry[]) => void) => Promise<AssetFileEntry[]>;
  const scans: Scan[] = [
    ...projects.map((project): Scan => async (onFiles) => {
      const enrich = (files: AssetFileEntry[]) => files.map((file) => ({
        ...file, source: 'project' as const, projectId: project.id, projectName: project.name,
      }));
      return enrich(await listProjectFiles(project.id, { signal, onFiles: (files) => onFiles(enrich(files)) }));
    }),
    (onFiles) => listGlobalFiles({ signal, onFiles }),
    ...folders.map((root): Scan => async (onFiles) => (
      await listExternalFolderContents([root], { signal, onFiles })
    ).files),
  ];
  const entries = new Map<string, { source: number; order: number; file: AssetSearchEntry }>();
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let published = false;
  let result: AssetSearchEntry[] = [];
  const publish = () => {
    timer = undefined;
    if (signal.aborted || !dirty) return;
    dirty = false;
    published = true;
    result = [...entries.values()].sort((a, b) => a.source - b.source || a.order - b.order).map((entry) => entry.file);
    options.onFiles(result);
  };
  const worker = async () => {
    while (cursor < scans.length) {
      signal.throwIfAborted();
      const source = cursor++;
      let order = 0;
      const receive = (files: AssetSearchEntry[]) => {
        if (signal.aborted) return;
        for (const file of files) {
          const previous = entries.get(file.path);
          // 即便较高优先级来源更晚完成，也保持原先“项目 → 全局 → 文件夹”的归属。
          if (!previous || source < previous.source) {
            entries.set(file.path, { source, order: order++, file });
            dirty = true;
          }
        }
        if (!published) publish();
        else if (dirty && timer === undefined) timer = setTimeout(publish, 100);
      };
      receive(await scans[source](receive));
      signal.throwIfAborted();
    }
  };
  try {
    // 每个目录内部最多 12 个 stat；来源层最多 3 个扫描，避免随项目数量无限放大。
    await Promise.all(Array.from({ length: Math.min(3, scans.length) }, worker));
    if (timer !== undefined) clearTimeout(timer);
    publish();
    return result;
  } finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
  }
}
