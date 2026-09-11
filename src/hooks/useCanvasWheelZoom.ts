import { useEffect, type RefObject } from 'react';
import type { Viewport } from '@xyflow/react';

const WHEEL_DELTA_PER_NOTCH = 120;
const WHEEL_SENSITIVITY = Math.log(1.08) / WHEEL_DELTA_PER_NOTCH;
const WHEEL_TRANSITION_MS = 60;
const WHEEL_RESPONSE_MS = WHEEL_TRANSITION_MS / 4;
const WHEEL_EXCLUDED = '.nowheel, .react-flow__panel, .react-flow__minimap, .node-floating-toolbar, input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const NATIVE_MOUSE_WHEEL = 'ai-canvas:native-mouse-wheel';
// 跨 Hook 重挂载保留取消水位，迟到的原生输入不能落入新项目。
let nativeWheelCancelledAt = 0;

interface NativeMouseWheelDetail {
  xRatio: number;
  yRatio: number;
  deltaY: number;
  issuedAt: number;
}

type WheelZoomInput = Pick<WheelEvent, 'target' | 'defaultPrevented' | 'cancelable' | 'ctrlKey' | 'metaKey'
  | 'shiftKey' | 'buttons' | 'deltaY' | 'deltaMode' | 'clientX' | 'clientY' | 'preventDefault' | 'stopPropagation'>;

interface WheelZoomOptions {
  getViewport: () => Viewport;
  setViewport: (viewport: Viewport) => Promise<boolean>;
  onStart: () => void;
  onEnd: (interrupted: boolean) => void;
  minZoom: number;
  maxZoom: number;
  /** Mac 桌面只接收原生识别的实体滚轮；DOM wheel 保留给触摸板。 */
  nativeMouseWheel?: boolean;
}

/** 合并同帧滚轮输入，以短过渡跟随目标；结束后立即释放交互状态。 */
export function bindCanvasWheelZoom(element: HTMLElement, options: WheelZoomOptions): { cancel: () => void; destroy: () => void } {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let frame = 0;
  let active = false;
  let logZoom = 0;
  let targetZoom = 1;
  let targetLogZoom = 0;
  let lastAdvancedAt = 0;
  let lastInputAt = 0;
  let direction = 0;
  let screen = { x: 0, y: 0 };
  let anchor = { x: 0, y: 0 };
  let lastApplied: Viewport | null = null;

  const cancel = (interrupted = true) => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastApplied = null;
    if (active) { active = false; options.onEnd(interrupted); }
  };
  const viewportChanged = (viewport: Viewport) => lastApplied !== null && (
    Math.abs(viewport.x - lastApplied.x) > 0.01
    || Math.abs(viewport.y - lastApplied.y) > 0.01
    || Math.abs(viewport.zoom - lastApplied.zoom) > 0.00001
  );
  const advance = (now: number) => {
    const elapsed = now - lastAdvancedAt;
    if (elapsed <= 0) return;
    // 对数空间指数追随可按时间分段积分，不因输入频率或刷新率反复重启动画。
    logZoom = now - lastInputAt >= WHEEL_TRANSITION_MS
      ? targetLogZoom
      : targetLogZoom + (logZoom - targetLogZoom) * Math.exp(-elapsed / WHEEL_RESPONSE_MS);
    lastAdvancedAt = now;
  };
  const tick = (now: number) => {
    frame = 0;
    // fitView、键盘定位或其他导航已经接管时，旧滚轮不能再把视口拉回。
    const viewport = options.getViewport();
    if (viewportChanged(viewport)) { cancel(); return; }
    advance(now);
    const settled = reducedMotion || now - lastInputAt >= WHEEL_TRANSITION_MS;
    const zoom = settled ? targetZoom : Math.exp(logZoom);
    if (zoom !== viewport.zoom) {
      const next = { x: screen.x - anchor.x * zoom, y: screen.y - anchor.y * zoom, zoom };
      lastApplied = next;
      // 输入事件只计算数值，每帧至多提交一次；默认 duration=0，避免叠加另一层动画。
      void options.setViewport(next);
    }
    if (!settled) frame = requestAnimationFrame(tick);
    else cancel(false);
  };
  const applyWheel = (event: WheelZoomInput) => {
    const target = event.target;
    // ctrl+wheel 包含触控板捏合，继续交由 React Flow；面板和编辑器保留自身滚动。
    if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey
      || event.buttons !== 0 || !Number.isFinite(event.deltaY) || event.deltaY === 0
      || !(target instanceof Element) || target.closest(WHEEL_EXCLUDED)
      || target.closest('.react-flow') !== element) {
      cancel();
      return;
    }
    const viewport = options.getViewport();
    if (!Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (viewportChanged(viewport)) cancel();

    // 8% 是灵敏度基准，不是固定档位；保留细小增量和浏览器合并后的完整输入。
    const units = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? WHEEL_DELTA_PER_NOTCH : 1;
    const delta = event.deltaY * units;
    const nextDirection = Math.sign(delta);
    const inputAt = performance.now();
    const continuing = active && direction === nextDirection;
    // 先把旧目标推进到真实输入时刻，再接收新目标；高刷新率不会少算一段响应。
    if (continuing) advance(inputAt);
    else {
      logZoom = Math.log(viewport.zoom);
      lastAdvancedAt = inputAt;
    }
    // 反向输入从当前显示位置开始，避免先追完旧目标才掉头。
    const base = continuing ? targetZoom : viewport.zoom;
    targetZoom = Math.min(options.maxZoom, Math.max(options.minZoom, base * Math.exp(-delta * WHEEL_SENSITIVITY)));
    if (targetZoom === viewport.zoom) { cancel(); return; }
    targetLogZoom = Math.log(targetZoom);
    direction = nextDirection;
    lastInputAt = inputAt;
    screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    anchor = { x: (screen.x - viewport.x) / viewport.zoom, y: (screen.y - viewport.y) / viewport.zoom };
    lastApplied = viewport;
    if (!active) { active = true; options.onStart(); }
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const interrupt = () => {
    // Date.now 的毫秒精度边界也算作旧输入，避免同毫秒切项目后的回写。
    if (options.nativeMouseWheel) nativeWheelCancelledAt = Date.now() + 1;
    cancel();
  };
  const onWheel = (event: WheelEvent) => {
    if (options.nativeMouseWheel) interrupt();
    else applyWheel(event);
  };
  const onNativeWheel = (event: Event) => {
    if (!(event instanceof CustomEvent) || event.defaultPrevented || !event.cancelable) return;
    const detail = event.detail as Partial<NativeMouseWheelDetail> | null;
    if (!detail || ![detail.xRatio, detail.yRatio, detail.deltaY, detail.issuedAt].every(value => typeof value === 'number' && Number.isFinite(value))) return;
    const { xRatio, yRatio, deltaY, issuedAt } = detail as NativeMouseWheelDetail;
    if (xRatio < 0 || xRatio >= 1 || yRatio < 0 || yRatio >= 1 || deltaY === 0) return;
    if (issuedAt <= nativeWheelCancelledAt || Date.now() - issuedAt > 250 || document.hidden || !document.hasFocus()) {
      // 确认消费过期输入，但不回放原生事件，防止它平移已切换的画布。
      event.preventDefault();
      return;
    }
    const clientX = xRatio * window.innerWidth;
    const clientY = yRatio * window.innerHeight;
    applyWheel({
      target: document.elementFromPoint(clientX, clientY),
      defaultPrevented: false, cancelable: true, ctrlKey: false, metaKey: false, shiftKey: false,
      buttons: 0, deltaY, deltaMode: 0, clientX, clientY,
      preventDefault: () => event.preventDefault(), stopPropagation: () => {},
    });
  };
  const onVisibilityChange = () => { if (document.hidden) interrupt(); };
  if (options.nativeMouseWheel) {
    interrupt();
    window.addEventListener(NATIVE_MOUSE_WHEEL, onNativeWheel);
    window.addEventListener('ai-canvas:native-wheel-cancel', interrupt);
    window.addEventListener('pointerdown', interrupt, { capture: true });
    window.addEventListener('keydown', interrupt, { capture: true });
    // WebKit 原生捏合不一定产生 ctrl+wheel，也可能产生 gesturestart。
    window.addEventListener('gesturestart', interrupt, { capture: true });
  }
  element.addEventListener('wheel', onWheel, { capture: true, passive: false });
  element.addEventListener('pointerdown', interrupt, { capture: true });
  window.addEventListener('blur', interrupt);
  document.addEventListener('visibilitychange', onVisibilityChange);
  return { cancel: interrupt, destroy: () => {
    if (options.nativeMouseWheel) {
      window.removeEventListener(NATIVE_MOUSE_WHEEL, onNativeWheel);
      window.removeEventListener('ai-canvas:native-wheel-cancel', interrupt);
      window.removeEventListener('pointerdown', interrupt, { capture: true });
      window.removeEventListener('keydown', interrupt, { capture: true });
      window.removeEventListener('gesturestart', interrupt, { capture: true });
    }
    element.removeEventListener('wheel', onWheel, { capture: true });
    element.removeEventListener('pointerdown', interrupt, { capture: true });
    window.removeEventListener('blur', interrupt);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    interrupt();
  } };
}

export function useCanvasWheelZoom({ rootRef, cancelRef, enabled, projectId, getViewport, setViewport, onStart, onEnd, minZoom, maxZoom, nativeMouseWheel }: WheelZoomOptions & {
  rootRef: RefObject<HTMLDivElement | null>;
  cancelRef: RefObject<(() => void) | null>;
  enabled: boolean;
  projectId: string | null;
}): void {
  useEffect(() => {
    const element = rootRef.current?.querySelector<HTMLElement>('.react-flow');
    if (!enabled || !element) return;
    const controller = bindCanvasWheelZoom(element, { getViewport, setViewport, onStart, onEnd, minZoom, maxZoom, nativeMouseWheel });
    cancelRef.current = controller.cancel;
    return () => {
      cancelRef.current = null;
      controller.destroy();
    };
  }, [rootRef, cancelRef, enabled, projectId, getViewport, setViewport, onStart, onEnd, minZoom, maxZoom, nativeMouseWheel]);
}
