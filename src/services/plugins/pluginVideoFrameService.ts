/**
 * 插件视频抽帧宿主服务。
 *
 * 复用内部视频编辑器的 mediabunny 有序批量解码；这里只负责参数边界、JPEG 编码、
 * iframe 预览图与联系表，不接触插件源码、画布 Store 或本地文件路径。
 */
import {
  createVideoInput,
  extractFramesAtTimestamps,
  iterateVideoFrames,
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
  /** 边界步进可指向视频开区间末端，此时预览仍显示最后一帧。 */
  boundaryTime?: number;
}

export interface PluginVideoFrameFailure {
  key: string;
  requestedTime: number;
  error: string;
}

export type PluginVideoFrameResult = PluginVideoFrameSuccess | PluginVideoFrameFailure;

export interface PluginDetectedShot {
  inPoint: number;
  outPoint: number;
  score: number;
}

/** RGB 直方图保留颜色变化，小网格亮度差保留构图变化；输入仅为解码后的像素。 */
export function frameDifference(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  if (left.length !== right.length || left.length === 0) throw new Error('镜头检测像素尺寸不一致');
  const histLeft = new Float64Array(48);
  const histRight = new Float64Array(48);
  let spatial = 0;
  for (let i = 0; i < left.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      histLeft[channel * 16 + (left[i + channel] >> 4)] += 1;
      histRight[channel * 16 + (right[i + channel] >> 4)] += 1;
      spatial += Math.abs(left[i + channel] - right[i + channel]);
    }
  }
  const pixels = left.length / 4;
  let histogram = 0;
  for (let i = 0; i < 48; i += 1) histogram += Math.abs(histLeft[i] - histRight[i]);
  return 0.65 * histogram / (pixels * 6) + 0.35 * spatial / (pixels * 3 * 255);
}

export function validateShotDetectionRange(start: number, end: number, duration: number): void {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || end <= start || end > duration) {
    throw new Error('镜头扫描区间超出视频范围');
  }
  if (end - start > 300) throw new Error('每次自动切镜最多扫描 300 秒，请缩小区间');
}

export async function inspectPluginVideoFrame(options: {
  url: string; time: number; direction: -1 | 0 | 1; boundary?: boolean; signal?: AbortSignal;
}): Promise<PluginVideoFrameSuccess> {
  const input = await createVideoInput(options.url);
  try {
    assertNotAborted(options.signal);
    const probe = await probeVideoSource(input);
    if (!Number.isFinite(options.time) || options.time < 0 || options.time > probe.duration) throw new Error('帧时间超出视频范围');
    const read = async (time: number) => (await extractFramesAtTimestamps(input, {
      timestamps: [Math.max(0, Math.min(time, probe.duration - 0.000001))], height: 360, signal: options.signal,
    }))[0];
    let frame = await read(options.time);
    if (!frame) throw new Error('该时间点没有可解码画面');
    let boundaryTime: number | undefined;
    // 出点是开区间端点；从视频末尾后退应命中最后一帧，而非倒数第二帧。
    if (options.direction !== 0 && !(options.direction < 0 && options.time === probe.duration)) {
      const target = options.direction < 0 ? frame.actualTime - 0.000001 : frame.actualTime + frame.duration + 0.000001;
      if (options.boundary && options.direction > 0 && target >= probe.duration && options.time < probe.duration) {
        boundaryTime = probe.duration;
      } else {
        const next = await read(target);
        if (!next || (options.direction < 0 ? next.actualTime >= frame.actualTime : next.actualTime <= frame.actualTime)) {
          throw new Error(options.direction < 0 ? '已经是第一帧' : '已经是最后一帧');
        }
        frame = next;
      }
    }
    assertNotAborted(options.signal);
    return {
      key: 'cursor', requestedTime: options.time, actualTime: frame.actualTime,
      frameDuration: frame.duration, width: frame.width, height: frame.height,
      ...(options.boundary ? { boundaryTime: boundaryTime ?? frame.actualTime } : {}),
      mediaType: 'image/jpeg', previewDataUrl: await createPreviewDataUrl(frame.canvas, 360),
    };
  } finally { input.dispose(); }
}

export async function detectPluginVideoShots(options: {
  url: string; start: number; end: number; threshold?: number; minShotDuration?: number; signal?: AbortSignal;
}): Promise<{ shots: PluginDetectedShot[]; scannedFrames: number; algorithm: string }> {
  const threshold = options.threshold ?? 0.28;
  const minDuration = options.minShotDuration ?? 0.3;
  if (!Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.95
    || !Number.isFinite(minDuration) || minDuration < 0.04 || minDuration > 10) throw new Error('镜头检测参数无效');
  const input = await createVideoInput(options.url);
  try {
    assertNotAborted(options.signal);
    const probe = await probeVideoSource(input);
    validateShotDetectionRange(options.start, options.end, probe.duration);
    const cuts: Array<{ time: number; score: number }> = [{ time: options.start, score: 0 }];
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 36;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('当前环境不能检测镜头');
    let previous: Uint8ClampedArray | undefined;
    let pending: { time: number; score: number; before: Uint8ClampedArray } | undefined;
    let baseline = 0;
    let scannedFrames = 0;
    const started = Date.now();
    for await (const frame of iterateVideoFrames(input, { start: options.start, end: options.end, height: 36, signal: options.signal })) {
      if (++scannedFrames > 36_000 || Date.now() - started > 120_000) throw new Error('镜头扫描达到处理上限，请缩小区间');
      context.drawImage(frame.canvas, 0, 0, 64, 36);
      const pixels = context.getImageData(0, 0, 64, 36).data;
      let confirmed = false;
      let suppressedFlash = false;
      if (pending) {
        // 下一帧回到切换前画面时抑制闪光的正反两个边沿，避免重复误切。
        if (frameDifference(pending.before, pixels) >= threshold * 0.65) {
          cuts.push({ time: pending.time, score: pending.score });
          if (cuts.length > 128) throw new Error('检测到超过 128 个镜头，请缩小区间或降低灵敏度');
          confirmed = true;
        } else {
          suppressedFlash = true;
        }
        pending = undefined;
      }
      if (previous) {
        const difference = frameDifference(previous, pixels);
        const adaptive = Math.max(threshold, baseline * 2.5);
        if (!confirmed && !suppressedFlash && difference >= adaptive && frame.actualTime - cuts[cuts.length - 1].time >= minDuration
          && options.end - frame.actualTime >= minDuration) {
          pending = { time: frame.actualTime, score: difference, before: previous };
        }
        baseline = baseline * 0.9 + Math.min(difference, threshold) * 0.1;
      }
      previous = pixels;
    }
    assertNotAborted(options.signal);
    if (!scannedFrames) throw new Error('扫描区间没有可解码画面');
    return {
      shots: cuts.map((cut, index) => ({ inPoint: cut.time, outPoint: cuts[index + 1]?.time ?? options.end, score: cut.score })),
      scannedFrames, algorithm: 'adaptive-frame-difference',
    };
  } finally { input.dispose(); }
}

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
  targetHeight = PREVIEW_HEIGHT,
): Promise<string> {
  for (const [height, quality] of [[targetHeight, 0.7], [Math.max(72, Math.round(targetHeight * 0.8)), 0.62], [72, 0.54]] as const) {
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
