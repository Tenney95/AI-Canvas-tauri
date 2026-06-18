/**
 * textSelection — 判断当前是否存在「文本节点选中模式」内的有效文本选区
 *
 * 仅当选区非空、且其锚点位于一个正处于选中模式（.text-output-content.is-selecting）
 * 的元素内时才返回 true。这样：
 *  - 用户在选中模式里选了文本 → 复制/右键走「文本复制」；
 *  - 用户已退出选中模式（.is-selecting 已移除）→ 即便 DOM 里残留旧选区，也走「节点复制」。
 */
export function hasActiveTextSelection(): boolean {
  if (typeof window === 'undefined') return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
  const anchor = sel.anchorNode;
  const el = anchor
    ? (anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement)
    : null;
  return !!el?.closest('.text-output-content.is-selecting');
}
