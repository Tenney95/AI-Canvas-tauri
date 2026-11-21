/**
 * ScriptWorkbench — 提供剧本创作工作台界面与交互。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import type { EpisodeCreativeInfo } from '../types';
import { useAppStore } from '../store/useAppStore';
import { listEpisodes, seriesOwnerId } from '../store/store.utils';
import { needsNativeEpisodeContent } from '../store/nativeProjectView';
import {
  analyzeEpisodeScript,
  buildCreativeFieldPolishPrompt,
  buildEpisodeCreativePrompt,
  buildSplitDraftPrompt,
  estimateSeriesSplitDuration,
  estimateSeriesSplitEpisodeCount,
  SPLIT_DRAFT_LIMITS,
  type CreativeFieldId,
  type EpisodeCreativeAction,
} from '../services/seriesCreativeService';
import { useT } from '../i18n';
import { createEpisodeShotlist } from '../services/shotlistService';
import { createOriginalWritingSession } from '../services/originalWritingService';
import { createOutlineDocumentSession } from '../services/outlineDocumentService';
import { createWorkbenchArticleSession } from '../services/workbenchArticleService';
import type { WorkbenchArticleCapture, WorkbenchArticleTarget } from '../types/workbenchArticle';
import type { DramaAssetKind } from '../types/dramaAssets';
import { commitSeriesAssetCandidates, extractSeriesAssetsFromFullScript, type SeriesAssetExtractionResult } from '../services/seriesAssetExtractionService';
import type { EpisodeAssetKind } from '../types/episodeAssets';
import { buildEpisodeAssetPanelSnapshot, executeEpisodeAssetPanelAction } from '../services/episodeAssetService';
import type { AgentMode } from '../types/agent';
import type { AssistantExecutionSelection, TeamTemplateId } from '../types/agentTeam';
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
import { buildChatModelCatalog, executeManagedChatOperation, projectChatNodes } from '../services/chat/detachedChatSyncController';
import { hasUnsettledEpisodeEditorSession, isEpisodeEditorWriteLocked, registerEpisodeEditorSession, settleEpisodeEditorSessions,
  subscribeEpisodeEditorWrites } from '../services/episodeEditorSessionService';
import { readEpisodeWorkspaceScope } from '../services/episodeWorkspaceScope';
import { createAppearanceUiSnapshot } from '../services/appearance/appearanceWindowSync';
import { resolveAppearanceMode } from '../services/appearance/appearanceRuntime';
import { getAppearanceForConfig } from '../services/appearance/appearanceMigration';
import { createScriptWorkbenchWindowHost, focusScriptWorkbenchWindow, type ScriptWorkbenchWindowHost } from '../services/scriptWorkbenchWindowService';
import { registerScriptWorkbenchAppClose, type ScriptWorkbenchExitTarget } from '../services/scriptWorkbenchAppClose';
import { captureProjectWindowContext, isProjectWindowContextCurrent } from '../services/projectWindowContext';
import { loadProjectAgentTasks } from '../services/chat/agentTaskService';
import { buildSeriesChapterPrompt, indexSeriesSplitMaterial, readSeriesChapter, readSeriesSource } from '../services/seriesSourceService';
import type { SeriesSourcePart } from '../types/seriesSource';
import { getSeriesSplitSkillOptions, getSeriesSplitSkillPrompt } from '../services/seriesSplitSkillService';
import type { ScriptWorkbenchAction, ScriptWorkbenchDispatch, ScriptWorkbenchRequest, ScriptWorkbenchSnapshot,
  WorkbenchCreativeDraft, WorkbenchDraft, WorkbenchEditorTab, WorkbenchPendingAction, WorkbenchSplitRequest } from '../types/scriptWorkbench';
import { resolveAssistantModel } from '../services/ai/assistantStream';
import { getAssistantTextModelCandidates } from '../services/projectSettingsService';
import { sanitizeDomainText } from '../services/chat/subAgentMaterials';
import { needsEpisodeScriptFileSync } from '../utils/manuscriptFileReference';
import WorkbenchView, { type ScriptWorkbenchViewProps, type WorkbenchPresentation } from './workbench/ScriptWorkbenchView';
import { useWorkbenchStoryGraph } from './workbench/useWorkbenchStoryGraph';

const isIntegerInRange = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

type EditorTab = WorkbenchEditorTab;
type PendingAction = WorkbenchPendingAction;
type CreativeDraft = WorkbenchCreativeDraft;
type CloseDestination = 'canvas' | 'app';
interface WorkbenchAppCloseRequest {
  id: string;
  target: ScriptWorkbenchExitTarget;
  resolve: (allowed: boolean) => void;
  restoreCanvas?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  replyId?: string;
}

// 非持久化恢复副本：宿主因切项目卸载时不把未确认丢弃的稿件当作已经放弃。
const workbenchDraftCache = new Map<string, { drafts: Record<string, WorkbenchDraft>; baselines: Record<string, string> }>();
const EMPTY_WORKBENCH_NODES: [] = [];
const WORKBENCH_ASSET_KINDS: Partial<Record<WorkbenchEditorTab, EpisodeAssetKind>> = {
  characters: 'character', scenes: 'scene', props: 'prop',
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
  return JSON.stringify([value.outline, value.script,
    ...Object.keys(EMPTY_CREATIVE_DRAFT).map((field) => value.creative[field as keyof CreativeDraft])]);
}

export default function ScriptWorkbench({
  isOpen,
  onClose: onCloseRequest,
  startWithSplit = false,
  openRequestRevision = 0,
  requestSplit = false,
  presentation = 'modal',
  visible = true,
  onSwitchToCanvas,
  onPageVisibilityChange,
  onDetachedChange,
  onReturnToProject,
  returningToProject = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  startWithSplit?: boolean;
  openRequestRevision?: number;
  requestSplit?: boolean;
  presentation?: WorkbenchPresentation;
  visible?: boolean;
  onSwitchToCanvas?: () => void;
  onPageVisibilityChange?: (visible: boolean) => void;
  onDetachedChange?: (detached: boolean) => void;
  onReturnToProject?: () => Promise<boolean>;
  returningToProject?: boolean;
}) {
  const t = useT();
  const {
    projects,
    currentProjectId,
    projectLoadStatus,
    projectExecutionContext,
    switchingProjectName,
    isCreatingProject,
    isReturningToStartPage,
    updateEpisodeCreative,
    openChatWithDraft,
    showToast,
    dramaAssets,
    config,
    workflows,
    agentTasks,
    conversations,
    activeConversationId,
    updateConfig,
    userSkills,
    agentPackageSkills,
    agentPackages,
  } = useAppStore(useShallow((state) => ({
    projects: state.projects,
    currentProjectId: state.currentProjectId,
    projectLoadStatus: state.projectLoadStatus,
    projectExecutionContext: state.projectExecutionContext,
    switchingProjectName: state.switchingProjectName,
    isCreatingProject: state.isCreatingProject,
    isReturningToStartPage: state.isReturningToStartPage,
    updateEpisodeCreative: state.updateEpisodeCreative,
    openChatWithDraft: state.openChatWithDraft,
    showToast: state.showToast,
    dramaAssets: state.dramaAssets,
    config: state.config,
    workflows: state.workflows,
    agentTasks: state.agentTasks,
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    updateConfig: state.updateConfig,
    userSkills: state.userSkills,
    agentPackageSkills: state.agentPackageSkills,
    agentPackages: state.agentPackages,
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
  const [, refreshOutlineDocuments] = useState(0);
  const [outlineDocuments] = useState(() => seriesId ? createOutlineDocumentSession({ seriesId }) : null);
  useEffect(() => outlineDocuments?.subscribe(() => refreshOutlineDocuments((version) => version + 1)), [outlineDocuments]);
  const [detached, setDetached] = useState(false);
  const [openingWindow, setOpeningWindow] = useState(false);
  const [closingWorkbench, setClosingWorkbench] = useState(false);
  const windowHost = useRef<ScriptWorkbenchWindowHost | null>(null);
  const afterReply = useRef<'close' | 'dock' | 'app-close' | null>(null);
  const pendingCloseDestination = useRef<CloseDestination>('canvas');
  const appCloseRequest = useRef<WorkbenchAppCloseRequest | null>(null);
  const prepareAppCloseRef = useRef<(target: ScriptWorkbenchExitTarget) => Promise<boolean>>(async () => false);
  const settleAppClose = useCallback((allowed: boolean) => {
    const pending = appCloseRequest.current;
    appCloseRequest.current = null;
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    if (!allowed && afterReply.current === 'app-close') afterReply.current = null;
    pending?.restoreCanvas?.();
    pending?.resolve(allowed);
  }, []);
  const acceptedEditSequenceRef = useRef(0);
  const [acceptedEditSequence, setAcceptedEditSequence] = useState(0);
  const workspaceReady = !!series && !!currentProjectId && seriesOwnerId(projects, currentProjectId) === seriesId
    && projectLoadStatus === 'ready' && !isCreatingProject && !isReturningToStartPage && switchingProjectName === null;
  const contentPending = needsNativeEpisodeContent(currentEpisode);
  const runtimeEpoch = projectExecutionContext?.runtimeEpoch;
  const [episodeReadFailure, setEpisodeReadFailure] = useState<{ episodeId: string; runtimeEpoch?: string; attempt: number }>();
  const [episodeReadAttempt, setEpisodeReadAttempt] = useState(0);
  useEffect(() => {
    if (!isOpen || !workspaceReady || !contentPending || !currentEpisodeId) return;
    let live = true;
    void useAppStore.getState().loadEpisodeCreative(currentEpisodeId).catch(() => {
      if (live) setEpisodeReadFailure({ episodeId: currentEpisodeId, runtimeEpoch, attempt: episodeReadAttempt });
    });
    return () => { live = false; };
  }, [isOpen, workspaceReady, contentPending, currentEpisodeId, runtimeEpoch, episodeReadAttempt]);
  const episodeContentLoad = workspaceReady && contentPending
    ? episodeReadFailure?.episodeId === currentEpisodeId && episodeReadFailure?.runtimeEpoch === runtimeEpoch
      && episodeReadFailure?.attempt === episodeReadAttempt ? 'error' : 'loading' : undefined;
  const contextReady = workspaceReady && !contentPending;
  const [activeTab, setActiveTab] = useState<EditorTab>('outline');
  const activeAssetKind = WORKBENCH_ASSET_KINDS[activeTab];
  const { session: graphSession, handleAction: handleStoryGraphAction, snapshot: graphSnapshot, clearSourceLocation } =
    useWorkbenchStoryGraph({
      t, isOpen, sessionId, seriesId, series, selectedEpisodeRef, currentEpisodeId, activeTab, contextReady, dramaAssets,
    });
  const [draftsByEpisode, setDraftsByEpisode] = useState<Record<string, WorkbenchDraft>>(() => seriesId ? workbenchDraftCache.get(seriesId)?.drafts ?? {} : {});
  const draftsRef = useRef<Record<string, WorkbenchDraft>>(draftsByEpisode);
  const draftBaselines = useRef<Record<string, string>>(seriesId ? workbenchDraftCache.get(seriesId)?.baselines ?? {} : {});
  const draftVersions = useRef(new Map<string, number>());
  const [draftVersionByEpisode, setDraftVersionByEpisode] = useState<Record<string, number>>({});
  const savingEpisodeRef = useRef<string | null>(null);
  const startingTeamRef = useRef(false);
  const assistantConversation = conversations.find((conversation) => conversation.id === activeConversationId
    && conversation.projectId === seriesId && !conversation.deletedAt);
  const executionSelection = normalizeExecutionSelection(assistantConversation?.executionSelection);
  const setExecutionSelection = (value: AssistantExecutionSelection) => {
    const state = useAppStore.getState();
    if (!state.currentProjectId || !seriesId || state.projectLoadStatus !== 'ready'
      || seriesOwnerId(state.projects, state.currentProjectId) !== seriesId) throw new Error(t('画布已离开本剧集，请先回到原剧集处理工作台修改'));
    const conversation = state.conversations.find((entry) => entry.id === state.activeConversationId
      && entry.projectId === seriesId && !entry.deletedAt);
    const conversationId = conversation?.id ?? state.createConversation(state.currentProjectId);
    state.updateConversation(conversationId, { executionSelection: normalizeExecutionSelection(value) });
  };
  const assistantModelProject = projects.find((project) => project.id === (assistantConversation?.workbenchTarget?.episodeId ?? currentProjectId));
  const assistantModelId = getAssistantTextModelCandidates(assistantModelProject?.settings, config.assistantModelId)[0];
  const assistantTeamProfile = useMemo(() => {
    const selection = assistantConversation?.creationProfile;
    if (selection && !config.creationProfiles?.some((profile) => profile.id === selection.id && profile.version === selection.version)) {
      return normalizeTeamProfile(config.agentTeamProfile);
    }
    try { return resolveCreationTeamProfile(selection, assistantConversation?.teamProfileOverride); }
    catch { return normalizeTeamProfile(config.agentTeamProfile); }
  }, [assistantConversation?.creationProfile, assistantConversation?.teamProfileOverride, config.agentTeamProfile, config.creationProfiles]);
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
  const splitSource: SeriesSourcePart = series?.series?.script?.trim() ? 'script' : 'original';
  const splitSkills = useMemo(() => splitOpen ? getSeriesSplitSkillOptions(userSkills, agentPackageSkills, agentPackages) : undefined,
    [splitOpen, userSkills, agentPackageSkills, agentPackages]);
  const splitPreparation = useRef<AbortController | null>(null);
  useEffect(() => () => splitPreparation.current?.abort(), [isOpen, seriesId]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [renamingEpisodeId, setRenamingEpisodeId] = useState<string | null>(null);
  const [extractingAssetKind, setExtractingAssetKind] = useState<DramaAssetKind | null>(null);
  const extractingAssetKindRef = useRef<DramaAssetKind | null>(null);
  const [seriesAssetPreview, setSeriesAssetPreview] = useState<SeriesAssetExtractionResult | null>(null);
  const extractionGeneration = useRef(0);
  useEffect(() => () => { extractionGeneration.current += 1; }, [isOpen, selectedEpisodeId, seriesId]);
  const assetSource = useAppStore(useShallow((state) => ({ projects: state.projects, currentProjectId: state.currentProjectId,
    projectLoadStatus: state.projectLoadStatus, isCreatingProject: state.isCreatingProject, isReturningToStartPage: state.isReturningToStartPage,
    switchingProjectName: state.switchingProjectName, dramaAssets: state.dramaAssets,
    globalCharacters: state.globalCharacters, globalScenes: state.globalScenes, globalProps: state.globalProps,
    nodes: activeAssetKind && selectedEpisodeId === state.currentProjectId
      ? projectChatNodes(state.nodes) : EMPTY_WORKBENCH_NODES })));

  const persistedDraft = createDraft(currentEpisode);
  const draft = currentEpisode
    ? draftsByEpisode[currentEpisode.id] ?? persistedDraft
    : persistedDraft;
  const isDirty = currentEpisode !== null
    && draftsByEpisode[currentEpisode.id] !== undefined
    && (contentPending || draftSignature(draft) !== draftSignature(persistedDraft));
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
    if (value) {
      if (!next[episodeId]) {
        const episode = useAppStore.getState().projects.find((item) => item.id === episodeId);
        draftBaselines.current[episodeId] = draftSignature(createDraft(episode ?? null));
      }
      next[episodeId] = value;
    } else {
      delete next[episodeId];
      delete draftBaselines.current[episodeId];
    }
    draftsRef.current = next;
    if (seriesId) {
      if (Object.keys(next).length) workbenchDraftCache.set(seriesId, { drafts: next, baselines: draftBaselines.current });
      else workbenchDraftCache.delete(seriesId);
    }
    const version = (draftVersions.current.get(episodeId) ?? 0) + 1;
    draftVersions.current.set(episodeId, version);
    setDraftVersionByEpisode((previous) => ({ ...previous, [episodeId]: version }));
    setDraftsByEpisode(next);
  }, [seriesId, setDraftVersionByEpisode, setDraftsByEpisode]);

  const onClose = (destination: CloseDestination = 'canvas') => {
    if (outlineDocuments?.isDirty() || outlineDocuments?.isBusy()) {
      setActiveTab('outline');
      showToast(t('请先保存大纲文件或处理未保存修改，再离开工作台'), 'error');
      return;
    }
    if (originalWriting?.isDirty() || originalWriting?.isBusy()) {
      setActiveTab('original');
      showToast(t('请先保存原文或处理未保存修改，再离开工作台'), 'error');
      return;
    }
    const episodeId = currentEpisode?.id;
    const local = episodeId ? draftsRef.current[episodeId] : undefined;
    const saved = useAppStore.getState().projects.find((item) => item.id === episodeId);
    if (episodeId && local && !needsNativeEpisodeContent(saved) && draftSignature(local) === draftSignature(createDraft(saved ?? null))) {
      replaceEpisodeDraft(episodeId, undefined);
    }
    if (destination === 'app') {
      if (detached) afterReply.current = 'app-close';
      else settleAppClose(true);
      return;
    }
    if (detached) afterReply.current = 'close';
    else onCloseRequest();
  };

  const currentDirty = () => {
    const episodeId = selectedEpisodeRef.current;
    const local = episodeId ? draftsRef.current[episodeId] : undefined;
    const saved = useAppStore.getState().projects.find((item) => item.id === episodeId);
    return !!local && (needsNativeEpisodeContent(saved) || draftSignature(local) !== draftSignature(createDraft(saved ?? null)));
  };

  useEffect(() => {
    const episodeId = currentEpisodeId;
    if (!isOpen || !episodeId) return;
    return registerEpisodeEditorSession(episodeId, () => {
      const episode = useAppStore.getState().projects.find((item) => item.id === episodeId);
      const local = draftsRef.current[episodeId];
      return { dirty: (!!local && (needsNativeEpisodeContent(episode) || draftSignature(local) !== draftSignature(createDraft(episode ?? null))))
        || graphSession.isEditing() || !!originalWriting?.isDirty() || !!outlineDocuments?.isDirty(),
        saving: savingEpisodeRef.current === episodeId || graphSession.isWriting() || !!originalWriting?.isBusy() || !!outlineDocuments?.isBusy() };
    }, () => {
      const version = draftVersions.current.get(episodeId) ?? 0;
      const releaseGraphEditor = graphSession.captureEditorRelease();
      return () => {
        if ((draftVersions.current.get(episodeId) ?? 0) === version && draftsRef.current[episodeId]) {
          replaceEpisodeDraft(episodeId, undefined);
        }
        releaseGraphEditor();
      };
    });
  }, [currentEpisodeId, isOpen, replaceEpisodeDraft, originalWriting, outlineDocuments, graphSession]);
  const analysis = analyzeEpisodeScript(draft.script, toCreativeInfo(draft.creative));

  const saveDraft = async (rebuildScriptFile = false): Promise<boolean> => {
    if (!currentEpisode || savingEpisodeRef.current || editorWriteLocked || !contextReady) return false;
    const episodeId = currentEpisode.id;
    const version = draftVersions.current.get(episodeId) ?? 0;
    const persisted = createDraft(currentEpisode);
    const savingDraft = draftsRef.current[episodeId] ?? persisted;
    const signature = draftSignature(savingDraft);
    const persistedSignature = draftSignature(persisted);
    const baseline = draftsRef.current[episodeId] ? draftBaselines.current[episodeId] : persistedSignature;
    if (rebuildScriptFile && (signature !== persistedSignature || !persisted.script.trim())) {
      showToast(t('请先保存本集修改，再重建 TXT'), 'error');
      return false;
    }
    const creativeChanged = Object.keys(EMPTY_CREATIVE_DRAFT).some((field) =>
      savingDraft.creative[field as keyof CreativeDraft] !== persisted.creative[field as keyof CreativeDraft]);
    const creative = creativeChanged ? toCreativeInfo(savingDraft.creative) : undefined;
    const syncScriptFile = !rebuildScriptFile && signature === persistedSignature && needsEpisodeScriptFileSync(currentEpisode);
    const updates = {
      ...(savingDraft.outline !== persisted.outline ? { outline: savingDraft.outline } : {}),
      ...(savingDraft.script !== persisted.script || syncScriptFile ? { script: savingDraft.script } : {}),
      ...(creativeChanged ? { creative } : {}),
    };
    savingEpisodeRef.current = episodeId;
    setIsSaving(true);
    try {
      const saved = await updateEpisodeCreative(episodeId, updates, { allowSameSeries: true,
        ...(rebuildScriptFile ? { rebuildScriptFile: true } : {}), assertCurrent: () => {
        if (selectedEpisodeRef.current !== episodeId || !readEpisodeWorkspaceScope(useAppStore.getState(), episodeId)) throw new Error(t('工作台分集或剧集已变化，请重新保存'));
        const latest = useAppStore.getState().projects.find((item) => item.id === episodeId);
        if (baseline === undefined || draftSignature(createDraft(latest ?? null)) !== baseline) {
          throw new Error(t('本集已被其他操作修改，草稿已保留；请核对后重新编辑'));
        }
      }, assertCommitCurrent: () => {
        const scope = readEpisodeWorkspaceScope(useAppStore.getState(), episodeId);
        if (!scope || scope.owner.id !== seriesId || selectedEpisodeRef.current !== episodeId) throw new Error(t('工作台分集或剧集已变化，请重新保存'));
      } });
      if (saved && rebuildScriptFile) return true;
      if (saved) {
        draftBaselines.current[episodeId] = draftSignature({ ...savingDraft, creative: creativeChanged ? toCreativeDraft(creative) : persisted.creative });
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
    } catch (error) {
      showToast(sanitizeDomainText(error instanceof Error ? error.message : t('当前草稿尚未全部保存，请核对后重试')).slice(0, 300), 'error');
      return false;
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
      const destination = pendingCloseDestination.current;
      pendingCloseDestination.current = 'canvas';
      originalWriting?.discard();
      outlineDocuments?.discard();
      onClose(destination);
      return;
    }
    selectedEpisodeRef.current = action.episodeId;
    setSelectedEpisodeId(action.episodeId);
  };

  const requestClose = (destination: CloseDestination = 'canvas') => {
    if (pendingCloseDestination.current === 'app' && appCloseRequest.current) destination = 'app';
    const blocked = () => {
      if (destination === 'app') settleAppClose(false);
      return false;
    };
    if (savingEpisodeRef.current || editorWriteLocked) {
      if (destination === 'app') showToast(t(appCloseRequest.current?.target === 'start'
        ? '请等待工作台保存完成后再返回启动页' : '请等待工作台保存完成后再关闭应用'), 'error');
      return blocked();
    }
    if (outlineDocuments?.isBusy()) {
      setActiveTab('outline');
      showToast(t('请等待大纲文件操作完成后再离开工作台'), 'error');
      return blocked();
    }
    if (originalWriting?.isBusy()) {
      setActiveTab('original');
      showToast(t('请先等待原文保存完成，或停止生成，再关闭工作台'), 'error');
      return blocked();
    }
    if (graphSession.isEditing() || graphSession.isWriting()) {
      showToast(t('请先保存或关闭关系图详情，再离开工作台'), 'error');
      setActiveTab('story-graph'); return blocked();
    }
    if (graphSession.hasPendingExtraction()) {
      showToast(t('请先取消关系图提取，或采纳、丢弃候选后关闭工作台'), 'error');
      setActiveTab('story-graph');
      return blocked();
    }
    if (currentDirty() || originalWriting?.isDirty() || outlineDocuments?.isDirty()) {
      const original = originalWriting?.summary();
      const outline = outlineDocuments?.getSummary();
      pendingOriginalVersion.current = JSON.stringify([original?.documentId, original?.revision, outline?.documentId, outline?.revision]);
      pendingCloseDestination.current = destination;
      setPendingAction({ type: 'close' }); return false;
    }
    else {
      setSeriesAssetPreview(null);
      onClose(destination);
      return true;
    }
  };

  const prepareAppClose = async (target: ScriptWorkbenchExitTarget): Promise<boolean> => {
    if (openingWindow || closingWorkbench || appCloseRequest.current) {
      showToast(t(target === 'start' ? '请等待工作台窗口操作完成后再返回启动页' : '请等待工作台窗口操作完成后再关闭应用'), 'error');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const pending: WorkbenchAppCloseRequest = { id: crypto.randomUUID(), target, resolve };
      appCloseRequest.current = pending;
      if (!detached) {
        requestClose('app');
        if (appCloseRequest.current === pending && presentation === 'page' && !visible) {
          if (target === 'start') pending.restoreCanvas = () => onPageVisibilityChange?.(false);
          onPageVisibilityChange?.(true);
        }
        return;
      }
      const host = windowHost.current;
      if (!host) { settleAppClose(false); return; }
      const unavailable = () => {
        if (appCloseRequest.current !== pending || pending.timer === undefined) return;
        showToast(t(target === 'start' ? '独立工作台未确认，已保留草稿，请处理后再返回启动页' : '独立工作台未确认，已保留草稿，请处理后再关闭应用'), 'error');
        settleAppClose(false);
      };
      // 只限制窗口握手，不限制用户确认及实际写盘的时间。
      pending.timer = setTimeout(unavailable, 10_000);
      void focusScriptWorkbenchWindow().then(() => host.publish()).catch(unavailable);
    });
  };

  const requestEpisodeSwitch = (episodeId: string) => {
    if (savingEpisodeRef.current || editorWriteLocked) return;
    if (graphSession.isEditing() || graphSession.isWriting()) { showToast(t('请先保存或关闭关系图详情，再切换分集'), 'error'); return; }
    if (episodeId === selectedEpisodeRef.current || !episodes.some((episode) => episode.id === episodeId)) return;
    setSeriesAssetPreview(null);
    if (currentDirty()) setPendingAction({ type: 'switch', episodeId });
    else { selectedEpisodeRef.current = episodeId; setSelectedEpisodeId(episodeId); setEpisodeReadAttempt((attempt) => attempt + 1); }
  };

  const startAutomaticCreativeRequest = async (content: string) => {
    if (!currentEpisode || !contextReady || startingTeamRef.current || savingEpisodeRef.current || editorWriteLocked) return;
    const episodeId = currentEpisode.id;
    const expected = captureProjectWindowContext(useAppStore.getState(), episodeId);
    startingTeamRef.current = true;
    setIsStartingTeam(true);
    try {
      if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
      if (selectedEpisodeRef.current !== episodeId || !isProjectWindowContextCurrent(expected, useAppStore.getState())) throw new Error(t('工作台分集已变化，请等待最新内容后重试'));
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
        const expected = captureProjectWindowContext(useAppStore.getState(), episodeId);
        if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
        const captured = await captureEpisodeTeamContext(episodeId, templateId === 'outline' ? 'outline' : 'script');
        if (selectedEpisodeRef.current !== episodeId || !isProjectWindowContextCurrent(expected, useAppStore.getState())) throw new Error(t('工作台分集已变化，请等待最新内容后重试'));
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
    const expected = captureProjectWindowContext(useAppStore.getState(), episodeId);
    try {
      if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
      if (useAppStore.getState().currentProjectId !== startingProjectId
        || !isProjectWindowContextCurrent(expected, useAppStore.getState())) throw new Error(t('画布上下文已变化，请重新生成分镜'));
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

  const readSplitContext = () => {
    const state = useAppStore.getState();
    const projectId = state.currentProjectId;
    const owner = state.projects.find((project) => project.id === seriesId);
    if (!isOpen || !owner || !projectId || state.projectLoadStatus !== 'ready'
      || state.isCreatingProject || state.isReturningToStartPage || state.switchingProjectName !== null
      || seriesOwnerId(state.projects, projectId) !== owner.id) throw new Error(t('当前剧集已变化'));
    return { state, projectId, owner };
  };

  const openSplitDraft = async (settings: WorkbenchSplitRequest) => {
    const limits = SPLIT_DRAFT_LIMITS;
    const invalid = () => new Error(t('拆分参数无效'));
    if (!splitOpen || splitPreparation.current || !settings || !settings.sizing
      || (settings.part !== 'script' && settings.part !== 'original')
      || typeof settings.version !== 'string' || !/^[a-f0-9]{64}$/.test(settings.version)
      || !isIntegerInRange(settings.episodeDurationSec, limits.minEpisodeDurationSec, limits.maxEpisodeDurationSec)
      || typeof settings.notes !== 'string' || settings.notes.length > limits.maxNotesCharacters
      || (settings.skillId !== undefined
        && (typeof settings.skillId !== 'string' || settings.skillId.length === 0 || settings.skillId.length > 160))
      || (settings.chapterIds !== undefined && (!Array.isArray(settings.chapterIds) || !settings.chapterIds.length
        || settings.chapterIds.some((id) => typeof id !== 'string' || !/^chapter-\d+-\d+$/.test(id))))) throw invalid();
    const { sizing, episodeDurationSec, chapterIds } = settings;
    if (sizing.kind === 'fixed') {
      if (!isIntegerInRange(sizing.count, limits.minEpisodeCount, limits.maxEpisodeCount)) throw invalid();
    } else if (sizing.kind !== 'auto'
      || !isIntegerInRange(sizing.charactersPerMinute, limits.minCharactersPerMinute, limits.maxCharactersPerMinute)
      || (sizing.totalDurationSec !== undefined && (!Number.isSafeInteger(sizing.totalDurationSec) || sizing.totalDurationSec < 1))) {
      throw invalid();
    }
    const previous = readSplitContext();
    const episodeId = selectedEpisodeRef.current;
    const expected = captureProjectWindowContext(previous.state, episodeId);
    const controller = new AbortController();
    splitPreparation.current = controller;
    try {
      const source = await readSeriesSource(previous.projectId, settings.part, controller.signal);
      controller.signal.throwIfAborted();
      const { state, owner } = readSplitContext();
      if (episodeId !== selectedEpisodeRef.current || !isProjectWindowContextCurrent(expected, state)
        || source.seriesId !== owner.id || source.version !== settings.version) {
        throw new Error(t('材料已变化，请重新读取章节后重试'));
      }
      const index = indexSeriesSplitMaterial(source);
      const selectedIds = new Set(chapterIds);
      const selected = chapterIds ? index.chapters.filter((chapter) => selectedIds.has(chapter.id)) : index.chapters;
      if (chapterIds && (selected.length !== chapterIds.length || selected.some((chapter) => !chapter.characterCount))) throw invalid();
      const characterCount = chapterIds ? selected.reduce((total, chapter) => total + chapter.characterCount, 0) : index.characterCount;
      if (!characterCount) throw new Error(t('未找到可拆分的正文'));
      const estimatedDurationSec = sizing.kind === 'auto'
        ? sizing.totalDurationSec ?? estimateSeriesSplitDuration(characterCount, sizing.charactersPerMinute)
        : undefined;
      const count = sizing.kind === 'fixed' ? sizing.count : estimateSeriesSplitEpisodeCount(estimatedDurationSec ?? 0, episodeDurationSec);
      if (!isIntegerInRange(count, limits.minEpisodeCount, limits.maxEpisodeCount)) throw invalid();
      const skillPrompt = settings.skillId ? getSeriesSplitSkillPrompt(settings.skillId) : undefined;
      if (settings.skillId && !skillPrompt) throw new Error(t('所选 Skill 无法用于拆分，请选择可读取剧集素材的 Skill'));
      const prompt = buildSplitDraftPrompt({
        seriesName: owner.name,
        source: settings.part,
        targetEpisodeCount: count,
        targetDurationSec: episodeDurationSec,
        existingEpisodeCount: listEpisodes(state.projects, owner.id).length,
        material: { seriesId: owner.id, version: source.version, chapterIds: chapterIds ? selected.map((chapter) => chapter.id) : undefined },
        chapterLabels: chapterIds ? selected.map((chapter) => `${chapter.ordinal}. ${chapter.title}`) : undefined,
        estimatedDurationSec,
        skillPrompt,
        notes: settings.notes,
      });
      if (currentDirty() || originalWriting?.isDirty()) throw new Error(t('请先保存工作台中的修改，再准备拆分草案。'));
      if (!requestClose()) return false;
      setSplitOpen(false);
      openChatWithDraft(prompt, { planConversationTitle: t('AI 分集拆分预览') });
      showToast(t('已准备拆分草案请求，不会直接创建分集'));
      return true;
    } finally {
      if (splitPreparation.current === controller) splitPreparation.current = null;
    }
  };

  const extractFullScriptAssets = async (kind: DramaAssetKind, label: string) => {
    if (!series || !currentProjectId || !contextReady || extractingAssetKindRef.current) return;
    const generation = ++extractionGeneration.current;
    const expected = captureProjectWindowContext(useAppStore.getState(), selectedEpisodeRef.current);
    extractingAssetKindRef.current = kind;
    setExtractingAssetKind(kind);
    try {
      const result = await extractSeriesAssetsFromFullScript({
        kind,
        seriesId: series.id,
        projectId: currentProjectId,
      });
      if (generation !== extractionGeneration.current || !isProjectWindowContextCurrent(expected, useAppStore.getState())) return;
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

  const readArticleTarget = (target: WorkbenchArticleTarget): WorkbenchArticleCapture => {
    const state = useAppStore.getState();
    const owner = state.projects.find((project) => project.id === seriesId);
    const episodeId = selectedEpisodeRef.current;
    const expected = captureProjectWindowContext(state, episodeId);
    const assertCurrent = () => {
      const latest = useAppStore.getState();
      if (!isOpen || !owner || !expected || !isProjectWindowContextCurrent(expected, latest)
        || latest.projectLoadStatus !== 'ready' || latest.isCreatingProject || latest.isReturningToStartPage
        || latest.switchingProjectName !== null || !latest.currentProjectId
        || seriesOwnerId(latest.projects, latest.currentProjectId) !== seriesId
        || selectedEpisodeRef.current !== episodeId || snapshotRef.current.activeTab !== activeTab) {
        throw new Error(t('文章所在的项目或编辑位置已变化，请重新选择文章'));
      }
      if (savingEpisodeRef.current || isEpisodeEditorWriteLocked(episodeId ?? undefined)) throw new Error(t('文章正在保存，请稍候'));
    };
    assertCurrent();
    const key = JSON.stringify([sessionId, expected, target]);
    if (target.kind === 'outline' || target.kind === 'script') {
      const episode = state.projects.find((project) => project.id === target.episodeId);
      if (activeTab !== target.kind || target.episodeId !== episodeId || !episode
        || (target.kind === 'outline' && outlineDocuments?.getSummary().selected)) {
        throw new Error(t('请先打开要修改的本集文章'));
      }
      const current = draftsRef.current[episode.id] ?? createDraft(episode);
      return { target, projectId: episode.id, key, label: `${episode.name} · ${t(target.kind === 'outline' ? '本集大纲' : '本集剧本')}`,
        content: current[target.kind], version: JSON.stringify([episode.updatedAt, draftVersions.current.get(episode.id) ?? 0]) };
    }
    if (target.kind === 'original') {
      const summary = originalWriting?.summary();
      if (activeTab !== 'original' || !originalWriting || !summary?.loaded || summary.documentId !== target.documentId
        || originalWriting.isBusy() || summary.error) throw new Error(t('请先载入原文并处理未同步的编辑或错误'));
      const document = originalWriting.readDraft();
      return { target, projectId: state.currentProjectId!, key, label: document.fileName, content: document.content,
        version: JSON.stringify([document.revision, document.acceptedSequence]) };
    }
    if (!('documentId' in target)) throw new Error(t('请先打开可编辑的大纲文件并处理未同步的编辑或错误'));
    const summary = outlineDocuments?.getSummary();
    if ((currentEpisode && activeTab !== 'outline') || !outlineDocuments || !summary?.selected || summary.busy || summary.error
      || summary.documentId !== target.documentId) throw new Error(t('请先打开可编辑的大纲文件并处理未同步的编辑或错误'));
    const document = outlineDocuments.readDraft();
    if (document.kind !== 'text' || document.documentId !== target.documentId) throw new Error(t('只有 Markdown 和 TXT 文章可以修改'));
    return { target, projectId: state.currentProjectId!, key, label: document.fileName, content: document.content,
      version: JSON.stringify([document.revision, document.acceptedSequence]) };
  };
  const [articleRevision, setArticleRevision] = useState({ original: 0, outlineDocument: 0 });
  const readArticleTargetRef = useRef(readArticleTarget);
  const articleApplyingRef = useRef(false);
  const applyArticleTarget = (captured: WorkbenchArticleCapture, text: string): void => {
    // 先让新稿与编辑版本同步到视图，再向独立窗口回复，避免旧编辑器抢先继续输入。
    flushSync(() => {
      const latest = readArticleTargetRef.current(captured.target);
      if (latest.key !== captured.key || latest.version !== captured.version || latest.content !== captured.content) {
        throw new Error(t('文章已变化，请重新生成，当前草稿已保留'));
      }
      const target = captured.target;
      if (target.kind === 'outline' || target.kind === 'script') {
        const episode = useAppStore.getState().projects.find((project) => project.id === target.episodeId);
        if (!episode) throw new Error(t('分集已变化，请重新打开文章'));
        replaceEpisodeDraft(episode.id, { ...(draftsRef.current[episode.id] ?? createDraft(episode)), [target.kind]: text });
        clearSourceLocation();
      } else if (target.kind === 'original') {
        originalWriting!.flush({ documentId: target.documentId, sequence: originalWriting!.summary().acceptedSequence + 1, content: text });
        setArticleRevision((previous) => ({ ...previous, original: previous.original + 1 }));
      } else {
        if (!('documentId' in target)) throw new Error(t('请先打开可编辑的大纲文件并处理未同步的编辑或错误'));
        outlineDocuments!.flush({ documentId: target.documentId, sequence: outlineDocuments!.getSummary().acceptedSequence + 1, content: text });
        setArticleRevision((previous) => ({ ...previous, outlineDocument: previous.outlineDocument + 1 }));
      }
    });
  };
  const readArticleExecution = () => {
    const state = useAppStore.getState();
    if (!contextReady || !state.currentProjectId || state.currentProjectId !== currentProjectId
      || seriesOwnerId(state.projects, state.currentProjectId) !== seriesId) throw new Error(t('画布已离开本剧集，请先回到原剧集处理工作台修改'));
    return { projectId: state.currentProjectId, conversationId: assistantConversation?.id,
      selection: executionSelection, modelId: assistantModelId, profile: assistantTeamProfile,
      mode: assistantConversation?.agentMode ?? teamMode };
  };
  const [articleAssistant] = useState(() => createWorkbenchArticleSession());
  const [, refreshArticleAssistant] = useState(0);
  useEffect(() => articleAssistant.subscribe(() => refreshArticleAssistant((version) => version + 1)), [articleAssistant]);
  useEffect(() => () => articleAssistant.cancel(), [articleAssistant]);
  const outlineDocumentId = outlineDocuments?.getSummary().documentId;
  const outlineDocumentSelected = outlineDocuments?.getSummary().selected;
  const originalDocumentId = originalWriting?.summary().documentId;
  useEffect(() => { articleAssistant.cancel(); }, [articleAssistant, contextReady, currentEpisodeId, activeTab, series?.exchangeEpoch,
    outlineDocumentId, outlineDocumentSelected, originalDocumentId]);

  const snapshot: ScriptWorkbenchSnapshot = {
    schemaVersion: 2, windowContext: captureProjectWindowContext(useAppStore.getState(), currentEpisodeId),
    sessionId, revision: 0, acceptedEditSequence,
    draftVersion: currentEpisodeId ? draftVersionByEpisode[currentEpisodeId] ?? 0 : 0,
    series: series ? { id: series.id, name: series.name, hasScript: !!series.series?.script?.trim(), hasOriginal: !!series.series?.originalWork,
      originalAddedAt: series.series?.originalWork?.addedAt, updatedAt: series.updatedAt, exchangeEpoch: series.exchangeEpoch ?? 0 } : null,
    episodes: episodes.map((episode) => ({ id: episode.id, name: episode.name, scriptLength: episode.episodeScript?.length ?? 0,
      hasOutline: !!episode.episodeOutline?.trim(), ...(needsNativeEpisodeContent(episode) ? { contentPending: true } : {}) })),
    currentEpisode: currentEpisode ? { id: currentEpisode.id, parentId: currentEpisode.parentId, name: currentEpisode.name,
      episodeOutline: currentEpisode.episodeOutline, episodeScript: currentEpisode.episodeScript, episodeScriptFile: currentEpisode.episodeScriptFile,
      episodeCreative: currentEpisode.episodeCreative, episodeAssetRoster: currentEpisode.episodeAssetRoster,
      creationProfile: currentEpisode.creationProfile, teamProfileOverride: currentEpisode.teamProfileOverride } : null,
    canvasProjectId: currentProjectId, activeTab, draft, analysis, isDirty, isSaving, isStartingTeam,
    contextReady, episodeContentLoad, editorWriteLocked, unsettledEditor, pendingAction, splitOpen, splitSource,
    splitSkills, sourceOpen, renamingEpisodeId, extractingAssetKind,
    seriesAssetPreview: seriesAssetPreview && contextReady ? { kind: seriesAssetPreview.kind, assets: seriesAssetPreview.assets } : null,
    existingAssets: (seriesAssetPreview?.kind === 'character' ? dramaAssets.characters : seriesAssetPreview?.kind === 'scene' ? dramaAssets.scenes : dramaAssets.props)
      .map((asset) => ({ name: asset.name, summary: asset.summary })),
    assetPanel: currentEpisode && activeAssetKind ? buildEpisodeAssetPanelSnapshot(assetSource, currentEpisode.id) : undefined,
    executionSelection, teamMode, teamProfile, modelGroups: modelCatalog.assistantModelGroups, episodeTeamTasks, episodeAgentTasks,
    assistantConversationId: assistantConversation?.id, assistantModelId,
    assistantModelDisabled: !!assistantConversation?.workbenchTarget, assistantTeamProfile, performanceMode: config.performanceMode === true,
    creationProfiles: creationProfileOptions(), externalAgents: externalCatalog,
    ...graphSnapshot,
    originalWriting: originalWriting?.summary(),
    outlineDocuments: outlineDocuments?.getSummary(),
    articleAssistant: articleAssistant.summary(), articleRevision,
    theme: resolveAppearanceMode(config.appearance?.mode ?? config.theme), language: config.language,
    appearance: createAppearanceUiSnapshot(config.appearance ?? getAppearanceForConfig(config)),
    detached, openingWindow,
  };
  const snapshotRef = useRef(snapshot);
  const requestRef = useRef<(request: ScriptWorkbenchRequest) => Promise<unknown>>(async () => undefined);
  const actionRef = useRef<(action: ScriptWorkbenchAction, request?: ScriptWorkbenchRequest) => Promise<unknown>>(async () => undefined);
  const onCloseRequestRef = useRef(onCloseRequest);
  const onPageVisibilityChangeRef = useRef(onPageVisibilityChange);
  const onDetachedChangeRef = useRef(onDetachedChange);
  const dispatchView = useCallback<ScriptWorkbenchDispatch>((action) => actionRef.current(action), []);

  const handleAction = async (action: ScriptWorkbenchAction, request?: ScriptWorkbenchRequest): Promise<unknown> => {
    if (articleApplyingRef.current) throw new Error(t('正在采用文章修改，请稍候'));
    if (request) {
      if (request.outlineHandoff && !(action.type === 'outline_reload' && action.discard)) {
        try { outlineDocuments?.flush(request.outlineHandoff); }
        catch (error) { if (action.type !== 'discard_pending') throw error; }
      }
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
    const uiOnly = ['flush_draft', 'close', 'dock', 'detach', 'cancel_pending', 'discard_pending', 'close_source', 'close_split', 'close_rename', 'close_asset_preview', 'story_graph_cancel', 'story_graph_discard', 'story_graph_editor', 'original_edit', 'original_cancel', 'original_discard_candidate', 'outline_edit', 'article_cancel', 'article_discard_candidate'];
    if (episodeContentLoad && action.type === 'select_episode') { articleAssistant.cancel(); return requestEpisodeSwitch(action.episodeId); }
    if (episodeContentLoad && action.type === 'reload_episode') { setEpisodeReadAttempt((attempt) => attempt + 1); return true; }
    if (!contextReady && !uiOnly.includes(action.type)) throw new Error(t('画布已离开本剧集，请先回到原剧集处理工作台修改'));
    if (action.type.startsWith('article_')) {
      if (action.type === 'article_apply') {
        articleApplyingRef.current = true;
        try { return await articleAssistant.handle(action); }
        finally { articleApplyingRef.current = false; }
      }
      return articleAssistant.handle(action as Parameters<typeof articleAssistant.handle>[0]);
    }
    if ((action.type === 'set_tab' && action.tab !== activeTab)
      || (action.type === 'select_episode' && action.episodeId !== selectedEpisodeRef.current)
      || (action.type === 'outline_trash' && action.file?.id === outlineDocuments?.getSummary().fileId)
      || ['outline_open', 'outline_create', 'outline_select_builtin', 'outline_reload', 'original_reload'].includes(action.type)) articleAssistant.cancel();
    if (action.type.startsWith('outline_')) {
      if (!outlineDocuments) throw new Error(t('当前没有可编辑的大纲文件'));
      return outlineDocuments.handle(action as Parameters<typeof outlineDocuments.handle>[0]);
    }
    if (action.type.startsWith('original_')) {
      if (!originalWriting) throw new Error(t('当前没有可编辑的原著文件'));
      // 所有原文读取、保存和生成仍由主窗口执行；快照只发布状态与统计。
      return originalWriting.handle(action as Parameters<typeof originalWriting.handle>[0]);
    }
    if (pendingAction?.type === 'close' && (action.type === 'discard_pending' || action.type === 'save_pending')) {
      if (outlineDocuments?.isBusy()) throw new Error(t('请等待大纲文件操作完成后再离开工作台'));
      if (originalWriting?.isBusy()) throw new Error(t('请先等待原文保存完成，或停止生成，再关闭工作台'));
      const original = originalWriting?.summary();
      const outline = outlineDocuments?.getSummary();
      const version = JSON.stringify([original?.documentId, original?.revision, outline?.documentId, outline?.revision]);
      if (version !== pendingOriginalVersion.current) {
        pendingOriginalVersion.current = version;
        throw new Error(t('文档在确认期间有新修改，请核对当前草稿后重试'));
      }
    }
    if ('taskId' in action && !(action.type === 'view_agent_task' ? episodeAgentTasks : episodeTeamTasks)
      .some((task) => task.id === action.taskId)) throw new Error(t('任务不属于当前分集'));
    switch (action.type) {
      case 'flush_draft': return true;
      case 'edit_text': if ((action.field === 'outline' || action.field === 'script') && typeof action.value === 'string') { clearSourceLocation(); setTextDraft(action.field, action.value); } return true;
      case 'edit_creative': if (Object.hasOwn(EMPTY_CREATIVE_DRAFT, action.field) && typeof action.value === 'string') setCreative(action.field, action.value); return true;
      case 'select_episode': requestEpisodeSwitch(action.episodeId); return true;
      case 'set_tab': {
        if (action.tab !== 'story-graph' && (graphSession.isEditing() || graphSession.isWriting())) throw new Error(t('请先保存或关闭关系图详情，再切换页签'));
        if (['outline', 'original', 'script', 'creative', 'characters', 'scenes', 'props', 'story-graph'].includes(action.tab)) setActiveTab(action.tab);
        return true;
      }
      case 'save': {
        const rebuildScriptFile = action.rebuildScriptFile === true;
        if (!await saveDraft(rebuildScriptFile)) throw new Error(t(rebuildScriptFile ? 'TXT 未重建，请核对后重试' : '当前草稿尚未全部保存，请核对后重试'));
        if (rebuildScriptFile) showToast(t('已用本集正文重建 TXT'));
        return true;
      }
      case 'close': {
        if (action.appCloseRequestId === undefined) return requestClose();
        const pending = appCloseRequest.current;
        if (!request || !pending || pending.id !== action.appCloseRequestId || pending.timer === undefined) return false;
        clearTimeout(pending.timer); pending.timer = undefined;
        pending.replyId = request.requestId;
        return requestClose('app');
      }
      case 'dock':
        articleAssistant.cancel();
        if (outlineDocuments?.isBusy()) throw new Error(t('请等待大纲文件操作完成后再切换窗口'));
        if (originalWriting?.isBusy()) throw new Error(t('请先等待原文保存完成，或停止生成，再切换窗口'));
        if (graphSession.isEditing() || graphSession.isWriting()) throw new Error(t('请先保存或关闭关系图详情，再切换窗口'));
        afterReply.current = 'dock'; return true;
      case 'detach': {
        articleAssistant.cancel();
        if (outlineDocuments?.isBusy()) throw new Error(t('请等待大纲文件操作完成后再切换窗口'));
        if (originalWriting?.isBusy()) throw new Error(t('请先等待原文保存完成，或停止生成，再切换窗口'));
        if (graphSession.isEditing() || graphSession.isWriting()) throw new Error(t('请先保存或关闭关系图详情，再切换窗口'));
        if (openingWindow) return false;
        setOpeningWindow(true);
        try {
          await windowHost.current?.open();
          if (presentation === 'page') onPageVisibilityChange?.(false);
          return true;
        }
        finally { setOpeningWindow(false); }
      }
      case 'cancel_pending':
        if (pendingCloseDestination.current === 'app') settleAppClose(false);
        pendingCloseDestination.current = 'canvas'; setPendingAction(null); return true;
      case 'discard_pending':
        if (pendingAction) {
          if (appCloseRequest.current) appCloseRequest.current.replyId = request?.requestId;
          performPendingAction(pendingAction);
        }
        return true;
      case 'save_pending': {
        if (!pendingAction) return false;
        const appRequest = pendingCloseDestination.current === 'app' ? appCloseRequest.current : null;
        const appCloseCancelled = () => !!appRequest && appCloseRequest.current !== appRequest;
        if (pendingAction.type === 'close' && outlineDocuments?.isDirty()) {
          await outlineDocuments.handle({ type: 'outline_save' });
          if (appCloseCancelled()) return false;
          if (outlineDocuments.isDirty()) throw new Error(t('大纲文件保存期间有新修改，草稿已保留，请重新保存'));
        }
        if (pendingAction.type === 'close' && originalWriting?.isDirty()) {
          await originalWriting.handle({ type: 'original_save' });
          if (appCloseCancelled()) return false;
          if (originalWriting.isDirty()) throw new Error(t('原文保存期间有新修改，草稿已保留，请重新保存'));
        }
        if (currentDirty() && !await saveDraft()) throw new Error(t('当前草稿尚未全部保存，请核对后重试'));
        if (appCloseCancelled()) return false;
        if (pendingCloseDestination.current === 'app' && (outlineDocuments?.isDirty() || originalWriting?.isDirty() || currentDirty())) {
          throw new Error(t('文档在确认期间有新修改，请核对当前草稿后重试'));
        }
        if (appCloseRequest.current) appCloseRequest.current.replyId = request?.requestId;
        performPendingAction(pendingAction); return true;
      }
      case 'open_split': setSplitOpen(true); return true;
      case 'close_split': splitPreparation.current?.abort(); setSplitOpen(false); return true;
      case 'read_split_material': {
        const { state, projectId, owner } = readSplitContext();
        const expected = captureProjectWindowContext(state, selectedEpisodeRef.current);
        const source = await readSeriesSource(projectId, action.part, new AbortController().signal);
        const current = readSplitContext();
        if (current.owner.id !== owner.id || !isProjectWindowContextCurrent(expected, current.state)) {
          throw new Error(t('材料已变化，请重新读取章节后重试'));
        }
        return indexSeriesSplitMaterial(source);
      }
      case 'split_skill_import': {
        const skill = await useAppStore.getState().uploadSkill('file');
        if (!skill) return null;
        if (!getSeriesSplitSkillPrompt(skill.id)) throw new Error(t('所选 Skill 无法用于拆分，请选择可读取剧集素材的 Skill'));
        return skill.id;
      }
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
      case 'split_draft': return openSplitDraft(action.settings);
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
      case 'settle_editor': if (currentEpisode && !currentDirty() && !savingEpisodeRef.current && !graphSession.isEditing()) settleEpisodeEditorSessions(currentEpisode.id); return true;
      case 'set_execution': setExecutionSelection(normalizeExecutionSelection(action.value)); return true;
      case 'select_assistant_model': {
        if (articleAssistant.isBusy() || assistantConversation?.workbenchTarget) throw new Error(t('请等待当前操作完成，并先处理文章的编辑错误。'));
        const state = useAppStore.getState();
        const project = state.projects.find((entry) => entry.id === state.currentProjectId);
        if (!project || typeof action.modelId !== 'string' || !modelCatalog.assistantModelGroups.some((group) => group.models.some((model) => model.value === action.modelId))
          || !resolveAssistantModel(project.id, action.modelId)) throw new Error(t('请选择可用的文本模型'));
        if (!await state.updateProjectSettings({ ...project.settings,
          defaultModels: { ...project.settings?.defaultModels, text: action.modelId } })) throw new Error(t('项目设置保存失败'));
        return true;
      }
      case 'save_assistant_team_profile': {
        if (articleAssistant.isBusy()) throw new Error(t('请等待当前操作完成，并先处理文章的编辑错误。'));
        await executeManagedChatOperation({ kind: 'save_team_profile', profile: normalizeTeamProfile(action.profile) },
          currentProjectId!, assistantConversation?.id);
        return true;
      }
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
      case 'story_graph_filter':
      case 'story_graph_detail':
      case 'story_graph_patch':
      case 'story_graph_resolve_evidence':
      case 'story_graph_locate':
      case 'story_graph_extract':
      case 'story_graph_editor':
      case 'story_graph_cancel':
      case 'story_graph_discard':
      case 'story_graph_adopt':
        return handleStoryGraphAction(action, {
          hasDraftChanges: (episode) => {
            const local = draftsRef.current[episode.id];
            return !!local && draftSignature(local) !== draftSignature(createDraft(episode));
          },
          currentDraftIsDirty: currentDirty,
          windowHandoffPending: () => !!afterReply.current || openingWindow,
          selectBuiltinOutline: () => outlineDocuments?.handle({ type: 'outline_select_builtin' }),
          revealSource: (episodeId, part) => {
            selectedEpisodeRef.current = episodeId;
            setSelectedEpisodeId(episodeId);
            setActiveTab(part);
          },
        });
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
    readArticleTargetRef.current = readArticleTarget;
    articleAssistant.setTargetAccess({ readTarget: readArticleTarget, applyTarget: applyArticleTarget, getExecution: readArticleExecution });
    snapshotRef.current = snapshot;
    onCloseRequestRef.current = onCloseRequest;
    onPageVisibilityChangeRef.current = onPageVisibilityChange;
    onDetachedChangeRef.current = onDetachedChange;
    actionRef.current = handleAction;
    requestRef.current = (request) => handleAction(request.action, request);
    prepareAppCloseRef.current = prepareAppClose;
  });
  useEffect(() => {
    if (!isOpen) return;
    const unregister = registerScriptWorkbenchAppClose((target) => prepareAppCloseRef.current(target));
    return () => { unregister(); settleAppClose(false); };
  }, [isOpen, settleAppClose]);
  useEffect(() => {
    const host = createScriptWorkbenchWindowHost({ sessionId, getSnapshot: () => {
      const pending = appCloseRequest.current;
      return pending?.timer === undefined ? snapshotRef.current : { ...snapshotRef.current, appCloseRequestId: pending.id };
    },
      getContext: () => captureProjectWindowContext(useAppStore.getState(), selectedEpisodeRef.current),
      onRequest: (request) => requestRef.current(request), onDetachedChange: (next) => {
        setDetached(next);
        onDetachedChangeRef.current?.(next);
        if (!next && afterReply.current !== 'app-close') settleAppClose(false);
      },
      onReplySent: (request) => {
        const action = afterReply.current;
        if (!action) return;
        if (action === 'app-close') {
          const pending = appCloseRequest.current;
          if (!pending || pending.replyId !== request.requestId) return;
          pending.replyId = undefined;
          setClosingWorkbench(true);
          void host.close().then(() => { settleAppClose(true); onCloseRequestRef.current(); }).catch(() => {
            setClosingWorkbench(false);
            settleAppClose(false);
          }).finally(() => { afterReply.current = null; });
          return;
        }
        afterReply.current = null;
        if (action === 'close') setClosingWorkbench(true);
        void host.close().catch(() => {}).finally(() => {
          if (action === 'close') onCloseRequestRef.current();
          else if (action === 'dock') onPageVisibilityChangeRef.current?.(true);
        });
      },
    });
    windowHost.current = host;
    return () => { windowHost.current = null; host.dispose(); };
  }, [sessionId, settleAppClose]);
  useEffect(() => { void windowHost.current?.publish().catch(() => {}); });
  useEffect(() => {
    if (presentation !== 'page' || !visible || !isOpen || detached || closingWorkbench) return;
    const save = () => {
      const current = snapshotRef.current;
      const fileVisible = (!current.currentEpisode || current.activeTab === 'outline') && current.outlineDocuments?.selected;
      if (fileVisible
        && !/\.(md|txt)$/i.test(current.outlineDocuments?.fileName ?? '')) return;
      const action: ScriptWorkbenchAction = fileVisible ? { type: 'outline_save' }
        : current.activeTab === 'original' ? { type: 'original_save' } : { type: 'save' };
      void actionRef.current(action).catch((error: unknown) => showToast(error instanceof Error ? error.message : t('工作台操作未完成'), 'error'));
    };
    window.addEventListener('script-workbench-save', save);
    return () => window.removeEventListener('script-workbench-save', save);
  }, [presentation, visible, isOpen, detached, closingWorkbench, showToast, t]);
  return !isOpen || detached || closingWorkbench ? null : <ScriptWorkbenchView snapshot={snapshot} dispatch={dispatchView}
    presentation={presentation} visible={visible} onSwitchToCanvas={onSwitchToCanvas}
    onBackToStartPage={() => { void useAppStore.getState().returnToStartPage(); }}
    onReturnToProject={onReturnToProject} returningToProject={returningToProject} />;
}

export function ScriptWorkbenchView(props: ScriptWorkbenchViewProps) {
  return <WorkbenchView {...props} activeAssetKind={WORKBENCH_ASSET_KINDS[props.snapshot.activeTab]} />;
}
