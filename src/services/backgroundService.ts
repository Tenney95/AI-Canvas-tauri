/**
 * backgroundService — 背景图片自动识别深色/浅色 + 无损压缩
 */

export interface BackgroundDetection {
  /** 是否为深色背景 */
  isDark: boolean;
  /** 平均亮度 (0-255) */
  brightness: number;
}

export interface CompressionResult {
  /** 最终使用的 data URL */
  dataUrl: string;
  /** 原始文件大小（字节） */
  originalSize: number;
  /** 最终文件大小（字节） */
  compressedSize: number;
  /** 缩减率（百分比，如 45 表示缩减了 45%，≤0 表示未缩减） */
  compressionRatio: number;
  /** 最终使用的格式 */
  format: string;
  /** 是否保留了原始文件（重编码后反而更大时退回原文件） */
  keptOriginal: boolean;
}

/**
 * 从图片 data URL 自动识别深色/浅色背景
 *
 * 将图片绘制到离屏 canvas 并采样像素计算加权亮度：
 *   - 亮度 = 0.299·R + 0.587·G + 0.114·B（感知亮度公式）
 *   - 亮度 < 128 → 深色，≥ 128 → 浅色
 */
export function detectBackgroundBrightness(dataUrl: string): Promise<BackgroundDetection> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // 缩小到 50px 宽做采样（平衡性能与精度）
      const sampleWidth = 50;
      const sampleHeight = Math.round((img.height / img.width) * sampleWidth) || 50;

      canvas.width = sampleWidth;
      canvas.height = sampleHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建 canvas 上下文'));
        return;
      }

      ctx.drawImage(img, 0, 0, sampleWidth, sampleHeight);
      const imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
      const pixels = imageData.data;

      let totalBrightness = 0;
      let count = 0;

      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        // 感知亮度公式（人眼对绿色最敏感）
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
        totalBrightness += brightness;
        count++;
      }

      const avgBrightness = count > 0 ? totalBrightness / count : 128;

      resolve({
        isDark: avgBrightness < 128,
        brightness: Math.round(avgBrightness),
      });
    };

    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = dataUrl;
  });
}

/**
 * 读取 File 对象为 data URL（限定最大 10MB 以保护内存）
 */
export function fileToDataUrl(file: File): Promise<string> {
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  if (file.size > MAX_SIZE) {
    return Promise.reject(new Error('图片大小不能超过 10MB'));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 无损压缩图片：通过离屏 Canvas 重新编码，剥离 EXIF/元数据，
 * 同时比较 PNG 与无损 WebP 两种格式，选择体积更小的。
 *
 * 压缩原理：
 *   1. 将原始图片绘制到离屏 Canvas（剥离所有元数据）
 *   2. 分别以 PNG 和 WebP(无损, quality=1.0) 编码
 *   3. 若重编码后比原始文件更大（常见于 JPEG → PNG/WebP 无损），
 *      则保留原始文件不做重编码，避免膨胀
 *
 * 这是像素级无损的（不改变任何像素值），仅通过剥离元数据和
 * 浏览器内置编码器优化来减小体积。
 *
 * 注意：对已高度优化的图片（如 WebP/AVIF 原图），压缩效果有限；
 *       对含大量 EXIF 的 JPEG 照片效果最显著。
 */
export function compressImageLossless(file: File): Promise<CompressionResult> {
  const MAX_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    return Promise.reject(new Error('图片大小不能超过 10MB'));
  }

  const originalSize = file.size;
  const origExt = file.type.split('/')[1] || file.name.split('.').pop() || 'file';

  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;

      // 过大的像素面积可能导致浏览器 blob 编码超时或 OOM，加保护
      const MAX_PIXELS = 4096 * 4096;
      if (w * h > MAX_PIXELS) {
        return reject(new Error(`图片分辨率过高（${w}×${h}），请使用 ≤4096×4096 的图片`));
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('无法创建 canvas 上下文'));

      // 绘制原图（保持原始尺寸，像素级无损）
      ctx.drawImage(img, 0, 0);

      // 并行编码 PNG 和无损 WebP，选更小的
      Promise.all([
        blobFromCanvas(canvas, 'image/png'),
        blobFromCanvas(canvas, 'image/webp', 1.0), // quality=1.0 = 无损 WebP
      ])
        .then(([pngBlob, webpBlob]) => {
          if (!pngBlob) return reject(new Error('PNG 编码失败'));

          const useWebP = webpBlob && webpBlob.size < pngBlob.size;
          const compressedBlob = useWebP ? webpBlob : pngBlob;
          const compressedFormat = useWebP ? 'webp' : 'png';

          // 重编码后反而更大 → 退回原始文件
          if (compressedBlob.size >= originalSize) {
            fileToDataUrl(file).then((dataUrl) => {
              resolve({
                dataUrl,
                originalSize,
                compressedSize: originalSize,
                compressionRatio: 0,
                format: origExt,
                keptOriginal: true,
              });
            }).catch(reject);
            return;
          }

          blobToDataUrl(compressedBlob).then((dataUrl) => {
            resolve({
              dataUrl,
              originalSize,
              compressedSize: compressedBlob.size,
              compressionRatio: Math.round((1 - compressedBlob.size / originalSize) * 100),
              format: compressedFormat,
              keptOriginal: false,
            });
          }).catch(reject);
        })
        .catch(reject);
    };

    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = URL.createObjectURL(file);
  });
}

/** 将 canvas 导出为指定格式的 Blob */
function blobFromCanvas(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality);
  });
}

/** 将 Blob 转为 data URL */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Data URL 转换失败'));
    reader.readAsDataURL(blob);
  });
}
