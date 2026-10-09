import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: { currentProjectId: 'p' },
  source: { nodeId: 'video', filePath: 'private-source.mp4', sourceUrl: 'asset://source', fileName: 'video' },
  checkModel: vi.fn(), download: vi.fn(), transcribe: vi.fn(), save: vi.fn(), input: vi.fn(),
  dispose: vi.fn(), canDecode: vi.fn(), audioTrack: vi.fn(), buffers: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.store } }));
vi.mock('../../src/store/store.utils', () => ({ generateId: () => 'fixed-id' }));
vi.mock('../../src/services/onnxService', () => ({
  ASR_MODEL: 'sensevoice-small-int8.onnx', ASR_VOCAB: 'sensevoice-vocab.txt',
  checkModelExists: mocks.checkModel, downloadModel: mocks.download, speechToText: mocks.transcribe,
}));
vi.mock('../../src/services/fileService', () => ({ saveBinaryToProjectData: mocks.save }));
vi.mock('../../src/services/videoEditorControlService', () => ({ bindVideoEditorMedia: () => ({ ...mocks.source }) }));
vi.mock('../../src/services/videoEditorInspectionService', () => ({ controlledClipUrl: () => 'asset://source' }));
vi.mock('../../src/services/videoEditorMediaService', () => ({ createVideoInput: mocks.input }));
vi.mock('mediabunny', () => ({ AudioBufferSink: class { buffers = mocks.buffers; } }));

import { extractReplicaSegmentAudio, inspectReplicaSpeechModels, prepareReplicaSpeechModels,
  transcribeReplicaSegmentAudio } from '../../src/services/plugins/pluginVideoReplicaAudioService';

function chunk(timestamp: number, channels: number[][], sampleRate = 16_000) {
  return { timestamp, buffer: { sampleRate, numberOfChannels: channels.length, length: channels[0].length,
    duration: channels[0].length / sampleRate, getChannelData: (index: number) => Float32Array.from(channels[index]) } };
}
function decodeChunks(chunks: ReturnType<typeof chunk>[]) {
  mocks.buffers.mockImplementation(async function* () { yield* chunks; });
}
const options = () => ({ projectId: 'p', nodeId: 'video', start: 0, end: 0.001, assertFresh: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.currentProjectId = 'p'; mocks.source.filePath = 'private-source.mp4';
  mocks.canDecode.mockResolvedValue(true); mocks.audioTrack.mockResolvedValue({ canDecode: mocks.canDecode });
  mocks.input.mockResolvedValue({ dispose: mocks.dispose, computeDuration: async () => 60, getPrimaryAudioTrack: mocks.audioTrack });
  mocks.save.mockResolvedValue({ filePath: 'private-output.wav', assetUrl: 'asset://audio' });
  mocks.checkModel.mockResolvedValue('private-model-path'); mocks.download.mockResolvedValue({});
  mocks.transcribe.mockResolvedValue({ text: '  原片对白  ', duration_seconds: 0.001 });
  decodeChunks([chunk(0, [Array(16).fill(0.5)])]);
});

describe('视频复刻分段音频', () => {
  it('crops exact sample boundaries and downmixes stereo to a bounded 16 kHz PCM WAV', async () => {
    decodeChunks([chunk(0, [[-1, -0.5, 0, 0.5, 1], [1, 0.5, 0.5, 1, -1]])]);
    const result = await extractReplicaSegmentAudio({ ...options(), start: 2 / 16_000, end: 4 / 16_000 });
    const bytes = mocks.save.mock.calls[0][0] as Uint8Array;
    expect(bytes.byteLength).toBe(48);
    const wav = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(wav.getUint32(24, true)).toBe(16_000); expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getInt16(44, true)).toBe(8_192); expect(wav.getInt16(46, true)).toBe(24_575);
    expect(result?.duration).toBe(2 / 16_000); expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.save.mock.calls[0][3]).toEqual({ throwOnError: true });
  });
  it('resamples the requested source time instead of leaking samples before or after the cut', async () => {
    decodeChunks([chunk(0, [[0, 1, 0, -1]], 8_000)]);
    await extractReplicaSegmentAudio({ ...options(), start: 1 / 16_000, end: 5 / 16_000 });
    const bytes = mocks.save.mock.calls[0][0] as Uint8Array;
    const wav = new DataView(bytes.buffer);
    expect([0, 1, 2, 3].map((index) => wav.getInt16(44 + index * 2, true))).toEqual([16_384, 32_767, 16_384, 0]);
    expect(mocks.buffers).toHaveBeenCalledWith(1 / 16_000, 5 / 16_000);
  });
  it('pads a short audio reference with silence without reading outside the source cut', async () => {
    decodeChunks([chunk(0, [Array(32).fill(0.5)])]);
    const result = await extractReplicaSegmentAudio({ ...options(), referenceDuration: 0.002 });
    const bytes = mocks.save.mock.calls[0][0] as Uint8Array;
    const wav = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(44 + 32 * 2); expect(result?.duration).toBe(0.002);
    expect(wav.getInt16(44 + 15 * 2, true)).toBe(16_384);
    expect(wav.getInt16(44 + 16 * 2, true)).toBe(0);
    expect(wav.getInt16(44 + 31 * 2, true)).toBe(0);
    expect(mocks.buffers).toHaveBeenCalledWith(0, 0.001);
  });
  it.each([0.0005, 30.01, NaN])('rejects invalid audio reference padding duration %s', async (referenceDuration) => {
    await expect(extractReplicaSegmentAudio({ ...options(), referenceDuration })).rejects.toThrow('参考音频时长');
    expect(mocks.input).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('returns null only when no audio track exists, without creating an empty asset', async () => {
    mocks.audioTrack.mockResolvedValue(null);
    expect(await extractReplicaSegmentAudio(options())).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it.each(['codec', 'empty', 'exception'])('fails explicitly for %s decode failures with a fixed safe message', async (mode) => {
    if (mode === 'codec') mocks.canDecode.mockResolvedValue(false);
    if (mode === 'empty') decodeChunks([]);
    if (mode === 'exception') mocks.buffers.mockImplementation(async function* () {
      yield chunk(0, [Array(16).fill(0.5)]);
      throw new Error('G:/secret/source.mp4 token');
    });
    await expect(extractReplicaSegmentAudio(options())).rejects.toThrow('分段音频提取失败');
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it.each([{ start: 0, end: 30.1 }, { start: -1, end: 1 }, { start: 1, end: 1 }, { start: 0, end: NaN }])(
    'rejects invalid ranges before reading or allocating', async (range) => {
      await expect(extractReplicaSegmentAudio({ ...options(), ...range })).rejects.toThrow('区间');
      expect(mocks.input).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    });
  it('detects a source revision or project change before saving', async () => {
    mocks.buffers.mockImplementation(async function* () {
      yield chunk(0, [Array(16).fill(0.5)]); mocks.source.filePath = 'changed.mp4';
    });
    await expect(extractReplicaSegmentAudio(options())).rejects.toThrow('来源已变化');
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.source.filePath = 'private-source.mp4';
    mocks.store.currentProjectId = 'other';
    await expect(extractReplicaSegmentAudio(options())).rejects.toThrow('项目已变化');
  });
  it('checks cancellation between decoder chunks and does not save cancelled audio', async () => {
    const controller = new AbortController();
    mocks.buffers.mockImplementation(async function* () { controller.abort(); yield chunk(0, [Array(16).fill(0.5)]); });
    await expect(extractReplicaSegmentAudio({ ...options(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

describe('视频复刻本地对白识别', () => {
  it('inspects both fixed files and downloads only through explicit preparation', async () => {
    mocks.checkModel.mockResolvedValueOnce(null).mockResolvedValueOnce('vocab');
    expect(await inspectReplicaSpeechModels()).toEqual({ ready: false });
    expect(mocks.download).not.toHaveBeenCalled();
    const controller = new AbortController(); await prepareReplicaSpeechModels(controller.signal);
    expect(mocks.download.mock.calls.map((call) => call[0])).toEqual(['sensevoice-small-int8.onnx', 'sensevoice-vocab.txt']);
    expect(mocks.download.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });
  it('returns transcript text without pretending to have sentence timestamps', async () => {
    const assertFresh = vi.fn();
    expect(await transcribeReplicaSegmentAudio({ filePath: 'private-output.wav' }, { assertFresh })).toBe('原片对白');
    expect(mocks.transcribe.mock.calls[0]).toEqual(['private-output.wav', 'sensevoice-small-int8.onnx', 'sensevoice-vocab.txt', 'replica-asr-fixed-id']);
    expect(mocks.download).not.toHaveBeenCalled(); expect(assertFresh).toHaveBeenCalled();
  });
  it('stops model preparation after cancellation and sanitizes download failures', async () => {
    const controller = new AbortController();
    mocks.download.mockImplementationOnce(async () => { controller.abort(); });
    await expect(prepareReplicaSpeechModels(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.download).toHaveBeenCalledOnce();
    mocks.download.mockRejectedValueOnce(new Error('G:/secret/model.onnx token'));
    await expect(prepareReplicaSpeechModels()).rejects.toThrow('本地语音模型准备失败');
  });
  it('does not implicitly download a missing recognizer', async () => {
    mocks.checkModel.mockResolvedValue(null);
    await expect(transcribeReplicaSegmentAudio({ filePath: 'private-output.wav' }, { assertFresh: vi.fn() })).rejects.toThrow('尚未准备');
    expect(mocks.transcribe).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it('discards an ASR result after cancellation while awaiting the existing native recognizer', async () => {
    const controller = new AbortController(); let resolve!: (result: { text: string }) => void;
    mocks.transcribe.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = transcribeReplicaSegmentAudio({ filePath: 'private-output.wav' }, { signal: controller.signal, assertFresh: vi.fn() });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    controller.abort(); resolve({ text: 'late' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.transcribe).toHaveBeenCalledOnce();
  });
  it('does not expose native exception paths or oversized text', async () => {
    mocks.transcribe.mockRejectedValueOnce(new Error('G:/secret/token'));
    await expect(transcribeReplicaSegmentAudio({ filePath: 'private-output.wav' }, { assertFresh: vi.fn() })).rejects.toThrow('本地对白识别失败');
    mocks.transcribe.mockResolvedValueOnce({ text: 'a'.repeat(8_001) });
    await expect(transcribeReplicaSegmentAudio({ filePath: 'private-output.wav' }, { assertFresh: vi.fn() })).rejects.toThrow('本地对白识别失败');
  });
});
