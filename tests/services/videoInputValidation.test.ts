import { describe, expect, it, vi } from 'vitest';
import type { VideoGenerationReferenceInput, VideoModelCapability } from '../../src/types/aiTypes';
import {
  assertVideoInputConstraints,
  base64DataUrlDecodedBytes,
  type ReferenceMediaMetadataProbe,
} from '../../src/services/ai/videoInputValidation';

function input(overrides: Partial<VideoGenerationReferenceInput> = {}): VideoGenerationReferenceInput {
  return {
    prompt: '一段符合长度要求的视频描述',
    imageUrls: [],
    videoUrls: [],
    audioUrls: [],
    operation: 'text-to-video',
    ...overrides,
  };
}

const soraConstraints: VideoModelCapability = {
  inputConstraints: {
    promptMinCharacters: 10,
    maxBase64DecodedBytes: 20 * 1024 * 1024,
    referenceVideo: {
      width: { min: 300 },
      durationSeconds: { max: 15, maxExclusive: true },
    },
    referenceAudio: {
      durationSeconds: { min: 3, max: 15, maxExclusive: true },
    },
  },
};

describe('通用视频提交前输入校验', () => {
  it('按去除首尾空格后的 Unicode 字符数拦截过短提示词', async () => {
    await expect(assertVideoInputConstraints(
      input({ prompt: '  只有九个字符呀  ' }),
      soraConstraints,
      'Sora2U',
    )).rejects.toThrow('至少需要 10 个字符');
  });

  it('准确累计 Base64 data URL 解码后的字节数', async () => {
    expect(base64DataUrlDecodedBytes('data:video/mp4;base64,VklERU8=')).toBe(5);
    expect(base64DataUrlDecodedBytes('https://cdn.example/video.mp4')).toBeUndefined();

    await expect(assertVideoInputConstraints(
      input({
        videoUrls: ['data:video/mp4;base64,VklERU8='],
        audioUrls: ['data:audio/mpeg;base64,QUJD'],
        operation: 'video-to-video',
      }),
      { inputConstraints: { maxBase64DecodedBytes: 7 } },
      '测试模型',
    )).rejects.toThrow('解码后合计 8 B，不能超过 7 B');
  });

  it('逐个拦截宽度不足或达到严格视频时长上限的参考视频', async () => {
    const tooNarrow = vi.fn<ReferenceMediaMetadataProbe>().mockResolvedValue({
      width: 299,
      durationSeconds: 14.9,
    });
    await expect(assertVideoInputConstraints(
      input({ videoUrls: ['data:video/mp4;base64,Vg=='], operation: 'video-to-video' }),
      soraConstraints,
      'Sora2U',
      { probeMediaMetadata: tooNarrow },
    )).rejects.toThrow('宽度为 299 px，至少为 300 px');

    const tooLong = vi.fn<ReferenceMediaMetadataProbe>().mockResolvedValue({
      width: 300,
      durationSeconds: 15,
    });
    await expect(assertVideoInputConstraints(
      input({ videoUrls: ['data:video/mp4;base64,Vg=='], operation: 'video-to-video' }),
      soraConstraints,
      'Sora2U',
      { probeMediaMetadata: tooLong },
    )).rejects.toThrow('时长为 15 秒，必须小于 15 秒');
  });

  it('音频接受 3 秒但拒绝不足 3 秒或达到 15 秒', async () => {
    const valid = vi.fn<ReferenceMediaMetadataProbe>().mockResolvedValue({ durationSeconds: 3 });
    await expect(assertVideoInputConstraints(
      input({ audioUrls: ['data:audio/mpeg;base64,QQ=='] }),
      soraConstraints,
      'Sora2U',
      { probeMediaMetadata: valid },
    )).resolves.toBeUndefined();

    const tooShort = vi.fn<ReferenceMediaMetadataProbe>().mockResolvedValue({ durationSeconds: 2.99 });
    await expect(assertVideoInputConstraints(
      input({ audioUrls: ['data:audio/mpeg;base64,QQ=='] }),
      soraConstraints,
      'Sora2U',
      { probeMediaMetadata: tooShort },
    )).rejects.toThrow('至少为 3 秒');

    const tooLong = vi.fn<ReferenceMediaMetadataProbe>().mockResolvedValue({ durationSeconds: 15 });
    await expect(assertVideoInputConstraints(
      input({ audioUrls: ['data:audio/mpeg;base64,QQ=='] }),
      soraConstraints,
      'Sora2U',
      { probeMediaMetadata: tooLong },
    )).rejects.toThrow('必须小于 15 秒');
  });

  it('按媒体类型校验多参考素材的合计时长', async () => {
    const probe = vi.fn<ReferenceMediaMetadataProbe>()
      .mockResolvedValueOnce({ durationSeconds: 8 })
      .mockResolvedValueOnce({ durationSeconds: 8 });

    await expect(assertVideoInputConstraints(
      input({
        videoUrls: ['https://cdn.example/one.mp4', 'https://cdn.example/two.mp4'],
        operation: 'video-to-video',
      }),
      {
        inputConstraints: {
          referenceVideo: {
            durationSeconds: { min: 2, max: 15 },
            totalDurationSeconds: { max: 15 },
          },
        },
      },
      'MiniMax H3',
      { probeMediaMetadata: probe },
    )).rejects.toThrow('参考视频合计时长为 16 秒，不能超过 15 秒');
  });

  it('声明了元数据规则但无法读取时阻止付费提交', async () => {
    const unreadable = vi.fn<ReferenceMediaMetadataProbe>().mockRejectedValue(new Error('媒体无法加载'));
    await expect(assertVideoInputConstraints(
      input({ videoUrls: ['https://cdn.example/broken.mp4'], operation: 'video-to-video' }),
      soraConstraints,
      'Sora2U',
      { probeMediaMetadata: unreadable },
    )).rejects.toThrow('无法读取第 1 个参考视频的信息');
  });

  it('没有声明输入规则的既有模型保持不拦截', async () => {
    await expect(assertVideoInputConstraints(
      input({ prompt: '', videoUrls: ['not-readable'] }),
      { maxVideoReferences: 1 },
      '旧模型',
      { probeMediaMetadata: vi.fn() },
    )).resolves.toBeUndefined();
  });

  it('编辑器清空数值后留下的空范围不会触发媒体读取', async () => {
    const probe = vi.fn<ReferenceMediaMetadataProbe>();
    await expect(assertVideoInputConstraints(
      input({ videoUrls: ['not-readable'], audioUrls: ['not-readable'] }),
      {
        inputConstraints: {
          referenceVideo: { width: {}, durationSeconds: {} },
          referenceAudio: { durationSeconds: {} },
        },
      },
      '自定义模型',
      { probeMediaMetadata: probe },
    )).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
