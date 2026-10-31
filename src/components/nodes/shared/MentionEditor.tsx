/**
 * MentionEditor @提及编辑器 — 支持 @引用其他节点输出的富文本输入框，实时渲染为彩色标签芯片
 */
import { t as translate, useT } from '../../../i18n';
import { lazy, Suspense, useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useId, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import type { PromptSubmitShortcut, WorkflowIONodeType } from '../../../types';
import { resolvePromptEnterAction } from '../../../utils/promptSubmitShortcut';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/useAppStore';
import { Icon } from '@iconify/react';
import { getAssetUrlFromPath, getFileCategory, listGlobalFolderContents, listExternalFolderContents, selectAssetFolderFiles, type AssetFileEntry, type AssetFolderEntry, type AssetFolderSelection } from '../../../services/fileService';
import { getAllAssetMeta } from '../../../services/indexedDbService';
import { springSmooth, fadeFast } from '../../../utils/motion';
import { calcAnchoredPosition, calcFixedPosition } from '../../../utils/popupPosition';
import { resolveMentionPreview } from './connectedNodesPreviewInteractions';
import { readMentionPreviewSource, resolveDramaMentionPreview, type MentionChipPreview, type MentionPreviewSource } from './mentionEditorPreview';
import { AnimatePresence, motion } from 'framer-motion';
import PopupCloseButton from '../../shared/PopupCloseButton';
import MentionPicker, { type MentionPickerChip, type MentionPickerItem } from '../../shared/MentionPicker';
import MentionChipMenu from './MentionChipMenu';
import ViewportImage from '../../shared/ViewportImage';
import VideoThumbnail from '../../shared/VideoThumbnail';
import { useDialogFocus } from '../../../hooks/useDialogFocus';
import { useComfyDomImageSources } from '../../../hooks/useComfyDomImageSources';
import { useComfyImageSource } from '../../../hooks/useComfyImageSource';
import { findDraggableMentionChip, startMentionChipDrag } from './mentionEditorChipDrag';
import { readMentionTextSelection, selectMentionText } from './mentionEditorTextSelection';
import {
  captureMentionEditorSelection,
  captureMentionEditorSnapshot,
  MentionEditorHistory,
  restoreMentionEditorSnapshot,
} from './mentionEditorHistory';
import {
  DRAMA_MENTION_MERGE_ALL,
  buildDramaMentionId,
  buildDramaActionMentionId,
  buildDramaVoiceMentionId,
} from '../../../types/dramaAssets';
import type { CharacterReferenceImage, DramaAssetReferenceImage, DramaAssetCategory } from '../../../types/dramaAssets';
import { parseShotlistRowMentionId } from '../../../types/shotlist';
import { findReferencePreviewSource, REFERENCE_PREVIEW_EVENT, requestReferencePreview } from '../../../utils/referencePreviewEvents';
import { AVATAR_ASPECT, CHARACTER_REFERENCE_KIND_LABELS } from '../../character/characterReferencePresentation';
import { findDramaAsset, listGlobalDramaAssets, resolveDramaActionMediaRef, resolveDramaAssetImageRef, resolveDramaVoiceRef } from '../../../services/dramaAssetPrompt';
import {
  bestNodeThumb,
  buildAssetChipEl,
  buildChipEl,
  buildDramaChipEl,
  buildWorkflowChipEl,
  buildComfyRefmodChipEl,
  resolveComfyRefmodChipPresentation,
  syncComfyRefmodReferenceChips,
  ensureCaretSlotBeforeChip,
  ensureCaretSlotAfterChip,
  getNodeMetaMap,
  isBrEl,
  isChipEl,
  normalizeChipSlots,
  renderPromptToNodes,
  serializeDOM,
  syncGlobalCharacterReferenceChips,
  syncShotlistReferenceChips,
  syncMentionChipLocale,
  syncImageReferenceLabels,
  ZWSP,
} from './mentionEditorDom';
import {
  matchesMentionQuery,
  resolveCanvasMentionNodes,
  resolveDramaMentionItems,
  resolveGlobalAssetPickerItems,
  resolveWorkflowMentionNodes,
  filterWorkflowMentions,
  workflowMentionFilterChips,
} from './mentionEditorSources';
import { useComfyRefmodMentionOptions } from '../../../hooks/useComfyRefmodMentionOptions';
import { buildComfyRefmodMention, parseComfyRefmodMentions, mergeComfyRefmodSelections } from '../../../utils/comfyRefmodMention';
import { comfyRefmodKey } from '../../../utils/comfyRefmod';
import { prepareComfyRefmodSelections } from '../../../services/comfyRefmodWorkflow';
import type { ComfyRefmodAsset, ComfyRefmodSelection } from '../../../types/comfyRefmod';
import type { WorkflowDefinition } from '../../../types';
import { workflowInputNodes } from '../../../services/runninghubWorkflowService';

const ComfyRefmodMentionSettings = lazy(() => import('./ComfyRefmodMentionSettings'));
const AssetFolderNavigation = lazy(() => import('../../assets/AssetFolderNavigation'));
const EMPTY_REFMODS: ComfyRefmodSelection[] = [];
interface RefmodEditSession {
  asset: ComfyRefmodAsset;
  thumbnailUrl?: string;
  initial?: ComfyRefmodSelection;
  manualIndex?: number;
  existing: ComfyRefmodSelection[];
  token?: string;
  chip?: HTMLElement;
  range?: Range;
  projectId: string | null;
  nodeId: string;
  workflow: WorkflowDefinition;
  nodeSnapshot: string;
  prompt: string;
}

interface MentionChipTarget {
  chip: HTMLElement;
  prompt: string;
  projectId: string | null;
  nodeId?: string;
}

// 无缩略图时的卡片占位图标
const MEDIA_ICONS: Record<'image' | 'video' | 'audio' | 'text', string> = {
  image: 'mdi:image-outline',
  video: 'mdi:video-outline',
  audio: 'mdi:music-note-outline',
  text: 'mdi:text-box-outline',
};
const DRAMA_KIND_LABELS: Record<string, string> = { character: '角色', scene: '场景', prop: '道具', weapon: '武器' };
const SEARCH_PAGE_SIZE = 60;

// ── Props ──
export interface MentionEditorProps {
  value: string;
  disabled?: boolean;
  onChange: (value: string, previousValue?: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  /** 滚动表格等裁剪容器内，将引用选择面板挂到 body。 */
  portalDropdown?: boolean;
  nodeId?: string;
  selectedWorkflowId?: string;
  canSubmit?: boolean;
  submitOnShiftEnter?: boolean;
  submitShortcut?: PromptSubmitShortcut;
  onFocus?: () => void;
  onBlur?: () => void;
  onSlashTrigger?: () => void;
  className?: string;
}

// ── 暴露给上层的命令式接口（在当前光标处插入节点引用芯片）──
export interface MentionEditorHandle {
  insertMentionAtCursor: (id: string, label: string) => void;
  /** 供共用文档工具栏调用；偏移按序列化原文计算。 */
  textInput?: Pick<HTMLTextAreaElement, 'selectionStart' | 'selectionEnd' | 'focus' | 'setSelectionRange'>;
  /** 父弹窗收到 Escape 时优先收起引用菜单。 */
  dismissMenu?: () => boolean;
}

// ── Cursor save/restore ──
type CursorPosition = { offset: number; workflowValue?: { index: number; offset: number; focused: boolean } };
const createCursorWalker = (root: HTMLElement) => document.createTreeWalker(root, NodeFilter.SHOW_ALL, {
  acceptNode(node) {
    for (let parent = node.parentNode; parent && parent !== root; parent = parent.parentNode) {
      if (!isChipEl(parent)) continue;
      // 工作流的 value 可以编辑，其余胶囊内部都只是展示，不计入正文偏移。
      return parent.hasAttribute('data-wf-id') && !!parent.querySelector('.prompt-chip-wf-value')?.contains(node)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_ACCEPT;
  },
});
const saveCursor = (root: HTMLElement): CursorPosition => {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return { offset: 0 };
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return { offset: 0 };
  let startContainer = range.startContainer;
  let startOffset = range.startOffset;
  if (startContainer === root) {
    const next = root.childNodes[startOffset];
    const previous = root.childNodes[startOffset - 1];
    if (next?.nodeType === Node.TEXT_NODE) { startContainer = next; startOffset = 0; }
    else if (previous?.nodeType === Node.TEXT_NODE) {
      startContainer = previous;
      startOffset = previous.textContent?.length ?? 0;
    }
  }
  const startElement = startContainer.nodeType === Node.ELEMENT_NODE
    ? startContainer as HTMLElement : startContainer.parentElement;
  const value = startElement?.closest<HTMLElement>('.prompt-chip-wf-value');
  let workflowValue: CursorPosition['workflowValue'];
  if (value && value !== root && root.contains(value)) {
    workflowValue = { index: Array.from(root.querySelectorAll('.prompt-chip-wf-value')).indexOf(value),
      offset: saveCursor(value).offset, focused: document.activeElement === value };
  }
  const walker = createCursorWalker(root);
  let offset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === startContainer) return { offset: offset + startOffset, workflowValue };
    if (node.nodeType === Node.TEXT_NODE) offset += (node.textContent || '').length;
    else if (isChipEl(node)) offset += 1;
  }
  return { offset, workflowValue };
};

const restoreCursor = (root: HTMLElement, position: CursorPosition): void => {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const applyRange = () => { range.collapse(true); sel.removeAllRanges(); sel.addRange(range); };
  if (position.workflowValue) {
    const value = root.querySelectorAll<HTMLElement>('.prompt-chip-wf-value')[position.workflowValue.index];
    if (value) {
      if (position.workflowValue.focused) value.focus({ preventScroll: true });
      restoreCursor(value, { offset: position.workflowValue.offset });
      return;
    }
  }
  const walker = createCursorWalker(root);
  let count = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const nodeLen = node.nodeType === Node.TEXT_NODE ? (node.textContent || '').length : isChipEl(node) ? 1 : 0;
    if (isChipEl(node) && count + nodeLen >= position.offset) {
      if (position.offset <= count) {
        ensureCaretSlotBeforeChip(node);
        const before = node.previousSibling;
        if (before?.nodeType === Node.TEXT_NODE) range.setStart(before, before.textContent?.length ?? 0);
        else range.setStart(ensureCaretSlotAfterChip(node), 0);
      } else range.setStart(ensureCaretSlotAfterChip(node), 0);
      applyRange();
      return;
    }
    if (node.nodeType === Node.TEXT_NODE && count + nodeLen >= position.offset) {
      range.setStart(node, Math.max(0, position.offset - count));
      applyRange();
      return;
    }
    count += nodeLen;
  }
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
};

// ═══════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════

const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditor({
  value: prompt = '',
  disabled = false,
  onChange,
  onSubmit,
  placeholder = translate('输入提示词开始创作   (Enter 生成，Shift+Enter 换行)'),
  ariaLabel,
  portalDropdown = false,
  nodeId,
  selectedWorkflowId,
  canSubmit = true,
  submitOnShiftEnter = false,
  submitShortcut,
  onFocus,
  onBlur,
  onSlashTrigger,
  className = '',
}: MentionEditorProps, ref) {
  const t = useT();
  // ── @ Mention state ──
  const [showMention, setShowMention] = useState(false);
  useEffect(() => {
    if (!showMention || disabled) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setShowMention(false);
      editorRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [showMention, disabled]);
  const [mentionQuery, setMentionQuery] = useState('');
  // 弹窗搜索独立于提示词中的 @ 查询，不能把搜索内容写进正文。
  const [resourceSearchExpanded, setResourceSearchExpanded] = useState(false);
  const [resourceSearchQuery, setResourceSearchQuery] = useState('');
  const [resourceSearchVisible, setResourceSearchVisible] = useState(SEARCH_PAGE_SIZE);
  const [resourceSearchActiveKey, setResourceSearchActiveKey] = useState<string | null>(null);
  const resourceSearchListId = useId();
  const globalAssetsRequestedRef = useRef(false);
  const mentionEditorWrapRef = useRef<HTMLDivElement>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const [mentionDropdownPosition, setMentionDropdownPosition] = useState({ left: 12, top: 0 });
  const mentionDropdownHeightRef = useRef<number | null>(null);
  const [mentionDropdownResizing, setMentionDropdownResizing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  useComfyDomImageSources(editorRef);
  const disabledRef = useRef(disabled);
  const historyRef = useRef(new MentionEditorHistory());
  const syncedPromptRef = useRef(prompt);
  const composingRef = useRef(false);
  const [compositionRevision, setCompositionRevision] = useState(0);
  const savedMentionRangeRef = useRef<Range | null>(null);
  const textInputActiveRef = useRef(false);
  const textInputSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const rememberTextInputSelection = useCallback(() => {
    const root = editorRef.current;
    if (!textInputActiveRef.current || !root) return;
    const selection = readMentionTextSelection(root);
    if (selection) textInputSelectionRef.current = selection;
  }, []);
  const textInputSelection = useCallback(() => {
    textInputActiveRef.current = true;
    rememberTextInputSelection();
    const length = editorRef.current ? serializeDOM(editorRef.current).length : 0;
    const saved = textInputSelectionRef.current;
    return saved ? { start: Math.min(saved.start, length), end: Math.min(saved.end, length) } : { start: length, end: length };
  }, [rememberTextInputSelection]);
  const replacementChipRef = useRef<MentionChipTarget | null>(null);
  const [chipMenu, setChipMenu] = useState<{ target: MentionChipTarget; x: number; y: number } | null>(null);
  const selectFirstMentionRef = useRef<(() => void) | null>(null);
  const lastFocusedWfValueRef = useRef<HTMLSpanElement | null>(null);
  const cancelChipDragRef = useRef<(() => void) | null>(null);
  const lastChipClickRef = useRef<{ chip: HTMLElement; time: number; x: number; y: number } | null>(null);
  const [refmodSession, setRefmodSession] = useState<RefmodEditSession>();
  const refmodSessionRef = useRef<RefmodEditSession | undefined>(undefined);
  const [refmodUiError, setRefmodUiError] = useState('');
  const { nodes, edges, workflows, dramaAssets, globalCharacters, globalScenes, globalProps, globalDramaAssetsLoading, globalDramaAssetsError, currentProjectId } = useAppStore(
    useShallow((state) => ({
      nodes: state.nodes,
      edges: state.edges,
      workflows: state.workflows,
      dramaAssets: state.dramaAssets,
      globalCharacters: state.globalCharacters,
      globalScenes: state.globalScenes,
      globalProps: state.globalProps,
      globalDramaAssetsLoading: state.globalDramaAssetsLoading,
      globalDramaAssetsError: state.globalDramaAssetsError,
      currentProjectId: state.currentProjectId,
    })),
  );
  const globalAssets = useMemo(() => listGlobalDramaAssets({ globalCharacters, globalScenes, globalProps }),
    [globalCharacters, globalScenes, globalProps]);
  const editorOwnerRef = useRef({ projectId: currentProjectId, nodeId });
  const isCurrentEditorOwner = useCallback(() => (
    useAppStore.getState().currentProjectId === currentProjectId
    && editorOwnerRef.current.projectId === currentProjectId
    && editorOwnerRef.current.nodeId === nodeId
  ), [currentProjectId, nodeId]);
  const isCurrentChipTarget = useCallback((target: MentionChipTarget) => {
    const root = editorRef.current;
    return !disabledRef.current && isCurrentEditorOwner() && target.projectId === currentProjectId
      && target.nodeId === nodeId && !!root && root.contains(target.chip) && serializeDOM(root) === target.prompt;
  }, [currentProjectId, nodeId, isCurrentEditorOwner]);
  useEffect(() => {
    const history = historyRef.current;
    return () => history.clear();
  }, []);
  useEffect(() => () => {
    cancelChipDragRef.current?.();
    cancelChipDragRef.current = null;
    lastChipClickRef.current = null;
  }, [currentProjectId, nodeId, prompt]);

  // ── 资产引用弹窗 ──
  const assetFolders = useAppStore((s) => s.config.assetFolders);
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  useLayoutEffect(() => {
    disabledRef.current = disabled;
    if (!disabled) return;
    cancelChipDragRef.current?.();
    cancelChipDragRef.current = null;
    if (chipHoverTimer.current !== null) clearTimeout(chipHoverTimer.current);
    chipHoverTimer.current = null;
    if (lastHoverKeyRef.current) useAppStore.getState().setHoveredMentionNodeId(null);
    lastHoverKeyRef.current = null;
    editorRef.current?.blur();
    refmodSessionRef.current = undefined;
    savedMentionRangeRef.current = null;
    replacementChipRef.current = null;
  }, [disabled]);
  const [assetList, setAssetList] = useState<AssetFileEntry[]>([]);
  const [assetFolderEntries, setAssetFolderEntries] = useState<AssetFolderEntry[]>([]);
  const [assetGlobalRootPath, setAssetGlobalRootPath] = useState<string | null>(null);
  const [assetFolderSelection, setAssetFolderSelection] = useState<AssetFolderSelection>({ kind: 'all' });
  const [assetCreativeKind, setAssetCreativeKind] = useState<DramaAssetCategory | null>(null);
  const assetPickerDialogRef = useRef<HTMLDivElement>(null);
  const [assetTagMap, setAssetTagMap] = useState<Record<string, string[]>>({});
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetLoadError, setAssetLoadError] = useState(false);
  const [assetScanTruncated, setAssetScanTruncated] = useState(false);
  const [assetLoadRevision, setAssetLoadRevision] = useState(0);
  const [assetSearch, setAssetSearch] = useState('');
  const [activeAssetTag, setActiveAssetTag] = useState<string | null>(null);
  const [assetTagsExpanded, setAssetTagsExpanded] = useState(false);
  const [assetTagsOverflow, setAssetTagsOverflow] = useState(false);
  const [visibleAssetTagCount, setVisibleAssetTagCount] = useState(Number.POSITIVE_INFINITY);
  const assetTagRowRef = useRef<HTMLDivElement>(null);
  const assetTagListRef = useRef<HTMLDivElement>(null);
  const assetTagListId = useId();
  const [assetVisible, setAssetVisible] = useState(40);
  const assetSentinelRef = useRef<HTMLDivElement | null>(null);

  // ── Selected workflow and its IO nodes ──
  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.id === selectedWorkflowId),
    [workflows, selectedWorkflowId],
  );
  const selectedWorkflowRef = useRef(selectedWorkflow);
  useLayoutEffect(() => {
    selectedWorkflowRef.current = selectedWorkflow;
    refmodSessionRef.current = undefined;
    const timer = window.setTimeout(() => {
      if (!refmodSessionRef.current) { setRefmodSession(undefined); setRefmodUiError(''); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentProjectId, nodeId, selectedWorkflow]);
  const workflowIONodes = useMemo(
    () => workflowInputNodes(selectedWorkflow),
    [selectedWorkflow],
  );

  // ── Build nodeId → { type, displayId, thumbnailUrl } map ──
  const nodeMetaMap = useMemo(() => getNodeMetaMap(nodes), [nodes]);

  // ── Rebuild DOM when prompt changes externally ──
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const owner = editorOwnerRef.current;
    const ownerChanged = owner.projectId !== currentProjectId || owner.nodeId !== nodeId;
    if (ownerChanged) {
      composingRef.current = false;
      textInputSelectionRef.current = null;
      savedMentionRangeRef.current = null;
      replacementChipRef.current = null;
      setChipMenu(null);
      setShowMention(false);
      setShowAssetPicker(false);
      setMentionQuery('');
      setAssetList([]);
      setAssetFolderEntries([]);
      setAssetGlobalRootPath(null);
      setAssetFolderSelection({ kind: 'all' });
      setAssetCreativeKind(null);
      setAssetTagMap({});
      editorOwnerRef.current = { projectId: currentProjectId, nodeId };
      historyRef.current.clear();
    }
    // IME 组合输入期间保留浏览器的文本节点，结束后再通过输入基线合并新引用。
    if (composingRef.current) return;
    syncGlobalCharacterReferenceChips(el);
    syncComfyRefmodReferenceChips(el);
    syncShotlistReferenceChips(el, nodeMetaMap);
    syncImageReferenceLabels(el, nodeMetaMap);
    const previousPrompt = syncedPromptRef.current;
    syncedPromptRef.current = prompt;
    const syncHistory = () => {
      const history = historyRef.current;
      const snapshot = captureMentionEditorSnapshot(el, prompt);
      if (!history.current) history.reset(snapshot);
      else if (history.current.prompt !== prompt) history.record(snapshot);
      else history.refresh(snapshot);
    };
    if (serializeDOM(el) === prompt) {
      // 外部清空才归一化残留空行；本地换行及其撤销快照保留真实 DOM。
      if (prompt === '' && el.innerHTML !== '' && (ownerChanged || previousPrompt !== prompt)) {
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
      syncHistory();
      return;
    }
    const sel = window.getSelection();
    const cursorOffset = sel && sel.rangeCount && el.contains(sel.getRangeAt(0).startContainer)
      ? saveCursor(el) : null;
    cancelChipDragRef.current?.();
    cancelChipDragRef.current = null;
    if (replacementChipRef.current) {
      replacementChipRef.current = null;
      setShowMention(false);
      setShowAssetPicker(false);
    }
    setChipMenu(null);
    el.innerHTML = '';
    for (const node of renderPromptToNodes(prompt, nodeMetaMap)) {
      el.appendChild(node);
    }
    syncImageReferenceLabels(el, nodeMetaMap);
    normalizeChipSlots(el);
    if (cursorOffset !== null) restoreCursor(el, cursorOffset);
    syncHistory();
  }, [compositionRevision, currentProjectId, nodeId, prompt, nodeMetaMap, globalAssets, dramaAssets]);

  useLayoutEffect(() => {
    const root = editorRef.current;
    if (root && !composingRef.current) syncMentionChipLocale(root, nodeMetaMap, t);
  }, [compositionRevision, nodeMetaMap, t]);

  // ── Emit prompt string to parent ──
  const emitDOM = useCallback((group: string | null = null) => {
    if (disabledRef.current) return;
    const el = editorRef.current;
    if (!el) return;
    syncGlobalCharacterReferenceChips(el);
    syncComfyRefmodReferenceChips(el);
    syncImageReferenceLabels(el, nodeMetaMap);
    const nextPrompt = serializeDOM(el);
    const previousPrompt = syncedPromptRef.current;
    syncedPromptRef.current = nextPrompt;
    // IME 中间态仍实时回写，整次组合输入只在结束时形成一个撤销步骤。
    if (!composingRef.current) historyRef.current.record(captureMentionEditorSnapshot(el, nextPrompt), group);
    onChange(nextPrompt, previousPrompt);
  }, [nodeMetaMap, onChange]);

  const applyHistory = useCallback((direction: 'undo' | 'redo') => {
    if (disabledRef.current) return;
    const el = editorRef.current;
    if (!el || composingRef.current) return;
    cancelChipDragRef.current?.();
    cancelChipDragRef.current = null;
    historyRef.current.updateSelection(captureMentionEditorSelection(el));
    const snapshot = historyRef.current[direction]();
    if (!snapshot) return;
    const previousPrompt = syncedPromptRef.current;
    restoreMentionEditorSnapshot(el, snapshot);
    syncGlobalCharacterReferenceChips(el);
    syncComfyRefmodReferenceChips(el);
    syncShotlistReferenceChips(el, nodeMetaMap);
    syncImageReferenceLabels(el, nodeMetaMap);
    syncedPromptRef.current = snapshot.prompt;
    lastFocusedWfValueRef.current = (document.activeElement as HTMLElement | null)?.closest<HTMLSpanElement>('.prompt-chip-wf-value') ?? null;
    savedMentionRangeRef.current = null;
    replacementChipRef.current = null;
    setChipMenu(null);
    setShowMention(false);
    onChange(snapshot.prompt, previousPrompt);
  }, [nodeMetaMap, onChange]);

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const beforeInput = (event: InputEvent) => {
      if (disabledRef.current) {
        event.preventDefault();
        return;
      }
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        if (composingRef.current || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        applyHistory(event.inputType === 'historyUndo' ? 'undo' : 'redo');
        return;
      }
      historyRef.current.updateSelection(captureMentionEditorSelection(el));
    };
    el.addEventListener('beforeinput', beforeInput);
    return () => el.removeEventListener('beforeinput', beforeInput);
  }, [applyHistory]);

  const canvasMentionNodes = useMemo(
    () => (showMention ? resolveCanvasMentionNodes(nodeId, nodes, edges) : []),
    [edges, nodeId, nodes, showMention],
  );
  const workflowMentionNodes = useMemo(
    () => (showMention ? resolveWorkflowMentionNodes(selectedWorkflowId, workflowIONodes) : []),
    [selectedWorkflowId, showMention, workflowIONodes],
  );

  const filteredCanvasMentions = mentionQuery
    ? canvasMentionNodes.filter((n) => matchesMentionQuery(mentionQuery, n.searchValues ?? [n.id, n.label, n.displayId, n.displayId != null ? `#${n.displayId}` : undefined]))
    : canvasMentionNodes;
  const filteredWorkflowMentions = mentionQuery
    ? workflowMentionNodes.filter((n) => matchesMentionQuery(mentionQuery, [n.id, n._ioNodeId, n.label]))
    : workflowMentionNodes;

  const currentEditorNode = nodes.find((node) => node.id === nodeId);
  const currentNodeType = currentEditorNode?.data.type;
  const isAudioNode = currentNodeType === 'ai-audio';
  const isVideoNode = currentNodeType === 'ai-video';
  const dramaMentionItems = useMemo(() => {
    if (!showMention) return [];
    return resolveDramaMentionItems(dramaAssets, mentionQuery, currentNodeType);
  }, [showMention, dramaAssets, mentionQuery, currentNodeType]);
  const allDramaMentionItems = useMemo(
    () => showMention ? resolveDramaMentionItems(dramaAssets, '', currentNodeType, globalAssets) : [],
    [showMention, dramaAssets, currentNodeType, globalAssets],
  );
  const projectMentionNodes = useMemo(
    () => showMention && resourceSearchExpanded ? resolveCanvasMentionNodes(nodeId, nodes, edges, 'project') : [],
    [showMention, resourceSearchExpanded, nodeId, nodes, edges],
  );
  const hasGlobalAssetReference = prompt.includes('@drama{global/');
  useEffect(() => {
    const searching = (showMention && resourceSearchExpanded) || showAssetPicker;
    if (!searching && (!hasGlobalAssetReference || globalAssetsRequestedRef.current)) return;
    const state = useAppStore.getState();
    // 全局创作资产按需加载，不依赖用户先打开资产库。
    globalAssetsRequestedRef.current = true;
    if (!state.globalDramaAssetsLoading) void state.loadGlobalDramaAssets().catch(() => {
      globalAssetsRequestedRef.current = false;
      useAppStore.getState().showToast(translate('全局创作资产加载失败，请重试'), 'error');
    });
  }, [showMention, resourceSearchExpanded, showAssetPicker, hasGlobalAssetReference]);

  // 角色参考图 / 动作列表 / 单个动作的素材选择。
  const [dramaRefPickerId, setDramaRefPickerId] = useState<string | null>(null);
  const [dramaActionPicker, setDramaActionPicker] = useState(false);
  const [dramaVoicePicker, setDramaVoicePicker] = useState(false);
  const [dramaActionId, setDramaActionId] = useState<string | null>(null);
  // @ 面板的 Tab / 资产种类筛选
  const [pickerTab, setPickerTab] = useState<'nodes' | 'assets' | 'workflow' | null>(null);
  const [comfySection, setComfySection] = useState<'inputs' | 'roles'>('inputs');
  const [workflowMediaFilter, setWorkflowMediaFilter] = useState<'all' | WorkflowIONodeType>('all');
  const localComfyWorkflow = selectedWorkflow && (!selectedWorkflow.adapterType || selectedWorkflow.adapterType === 'comfyui') ? selectedWorkflow : undefined;
  const canMentionRefmod = !disabled && isVideoNode && currentEditorNode?.data.role !== 'source' && currentEditorNode?.data.status !== 'loading' && !!localComfyWorkflow;
  const activeRefmodSession = refmodSession && canMentionRefmod && refmodSession.projectId === currentProjectId && refmodSession.nodeId === nodeId
    && refmodSession.workflow === selectedWorkflow ? refmodSession : undefined;
  const effectiveComfySection = canMentionRefmod ? comfySection : 'inputs';
  const refmodOptions = useComfyRefmodMentionOptions({
    enabled: canMentionRefmod && ((showMention && ((pickerTab === 'workflow' && comfySection === 'roles') || resourceSearchExpanded)) || !!activeRefmodSession),
    workflow: localComfyWorkflow,
  });
  const manualRefmods = currentEditorNode?.data.comfyRefmods ?? EMPTY_REFMODS;
  const [dramaKind, setDramaKind] = useState<string>('all');
  useEffect(() => {
    if (!showMention) {
      setResourceSearchExpanded(false);
      setResourceSearchQuery('');
      setResourceSearchVisible(SEARCH_PAGE_SIZE);
      setResourceSearchActiveKey(null);
      setDramaRefPickerId(null);
      setDramaVoicePicker(false);
      setDramaActionPicker(false);
      setDramaActionId(null);
      setPickerTab(null);
      setComfySection('inputs');
      setWorkflowMediaFilter('all');
      setDramaKind('all');
    }
  }, [showMention]);

  // ── Clear saved range when both mention menu and asset picker are closed ──
  // （@ 菜单切到资产弹窗时需保留光标范围，供选中资产后插入芯片）
  useEffect(() => {
    if (!showMention && !showAssetPicker) {
      savedMentionRangeRef.current = null;
      replacementChipRef.current = null;
    }
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
      if (editorRef.current && !editorRef.current.parentElement?.contains(e.target as Node)
        && !mentionDropdownRef.current?.contains(e.target as Node)) {
        setShowMention(false);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [showMention]);

  // ── Helpers ──
  /** 选择完成后移除待替换胶囊，或删除光标前的 @ 查询；失效目标阻止后续插入。 */
  const deleteAtChar = useCallback(() => {
    if (disabledRef.current) return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const replacement = replacementChipRef.current;
    if (replacement) {
      replacementChipRef.current = null;
      if (!isCurrentChipTarget(replacement)) {
        setShowMention(false);
        setShowAssetPicker(false);
        return false;
      }
      const range = document.createRange();
      range.selectNode(replacement.chip);
      range.deleteContents();
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    if (!container || container.nodeType !== Node.TEXT_NODE) return true;
    const cursor = range.startOffset;
    const textBefore = (container.textContent || '').slice(0, cursor);
    const atIdx = textBefore.lastIndexOf('@');
    if (atIdx < 0) return true;
    const r = document.createRange();
    r.setStart(container, atIdx);
    r.setEnd(container, cursor);
    r.deleteContents();
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  }, [isCurrentChipTarget]);

  const closeRefmodSettings = useCallback(() => {
    refmodSessionRef.current = undefined;
    setRefmodSession(undefined);
  }, []);

  const openRefmodSettings = useCallback((asset: ComfyRefmodAsset, thumbnailUrl?: string, chip?: HTMLElement, manualIndex?: number) => {
    const root = editorRef.current;
    const state = useAppStore.getState();
    if (!root || !nodeId || !localComfyWorkflow || !canMentionRefmod || state.currentProjectId !== currentProjectId) return;
    try {
      const node = state.nodes.find((item) => item.id === nodeId);
      if (!node) throw new Error(translate('视频节点已不存在，请重新打开提示词'));
      if (node.data.role === 'source' || node.data.status === 'loading') throw new Error(translate('源视频或正在生成的视频不能修改角色引用'));
      const replacement = replacementChipRef.current;
      if (!chip && replacement) {
        if (!isCurrentChipTarget(replacement)) return;
        chip = replacement.chip;
      }
      const currentPrompt = serializeDOM(root);
      const token = chip?.getAttribute('data-refmod-raw') || undefined;
      const initial = manualIndex === undefined ? (token ? parseComfyRefmodMentions(token).mentions[0]?.selection : undefined) : node.data.comfyRefmods?.[manualIndex];
      if (manualIndex !== undefined && !initial) throw new Error(translate('手工绑定已变化，请重新打开列表'));
      const parsed = parseComfyRefmodMentions(currentPrompt);
      const otherMentions = [...parsed.mentions];
      const editingIndex = token ? otherMentions.findIndex((item) => item.token === token) : -1;
      if (editingIndex >= 0) otherMentions.splice(editingIndex, 1);
      const existing = mergeComfyRefmodSelections((node.data.comfyRefmods ?? []).filter((_, index) => index !== manualIndex), otherMentions.map((item) => item.selection));
      const selection = window.getSelection();
      const saved = savedMentionRangeRef.current ?? (selection?.rangeCount ? selection.getRangeAt(0) : undefined);
      const session: RefmodEditSession = {
        asset, thumbnailUrl, initial, manualIndex, existing, token, chip, range: saved?.cloneRange(),
        projectId: currentProjectId, nodeId, workflow: localComfyWorkflow, prompt: currentPrompt,
        nodeSnapshot: JSON.stringify([node.data.workflowId, node.data.provider, node.data.comfyRefmods]),
      };
      refmodSessionRef.current = session;
      replacementChipRef.current = null;
      setRefmodSession(session); setRefmodUiError('');
      setShowMention(false); setMentionQuery('');
    } catch (cause) { setRefmodUiError(cause instanceof Error ? cause.message : translate('读取 ComfyUI 角色引用失败')); }
  }, [nodeId, localComfyWorkflow, canMentionRefmod, currentProjectId, isCurrentChipTarget]);

  const editRefmodChip = useCallback((chip: HTMLElement) => {
    try {
      const raw = chip.getAttribute('data-refmod-raw') || '';
      const mention = parseComfyRefmodMentions(raw).mentions[0];
      if (!mention) throw new Error(translate('角色引用已损坏，请删除后重新选择'));
      const saved = useAppStore.getState().config.comfyRefmodAssets?.find((item) => comfyRefmodKey(item) === comfyRefmodKey(mention.selection));
      const asset = saved ?? { ...mention.selection, id: comfyRefmodKey(mention.selection), name: mention.label, tags: [], updatedAt: 0 };
      openRefmodSettings(asset, resolveComfyRefmodChipPresentation(raw)?.thumbnailUrl, chip);
    } catch (cause) { setRefmodUiError(cause instanceof Error ? cause.message : translate('无法编辑角色引用')); }
  }, [openRefmodSettings]);

  const applyRefmodMention = useCallback(async (selection: ComfyRefmodSelection) => {
    const session = refmodSessionRef.current;
    const root = editorRef.current;
    if (!session || !root) throw new Error(translate('角色设置已关闭，请重新选择'));
    const assertCurrent = () => {
      if (disabledRef.current) throw new Error(translate('编辑器已禁用，请停止当前操作后重试'));
      const state = useAppStore.getState();
      const node = state.nodes.find((item) => item.id === session.nodeId);
      if (refmodSessionRef.current !== session || state.currentProjectId !== session.projectId
        || editorOwnerRef.current.nodeId !== session.nodeId || selectedWorkflowRef.current !== session.workflow
        || state.workflows.find((item) => item.id === session.workflow.id) !== session.workflow || !node
        || node.data.role === 'source' || node.data.status === 'loading'
        || session.nodeSnapshot !== JSON.stringify([node.data.workflowId, node.data.provider, node.data.comfyRefmods])
        || serializeDOM(root) !== session.prompt) throw new Error(translate('项目、工作流或提示词已变化，请关闭设置后重新选择'));
      return node;
    };
    const current = assertCurrent();
    // 手工绑定不能被提示词悄悄覆盖；需要用户先在“已绑定”列表移除冲突项。
    const retainedManual = (current.data.comfyRefmods ?? []).filter((_, index) => index !== session.manualIndex);
    mergeComfyRefmodSelections(retainedManual, [selection]);
    mergeComfyRefmodSelections(session.existing, [selection]);
    const prepared = await prepareComfyRefmodSelections(session.workflow, [selection], session.existing);
    assertCurrent();
    const resolved = prepared.find((item) => item.loaderNodeId === selection.loaderNodeId && item.slot === selection.slot
      && comfyRefmodKey(item) === comfyRefmodKey(selection));
    if (!resolved) throw new Error(translate('无法确认目标槽位，请刷新目录后重试'));
    if (session.manualIndex !== undefined) {
      const latest = assertCurrent();
      const next = [...(latest.data.comfyRefmods ?? [])];
      next[session.manualIndex] = resolved;
      useAppStore.getState().updateNodeData(session.nodeId, { comfyRefmods: next });
      closeRefmodSettings();
      return;
    }
    const raw = buildComfyRefmodMention(resolved, session.asset.name);
    const chip = buildComfyRefmodChipEl(raw, session.thumbnailUrl);
    root.focus({ preventScroll: true });
    const caret = window.getSelection();
    if (!caret) throw new Error(translate('无法恢复提示词光标，请重新打开设置'));
    let range: Range;
    if (session.chip) {
      if (!root.contains(session.chip) || (session.chip.getAttribute('data-refmod-raw') || undefined) !== session.token) throw new Error(translate('角色胶囊已变化，请重新选择'));
      session.chip.replaceWith(chip);
      range = document.createRange();
    } else {
      if (!session.range || !root.contains(session.range.startContainer) || !root.contains(session.range.endContainer)) throw new Error(translate('插入位置已变化，请重新输入 @ 选择'));
      caret.removeAllRanges(); caret.addRange(session.range);
      if (!deleteAtChar()) throw new Error(translate('插入位置已变化，请重新输入 @ 选择'));
      range = caret.rangeCount ? caret.getRangeAt(0) : session.range;
      const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
      const workflowChip = element?.closest('[data-wf-id]');
      if (workflowChip && root.contains(workflowChip)) { range.setStartAfter(workflowChip); range.collapse(true); }
      range.insertNode(chip);
    }
    ensureCaretSlotBeforeChip(chip);
    range.setStartAfter(chip); range.collapse(true);
    caret.removeAllRanges(); caret.addRange(range);
    savedMentionRangeRef.current = null;
    emitDOM(); closeRefmodSettings();
  }, [deleteAtChar, emitDOM, closeRefmodSettings]);

  const removeManualRefmod = useCallback((reference: ComfyRefmodSelection) => {
    const state = useAppStore.getState();
    const node = state.nodes.find((item) => item.id === nodeId);
    if (state.currentProjectId !== currentProjectId || !node || !currentEditorNode || node.data.status === 'loading' || node.data.role === 'source'
      || selectedWorkflowRef.current !== selectedWorkflow
      || JSON.stringify([node.data.workflowId, node.data.comfyRefmods]) !== JSON.stringify([currentEditorNode.data.workflowId, manualRefmods])) {
      setRefmodUiError(translate('项目或视频绑定已变化，请重新打开 ComfyUI 角色列表')); return;
    }
    state.updateNodeData(node.id, { comfyRefmods: manualRefmods.filter((item) => item !== reference) });
    setRefmodUiError('');
  }, [nodeId, currentProjectId, currentEditorNode, selectedWorkflow, manualRefmods]);

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
    dismissMenu: () => {
      if (!showMention && !chipMenu) return false;
      replacementChipRef.current = null;
      setShowMention(false);
      setChipMenu(null);
      editorRef.current?.focus({ preventScroll: true });
      return true;
    },
    textInput: {
      get selectionStart() { return textInputSelection().start; },
      get selectionEnd() { return textInputSelection().end; },
      focus: (options?: FocusOptions) => {
        textInputActiveRef.current = true;
        editorRef.current?.focus(options);
      },
      setSelectionRange: (start: number, end: number) => {
        const root = editorRef.current;
        if (!root) return;
        textInputActiveRef.current = true;
        selectMentionText(root, start, end);
        rememberTextInputSelection();
      },
    },
    insertMentionAtCursor: (id: string, label: string) => {
      if (disabledRef.current) return;
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
  }), [insertChipAtCursor, emitDOM, nodeMetaMap, textInputSelection, rememberTextInputSelection, showMention, chipMenu]);

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
      if (useAppStore.getState().currentProjectId !== currentProjectId) return;
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
      if (!deleteAtChar()) return;
      insertChipAtCursor(refNodeId, refLabel);
      setShowMention(false);
      setMentionQuery('');
    },
    [currentProjectId, deleteAtChar, insertChipAtCursor],
  );

  const handleSelectWorkflowMention = useCallback(
    (ioNodeId: string, ioNodeTitle: string, ioNodeType: WorkflowIONodeType) => {
      if (useAppStore.getState().currentProjectId !== currentProjectId) return;
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
      if (!deleteAtChar()) return;
      insertWorkflowChipAtCursor(ioNodeId, ioNodeTitle, ioNodeType);
      setShowMention(false);
      setMentionQuery('');
    },
    [currentProjectId, deleteAtChar, insertWorkflowChipAtCursor],
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

  // 收起搜索时返回提示词光标，仍保留 @ 范围供下一次选择使用。
  const focusMentionCursor = useCallback(() => {
    const editor = editorRef.current;
    const saved = savedMentionRangeRef.current;
    editor?.focus({ preventScroll: true });
    if (!editor || !saved || !editor.contains(saved.startContainer) || !editor.contains(saved.endContainer)) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(saved.cloneRange());
  }, []);

  /** 二级菜单：引用角色的某一张参考图，或把全部参考图拼成一张 */
  const handleSelectDramaReference = useCallback(
    (
      item: { id: string; name: string; kind: string },
      pick: string,
      thumb?: string,
    ) => {
      if (!isCurrentEditorOwner()) return;
      restoreMentionCursor();
      if (!deleteAtChar()) return;
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
    [isCurrentEditorOwner, restoreMentionCursor, deleteAtChar, insertDramaChipAtCursor],
  );

  const handleSelectDramaMention = useCallback(
    (item: ReturnType<typeof resolveDramaMentionItems>[number]) => {
      if (!isCurrentEditorOwner()) return;
      // 资产库始终保留 @drama 身份，绑图节点只用于读取缩略图。
      restoreMentionCursor();
      if (!deleteAtChar()) return;
      let thumb: string | undefined;
      if (item.imageNodeId && !item.id.startsWith('global/')) {
        const n = nodes.find((x) => x.id === item.imageNodeId);
        thumb = bestNodeThumb(n?.data ?? {}) || item.imageUrl;
      } else {
        thumb = item.imageUrl || item.referenceImages?.find((reference) => reference.imageUrl)?.imageUrl;
      }
      insertDramaChipAtCursor(item.id, item.name, item.kind, thumb);
      setShowMention(false);
      setMentionQuery('');
    },
    [isCurrentEditorOwner, nodes, restoreMentionCursor, deleteAtChar, insertDramaChipAtCursor],
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
    focusMentionCursor();
    setShowMention(false);
    setShowAssetPicker(true);
    setAssetSearch('');
    setAssetFolderSelection({ kind: 'all' });
    setAssetCreativeKind(null);
    setActiveAssetTag(null);
    setAssetTagsExpanded(false);
  }, [focusMentionCursor]);

  const closeAssetPicker = useCallback(() => {
    setShowAssetPicker(false);
    focusMentionCursor();
  }, [focusMentionCursor]);
  useDialogFocus(showAssetPicker && !disabled, assetPickerDialogRef, closeAssetPicker, { zIndex: 10050 });

  // 只在搜索/资产弹窗打开时读取目录；键入关键词只过滤本轮缓存。
  const shouldLoadAssets = showAssetPicker || (showMention && resourceSearchExpanded);
  useEffect(() => {
    if (!shouldLoadAssets) return;
    let alive = true;
    const controller = new AbortController();
    setAssetList([]);
    setAssetFolderEntries([]);
    setAssetGlobalRootPath(null);
    setAssetTagMap({});
    setAssetLoading(true);
    setAssetLoadError(false);
    setAssetScanTruncated(false);
    void Promise.allSettled([listGlobalFolderContents({ signal: controller.signal }), listExternalFolderContents(assetFolders ?? [], { maxFilesPerFolder: 3000, signal: controller.signal }), getAllAssetMeta()])
      .then(([globalResult, folderResult, metaResult]) => {
        if (!alive || useAppStore.getState().currentProjectId !== currentProjectId) return;
        const globalFiles = globalResult.status === 'fulfilled' ? globalResult.value.files : [];
        const folderFiles = folderResult.status === 'fulfilled' ? folderResult.value.files : [];
        const metas = metaResult.status === 'fulfilled' ? metaResult.value : [];
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
        const folders = [...(globalResult.status === 'fulfilled' ? globalResult.value.folders : []),
          ...(folderResult.status === 'fulfilled' ? folderResult.value.folders : [])];
        const uniqueFolders = Array.from(new Map(folders.map((folder) => [JSON.stringify([folder.rootPath, folder.relativePath]), folder])).values());
        setAssetFolderEntries(uniqueFolders);
        setAssetFolderSelection((selection) => selection.kind === 'folder'
          && !uniqueFolders.some((folder) => folder.rootPath === selection.rootPath && folder.relativePath === selection.relativePath)
          ? { kind: 'all' } : selection);
        setAssetGlobalRootPath(globalResult.status === 'fulfilled' ? globalResult.value.rootPath : null);
        setAssetTagMap(tagMap);
        setAssetLoadError(globalResult.status === 'rejected' || folderResult.status === 'rejected'
          || (globalResult.status === 'fulfilled' && globalResult.value.folders.some((folder) => folder.availability === 'offline'))
          || (folderResult.status === 'fulfilled' && folderResult.value.folders.some((folder) => folder.availability === 'offline')));
        setAssetScanTruncated((globalResult.status === 'fulfilled' && globalResult.value.truncated)
          || (folderResult.status === 'fulfilled' && folderResult.value.truncated));
      })
      .catch(() => { if (alive && useAppStore.getState().currentProjectId === currentProjectId) setAssetLoadError(true); })
      .finally(() => { if (alive && useAppStore.getState().currentProjectId === currentProjectId) setAssetLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [shouldLoadAssets, assetFolders, assetLoadRevision, currentProjectId, nodeId]);

  const handleSelectAsset = useCallback(
    (file: AssetFileEntry) => {
      if (!isCurrentEditorOwner()) return;
      const el = editorRef.current;
      if (el) el.focus();
      const saved = savedMentionRangeRef.current;
      savedMentionRangeRef.current = null;
      if (saved) {
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(saved); }
      }
      if (!deleteAtChar()) return;
      insertAssetChipAtCursor(file.path, file.assetUrl);
      setShowAssetPicker(false);
      setShowMention(false);
      setMentionQuery('');
    },
    [isCurrentEditorOwner, deleteAtChar, insertAssetChipAtCursor],
  );

  // 标签合并 + 派生标签 chip
  const taggedAssets = useMemo(
    () => assetList.map((f) => {
      const key = f.assetId ?? f.path;
      return assetTagMap[key] ? { ...f, tags: assetTagMap[key] } : f;
    }),
    [assetList, assetTagMap],
  );
  const folderAssets = useMemo(() => selectAssetFolderFiles(taggedAssets, assetFolderSelection), [taggedAssets, assetFolderSelection]);
  const globalPickerItems = useMemo(() => showAssetPicker ? resolveGlobalAssetPickerItems(globalAssets, null, '', currentNodeType) : [],
    [showAssetPicker, globalAssets, currentNodeType]);
  const creativePickerItems = useMemo(() => showAssetPicker && assetCreativeKind ? resolveGlobalAssetPickerItems(globalAssets, assetCreativeKind, assetSearch, currentNodeType) : [],
    [showAssetPicker, globalAssets, assetCreativeKind, assetSearch, currentNodeType]);
  const creativePickerCounts = useMemo(() => ({
    character: globalPickerItems.filter((item) => item.category === 'character').length,
    scene: globalPickerItems.filter((item) => item.category === 'scene').length,
    prop: globalPickerItems.filter((item) => item.category === 'prop').length,
    weapon: globalPickerItems.filter((item) => item.category === 'weapon').length,
  }), [globalPickerItems]);
  const assetTagList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of folderAssets) for (const t of f.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  }, [folderAssets]);

  // 沿用资产库的完整单排标签与“更多”折叠方式，缩放动画中用布局宽度测量。
  useEffect(() => {
    if (!showAssetPicker || disabled || assetCreativeKind) return;
    const row = assetTagRowRef.current;
    const list = assetTagListRef.current;
    if (!row || !list) return;
    const measure = () => {
      const rowStyle = window.getComputedStyle(row);
      const availableWidth = row.clientWidth - (parseFloat(rowStyle.paddingLeft) || 0) - (parseFloat(rowStyle.paddingRight) || 0);
      const rowGap = parseFloat(rowStyle.columnGap) || 0;
      const listGap = parseFloat(window.getComputedStyle(list).columnGap) || 0;
      const widths = Array.from(list.children, (item) => (item as HTMLElement).offsetWidth);
      const contentWidth = widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * listGap;
      const overflow = contentWidth > availableWidth + 1;
      setAssetTagsOverflow(overflow);
      if (!overflow) {
        setVisibleAssetTagCount(widths.length);
        setAssetTagsExpanded(false);
        return;
      }
      let usedWidth = 0;
      let visibleCount = 0;
      for (const width of widths) {
        const nextWidth = usedWidth + (visibleCount > 0 ? listGap : 0) + width;
        if (nextWidth > availableWidth - 28 - rowGap) break;
        usedWidth = nextWidth;
        visibleCount++;
      }
      setVisibleAssetTagCount(visibleCount);
    };
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [showAssetPicker, disabled, assetCreativeKind, assetTagList, assetTagsExpanded]);

  const filteredAssets = useMemo(() => {
    const q = assetSearch.trim().toLowerCase();
    return folderAssets.filter((f) => {
      if (activeAssetTag && !(f.tags ?? []).includes(activeAssetTag)) return false;
      if (q) {
        const inName = f.name.toLowerCase().includes(q);
        const inTags = (f.tags ?? []).some((t) => t.toLowerCase().includes(q));
        if (!inName && !inTags) return false;
      }
      return true;
    });
  }, [folderAssets, assetSearch, activeAssetTag]);

  // 增量渲染：过滤变化时重置
  useEffect(() => { setAssetVisible(40); }, [assetSearch, activeAssetTag, showAssetPicker, assetFolderSelection, assetCreativeKind]);
  const visibleAssets = useMemo(() => filteredAssets.slice(0, assetVisible), [filteredAssets, assetVisible]);
  const visibleCreativePickerItems = useMemo(() => creativePickerItems.slice(0, assetVisible), [creativePickerItems, assetVisible]);
  const assetPickerResultCount = assetCreativeKind ? creativePickerItems.length : filteredAssets.length;
  useEffect(() => {
    // 搜索可先预读资产；弹窗真正显示列表后才有哨兵，开关和加载状态也需重新绑定。
    if (!showAssetPicker || disabled || (assetCreativeKind ? globalDramaAssetsLoading : assetLoading)) return;
    const el = assetSentinelRef.current;
    if (!el) return;
    const root = el.closest('.asset-picker-grid') as HTMLElement | null;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setAssetVisible((c) => (c < assetPickerResultCount ? c + 40 : c));
      }
    }, { root, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [showAssetPicker, disabled, assetLoading, globalDramaAssetsLoading, assetCreativeKind, assetFolderSelection, assetPickerResultCount, assetVisible]);

  // ── Input handler: detect @ and / ──
  const handleInput = useCallback((event: React.FormEvent<HTMLDivElement>) => {
    if (disabledRef.current) return;
    replacementChipRef.current = null;
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
    const inputType = (event.nativeEvent as InputEvent).inputType;
    const group = ['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(inputType) ? inputType : null;
    emitDOM(group);
  }, [emitDOM, onSlashTrigger, showMention]);

  // ── KeyDown: mention navigation / submit / chip deletion ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabledRef.current) { e.preventDefault(); return; }
      // 输入法组合中：回车/方向键属于候选框，不该触发提交或 @ 选中
      if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      const refmodChip = (e.target as Element | null)?.closest?.<HTMLElement>('[data-refmod-raw]');
      if (refmodChip && e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation(); editRefmodChip(refmodChip); return;
      }
      if (refmodChip && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault(); refmodChip.remove(); emitDOM(); return;
      }
      if (editorRef.current) historyRef.current.updateSelection(captureMentionEditorSelection(editorRef.current));
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || (key === 'y' && !e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        applyHistory(key === 'y' || e.shiftKey ? 'redo' : 'undo');
        return;
      }
      const enterAction = resolvePromptEnterAction(e, submitShortcut ?? (submitOnShiftEnter ? 'shift-enter' : 'enter'), showMention);
      // 方向键导航前先补好行首芯片的光标落点（ZWSP），否则光标跳不到芯片前
      if (e.key.startsWith('Arrow') && editorRef.current) normalizeChipSlots(editorRef.current);
      // @ mention: Enter → select first match
      if (enterAction === 'mention') {
        e.preventDefault();
        selectFirstMentionRef.current?.();
        return;
      }
      // @ mention: Escape → close
      if (showMention && e.key === 'Escape') {
        e.preventDefault();
        setShowMention(false);
        return;
      }
      // Submit with the shortcut chosen by the parent; mention selection keeps plain Enter.
      if (enterAction === 'submit') {
        e.preventDefault();
        if (e.repeat) return;
        const text = editorRef.current ? serializeDOM(editorRef.current) : '';
        if (canSubmit && text.trim() && onSubmit) onSubmit();
        return;
      }
      // 换行时手动插入单个 <br>，避免浏览器在芯片旁默认插入两个 <br>（换两行）
      if (enterAction === 'newline') {
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
        // 芯片前的零宽落点不是正文：行首合并换行，文档开头则保留落点。
        let chipSlot: Node | null = null;
        if (node.nodeType === Node.TEXT_NODE && isChipEl(node.nextSibling)
          && !(node.textContent || '').slice(0, offset).replaceAll(ZWSP, '')) {
          chipSlot = node;
        } else if (node === editorRef.current) {
          const after = node.childNodes[offset];
          const before = node.childNodes[offset - 1];
          if (after?.nodeType === Node.TEXT_NODE && after.textContent === ZWSP && isChipEl(after.nextSibling)) {
            chipSlot = after;
          } else if (isChipEl(after) && before?.nodeType === Node.TEXT_NODE && before.textContent === ZWSP) {
            chipSlot = before;
          }
        }
        if (chipSlot && (isBrEl(chipSlot.previousSibling)
          || (!chipSlot.previousSibling && chipSlot.parentNode === editorRef.current))) {
          e.preventDefault();
          if (node !== chipSlot) {
            range.setStart(chipSlot, (chipSlot.textContent || '').length);
            range.collapse(true);
          }
          if (isBrEl(chipSlot.previousSibling)) {
            (chipSlot.previousSibling as ChildNode).remove();
            emitDOM();
          }
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
        if (node.nodeType === Node.ELEMENT_NODE && isChipEl(node.childNodes[range.startOffset])) {
          e.preventDefault(); (node.childNodes[range.startOffset] as HTMLElement).remove(); emitDOM(); return;
        }
        if (node && node.nodeType === Node.TEXT_NODE) {
          const textLen = (node.textContent || '').length;
          if (range.startOffset === textLen) {
            const next = node.nextSibling;
            if (next && next.nodeType === Node.ELEMENT_NODE) {
              const nextEl = next as HTMLElement;
              if (isChipEl(nextEl)) {
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
      canSubmit,
      onSubmit,
      submitOnShiftEnter,
      submitShortcut,
      emitDOM,
      applyHistory,
      editRefmodChip,
    ],
  );

  // ── Paste: plain text only ──
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (disabledRef.current) return;
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

  // ── 芯片 hover：读取对应内容的小卡片，保留原有引用高亮联动 ──
  const lastHoverKeyRef = useRef<string | null>(null);
  const chipHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipHoverSuppressedRef = useRef(false);
  const [chipHoverSuppressed, setChipHoverSuppressed] = useState(false);
  const [chipTip, setChipTip] = useState<{
    source: MentionPreviewSource; key: string; x: number; y: number; width: number;
    ownerNodeId?: string; ownerProjectId: typeof currentProjectId; assetUrl?: string; assetUnavailable?: boolean;
  } | null>(null);
  if (disabled) {
    if (showMention) setShowMention(false);
    if (showAssetPicker) setShowAssetPicker(false);
    if (refmodSession) setRefmodSession(undefined);
    if (chipTip) setChipTip(null);
    if (chipMenu) setChipMenu(null);
  }
  const handleEditorMouseLeave = useCallback(() => {
    if (chipHoverTimer.current !== null) clearTimeout(chipHoverTimer.current);
    chipHoverTimer.current = null;
    lastHoverKeyRef.current = null;
    useAppStore.getState().setHoveredMentionNodeId(null);
    setChipTip(null);
  }, []);
  const handleEditorMouseOver = useCallback((e: React.MouseEvent) => {
    if (chipMenu || showMention || e.buttons !== 0 || chipHoverSuppressedRef.current || editorRef.current?.classList.contains('is-chip-dragging')) {
      handleEditorMouseLeave();
      return;
    }
    const el = (e.target as Element).closest?.<HTMLElement>('[data-ref-id],[data-drama-id],[data-asset-path],[data-refmod-raw]') ?? null;
    const source = el && editorRef.current?.contains(el) ? readMentionPreviewSource(el) : null;
    const key = source ? `${source.kind}:${source.id}` : null;
    if (key === lastHoverKeyRef.current) return; // 同一芯片，跳过避免抖动
    handleEditorMouseLeave();
    lastHoverKeyRef.current = key;
    if (source?.kind === 'node') useAppStore.getState().setHoveredMentionNodeId(parseShotlistRowMentionId(source.id)?.nodeId || source.id);
    if (el && source && key) {
      chipHoverTimer.current = setTimeout(() => {
        chipHoverTimer.current = null;
        const stillHovered = () => !chipHoverSuppressedRef.current
          && !editorRef.current?.classList.contains('is-chip-dragging')
          && lastHoverKeyRef.current === key && el.isConnected && editorRef.current?.contains(el)
          && useAppStore.getState().currentProjectId === currentProjectId;
        if (!stillHovered()) return;
        const rect = el.getBoundingClientRect();
        const width = Math.min(264, window.innerWidth - 24);
        const height = Math.min(208, window.innerHeight - 24);
        // 优先放在编辑器内的下方，空间不足时使用既有锚定翻转算法。
        const position = rect.bottom + 8 + height <= window.innerHeight - 12
          ? calcFixedPosition(rect.left, rect.bottom + 8, width, height, 12)
          : calcAnchoredPosition(rect, width, height, 8, 12);
        const tip = { source, key, x: position.left, y: position.top, width,
          ownerNodeId: nodeId, ownerProjectId: currentProjectId };
        setChipTip(tip);
        if (source.kind === 'asset' && ['image', 'video'].includes(getFileCategory(source.label))) {
          // Resolve only the hovered file; do not scan asset folders or retain stale results.
          void getAssetUrlFromPath(source.id).then((assetUrl) => {
            if (stillHovered()) setChipTip((current) => current === tip
              ? { ...current, assetUrl, assetUnavailable: !assetUrl } : current);
          }, () => {
            if (stillHovered()) setChipTip((current) => current === tip
              ? { ...current, assetUnavailable: true } : current);
          });
        }
      }, 120);
    }
  }, [chipMenu, showMention, currentProjectId, handleEditorMouseLeave, nodeId]);
  const closeChipMenu = useCallback((restoreFocus = false) => {
    setChipMenu(null);
    if (restoreFocus) editorRef.current?.focus({ preventScroll: true });
  }, []);
  const handleChipContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const root = editorRef.current;
    if (!root || disabledRef.current || composingRef.current || !isCurrentEditorOwner()) return;
    const chip = findDraggableMentionChip(root, event.target);
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    cancelChipDragRef.current?.();
    cancelChipDragRef.current = null;
    lastChipClickRef.current = null;
    handleEditorMouseLeave();
    historyRef.current.endGroup();
    historyRef.current.updateSelection(captureMentionEditorSelection(root));
    replacementChipRef.current = null;
    setShowMention(false);
    setChipMenu({ target: { chip, prompt: serializeDOM(root), projectId: currentProjectId, nodeId }, x: event.clientX, y: event.clientY });
  }, [currentProjectId, nodeId, isCurrentEditorOwner, handleEditorMouseLeave]);
  const replaceMenuChip = useCallback(() => {
    closeChipMenu();
    if (!chipMenu || !isCurrentChipTarget(chipMenu.target)) return;
    const target = chipMenu.target;
    replacementChipRef.current = target;
    const range = document.createRange();
    range.selectNode(target.chip);
    savedMentionRangeRef.current = range;
    focusMentionCursor();
    setMentionQuery('');
    setPickerTab(target.chip.hasAttribute('data-drama-id') ? 'assets'
      : target.chip.hasAttribute('data-wf-id') || target.chip.hasAttribute('data-refmod-raw') ? 'workflow' : 'nodes');
    setComfySection(target.chip.hasAttribute('data-refmod-raw') ? 'roles' : 'inputs');
    setShowMention(true);
  }, [chipMenu, closeChipMenu, isCurrentChipTarget, focusMentionCursor]);
  const deleteMenuChip = useCallback(() => {
    closeChipMenu();
    if (!chipMenu || !isCurrentChipTarget(chipMenu.target)) return;
    const root = editorRef.current!;
    const range = document.createRange();
    range.selectNode(chipMenu.target.chip);
    range.deleteContents();
    range.collapse(true);
    normalizeChipSlots(root);
    root.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    emitDOM();
  }, [chipMenu, closeChipMenu, isCurrentChipTarget, emitDOM]);
  const handleChipPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (disabledRef.current) return;
    const root = editorRef.current;
    if (!root || event.button !== 0 || event.pointerType === 'touch') return;
    const source = findDraggableMentionChip(root, event.target);
    if (!source) { lastChipClickRef.current = null; return; }
    event.preventDefault();
    event.stopPropagation();
    cancelChipDragRef.current?.();
    handleEditorMouseLeave();
    setShowMention(false);
    root.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(ensureCaretSlotAfterChip(source), 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    cancelChipDragRef.current = startMentionChipDrag({
      root, source, pointerId: event.pointerId,
      clientX: event.clientX, clientY: event.clientY, onCommit: emitDOM,
      isCurrent: () => useAppStore.getState().currentProjectId === currentProjectId,
      onDragStart: () => { lastChipClickRef.current = null; },
      onClick: (release) => {
        if (release.ctrlKey || release.altKey || release.metaKey) { lastChipClickRef.current = null; return; }
        const previous = lastChipClickRef.current;
        const now = Date.now();
        if (previous?.chip === source && now - previous.time <= 400
          && Math.hypot(release.clientX - previous.x, release.clientY - previous.y) < 4) {
          lastChipClickRef.current = null;
          if (source.hasAttribute('data-refmod-raw')) { editRefmodChip(source); return; }
          const reference = findReferencePreviewSource(source);
          if (reference) requestReferencePreview(reference, root.ownerDocument);
        } else lastChipClickRef.current = { chip: source, time: now, x: release.clientX, y: release.clientY };
      },
    });
  }, [currentProjectId, emitDOM, handleEditorMouseLeave, editRefmodChip]);
  useEffect(() => {
    const dismissTransientReferences = () => {
      cancelChipDragRef.current?.();
      cancelChipDragRef.current = null;
      lastChipClickRef.current = null;
      handleEditorMouseLeave();
      setShowMention(false);
    };
    document.addEventListener(REFERENCE_PREVIEW_EVENT, dismissTransientReferences);
    return () => document.removeEventListener(REFERENCE_PREVIEW_EVENT, dismissTransientReferences);
  }, [handleEditorMouseLeave]);
  const chipPreview = useMemo<MentionChipPreview | null>(() => {
    if (!chipTip || chipTip.ownerNodeId !== nodeId || chipTip.ownerProjectId !== currentProjectId) return null;
    const { source } = chipTip;
    if (source.kind === 'node') return resolveMentionPreview(nodes, source.id, source.label, nodeMetaMap.get(source.id)?.thumbnailUrl);
    if (source.kind === 'drama') return resolveDramaMentionPreview(dramaAssets, globalAssets, nodes, source.id, source.label);
    if (source.kind === 'refmod') {
      try {
        const mention = parseComfyRefmodMentions(source.id).mentions[0];
        if (!mention) return null;
        return { label: mention.label, outputType: 'image', thumbnailUrl: resolveComfyRefmodChipPresentation(source.id)?.thumbnailUrl,
          text: `${mention.selection.fileName}\n${t('加载节点 #{node} · 槽位 {slot}', { node: mention.selection.loaderNodeId || '—', slot: mention.selection.slot ?? '—' })}\n${mention.selection.loaderType === 'refmods-lab' ? t('参考强度沿用工作流 Combine 设置') : t('参考强度 {strength}', { strength: mention.selection.strength })}`,
          missing: false, description: t('ComfyUI 角色参考包 · 双击调整槽位和强度，生成前重新校验') };
      } catch { return { label: source.label, outputType: 'text', text: '', missing: true, description: t('角色引用已损坏，请删除后重新选择') }; }
    }
    const category = getFileCategory(source.label);
    return {
      label: source.label, displayId: undefined, sprite: undefined,
      outputType: category === 'other' ? 'text' : category,
      thumbnailUrl: category === 'image' && !chipTip.assetUnavailable ? chipTip.assetUrl : undefined,
      videoUrl: category === 'video' && !chipTip.assetUnavailable ? chipTip.assetUrl : undefined,
      text: '', missing: !!chipTip.assetUnavailable,
      description: chipTip.assetUnavailable ? t('素材文件不可用') : t('素材库 · {kind}', { kind: t({ image: '图像素材', video: '视频素材', audio: '音频素材', text: '文本文件', other: '文件' }[category]) }),
    };
  }, [chipTip, currentProjectId, dramaAssets, globalAssets, nodeId, nodeMetaMap, nodes, t]);
  const chipSpriteSource = useComfyImageSource(chipPreview?.sprite ? chipPreview.thumbnailUrl : undefined);
  useEffect(() => {
    // 捕获画布、文字选择和胶囊拖动；原生拖放开始后可能立即收到 pointercancel。
    let nativeDragging = false;
    const updateSuppressed = (pressed: boolean) => {
      const suppressed = pressed || nativeDragging;
      chipHoverSuppressedRef.current = suppressed;
      setChipHoverSuppressed(suppressed);
      if (suppressed) handleEditorMouseLeave();
    };
    const pointerDown = (event: PointerEvent) => {
      const previous = lastChipClickRef.current;
      if (previous && (!(event.target instanceof Node) || !previous.chip.contains(event.target))) lastChipClickRef.current = null;
      updateSuppressed(true);
    };
    const pointerUp = (event: PointerEvent) => updateSuppressed(event.buttons !== 0);
    const pointerMove = (event: PointerEvent) => {
      // 在窗口外松开后重新进入，也能恢复普通悬浮。
      if (event.buttons === 0 && !nativeDragging && chipHoverSuppressedRef.current) updateSuppressed(false);
    };
    const pointerCancel = () => { lastChipClickRef.current = null; updateSuppressed(false); };
    const dragStart = () => {
      nativeDragging = true;
      updateSuppressed(true);
    };
    const reset = () => {
      nativeDragging = false;
      lastChipClickRef.current = null;
      updateSuppressed(false);
      handleEditorMouseLeave();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        lastChipClickRef.current = null;
        if (lastHoverKeyRef.current) handleEditorMouseLeave();
      }
    };
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointermove', pointerMove, true);
    window.addEventListener('pointercancel', pointerCancel, true);
    window.addEventListener('dragstart', dragStart, true);
    window.addEventListener('dragend', reset, true);
    window.addEventListener('drop', reset, true);
    window.addEventListener('blur', reset);
    window.addEventListener('resize', handleEditorMouseLeave);
    window.addEventListener('scroll', handleEditorMouseLeave, true);
    window.addEventListener('keydown', escape);
    return () => {
      if (chipHoverTimer.current !== null) clearTimeout(chipHoverTimer.current);
      lastHoverKeyRef.current = null;
      useAppStore.getState().setHoveredMentionNodeId(null);
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('pointermove', pointerMove, true);
      window.removeEventListener('pointercancel', pointerCancel, true);
      window.removeEventListener('dragstart', dragStart, true);
      window.removeEventListener('dragend', reset, true);
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('resize', handleEditorMouseLeave);
      window.removeEventListener('scroll', handleEditorMouseLeave, true);
      window.removeEventListener('keydown', escape);
    };
  }, [currentProjectId, nodeId, handleEditorMouseLeave]);

  // ── @ 面板数据：输入图（画布节点） / 资产库（短剧资产） / ComfyUI 节点（工作流 IO） ──
  const dramaThumbOf = useCallback((item: { imageNodeId?: string; imageUrl?: string; referenceImages?: Array<CharacterReferenceImage | DramaAssetReferenceImage> }) => {
    if (!item.imageNodeId) return item.imageUrl || item.referenceImages?.find((reference) => reference.imageUrl)?.imageUrl;
    const n = nodes.find((x) => x.id === item.imageNodeId);
    return bestNodeThumb(n?.data ?? {}) || item.imageUrl;
  }, [nodes]);

  const nodeTabItems: MentionPickerItem[] = [
    ...filteredCanvasMentions.map((node) => ({
      key: `node:${node.id}`,
      label: node.label,
      thumbnailUrl: node.thumbnailUrl,
      video: node.outputType === 'video' ? { src: node.videoUrl, filePath: node.filePath } : undefined,
      icon: MEDIA_ICONS[node.outputType],
      badge: node.isSelf ? t('自身') : node.displayId != null ? `#${node.displayId}` : undefined,
      onSelect: () => handleSelectCanvasMention(node.id, node.label),
    })),
  ];
  const workflowInputItems: MentionPickerItem[] = filterWorkflowMentions(filteredWorkflowMentions, workflowMediaFilter).map((node) => ({
    key: `wf:${node.id}`,
    label: node.label,
    icon: MEDIA_ICONS[node._ioType === 'image' || node._ioType === 'video' || node._ioType === 'audio' ? node._ioType : 'text'],
    badge: t('工作流'),
    onSelect: () => handleSelectWorkflowMention(node._ioNodeId, node.label, node._ioType),
  }));
  const refmodTabItems: MentionPickerItem[] = refmodOptions.entries
    .filter(({ asset, characterName }) => matchesMentionQuery(mentionQuery, [asset.name, asset.fileName, characterName, ...asset.tags]))
    .map(({ asset, thumbnailUrl, characterName }) => ({
      key: `refmod:${comfyRefmodKey(asset)}`, label: asset.name, thumbnailUrl,
      icon: 'mdi:account-box-outline', badge: t('ComfyUI 角色'), title: `${asset.name}${characterName ? ` · ${characterName}` : ''}\n${asset.fileName}`,
      onSelect: () => openRefmodSettings(asset, thumbnailUrl),
    }));
  const workflowTabItems = effectiveComfySection === 'roles' ? refmodTabItems : workflowInputItems;

  const drillItem = !isAudioNode && dramaRefPickerId
    ? allDramaMentionItems.find((item) => item.id === dramaRefPickerId)
    : undefined;
  const drillAsset = drillItem ? findDramaAsset(dramaAssets, drillItem.id, globalAssets) : undefined;
  const drillRefs: Array<CharacterReferenceImage | DramaAssetReferenceImage> = (drillItem?.referenceImages ?? []).flatMap((reference) => {
    const image = drillAsset ? resolveDramaAssetImageRef(drillAsset, nodes, reference.id) : undefined;
    return image ? [{ ...reference, imageUrl: image.imageUrl }] : [];
  });
  const drillCharacter = drillAsset?.kind === 'character' ? drillAsset : undefined;
  const drillActions = drillCharacter?.actions ?? [];
  const drillAction = drillActions.find((action) => action.id === dramaActionId);

  const dramaKindChips: MentionPickerChip[] = (() => {
    if (drillItem) return [];
    const counts = new Map<string, number>();
    for (const item of dramaMentionItems) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    if (counts.size === 0) return [];
    return [
      { id: 'all', label: t('全部'), count: dramaMentionItems.length },
      ...[...counts].map(([kind, count]) => ({ id: kind, label: DRAMA_KIND_LABELS[kind] ? t(DRAMA_KIND_LABELS[kind]) : kind, count })),
    ];
  })();

  // 默认资产页和全局搜索共用选中逻辑，角色的参考图、动作、声音仍可继续下钻。
  const buildDramaPickerItem = (item: ReturnType<typeof resolveDramaMentionItems>[number]): MentionPickerItem => {
    const asset = findDramaAsset(dramaAssets, item.id, globalAssets);
    const references = (item.referenceImages ?? []).flatMap((reference) => {
      const image = asset ? resolveDramaAssetImageRef(asset, nodes, reference.id) : undefined;
      return image ? [{ ...reference, imageUrl: image.imageUrl }] : [];
    });
    const multiRef = references.length > 1;
    const character = asset?.kind === 'character' ? asset : undefined;
    const hasActions = !!character?.actions?.length;
    const avatarReference = character?.referenceImages?.find((reference) => reference.id === character.avatarReferenceImageId)
      ?? character?.referenceImages?.find((reference) => reference.id === character.primaryReferenceImageId)
      ?? character?.referenceImages?.[0];
    const avatarCrop = avatarReference?.imageUrl && avatarReference.id === character?.avatarReferenceImageId
      ? character?.avatarCrop
      : undefined;
    const thumb = dramaThumbOf(item) || references[0]?.imageUrl;
    const hasUsableAction = character?.actions?.some((action) =>
      action.media?.some((media) => !!resolveDramaActionMediaRef(character, action.id, media.id)),
    );
    const hasUsableVoice = isVideoNode && character?.voiceClips?.some((clip) =>
      !!resolveDramaVoiceRef(character, clip.id),
    );
    const emptyCharacter = !!character && !isAudioNode && !thumb && !hasUsableAction && !hasUsableVoice;
    return {
      key: `drama:${item.id}`,
      label: item.name,
      thumbnailUrl: avatarReference?.imageUrl || thumb,
      thumbnailCrop: avatarCrop,
      disabled: emptyCharacter,
      title: emptyCharacter ? t('该角色暂无可引用的素材') : undefined,
      icon: isAudioNode ? MEDIA_ICONS.audio : item.category === 'weapon' ? 'lucide:swords' : item.kind === 'scene' ? 'lucide:mountain' : item.kind === 'prop' ? 'lucide:box' : 'mdi:account-box-outline',
      badge: isAudioNode ? t('音频') : multiRef ? t('{count} 图', { count: references.length }) : thumb ? undefined : t('简介'),
      onSelect: () => {
        if (emptyCharacter || !isCurrentEditorOwner()) return;
        if (isAudioNode) {
          if (!item.voice) return;
          restoreMentionCursor();
          if (!deleteAtChar()) return;
          insertDramaChipAtCursor(buildDramaVoiceMentionId(item.id, item.voice.id), item.voice.label, 'voice');
          setShowMention(false);
          setMentionQuery('');
          return;
        }
        if (multiRef || hasActions || (isVideoNode && character?.voiceClips?.length)) {
          setResourceSearchExpanded(false);
          setResourceSearchQuery('');
          setPickerTab('assets');
          setDramaRefPickerId(item.id);
          setDramaVoicePicker(false);
          setDramaActionPicker(false);
          setDramaActionId(null);
          focusMentionCursor();
        } else if (references[0]) {
          handleSelectDramaReference(item, references[0].id, references[0].imageUrl);
        } else handleSelectDramaMention(item);
      },
    };
  };

  const assetTabItems: MentionPickerItem[] = drillItem && drillCharacter && isVideoNode && dramaVoicePicker
    ? (drillCharacter.voiceClips ?? []).map((clip) => ({
      key: `drama-voice:${clip.id}`,
      audioPreviewUrl: resolveDramaVoiceRef(drillCharacter, clip.id)?.url,
      label: clip.label?.trim() || t('角色声音'),
      icon: MEDIA_ICONS.audio,
      disabled: !resolveDramaVoiceRef(drillCharacter, clip.id),
      onSelect: () => {
        if (useAppStore.getState().currentProjectId !== currentProjectId) return;
        const voice = resolveDramaVoiceRef(drillCharacter, clip.id);
        if (!voice) return;
        restoreMentionCursor();
        if (!deleteAtChar()) return;
        insertDramaChipAtCursor(buildDramaVoiceMentionId(drillCharacter.id, clip.id), voice.label, 'voice');
        setShowMention(false);
        setMentionQuery('');
      },
    }))
    : drillItem && dramaActionPicker
    ? drillAction && drillCharacter
      ? (drillAction.media ?? []).map((media) => ({
        key: `drama-action-media:${media.id}`,
        label: media.name,
        thumbnailUrl: media.kind === 'video' ? undefined : media.url,
        video: media.kind === 'video' ? { src: media.url, filePath: media.filePath } : undefined,
        icon: media.kind === 'video' ? 'lucide:film' : 'mdi:image-outline',
        badge: media.kind === 'video' ? t('视频') : media.kind === 'gif' ? 'GIF' : t('图片'),
        disabled: !resolveDramaActionMediaRef(drillCharacter, drillAction.id, media.id),
        onSelect: () => {
          if (useAppStore.getState().currentProjectId !== currentProjectId) return;
          const selected = resolveDramaActionMediaRef(drillCharacter, drillAction.id, media.id);
          if (!selected) return;
          restoreMentionCursor();
          if (!deleteAtChar()) return;
          insertDramaChipAtCursor(
            buildDramaActionMentionId(drillCharacter.id, drillAction.id, media.id),
            selected.label,
            media.kind === 'video' ? 'action-video' : 'action-image',
            media.kind === 'video' ? undefined : selected.url,
          );
          setShowMention(false);
          setMentionQuery('');
        },
      }))
      : drillActions.map((action) => {
        const image = action.media?.find((media) => media.kind !== 'video' && media.url);
        const video = image ? undefined : action.media?.find((media) => media.kind === 'video' && media.url);
        return {
          key: `drama-action:${action.id}`, label: action.name, thumbnailUrl: image?.url,
          video: video ? { src: video.url, filePath: video.filePath } : undefined,
          icon: 'lucide:accessibility', badge: t('{count} 素材', { count: action.media?.length ?? 0 }),
          onSelect: () => setDramaActionId(action.id),
        };
      })
    : drillItem ? [
      ...(drillItem.kind === 'character' && drillRefs.length > 1 ? [{
        key: 'drama-merge-all',
        label: t('全部拼成一张'),
        icon: 'lucide:layout-grid',
        badge: t('{count} 图', { count: drillRefs.length }),
        onSelect: () => handleSelectDramaReference(drillItem, DRAMA_MENTION_MERGE_ALL, drillRefs[0]?.imageUrl),
      }] : []),
      ...drillRefs.map((reference) => ({
        key: `drama-ref:${reference.id}`,
        label: 'kind' in reference ? t(CHARACTER_REFERENCE_KIND_LABELS[reference.kind]) : reference.label || t('参考图'),
        thumbnailUrl: reference.imageUrl,
        onSelect: () => handleSelectDramaReference(drillItem, reference.id, reference.imageUrl),
      })),
      ...(drillRefs.length === 0 ? [{
        key: 'drama-brief', label: dramaThumbOf(drillItem) ? t('主视觉') : t('角色简介'), icon: 'lucide:text',
        thumbnailUrl: dramaThumbOf(drillItem),
        disabled: drillItem.kind === 'character' && !dramaThumbOf(drillItem),
        onSelect: () => handleSelectDramaMention(drillItem),
      }] : []),
    ]
    : dramaMentionItems
      .filter((item) => dramaKind === 'all' || item.category === dramaKind)
      .map(buildDramaPickerItem);

  // 首次打开优先展示有内容的分类；手动切换后保留选择，工作流取消时回到普通分类。
  const defaultTab = nodeTabItems.length > 0 ? 'nodes'
    : localComfyWorkflow && workflowTabItems.length > 0 ? 'workflow'
      : assetTabItems.length > 0 ? 'assets' : 'nodes';
  const effectiveTab = drillItem ? 'assets'
    : pickerTab === 'workflow' && !localComfyWorkflow ? defaultTab
      : pickerTab ?? defaultTab;
  const activeTabItems = effectiveTab === 'assets' ? assetTabItems
    : effectiveTab === 'workflow' ? workflowTabItems : nodeTabItems;

  const resourceSearchCandidates = useMemo(() => {
    if (!showMention || !resourceSearchExpanded) return [];
    const query = resourceSearchQuery;
    return [
      ...projectMentionNodes
        .filter((item) => matchesMentionQuery(query, item.searchValues ?? [item.id, item.label, item.displayId]))
        .map((item) => ({ source: 'node' as const, item })),
      ...allDramaMentionItems
        .filter((item) => matchesMentionQuery(query, [item.id, item.name, DRAMA_KIND_LABELS[item.category], ...(item.aliases ?? [])]))
        .map((item) => ({ source: 'drama' as const, item })),
      ...taggedAssets
        .filter((item) => item.category === 'image' && matchesMentionQuery(query, [item.name, item.assetId, ...(item.tags ?? [])]))
        .map((item) => ({ source: 'file' as const, item })),
      ...workflowMentionNodes
        .filter((item) => matchesMentionQuery(query, [item.id, item._ioNodeId, item.label]))
        .map((item) => ({ source: 'workflow' as const, item })),
      ...refmodOptions.entries
        .filter(({ asset, characterName }) => matchesMentionQuery(query, [asset.name, asset.fileName, characterName, ...asset.tags]))
        .map((item) => ({ source: 'refmod' as const, item })),
    ];
  }, [showMention, resourceSearchExpanded, resourceSearchQuery, projectMentionNodes, allDramaMentionItems, taggedAssets, workflowMentionNodes, refmodOptions.entries]);

  // 在映射卡片之前分批，目录中的大量图片不同时创建 DOM 和缩略图请求。
  const resourceSearchItems: MentionPickerItem[] = resourceSearchCandidates.slice(0, resourceSearchVisible).map((candidate, index) => {
    let item: MentionPickerItem;
    if (candidate.source === 'node') {
      const node = candidate.item;
      item = {
        key: `node:${node.id}`, label: node.label, thumbnailUrl: node.thumbnailUrl,
        video: node.outputType === 'video' ? { src: node.videoUrl, filePath: node.filePath } : undefined,
        icon: MEDIA_ICONS[node.outputType],
        badge: node.isSelf ? t('自身') : node.displayId != null ? `#${node.displayId}` : t('节点'),
        onSelect: () => handleSelectCanvasMention(node.id, node.label),
      };
    } else if (candidate.source === 'drama') {
      item = buildDramaPickerItem(candidate.item);
      item.badge = candidate.item.id.startsWith('global/') ? t('全局{kind}', { kind: t(DRAMA_KIND_LABELS[candidate.item.category]) }) : t(DRAMA_KIND_LABELS[candidate.item.category]);
    } else if (candidate.source === 'file') {
      const file = candidate.item;
      item = {
        key: `file:${file.path}`, label: file.name, thumbnailUrl: file.assetUrl,
        icon: MEDIA_ICONS.image, badge: file.source === 'folder' ? t('目录图片') : t('全局图片'),
        disabled: file.availability === 'offline',
        title: file.availability === 'offline' ? t('{name} · 文件当前不可用', { name: file.name }) : file.name,
        onSelect: () => handleSelectAsset(file),
      };
    } else if (candidate.source === 'workflow') {
      const workflowNode = candidate.item;
      item = {
        key: `wf:${workflowNode.id}`, label: workflowNode.label, badge: t('工作流'),
        icon: MEDIA_ICONS[workflowNode._ioType === 'image' || workflowNode._ioType === 'video' || workflowNode._ioType === 'audio' ? workflowNode._ioType : 'text'],
        onSelect: () => handleSelectWorkflowMention(workflowNode._ioNodeId, workflowNode.label, workflowNode._ioType),
      };
    } else {
      const { asset, thumbnailUrl } = candidate.item;
      item = { key: `refmod:${comfyRefmodKey(asset)}`, label: asset.name, thumbnailUrl, badge: t('ComfyUI 角色'),
        icon: 'mdi:account-box-outline', onSelect: () => openRefmodSettings(asset, thumbnailUrl) };
    }
    return { ...item, domId: `${resourceSearchListId}-item-${index}` };
  });
  const activeSearchItem = resourceSearchItems.find((item) => item.key === resourceSearchActiveKey && !item.disabled)
    ?? resourceSearchItems.find((item) => !item.disabled);
  const resourceSearchLoading = assetLoading || globalDramaAssetsLoading || refmodOptions.loading;

  const handleResourceSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter 只选择搜索结果，不能冒泡成为节点生成或弹窗快捷键。
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) activeSearchItem?.onSelect();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const enabled = resourceSearchItems.filter((item) => !item.disabled);
    if (!enabled.length) return;
    const currentIndex = enabled.findIndex((item) => item.key === activeSearchItem?.key);
    const nextIndex = Math.max(0, Math.min(enabled.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)));
    setResourceSearchActiveKey(enabled[nextIndex].key);
  };

  // 回车与鼠标始终选当前页面中的条目，包括动作及素材下钻页。
  useLayoutEffect(() => {
    selectFirstMentionRef.current = activeTabItems
      .find((item) => !item.disabled)?.onSelect ?? null;
  });

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
      mentionDropdownHeightRef.current ?? dropdown.offsetHeight,
      8,
      12,
    );
    const nextPosition = {
      left: Math.round(safePosition.left - (portalDropdown ? 0 : wrapRect.left)),
      top: Math.round(safePosition.top - (portalDropdown ? 0 : wrapRect.top)),
    };
    setMentionDropdownPosition((current) => (
      current.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition
    ));
  }, [portalDropdown]);

  const handleMentionHeightChange = useCallback((height: number, animated: boolean) => {
    mentionDropdownHeightRef.current = height;
    setMentionDropdownResizing(animated);
    updateMentionDropdownPosition();
  }, [updateMentionDropdownPosition]);

  useLayoutEffect(() => {
    if (!showMention) {
      mentionDropdownHeightRef.current = null;
      setMentionDropdownResizing(false);
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
    resourceSearchExpanded,
    resourceSearchItems.length,
    nodeTabItems.length,
    showMention,
    updateMentionDropdownPosition,
  ]);

  const renderMentionDropdown = (dropdown: React.ReactElement) => (
    portalDropdown ? createPortal(dropdown, document.body) : dropdown
  );

  return (
    <div ref={mentionEditorWrapRef} className={`mention-editor-wrap relative ${className}`} inert={disabled || undefined}>
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        className={`ui-ai-input__editor prompt-editor${!prompt ? ' is-empty' : ''}`}
        data-placeholder={placeholder}
        data-reference-owner-node-id={nodeId}
        onInput={handleInput}
        onCompositionStart={() => {
          if (editorRef.current) historyRef.current.updateSelection(captureMentionEditorSelection(editorRef.current));
          historyRef.current.endGroup();
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          emitDOM();
          // 合并后提示词可能与 Store 相同，仍需刷新组合输入期间暂缓的 DOM。
          setCompositionRevision((revision) => revision + 1);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={rememberTextInputSelection}
        onMouseUp={rememberTextInputSelection}
        onPaste={handlePaste}
        onContextMenu={handleChipContextMenu}
        onPointerDown={handleChipPointerDown}
        onPointerDownCapture={() => {
          if (replacementChipRef.current) {
            replacementChipRef.current = null;
            setShowMention(false);
          }
          historyRef.current.endGroup();
          if (editorRef.current) historyRef.current.updateSelection(captureMentionEditorSelection(editorRef.current));
        }}
        onDragStart={(event) => {
          if (editorRef.current && findDraggableMentionChip(editorRef.current, event.target)) event.preventDefault();
        }}
        onMouseOver={handleEditorMouseOver}
        onMouseLeave={handleEditorMouseLeave}
        onFocus={() => {
          if (editorRef.current) normalizeChipSlots(editorRef.current); // 聚焦即修复历史无落点芯片
          onFocus?.();
        }}
        onBlur={() => {
          rememberTextInputSelection();
          const wasComposing = composingRef.current;
          composingRef.current = false;
          emitDOM();
          if (wasComposing) setCompositionRevision((revision) => revision + 1);
          onBlur?.();
        }}
        spellCheck={false}
      />
      {chipMenu && !disabled && chipMenu.target.projectId === currentProjectId && chipMenu.target.nodeId === nodeId
        && chipMenu.target.prompt === prompt
        && <MentionChipMenu x={chipMenu.x} y={chipMenu.y} onReplace={replaceMenuChip} onDelete={deleteMenuChip} onClose={closeChipMenu} />}
      {refmodUiError && <p className="ui-alert ui-alert--warning mt-2 text-xs" role="alert">{refmodUiError}</p>}
      {activeRefmodSession && <Suspense fallback={null}><ComfyRefmodMentionSettings key={`${activeRefmodSession.nodeSnapshot}:${refmodOptions.catalog?.fetchedAt ?? 'loading'}`}
        workflow={activeRefmodSession.workflow} asset={activeRefmodSession.asset} initial={activeRefmodSession.initial}
        bindingMode={activeRefmodSession.manualIndex !== undefined}
        existing={activeRefmodSession.existing} manual={manualRefmods} catalog={refmodOptions.catalog} loading={refmodOptions.loading}
        error={refmodOptions.error} refresh={refmodOptions.refresh} onClose={closeRefmodSettings} onApply={applyRefmodMention}
      /></Suspense>}

      {/* 保留 chip-name-tip 的 Portal 标记，宿主点外关闭逻辑继续识别。 */}
      {createPortal(
        // 按下时直接卸载详情卡片，避免拖动期间仍残留退出动画。
        disabled || chipHoverSuppressed ? null : <AnimatePresence>
          {chipTip && chipPreview && (
            <motion.div
              key={chipTip.key}
              className="chip-name-tip reference-chip-card ui-card p-2"
              role="tooltip"
              data-reference-preview-open=""
              style={{ left: chipTip.x, top: chipTip.y, width: chipTip.width }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: fadeFast }}
              transition={fadeFast}
            >
              <div className="reference-chip-content flex h-32 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-canvas-bg">
                {chipPreview.outputType === 'video' ? (
                  <VideoThumbnail src={chipPreview.videoUrl} filePath={chipPreview.filePath} poster={chipPreview.thumbnailUrl}
                    name={chipPreview.label} alt={chipPreview.label} className="h-full w-full object-contain" />
                ) : chipPreview.thumbnailUrls && chipPreview.thumbnailUrls.length > 1 ? (
                  <div className="grid h-full w-full grid-cols-2 gap-1 overflow-hidden p-2">
                    {chipPreview.thumbnailUrls.slice(0, 4).map((url, index) => (
                      <ViewportImage key={`${index}:${url}`} src={url} alt={`${chipPreview.label} · ${index + 1}`} className="h-12 w-full object-contain" loading="lazy" />
                    ))}
                  </div>
                ) : chipPreview.thumbnailUrl ? (
                  chipPreview.sprite ? (
                    <div role="img" aria-label={chipPreview.label} className="h-full w-full bg-no-repeat" style={{ backgroundImage: chipSpriteSource ? `url(${JSON.stringify(chipSpriteSource)})` : undefined, ...chipPreview.sprite }} />
                  ) : (
                    <ViewportImage src={chipPreview.thumbnailUrl} alt={chipPreview.label} className="h-full w-full object-contain"
                      onError={chipTip.source.kind === 'asset' ? () => setChipTip((current) => current && current === chipTip
                        ? { ...current, assetUrl: undefined, assetUnavailable: true } : current) : undefined} />
                  )
                ) : chipPreview.text ? (
                  <p className="line-clamp-5 whitespace-pre-wrap break-words p-2 text-xs leading-5 text-canvas-text-secondary">{chipPreview.text}</p>
                ) : (
                  <Icon icon={MEDIA_ICONS[chipPreview.outputType]} className="text-3xl text-canvas-text-muted" aria-hidden="true" />
                )}
              </div>
              <p className="mt-2 line-clamp-2 break-words text-xs font-medium text-canvas-text">{chipPreview.label}</p>
              <span className="mt-1 text-[11px] text-canvas-text-muted">
                {chipPreview.displayId != null ? `#${chipPreview.displayId} · ` : ''}
                {chipPreview.description ?? (chipPreview.missing ? t('引用节点已不存在') : ({ image: t('图像素材'), video: t('视频素材'), audio: t('音频素材'), text: t('文本内容') }[chipPreview.outputType]))}
                {chipPreview.thumbnailUrls && chipPreview.thumbnailUrls.length > 4 ? t(' · 预览前4张') : ''}
              </span>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* @ Mention Dropdown */}
      {showMention && !disabled && renderMentionDropdown(
        <div
          ref={mentionDropdownRef}
          data-mention-picker-open=""
          className={`mention-dropdown${mentionDropdownResizing ? ' is-resizing' : ''} ${portalDropdown ? 'fixed z-[10000]' : 'absolute z-50'} w-[336px] max-w-[calc(100vw-24px)] [&>.mention-picker]:max-h-[calc(100vh-24px)] [&>.mention-picker]:overflow-hidden [&_.mention-picker-grid]:min-h-0`}
          style={{ left: mentionDropdownPosition.left, top: mentionDropdownPosition.top }}
        >
          <MentionPicker
            ariaLabel={t('引用节点或资产')}
            onHeightChange={handleMentionHeightChange}
            search={{
              expanded: resourceSearchExpanded,
              onExpandedChange: (expanded) => {
                setResourceSearchExpanded(expanded);
                if (expanded) {
                  setResourceSearchQuery(mentionQuery);
                  setResourceSearchVisible(SEARCH_PAGE_SIZE);
                  setResourceSearchActiveKey(null);
                }
              },
              value: resourceSearchQuery,
              onChange: (query) => {
                setResourceSearchQuery(query);
                setResourceSearchVisible(SEARCH_PAGE_SIZE);
                setResourceSearchActiveKey(null);
              },
              label: t('搜索全局资源'),
              placeholder: t('节点 ID、#编号、文件名、角色或道具'),
              onKeyDown: handleResourceSearchKeyDown,
              listId: resourceSearchListId,
              activeDescendant: activeSearchItem?.domId,
              onCollapse: focusMentionCursor,
            }}
            listId={resourceSearchExpanded ? resourceSearchListId : undefined}
            activeKey={resourceSearchExpanded ? activeSearchItem?.key : undefined}
            onItemHover={resourceSearchExpanded ? setResourceSearchActiveKey : undefined}
            tabs={[
              { id: 'nodes', label: isAudioNode ? t('输入音频') : t('输入图'), icon: isAudioNode ? MEDIA_ICONS.audio : 'mdi:image-multiple-outline' },
              { id: 'assets', label: t('资产库'), icon: 'mdi:bookshelf' },
              ...(localComfyWorkflow ? [{ id: 'workflow', label: 'ComfyUI' }] : []),
            ]}
            activeTab={effectiveTab}
            onTabChange={(id) => {
              setPickerTab(id as 'nodes' | 'assets' | 'workflow');
              setDramaRefPickerId(null);
              setDramaActionPicker(false);
              setDramaActionId(null);
            }}
            chips={!resourceSearchExpanded && effectiveTab === 'assets' ? dramaKindChips : undefined}
            activeChip={dramaKind}
            onChipChange={setDramaKind}
            leading={!resourceSearchExpanded && effectiveTab === 'workflow' ? (
              <div className="flex w-full flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className={`mention-picker-chip${effectiveComfySection === 'inputs' ? ' active' : ''}`} aria-pressed={effectiveComfySection === 'inputs'} onMouseDown={(event) => event.preventDefault()} onClick={() => setComfySection('inputs')}>{t('工作流输入')}</button>
                  {canMentionRefmod && <button type="button" className={`mention-picker-chip${effectiveComfySection === 'roles' ? ' active' : ''}`} aria-pressed={effectiveComfySection === 'roles'} onMouseDown={(event) => event.preventDefault()} onClick={() => setComfySection('roles')}>{t('ComfyUI 角色')}</button>}
                </div>
                {effectiveComfySection === 'inputs' ? <div className="flex flex-wrap gap-1.5" aria-label={t('工作流输入类型')}>
                  {workflowMentionFilterChips(filteredWorkflowMentions).map((filter) => <button key={filter.id} type="button" className={`mention-picker-chip${workflowMediaFilter === filter.id ? ' active' : ''}`}
                    aria-pressed={workflowMediaFilter === filter.id} onMouseDown={(event) => event.preventDefault()} onClick={() => setWorkflowMediaFilter(filter.id)}>{filter.label}<span className="mention-picker-chip-count">{filter.count}</span></button>)}
                </div> : <>
                  <div className="flex items-center justify-between gap-2 text-xs text-canvas-text-muted"><span>{refmodOptions.catalog?.serverName ?? t('当前工作流服务器')}</span>
                    <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={refmodOptions.loading} onMouseDown={(event) => event.preventDefault()} onClick={refmodOptions.refresh}>{refmodOptions.loading ? t('读取中…') : t('刷新目录')}</button>
                  </div>
                  {refmodOptions.error && <p className="ui-alert ui-alert--warning text-xs" role="status">{refmodOptions.error}</p>}
                  {manualRefmods.length > 0 && <details className="text-xs text-canvas-text-secondary"><summary className="cursor-pointer" onMouseDown={(event) => event.preventDefault()}>{t('已绑定 {count} 项（资源库/拖入）', { count: manualRefmods.length })}</summary>
                    <div className="mt-1 max-h-24 space-y-1 overflow-y-auto">{manualRefmods.map((reference, index) => <div key={`${comfyRefmodKey(reference)}:${index}`} className="flex items-center gap-2 rounded border border-canvas-border p-2">
                      <span className="min-w-0 flex-1 truncate" title={reference.fileName}>{reference.fileName}</span>
                      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0" onMouseDown={(event) => event.preventDefault()} onClick={() => {
                        const saved = useAppStore.getState().config.comfyRefmodAssets?.find((item) => comfyRefmodKey(item) === comfyRefmodKey(reference));
                        openRefmodSettings(saved ?? { ...reference, id: comfyRefmodKey(reference), name: reference.fileName, tags: [], updatedAt: 0 }, undefined, undefined, index);
                      }}>{t('编辑')}</button>
                      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0" onMouseDown={(event) => event.preventDefault()} onClick={() => removeManualRefmod(reference)}>{t('移除')}</button>
                    </div>)}</div>
                  </details>}
                </>}
              </div>
            ) : !resourceSearchExpanded && effectiveTab === 'assets' && drillItem ? (
              <>
                <button
                  type="button"
                  className="mention-picker-chip"
                  aria-label={dramaActionPicker || dramaVoicePicker ? t('返回角色参考图') : t('返回资产列表')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (dramaActionPicker || dramaVoicePicker) {
                      setDramaVoicePicker(false);
                      setDramaActionPicker(false);
                      setDramaActionId(null);
                    } else setDramaRefPickerId(null);
                  }}
                >
                  <Icon icon="lucide:chevron-left" width="12" height="12" />
                  {drillItem.name}
                </button>
                {drillCharacter && (
                  <button
                    type="button"
                    className={`mention-picker-chip${dramaActionPicker ? ' active' : ''}`}
                    aria-pressed={dramaActionPicker}
                    onMouseDown={(e) => { e.preventDefault(); setDramaVoicePicker(false); setDramaActionPicker(true); setDramaActionId(null); }}
                  >
                    <Icon icon="lucide:accessibility" width="12" height="12" />
                    {t('动作')}
                    <span className="mention-picker-chip-count">{drillActions.length}</span>
                  </button>
                )}
                {drillCharacter && isVideoNode && (
                  <button
                    type="button"
                    className={`mention-picker-chip${dramaVoicePicker ? ' active' : ''}`}
                    aria-pressed={dramaVoicePicker}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setDramaVoicePicker(true);
                      setDramaActionPicker(false);
                      setDramaActionId(null);
                    }}
                  >
                    <Icon icon={MEDIA_ICONS.audio} width="12" height="12" />
                    {t('声音')}
                    <span className="mention-picker-chip-count">{drillCharacter.voiceClips?.length ?? 0}</span>
                  </button>
                )}
                {dramaActionPicker && drillAction && (
                  <button type="button" className="mention-picker-chip" aria-label={t('返回动作列表')}
                    onMouseDown={(e) => { e.preventDefault(); setDramaActionId(null); }}>
                    <Icon icon="lucide:chevron-left" width="12" height="12" />
                    {drillAction.name}
                  </button>
                )}
              </>
            ) : undefined}
            items={resourceSearchExpanded ? resourceSearchItems : activeTabItems}
            mediaAspectRatio={!resourceSearchExpanded && effectiveTab === 'assets' ? AVATAR_ASPECT : undefined}
            emptyText={resourceSearchExpanded ? resourceSearchLoading ? t('正在读取资源…') : assetLoadError ? t('暂无匹配结果，部分图片目录读取失败') : t('没有匹配的资源')
              : effectiveTab === 'assets' && drillItem && dramaVoicePicker
              ? t('该角色暂无声音，请先在角色库中添加')
              : effectiveTab === 'assets' && drillItem && dramaActionPicker
              ? drillAction ? t('该动作暂无图片、GIF 或视频素材') : t('该角色暂无动作，请先在角色库中添加')
              : mentionQuery ? t('无匹配节点或资产') : effectiveTab === 'workflow' ? effectiveComfySection === 'roles' ? refmodOptions.loading ? t('正在读取 ComfyUI 角色…') : t('当前工作流暂无可用角色参考包') : t('当前筛选下暂无工作流输入') : effectiveTab === 'assets' ? isAudioNode ? t('暂无带音频的角色，请先在角色库中添加音频') : t('暂无短剧资产') : t('暂无可引用的输入')}
            footer={(
              <>
              {resourceSearchExpanded && ((assetLoadError && !assetLoading)
                || resourceSearchVisible < resourceSearchCandidates.length || assetScanTruncated) && (
                <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs text-canvas-text-secondary">
                  {assetLoadError && !assetLoading && (
                    <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm"
                      title={t('部分图片目录读取失败，点击重试')}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setAssetLoadRevision((revision) => revision + 1)}>
                      {t('重试')}
                    </button>
                  )}
                  {resourceSearchVisible < resourceSearchCandidates.length && (
                    <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ml-auto"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setResourceSearchVisible((count) => count + SEARCH_PAGE_SIZE)}>
                      {t('加载更多')}
                    </button>
                  )}
                  {assetScanTruncated && <span>{t('目录文件过多，部分资源未纳入搜索')}</span>}
                </div>
              )}
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={openAssetPicker}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-canvas-hover"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-indigo-500/15 text-indigo-300">
                  <Icon icon="solar:gallery-bold" width="14" height="14" />
                </span>
                <span className="text-xs text-canvas-text">{t('引用资产')}</span>
                <span className="ml-auto text-[10px] text-canvas-text-muted">{t('全局资产')}</span>
              </button>
              </>
            )}
          />
        </div>
      )}

      {/* 资产引用弹窗（Portal） */}
      {createPortal(
        <AnimatePresence>
          {showAssetPicker && !disabled && (
            <motion.div
              data-tauri-drag-region
              data-mention-picker-open=""
              className="asset-picker-backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onMouseDown={closeAssetPicker}
            >
              <motion.div
                ref={assetPickerDialogRef}
                className="asset-picker"
                role="dialog"
                aria-modal="true"
                aria-label={t('选择全局资产')}
                tabIndex={-1}
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
                      type="text" placeholder={assetCreativeKind ? t('搜索名称、简介…') : t('搜索名称或标签…')} aria-label={t('搜索全局资产')}
                      value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)}
                    />
                  </div>
                  <PopupCloseButton onClick={closeAssetPicker} />
                </div>


                <div className="asset-picker-body">
                  <div className="asset-picker-sidebar">
                    <Suspense fallback={<p role="status" className="p-3 text-xs text-canvas-text-muted">{t('正在打开分类…')}</p>}>
                    <AssetFolderNavigation
                      readOnly compact={false} folders={assetFolderEntries} selection={assetFolderSelection}
                      totalCount={assetList.length} globalCount={selectAssetFolderFiles(assetList, { kind: 'global' }).length}
                      globalRootPath={assetGlobalRootPath} loading={assetLoading}
                      creativeKind={assetCreativeKind} creativeCounts={creativePickerCounts}
                      onSelect={(selection) => {
                        setAssetCreativeKind(null); setAssetFolderSelection(selection); setActiveAssetTag(null); setAssetTagsExpanded(false);
                      }}
                      onSelectCreative={(kind) => {
                        setAssetCreativeKind(kind); setActiveAssetTag(null); setAssetTagsExpanded(false);
                      }}
                    />
                    </Suspense>
                  </div>
                  <div className="asset-picker-content">
                {!assetCreativeKind && (assetLoadError || assetScanTruncated) && <div role="status" className="flex flex-wrap items-center gap-2 p-2 text-xs text-canvas-text-secondary">
                  <span>{assetLoadError ? t('部分目录读取失败') : t('目录文件较多，当前仅显示已扫描的文件')}</span>
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={assetLoading} onClick={() => setAssetLoadRevision((revision) => revision + 1)}>{t('重新读取')}</button>
                </div>}
                {/* 标签筛选 */}
                {!assetCreativeKind && assetTagList.length > 0 && (
                  <div ref={assetTagRowRef} className={`asset-picker-tags${assetTagsExpanded ? ' expanded' : ''}`}>
                    <div ref={assetTagListRef} id={assetTagListId} className="assets-category-list">
                      <button
                        type="button"
                        className={`asset-picker-tag ${activeAssetTag === null ? 'active' : ''} ${assetTagsExpanded || visibleAssetTagCount > 0 ? '' : 'assets-filter-item-hidden'}`}
                        aria-pressed={activeAssetTag === null}
                        onClick={() => setActiveAssetTag(null)}
                      >{t('全部')}</button>
                      {assetTagList.map(([tag, count], index) => (
                        <button
                          key={tag}
                          type="button"
                          className={`asset-picker-tag ${activeAssetTag === tag ? 'active' : ''} ${assetTagsExpanded || index + 1 < visibleAssetTagCount ? '' : 'assets-filter-item-hidden'}`}
                          aria-pressed={activeAssetTag === tag}
                          title={tag}
                          onClick={() => setActiveAssetTag((t) => (t === tag ? null : tag))}
                        ><span className="asset-picker-tag-label">#{tag}</span><span className="asset-picker-tag-count">{count}</span></button>
                      ))}
                    </div>
                    {assetTagsOverflow && (
                      <button type="button" className="assets-filter-more" aria-controls={assetTagListId}
                        aria-expanded={assetTagsExpanded} aria-label={assetTagsExpanded ? t('收起标签') : t('展开更多标签')}
                        title={assetTagsExpanded ? t('收起标签') : t('更多标签')} onClick={() => setAssetTagsExpanded((expanded) => !expanded)}>
                        <Icon icon={assetTagsExpanded ? 'lucide:chevron-up' : 'lucide:ellipsis'} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}

                <div key={assetCreativeKind ?? JSON.stringify(assetFolderSelection)} className="asset-picker-grid">
                  {assetCreativeKind ? (
                    globalDramaAssetsLoading ? <div role="status" className="asset-picker-empty">{t('正在加载创作资产…')}</div>
                      : globalDramaAssetsError ? <div role="alert" className="asset-picker-empty">
                        <p>{t('创作资产加载失败，请重试')}</p>
                        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => {
                          void useAppStore.getState().loadGlobalDramaAssets().catch(() => {});
                        }}>{t('重试加载')}</button>
                      </div>
                        : creativePickerItems.length === 0 ? <div className="asset-picker-empty">{assetSearch ? t('没有匹配的创作资产') : t('暂无可引用的创作资产')}</div>
                          : visibleCreativePickerItems.map((item) => {
                            const candidate = buildDramaPickerItem(item);
                            return <button key={candidate.key} type="button" className="asset-picker-card" disabled={candidate.disabled}
                              data-tooltip={candidate.title ?? candidate.label} onClick={() => {
                                if (!isCurrentEditorOwner()) return;
                                setShowAssetPicker(false);
                                setShowMention(true);
                                candidate.onSelect();
                              }}>
                              {candidate.thumbnailUrl ? <ViewportImage src={candidate.thumbnailUrl} alt="" />
                                : <span className="asset-picker-card-icon"><Icon icon={candidate.icon ?? 'lucide:image'} aria-hidden="true" /></span>}
                              <span className="asset-picker-card-name">{candidate.label}{candidate.badge ? ` · ${candidate.badge}` : ''}</span>
                            </button>;
                          })
                  ) : assetLoading ? (
                    <div className="asset-picker-empty">{t('加载中…')}</div>
                  ) : filteredAssets.length === 0 ? (
                    <div className="asset-picker-empty">{assetSearch || activeAssetTag ? t('没有匹配的文件') : t('暂无文件')}</div>
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
                          {file.category === 'video' ? (
                            <VideoThumbnail src={file.assetUrl} filePath={file.path} name={file.name} alt={file.name}
                              className="aspect-square w-full object-cover" />
                          ) : file.assetUrl ? (
                            <ViewportImage src={file.assetUrl} alt={file.name} />
                          ) : (
                            <span className="asset-picker-card-icon">
                              {file.category === 'audio' ? '🎵' : file.category === 'text' ? '📄' : '📁'}
                            </span>
                          )}
                          <span className="asset-picker-card-name">{file.name}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {assetVisible < assetPickerResultCount && (
                    <div ref={assetSentinelRef} className="asset-picker-sentinel">{t('加载更多…')}</div>
                  )}
                </div>
                  </div>
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
