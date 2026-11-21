/**
 * MentionEditor @提及编辑器 — 支持 @引用其他节点输出的富文本输入框，实时渲染为彩色标签芯片
 */
import { t as translate, useT } from '../../../i18n';
import { lazy, Suspense, useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useId, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import type { PromptSubmitShortcut, WorkflowIONodeType } from '../../../types';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type AppState } from '../../../store/useAppStore';
import { createCanvasNodeDataSelector } from '../../../utils/canvasNodeDataSelector';
import { getCanvasNodeById } from '../../../utils/canvasRenderProjection';
import { Icon } from '@iconify/react';
import { getAssetUrlFromPath, getFileCategory } from '../../../services/fileService';
import { fadeFast } from '../../../utils/motion';
import { calcAnchoredPosition, calcFixedPosition } from '../../../utils/popupPosition';
import { resolveMentionPreview } from './connectedNodesPreviewInteractions';
import { readMentionPreviewSource, resolveDramaMentionPreview, type MentionChipPreview, type MentionPreviewSource } from './mentionEditorPreview';
import { mentionHoverSuppressed, subscribeMentionHoverGestures } from './mentionHoverGestures';
import { AnimatePresence, motion } from 'framer-motion';
import MentionPicker, { type MentionPickerChip, type MentionPickerItem } from '../../shared/MentionPicker';
import MentionChipMenu from './MentionChipMenu';
import ViewportImage from '../../shared/ViewportImage';
import VideoThumbnail from '../../shared/VideoThumbnail';
import { useComfyImageSource } from '../../../hooks/useComfyImageSource';
import { findDraggableMentionChip, startMentionChipDrag } from './mentionEditorChipDrag';
import {
  captureMentionEditorSelection,
  captureMentionEditorSnapshot,
} from './mentionEditorHistory';
import {
  DRAMA_MENTION_MERGE_ALL,
  buildDramaActionMentionId,
  buildDramaVoiceMentionId,
} from '../../../types/dramaAssets';
import type { CharacterReferenceImage, DramaAssetReferenceImage } from '../../../types/dramaAssets';
import { parseShotlistRowMentionId } from '../../../types/shotlist';
import { findReferencePreviewSource, REFERENCE_PREVIEW_EVENT, requestReferencePreview } from '../../../utils/referencePreviewEvents';
import { AVATAR_ASPECT, CHARACTER_REFERENCE_KIND_LABELS } from '../../character/characterReferencePresentation';
import { findDramaAsset, listGlobalDramaAssets, resolveDramaActionMediaRef, resolveDramaAssetImageRef, resolveDramaVoiceRef } from '../../../services/dramaAssetPrompt';
import {
  bestNodeThumb,
  buildChipEl,
  resolveComfyRefmodChipPresentation,
  syncComfyRefmodReferenceChips,
  ensureCaretSlotAfterChip,
  ensureCaretSlotBeforeChip,
  getNodeMetaMap,
  normalizeChipSlots,
  renderPromptToNodes,
  serializeDOM,
  syncGlobalCharacterReferenceChips,
  syncShotlistReferenceChips,
  syncMentionChipLocale,
  syncImageReferenceLabels,
} from './mentionEditorDom';
import {
  matchesMentionQuery,
  resolveCanvasMentionNodes,
  resolveDramaMentionItems,
  resolveWorkflowMentionNodes,
  filterWorkflowMentions,
  workflowMentionFilterChips,
  type WorkflowMentionItem,
} from './mentionEditorSources';
import { useComfyRefmodMentionOptions } from '../../../hooks/useComfyRefmodMentionOptions';
import { parseComfyRefmodMentions } from '../../../utils/comfyRefmodMention';
import { comfyRefmodKey } from '../../../utils/comfyRefmod';
import type { ComfyRefmodSelection } from '../../../types/comfyRefmod';
import { workflowInputNodes } from '../../../services/runninghubWorkflowService';

import {
  restoreCursor, saveCursor, useMentionInputActions, useMentionInputHistory, useMentionInputState,
  type MentionChipTarget, type RefmodEditSession,
} from './useMentionEditorInput';
import { selectMentionText } from './mentionEditorTextSelection';
import { useComfyDomImageSources } from '../../../hooks/useComfyDomImageSources';
import { useMentionAssetPicker } from './useMentionAssetPicker';

const ComfyRefmodMentionSettings = lazy(() => import('./ComfyRefmodMentionSettings'));
const EMPTY_REFMODS: ComfyRefmodSelection[] = [];
const EMPTY_CANVAS_NODES: AppState['nodes'] = [];
const EMPTY_CANVAS_EDGES: AppState['edges'] = [];
// 所有编辑器始终投影完整 nodes、相同展示字段，共用一次比较及元数据缓存。
// 不按 owner/菜单裁剪，也不把只读展示快照用于业务写回。
const selectReferenceNodes = createCanvasNodeDataSelector([
  'displayId', 'imageUrl', 'videoUrl', 'audioUrl', 'thumbnailUrl', 'filePath',
  'directorCaptureUrls', 'storyboardCols', 'storyboardRows', 'storyboardOverrides', 'shotlistRows',
]);
let referenceNodeConsumers = 0;
const INITIAL_MENTION_POSITION = { left: 12, top: 0 };
let highlightedMention: { owner: object; id: string } | undefined;

function releaseMentionHighlight(owner: object) {
  if (highlightedMention?.owner !== owner) return;
  const { id } = highlightedMention;
  highlightedMention = undefined;
  const state = useAppStore.getState();
  if (state.hoveredMentionNodeId === id) state.setHoveredMentionNodeId(null);
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
  useEffect(() => {
    referenceNodeConsumers += 1;
    return () => {
      referenceNodeConsumers -= 1;
      if (referenceNodeConsumers === 0) selectReferenceNodes(undefined);
    };
  }, []);
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
  const [mentionDropdownPosition, setMentionDropdownPosition] = useState(INITIAL_MENTION_POSITION);
  const mentionDropdownWasOpen = useRef(false);
  const mentionDropdownHeightRef = useRef<number | null>(null);
  const [mentionDropdownResizing, setMentionDropdownResizing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  useComfyDomImageSources(editorRef);
  const input = useMentionInputState(editorRef, prompt, disabled);
  const {
    disabledRef, historyRef, syncedPromptRef, composingRef, compositionRevision,
    setCompositionRevision, savedMentionRangeRef, textInputActiveRef, textInputSelectionRef, textInputSelection, rememberTextInputSelection,
    replacementChipRef, chipMenu, setChipMenu, selectFirstMentionRef, lastFocusedWfValueRef,
    cancelChipDragRef, lastChipClickRef, restoreMentionCursor, focusMentionCursor,
  } = input;
  const [refmodSession, setRefmodSession] = useState<RefmodEditSession>();
  const refmodSessionRef = useRef<RefmodEditSession | undefined>(undefined);
  const [refmodUiError, setRefmodUiError] = useState('');
  const [chipTip, setChipTip] = useState<{
    source: MentionPreviewSource; key: string; x: number; y: number; width: number;
    ownerNodeId?: string; ownerProjectId: string | null; assetUrl?: string; assetUnavailable?: boolean;
  } | null>(null);
  const { nodes, edges, referenceNodes, previewNodes, currentEditorData, selectedWorkflow, dramaAssets, globalCharacters, globalScenes, globalProps, globalDramaAssetsLoading, globalDramaAssetsError, currentProjectId } = useAppStore(
    useShallow((state) => ({
      // 完整节点只供展开候选和预览读取，展示投影不参与业务写回。
      nodes: showMention ? state.nodes : EMPTY_CANVAS_NODES,
      edges: showMention ? state.edges : EMPTY_CANVAS_EDGES,
      referenceNodes: selectReferenceNodes(state.nodes),
      previewNodes: chipTip ? state.nodes : EMPTY_CANVAS_NODES,
      currentEditorData: nodeId ? getCanvasNodeById(state.nodes, nodeId)?.data : undefined,
      selectedWorkflow: state.workflows.find((workflow) => workflow.id === selectedWorkflowId),
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

  const currentNodeType = currentEditorData?.type;
  const {
    showAssetPicker, setShowAssetPicker, resetAssetSelection, assetLoading, assetLoadError,
    assetScanTruncated, setAssetLoadRevision, openAssetPicker, taggedAssets, renderAssetPicker,
  } = useMentionAssetPicker({
    t, showMention, setShowMention, resourceSearchExpanded, globalDramaAssetsLoading,
    globalDramaAssetsError, currentProjectId, globalAssets, isCurrentEditorOwner, currentNodeType,
    focusMentionCursor, disabled, nodeId,
  });
  useLayoutEffect(() => {
    disabledRef.current = disabled;
    if (!disabled) return;
    cancelChipDragRef.current?.();
    cancelChipDragRef.current = null;
    if (chipHoverTimer.current !== null) clearTimeout(chipHoverTimer.current);
    chipHoverTimer.current = null;
    releaseMentionHighlight(lastHoverKeyRef);
    lastHoverKeyRef.current = null;
    chipPresenceActive.current = false;
    editorRef.current?.blur();
    refmodSessionRef.current = undefined;
    savedMentionRangeRef.current = null;
    replacementChipRef.current = null;
  }, [disabled]);
  // ── Selected workflow and its IO nodes ──
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
    () => showMention ? workflowInputNodes(selectedWorkflow) : [],
    [showMention, selectedWorkflow],
  );

  // ── Build nodeId → { type, displayId, thumbnailUrl } map ──
  const nodeMetaMap = useMemo(() => getNodeMetaMap(referenceNodes), [referenceNodes]);

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
      resetAssetSelection();
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

  const history = useMentionInputHistory(input, nodeMetaMap, onChange, setShowMention);
  const { emitDOM } = history;

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
  // RH 已提供相同的定向输入；只有角色参考包仍限定本地 ComfyUI。
  const hasWorkflowInputTab = !!localComfyWorkflow || selectedWorkflow?.adapterType === 'runninghub';
  const canMentionRefmod = !disabled && isVideoNode && currentEditorData?.role !== 'source' && currentEditorData?.status !== 'loading' && !!localComfyWorkflow;
  const activeRefmodSession = refmodSession && canMentionRefmod && refmodSession.projectId === currentProjectId && refmodSession.nodeId === nodeId
    && refmodSession.workflow === selectedWorkflow ? refmodSession : undefined;
  const effectiveComfySection = canMentionRefmod ? comfySection : 'inputs';
  const refmodOptions = useComfyRefmodMentionOptions({
    enabled: canMentionRefmod && ((showMention && ((pickerTab === 'workflow' && comfySection === 'roles') || resourceSearchExpanded)) || !!activeRefmodSession),
    workflow: localComfyWorkflow,
  });
  const manualRefmods = currentEditorData?.comfyRefmods ?? EMPTY_REFMODS;
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

  const {
    insertChipAtCursor, deleteAtChar, closeRefmodSettings, openRefmodSettings, editRefmodChip, applyRefmodMention,
    removeManualRefmod, handleSelectCanvasMention, handleSelectWorkflowMention,
    insertDramaChipAtCursor, handleSelectDramaReference, handleSelectDramaMention,
    handleSelectAsset, handleInput, handleKeyDown, handlePaste,
  } = useMentionInputActions({
    input, history, showMention, setShowMention, setMentionQuery, setRefmodSession,
    refmodSessionRef, setRefmodUiError, currentEditorData, selectedWorkflow, currentProjectId,
    editorOwnerRef, isCurrentEditorOwner, isCurrentChipTarget, setShowAssetPicker,
    selectedWorkflowRef, nodeMetaMap, setDramaRefPickerId, localComfyWorkflow, canMentionRefmod,
    manualRefmods, onSubmit, nodeId, canSubmit, submitOnShiftEnter, submitShortcut, onSlashTrigger,
  });

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

  // ── 芯片 hover：读取对应内容的小卡片，保留原有引用高亮联动 ──
  const lastHoverKeyRef = useRef<string | null>(null);
  const chipHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipPresenceActive = useRef(false);
  const [chipPresenceKey, setChipPresenceKey] = useState(0);
  // 浮动面板会复用同一个编辑器。切换归属时释放旧卡片及其完整节点订阅。
  if (chipTip && (disabled || chipTip.ownerNodeId !== nodeId || chipTip.ownerProjectId !== currentProjectId)) {
    setChipTip(null);
  }
  if (disabled) {
    if (showMention) setShowMention(false);
    if (showAssetPicker) setShowAssetPicker(false);
    if (refmodSession) setRefmodSession(undefined);
    if (chipMenu) setChipMenu(null);
  }
  const handleEditorMouseLeave = useCallback(() => {
    if (!lastHoverKeyRef.current) return;
    if (chipHoverTimer.current !== null) clearTimeout(chipHoverTimer.current);
    chipHoverTimer.current = null;
    lastHoverKeyRef.current = null;
    releaseMentionHighlight(lastHoverKeyRef);
    if (chipPresenceActive.current) setChipTip(null);
  }, []);
  const handleEditorMouseOver = useCallback((e: React.MouseEvent) => {
    if (chipMenu || showMention || e.buttons !== 0 || mentionHoverSuppressed(window) || editorRef.current?.classList.contains('is-chip-dragging')) {
      handleEditorMouseLeave();
      return;
    }
    const el = (e.target as Element).closest?.<HTMLElement>('[data-ref-id],[data-drama-id],[data-asset-path],[data-refmod-raw]') ?? null;
    const source = el && editorRef.current?.contains(el) ? readMentionPreviewSource(el) : null;
    const key = source ? `${source.kind}:${source.id}` : null;
    if (key === lastHoverKeyRef.current) return; // 同一芯片，跳过避免抖动
    handleEditorMouseLeave();
    lastHoverKeyRef.current = key;
    if (source?.kind === 'node') {
      const id = parseShotlistRowMentionId(source.id)?.nodeId || source.id;
      highlightedMention = { owner: lastHoverKeyRef, id };
      useAppStore.getState().setHoveredMentionNodeId(id);
    }
    if (el && source && key) {
      chipHoverTimer.current = setTimeout(() => {
        chipHoverTimer.current = null;
        const stillHovered = () => !mentionHoverSuppressed(window)
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
        chipPresenceActive.current = true;
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
    if (source.kind === 'node') return resolveMentionPreview(previewNodes, source.id, source.label, nodeMetaMap.get(source.id)?.thumbnailUrl);
    if (source.kind === 'drama') return resolveDramaMentionPreview(dramaAssets, globalAssets, previewNodes, source.id, source.label);
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
  }, [chipTip, currentProjectId, dramaAssets, globalAssets, nodeId, nodeMetaMap, previewNodes, t]);
  const chipSpriteSource = useComfyImageSource(chipPreview?.sprite ? chipPreview.thumbnailUrl : undefined);
  useEffect(() => {
    const owner = lastHoverKeyRef;
    const unsubscribe = subscribeMentionHoverGestures(window, (event) => {
      if (!owner.current && !chipPresenceActive.current && !lastChipClickRef.current) return;
      if (event.type === 'pointerdown') {
        const previous = lastChipClickRef.current;
        if (previous && (!(event.target instanceof Node) || !previous.chip.contains(event.target))) lastChipClickRef.current = null;
      } else if (['pointercancel', 'drop', 'dragend', 'blur', 'keydown'].includes(event.type)) {
        lastChipClickRef.current = null;
      }
      if (event.type === 'pointercancel' && !mentionHoverSuppressed(window)) return;
      handleEditorMouseLeave();
      // 按下同时卸载正在退场的预览。普通移出仍交给 AnimatePresence 淡出。
      if (chipPresenceActive.current && (event.type === 'pointerdown' || event.type === 'dragstart')) {
        chipPresenceActive.current = false;
        setChipPresenceKey((key) => key + 1);
      }
    });
    return () => {
      unsubscribe();
      if (chipHoverTimer.current !== null) clearTimeout(chipHoverTimer.current);
      chipHoverTimer.current = null;
      owner.current = null;
      releaseMentionHighlight(owner);
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
  const buildWorkflowPickerItem = (node: WorkflowMentionItem): MentionPickerItem => ({
    key: `wf:${node.id}`,
    label: localComfyWorkflow ? `#${node._ioNodeId} ${node.label}` : node.label,
    icon: MEDIA_ICONS[node._ioType === 'image' || node._ioType === 'video' || node._ioType === 'audio' ? node._ioType : 'text'],
    badge: t('工作流'),
    onSelect: () => handleSelectWorkflowMention(node._ioNodeId, node.label, node._ioType),
  });
  const workflowInputItems = filterWorkflowMentions(filteredWorkflowMentions, workflowMediaFilter).map(buildWorkflowPickerItem);
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
    : hasWorkflowInputTab && workflowTabItems.length > 0 ? 'workflow'
      : assetTabItems.length > 0 ? 'assets' : 'nodes';
  const effectiveTab = drillItem ? 'assets'
    : pickerTab === 'workflow' && !hasWorkflowInputTab ? defaultTab
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
      item = buildWorkflowPickerItem(candidate.item);
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
      if (!mentionDropdownWasOpen.current) return;
      mentionDropdownWasOpen.current = false;
      mentionDropdownHeightRef.current = null;
      setMentionDropdownResizing(false);
      setMentionDropdownPosition(INITIAL_MENTION_POSITION);
      return undefined;
    }
    mentionDropdownWasOpen.current = true;
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
        disabled ? null : <AnimatePresence key={chipPresenceKey} onExitComplete={() => {
          if (!lastHoverKeyRef.current) chipPresenceActive.current = false;
        }}>
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
              ...(hasWorkflowInputTab ? [{ id: 'workflow', label: 'ComfyUI' }] : []),
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

      {renderAssetPicker(buildDramaPickerItem, handleSelectAsset)}
    </div>
  );
});

export default MentionEditor;
