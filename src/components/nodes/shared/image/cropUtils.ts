import { type Crop, centerCrop, makeAspectCrop } from 'react-image-crop';

const DEFAULT_CROP_PERCENT = 80;

/** 生成完整落在图片内的居中比例框，避免窄比例在横图上按宽度计算后高度越界。 */
export function makeContainedCenteredCrop(
  aspect: number,
  mediaWidth: number,
  mediaHeight: number,
): Crop {
  const mediaAspect = mediaWidth / mediaHeight;
  const baseCrop = aspect >= mediaAspect
    ? { unit: '%' as const, width: DEFAULT_CROP_PERCENT }
    : { unit: '%' as const, height: DEFAULT_CROP_PERCENT };

  return centerCrop(
    makeAspectCrop(baseCrop, aspect, mediaWidth, mediaHeight),
    mediaWidth,
    mediaHeight,
  );
}
