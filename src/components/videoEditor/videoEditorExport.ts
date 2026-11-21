import type { t as translate } from '../../i18n';
import { buildNodeFileName, saveBinaryToLocalFile, saveBinaryToProjectData } from '../../services/fileService';
import { assertVideoEditorProjectContext } from '../../services/indexedDbService';
import { exportLosslessConcat, VideoExportCanceledError, type ConcatSegment } from '../../services/videoEditorMediaService';
import { postVideoEditorExported, postVideoEditorFrameExported, readVideoEditorWindowBinding } from '../../services/videoEditorWindowService';
import type { VideoEditorCanvasSize, VideoEditorProjectRecord } from '../../types/videoEditor';

export type ExportDestination = 'canvas' | 'local';

/** 独立窗口开不了 devtools，错误详情必须能在界面上直接看到并复制 */
export interface EditorFailure {
  stage: string;
  message: string;
  detail: string;
}

export function describeFailure(stage: string, reason: unknown): EditorFailure {
  if (reason instanceof Error) {
    return {
      stage,
      // WebKit 的 fetch 失败只会给出 "Type error"，必须带上 name 才能分辨
      message: `${reason.name}: ${reason.message}`,
      detail: reason.stack || `${reason.name}: ${reason.message}`,
    };
  }
  return { stage, message: String(reason), detail: String(reason) };
}

/** 给某个阶段的异步操作打上标签，失败时能立刻知道断在哪一步 */
export async function withStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (reason) {
    if (reason instanceof VideoExportCanceledError) throw reason;
    const failure = describeFailure(stage, reason);
    const error = new Error(`${stage}：${failure.message}`);
    error.stack = failure.detail;
    throw error;
  }
}

export function assertWindowProjectCurrent(projectId: string): Promise<void> {
  const binding = readVideoEditorWindowBinding();
  return assertVideoEditorProjectContext(projectId, binding?.expectedContext, binding?.expectedContext.modelGeneration === 1 ? binding.sessionId : undefined);
}

export async function encodeLosslessSegments({
  segments, timelineDuration, onProgress, signal, t,
}: {
  segments: ConcatSegment[];
  timelineDuration: number;
  onProgress: (progress: number) => void;
  signal: AbortSignal;
  t: typeof translate;
}): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const result = await withStage('无损裁剪导出', () => exportLosslessConcat({
    segments,
    onProgress,
    signal,
  }));
  const notes: string[] = [];

  notes.push(t('已无损导出 {count} 个片段，共 {time}s', {
    count: segments.length, time: timelineDuration.toFixed(2),
  }));
  notes.push(result.audioKept
    ? t('音轨已按原始分组直通保留')
    : t('未输出音轨：{reason}', { reason: result.audioDropReason ?? t('未知原因') }));
  return { bytes: result.bytes, notes };
}

interface ExportedMedia {
  bytes: Uint8Array;
  record: Pick<VideoEditorProjectRecord, 'name' | 'projectId'>;
  instanceId: string;
  t: typeof translate;
}

export async function deliverExportedVideo({
  destination, bytes, record, instanceId, size, timelineDuration, notes, t,
}: ExportedMedia & {
  destination: ExportDestination;
  size: VideoEditorCanvasSize;
  timelineDuration: number;
  notes: string[];
}): Promise<string> {
  const fileName = buildNodeFileName(record.name, 'mp4', 'edited');
  await assertWindowProjectCurrent(record.projectId);
  if (destination === 'local') {
    const savedPath = await withStage('保存到本地', () => saveBinaryToLocalFile(bytes, fileName, undefined,
      { assertCurrent: () => assertWindowProjectCurrent(record.projectId) }));
    if (!savedPath) {
      return t('已取消保存到本地');
    }
    notes.push(t('已保存到本地：{fileName}', { fileName }));
  } else {
    const saved = await withStage('写入项目目录', async () => {
      const result = await saveBinaryToProjectData(bytes, record.projectId, fileName,
        { assertCurrent: () => assertWindowProjectCurrent(record.projectId) });
      if (!result) throw new Error('项目数据目录不可写');
      return result;
    });
    await assertWindowProjectCurrent(record.projectId);

    await withStage('输出到画布', () => postVideoEditorExported(instanceId, {
      videoUrl: saved.assetUrl,
      filePath: saved.filePath,
      fileName,
      duration: timelineDuration,
      // 合成路径按画布尺寸出片，直通路径保持源尺寸
      width: size.width,
      height: size.height,
    }));
    notes.push(t('已创建画布视频节点'));
  }

  return notes.join('；');
}

export async function deliverExportedFrame({
  bytes, record, instanceId, playhead, canvasSize, t,
}: ExportedMedia & { playhead: number; canvasSize: VideoEditorCanvasSize }): Promise<string> {
  await assertWindowProjectCurrent(record.projectId);

  // 同一工程会反复导帧，文件名带上时刻才不至于全靠去重后缀区分
  const stamp = `${Math.round(playhead * 1000)}ms`;
  const fileName = buildNodeFileName(`${record.name} 帧${stamp}`, 'png', `frame-${stamp}`);
  const saved = await withStage('写入项目目录', async () => {
    const result = await saveBinaryToProjectData(bytes, record.projectId, fileName,
      { assertCurrent: () => assertWindowProjectCurrent(record.projectId) });
    if (!result) throw new Error('项目数据目录不可写');
    return result;
  });
  await assertWindowProjectCurrent(record.projectId);

  await withStage('输出到画布', () => postVideoEditorFrameExported(instanceId, {
    imageUrl: saved.assetUrl,
    filePath: saved.filePath,
    fileName,
    time: playhead,
    width: canvasSize.width,
    height: canvasSize.height,
  }));
  return t('已导出 {time}s 的画面为图片节点 · {width}×{height}', {
    time: playhead.toFixed(2), width: canvasSize.width, height: canvasSize.height,
  });
}
