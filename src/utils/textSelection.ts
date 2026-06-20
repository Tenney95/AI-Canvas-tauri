/**
 * textSelection — 判断当前是否存在「文本节点选中模式」内的有效文本选区
 *
 * 仅当选区非空、且其锚点位于一个正处于选中模式（.text-output-content.is-selecting）
 * 的元素内时才返回 true。这样：
 *  - 用户在选中模式里选了文本 → 复制/右键走「文本复制」；
 *  - 用户已退出选中模式（.is-selecting 已移除）→ 即便 DOM 里残留旧选区，也走「节点复制」。
 */
export interface ActiveTextSelection {
  text: string;
  start: number;
  end: number;
}

function getTextOffset(container: Element, targetNode: Node, targetOffset: number): number | null {
  try {
    const range = document.createRange();
    range.selectNodeContents(container);
    range.setEnd(targetNode, targetOffset);
    return range.toString().length;
  } catch {
    return null;
  }
}

export function getActiveTextSelection(): ActiveTextSelection | null {
  if (typeof window === 'undefined') return null;
  const sel = window.getSelection();
  const text = sel?.toString() ?? '';
  if (!sel || sel.isCollapsed || !text.trim() || sel.rangeCount === 0) return null;
  const anchor = sel.anchorNode;
  const el = anchor
    ? (anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement)
    : null;
  const container = el?.closest('.text-output-content.is-selecting');
  if (!container) return null;

  const range = sel.getRangeAt(0);
  const start = getTextOffset(container, range.startContainer, range.startOffset);
  const end = getTextOffset(container, range.endContainer, range.endOffset);
  if (start == null || end == null || start === end) return null;

  return {
    text,
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

export function hasActiveTextSelection(): boolean {
  return getActiveTextSelection() != null;
}
