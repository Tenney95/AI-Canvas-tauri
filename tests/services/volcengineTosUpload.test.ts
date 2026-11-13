import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolcengineTosConfig } from '../../src/types/volcengineTos';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readFile: vi.fn(), assertData: vi.fn(), readSecret: vi.fn(), native: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => mocks.native }));
vi.mock('../../src/services/fileService', () => ({
  readFileToDataUrl: mocks.readFile, assertMediaDataUrlWithinLimitAsync: mocks.assertData,
  isMediaDataUrl: (value: string) => value.startsWith('data:'),
}));
vi.mock('../../src/services/providerSecretService', () => ({ readAppSecret: mocks.readSecret, writeAppSecret: vi.fn(), deleteAppSecret: vi.fn() }));

import { assertVolcengineTosEndpoint, assertVolcengineTosMediaSize, uploadVolcengineTosReference } from '../../src/services/ai/providers/volcengineTosUpload';

const config: VolcengineTosConfig = { bucket: 'reference-bucket', region: 'cn-beijing',
  credentialRef: 'secret:provider/volcengine/tos/01234567-0123-4123-8123-0123456789ab' };
const inline = 'data:image/png;base64,aW1hZ2U=';
const signedResult = () => ({ url: `https://${config.bucket}.tos-cn-beijing.ivolces.com/ai-canvas/ark-reference/fixture.png?X-Tos-Signature=fixture-signature`,
  expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
const fetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks(); mocks.native = true;
  mocks.assertData.mockResolvedValue(5);
  mocks.invoke.mockImplementation(async () => signedResult());
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('方舟私有 TOS 上传桥', () => {
  it('缺少 TOS 配置时失败关闭，不读取凭据或访问公共图床', async () => {
    await expect(uploadVolcengineTosReference(inline, 'image', undefined)).rejects.toThrow('不会改用公共图床');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('200 MB 以内的大视频只传原生路径、指纹与凭据引用，不读取为 Data URL', async () => {
    const expectedSource = { digest: 'a'.repeat(64), bytes: 180_000_000 };
    const guard = vi.fn();
    const result = await uploadVolcengineTosReference('file:///C:/fixture/large-video.mp4', 'video', config, undefined, expectedSource, guard);
    expect(result).toBe(signedResult().url);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('upload_volcengine_tos_reference', {
      req: { requestId: expect.stringMatching(/^volcengine-tos-/), bucket: config.bucket, credentialRef: config.credentialRef,
        kind: 'video', source: { path: 'C:/fixture/large-video.mp4' }, expectedSource },
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.assertData).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it('受限 Data URL 交给原生上传，超过 32 MiB 的内联素材不进入 IPC', async () => {
    await expect(uploadVolcengineTosReference(inline, 'image', config)).resolves.toBe(signedResult().url);
    expect(mocks.invoke).toHaveBeenCalledWith('upload_volcengine_tos_reference', {
      req: expect.objectContaining({ source: { dataUrl: inline }, credentialRef: config.credentialRef }),
    });
    mocks.invoke.mockClear();
    mocks.assertData.mockResolvedValueOnce(32 * 1024 * 1024 + 1);
    await expect(uploadVolcengineTosReference('data:video/mp4;base64,dmk=', 'video', config)).rejects.toThrow('先保存为本地文件');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('取消通知同一原生 requestId，迟到结果不能交付', async () => {
    let finish!: (result: ReturnType<typeof signedResult>) => void;
    mocks.invoke.mockImplementation((command: string) => command === 'upload_volcengine_tos_reference'
      ? new Promise<ReturnType<typeof signedResult>>((resolve) => { finish = resolve; }) : Promise.resolve());
    const controller = new AbortController();
    const pending = uploadVolcengineTosReference('file:///C:/fixture/reference.png', 'image', config, controller.signal);
    const requestId = mocks.invoke.mock.calls[0][1].req.requestId as string;
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_volcengine_tos_upload', { requestId });
    finish(signedResult());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: '公网 TOS 域名', change: () => ({ ...signedResult(), url: signedResult().url.replace('ivolces.com', 'volces.com') }) },
    { name: '其他 Bucket', change: () => ({ ...signedResult(), url: signedResult().url.replace('reference-bucket.', 'other-bucket.') }) },
    { name: '过期链接', change: () => ({ ...signedResult(), expiresAt: Date.now() - 1 }) },
    { name: '剩余有效期不足三小时', change: () => ({ ...signedResult(), expiresAt: Date.now() + 2 * 60 * 60 * 1000 }) },
    { name: '缺少签名', change: () => ({ ...signedResult(), url: signedResult().url.split('?')[0] }) },
    { name: '错误的对象目录', change: () => ({ ...signedResult(), url: signedResult().url.replace('/ai-canvas/ark-reference/', '/other/') }) },
  ])('拒绝 $name，不将链接写入错误消息', async ({ change }) => {
    const result = change(); mocks.invoke.mockResolvedValueOnce(result);
    const error = await uploadVolcengineTosReference(inline, 'image', config).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('未返回有效的北京内网素材链接');
    expect((error as Error).message).not.toContain(result.url);
  });

  it('原生异常中的本机路径和签名链接不会透传', async () => {
    mocks.invoke.mockRejectedValueOnce(`TOS failed https://private.example/?X-Tos-Signature=sensitive C:\\fixture\\secret.mp4`);
    const error = await uploadVolcengineTosReference(inline, 'image', config).catch((cause: unknown) => cause);
    expect((error as Error).message).toBe('火山 TOS 上传失败，请检查 Bucket、AK/SK 权限及网络；不会改用公共图床');
  });

  it('本地素材只允许北京官方接口，视频与图片/音频使用各自字节边界', () => {
    expect(() => assertVolcengineTosEndpoint()).not.toThrow();
    expect(() => assertVolcengineTosEndpoint('https://ark.cn-beijing.volces.com/api/v3/')).not.toThrow();
    for (const endpoint of ['https://relay.example/api/v3', 'https://ark.cn-shanghai.volces.com/api/v3',
      'http://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com:8443/api/v3',
      'https://user@ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3?key=hidden']) {
      expect(() => assertVolcengineTosEndpoint(endpoint)).toThrow('方舟官方接口');
    }
    expect(() => assertVolcengineTosMediaSize(200_000_000, 'video')).not.toThrow();
    expect(() => assertVolcengineTosMediaSize(200_000_001, 'video')).toThrow('200 MB');
    expect(() => assertVolcengineTosMediaSize(32 * 1024 * 1024, 'image')).not.toThrow();
    expect(() => assertVolcengineTosMediaSize(32 * 1024 * 1024 + 1, 'audio')).toThrow('32 MiB');
  });
});
