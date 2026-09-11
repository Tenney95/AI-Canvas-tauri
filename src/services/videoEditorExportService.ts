import { VideoEditorControlError } from "../types/videoEditorControl";
/** 有界后台合成任务；完成后只向仍匹配的项目画布提交一次结果。 */
import { useAppStore } from '../store/useAppStore';
import { generateId } from '../store/store.utils';
import { saveBinaryToProjectData } from './fileService';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from './canvasDerivationGuard';
import { assertEditorWindowClosed, assertVideoEditorContext, bindVideoEditorTracks, DEFAULT_VIDEO_EDITOR_OUTPUT,
  readControlledEditor, validateVideoEditorOutput, videoEditorVersion } from './videoEditorControlService';
import { prepareControlledRenderSources } from './videoEditorRenderSources';
import { createVideoInput, exportComposite, probeVideoSource } from './videoEditorMediaService';
import { renderFrameAt } from './videoCompositor';
import { inspectionImage, validateInspectionTimes } from './videoEditorInspectionService';
import { computeTimelineDuration, type VideoEditorProjectRecord } from '../types/videoEditor';
import type { VideoEditorControlContext, VideoEditorExportInput, VideoEditorExportStatus } from '../types/videoEditorControl';

interface ExportJob {
  projectId: string;
  requestKey: string;
  controller: AbortController;
  status: VideoEditorExportStatus;
}
const jobs: Map<string, ExportJob> = import.meta.hot?.data.videoExportJobs ?? new Map();
let starting = false;
const active = (job: ExportJob) => ['queued', 'running', 'saving'].includes(job.status.status);

function findJob(context: VideoEditorControlContext, jobId: string) {
  assertVideoEditorContext(context);
  const job = jobs.get(jobId);
  if (!job || job.projectId !== context.projectId) throw new VideoEditorControlError('当前项目没有该导出任务');
  return job;
}

export function getControlledExport(context: VideoEditorControlContext, jobId: string) {
  return { ...findJob(context, jobId).status };
}

export function cancelControlledExport(context: VideoEditorControlContext, jobId: string) {
  const job = findJob(context, jobId);
  if (active(job)) { job.controller.abort(); job.status.stage = '正在取消'; }
  return { ...job.status };
}

function validateRecord(record: VideoEditorProjectRecord) {
  validateVideoEditorOutput(record.output ?? DEFAULT_VIDEO_EDITOR_OUTPUT);
  bindVideoEditorTracks(record.tracks);
  const duration = computeTimelineDuration(record.tracks);
  if (!Number.isFinite(duration) || duration <= 0) throw new VideoEditorControlError('时间轴为空');
  return duration;
}

async function assertRecordVersion(context: VideoEditorControlContext, editorId: string, version: string) {
  const record = await readControlledEditor(context, editorId);
  if (await videoEditorVersion(record) !== version) throw new VideoEditorControlError('剪辑工程已变化，请重新读取版本');
  assertVideoEditorContext(context);
  return record;
}

export async function startControlledExport(context: VideoEditorControlContext, input: VideoEditorExportInput) {
  assertVideoEditorContext(context);
  const prior = [...jobs.values()].find((job) => job.projectId === context.projectId && job.requestKey === input.requestKey);
  if (prior) {
    if (prior.status.editorId !== input.editorId || prior.status.version !== input.expectedVersion) {
      throw new VideoEditorControlError('requestKey 已用于另一工程或版本，请读取原任务结果');
    }
    return { ...prior.status };
  }
  if (starting || [...jobs.values()].some(active)) throw new VideoEditorControlError('已有合成任务正在运行，请先查询或取消');
  starting = true;
  try {
    await assertEditorWindowClosed();
    const record = await assertRecordVersion(context, input.editorId, input.expectedVersion);
    validateRecord(record);
    assertVideoEditorContext(context);
    // 只保留最近 30 项。进行中的任务不会被裁剪。
    while (jobs.size >= 30) {
      const oldest = [...jobs.entries()].find(([, job]) => !active(job));
      if (!oldest) break;
      jobs.delete(oldest[0]);
    }
    const controller = new AbortController();
    const guard = registerCanvasDerivation(useAppStore.getState(), record.nodeId, { onCancel: () => controller.abort() });
    if (!guard) throw new VideoEditorControlError('剪辑工程的锚点节点已不存在');
    const jobId = `video-export-${generateId()}`;
    const job: ExportJob = { projectId: context.projectId, requestKey: input.requestKey, controller,
      status: { jobId, editorId: record.id, version: input.expectedVersion, status: 'queued',
        progress: 0, stage: '等待合成', createdAt: Date.now() } };
    jobs.set(jobId, job);
    // 接受后由独立取消入口与项目派生守卫管理；不依赖已完成的 MCP 请求信号。
    const runContext = { projectId: context.projectId, baseRevision: guard.baseRevision, signal: controller.signal };
    const check = () => {
      assertVideoEditorContext(runContext);
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) throw new VideoEditorControlError('项目或画布已变化');
    };
    void runExport(job, record, runContext, check).finally(() => completeCanvasDerivation(guard));
    return { ...job.status };
  } finally { starting = false; }
}

async function runExport(job: ExportJob, record: VideoEditorProjectRecord, context: VideoEditorControlContext, check: () => void) {
  let sources: Awaited<ReturnType<typeof prepareControlledRenderSources>> | undefined;
  let saved = false;
  const checkAssets = () => { check(); sources?.assertFresh(); };
  try {
    job.status.status = 'running'; job.status.stage = '读取素材';
    sources = await prepareControlledRenderSources(record, check);
    const output = record.output ?? DEFAULT_VIDEO_EDITOR_OUTPUT;
    const duration = computeTimelineDuration(record.tracks);
    const bytes = await exportComposite({ tracks: record.tracks, duration, canvas: output, frameRate: output.frameRate,
      ...sources, signal: context.signal,
      onProgress: (value) => { checkAssets(); job.status.progress = Math.min(0.95, value * 0.95); },
      onStage: (stage) => { checkAssets(); job.status.stage = stage; },
      onAudioMode: (mode) => { job.status.audioMode = mode; },
    });
    checkAssets();
    job.status.stage = '校验成片';
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
    let probe;
    try {
      const encoded = await createVideoInput(url);
      try { probe = await probeVideoSource(encoded); } finally { encoded.dispose(); }
    } finally { URL.revokeObjectURL(url); }
    if (!probe.decodable || probe.width !== output.width || probe.height !== output.height
      || Math.abs(probe.duration - duration) > Math.max(0.1, 2 / output.frameRate)) throw new VideoEditorControlError('成片参数校验失败');
    await assertRecordVersion(context, record.id, job.status.version);
    await assertEditorWindowClosed();
    checkAssets();
    job.status.status = 'saving'; job.status.stage = '保存成片';
    const fileName = `${job.status.jobId}.mp4`;
    const result = await saveBinaryToProjectData(bytes, context.projectId, fileName);
    if (!result) throw new VideoEditorControlError('成片保存失败');
    saved = true;
    await assertRecordVersion(context, record.id, job.status.version);
    checkAssets();
    const nodeId = `node-${generateId()}`;
    const store = useAppStore.getState();
    const anchor = store.nodes.find((node) => node.id === record.nodeId)!;
    store.addNodesWithEdges([{ id: nodeId, type: 'source-video',
      position: { x: anchor.position.x + 380, y: anchor.position.y },
      data: { type: 'source-video', label: record.name, filePath: result.filePath, videoUrl: result.assetUrl,
        fileName, videoDuration: probe.duration, status: 'success' } }], []);
    useAppStore.getState().incrementRevision();
    Object.assign(job.status, { status: 'succeeded', progress: 1, stage: '已保存并添加到画布',
      nodeId, fileName, duration: probe.duration, width: probe.width, height: probe.height, frameRate: output.frameRate });
  } catch (error) {
    job.status.status = context.signal.aborted ? 'cancelled' : 'failed';
    job.status.stage = context.signal.aborted ? '已取消' : '导出失败';
    // 原生/解码异常可能包含路径和地址，任务持久化与 MCP 均只返回固定摘要。
    job.status.error = saved ? '文件已保存，但项目或工程发生变化，未添加画布节点；可在项目素材目录查看。'
      : context.signal.aborted ? '导出已取消，未添加画布节点。'
        : error instanceof VideoEditorControlError ? error.message
          : '导出未完成。请检查素材可解码性、片段出点、编码支持、工程版本和项目存储授权。';
  } finally {
    sources?.dispose();
    job.status.finishedAt = Date.now();
  }
}

export async function previewControlledEditor(context: VideoEditorControlContext, editorId: string, version: string, timestamps: number[]) {
  const record = await assertRecordVersion(context, editorId, version);
  const duration = validateRecord(record);
  validateInspectionTimes(timestamps, duration);
  const check = () => assertVideoEditorContext(context);
  const sources = await prepareControlledRenderSources(record, check);
  const output = record.output ?? DEFAULT_VIDEO_EDITOR_OUTPUT;
  // 在真实输出画幅渲染文字后再缩小，保持字号与最终合成一致。
  const canvas = document.createElement('canvas');
  canvas.width = output.width; canvas.height = output.height;
  const thumb = document.createElement('canvas');
  const scale = Math.min(960 / output.width, 540 / output.height, 1);
  thumb.width = Math.round(output.width * scale); thumb.height = Math.round(output.height * scale);
  try {
    const surface = canvas.getContext('2d', { alpha: false });
    const thumbnail = thumb.getContext('2d', { alpha: false });
    if (!surface || !thumbnail) throw new VideoEditorControlError('无法建立合成预览');
    const images = [];
    for (const time of timestamps) {
      check();
      await renderFrameAt(surface, output, record.tracks, time, sources.resolveVideo);
      sources.assertFresh();
      thumbnail.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      images.push(await inspectionImage(thumb));
    }
    await assertRecordVersion(context, editorId, version);
    sources.assertFresh();
    return { metadata: { editorId, version, duration, timestamps, width: thumb.width, height: thumb.height }, images };
  } finally { sources.dispose(); canvas.width = 1; canvas.height = 1; thumb.width = 1; thumb.height = 1; }
}

if (import.meta.hot) {
  import.meta.hot.data.videoExportJobs = jobs;
  import.meta.hot.dispose(() => { for (const job of jobs.values()) if (active(job)) job.controller.abort(); });
}
