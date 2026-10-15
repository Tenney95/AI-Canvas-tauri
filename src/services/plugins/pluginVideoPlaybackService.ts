/** 媒体 URL 留在宿主，沿用编辑器读取器；隔离插件只接收播放预览字节。 */
import { BufferTarget, Conversion, Mp4OutputFormat, Output } from 'mediabunny';
import { createVideoInput, probeVideoSource } from '../videoEditorMediaService';

export async function createPluginVideoPlayback(options: {
  url: string;
  signal?: AbortSignal;
  assertFresh: () => void;
}): Promise<{ bytes: Uint8Array; duration: number; hasAudio: boolean }> {
  let conversion: Conversion | undefined;
  let input: Awaited<ReturnType<typeof createVideoInput>> | undefined;
  let expired = false;
  const cancel = () => { void conversion?.cancel().catch(() => undefined); input?.dispose(); };
  const timeout = setTimeout(() => { expired = true; cancel(); }, 120_000);
  const check = () => {
    if (options.signal?.aborted) throw new Error('视频预览准备已取消');
    if (expired) throw new Error('视频预览准备超时，请缩短视频后重试');
    options.assertFresh();
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    check();
    input = await createVideoInput(options.url);
    check();
    const probe = await probeVideoSource(input);
    check();
    if (!Number.isFinite(probe.duration) || probe.duration <= 0 || probe.duration > 300
      || !Number.isFinite(probe.width) || !Number.isFinite(probe.height) || probe.width <= 0 || probe.height <= 0) {
      throw new Error('连续预览仅支持 300 秒以内的有效视频');
    }
    const scale = Math.min(1, 960 / Math.max(probe.width, probe.height));
    const width = Math.max(2, Math.round(probe.width * scale / 2) * 2);
    const height = Math.max(2, Math.round(probe.height * scale / 2) * 2);
    const audio = Boolean(probe.audioCodec) && typeof AudioEncoder !== 'undefined';
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target,
    });
    conversion = await Conversion.init({
      input, output, tracks: 'primary', tags: {}, showWarnings: false,
      video: { codec: 'avc', width, height, fit: 'contain', frameRate: 30,
        bitrate: 1_600_000, keyFrameInterval: 1, forceTranscode: true },
      audio: audio ? { codec: 'aac', bitrate: 64_000, numberOfChannels: 2, forceTranscode: true } : { discard: true },
    });
    check();
    const videoTrack = await input.getPrimaryVideoTrack();
    check();
    if (!conversion.isValid || !videoTrack || !conversion.utilizedTracks.includes(videoTrack)) {
      throw new Error('当前设备不能准备连续视频预览，请检查视频编码');
    }
    conversion.onProgress = check;
    await conversion.execute();
    check();
    if (!target.buffer?.byteLength) throw new Error('未能生成连续视频预览');
    return { bytes: new Uint8Array(target.buffer), duration: probe.duration,
      hasAudio: conversion.utilizedTracks.some((track) => track.isAudioTrack()) };
  } catch (error) {
    await conversion?.cancel().catch(() => undefined);
    if (options.signal?.aborted || expired) check();
    // 编解码器异常不得携带宿主媒体地址跨越插件边界。
    if (error instanceof Error && /^(连续|视频预览|当前设备|未能)/u.test(error.message)) throw error;
    throw new Error('连续视频预览准备失败，请检查本地视频编码', { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
    input?.dispose();
  }
}
