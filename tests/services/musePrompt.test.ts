import { describe, expect, it } from 'vitest';
import type { MediaReference } from '../../src/types/aiTypes';
import { museImagePrompt, museVideoPrompt } from '../../src/services/ai/providers/musePrompt';

const reference = (role: MediaReference['role'], kind: MediaReference['kind'] = 'image'): MediaReference =>
  ({ kind, role, origin: 'connection', url: `data:${kind}/fixture` });

describe('Muse 网页生成请求', () => {
  it('无参考图时明确从零生成，保留用户正文和目标比例', () => {
    const prompt = museImagePrompt('雨中街道，不加文字', '9:16', 0);
    expect(prompt).toContain('没有参考图片');
    expect(prompt).toContain('目标比例 9:16');
    expect(prompt).toContain('雨中街道，不加文字');
    expect(prompt).not.toContain('水印');
  });

  it('拒绝空提示词、超限图片和不支持的比例', () => {
    expect(() => museImagePrompt(' ', '1:1', 0)).toThrow();
    expect(() => museImagePrompt('风景', '1:1', 5)).toThrow();
    expect(() => museImagePrompt('风景', 'adaptive', 0)).toThrow();
  });

  it('显式首帧与普通参考保持不同含义，素材顺序不被改写', () => {
    const first = reference('first_frame'), second = { ...reference('reference'), url: 'second' };
    const result = museVideoPrompt('镜头推进', '16:9', 6, [first, second]);
    expect(result.images).toEqual([first.url, second.url]);
    expect(result.prompt).toContain('作为首帧');
    expect(result.prompt).toContain('目标时长 6 秒');
    expect(museVideoPrompt('镜头推进', '16:9', 5, [reference('reference')]).prompt).not.toContain('作为首帧');
  });

  it('拒绝尾帧和未实现的音视频参考，避免静默漏传素材', () => {
    for (const item of [reference('last_frame'), reference('reference', 'video'), reference('reference_audio', 'audio')]) {
      expect(() => museVideoPrompt('运动镜头', '16:9', 5, [item])).toThrow();
    }
    expect(() => museVideoPrompt('运动镜头', '16:9', 5, [reference('reference'), reference('first_frame')])).toThrow();
    expect(() => museVideoPrompt('运动镜头', '16:9', 5, [reference('first_frame'), reference('first_frame')])).toThrow();
  });

  it('只接受离散目标时长和横竖视频画幅', () => {
    expect(() => museVideoPrompt('海浪', '1:1', 5, [])).toThrow();
    expect(() => museVideoPrompt('海浪', '16:9', 7, [])).toThrow();
    expect(museVideoPrompt('海浪', '9:16', 10, []).prompt).toContain('没有参考素材');
  });
});
