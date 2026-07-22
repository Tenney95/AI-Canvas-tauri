import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA_STATE,
  DEFAULT_LIGHT_STATE,
  buildStudioPrompt,
  normalizeCameraYaw,
} from '../../src/components/nodes/shared/image/cameraStudio';

describe('XiaoLuo camera studio prompt', () => {
  it('normalizes yaw into the signed camera range', () => {
    expect(normalizeCameraYaw(190)).toBe(-170);
    expect(normalizeCameraYaw(-190)).toBe(170);
    expect(normalizeCameraYaw(360)).toBe(0);
  });

  it('builds a camera-only prompt with angle, framing, and lens', () => {
    const prompt = buildStudioPrompt('camera', {
      ...DEFAULT_CAMERA_STATE,
      yaw: 45,
      pitch: 25,
      distance: 'close',
      lens: '85mm',
    }, DEFAULT_LIGHT_STATE);

    expect(prompt).toContain('front-right three-quarter view');
    expect(prompt).toContain('high-angle shot');
    expect(prompt).toContain('close-up framing');
    expect(prompt).toContain('85mm portrait lens');
    expect(prompt).not.toContain('key light');
  });

  it('builds a lighting-only prompt without camera instructions', () => {
    const prompt = buildStudioPrompt('lighting', DEFAULT_CAMERA_STATE, {
      ...DEFAULT_LIGHT_STATE,
      yaw: -90,
      pitch: 35,
      intensity: 72,
      temperature: 'warm',
      rimLight: true,
      fillLight: true,
    });

    expect(prompt).toContain('left-side elevated key light');
    expect(prompt).toContain('72% intensity');
    expect(prompt).toContain('warm tungsten color temperature');
    expect(prompt).toContain('subtle rim light');
    expect(prompt).toContain('soft fill light');
    expect(prompt).not.toContain('camera view');
  });

  it('combines camera and lighting instructions in dual mode', () => {
    const prompt = buildStudioPrompt('dual', DEFAULT_CAMERA_STATE, DEFAULT_LIGHT_STATE);

    expect(prompt).toContain('camera view');
    expect(prompt).toContain('key light');
  });
});
