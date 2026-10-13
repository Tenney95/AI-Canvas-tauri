import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIVideoGenParams, VideoGenerationReferenceInput } from '../../src/types/aiTypes';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), savePendingTask: vi.fn(), removePendingTask: vi.fn(), cleanupNodePolling: vi.fn(() => true),
  captureVideoTaskGeneration: vi.fn(),
  pauseVideoNodeTaskOnTimeout: vi.fn((nodeId: string | undefined, error: unknown, taskId?: string) => {
    if (!nodeId || !taskId || !(error instanceof Error) || error.name !== 'ModelProtocolHttpError') return undefined;
    return Object.assign(new Error('视频查询已暂停'), { name: 'VideoPollingPausedError' });
  }),
  registerNodePolling: vi.fn(() => new AbortController().signal),
  images: vi.fn(async (urls: string[]) => urls.map((url) => url.replace('asset://', 'https://uploads.example/'))),
  media: vi.fn(async (url: string) => url.replace('asset://', 'https://uploads.example/')),
  state: { config: { providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key', baseUrl: '' } } }, currentProjectId: 'project' },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/pollManager', () => mocks);
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));
vi.mock('../../src/services/ai/imageUtils', () => ({ resolveImageUrlArray: mocks.images }));
vi.mock('../../src/services/uploadService', () => ({ resolveMediaReferenceUrl: mocks.media }));
import { grsaiMediaProviderAdapter } from '../../src/services/ai/providers/grsaiMedia';
import { getGrsaiVideoCapability, GRSAI_H3_PROTOCOL } from '../../src/services/ai/grsaiModels';
import { pollResolvedModelProtocol, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function generate(overrides: Partial<AIVideoGenParams> = {}, input: Partial<VideoGenerationReferenceInput> = {}, signal?: AbortSignal) {
  return grsaiMediaProviderAdapter.generateVideo!({
    params: { provider: 'grsai', model: 'grsai/minimax-h3', prompt: '短片', nodeId: 'node', ...overrides }, prompt: '短片', signal,
    resolveReferenceInput: async () => ({ prompt: '短片', operation: 'text-to-video', imageUrls: [], videoUrls: [], audioUrls: [], ...input }),
  });
}
beforeEach(() => { vi.clearAllMocks(); mocks.fetch.mockReset(); mocks.state.config.providers.grsai.apiKey = 'fixture-key'; mocks.state.config.providers.grsai.baseUrl = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('GRSAI H3 独立视频合同', () => {
  it('keeps the H3 query descriptor after a gateway timeout without resubmitting', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValueOnce(json({ id: 'slow-h3', status: 'running' })).mockResolvedValue(json({}, 504));
    const rejected = expect(generate()).rejects.toMatchObject({ name: 'VideoPollingPausedError' });
    await vi.runAllTimersAsync();
    await rejected;
    expect(mocks.savePendingTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'slow-h3', submitted: true }));
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('declares only GRSAI supported controls and validates the resumable protocol', () => {
    expect(validateModelExecutionProtocol(GRSAI_H3_PROTOCOL)).toEqual([]);
    expect(getGrsaiVideoCapability('grsai/minimax-h3', '1080p')).toMatchObject({ minDuration: 1, maxDuration: 10, maxImageReferences: 9, maxVideoReferences: 0, maxAudioReferences: 3 });
    expect(getGrsaiVideoCapability('minimax-h3', '768p')?.maxDuration).toBe(15);
    expect(getGrsaiVideoCapability('other')).toBeUndefined();
  });

  it.each([['480p', '16:9', 15, 'landscape'], ['768p', '9:16', 15, 'portrait'], ['1080p', '16:9', 10, 'landscape']] as const)('submits %s as async and persists a credential-free recovery descriptor', async (resolution, ratio, duration, wireRatio) => {
    mocks.fetch.mockResolvedValueOnce(json({ id: 'h3-task', status: 'running' }))
      .mockResolvedValueOnce(json({ status: 'succeeded', results: [{ url: 'https://cdn.example/video.mp4' }] }));
    await expect(generate({ seedanceResolution: resolution, seedanceRatio: ratio, seedanceDuration: duration })).resolves.toEqual({ url: 'https://cdn.example/video.mp4' });
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ model: 'minimax-h3', resolution, duration, aspectRatio: wireRatio, replyType: 'async' });
    expect(mocks.fetch.mock.calls[1][0]).toBe('https://grsai.dakka.com.cn/v1/api/result?id=h3-task');
    const saved = mocks.savePendingTask.mock.calls[0][0];
    expect(saved).toMatchObject({ taskType: 'custom-protocol', taskId: 'h3-task', providerConfigId: 'grsai' });
    expect(JSON.stringify(saved)).not.toContain('fixture-key');
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
  });

  it('keeps nine image and three audio references in order, preferring local references for upload', async () => {
    const images = Array.from({ length: 9 }, (_, i) => `asset://image-${i}.png`);
    const audios = Array.from({ length: 3 }, (_, i) => `asset://audio-${i}.mp3`);
    mocks.fetch.mockResolvedValueOnce(json({ id: 'task', status: 'running' })).mockResolvedValueOnce(json({ status: 'succeeded', results: [{ url: 'https://cdn.example/video.mp4' }] }));
    await generate({}, { operation: 'image-to-video', imageUrls: images, audioUrls: audios, references: [
      ...images.map((url) => ({ kind: 'image' as const, role: 'reference' as const, url, origin: 'prompt' as const })),
      ...audios.map((url) => ({ kind: 'audio' as const, role: 'reference_audio' as const, url, origin: 'prompt' as const })),
    ] });
    expect(mocks.images).toHaveBeenCalledWith(images, 'grsai', expect.any(AbortSignal));
    const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(body.images).toEqual(images.map((url) => url.replace('asset://', 'https://uploads.example/')));
    expect(body.audios).toEqual(audios.map((url) => url.replace('asset://', 'https://uploads.example/')));
    expect(body).not.toHaveProperty('generate_audio');
  });

  it.each([
    [{ seedanceResolution: '1080p', seedanceDuration: 11 }, {}, '1–10'],
    [{ seedanceResolution: '720p' }, {}, '分辨率'],
    [{ seedanceRatio: '1:1' }, {}, '比例'],
    [{ seedanceDuration: 1.5 }, {}, '时长'],
    [{}, { videoUrls: ['https://cdn.example/ref.mp4'] }, '参考视频'],
    [{}, { imageUrls: Array(10).fill('https://cdn.example/ref.png') }, '最多'],
    [{}, { audioUrls: Array(4).fill('https://cdn.example/ref.mp3') }, '最多'],
    [{}, { references: [{ kind: 'image', role: 'first_frame', url: 'https://cdn.example/ref.png', origin: 'prompt' }] }, '首尾帧'],
  ] as Array<[Partial<AIVideoGenParams>, Partial<VideoGenerationReferenceInput>, string]>)('rejects invalid inputs before upload or paid submission (%j)', async (params, input, message) => {
    await expect(generate(params, input)).rejects.toThrow(message);
    expect(mocks.images).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['failed', 'violation'])('propagates %s without submitting again', async (status) => {
    mocks.fetch.mockResolvedValueOnce(json({ id: 'task', status: 'running' })).mockResolvedValueOnce(json({ status, error: '供应商拒绝' }));
    await expect(generate()).rejects.toThrow('供应商拒绝');
    expect(mocks.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it.each(['failed', 'violation'])('rejects a %s submission without starting a query', async (status) => {
    mocks.fetch.mockResolvedValueOnce(json({ id: 'rejected-task', status, error: '提交被拒绝' }));
    await expect(generate()).rejects.toThrow('提交被拒绝');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.savePendingTask).not.toHaveBeenCalled();
  });

  it('does not resubmit after HTTP 504', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ error: 'gateway timeout' }, 504));
    await expect(generate()).rejects.toThrow('504');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses the saved query descriptor with the current Key and never submits during recovery', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ id: 'recover-task', status: 'running' }))
      .mockResolvedValueOnce(json({ status: 'succeeded', results: [{ url: 'https://cdn.example/video.mp4' }] }));
    await generate();
    const saved = JSON.parse(JSON.stringify(mocks.savePendingTask.mock.calls[0][0]));
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValueOnce(json({ status: 'succeeded', results: [{ url: 'https://cdn.example/recovered.mp4' }] }));
    await expect(pollResolvedModelProtocol(saved.protocolPoll, 'rotated-key', undefined, 'https://grsai.dakka.com.cn/v1'))
      .resolves.toMatchObject({ urls: ['https://cdn.example/recovered.mp4'] });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith('https://grsai.dakka.com.cn/v1/api/result?id=recover-task',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer rotated-key' } }));
  });

  it('cancels after submission without resubmission', async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementationOnce(async () => { controller.abort(); return json({ id: 'task', status: 'running' }); });
    await expect(generate({}, {}, controller.signal)).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
