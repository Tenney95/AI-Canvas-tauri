/** 提示词编辑器的临时历史；仅保存当前编辑器 DOM，不进入 Store 或持久化。 */
interface SelectionPoint {
  path: number[];
  offset: number;
}

interface EditorSelection {
  anchor: SelectionPoint;
  focus: SelectionPoint;
}

export interface MentionEditorSnapshot {
  prompt: string;
  markup: string;
  content: Node[];
  selection: EditorSelection | null;
}

const MAX_ENTRIES = 100;
// 同时限制条目数与 DOM 源文本总量，避免引用缩略图等数据无限累积。
const MAX_MARKUP_CHARS = 2 * 1024 * 1024;
const INPUT_GROUP_MS = 750;

function selectionPoint(root: HTMLElement, node: Node | null, offset: number): SelectionPoint | null {
  if (!node || !root.contains(node)) return null;
  const path: number[] = [];
  let current = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.from(parent.childNodes).indexOf(current as ChildNode));
    current = parent;
  }
  return { path, offset };
}

export function captureMentionEditorSelection(root: HTMLElement): EditorSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return null;
  const anchor = selectionPoint(root, selection.anchorNode, selection.anchorOffset);
  const focus = selectionPoint(root, selection.focusNode, selection.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
}

export function captureMentionEditorSnapshot(root: HTMLElement, prompt: string): MentionEditorSnapshot {
  return {
    prompt,
    markup: root.innerHTML,
    content: Array.from(root.childNodes, (node) => node.cloneNode(true)),
    selection: captureMentionEditorSelection(root),
  };
}

export function restoreMentionEditorSnapshot(root: HTMLElement, snapshot: MentionEditorSnapshot): void {
  root.replaceChildren(...snapshot.content.map((node) => node.cloneNode(true)));
  const resolve = (point: SelectionPoint): { node: Node; offset: number } | null => {
    let node: Node = root;
    for (const index of point.path) {
      const child = node.childNodes[index];
      if (!child) return null;
      node = child;
    }
    const length = node.nodeType === 3 ? (node.textContent ?? '').length : node.childNodes.length;
    return { node, offset: Math.min(point.offset, length) };
  };
  const anchor = snapshot.selection && resolve(snapshot.selection.anchor);
  const focus = snapshot.selection && resolve(snapshot.selection.focus);
  const anchorElement = anchor?.node.nodeType === 1 ? anchor.node as HTMLElement : anchor?.node.parentElement;
  const valueArea = anchorElement?.closest<HTMLElement>('.prompt-chip-wf-value');
  (valueArea ?? root).focus({ preventScroll: true });
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  if (anchor && focus) {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  } else {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

export class MentionEditorHistory {
  private entries: MentionEditorSnapshot[] = [];
  private index = -1;
  private group: string | null = null;
  private lastInputAt = 0;

  get current(): MentionEditorSnapshot | undefined {
    return this.entries[this.index];
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
    this.endGroup();
  }

  reset(snapshot: MentionEditorSnapshot): void {
    this.clear();
    this.entries = [snapshot];
    this.index = 0;
  }

  endGroup(): void {
    this.group = null;
    this.lastInputAt = 0;
  }

  updateSelection(selection: EditorSelection | null): void {
    const current = this.current;
    if (!current || !selection) return;
    if (JSON.stringify(selection) !== JSON.stringify(current.selection)) this.endGroup();
    current.selection = selection;
  }

  /** 同一提示词的 DOM 标签/编号刷新无需增加撤销步骤。 */
  refresh(snapshot: MentionEditorSnapshot): void {
    if (!this.current) this.reset(snapshot);
    else {
      if (!snapshot.selection && snapshot.markup === this.current.markup) snapshot.selection = this.current.selection;
      this.entries[this.index] = snapshot;
    }
  }

  record(snapshot: MentionEditorSnapshot, group: string | null = null, now = Date.now()): void {
    const current = this.current;
    if (!current) {
      this.reset(snapshot);
      return;
    }
    if (current.markup === snapshot.markup && current.prompt === snapshot.prompt) {
      current.selection = snapshot.selection ?? current.selection;
      if (!group) this.endGroup();
      return;
    }
    const merge = group !== null && group === this.group && now - this.lastInputAt <= INPUT_GROUP_MS
      && this.index > 0 && this.index === this.entries.length - 1;
    this.entries.length = this.index + 1;
    if (merge) this.entries[this.index] = snapshot;
    else {
      this.entries.push(snapshot);
      this.index += 1;
    }
    this.group = group;
    this.lastInputAt = now;
    let markupChars = this.entries.reduce((total, entry) => total + entry.markup.length, 0);
    while (this.entries.length > 1 && (this.entries.length > MAX_ENTRIES || markupChars > MAX_MARKUP_CHARS)) {
      markupChars -= this.entries.shift()!.markup.length;
      this.index -= 1;
    }
  }

  undo(): MentionEditorSnapshot | undefined {
    this.endGroup();
    if (this.index <= 0) return undefined;
    this.index -= 1;
    return this.current;
  }

  redo(): MentionEditorSnapshot | undefined {
    this.endGroup();
    if (this.index >= this.entries.length - 1) return undefined;
    this.index += 1;
    return this.current;
  }
}
