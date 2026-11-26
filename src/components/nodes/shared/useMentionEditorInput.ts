import { t as translate } from '../../../i18n';
import { useState, useCallback, useRef, useEffect } from 'react';
import type { PromptSubmitShortcut, WorkflowIONodeType } from '../../../types';
import { resolvePromptEnterAction } from '../../../utils/promptSubmitShortcut';
import { useAppStore, type AppState } from '../../../store/useAppStore';
import type { AssetFileEntry } from '../../../services/fileService';
import { readMentionTextSelection } from './mentionEditorTextSelection';
import {
  captureMentionEditorSelection,
  captureMentionEditorSnapshot,
  MentionEditorHistory,
  restoreMentionEditorSnapshot,
} from './mentionEditorHistory';
import { buildDramaMentionId } from '../../../types/dramaAssets';
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
  type getNodeMetaMap,
  isBrEl,
  isChipEl,
  normalizeChipSlots,
  serializeDOM,
  syncGlobalCharacterReferenceChips,
  syncShotlistReferenceChips,
  syncImageReferenceLabels,
  ZWSP,
} from './mentionEditorDom';
import type { resolveDramaMentionItems } from './mentionEditorSources';
import { buildComfyRefmodMention, parseComfyRefmodMentions, mergeComfyRefmodSelections } from '../../../utils/comfyRefmodMention';
import { comfyRefmodKey } from '../../../utils/comfyRefmod';
import { prepareComfyRefmodSelections } from '../../../services/comfyRefmodWorkflow';
import type { ComfyRefmodAsset, ComfyRefmodSelection } from '../../../types/comfyRefmod';
import type { WorkflowDefinition } from '../../../types';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { MentionEditorProps } from './MentionEditor';

export interface RefmodEditSession {
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

export interface MentionChipTarget {
  chip: HTMLElement;
  prompt: string;
  projectId: string | null;
  nodeId?: string;
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
export const saveCursor = (root: HTMLElement): CursorPosition => {
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

export const restoreCursor = (root: HTMLElement, position: CursorPosition): void => {
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

export function useMentionInputState(editorRef: RefObject<HTMLDivElement | null>, prompt: string, disabled: boolean) {
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
  }, [editorRef]);
  const textInputSelection = useCallback(() => {
    textInputActiveRef.current = true;
    rememberTextInputSelection();
    const length = editorRef.current ? serializeDOM(editorRef.current).length : 0;
    const saved = textInputSelectionRef.current;
    return saved ? { start: Math.min(saved.start, length), end: Math.min(saved.end, length) } : { start: length, end: length };
  }, [editorRef, rememberTextInputSelection]);
  const replacementChipRef = useRef<MentionChipTarget | null>(null);
  const [chipMenu, setChipMenu] = useState<{ target: MentionChipTarget; x: number; y: number } | null>(null);
  const selectFirstMentionRef = useRef<(() => void) | null>(null);
  const lastFocusedWfValueRef = useRef<HTMLSpanElement | null>(null);
  const cancelChipDragRef = useRef<(() => void) | null>(null);
  const lastChipClickRef = useRef<{ chip: HTMLElement; time: number; x: number; y: number } | null>(null);
  /** 先聚焦编辑器，再把光标放回 @ 处，避免焦点从工作流芯片移出时清掉选区。 */
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
  }, [editorRef]);

  // 收起搜索时返回提示词光标，仍保留 @ 范围供下一次选择使用。
  const focusMentionCursor = useCallback(() => {
    const editor = editorRef.current;
    const saved = savedMentionRangeRef.current;
    editor?.focus({ preventScroll: true });
    if (!editor || !saved || !editor.contains(saved.startContainer) || !editor.contains(saved.endContainer)) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(saved.cloneRange());
  }, [editorRef]);


  return {
    editorRef, disabledRef, historyRef, syncedPromptRef, composingRef, compositionRevision,
    setCompositionRevision, savedMentionRangeRef, textInputActiveRef, textInputSelectionRef,
    rememberTextInputSelection, textInputSelection, replacementChipRef, chipMenu, setChipMenu,
    selectFirstMentionRef, lastFocusedWfValueRef, cancelChipDragRef, lastChipClickRef,
    restoreMentionCursor, focusMentionCursor,
  };
}

type InputState = ReturnType<typeof useMentionInputState>;
type EditorNodeMeta = ReturnType<typeof getNodeMetaMap>;

export function useMentionInputHistory(
  input: InputState, nodeMetaMap: EditorNodeMeta,
  onChange: MentionEditorProps['onChange'], setShowMention: (open: boolean) => void,
) {
  const {
    editorRef, disabledRef, historyRef, syncedPromptRef, composingRef, savedMentionRangeRef,
    replacementChipRef, setChipMenu, lastFocusedWfValueRef, cancelChipDragRef,
  } = input;
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
  }, [composingRef, disabledRef, editorRef, historyRef, nodeMetaMap, onChange, syncedPromptRef]);

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
  }, [cancelChipDragRef, composingRef, disabledRef, editorRef, historyRef, lastFocusedWfValueRef, nodeMetaMap, onChange, replacementChipRef, savedMentionRangeRef, setChipMenu, setShowMention, syncedPromptRef]);

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
  }, [applyHistory, composingRef, disabledRef, editorRef, historyRef]);

  return { emitDOM, applyHistory };
}

interface MentionInputOptions {
  input: InputState;
  history: ReturnType<typeof useMentionInputHistory>;
  showMention: boolean;
  setShowMention: (open: boolean) => void;
  setMentionQuery: (query: string) => void;
  setRefmodSession: Dispatch<SetStateAction<RefmodEditSession | undefined>>;
  refmodSessionRef: RefObject<RefmodEditSession | undefined>;
  setRefmodUiError: (message: string) => void;
  currentEditorData?: AppState['nodes'][number]['data'];
  selectedWorkflow?: WorkflowDefinition;
  currentProjectId: string | null;
  editorOwnerRef: RefObject<{ projectId: string | null; nodeId?: string }>;
  isCurrentEditorOwner: () => boolean;
  isCurrentChipTarget: (target: MentionChipTarget) => boolean;
  setShowAssetPicker: (open: boolean) => void;
  selectedWorkflowRef: RefObject<WorkflowDefinition | undefined>;
  nodeMetaMap: EditorNodeMeta;
  setDramaRefPickerId: (id: string | null) => void;
  localComfyWorkflow?: WorkflowDefinition;
  canMentionRefmod: boolean;
  manualRefmods: ComfyRefmodSelection[];
  onSubmit?: () => void;
  nodeId?: string;
  canSubmit: boolean;
  submitOnShiftEnter: boolean;
  submitShortcut?: PromptSubmitShortcut;
  onSlashTrigger?: () => void;
}

export function useMentionInputActions({
  input, history, showMention, setShowMention, setMentionQuery, setRefmodSession, refmodSessionRef,
  setRefmodUiError, currentEditorData, selectedWorkflow, currentProjectId, editorOwnerRef,
  isCurrentEditorOwner, isCurrentChipTarget, setShowAssetPicker, selectedWorkflowRef, nodeMetaMap,
  setDramaRefPickerId, localComfyWorkflow, canMentionRefmod, manualRefmods, onSubmit, nodeId,
  canSubmit, submitOnShiftEnter, submitShortcut, onSlashTrigger,
}: MentionInputOptions) {
  const {
    editorRef, disabledRef, historyRef, composingRef, savedMentionRangeRef,
    replacementChipRef,
    selectFirstMentionRef, restoreMentionCursor,
  } = input;
  const { emitDOM, applyHistory } = history;
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
  }, [disabledRef, isCurrentChipTarget, replacementChipRef, setShowAssetPicker, setShowMention]);

  const closeRefmodSettings = useCallback(() => {
    refmodSessionRef.current = undefined;
    setRefmodSession(undefined);
  }, [refmodSessionRef, setRefmodSession]);

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
  }, [editorRef, nodeId, localComfyWorkflow, canMentionRefmod, currentProjectId, replacementChipRef, savedMentionRangeRef, refmodSessionRef, setRefmodSession, setRefmodUiError, setShowMention, setMentionQuery, isCurrentChipTarget]);

  const editRefmodChip = useCallback((chip: HTMLElement) => {
    try {
      const raw = chip.getAttribute('data-refmod-raw') || '';
      const mention = parseComfyRefmodMentions(raw).mentions[0];
      if (!mention) throw new Error(translate('角色引用已损坏，请删除后重新选择'));
      const saved = useAppStore.getState().config.comfyRefmodAssets?.find((item) => comfyRefmodKey(item) === comfyRefmodKey(mention.selection));
      const asset = saved ?? { ...mention.selection, id: comfyRefmodKey(mention.selection), name: mention.label, tags: [], updatedAt: 0 };
      openRefmodSettings(asset, resolveComfyRefmodChipPresentation(raw)?.thumbnailUrl, chip);
    } catch (cause) { setRefmodUiError(cause instanceof Error ? cause.message : translate('无法编辑角色引用')); }
  }, [openRefmodSettings, setRefmodUiError]);

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
  }, [refmodSessionRef, editorRef, savedMentionRangeRef, emitDOM, closeRefmodSettings, disabledRef, editorOwnerRef, selectedWorkflowRef, deleteAtChar]);

  const removeManualRefmod = useCallback((reference: ComfyRefmodSelection) => {
    const state = useAppStore.getState();
    const node = state.nodes.find((item) => item.id === nodeId);
    if (state.currentProjectId !== currentProjectId || !node || !currentEditorData || node.data.status === 'loading' || node.data.role === 'source'
      || selectedWorkflowRef.current !== selectedWorkflow
      || JSON.stringify([node.data.workflowId, node.data.comfyRefmods]) !== JSON.stringify([currentEditorData.workflowId, manualRefmods])) {
      setRefmodUiError(translate('项目或视频绑定已变化，请重新打开 ComfyUI 角色列表')); return;
    }
    state.updateNodeData(node.id, { comfyRefmods: manualRefmods.filter((item) => item !== reference) });
    setRefmodUiError('');
  }, [currentProjectId, currentEditorData, selectedWorkflowRef, selectedWorkflow, manualRefmods, setRefmodUiError, nodeId]);

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
    [editorRef, nodeMetaMap, emitDOM],
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
    [editorRef, emitDOM],
  );

  // ── Mention selection handlers ──
  const handleSelectCanvasMention = useCallback(
    (refNodeId: string, refLabel: string) => {
      if (useAppStore.getState().currentProjectId !== currentProjectId) return;
      restoreMentionCursor();
      if (!deleteAtChar()) return;
      insertChipAtCursor(refNodeId, refLabel);
      setShowMention(false);
      setMentionQuery('');
    },
    [currentProjectId, deleteAtChar, insertChipAtCursor, restoreMentionCursor, setMentionQuery, setShowMention],
  );

  const handleSelectWorkflowMention = useCallback(
    (ioNodeId: string, ioNodeTitle: string, ioNodeType: WorkflowIONodeType) => {
      if (useAppStore.getState().currentProjectId !== currentProjectId) return;
      restoreMentionCursor();
      if (!deleteAtChar()) return;
      insertWorkflowChipAtCursor(ioNodeId, ioNodeTitle, ioNodeType);
      setShowMention(false);
      setMentionQuery('');
    },
    [currentProjectId, deleteAtChar, insertWorkflowChipAtCursor, restoreMentionCursor, setMentionQuery, setShowMention],
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
    [editorRef, emitDOM],
  );

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
    [isCurrentEditorOwner, restoreMentionCursor, deleteAtChar, insertDramaChipAtCursor, setShowMention, setMentionQuery, setDramaRefPickerId],
  );

  const handleSelectDramaMention = useCallback(
    (item: ReturnType<typeof resolveDramaMentionItems>[number]) => {
      if (!isCurrentEditorOwner()) return;
      // 资产库始终保留 @drama 身份，绑图节点只用于读取缩略图。
      restoreMentionCursor();
      if (!deleteAtChar()) return;
      let thumb: string | undefined;
      if (item.imageNodeId && !item.id.startsWith('global/')) {
        const n = useAppStore.getState().nodes.find((x) => x.id === item.imageNodeId);
        thumb = bestNodeThumb(n?.data ?? {}) || item.imageUrl;
      } else {
        thumb = item.imageUrl || item.referenceImages?.find((reference) => reference.imageUrl)?.imageUrl;
      }
      insertDramaChipAtCursor(item.id, item.name, item.kind, thumb);
      setShowMention(false);
      setMentionQuery('');
    },
    [isCurrentEditorOwner, restoreMentionCursor, deleteAtChar, insertDramaChipAtCursor, setShowMention, setMentionQuery],
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
    [editorRef, emitDOM],
  );

  const handleSelectAsset = useCallback(
    (file: AssetFileEntry) => {
      if (!isCurrentEditorOwner()) return;
      restoreMentionCursor();
      if (!deleteAtChar()) return;
      insertAssetChipAtCursor(file.path, file.assetUrl);
      setShowAssetPicker(false);
      setShowMention(false);
      setMentionQuery('');
    },
    [isCurrentEditorOwner, restoreMentionCursor, deleteAtChar, insertAssetChipAtCursor, setShowAssetPicker, setShowMention, setMentionQuery],
  );

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
  }, [disabledRef, editorRef, emitDOM, onSlashTrigger, replacementChipRef, savedMentionRangeRef, setMentionQuery, setShowMention, showMention]);

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
    [disabledRef, composingRef, editorRef, historyRef, submitShortcut, submitOnShiftEnter, showMention, editRefmodChip, emitDOM, applyHistory, selectFirstMentionRef, setShowMention, canSubmit, onSubmit],
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
    [disabledRef, emitDOM],
  );

  return {
    insertChipAtCursor, deleteAtChar, closeRefmodSettings, openRefmodSettings, editRefmodChip, applyRefmodMention,
    removeManualRefmod, handleSelectCanvasMention, handleSelectWorkflowMention,
    insertDramaChipAtCursor, handleSelectDramaReference, handleSelectDramaMention,
    handleSelectAsset, handleInput, handleKeyDown, handlePaste,
  };
}
