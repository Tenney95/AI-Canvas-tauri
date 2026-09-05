/**
 * 插件视频抽帧宿主服务。
 *
 * 复用内部视频编辑器的 mediabunny 有序批量解码；这里只负责参数边界、JPEG 编码、
 * iframe 预览图与联系表，不接触插件源码、画布 Store 或本地文件路径。
 */
import {
  createVideoInput,
  extractFramesAtTimestamps,
  probeVideoSource,
  type VideoFrameCanvasSample,
} from '../videoEditorMediaService';

const PREVIEW_COUNT_MAX = 48;
const ANALYSIS_COUNT_MAX = 24;
const PREVIEW_HEIGHT = 120;
const ANALYSIS_HEIGHT = 720;
const PREVIEW_MAX_BYTES = 72 * 1024;
const FRAME_MAX_BYTES = 4 * 1024 * 1024;
const SAMPLE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface PluginVideoFrameSampleRequest {
  key: string;
  time: number;
}

export interface PluginVideoFrameSuccess {
  key: string;
  requestedTime: number;
  actualTime: number;
  frameDuration: number;
  width: number;
  height: number;
  mediaType: 'image/jpeg';
  previewDataUrl: string;
  bytes?: Uint8Array;
}

export interface PluginVideoFrameFailure {
  key: string;
  requestedTime: number;
  error: string;
}

export type PluginVideoFrameResult = PluginVideoFrameSuccess | PluginVideoFrameFailure;

export interface PluginVideoFrameBatch {
  video: {
    duration: number;
    width: number;
    height: number;
    videoCodec: string | null;
  };
  frames: PluginVideoFrameResult[];
  contactSheet?: {
    mediaType: 'image/jpeg';
    width: number;
    height: number;
    bytes: Uint8Array;
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('抽帧已取消');
}

export function buildUniformFrameRequests(
  duration: number,
  count: number,
): PluginVideoFrameSampleRequest[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长无效');
  if (!Number.isInteger(count) || count < 1 || count > PREVIEW_COUNT_MAX) {
    throw new Error(`预览帧数量必须在 1-${PREVIEW_COUNT_MAX} 之间`);
  }
  return Array.from({ length: count }, (_, index) => ({
    key: `preview-${index + 1}`,
    time: (duration * index) / count,
  }));
}

export function validateAnalysisFrameRequests(
  samples: readonly PluginVideoFrameSampleRequest[],
  duration: number,
): PluginVideoFrameSampleRequest[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长无效');
  if (samples.length < 1 || samples.length > ANALYSIS_COUNT_MAX) {
    throw new Error(`分析帧数量必须在 1-${ANALYSIS_COUNT_MAX} 之间`);
  }
  const keys = new Set<string>();
  return samples.map((sample, index) => {
    if (!SAMPLE_KEY_RE.test(sample.key) || keys.has(sample.key)) throw new Error('抽帧 key 无效或重复');
    if (!Number.isFinite(sample.time) || sample.time < 0 || sample.time > duration) {
      throw new Error('抽帧时间点超出视频范围');
    }
    if (index > 0 && sample.time <= samples[index - 1].time) {
      throw new Error('分析帧时间点必须严格递增');
    }
    keys.add(sample.key);
    return { key: sample.key, time: sample.time };
  });
}

function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

async function canvasToJpegBytes(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number,
): Promise<Uint8Array> {
  let blob: Blob | null;
  if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  } else {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality });
  }
  if (!blob) throw new Error('视频帧 JPEG 编码失败');
  return new Uint8Array(await blob.arrayBuffer());
}

function createScaledCanvas(
  source: HTMLCanvasElement | OffscreenCanvas,
  targetHeight: number,
): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('当前环境不能创建视频帧画布');
  const height = Math.max(1, Math.min(targetHeight, source.height));
  const width = Math.max(1, Math.round(source.width * (height / source.height)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境不能绘制视频帧');
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

async function createPreviewDataUrl(
  source: HTMLCanvasElement | OffscreenCanvas,
): Promise<string> {
  for (const [height, quality] of [[PREVIEW_HEIGHT, 0.7], [96, 0.62], [72, 0.54]] as const) {
    const bytes = await canvasToJpegBytes(createScaledCanvas(source, height), quality);
    if (bytes.byteLength <= PREVIEW_MAX_BYTES) return bytesToDataUrl(bytes, 'image/jpeg');
  }
  throw new Error('视频帧预览图超过大小上限');
}

function formatTimecode(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

async function createContactSheet(
  entries: Array<{ request: PluginVideoFrameSampleRequest; frame: VideoFrameCanvasSample }>,
): Promise<PluginVideoFrameBatch['contactSheet']> {
  if (entries.length === 0) return undefined;
  if (typeof document === 'undefined') throw new Error('当前环境不能创建联系表');
  const columns = Math.min(4, entries.length);
  const rows = Math.ceil(entries.length / columns);
  const cellWidth = 360;
  const imageHeight = 203;
  const labelHeight = 30;
  const gap = 8;
  const canvas = document.createElement('canvas');
  canvas.width = columns * cellWidth + Math.max(0, columns - 1) * gap;
  canvas.height = rows * (imageHeight + labelHeight) + Math.max(0, rows - 1) * gap;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境不能绘制联系表');
  context.fillStyle = '#0a0a0f';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '600 16px system-ui, sans-serif';
  context.textBaseline = 'middle';

  entries.forEach(({ request, frame }, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * (cellWidth + gap);
    const y = row * (imageHeight + labelHeight + gap);
    const scale = Math.min(cellWidth / frame.canvas.width, imageHeight / frame.canvas.height);
    const width = Math.max(1, Math.round(frame.canvas.width * scale));
    const height = Math.max(1, Math.round(frame.canvas.height * scale));
    const offsetX = x + Math.round((cellWidth - width) / 2);
    const offsetY = y + Math.round((imageHeight - height) / 2);
    context.drawImage(frame.canvas, offsetX, offsetY, width, height);
    context.fillStyle = '#14141c';
    context.fillRect(x, y + imageHeight, cellWidth, labelHeight);
    context.fillStyle = '#e8e8ed';
    context.fillText(`${request.key}  ${formatTimecode(frame.actualTime)}`, x + 10, y + imageHeight + labelHeight / 2);
  });

  const bytes = await canvasToJpegBytes(canvas, 0.84);
  if (bytes.byteLength > FRAME_MAX_BYTES) throw new Error('联系表超过 4 MiB 上限，请减少分析帧数');
  return { mediaType: 'image/jpeg', width: canvas.width, height: canvas.height, bytes };
}

export async function extractPluginVideoFrames(options: {
  url: string;
  mode: 'preview' | 'analysis';
  count?: number;
  samples?: readonly PluginVideoFrameSampleRequest[];
  signal?: AbortSignal;
}): Promise<PluginVideoFrameBatch> {
  assertNotAborted(options.signal);
  const input = await createVideoInput(options.url);
  try {
    const probe = await probeVideoSource(input);
    if (!probe.decodable || probe.duration <= 0) throw new Error('视频轨无法解码或时长无效');
    const requests = options.mode === 'preview'
      ? buildUniformFrameRequests(probe.duration, options.count ?? 12)
      : validateAnalysisFrameRequests(options.samples ?? [], probe.duration);
    const lastSafeTime = Math.max(0, probe.duration - Math.min(0.001, probe.duration / 1000));
    const decodeTimes = requests.map((sample) => Math.min(sample.time, lastSafeTime));
    const decoded = await extractFramesAtTimestamps(input, {
      timestamps: decodeTimes,
      height: options.mode === 'preview' ? PREVIEW_HEIGHT : ANALYSIS_HEIGHT,
      signal: options.signal,
    });
    assertNotAborted(options.signal);

    const successfulForSheet: Array<{ request: PluginVideoFrameSampleRequest; frame: VideoFrameCanvasSample }> = [];
    const frames: PluginVideoFrameResult[] = [];
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const frame = decoded[index];
      if (!frame) {
        frames.push({ key: request.key, requestedTime: request.time, error: '该时间点没有可解码画面' });
        continue;
      }
      try {
        const previewDataUrl = await createPreviewDataUrl(frame.canvas);
        const bytes = options.mode === 'analysis'
          ? await canvasToJpegBytes(frame.canvas, 0.88)
          : undefined;
        if (bytes && bytes.byteLength > FRAME_MAX_BYTES) throw new Error('视频帧超过 4 MiB 上限');
        if (bytes) successfulForSheet.push({ request, frame });
        frames.push({
          key: request.key,
          requestedTime: request.time,
          actualTime: frame.actualTime,
          frameDuration: frame.duration,
          width: frame.width,
          height: frame.height,
          mediaType: 'image/jpeg',
          previewDataUrl,
          bytes,
        });
      } catch (error) {
        frames.push({
          key: request.key,
          requestedTime: request.time,
          error: error instanceof Error ? error.message : '视频帧编码失败',
        });
      }
      assertNotAborted(options.signal);
    }

    return {
      video: {
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        videoCodec: probe.videoCodec,
      },
      frames,
      contactSheet: options.mode === 'analysis'
        ? await createContactSheet(successfulForSheet)
        : undefined,
    };
  } finally {
    input.dispose();
  }
}
