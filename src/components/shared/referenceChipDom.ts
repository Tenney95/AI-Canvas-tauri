/** UI Kit 引用胶囊的纯 DOM 构造器；不读取 Store、路径或宿主权限。 */
export interface ReferenceChipOptions {
  label: string;
  kind?: 'text' | 'image' | 'video' | 'audio' | 'markdown';
  badge?: string;
  mediaIndex?: string;
  thumbnailUrl?: string;
  thumbnailCrop?: { x: number; y: number; width: number; height: number };
  iconPath?: string;
  iconText?: string;
}

export function buildReferenceChipEl(doc: Document, options: ReferenceChipOptions): HTMLSpanElement {
  const kind = options.kind || 'text';
  const chip = doc.createElement('span');
  chip.className = `ui-reference-chip ui-reference-chip--${kind} prompt-chip prompt-chip-node chip-${kind}`;
  chip.contentEditable = 'false';
  chip.title = options.badge ? `${options.label} (${options.badge})` : options.label;
  chip.setAttribute('aria-label', chip.title);
  const icon = doc.createElement('span');
  icon.className = 'ui-reference-chip__icon prompt-chip-icon';
  icon.setAttribute('aria-hidden', 'true');
  if (options.iconPath) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(name, value);
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', options.iconPath); svg.appendChild(path); icon.appendChild(svg);
  } else if (options.thumbnailUrl) {
    icon.classList.add('has-thumbnail');
    const image = doc.createElement('img');
    image.className = 'ui-reference-chip__thumb prompt-chip-thumb';
    image.src = options.thumbnailUrl; image.alt = ''; image.draggable = false;
    if (options.thumbnailCrop) {
      const crop = options.thumbnailCrop;
      // 只设置裁剪几何；调用方须先校验来源与 0..1 矩形。
      image.style.width = `${100 / crop.width}%`; image.style.height = `${100 / crop.height}%`;
      image.style.left = `${-100 * crop.x / crop.width}%`; image.style.top = `${-100 * crop.y / crop.height}%`;
      image.classList.add('is-cropped');
    }
    icon.appendChild(image);
  } else icon.textContent = options.iconText || '@';
  chip.appendChild(icon);
  const label = doc.createElement('span');
  label.className = 'ui-reference-chip__label prompt-chip-id';
  label.textContent = options.badge || options.label; chip.appendChild(label);
  if (options.mediaIndex) {
    const index = doc.createElement('span');
    index.className = 'ui-reference-chip__index prompt-chip-id prompt-chip-image-index prompt-chip-media-index text-canvas-text-secondary';
    index.textContent = options.mediaIndex; chip.appendChild(index);
  }
  return chip;
}
