import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_FORMATS, BufferSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket,
  EncodedPacketSink, Input, Mp4OutputFormat, Output,
} from 'mediabunny';

const media = vi.hoisted(() => ({ createInput: vi.fn() }));
vi.mock('../../src/services/videoEditorMediaService', () => ({ createVideoInput: media.createInput }));
import { extractVideoAudio } from '../../src/services/videoAudioExtractionService';

const inputs: Input[] = [];
function open(bytes: Uint8Array) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  inputs.push(input);
  return input;
}

function wavBytes() {
  const bytes = new Uint8Array(44 + 32);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((char, index) => { bytes[at + index] = char.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, 32, true);
  for (let i = 44; i < bytes.length; i += 2) view.setInt16(i, (i - 44) * 100, true);
  return bytes;
}

beforeEach(() => media.createInput.mockReset());
afterEach(() => { inputs.splice(0).forEach((input) => input.dispose()); });

describe('video audio extraction', () => {
  it('rewraps AAC packets unchanged as audio-only M4A without a decoder', async () => {
    // 分组夹具只验证容器搬运，不用于播放或音质验收。
    const packetData = new Uint8Array([1, 2, 3, 4]);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const source = new EncodedAudioPacketSource('aac');
    output.addAudioTrack(source);
    await output.start();
    await source.add(new EncodedPacket(packetData, 'key', 0, 1024 / 44100), {
      decoderConfig: {
        codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2,
        description: new Uint8Array([0x12, 0x10]),
      },
    });
    source.close();
    await output.finalize();
    const input = open(new Uint8Array(target.buffer!));
    const track = (await input.getPrimaryAudioTrack())!;
    const decode = vi.spyOn(track, 'canDecode').mockResolvedValue(false);
    media.createInput.mockResolvedValue(input);

    const result = await extractVideoAudio('asset://video.mp4', new AbortController().signal);
    expect(result).toMatchObject({ extension: 'm4a', mimeType: 'audio/mp4' });
    const extracted = open(result.bytes);
    expect(await extracted.getPrimaryVideoTrack()).toBeNull();
    const audio = (await extracted.getPrimaryAudioTrack())!;
    expect(await audio.getCodec()).toBe('aac');
    expect((await new EncodedPacketSink(audio).getFirstPacket())?.data).toEqual(packetData);
    expect(decode).not.toHaveBeenCalled();
  });

  it('exports PCM audio as a readable WAV with the same samples', async () => {
    const original = wavBytes();
    media.createInput.mockResolvedValue(open(original));
    const result = await extractVideoAudio('asset://video.mov', new AbortController().signal);
    expect(result).toMatchObject({ extension: 'wav', mimeType: 'audio/wav' });
    const extracted = open(result.bytes);
    const track = (await extracted.getPrimaryAudioTrack())!;
    expect(await track.getCodec()).toBe('pcm-s16');
    expect(await track.getSampleRate()).toBe(8000);
    expect((await new EncodedPacketSink(track).getFirstPacket())?.data).toEqual(original.subarray(44));
  });

  it('rejects a video with no audio and releases its input', async () => {
    const input = { getPrimaryAudioTrack: async () => null, dispose: vi.fn() };
    media.createInput.mockResolvedValue(input);
    await expect(extractVideoAudio('asset://silent.mp4', new AbortController().signal)).rejects.toThrow('没有音轨');
    expect(input.dispose).toHaveBeenCalledOnce();
  });

  it('releases the input when canceled during track discovery', async () => {
    const controller = new AbortController();
    const input = {
      getPrimaryAudioTrack: vi.fn(async () => {
        controller.abort();
        return { getCodec: async () => 'aac' };
      }),
      dispose: vi.fn(),
    };
    media.createInput.mockResolvedValue(input);
    await expect(extractVideoAudio('asset://video.mp4', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(input.dispose).toHaveBeenCalled();
  });

  it('does not open the video for an already canceled operation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractVideoAudio('asset://video.mp4', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(media.createInput).not.toHaveBeenCalled();
  });
});
