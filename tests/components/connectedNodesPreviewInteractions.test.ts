import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateDockOffset,
  CONNECTED_PREVIEW_GAP,
  CONNECTED_PREVIEW_THUMB_SIZE,
  createConnectedPreviewLongPressController,
} from '../../src/components/nodes/shared/connectedNodesPreviewInteractions';

describe('ConnectedNodesPreview 交互', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('2.5 倍悬浮时把相邻缩略图推开并保留原间距', () => {
    const maxScale = 2.5;
    const nearScale = 1.16;
    const offset = calculateDockOffset(1, 0, maxScale, nearScale);
    const centerDistance = CONNECTED_PREVIEW_THUMB_SIZE + CONNECTED_PREVIEW_GAP + offset;
    const requiredDistance = CONNECTED_PREVIEW_THUMB_SIZE * maxScale / 2
      + CONNECTED_PREVIEW_THUMB_SIZE * nearScale / 2
      + CONNECTED_PREVIEW_GAP;

    expect(centerDistance).toBeCloseTo(requiredDistance);
  });

  it('长按达到阈值后触发全屏', () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const controller = createConnectedPreviewLongPressController(onTrigger, 500, 8);

    controller.start('node-1', {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 20,
      clientY: 30,
    });
    vi.advanceTimersByTime(500);

    expect(onTrigger).toHaveBeenCalledWith('node-1');
  });

  it('长按过程中移动超过容差会取消', () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const controller = createConnectedPreviewLongPressController(onTrigger, 500, 8);

    controller.start('node-1', {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 20,
      clientY: 30,
    });
    controller.move({ pointerId: 1, clientX: 29, clientY: 30 });
    vi.advanceTimersByTime(500);

    expect(onTrigger).not.toHaveBeenCalled();
  });
});
