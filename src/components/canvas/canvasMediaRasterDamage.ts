interface CardRect { x: number; y: number; width: number; height: number }
export interface BitmapRect { left: number; top: number; right: number; bottom: number }

/** Round out in backing pixels. The extra pixel includes antialiased edges at fractional zoom. */
export function mediaBodyPixels(card: CardRect, origin: { left: number; top: number },
  scaleX: number, scaleY: number, width: number, height: number): BitmapRect {
  return {
    left: Math.max(0, Math.floor((card.x - origin.left) * scaleX) - 1),
    top: Math.max(0, Math.floor((card.y - origin.top) * scaleY) - 1),
    right: Math.min(width, Math.ceil((card.x + card.width - origin.left) * scaleX) + 1),
    bottom: Math.min(height, Math.ceil((card.y + card.height - origin.top) * scaleY) + 1),
  };
}

export function intersectsMediaDamage(rect: BitmapRect, damage: readonly BitmapRect[]) {
  return damage.some((part) => rect.left < part.right && rect.right > part.left
    && rect.top < part.bottom && rect.bottom > part.top);
}

/** null requests a full pass. Bound both the number of clip rectangles and the area replayed. */
export function collectMediaDamage(damage: BitmapRect[], rect: BitmapRect, framePixels: number): BitmapRect[] | null {
  if (rect.left >= rect.right || rect.top >= rect.bottom) return damage;
  damage.push(rect);
  if (damage.length > 24) return null;
  const area = damage.reduce((total, part) => total + (part.right - part.left) * (part.bottom - part.top), 0);
  return area >= framePixels / 2 ? null : damage;
}

export function paintMediaDamage(ctx: CanvasRenderingContext2D, width: number, height: number,
  damage: readonly BitmapRect[] | null, paint: () => void) {
  if (damage?.length === 0) return;
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (damage === null) {
      ctx.clearRect(0, 0, width, height);
    } else {
      ctx.beginPath();
      for (const { left, top, right, bottom } of damage) {
        ctx.clearRect(left, top, right - left, bottom - top);
        ctx.rect(left, top, right - left, bottom - top);
      }
      ctx.clip();
    }
    // Replay once under the union clip to preserve source-over ordering and alpha.
    paint();
  } finally {
    ctx.restore();
  }
}
