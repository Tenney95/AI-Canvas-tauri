import { describe, expect, it } from 'vitest';
import { makeContainedCenteredCrop } from '../../src/components/nodes/shared/image/cropUtils';

const ASPECTS = [1, 4 / 3, 16 / 9, 3 / 4, 9 / 16];
const MEDIA_SIZES = [
  { width: 1600, height: 900 },
  { width: 900, height: 1600 },
  { width: 1200, height: 1200 },
];

describe('makeContainedCenteredCrop', () => {
  it.each(MEDIA_SIZES)('keeps every preset inside a $width x $height image', ({ width, height }) => {
    for (const aspect of ASPECTS) {
      const crop = makeContainedCenteredCrop(aspect, width, height);
      const pixelWidth = (crop.width / 100) * width;
      const pixelHeight = (crop.height / 100) * height;

      expect(crop.unit).toBe('%');
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(100);
      expect(crop.y + crop.height).toBeLessThanOrEqual(100);
      expect(pixelWidth / pixelHeight).toBeCloseTo(aspect, 8);
    }
  });

  it('uses image height as the limiting side for a square crop on a landscape image', () => {
    const crop = makeContainedCenteredCrop(1, 1600, 900);

    expect(crop.height).toBeCloseTo(80, 8);
    expect(crop.width).toBeCloseTo(45, 8);
    expect(crop.y).toBeCloseTo(10, 8);
  });
});
