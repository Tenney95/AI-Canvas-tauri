import { getIcon } from '@iconify/react';
import { getNodeTypeConfig } from '../../types';

export const CANVAS_MEDIA_TITLE_HEIGHT = 20;

export interface CanvasMediaDetails {
  video: boolean;
  title: string;
  displayId?: number;
}

function pixels(value: string) { return Number.parseFloat(value) || 0; }

function titleIcon(kind: 'ai-image' | 'ai-video') {
  const icon = getIcon(getNodeTypeConfig(kind).icon);
  const path = icon?.body.match(/\bd="([^"]+)"/)?.[1];
  return path && icon ? { path: new Path2D(path), width: icon.width, height: icon.height } : undefined;
}

/** Read the same classes and appearance variables as the live node once per appearance. */
export function readCanvasNearMediaStyle(view: Window, probe: HTMLElement) {
  const computed = (selector: string) => view.getComputedStyle(probe.querySelector(selector)!);
  const card = computed('.image-node');
  const label = computed('.node-label');
  const text = computed('.node-label-text');
  const badge = computed('.node-label .tabular-nums');
  const icon = computed('.node-label-icon');
  const font = (style: CSSStyleDeclaration) => `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return {
    background: card.backgroundColor,
    videoBackground: computed('.video-node .has-media').backgroundColor,
    border: card.borderTopColor,
    borderWidth: pixels(card.borderTopWidth),
    radius: pixels(card.borderTopLeftRadius),
    imageInset: pixels(computed('.image-node .node-preview').paddingLeft),
    title: {
      font: font(text), color: text.color, badgeFont: font(badge), badgeColor: badge.color, iconColor: icon.color,
      pad: pixels(label.paddingLeft), gap: pixels(label.columnGap), iconBox: pixels(icon.width),
      imageIcon: titleIcon('ai-image'), videoIcon: titleIcon('ai-video'),
    },
  };
}

function ellipsize(ctx: CanvasRenderingContext2D, title: string, maxWidth: number) {
  if (ctx.measureText(title).width <= maxWidth) return title;
  if (ctx.measureText('…').width > maxWidth) return '';
  const characters = Array.from(title);
  let low = 0, high = characters.length;
  while (low < high) {
    const next = Math.ceil((low + high) / 2);
    if (ctx.measureText(characters.slice(0, next).join('') + '…').width <= maxWidth) low = next;
    else high = next - 1;
  }
  return characters.slice(0, low).join('') + '…';
}

export function drawCanvasNearMedia(
  ctx: CanvasRenderingContext2D,
  { x, y, width, height, detail }: {
    x: number; y: number; width: number; height: number; detail: CanvasMediaDetails;
  },
  style: ReturnType<typeof readCanvasNearMediaStyle>,
  image?: HTMLImageElement,
) {
  ctx.save();
  const radius = Math.min(style.radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.clip();
  ctx.fillStyle = style.background;
  ctx.fillRect(x, y, width, height);
  if (detail.video) {
    ctx.fillStyle = style.videoBackground;
    ctx.fillRect(x, y, width, height);
  }
  if (image) {
    const inset = Math.min(style.borderWidth + (detail.video ? 0 : style.imageInset), width / 2, height / 2);
    const innerWidth = width - 2 * inset, innerHeight = height - 2 * inset;
    const fit = detail.video ? Math.min : Math.max;
    const scale = fit(innerWidth / image.naturalWidth, innerHeight / image.naturalHeight);
    const imageWidth = image.naturalWidth * scale, imageHeight = image.naturalHeight * scale;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x + inset, y + inset, innerWidth, innerHeight, Math.min(radius, innerWidth / 2, innerHeight / 2));
    ctx.clip();
    ctx.drawImage(image, x + (width - imageWidth) / 2, y + (height - imageHeight) / 2, imageWidth, imageHeight);
    ctx.restore();
  }
  if (style.borderWidth > 0) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 2 * style.borderWidth;
    ctx.stroke();
  }
  ctx.restore();
  if (!detail.title) return;

  const label = style.title;
  const icon = detail.video ? label.videoIcon : label.imageIcon;
  const centerY = y - CANVAS_MEDIA_TITLE_HEIGHT / 2;
  ctx.save();
  if (icon) {
    const size = 14;
    ctx.save();
    ctx.translate(x + label.pad + (label.iconBox - size) / 2, centerY - size / 2);
    ctx.scale(size / icon.width, size / icon.height);
    ctx.fillStyle = label.iconColor;
    ctx.fill(icon.path);
    ctx.restore();
  }
  ctx.textBaseline = 'middle';
  let right = x + width - label.pad;
  if (detail.displayId != null) {
    const badge = `#${detail.displayId}`;
    ctx.font = label.badgeFont;
    ctx.fillStyle = label.badgeColor;
    ctx.textAlign = 'right';
    ctx.fillText(badge, right, centerY);
    right -= ctx.measureText(badge).width + label.gap;
  }
  const left = x + label.pad + label.iconBox + label.gap;
  ctx.textAlign = 'left';
  ctx.font = label.font;
  ctx.fillStyle = label.color;
  ctx.fillText(ellipsize(ctx, detail.title, right - left), left, centerY);
  ctx.restore();
}
