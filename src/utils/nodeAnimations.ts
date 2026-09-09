/**
 * nodeAnimations — 画布节点进出场动画辅助
 *
 * React Flow 在外层 `.react-flow__node` 上用内联 transform 定位，
 * 因此动画只作用于内层 `.node` 元素（缩放/透明度），或者用独立的 scale / translate
 * 属性叠加到外层（与内联 transform 互不覆盖）——绝不直接改外层 transform，
 * 否则节点会跳回原点。
 */

/** 节点退场动画时长（ms），需与 CSS .node-exiting 过渡一致。偏短以保持删除手感跟手 */
const NODE_EXIT_MS = 130;
/** 定位到节点后的聚焦脉冲时长（ms） */
const NODE_FOCUS_PULSE_MS = 520;
const pendingNodeExits = new Set<Promise<void>>();

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * 给一组节点播放退场动画，返回动画结束后 resolve 的 Promise。
 * 调用方在 Promise resolve 后再真正从状态中移除节点。
 * 找不到 DOM 元素或开启「减少动效」时立即 resolve（即时删除）。
 */
export function playNodeExit(ids: string[]): Promise<void> {
  if (typeof document === 'undefined' || ids.length === 0) return Promise.resolve();
  if (prefersReducedMotion()) return Promise.resolve();

  const inners: HTMLElement[] = [];
  for (const id of ids) {
    const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
    const wrapper = document.querySelector(`.react-flow__node[data-id="${safeId}"]`);
    const inner = wrapper?.querySelector<HTMLElement>('.node');
    if (inner) inners.push(inner);
  }

  if (inners.length === 0) return Promise.resolve();

  inners.forEach((el) => el.classList.add('node-exiting'));
  const exit = new Promise<void>((resolve) => setTimeout(resolve, NODE_EXIT_MS));
  pendingNodeExits.add(exit);
  void exit.then(() => pendingNodeExits.delete(exit));
  return exit;
}

/**
 * 定位到节点后播放一次「放大 → 回弹」非线性脉冲。
 *
 * 只动内层 .node：外层 .react-flow__node 的 transform 是 React Flow 用来定位的
 * translate(x, y)，而独立 scale 属性作用在这条 transform 之外，会把它一起放大
 * （s * (x, y)），节点会被甩出一大段；内层元素自身没有位移，缩放就是原地脉冲。
 * 用独立 scale 属性而不是 transform，避免覆盖 .node 上拖拽抬起的 scale(1.03)。
 */
export function playNodeFocusPulse(id: string): void {
  if (typeof document === 'undefined' || !id) return;
  if (prefersReducedMotion()) return;

  const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  const element = document
    .querySelector(`.react-flow__node[data-id="${safeId}"]`)
    ?.querySelector<HTMLElement>('.node');
  if (!element || typeof element.animate !== 'function') return;

  const supportsScaleProperty =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('scale', '1.05');

  const steps: { value: number; offset: number; easing: string }[] = [
    { value: 1, offset: 0, easing: 'cubic-bezier(0.22, 1.28, 0.36, 1)' },
    { value: 1.08, offset: 0.32, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
    { value: 0.974, offset: 0.64, easing: 'cubic-bezier(0.33, 0, 0.2, 1)' },
    { value: 1, offset: 1, easing: 'linear' },
  ];
  const keyframes = steps.map(({ value, offset, easing }) =>
    supportsScaleProperty
      ? { scale: String(value), offset, easing }
      : { transform: `scale(${value})`, offset, easing },
  );

  element.animate(keyframes, { duration: NODE_FOCUS_PULSE_MS });
}

/** 等待所有已开始的节点退场动画及其删除回调完成。 */
export async function waitForPendingNodeExits(): Promise<void> {
  while (pendingNodeExits.size > 0) {
    await Promise.allSettled([...pendingNodeExits]);
  }
  // playNodeExit 的调用方通过 .then() 落删除状态，让这些回调先完成。
  await Promise.resolve();
}
