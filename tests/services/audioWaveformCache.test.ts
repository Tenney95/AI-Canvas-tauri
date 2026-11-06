/** 音频波形的共享工作、独立取消与完成缓存。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>(), nativeFetch: vi.fn<typeof fetch>(),
  decode: vi.fn<(data: ArrayBuffer) => Promise<AudioBuffer>>() }));
vi.mock('../../src/services/comfyMediaSource', () => ({ shouldLoadNativeComfyMedia: (source: string) => source.startsWith('comfy:') }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.nativeFetch }));
let acquire: typeof import('../../src/components/nodes/shared/audio/audioWaveformCache').acquireAudioWaveform;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function buffer(duration = 3.5): AudioBuffer {
  return { duration, getChannelData: () => Float32Array.from({ length: 440 }, (_, index) => index === 0 ? -0.5 : index === 1 ? 0.75 : 0) } as unknown as AudioBuffer;
}
const response = () => new Response(new Uint8Array([1, 2, 3]));
async function settle() { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }
const signal = () => new AbortController().signal;
beforeEach(async () => {
  vi.resetModules();
  mocks.fetch.mockReset().mockImplementation(async () => response());
  mocks.nativeFetch.mockReset().mockImplementation(async () => response());
  mocks.decode.mockReset().mockResolvedValue(buffer());
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = mocks.decode; });
  acquire = (await import('../../src/components/nodes/shared/audio/audioWaveformCache')).acquireAudioWaveform;
});

describe('audio waveform cache', () => {
  it('shares one job per URL, isolates consumer cancellation and serializes different sources through decoding', async () => {
    const decode = deferred<AudioBuffer>();
    mocks.decode.mockReturnValueOnce(decode.promise);
    const first = new AbortController();
    const cancelled = acquire('audio-a', first.signal).catch((error: unknown) => error);
    const shared = acquire('audio-a', signal());
    const next = acquire('audio-b', signal());
    await settle();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.decode).toHaveBeenCalledOnce();
    first.abort();
    expect((mocks.fetch.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(false);
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    decode.resolve(buffer());
    const waveform = await shared;
    await next;
    expect(waveform.peaks).toHaveLength(220);
    expect(waveform.peaks[0]).toBe(0.75);
    expect(await acquire('audio-a', signal())).toBe(waveform);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.decode).toHaveBeenCalledTimes(2);
  });

  it('removes unneeded queued work and aborts an unshared fetch before starting the next job', async () => {
    mocks.fetch.mockImplementationOnce((_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const first = new AbortController();
    const queued = new AbortController();
    const stopped = acquire('fetching', first.signal).catch((error: unknown) => error);
    const skipped = acquire('unneeded', queued.signal).catch((error: unknown) => error);
    queued.abort(); first.abort();
    const next = acquire('next', signal());
    expect(await skipped).toMatchObject({ name: 'AbortError' });
    expect(await stopped).toMatchObject({ name: 'AbortError' });
    await next;
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual(['fetching', 'next']);
    expect(mocks.decode).toHaveBeenCalledOnce();
  });

  it('retains the slot for an uncancellable decode and queues a fresh same-source attempt behind existing work', async () => {
    const decode = deferred<AudioBuffer>();
    mocks.decode.mockReturnValueOnce(decode.promise);
    const first = new AbortController();
    const stopped = acquire('audio-a', first.signal).catch((error: unknown) => error);
    const next = acquire('audio-b', signal());
    await settle();
    first.abort();
    await stopped;
    const retry = acquire('audio-a', signal());
    await settle();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    decode.resolve(buffer(99));
    await next;
    expect((await retry).duration).toBe(3.5);
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual(['audio-a', 'audio-b', 'audio-a']);
  });

  it('does not evict an active job when more than 64 other URLs queue and limits only completed cache entries', async () => {
    const read = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(read.promise);
    const first = acquire('active', signal());
    const queued = Array.from({ length: 65 }, (_, index) => acquire(`queued-${index}`, signal()));
    const shared = acquire('active', signal());
    expect(mocks.fetch).toHaveBeenCalledOnce();
    read.resolve(response());
    const [original] = await Promise.all([first, ...queued, shared]);
    expect(await shared).toBe(original);
    expect(mocks.fetch).toHaveBeenCalledTimes(66);
    await acquire('queued-64', signal());
    expect(mocks.fetch).toHaveBeenCalledTimes(66);
    await acquire('active', signal());
    expect(mocks.fetch).toHaveBeenCalledTimes(67);
  });

  it.each(['fetch', 'decode'] as const)('allows an immediate retry from a %s failure handler without poisoning the shared registry', async (stage) => {
    if (stage === 'fetch') mocks.fetch.mockRejectedValueOnce(new Error('network unavailable'));
    else mocks.decode.mockRejectedValueOnce(new Error('invalid audio'));
    const recovered = acquire('retry', signal()).catch(() => acquire('retry', signal()));
    expect((await recovered).peaks).toHaveLength(220);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the full private Comfy source on the existing safe fetch path', async () => {
    await acquire('comfy:private-audio', signal());
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.nativeFetch).toHaveBeenCalledExactlyOnceWith('comfy:private-audio', { signal: expect.any(AbortSignal) });
  });

  it('keeps the existing file-size guard and releases the slot after rejecting an oversized response', async () => {
    const oversized = new Response(new Uint8Array([1]), { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } });
    const cancel = vi.spyOn(oversized.body!, 'cancel');
    mocks.fetch.mockResolvedValueOnce(oversized);
    await expect(acquire('oversized', signal())).rejects.toThrow('32 MiB');
    expect(cancel).toHaveBeenCalledOnce();
    await acquire('valid', signal());
    expect(mocks.decode).toHaveBeenCalledOnce();
  });
});
