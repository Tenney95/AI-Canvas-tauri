import { calcAnchoredPosition } from '../../utils/popupPosition';

/** 先把菜单贴到按钮旁，滚动或尺寸变化时再跟着调整。 */
export function trackModelMenuPosition(trigger: HTMLElement, menu: HTMLElement): () => void {
  const update = () => {
    const rect = trigger.getBoundingClientRect();
    const availableHeight = Math.max(rect.top - 12, window.innerHeight - rect.bottom - 12, 0);
    menu.style.width = `${Math.min(380, Math.max(0, window.innerWidth - 16))}px`;
    menu.style.maxHeight = `${Math.min(360, availableHeight)}px`;
    let layer = 300;
    for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
      const value = Number.parseInt(window.getComputedStyle(parent).zIndex, 10);
      if (Number.isFinite(value)) layer = Math.max(layer, value + 1);
    }
    menu.style.zIndex = String(layer);
    const position = calcAnchoredPosition(rect, menu.offsetWidth, menu.offsetHeight, 4, 8);
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    menu.dataset.placement = position.placement;
  };

  update();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  observer?.observe(menu);
  observer?.observe(trigger);
  window.addEventListener('resize', update);
  document.addEventListener('scroll', update, true);
  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', update);
    document.removeEventListener('scroll', update, true);
  };
}
