/** 独立工作台仅显示主窗口快照；短暂本地输入保留到主窗口确认，禁止自行保存或调模型。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScriptWorkbenchView } from './ScriptWorkbench';
import { closeUninitializedScriptWorkbench, connectScriptWorkbenchWindow } from '../services/scriptWorkbenchWindowService';
import { applyAppearanceTheme } from '../services/appearance/appearanceRuntime';
import { getBuiltinAppearanceTheme } from '../services/appearance/appearanceDefaults';
import { setLocale, useT } from '../i18n';
import type { ScriptWorkbenchDispatch, ScriptWorkbenchSnapshot, WorkbenchDraftHandoff } from '../types/scriptWorkbench';
import type { OriginalWritingHandoff } from '../types/originalWriting';
import { sameProjectWindowContext } from '../services/projectWindowContext';
import type { ProjectWindowContext } from '../types/projectWindow';

type WindowConnection = Awaited<ReturnType<typeof connectScriptWorkbenchWindow>>;

export default function ScriptWorkbenchWindow() {
  const t = useT();
  const [snapshot, setSnapshot] = useState<ScriptWorkbenchSnapshot | null>(null);
  const snapshotRef = useRef<ScriptWorkbenchSnapshot | null>(null);
  const connection = useRef<WindowConnection | null>(null);
  const handoff = useRef<WorkbenchDraftHandoff | undefined>(undefined);
  const originalHandoff = useRef<OriginalWritingHandoff | undefined>(undefined);
  const originalWindowContext = useRef<ProjectWindowContext | null | undefined>(undefined);
  const [optimisticDraft, setOptimisticDraft] = useState<WorkbenchDraftHandoff | undefined>(undefined);
  const editSequence = useRef(0);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');

  const dispatch = useCallback<ScriptWorkbenchDispatch>(async (action) => {
    const current = snapshotRef.current;
    const bridge = connection.current;
    if (!current || !bridge) throw new Error('工作台尚未连接主窗口');
    if ((handoff.current && !sameProjectWindowContext(handoff.current.windowContext, current.windowContext))
      || (originalHandoff.current && !sameProjectWindowContext(originalWindowContext.current, current.windowContext))) {
      throw new Error('工作台目标已变化，原草稿仍保留在本窗口，请先核对原分集；未将旧修改写入新目标');
    }
    let command = action;
    if (action.type === 'original_edit') {
      if (!originalHandoff.current || action.handoff.documentId !== originalHandoff.current.documentId
        || action.handoff.sequence > originalHandoff.current.sequence) originalHandoff.current = action.handoff;
      originalWindowContext.current = current.windowContext;
    }
    if (action.type === 'edit_text' || action.type === 'edit_creative') {
      if (!current.currentEpisode || !current.contextReady || current.editorWriteLocked) throw new Error('当前分集暂不能编辑');
      const draft = structuredClone(handoff.current?.episodeId === current.currentEpisode.id ? handoff.current.draft : current.draft);
      if (action.type === 'edit_text') draft[action.field] = action.value;
      else draft.creative[action.field] = action.value;
      editSequence.current = Math.max(editSequence.current, current.acceptedEditSequence) + 1;
      handoff.current = { episodeId: current.currentEpisode.id, sequence: editSequence.current, draft, windowContext: current.windowContext };
      setOptimisticDraft(handoff.current);
      command = { type: 'flush_draft' };
    }
    const closeIntent = action.type === 'dock' || action.type === 'close'
      || ((action.type === 'discard_pending' || action.type === 'save_pending') && current.pendingAction?.type === 'close');
    const discardedOriginal = action.type === 'original_reload' && action.discard ? originalHandoff.current : undefined;
    if (closeIntent) setClosing(true);
    try {
      const submittedHandoff = handoff.current;
      const value = await bridge.request({ revision: current.revision, episodeId: current.currentEpisode?.id ?? null,
        action: command, handoff: submittedHandoff,
        originalHandoff: discardedOriginal || command.type === 'original_edit' ? undefined : originalHandoff.current });
      if (submittedHandoff && handoff.current === submittedHandoff
        && (snapshotRef.current?.acceptedEditSequence ?? 0) >= submittedHandoff.sequence) {
        handoff.current = undefined; setOptimisticDraft(undefined);
      }
      if (discardedOriginal && originalHandoff.current === discardedOriginal) originalHandoff.current = undefined;
      if (closeIntent && (value !== true || snapshotRef.current?.pendingAction)) setClosing(false);
      return value;
    } catch (cause) {
      if (closeIntent) setClosing(false);
      throw cause;
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let closeStop: (() => void) | undefined;
    const sessionId = new URLSearchParams(window.location.search).get('session') ?? '';
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(sessionId)) return;
    void connectScriptWorkbenchWindow(sessionId, (next) => {
      if (disposed) return;
      snapshotRef.current = next;
      if (next.pendingAction) setClosing(false);
      editSequence.current = Math.max(editSequence.current, next.acceptedEditSequence);
      if (handoff.current && next.acceptedEditSequence >= handoff.current.sequence
        && sameProjectWindowContext(handoff.current.windowContext, next.windowContext)) {
        handoff.current = undefined; setOptimisticDraft(undefined);
      }
      if (originalHandoff.current && next.originalWriting?.documentId === originalHandoff.current.documentId
        && next.originalWriting.acceptedSequence >= originalHandoff.current.sequence) originalHandoff.current = undefined;
      setSnapshot(next);
    }).then(async (bridge) => {
      if (disposed) { bridge.dispose(); return; }
      connection.current = bridge;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const stop = await getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        if (!snapshotRef.current) { void closeUninitializedScriptWorkbench(sessionId).catch(() => {}); return; }
        void dispatch({ type: 'close' }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '关闭工作台失败'));
      });
      if (disposed) stop(); else closeStop = stop;
    }).catch(() => { if (!disposed) setError('无法连接主窗口，已保留原工作台，请回到主窗口重试'); });
    const beforeUnload = () => {
      const current = snapshotRef.current;
      if (current && (handoff.current || originalHandoff.current)) connection.current?.handoff({ revision: current.revision,
        episodeId: current.currentEpisode?.id ?? null, action: { type: 'flush_draft' }, handoff: handoff.current,
        originalHandoff: originalHandoff.current });
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      disposed = true; window.removeEventListener('beforeunload', beforeUnload);
      closeStop?.(); connection.current?.dispose(); connection.current = null;
    };
  }, [dispatch]);

  const appearance = snapshot?.appearance;
  const language = snapshot?.language;
  const appliedAppearance = useRef('');
  useEffect(() => { setLocale(language); }, [language]);
  useEffect(() => {
    if (!appearance) return;
    const identity = JSON.stringify(appearance);
    if (identity === appliedAppearance.current) return;
    appliedAppearance.current = identity;
    applyAppearanceTheme({ ...getBuiltinAppearanceTheme('standard-dark'), ...appearance });
  }, [appearance]);

  if (!snapshot) return <div className="grid h-screen place-items-center bg-canvas-bg p-3 text-sm text-canvas-text" role="status">
    {error || t('正在连接主窗口…')}
  </div>;
  const local = optimisticDraft?.episodeId === snapshot.currentEpisode?.id ? optimisticDraft : undefined;
  return <ScriptWorkbenchView standalone snapshot={{ ...snapshot, detached: true,
    draft: local?.draft ?? snapshot.draft, isDirty: local ? true : snapshot.isDirty,
    editorWriteLocked: snapshot.editorWriteLocked || closing }} dispatch={dispatch}
    externalError={error} onDismissError={() => setError('')} />;
}
