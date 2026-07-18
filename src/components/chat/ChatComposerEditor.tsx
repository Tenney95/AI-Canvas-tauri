import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';

export type ChatComposerReference =
  | { kind: 'node'; id: string; label: string; displayId?: number }
  | { kind: 'model'; id: string; label: string }
  | { kind: 'skill'; id: string; label: string };

export interface ChatComposerEditorHandle {
  focus: () => void;
  insertReference: (reference: ChatComposerReference) => void;
}

interface ChatComposerEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  nodeDisplayIds: ReadonlyMap<string, number | undefined>;
  onMentionQueryChange: (query: string | null) => void;
  onSlashQueryChange: (query: string | null) => void;
  placeholder: string;
  disabled?: boolean;
}

type ParsedReference = ChatComposerReference & { raw: string };

const ZWSP = '\u200B';
const REFERENCE_PATTERN = /@\{([^:}\r\n]+):([^}\r\n]+)\}|@model\{([^|}\r\n]+)\|([^}\r\n]*)\}|@skill\{([^|}\r\n]+)\|([^}\r\n]*)\}/g;
const REFERENCE_TEXT_PATTERN = /@\{[^:}\r\n]+:[^}\r\n]+\}|@model\{[^|}\r\n]+\|[^}\r\n]*\}|@skill\{[^|}\r\n]+\|[^}\r\n]*\}/;

function decodeLabel(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeLabel(value: string): string {
  return value.replace(/}/g, '').trim();
}

function serializeReference(reference: ChatComposerReference): string {
  if (reference.kind === 'node') {
    return `@{${reference.id}:${sanitizeLabel(reference.label) || '节点'}}`;
  }
  if (reference.kind === 'model') {
    return `@model{${reference.id}|${sanitizeLabel(reference.label) || '模型'}}`;
  }
  return `@skill{${reference.id}|${encodeURIComponent(reference.label)}}`;
}

function parseReference(match: RegExpExecArray, nodeDisplayIds: ReadonlyMap<string, number | undefined>): ParsedReference {
  const raw = match[0];
  if (match[1] !== undefined) {
    return {
      kind: 'node',
      id: match[1],
      label: match[2],
      displayId: nodeDisplayIds.get(match[1]),
      raw,
    };
  }
  if (match[3] !== undefined) {
    return {
      kind: 'model',
      id: match[3],
      label: match[4] || '模型',
      raw,
    };
  }
  return {
    kind: 'skill',
    id: match[5],
    label: decodeLabel(match[6]) || 'Skill',
    raw,
  };
}

function isReferenceElement(node: Node | null | undefined): node is HTMLElement {
  return !!node
    && node.nodeType === Node.ELEMENT_NODE
    && (node as HTMLElement).hasAttribute('data-chat-reference');
}

function isBreakElement(node: Node | null | undefined): boolean {
  return !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR';
}

function ensureCaretSlotBefore(referenceElement: HTMLElement): void {
  const previous = referenceElement.previousSibling;
  if (!previous || isBreakElement(previous) || isReferenceElement(previous)) {
    referenceElement.parentNode?.insertBefore(document.createTextNode(ZWSP), referenceElement);
  }
}

function buildReferenceElement(reference: ParsedReference): HTMLSpanElement {
  const element = document.createElement('span');
  element.contentEditable = 'false';
  element.setAttribute('data-chat-reference', reference.kind);
  element.setAttribute('data-chat-reference-raw', reference.raw);
  element.setAttribute('aria-label', reference.kind === 'node'
    ? `节点 ${reference.label}${reference.displayId != null ? `，编号 ${reference.displayId}` : ''}`
    : reference.kind === 'model'
      ? `模型 ${reference.label}`
      : `Skill ${reference.label}`);
  element.className = `mx-0.5 inline-flex max-w-[min(100%,18rem)] select-none items-center align-middle
    rounded-[7px] border px-2 py-1 text-[12px] font-medium leading-none shadow-sm
    ${reference.kind === 'node'
      ? 'border-indigo-400/25 bg-indigo-400/10 text-indigo-100'
      : reference.kind === 'model'
        ? 'border-sky-400/25 bg-sky-400/10 text-sky-100'
        : 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100'}`;

  const accent = document.createElement('span');
  accent.setAttribute('aria-hidden', 'true');
  accent.className = `mr-1.5 h-3 w-0.5 shrink-0 rounded-full ${reference.kind === 'node'
    ? 'bg-indigo-300/70'
    : reference.kind === 'model'
      ? 'bg-sky-300/70'
      : 'bg-emerald-300/70'}`;
  element.appendChild(accent);

  const label = document.createElement('span');
  label.className = 'max-w-[12rem] truncate';
  label.textContent = reference.kind === 'skill' ? `/${reference.label}` : reference.label;
  element.appendChild(label);

  if (reference.kind === 'node' && reference.displayId != null) {
    const displayId = document.createElement('span');
    displayId.className = 'ml-1.5 shrink-0 border-l border-indigo-300/20 pl-1.5 text-[10px] font-semibold tabular-nums text-indigo-200/65';
    displayId.textContent = `#${reference.displayId}`;
    element.appendChild(displayId);
  }
  return element;
}

function appendText(nodes: Node[], value: string): void {
  if (!value) return;
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) nodes.push(document.createElement('br'));
    if (line) nodes.push(document.createTextNode(line));
  });
}

function renderValue(value: string, nodeDisplayIds: ReadonlyMap<string, number | undefined>): Node[] {
  const nodes: Node[] = [];
  let cursor = 0;
  for (const match of value.matchAll(REFERENCE_PATTERN)) {
    const start = match.index;
    if (start == null) continue;
    appendText(nodes, value.slice(cursor, start));
    const referenceElement = buildReferenceElement(parseReference(match, nodeDisplayIds));
    const previous = nodes[nodes.length - 1];
    if (!previous || isBreakElement(previous) || isReferenceElement(previous)) {
      nodes.push(document.createTextNode(ZWSP));
    }
    nodes.push(referenceElement);
    cursor = start + match[0].length;
  }
  appendText(nodes, value.slice(cursor));
  return nodes;
}

function serializeEditor(root: HTMLElement): string {
  let value = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      value += (node.textContent || '').split(ZWSP).join('');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    const rawReference = element.getAttribute('data-chat-reference-raw');
    if (rawReference != null) {
      value += rawReference;
      return;
    }
    if (element.tagName === 'BR') {
      value += '\n';
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return value;
}

function containsUndecoratedReference(root: HTMLElement): boolean {
  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      return REFERENCE_TEXT_PATTERN.test(node.textContent || '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE || isReferenceElement(node)) return false;
    return Array.from(node.childNodes).some(visit);
  };
  return Array.from(root.childNodes).some(visit);
}

function placeCaretAtEnd(root: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function resolveTextCaret(range: Range): { node: Text; offset: number } | null {
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    return { node: range.startContainer as Text, offset: range.startOffset };
  }
  if (range.startContainer.nodeType !== Node.ELEMENT_NODE || range.startOffset === 0) return null;

  let candidate: Node | null = range.startContainer.childNodes[range.startOffset - 1] ?? null;
  while (candidate?.nodeType === Node.ELEMENT_NODE && !isReferenceElement(candidate)) {
    candidate = candidate.lastChild;
  }
  if (candidate?.nodeType !== Node.TEXT_NODE) return null;
  return { node: candidate as Text, offset: candidate.textContent?.length ?? 0 };
}

const ChatComposerEditor = forwardRef<ChatComposerEditorHandle, ChatComposerEditorProps>(function ChatComposerEditor({
  value,
  onChange,
  onSubmit,
  nodeDisplayIds,
  onMentionQueryChange,
  onSlashQueryChange,
  placeholder,
  disabled = false,
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastRangeRef = useRef<Range | null>(null);
  const triggerRangeRef = useRef<Range | null>(null);

  const emitValue = useCallback(() => {
    if (editorRef.current) onChange(serializeEditor(editorRef.current));
  }, [onChange]);

  const captureSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.startContainer)) lastRangeRef.current = range.cloneRange();
  }, []);

  const detectTrigger = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const caret = selection.getRangeAt(0);
    const textCaret = resolveTextCaret(caret);
    if (!editor.contains(caret.startContainer) || !textCaret) {
      triggerRangeRef.current = null;
      onMentionQueryChange(null);
      onSlashQueryChange(null);
      return;
    }

    const textBeforeCaret = (textCaret.node.textContent || '').slice(0, textCaret.offset);
    const mention = /@([^\s@]*)$/.exec(textBeforeCaret);
    const slash = /(?:^|\s)\/([^\s/]*)$/.exec(textBeforeCaret);
    const trigger = mention ?? slash;
    if (!trigger) {
      triggerRangeRef.current = null;
      onMentionQueryChange(null);
      onSlashQueryChange(null);
      return;
    }

    const replacement = caret.cloneRange();
    replacement.setStart(textCaret.node, textCaret.offset - trigger[0].trimStart().length);
    triggerRangeRef.current = replacement;
    if (mention) {
      onMentionQueryChange(mention[1]);
      onSlashQueryChange(null);
    } else {
      onMentionQueryChange(null);
      onSlashQueryChange(slash?.[1] ?? '');
    }
  }, [onMentionQueryChange, onSlashQueryChange]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const serializedValue = serializeEditor(editor);
    if (serializedValue === value && !containsUndecoratedReference(editor)) return;

    const hadFocus = document.activeElement === editor;
    editor.innerHTML = '';
    for (const node of renderValue(value, nodeDisplayIds)) editor.appendChild(node);
    if (hadFocus) placeCaretAtEnd(editor);
  }, [nodeDisplayIds, value]);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    insertReference: (reference) => {
      const editor = editorRef.current;
      if (!editor || disabled) return;
      editor.focus();

      const selection = window.getSelection();
      const savedRange = triggerRangeRef.current ?? lastRangeRef.current;
      const range = savedRange && editor.contains(savedRange.startContainer)
        ? savedRange.cloneRange()
        : document.createRange();
      if (!savedRange || !editor.contains(savedRange.startContainer)) {
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      range.deleteContents();

      const raw = serializeReference(reference);
      const chip = buildReferenceElement({ ...reference, raw });
      range.insertNode(chip);
      ensureCaretSlotBefore(chip);
      const spacer = document.createTextNode(' ');
      chip.parentNode?.insertBefore(spacer, chip.nextSibling);
      range.setStart(spacer, 1);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      lastRangeRef.current = range.cloneRange();
      triggerRangeRef.current = null;
      onMentionQueryChange(null);
      onSlashQueryChange(null);
      emitValue();
    },
  }), [disabled, emitValue, onMentionQueryChange, onSlashQueryChange]);

  const handleInput = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!editor.textContent && !editor.querySelector('[data-chat-reference]')) editor.innerHTML = '';
    captureSelection();
    detectTrigger();
    emitValue();
  }, [captureSelection, detectTrigger, emitValue]);

  const removeAdjacentReference = useCallback((direction: 'before' | 'after'): boolean => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !editor.contains(range.startContainer)) return false;

    let candidate: Node | null = null;
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const text = range.startContainer.textContent || '';
      if (direction === 'before' && range.startOffset === 0) candidate = range.startContainer.previousSibling;
      if (direction === 'after' && range.startOffset === text.length) candidate = range.startContainer.nextSibling;
    } else if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
      candidate = direction === 'before'
        ? range.startContainer.childNodes[range.startOffset - 1] ?? null
        : range.startContainer.childNodes[range.startOffset] ?? null;
    }
    if (!isReferenceElement(candidate)) return false;

    const previous = candidate.previousSibling;
    candidate.remove();
    if (previous?.nodeType === Node.TEXT_NODE && previous.textContent === ZWSP) previous.remove();
    emitValue();
    return true;
  }, [emitValue]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!disabled && value.trim()) onSubmit();
      return;
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const lineBreak = document.createElement('br');
      const caretSlot = document.createTextNode(ZWSP);
      range.insertNode(lineBreak);
      lineBreak.parentNode?.insertBefore(caretSlot, lineBreak.nextSibling);
      range.setStart(caretSlot, 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      emitValue();
      return;
    }
    if (event.key === 'Backspace' && removeAdjacentReference('before')) event.preventDefault();
    if (event.key === 'Delete' && removeAdjacentReference('after')) event.preventDefault();
  }, [disabled, emitValue, onSubmit, removeAdjacentReference, value]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const text = document.createTextNode(event.clipboardData.getData('text/plain'));
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    handleInput();
  }, [handleInput]);

  return (
    <div className="relative min-h-[64px] max-h-[160px]">
      {!value && (
        <span className="pointer-events-none absolute inset-x-0 top-0 text-[13px] leading-5 text-canvas-text-muted">
          {placeholder}
        </span>
      )}
      <div
        ref={editorRef}
        role="textbox"
        aria-label="对话消息"
        aria-multiline="true"
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onKeyUp={captureSelection}
        onMouseUp={captureSelection}
        onPaste={handlePaste}
        onBlur={emitValue}
        className={`chat-panel-textarea relative z-10 block w-full min-h-[64px] max-h-[160px]
          overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[15px] leading-6 text-canvas-text
          outline-none selection:bg-indigo-400/25 rounded-[8px] ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      />
    </div>
  );
});

export default ChatComposerEditor;
