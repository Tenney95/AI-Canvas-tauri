import { describe, expect, it } from 'vitest';
import {
  applyProjectDefaultsToNodeData,
  getEnabledProjectStyleReferenceUrl,
  normalizeProjectSettings,
  resolveProjectGenerationPrompt,
} from '../../src/services/projectSettingsService';
import type { BaseNodeData, ProjectSettings } from '../../src/types';

describe('project style reference (风格母图)', () => {
  it('normalizes style reference with default enabled', () => {
    const settings: ProjectSettings = {
      visualStyle: {
        styleReference: {
          imageUrl: 'asset://localhost/style.png',
          fileName: 'style.png',
        },
      },
    };
    const next = normalizeProjectSettings(settings);
    expect(next.visualStyle?.styleReference?.imageUrl).toBe('asset://localhost/style.png');
    expect(next.visualStyle?.styleReference?.enabled).toBe(true);
  });

  it('preserves explicit disabled', () => {
    const settings: ProjectSettings = {
      visualStyle: {
        styleReference: {
          imageUrl: 'https://cdn/x.png',
          enabled: false,
        },
      },
    };
    const next = normalizeProjectSettings(settings);
    expect(next.visualStyle?.styleReference?.enabled).toBe(false);
    expect(getEnabledProjectStyleReferenceUrl(next)).toBeNull();
  });

  it('getEnabledProjectStyleReferenceUrl returns url when enabled', () => {
    const settings: ProjectSettings = {
      visualStyle: {
        styleReference: {
          imageUrl: '  https://cdn/style.png  ',
          enabled: true,
        },
      },
    };
    expect(getEnabledProjectStyleReferenceUrl(settings)).toBe('https://cdn/style.png');
  });

  it('keeps named style and style reference together', () => {
    const settings: ProjectSettings = {
      visualStyle: {
        styleId: 'cinematic',
        styleName: '电影质感',
        prompt: '电影级',
        locked: true,
        styleReference: {
          imageUrl: 'asset://ref.png',
          enabled: true,
        },
      },
    };
    const next = normalizeProjectSettings(settings);
    expect(next.visualStyle?.styleId).toBe('cinematic');
    expect(next.visualStyle?.styleReference?.imageUrl).toBe('asset://ref.png');
  });

  it('syncs a new image node size to the project aspect ratio', () => {
    const next = applyProjectDefaultsToNodeData({
      label: '生成图像',
      type: 'ai-image',
      role: 'generator',
      prompt: '',
      aspectRatio: '16:9',
      nodeWidth: 280,
      nodeHeight: 158,
    }, {
      generation: { imageAspectRatio: '2:3' },
    });

    expect(next).toMatchObject({
      aspectRatio: '2:3',
      nodeWidth: 187,
      nodeHeight: 280,
    });
  });

  it('adds the node-selected style and media prompt suffix to generation prompts', () => {
    const data: BaseNodeData = {
      label: '视频生成',
      type: 'ai-video',
      style: 'paper-cut',
    };
    const settings: ProjectSettings = {
      visualStyle: {
        styleId: 'cinematic',
        prompt: '电影级画面',
      },
      promptSuffixes: {
        video: '镜头稳定，运动连贯',
      },
    };

    expect(resolveProjectGenerationPrompt({
      prompt: '一艘飞船穿过云层',
      data,
      settings,
      customStyles: [{
        id: 'paper-cut',
        nodeType: 'ai-video',
        name: '剪纸',
        prompt: '中国剪纸艺术风格，层次分明',
        createdAt: 1,
      }],
    })).toBe([
      '一艘飞船穿过云层',
      '中国剪纸艺术风格，层次分明',
      '镜头稳定，运动连贯',
    ].join('\n\n'));
  });
});
