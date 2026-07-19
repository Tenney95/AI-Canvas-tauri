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
    let pathObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const updateMask = () => {
      const svg = path?.ownerSVGElement;
      if (!path || !svg) return;

      const currentPath = path.getAttribute('d') ?? '';
      if (!currentPath.includes('a')) squareMaskPath = currentPath;
      if (!squareMaskPath) return;

      const bounds = svg.getBoundingClientRect();
      const viewBox = svg.viewBox.baseVal;
      if (!bounds.width || !viewBox.width) return;
      const radiusInViewBox = radius * (viewBox.width / bounds.width);
      const roundedPath = roundInnerRect(squareMaskPath, radiusInViewBox);
      if (roundedPath && roundedPath !== currentPath) path.setAttribute('d', roundedPath);
    };

    const disconnectMask = () => {
      pathObserver?.disconnect();
      resizeObserver?.disconnect();
      pathObserver = null;
      resizeObserver = null;
    };

    const connectMask = () => {
      const nextPath = document.querySelector<SVGPathElement>(MASK_SELECTOR);
      if (nextPath === path) return;

      disconnectMask();
      path = nextPath;
      squareMaskPath = '';
      if (!path) return;

      updateMask();
      pathObserver = new MutationObserver(updateMask);
      pathObserver.observe(path, { attributes: true, attributeFilter: ['d'] });

      const svg = path.ownerSVGElement;
      if (svg) {
        resizeObserver = new ResizeObserver(updateMask);
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
