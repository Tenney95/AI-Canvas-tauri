import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolcengineTosConfig, VolcengineTosCredentials } from '../../src/types/volcengineTos';

const secrets = vi.hoisted(() => ({ write: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/services/providerSecretService', () => ({ writeAppSecret: secrets.write, deleteAppSecret: secrets.remove }));

import { deleteVolcengineTosCredential, persistVolcengineTosConfig, validateVolcengineTosConfig } from '../../src/services/volcengineTosConfigService';

const ref = 'secret:provider/volcengine/tos/01234567-0123-4123-8123-0123456789ab';
const config: VolcengineTosConfig = { bucket: 'reference-bucket', region: 'cn-beijing', credentialRef: ref };
const empty: VolcengineTosCredentials = { accessKeyId: '', secretAccessKey: '' };
const credentials: VolcengineTosCredentials = { accessKeyId: 'fixture-tos-ak', secretAccessKey: 'fixture-tos-sk' };

beforeEach(() => {
  vi.resetAllMocks();
  secrets.write.mockResolvedValue(true);
  secrets.remove.mockResolvedValue(true);
});

describe('火山 TOS 配置与独立凭据', () => {
  it('未配置 TOS 可保存连接，空草稿不写入凭据', async () => {
    expect(await persistVolcengineTosConfig(undefined, empty)).toBeUndefined();
    expect(await persistVolcengineTosConfig({ bucket: '', region: 'cn-beijing', credentialRef: '' }, empty)).toBeUndefined();
    expect(secrets.write).not.toHaveBeenCalled();
  });

  it('拒绝非法 Bucket、其他区域、其他凭据引用与不完整 AK/SK', () => {
    for (const bucket of ['ab', '-bucket', 'bucket-', 'MyBucket', 'bucket.example', 'a'.repeat(64)]) {
      expect(() => validateVolcengineTosConfig({ ...config, bucket })).toThrow('Bucket');
    }
    expect(() => validateVolcengineTosConfig({ ...config, region: 'cn-shanghai' as 'cn-beijing' })).toThrow('北京');
    expect(() => validateVolcengineTosConfig({ ...config, credentialRef: 'secret:provider/volcengine/asset-library/access-key' })).toThrow('引用无效');
    expect(() => validateVolcengineTosConfig(config, { ...empty, accessKeyId: credentials.accessKeyId })).toThrow('同时填写');
    expect(() => validateVolcengineTosConfig({ ...config, credentialRef: '' })).toThrow('方舟 API Key 不能代替');
  });

  it('AK/SK 保存在一个新 JSON bundle 中，普通配置只返回引用', async () => {
    const saved = await persistVolcengineTosConfig({ ...config, bucket: ' reference-bucket ', credentialRef: '' }, credentials);
    const [key, value, expected] = secrets.write.mock.calls[0] as [string, string, { value: null }];
    expect(key).toMatch(/^provider\/volcengine\/tos\/[a-f0-9-]{36}$/);
    expect(JSON.parse(value)).toEqual(credentials);
    expect(expected).toEqual({ value: null });
    expect(saved).toEqual({ bucket: 'reference-bucket', region: 'cn-beijing', credentialRef: `secret:${key}` });
    expect(JSON.stringify(saved)).not.toContain(credentials.accessKeyId);
    expect(JSON.stringify(saved)).not.toContain(credentials.secretAccessKey);
  });

  it('AK/SK 长度和字符限制与原生凭据解析保持一致', () => {
    expect(() => validateVolcengineTosConfig(config, { accessKeyId: 'a'.repeat(256), secretAccessKey: 's'.repeat(2048) })).not.toThrow();
    expect(() => validateVolcengineTosConfig(config, { ...credentials, accessKeyId: 'a'.repeat(257) })).toThrow('格式无效');
    expect(() => validateVolcengineTosConfig(config, { ...credentials, accessKeyId: '中文AK' })).toThrow('格式无效');
    expect(() => validateVolcengineTosConfig(config, { ...credentials, secretAccessKey: 's'.repeat(2049) })).toThrow('格式无效');
    expect(() => validateVolcengineTosConfig(config, { ...credentials, secretAccessKey: 's\nkey' })).toThrow('格式无效');
  });

  it('留空保留旧引用；新 bundle 写入失败不覆盖或删除旧凭据', async () => {
    expect(await persistVolcengineTosConfig(config, empty)).toEqual(config);
    expect(secrets.write).not.toHaveBeenCalled();
    secrets.write.mockResolvedValueOnce(false);
    await expect(persistVolcengineTosConfig(config, credentials)).rejects.toThrow('凭据保存失败');
    expect(secrets.write.mock.calls[0][0]).not.toBe(ref.slice('secret:'.length));
    expect(secrets.remove).not.toHaveBeenCalled();
  });

  it('清理仅接受本功能的 UUID 引用', async () => {
    await deleteVolcengineTosCredential('secret:provider/volcengine/asset-library/access-key');
    expect(secrets.remove).not.toHaveBeenCalled();
    await deleteVolcengineTosCredential(ref);
    expect(secrets.remove).toHaveBeenCalledExactlyOnceWith(ref.slice('secret:'.length));
  });
});
