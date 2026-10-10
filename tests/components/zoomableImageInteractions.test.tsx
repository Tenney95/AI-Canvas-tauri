import { Children, isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gesture = vi.hoisted(() => ({ scale: 1, zoomTo: vi.fn(), reset: vi.fn() }));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(callback: T) => callback,
  useEffect: vi.fn(),
}));
vi.mock('../../src/hooks/useImageViewportGesture', () => ({
  useImageViewportGesture: () => ({
    ...gesture,
    containerRef: vi.fn(), containerEl: { current: null },
    tx: 0, ty: 0, dragging: false, gesturing: false, cursor: 'default',
    onPointerDown: vi.fn(),
  }),
}));

import ZoomableImage from '../../src/components/shared/ZoomableImage';

type Element = ReactElement<{
  children?: React.ReactNode;
  className?: string;
  'aria-label'?: string;
  onClick?: (event: Event) => void;
}>;

function children(element: Element): Element[] {
  return Children.toArray(element.props.children).filter(isValidElement) as Element[];
}

// 按按钮、控制栏、预览容器的顺序冒泡，复现缩放尚未重新渲染时的同一次点击。
function click(path: Element[]) {
  const event = new Event('click', { bubbles: true });
  for (const element of path) {
    element.props.onClick?.(event);
    if (event.cancelBubble) break;
  }
}

beforeEach(() => {
  gesture.scale = 1;
  vi.clearAllMocks();
});

describe('fullscreen image zoom controls', () => {
  it.each([
    ['放大', 1, 1.4],
    ['缩小', 1.4, 1],
    ['复位缩放', 1, null],
  ] as const)('%s does not close the preview', (label, scale, expectedScale) => {
    gesture.scale = scale;
    const onClose = vi.fn();
    const root = ZoomableImage({ src: 'asset://preview.png', onClose });
    const controls = children(root).find((element) => element.props.className === 'zoom-controls')!;
    const button = children(controls).find((element) => element.props['aria-label'] === label)!;

    click([button, controls, root]);

    expect(onClose).not.toHaveBeenCalled();
    if (expectedScale === null) expect(gesture.reset).toHaveBeenCalledOnce();
    else expect(gesture.zoomTo).toHaveBeenCalledWith(expectedScale, 0, 0);
  });

  it('still closes when clicking the image at the default scale', () => {
    const onClose = vi.fn();
    const root = ZoomableImage({ src: 'asset://preview.png', onClose });
    click([children(root)[0], root]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
