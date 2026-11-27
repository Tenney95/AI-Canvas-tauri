import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaReference } from '../../src/types/aiTypes';
import { buildModelProtocolRequest, executeModelProtocol, submitModelProtocol } from '../../src/services/ai/modelProtocol';
import { captureNativeQueryContractId, resolveNativeQueryContract } from '../../src/services/nativeProtocolRecovery';
import { nativeProtocolQueryDigest } from '../../src/services/nativeModelProtocolTask';
import { corsSafeFetch } from '../../src/services/ai/httpTransport';
import { resolveCanonicalVideoRequest } from '../../src/services/ai/videoRequestResolver';
import {
  isSandId, mergeSandReferences, sandProtocolFor, sandSite, sandTaskRequest, sandVariables, sandVideoCapability,
  type SandVariant, SAND_ARK_TASKS_PATH, SAND_SITES, SAND_V2_TASKS_PATH, validateSandTask,
} from '../../src/services/ai/providers/sandVideoContract';

vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: vi.fn(), logAiResponse: vi.fn() }));
vi.mock('../../src/services/ai/providers/sandRateLimit', () => ({ waitForSandRequest: vi.fn() }));

const remoteId = '9223372036854775807';
const cdnUrl = 'https://cdn.example/video.mp4?signature=test';
const options = (site: (typeof SAND_SITES)[number] = SAND_SITES[0]) => ({
  protocol: sandProtocolFor(site.id), baseUrl: site.origin, apiKey: 'sand-test-key',
  variables: { duration: 5, aspectRatio: '16:9', sandContent: [{ type: 'text', text: 'Camera pans left' }] },
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const canonical = (prompt: string, references: readonly MediaReference[] = [], generateAudio?: boolean, variant: SandVariant = 'ark') =>
  resolveCanonicalVideoRequest({ model: 'magi-2', provider: 'general', prompt, generateAudio },
    { capability: sandVideoCapability(variant), references });

beforeEach(() => { vi.mocked(corsSafeFetch).mockReset(); });

describe('Sand 官方 Ark 视频合同', () => {
  it('保持同一素材的两个关键帧角色并移除同源普通引用', () => {
    const image: MediaReference = { kind: 'image', role: 'reference', origin: 'connection', url: 'asset://localhost/image.png' };
    const request = canonical('', mergeSandReferences([image, { ...image, role: 'first_frame' }, { ...image, role: 'last_frame' }]));
    const ids = new Map(request.references.all.map((reference) => [reference, remoteId]));
    expect(sandVariables(request, 'ark', ids).sandContent).toEqual([
      { type: 'image_url', role: 'first_frame', image_url: { url: `asset://${remoteId}` } },
      { type: 'image_url', role: 'last_frame', image_url: { url: `asset://${remoteId}` } },
    ]);
    expect(() => sandVariables(canonical('', [{ ...image, role: 'last_frame' }]), 'ark')).toThrow();
  });

  it('仅音频时省略空文本，静音选项保留音频参考', () => {
    const audio: MediaReference = { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'https://media.example/reference.mp3' };
    expect(sandVariables(canonical('', [audio], false), 'ark')).toMatchObject({
      generateAudio: false,
      sandContent: [{ type: 'audio_url', role: 'reference_audio', audio_url: { url: audio.url } }],
    });
    expect(() => sandVariables(canonical(' '), 'ark')).toThrow('请填写 MAGI-2 提示词');
  });

  it('仅中国站发送 watermark，两个站点均使用固定的创建路径', () => {
    for (const site of SAND_SITES) {
      const request = buildModelProtocolRequest(options(site));
      expect(request.url).toBe(`${site.origin}${SAND_ARK_TASKS_PATH}`);
      const body = JSON.parse(String(request.init.body));
      expect(body).toMatchObject({ model: 'magi-2', duration: 5, ratio: '16:9', resolution: '1080p' });
      if (site.id === 'sand-ai-cn') expect(body.watermark).toBe(false);
      else expect(body).not.toHaveProperty('watermark');
    }
  });

  it('按原 int64 字符串查询，返回 CDN 链接且不由协议执行器带 Key 下载', async () => {
    vi.mocked(corsSafeFetch).mockResolvedValueOnce(response({ id: remoteId }))
      .mockResolvedValueOnce(response({ id: remoteId, model: 'magi-2', status: 'succeeded', content: { video_url: cdnUrl } }));
    await expect(executeModelProtocol(options())).resolves.toEqual({ taskId: remoteId, urls: [cdnUrl] });
    expect(corsSafeFetch).toHaveBeenNthCalledWith(2, `${SAND_SITES[0].origin}${SAND_ARK_TASKS_PATH}/${remoteId}`,
      expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit' }), { sensitive: true });
    expect(corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('拒绝错误任务身份与溢出 ID', () => {
    expect(isSandId(remoteId)).toBe(true);
    expect(isSandId('9223372036854775808')).toBe(false);
    expect(() => validateSandTask({ id: '1', model: 'magi-2', status: 'running' }, remoteId)).toThrow('原任务');
  });

  it('创建 503 后保留提交不确定性且只请求一次', async () => {
    vi.mocked(corsSafeFetch).mockResolvedValueOnce(response({ message: 'untrusted' }, 503));
    await expect(submitModelProtocol(options())).rejects.toMatchObject({ status: 503, definitiveFailure: false });
    expect(corsSafeFetch).toHaveBeenCalledOnce();
  });
});

describe('Sand 官方原生 v2 视频合同', () => {
  it('保留媒体顺序和素材 ID 的完整精度', () => {
    const image: MediaReference = { kind: 'image', role: 'reference', origin: 'connection', url: 'asset://localhost/image.png' };
    const audio: MediaReference = { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'https://media.example/audio.wav' };
    const request = canonical('Slow pan', [audio, image], false, 'v2');
    const vars = sandVariables(request, 'v2', new Map([[request.references.images[0], remoteId]]));
    for (const site of SAND_SITES) {
      const protocol = sandProtocolFor(`${site.id}-v2`);
      const built = buildModelProtocolRequest({ ...options(site), protocol, variables: vars });
      expect(built.url).toBe(`${site.origin}${SAND_V2_TASKS_PATH}`);
      expect(JSON.parse(String(built.init.body))).toEqual({
        model: 'magi-2', parts: [
          { type: 'text', text: 'Slow pan' },
          { type: 'reference_audio', audio: { url: audio.url } },
          { type: 'reference_image', image: { assetId: remoteId } },
        ],
        duration: 5, aspectRatio: '16:9', resolution: '1080p', generateAudio: false,
        ...(site.id === 'sand-ai-cn' ? { watermark: false } : {}),
      });
    }
    expect(() => canonical(' ', [image], undefined, 'v2')).toThrow('提示词');
    expect(() => canonical('Pan', [{ ...image, role: 'first_frame' }], undefined, 'v2')).toThrow('普通参考素材');
  });

  it.each([202, 400, 503])('HTTP %i 携带 ID 时仅创建一次并查询同一任务', async (status) => {
    vi.mocked(corsSafeFetch).mockResolvedValueOnce(response(status === 202 ? { id: remoteId }
      : { code: 'internal_error', message: 'private details', details: { generation_id: remoteId } }, status))
      .mockResolvedValueOnce(response({ id: remoteId, status: 'succeeded', output: { videoUrl: cdnUrl } }));
    await expect(executeModelProtocol({ ...options(), protocol: sandProtocolFor('sand-ai-v2') }))
      .resolves.toEqual({ taskId: remoteId, urls: [cdnUrl] });
    expect(corsSafeFetch).toHaveBeenCalledTimes(2);
    expect(corsSafeFetch).toHaveBeenNthCalledWith(2, `${SAND_SITES[0].origin}${SAND_V2_TASKS_PATH}/${remoteId}`,
      expect.objectContaining({ method: 'GET', redirect: 'error' }), { sensitive: true });
  });

  it('拒绝跨协议状态、错误 ID 和查询地址变形', () => {
    expect(() => validateSandTask({ id: remoteId, status: 'processing' }, remoteId, '', 'v2')).not.toThrow();
    expect(() => validateSandTask({ id: remoteId, status: 'running' }, remoteId, '', 'v2')).toThrow();
    expect(() => validateSandTask({ id: '1', status: 'processing' }, remoteId, '', 'v2')).toThrow();
    expect(sandTaskRequest('https://api.sand.ai.example/v2/generations', 'POST')).toBeUndefined();
    expect(() => sandTaskRequest(`${SAND_SITES[0].origin}${SAND_V2_TASKS_PATH}/${remoteId}?other=1`, 'GET')).toThrow();
  });

  it('无法确认任务 ID 的 v2 创建错误保留未知状态', async () => {
    vi.mocked(corsSafeFetch).mockResolvedValueOnce(response({ details: { generation_id: 42 } }, 400));
    await expect(submitModelProtocol({ ...options(), protocol: sandProtocolFor('sand-ai-v2') }))
      .rejects.toMatchObject({ status: 400, definitiveFailure: false });
    expect(corsSafeFetch).toHaveBeenCalledOnce();
  });

  it('锁定原协议版本并保持原 Ark 查询版本 ID', async () => {
    const ark = sandSite('sand-ai')!;
    const native = sandSite('sand-ai-v2')!;
    const digest = await nativeProtocolQueryDigest('magi-2', sandProtocolFor(native.id));
    const arkDigest = await nativeProtocolQueryDigest('magi-2', sandProtocolFor(ark.id));
    await expect(captureNativeQueryContractId(ark.id, 'video', 'magi-2', arkDigest)).resolves.toBe('sand-ai-ark-v1');
    await expect(captureNativeQueryContractId(native.id, 'video', 'magi-2', digest)).resolves.toBe(native.queryId);
    await expect(resolveNativeQueryContract(native.queryId, native.id, 'video', 'magi-2', arkDigest)).resolves.toBeUndefined();
    await expect(resolveNativeQueryContract(native.queryId, ark.id, 'video', 'magi-2', digest)).resolves.toBeUndefined();
    const customModel = 'custom-video';
    const customDigest = await nativeProtocolQueryDigest(customModel, sandProtocolFor(native.id));
    await expect(captureNativeQueryContractId(native.id, 'video', customModel, customDigest)).resolves.toBeUndefined();
    await expect(resolveNativeQueryContract(native.queryId, native.id, 'video', customModel, customDigest)).resolves.toBeUndefined();
  });
});
