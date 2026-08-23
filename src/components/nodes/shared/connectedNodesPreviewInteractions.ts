export const CONNECTED_PREVIEW_THUMB_SIZE = 38;
export const CONNECTED_PREVIEW_GAP = 6;
export const CONNECTED_PREVIEW_LONG_PRESS_MS = 500;
export const CONNECTED_PREVIEW_MOVE_THRESHOLD_PX = 8;

export function calculateDockOffset(
  index: number,
  hoverIndex: number | null,
  maxScale: number,
  nearScale: number,
  thumbSize = CONNECTED_PREVIEW_THUMB_SIZE,
): number {
  if (hoverIndex === null || index === hoverIndex) return 0;
  const delta = index - hoverIndex;
  const distance = Math.abs(delta);
  const direction = Math.sign(delta);
  const hoveredHalfGrowth = thumbSize * (maxScale - 1) / 2;
  const nearFullGrowth = thumbSize * (nearScale - 1);
  const targetHalfGrowth = distance === 1 ? nearFullGrowth / 2 : 0;
  const betweenGrowth = distance > 1 ? nearFullGrowth : 0;

  return direction * (hoveredHalfGrowth + betweenGrowth + targetHalfGrowth);
}

interface LongPressPointer {
  button: number;
  isPrimary: boolean;
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface ConnectedPreviewLongPressController<T> {
  start: (item: T, event: LongPressPointer) => boolean;
  move: (event: Pick<LongPressPointer, 'pointerId' | 'clientX' | 'clientY'>) => void;
  end: (pointerId: number) => void;
  cancel: () => void;
  dispose: () => void;
}

export function createConnectedPreviewLongPressController<T>(
  onTrigger: (item: T) => void,
  delay = CONNECTED_PREVIEW_LONG_PRESS_MS,
  moveThreshold = CONNECTED_PREVIEW_MOVE_THRESHOLD_PX,
): ConnectedPreviewLongPressController<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: ({ item: T } & Pick<LongPressPointer, 'pointerId' | 'clientX' | 'clientY'>) | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    active = null;
  };

  return {
    start: (item, event) => {
      cancel();
      if (event.button !== 0 || !event.isPrimary) return false;
      active = {
        item,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      timer = setTimeout(() => {
        if (!active) return;
        const triggeredItem = active.item;
        timer = null;
        active = null;
        onTrigger(triggeredItem);
      }, delay);
      return true;
    },
    move: (event) => {
      if (!active || active.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - active.clientX, event.clientY - active.clientY) > moveThreshold) {
        cancel();
      }
    },
    end: (pointerId) => {
      if (active?.pointerId === pointerId) cancel();
    },
    cancel,
    dispose: cancel,
  };
}
