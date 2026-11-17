import { describe, expect, it } from 'vitest';
import { getRelayonGroupPresetModels, isRelayonOfficialBaseUrl, relayonGroupBaseUrl, resolveRelayonImageBaseUrl } from '../../src/services/ai/relayonProviderGroups';
import { RELAYON_MODEL_MANIFEST } from '../../src/services/ai/providers/relayonModelManifest';

describe('万象媒体新地址与旧官方来源兼容', () => {
  it('两款2.6格式变体只进入image分组，不扩大其他分组权限', () => {
    for (const id of ['image-2.6-flare-01', 'image-2.6-sunburst-01']) {
      expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'image').some((model) => model.id === id)).toBe(true);
      for (const group of ['video', 'default', 'GPTpro号池', 'Gemini号池', 'ClaudeMax号池']) {
        expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, group).some((model) => model.id === id)).toBe(false);
      }
    }
  });
  it('新图片和视频分组默认使用 API 子域，其他分组保持原来源', () => {
    for (const group of ['image', 'video']) expect(relayonGroupBaseUrl(group)).toBe('https://api.relayonapi.com/v1');
    for (const group of [undefined, 'default', 'GPTpro号池']) {
      expect(relayonGroupBaseUrl(group)).toBe('https://relayonapi.com/v1');
    }
  });

  it('旧官方图片地址只为本轮请求临时投影 API 子域，新地址保持不变', () => {
    expect(resolveRelayonImageBaseUrl('https://relayonapi.com/v1')).toBe('https://api.relayonapi.com/v1');
    expect(resolveRelayonImageBaseUrl('https://api.relayonapi.com/v1')).toBe('https://api.relayonapi.com/v1');
  });

  it.each(['https://custom.example/v1', 'http://relayonapi.com/v1', 'https://relayonapi.com:9443/v1',
    'https://relayonapi.com/v1/images', 'https://key@relayonapi.com/v1', 'https://relayonapi.com/v1?key=fixture'])(
    '图片请求不改写非精确官方来源 %s', (url) => expect(resolveRelayonImageBaseUrl(url)).toBe(url),
  );

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
