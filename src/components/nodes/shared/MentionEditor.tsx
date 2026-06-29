/**
 * MentionEditor @提及编辑器 — 支持 @引用其他节点输出的富文本输入框，实时渲染为彩色标签芯片
 */
import { useState, useCallback, useRef, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import type { WorkflowIONodeType } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { Icon } from '@iconify/react';
import { listGlobalFiles, listExternalFolderFiles, getFileCategory, type AssetFileEntry } from '../../../services/fileService';
import { getAllAssetMeta } from '../../../services/indexedDbService';
import { springSmooth, fadeFast } from '../../../utils/motion';
import { AnimatePresence, motion } from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/core';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
/** 本地文件路径 → asset URL（Tauri 端，不会失效）；非 Tauri 返回 undefined */
function localAssetUrl(filePath?: string): string | undefined {
  if (!filePath || !IS_TAURI) return undefined;
  try { return convertFileSrc(filePath); } catch { return undefined; }
}
/** 节点缩略图来源：图片节点优先本地文件（线上地址可能失效），其余用海报帧 thumbnailUrl */
function bestNodeThumb(data: { imageUrl?: unknown; thumbnailUrl?: unknown; filePath?: unknown }): string | undefined {
  if (data.imageUrl) {
    return localAssetUrl(data.filePath as string | undefined)
      || (data.thumbnailUrl as string | undefined)
      || (data.imageUrl as string | undefined);
  }
  return data.thumbnailUrl as string | undefined;
}

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
  onSlashTrigger?: () => void;
  className?: string;
}

// ── 暴露给上层的命令式接口（在当前光标处插入节点引用芯片）──
export interface MentionEditorHandle {
  insertMentionAtCursor: (id: string, label: string) => void;
}

// ── Chip color config per node type ──
const CHIP_STYLE: Record<string, string> = {
  'ai-text': 'chip-text',
  'ai-image': 'chip-image',
  'ai-video': 'chip-video',
  'ai-audio': 'chip-audio',
  'ai-markdown': 'chip-markdown',
};

const NODE_ICON: Record<string, string> = {
  'ai-text': 'T',
  'ai-image': 'I',
  'ai-video': 'V',
  'ai-audio': 'A',
  'ai-markdown': 'M',
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

/** 零宽空格 —— 作为不可编辑芯片（contenteditable=false）前的光标落点占位符。 */
const ZWSP = '\u200B';

/** 是否为不可编辑的引用芯片（节点 / 资产 / 工作流 IO）。 */
function isChipEl(node: Node | null | undefined): node is HTMLElement {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as HTMLElement;
  return (
    el.hasAttribute('data-ref-id') ||
    el.hasAttribute('data-asset-path') ||
    el.hasAttribute('data-wf-id') ||
    el.hasAttribute('data-skill-id')
  );
}

function isBrEl(node: Node | null | undefined): boolean {
  return !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR';
}

/** 行首芯片（前面是 <br> 或位于最开头）前补零宽空格，让光标能落到芯片前面（命令式插入用）。 */
function ensureCaretSlotBeforeChip(chip: Node): void {
  if (!chip.previousSibling || isBrEl(chip.previousSibling)) {
    chip.parentNode?.insertBefore(document.createTextNode(ZWSP), chip);
  }
}

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
      } else if (el.hasAttribute('data-asset-path')) {
        result += `@asset{${encodeURIComponent(el.getAttribute('data-asset-path') || '')}}`;
      } else if (el.hasAttribute('data-skill-id')) {
        const id = el.getAttribute('data-skill-id') || '';
        const name = el.getAttribute('data-skill-name') || '';
        result += `@skill{${id}|${encodeURIComponent(name)}}`;
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
  // 去掉芯片前的零宽空格占位符，再剥掉尾部换行
  return result.split(ZWSP).join('').replace(/\n+$/, '');
}

/** Build a chip <span contenteditable="false"> for a canvas node reference. */
function buildChipEl(
  nodeId: string,
  label: string,
  metaMap: Map<string, { type: string; displayId: number | undefined; thumbnailUrl?: string }>,
): HTMLSpanElement {
  const meta = metaMap.get(nodeId);
  const nodeType = meta?.type || 'ai-text';
  const displayId = meta?.displayId;
  const thumbnailUrl = meta?.thumbnailUrl;
  const chipClass = CHIP_STYLE[nodeType] || CHIP_STYLE['ai-text'];
  const isMedia = nodeType === 'ai-image' || nodeType === 'ai-video';

  const span = document.createElement('span');
  span.className = `prompt-chip ${chipClass}`;
  span.contentEditable = 'false';
  span.setAttribute('data-ref-id', nodeId);
  span.setAttribute('data-ref-label', label);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'prompt-chip-icon';
  if (isMedia && thumbnailUrl) {
    const img = document.createElement('img');
    img.src = thumbnailUrl;
    img.className = 'prompt-chip-thumb';
    img.alt = '';
    iconSpan.appendChild(img);
  } else {
    iconSpan.textContent = NODE_ICON[nodeType] || '?';
  }
  span.appendChild(iconSpan);

  if (displayId != null) {
    const idSpan = document.createElement('span');
    idSpan.className = 'prompt-chip-id';
    idSpan.textContent = `#${displayId}`;
    span.appendChild(idSpan);
  }
  return span;
}

/** Build a chip for a referenced permanent asset file (@asset{encodedPath}). */
function buildAssetChipEl(path: string, assetUrl?: string): HTMLSpanElement {
  const name = path.split(/[\\/]/).pop() || 'asset';
  const isImage = getFileCategory(name) === 'image';

  const span = document.createElement('span');
  span.className = 'prompt-chip chip-asset';
  span.contentEditable = 'false';
  span.setAttribute('data-asset-path', path);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'prompt-chip-icon';
  if (isImage && assetUrl) {
    const img = document.createElement('img');
    img.src = assetUrl;
    img.className = 'prompt-chip-thumb';
    img.alt = '';
    iconSpan.appendChild(img);
  } else {
    iconSpan.textContent = isImage ? '🖼' : '📄';
  }
  span.appendChild(iconSpan);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'prompt-chip-id';
  nameSpan.textContent = name.length > 18 ? `${name.slice(0, 16)}…` : name;
  span.appendChild(nameSpan);
  return span;
}

/** Build a chip for a Skill reference (@skill{id|encodedName}). */
function buildSkillChipEl(skillId: string, skillName: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'prompt-chip chip-skill';
  span.contentEditable = 'false';
  span.setAttribute('data-skill-id', skillId);
  span.setAttribute('data-skill-name', skillName);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'prompt-chip-icon';
  iconSpan.textContent = 'S';
  span.appendChild(iconSpan);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'prompt-chip-id';
  nameSpan.textContent = skillName.length > 20 ? `${skillName.slice(0, 18)}...` : skillName;
  span.appendChild(nameSpan);
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
  metaMap: Map<string, { type: string; displayId: number | undefined; thumbnailUrl?: string }>,
): Node[] {
  const regex = /@asset\{([^}]+)\}|@\{([^:]+):([^}]+)\}|@wf\{([^|]+)\|([^|]+)\|([^|}]+)\}|@skill\{([^|}]+)\|([^}]+)\}/g;
  const nodes: Node[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // 行首芯片（前面是 <br>、另一个芯片，或位于最开头）需要一个零宽空格文本节点，
  // 否则光标无法落到芯片前面（contenteditable=false 元素旁缺少可定位的文本节点）。
  const pushChip = (chip: Node) => {
    const last = nodes[nodes.length - 1];
    if (!last || isBrEl(last) || isChipEl(last)) {
      nodes.push(document.createTextNode(ZWSP));
    }
    nodes.push(chip);
  };

  while ((match = regex.exec(text)) !== null) {
    pushTextWithBreaks(nodes, text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      // Asset reference
      let path = match[1];
      try { path = decodeURIComponent(match[1]); } catch { /* keep raw */ }
      pushChip(buildAssetChipEl(path));
      lastIndex = regex.lastIndex;
    } else if (match[2] !== undefined) {
      pushChip(buildChipEl(match[2], match[3], metaMap));
      lastIndex = regex.lastIndex;
    } else if (match[4] !== undefined) {
      const id = match[4];
      const title = match[5];
      const type = match[6] as WorkflowIONodeType;
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
        pushChip(chip);
        lastIndex = i;
        regex.lastIndex = i;
      } else {
        pushChip(chip);
        lastIndex = matchEnd;
        regex.lastIndex = matchEnd;
      }
    } else {
      const id = match[7];
      let name = match[8];
      try { name = decodeURIComponent(match[8]); } catch { /* keep raw */ }
      pushChip(buildSkillChipEl(id, name));
      lastIndex = regex.lastIndex;
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

const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditor({
  value: prompt = '',
  onChange,
  onSubmit,
  placeholder = '输入提示词开始创作   (Enter 生成，Shift+Enter 换行)',
  nodeId,
  selectedWorkflowId,
  canSubmit = true,
  onFocus,
  onBlur,
  onSlashTrigger,
  className = '',
}: MentionEditorProps, ref) {
  // ── @ Mention state ──
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  const savedMentionRangeRef = useRef<Range | null>(null);
  const { nodes, edges, workflows } = useAppStore();

  // ── 资产引用弹窗 ──
  const assetFolders = useAppStore((s) => s.config.assetFolders);
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [assetList, setAssetList] = useState<AssetFileEntry[]>([]);
  const [assetTagMap, setAssetTagMap] = useState<Record<string, string[]>>({});
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetSearch, setAssetSearch] = useState('');
  const [activeAssetTag, setActiveAssetTag] = useState<string | null>(null);
  const [assetVisible, setAssetVisible] = useState(40);
  const assetSentinelRef = useRef<HTMLDivElement | null>(null);

  // ── Selected workflow and its IO nodes ──
  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.id === selectedWorkflowId),
    [workflows, selectedWorkflowId],
  );
  const workflowIONodes = useMemo(
    () => selectedWorkflow?.ioNodes || [],
    [selectedWorkflow],
  );

  // ── Build nodeId → { type, displayId, thumbnailUrl } map ──
  const nodeMetaMap = useMemo(() => {
    const map = new Map<string, { type: string; displayId: number | undefined; thumbnailUrl?: string }>();
    for (const n of nodes) {
      map.set(n.id, {
        type: (n.data.type as string) || '',
        displayId: n.data.displayId as number | undefined,
        // 图片节点优先本地文件（线上地址可能失效）；视频用海报帧；不用 videoUrl（会裂图）
        thumbnailUrl: bestNodeThumb(n.data),
      });
    }
    return map;
  }, [nodes]);

  // ── Rebuild DOM when prompt changes externally ──
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (serializeDOM(el) === prompt) {
      // 删空后浏览器常残留 <br>，而 serializeDOM 会剥掉尾部换行使其「看起来为空」，
      // 于是 DOM 不会被清理、光标停在残留空行（第 2/3 行）。这里把真正的空状态归一化。
      // 仅在 prompt 由非空变空时触发（此 effect 才会重跑），不影响用户主动按 Shift+Enter 换行。
      if (prompt === '' && el.innerHTML !== '') {
        const hadFocus = document.activeElement === el;
        el.innerHTML = '';
        if (hadFocus) {
          const sel = window.getSelection();
          const r = document.createRange();
          r.selectNodeContents(el);
          r.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(r);
        }
      }
      return;
    }
    const sel = window.getSelection();
    const cursorOffset = sel && sel.rangeCount ? saveCursor(el) : null;
    el.innerHTML = '';
    for (const node of renderPromptToNodes(prompt, nodeMetaMap)) {
      el.appendChild(node);
    }
    if (cursorOffset !== null) restoreCursor(el, cursorOffset);
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
        if (parent && parent.closest('[data-skill-id]')) continue;
        if (parent && parent.closest('[data-wf-id]') && !parent.closest('.prompt-chip-wf-value')) continue;
        offset += (node.textContent || '').length;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.hasAttribute('data-ref-id')) offset += 1;
        else if (el.hasAttribute('data-skill-id')) offset += 1;
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
        if (parent && parent.closest('[data-skill-id]')) continue;
        if (parent && parent.closest('[data-wf-id]') && !parent.closest('.prompt-chip-wf-value')) continue;
        nodeLen = (node.textContent || '').length;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.hasAttribute('data-ref-id') || el.hasAttribute('data-wf-id') || el.hasAttribute('data-skill-id')) nodeLen = 1;
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
    const me = nodes.find((n) => n.id === nodeId);

    // 直接入边的源
    const rawSourceIds = new Set(edges.filter((e) => e.target === nodeId).map((e) => e.source));
    // 共享输入：本节点若在某分组内，加入该分组的入边源（组内节点共享组的输入）
    if (me?.parentId) {
      edges.filter((e) => e.target === me.parentId).forEach((e) => rawSourceIds.add(e.source));
    }

    // 全部输出：作为源的分组节点展开为其全部子节点；分组节点本身不作为候选
    const sourceNodeIds = new Set<string>();
    for (const sid of rawSourceIds) {
      const sn = nodes.find((n) => n.id === sid);
      if (sn?.type === 'group') {
        nodes.filter((n) => n.parentId === sid).forEach((c) => sourceNodeIds.add(c.id));
      } else {
        sourceNodeIds.add(sid);
      }
    }

    return nodes
      .filter((n) => n.id !== nodeId && n.type !== 'group' && sourceNodeIds.has(n.id))
      .map((n) => ({
        id: n.id,
        label: (n.data.label as string) || '节点',
        type: n.data.type,
        displayId: n.data.displayId as number | undefined,
        hasOutput: !!n.data.output,
        outputType: n.data.imageUrl ? 'image' : n.data.videoUrl ? 'video' : n.data.audioUrl ? 'audio' : 'text',
        // 图片节点优先本地文件（线上地址可能失效）；视频用海报帧；不用 videoUrl
        thumbnailUrl: bestNodeThumb(n.data),
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

  // ── Clear saved range when both mention menu and asset picker are closed ──
  // （@ 菜单切到资产弹窗时需保留光标范围，供选中资产后插入芯片）
  useEffect(() => {
    if (!showMention && !showAssetPicker) savedMentionRangeRef.current = null;
  }, [showMention, showAssetPicker]);

  // ── Click outside closes mention ──
  useEffect(() => {
    if (!showMention) return;
    const handler = (e: MouseEvent) => {
      if (editorRef.current && !editorRef.current.parentElement?.contains(e.target as Node)) {
        setShowMention(false);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
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
      ensureCaretSlotBeforeChip(chip);
      range.setStartAfter(chip);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      emitDOM();
    },
    [nodeMetaMap, emitDOM],
  );

  // 暴露命令式插入：在当前光标处插入引用芯片；若编辑器内无有效光标则落到末尾
  useImperativeHandle(ref, () => ({
    insertMentionAtCursor: (id: string, label: string) => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!range || !el.contains(range.startContainer)) {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false); // 末尾
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
      insertChipAtCursor(id, label);
    },
  }), [insertChipAtCursor]);

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
      ensureCaretSlotBeforeChip(chip);
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

  // ── Insert an asset reference chip ──
  const insertAssetChipAtCursor = useCallback(
    (path: string, assetUrl?: string) => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      const chip = buildAssetChipEl(path, assetUrl);
      range.insertNode(chip);
      ensureCaretSlotBeforeChip(chip);
      range.setStartAfter(chip);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      emitDOM();
    },
    [emitDOM],
  );

  // ── 打开资产弹窗（保持 @ 处的光标范围，关闭 @ 菜单）──
  const openAssetPicker = useCallback(() => {
    setShowMention(false);
    setShowAssetPicker(true);
    setAssetSearch('');
  }, []);

  // Esc 关闭资产弹窗
  useEffect(() => {
    if (!showAssetPicker) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setShowAssetPicker(false); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [showAssetPicker]);

  // 弹窗打开时加载：全局永久资产 + 登记的外部文件夹（去重）+ 标签元数据
  useEffect(() => {
    if (!showAssetPicker) return;
    let alive = true;
    setAssetLoading(true);
    Promise.all([
      listGlobalFiles(),
      listExternalFolderFiles(assetFolders ?? []),
      getAllAssetMeta().catch(() => []),
    ])
      .then(([globalFiles, folderFiles, metas]) => {
        if (!alive) return;
        const seen = new Set<string>();
        const merged: AssetFileEntry[] = [];
        for (const f of [...globalFiles, ...folderFiles]) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          merged.push(f);
        }
        const tagMap: Record<string, string[]> = {};
        for (const m of metas) if (m.tags?.length) tagMap[m.path] = m.tags;
        setAssetList(merged);
        setAssetTagMap(tagMap);
      })
      .catch(() => { if (alive) { setAssetList([]); setAssetTagMap({}); } })
      .finally(() => { if (alive) setAssetLoading(false); });
    return () => { alive = false; };
  }, [showAssetPicker, assetFolders]);

  const handleSelectAsset = useCallback(
    (file: AssetFileEntry) => {
      const el = editorRef.current;
      if (el) el.focus();
      const saved = savedMentionRangeRef.current;
      savedMentionRangeRef.current = null;
      if (saved) {
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(saved); }
      }
      deleteAtChar();
      insertAssetChipAtCursor(file.path, file.assetUrl);
      setShowAssetPicker(false);
      setMentionQuery('');
    },
    [deleteAtChar, insertAssetChipAtCursor],
  );

  // 标签合并 + 派生标签 chip
  const taggedAssets = useMemo(
    () => assetList.map((f) => (assetTagMap[f.path] ? { ...f, tags: assetTagMap[f.path] } : f)),
    [assetList, assetTagMap],
  );
  const assetTagList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of taggedAssets) for (const t of f.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  }, [taggedAssets]);

  const filteredAssets = useMemo(() => {
    const q = assetSearch.trim().toLowerCase();
    return taggedAssets.filter((f) => {
      if (activeAssetTag && !(f.tags ?? []).includes(activeAssetTag)) return false;
      if (q) {
        const inName = f.name.toLowerCase().includes(q);
        const inTags = (f.tags ?? []).some((t) => t.toLowerCase().includes(q));
        if (!inName && !inTags) return false;
      }
      return true;
    });
  }, [taggedAssets, assetSearch, activeAssetTag]);

  // 增量渲染：过滤变化时重置
  useEffect(() => { setAssetVisible(40); }, [assetSearch, activeAssetTag, showAssetPicker]);
  const visibleAssets = useMemo(() => filteredAssets.slice(0, assetVisible), [filteredAssets, assetVisible]);
  useEffect(() => {
    const el = assetSentinelRef.current;
    if (!el) return;
    const root = el.closest('.asset-picker-grid') as HTMLElement | null;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setAssetVisible((c) => (c < filteredAssets.length ? c + 40 : c));
      }
    }, { root, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [filteredAssets.length, visibleAssets.length]);

  // ── Input handler: detect @ and / ──
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
          // 资产引用始终可用，故 @ 总是打开菜单
          setMentionQuery('');
          setShowMention(true);
          // Save cursor range before the menu steals focus
          const sel2 = window.getSelection();
          if (sel2 && sel2.rangeCount) {
            savedMentionRangeRef.current = sel2.getRangeAt(0).cloneRange();
          }
        } else if (cursorPos > 0 && text[cursorPos - 1] === '/') {
          onSlashTrigger?.();
        }
      }
    }
    emitDOM();
  }, [emitDOM, onSlashTrigger]);

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
      // Newline on Shift+Enter —— 手动插入单个 <br>，避免浏览器在芯片旁默认插入两个 <br>（换两行）
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = document.createElement('br');
        range.insertNode(br);
        const next = br.nextSibling;
        if (!next) {
          // 位于末尾：补一个占位 <br>，让新空行可见，光标落在新行
          const filler = document.createElement('br');
          br.parentNode?.insertBefore(filler, null);
          range.setStartBefore(filler);
        } else if (isChipEl(next)) {
          // 新行以芯片开头：插入零宽空格，让光标能落到芯片前面
          const zwsp = document.createTextNode(ZWSP);
          br.parentNode?.insertBefore(zwsp, next);
          range.setStart(zwsp, 1);
        } else {
          range.setStartAfter(br);
        }
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        emitDOM();
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
        // 光标在文本节点开头：删除其前一个兄弟若为芯片
        if (node && node.nodeType === Node.TEXT_NODE && offset === 0 && isChipEl(node.previousSibling)) {
          e.preventDefault();
          (node.previousSibling as HTMLElement).remove();
          emitDOM();
          return;
        }
        // 光标在元素层级（编辑器根 / 行尾，container 为元素）：删除光标前一个子节点若为芯片。
        // 末尾芯片时 container 是编辑器、offset=子节点数，前一个节点是 childNodes[offset-1]（而非 previousSibling）。
        if (node && node.nodeType === Node.ELEMENT_NODE && offset > 0 && isChipEl(node.childNodes[offset - 1])) {
          e.preventDefault();
          (node.childNodes[offset - 1] as HTMLElement).remove();
          emitDOM();
          return;
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
              if (nextEl.hasAttribute('data-ref-id') || nextEl.hasAttribute('data-wf-id') || nextEl.hasAttribute('data-skill-id')) {
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

  // ── 芯片 hover：① 发布节点 id 联动 connected-nodes-float 高亮；② 显示节点名字浮层 ──
  const lastHoverIdRef = useRef<string | null>(null);
  const [chipTip, setChipTip] = useState<{ label: string; x: number; y: number } | null>(null);
  const handleEditorMouseOver = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.('[data-ref-id]') as HTMLElement | null;
    const id = el?.getAttribute('data-ref-id') ?? null;
    if (id === lastHoverIdRef.current) return; // 同一芯片，跳过避免抖动
    lastHoverIdRef.current = id;
    useAppStore.getState().setHoveredMentionNodeId(id);
    if (el && id) {
      const label = el.getAttribute('data-ref-label') || '节点';
      const r = el.getBoundingClientRect();
      setChipTip({ label, x: r.left + r.width / 2, y: r.top });
    } else {
      setChipTip(null);
    }
  }, []);
  const handleEditorMouseLeave = useCallback(() => {
    lastHoverIdRef.current = null;
    useAppStore.getState().setHoveredMentionNodeId(null);
    setChipTip(null);
  }, []);
  // 卸载时清除，避免残留 hover 高亮
  useEffect(() => () => { useAppStore.getState().setHoveredMentionNodeId(null); }, []);

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
        onMouseOver={handleEditorMouseOver}
        onMouseLeave={handleEditorMouseLeave}
        onFocus={onFocus}
        onBlur={() => {
          onBlur?.();
          emitDOM();
        }}
        spellCheck={false}
      />

      {/* 芯片 hover 名字浮层（Portal，避免被编辑器 overflow 裁剪）*/}
      {createPortal(
        <AnimatePresence>
          {chipTip && (
            <motion.div
              className="chip-name-tip"
              style={{ left: chipTip.x, top: chipTip.y }}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4, transition: fadeFast }}
              transition={fadeFast}
            >
              {chipTip.label}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* @ Mention Dropdown */}
      {showMention && (
        <div className="mention-dropdown absolute left-3 bottom-full mb-1 w-64 bg-canvas-card border border-canvas-border rounded-lg shadow-xl shadow-black/40 overflow-hidden z-50">
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
                      className={`w-6 h-6 rounded flex items-center justify-center text-xs shrink-0 overflow-hidden ${node.outputType === 'image'
                          ? 'bg-green-500/15 text-green-400'
                          : node.outputType === 'video'
                            ? 'bg-blue-500/15 text-blue-400'
                            : node.outputType === 'audio'
                              ? 'bg-orange-500/15 text-orange-400'
                              : 'bg-indigo-500/15 text-indigo-400'
                        }`}
                    >
                      {(node.outputType === 'image' || node.outputType === 'video') && node.thumbnailUrl ? (
                        <img src={node.thumbnailUrl} alt="" className="w-full h-full object-cover rounded" />
                      ) : node.outputType === 'video' ? '🎬' : node.outputType === 'image' ? '🖼' : node.outputType === 'audio' ? '🎵' : 'T'}
                    </span>
                    <div className="min-w-0 flex-1 flex items-center gap-1 overflow-hidden">
                      <span className="text-sm text-canvas-text truncate">{node.label}</span>
                      <span className="text-[10px] text-canvas-text-muted shrink-0">#{node.displayId}</span>
                      {/* {!node.hasOutput && (
                        <span className="text-[10px] text-canvas-text-muted shrink-0">等待生成</span>
                      )} */}
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
                      className={`w-6 h-6 rounded flex items-center justify-center text-xs ${(node as typeof node & { _ioType: string })._ioType === 'image'
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
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <span className="text-sm text-canvas-text truncate">{node.label}</span>
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

          {/* No node results for query */}
          {mentionQuery && filteredCanvasMentions.length === 0 && filteredWorkflowMentions.length === 0 && (
            <div className="px-3 py-3 text-center text-xs text-canvas-text-muted">无匹配节点</div>
          )}

          {/* 引用资产 — 常驻入口 */}
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); openAssetPicker(); }}
            className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-canvas-hover transition-colors text-left border-t border-canvas-border"
          >
            <span className="w-6 h-6 rounded flex items-center justify-center shrink-0 bg-indigo-500/15 text-indigo-300">
              <Icon icon="solar:gallery-bold" width="14" height="14" />
            </span>
            <span className="text-sm text-canvas-text">引用资产</span>
            <span className="ml-auto text-[10px] text-canvas-text-muted">永久保存</span>
          </button>
        </div>
      )}

      {/* 资产引用弹窗（Portal） */}
      {createPortal(
        <AnimatePresence>
          {showAssetPicker && (
            <motion.div
              className="asset-picker-backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onMouseDown={() => setShowAssetPicker(false)}
            >
              <motion.div
                className="asset-picker"
                initial={{ opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 12, transition: fadeFast }}
                transition={springSmooth}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="asset-picker-header">
                  <div className="asset-picker-search">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text" placeholder="搜索名称或标签…" autoFocus
                      value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)}
                    />
                  </div>
                  <button type="button" className="asset-picker-close" onClick={() => setShowAssetPicker(false)} aria-label="关闭">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>


                {/* 标签筛选 */}
                {assetTagList.length > 0 && (
                  <div className="asset-picker-tags">
                    <button
                      type="button"
                      className={`asset-picker-tag ${activeAssetTag === null ? 'active' : ''}`}
                      onClick={() => setActiveAssetTag(null)}
                    >全部</button>
                    {assetTagList.map(([tag, count]) => (
                      <button
                        key={tag}
                        type="button"
                        className={`asset-picker-tag ${activeAssetTag === tag ? 'active' : ''}`}
                        onClick={() => setActiveAssetTag((t) => (t === tag ? null : tag))}
                      >#{tag}<span className="asset-picker-tag-count">{count}</span></button>
                    ))}
                  </div>
                )}

                <div className="asset-picker-grid">
                  {assetLoading ? (
                    <div className="asset-picker-empty">加载中…</div>
                  ) : filteredAssets.length === 0 ? (
                    <div className="asset-picker-empty">{assetSearch || activeAssetTag ? '没有匹配的文件' : '暂无文件'}</div>
                  ) : (
                    <>
                      {visibleAssets.map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          className="asset-picker-card"
                          title={file.name}
                          onClick={() => handleSelectAsset(file)}
                        >
                          {file.assetUrl ? (
                            <img src={file.assetUrl} alt={file.name} loading="lazy" decoding="async" />
                          ) : (
                            <span className="asset-picker-card-icon">
                              {file.category === 'video' ? '🎬' : file.category === 'audio' ? '🎵' : file.category === 'text' ? '📄' : '📁'}
                            </span>
                          )}
                          <span className="asset-picker-card-name">{file.name}</span>
                        </button>
                      ))}
                      {assetVisible < filteredAssets.length && (
                        <div ref={assetSentinelRef} className="asset-picker-sentinel">加载更多…</div>
                      )}
                    </>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
});

export default MentionEditor;
