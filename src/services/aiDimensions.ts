/** 将画质 + 比例映射为像素尺寸 */
export function mapImageDimensions(
  imageSize: string,
  aspectRatio: string,
): { width: number; height: number } {
  const shortSideMap: Record<string, number> = { '720p': 720, '1K': 1024, '2K': 2048, '4K': 4096 };
  const shortSide = shortSideMap[imageSize] || 1024;

  const [w, h] = aspectRatio.split(':').map(Number);
  if (!w || !h) return { width: shortSide, height: shortSide };

  if (w >= h) {
    return { width: Math.round(shortSide * (w / h)), height: shortSide };
  }
  return { width: shortSide, height: Math.round(shortSide * (h / w)) };
}
