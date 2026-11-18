/**
 * modelProtocolTestRun — 回归测试：模型协议试跑前置条件。
 */
import { describe, expect, it, vi } from 'vitest';
import { assertRealProtocolTestVariables, defaultVideoTestScenario, describeProtocolTestRunBlocker,
  buildVideoTestVariables, resolveProtocolTestRunDraft, videoTestReferences, nativeProtocolTestMessages } from '../../src/components/settings/modelProtocolTestRun';
import { getDefaultCustomProtocol } from '../../src/services/ai/modelProtocol';

const videoBuilder = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/ai/generateVideo', () => ({ buildGeneralVideoProtocolVariables: videoBuilder }));

describe('模型协议试跑前置条件', () => {
  it('preserves all five images and history from trial messages', () => {
    const messages = [{ role: 'system', content: '看图' }, { role: 'user', content: [{ type: 'text', text: '五图' },
      ...Array.from({ length: 5 }, (_, i) => ({ type: 'image_url', image_url: { url: `https://images.vendor.com/${i}.png` } }))] }];
    expect(nativeProtocolTestMessages({ messages })).toEqual(messages);
    expect(() => nativeProtocolTestMessages({ messages: [{ role: 'user', content: [{ type: 'video', url: 'x' }] }] })).toThrow('仅支持');
  });
  it('凭据与地址齐全的声明式协议可以试跑', () => {
    expect(describeProtocolTestRunBlocker('custom', 'sk-test', 'https://gw.example/v1')).toBeNull();
    expect(describeProtocolTestRunBlocker('openai-chat', 'sk-test', 'https://gw.example/v1')).toBeNull();
  });

  it('自动兼容不走声明式协议，没有东西可跑', () => {
    expect(describeProtocolTestRunBlocker('legacy', 'sk-test', 'https://gw.example/v1'))
      .toBe('legacy-preset');
  });

  it('缺地址或缺密钥时先报地址，空白字符不算填写', () => {
    expect(describeProtocolTestRunBlocker('custom', 'sk-test', '   ')).toBe('missing-base-url');
    expect(describeProtocolTestRunBlocker('custom', '  ', 'https://gw.example/v1'))
      .toBe('missing-api-key');
  });

  it('无效草稿阻止试跑，执行前重新解析当前 JSON', () => {
    const previous = getDefaultCustomProtocol('image');
    const edited = structuredClone(previous);
    edited.submit.path = '/new-images';
    expect(describeProtocolTestRunBlocker('custom', 'sk-test', 'https://gw.example', true))
      .toBe('invalid-draft');
    expect(resolveProtocolTestRunDraft('custom', previous, JSON.stringify(edited))).toEqual(edited);
    expect(() => resolveProtocolTestRunDraft('custom', previous, '{ invalid JSON')).toThrow();
    expect(() => resolveProtocolTestRunDraft('custom', previous, JSON.stringify(previous), true))
      .toThrow('请修正表单中的 JSON 错误');
  });
});

describe('真实视频试跑素材场景', () => {
  const input = { firstImage: 'https://media.vendor.com/first.png', lastImage: 'https://media.vendor.com/last.png',
    images: 'https://media.vendor.com/ref.png', videos: 'https://media.vendor.com/ref.mp4', audios: 'https://media.vendor.com/ref.mp3' };

  it('文生不发送旧素材，首尾帧和多参考保持互斥', () => {
    expect(videoTestReferences('text', input)).toEqual([]);
    expect(videoTestReferences('keyframe', input).map(({ role }) => role)).toEqual(['first_frame', 'last_frame']);
    const references = videoTestReferences('reference', input);
    expect(references.map(({ kind }) => kind)).toEqual(['image', 'video', 'audio']);
    expect(references.some(({ role }) => role === 'first_frame' || role === 'last_frame')).toBe(false);
  });

  it('没有真实素材、占位网址、非HTTP路径和携带凭据的链接不会发送', () => {
    expect(() => videoTestReferences('reference', { ...input, images: '', videos: '', audios: '' })).toThrow('至少一份');
    for (const firstImage of ['', 'https://cdn.example/ref.png', 'file:///private/ref.png', 'https://user:pass@media.vendor.com/ref.png']) {
      expect(() => videoTestReferences('keyframe', { ...input, firstImage })).toThrow();
    }
    expect(() => assertRealProtocolTestVariables({ imageUrls: ['https://cdn.example/ref.png'] })).toThrow('示例素材');
    expect(() => assertRealProtocolTestVariables({ prompt: '真实提示词' })).not.toThrow();
  });

  it('场景默认值只依据明确能力，不根据型号名推断', () => {
    const model = { id: 'known-looking-h3', provider: 'custom', name: 'H3', category: 'video' as const };
    expect(defaultVideoTestScenario(model)).toBe('text');
    expect(defaultVideoTestScenario({ ...model, videoCapability: { requiresReference: true, operations: ['video-to-video'] } })).toBe('reference');
    expect(defaultVideoTestScenario({ ...model, videoCapability: { operations: ['image-to-video'] } })).toBe('keyframe');
  });

  it('视频参数与角色交给共享构造器，不让旧JSON素材覆盖当前场景', async () => {
    videoBuilder.mockReset().mockReturnValue({ model: 'video', videoInputMode: 'text', firstImage: undefined, imageUrls: undefined });
    const model = { id: 'video', provider: 'custom', name: 'Video', category: 'video' as const,
      videoCapability: { resolutions: ['768P'], defaultResolution: '768P' } };
    const result = await buildVideoTestVariables(model, 'text', input, {
      prompt: 'my trial', duration: 5, aspectRatio: '16:9', videoResolution: 1280,
      firstImage: 'https://media.vendor.com/old.png', imageUrls: ['https://media.vendor.com/old.png'],
    });
    expect(videoBuilder).toHaveBeenCalledWith('video', expect.objectContaining({
      seedanceDuration: 5, seedanceRatio: '16:9', videoResolution: 1280,
    }), expect.objectContaining({ references: [], imageUrls: [], videoUrls: [], audioUrls: [] }), model.videoCapability);
    expect(result.firstImage).toBeUndefined();
    expect(result.imageUrls).toBeUndefined();
    videoBuilder.mockClear();
    await expect(buildVideoTestVariables(model, 'text', input, { duration: '5' })).rejects.toThrow('有限数值');
    expect(videoBuilder).not.toHaveBeenCalled();
  });
});
