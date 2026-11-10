import { describe, expect, it } from 'vitest';
import { isRelayonOfficialBaseUrl, relayonGroupBaseUrl } from '../../src/services/ai/relayonProviderGroups';

describe('万象视频新地址与旧官方来源兼容', () => {
  it('仅新视频分组默认使用 API 子域，其他分组保持原来源', () => {
    expect(relayonGroupBaseUrl('video')).toBe('https://api.relayonapi.com/v1');
    for (const group of [undefined, 'image', 'default', 'GPTpro号池']) {
      expect(relayonGroupBaseUrl(group)).toBe('https://relayonapi.com/v1');
    }
  });

  it.each(['https://relayonapi.com/v1', 'https://api.relayonapi.com/v1', 'https://api.relayonapi.com/v1/'])(
    '允许原样导入已确认的官方地址 %s', (url) => expect(isRelayonOfficialBaseUrl(url)).toBe(true),
  );

  it.each([
    'http://api.relayonapi.com/v1', 'https://api.relayonapi.com:9443/v1',
    'https://api.relayonapi.com.evil.example/v1', 'https://api.relayonapi.com/v1/videos',
    'https://key@api.relayonapi.com/v1', 'https://api.relayonapi.com/v1?key=fixture',
    'https://api.relayonapi.com/v1#video', 'not-a-url',
  ])('拒绝错误来源或带凭据／额外字段的地址 %s', (url) => expect(isRelayonOfficialBaseUrl(url)).toBe(false));
});
