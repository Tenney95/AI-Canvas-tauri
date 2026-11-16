import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiProviderConfig } from '../../src/types';
import type { VolcengineAssetCreateInput } from '../../src/types/volcengineAssetLibrary';

const mocks = vi.hoisted(() => ({ providers: {} as Record<string, ApiProviderConfig>, upload: vi.fn(), create: vi.fn(),
  sign: vi.fn(), fetch: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ config: { providers: mocks.providers } }) } }));
vi.mock('../../src/services/ai/providers/volcengineTosUpload', () => ({ uploadVolcengineTosReference: mocks.upload }));
vi.mock('../../src/services/ai/providers/volcengineAssetLibrary', () => ({ createAsset: mocks.create }));
vi.mock('../../src/services/ai/providers/volcengineSigner', () => ({ signVolcengineRequest: mocks.sign }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));

import { createVolcengineAssetViaTos } from '../../src/services/ai/providers/volcengineAssetUpload';

const signed = 'https://reference-bucket.tos-cn-beijing.volces.com/ai-canvas/ark-reference/fixture.png?X-Tos-Signature=fixture';
const options = { accessKeyId: 'library-ak', secretAccessKey: 'library-sk', projectName: 'default', region: 'cn-beijing' };
const input: VolcengineAssetCreateInput = { assetType: 'Image', groupId: 'group-one', name: '人像', url: 'asset://localhost/reference.png' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.providers = { 'my-ark': { name: '方舟', apiKey: '', catalogId: 'volcengine',
    tosUpload: { bucket: 'reference-bucket', region: 'cn-beijing', credentialRef: 'secret:provider/volcengine/tos/01234567-0123-4123-8123-0123456789ab' },
    assetLibrary: { enabled: true, projectName: 'default', region: 'cn-beijing' },
  } };
  mocks.upload.mockResolvedValue(signed);
  mocks.create.mockResolvedValue({ id: 'asset-one' });
  mocks.sign.mockResolvedValue({ headers: { Authorization: 'fixture-signed-request' } });
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ Result: { Id: 'asset-one' } })));
});

describe('方舟素材统一经 TOS 入库', () => {
  it.each([
    { assetType: 'Image', kind: 'image', url: 'asset://localhost/reference.png' },
    { assetType: 'Video', kind: 'video', url: 'https://source.example/reference.mp4' },
    { assetType: 'Audio', kind: 'audio', url: 'file:///C:/fixture/reference.wav' },
  ] as const)('$assetType 本地或外部 URL 先上传同一连接 TOS，再只用公网签名 URL 提交一次入库', async ({ assetType, kind, url }) => {
    expect(await createVolcengineAssetViaTos('my-ark', options, { ...input, assetType, url })).toEqual({ id: 'asset-one' });
    expect(mocks.upload).toHaveBeenCalledExactlyOnceWith(url, kind, mocks.providers['my-ark'].tosUpload,
      undefined, undefined, expect.any(Function), 'asset-ingestion');
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ ...options, baseUrl: 'https://ark.cn-beijing.volcengineapi.com/', beforeRequest: expect.any(Function) },
      { ...input, assetType, url: signed });
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(mocks.create.mock.invocationCallOrder[0]);
  });

  it('TOS 上传失败时不提交 CreateAsset，也不自动重投', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('火山 TOS 上传失败'));
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('TOS 上传失败');
    expect(mocks.upload).toHaveBeenCalledOnce(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it('上传期间切桶会拒绝迟到结果，不提交旧配置', async () => {
    mocks.upload.mockImplementationOnce(async () => {
      mocks.providers['my-ark'].tosUpload = { ...mocks.providers['my-ark'].tosUpload!, bucket: 'changed-bucket' };
      return signed;
    });
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('连接配置已变化');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('签名等待期间切换素材库项目会在真实 CreateAsset HTTP 提交前停止', async () => {
    const library = await vi.importActual<typeof import('../../src/services/ai/providers/volcengineAssetLibrary')>(
      '../../src/services/ai/providers/volcengineAssetLibrary',
    );
    mocks.create.mockImplementationOnce(library.createAsset);
    mocks.sign.mockImplementationOnce(async () => {
      mocks.providers['my-ark'].assetLibrary!.projectName = 'changed-project';
      return { headers: { Authorization: 'fixture-signed-request' } };
    });
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('连接配置已变化');
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.sign).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('CreateAsset 已受理时配置变化不交付旧结果，并提醒检查原素材库而非重投', async () => {
    mocks.create.mockImplementationOnce(async () => {
      mocks.providers['my-ark'].assetLibrary!.projectName = 'changed-project';
      return { id: 'accepted-under-original-project' };
    });
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('素材入库任务可能已受理，请先检查原素材库，勿直接重投');
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('CreateAsset 返回后取消不交付迟到结果，保留 AbortError 并提示可能已受理', async () => {
    const controller = new AbortController();
    mocks.create.mockImplementationOnce(async () => {
      controller.abort(new DOMException('Cancelled', 'AbortError'));
      return { id: 'accepted-before-cancellation' };
    });
    await expect(createVolcengineAssetViaTos('my-ark', { ...options, signal: controller.signal }, input)).rejects.toMatchObject({
      name: 'AbortError', message: expect.stringContaining('素材入库任务可能已受理'),
    });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('取消上传后不能继续入库', async () => {
    const controller = new AbortController();
    mocks.upload.mockImplementationOnce(async () => { controller.abort(new DOMException('Cancelled', 'AbortError')); return signed; });
    await expect(createVolcengineAssetViaTos('my-ark', { ...options, signal: controller.signal }, input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('缺 TOS 或素材库配置、同名自定义连接、第三方入库接口和项目不匹配均在上传前拒绝', async () => {
    mocks.providers['my-ark'].tosUpload = undefined;
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('TOS Bucket');
    mocks.providers['my-ark'].tosUpload = { bucket: 'reference-bucket', region: 'cn-beijing', credentialRef: 'secret:fixture' };
    await expect(createVolcengineAssetViaTos('my-ark', { ...options, baseUrl: 'https://relay.example/' }, input)).rejects.toThrow('官方接口');
    await expect(createVolcengineAssetViaTos('my-ark', { ...options, projectName: 'other-project' }, input)).rejects.toThrow('配置已变化');
    await expect(createVolcengineAssetViaTos('my-ark', { ...options, region: 'cn-shanghai' }, input)).rejects.toThrow('北京区域');
    mocks.providers['my-ark'].assetLibrary!.enabled = false;
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('启用虚拟人像库');
    mocks.providers['my-ark'].assetLibrary!.enabled = true;
    mocks.providers['my-ark'].catalogId = 'custom-openai';
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('火山方舟连接');
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it('入库拒绝或缺素材 ID 不自动重复提交，避免创建重复资产', async () => {
    mocks.create.mockRejectedValueOnce(new Error('方舟素材库拒绝了请求'));
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('拒绝了请求');
    expect(mocks.create).toHaveBeenCalledOnce();
    mocks.create.mockResolvedValueOnce({ id: '' });
    await expect(createVolcengineAssetViaTos('my-ark', options, input)).rejects.toThrow('避免重复提交');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
});
