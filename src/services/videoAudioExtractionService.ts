/** 视频音轨提取：AAC 原样封装为 M4A，其他可解码音轨导出为 WAV。 */
import { Conversion, EncodedPacketSink, Output, Mp4OutputFormat, StreamTarget, WavOutputFormat, type StreamTargetChunk } from 'mediabunny';
import { t } from '../i18n';
import { createVideoInput } from './videoEditorMediaService';
import { MEDIA_DATA_URL_BYTE_LIMITS } from './mediaDataUrl';

export async function extractVideoAudio(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const input = await createVideoInput(url);
  let conversion: Conversion | undefined;
  let output: Output | undefined;
  let canceling: Promise<void> | undefined;
  const cancel = () => {
    canceling = conversion?.cancel();
    void canceling?.catch(() => undefined);
    input.dispose();
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error(t('该视频没有音轨，无法提取音频'));
    const copyAac = await track.getCodec() === 'aac';
    if (!copyAac && !(await track.canDecode())) {
      throw new Error(t('当前设备无法解码该视频的音轨'));
    }
    signal.throwIfAborted();
    const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
    if (!firstPacket?.byteLength) throw new Error(t('提取的音频为空'));
    signal.throwIfAborted();
    const chunks: StreamTargetChunk[] = [];
    let byteLength = 0;
    const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
      write(chunk) {
        const end = chunk.position + chunk.data.byteLength;
        if (end > MEDIA_DATA_URL_BYTE_LIMITS.audio) {
          throw new Error(t('提取的音频超过 32 MiB，请先裁剪视频'));
        }
        byteLength = Math.max(byteLength, end);
        chunks.push({ ...chunk, data: chunk.data.slice() });
      },
    }), { chunked: true, chunkSize: 1024 * 1024 });
    output = new Output({
      format: copyAac ? new Mp4OutputFormat() : new WavOutputFormat(),
      target,
    });
    conversion = await Conversion.init({
      input, output, tracks: 'primary',
      video: { discard: true },
      audio: { codec: copyAac ? 'aac' : 'pcm-s16' },
      // 从首个音频分组开始，负时间戳也整体平移，避免触发 AAC 重编码。
      trim: { start: firstPacket.timestamp },
      tags: {},
      showWarnings: false,
    });
    signal.throwIfAborted();
    if (!conversion.isValid || !conversion.utilizedTracks.includes(track)) {
      throw new Error(t('当前设备无法导出该视频的音轨'));
    }
    await conversion.execute();
    signal.throwIfAborted();
    if (!byteLength) throw new Error(t('提取的音频为空'));
    const bytes = new Uint8Array(byteLength);
    for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
    return {
      bytes,
      extension: copyAac ? 'm4a' : 'wav',
      mimeType: copyAac ? 'audio/mp4' : 'audio/wav',
    };
  } finally {
    signal.removeEventListener('abort', cancel);
    if (canceling) await canceling.catch(() => undefined);
    else if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined);
    }
    input.dispose();
  }
}
