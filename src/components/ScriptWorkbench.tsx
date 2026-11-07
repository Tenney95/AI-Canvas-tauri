/**
 * ScriptWorkbench — 提供剧本创作工作台界面与交互。
 */
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import type { EpisodeCreativeInfo } from '../types';
import { useAppStore } from '../store/useAppStore';
import { listEpisodes, seriesOwnerId } from '../store/store.utils';
import {
  analyzeEpisodeScript,
  buildCreativeFieldPolishPrompt,
  buildEpisodeCreativePrompt,
  buildSplitDraftPrompt,
  type CreativeFieldId,
  type EpisodeCreativeAction,
} from '../services/seriesCreativeService';
import { useT } from '../i18n';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';
import Select from './shared/Select';
import NumberStepper from './shared/NumberStepper';
import { LazyLoadBoundary, LazyLoadFallback } from './shared/LazyLoadBoundary';
import { createEpisodeShotlist } from '../services/shotlistService';
import SeriesSourceBrowser, { type SeriesSourceBrowserRemote } from './SeriesSourceBrowser';
import OriginalWritingEditor from './OriginalWritingEditor';
import { createOriginalWritingSession } from '../services/originalWritingService';
import WorkbenchContextSummary from './series/WorkbenchContextSummary';
import WorkbenchCollaborationDialog from './series/WorkbenchCollaborationDialog';
import type { DramaAssetKind } from '../types/dramaAssets';
import { commitSeriesAssetCandidates, extractSeriesAssetsFromFullScript, type SeriesAssetExtractionResult } from '../services/seriesAssetExtractionService';
import { normalizeEpisodeAssetRoster, type EpisodeAssetPanelActionResult } from '../types/episodeAssets';
import EpisodeAssetPanel from './series/EpisodeAssetPanel';
import { buildEpisodeAssetPanelSnapshot, executeEpisodeAssetPanelAction } from '../services/episodeAssetService';
import AssetExtractionPreviewDialog from './series/AssetExtractionPreviewDialog';
import type { AgentMode } from '../types/agent';
import type { AssistantExecutionSelection, TeamTemplateId } from '../types/agentTeam';
import TeamRunCard from './shared/agentTeams/TeamRunCard';
import type { CreationProfileChoicePreview } from '../types/creationProfile';
import { creationProfileOptions, captureCreationProfile, previewCreationProfileOption, resolveCreationTeamProfile } from '../services/creationProfiles/creationProfileService';
import { getExternalAgentCatalog, readExternalAgentCatalog } from '../services/chat/externalAgents/externalAgentService';
import { editTeamGraph } from '../services/chat/teams/teamRuntime';
import { resolveAgentDispatchOutcome } from '../services/chat/agentDurabilityService';
import { configValuesEqual } from '../services/configPatch';
import { normalizeCreationProfileSelection } from '../services/creationProfiles/creationProfileManifest';
import { normalizeExecutionSelection, normalizeTeamProfile } from '../services/chat/teams/teamProfileService';
import { appendTeamInstruction, startTeamInvocation, openAgentTaskInAssistant, openTeamTaskInAssistant, readTeamTaskArtifact } from '../services/chat/teams/teamInvocationService';
import { startWorkbenchAgentInvocation } from '../services/chat/workbenchAgentInvocationService';
import { captureEpisodeTeamContext, applyTeamResult, restoreTeamResult, reconcileTeamResult } from '../services/chat/teams/teamResultApplyService';
import { pauseAgentTask, stopAgentTask } from '../services/chat/agentTaskControl';
import { cancelScheduledAgentExecution } from '../services/chat/agentScheduler';
import { resumeAgentTaskExecution } from '../services/chat/conversationExecutionController';
import { buildChatModelCatalog, projectChatNodes } from '../services/chat/detachedChatSyncController';
import { hasUnsettledEpisodeEditorSession, isEpisodeEditorWriteLocked, registerEpisodeEditorSession, settleEpisodeEditorSessions,
  subscribeEpisodeEditorWrites } from '../services/episodeEditorSessionService';
import { readEpisodeWorkspaceScope } from '../services/episodeWorkspaceScope';
import { createAppearanceUiSnapshot } from '../services/appearance/appearanceWindowSync';
import { resolveAppearanceMode } from '../services/appearance/appearanceRuntime';
import { getAppearanceForConfig } from '../services/appearance/appearanceMigration';
import { createScriptWorkbenchWindowHost, type ScriptWorkbenchWindowHost } from '../services/scriptWorkbenchWindowService';
import { loadProjectAgentTasks } from '../services/chat/agentTaskService';
import { buildSeriesChapterPrompt, readSeriesChapter, readSeriesSource } from '../services/seriesSourceService';
import type { SeriesSourceSnapshot } from '../types/seriesSource';
import type { ScriptWorkbenchAction, ScriptWorkbenchDispatch, ScriptWorkbenchRequest, ScriptWorkbenchSnapshot,
  WorkbenchCreativeDraft, WorkbenchDraft, WorkbenchEditorTab, WorkbenchPendingAction } from '../types/scriptWorkbench';
import type { StoryGraphAssetOption, StoryGraphCandidates, StoryGraphDetail, StoryGraphEvidence, StoryGraphExtractionState,
  StoryGraphExtractRequest, StoryGraphFilter, StoryGraphPatch, StoryGraphSource } from '../types/storyGraph';
import { STORY_GRAPH_EDGE_KINDS, STORY_GRAPH_NODE_KINDS } from '../types/storyGraph';
import { applyStoryGraphPatch, createEmptyStoryGraph, hashStoryGraphSource, projectStoryGraphView,
  validateStoryGraphEvidence } from '../services/storyGraphService';
import { buildStoryGraphCandidatePatch, extractStoryGraphCandidates } from '../services/storyGraphExtractionService';
import { resolveAssistantModel } from '../services/ai/assistantStream';
import { sanitizeDomainText } from '../services/chat/subAgentMaterials';

const StoryGraphPanel = lazy(() => import('./storyGraph/StoryGraphPanel'));

type EditorTab = WorkbenchEditorTab;
type PendingAction = WorkbenchPendingAction;
type CreativeDraft = WorkbenchCreativeDraft;

// 非持久化恢复副本：宿主因切项目卸载时不把未确认丢弃的稿件当作已经放弃。
const workbenchDraftCache = new Map<string, Record<string, WorkbenchDraft>>();
const EMPTY_WORKBENCH_NODES: [] = [];

const WORKBENCH_ACTIONS_BY_TAB: Partial<Record<WorkbenchEditorTab, EpisodeCreativeAction[]>> = {
  outline: ['optimize-outline', 'adjust-beats', 'diagnose', 'strengthen-opening', 'strengthen-conflict', 'design-reversal', 'strengthen-ending'],
  script: ['write-script', 'rewrite-script', 'polish-dialogue', 'visualize-action', 'add-performance-cues', 'diagnose'],
  creative: ['adjust-beats', 'strengthen-opening', 'strengthen-conflict', 'design-reversal', 'strengthen-ending', 'diagnose'],
};

const EMPTY_CREATIVE_DRAFT: CreativeDraft = {
  task: '',
  coreConflict: '',
  openingHook: '',
  reversal: '',
  endingHook: '',
  beats: '',
  targetDurationSec: '',
  sourceRange: '',
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

function toCreativeDraft(value: EpisodeCreativeInfo | undefined): CreativeDraft {
  return {
    ...EMPTY_CREATIVE_DRAFT,
    task: value?.task ?? '',
    coreConflict: value?.coreConflict ?? '',
    openingHook: value?.openingHook ?? '',
    reversal: value?.reversal ?? '',
    endingHook: value?.endingHook ?? '',
    beats: value?.beats?.join('\n') ?? '',
    targetDurationSec: value?.targetDurationSec ? String(value.targetDurationSec) : '90',
    sourceRange: value?.sourceRange ?? '',
  };
}

function toCreativeInfo(value: CreativeDraft): EpisodeCreativeInfo | undefined {
  const duration = Number.parseInt(value.targetDurationSec, 10);
  const beats = value.beats
    .split(/\r?\n/)
    .map((beat) => beat.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);
  const result: EpisodeCreativeInfo = {
    task: value.task.trim() || undefined,
    coreConflict: value.coreConflict.trim() || undefined,
    openingHook: value.openingHook.trim() || undefined,
    reversal: value.reversal.trim() || undefined,
    endingHook: value.endingHook.trim() || undefined,
    beats: beats.length > 0 ? beats : undefined,
    targetDurationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    sourceRange: value.sourceRange.trim() || undefined,
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

function createDraft(episode: {
  episodeOutline?: string;
  episodeScript?: string;
  episodeCreative?: EpisodeCreativeInfo;
} | null): WorkbenchDraft {
  return {
    outline: episode?.episodeOutline ?? '',
    script: episode?.episodeScript ?? '',
    creative: toCreativeDraft(episode?.episodeCreative),
  };
}

function draftSignature(value: WorkbenchDraft): string {
  return JSON.stringify(value);
}

function CreativeField({
  label,
  value,
  placeholder,
  multiline = false,
  readOnly = false,
  numberInput,
  onChange,
  onAiAction,
  aiDisabled = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
  readOnly?: boolean;
  numberInput?: { min: number; max?: number; step?: number };
  onChange: (value: string) => void;
  onAiAction?: () => void;
  aiDisabled?: boolean;
}) {
  const t = useT();
  const inputId = useId();
  const aiActionLabel = value.trim() ? t('AI 润色') : t('AI 生成');
  const fieldClass = `w-full rounded-lg border border-canvas-border bg-canvas-card px-3 text-xs
                      text-canvas-text outline-none transition-colors placeholder:text-canvas-text-muted
                      focus:border-indigo-400/60 focus:ring-1 focus:ring-indigo-400/20`;
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <label
          htmlFor={inputId}
          className="min-w-0 flex-1 truncate text-[11px] font-medium text-canvas-text-secondary"
        >
          {label}
        </label>
        {onAiAction ? (
          <button
            type="button"
            disabled={aiDisabled}
            onClick={(event) => {
              event.preventDefault();
              onAiAction();
            }}
            aria-label={t('{action}{label}', { action: aiActionLabel, label })}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-indigo-400/20
                       bg-indigo-500/10 px-2 text-[10px] font-medium text-indigo-300 transition-colors
                       hover:border-indigo-400/40 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon icon="lucide:sparkles" className="h-3 w-3" />
            {aiActionLabel}
          </button>
        ) : null}
      </span>
      {numberInput ? (
        <NumberStepper id={inputId} value={Number.parseFloat(value) || numberInput.min}
          onChange={(next) => onChange(String(next))} min={numberInput.min} max={numberInput.max} step={numberInput.step ?? 1}
          disabled={readOnly} aria-label={label} className="w-full" />
      ) : multiline ? (
        <textarea
          id={inputId}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`${fieldClass} min-h-24 resize-y py-2.5 leading-relaxed`}
        />
      ) : (
        <input
          id={inputId}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`${fieldClass} h-9`}
        />
      )}
    </div>
  );
}

export default function ScriptWorkbench({
  isOpen,
  onClose: onCloseRequest,
  startWithSplit = false,
  openRequestRevision = 0,
  requestSplit = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  startWithSplit?: boolean;
  openRequestRevision?: number;
  requestSplit?: boolean;
}) {
  const t = useT();
  const {
    projects,
    currentProjectId,
    projectLoadStatus,
    updateEpisodeCreative,
    openChatWithDraft,
    showToast,
    dramaAssets,
    config,
    workflows,
    agentTasks,
    updateConfig,
  } = useAppStore(useShallow((state) => ({
    projects: state.projects,
    currentProjectId: state.currentProjectId,
    projectLoadStatus: state.projectLoadStatus,
    updateEpisodeCreative: state.updateEpisodeCreative,
    openChatWithDraft: state.openChatWithDraft,
    showToast: state.showToast,
    dramaAssets: state.dramaAssets,
    config: state.config,
    workflows: state.workflows,
    agentTasks: state.agentTasks,
    updateConfig: state.updateConfig,
  })));

  const [seriesId] = useState(() => currentProjectId ? seriesOwnerId(projects, currentProjectId) : null);
  const series = projects.find((project) => project.id === seriesId) ?? null;
  const episodes = useMemo(
    () => (seriesId ? listEpisodes(projects, seriesId) : []),
    [projects, seriesId],
  );
  const [selectedEpisodeId, setSelectedEpisodeId] = useState(() => episodes.find((episode) => episode.id === currentProjectId)?.id ?? episodes[0]?.id ?? null);
  const selectedEpisodeRef = useRef(selectedEpisodeId);
  const currentEpisode = episodes.find((episode) => episode.id === selectedEpisodeId) ?? null;
  const currentEpisodeId = currentEpisode?.id;
  const [sessionId] = useState(() => crypto.randomUUID());
  const [, refreshOriginalWriting] = useState(0);
  const [originalWriting] = useState(() => seriesId ? createOriginalWritingSession({ seriesId }) : null);
  useEffect(() => originalWriting?.subscribe(() => refreshOriginalWriting((version) => version + 1)), [originalWriting]);
  const [detached, setDetached] = useState(false);
  const [openingWindow, setOpeningWindow] = useState(false);
  const [closingWorkbench, setClosingWorkbench] = useState(false);
  const windowHost = useRef<ScriptWorkbenchWindowHost | null>(null);
  const afterReply = useRef<'close' | 'dock' | null>(null);
  const acceptedEditSequenceRef = useRef(0);
  const [acceptedEditSequence, setAcceptedEditSequence] = useState(0);
  const workspaceState = useAppStore.getState();
  const contextReady = !!series && !!currentProjectId && seriesOwnerId(projects, currentProjectId) === seriesId
    && projectLoadStatus === 'ready' && !workspaceState.isCreatingProject && !workspaceState.isReturningToStartPage
    && workspaceState.switchingProjectName === null;
  const [activeTab, setActiveTab] = useState<EditorTab>('outline');
  const [emptyStoryGraph] = useState(() => createEmptyStoryGraph());
  const [graphFilter, setGraphFilter] = useState<StoryGraphFilter>();
  const [graphExtraction, setGraphExtraction] = useState<StoryGraphExtractionState>({ status: 'idle', completed: 0, total: 0 });
  const [sourceLocation, setSourceLocation] = useState<ScriptWorkbenchSnapshot['sourceLocation']>();
  const sourceLocationSequence = useRef(0);
  const graphController = useRef<AbortController | null>(null);
  const graphRunId = useRef<string | undefined>(undefined);
  const graphGeneration = useRef(0);
  const graphCandidate = useRef<StoryGraphCandidates | null>(null);
  const graphContinuation = useRef<{ request: StoryGraphExtractRequest; candidate: StoryGraphCandidates; epoch: number } | null>(null);
  const graphEditorLease = useRef<{ graphId: string; epoch: number } | null>(null);
  const graphWritesInFlight = useRef(0);
  const [graphEditorOpen, setGraphEditorOpen] = useState(false);
  useEffect(() => () => {
    graphGeneration.current += 1;
    graphController.current?.abort();
    graphCandidate.current = null;
    graphEditorLease.current = null;
  }, [seriesId, isOpen]);
  const [draftsByEpisode, setDraftsByEpisode] = useState<Record<string, WorkbenchDraft>>(() => seriesId ? workbenchDraftCache.get(seriesId) ?? {} : {});
  const draftsRef = useRef<Record<string, WorkbenchDraft>>(draftsByEpisode);
  const draftVersions = useRef(new Map<string, number>());
  const [draftVersionByEpisode, setDraftVersionByEpisode] = useState<Record<string, number>>({});
  const savingEpisodeRef = useRef<string | null>(null);
  const startingTeamRef = useRef(false);
  const [executionSelection, setExecutionSelection] = useState<AssistantExecutionSelection>({ kind: 'single' });
  const [teamMode, setTeamMode] = useState<AgentMode>('collaborative');
  const [isStartingTeam, setIsStartingTeam] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const pendingOriginalVersion = useRef('');
  const [splitOpen, setSplitOpen] = useState(startWithSplit || Boolean(openRequestRevision && requestSplit));
  const [previousOpenRequest, setPreviousOpenRequest] = useState({ revision: openRequestRevision, split: requestSplit });
  if (previousOpenRequest.revision !== openRequestRevision || previousOpenRequest.split !== requestSplit) {
    setPreviousOpenRequest({ revision: openRequestRevision, split: requestSplit });
    if (openRequestRevision && requestSplit) setSplitOpen(true);
  }
  const [splitSource, setSplitSource] = useState<'script' | 'original'>(
    series?.series?.script?.trim() ? 'script' : 'original',
  );
  const [targetEpisodeCount, setTargetEpisodeCount] = useState('24');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [renamingEpisodeId, setRenamingEpisodeId] = useState<string | null>(null);
  const [targetDurationSec, setTargetDurationSec] = useState('90');
  const [extractingAssetKind, setExtractingAssetKind] = useState<DramaAssetKind | null>(null);
  const extractingAssetKindRef = useRef<DramaAssetKind | null>(null);
  const [seriesAssetPreview, setSeriesAssetPreview] = useState<SeriesAssetExtractionResult | null>(null);
  const extractionGeneration = useRef(0);
  useEffect(() => () => { extractionGeneration.current += 1; }, [isOpen, selectedEpisodeId, seriesId]);
  const assetSource = useAppStore(useShallow((state) => ({ projects: state.projects, currentProjectId: state.currentProjectId,
    projectLoadStatus: state.projectLoadStatus, isCreatingProject: state.isCreatingProject, isReturningToStartPage: state.isReturningToStartPage,
    switchingProjectName: state.switchingProjectName, dramaAssets: state.dramaAssets,
    globalCharacters: state.globalCharacters, globalProps: state.globalProps,
    nodes: (activeTab === 'characters' || activeTab === 'props') && selectedEpisodeId === state.currentProjectId
      ? projectChatNodes(state.nodes) : EMPTY_WORKBENCH_NODES })));

  const persistedDraft = createDraft(currentEpisode);
  const draft = currentEpisode
    ? draftsByEpisode[currentEpisode.id] ?? persistedDraft
    : persistedDraft;
  const isDirty = currentEpisode !== null
    && draftsByEpisode[currentEpisode.id] !== undefined
    && draftSignature(draft) !== draftSignature(persistedDraft);
  const editorWriteLocked = useSyncExternalStore(subscribeEpisodeEditorWrites,
    () => isEpisodeEditorWriteLocked(currentEpisode?.id), () => false);
  const unsettledEditor = useSyncExternalStore(subscribeEpisodeEditorWrites,
    () => hasUnsettledEpisodeEditorSession(currentEpisode?.id), () => false);
  const teamProfile = useMemo(() => {
    if (currentEpisode?.creationProfile && !config.creationProfiles?.some((profile) => profile.id === currentEpisode?.creationProfile?.id
      && profile.version === currentEpisode?.creationProfile?.version)) return normalizeTeamProfile(config.agentTeamProfile);
    try { return resolveCreationTeamProfile(currentEpisode?.creationProfile, currentEpisode?.teamProfileOverride); }
    catch { return normalizeTeamProfile(config.agentTeamProfile); }
  }, [config.agentTeamProfile, config.creationProfiles, currentEpisode?.creationProfile, currentEpisode?.teamProfileOverride]);
  const [externalCatalog, setExternalCatalog] = useState(() => readExternalAgentCatalog());
  const modelCatalog = useMemo(() => buildChatModelCatalog({ config, workflows }), [config, workflows]);
  const episodeTeamTasks = currentEpisodeId
    ? agentTasks.filter((task) => task.teamRun?.target?.episodeId === currentEpisodeId)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
    : [];
  const episodeAgentTasks = currentEpisodeId ? agentTasks
    .filter((task) => !task.parentTaskId && task.workbenchTarget?.episodeId === currentEpisodeId
      && task.workbenchTarget.seriesId === seriesId)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
    .map((task) => ({ id: task.id, status: task.status, title: t('智能调度'),
      activity: task.steps.find((step) => step.id === task.currentStepId)?.title ?? task.steps.at(-1)?.title ?? '' })) : [];

  useEffect(() => {
    if (!currentEpisodeId || !contextReady) return;
    let current = true;
    const episodeId = currentEpisodeId;
    void loadProjectAgentTasks(episodeId).then((tasks) => {
      const state = useAppStore.getState();
      if (!current || selectedEpisodeRef.current !== episodeId || !readEpisodeWorkspaceScope(state, episodeId)) return;
      for (const task of tasks) {
        const target = task.teamRun?.target ?? task.workbenchTarget;
        if (target?.episodeId !== episodeId || target.seriesId !== seriesId) continue;
        const live = state.agentTasks.find((item) => item.id === task.id);
        if (!live || live.updatedAt < task.updatedAt) state.upsertAgentTask(task);
      }
    }).catch(() => {});
    return () => { current = false; };
  }, [currentEpisodeId, currentProjectId, projectLoadStatus, contextReady, seriesId]);

  const replaceEpisodeDraft = useCallback((episodeId: string, value: WorkbenchDraft | undefined) => {
    const next = { ...draftsRef.current };
    if (value) next[episodeId] = value;
    else delete next[episodeId];
    draftsRef.current = next;
    if (seriesId) {
      if (Object.keys(next).length) workbenchDraftCache.set(seriesId, next);
      else workbenchDraftCache.delete(seriesId);
    }
    const version = (draftVersions.current.get(episodeId) ?? 0) + 1;
    draftVersions.current.set(episodeId, version);
    setDraftVersionByEpisode((previous) => ({ ...previous, [episodeId]: version }));
    setDraftsByEpisode(next);
  }, [seriesId, setDraftVersionByEpisode, setDraftsByEpisode]);

  const onClose = () => {
    if (originalWriting?.isDirty() || originalWriting?.isBusy()) {
      setActiveTab('original');
      showToast(t('请先保存原文或处理未保存修改，再离开工作台'), 'error');
      return;
    }
    const episodeId = currentEpisode?.id;
    const local = episodeId ? draftsRef.current[episodeId] : undefined;
    const saved = useAppStore.getState().projects.find((item) => item.id === episodeId);
    if (episodeId && local && draftSignature(local) === draftSignature(createDraft(saved ?? null))) {
      replaceEpisodeDraft(episodeId, undefined);
    }
    if (detached) afterReply.current = 'close';
    else onCloseRequest();
  };

  const currentDirty = () => {
    const episodeId = selectedEpisodeRef.current;
    const local = episodeId ? draftsRef.current[episodeId] : undefined;
    return !!local && draftSignature(local) !== draftSignature(createDraft(useAppStore.getState().projects.find((item) => item.id === episodeId) ?? null));
  };

  useEffect(() => {
    const episodeId = currentEpisodeId;
    if (!isOpen || !episodeId) return;
    return registerEpisodeEditorSession(episodeId, () => {
      const episode = useAppStore.getState().projects.find((item) => item.id === episodeId);
      const local = draftsRef.current[episodeId];
      return { dirty: (!!local && draftSignature(local) !== draftSignature(createDraft(episode ?? null))) || graphEditorLease.current !== null || !!originalWriting?.isDirty(),
        saving: savingEpisodeRef.current === episodeId || graphWritesInFlight.current > 0 || !!originalWriting?.isBusy() };
    }, () => {
      const version = draftVersions.current.get(episodeId) ?? 0;
      const lease = graphEditorLease.current;
      return () => {
        if ((draftVersions.current.get(episodeId) ?? 0) === version && draftsRef.current[episodeId]) {
          replaceEpisodeDraft(episodeId, undefined);
        }
        if (lease && graphEditorLease.current === lease) { graphEditorLease.current = null; setGraphEditorOpen(false); }
      };
    });
  }, [currentEpisodeId, isOpen, replaceEpisodeDraft, originalWriting]);
  const analysis = analyzeEpisodeScript(draft.script, toCreativeInfo(draft.creative));

  const saveDraft = async (): Promise<boolean> => {
    if (!currentEpisode || savingEpisodeRef.current || editorWriteLocked || !contextReady) return false;
    const episodeId = currentEpisode.id;
    const version = draftVersions.current.get(episodeId) ?? 0;
    const savingDraft = draftsRef.current[episodeId] ?? createDraft(currentEpisode);
    const signature = draftSignature(savingDraft);
    savingEpisodeRef.current = episodeId;
    setIsSaving(true);
    try {
      const saved = await updateEpisodeCreative(episodeId, {
        outline: savingDraft.outline,
        script: savingDraft.script,
        creative: toCreativeInfo(savingDraft.creative),
      }, { allowSameSeries: true, assertCurrent: () => {
        if (selectedEpisodeRef.current !== episodeId || !readEpisodeWorkspaceScope(useAppStore.getState(), episodeId)) throw new Error(t('工作台分集或剧集已变化，请重新保存'));
      }, assertCommitCurrent: () => {
        const scope = readEpisodeWorkspaceScope(useAppStore.getState(), episodeId);
        if (!scope || scope.owner.id !== seriesId || selectedEpisodeRef.current !== episodeId) throw new Error(t('工作台分集或剧集已变化，请重新保存'));
      } });
      if (saved) {
        const latest = draftsRef.current[episodeId];
        if ((draftVersions.current.get(episodeId) ?? 0) !== version
          || (latest && draftSignature(latest) !== signature)) {
          showToast(t('保存期间有新修改，已保留草稿，请重新发起创作请求'));
          return false;
        }
        replaceEpisodeDraft(episodeId, undefined);
        settleEpisodeEditorSessions(episodeId);
      }
      return saved && selectedEpisodeRef.current === episodeId && !!readEpisodeWorkspaceScope(useAppStore.getState(), episodeId);
    } finally {
      savingEpisodeRef.current = null;
      setIsSaving(false);
    }
  };

  const performPendingAction = (action: PendingAction) => {
    if (savingEpisodeRef.current || isEpisodeEditorWriteLocked(currentEpisode?.id)) return;
    setPendingAction(null);
    setSeriesAssetPreview(null);
    if (selectedEpisodeRef.current) {
      replaceEpisodeDraft(selectedEpisodeRef.current, undefined);
      settleEpisodeEditorSessions(selectedEpisodeRef.current);
    }
    if (action.type === 'close') {
      originalWriting?.discard();
      onClose();
      return;
    }
    selectedEpisodeRef.current = action.episodeId;
    setSelectedEpisodeId(action.episodeId);
  };

  const requestClose = () => {
    if (savingEpisodeRef.current || editorWriteLocked) return false;
    if (originalWriting?.isBusy()) {
      setActiveTab('original');
      showToast(t('请先等待原文保存完成，或停止生成，再关闭工作台'), 'error');
      return false;
    }
    if (graphEditorLease.current || graphWritesInFlight.current > 0) {
      showToast(t('请先保存或关闭关系图详情，再离开工作台'), 'error');
      setActiveTab('story-graph'); return false;
    }
    if (graphController.current || graphCandidate.current) {
      showToast(t('请先取消关系图提取，或采纳、丢弃候选后关闭工作台'), 'error');
      setActiveTab('story-graph');
      return false;
    }
    if (currentDirty() || originalWriting?.isDirty()) {
      const original = originalWriting?.summary();
      pendingOriginalVersion.current = JSON.stringify([original?.documentId, original?.revision]);
      setPendingAction({ type: 'close' }); return false;
    }
    else {
      setSeriesAssetPreview(null);
      onClose();
      return true;
    }
  };

  const requestEpisodeSwitch = (episodeId: string) => {
    if (savingEpisodeRef.current || editorWriteLocked) return;
    if (graphEditorLease.current || graphWritesInFlight.current > 0) { showToast(t('请先保存或关闭关系图详情，再切换分集'), 'error'); return; }
    if (episodeId === selectedEpisodeRef.current || !episodes.some((episode) => episode.id === episodeId)) return;
    setSeriesAssetPreview(null);
    if (currentDirty()) setPendingAction({ type: 'switch', episodeId });
    else { selectedEpisodeRef.current = episodeId; setSelectedEpisodeId(episodeId); }
  };

  const readGraphContext = () => {
    const state = useAppStore.getState();
    const owner = state.projects.find((project) => project.id === seriesId);
    if (!isOpen || !owner || !state.currentProjectId || state.projectLoadStatus !== 'ready'
      || state.isCreatingProject || state.isReturningToStartPage || state.switchingProjectName !== null
      || seriesOwnerId(state.projects, state.currentProjectId) !== seriesId) {
      throw new Error(t('关系图所在剧集已变化，请回到原剧集重试'));
    }
    return { state, owner, graph: owner.series?.storyGraph ?? createEmptyStoryGraph(`${emptyStoryGraph.id}-${owner.exchangeEpoch ?? 0}`) };
  };
  const readGraphSource = (episodeId: string, part: 'outline' | 'script') => {
    const { state, owner } = readGraphContext();
    if (part !== 'outline' && part !== 'script') throw new Error(t('关系图来源类型无效'));
    const episode = listEpisodes(state.projects, owner.id).find((entry) => entry.id === episodeId);
    if (!episode) throw new Error(t('关系图来源分集已删除或不属于本剧'));
    return { episode, text: (part === 'outline' ? episode.episodeOutline : episode.episodeScript) ?? '' };
  };
  const modelFingerprint = async (modelId: string) => {
    const { state } = readGraphContext();
    const model = buildChatModelCatalog(state).assistantModelGroups.flatMap((group) => group.models).find((item) => item.value === modelId);
    const resolved = resolveAssistantModel(seriesId, modelId);
    if (!model || model.provider === 'comfyui' || !resolved) throw new Error(t('请选择可用的文本模型'));
    const fingerprint = await hashStoryGraphSource(JSON.stringify(resolved));
    readGraphContext();
    if (!configValuesEqual(resolved, resolveAssistantModel(seriesId, modelId))) throw new Error(t('文本模型配置已变化，请重新选择'));
    return { model, fingerprint };
  };
  const graphScopeGuard = (epoch: number, selectedId: string | null) => {
    const { owner } = readGraphContext();
    if ((owner.exchangeEpoch ?? 0) !== epoch || selectedEpisodeRef.current !== selectedId) {
      throw new Error(t('关系图会话或分集已变化，请核对后重试'));
    }
  };
  const validateGraphPatch = async (patch: StoryGraphPatch) => {
    const { state, owner, graph } = readGraphContext();
    const episodeIds = new Set(listEpisodes(state.projects, owner.id).map((entry) => entry.id));
    const checkedSources: Array<Pick<StoryGraphSource, 'episodeId' | 'part' | 'text'>> = [];
    for (const item of [...(patch.upsertNodes ?? []), ...(patch.upsertEdges ?? [])]) {
      const previous = 'source' in item ? graph.edges.find((edge) => edge.id === item.id) : graph.nodes.find((node) => node.id === item.id);
      if (item.episodeIds.some((id) => !episodeIds.has(id) && !previous?.episodeIds.includes(id))) throw new Error(t('关系图引用了本剧以外的分集'));
      if ('source' in item) {
        for (const key of ['fromEpisodeId', 'toEpisodeId'] as const) {
          const oldValue = previous && 'source' in previous ? previous[key] : undefined;
          if (item[key] && !episodeIds.has(item[key]) && item[key] !== oldValue) throw new Error(t('关系图引用了本剧以外的分集'));
        }
      }
      for (const evidence of item.evidence) {
        if (previous?.evidence.some((entry) => configValuesEqual(entry, evidence))) continue;
        const { text } = readGraphSource(evidence.episodeId, evidence.part);
        const source: StoryGraphSource = { episodeId: evidence.episodeId, part: evidence.part, text, sourceHash: await hashStoryGraphSource(text) };
        if (!validateStoryGraphEvidence(evidence, source)) throw new Error(t('原文证据已变化，请重新绑定'));
        checkedSources.push(source);
      }
      if ('asset' in item && item.asset) {
        const oldAsset = previous && 'asset' in previous ? previous.asset : undefined;
        if (!configValuesEqual(oldAsset, item.asset)) {
          const pool = item.asset.kind === 'character' ? state.dramaAssets.characters : item.asset.kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props;
          if (!pool.some((asset) => asset.id === item.asset?.id)) throw new Error(t('绑定的正式资产已删除或不属于本剧'));
        }
      }
    }
    return () => {
      for (const source of checkedSources) {
        if (readGraphSource(source.episodeId, source.part).text !== source.text) throw new Error(t('原文证据已变化，请重新绑定'));
      }
    };
  };
  const commitGraphPatch = async (patch: StoryGraphPatch, expectedRevision: number, assertCandidate?: () => void) => {
    const { owner, graph } = readGraphContext();
    const epoch = owner.exchangeEpoch ?? 0;
    const selectedId = selectedEpisodeRef.current;
    const lease = graphEditorLease.current;
    if (lease && (lease.graphId !== graph.id || lease.epoch !== epoch)) throw new Error(t('关系图版本已变化，请重新打开详情'));
    if (patch.graphId && patch.graphId !== graph.id) throw new Error(t('关系图版本已变化，请刷新后重试'));
    const boundedPatch = { ...patch, graphId: graph.id };
    applyStoryGraphPatch(graph, boundedPatch, expectedRevision);
    graphWritesInFlight.current += 1;
    try {
      const assertSources = await validateGraphPatch(boundedPatch);
      graphScopeGuard(epoch, selectedId);
      assertSources();
      assertCandidate?.();
      await useAppStore.getState().updateStoryGraph(owner.id, boundedPatch, expectedRevision, {
        expectedExchangeEpoch: epoch, assertCurrent: () => { graphScopeGuard(epoch, selectedId); assertSources(); assertCandidate?.(); },
      });
      return true;
    } finally { graphWritesInFlight.current -= 1; }
  };
  const startGraphExtraction = async (input: StoryGraphExtractRequest) => {
    if (graphEditorLease.current || graphWritesInFlight.current > 0) throw new Error(t('请先保存或关闭关系图详情'));
    if (graphController.current || graphCandidate.current) throw new Error(t('请先取消提取，或采纳、丢弃当前候选'));
    const { owner, graph } = readGraphContext();
    if (!Array.isArray(input.episodeIds) || input.episodeIds.length < 1 || input.episodeIds.length > 100
      || !Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 2
      || input.parts.some((part) => part !== 'outline' && part !== 'script')
      || typeof input.modelId !== 'string' || input.modelId.length > 256
      || (input.startChunk !== undefined && (!Number.isSafeInteger(input.startChunk) || input.startChunk < 0))) {
      throw new Error(t('关系图提取参数无效'));
    }
    const epoch = owner.exchangeEpoch ?? 0;
    const controller = new AbortController();
    graphController.current = controller;
    const generation = ++graphGeneration.current;
    const runId = crypto.randomUUID();
    graphRunId.current = runId;
    const assertScope = () => {
      controller.signal.throwIfAborted();
      if (graphGeneration.current !== generation) throw new Error(t('关系图提取已取消'));
      const current = readGraphContext();
      if ((current.owner.exchangeEpoch ?? 0) !== epoch) throw new Error(t('关系图会话或分集已变化，请核对后重试'));
      const live = current.graph;
      if (live.id !== graph.id || live.revision !== graph.revision) throw new Error(t('关系图版本已变化，请重新提取'));
    };
    setGraphExtraction({ status: 'running', runId, completed: 0, total: 0 });
    try {
      const capturedModel = await modelFingerprint(input.modelId);
      assertScope();
      const sources: StoryGraphSource[] = [];
      for (const episodeId of [...new Set(input.episodeIds)]) {
        for (const part of [...new Set(input.parts)]) {
          const { episode, text } = readGraphSource(episodeId, part);
          const local = draftsRef.current[episodeId];
          if ((local && draftSignature(local) !== draftSignature(createDraft(episode))) || isEpisodeEditorWriteLocked(episodeId)
            || hasUnsettledEpisodeEditorSession(episodeId)) throw new Error(t('请先保存所选分集的稿件，再提取关系图'));
          if (text.trim()) sources.push({ episodeId, part, text, sourceHash: await hashStoryGraphSource(text) });
          assertScope();
        }
      }
      const bindings = sources.map(({ episodeId, part, sourceHash }) => ({ episodeId, part, sourceHash }));
      const continuation = graphContinuation.current;
      if ((input.startChunk ?? 0) > 0 && (!continuation || continuation.epoch !== epoch
        || continuation.candidate.nextChunk !== input.startChunk || continuation.candidate.graphId !== graph.id
        || continuation.candidate.modelFingerprint !== capturedModel.fingerprint
        || !configValuesEqual(continuation.candidate.sourceBindings, bindings)
        || continuation.request.modelId !== input.modelId)) throw new Error(t('续批材料或模型已变化，请从第一批重新提取'));
      const assertCurrent = async () => {
        assertScope();
        for (const source of sources) if (readGraphSource(source.episodeId, source.part).text !== source.text) throw new Error(t('稿件来源已变化，请重新提取'));
        if ((await modelFingerprint(input.modelId)).fingerprint !== capturedModel.fingerprint) throw new Error(t('文本模型配置已变化，请重新选择'));
        assertScope();
        for (const source of sources) if (readGraphSource(source.episodeId, source.part).text !== source.text) throw new Error(t('稿件来源已变化，请重新提取'));
      };
      await assertCurrent();
      const candidate = await extractStoryGraphCandidates({ seriesId: owner.id, sessionId, graphId: graph.id,
        graphRevision: graph.revision, model: { model: capturedModel.model.value, provider: capturedModel.model.provider, fingerprint: capturedModel.fingerprint },
        sources, startChunk: input.startChunk }, { signal: controller.signal, assertCurrent,
        onProgress: (progress) => {
          if (graphGeneration.current === generation) setGraphExtraction({ status: 'running', runId, completed: progress.completedCalls, total: progress.totalCalls });
        },
      });
      await assertCurrent();
      graphCandidate.current = candidate;
      graphContinuation.current = { request: structuredClone(input), candidate, epoch };
      setGraphExtraction({ status: 'ready', runId, completed: candidate.callsUsed, total: candidate.callsUsed, candidate,
        ...(candidate.hasMore && candidate.nextChunk !== undefined ? { continuation: { request: structuredClone(input), nextChunk: candidate.nextChunk, totalChunks: candidate.totalChunks } } : {}) });
    } catch (cause) {
      const error = sanitizeDomainText(cause instanceof Error ? cause.message : t('关系图提取失败')).slice(0, 300);
      if (graphGeneration.current === generation) setGraphExtraction((previous) => ({ ...previous,
        status: controller.signal.aborted ? 'cancelled' : 'failed', runId, error: controller.signal.aborted ? undefined : error }));
      if (controller.signal.aborted) return false;
      throw new Error(error, { cause });
    } finally {
      if (graphController.current === controller) graphController.current = null;
    }
    return true;
  };

  const startAutomaticCreativeRequest = async (content: string) => {
    if (!currentEpisode || !contextReady || startingTeamRef.current || savingEpisodeRef.current || editorWriteLocked) return;
    const episodeId = currentEpisode.id;
    startingTeamRef.current = true;
    setIsStartingTeam(true);
    try {
      if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
      if (selectedEpisodeRef.current !== episodeId) throw new Error(t('工作台分集已变化，请等待最新内容后重试'));
      startWorkbenchAgentInvocation({ episodeId, content, mode: teamMode });
      showToast(t('智能调度已开始，可查看调用与结果'));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('创作任务启动失败'), 'error');
      throw error;
    } finally {
      startingTeamRef.current = false;
      setIsStartingTeam(false);
    }
  };

  const openCreativeAction = async (action: EpisodeCreativeAction, requestId?: string) => {
    if (!series || !currentEpisode || !contextReady) return;
    if (executionSelection.kind === 'team') {
      const templateId: TeamTemplateId | undefined = action === 'optimize-outline' ? 'outline'
        : action === 'write-script' ? 'script' : action === 'diagnose' ? 'review' : undefined;
      if (!templateId) { showToast(t('这个创作动作请使用智能调度')); return; }
      if (startingTeamRef.current || savingEpisodeRef.current || editorWriteLocked) return;
      startingTeamRef.current = true;
      setIsStartingTeam(true);
      try {
        const episodeId = currentEpisode.id;
        if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
        const captured = await captureEpisodeTeamContext(episodeId, templateId === 'outline' ? 'outline' : 'script');
        setExecutionSelection({ kind: 'team', templateId });
        await startTeamInvocation({ projectId: episodeId, mode: teamMode, templateId, requestId,
          content: templateId === 'outline' ? t('优化本集大纲，保留已确认设定与有效结构，只返回本集候选。')
            : templateId === 'script' ? t('根据已保存的大纲与创作要点写出本集完整剧本，保留人物设定并检查可拍性。')
              : t('联合审阅本集剧本的因果、人物连续性、对白与可拍性，只返回定位问题和裁决，不改写正文。'),
          ...captured, profile: teamProfile });
        showToast(t('团队任务已开始，可在工作台或助手查看同一任务'));
      } catch (error) {
        showToast(error instanceof Error ? error.message : t('团队任务启动失败'), 'error');
        throw error;
      } finally {
        startingTeamRef.current = false;
        setIsStartingTeam(false);
      }
      return;
    }
    await startAutomaticCreativeRequest(buildEpisodeCreativePrompt(action, {
      seriesName: series.name,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
    }));
  };

  const openEpisodeShotlist = async () => {
    if (!currentEpisode || isSaving || !contextReady) return;
    const startingProjectId = useAppStore.getState().currentProjectId;
    const episodeId = currentEpisode.id;
    try {
      if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
      if (useAppStore.getState().currentProjectId !== startingProjectId) return;
      if (startingProjectId !== episodeId) {
        throw new Error(t('请先在剧集栏切换到本集画布，再生成分镜'));
      }
      const state = useAppStore.getState();
      const { shotlistId } = createEpisodeShotlist({ projectId: episodeId, baseRevision: state.getCurrentRevision() }, episodeId);
      onClose();
      window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId: shotlistId } }));
      useAppStore.getState().openNodeDialog(shotlistId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('创建本集分镜失败'), 'error');
      throw error;
    }
  };

  const openFieldPolish = async (field: CreativeFieldId, hasValue: boolean) => {
    if (!series || !currentEpisode || !contextReady) return;
    await startAutomaticCreativeRequest(buildCreativeFieldPolishPrompt(field, {
      seriesName: series.name,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
    }, hasValue));
  };

  const openSplitDraft = () => {
    if (!series) return;
    const count = Math.min(100, Math.max(1, Number.parseInt(targetEpisodeCount, 10) || 24));
    const duration = Math.min(600, Math.max(15, Number.parseInt(targetDurationSec, 10) || 90));
    openChatWithDraft(buildSplitDraftPrompt({
      seriesName: series.name,
      source: splitSource,
      targetEpisodeCount: count,
      targetDurationSec: duration,
      existingEpisodeCount: episodes.length,
    }));
    showToast(t('已准备拆分草案请求，不会直接创建分集'));
  };

  const extractFullScriptAssets = async (kind: DramaAssetKind, label: string) => {
    if (!series || !currentProjectId || !contextReady || extractingAssetKindRef.current) return;
    const generation = ++extractionGeneration.current;
    extractingAssetKindRef.current = kind;
    setExtractingAssetKind(kind);
    try {
      const result = await extractSeriesAssetsFromFullScript({
        kind,
        seriesId: series.id,
        projectId: currentProjectId,
      });
      if (generation !== extractionGeneration.current) return;
      setSeriesAssetPreview(result);
      showToast(t('已提取 {count} 项{name}，请预览后选择入库', { count: result.count, name: label }));
    } catch (error) {
      if (generation !== extractionGeneration.current) return;
      showToast(error instanceof Error ? error.message : t('全剧资产提取失败'), 'error');
      throw error;
    } finally {
      extractingAssetKindRef.current = null;
      setExtractingAssetKind(null);
    }
  };

  const setCreative = (field: keyof CreativeDraft, value: string) => {
    if (!currentEpisode || !contextReady || isEpisodeEditorWriteLocked(currentEpisode.id)) return;
    const currentDraft = draftsRef.current[currentEpisode.id] ?? createDraft(currentEpisode);
    replaceEpisodeDraft(currentEpisode.id, { ...currentDraft, creative: { ...currentDraft.creative, [field]: value } });
  };

  const setTextDraft = (field: 'outline' | 'script', value: string) => {
    if (!currentEpisode || !contextReady || isEpisodeEditorWriteLocked(currentEpisode.id)) return;
    const currentDraft = draftsRef.current[currentEpisode.id] ?? createDraft(currentEpisode);
    replaceEpisodeDraft(currentEpisode.id, { ...currentDraft, [field]: value });
  };

  const viewTeamTask = async (taskId: string) => {
    if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
    onClose();
    await openTeamTaskInAssistant(taskId);
  };

  const mutateTeamResult = async (taskId: string, restore: boolean) => {
    if (currentDirty() || savingEpisodeRef.current) throw new Error(t('请先处理工作台未保存修改，再应用团队成果'));
    onClose();
    try {
      await openTeamTaskInAssistant(taskId);
      await (restore ? restoreTeamResult(taskId) : applyTeamResult(taskId));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('团队成果保存失败'), 'error');
      throw error;
    }
  };

  const effectiveGraphFilter = useMemo<StoryGraphFilter>(() => graphFilter ?? { episodeIds: currentEpisodeId ? [currentEpisodeId] : [] }, [graphFilter, currentEpisodeId]);
  const liveStoryGraph = useMemo(() => series?.series?.storyGraph
    ?? createEmptyStoryGraph(`${emptyStoryGraph.id}-${series?.exchangeEpoch ?? 0}`), [series?.series?.storyGraph, series?.exchangeEpoch, emptyStoryGraph.id]);
  const graphView = useMemo(() => activeTab === 'story-graph'
    ? projectStoryGraphView(liveStoryGraph, effectiveGraphFilter) : undefined, [activeTab, liveStoryGraph, effectiveGraphFilter]);
  const graphAssets = useMemo<StoryGraphAssetOption[]>(() => [
    ...dramaAssets.characters.map((asset) => ({ kind: 'character' as const, id: asset.id, label: asset.name })),
    ...dramaAssets.scenes.map((asset) => ({ kind: 'scene' as const, id: asset.id, label: asset.name })),
    ...dramaAssets.props.map((asset) => ({ kind: 'prop' as const, id: asset.id, label: asset.name })),
  ].slice(0, 500), [dramaAssets]);

  const snapshot: ScriptWorkbenchSnapshot = {
    sessionId, revision: 0, acceptedEditSequence,
    draftVersion: currentEpisodeId ? draftVersionByEpisode[currentEpisodeId] ?? 0 : 0,
    series: series ? { id: series.id, name: series.name, hasScript: !!series.series?.script?.trim(), hasOriginal: !!series.series?.originalWork,
      originalAddedAt: series.series?.originalWork?.addedAt, exchangeEpoch: series.exchangeEpoch ?? 0 } : null,
    episodes: episodes.map((episode) => ({ id: episode.id, name: episode.name, scriptLength: episode.episodeScript?.length ?? 0, hasOutline: !!episode.episodeOutline?.trim() })),
    currentEpisode: currentEpisode ? { id: currentEpisode.id, parentId: currentEpisode.parentId, name: currentEpisode.name,
      episodeOutline: currentEpisode.episodeOutline, episodeScript: currentEpisode.episodeScript,
      episodeCreative: currentEpisode.episodeCreative, episodeAssetRoster: currentEpisode.episodeAssetRoster,
      creationProfile: currentEpisode.creationProfile, teamProfileOverride: currentEpisode.teamProfileOverride } : null,
    canvasProjectId: currentProjectId, activeTab, draft, analysis, isDirty, isSaving, isStartingTeam,
    contextReady, editorWriteLocked, unsettledEditor, pendingAction, splitOpen, splitSource,
    targetEpisodeCount, targetDurationSec, sourceOpen, renamingEpisodeId, extractingAssetKind,
    seriesAssetPreview: seriesAssetPreview && contextReady ? { kind: seriesAssetPreview.kind, assets: seriesAssetPreview.assets } : null,
    existingAssets: (seriesAssetPreview?.kind === 'character' ? dramaAssets.characters : seriesAssetPreview?.kind === 'scene' ? dramaAssets.scenes : dramaAssets.props)
      .map((asset) => ({ name: asset.name, summary: asset.summary })),
    assetPanel: currentEpisode && (activeTab === 'characters' || activeTab === 'props') ? buildEpisodeAssetPanelSnapshot(assetSource, currentEpisode.id) : undefined,
    executionSelection, teamMode, teamProfile, modelGroups: modelCatalog.assistantModelGroups, episodeTeamTasks, episodeAgentTasks,
    creationProfiles: creationProfileOptions(), externalAgents: externalCatalog,
    storyGraphView: graphView, storyGraphFilter: effectiveGraphFilter,
    storyGraphAssets: graphView && contextReady ? graphAssets : undefined,
    storyGraphExtraction: graphView ? graphExtraction : undefined, storyGraphEditorOpen: graphEditorOpen, sourceLocation,
    originalWriting: originalWriting?.summary(),
    theme: resolveAppearanceMode(config.appearance?.mode ?? config.theme), language: config.language,
    appearance: createAppearanceUiSnapshot(config.appearance ?? getAppearanceForConfig(config)),
    detached, openingWindow,
  };
  const snapshotRef = useRef(snapshot);
  const requestRef = useRef<(request: ScriptWorkbenchRequest) => Promise<unknown>>(async () => undefined);
  const actionRef = useRef<(action: ScriptWorkbenchAction, request?: ScriptWorkbenchRequest) => Promise<unknown>>(async () => undefined);
  const onCloseRequestRef = useRef(onCloseRequest);
  const dispatchView = useCallback<ScriptWorkbenchDispatch>((action) => actionRef.current(action), []);

  const handleAction = async (action: ScriptWorkbenchAction, request?: ScriptWorkbenchRequest): Promise<unknown> => {
    if (request) {
      if (request.originalHandoff && !(action.type === 'original_reload' && action.discard)) {
        try { originalWriting?.flush(request.originalHandoff); }
        catch (error) {
          // 无法接受的末次输入不能阻塞停止生成或用户明确放弃；其余操作仍须完成交接。
          if (!['original_cancel', 'original_discard_candidate', 'discard_pending'].includes(action.type)) throw error;
        }
      }
      if (!action.type.startsWith('original_') && request.episodeId !== selectedEpisodeRef.current) throw new Error(t('工作台分集已变化，请等待最新内容后重试'));
      const handoff = request.handoff;
      if (handoff && handoff.sequence > acceptedEditSequenceRef.current) {
        const value = handoff.draft;
        if (handoff.episodeId !== selectedEpisodeRef.current || !Number.isSafeInteger(handoff.sequence)
          || !value || typeof value.outline !== 'string' || typeof value.script !== 'string' || !value.creative
          || Object.keys(EMPTY_CREATIVE_DRAFT).some((field) => typeof value.creative[field as keyof CreativeDraft] !== 'string')) {
          throw new Error(t('最后编辑的交接内容无效，已保留原稿'));
        }
        if (isEpisodeEditorWriteLocked(handoff.episodeId)) throw new Error(t('团队成果正在保存，修改仍保留在独立窗口，请稍后重试'));
        replaceEpisodeDraft(handoff.episodeId, structuredClone(value));
        acceptedEditSequenceRef.current = handoff.sequence;
        setAcceptedEditSequence(handoff.sequence);
      }
    }
    const uiOnly = ['flush_draft', 'close', 'dock', 'detach', 'cancel_pending', 'discard_pending', 'close_source', 'close_rename', 'close_asset_preview', 'story_graph_cancel', 'story_graph_discard', 'story_graph_editor', 'original_edit', 'original_cancel', 'original_discard_candidate'];
    if (!contextReady && !uiOnly.includes(action.type)) throw new Error(t('画布已离开本剧集，请先回到原剧集处理工作台修改'));
    if (action.type.startsWith('original_')) {
      if (!originalWriting) throw new Error(t('当前没有可编辑的原著文件'));
      // 所有原文读取、保存和生成仍由主窗口执行；快照只发布状态与统计。
      return originalWriting.handle(action as Parameters<typeof originalWriting.handle>[0]);
    }
    if (pendingAction?.type === 'close' && (action.type === 'discard_pending' || action.type === 'save_pending')) {
      if (originalWriting?.isBusy()) throw new Error(t('请先等待原文保存完成，或停止生成，再关闭工作台'));
      const original = originalWriting?.summary();
      const version = JSON.stringify([original?.documentId, original?.revision]);
      if (version !== pendingOriginalVersion.current) {
        pendingOriginalVersion.current = version;
        throw new Error(t('原文在确认期间有新修改，请核对当前草稿后重试'));
      }
    }
    if ('taskId' in action && !(action.type === 'view_agent_task' ? episodeAgentTasks : episodeTeamTasks)
      .some((task) => task.id === action.taskId)) throw new Error(t('任务不属于当前分集'));
    switch (action.type) {
      case 'flush_draft': return true;
      case 'edit_text': if ((action.field === 'outline' || action.field === 'script') && typeof action.value === 'string') { setSourceLocation(undefined); setTextDraft(action.field, action.value); } return true;
      case 'edit_creative': if (Object.hasOwn(EMPTY_CREATIVE_DRAFT, action.field) && typeof action.value === 'string') setCreative(action.field, action.value); return true;
      case 'select_episode': requestEpisodeSwitch(action.episodeId); return true;
      case 'set_tab': {
        if (action.tab !== 'story-graph' && (graphEditorLease.current || graphWritesInFlight.current > 0)) throw new Error(t('请先保存或关闭关系图详情，再切换页签'));
        if (['outline', 'original', 'script', 'creative', 'characters', 'props', 'story-graph'].includes(action.tab)) setActiveTab(action.tab);
        return true;
      }
      case 'save': {
        if (!await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
        return true;
      }
      case 'close': return requestClose();
      case 'dock':
        if (originalWriting?.isBusy()) throw new Error(t('请先等待原文保存完成，或停止生成，再切换窗口'));
        if (graphEditorLease.current || graphWritesInFlight.current > 0) throw new Error(t('请先保存或关闭关系图详情，再切换窗口'));
        afterReply.current = 'dock'; return true;
      case 'detach': {
        if (originalWriting?.isBusy()) throw new Error(t('请先等待原文保存完成，或停止生成，再切换窗口'));
        if (graphEditorLease.current || graphWritesInFlight.current > 0) throw new Error(t('请先保存或关闭关系图详情，再切换窗口'));
        if (openingWindow) return false;
        setOpeningWindow(true);
        try { await windowHost.current?.open(); return true; }
        finally { setOpeningWindow(false); }
      }
      case 'cancel_pending': setPendingAction(null); return true;
      case 'discard_pending': if (pendingAction) performPendingAction(pendingAction); return true;
      case 'save_pending': {
        if (!pendingAction) return false;
        if (pendingAction.type === 'close' && originalWriting?.isDirty()) {
          await originalWriting.handle({ type: 'original_save' });
          if (originalWriting.isDirty()) throw new Error(t('原文保存期间有新修改，草稿已保留，请重新保存'));
        }
        if (!await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
        performPendingAction(pendingAction); return true;
      }
      case 'toggle_split': setSplitOpen((value) => !value); return true;
      case 'set_split_source': if (action.value === 'script' || action.value === 'original') setSplitSource(action.value); return true;
      case 'set_split_count': setTargetEpisodeCount(String(action.value).slice(0, 8)); return true;
      case 'set_split_duration': setTargetDurationSec(String(action.value).slice(0, 8)); return true;
      case 'open_source': setSourceOpen(true); return true;
      case 'close_source': setSourceOpen(false); return true;
      case 'read_source': {
        const state = useAppStore.getState();
        const canvasId = state.currentProjectId;
        if (!canvasId || seriesOwnerId(state.projects, canvasId) !== seriesId) throw new Error(t('当前剧集已变化'));
        return readSeriesSource(canvasId, action.part, new AbortController().signal);
      }
      case 'prepare_chapter': {
        if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
        const state = useAppStore.getState();
        const canvasId = state.currentProjectId;
        if (!canvasId || seriesOwnerId(state.projects, canvasId) !== seriesId || action.reference.seriesId !== seriesId) throw new Error(t('当前剧集已变化'));
        const source = await readSeriesSource(canvasId, action.reference.part, new AbortController().signal);
        readSeriesChapter(source, action.reference, 0, 1);
        const prompt = buildSeriesChapterPrompt(source, action.reference.chapterId);
        setSourceOpen(false); onClose(); openChatWithDraft(prompt); return true;
      }
      case 'open_rename': if (episodes.some((episode) => episode.id === action.episodeId)) setRenamingEpisodeId(action.episodeId); return true;
      case 'close_rename': setRenamingEpisodeId(null); return true;
      case 'rename': {
        const episodeId = renamingEpisodeId;
        const name = typeof action.name === 'string' ? action.name.trim() : '';
        if (!episodeId || !name || name.length > 120 || !readEpisodeWorkspaceScope(useAppStore.getState(), episodeId)) throw new Error(t('请输入有效的分集名称'));
        if (!await useAppStore.getState().renameProject(episodeId, name)) throw new Error(t('修改名称失败'));
        setRenamingEpisodeId(null); return true;
      }
      case 'creative': return openCreativeAction(action.action, request?.requestId);
      case 'view_agent_task': {
        const task = useAppStore.getState().agentTasks.find((item) => item.id === action.taskId && !item.parentTaskId
          && item.workbenchTarget?.episodeId === currentEpisode?.id && item.workbenchTarget?.seriesId === seriesId);
        if (!task || !readEpisodeWorkspaceScope(useAppStore.getState(), task.projectId)) throw new Error(t('任务不属于当前分集'));
        await openAgentTaskInAssistant(task.id);
        requestClose();
        return true;
      }
      case 'polish': return openFieldPolish(action.field, action.hasValue);
      case 'shotlist': return openEpisodeShotlist();
      case 'split_draft': openSplitDraft(); return true;
      case 'extract_series': return extractFullScriptAssets(action.kind, action.label);
      case 'close_asset_preview': setSeriesAssetPreview(null); return true;
      case 'commit_asset_preview': {
        if (!seriesAssetPreview) throw new Error(t('提取预览已变化，请重新提取'));
        const count = await commitSeriesAssetCandidates(seriesAssetPreview, action.selectedIds);
        setSeriesAssetPreview(null); showToast(t('已将 {count} 项资产加入本剧资产库', { count })); return true;
      }
      case 'asset': {
        if (action.episodeId !== selectedEpisodeRef.current) throw new Error(t('工作台分集已变化'));
        return executeEpisodeAssetPanelAction(action.episodeId, action.kind, action.action);
      }
      case 'settle_editor': if (currentEpisode && !currentDirty() && !savingEpisodeRef.current && !graphEditorLease.current) settleEpisodeEditorSessions(currentEpisode.id); return true;
      case 'set_execution': setExecutionSelection(normalizeExecutionSelection(action.value)); return true;
      case 'set_team_mode': if (['plan', 'collaborative', 'autonomous'].includes(action.value)) setTeamMode(action.value); return true;
      case 'preview_creation_profile': {
        if (!currentEpisodeId) throw new Error(t('请选择工作台分集'));
        const preview = await previewCreationProfileOption(action.profile, currentEpisodeId);
        if (selectedEpisodeRef.current !== currentEpisodeId || !readEpisodeWorkspaceScope(useAppStore.getState(), currentEpisodeId)) throw new Error(t('工作台分集已变化'));
        return { ...preview, profile: { id: preview.profile.id, version: preview.profile.version, name: preview.profile.name } } satisfies CreationProfileChoicePreview;
      }
      case 'apply_creation_profile': {
        if (!currentEpisodeId || !currentEpisode) throw new Error(t('请选择工作台分集'));
        const episodeId = currentEpisodeId;
        const previous = currentEpisode.creationProfile;
        const previousOverride = currentEpisode.teamProfileOverride;
        const selection = normalizeCreationProfileSelection(action.selection);
        if (action.selection !== null && !selection) throw new Error(t('组合包选择无效'));
        const captured = await captureCreationProfile(selection, episodeId);
        const assertScope = () => { if (selectedEpisodeRef.current !== episodeId || !readEpisodeWorkspaceScope(useAppStore.getState(), episodeId)) throw new Error(t('工作台分集已变化')); };
        assertScope();
        const saved = await updateEpisodeCreative(episodeId, { creationProfile: selection ?? null, teamProfileOverride: null }, {
          allowSameSeries: true, assertCurrent: () => {
            assertScope();
            const latest = useAppStore.getState().projects.find((entry) => entry.id === episodeId);
            if (!configValuesEqual(latest?.creationProfile, previous) || !configValuesEqual(latest?.teamProfileOverride, previousOverride)) throw new Error(t('组合包选择已变化，请重新预检'));
          }, assertCommitCurrent: assertScope,
        });
        if (!saved) throw new Error(t('组合包未能保存，请重试'));
        if (captured.profile?.teamTemplateId) setExecutionSelection({ kind: 'team', templateId: captured.profile.teamTemplateId });
        return true;
      }
      case 'story_graph_filter': {
        const { owner, graph } = readGraphContext();
        const input = action.filter;
        const knownEpisodes = new Set(listEpisodes(useAppStore.getState().projects, owner.id).map((episode) => episode.id));
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 120))
          || (input.episodeIds !== undefined && (!Array.isArray(input.episodeIds) || input.episodeIds.length > 100 || input.episodeIds.some((id) => !knownEpisodes.has(id))))
          || (input.nodeKinds !== undefined && (!Array.isArray(input.nodeKinds) || input.nodeKinds.length > 7 || input.nodeKinds.some((kind) => !STORY_GRAPH_NODE_KINDS.includes(kind))))
          || (input.edgeKinds !== undefined && (!Array.isArray(input.edgeKinds) || input.edgeKinds.length > 10 || input.edgeKinds.some((kind) => !STORY_GRAPH_EDGE_KINDS.includes(kind))))
          || (input.focusNodeId !== undefined && (typeof input.focusNodeId !== 'string' || !graph.nodes.some((node) => node.id === input.focusNodeId)))) {
          throw new Error(t('关系图筛选条件无效'));
        }
        setGraphFilter({ episodeIds: input.episodeIds, search: input.search, nodeKinds: input.nodeKinds,
          edgeKinds: input.edgeKinds, focusNodeId: input.focusNodeId, neighbors: input.neighbors === true });
        return true;
      }
      case 'story_graph_detail': {
        const { state, graph } = readGraphContext();
        const item = action.selection?.kind === 'node' ? graph.nodes.find((node) => node.id === action.selection.id)
          : action.selection?.kind === 'edge' ? graph.edges.find((edge) => edge.id === action.selection.id) : undefined;
        if (!item) throw new Error(t('关系图条目已删除或不在当前图中'));
        const evidenceStatuses: StoryGraphDetail['evidenceStatuses'] = [];
        for (const evidence of item.evidence) {
          try {
            const { text } = readGraphSource(evidence.episodeId, evidence.part);
            const hash = await hashStoryGraphSource(text);
            const currentText = readGraphSource(evidence.episodeId, evidence.part).text;
            evidenceStatuses.push(text === currentText && validateStoryGraphEvidence(evidence, { ...evidence, text, sourceHash: hash }) ? 'current' : 'changed');
          } catch { evidenceStatuses.push('missing'); }
        }
        const current = readGraphContext().graph;
        if (current.id !== graph.id || current.revision !== graph.revision) throw new Error(t('关系图版本已变化，请重新选择条目'));
        let assetAvailable: boolean | undefined;
        if ('asset' in item && item.asset) {
          const pool = item.asset.kind === 'character' ? state.dramaAssets.characters : item.asset.kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props;
          assetAvailable = pool.some((asset) => asset.id === item.asset?.id);
        }
        return { item: structuredClone(item), evidenceStatuses, assetAvailable } satisfies StoryGraphDetail;
      }
      case 'story_graph_patch': return commitGraphPatch(action.patch, action.expectedRevision);
      case 'story_graph_resolve_evidence': {
        const query = action.query;
        if (!query || typeof query.quote !== 'string' || !query.quote.trim() || query.quote.length > 240) throw new Error(t('请输入不超过 240 字的原文摘录'));
        const { owner } = readGraphContext();
        const epoch = owner.exchangeEpoch ?? 0;
        const selectedId = selectedEpisodeRef.current;
        const { text } = readGraphSource(query.episodeId, query.part);
        const start = text.indexOf(query.quote);
        if (start < 0 || text.indexOf(query.quote, start + 1) >= 0) throw new Error(t('摘录需在已保存稿件中唯一匹配，请调整摘录'));
        const sourceHash = await hashStoryGraphSource(text);
        graphScopeGuard(epoch, selectedId);
        if (readGraphSource(query.episodeId, query.part).text !== text) throw new Error(t('原文证据已变化，请重新绑定'));
        return { episodeId: query.episodeId, part: query.part, sourceHash, start, end: start + query.quote.length, quote: query.quote } satisfies StoryGraphEvidence;
      }
      case 'story_graph_locate': {
        if (graphEditorLease.current) throw new Error(t('请先保存或关闭关系图详情，再查看出处'));
        if (currentDirty()) throw new Error(t('请先保存或处理当前草稿，再查看原文出处'));
        const evidence = action.evidence;
        const { owner } = readGraphContext();
        const epoch = owner.exchangeEpoch ?? 0;
        const selectedId = selectedEpisodeRef.current;
        const { text, episode } = readGraphSource(evidence.episodeId, evidence.part);
        const targetDraft = draftsRef.current[evidence.episodeId];
        if ((targetDraft && draftSignature(targetDraft) !== draftSignature(createDraft(episode)))
          || isEpisodeEditorWriteLocked(evidence.episodeId) || hasUnsettledEpisodeEditorSession(evidence.episodeId)) {
          throw new Error(t('目标分集还有未处理的修改，请先保存后查看出处'));
        }
        const sourceHash = await hashStoryGraphSource(text);
        graphScopeGuard(epoch, selectedId);
        if (readGraphSource(evidence.episodeId, evidence.part).text !== text
          || !validateStoryGraphEvidence(evidence, { ...evidence, text, sourceHash })) throw new Error(t('原文来源已变化，请先重新绑定证据'));
        selectedEpisodeRef.current = evidence.episodeId;
        setSelectedEpisodeId(evidence.episodeId);
        setActiveTab(evidence.part);
        sourceLocationSequence.current += 1;
        setSourceLocation({ ...evidence, sequence: sourceLocationSequence.current });
        return true;
      }
      case 'story_graph_extract': return startGraphExtraction(action.request);
      case 'story_graph_editor': {
        if (typeof action.open !== 'boolean' || typeof action.graphId !== 'string'
          || !Number.isSafeInteger(action.expectedRevision) || !Number.isSafeInteger(action.epoch)) throw new Error(t('关系图版本已变化，请重新打开详情'));
        if (action.open) {
          if (afterReply.current || openingWindow) throw new Error(t('工作台窗口正在交接，请稍后打开详情'));
          const { owner, graph } = readGraphContext();
          if (typeof action.graphId !== 'string' || action.graphId !== graph.id || action.expectedRevision !== graph.revision
            || action.epoch !== (owner.exchangeEpoch ?? 0)) throw new Error(t('关系图版本已变化，请重新打开详情'));
          graphEditorLease.current = { graphId: graph.id, epoch: owner.exchangeEpoch ?? 0 };
          setGraphEditorOpen(true);
        } else {
          const lease = graphEditorLease.current;
          if (lease && (lease.graphId !== action.graphId || lease.epoch !== action.epoch)) throw new Error(t('关系图编辑会话已变化，请重新核对'));
          graphEditorLease.current = null; setGraphEditorOpen(false);
        }
        return true;
      }
      case 'story_graph_cancel': {
        if (!graphController.current || !action.runId || action.runId !== graphRunId.current) throw new Error(t('关系图提取已结束，请核对最新候选'));
        graphGeneration.current += 1;
        graphController.current?.abort(); graphController.current = null;
        setGraphExtraction((previous) => ({ status: 'cancelled', runId: previous.runId, completed: previous.completed, total: previous.total, continuation: previous.continuation }));
        return true;
      }
      case 'story_graph_discard': {
        if (graphController.current) throw new Error(t('请先取消正在执行的关系图提取'));
        if (graphCandidate.current && action.candidateId !== graphCandidate.current.id) throw new Error(t('关系图候选已变化，请重新核对'));
        graphCandidate.current = null;
        setGraphExtraction((previous) => ({ status: 'idle', runId: previous.runId, completed: 0, total: 0, continuation: previous.continuation }));
        return true;
      }
      case 'story_graph_adopt': {
        const candidate = graphCandidate.current;
        const { owner, graph } = readGraphContext();
        if (!candidate || candidate.id !== action.candidateId || candidate.seriesId !== owner.id || candidate.sessionId !== sessionId
          || candidate.graphId !== graph.id || candidate.graphRevision !== graph.revision) throw new Error(t('关系图候选已变化，请重新核对'));
        const epoch = owner.exchangeEpoch ?? 0;
        if (graphContinuation.current?.candidate.id !== candidate.id || graphContinuation.current.epoch !== epoch) throw new Error(t('关系图候选已变化，请重新核对'));
        const sourceTexts = new Map<string, string>();
        for (const binding of candidate.sourceBindings) {
          const { text } = readGraphSource(binding.episodeId, binding.part);
          if (await hashStoryGraphSource(text) !== binding.sourceHash) throw new Error(t('候选来源已变化，请重新提取'));
          sourceTexts.set(`${binding.episodeId}:${binding.part}`, text);
        }
        const patch = buildStoryGraphCandidatePatch(graph, candidate, action.selection);
        await commitGraphPatch(patch, graph.revision, () => {
          if (graphCandidate.current !== candidate || (readGraphContext().owner.exchangeEpoch ?? 0) !== epoch) throw new Error(t('关系图候选已变化，请重新核对'));
          for (const binding of candidate.sourceBindings) {
            const source = readGraphSource(binding.episodeId, binding.part);
            if (source.text !== sourceTexts.get(`${binding.episodeId}:${binding.part}`)) throw new Error(t('候选来源已变化，请重新提取'));
          }
        });
        graphCandidate.current = null;
        setGraphExtraction((previous) => ({ status: 'idle', runId: previous.runId, completed: 0, total: 0, continuation: previous.continuation }));
        return true;
      }
      case 'refresh_external_agents': { const catalog = await getExternalAgentCatalog(); setExternalCatalog(catalog); return catalog; }
      case 'edit_team_graph': return editTeamGraph(action.taskId, action.graph, action.expected);
      case 'resolve_dispatch': {
        if (!['verified_completed', 'abandoned'].includes(action.decision)) throw new Error(t('请选择明确的调用核实结果'));
        return resolveAgentDispatchOutcome(action.taskId, action.dispatchId, action.decision);
      }
      case 'save_team_profile': {
        const profile = normalizeTeamProfile(action.profile);
        if (currentEpisode?.creationProfile) {
          const episodeId = currentEpisode.id;
          const previous = currentEpisode.creationProfile;
          const previousOverride = currentEpisode.teamProfileOverride;
          const assertScope = () => { if (selectedEpisodeRef.current !== episodeId || !readEpisodeWorkspaceScope(useAppStore.getState(), episodeId)) throw new Error(t('工作台分集已变化')); };
          await captureCreationProfile(previous, episodeId);
          if (!await updateEpisodeCreative(episodeId, { teamProfileOverride: profile }, { allowSameSeries: true,
            assertCurrent: () => { assertScope(); const latest = useAppStore.getState().projects.find((entry) => entry.id === episodeId);
              if (!configValuesEqual(latest?.creationProfile, previous) || !configValuesEqual(latest?.teamProfileOverride, previousOverride)) throw new Error(t('组合包选择已变化，请重新配置')); },
            assertCommitCurrent: assertScope })) throw new Error(t('团队配置未能保存，请重试'));
        } else {
          const previous = useAppStore.getState().config.agentTeamProfile;
          updateConfig({ agentTeamProfile: profile });
          try { await useAppStore.getState().saveConfig({ silent: true, throwOnError: true }); }
          catch (error) { if (configValuesEqual(useAppStore.getState().config.agentTeamProfile, profile)) updateConfig({ agentTeamProfile: previous }); throw error; }
        }
        return true;
      }
      case 'team_artifact': return readTeamTaskArtifact(action.taskId, action.artifactId);
      case 'team_amend': return appendTeamInstruction(action.taskId, action.instruction);
      case 'team_control': {
        switch (action.action) {
          case 'pause': cancelScheduledAgentExecution(action.taskId); pauseAgentTask(action.taskId); return true;
          case 'stop': cancelScheduledAgentExecution(action.taskId); stopAgentTask(action.taskId); return true;
          case 'resume': { const result = resumeAgentTaskExecution(action.taskId); if (!result.ok) throw new Error(result.message ?? t('任务当前不能继续')); return true; }
          case 'view': return viewTeamTask(action.taskId);
          case 'apply': return mutateTeamResult(action.taskId, false);
          case 'restore': return mutateTeamResult(action.taskId, true);
          case 'reconcile': return reconcileTeamResult(action.taskId);
        }
      }
    }
  };
  useLayoutEffect(() => {
    snapshotRef.current = snapshot;
    onCloseRequestRef.current = onCloseRequest;
    actionRef.current = handleAction;
    requestRef.current = (request) => handleAction(request.action, request);
  });
  useEffect(() => {
    const host = createScriptWorkbenchWindowHost({ sessionId, getSnapshot: () => snapshotRef.current,
      onRequest: (request) => requestRef.current(request), onDetachedChange: setDetached,
      onReplySent: () => {
        const action = afterReply.current;
        if (!action) return;
        afterReply.current = null;
        if (action === 'close') setClosingWorkbench(true);
        void host.close().catch(() => {}).finally(() => { if (action === 'close') onCloseRequestRef.current(); });
      },
    });
    windowHost.current = host;
    return () => { windowHost.current = null; host.dispose(); };
  }, [sessionId]);
  useEffect(() => { void windowHost.current?.publish().catch(() => {}); });
  return !isOpen || detached || closingWorkbench ? null : <ScriptWorkbenchView snapshot={snapshot} dispatch={dispatchView} />;
}

function WorkbenchFrame({ standalone, children, ...props }: {
  standalone: boolean; isOpen: boolean; onClose: () => void; ariaLabel: string; closeOnBackdrop: boolean; className: string; children: ReactNode;
}) {
  if (standalone) return <div className="ui-dialog-surface flex h-screen w-screen flex-col overflow-hidden text-canvas-text">{children}</div>;
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
export function ScriptWorkbenchView({ snapshot, dispatch, standalone = false, externalError = '', onDismissError }: {
  snapshot: ScriptWorkbenchSnapshot; dispatch: ScriptWorkbenchDispatch; standalone?: boolean;
  externalError?: string; onDismissError?: () => void;
}) {
  const t = useT();
  const sourceEditorRef = useRef<HTMLTextAreaElement>(null);
  const locatedSourceSequence = useRef(0);
  const graphViewLease = useRef<{ graphId: string; epoch: number } | null>(null);
  const [originalToolsContainer, setOriginalToolsContainer] = useState<HTMLDivElement | null>(null);
  const [collaborationEpisodeId, setCollaborationEpisodeId] = useState<string | null>(null);
  const splitCountId = useId();
  const splitDurationId = useId();
  const [error, setError] = useState('');
  const { series, episodes, currentEpisode, activeTab, draft, isDirty, isSaving, isStartingTeam,
    contextReady, editorWriteLocked, pendingAction, splitOpen, splitSource, targetEpisodeCount,
    targetDurationSec, sourceOpen, renamingEpisodeId, extractingAssetKind, seriesAssetPreview, executionSelection,
    episodeTeamTasks } = snapshot;
  const collaborationOpen = !!collaborationEpisodeId && collaborationEpisodeId === currentEpisode?.id && contextReady;
  if (collaborationEpisodeId && (!contextReady || collaborationEpisodeId !== currentEpisode?.id)) setCollaborationEpisodeId(null);
  const isOpen = true;
  const projectLoadStatus = contextReady ? 'ready' : 'loading';
  const episodeAssetRoster = normalizeEpisodeAssetRoster(currentEpisode?.episodeAssetRoster);
  const creationToolsVisible = activeTab === 'outline' || activeTab === 'script' || activeTab === 'creative';
  const creativeActions = WORKBENCH_ACTIONS_BY_TAB[activeTab] ?? [];
  const creativeGroups = CREATIVE_ACTION_GROUPS.map((group) => ({ ...group,
    actions: group.actions.filter((action) => creativeActions.includes(action.id)),
  })).filter((group) => group.actions.length > 0);
  const extractionActions = SERIES_ASSET_EXTRACTION_ACTIONS.filter((action) => activeTab === 'script'
    || (activeTab === 'characters' && action.kind === 'character') || (activeTab === 'props' && action.kind === 'prop'));
  const splitSourceAvailable = splitSource === 'script' ? !!series?.hasScript : !!series?.hasOriginal;
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
  const openSplitDraft = () => fire({ type: 'split_draft' });
  const extractFullScriptAssets = (kind: DramaAssetKind, label: string) => report({ type: 'extract_series', kind, label });
  const setSplitSource = (value: 'script' | 'original') => fire({ type: 'set_split_source', value });
  const setTargetEpisodeCount = (value: string) => fire({ type: 'set_split_count', value });
  const setTargetDurationSec = (value: string) => fire({ type: 'set_split_duration', value });
  const sourceRemote = useMemo<SeriesSourceBrowserRemote>(() => ({
    contextKey: `${snapshot.sessionId}:${series?.id ?? ''}:${series?.exchangeEpoch ?? 0}:${series?.originalAddedAt ?? 0}`, ready: snapshot.contextReady,
    readSource: async (part, signal) => { signal.throwIfAborted(); const result = await dispatch({ type: 'read_source', part }); signal.throwIfAborted(); return result as SeriesSourceSnapshot; },
    prepareChapter: async (reference) => { await dispatch({ type: 'prepare_chapter', reference }); },
  }), [dispatch, series?.id, series?.exchangeEpoch, series?.originalAddedAt, snapshot.contextReady, snapshot.sessionId]);
  useLayoutEffect(() => {
    const location = snapshot.sourceLocation;
    const editor = sourceEditorRef.current;
    if (!location || !editor || locatedSourceSequence.current === location.sequence
      || currentEpisode?.id !== location.episodeId || activeTab !== location.part || isDirty) return;
    if (editor.value.slice(location.start, location.end) !== location.quote) return;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(location.start, location.end);
    locatedSourceSequence.current = location.sequence;
    const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 28;
    editor.scrollTop = Math.max(0, editor.value.slice(0, location.start).split('\n').length - 2) * lineHeight;
  }, [activeTab, currentEpisode?.id, isDirty, snapshot.sourceLocation]);

  return (
    <WorkbenchFrame standalone={standalone}
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
            if (activeTab === 'original') fire({ type: 'original_save' });
            else void saveDraft();
          }
        }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-2.5 py-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-indigo-500/15 text-indigo-400">
            <Icon icon="lucide:notebook-pen" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{t('剧本创作工作台')}</h2>
            <p className="truncate text-[11px] text-canvas-text-muted">
              {series?.name ?? t('当前剧集')} · {currentEpisode?.name ?? t('还没有分集')}
            </p>
          </div>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary"
            disabled={!currentEpisode || !contextReady || isSaving || isStartingTeam || editorWriteLocked}
            aria-haspopup="dialog" aria-expanded={collaborationOpen}
            onClick={() => setCollaborationEpisodeId(currentEpisode?.id ?? null)}>
            <Icon icon="lucide:users-round" className="h-3.5 w-3.5" />
            {t('Agent协作')}
          </button>
          <button
            type="button"
            onClick={() => fire({ type: 'toggle_split' })}
            className={`ui-btn ui-btn--sm ui-btn--secondary${splitOpen ? ' is-active' : ''}`}
            aria-pressed={splitOpen}
          >
            <Icon icon="lucide:wand-sparkles" className="h-3.5 w-3.5" />
            {t('AI 拆分草案')}
          </button>
          <button type="button" className="ui-btn ui-btn--sm" disabled={projectLoadStatus !== 'ready'}
            onClick={() => setSourceOpen(true)}>{t('章节浏览')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary"
            disabled={isSaving || editorWriteLocked || snapshot.openingWindow}
            onClick={() => fire({ type: standalone ? 'dock' : 'detach' })}
            aria-label={standalone ? t('收回主窗口') : t('独立窗口显示')}>
            <Icon icon={standalone ? 'lucide:panel-top-close' : 'lucide:external-link'} className="h-3.5 w-3.5" />
            {snapshot.openingWindow ? t('正在打开…') : standalone ? t('收回主窗口') : t('独立窗口')}
          </button>
          <PopupCloseButton ariaLabel={t('关闭剧本创作工作台')} onClick={requestClose} />
        </header>

        {!contextReady && <p role="status" className="ui-hint shrink-0 border-b border-canvas-border p-3">{t('画布已离开本剧集，请先回到原剧集处理工作台修改')}</p>}
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
              disabled={isSaving || editorWriteLocked || snapshot.originalWriting?.saving || snapshot.originalWriting?.generating || snapshot.originalWriting?.loading}
              onClick={() => performPendingAction(pendingAction)}
              className="h-7 rounded-md px-2.5 text-[11px] text-red-300 hover:bg-red-500/15"
            >
              {t('放弃修改')}
            </button>
            <button
              type="button"
              disabled={isSaving || snapshot.originalWriting?.saving || snapshot.originalWriting?.generating || snapshot.originalWriting?.loading}
              onClick={() => fire({ type: 'save_pending' })}
              className="h-7 rounded-md bg-amber-400/90 px-3 text-[11px] font-medium text-black
                         hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
            >
              {t('保存并继续')}
            </button>
          </div>
        ) : null}

        {splitOpen ? (
          <section className="grid shrink-0 gap-3 border-b border-border-subtle bg-[color-mix(in_srgb,var(--theme-card)_40%,transparent)] p-3
                              sm:grid-cols-[minmax(0,1fr)_120px_120px_auto] sm:items-end">
            <div className="grid gap-1">
              <span className="text-[10px] text-canvas-text-muted">{t('拆分素材')}</span>
              <Select<'script' | 'original'>
                value={splitSource}
                onChange={setSplitSource}
                options={[
                  { value: 'script', label: t('全剧剧本') },
                  { value: 'original', label: t('原著') },
                ]}
                aria-label={t('拆分素材')}
              />
            </div>
            <div className="ui-field">
              <label htmlFor={splitCountId} className="ui-label">{t('目标总集数')}</label>
              <NumberStepper
                id={splitCountId}
                aria-label={t('目标总集数')}
                min={1}
                max={100}
                value={Number.parseInt(targetEpisodeCount, 10) || 24}
                onChange={(value) => setTargetEpisodeCount(String(value))}
                disabled={!contextReady}
              />
            </div>
            <div className="ui-field">
              <label htmlFor={splitDurationId} className="ui-label">{t('单集秒数')}</label>
              <NumberStepper
                id={splitDurationId}
                aria-label={t('单集秒数')}
                min={15}
                max={600}
                value={Number.parseInt(targetDurationSec, 10) || 90}
                onChange={(value) => setTargetDurationSec(String(value))}
                disabled={!contextReady}
              />
            </div>
            <button
              type="button"
              disabled={!splitSourceAvailable}
              onClick={openSplitDraft}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-indigo-500/90 px-3
                         text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed
                         disabled:opacity-40"
            >
              <Icon icon="lucide:message-square-text" className="h-3.5 w-3.5" />
              {t('在对话中生成预览')}
            </button>
            <p className="text-[10px] text-canvas-text-muted sm:col-span-4">
              {splitSourceAvailable
                ? t('只生成可调整的分集草案，不会直接创建、覆盖或删除分集。')
                : t('请先添加所选素材，再生成拆分草案。')}
            </p>
          </section>
        ) : null}

        <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto]
                         lg:grid-cols-[190px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]
                         xl:grid-cols-[210px_minmax(0,1fr)_300px] xl:grid-rows-1">
          <aside className="min-h-0 border-b border-border-subtle p-3 lg:border-b-0 lg:border-r">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-canvas-text-secondary">{t('分集')}</span>
              <span className="text-[10px] text-canvas-text-muted">{episodes.length}</span>
            </div>
            <div className="flex max-h-28 gap-1.5 overflow-auto lg:max-h-none lg:flex-col">
              {episodes.map((episode) => {
                const active = episode.id === currentEpisode?.id;
                return (
                  <div
                    key={episode.id}
                    className={`flex w-44 shrink-0 items-center gap-1 rounded-lg border p-2 text-left transition-colors lg:w-auto ${
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
                        {episode.scriptLength > 0
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

          <section className="flex min-h-0 min-w-0 flex-col border-border-subtle xl:border-r">
            {currentEpisode ? (
              <>
                <div className="flex min-h-11 min-w-0 shrink-0 flex-nowrap items-center gap-1 overflow-x-auto border-b border-border-subtle px-3 py-1">
                  {([
                    ['outline', '本集大纲', 'lucide:list-tree'],
                    ['original', '原文', 'lucide:book-open'],
                    ['script', '本集剧本', 'lucide:scroll-text'],
                    ['creative', '创作要点', 'lucide:lightbulb'],
                    ['characters', '本集角色', 'lucide:users-round'],
                    ['props', '本集道具', 'lucide:package'],
                    ['story-graph', '故事关系图', 'lucide:network'],
                  ] as const).map(([id, label, icon]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      className={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs transition-colors ${
                        activeTab === id
                          ? 'bg-indigo-500/15 text-indigo-300'
                          : 'text-canvas-text-muted hover:bg-canvas-hover hover:text-canvas-text-secondary'
                      }`}
                    >
                      <Icon icon={icon} className="h-3.5 w-3.5" />
                      {t(label)}
                      {id === 'characters' || id === 'props' ? (
                        <span className="ui-badge">{id === 'characters' ? episodeAssetRoster.characters.length : episodeAssetRoster.props.length}</span>
                      ) : null}
                    </button>
                  ))}
                </div>

                <div className="min-h-0 flex-1 overflow-auto">
                  {snapshot.originalWriting && <section className={activeTab === 'original' ? 'h-full min-h-80 min-w-0 overflow-hidden' : 'hidden'} aria-label={t('原文')}>
                    {!series?.hasOriginal ? <p role="status" className="ui-hint p-3">{t('还没有原文，请在剧集栏添加原著文件。')}</p>
                      : <OriginalWritingEditor summary={snapshot.originalWriting} dispatch={dispatch} ready={contextReady} active={activeTab === 'original'} toolsContainer={originalToolsContainer} />}
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
                  {(activeTab === 'characters' || activeTab === 'props') && snapshot.assetPanel ? (
                      <EpisodeAssetPanel key={`${currentEpisode.id}-${activeTab}`} episodeId={currentEpisode.id}
                        kind={activeTab === 'characters' ? 'character' : 'prop'}
                        remoteHost={{ snapshot: snapshot.assetPanel, dispatchAction: async (action) => await dispatch({ type: 'asset', episodeId: currentEpisode.id,
                          kind: activeTab === 'characters' ? 'character' : 'prop', action }) as EpisodeAssetPanelActionResult }}
                        onBeforeExtract={async () => !isDirty || await saveDraft()} />
                  ) : null}
                  {activeTab === 'outline' ? (
                    <textarea
                      ref={sourceEditorRef}
                      value={draft.outline}
                      readOnly={editorWriteLocked || !contextReady}
                      onChange={(event) => setTextDraft('outline', event.target.value)}
                      spellCheck={false}
                      placeholder={t('写下本集任务、核心冲突、主要情节点和结尾卡点…')}
                      className="block h-full min-h-80 w-full resize-none bg-transparent p-4 text-[13px] leading-7
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
                      className="block h-full min-h-80 w-full resize-none bg-transparent p-4 font-mono text-[13px]
                                 leading-7 text-canvas-text outline-none placeholder:text-canvas-text-muted"
                    />
                  ) : null}
                  {activeTab === 'creative' ? (
                    <fieldset disabled={!contextReady || editorWriteLocked} className="grid gap-4 p-4 md:grid-cols-2">
                      <CreativeField
                        label={t('本集任务')}
                        value={draft.creative.task}
                        placeholder={t('这一集必须完成什么叙事推进？')}
                        onChange={(value) => setCreative('task', value)}
                        onAiAction={() => { void openFieldPolish('task', t('本集任务'), Boolean(draft.creative.task.trim())); }}
                        aiDisabled={isSaving || editorWriteLocked || executionSelection.kind === 'team' || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('核心冲突')}
                        value={draft.creative.coreConflict}
                        placeholder={t('谁与谁争夺什么，失败代价是什么？')}
                        onChange={(value) => setCreative('coreConflict', value)}
                        onAiAction={() => { void openFieldPolish('coreConflict', t('核心冲突'), Boolean(draft.creative.coreConflict.trim())); }}
                        aiDisabled={isSaving || editorWriteLocked || executionSelection.kind === 'team' || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('开场钩子')}
                        value={draft.creative.openingHook}
                        placeholder={t('开场 3-5 秒发生什么？')}
                        onChange={(value) => setCreative('openingHook', value)}
                        onAiAction={() => { void openFieldPolish('openingHook', t('开场钩子'), Boolean(draft.creative.openingHook.trim())); }}
                        aiDisabled={isSaving || editorWriteLocked || executionSelection.kind === 'team' || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('反转或情绪爆点')}
                        value={draft.creative.reversal}
                        placeholder={t('本集最强的变化是什么？')}
                        onChange={(value) => setCreative('reversal', value)}
                        onAiAction={() => { void openFieldPolish('reversal', t('反转或情绪爆点'), Boolean(draft.creative.reversal.trim())); }}
                        aiDisabled={isSaving || editorWriteLocked || executionSelection.kind === 'team' || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('结尾卡点')}
                        value={draft.creative.endingHook}
                        placeholder={t('观众必须继续看的未完成事件')}
                        onChange={(value) => setCreative('endingHook', value)}
                        onAiAction={() => { void openFieldPolish('endingHook', t('结尾卡点'), Boolean(draft.creative.endingHook.trim())); }}
                        aiDisabled={isSaving || editorWriteLocked || executionSelection.kind === 'team' || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('原著来源范围')}
                        value={draft.creative.sourceRange}
                        placeholder={t('例如：第 3 章 20%-45%')}
                        onChange={(value) => setCreative('sourceRange', value)}
                      />
                      <CreativeField
                        label={t('主要情节点（每行一条）')}
                        value={draft.creative.beats}
                        placeholder={t('建议 3-5 条，按发生顺序排列')}
                        multiline
                        onChange={(value) => setCreative('beats', value)}
                        onAiAction={() => { void openFieldPolish('beats', t('主要情节点（每行一条）'), Boolean(draft.creative.beats.trim())); }}
                        aiDisabled={isSaving || editorWriteLocked || executionSelection.kind === 'team' || projectLoadStatus !== 'ready'}
                      />
                      <CreativeField
                        label={t('目标时长（秒）')}
                        readOnly={editorWriteLocked || !contextReady}
                        numberInput={{ min: 1 }}
                        value={draft.creative.targetDurationSec}
                        placeholder="90"
                        onChange={(value) => setCreative('targetDurationSec', value)}
                      />
                    </fieldset>
                  ) : null}
                </div>

                {activeTab !== 'original' && <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-border-subtle px-3">
                  <span className={`text-[11px] ${isDirty ? 'text-amber-300' : 'text-canvas-text-muted'}`}>
                    {editorWriteLocked ? t('团队成果保存中…') : isDirty ? t('有未保存修改') : t('已保存')}
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
                  <button
                    type="button"
                    disabled={!isDirty || isSaving || editorWriteLocked || projectLoadStatus !== 'ready'}
                    onClick={() => { void saveDraft(); }}
                    className="h-8 rounded-lg bg-indigo-500/90 px-4 text-xs font-medium text-white
                               hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isSaving ? t('保存中…') : t('保存本集')}
                  </button>
                </footer>}
              </>
            ) : (
              <div className="grid min-h-80 flex-1 place-items-center p-6 text-center">
                <div>
                  <Icon icon="lucide:files" className="mx-auto h-8 w-8 text-canvas-text-muted" />
                  <p className="mt-3 text-sm font-medium">{t('还没有可编辑的分集')}</p>
                  <p className="mt-1 text-xs text-canvas-text-muted">{t('先新增分集，或使用 AI 拆分草案。')}</p>
                </div>
              </div>
            )}
          </section>

          <aside className="min-h-0 overflow-auto border-t border-border-subtle p-3
                            lg:col-span-2 lg:max-h-64 xl:col-span-1 xl:max-h-none xl:border-t-0">
            <WorkbenchContextSummary snapshot={snapshot} dispatch={report} />
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
