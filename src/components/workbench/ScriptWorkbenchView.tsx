import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import { isTauriEnv } from '../../services/fs/core';
import type { CreativeFieldId, EpisodeCreativeAction } from '../../services/seriesCreativeService';
import type { DramaAssetKind } from '../../types/dramaAssets';
import { normalizeEpisodeAssetRoster, type EpisodeAssetKind, type EpisodeAssetPanelActionResult } from '../../types/episodeAssets';
import type {
  ScriptWorkbenchAction, ScriptWorkbenchDispatch, ScriptWorkbenchSnapshot, WorkbenchCreativeDraft,
  WorkbenchEditorTab, WorkbenchPendingAction,
} from '../../types/scriptWorkbench';
import type { SeriesSourceSnapshot } from '../../types/seriesSource';
import type { StoryGraphDetail, StoryGraphEvidence } from '../../types/storyGraph';
import type { WorkbenchArticleTarget } from '../../types/workbenchArticle';
import { needsEpisodeScriptFileSync } from '../../utils/manuscriptFileReference';
import ModelSelector from '../nodes/shared/ModelSelector';
import OriginalWritingEditor from '../OriginalWritingEditor';
import AssetExtractionPreviewDialog from '../series/AssetExtractionPreviewDialog';
import EpisodeAssetPanel from '../series/EpisodeAssetPanel';
import WorkbenchCollaborationDialog from '../series/WorkbenchCollaborationDialog';
import WorkbenchContextSummary from '../series/WorkbenchContextSummary';
import WorkbenchSplitDialog from '../series/WorkbenchSplitDialog';
import SeriesSourceBrowser, { type SeriesSourceBrowserRemote } from '../SeriesSourceBrowser';
import TeamExecutionPicker from '../shared/agentTeams/TeamExecutionPicker';
import TeamRunCard from '../shared/agentTeams/TeamRunCard';
import { LazyLoadBoundary, LazyLoadFallback } from '../shared/LazyLoadBoundary';
import ModalOverlay from '../shared/ModalOverlay';
import { ModalPresentationContext } from '../shared/modalPresentationContext';
import PopupCloseButton from '../shared/PopupCloseButton';
import Tabs from '../shared/Tabs';
import EpisodeCreativeForm from './EpisodeCreativeForm';
import OutlineFilesPanel from './OutlineFilesPanel';
import WorkbenchArticleAssistant from './WorkbenchArticleAssistant';

const StoryGraphPanel = lazy(() => import('../storyGraph/StoryGraphPanel'));

type EditorTab = WorkbenchEditorTab;
type PendingAction = WorkbenchPendingAction;
type CreativeDraft = WorkbenchCreativeDraft;
export type WorkbenchPresentation = 'modal' | 'page';

export interface ScriptWorkbenchViewProps {
  snapshot: ScriptWorkbenchSnapshot; dispatch: ScriptWorkbenchDispatch; standalone?: boolean;
  presentation?: WorkbenchPresentation; visible?: boolean; closingWindow?: boolean; onSwitchToCanvas?: () => void;
  onBackToStartPage?: () => void;
  onReturnToProject?: () => Promise<boolean>; returningToProject?: boolean;
  externalError?: string; onDismissError?: () => void;
}

const WORKBENCH_ACTIONS_BY_TAB: Partial<Record<WorkbenchEditorTab, EpisodeCreativeAction[]>> = {
  outline: ['optimize-outline', 'adjust-beats', 'diagnose', 'strengthen-opening', 'strengthen-conflict', 'design-reversal', 'strengthen-ending'],
  script: ['write-script', 'rewrite-script', 'polish-dialogue', 'visualize-action', 'add-performance-cues', 'diagnose'],
  creative: ['adjust-beats', 'strengthen-opening', 'strengthen-conflict', 'design-reversal', 'strengthen-ending', 'diagnose'],
};

const CREATIVE_ACTION_GROUPS: Array<{
  label: string;
  icon: string;
  actions: Array<{ id: EpisodeCreativeAction; label: string }>;
}> = [
  {
    label: '结构创作',
    icon: 'lucide:blocks',
    actions: [
      { id: 'optimize-outline', label: '优化本集大纲' },
      { id: 'adjust-beats', label: '调整情节点' },
      { id: 'diagnose', label: '深度创作诊断' },
    ],
  },
  {
    label: '剧本写作',
    icon: 'lucide:pen-line',
    actions: [
      { id: 'write-script', label: '根据集纲写正文' },
      { id: 'rewrite-script', label: '重写本集剧本' },
      { id: 'polish-dialogue', label: '对白润色' },
      { id: 'visualize-action', label: '动作可拍化' },
    ],
  },
  {
    label: '戏剧增强',
    icon: 'lucide:sparkles',
    actions: [
      { id: 'strengthen-opening', label: '加强开场钩子' },
      { id: 'strengthen-conflict', label: '加强核心冲突' },
      { id: 'design-reversal', label: '设计反转' },
      { id: 'strengthen-ending', label: '加强结尾卡点' },
      { id: 'add-performance-cues', label: '补表演标注' },
    ],
  },
];

const SERIES_ASSET_EXTRACTION_ACTIONS: Array<{
  kind: DramaAssetKind;
  label: string;
  icon: string;
}> = [
  { kind: 'character', label: '提取人物', icon: 'lucide:user-round-search' },
  { kind: 'scene', label: '提取场景', icon: 'lucide:map-pinned' },
  { kind: 'prop', label: '提取道具', icon: 'lucide:briefcase-business' },
];

function WorkbenchFrame({ standalone, presentation, visible, children, ...props }: {
  standalone: boolean; presentation: WorkbenchPresentation; visible: boolean;
  isOpen: boolean; onClose: () => void; ariaLabel: string; closeOnBackdrop: boolean; className: string; children: ReactNode;
}) {
  const pageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!standalone && presentation === 'page' && visible && pageRef.current
      && !pageRef.current.contains(document.activeElement)) pageRef.current.focus({ preventScroll: true });
  }, [standalone, presentation, visible]);
  if (standalone) return <div className="ui-dialog-surface flex h-screen w-screen flex-col overflow-hidden text-canvas-text">{children}</div>;
  if (presentation === 'page') {
    const container = typeof document === 'undefined' ? null : document.getElementById('script-workbench-page');
    if (!container) return null;
    return createPortal(<ModalPresentationContext value={visible}>
      <section ref={pageRef} role="main" tabIndex={-1} aria-label={props.ariaLabel} aria-hidden={!visible} inert={!visible}
        className={`ui-dialog-surface h-full w-full overflow-hidden bg-canvas-surface text-canvas-text outline-none ${visible ? 'flex flex-col' : 'hidden'}`}>
        {children}
      </section>
    </ModalPresentationContext>, container);
  }
  return <ModalOverlay {...props}>{children}</ModalOverlay>;
}

function WorkbenchRenameDialog({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const t = useT();
  const inputId = useId();
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <ModalOverlay isOpen onClose={() => { if (!busy) onClose(); }} ariaLabel={t('修改分集名称')} zIndex={340} className="ui-dialog-surface w-full max-w-sm mx-3">
    <form className="space-y-3 p-3" onSubmit={(event) => {
      event.preventDefault();
      if (busy || !draft.trim()) return;
      setBusy(true); setError('');
      void onSave(draft.trim()).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('修改名称失败'))).finally(() => setBusy(false));
    }}>
      <div className="ui-field"><label className="ui-label" htmlFor={inputId}>{t('分集名称')}</label>
        <input id={inputId} className="ui-input w-full" value={draft} maxLength={120} disabled={busy} autoFocus
          onChange={(event) => setDraft(event.target.value)} /></div>
      {error && <p className="ui-error" role="alert">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--ghost" disabled={busy} onClick={onClose}>{t('取消')}</button>
        <button type="submit" className="ui-btn ui-btn--primary" disabled={busy || !draft.trim()}>{busy ? t('保存中…') : t('保存')}</button></div>
    </form>
  </ModalOverlay>;
}

/** 两种展示共用的纯视图；所有保存、模型与资产能力均通过主窗口 dispatch。 */
export default function WorkbenchView({ snapshot, dispatch: dispatchAction, activeAssetKind, standalone = false, presentation = 'modal', visible = true, closingWindow = false,
  onSwitchToCanvas, onBackToStartPage, onReturnToProject, returningToProject = false, externalError = '', onDismissError
}: ScriptWorkbenchViewProps & { activeAssetKind: EpisodeAssetKind | undefined }) {
  const t = useT();
  const pageHeader = !standalone && presentation === 'page';
  const nativeWindowControls = isTauriEnv();
  const macWindowControls = nativeWindowControls && typeof navigator !== 'undefined'
    && /Macintosh|Mac OS X/.test(navigator.userAgent);
  const sourceEditorRef = useRef<HTMLTextAreaElement>(null);
  const locatedSourceSequence = useRef(0);
  const graphViewLease = useRef<{ graphId: string; epoch: number } | null>(null);
  const [originalToolsContainer, setOriginalToolsContainer] = useState<HTMLDivElement | null>(null);
  const [outlineArticleContainer, setOutlineArticleContainer] = useState<HTMLDivElement | null>(null);
  const [originalArticleContainer, setOriginalArticleContainer] = useState<HTMLDivElement | null>(null);
  const [plainArticleContainer, setPlainArticleContainer] = useState<HTMLDivElement | null>(null);
  const [articleOverlay, setArticleOverlay] = useState<HTMLElement | null>(null);
  const [collaborationEpisodeId, setCollaborationEpisodeId] = useState<string | null>(null);
  const [episodesVisible, setEpisodesVisible] = useState(true);
  const [filesVisible, setFilesVisible] = useState(true);
  const [toolsVisible, setToolsVisible] = useState(true);
  const [articleVisible, setArticleVisible] = useState(true);
  const [articleApplying, setArticleApplying] = useState(false);
  const articleApplyingRef = useRef(false);
  const dispatch = useCallback<ScriptWorkbenchDispatch>(async (action) => {
    if (articleApplyingRef.current) throw new Error(t('正在采用文章修改，请稍候'));
    if (action.type !== 'article_apply') return dispatchAction(action);
    articleApplyingRef.current = true;
    setArticleApplying(true);
    try { return await dispatchAction(action); }
    finally { articleApplyingRef.current = false; setArticleApplying(false); }
  }, [dispatchAction, t]);
  const [error, setError] = useState('');
  const [assistantConfigPending, setAssistantConfigPending] = useState(false);
  const assistantConfigInFlight = useRef(false);
  const configureAssistant = async (action: ScriptWorkbenchAction): Promise<void> => {
    if (assistantConfigInFlight.current) throw new Error(t('配置正在更新，请稍候'));
    assistantConfigInFlight.current = true;
    setAssistantConfigPending(true); setError('');
    try { await dispatch(action); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('工作台操作未完成')); throw reason; }
    finally { assistantConfigInFlight.current = false; setAssistantConfigPending(false); }
  };
  const { series, episodes, currentEpisode, activeTab, draft, isDirty, isSaving, isStartingTeam,
    contextReady, editorWriteLocked: snapshotEditorWriteLocked, pendingAction, splitOpen, splitSource,
    sourceOpen, renamingEpisodeId, extractingAssetKind, seriesAssetPreview, executionSelection,
    episodeTeamTasks } = snapshot;
  const editorWriteLocked = snapshotEditorWriteLocked || articleApplying;
  const collaborationOpen = !!collaborationEpisodeId && collaborationEpisodeId === currentEpisode?.id && contextReady;
  if (collaborationEpisodeId && (!contextReady || collaborationEpisodeId !== currentEpisode?.id)) setCollaborationEpisodeId(null);
  const isOpen = true;
  const projectLoadStatus = contextReady ? 'ready' : 'loading';
  const episodeAssetRoster = normalizeEpisodeAssetRoster(currentEpisode?.episodeAssetRoster);
  const scriptFileSyncNeeded = !!currentEpisode && needsEpisodeScriptFileSync(currentEpisode);
  const outlineFileSelected = (!currentEpisode || activeTab === 'outline') && !!snapshot.outlineDocuments?.selected;
  const articleTarget: WorkbenchArticleTarget | null = outlineFileSelected
    ? snapshot.outlineDocuments?.documentId && /\.(md|txt)$/i.test(snapshot.outlineDocuments.fileName ?? '')
      ? { kind: 'outline-document', documentId: snapshot.outlineDocuments.documentId } : null
    : activeTab === 'original' && snapshot.originalWriting?.documentId
      ? { kind: 'original', documentId: snapshot.originalWriting.documentId }
      : currentEpisode && (activeTab === 'outline' || activeTab === 'script')
        ? { kind: activeTab, episodeId: currentEpisode.id } : null;
  const articleTargetKey = JSON.stringify([snapshot.sessionId, series?.id, series?.exchangeEpoch, currentEpisode?.id, activeTab, articleTarget]);
  const articleTargetLabel = outlineFileSelected ? snapshot.outlineDocuments?.fileName ?? t('大纲文件')
    : activeTab === 'original' ? snapshot.originalWriting?.fileName ?? t('原文')
      : currentEpisode ? `${currentEpisode.name} · ${t(activeTab === 'script' ? '本集剧本' : '本集大纲')}` : t('未选择文章');
  const articleUnavailable = !contextReady || isSaving || editorWriteLocked
    || (articleTarget?.kind === 'original' && (!!snapshot.originalWriting?.error || snapshot.originalWriting?.loading || snapshot.originalWriting?.saving || snapshot.originalWriting?.generating))
    || (articleTarget?.kind === 'outline-document' && (!!snapshot.outlineDocuments?.error || snapshot.outlineDocuments?.busy));
  const articleContainer = activeTab !== 'outline' && activeTab !== 'original' && activeTab !== 'script' ? null
    : (!currentEpisode || activeTab === 'outline') && snapshot.outlineDocuments ? outlineArticleContainer
    : activeTab === 'original' && snapshot.originalWriting ? originalArticleContainer : plainArticleContainer;
  useLayoutEffect(() => {
    if (!articleContainer || !articleOverlay) return;
    const update = () => articleContainer.style.setProperty('--workbench-article-overlay-height', `${articleOverlay.offsetHeight}px`);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(articleOverlay);
    return () => { observer?.disconnect(); articleContainer.style.removeProperty('--workbench-article-overlay-height'); };
  }, [articleContainer, articleOverlay, articleVisible, visible]);
  const creationToolsVisible = !!currentEpisode && ((activeTab === 'outline' && !outlineFileSelected) || activeTab === 'script' || activeTab === 'creative');
  const creativeActions = WORKBENCH_ACTIONS_BY_TAB[activeTab] ?? [];
  const creativeGroups = CREATIVE_ACTION_GROUPS.map((group) => ({ ...group,
    actions: group.actions.filter((action) => creativeActions.includes(action.id)),
  })).filter((group) => !outlineFileSelected && group.actions.length > 0);
  const extractionActions = SERIES_ASSET_EXTRACTION_ACTIONS.filter((action) => activeTab === 'script'
    || action.kind === activeAssetKind);
  const fire = (action: ScriptWorkbenchAction) => { void dispatch(action).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('工作台操作未完成'))); };
  const report = async (action: ScriptWorkbenchAction) => {
    try { return await dispatch(action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('工作台操作未完成')); return false; }
  };
  const setActiveTab = (tab: EditorTab) => fire({ type: 'set_tab', tab });
  const setTextDraft = (field: 'outline' | 'script', value: string) => fire({ type: 'edit_text', field, value });
  const setCreative = (field: keyof CreativeDraft, value: string) => fire({ type: 'edit_creative', field, value });
  const requestClose = () => fire({ type: 'close' });
  const requestEpisodeSwitch = (episodeId: string) => fire({ type: 'select_episode', episodeId });
  const setRenamingEpisodeId = (episodeId: string | null) => fire(episodeId ? { type: 'open_rename', episodeId } : { type: 'close_rename' });
  const setSourceOpen = (open: boolean) => fire({ type: open ? 'open_source' : 'close_source' });
  const setPendingAction = (_value: null) => fire({ type: 'cancel_pending' });
  const performPendingAction = (_value: PendingAction) => fire({ type: 'discard_pending' });
  const saveDraft = async () => await report({ type: 'save' }) === true;
  const openCreativeAction = (action: EpisodeCreativeAction) => report({ type: 'creative', action });
  const openFieldPolish = (field: CreativeFieldId, label: string, hasValue: boolean) => report({ type: 'polish', field, label, hasValue });
  const openEpisodeShotlist = () => report({ type: 'shotlist' });
  const extractFullScriptAssets = (kind: DramaAssetKind, label: string) => report({ type: 'extract_series', kind, label });
  const sourceRemote = useMemo<SeriesSourceBrowserRemote>(() => ({
    contextKey: `${snapshot.sessionId}:${series?.id ?? ''}:${series?.exchangeEpoch ?? 0}:${series?.originalAddedAt ?? 0}`, ready: snapshot.contextReady,
    readSource: async (part, signal) => { signal.throwIfAborted(); const result = await dispatch({ type: 'read_source', part }); signal.throwIfAborted(); return result as SeriesSourceSnapshot; },
    prepareChapter: async (reference) => { await dispatch({ type: 'prepare_chapter', reference }); },
  }), [dispatch, series?.id, series?.exchangeEpoch, series?.originalAddedAt, snapshot.contextReady, snapshot.sessionId]);
  useLayoutEffect(() => {
    const location = snapshot.sourceLocation;
    const editor = sourceEditorRef.current;
    if (!location || !editor || locatedSourceSequence.current === location.sequence
      || currentEpisode?.id !== location.episodeId || activeTab !== location.part || isDirty || outlineFileSelected) return;
    if (editor.value.slice(location.start, location.end) !== location.quote) return;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(location.start, location.end);
    locatedSourceSequence.current = location.sequence;
    const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 28;
    editor.scrollTop = Math.max(0, editor.value.slice(0, location.start).split('\n').length - 2) * lineHeight;
  }, [activeTab, currentEpisode?.id, isDirty, outlineFileSelected, snapshot.sourceLocation]);

  return (
    <WorkbenchFrame standalone={standalone} presentation={presentation} visible={visible}
      isOpen={isOpen}
      onClose={requestClose}
      ariaLabel={t('剧本创作工作台')}
      closeOnBackdrop={false}
      className="ui-dialog-surface h-[min(88vh,860px)] w-[min(1440px,calc(100vw-24px))]
                 border-[var(--glass-ring)] text-canvas-text"
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (outlineFileSelected) {
              if (/\.(md|txt)$/i.test(snapshot.outlineDocuments?.fileName ?? '')) fire({ type: 'outline_save' });
            }
            else if (activeTab === 'original') fire({ type: 'original_save' });
            else void saveDraft();
          }
        }}
      >
        <header data-tauri-drag-region={pageHeader ? 'deep' : undefined}
          className={pageHeader
            ? `relative flex min-h-11 shrink-0 select-none flex-wrap items-center gap-3 border-b border-border-subtle py-1 ${nativeWindowControls && !macWindowControls ? 'pr-32' : 'pr-3'}`
            : 'flex shrink-0 items-center gap-3 border-b border-border-subtle px-2.5 py-2'}>
          {pageHeader ? <div className={`flex min-w-0 shrink-0 items-center ${episodesVisible ? 'w-[calc(190px-0.75rem)] xl:w-[calc(210px-0.75rem)]' : ''} ${macWindowControls ? 'pl-20' : 'pl-3'}`}>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm min-w-0 max-w-full"
              aria-label={t('返回启动页')} title={t('返回启动页')} onClick={onBackToStartPage}>
              <Icon icon="mdi:arrow-left" width="16" className="shrink-0" aria-hidden="true" />
              <span className="truncate">{t('返回启动页')}</span>
            </button>
          </div> : <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-indigo-500/15 text-indigo-400">
            <Icon icon="lucide:notebook-pen" className="h-4 w-4" />
          </span>}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{t('剧本创作工作台')}</h2>
            <p className="truncate text-[11px] text-canvas-text-muted">
              {series?.name ?? t('当前剧集')} · {currentEpisode?.name ?? t('还没有分集')}
            </p>
          </div>
          {!standalone && presentation === 'page' && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary"
            onClick={onSwitchToCanvas}>
            <Icon icon="lucide:panels-top-left" className="h-3.5 w-3.5" />
            {t('切换到画布')}
          </button>}
          <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary"
            disabled={!currentEpisode || !contextReady || isSaving || isStartingTeam || editorWriteLocked}
            aria-haspopup="dialog" aria-expanded={collaborationOpen}
            onClick={() => setCollaborationEpisodeId(currentEpisode?.id ?? null)}>
            <Icon icon="lucide:users-round" className="h-3.5 w-3.5" />
            {t('Agent协作')}
          </button>
          <button
            type="button"
            disabled={!contextReady}
            onClick={() => fire({ type: 'open_split' })}
            className={`ui-btn ui-btn--sm ui-btn--secondary${splitOpen ? ' is-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={splitOpen}
          >
            <Icon icon="lucide:wand-sparkles" className="h-3.5 w-3.5" />
            {t('AI 拆分草案')}
          </button>
          <button type="button" className="ui-btn ui-btn--sm" disabled={projectLoadStatus !== 'ready'}
            onClick={() => setSourceOpen(true)}>{t('章节浏览')}</button>
          <div className="flex shrink-0 items-center gap-1 border-l border-border-subtle pl-2" role="group" aria-label={t('分栏显示')}>
            {([
              { label: t('分集列表'), icon: 'lucide:panel-left', shown: episodesVisible, toggle: () => setEpisodesVisible((value) => !value) },
              { label: t('大纲文件列表'), icon: 'lucide:files', shown: filesVisible, toggle: () => setFilesVisible((value) => !value) },
              { label: t('右侧工具'), icon: 'lucide:panel-right', shown: toolsVisible, toggle: () => setToolsVisible((value) => !value) },
              { label: t('AI 修改区'), icon: 'lucide:panel-bottom', shown: articleVisible, toggle: () => setArticleVisible((value) => !value) },
            ]).map((panel) => <button key={panel.icon} type="button"
              className={`ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost ${panel.shown ? 'bg-canvas-hover text-canvas-text' : 'text-canvas-text-muted'}`}
              aria-pressed={panel.shown} aria-label={t('{action}{panel}', { action: t(panel.shown ? '隐藏' : '显示'), panel: panel.label })}
              title={t('{action}{panel}', { action: t(panel.shown ? '隐藏' : '显示'), panel: panel.label })} onClick={panel.toggle}>
              <Icon icon={panel.icon} className="h-4 w-4" aria-hidden="true" />
            </button>)}
          </div>
          {!pageHeader && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary"
            disabled={isSaving || editorWriteLocked || snapshot.openingWindow}
            onClick={() => fire({ type: standalone ? 'dock' : 'detach' })}
            aria-label={standalone ? t('收回主窗口') : t('独立窗口显示')}>
            <Icon icon={standalone ? 'lucide:panel-top-close' : 'lucide:external-link'} className="h-3.5 w-3.5" />
            {snapshot.openingWindow ? t('正在打开…') : standalone ? t('收回主窗口') : t('独立窗口')}
          </button>}
          {!pageHeader && <PopupCloseButton ariaLabel={t('关闭剧本创作工作台')} onClick={requestClose} />}
        </header>

        {snapshot.episodeContentLoad && <div role="status" className="ui-hint flex shrink-0 flex-wrap items-center gap-2 border-b border-canvas-border p-3">
          <span className="min-w-0 flex-1">{t(snapshot.episodeContentLoad === 'loading' ? '正在读取本集正文…' : '本集正文读取失败，草稿已保留')}</span>
          {snapshot.episodeContentLoad === 'error' && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary"
            onClick={() => fire({ type: 'reload_episode' })}>{t('重试')}</button>}
        </div>}
        {!contextReady && !snapshot.episodeContentLoad && <div role="status" className="ui-hint flex shrink-0 flex-wrap items-center gap-2 border-b border-canvas-border p-3">
          <span className="min-w-0 flex-1">{t('画布已离开本剧集，请先回到原剧集处理工作台修改')}</span>
          {onReturnToProject && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary"
            disabled={returningToProject} aria-busy={returningToProject} onClick={() => { void onReturnToProject(); }}>
            {t(returningToProject ? '正在打开…' : '返回原剧集')}
          </button>}
        </div>}
        {(error || externalError) && <div role="alert" className="ui-error flex shrink-0 items-center gap-2 p-3">
          <span className="min-w-0 flex-1 break-words">{error || externalError}</span>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => { setError(''); onDismissError?.(); }}>{t('关闭')}</button>
        </div>}
        {(!currentEpisode || !contextReady) && snapshot.storyGraphExtraction
          && (snapshot.storyGraphExtraction.status === 'running' || snapshot.storyGraphExtraction.candidate) && (
          <div role="status" className="ui-alert ui-alert--warning flex shrink-0 flex-wrap items-center gap-2 p-2">
            <span className="min-w-0 flex-1 text-xs">{t('先处理当前关系图提取或候选，再关闭工作台')}</span>
            {snapshot.storyGraphExtraction.status === 'running'
              ? <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" onClick={() => fire({ type: 'story_graph_cancel', runId: snapshot.storyGraphExtraction?.runId })}>{t('取消提取')}</button>
              : <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" onClick={() => fire({ type: 'story_graph_discard', candidateId: snapshot.storyGraphExtraction?.candidate?.id })}>{t('丢弃候选')}</button>}
          </div>
        )}

        {pendingAction ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-400/20 bg-amber-500/10 px-4 py-2">
            <Icon icon="lucide:triangle-alert" className="h-4 w-4 text-amber-400" />
            <span className="min-w-0 flex-1 text-xs text-amber-100">
              {t('当前修改还没有保存，要先保存吗？')}
            </span>
            <button
              type="button"
              onClick={() => setPendingAction(null)}
              className="h-7 rounded-md px-2.5 text-[11px] text-canvas-text-secondary hover:bg-canvas-hover"
            >
              {t('继续编辑')}
            </button>
            <button
              type="button"
              disabled={isSaving || editorWriteLocked || snapshot.outlineDocuments?.busy || snapshot.originalWriting?.saving || snapshot.originalWriting?.generating || snapshot.originalWriting?.loading}
              onClick={() => performPendingAction(pendingAction)}
              className="h-7 rounded-md px-2.5 text-[11px] text-red-300 hover:bg-red-500/15"
            >
              {t('放弃修改')}
            </button>
            <button
              type="button"
              disabled={isSaving || snapshot.outlineDocuments?.busy || snapshot.originalWriting?.saving || snapshot.originalWriting?.generating || snapshot.originalWriting?.loading}
              onClick={() => fire({ type: 'save_pending' })}
              className="h-7 rounded-md bg-amber-400/90 px-3 text-[11px] font-medium text-black
                         hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
            >
              {t('保存并继续')}
            </button>
          </div>
        ) : null}

        <main className="flex min-h-0 flex-1">
          <aside className={`${episodesVisible ? 'flex' : 'hidden'} min-h-0 w-[190px] min-w-0 shrink-0 flex-col overflow-hidden border-r border-border-subtle p-3 xl:w-[210px]`}>
            <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-canvas-text-secondary">{t('分集')}</span>
              <span className="text-[10px] text-canvas-text-muted">{episodes.length}</span>
            </div>
            <div className="ui-scroll ui-scroll--both flex min-h-0 flex-1 flex-col gap-1.5">
              {episodes.map((episode) => {
                const active = episode.id === currentEpisode?.id;
                return (
                  <div
                    key={episode.id}
                    className={`flex shrink-0 items-center gap-1 rounded-lg border p-2 text-left transition-colors ${
                      active
                        ? 'border-indigo-400/40 bg-indigo-500/10'
                        : 'border-transparent hover:border-canvas-border hover:bg-canvas-hover'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => requestEpisodeSwitch(episode.id)}
                      aria-current={active}
                      data-tooltip={episode.name}
                      className="min-w-0 flex-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
                    >
                      <span className="block truncate text-[11px] font-medium text-canvas-text">{episode.name}</span>
                      <span className="mt-1 block truncate text-[10px] text-canvas-text-muted">
                        {episode.contentPending ? t('选择后读取正文') : episode.scriptLength > 0
                          ? t('正文 {count} 字', { count: episode.scriptLength })
                          : episode.hasOutline
                            ? t('已有大纲')
                            : t('尚未创作')}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={projectLoadStatus !== 'ready' || isSaving}
                      onClick={() => setRenamingEpisodeId(episode.id)}
                      aria-label={t('修改 {name} 的名称', { name: episode.name })}
                      data-tooltip={t('修改分集名称')}
                      className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost"
                    >
                      <Icon icon="lucide:pencil" className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              {episodes.length === 0 ? (
                <div className="rounded-lg border border-dashed border-canvas-border p-3 text-center text-[11px] text-canvas-text-muted">
                  {t('还没有分集，可以先生成拆分草案。')}
                </div>
              ) : null}
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {currentEpisode ? (
              <>
                <Tabs value={activeTab} onChange={setActiveTab} size="sm" aria-label={t('剧本创作工作台')}
                  className="min-h-11 shrink-0" items={([
                    ['outline', '本集大纲', 'lucide:list-tree'],
                    ['original', '原文', 'lucide:book-open'],
                    ['script', '本集剧本', 'lucide:scroll-text'],
                    ['creative', '创作要点', 'lucide:lightbulb'],
                    ['characters', '本集角色', 'lucide:users-round'],
                    ['scenes', '本集场景', 'lucide:map-pin'],
                    ['props', '本集道具', 'lucide:package'],
                    ['story-graph', '故事关系图', 'lucide:network'],
                  ] as const).map(([id, label, icon]) => ({ value: id,
                    label: <><Icon icon={icon} className="h-3.5 w-3.5" aria-hidden="true" />{t(label)}</>,
                    count: id === 'characters' ? episodeAssetRoster.characters.length
                      : id === 'scenes' ? (episodeAssetRoster.scenes ?? []).length
                        : id === 'props' ? episodeAssetRoster.props.length : undefined,
                  }))} />

                <div ref={setPlainArticleContainer} className="relative min-h-0 flex-1">
                <div className={`h-full ${activeTab !== 'outline' && activeTab !== 'original' && activeTab !== 'script' ? 'overflow-auto script-workbench-article-text' : 'script-workbench-article-viewport overflow-hidden'}`}>
                  {snapshot.outlineDocuments && <section className={activeTab === 'outline' ? 'h-full min-h-0 min-w-0 overflow-hidden' : 'hidden'} aria-label={t('大纲文件')}>
                    <OutlineFilesPanel key={snapshot.articleRevision?.outlineDocument ?? 0}
                      summary={snapshot.outlineDocuments} dispatch={dispatch} ready={contextReady && !articleApplying && !closingWindow} fileListVisible={filesVisible}
                      onArticleContainer={setOutlineArticleContainer}
                      active={activeTab === 'outline' && visible}>
                      <textarea ref={activeTab === 'outline' ? sourceEditorRef : undefined} value={draft.outline} readOnly={editorWriteLocked || !contextReady}
                        onChange={(event) => setTextDraft('outline', event.target.value)} spellCheck={false}
                        aria-label={t('本集大纲')} placeholder={t('写下本集任务、核心冲突、主要情节点和结尾卡点…')}
                        className="script-workbench-article-text block h-full min-h-80 w-full flex-1 resize-none bg-transparent p-3 text-[13px] leading-7 text-canvas-text outline-none placeholder:text-canvas-text-muted" />
                    </OutlineFilesPanel>
                  </section>}
                  {snapshot.originalWriting && <section className={activeTab === 'original' ? 'h-full min-h-0 min-w-0 overflow-hidden' : 'hidden'} aria-label={t('原文')}>
                    <OriginalWritingEditor key={snapshot.articleRevision?.original ?? 0}
                      summary={snapshot.originalWriting} dispatch={dispatch} ready={contextReady && !articleApplying && !closingWindow} active={activeTab === 'original'} toolsContainer={originalToolsContainer}
                      onArticleContainer={setOriginalArticleContainer} />
                  </section>}
                  {activeTab === 'story-graph' && snapshot.storyGraphView ? (
                    <LazyLoadBoundary label={t('故事关系图')} resetKey={snapshot.sessionId}>
                      <Suspense fallback={<LazyLoadFallback label={t('故事关系图')} />}>
                        <StoryGraphPanel view={snapshot.storyGraphView} filter={snapshot.storyGraphFilter}
                          episodes={episodes} currentEpisodeId={currentEpisode.id} assets={snapshot.storyGraphAssets ?? []}
                          modelGroups={snapshot.modelGroups} extraction={snapshot.storyGraphExtraction} theme={snapshot.theme}
                          disabled={!contextReady || editorWriteLocked || isSaving}
                          onFilterChange={async (filter) => await dispatch({ type: 'story_graph_filter', filter })}
                          onReadDetail={async (selection) => await dispatch({ type: 'story_graph_detail', selection }) as StoryGraphDetail}
                          onPatch={async (patch, expectedRevision) => await dispatch({ type: 'story_graph_patch', patch, expectedRevision })}
                          onResolveEvidence={async (query) => await dispatch({ type: 'story_graph_resolve_evidence', query }) as StoryGraphEvidence}
                          onLocateEvidence={async (evidence) => await dispatch({ type: 'story_graph_locate', evidence })}
                          onExtract={async (request) => await dispatch({ type: 'story_graph_extract', request })}
                          onCancelExtraction={async () => await dispatch({ type: 'story_graph_cancel', runId: snapshot.storyGraphExtraction?.runId })}
                          onDiscardCandidates={async () => await dispatch({ type: 'story_graph_discard', candidateId: snapshot.storyGraphExtraction?.candidate?.id })}
                          onAdoptCandidates={async (candidateId, selection) => await dispatch({ type: 'story_graph_adopt', candidateId, selection })}
                          onEditorStateChange={async (open) => {
                            const identity = open ? { graphId: snapshot.storyGraphView!.id, epoch: series?.exchangeEpoch ?? 0 }
                              : graphViewLease.current ?? { graphId: snapshot.storyGraphView!.id, epoch: series?.exchangeEpoch ?? 0 };
                            await dispatch({ type: 'story_graph_editor', open, ...identity, expectedRevision: snapshot.storyGraphView!.revision });
                            graphViewLease.current = open ? identity : null;
                          }} />
                      </Suspense>
                    </LazyLoadBoundary>
                  ) : null}
                  {activeAssetKind && snapshot.assetPanel ? (
                      <EpisodeAssetPanel key={`${currentEpisode.id}-${activeTab}`} episodeId={currentEpisode.id}
                        kind={activeAssetKind}
                        remoteHost={{ snapshot: snapshot.assetPanel, dispatchAction: async (action) => await dispatch({ type: 'asset', episodeId: currentEpisode.id,
                          kind: activeAssetKind, action }) as EpisodeAssetPanelActionResult }}
                        onBeforeExtract={async () => !isDirty || await saveDraft()} />
                  ) : null}
                  {activeTab === 'outline' && !snapshot.outlineDocuments ? (
                    <textarea
                      ref={sourceEditorRef}
                      value={draft.outline}
                      readOnly={editorWriteLocked || !contextReady}
                      onChange={(event) => setTextDraft('outline', event.target.value)}
                      spellCheck={false}
                      placeholder={t('写下本集任务、核心冲突、主要情节点和结尾卡点…')}
                      className="script-workbench-article-text block h-full min-h-80 w-full resize-none bg-transparent p-4 text-[13px] leading-7
                                 text-canvas-text outline-none placeholder:text-canvas-text-muted"
                    />
                  ) : null}
                  {activeTab === 'script' ? (
                    <textarea
                      ref={sourceEditorRef}
                      value={draft.script}
                      readOnly={editorWriteLocked || !contextReady}
                      onChange={(event) => setTextDraft('script', event.target.value)}
                      spellCheck={false}
                      placeholder={t('按场号、场景、人物、动作和对白写本集完整正文…')}
                      className="script-workbench-article-text block h-full min-h-80 w-full resize-none bg-transparent p-4 font-mono text-[13px]
                                 leading-7 text-canvas-text outline-none placeholder:text-canvas-text-muted"
                    />
                  ) : null}
                  {activeTab === 'creative' ? (
                    <EpisodeCreativeForm
                      draft={draft.creative}
                      disabled={!contextReady || editorWriteLocked}
                      aiDisabled={isSaving || editorWriteLocked || executionSelection.kind === 'team' || projectLoadStatus !== 'ready'}
                      onChange={setCreative}
                      onPolish={openFieldPolish}
                    />
                  ) : null}
                </div>
                </div>

                {activeTab !== 'original' && !outlineFileSelected && <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-border-subtle px-3">
                  <span className={`text-[11px] ${isDirty ? 'text-amber-300' : 'text-canvas-text-muted'}`}>
                    {editorWriteLocked ? t('团队成果保存中…') : isDirty ? t('有未保存修改') : scriptFileSyncNeeded ? t('待保存 TXT') : t('已保存')}
                  </span>
                  <span className="hidden text-[10px] text-canvas-text-muted sm:inline">Ctrl+S</span>
                  <button
                    type="button"
                    disabled={!draft.script.trim() || isSaving || projectLoadStatus !== 'ready' || currentEpisode.id !== snapshot.canvasProjectId}
                    onClick={() => { void openEpisodeShotlist(); }}
                    className="ui-btn ui-btn--sm ml-auto"
                    title={currentEpisode.id !== snapshot.canvasProjectId ? t('请先在剧集栏切换到本集画布，再生成分镜') : t('用已保存的本集剧本创建分镜表，并选择模型生成')}
                  >
                    <Icon icon="lucide:list-video" className="h-3.5 w-3.5" />
                    {t('生成本集分镜')}
                  </button>
                  {activeTab === 'script' && nativeWindowControls && snapshot.windowContext?.target.modelGeneration === 1
                    && currentEpisode.episodeScriptFile && !!currentEpisode.episodeScript?.trim() && (
                    <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary"
                      title={t('用已保存的正文重建 TXT，保留原文件')}
                      disabled={isDirty || isSaving || editorWriteLocked || !contextReady}
                      onClick={() => fire({ type: 'save', rebuildScriptFile: true })}>
                      {t('重建 TXT')}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={(!isDirty && !scriptFileSyncNeeded) || isSaving || editorWriteLocked || projectLoadStatus !== 'ready'}
                    onClick={() => { void saveDraft(); }}
                    className="h-8 rounded-lg bg-indigo-500/90 px-4 text-xs font-medium text-white
                               hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isSaving ? t('保存中…') : t('保存本集')}
                  </button>
                </footer>}
              </>
            ) : (
              snapshot.outlineDocuments ? <OutlineFilesPanel key={snapshot.articleRevision?.outlineDocument ?? 0}
                summary={snapshot.outlineDocuments} dispatch={dispatch} ready={contextReady && !articleApplying && !closingWindow} active={visible} fileListVisible={filesVisible}
                onArticleContainer={setOutlineArticleContainer}>
                <div className="script-workbench-article-text grid min-h-80 flex-1 place-items-center p-3 text-center">
                  <p className="text-xs text-canvas-text-muted">{t('还没有分集，可以先新建大纲文件，或生成拆分草案。')}</p>
                </div>
              </OutlineFilesPanel> : <div ref={setPlainArticleContainer} className="relative min-h-0 flex-1">
                <div className="script-workbench-article-text grid h-full min-h-80 place-items-center p-6 text-center">
                <div>
                  <Icon icon="lucide:files" className="mx-auto h-8 w-8 text-canvas-text-muted" />
                  <p className="mt-3 text-sm font-medium">{t('还没有可编辑的分集')}</p>
                  <p className="mt-1 text-xs text-canvas-text-muted">{t('先新增分集，或使用 AI 拆分草案。')}</p>
                </div>
              </div>
              </div>
            )}
            {articleContainer && createPortal(
              <WorkbenchArticleAssistant containerRef={setArticleOverlay} hidden={!articleVisible}
                targetKey={articleTargetKey} targetLabel={articleTargetLabel} target={articleTarget}
                disabled={!!articleUnavailable || assistantConfigPending} generating={snapshot.articleAssistant?.generating ?? false} dispatch={dispatch}
                theme={snapshot.theme ?? 'dark'} performanceMode={snapshot.performanceMode}
                executionControls={executionSelection.kind === 'team' ? <TeamExecutionPicker
                  value={executionSelection} profile={snapshot.assistantTeamProfile ?? snapshot.teamProfile}
                  onChange={(value) => { void configureAssistant({ type: 'set_execution', value }).catch(() => {}); }}
                  onProfileChange={(profile) => configureAssistant({ type: 'save_assistant_team_profile', profile })}
                  modelGroups={snapshot.modelGroups} generalModels={[]} theme={snapshot.theme ?? 'dark'}
                  controls="configuration" compact externalAgents={snapshot.externalAgents}
                  onRefreshExternalAgents={async () => { await dispatch({ type: 'refresh_external_agents' }); }}
                  disabled={!!articleUnavailable || assistantConfigPending || !!snapshot.articleAssistant?.generating || snapshot.assistantModelDisabled} />
                  : <ModelSelector nodeType="ai-text" appearance="pill" theme={snapshot.theme ?? 'dark'} persistPreference={false}
                    selectedModel={snapshot.assistantModelId ?? ''} configuredGroupsOverride={snapshot.modelGroups} generalModelsOverride={[]}
                    disabled={!!articleUnavailable || assistantConfigPending || !!snapshot.articleAssistant?.generating || snapshot.assistantModelDisabled}
                    onSelect={(model) => { void configureAssistant({ type: 'select_assistant_model', modelId: model.value }).catch(() => {}); }} />}
                unavailableReason={outlineFileSelected && !articleTarget ? t('PDF、PPT 和 Word 为只读资料，请选择 Markdown 或 TXT 文章。')
                  : !articleTarget ? t('请选择本集大纲、剧本、原文，或新建并选择 Markdown / TXT 文章。')
                    : t('请等待当前操作完成，并先处理文章的编辑错误。')} />, articleContainer)}
          </section>

          <aside className={`${toolsVisible ? '' : 'hidden'} min-h-0 w-[300px] min-w-0 shrink-0 overflow-auto border-l border-border-subtle p-3`}>
            {outlineFileSelected ? <div className="ui-card p-3">
              <h3 className="ui-label">{t('大纲参考资料')}</h3>
              <p className="mt-2 text-xs leading-relaxed text-canvas-text-secondary">{t('MD、TXT 可编辑保存；PDF、PPT 和 Word 在本地只读预览。')}</p>
            </div> : <WorkbenchContextSummary snapshot={snapshot} dispatch={report} />}
            {activeTab === 'original' && <div ref={setOriginalToolsContainer} className="mt-3 space-y-3" />}

            {extractionActions.length > 0 && <section className="ui-card mt-4 p-3">
              <div className="flex items-center gap-1.5">
                <Icon icon="lucide:scan-text" className="h-3.5 w-3.5 text-indigo-400" />
                <h3 className="text-[10px] font-semibold text-canvas-text-secondary">{t('全剧资产提取')}</h3>
                <span className="ml-auto rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[9px] text-indigo-300">
                  {t('完整剧本')}
                </span>
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-canvas-text-muted">
                {series?.hasScript
                  ? t('读取全剧剧本，提取结果先预览，仅将所选条目加入本剧资产库。')
                  : t('请先填写全剧剧本。')}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {extractionActions.map((action) => {
                  const running = extractingAssetKind === action.kind;
                  const label = t(action.label);
                  return (
                    <button
                      key={action.kind}
                      type="button"
                      aria-busy={running}
                      disabled={!series?.hasScript
                        || extractingAssetKind !== null
                        || projectLoadStatus !== 'ready'}
                      onClick={() => { void extractFullScriptAssets(action.kind, label); }}
                      className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border
                                 border-canvas-border bg-[var(--white-alpha-04)] px-1.5 py-2 text-[10px]
                                 text-canvas-text-secondary transition-colors hover:border-indigo-400/40
                                 hover:bg-indigo-500/10 hover:text-indigo-200 disabled:cursor-not-allowed
                                 disabled:opacity-40"
                    >
                      <Icon
                        icon={running ? 'lucide:loader-circle' : action.icon}
                        className={`h-3.5 w-3.5 ${running ? 'animate-spin' : ''}`}
                      />
                      <span className="truncate">{running ? t('提取中…') : label}</span>
                    </button>
                  );
                })}
              </div>
            </section>}

            {creationToolsVisible && <>
            {(snapshot.episodeAgentTasks ?? []).map((task) => <section key={task.id} className="ui-card mt-2 space-y-2 p-2" aria-label={t('智能调度任务')}>
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="ui-label truncate">{task.title}</span>
                <span className="ui-badge">{t(task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败'
                  : task.status === 'stopped' ? '已停止' : task.status === 'paused' ? '已暂停' : task.status === 'queued' ? '排队中' : '执行中')}</span>
              </div>
              {task.activity && <p className="truncate text-xs text-canvas-text-secondary" title={task.activity}>{task.activity}</p>}
              <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={!contextReady}
                onClick={() => fire({ type: 'view_agent_task', taskId: task.id })}>{t('查看调用与结果')}</button>
            </section>)}

            {episodeTeamTasks.map((task) => <TeamRunCard key={task.id} task={task} compact
              onPause={(taskId) => fire({ type: 'team_control', taskId, action: 'pause' })}
              onStop={(taskId) => fire({ type: 'team_control', taskId, action: 'stop' })}
              onResume={(taskId) => fire({ type: 'team_control', taskId, action: 'resume' })}
              onView={(taskId) => fire({ type: 'team_control', taskId, action: 'view' })}
              onReadArtifact={async (taskId, artifact) => await dispatch({ type: 'team_artifact', taskId, artifactId: artifact.id }) as string}
              onApply={async (taskId) => { await dispatch({ type: 'team_control', taskId, action: 'apply' }); }}
              onRestore={async (taskId) => { await dispatch({ type: 'team_control', taskId, action: 'restore' }); }}
              onReconcile={async (taskId) => { await dispatch({ type: 'team_control', taskId, action: 'reconcile' }); }}
              onAmend={async (taskId, instruction) => { await dispatch({ type: 'team_amend', taskId, instruction }); }}
              onEditGraph={async (graph, expected) => { await dispatch({ type: 'edit_team_graph', taskId: task.id, graph, expected }); }}
              onResolveDispatch={async (dispatchId, decision) => { await dispatch({ type: 'resolve_dispatch', taskId: task.id, dispatchId, decision }); }} />)}

            <div className="script-workbench-actions mt-4 grid gap-3">
              {creativeGroups.map((group) => (
                <section key={group.label}>
                  <div className="ui-label mb-1.5 flex items-center gap-1.5">
                    <Icon icon={group.icon} className="h-3.5 w-3.5" />
                    {t(group.label)}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.actions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        disabled={!currentEpisode || isSaving || isStartingTeam || editorWriteLocked || projectLoadStatus !== 'ready'
                          || (executionSelection.kind === 'team' && !['optimize-outline', 'write-script', 'diagnose'].includes(action.id))}
                        onClick={() => { void openCreativeAction(action.id); }}
                        className="ui-btn ui-btn--sm ui-btn--secondary"
                      >
                        {executionSelection.kind === 'team' && action.id === 'diagnose' ? t('联合审稿') : t(action.label)}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div></>}
          </aside>
        </main>
      </div>
      {splitOpen && <WorkbenchSplitDialog snapshot={snapshot} dispatch={dispatch} onClose={() => fire({ type: 'close_split' })} />}
      {collaborationOpen && <WorkbenchCollaborationDialog key={collaborationEpisodeId} snapshot={snapshot} dispatch={dispatch}
        onClose={() => setCollaborationEpisodeId(null)} />}
      {isOpen && renamingEpisodeId && <WorkbenchRenameDialog key={renamingEpisodeId}
        name={episodes.find((episode) => episode.id === renamingEpisodeId)?.name ?? ''}
        onClose={() => setRenamingEpisodeId(null)} onSave={async (name) => { await dispatch({ type: 'rename', name }); }} />}
      {isOpen && seriesAssetPreview && contextReady && (
        <AssetExtractionPreviewDialog title={t('全剧资产提取预览')} items={seriesAssetPreview.assets}
          existingItems={snapshot.existingAssets}
          confirmLabel={t('将所选条目加入本剧资产库')}
          onClose={() => fire({ type: 'close_asset_preview' })}
          onConfirm={async (selectedIds) => {
            await dispatch({ type: 'commit_asset_preview', selectedIds });
          }} />
      )}
      {sourceOpen && <SeriesSourceBrowser initialPart={splitSource} onClose={() => setSourceOpen(false)} remote={sourceRemote} />}
    </WorkbenchFrame>
  );
}
