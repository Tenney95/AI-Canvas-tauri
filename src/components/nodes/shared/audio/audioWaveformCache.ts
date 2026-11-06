/** 共享音频波形：进行中请求独立于完成缓存，取消消费者不影响其他节点。 */
import { shouldLoadNativeComfyMedia } from '../../../../services/comfyMediaSource';
import { corsSafeFetch } from '../../../../services/ai/httpTransport';

export interface WaveformData {
  readonly peaks: readonly number[];
  readonly duration: number;
}

export const WAVEFORM_COLUMNS = 220;
const WAVEFORM_CACHE_LIMIT = 64;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const completed = new Map<string, WaveformData>();
const requests = new Map<string, WaveformRequest>();
let running = false;
let decodeContext: OfflineAudioContext | null = null;

interface Consumer {
  resolve: (waveform: WaveformData) => void;
  reject: (error: unknown) => void;
}
interface WaveformRequest {
  source: string;
  controller: AbortController;
  started: boolean;
  consumers: Set<Consumer>;
}

async function decodeWaveform(audioUrl: string, cancellation: AbortSignal): Promise<WaveformData> {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(15_000)]);
  // 波形需要完整文件，不能读取仅供播放器 Range 请求的分段地址。
  const response = await (shouldLoadNativeComfyMedia(audioUrl) ? corsSafeFetch : fetch)(audioUrl, { signal });
  if (!response.ok && response.status !== 0) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to load audio: ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeError('音频波形读取超过 32 MiB 限制');
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  let total = 0;
  if (reader) {
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FILE_BYTES) throw new RangeError('音频波形读取超过 32 MiB 限制');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    total = bytes.byteLength;
    if (total > MAX_FILE_BYTES) throw new RangeError('音频波形读取超过 32 MiB 限制');
    chunks.push(bytes);
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  decodeContext ??= new OfflineAudioContext(1, 1, 44_100);
  const audioBuffer = await decodeContext.decodeAudioData(bytes.buffer);
  // decodeAudioData 不能取消；等它真正结束后才能释放唯一的读取/解码槽。
  signal.throwIfAborted();
  const channelData = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.floor(channelData.length / WAVEFORM_COLUMNS));
  const peaks: number[] = [];
  for (let index = 0; index < WAVEFORM_COLUMNS; index += 1) {
    let max = 0;
    const start = index * step;
    const end = Math.min(start + step, channelData.length);
    for (let sample = start; sample < end; sample += 1) {
      const absoluteValue = Math.abs(channelData[sample]);
      if (absoluteValue > max) max = absoluteValue;
    }
    peaks.push(max);
  }
  return { peaks, duration: audioBuffer.duration };
}

function pumpWaveforms(): void {
  if (running) return;
  const request = [...requests.values()].find((entry) => !entry.started && entry.consumers.size > 0);
  if (!request) return;
  running = true;
  request.started = true;
  void decodeWaveform(request.source, request.controller.signal).then((waveform) => {
    if (!request.controller.signal.aborted && request.consumers.size > 0) {
      completed.set(request.source, waveform);
      while (completed.size > WAVEFORM_CACHE_LIMIT) completed.delete(completed.keys().next().value!);
    }
    if (requests.get(request.source) === request) requests.delete(request.source);
    for (const consumer of [...request.consumers]) consumer.resolve(waveform);
  }, (error: unknown) => {
    if (requests.get(request.source) === request) requests.delete(request.source);
    for (const consumer of [...request.consumers]) consumer.reject(error);
  }).finally(() => {
    if (requests.get(request.source) === request) requests.delete(request.source);
    running = false;
    pumpWaveforms();
  });
}

/** 每次调用是独立消费者；同 URL 共用一次排队、读取和解码。 */
export function acquireAudioWaveform(audioUrl: string, signal: AbortSignal): Promise<WaveformData> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const cached = completed.get(audioUrl);
  if (cached) {
    completed.delete(audioUrl);
    completed.set(audioUrl, cached);
    return Promise.resolve(cached);
  }
  let request = requests.get(audioUrl);
  // 已取消的原生解码仍占槽，新消费者排在其真正结束之后，不能接收旧结果。
  if (!request || request.controller.signal.aborted) {
    requests.delete(audioUrl);
    request = { source: audioUrl, controller: new AbortController(), started: false, consumers: new Set() };
    requests.set(audioUrl, request);
  }
  const entry = request;
  return new Promise<WaveformData>((resolve, reject) => {
    const finish = () => { entry.consumers.delete(consumer); signal.removeEventListener('abort', abort); };
    const consumer: Consumer = {
      resolve: (waveform) => { finish(); resolve(waveform); },
      reject: (error) => { finish(); reject(error); },
    };
    const abort = () => {
      consumer.reject(signal.reason);
      if (entry.consumers.size !== 0) return;
      entry.controller.abort(signal.reason);
      if (!entry.started && requests.get(audioUrl) === entry) requests.delete(audioUrl);
    };
    entry.consumers.add(consumer);
    signal.addEventListener('abort', abort, { once: true });
    pumpWaveforms();
  });
}
