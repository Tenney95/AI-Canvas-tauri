import { useLayoutEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

const ROW_BUFFER = 2;
const MAX_EAGER_ROWS = 12;
// The editor alone occupies 52 CSS pixels. Layout measures the exact window before first paint.
const MIN_EDITOR_HEIGHT = 52;

interface EditorWindow {
  first: number;
  end: number;
}

/** Read actual row bounds, including varying cinematography/column heights and canvas zoom. */
export function visibleShotlistEditorWindow(
  count: number, viewport: Pick<DOMRect, 'top' | 'bottom'>,
  bounds: (index: number) => Pick<DOMRect, 'top' | 'bottom'>,
): EditorWindow {
  const boundary = (pastBoundary: (index: number) => boolean) => {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pastBoundary(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  return {
    first: Math.max(0, boundary((i) => bounds(i).bottom > viewport.top) - ROW_BUFFER),
    end: Math.min(count, boundary((i) => bounds(i).top >= viewport.bottom) + ROW_BUFFER),
  };
}

/** Window only the heavy editable cells. All rows retain their natural layout and media controls. */
export function useShotlistEditorWindow(
  tableRef: RefObject<HTMLTableElement | null>, count: number, nodeHeight: number, fullscreen: boolean, columns: string,
) {
  const [range, setRange] = useState<EditorWindow>(() => ({
    first: 0, end: Math.ceil(nodeHeight / MIN_EDITOR_HEIGHT) + ROW_BUFFER,
  }));
  const [activeRow, setActiveRow] = useState<string>();
  useLayoutEffect(() => {
    if (count <= MAX_EAGER_ROWS) return;
    const table = tableRef.current;
    const scroll = table?.parentElement;
    const body = table?.tBodies[0];
    if (!table || !scroll || !body) return;
    let lastRange: EditorWindow | undefined;
    const measure = (synchronous: boolean) => {
      const viewport = scroll.getBoundingClientRect();
      if (viewport.bottom <= viewport.top) return;
      const next = visibleShotlistEditorWindow(body.rows.length, viewport,
        (i) => body.rows[i].getBoundingClientRect());
      if (next.first === lastRange?.first && next.end === lastRange.end) return;
      lastRange = next;
      const update = () => setRange((current) => current.first === next.first && current.end === next.end ? current : next);
      if (synchronous) flushSync(update);
      else update();
    };
    const onScroll = () => measure(true);
    const onFocus = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest<HTMLTableRowElement>('tr[data-shot-row-id]');
      if (!row || row.parentElement !== body) return;
      const cell = target.closest('td');
      if (cell && target.matches('[data-shot-editor-placeholder]')) {
        // Tab (including reverse entry from outside the table) lands in the same
        // logical cell once. The original editor takes focus before the next key.
        flushSync(() => setActiveRow(row.dataset.shotRowId));
        cell.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
      } else {
        setActiveRow(row.dataset.shotRowId);
      }
    };
    // Compositor scrolling may bring an offscreen cell under the pointer before the scroll event.
    const onPointerOver = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-shot-editor-placeholder]')) measure(true);
    };
    measure(false);
    const observer = new ResizeObserver(() => measure(true));
    observer.observe(scroll);
    observer.observe(table);
    const rowOrder = new MutationObserver(() => measure(true));
    rowOrder.observe(body, { childList: true });
    scroll.addEventListener('scroll', onScroll, { passive: true });
    table.addEventListener('focusin', onFocus);
    table.addEventListener('pointerover', onPointerOver, true);
    return () => {
      observer.disconnect();
      rowOrder.disconnect();
      scroll.removeEventListener('scroll', onScroll);
      table.removeEventListener('focusin', onFocus);
      table.removeEventListener('pointerover', onPointerOver, true);
    };
  }, [count, fullscreen, columns, tableRef]);

  return { range, activeRow, all: count <= MAX_EAGER_ROWS };
}
