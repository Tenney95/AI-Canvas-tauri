/**
 * 剪辑媒体服务 — 基于 mediabunny (MPL-2.0) 的解码、缩略图与裁剪导出
 *
 * 输入统一走 CustomSource + HTTP Range，避免把整个视频读进内存：
 * Tauri 的 asset:// 协议支持 Range（<video> 拖动进度条依赖它），
 * 不支持时在大小和共享内存预算内整包读取。
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  CustomSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  canEncodeAudio,
} from 'mediabunny';
import {
  getClipEnd,
  type VideoEditorCanvasSize,
  type VideoEditorSourceProbe,
  type VideoEditorTrack,
} from '../types/videoEditor';
import { renderFrameAt, type ClipSourceResolver } from './videoCompositor';
import { MIX_CHANNELS, MIX_SAMPLE_RATE, mixTimelineAudio, toAudioBuffers, type ClipAudioResolver } from './videoAudioMixer';
import { shouldLoadNativeComfyImage } from './comfyImageSource';
import { corsSafeFetch } from './ai/httpTransport';

/** 单次 Range 请求的上限，超出由 mediabunny 自行分片 */
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_WHOLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_WHOLE_FILE_BYTES = 128 * 1024 * 1024;
let retainedWholeFileBytes = 0;

class RangeUnsupportedError extends Error {}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  wholeFile = false,
  reserve?: (size: number) => void,
): Promise<Uint8Array> {
  const tooLarge = () => wholeFile
    ? new Error('媒体整包读取超过 64 MiB，请改用支持分片读取的媒体源')
    : new RangeUnsupportedError('媒体分片响应超过请求范围');
  const length = response.headers.get('Content-Length');
  const declaredLength = length !== null && /^\d+$/u.test(length) && Number.isSafeInteger(Number(length))
    ? Number(length) : null;
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }

  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) {
    if (wholeFile) throw new Error('当前环境无法流式读取媒体整包，请使用支持分片读取的媒体源');
    if (declaredLength === null) throw new Error('当前环境无法有界读取媒体响应，请使用支持分片读取的媒体源');
    reserve?.(declaredLength);
    const buffer = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    if (buffer.byteLength > maxBytes) throw tooLarge();
    reserve?.(buffer.byteLength);
    return buffer;
  }

  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    if (declaredLength !== null) reserve?.(declaredLength);
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) throw tooLarge();
      reserve?.(totalBytes + value.byteLength);
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }

  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchRange(url: string, start: number, end: number, signal: AbortSignal, nativeComfy: boolean): Promise<Uint8Array> {
  signal.throwIfAborted();
  const expectedLength = Math.max(0, end - start);
  if (expectedLength === 0) return new Uint8Array();
  // Range 是闭区间，mediabunny 的 end 是开区间
  const response = await (nativeComfy ? corsSafeFetch : fetch)(url, {
    headers: { Range: `bytes=${start}-${end - 1}` },
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`读取媒体分片失败：HTTP ${response.status}`);
  }
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeUnsupportedError('媒体源忽略 Range 请求');
  }
  return readBoundedBody(response, expectedLength, signal);
}

/**
 * 分片读取的自愈包装。
 *
 * 导出时 Conversion 会并发发起大量分片请求，WKWebView 的 asset:// 处理器
 * 在这种压力下会让 fetch 直接失败（WebKit 报 `TypeError: Type error`）。
 * 这里先退避重试一次，仍失败则整份下载一次并转为内存切片，
 * 让后续所有读取都不再依赖 asset:// 的并发表现。
 */
export function createResilientReader(url: string, size: number | null, ranged = true, nativeComfy = shouldLoadNativeComfyImage(url)) {
  const controller = new AbortController();
  const { signal } = controller;
  let wholeFile: Promise<Uint8Array> | null = null;
  let reservedBytes = 0;
  const release = () => {
    retainedWholeFileBytes -= reservedBytes;
    reservedBytes = 0;
  };
  const reserve = (bytes: number) => {
    signal.throwIfAborted();
    if (bytes > MAX_WHOLE_FILE_BYTES) {
      throw new Error('媒体整包读取超过 64 MiB，请改用支持分片读取的媒体源');
    }
    const next = Math.max(bytes, reservedBytes);
    if (retainedWholeFileBytes + next - reservedBytes > MAX_RETAINED_WHOLE_FILE_BYTES) {
      throw new Error('媒体整包读取已达到 128 MiB 共享预算，请关闭其他媒体后重试');
    }
    retainedWholeFileBytes += next - reservedBytes;
    reservedBytes = next;
  };

  const loadWholeFile = () => {
    signal.throwIfAborted();
    wholeFile ??= (async () => {
      try {
        if (size !== null) reserve(size);
        const response = await (nativeComfy ? corsSafeFetch : fetch)(url, { signal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`读取媒体失败：HTTP ${response.status}`);
        }
        const bytes = await readBoundedBody(response, MAX_WHOLE_FILE_BYTES, signal, true, reserve);
        if (size !== null && bytes.byteLength !== size) throw new Error('媒体大小已变化，请重新加载素材');
        return bytes;
      } catch (error) {
        release();
        throw error;
      }
    })();
    return wholeFile;
  };

  const read = async (start: number, end: number): Promise<Uint8Array> => {
    signal.throwIfAborted();
    const clampedEnd = size === null ? end : Math.min(end, size);
    if (wholeFile || !ranged) return (await loadWholeFile()).subarray(start, clampedEnd);

    try {
      return await fetchRange(url, start, clampedEnd, signal, nativeComfy);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof RangeUnsupportedError) {
        return (await loadWholeFile()).subarray(start, clampedEnd);
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 50);
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        return await fetchRange(url, start, clampedEnd, signal, nativeComfy);
      } catch (retryError) {
        signal.throwIfAborted();
        if (retryError instanceof Error && retryError.name === 'AbortError') throw retryError;
        return (await loadWholeFile()).subarray(start, clampedEnd);
      }
    }
  };
  return Object.assign(read, {
    getSize: async () => {
      signal.throwIfAborted();
      return ranged && size !== null ? size : (await loadWholeFile()).byteLength;
    },
    dispose: () => { controller.abort(); wholeFile = null; release(); },
  });
}

/** 探测 URL 是否支持 Range，并取得文件总长度 */
async function probeRangeSupport(url: string, signal: AbortSignal, nativeComfy: boolean): Promise<{ size: number; ranged: boolean } | null> {
  let response: Response | null = null;
  try {
    signal.throwIfAborted();
    response = await (nativeComfy ? corsSafeFetch : fetch)(url, { headers: { Range: 'bytes=0-0' }, signal });
    signal.throwIfAborted();
    if (!response.ok) return null;
    if (response.status === 206) {
      // Content-Range: bytes 0-0/12345
      const contentRange = response.headers.get('Content-Range');
      const total = /^bytes 0-0\/(\d+)$/iu.exec(contentRange?.trim() ?? '')?.[1];
      const size = total ? Number(total) : NaN;
      // 206 的 Content-Length 只是这个分片的长度，不能拿它当整份大小。
      return Number.isSafeInteger(size) && size > 0 ? { size, ranged: true } : null;
    }
    if (response.status !== 200) return null;
    const length = response.headers.get('Content-Length');
    const size = length ? Number(length) : NaN;
    if (Number.isSafeInteger(size) && size > 0) return { size, ranged: false };
    return null;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return null;
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

/**
 * 为媒体 URL 建立 mediabunny 输入。
 * 首次读取时才探测媒体源，让 Input.dispose 也能取消探测与整包下载。
 */
export async function createVideoInput(url: string): Promise<Input> {
  const nativeComfy = shouldLoadNativeComfyImage(url);
  const controller = new AbortController();
  let read: ReturnType<typeof createResilientReader> | null = null;
  let pendingReader: Promise<ReturnType<typeof createResilientReader>> | null = null;
  const getReader = () => {
    controller.signal.throwIfAborted();
    pendingReader ??= (async () => {
      const probe = await probeRangeSupport(url, controller.signal, nativeComfy);
      controller.signal.throwIfAborted();
      read = createResilientReader(url, probe?.size ?? null, probe?.ranged ?? false, nativeComfy);
      return read;
    })();
    return pendingReader;
  };
  return new Input({
    formats: ALL_FORMATS,
    source: new CustomSource({
      getSize: async () => (await getReader()).getSize(),
      read: async (start, end) => (await getReader())(start, Math.min(end, start + MAX_RANGE_BYTES)),
      dispose: () => { controller.abort(); read?.dispose(); pendingReader = null; read = null; },
      maxCacheSize: MAX_RANGE_BYTES,
    }),
  });
}

/** 探测时长、分辨率与编解码可用性 */
export async function probeVideoSource(input: Input): Promise<VideoEditorSourceProbe> {
  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();

  const duration = await input.computeDuration();
  const decodable = videoTrack ? await videoTrack.canDecode() : false;

  return {
    duration,
    width: videoTrack?.displayWidth ?? 0,
    height: videoTrack?.displayHeight ?? 0,
    decodable,
    videoCodec: videoTrack ? await videoTrack.getCodec() : null,
    audioCodec: audioTrack ? await audioTrack.getCodec() : null,
  };
}

export interface VideoFrameCanvasSample {
  requestedTime: number;
  actualTime: number;
  duration: number;
  width: number;
  height: number;
  canvas: HTMLCanvasElement | OffscreenCanvas;
}

/** 顺序处理小尺寸视频帧；调用方必须在下一轮前消费 canvas，不保留池中的画布。 */
export async function* iterateVideoFrames(
  input: Input,
  options: { start: number; end: number; height: number; signal?: AbortSignal },
): AsyncGenerator<VideoFrameCanvasSample> {
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) throw new Error('视频轨无法解码');
  const sink = new CanvasSink(track, { height: options.height, fit: 'contain', poolSize: 2 });
  for await (const frame of sink.canvases(options.start, options.end)) {
    if (options.signal?.aborted) throw new Error('抽帧已取消');
    yield {
      requestedTime: frame.timestamp, actualTime: frame.timestamp, duration: frame.duration,
      width: frame.canvas.width, height: frame.canvas.height, canvas: frame.canvas,
    };
  }
}

/**
 * 按显式时间点批量解码视频帧。
 *
 * 时间点必须单调递增，才能让 mediabunny 复用同一条有序解码管线；调用方用
 * requestedTime 与 WrappedCanvas.timestamp 同时记录请求位置和实际样本时间。
 */
export async function extractFramesAtTimestamps(
  input: Input,
  options: { timestamps: readonly number[]; height: number; signal?: AbortSignal },
): Promise<Array<VideoFrameCanvasSample | null>> {
  const { timestamps, height, signal } = options;
  if (!Number.isInteger(height) || height <= 0) throw new Error('抽帧高度必须是正整数');
  if (timestamps.length === 0) return [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('抽帧时间点无效');
    if (index > 0 && timestamp < timestamps[index - 1]) {
      throw new Error('批量抽帧时间点必须单调递增');
    }
  }
  if (signal?.aborted) throw new Error('抽帧已取消');

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack || !(await videoTrack.canDecode())) return timestamps.map(() => null);
  const sink = new CanvasSink(videoTrack, { height, fit: 'contain', poolSize: 0 });
  const frames: Array<VideoFrameCanvasSample | null> = [];
  let index = 0;
  for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
    if (signal?.aborted) throw new Error('抽帧已取消');
    frames.push(wrapped ? {
      requestedTime: timestamps[index],
      actualTime: wrapped.timestamp,
      duration: wrapped.duration,
      width: wrapped.canvas.width,
      height: wrapped.canvas.height,
      canvas: wrapped.canvas,
    } : null);
    index += 1;
  }
  while (frames.length < timestamps.length) frames.push(null);
  return frames;
}

/**
 * 沿时间轴均匀抽取缩略图。
 * 用 canvasesAtTimestamps 的有序批量解码，避免逐帧 seek 造成重复解包。
 */
export async function extractThumbnails(
  input: Input,
  options: { count: number; height: number; duration: number },
): Promise<string[]> {
  const { count, height, duration } = options;
  if (count <= 0 || duration <= 0) return [];
  const timestamps = Array.from(
    { length: count },
    (_, index) => (duration * index) / count,
  );
  return (await extractFramesAtTimestamps(input, { timestamps, height })).map((frame) => (
    frame?.canvas instanceof HTMLCanvasElement
      ? frame.canvas.toDataURL('image/jpeg', 0.82)
      : ''
  ));
}

/**
 * 让 `VideoEncoder.isConfigSupported` 的异常等价于「这个配置不支持」。
 *
 * mediabunny 会先试 `bitrateMode: 'quantizer'` 的候选配置，而 `'quantizer'`
 * 是 WebCodecs 后加的枚举值，WebKit 不认识它 —— 按 WebIDL 规则，字典里出现
 * 非法枚举值直接抛 TypeError（表现为 `TypeError: Type error`）。
 * mediabunny 没有接这种情况，于是整个导出崩掉，而**它后面还有一个
 * 普通 bitrate 候选本可以用**。这里把异常转成 `{supported:false}`，
 * 让它继续往下试，而不是一竿子判定本机不能编码。
 */
let encoderProbeGuarded = false;
export function guardEncoderProbe(): void {
  if (encoderProbeGuarded) return;
  encoderProbeGuarded = true;
  if (typeof VideoEncoder === 'undefined') return;

  const original = VideoEncoder.isConfigSupported.bind(VideoEncoder);
  VideoEncoder.isConfigSupported = async (config: VideoEncoderConfig) => {
    try {
      return await original(config);
    } catch (error) {
      console.warn('[videoEditor] isConfigSupported 拒绝了该配置，跳过该候选:', config, error);
      return { supported: false, config };
    }
  };
}

export class VideoExportCanceledError extends Error {
  constructor() {
    super('导出已取消');
    this.name = 'VideoExportCanceledError';
  }
}

/** 无损直通导出的结果 */
export type LosslessTrimResult = {
  bytes: Uint8Array;
  /** 与请求入点对齐的源关键帧时间 */
  actualStart: number;
  /** 是否保留源音轨；有声但无法直通时会抛错，交给合成处理 */
  audioKept: boolean;
  /** 源素材没有音轨时的说明，供调用方展示 */
  audioDropReason?: string;
};

const KEYFRAME_TIME_EPSILON = 1e-6; // 仅容许媒体时标与浮点秒数之间的换算误差。

async function readLosslessStart(sink: EncodedPacketSink, start: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new VideoExportCanceledError();
  const packet = await sink.getKeyPacket(start + KEYFRAME_TIME_EPSILON) ?? await sink.getFirstKeyPacket();
  if (signal?.aborted) throw new VideoExportCanceledError();
  if (!packet) throw new Error('视频轨没有可用的关键帧');
  if (Math.abs(packet.timestamp - start) > KEYFRAME_TIME_EPSILON) {
    throw new Error('片段入点未对齐关键帧，需要合成导出以保留裁切位置');
  }
  return packet;
}

function audioDecoderSignature(config: AudioDecoderConfig | null): string | null {
  if (!config) return null;
  const description = config.description;
  const bytes = description
    ? ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : new Uint8Array(description)
    : new Uint8Array();
  return `${config.codec}|${config.sampleRate}|${config.numberOfChannels}|${bytes.join(',')}`;
}

/**
 * 关键帧对齐的无损裁剪导出。
 * 直接搬运已编码分组并将入点平移到零点。需要解码参考帧的切点交给合成路径。
 */
export async function exportLosslessTrim(options: {
  input: Input;
  start: number;
  end: number;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}): Promise<LosslessTrimResult> {
  const { input, start, end, onProgress, signal } = options;
  if (!(end > start)) throw new Error('导出区间无效：出点必须大于入点');

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('该文件没有可导出的视频轨');

  const videoCodec = await videoTrack.getCodec();
  if (!videoCodec) throw new Error('无法识别源视频编码，改用重编码导出');

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  if (!output.format.getSupportedVideoCodecs().includes(videoCodec)) {
    throw new Error(`MP4 容器不支持源编码 ${videoCodec}，改用重编码导出`);
  }

  const videoSource = new EncodedVideoPacketSource(videoCodec);
  output.addVideoTrack(videoSource, { rotation: videoTrack.rotation });

  // 有声音就要保留；直通做不到时，让调用方改走合成。
  const audioTrack = await input.getPrimaryAudioTrack();
  const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
  if (audioTrack && (!audioCodec || !output.format.getSupportedAudioCodecs().includes(audioCodec))) {
    throw new Error('源音频无法在 MP4 中直通保留，改用合成导出');
  }
  const keepAudio = !!audioTrack && !!audioCodec;
  const audioSource = keepAudio ? new EncodedAudioPacketSource(audioCodec) : null;
  if (audioSource) output.addAudioTrack(audioSource);

  const videoSink = new EncodedPacketSink(videoTrack);
  const startPacket = await readLosslessStart(videoSink, start, signal);
  const actualStart = startPacket.timestamp;
  await output.start();

  const throwIfAborted = () => {
    if (signal?.aborted) throw new VideoExportCanceledError();
  };

  try {
    const span = Math.max(end - actualStart, Number.EPSILON);

    const videoDecoderConfig = await videoTrack.getDecoderConfig();
    let firstVideoPacket = true;
    for await (const packet of videoSink.packets(startPacket)) {
      throwIfAborted();
      if (packet.timestamp >= end) break;
      await videoSource.add(
        packet.clone({ timestamp: packet.timestamp - actualStart }),
        firstVideoPacket && videoDecoderConfig ? { decoderConfig: videoDecoderConfig } : undefined,
      );
      firstVideoPacket = false;
      onProgress?.(Math.min(1, (packet.timestamp - actualStart) / span));
    }
    videoSource.close();

    if (audioTrack && audioSource) {
      const audioSink = new EncodedPacketSink(audioTrack);
      const audioStart = (await audioSink.getPacket(actualStart)) ?? undefined;
      const audioDecoderConfig = await audioTrack.getDecoderConfig();
      let firstAudioPacket = true;
      for await (const packet of audioSink.packets(audioStart)) {
        throwIfAborted();
        if (packet.timestamp >= end) break;
        // 音频分组可能早于视频入点，平移后为负会被容器拒绝
        const shifted = packet.timestamp - actualStart;
        if (shifted < 0) continue;
        await audioSource.add(
          packet.clone({ timestamp: shifted }),
          firstAudioPacket && audioDecoderConfig
            ? { decoderConfig: audioDecoderConfig }
            : undefined,
        );
        firstAudioPacket = false;
      }
      audioSource.close();
    }

    await output.finalize();
    onProgress?.(1);

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('导出未产生有效数据');
    return {
      bytes: new Uint8Array(buffer),
      actualStart,
      audioKept: keepAudio,
      audioDropReason: keepAudio ? undefined : '素材没有音轨',
    };
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
}

/** 合成导出时音轨的处理方式 */
export type CompositeAudioMode = 'encode' | 'copy' | 'pcm' | 'none';

/**
 * 无 AudioEncoder 时用于混流输出的编码。
 *
 * mediabunny 对 PCM 走自带的软件编码器（`initPcmEncoder`），完全不碰
 * WebCodecs 的 `AudioEncoder`；MP4 也能容纳 pcm-s16（ISO/IEC 23003-5）。
 * 因此即便本机没有音频编码器，混流、音量包络、重叠音频依然可用，
 * 代价只是音轨不压缩（48kHz 立体声约 1.5 Mbps）。
 */
const PCM_FALLBACK_CODEC = 'pcm-s16' as const;

/**
 * 判断合成导出能否直通搬运音频分组。
 *
 * 先探测当前设备能否按实际参数编码 AAC；不支持时优先原样搬运：
 * 不需要混音（片段在时间上不重叠）、不改音量、且各段解码参数一致。
 */
export async function resolveCompositeAudioMode(
  tracks: VideoEditorTrack[],
  resolve: ClipAudioResolver,
): Promise<{ mode: CompositeAudioMode; reason?: string }> {
  const audible = tracks.filter((track) => !track.hidden && !track.muted);
  const clips = audible.flatMap((track) => (
    (track.volume ?? 1) === 1
      ? track.clips.filter((clip) => clip.kind !== 'image' && clip.kind !== 'text')
      : track.clips.filter((clip) => clip.kind !== 'image' && clip.kind !== 'text')
        .map((clip) => ({ ...clip, volume: -1 }))
  ));
  if (clips.length === 0) return { mode: 'none', reason: '时间轴没有音频素材' };

  const entries = await Promise.all(clips.map(async (clip) => {
    const input = resolve(clip);
    if (!input) throw new Error('未能读取片段音频，请重新加载素材后导出');
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const codec = await track.getCodec();
    if (!codec) throw new Error('当前设备无法识别素材音频编码，无法保留音轨');
    const config = await track.getDecoderConfig();
    const signature = audioDecoderSignature(config);
    return { clip, track, codec, signature };
  }));
  const audioClips = entries.filter((entry) => entry !== null)
    .sort((a, b) => a.clip.timelineStart - b.clip.timelineStart);
  if (audioClips.length === 0) return { mode: 'none', reason: '时间轴没有可用的音频轨' };

  const volumeChanged = audioClips.some(({ clip }) => (
    (clip.volume ?? 1) !== 1 || (clip.volumePoints?.length ?? 0) > 0
  ));

  const overlapping = audioClips.some(({ clip }, index) => (
    index > 0 && clip.timelineStart < getClipEnd(audioClips[index - 1].clip) - 1e-3
  ));
  const reference = audioClips[0];
  const uniform = reference.signature !== null && audioClips.every(({ codec, signature }) => (
    codec === reference.codec && signature === reference.signature
  ));
  const supported = new Mp4OutputFormat().getSupportedAudioCodecs();
  const canCopy = !volumeChanged && !overlapping && uniform && supported.includes(reference.codec);
  const canEncodeAac = await canEncodeAudio('aac', {
    sampleRate: MIX_SAMPLE_RATE, numberOfChannels: MIX_CHANNELS, bitrate: QUALITY_MEDIUM,
  }).catch(() => false);
  if (!canEncodeAac && canCopy) return { mode: 'copy' };
  const decodable = await Promise.all(audioClips.map(({ track }) => track.canDecode()));
  if (decodable.some((value) => !value)) {
    if (canCopy) return { mode: 'copy' };
    throw new Error('当前设备无法解码素材音频，无法保留混音音轨');
  }
  if (canEncodeAac) return { mode: 'encode' };

  // 直通不满足条件也不必放弃音频：PCM 编码走 mediabunny 自带的软件实现，
  // 不需要 AudioEncoder，混流与音量包络照常生效
  const reasons = [
    volumeChanged ? '需要应用音量调整' : '',
    overlapping ? '存在重叠音频需混合' : '',
    uniform ? '' : '各段音频参数不一致',
    supported.includes(reference.codec) ? '' : 'MP4 不支持原音频编码',
  ].filter(Boolean).join('、');
  return { mode: 'pcm', reason: `${reasons}，本机不支持 AAC 编码，改用未压缩 PCM 音轨` };
}

/** 把各片段的已编码音频分组按时间轴位置搬进输出，不经过编码器 */
async function copyAudioPackets(options: {
  output: Output;
  tracks: VideoEditorTrack[];
  resolve: ClipAudioResolver;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<void> {
  const { output, tracks, resolve, signal, onProgress } = options;

  const clips = tracks
    .filter((track) => !track.hidden && !track.muted)
    .flatMap((track) => track.clips.filter((clip) => clip.kind !== 'image' && clip.kind !== 'text'))
    .sort((a, b) => a.timelineStart - b.timelineStart);

  let firstTrack: Awaited<ReturnType<Input['getPrimaryAudioTrack']>> = null;
  for (const clip of clips) {
    if (signal?.aborted) throw new VideoExportCanceledError();
    const input = resolve(clip);
    firstTrack = input ? await input.getPrimaryAudioTrack() : null;
    if (firstTrack) break;
  }
  const codec = firstTrack ? await firstTrack.getCodec() : null;
  if (!firstTrack) { await output.start(); return; }
  if (!codec || !output.format.getSupportedAudioCodecs().includes(codec)) {
    throw new Error('当前输出容器无法保留素材音频编码');
  }

  const source = new EncodedAudioPacketSource(codec);
  output.addAudioTrack(source);
  await output.start();

  let firstPacket = true;
  for (const [index, clip] of clips.entries()) {
    if (signal?.aborted) throw new VideoExportCanceledError();
    const input = resolve(clip);
    const audioTrack = input ? await input.getPrimaryAudioTrack() : null;
    if (!audioTrack) continue;

    const sink = new EncodedPacketSink(audioTrack);
    const decoderConfig = await audioTrack.getDecoderConfig();
    const startPacket = (await sink.getPacket(clip.sourceIn)) ?? undefined;

    for await (const packet of sink.packets(startPacket)) {
      if (signal?.aborted) throw new VideoExportCanceledError();
      if (packet.timestamp >= clip.sourceOut) break;
      // 素材时间平移到片段在时间轴上的位置
      const shifted = clip.timelineStart + (packet.timestamp - clip.sourceIn);
      if (shifted < 0) continue;
      await source.add(
        packet.clone({ timestamp: shifted }),
        firstPacket && decoderConfig ? { decoderConfig } : undefined,
      );
      firstPacket = false;
    }
    onProgress?.((index + 1) / clips.length);
  }
  source.close();
}

/**
 * 合成导出 —— 多轨叠加 / 画中画 / 转场 / 混音都走这条路。
 *
 * 与无损直通互斥：这里逐帧渲染并重编码，因此支持任意合成，
 * 代价是慢且有一次编码损失。调用方应先用 `needsCompositing()` 判断，
 * 能直通就别进来。
 */
export async function exportComposite(options: {
  tracks: VideoEditorTrack[];
  duration: number;
  canvas: VideoEditorCanvasSize;
  frameRate: number;
  resolveVideo: ClipSourceResolver;
  resolveAudio: ClipAudioResolver;
  onProgress?: (progress: number) => void;
  onStage?: (stage: string) => void;
  /** 音频最终按什么方式处理，供调用方如实告知用户 */
  onAudioMode?: (mode: CompositeAudioMode, reason?: string) => void;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const {
    tracks, duration, canvas, frameRate,
    resolveVideo, resolveAudio, onProgress, onStage, onAudioMode, signal,
  } = options;
  if (duration <= 0) throw new Error('时间轴为空，没有可导出的内容');

  guardEncoderProbe();

  const surface = document.createElement('canvas');
  surface.width = canvas.width;
  surface.height = canvas.height;
  let pendingOutput: Output | null = null;
  try {
    const context = surface.getContext('2d', { alpha: false });
    if (!context) throw new Error('无法创建合成画布');

    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    pendingOutput = output;
    const videoSource = new CanvasSource(surface, {
      codec: 'avc',
      bitrate: QUALITY_HIGH,
    });
    output.addVideoTrack(videoSource);

    // AAC 不可用时保留原分组；需要混音则使用软件 PCM，不能静默丢音。
    const { mode: audioMode, reason: audioReason } = await resolveCompositeAudioMode(
      tracks,
      resolveAudio,
    );
    onAudioMode?.(audioMode, audioReason);

    let mixed: Awaited<ReturnType<typeof mixTimelineAudio>> = null;
    let audioSource: AudioBufferSource | null = null;

    if (audioMode === 'encode' || audioMode === 'pcm') {
      onStage?.('混合音频');
      mixed = await mixTimelineAudio({
        tracks,
        duration,
        resolve: resolveAudio,
        signal,
        onProgress: (value) => onProgress?.(value * 0.2),
      });
      if (!mixed) throw new Error('未能混合素材音频，无法保留音轨');
      audioSource = audioMode === 'pcm'
        ? new AudioBufferSource({ codec: PCM_FALLBACK_CODEC })
        : new AudioBufferSource({ codec: 'aac', bitrate: QUALITY_MEDIUM });
      output.addAudioTrack(audioSource);
    }

    // 分组直通模式由 copyAudioPackets 自己 addAudioTrack 并 start
    if (audioMode !== 'copy') await output.start();

    if (audioMode === 'copy') {
        onStage?.('搬运音频');
        await copyAudioPackets({
          output,
          tracks,
          resolve: resolveAudio,
          signal,
          onProgress: (value) => onProgress?.(value * 0.2),
        });
      }

      onStage?.('渲染画面');
      const frameCount = Math.max(1, Math.round(duration * frameRate));
      const frameDuration = 1 / frameRate;

      for (let frame = 0; frame < frameCount; frame += 1) {
        if (signal?.aborted) throw new VideoExportCanceledError();
        const time = frame * frameDuration;
        await renderFrameAt(context, canvas, tracks, time, resolveVideo);
        await videoSource.add(time, frameDuration);
        // 画面占 20%–90% 的进度区间，音频写入留在最后
        onProgress?.(0.2 + (frame / frameCount) * 0.7);
      }
      videoSource.close();

      if (audioSource && mixed) {
        onStage?.('写入音频');
        const buffers = toAudioBuffers(mixed);
        for (const [index, buffer] of buffers.entries()) {
          if (signal?.aborted) throw new VideoExportCanceledError();
          await audioSource.add(buffer);
          onProgress?.(0.9 + (index / buffers.length) * 0.1);
        }
        audioSource.close();
      }

      await output.finalize();
      pendingOutput = null;
      onProgress?.(1);

      const buffer = (output.target as BufferTarget).buffer;
      if (!buffer) throw new Error('导出未产生有效数据');
      return new Uint8Array(buffer);
  } finally {
    await pendingOutput?.cancel().catch(() => undefined);
    surface.width = 1;
    surface.height = 1;
  }
}

/** 拼接导出的输入片段 */
export type ConcatSegment = {
  input: Input;
  start: number;
  end: number;
  label: string;
};

/**
 * 多片段关键帧对齐的无损拼接导出。
 *
 * 直通复制的前提是所有片段共用同一套解码参数，因此这里要求编码与分辨率一致；
 * 不一致时明确报错，而不是产出一个播不动的文件。
 */
export async function exportLosslessConcat(options: {
  segments: ConcatSegment[];
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}): Promise<LosslessTrimResult> {
  const { onProgress, signal } = options;
  const segments: ConcatSegment[] = [];
  for (const segment of options.segments) {
    if (!(segment.end > segment.start)) throw new Error('导出区间无效：出点必须大于入点');
    const previous = segments.at(-1);
    // 仅在同一素材的切点前后完全连续时合并读取区间。时间轴上的片段保持独立。
    if (previous?.input === segment.input && previous.end === segment.start) previous.end = segment.end;
    else segments.push({ ...segment });
  }
  if (segments.length === 0) throw new Error('没有可导出的片段');
  if (segments.length === 1) {
    return exportLosslessTrim({ ...segments[0], onProgress, signal });
  }

  // 先统一校验，避免写了一半才发现拼不起来
  const tracks = await Promise.all(segments.map(async (segment) => {
    const track = await segment.input.getPrimaryVideoTrack();
    if (!track) throw new Error(`片段「${segment.label}」没有视频轨`);
    const sink = new EncodedPacketSink(track);
    const startPacket = await readLosslessStart(sink, segment.start, signal);
    return { segment, track, sink, startPacket, codec: await track.getCodec() };
  }));

  const [first, ...rest] = tracks;
  if (!first.codec) throw new Error('无法识别源视频编码，无法直通拼接');
  const mismatch = rest.find((entry) => entry.codec !== first.codec
    || entry.track.displayWidth !== first.track.displayWidth
    || entry.track.displayHeight !== first.track.displayHeight);
  if (mismatch) {
    throw new Error(
      `片段「${mismatch.segment.label}」的编码或分辨率与首个片段不一致，无法直通拼接`
      + `（${mismatch.codec ?? '未知'} ${mismatch.track.displayWidth}×${mismatch.track.displayHeight}`
      + ` vs ${first.codec} ${first.track.displayWidth}×${first.track.displayHeight}）`,
    );
  }

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  if (!output.format.getSupportedVideoCodecs().includes(first.codec)) {
    throw new Error(`MP4 容器不支持源编码 ${first.codec}`);
  }

  const videoSource = new EncodedVideoPacketSource(first.codec);
  output.addVideoTrack(videoSource, { rotation: first.track.rotation });

  // 无声片段只留空档；有声片段必须兼容，不能为了直通把声音丢掉。
  const audioTracks = await Promise.all(segments.map(async (segment) => {
    const track = await segment.input.getPrimaryAudioTrack();
    if (!track) return null;
    const config = await track.getDecoderConfig();
    return {
      track,
      codec: await track.getCodec(),
      signature: audioDecoderSignature(config),
    };
  }));

  const firstAudio = audioTracks.find((entry) => entry !== null);
  if (firstAudio && (
    !firstAudio.codec
    || !firstAudio.signature
    || !output.format.getSupportedAudioCodecs().includes(firstAudio.codec)
    || audioTracks.some((entry) => entry !== null && (
      entry.codec !== firstAudio.codec || entry.signature !== firstAudio.signature
    ))
  )) {
    throw new Error('音频编码或解码参数不支持直通，改用合成导出以保留音轨');
  }
  const audioSource = firstAudio?.codec
    ? new EncodedAudioPacketSource(firstAudio.codec)
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();

  try {
    const totalSpan = tracks.reduce(
      (sum, entry) => sum + Math.max(0, entry.segment.end - entry.segment.start),
      0,
    );
    let timelineCursor = 0;
    let firstPacket = true;
    let firstAudioPacket = true;
    for (const [index, entry] of tracks.entries()) {
      if (signal?.aborted) throw new VideoExportCanceledError();

      const decoderConfig = await entry.track.getDecoderConfig();
      const segmentBase = entry.startPacket.timestamp;

      for await (const packet of entry.sink.packets(entry.startPacket)) {
        if (signal?.aborted) throw new VideoExportCanceledError();
        if (packet.timestamp >= entry.segment.end) break;
        await videoSource.add(
          packet.clone({ timestamp: timelineCursor + (packet.timestamp - segmentBase) }),
          firstPacket && decoderConfig ? { decoderConfig } : undefined,
        );
        firstPacket = false;
        if (totalSpan > 0) {
          const done = timelineCursor + (packet.timestamp - segmentBase);
          onProgress?.(Math.min(1, done / totalSpan));
        }
      }

      // 音频与画面共用同一个 segmentBase，保证两条轨在拼接点上对齐
      const audioEntry = audioTracks[index];
      if (audioSource && audioEntry) {
        const audioSink = new EncodedPacketSink(audioEntry.track);
        const audioStart = (await audioSink.getPacket(segmentBase)) ?? undefined;
        const audioDecoderConfig = await audioEntry.track.getDecoderConfig();

        for await (const packet of audioSink.packets(audioStart)) {
          if (signal?.aborted) throw new VideoExportCanceledError();
          if (packet.timestamp >= entry.segment.end) break;
          const offset = packet.timestamp - segmentBase;
          // 后续片段也要挡住入点前的分组，免得声音跑进前面的无声片段。
          if (offset < 0) continue;
          const shifted = timelineCursor + offset;
          await audioSource.add(
            packet.clone({ timestamp: shifted }),
            firstAudioPacket && audioDecoderConfig
              ? { decoderConfig: audioDecoderConfig }
              : undefined,
          );
          firstAudioPacket = false;
        }
      }

      timelineCursor += Math.max(0, entry.segment.end - segmentBase);
    }

    videoSource.close();
    audioSource?.close();
    await output.finalize();
    onProgress?.(1);

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('导出未产生有效数据');
    return {
      bytes: new Uint8Array(buffer),
      actualStart: first.startPacket.timestamp,
      audioKept: !!audioSource,
      audioDropReason: audioSource ? undefined : '素材没有音轨',
    };
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
}
