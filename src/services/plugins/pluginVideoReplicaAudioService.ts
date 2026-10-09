/** 视频复刻的宿主音频准备。路径只用于本地主窗口，不进入插件 UI 或任务摘要。 */
import { AudioBufferSink } from 'mediabunny';
import { useAppStore } from '../../store/useAppStore';
import { generateId } from '../../store/store.utils';
import { pcmS16LeToWav } from '../ai/modelProtocolHttp';
import { saveBinaryToProjectData } from '../fileService';
import { ASR_MODEL, ASR_VOCAB, checkModelExists, downloadModel, speechToText } from '../onnxService';
import { bindVideoEditorMedia } from '../videoEditorControlService';
import { controlledClipUrl } from '../videoEditorInspectionService';
import { createVideoInput } from '../videoEditorMediaService';

const SAMPLE_RATE = 16_000;
const SEGMENT_SECONDS_MAX = 30;

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('音频处理已取消', 'AbortError');
}

export async function inspectReplicaSpeechModels(): Promise<{ ready: boolean }> {
  const files = await Promise.all([checkModelExists(ASR_MODEL), checkModelExists(ASR_VOCAB)]);
  return { ready: files.every(Boolean) };
}

/** 仅在用户显式选择准备语音模型后调用；下载沿用固定注册表与可取消传输。 */
export async function prepareReplicaSpeechModels(signal?: AbortSignal): Promise<void> {
  try {
    for (const model of [ASR_MODEL, ASR_VOCAB]) {
      assertNotAborted(signal);
      await downloadModel(model, { signal });
      assertNotAborted(signal);
    }
  } catch {
    assertNotAborted(signal);
    throw new Error('本地语音模型准备失败，请检查模型下载连接');
  }
}

export async function extractReplicaSegmentAudio(options: {
  projectId: string;
  nodeId: string;
  start: number;
  end: number;
  referenceDuration?: number;
  signal?: AbortSignal;
  assertFresh: () => void;
}): Promise<{ filePath: string; assetUrl: string; fileName: string; duration: number } | null> {
  const { start, end } = options;
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end - start > SEGMENT_SECONDS_MAX) {
    throw new Error('音频提取区间必须在 0 至 30 秒的有效分段内');
  }
  const referenceDuration = options.referenceDuration ?? end - start;
  if (!Number.isFinite(referenceDuration) || referenceDuration < end - start || referenceDuration > SEGMENT_SECONDS_MAX) {
    throw new Error('参考音频时长必须覆盖源区间且不超过 30 秒');
  }
  const check = () => {
    assertNotAborted(options.signal);
    options.assertFresh();
    if (useAppStore.getState().currentProjectId !== options.projectId) throw new Error('音频处理项目已变化');
  };
  check();
  const source = bindVideoEditorMedia(options.nodeId, 'video');
  const checkSource = () => {
    check();
    if (JSON.stringify(bindVideoEditorMedia(options.nodeId, 'video')) !== JSON.stringify(source)) {
      throw new Error('音频来源已变化，请重新开始复刻');
    }
  };
  let input: Awaited<ReturnType<typeof createVideoInput>> | undefined;
  try {
    input = await createVideoInput(controlledClipUrl(source));
    checkSource();
    const duration = await input.computeDuration();
    checkSource();
    if (!Number.isFinite(duration) || end > duration + 1 / SAMPLE_RATE) throw new Error('音频分段超出源视频时长');
    const track = await input.getPrimaryAudioTrack();
    checkSource();
    if (!track) return null;
    if (!(await track.canDecode())) throw new Error('decode');
    checkSource();

    // 精确裁到分段采样边界；单声道 16 kHz WAV 每段最多约 960 KiB。
    const sourceSampleCount = Math.max(1, Math.round((end - start) * SAMPLE_RATE));
    const sampleCount = Math.max(sourceSampleCount, Math.round(referenceDuration * SAMPLE_RATE));
    const samples = new Float32Array(sampleCount);
    const sink = new AudioBufferSink(track);
    let decodedSamples = 0;
    let chunkCount = 0;
    for await (const wrapped of sink.buffers(start, end)) {
      checkSource();
      const buffer = wrapped.buffer;
      if (!Number.isFinite(wrapped.timestamp) || !Number.isFinite(buffer.sampleRate)
        || buffer.sampleRate < 8_000 || buffer.sampleRate > 192_000
        || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 32
        || buffer.length < 1 || buffer.duration > SEGMENT_SECONDS_MAX + 2 || ++chunkCount > 4_800) {
        throw new Error('decode');
      }
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
      const first = Math.max(0, Math.ceil((wrapped.timestamp - start) * SAMPLE_RATE - 0.000001));
      const last = Math.min(sourceSampleCount, Math.ceil((wrapped.timestamp + buffer.duration - start) * SAMPLE_RATE - 0.000001));
      for (let index = first; index < last; index += 1) {
        const position = (start + index / SAMPLE_RATE - wrapped.timestamp) * buffer.sampleRate;
        const left = Math.max(0, Math.min(buffer.length - 1, Math.floor(position)));
        const right = Math.min(buffer.length - 1, left + 1);
        const fraction = Math.max(0, Math.min(1, position - left));
        let value = 0;
        for (const channel of channels) value += channel[left] * (1 - fraction) + channel[right] * fraction;
        value /= channels.length;
        if (!Number.isFinite(value)) throw new Error('decode');
        samples[index] = Math.max(-1, Math.min(1, value));
        decodedSamples += 1;
      }
      if (decodedSamples > sourceSampleCount * 3) throw new Error('decode');
    }
    checkSource();
    if (!decodedSamples) throw new Error('decode');
    const pcm = new Uint8Array(sampleCount * 2);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < sampleCount; index += 1) {
      const value = samples[index];
      view.setInt16(index * 2, Math.round(value < 0 ? value * 32_768 : value * 32_767), true);
    }
    const fileName = `replica-audio-${generateId()}.wav`;
    checkSource();
    const saved = await saveBinaryToProjectData(pcmS16LeToWav(pcm, SAMPLE_RATE, 1), options.projectId, fileName, { throwOnError: true });
    checkSource();
    if (!saved?.filePath || !saved.assetUrl) throw new Error('save');
    return { ...saved, fileName, duration: sampleCount / SAMPLE_RATE };
  } catch {
    checkSource();
    // 解码/文件异常可能含来源地址，调用方只拿固定脱敏错误。
    throw new Error('分段音频提取失败，请检查音轨可解码性和项目存储授权');
  } finally {
    input?.dispose();
  }
}

export async function transcribeReplicaSegmentAudio(audio: { filePath: string }, options: {
  signal?: AbortSignal;
  assertFresh: () => void;
}): Promise<string> {
  const check = () => { assertNotAborted(options.signal); options.assertFresh(); };
  check();
  const models = await inspectReplicaSpeechModels();
  check();
  if (!models.ready) throw new Error('本地语音模型尚未准备，请先选择下载语音模型');
  try {
    // 原生识别尚无取消 IPC：结束后再检查信号，取消结果不会继续进入生成流程。
    const result = await speechToText(audio.filePath, ASR_MODEL, ASR_VOCAB, `replica-asr-${generateId()}`);
    check();
    if (typeof result.text !== 'string' || result.text.length > 8_000) throw new Error('text');
    return result.text.trim();
  } catch {
    check();
    throw new Error('本地对白识别失败，请检查语音模型和分段音频');
  }
}
