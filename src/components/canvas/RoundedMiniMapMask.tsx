/**
 * 修正 React Flow 小地图遮罩路径，为视口窗口生成稳定的圆角内框。
 */
import { useEffect } from 'react';

const MASK_SELECTOR = '.react-flow__minimap-mask';

function formatCoordinate(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function roundInnerRect(maskPath: string, radius: number): string | null {
  const innerStart = maskPath.lastIndexOf('M');
  if (innerStart <= 0) return null;

  const outerPath = maskPath.slice(0, innerStart).trimEnd();
  const innerPath = maskPath.slice(innerStart).trim();
  const match = innerPath.match(/^M([^,]+),([^h]+)h([^v]+)v([^h]+)h([^z]+)z$/);
  if (!match) return null;

  const [, rawX, rawY, rawWidth, rawHeight] = match;
  const x = Number(rawX);
  const y = Number(rawY);
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (![x, y, width, height].every(Number.isFinite)) return null;

  const cornerRadius = Math.min(radius, width / 2, height / 2);
  const horizontal = width - cornerRadius * 2;
  const vertical = height - cornerRadius * 2;
  const f = formatCoordinate;
  const roundedInnerPath = [
    `M${f(x + cornerRadius)},${f(y)}`,
    `h${f(horizontal)}`,
    `a${f(cornerRadius)},${f(cornerRadius)} 0 0 1 ${f(cornerRadius)},${f(cornerRadius)}`,
    `v${f(vertical)}`,
    `a${f(cornerRadius)},${f(cornerRadius)} 0 0 1 ${f(-cornerRadius)},${f(cornerRadius)}`,
    `h${f(-horizontal)}`,
    `a${f(cornerRadius)},${f(cornerRadius)} 0 0 1 ${f(-cornerRadius)},${f(-cornerRadius)}`,
    `v${f(-vertical)}`,
    `a${f(cornerRadius)},${f(cornerRadius)} 0 0 1 ${f(cornerRadius)},${f(-cornerRadius)}`,
    'z',
  ].join('');

  return `${outerPath}\n${roundedInnerPath}`;
}

export default function RoundedMiniMapMask({ radius = 6 }: { radius?: number }) {
  useEffect(() => {
    let path: SVGPathElement | null = null;
    let squareMaskPath = '';
    let lastRoundedPath = '';
    let screenWidth = 0;
    let pathObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const updateMask = (resized = false) => {
      const svg = path?.ownerSVGElement;
      if (!path || !svg) return;

      const currentPath = path.getAttribute('d') ?? '';
      // 忽略圆角路径自身的回写通知，避免同一次视口更新处理两遍。
      if (!resized && currentPath === lastRoundedPath) return;
      if (!currentPath.includes('a')) squareMaskPath = currentPath;
      if (!squareMaskPath) return;

      const viewBox = svg.viewBox.baseVal;
      if (!screenWidth || !viewBox.width) return;
      const radiusInViewBox = radius * (viewBox.width / screenWidth);
      const roundedPath = roundInnerRect(squareMaskPath, radiusInViewBox);
      if (roundedPath) {
        lastRoundedPath = roundedPath;
        if (roundedPath !== currentPath) path.setAttribute('d', roundedPath);
      }
    };

    const disconnectMask = () => {
      pathObserver?.disconnect();
      resizeObserver?.disconnect();
      pathObserver = null;
      resizeObserver = null;
      path = null;
      squareMaskPath = '';
      lastRoundedPath = '';
      screenWidth = 0;
    };

    const connectMask = () => {
      // 画布其他区域的 DOM 更新不需要重新查找仍在使用的小地图。
      if (path?.isConnected) return;
      const nextPath = document.querySelector<SVGPathElement>(MASK_SELECTOR);
      if (nextPath === path) return;

      disconnectMask();
      path = nextPath;
      if (!path) return;

      const svg = path.ownerSVGElement;
      // SVG 的屏幕宽度只在连接和尺寸变化时测量，平移/缩放沿用缓存。
      if (svg) screenWidth = svg.getBoundingClientRect().width;
      updateMask();
      pathObserver = new MutationObserver(() => updateMask());
      pathObserver.observe(path, { attributes: true, attributeFilter: ['d'] });

      if (svg) {
        resizeObserver = new ResizeObserver(() => {
          if (path?.ownerSVGElement !== svg) return;
          const nextWidth = svg.getBoundingClientRect().width;
          if (nextWidth === screenWidth) return;
          screenWidth = nextWidth;
          updateMask(true);
        });
        resizeObserver.observe(svg);
      }
    };

    const minimapObserver = new MutationObserver(connectMask);
    minimapObserver.observe(document.body, { childList: true, subtree: true });
    connectMask();

    return () => {
      minimapObserver.disconnect();
      disconnectMask();
    };
  }, [radius]);

  return null;
}
