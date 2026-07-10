import { useRef, useEffect } from 'react';

/**
 * 追踪全局 Shift 键是否被按下，用于节点缩放时保持比例。
 * 同时处理窗口失焦后重置，避免 Shift 状态"粘住"。
 */
export function useShiftProportional() {
  const shiftHeld = useRef(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && !e.repeat) {
        shiftHeld.current = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftHeld.current = false;
      }
    };
    const onBlur = () => {
      shiftHeld.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return shiftHeld;
}

/**
 * 拖拽中 Shift 被按下时，需要"锁定"到当前实时尺寸作为新的等比基准。
 * reset() 在每次 pointerdown 时调用；lock() 在 Shift 首次激活时调用。
 */
export function useProportionalLock() {
  const lockRef = useRef({ w: 0, h: 0, x: 0, y: 0, ratio: 1 });

  const reset = () => {
    lockRef.current = { w: 0, h: 0, x: 0, y: 0, ratio: 1 };
  };

  const lock = (liveW: number, liveH: number, clientX: number, clientY: number) => {
    const ratio = liveH > 0 ? liveW / liveH : 1;
    lockRef.current = { w: liveW, h: liveH, x: clientX, y: clientY, ratio };
  };

  /** 是否已锁定（即 Shift 已被按下过） */
  const isLocked = () => lockRef.current.w !== 0;

  return { lockRef, reset, lock, isLocked };
}

/**
 * 根据是否按比例模式，计算最终的宽高。
 *
 * @param baseW  基准宽度（自由模式=拖拽起点宽；比例模式=Shift按下瞬间的宽）
 * @param baseH  基准高度
 * @param dx     基准 X 方向偏移
 * @param dy     基准 Y 方向偏移
 * @param ratio  宽高比
 * @param minW   最小宽度
 * @param minH   最小高度
 * @param useProportional  是否启用量保持
 */
export function computeResize(
  baseW: number,
  baseH: number,
  dx: number,
  dy: number,
  ratio: number,
  minW: number,
  minH: number,
  useProportional: boolean,
): { width: number; height: number } {
  if (!useProportional) {
    return {
      width: Math.max(minW, baseW + dx),
      height: Math.max(minH, baseH + dy),
    };
  }

  // 比例模式：以变化更大的轴向为主导，另一轴按比例计算
  const rawW = baseW + dx;
  const rawH = baseH + dy;
  let width: number;
  let height: number;

  if (Math.abs(dx) >= Math.abs(dy)) {
    width = Math.max(minW, rawW);
    height = Math.max(minH, width / ratio);
  } else {
    height = Math.max(minH, rawH);
    width = Math.max(minW, height * ratio);
  }

  return { width, height };
}
