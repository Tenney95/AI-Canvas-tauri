import { describe, expect, it } from 'vitest';
import {
  getEnabledProjectStyleReferenceUrl,
  normalizeProjectSettings,
} from '../../src/services/projectSettingsService';
import type { ProjectSettings } from '../../src/types';

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
});
