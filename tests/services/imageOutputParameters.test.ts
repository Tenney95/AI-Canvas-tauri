import { describe, expect, it } from 'vitest';
import type { ImageModelCapability, ImageOutputParameters } from '../../src/types/aiTypes';
import { assertImageOutputCapability, assertImageOutputInput, pickImageOutputParameters,
  resolveConfiguredImageOutput, resolveImageOutputCapability } from '../../src/services/ai/imageOutputParameters';

const capability: ImageModelCapability = {
  outputFormats: ['png', 'gif', 'svg'], defaultOutputFormat: 'png',
  textOnlyOutputFormats: ['gif', 'svg'], squareOnlyOutputFormats: ['gif', 'svg'],
  ratios: ['1:1', '16:9'], defaultRatio: '16:9', supportsImageReference: true, maxImageReferences: 6,
  gifFrameCount: { min: 2, max: 16, step: 1, default: 9 },
  gifFrameDurationMs: { min: 20, max: 655350, step: 10, default: 200 }, supportsGifTransparency: true,
};

describe('图片原格式参数边界', () => {
  it('旧模型不凭空获得格式参数，未指定参数也不改变旧请求', () => {
    expect(resolveConfiguredImageOutput(undefined, {})).toEqual({});
    expect(resolveConfiguredImageOutput({ ratios: ['1:1'] }, {})).toEqual({});
    for (const value of [{ imageOutputFormat: 'png' }, { imageTransparent: false }, { imageFrameCount: 9 }]) {
      expect(() => resolveConfiguredImageOutput(undefined, value as ImageOutputParameters)).toThrow('未声明');
    }
  });

  it('默认PNG不带GIF字段；GIF补默认值并保留明确的false', () => {
    expect(resolveConfiguredImageOutput(capability, {})).toEqual({ imageOutputFormat: 'png' });
    const gif = resolveConfiguredImageOutput(capability, { imageOutputFormat: 'gif', imageTransparent: false });
    expect(gif).toEqual({ imageOutputFormat: 'gif', imageFrameCount: 9, imageFrameDurationMs: 200, imageTransparent: false });
    expect(pickImageOutputParameters(gif)).toEqual(gif);
    expect(pickImageOutputParameters({ imageFrameCount: undefined, imageTransparent: false })).toEqual({ imageTransparent: false });
  });

  it.each([
    { imageFrameCount: 1 }, { imageFrameCount: 17 }, { imageFrameCount: 2.5 },
    { imageFrameDurationMs: 19 }, { imageFrameDurationMs: 655360 }, { imageFrameDurationMs: 201 },
    { imageFrameCount: null as unknown as number }, { imageFrameDurationMs: null as unknown as number },
  ])('上传前拒绝无效GIF参数%j', (params) => {
    expect(() => resolveConfiguredImageOutput(capability, { imageOutputFormat: 'gif', ...params })).toThrow();
  });

  it.each(['png', 'svg'] as const)('%s不接受残留GIF参数', (imageOutputFormat) => {
    expect(() => resolveConfiguredImageOutput(capability, { imageOutputFormat, imageTransparent: false })).toThrow('仅适用于GIF');
    expect(() => resolveConfiguredImageOutput(capability, { imageOutputFormat, imageFrameCount: 9 })).toThrow('仅适用于GIF');
  });

  it.each(['gif', 'svg'] as const)('%s只投影方图文生能力且不修改保存能力', (imageOutputFormat) => {
    const saved = structuredClone(capability);
    const result = resolveImageOutputCapability(saved, imageOutputFormat)!;
    expect(result).toMatchObject({ ratios: ['1:1'], defaultRatio: '1:1', supportsImageReference: false, maxImageReferences: 0 });
    expect(saved).toEqual(capability);
    expect(() => assertImageOutputInput(capability, { imageOutputFormat }, { aspectRatio: '1:1', imageCount: 0 })).not.toThrow();
    expect(() => assertImageOutputInput(capability, { imageOutputFormat }, { aspectRatio: '16:9' })).toThrow('方图');
    expect(() => assertImageOutputInput(capability, { imageOutputFormat }, { aspectRatio: '1:1', imageCount: 1 })).toThrow('参考图');
    expect(() => assertImageOutputInput(capability, { imageOutputFormat }, { aspectRatio: '1:1', hasMask: true })).toThrow('蒙版');
  });

  it('PNG保留原参考和比例能力，枚举/默认及步进声明不合法时拒绝', () => {
    expect(resolveImageOutputCapability(capability, 'png')).toMatchObject({ ratios: ['1:1', '16:9'], maxImageReferences: 6 });
    expect(() => assertImageOutputCapability({ outputFormats: ['png'], defaultOutputFormat: 'gif' })).toThrow();
    expect(() => assertImageOutputCapability({ outputFormats: ['png'], textOnlyOutputFormats: ['svg'] })).toThrow();
    expect(() => assertImageOutputCapability({ outputFormats: ['gif'], gifFrameCount: { min: 2, max: 16, default: 1 } })).toThrow();
    expect(() => resolveConfiguredImageOutput(capability, { imageOutputFormat: 'jpeg' as 'png' })).toThrow('选项');
  });
});
