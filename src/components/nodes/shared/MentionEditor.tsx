import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { WorkflowIONodeType } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { Icon } from '@iconify/react';

// ── Props ──
export interface MentionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  nodeId?: string;
  selectedWorkflowId?: string;
  canSubmit?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
}

// ── Chip color config per node type ──
const CHIP_STYLE: Record<string, string> = {
  'ai-text': 'chip-text',
  'ai-image': 'chip-image',
  'ai-video': 'chip-video',
  'ai-audio': 'chip-audio',
};

const NODE_ICON: Record<string, string> = {
  'ai-text': 'T',
  'ai-image': 'I',
  'ai-video': 'V',
  'ai-audio': 'A',
};

// ── Workflow IO node chip color/icon per IONodeType ──
const WF_IO_STYLE: Record<string, string> = {
  prompt: 'chip-workflow-prompt',
  image: 'chip-workflow-image',
  video: 'chip-workflow-video',
  audio: 'chip-workflow-audio',
};
const WF_IO_ICON: Record<string, string> = {
  prompt: 'T',
  image: 'I',
  video: 'V',
  audio: 'A',
};

// ═══════════════════════════════════════════════
// DOM ↔ String helpers
// ═══════════════════════════════════════════════

/** Serialize contenteditable DOM back to @{id:label} / @wf{id|title|type} marker string (pipe-separated to avoid ambiguity with `:` in node IDs). */
function serializeDOM(root: HTMLElement): string {
  let result = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.hasAttribute('data-ref-id')) {
        const id = el.getAttribute('data-ref-id') || '';
        const label = el.getAttribute('data-ref-label') || '';
        result += `@{${id}:${label}}`;
      } else if (el.hasAttribute('data-wf-id')) {
        const id = el.getAttribute('data-wf-id') || '';
        const title = el.getAttribute('data-wf-title') || '';
        const type = el.getAttribute('data-wf-type') || 'prompt';
        result += `@wf{${id}|${title}|${type}}(`;
        const valueEl = el.querySelector('.prompt-chip-wf-value');
        if (valueEl) {
          for (const child of Array.from(valueEl.childNodes)) walk(child);
        }
        result += ')';
      } else if (el.tagName === 'BR') {
        result += '\n';
      } else {
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    }
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return result.replace(/\n+$/, '');
}

/** Build a chip <span contenteditable="false"> for a canvas node reference. */
function buildChipEl(
  nodeId: string,
  label: string,
  metaMap: Map<string, { type: string; displayId: number | undefined }>,
): HTMLSpanElement {
  const meta = metaMap.get(nodeId);
  const nodeType = meta?.type || 'ai-text';
  const displayId = meta?.displayId;
  const chipClass = CHIP_STYLE[nodeType] || CHIP_STYLE['ai-text'];
  const icon = NODE_ICON[nodeType] || '?';

  const span = document.createElement('span');
  span.className = `prompt-chip ${chipClass}`;
  span.contentEditable = 'false';
  span.setAttribute('data-ref-id', nodeId);
  span.setAttribute('data-ref-label', label);
  span.innerHTML =
    `<span class="prompt-chip-icon">${icon}</span>` +
    (displayId != null ? `<span class="prompt-chip-id">#${displayId}</span>` : '');
  return span;
}

/** Build a workflow IO chip — label prefix (⚡ T#id :) + editable value area. */
function buildWorkflowChipEl(
  ioNodeId: string,
  ioNodeTitle: string,
  ioNodeType: WorkflowIONodeType,
): HTMLSpanElement {
  const chipClass = WF_IO_STYLE[ioNodeType] || WF_IO_STYLE.prompt;
  const icon = WF_IO_ICON[ioNodeType] || '?';

  const span = document.createElement('span');
  span.className = `prompt-chip prompt-chip-wf ${chipClass}`;
  span.contentEditable = 'false';
  span.setAttribute('data-wf-id', ioNodeId);
  span.setAttribute('data-wf-title', ioNodeTitle);
  span.setAttribute('data-wf-type', ioNodeType);

  const prefix = document.createElement('span');
  prefix.className = 'prompt-chip-wf-prefix';
  prefix.contentEditable = 'false';
  prefix.innerHTML =
    `<svg width="14" height="14" viewBox="0 0 16 16"><path fill="none" stroke="#f5a97f" stroke-linecap="round" stroke-linejoin="round" d="M3.5 1.5h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2m7 7h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2m-6-1V10q0 1.5 1.5 1.5h2.5"/></svg>` +
    `<span class="prompt-chip-icon">${icon}</span>` +
    `<span class="prompt-chip-wf-id">#${ioNodeId}</span>` +
    `<span class="prompt-chip-wf-colon">:</span>`;
  span.appendChild(prefix);

  const valueArea = document.createElement('span');
  valueArea.className = 'prompt-chip-wf-value';
  valueArea.contentEditable = 'true';
  valueArea.appendChild(document.createElement('br'));
  span.appendChild(valueArea);

  return span;
}

/** Render a prompt string → array of DOM nodes. */
function renderPromptToNodes(
  text: string,
  metaMap: Map<string, { type: string; displayId: number | undefined }>,
): Node[] {
  const regex = /@\{([^:]+):([^}]+)\}|@wf\{([^|]+)\|([^|]+)\|([^|}]+)\}/g;
  const nodes: Node[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    pushTextWithBreaks(nodes, text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      nodes.push(buildChipEl(match[1], match[2], metaMap));
      lastIndex = regex.lastIndex;
    } else {
      const id = match[3];
      const title = match[4];
      const type = match[5] as WorkflowIONodeType;
      const matchEnd = regex.lastIndex;

      // Value area is wrapped in (...) — find matching closing paren with depth tracking.
      // Canvas chips inside the value area are detected via recursive renderPromptToNodes.
      const chip = buildWorkflowChipEl(id, title, type);
      if (text[matchEnd] === '(') {
        let depth = 1;
        let i = matchEnd + 1;
        while (i < text.length && depth > 0) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') depth--;
          i++;
        }
        const valueText = text.slice(matchEnd + 1, i - 1);
        if (valueText) {
          const valueArea = chip.querySelector('.prompt-chip-wf-value');
          if (valueArea) {
            // Remove the initial <br> placeholder before appending real content
            valueArea.innerHTML = '';
            const nestedNodes = renderPromptToNodes(valueText, metaMap);
            for (const n of nestedNodes) {
              valueArea.appendChild(n);
            }
          }
        }
        nodes.push(chip);
        lastIndex = i;
        regex.lastIndex = i;
      } else {
        nodes.push(chip);
        lastIndex = matchEnd;
        regex.lastIndex = matchEnd;
      }
    }
  }
  pushTextWithBreaks(nodes, text.slice(lastIndex));
  return nodes;
}

function pushTextWithBreaks(nodes: Node[], text: string) {
  if (!text) return;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(document.createElement('br'));
    if (line) nodes.push(document.createTextNode(line));
  });
}

// ═══════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════

export default function MentionEditor({
  value: prompt = '',
  onChange,
  onSubmit,
  placeholder = '输入提示词开始创作   (Enter 生成，Shift+Enter 换行)',
  nodeId,
  selectedWorkflowId,
  canSubmit = true,
  onFocus,
  onBlur,
  className = '',
}: MentionEditorProps) {
  // ── @ Mention state ──
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  const savedMentionRangeRef = useRef<Range | null>(null);
  const { nodes, edges, workflows } = useAppStore();

  // ── Selected workflow and its IO nodes ──
  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.id === selectedWorkflowId),
    [workflows, selectedWorkflowId],
  );
  const workflowIONodes = selectedWorkflow?.ioNodes || [];

  // ── Build nodeId → { type, displayId } map ──
  const nodeMetaMap = useMemo(() => {
    const map = new Map<string, { type: string; displayId: number | undefined }>();
    for (const n of nodes) {
      map.set(n.id, {
        type: (n.data.type as string) || '',
        displayId: n.data.displayId as number | undefined,
      });
    }
    return map;
  }, [nodes]);

  // ── Rebuild DOM when prompt changes externally ──
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (serializeDOM(el) === prompt) return;
    const sel = window.getSelection();
    const cursorOffset = sel && sel.rangeCount ? saveCursor(el) : null;
    el.innerHTML = '';
    for (const node of renderPromptToNodes(prompt, nodeMetaMap)) {
      el.appendChild(node);
    }
    if (cursorOffset !== null) restoreCursor(el, cursorOffset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, nodeMetaMap]);

  // ── Cursor save/restore ──
  const saveCursor = (root: HTMLElement): number => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    let offset = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) return offset + range.startOffset;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent && parent.closest('[data-ref-id]')) continue;
        if (parent && parent.closest('[data-wf-id]') && !parent.closest('.prompt-chip-wf-value')) continue;
        offset += (node.textContent || '').length;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.hasAttribute('data-ref-id')) offset += 1;
        else if (el.hasAttribute('data-wf-id')) offset += 1;
      }
    }
    return offset;
  };

  const restoreCursor = (root: HTMLElement, offset: number) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    let count = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      let nodeLen = 0;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent && parent.closest('[data-ref-id]')) continue;
        if (parent && parent.closest('[data-wf-id]') && !parent.closest('.prompt-chip-wf-value')) continue;
        nodeLen = (node.textContent || '').length;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.hasAttribute('data-ref-id') || el.hasAttribute('data-wf-id')) nodeLen = 1;
        if (el.classList.contains('prompt-chip-wf-value') && count + nodeLen >= offset) {
          const firstChild = el.firstChild;
          if (firstChild) {
            range.setStart(firstChild, Math.max(0, offset - count));
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            return;
          }
        }
      }
      if (count + nodeLen >= offset) {
        range.setStart(node, offset - count);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      count += nodeLen;
    }
    range.selectNodeContents(root);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // ── Emit prompt string to parent ──
  const emitDOM = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    onChange(serializeDOM(el));
  }, [onChange]);

  // ── Mention data sources ──
  const getCanvasMentionNodes = useCallback(() => {
    if (!nodeId) return [];
    const incomingEdges = edges.filter((e) => e.target === nodeId);
    const sourceNodeIds = new Set(incomingEdges.map((e) => e.source));
    return nodes
      .filter((n) => n.id !== nodeId && sourceNodeIds.has(n.id))
      .map((n) => ({
        id: n.id,
        label: (n.data.label as string) || '节点',
        type: n.data.type,
        displayId: n.data.displayId as number | undefined,
        hasOutput: !!n.data.output,
        outputType: n.data.imageUrl ? 'image' : n.data.videoUrl ? 'video' : n.data.audioUrl ? 'audio' : 'text',
      }));
  }, [nodeId, nodes, edges]);

  const getWorkflowMentionNodes = useCallback(() => {
    if (!selectedWorkflowId || workflowIONodes.length === 0) return [];
    return workflowIONodes.map((io) => ({
      id: `wf:${io.nodeId}`,
      label: io.title,
      _ioNodeId: io.nodeId,
      _ioType: io.type,
    }));
  }, [selectedWorkflowId, workflowIONodes]);

  const canvasMentionNodes = getCanvasMentionNodes();
  const workflowMentionNodes = getWorkflowMentionNodes();

  const filteredCanvasMentions = mentionQuery
    ? canvasMentionNodes.filter((n) => n.label.toLowerCase().includes(mentionQuery.toLowerCase()))
    : canvasMentionNodes;
  const filteredWorkflowMentions = mentionQuery
    ? workflowMentionNodes.filter((n) => n.label.toLowerCase().includes(mentionQuery.toLowerCase()))
    : workflowMentionNodes;

  const hasAnyMentions = canvasMentionNodes.length > 0 || workflowMentionNodes.length > 0;

  // ── Auto-close menu when no mentionables left ──
  useEffect(() => {
    if (showMention && !hasAnyMentions) setShowMention(false);
  }, [showMention, hasAnyMentions]);

  // ── Clear saved range when mention closes ──
  useEffect(() => {
    if (!showMention) savedMentionRangeRef.current = null;
  }, [showMention]);

  // ── Click outside closes mention ──
  useEffect(() => {
    if (!showMention) return;
    const handler = (e: MouseEvent) => {
      if (editorRef.current && !editorRef.current.parentElement?.contains(e.target as Node)) {
        setShowMention(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMention]);

  // ── Helpers ──
  const deleteAtChar = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const textBefore = range.startContainer?.textContent?.slice(0, range.startOffset) || '';
      const atIdx = textBefore.lastIndexOf('@');
      if (atIdx >= 0 && range.startContainer) {
        range.setStart(range.startContainer, atIdx);
        range.setEnd(range.startContainer, atIdx + 1);
        range.deleteContents();
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, []);

  // ── Insert a canvas node chip ──
  const insertChipAtCursor = useCallback(
    (refNodeId: string, refLabel: string) => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      const chip = buildChipEl(refNodeId, refLabel, nodeMetaMap);
      range.insertNode(chip);
      range.setStartAfter(chip);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      emitDOM();
    },
    [nodeMetaMap, emitDOM],
  );

  // ── Insert a workflow IO chip ──
  const insertWorkflowChipAtCursor = useCallback(
    (ioNodeId: string, ioNodeTitle: string, ioNodeType: WorkflowIONodeType) => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      const chip = buildWorkflowChipEl(ioNodeId, ioNodeTitle, ioNodeType);
      range.insertNode(chip);
      const valueArea = chip.querySelector('.prompt-chip-wf-value');
      if (valueArea) {
        const textNode = valueArea.firstChild;
        range.setStart(textNode || valueArea, 0);
      } else {
        range.setStartAfter(chip);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      emitDOM();
    },
    [emitDOM],
  );

  // ── Mention selection handlers ──
  const handleSelectCanvasMention = useCallback(
    (refNodeId: string, refLabel: string) => {
      // Focus the editor FIRST so the selection we restore below
      // survives across the contentEditable boundary (workflow chip value area).
      const el = editorRef.current;
      if (el) el.focus();
      const saved = savedMentionRangeRef.current;
      savedMentionRangeRef.current = null;
      if (saved) {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(saved);
        }
      }
      deleteAtChar();
      insertChipAtCursor(refNodeId, refLabel);
      setShowMention(false);
      setMentionQuery('');
    },
    [deleteAtChar, insertChipAtCursor],
  );

  const handleSelectWorkflowMention = useCallback(
    (ioNodeId: string, ioNodeTitle: string, ioNodeType: WorkflowIONodeType) => {
      // Focus the editor FIRST so the selection we restore below
      // survives across the contentEditable boundary (workflow chip value area).
      const el = editorRef.current;
      if (el) el.focus();
      const saved = savedMentionRangeRef.current;
      savedMentionRangeRef.current = null;
      if (saved) {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(saved);
        }
      }
      deleteAtChar();
      insertWorkflowChipAtCursor(ioNodeId, ioNodeTitle, ioNodeType);
      setShowMention(false);
      setMentionQuery('');
    },
    [deleteAtChar, insertWorkflowChipAtCursor],
  );

  // ── Input handler: detect @ ──
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node && node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        const cursorPos = range.startOffset;
        if (cursorPos > 0 && text[cursorPos - 1] === '@') {
          if (hasAnyMentions) {
            setMentionQuery('');
            setShowMention(true);
            // Save cursor range before the menu steals focus
            const sel2 = window.getSelection();
            if (sel2 && sel2.rangeCount) {
              savedMentionRangeRef.current = sel2.getRangeAt(0).cloneRange();
            }
          }
        }
      }
    }
    emitDOM();
  }, [emitDOM, hasAnyMentions]);

  // ── KeyDown: mention navigation / submit / chip deletion ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // @ mention: Enter → select first match
      if (showMention && e.key === 'Enter' && !e.shiftKey) {
        if (filteredCanvasMentions.length > 0) {
          e.preventDefault();
          handleSelectCanvasMention(filteredCanvasMentions[0].id, filteredCanvasMentions[0].label);
          return;
        }
        if (filteredWorkflowMentions.length > 0) {
          e.preventDefault();
          const wf = filteredWorkflowMentions[0] as typeof filteredWorkflowMentions[number] & { _ioNodeId: string; _ioType: WorkflowIONodeType };
          handleSelectWorkflowMention(wf._ioNodeId, wf.label, wf._ioType);
          return;
        }
      }
      // @ mention: Escape → close
      if (showMention && e.key === 'Escape') {
        e.preventDefault();
        setShowMention(false);
        return;
      }
      // Submit on Enter (no shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = editorRef.current ? serializeDOM(editorRef.current) : '';
        if (canSubmit && text.trim() && onSubmit) onSubmit();
        return;
      }
      // Delete chip on Backspace
      if (e.key === 'Backspace') {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!range.collapsed) return;
        const node = range.startContainer;
        const offset = range.startOffset;
        if (node && node.nodeType === Node.TEXT_NODE && offset === 0) {
          const valueArea = node.parentElement;
          if (valueArea?.classList.contains('prompt-chip-wf-value')) {
            const chipEl = valueArea.closest('[data-wf-id]');
            if (chipEl) {
              e.preventDefault();
              chipEl.remove();
              emitDOM();
              return;
            }
          }
        }
        if (node && node.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
          const prev = node.previousSibling;
          if (prev && prev.nodeType === Node.ELEMENT_NODE) {
            const prevEl = prev as HTMLElement;
            if (prevEl.hasAttribute('data-ref-id')) {
              e.preventDefault();
              prev.remove();
              emitDOM();
              return;
            }
          }
        }
        if (node && node.nodeType === Node.ELEMENT_NODE) {
          const prev = (node as HTMLElement).previousSibling;
          if (prev && prev.nodeType === Node.ELEMENT_NODE) {
            const prevEl = prev as HTMLElement;
            if (prevEl.hasAttribute('data-ref-id') || prevEl.hasAttribute('data-wf-id')) {
              e.preventDefault();
              prev.remove();
              emitDOM();
              return;
            }
          }
        }
      }
      // Delete chip on Delete
      if (e.key === 'Delete') {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!range.collapsed) return;
        const node = range.startContainer;
        if (node && node.nodeType === Node.TEXT_NODE) {
          const textLen = (node.textContent || '').length;
          if (range.startOffset === textLen) {
            const next = node.nextSibling;
            if (next && next.nodeType === Node.ELEMENT_NODE) {
              const nextEl = next as HTMLElement;
              if (nextEl.hasAttribute('data-ref-id') || nextEl.hasAttribute('data-wf-id')) {
                e.preventDefault();
                next.remove();
                emitDOM();
                return;
              }
            }
          }
        }
      }
    },
    [
      showMention,
      filteredCanvasMentions,
      filteredWorkflowMentions,
      canSubmit,
      onSubmit,
      emitDOM,
      handleSelectCanvasMention,
      handleSelectWorkflowMention,
    ],
  );

  // ── Paste: plain text only ──
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const plain = e.clipboardData.getData('text/plain');
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(plain));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      emitDOM();
    },
    [emitDOM],
  );

  return (
    <div className={`mention-editor-wrap relative ${className}`}>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        className={`prompt-editor${!prompt ? ' is-empty' : ''}`}
        data-placeholder={placeholder}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={onFocus}
        onBlur={() => {
          onBlur?.();
          emitDOM();
        }}
        spellCheck={false}
      />

      {/* @ Mention Dropdown */}
      {showMention && (canvasMentionNodes.length > 0 || workflowMentionNodes.length > 0) && (
        <div className="absolute left-3 bottom-full mb-1 w-64 bg-canvas-card border border-canvas-border rounded-lg shadow-xl shadow-black/40 overflow-hidden z-50">
          {/* Canvas nodes section */}
          {canvasMentionNodes.length > 0 && (
            <>
              <div className="px-3 py-2 text-[11px] text-canvas-text-muted uppercase tracking-wider">
                引用节点
              </div>
              {filteredCanvasMentions.length > 0 ? (
                filteredCanvasMentions.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelectCanvasMention(node.id, node.label);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas-hover transition-colors text-left"
                  >
                    <span
                      className={`w-6 h-6 rounded flex items-center justify-center text-xs ${
                        node.outputType === 'image'
                          ? 'bg-green-500/15 text-green-400'
                          : node.outputType === 'video'
                          ? 'bg-blue-500/15 text-blue-400'
                          : node.outputType === 'audio'
                          ? 'bg-orange-500/15 text-orange-400'
                          : 'bg-indigo-500/15 text-indigo-400'
                      }`}
                    >
                      {node.outputType === 'image' ? '🖼' : node.outputType === 'video' ? '🎬' : node.outputType === 'audio' ? '🎵' : 'T'}
                    </span>
                    <div>
                      <span className="text-sm text-canvas-text">{node.label}</span>
                      <span className='text-[10px] text-canvas-text-muted'> #{node.displayId}</span>
                      {!node.hasOutput && (
                        <span className="ml-2 text-[10px] text-canvas-text-muted">等待生成</span>
                      )}
                    </div>
                  </button>
                ))
              ) : (
                mentionQuery ? (
                  <div className="px-3 py-4 text-center text-xs text-canvas-text-muted">无匹配节点</div>
                ) : null
              )}
            </>
          )}

          {/* Workflow IO nodes section */}
          {workflowMentionNodes.length > 0 && (
            <>
              <div className="px-3 py-2 text-[11px] text-amber-400/70 uppercase tracking-wider flex items-center gap-1.5 border-t border-canvas-border">
                <span><Icon icon="catppuccin:workflow" /></span>
                <span>工作流: {selectedWorkflow?.name || ''}</span>
              </div>
              {filteredWorkflowMentions.length > 0 ? (
                filteredWorkflowMentions.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const ioType = (node as typeof node & { _ioType: WorkflowIONodeType })._ioType || 'prompt';
                      const ioNodeId = (node as typeof node & { _ioNodeId: string })._ioNodeId;
                      handleSelectWorkflowMention(ioNodeId, node.label, ioType);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas-hover transition-colors text-left"
                  >
                    <span
                      className={`w-6 h-6 rounded flex items-center justify-center text-xs ${
                        (node as typeof node & { _ioType: string })._ioType === 'image'
                          ? 'bg-green-500/15 text-green-400'
                          : (node as typeof node & { _ioType: string })._ioType === 'video'
                          ? 'bg-blue-500/15 text-blue-400'
                          : (node as typeof node & { _ioType: string })._ioType === 'audio'
                          ? 'bg-orange-500/15 text-orange-400'
                          : 'bg-indigo-500/15 text-indigo-400'
                      }`}
                    >
                      {(node as typeof node & { _ioType: string })._ioType === 'image' ? '🖼' : (node as typeof node & { _ioType: string })._ioType === 'video' ? '🎬' : (node as typeof node & { _ioType: string })._ioType === 'audio' ? '🎵' : 'T'}
                    </span>
                    <div>
                      <span className="text-sm text-canvas-text">{node.label}</span>
                    </div>
                  </button>
                ))
              ) : (
                mentionQuery ? (
                  <div className="px-3 py-4 text-center text-xs text-canvas-text-muted">无匹配节点</div>
                ) : null
              )}
            </>
          )}

          {/* No results for query */}
          {mentionQuery && filteredCanvasMentions.length === 0 && filteredWorkflowMentions.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-canvas-text-muted">无匹配节点</div>
          )}
        </div>
      )}
    </div>
  );
}
