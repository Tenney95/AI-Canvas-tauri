import { ensureCaretSlotBeforeChip, serializeDOM } from './mentionEditorDom';

const CHIP_SELECTOR = '[data-ref-id],[data-asset-path],[data-drama-id],[data-wf-id],[data-skill-id]';

/** 工作流值区保留文字选择，内部引用仍可单独拖动。 */
export function findDraggableMentionChip(root: HTMLElement, target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : null;
  const chip = element?.closest<HTMLElement>(CHIP_SELECTOR);
  if (!chip || !root.contains(chip)) return null;
  const value = element?.closest('.prompt-chip-wf-value');
  return value && chip.contains(value) ? null : chip;
}

/** 命中胶囊时只落在两侧；工作流值区可以接收普通引用，不能嵌套工作流。 */
export function getMentionChipDropRange(root: HTMLElement, source: HTMLElement, x: number, y: number): Range | null {
  const bounds = root.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let range = doc.caretRangeFromPoint?.(x, y) ?? null;
  if (!range) {
    const position = doc.caretPositionFromPoint?.(x, y);
    if (position) {
      range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
    }
  }
  if (!range || !root.contains(range.startContainer)) {
    range = doc.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }
  const container = range.startContainer;
  const element = container.nodeType === Node.ELEMENT_NODE ? container as Element : container.parentElement;
  let chip = element?.closest<HTMLElement>(CHIP_SELECTOR);
  const value = element?.closest('.prompt-chip-wf-value');
  if (value && chip?.contains(value) && !source.hasAttribute('data-wf-id')) chip = null;
  if (chip && root.contains(chip)) {
    const rect = chip.getBoundingClientRect();
    if (x < rect.left + rect.width / 2) range.setStartBefore(chip);
    else range.setStartAfter(chip);
  }
  range.collapse(true);
  return source.contains(range.startContainer) ? null : range;
}

/** 松开时才修改 DOM；取消、外部编辑或移出输入框不会丢失原引用。 */
export function commitMentionChipDrop(root: HTMLElement, source: HTMLElement, range: Range, copy: boolean): boolean {
  if (!root.contains(source) || !root.contains(range.startContainer) || source.contains(range.startContainer)) return false;
  // 外层工作流不能被放进自己的值区，也不能嵌套到另一个工作流中。
  const container = range.startContainer;
  const element = container.nodeType === Node.ELEMENT_NODE ? container as Element : container.parentElement;
  if (source.hasAttribute('data-wf-id') && element?.closest('.prompt-chip-wf-value')) return false;
  const chip = copy ? source.cloneNode(true) as HTMLElement : source;
  chip.classList.remove('is-chip-drag-source');
  range.insertNode(chip);
  ensureCaretSlotBeforeChip(chip);
  range.setStartAfter(chip);
  range.collapse(true);
  root.focus({ preventScroll: true });
  const selection = root.ownerDocument.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

function caretRect(range: Range, root: HTMLElement): { left: number; top: number; height: number } {
  const rect = range.getBoundingClientRect();
  if (rect.height) return rect;
  const container = range.startContainer;
  const offset = range.startOffset;
  const probe = range.cloneRange();
  if (container.nodeType === Node.TEXT_NODE && container.textContent?.length) {
    probe.setStart(container, Math.max(0, offset - 1));
    probe.setEnd(container, Math.min(container.textContent.length, offset || 1));
    const textRect = probe.getBoundingClientRect();
    if (textRect.height) return { left: offset ? textRect.right : textRect.left, top: textRect.top, height: textRect.height };
  } else {
    const next = container.childNodes[offset];
    const previous = container.childNodes[offset - 1];
    const neighbor = next ?? previous;
    if (neighbor) {
      probe.selectNodeContents(neighbor);
      const neighborRect = probe.getBoundingClientRect();
      if (neighborRect.height) return { left: next ? neighborRect.left : neighborRect.right, top: neighborRect.top, height: neighborRect.height };
    }
  }
  const bounds = root.getBoundingClientRect();
  return { left: bounds.left, top: bounds.top, height: parseFloat(getComputedStyle(root).lineHeight) || 20 };
}

interface ChipDragStart {
  root: HTMLElement;
  source: HTMLElement;
  pointerId: number;
  clientX: number;
  clientY: number;
  isCurrent?: () => boolean;
  onCommit: () => void;
}

/** 使用指针会话，兼容开启原生文件拖放的 Tauri WebView。 */
export function startMentionChipDrag({ root, source, pointerId, clientX, clientY, isCurrent = () => true, onCommit }: ChipDragStart): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const initialPrompt = serializeDOM(root);
  const preview = doc.createElement('div');
  preview.className = 'prompt-chip-drag-preview';
  preview.setAttribute('aria-hidden', 'true');
  // 复用节点对话框的顶层引用交互标记，让 Escape 优先取消拖动。
  preview.setAttribute('data-reference-preview-open', '');
  const clone = source.cloneNode(true) as HTMLElement;
  preview.appendChild(clone);
  const marker = doc.createElement('div');
  marker.className = 'prompt-chip-drop-caret';
  marker.setAttribute('aria-hidden', 'true');
  let active = false;
  let ended = false;
  let copy = false;
  let x = clientX;
  let y = clientY;
  let frame = 0;
  const capture = { capture: true };
  const valid = () => root.isConnected && root.contains(source) && isCurrent();
  const finish = () => {
    if (ended) return;
    ended = true;
    win.cancelAnimationFrame(frame);
    win.removeEventListener('pointermove', move, capture);
    win.removeEventListener('pointerup', up, capture);
    win.removeEventListener('pointercancel', cancel, capture);
    win.removeEventListener('blur', finish);
    doc.removeEventListener('keydown', key, capture);
    doc.removeEventListener('keyup', key, capture);
    source.classList.remove('is-chip-drag-source');
    root.classList.remove('is-chip-dragging', 'is-chip-copying');
    preview.remove();
    marker.remove();
  };
  const update = () => {
    frame = 0;
    if (ended) return;
    if (!valid()) { finish(); return; }
    preview.style.left = `${x + 12}px`;
    preview.style.top = `${y + 12}px`;
    root.classList.toggle('is-chip-copying', copy);
    preview.classList.toggle('is-copy', copy);
    const range = getMentionChipDropRange(root, source, x, y);
    marker.hidden = !range;
    if (range) {
      const rect = caretRect(range, root);
      marker.style.left = `${rect.left}px`;
      marker.style.top = `${rect.top}px`;
      marker.style.height = `${rect.height}px`;
      const bounds = root.getBoundingClientRect();
      const delta = y < bounds.top + 20 ? -8 : y > bounds.bottom - 20 ? 8 : 0;
      if (delta && root.scrollHeight > root.clientHeight) {
        const previousScroll = root.scrollTop;
        root.scrollTop += delta;
        if (root.scrollTop !== previousScroll) frame = win.requestAnimationFrame(update);
      }
    }
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId || ended) return;
    x = event.clientX;
    y = event.clientY;
    copy = event.ctrlKey || event.altKey;
    if (!active && Math.hypot(x - clientX, y - clientY) < 4) return;
    event.preventDefault();
    event.stopPropagation();
    if (!active) {
      active = true;
      doc.body.append(preview, marker);
      source.classList.add('is-chip-drag-source');
      root.classList.add('is-chip-dragging');
    }
    win.cancelAnimationFrame(frame);
    update();
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointerId || ended) return;
    event.preventDefault();
    event.stopPropagation();
    const range = active && valid() && serializeDOM(root) === initialPrompt
      ? getMentionChipDropRange(root, source, event.clientX, event.clientY) : null;
    finish();
    if (range && commitMentionChipDrop(root, source, range, event.ctrlKey || event.altKey)) onCommit();
  };
  const cancel = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(); };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish();
    } else if (active && (event.key === 'Control' || event.key === 'Alt')) {
      event.preventDefault();
      event.stopPropagation();
      copy = event.ctrlKey || event.altKey;
      win.cancelAnimationFrame(frame);
      update();
    }
  };
  win.addEventListener('pointermove', move, capture);
  win.addEventListener('pointerup', up, capture);
  win.addEventListener('pointercancel', cancel, capture);
  win.addEventListener('blur', finish);
  doc.addEventListener('keydown', key, capture);
  doc.addEventListener('keyup', key, capture);
  return finish;
}
