/** 新库耐久输出历史到既有历史视图的可重放投影，不修改媒体任务或生成权限。 */
import { getUnprojectedNativeOutputHistory, putNativeOutputHistoryEntries } from './indexedDbService';
import { readNativeProjectCapture, readNativeProjectByCanvasId, isNativeCanvasId } from './indexedDb/nativeProjectRepository';
import { readNativeOutputHistory } from './nativeOutputHistory';
import { createNativeMediaDisplayResolver, nativeMediaContentDigest } from './nativeMediaDisplay';
import { safeExchangePath } from './projectExchangeDomain';
import { getAssetUrlFromPath, joinPath } from './fs/core';
import { invoke } from '@tauri-apps/api/core';
import { configValuesEqual } from './configPatch';
import type { HistoryRecord } from './indexedDbService';

const syncing = new Map<string, Promise<void>>();

export function syncNativeOutputHistory(canvasId: string): Promise<void> {
  if (!isNativeCanvasId(canvasId)) return Promise.resolve();
  const running = syncing.get(canvasId);
  if (running) return running;
  const pending = (async () => {
    const candidates = await readNativeOutputHistory(canvasId);
    const unseen = await getUnprojectedNativeOutputHistory(candidates.map((item) => item.entry));
    if (!unseen.length) return;
    const ids = new Set(unseen.map((entry) => entry.id));
    const selected = candidates.filter((item) => ids.has(item.entry.id));
    const projectId = selected[0]?.ownerProjectId;
    if (!projectId || selected.some((item) => item.ownerProjectId !== projectId)) throw new Error('新项目输出历史归属异常');
    const capture = await readNativeProjectCapture(projectId);
    if (!capture || !capture.aggregate.canvases.some((canvas) => canvas.id === canvasId)) return;
    const display = createNativeMediaDisplayResolver(capture.aggregate.project);
    const records: HistoryRecord[] = [];
    for (const candidate of selected) {
      // 个别原文件暂不可读时保留outbox，下次读取重试，不把成功历史永久改成失败。
      try {
        let media: { url: string; filePath: string };
        if (nativeMediaContentDigest(candidate.relativePath) === candidate.sha256) media = await display(candidate.rootRef, candidate);
        else {
          // 旧导入产物由归档映射提供摘要，不能要求其路径仍是生成时的摘要目录。
          if (!candidate.relativePath.startsWith('imports/') || safeExchangePath(candidate.relativePath) !== candidate.relativePath) continue;
          const directory = await display.directory(candidate.rootRef);
          const files = await invoke<Array<{ path: string; bytes: number; sha256: string }>>('inspect_project_archive_assets', {
            assetsDir: directory, selectedPaths: [candidate.relativePath],
          });
          if (files.length !== 1 || files[0].path !== candidate.relativePath || files[0].sha256 !== candidate.sha256
            || !Number.isSafeInteger(files[0].bytes) || files[0].bytes <= 0 || candidate.bytes !== undefined && files[0].bytes !== candidate.bytes) continue;
          const filePath = joinPath(directory, candidate.relativePath);
          media = { filePath, url: await getAssetUrlFromPath(filePath) };
        }
        records.push({ ...candidate.entry, output: media.url, mediaUrl: media.url, filePath: media.filePath,
          relativePath: candidate.relativePath, storageRootRef: candidate.rootRef });
      } catch { /* 不消费尚未核验的媒体身份。 */ }
    }
    const latest = await readNativeProjectCapture(projectId);
    if (!latest || latest.aggregate.project.epoch !== capture.aggregate.project.epoch
      || !configValuesEqual(latest.aggregate.project.storageBindings, capture.aggregate.project.storageBindings)
      || latest.aggregate.canvases.find((canvas) => canvas.id === canvasId)?.epoch
        !== capture.aggregate.canvases.find((canvas) => canvas.id === canvasId)?.epoch) return;
    await putNativeOutputHistoryEntries(records);
  })().finally(() => { if (syncing.get(canvasId) === pending) syncing.delete(canvasId); });
  syncing.set(canvasId, pending);
  return pending;
}

/** 导入历史只持久化相对身份；读取时按当前本机绑定水化，不复制发送端绝对路径。 */
export async function hydrateNativeOutputHistoryRecords(canvasId: string, records: HistoryRecord[]): Promise<HistoryRecord[]> {
  if (!isNativeCanvasId(canvasId) || !records.some((record) => record.relativePath && record.storageRootRef)) return records;
  const aggregate = await readNativeProjectByCanvasId(canvasId);
  if (!aggregate) return records;
  const display = createNativeMediaDisplayResolver(aggregate.project);
  return Promise.all(records.map(async (record) => {
    if (record.projectId !== canvasId || !record.relativePath || !record.storageRootRef) return record;
    if (safeExchangePath(record.relativePath) !== record.relativePath) throw new Error('输出历史文件身份无效');
    const filePath = joinPath(await display.directory(record.storageRootRef), record.relativePath);
    const mediaUrl = await getAssetUrlFromPath(filePath);
    return { ...record, filePath, mediaUrl, output: record.nodeType === 'ai-text' ? record.output : mediaUrl };
  }));
}
