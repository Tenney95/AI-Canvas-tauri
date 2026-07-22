/**
 * nodeAnimations — 画布节点进出场动画辅助
 *
 * React Flow 在外层 `.react-flow__node` 上用内联 transform 定位，
 * 因此动画只作用于内层 `.node` 元素（缩放/透明度），绝不碰外层 transform，
 * 否则节点会跳回原点。
 */

/** 节点退场动画时长（ms），需与 CSS .node-exiting 过渡一致。偏短以保持删除手感跟手 */
const NODE_EXIT_MS = 130;
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

/** 等待所有已开始的节点退场动画及其删除回调完成。 */
export async function waitForPendingNodeExits(): Promise<void> {
  while (pendingNodeExits.size > 0) {
    await Promise.allSettled([...pendingNodeExits]);
  }
  // playNodeExit 的调用方通过 .then() 落删除状态，让这些回调先完成。
  await Promise.resolve();
}
