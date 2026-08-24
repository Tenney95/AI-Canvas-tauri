/**
 * MentionEditor @提及编辑器 — 支持 @引用其他节点输出的富文本输入框，实时渲染为彩色标签芯片
 */
import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import type { WorkflowIONodeType } from '../../../types';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/useAppStore';
import { Icon } from '@iconify/react';
import { listGlobalFiles, listExternalFolderFiles, type AssetFileEntry } from '../../../services/fileService';
import { getAllAssetMeta } from '../../../services/indexedDbService';
import { springSmooth, fadeFast } from '../../../utils/motion';
import { calcAnchoredPosition } from '../../../utils/popupPosition';
import { AnimatePresence, motion } from 'framer-motion';
import PopupCloseButton from '../../shared/PopupCloseButton';
import MentionPicker, { type MentionPickerChip, type MentionPickerItem } from '../../shared/MentionPicker';
import {
  DRAMA_MENTION_MERGE_ALL,
  buildDramaMentionId,
} from '../../../types/dramaAssets';
import type { CharacterReferenceImage } from '../../../types/dramaAssets';
import { CHARACTER_REFERENCE_KIND_LABELS } from '../../character/characterReferencePresentation';
import {
  bestNodeThumb,
  buildAssetChipEl,
  buildChipEl,
  buildDramaChipEl,
  buildWorkflowChipEl,
  ensureCaretSlotBeforeChip,
  getNodeMetaMap,
  isBrEl,
  isChipEl,
  normalizeChipSlots,
  renderPromptToNodes,
  serializeDOM,
  syncImageReferenceLabels,
  ZWSP,
} from './mentionEditorDom';
import {
  resolveCanvasMentionNodes,
  resolveDramaMentionItems,
  resolveWorkflowMentionNodes,
} from './mentionEditorSources';

// 无缩略图时的卡片占位图标
const MEDIA_ICONS: Record<'image' | 'video' | 'audio' | 'text', string> = {
  image: 'mdi:image-outline',
  video: 'mdi:video-outline',
  audio: 'mdi:music-note-outline',
  text: 'mdi:text-box-outline',
};
const DRAMA_KIND_LABELS: Record<string, string> = { character: '角色', scene: '场景', prop: '道具' };

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
  const mentionEditorWrapRef = useRef<HTMLDivElement>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const [mentionDropdownPosition, setMentionDropdownPosition] = useState({ left: 12, top: 0 });
  const editorRef = useRef<HTMLDivElement>(null);
  const savedMentionRangeRef = useRef<Range | null>(null);
  const lastFocusedWfValueRef = useRef<HTMLSpanElement | null>(null);
  const { nodes, edges, workflows, dramaAssets } = useAppStore(
    useShallow((state) => ({
      nodes: state.nodes,
      edges: state.edges,
      workflows: state.workflows,
      dramaAssets: state.dramaAssets,
    })),
  );

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
  const nodeMetaMap = useMemo(() => getNodeMetaMap(nodes), [nodes]);

  // ── Rebuild DOM when prompt changes externally ──
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    syncImageReferenceLabels(el, nodeMetaMap);
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
    syncImageReferenceLabels(el, nodeMetaMap);
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
    syncImageReferenceLabels(el, nodeMetaMap);
    onChange(serializeDOM(el));
  }, [nodeMetaMap, onChange]);

  const canvasMentionNodes = useMemo(
    () => (showMention ? resolveCanvasMentionNodes(nodeId, nodes, edges) : []),
    [edges, nodeId, nodes, showMention],
  );
  const workflowMentionNodes = useMemo(
    () => (showMention ? resolveWorkflowMentionNodes(selectedWorkflowId, workflowIONodes) : []),
    [selectedWorkflowId, showMention, workflowIONodes],
  );

  const filteredCanvasMentions = mentionQuery
    ? canvasMentionNodes.filter((n) => n.label.toLowerCase().includes(mentionQuery.toLowerCase()))
    : canvasMentionNodes;
  const filteredWorkflowMentions = mentionQuery
    ? workflowMentionNodes.filter((n) => n.label.toLowerCase().includes(mentionQuery.toLowerCase()))
    : workflowMentionNodes;

  const dramaMentionItems = useMemo(() => {
    if (!showMention) return [];
    return resolveDramaMentionItems(dramaAssets, mentionQuery);
  }, [showMention, dramaAssets, mentionQuery]);

  // 展开了参考图二级菜单的角色 id（多图角色才有）
  const [dramaRefPickerId, setDramaRefPickerId] = useState<string | null>(null);
  // @ 面板的 Tab / 资产种类筛选
  const [pickerTab, setPickerTab] = useState<'nodes' | 'assets'>('nodes');
  const [dramaKind, setDramaKind] = useState<string>('all');
  useEffect(() => {
    if (!showMention) {
      setDramaRefPickerId(null);
      setPickerTab('nodes');
      setDramaKind('all');
    }
  }, [showMention]);

  // ── Clear saved range when both mention menu and asset picker are closed ──
  // （@ 菜单切到资产弹窗时需保留光标范围，供选中资产后插入芯片）
  useEffect(() => {
    if (!showMention && !showAssetPicker) savedMentionRangeRef.current = null;
  }, [showMention, showAssetPicker]);

  // ── Track last focused workflow chip value area ──
  // 用于点击 connected-nodes-strip 缩略图时把文本插入到正确的 value 区
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const handler = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.classList.contains('prompt-chip-wf-value')) {
        lastFocusedWfValueRef.current = target;
      } else {
        lastFocusedWfValueRef.current = null;
      }
    };
    editor.addEventListener('focusin', handler);
    return () => editor.removeEventListener('focusin', handler);
  }, []);

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
  /** 删除光标前的 @ 及后续查询字（如 `@主角` → 整段删掉再插入芯片） */
  const deleteAtChar = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    if (!container || container.nodeType !== Node.TEXT_NODE) return;
    const cursor = range.startOffset;
    const textBefore = (container.textContent || '').slice(0, cursor);
    const atIdx = textBefore.lastIndexOf('@');
    if (atIdx < 0) return;
    const r = document.createRange();
    r.setStart(container, atIdx);
    r.setEnd(container, cursor);
    r.deleteContents();
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
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

      // 若之前焦点在 workflow chip 的 value 区内 → 在该 value 区末尾插入引用芯片
      const wfValue = lastFocusedWfValueRef.current;
      if (wfValue && el.contains(wfValue)) {
        wfValue.focus();
        // 光标落到 value 区末尾
        const sel = window.getSelection();
        if (sel) {
          const r = document.createRange();
          r.selectNodeContents(wfValue);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
          // 如果已有内容，先加个空格
          const hasContent = wfValue.textContent && wfValue.textContent.trim().length > 0;
          if (hasContent) {
            r.insertNode(document.createTextNode(' '));
            r.collapse(false);
          } else {
            // 清除 contenteditable 的占位 <br>，避免芯片前多余换行
            wfValue.innerHTML = '';
            // 重新选择空 value 区末尾
            r.selectNodeContents(wfValue);
            r.collapse(false);
            sel.removeAllRanges();
            sel.addRange(r);
          }
          const chip = buildChipEl(id, label, nodeMetaMap);
          r.insertNode(chip);
          ensureCaretSlotBeforeChip(chip);
          r.setStartAfter(chip);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        emitDOM();
        return;
      }

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
  }), [insertChipAtCursor, emitDOM, nodeMetaMap]);

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

  const insertDramaChipAtCursor = useCallback(
    (dramaId: string, name: string, kind: string, thumbUrl?: string) => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      const chip = buildDramaChipEl(dramaId, name, kind, thumbUrl);
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

  /** 把光标放回 @ 处，供插入芯片 */
  const restoreMentionCursor = useCallback(() => {
    const el = editorRef.current;
    if (el) el.focus();
    const saved = savedMentionRangeRef.current;
    savedMentionRangeRef.current = null;
    if (!saved) return;
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
  }, []);

  /** 二级菜单：引用角色的某一张参考图，或把全部参考图拼成一张 */
  const handleSelectDramaReference = useCallback(
    (
      item: { id: string; name: string; kind: string },
      pick: string,
      thumb?: string,
    ) => {
      restoreMentionCursor();
      deleteAtChar();
      insertDramaChipAtCursor(
        buildDramaMentionId(item.id, pick),
        item.name,
        item.kind,
        thumb,
      );
      setShowMention(false);
      setMentionQuery('');
      setDramaRefPickerId(null);
    },
    [restoreMentionCursor, deleteAtChar, insertDramaChipAtCursor],
  );

  const handleSelectDramaMention = useCallback(
    (item: { id: string; name: string; kind: string; imageNodeId?: string; imageUrl?: string }) => {
      // 仅当绑图节点上已有真实图片时，才 @ 图像节点；否则始终 @drama 芯片（解析时展开单条简介）
      if (item.imageNodeId) {
        const imgNode = nodes.find((n) => n.id === item.imageNodeId);
        const hasImage = !!(
          (imgNode?.data?.imageUrl as string | undefined)
          || (imgNode?.data?.thumbnailUrl as string | undefined)
          || item.imageUrl
        );
        if (imgNode && hasImage) {
          handleSelectCanvasMention(item.imageNodeId, item.name);
          return;
        }
      }
      restoreMentionCursor();
      deleteAtChar();
      let thumb: string | undefined;
      if (item.imageNodeId) {
        const n = nodes.find((x) => x.id === item.imageNodeId);
        thumb = bestNodeThumb(n?.data ?? {}) || item.imageUrl;
      } else {
        thumb = item.imageUrl;
      }
      insertDramaChipAtCursor(item.id, item.name, item.kind, thumb);
      setShowMention(false);
      setMentionQuery('');
    },
    [nodes, handleSelectCanvasMention, restoreMentionCursor, deleteAtChar, insertDramaChipAtCursor],
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
    Promise.all([listGlobalFiles(), listExternalFolderFiles(assetFolders ?? [])])
      .then(async ([globalFiles, folderFiles]) => {
        const metas = await getAllAssetMeta().catch(() => []);
        if (!alive) return;
        const seen = new Set<string>();
        const merged: AssetFileEntry[] = [];
        for (const f of [...globalFiles, ...folderFiles]) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          merged.push(f);
        }
        const tagMap: Record<string, string[]> = {};
        for (const m of metas) if (m.tags?.length) tagMap[m.assetId] = m.tags;
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
    () => assetList.map((f) => {
      const key = f.assetId ?? f.path;
      return assetTagMap[key] ? { ...f, tags: assetTagMap[key] } : f;
    }),
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
    normalizeChipSlots(el); // 删字后行首化的芯片补回光标落点
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node && node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        const cursorPos = range.startOffset;
        const before = text.slice(0, cursorPos);
        // 光标前最近的 @… 查询段（不含空格/换行）
        const atIdx = before.lastIndexOf('@');
        const afterAt = atIdx >= 0 ? before.slice(atIdx + 1) : '';
        const inMention =
          atIdx >= 0
          && !afterAt.includes(' ')
          && !afterAt.includes('\n')
          && !afterAt.includes('{'); // 已完成的 @{...} 芯片序列化文本不走菜单
        if (inMention) {
          setMentionQuery(afterAt);
          setShowMention(true);
          const sel2 = window.getSelection();
          if (sel2 && sel2.rangeCount) {
            savedMentionRangeRef.current = sel2.getRangeAt(0).cloneRange();
          }
        } else {
          if (showMention) setShowMention(false);
          if (cursorPos > 0 && text[cursorPos - 1] === '/') {
            onSlashTrigger?.();
          }
        }
      } else if (showMention) {
        // 光标移到了非文本节点（如 chip），关闭菜单
        setShowMention(false);
      }
    }
    emitDOM();
  }, [emitDOM, onSlashTrigger, showMention]);

  // ── KeyDown: mention navigation / submit / chip deletion ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // 输入法组合中：回车/方向键属于候选框，不该触发提交或 @ 选中
      if (e.nativeEvent.isComposing) return;
      // 方向键导航前先补好行首芯片的光标落点（ZWSP），否则光标跳不到芯片前
      if (e.key.startsWith('Arrow') && editorRef.current) normalizeChipSlots(editorRef.current);
      // @ mention: Enter → select first match
      if (showMention && e.key === 'Enter' && !e.shiftKey) {
        if (filteredCanvasMentions.length > 0) {
          e.preventDefault();
          handleSelectCanvasMention(filteredCanvasMentions[0].id, filteredCanvasMentions[0].label);
          return;
        }
        if (dramaMentionItems.length > 0) {
          e.preventDefault();
          handleSelectDramaMention(dramaMentionItems[0]);
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

        // 特例：光标正贴在某芯片前面 —— 把 <br> 插到「芯片(及其单个 ZWSP 落点)」之前，
        // 不分裂落点、不产生双停顿，光标停在芯片前。
        const sc = range.startContainer;
        const so = range.startOffset;
        let chipAfter: HTMLElement | null = null;
        if (sc.nodeType === Node.TEXT_NODE && so === (sc.textContent?.length ?? 0) && isChipEl(sc.nextSibling)) {
          chipAfter = sc.nextSibling as HTMLElement;
        } else if (sc.nodeType === Node.ELEMENT_NODE && isChipEl(sc.childNodes[so])) {
          chipAfter = sc.childNodes[so] as HTMLElement;
        }
        if (chipAfter) {
          const parent = chipAfter.parentNode!;
          let slot = chipAfter.previousSibling as Text | null;
          const zwspOnly = !!slot && slot.nodeType === Node.TEXT_NODE && (slot.textContent === '' || slot.textContent === ZWSP);
          if (!zwspOnly) {
            slot = document.createTextNode(ZWSP);
            parent.insertBefore(slot, chipAfter);
          } else if (!slot!.textContent) {
            slot!.textContent = ZWSP;
          }
          parent.insertBefore(document.createElement('br'), slot!); // <br> 在落点之前
          range.setStart(slot!, (slot!.textContent || '').length);   // 光标落到芯片前
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          emitDOM();
          return;
        }

        const br = document.createElement('br');
        range.insertNode(br);
        const next = br.nextSibling;
        if (!next) {
          // 位于末尾：补一个占位 <br>，让新空行可见，光标落在新行
          const filler = document.createElement('br');
          br.parentNode?.insertBefore(filler, null);
          range.setStartBefore(filler);
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
        // 行首芯片前（光标在其 ZWSP 落点里）退格 → 删掉上面的换行 <br> 合并到上一行，而不是卡在 ZWSP
        if (node && node.nodeType === Node.TEXT_NODE && isChipEl(node.nextSibling) && isBrEl(node.previousSibling)) {
          e.preventDefault();
          (node.previousSibling as ChildNode).remove();
          emitDOM();
          return;
        }
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
      dramaMentionItems,
      canSubmit,
      onSubmit,
      emitDOM,
      handleSelectCanvasMention,
      handleSelectWorkflowMention,
      handleSelectDramaMention,
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

  // ── @ 面板数据：输入图（画布节点 + 工作流 IO） / 资产库（短剧资产） ──
  const dramaThumbOf = useCallback((item: { imageNodeId?: string; imageUrl?: string }) => {
    if (!item.imageNodeId) return item.imageUrl;
    const n = nodes.find((x) => x.id === item.imageNodeId);
    return bestNodeThumb(n?.data ?? {}) || item.imageUrl;
  }, [nodes]);

  const nodeTabItems: MentionPickerItem[] = [
    ...filteredCanvasMentions.map((node) => ({
      key: `node:${node.id}`,
      label: node.label,
      thumbnailUrl: node.thumbnailUrl,
      icon: MEDIA_ICONS[node.outputType],
      badge: node.isSelf ? '自身' : node.displayId != null ? `#${node.displayId}` : undefined,
      onSelect: () => handleSelectCanvasMention(node.id, node.label),
    })),
    ...filteredWorkflowMentions.map((node) => ({
      key: `wf:${node.id}`,
      label: node.label,
      icon: MEDIA_ICONS[node._ioType === 'image' || node._ioType === 'video' || node._ioType === 'audio' ? node._ioType : 'text'],
      badge: '工作流',
      onSelect: () => handleSelectWorkflowMention(node._ioNodeId, node.label, node._ioType),
    })),
  ];

  const drillItem = dramaRefPickerId
    ? dramaMentionItems.find((item) => item.id === dramaRefPickerId)
    : undefined;
  const drillRefs: CharacterReferenceImage[] = (drillItem?.referenceImages ?? [])
    .filter((reference) => !!reference.imageUrl);

  const dramaKindChips: MentionPickerChip[] = (() => {
    if (drillItem) return [];
    const counts = new Map<string, number>();
    for (const item of dramaMentionItems) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    if (counts.size === 0) return [];
    return [
      { id: 'all', label: '全部', count: dramaMentionItems.length },
      ...[...counts].map(([kind, count]) => ({ id: kind, label: DRAMA_KIND_LABELS[kind] ?? kind, count })),
    ];
  })();

  const assetTabItems: MentionPickerItem[] = drillItem
    ? [
      {
        key: 'drama-merge-all',
        label: '全部拼成一张',
        icon: 'lucide:layout-grid',
        badge: `${drillRefs.length} 图`,
        onSelect: () => handleSelectDramaReference(drillItem, DRAMA_MENTION_MERGE_ALL, drillRefs[0]?.imageUrl),
      },
      ...drillRefs.map((reference) => ({
        key: `drama-ref:${reference.id}`,
        label: CHARACTER_REFERENCE_KIND_LABELS[reference.kind],
        thumbnailUrl: reference.imageUrl,
        onSelect: () => handleSelectDramaReference(drillItem, reference.id, reference.imageUrl),
      })),
    ]
    : dramaMentionItems
      .filter((item) => dramaKind === 'all' || item.kind === dramaKind)
      .map((item) => {
        const references = (item.referenceImages ?? []).filter((reference) => !!reference.imageUrl);
        const multiRef = references.length > 1;
        const thumb = dramaThumbOf(item) || references[0]?.imageUrl;
        return {
          key: `drama:${item.id}`,
          label: item.name,
          thumbnailUrl: thumb,
          icon: 'mdi:account-box-outline',
          badge: multiRef ? `${references.length} 图` : thumb ? undefined : '简介',
          onSelect: () => {
            // 多张参考图先钻进二级视图让用户挑图或选合并
            if (multiRef) setDramaRefPickerId(item.id);
            else handleSelectDramaMention(item);
          },
        };
      });

  // 当前 Tab 空而另一个有内容时自动切过去（输入 @关键词 时不至于对着空网格）
  const effectiveTab = pickerTab === 'nodes' && nodeTabItems.length === 0 && assetTabItems.length > 0
    ? 'assets'
    : pickerTab === 'assets' && assetTabItems.length === 0 && nodeTabItems.length > 0
      ? 'nodes'
      : pickerTab;

  const updateMentionDropdownPosition = useCallback(() => {
    const wrap = mentionEditorWrapRef.current;
    const dropdown = mentionDropdownRef.current;
    if (!wrap || !dropdown) return;

    const wrapRect = wrap.getBoundingClientRect();
    const savedRange = savedMentionRangeRef.current;
    const rangeRects = savedRange?.getClientRects();
    const caretRect = rangeRects?.[rangeRects.length - 1]
      ?? savedRange?.getBoundingClientRect()
      ?? editorRef.current?.getBoundingClientRect()
      ?? wrapRect;
    const safePosition = calcAnchoredPosition(
      caretRect,
      dropdown.offsetWidth,
      dropdown.offsetHeight,
      8,
      12,
    );
    const nextPosition = {
      left: Math.round(safePosition.left - wrapRect.left),
      top: Math.round(safePosition.top - wrapRect.top),
    };
    setMentionDropdownPosition((current) => (
      current.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition
    ));
  }, []);

  useLayoutEffect(() => {
    if (!showMention) {
      setMentionDropdownPosition({ left: 12, top: 0 });
      return undefined;
    }

    const dropdown = mentionDropdownRef.current;
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateMentionDropdownPosition);
    if (dropdown) resizeObserver?.observe(dropdown);

    updateMentionDropdownPosition();
    window.addEventListener('resize', updateMentionDropdownPosition);
    window.addEventListener('scroll', updateMentionDropdownPosition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateMentionDropdownPosition);
      window.removeEventListener('scroll', updateMentionDropdownPosition, true);
    };
  }, [
    assetTabItems.length,
    dramaKindChips.length,
    drillItem?.id,
    effectiveTab,
    mentionQuery,
    nodeTabItems.length,
    showMention,
    updateMentionDropdownPosition,
  ]);

  return (
    <div ref={mentionEditorWrapRef} className={`mention-editor-wrap relative ${className}`}>
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
        onFocus={() => {
          if (editorRef.current) normalizeChipSlots(editorRef.current); // 聚焦即修复历史无落点芯片
          onFocus?.();
        }}
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
        <div
          ref={mentionDropdownRef}
          className="mention-dropdown absolute w-[336px] max-w-[calc(100vw-24px)] z-50 [&>.mention-picker]:max-h-[calc(100vh-24px)] [&>.mention-picker]:overflow-hidden [&_.mention-picker-grid]:min-h-0"
          style={{ left: mentionDropdownPosition.left, top: mentionDropdownPosition.top }}
        >
          <MentionPicker
            ariaLabel="引用节点或资产"
            tabs={[
              { id: 'nodes', label: '输入图', icon: 'mdi:image-multiple-outline' },
              { id: 'assets', label: '资产库', icon: 'mdi:bookshelf' },
            ]}
            activeTab={effectiveTab}
            onTabChange={(id) => { setPickerTab(id as 'nodes' | 'assets'); setDramaRefPickerId(null); }}
            chips={effectiveTab === 'assets' ? dramaKindChips : undefined}
            activeChip={dramaKind}
            onChipChange={setDramaKind}
            leading={effectiveTab === 'assets' && drillItem ? (
              <button
                type="button"
                className="mention-picker-chip"
                onMouseDown={(e) => { e.preventDefault(); setDramaRefPickerId(null); }}
              >
                <Icon icon="lucide:chevron-left" width="12" height="12" />
                {drillItem.name}
              </button>
            ) : undefined}
            items={effectiveTab === 'assets' ? assetTabItems : nodeTabItems}
            emptyText={mentionQuery ? '无匹配节点或资产' : effectiveTab === 'assets' ? '暂无短剧资产' : '暂无可引用的输入'}
            footer={(
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); openAssetPicker(); }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-canvas-hover"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-indigo-500/15 text-indigo-300">
                  <Icon icon="solar:gallery-bold" width="14" height="14" />
                </span>
                <span className="text-xs text-canvas-text">引用资产</span>
                <span className="ml-auto text-[10px] text-canvas-text-muted">全局资产</span>
              </button>
            )}
          />
        </div>
      )}

      {/* 资产引用弹窗（Portal） */}
      {createPortal(
        <AnimatePresence>
          {showAssetPicker && (
            <motion.div
              data-tauri-drag-region
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
                  <PopupCloseButton onClick={() => setShowAssetPicker(false)} />
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
                          data-tooltip={file.name}
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
