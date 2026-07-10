/**
 * ai/panoramaPrompt — 全景图提示词构建
 */

/** 为全景图节点拼接 360° 等距柱状投影提示词 */
export function buildPanoramaPrompt(userPrompt: string): string {
  const panoramaSuffix = [
    '360-degree equirectangular panoramic image',
    'spherical projection for VR display',
    'seamless left-to-right horizontal tiling with no visible edges',
    'ultra-wide immersive perspective, full 360° horizontal × 180° vertical coverage',
    'high quality photorealistic equirectangular panorama format',
  ].join(', ');
  return `${userPrompt}, ${panoramaSuffix}`;
}
