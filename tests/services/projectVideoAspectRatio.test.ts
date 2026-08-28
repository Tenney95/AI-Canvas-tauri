import { describe, expect, it } from 'vitest';
import {
  applyProjectDefaultsToNodeData,
  normalizeProjectSettings,
} from '../../src/services/projectSettingsService';
import {
  mapVideoDimensions,
  resolveVideoDurationSeconds,
  VIDEO_ASPECT_RATIOS,
  videoDurationFromFrames,
  videoFramesFromDuration,
} from '../../src/services/aiDimensions';
import type { BaseNodeData, ProjectSettings } from '../../src/types';

function videoNode(partial: Partial<BaseNodeData> = {}): BaseNodeData {
  return { type: 'ai-video', label: '视频', ...partial } as BaseNodeData;
}

describe('项目默认的视频画面比例', () => {
  it('保留合法比例并丢弃非法值', () => {
    for (const ratio of ['16:9', '9:16', 'adaptive']) {
      const settings: ProjectSettings = { generation: { videoAspectRatio: ratio } };
      expect(normalizeProjectSettings(settings).generation?.videoAspectRatio).toBe(ratio);
    }

    const invalid: ProjectSettings = { generation: { videoAspectRatio: '7:5' } };
    expect(normalizeProjectSettings(invalid).generation?.videoAspectRatio).toBeUndefined();
  });

  it('把项目默认比例写进视频节点的 seedanceRatio', () => {
    const settings: ProjectSettings = { generation: { videoAspectRatio: '9:16' } };

    const applied = applyProjectDefaultsToNodeData(videoNode(), settings);

    expect(applied.seedanceRatio).toBe('9:16');
  });

  it('不覆盖节点上已有的比例', () => {
    const settings: ProjectSettings = { generation: { videoAspectRatio: '9:16' } };

    const applied = applyProjectDefaultsToNodeData(
      videoNode({ seedanceRatio: '21:9', prompt: '已有提示词' }),
      settings,
    );

    expect(applied.seedanceRatio).toBe('21:9');
  });

  it('不把项目视频默认值注入 direct general 自定义模型', () => {
    const settings: ProjectSettings = {
      defaultModels: { video: 'general/custom-video' },
      generation: {
        videoAspectRatio: '9:16',
        videoResolution: '1080p',
        videoDuration: 10,
      },
    };

    const applied = applyProjectDefaultsToNodeData(videoNode(), settings);

    expect(applied).toMatchObject({
      model: 'general/custom-video',
      provider: 'general',
    });
    expect(applied.seedanceRatio).toBeUndefined();
    expect(applied.seedanceResolution).toBeUndefined();
    expect(applied.seedanceDuration).toBeUndefined();
  });

  it('只作用于视频节点', () => {
    const settings: ProjectSettings = { generation: { videoAspectRatio: '9:16' } };

    const applied = applyProjectDefaultsToNodeData(
      { type: 'ai-image', label: '图片' } as BaseNodeData,
      settings,
    );

    expect(applied.seedanceRatio).toBeUndefined();
  });
});

describe('视频比例 → 像素尺寸换算', () => {
  it('把分辨率当长边，短边按比例换算并对齐到 8', () => {
    // 常见档位应落在标准视频尺寸上
    expect(mapVideoDimensions(1280, '16:9')).toEqual({ width: 1280, height: 720 });
    expect(mapVideoDimensions(1024, '16:9')).toEqual({ width: 1024, height: 576 });
  });

  it('竖屏比例把长边给到高度', () => {
    expect(mapVideoDimensions(1280, '9:16')).toEqual({ width: 720, height: 1280 });
    expect(mapVideoDimensions(1024, '3:4')).toEqual({ width: 768, height: 1024 });
  });

  it('1:1 得到正方形', () => {
    expect(mapVideoDimensions(832, '1:1')).toEqual({ width: 832, height: 832 });
  });

  it('两边都是 8 的倍数', () => {
    for (const ratio of VIDEO_ASPECT_RATIOS) {
      for (const base of [832, 1024, 1280, 1440]) {
        const { width, height } = mapVideoDimensions(base, ratio);
        expect(width % 8).toBe(0);
        expect(height % 8).toBe(0);
        expect(Math.max(width, height)).toBe(base);
      }
    }
  });

  it('比例缺失或非法时退回正方形，不产生 NaN', () => {
    expect(mapVideoDimensions(832, undefined)).toEqual({ width: 832, height: 832 });
    expect(mapVideoDimensions(832, 'adaptive')).toEqual({ width: 832, height: 832 });
    expect(mapVideoDimensions(832, '0:0')).toEqual({ width: 832, height: 832 });
    expect(mapVideoDimensions(Number.NaN, '16:9')).toEqual({ width: 832, height: 472 });
  });

  it('比例选项同时覆盖横屏与竖屏', () => {
    expect(VIDEO_ASPECT_RATIOS).toContain('16:9');
    expect(VIDEO_ASPECT_RATIOS).toContain('9:16');
  });
});

describe('视频秒数 ↔ 帧数换算', () => {
  it('按秒数和 FPS 生成包含首帧的总帧数', () => {
    expect(videoFramesFromDuration(5, 24)).toBe(121);
    expect(videoFramesFromDuration(6, 30)).toBe(181);
  });

  it('旧节点只有总帧数时反算为最接近的整数秒', () => {
    expect(videoDurationFromFrames(77, 24)).toBe(3);
    expect(resolveVideoDurationSeconds(undefined, 121, 24)).toBe(5);
  });

  it('限制通用 UI 的时长范围并修复非法输入', () => {
    expect(videoFramesFromDuration(1, 24)).toBe(49);
    expect(videoFramesFromDuration(99, 24)).toBe(361);
    expect(resolveVideoDurationSeconds(undefined, undefined, undefined)).toBe(5);
  });
});
