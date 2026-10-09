import { useEffect, useRef, type RefObject } from 'react';

interface DialogFocusOptions {
  zIndex?: number;
  escapeOnKeyUp?: boolean;
}

interface DialogEntry extends DialogFocusOptions {
  panel: HTMLElement;
  previousFocus: HTMLElement | null;
  onClose: () => void;
  zIndex: number;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex], [contenteditable="true"], audio[controls], video[controls]';
interface DialogStack {
  entries: DialogEntry[];
  closedOnKeyDown: boolean;
}

const dialogStacks = new WeakMap<Document, DialogStack>();

function topDialog(stack: DialogEntry[]) {
  return stack.reduce<DialogEntry | undefined>((top, entry) => (
    !top || entry.zIndex >= top.zIndex ? entry : top
  ), undefined);
}

function focusableElements(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => (
    element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]')
    && element.getClientRects().length > 0
  ));
}

function focusFirst(entry: DialogEntry) {
  (focusableElements(entry.panel)[0] ?? entry.panel).focus({ preventScroll: true });
}

/** 按实际层级圈定焦点；Portal 子弹窗关闭后恢复到仍活动的父弹窗。 */
export function bindDialogFocus(panel: HTMLElement, onClose: () => void, options: DialogFocusOptions = {}) {
  const doc = panel.ownerDocument;
  const state = dialogStacks.get(doc) ?? { entries: [], closedOnKeyDown: false };
  dialogStacks.set(doc, state);
  const stack = state.entries;
  const entry: DialogEntry = {
    ...options,
    panel,
    onClose,
    zIndex: options.zIndex ?? (Number(doc.defaultView?.getComputedStyle(panel).zIndex) || 0),
    previousFocus: doc.activeElement instanceof HTMLElement ? doc.activeElement : null,
  };
  stack.push(entry);
  const focusFrame = requestAnimationFrame(() => {
    if (topDialog(stack) === entry && !panel.contains(doc.activeElement)) focusFirst(entry);
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    if (topDialog(stack) !== entry || event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat && !state.closedOnKeyDown && !entry.escapeOnKeyUp) {
        state.closedOnKeyDown = true;
        entry.onClose();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(panel);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
    } else if (event.shiftKey && (doc.activeElement === first || !panel.contains(doc.activeElement))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (doc.activeElement === last || !panel.contains(doc.activeElement))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };
  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    // 即使关闭回调同步卸载子层，本次释放也不能继续关闭刚露出的父层。
    if (state.closedOnKeyDown) {
      state.closedOnKeyDown = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (topDialog(stack) === entry && entry.escapeOnKeyUp) {
      event.preventDefault();
      event.stopImmediatePropagation();
      entry.onClose();
    }
  };
  doc.addEventListener('keydown', handleKeyDown, true);
  doc.addEventListener('keyup', handleKeyUp, true);

  return () => {
    cancelAnimationFrame(focusFrame);
    const wasTop = topDialog(stack) === entry;
    const index = stack.indexOf(entry);
    if (index < 0) return;
    stack.splice(index, 1);
    // 父层先被卸载时，子层不能把焦点恢复到已经关闭的父层。
    for (const remaining of stack) {
      if (entry.panel.contains(remaining.previousFocus)) remaining.previousFocus = entry.previousFocus;
    }
    doc.removeEventListener('keydown', handleKeyDown, true);
    doc.removeEventListener('keyup', handleKeyUp, true);
    if (stack.length === 0) dialogStacks.delete(doc);
    if (!wasTop) return;
    const top = topDialog(stack);
    if (entry.previousFocus?.isConnected && (!top || top.panel.contains(entry.previousFocus))) {
      entry.previousFocus.focus({ preventScroll: true });
    } else if (top) focusFirst(top);
  };
}

export function useDialogFocus(
  isOpen: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  { zIndex, escapeOnKeyUp = false }: DialogFocusOptions = {},
) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!isOpen || !panel) return;
    return bindDialogFocus(panel, () => onCloseRef.current(), { zIndex, escapeOnKeyUp });
  }, [escapeOnKeyUp, isOpen, panelRef, zIndex]);
}
