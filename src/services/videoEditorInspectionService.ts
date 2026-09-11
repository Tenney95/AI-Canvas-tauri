import { VideoEditorControlError } from "../types/videoEditorControl";
/** MCP 验片仅按当前画布节点取素材，帧图只作为瞬时富内容返回。 */
import { useAppStore } from '../store/useAppStore';
import { blobToDataUrl } from '../store/store.utils';
import { getConvertFileSrc } from './fileService';
import { createVideoInput, extractFramesAtTimestamps, probeVideoSource } from './videoEditorMediaService';
import { assertVideoEditorContext, bindVideoEditorMedia } from './videoEditorControlService';
import type { VideoEditorControlContext } from '../types/videoEditorControl';
import type { VideoEditorClip } from '../types/videoEditor';

export function controlledClipUrl(clip: Pick<VideoEditorClip, 'filePath' | 'sourceUrl'>): string {
  const convert = getConvertFileSrc();
  const url = clip.filePath && convert ? convert(clip.filePath) : clip.sourceUrl;
  if (!url) throw new VideoEditorControlError('素材没有可读取的地址');
  return url;
}

function nodeSource(context: VideoEditorControlContext, nodeId: string) {
  assertVideoEditorContext(context);
  const node = useAppStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  const audio = ['ai-audio', 'source-audio'].includes(node?.type ?? '');
  const source = bindVideoEditorMedia(nodeId, 'video', audio);
  const check = () => {
    assertVideoEditorContext(context);
    if (JSON.stringify(source) !== JSON.stringify(bindVideoEditorMedia(nodeId, 'video', audio))) {
      throw new VideoEditorControlError('素材已变化，请重新读取');
    }
  };
  return { source, check, audio };
}

export async function probeControlledNode(context: VideoEditorControlContext, nodeId: string) {
  const { source, check } = nodeSource(context, nodeId);
  const input = await createVideoInput(controlledClipUrl(source));
  try {
    check();
    const probe = await probeVideoSource(input);
    check();
    if (!Number.isFinite(probe.duration) || probe.duration <= 0) throw new VideoEditorControlError('媒体时长无效');
    return { nodeId, ...probe };
  } finally { input.dispose(); }
}

export function validateInspectionTimes(timestamps: number[], duration: number) {
  if (!timestamps.length || timestamps.length > 6 || timestamps.some((time, index) => (
    !Number.isFinite(time) || time < 0 || time >= duration || (index > 0 && time <= timestamps[index - 1])
  ))) throw new VideoEditorControlError('请提供 1 至 6 个严格递增、位于片长范围内的时间点');
}

export async function inspectionImage(canvas: HTMLCanvasElement | OffscreenCanvas) {
  const blob = 'convertToBlob' in canvas
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
    : await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (
      value ? resolve(value) : reject(new VideoEditorControlError('验片图编码失败'))
    ), 'image/jpeg', 0.75));
  if (blob.size > 512 * 1024) throw new VideoEditorControlError('单张验片图超过 512 KiB');
  const data = (await blobToDataUrl(blob)).split(',')[1];
  return { type: 'image' as const, mimeType: 'image/jpeg' as const, data };
}

export async function inspectControlledNode(context: VideoEditorControlContext, nodeId: string, timestamps: number[]) {
  const { source, check, audio } = nodeSource(context, nodeId);
  if (audio) throw new VideoEditorControlError('抽帧需要视频节点');
  const input = await createVideoInput(controlledClipUrl(source));
  const frames: Awaited<ReturnType<typeof extractFramesAtTimestamps>> = [];
  try {
    check();
    const probe = await probeVideoSource(input);
    validateInspectionTimes(timestamps, probe.duration);
    // 同时限制宽与高，避免超宽片源放大返回体积。
    const height = Math.max(1, Math.floor(Math.min(540, 960 * probe.height / Math.max(1, probe.width))));
    frames.push(...await extractFramesAtTimestamps(input, { timestamps, height, signal: context.signal }));
    check();
    const images = [];
    const samples = [];
    for (const [index, frame] of frames.entries()) {
      if (!frame) throw new VideoEditorControlError(`时间点 ${timestamps[index]} 秒没有可解码画面`);
      images.push(await inspectionImage(frame.canvas));
      samples.push({ requestedTime: frame.requestedTime, actualTime: frame.actualTime, duration: frame.duration,
        width: frame.width, height: frame.height });
    }
    check();
    return { metadata: { nodeId, probe, samples }, images };
  } finally {
    for (const frame of frames) if (frame) { frame.canvas.width = 1; frame.canvas.height = 1; }
    input.dispose();
  }
}
