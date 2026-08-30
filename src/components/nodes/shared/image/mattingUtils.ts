export type RgbaColor = readonly [number, number, number, number];

const DEFAULT_TOLERANCE = 20;

/**
 * 低分配扫描线填充。
 * 队列和去重表均按像素数一次性分配，不在遍历过程中创建坐标/邻居数组。
 */
export function floodFillImageData(
  imageData: ImageData,
  startX: number,
  startY: number,
  fillColor: RgbaColor,
  tolerance = DEFAULT_TOLERANCE,
): boolean {
  const { data, width, height } = imageData;
  if (width < 1 || height < 1 || data.length < width * height * 4) return false;

  const x = Math.min(width - 1, Math.max(0, Math.round(startX)));
  const y = Math.min(height - 1, Math.max(0, Math.round(startY)));
  const startPixel = y * width + x;
  const startOffset = startPixel * 4;
  const target: RgbaColor = [
    data[startOffset],
    data[startOffset + 1],
    data[startOffset + 2],
    data[startOffset + 3],
  ];

  const isFillColor = (pixel: number): boolean => {
    const offset = pixel * 4;
    return data[offset] === fillColor[0]
      && data[offset + 1] === fillColor[1]
      && data[offset + 2] === fillColor[2]
      && data[offset + 3] === fillColor[3];
  };
  if (isFillColor(startPixel)) return false;

  const safeTolerance = Math.max(0, Math.min(255, Math.round(tolerance)));
  const matchesTarget = (pixel: number): boolean => {
    if (isFillColor(pixel)) return false;
    const offset = pixel * 4;
    return Math.abs(data[offset] - target[0]) <= safeTolerance
      && Math.abs(data[offset + 1] - target[1]) <= safeTolerance
      && Math.abs(data[offset + 2] - target[2]) <= safeTolerance
      && Math.abs(data[offset + 3] - target[3]) <= safeTolerance;
  };

  const pixelCount = width * height;
  const stack = new Int32Array(pixelCount);
  const queued = new Uint8Array(pixelCount);
  let stackSize = 0;
  let changed = false;

  const push = (pixel: number) => {
    if (queued[pixel]) return;
    queued[pixel] = 1;
    stack[stackSize] = pixel;
    stackSize += 1;
  };
  push(startPixel);

  while (stackSize > 0) {
    stackSize -= 1;
    const seed = stack[stackSize];
    if (!matchesTarget(seed)) continue;

    const row = Math.floor(seed / width);
    let scanX = seed - row * width;
    while (scanX > 0 && matchesTarget(row * width + scanX - 1)) scanX -= 1;

    let spanAbove = false;
    let spanBelow = false;
    for (; scanX < width; scanX += 1) {
      const pixel = row * width + scanX;
      if (!matchesTarget(pixel)) break;

      const offset = pixel * 4;
      data[offset] = fillColor[0];
      data[offset + 1] = fillColor[1];
      data[offset + 2] = fillColor[2];
      data[offset + 3] = fillColor[3];
      changed = true;

      if (row > 0) {
        const above = pixel - width;
        const canFillAbove = matchesTarget(above);
        if (canFillAbove && !spanAbove) push(above);
        spanAbove = canFillAbove;
      }
      if (row + 1 < height) {
        const below = pixel + width;
        const canFillBelow = matchesTarget(below);
        if (canFillBelow && !spanBelow) push(below);
        spanBelow = canFillBelow;
      }
    }
  }

  return changed;
}

/** 按 ImageData 实际字节数淘汰最旧历史，同时始终保留最新一条。 */
export function trimImageDataHistory(
  entries: readonly ImageData[],
  maxBytes: number,
): ImageData[] {
  if (entries.length <= 1) return entries.slice();
  const budget = Math.max(0, Math.floor(maxBytes));
  let totalBytes = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
  let firstKept = 0;
  while (firstKept < entries.length - 1 && totalBytes > budget) {
    totalBytes -= entries[firstKept].data.byteLength;
    firstKept += 1;
  }
  return entries.slice(firstKept);
}
