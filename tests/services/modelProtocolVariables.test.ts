import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VARIABLE_NAMES,
  PROTOCOL_VARIABLES,
  REFERENCE_PROTOCOL_VARIABLES,
  getCategoryProtocolVariables,
  getProtocolVariableDescription,
  resolveProtocolFieldTemplate,
} from '../../src/services/ai/modelProtocolVariables';
import { buildGeneralVideoProtocolVariables } from '../../src/services/ai/generateVideo';

describe('protocol variable table', () => {
  it('provides hover help for every configurable variable', () => {
    const missingDescriptions = PROTOCOL_VARIABLES
      .map((spec) => spec.name)
      .filter((name) => !getProtocolVariableDescription(name)?.trim());

    expect(missingDescriptions).toEqual([]);
  });

  it('picks the most specific rule for fields that mean different things', () => {
    // 同名字段按取值分流
    expect(resolveProtocolFieldTemplate('size', '16:9', 'image')).toBe('{{aspectRatio}}');
    expect(resolveProtocolFieldTemplate('size', '1024x1024', 'image')).toBe('{{size}}');
    // 同名字段按模型类别分流
    expect(resolveProtocolFieldTemplate('resolution', '2K', 'image')).toBe('{{imageSize}}');
    expect(resolveProtocolFieldTemplate('resolution', '720p', 'video')).toBe('{{seedanceResolution}}');
    // 类别限定优先于取值限定
    expect(resolveProtocolFieldTemplate('firstframeimage', 'https://a/1.png', 'video')).toBe('{{firstImage}}');
    expect(resolveProtocolFieldTemplate('firstframeimage', 'https://a/1.png', 'image')).toBe('{{imageUrls.0}}');
    // 单数参考图字段：给数组整体替换，给单值只取第一张
    expect(resolveProtocolFieldTemplate('image', ['https://a/1.png'], 'image')).toBe('{{imageUrls}}');
    expect(resolveProtocolFieldTemplate('image', 'https://a/1.png', 'image')).toBe('{{imageUrls.0}}');
    // 布尔的 audio 是有声开关，字符串的 audio 不是
    expect(resolveProtocolFieldTemplate('audio', true, 'video')).toBe('{{generateAudio}}');
    expect(resolveProtocolFieldTemplate('audio', 'https://a/bgm.mp3', 'video')).toBeUndefined();
    // 认不出的字段保持字面量
    expect(resolveProtocolFieldTemplate('watermark', true, 'video')).toBeUndefined();
  });

  it('covers every variable the video runtime actually supplies', () => {
    const variables = buildGeneralVideoProtocolVariables(
      'relay-video',
      { model: 'general/relay', provider: 'general', prompt: 'prompt' },
      {
        prompt: 'prompt',
        imageUrls: ['https://cdn.example/ref.png'],
        videoUrls: ['https://cdn.example/ref.mp4'],
        audioUrls: ['https://cdn.example/ref.mp3'],
        operation: 'video-to-video',
        references: [{ kind: 'image', url: 'https://cdn.example/ref.png', origin: 'connection', role: 'reference' }],
      },
    );
    // 运行时产出的变量必须都在总表里，否则协议模板引用时会被白名单拒绝
    const missing = Object.keys(variables).filter((name) => !PROTOCOL_VARIABLE_NAMES.has(name));
    expect(missing).toEqual([]);
    // 反过来，模型设置里列给用户的可用变量必须都是运行时真的会给值的
    expect(getCategoryProtocolVariables('video').sort())
      .toEqual(Object.keys(variables).sort());
    // 参考素材变量在视频类别下也必须都有值
    const unsupplied = REFERENCE_PROTOCOL_VARIABLES
      .filter((name) => getCategoryProtocolVariables('video').includes(name) && !(name in variables));
    expect(unsupplied).toEqual([]);
  });
});
