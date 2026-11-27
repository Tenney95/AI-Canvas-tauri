import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildModelProtocolRequest, executeModelProtocol, pollResolvedModelProtocol, submitModelProtocol } from '../../src/services/ai/modelProtocol';
import { corsSafeFetch } from '../../src/services/ai/httpTransport';
import {
  compileMagiGatewayRequest, MAGI_VIDEO_GATEWAYS, magiGatewayCapability, magiGatewayProtocol, validateMagiGatewayTask,
} from '../../src/services/ai/providers/magiVideoGateways';
import { resolveCanonicalVideoRequest } from '../../src/services/ai/videoRequestResolver';
import { captureNativeQueryContractId, resolveNativeQueryContract } from '../../src/services/nativeProtocolRecovery';
import { nativeProtocolQueryDigest, nativeProtocolTaskIdContext } from '../../src/services/nativeModelProtocolTask';
import { resolvePoll } from '../../src/services/ai/modelProtocolPoll';
import type { MediaReference } from '../../src/types/aiTypes';

vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: vi.fn(), logAiResponse: vi.fn() }));
const [higgsfield, beatapi, nereo] = MAGI_VIDEO_GATEWAYS;
type Gateway = typeof MAGI_VIDEO_GATEWAYS[number];
const image = (role: MediaReference['role'], path: string): MediaReference =>
  ({ kind: 'image', role, origin: 'connection', url: `https://example.com/${path}` });
const first = image('first_frame', 'first.png');
const last = image('last_frame', 'last.png');
const sound: MediaReference = { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'https://example.com/sound.wav' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const download = 'https://media.example.com/video.mp4?signature=throwaway';
const key = 'test-key:certainly-not-secret';
const makeRequest = (gateway: Gateway, references: MediaReference[] = [], prompt = 'A slow camera pan') => {
  const canonical = resolveCanonicalVideoRequest({ model: 'magi-2', provider: 'general', prompt, generateAudio: false,
    seedanceDuration: 7, seedanceRatio: '9:16' }, { references, capability: magiGatewayCapability(gateway, 'magi-2') });
  const compiled = compileMagiGatewayRequest(gateway, canonical);
  return { baseUrl: gateway.origin, apiKey: key, protocol: compiled.executionProfile.protocol!, variables: compiled.variables };
};

beforeEach(() => vi.mocked(corsSafeFetch).mockReset());

describe('MAGI-2 gateway contracts', () => {
  it('selects three Higgsfield routes and uses Key authentication', () => {
    const text = buildModelProtocolRequest(makeRequest(higgsfield));
    expect(text.url).toBe('https://api.higgsfield.ai/sand/magi-2/text-to-video');
    expect(new Headers(text.init.headers).get('Authorization')).toBe(`Key ${key}`);
    const frames = buildModelProtocolRequest(makeRequest(higgsfield, [last, first], ''));
    expect(frames.url).toBe('https://api.higgsfield.ai/sand/magi-2/image-to-video');
    expect(JSON.parse(String(frames.init.body))).toEqual({
      resolution: '1080p', duration: 7, aspect_ratio: '9:16', generate_audio: false,
      image_url: first.url, end_image_url: last.url,
    });
    const reference = buildModelProtocolRequest(makeRequest(higgsfield, [sound], ''));
    expect(reference.url).toBe('https://api.higgsfield.ai/sand/magi-2/reference-to-video');
    expect(JSON.parse(String(reference.init.body))).toMatchObject({ audio_urls: [sound.url] });
  });

  it('preserves BeatAPI frame order and omits ratio for frame input', () => {
    const built = buildModelProtocolRequest({ ...makeRequest(beatapi, [last, first]), idempotencyKey: 'unique-paid-attempt' });
    expect(built.url).toBe('https://api.beatapi.io/v1/videos/tasks');
    expect(new Headers(built.init.headers).get('Idempotency-Key')).toBe('unique-paid-attempt');
    expect(JSON.parse(String(built.init.body))).toEqual({
      model: 'magi-2', prompt: 'A slow camera pan', resolution: '1080p', duration: 7,
      generate_audio: false, images: [first.url, last.url],
    });
    expect(makeRequest(beatapi, [sound]).variables.gatewayVideoBody).toMatchObject({
      reference_audios: [sound.url], aspect_ratio: '9:16',
    });
    expect(() => makeRequest(beatapi, [sound], '')).toThrow('提示词');
    expect(() => makeRequest(beatapi, [first, image('first_frame', 'duplicate.png')])).toThrow('一张首帧');
  });

  it('selects independent Nereo routes and reference fields', () => {
    const built = buildModelProtocolRequest(makeRequest(nereo, [sound]));
    expect(built.url).toBe('https://api.nereo.io/api/v1/sand/magi-2/reference-to-video');
    expect(JSON.parse(String(built.init.body))).toMatchObject({ reference_audio_urls: [sound.url] });
    expect(new Headers(built.init.headers).get('Authorization')).toBe(`Bearer ${key}`);
    expect(() => makeRequest(nereo, [{ ...sound, url: 'http://127.0.0.1/sound.wav' }])).toThrow('公开 HTTPS');
  });

  it.each([
    { gateway: higgsfield, id: '71b37e19-ccd8-4e43-b015-3644b596c348', status: 200,
      created: { request_id: '71b37e19-ccd8-4e43-b015-3644b596c348' },
      result: { request_id: '71b37e19-ccd8-4e43-b015-3644b596c348', status: 'completed', video: { url: download } } },
    { gateway: beatapi, id: 'task_7Qm2Xc9LpR4vT8sKa1Nf6YbH3eWdJ0uZ', status: 201,
      created: { data: { id: 'task_7Qm2Xc9LpR4vT8sKa1Nf6YbH3eWdJ0uZ' } },
      result: { data: { id: 'task_7Qm2Xc9LpR4vT8sKa1Nf6YbH3eWdJ0uZ', model: 'magi-2', status: 'succeeded',
        output: { media: [{ url: download }] } } } },
    { gateway: nereo, id: '7c1k2n0q8x4m3v9d5a6b', status: 200,
      created: { request_id: '7c1k2n0q8x4m3v9d5a6b' },
      result: { request_id: '7c1k2n0q8x4m3v9d5a6b', endpoint_id: 'sand/magi-2/text-to-video',
        status: 'completed', outputs: [{ url: download }] } },
  ])('submits once and polls the documented result for $gateway.name', async ({ gateway, id, status, created, result }) => {
    vi.mocked(corsSafeFetch).mockResolvedValueOnce(response({ ...created, status_url: 'https://untrusted.example/status' }, status))
      .mockResolvedValueOnce(response(result));
    await expect(executeModelProtocol(makeRequest(gateway))).resolves.toEqual({ taskId: id, urls: [download] });
    expect(corsSafeFetch).toHaveBeenCalledTimes(2);
    expect(corsSafeFetch).toHaveBeenNthCalledWith(2, `${gateway.origin}${gateway.queryPrefix}${id}${gateway.querySuffix}`,
      expect.objectContaining({ redirect: 'error', credentials: 'omit', method: 'GET' }), { sensitive: true, magiGateway: true });
    const protocol = magiGatewayProtocol(gateway, 'reference-to-video');
    const queryDigest = await nativeProtocolQueryDigest('magi-2', protocol);
    await expect(captureNativeQueryContractId(gateway.id, 'video', 'magi-2', queryDigest)).resolves.toBe(gateway.queryId);
    const frozen = await resolveNativeQueryContract(gateway.queryId, gateway.id, 'video', 'magi-2', queryDigest);
    expect(frozen?.poll).toEqual(protocol.poll);
    const customModel = 'custom-video';
    const customDigest = await nativeProtocolQueryDigest(customModel, protocol);
    await expect(captureNativeQueryContractId(gateway.id, 'video', customModel, customDigest)).resolves.toBeUndefined();
    await expect(resolveNativeQueryContract(gateway.queryId, gateway.id, 'video', customModel, customDigest)).resolves.toBeUndefined();
    expect(() => validateMagiGatewayTask(gateway, result, 'wrong-id', key)).toThrow('原任务');
    const poll = resolvePoll(gateway.origin, protocol.poll!, protocol.auth, nativeProtocolTaskIdContext(protocol, id));
    await expect(pollResolvedModelProtocol(poll, key, undefined, gateway.origin, undefined, false, 'wrong-id')).rejects.toThrow('原任务');
    expect(corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('retains an ambiguous submission after conflict or upstream failure', async () => {
    for (const status of [409, 503]) {
      vi.mocked(corsSafeFetch).mockClear().mockResolvedValueOnce(response({ secret: key }, status));
      await expect(submitModelProtocol(makeRequest(beatapi))).rejects.toMatchObject({ status, definitiveFailure: false });
      expect(corsSafeFetch).toHaveBeenCalledOnce();
    }
  });

  it('keeps the shared BeatAPI paths compatible with separately configured video models', async () => {
    const id = 'task_7Qm2Xc9LpR4vT8sKa1Nf6YbH3eWdJ0uZ';
    const protocol = magiGatewayProtocol(beatapi);
    delete protocol.poll!.magiGateway;
    protocol.submit.body = { model: 'other-video', prompt: '{{prompt}}' };
    vi.mocked(corsSafeFetch).mockResolvedValueOnce(response({ data: { id } }, 201))
      .mockResolvedValueOnce(response({ data: { id, model: 'other-video', status: 'succeeded', output: { media: [{ url: download }] } } }));
    await expect(executeModelProtocol({ ...makeRequest(beatapi), protocol, variables: { prompt: 'Scene' } }))
      .resolves.toEqual({ taskId: id, urls: [download] });
  });

  it('rejects a mismatched result and an oversized response', async () => {
    const id = '71b37e19-ccd8-4e43-b015-3644b596c348';
    expect(() => validateMagiGatewayTask(higgsfield, { request_id: id, status: 'completed',
      video: { url: 'http://localhost/result.mp4' } }, id, key)).toThrow('安全下载');
    vi.mocked(corsSafeFetch).mockResolvedValueOnce(response({ request_id: id, data: 'x'.repeat(128 * 1024) }));
    await expect(submitModelProtocol(makeRequest(higgsfield))).rejects.toThrow('安全上限');
    expect(corsSafeFetch).toHaveBeenCalledOnce();
  });
});
