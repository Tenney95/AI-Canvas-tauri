/**
 * ScriptWorkbench — 提供剧本创作工作台界面与交互。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import EpisodeNameDialog from './shared/EpisodeNameDialog';
import Select from './shared/Select';
import { createEpisodeShotlist } from '../services/shotlistService';
import SeriesSourceBrowser from './SeriesSourceBrowser';
import type { DramaAssetKind } from '../types/dramaAssets';
import { commitSeriesAssetCandidates, extractSeriesAssetsFromFullScript, type SeriesAssetExtractionResult } from '../services/seriesAssetExtractionService';
import { normalizeEpisodeAssetRoster } from '../types/episodeAssets';
import EpisodeAssetPanel from './series/EpisodeAssetPanel';
import AssetExtractionPreviewDialog from './series/AssetExtractionPreviewDialog';
import type { AgentMode } from '../types/agent';
import type { AssistantExecutionSelection, TeamTemplateId } from '../types/agentTeam';
import TeamExecutionPicker from './shared/agentTeams/TeamExecutionPicker';
import TeamRunCard from './shared/agentTeams/TeamRunCard';
import { normalizeTeamProfile } from '../services/chat/teams/teamProfileService';
import { appendTeamInstruction, startTeamInvocation, openTeamTaskInAssistant, readTeamTaskArtifact } from '../services/chat/teams/teamInvocationService';
import { captureEpisodeTeamContext, applyTeamResult, restoreTeamResult, reconcileTeamResult } from '../services/chat/teams/teamResultApplyService';
import { pauseAgentTask, stopAgentTask } from '../services/chat/agentTaskControl';
import { cancelScheduledAgentExecution } from '../services/chat/agentScheduler';
import { resumeAgentTaskExecution } from '../services/chat/conversationExecutionController';
import { buildChatModelCatalog } from '../services/chat/detachedChatSyncController';
import { hasUnsettledEpisodeEditorSession, isEpisodeEditorWriteLocked, registerEpisodeEditorSession, settleEpisodeEditorSessions,
  subscribeEpisodeEditorWrites } from '../services/episodeEditorSessionService';

type EditorTab = 'outline' | 'script' | 'creative' | 'characters' | 'props';
type PendingAction = { type: 'close' } | { type: 'switch'; episodeId: string };

interface CreativeDraft {
  task: string;
  coreConflict: string;
  openingHook: string;
  reversal: string;
  endingHook: string;
  beats: string;
  targetDurationSec: string;
  sourceRange: string;
}

interface WorkbenchDraft {
  outline: string;
  script: string;
  creative: CreativeDraft;
}

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

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-canvas-border bg-canvas-card px-2.5 py-2">
      <p className="truncate text-[10px] text-canvas-text-muted">{label}</p>
      <p className="mt-0.5 truncate text-xs font-semibold text-canvas-text">{value}</p>
    </div>
  );
}

function CreativeField({
  label,
  value,
  placeholder,
  multiline = false,
  onChange,
  onAiAction,
  aiDisabled = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
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
      {multiline ? (
        <textarea
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`${fieldClass} min-h-24 resize-y py-2.5 leading-relaxed`}
        />
      ) : (
        <input
          id={inputId}
          value={value}
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
}: {
  isOpen: boolean;
  onClose: () => void;
  startWithSplit?: boolean;
}) {
  const t = useT();
  const {
    projects,
    currentProjectId,
    projectLoadStatus,
    switchProject,
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
    switchProject: state.switchProject,
    updateEpisodeCreative: state.updateEpisodeCreative,
    openChatWithDraft: state.openChatWithDraft,
    showToast: state.showToast,
    dramaAssets: state.dramaAssets,
    config: state.config,
    workflows: state.workflows,
    agentTasks: state.agentTasks,
    updateConfig: state.updateConfig,
  })));

  const seriesId = currentProjectId ? seriesOwnerId(projects, currentProjectId) : null;
  const series = projects.find((project) => project.id === seriesId) ?? null;
  const episodes = useMemo(
    () => (seriesId ? listEpisodes(projects, seriesId) : []),
    [projects, seriesId],
  );
  const currentEpisode = episodes.find((episode) => episode.id === currentProjectId)
    ?? episodes[0]
    ?? null;
  const [activeTab, setActiveTab] = useState<EditorTab>('outline');
  const [draftsByEpisode, setDraftsByEpisode] = useState<Record<string, WorkbenchDraft>>({});
  const draftsRef = useRef<Record<string, WorkbenchDraft>>({});
  const draftVersions = useRef(new Map<string, number>());
  const savingEpisodeRef = useRef<string | null>(null);
  const startingTeamRef = useRef(false);
  const teamControlsRef = useRef<HTMLDivElement>(null);
  const [executionSelection, setExecutionSelection] = useState<AssistantExecutionSelection>({ kind: 'single' });
  const [teamMode, setTeamMode] = useState<AgentMode>('collaborative');
  const [isStartingTeam, setIsStartingTeam] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [splitOpen, setSplitOpen] = useState(startWithSplit);
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
  useEffect(() => () => { extractionGeneration.current += 1; }, [isOpen, currentProjectId]);
  const episodeAssetRoster = useMemo(
    () => normalizeEpisodeAssetRoster(currentEpisode?.episodeAssetRoster),
    [currentEpisode?.episodeAssetRoster],
  );
  const splitSourceAvailable = splitSource === 'script'
    ? Boolean(series?.series?.script?.trim())
    : Boolean(series?.series?.originalWork);

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
  const teamProfile = useMemo(() => normalizeTeamProfile(config.agentTeamProfile), [config.agentTeamProfile]);
  const modelCatalog = useMemo(() => buildChatModelCatalog({ config, workflows }), [config, workflows]);
  const episodeTeamTasks = useMemo(() => currentEpisode
    ? agentTasks.filter((task) => task.teamRun?.target?.episodeId === currentEpisode.id)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
    : [], [agentTasks, currentEpisode]);

  const replaceEpisodeDraft = useCallback((episodeId: string, value: WorkbenchDraft | undefined) => {
    const next = { ...draftsRef.current };
    if (value) next[episodeId] = value;
    else delete next[episodeId];
    draftsRef.current = next;
    draftVersions.current.set(episodeId, (draftVersions.current.get(episodeId) ?? 0) + 1);
    setDraftsByEpisode(next);
  }, []);

  const onClose = () => {
    const episodeId = currentEpisode?.id;
    const local = episodeId ? draftsRef.current[episodeId] : undefined;
    const saved = useAppStore.getState().projects.find((item) => item.id === episodeId);
    if (episodeId && local && draftSignature(local) === draftSignature(createDraft(saved ?? null))) {
      replaceEpisodeDraft(episodeId, undefined);
    }
    onCloseRequest();
  };

  useEffect(() => {
    const episodeId = currentEpisode?.id;
    if (!isOpen || !episodeId) return;
    return registerEpisodeEditorSession(episodeId, () => {
      const episode = useAppStore.getState().projects.find((item) => item.id === episodeId);
      const local = draftsRef.current[episodeId];
      return { dirty: !!local && draftSignature(local) !== draftSignature(createDraft(episode ?? null)),
        saving: savingEpisodeRef.current === episodeId };
    }, () => {
      const version = draftVersions.current.get(episodeId) ?? 0;
      return () => {
        if ((draftVersions.current.get(episodeId) ?? 0) === version && draftsRef.current[episodeId]) {
          replaceEpisodeDraft(episodeId, undefined);
        }
      };
    });
  }, [currentEpisode?.id, isOpen, replaceEpisodeDraft]);
  const analysis = useMemo(
    () => analyzeEpisodeScript(draft.script, toCreativeInfo(draft.creative)),
    [draft.creative, draft.script],
  );

  const saveDraft = async (): Promise<boolean> => {
    if (!currentEpisode || savingEpisodeRef.current || editorWriteLocked || projectLoadStatus !== 'ready') return false;
    const episodeId = currentEpisode.id;
    const startingProjectId = useAppStore.getState().currentProjectId;
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
      });
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
      return saved && useAppStore.getState().currentProjectId === startingProjectId;
    } finally {
      savingEpisodeRef.current = null;
      setIsSaving(false);
    }
  };

  const performPendingAction = (action: PendingAction) => {
    if (savingEpisodeRef.current || isEpisodeEditorWriteLocked(currentEpisode?.id)) return;
    setPendingAction(null);
    setSeriesAssetPreview(null);
    if (currentEpisode) {
      replaceEpisodeDraft(currentEpisode.id, undefined);
      settleEpisodeEditorSessions(currentEpisode.id);
    }
    if (action.type === 'close') {
      onClose();
      return;
    }
    void switchProject(action.episodeId);
  };

  const requestClose = () => {
    if (savingEpisodeRef.current || editorWriteLocked) return;
    if (isDirty) setPendingAction({ type: 'close' });
    else {
      setSeriesAssetPreview(null);
      onClose();
    }
  };

  const requestEpisodeSwitch = (episodeId: string) => {
    if (savingEpisodeRef.current || editorWriteLocked) return;
    if (episodeId === currentProjectId) return;
    setSeriesAssetPreview(null);
    if (isDirty) setPendingAction({ type: 'switch', episodeId });
    else void switchProject(episodeId);
  };

  const openCreativeAction = async (action: EpisodeCreativeAction) => {
    if (!series || !currentEpisode) return;
    if (executionSelection.kind === 'team') {
      const templateId: TeamTemplateId | undefined = action === 'optimize-outline' ? 'outline'
        : action === 'write-script' ? 'script' : action === 'diagnose' ? 'review' : undefined;
      if (!templateId) { showToast(t('这个创作动作暂用单模型，请切换执行方式')); return; }
      if (startingTeamRef.current || savingEpisodeRef.current || editorWriteLocked) return;
      startingTeamRef.current = true;
      setIsStartingTeam(true);
      try {
        const episodeId = currentEpisode.id;
        if (isDirty && !await saveDraft()) return;
        const captured = await captureEpisodeTeamContext(episodeId, templateId === 'outline' ? 'outline' : 'script');
        setExecutionSelection({ kind: 'team', templateId });
        await startTeamInvocation({ projectId: episodeId, mode: teamMode, templateId,
          content: templateId === 'outline' ? t('优化本集大纲，保留已确认设定与有效结构，只返回本集候选。')
            : templateId === 'script' ? t('根据已保存的大纲与创作要点写出本集完整剧本，保留人物设定并检查可拍性。')
              : t('联合审阅本集剧本的因果、人物连续性、对白与可拍性，只返回定位问题和裁决，不改写正文。'),
          ...captured, profile: teamProfile });
        showToast(t('团队任务已开始，可在工作台或助手查看同一任务'));
      } catch (error) {
        showToast(error instanceof Error ? error.message : t('团队任务启动失败'), 'error');
      } finally {
        startingTeamRef.current = false;
        setIsStartingTeam(false);
      }
      return;
    }
    if (isDirty && !await saveDraft()) return;
    openChatWithDraft(buildEpisodeCreativePrompt(action, {
      seriesName: series.name,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
    }));
    showToast(t('已把创作请求放入对话输入框'));
  };

  const openEpisodeShotlist = async () => {
    if (!currentEpisode || isSaving || projectLoadStatus !== 'ready') return;
    const startingProjectId = useAppStore.getState().currentProjectId;
    const episodeId = currentEpisode.id;
    try {
      if (isDirty && !await saveDraft()) return;
      if (useAppStore.getState().currentProjectId !== startingProjectId) return;
      if (startingProjectId !== episodeId) await switchProject(episodeId);
      const state = useAppStore.getState();
      const { shotlistId } = createEpisodeShotlist({ projectId: episodeId, baseRevision: state.getCurrentRevision() }, episodeId);
      onClose();
      window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId: shotlistId } }));
      useAppStore.getState().openNodeDialog(shotlistId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('创建本集分镜失败'), 'error');
    }
  };

  const openFieldPolish = async (field: CreativeFieldId, label: string, hasValue: boolean) => {
    if (!series || !currentEpisode) return;
    if (isDirty && !await saveDraft()) return;
    openChatWithDraft(buildCreativeFieldPolishPrompt(field, {
      seriesName: series.name,
      episodeId: currentEpisode.id,
      episodeName: currentEpisode.name,
    }, hasValue));
    showToast(t('已准备{name}的 AI 创作请求', { name: label }));
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
    if (!series || !currentProjectId || extractingAssetKindRef.current) return;
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
    } finally {
      extractingAssetKindRef.current = null;
      setExtractingAssetKind(null);
    }
  };

  const setCreative = (field: keyof CreativeDraft, value: string) => {
    if (!currentEpisode || isEpisodeEditorWriteLocked(currentEpisode.id)) return;
    const currentDraft = draftsRef.current[currentEpisode.id] ?? createDraft(currentEpisode);
    replaceEpisodeDraft(currentEpisode.id, { ...currentDraft, creative: { ...currentDraft.creative, [field]: value } });
  };

  const setTextDraft = (field: 'outline' | 'script', value: string) => {
    if (!currentEpisode || isEpisodeEditorWriteLocked(currentEpisode.id)) return;
    const currentDraft = draftsRef.current[currentEpisode.id] ?? createDraft(currentEpisode);
    replaceEpisodeDraft(currentEpisode.id, { ...currentDraft, [field]: value });
  };

  const viewTeamTask = async (taskId: string) => {
    if (isDirty && !await saveDraft()) return;
    onClose();
    await openTeamTaskInAssistant(taskId);
  };

  const mutateTeamResult = async (taskId: string, restore: boolean) => {
    if (isDirty || savingEpisodeRef.current) throw new Error(t('请先处理工作台未保存修改，再应用团队成果'));
    onClose();
    try {
      await openTeamTaskInAssistant(taskId);
      await (restore ? restoreTeamResult(taskId) : applyTeamResult(taskId));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('团队成果保存失败'), 'error');
      throw error;
    }
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={requestClose}
      ariaLabel={t('剧本创作工作台')}
      closeOnBackdrop={false}
      className="ui-dialog-surface h-[min(88vh,860px)] w-[min(1180px,calc(100vw-24px))]
                 border-[var(--glass-ring)] text-canvas-text"
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            void saveDraft();
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
            disabled={!currentEpisode || isSaving || isStartingTeam || editorWriteLocked}
            onClick={() => {
              setExecutionSelection({ kind: 'team', templateId: activeTab === 'outline' ? 'outline' : 'script' });
              teamControlsRef.current?.scrollIntoView({ block: 'nearest' });
            }}>
            <Icon icon="lucide:users-round" className="h-3.5 w-3.5" />
            {t('团队协作')}
          </button>
          <button
            type="button"
            onClick={() => setSplitOpen((open) => !open)}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors ${
              splitOpen
                ? 'border-indigo-400/50 bg-indigo-500/15 text-indigo-300'
                : 'border-canvas-border text-canvas-text-secondary hover:bg-canvas-hover'
            }`}
          >
            <Icon icon="lucide:wand-sparkles" className="h-3.5 w-3.5" />
            {t('AI 拆分草案')}
          </button>
          <button type="button" className="ui-btn ui-btn--sm" disabled={projectLoadStatus !== 'ready'}
            onClick={() => setSourceOpen(true)}>{t('章节浏览')}</button>
          <PopupCloseButton ariaLabel={t('关闭剧本创作工作台')} onClick={requestClose} />
        </header>

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
              disabled={isSaving || editorWriteLocked}
              onClick={() => performPendingAction(pendingAction)}
              className="h-7 rounded-md px-2.5 text-[11px] text-red-300 hover:bg-red-500/15"
            >
              {t('放弃修改')}
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => {
                void saveDraft().then((saved) => {
                  if (saved) performPendingAction(pendingAction);
                });
              }}
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
            <label className="grid gap-1">
              <span className="text-[10px] text-canvas-text-muted">{t('目标总集数')}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={targetEpisodeCount}
                onChange={(event) => setTargetEpisodeCount(event.target.value)}
                className="h-8 rounded-lg border border-canvas-border bg-canvas-card px-2 text-xs outline-none"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[10px] text-canvas-text-muted">{t('单集秒数')}</span>
              <input
                type="number"
                min={15}
                max={600}
                value={targetDurationSec}
                onChange={(event) => setTargetDurationSec(event.target.value)}
                className="h-8 rounded-lg border border-canvas-border bg-canvas-card px-2 text-xs outline-none"
              />
            </label>
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
                        {episode.episodeScript?.trim()
                          ? t('正文 {count} 字', { count: episode.episodeScript.length })
                          : episode.episodeOutline?.trim()
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

          <section className="flex min-h-0 flex-col border-border-subtle xl:border-r">
            {currentEpisode ? (
              <>
                <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-border-subtle px-3 py-1">
                  {([
                    ['outline', '本集大纲', 'lucide:list-tree'],
                    ['script', '本集剧本', 'lucide:scroll-text'],
                    ['creative', '创作要点', 'lucide:lightbulb'],
                    ['characters', '本集角色', 'lucide:users-round'],
                    ['props', '本集道具', 'lucide:package'],
                  ] as const).map(([id, label, icon]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs transition-colors ${
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
                  {activeTab === 'characters' || activeTab === 'props' ? (
                    currentProjectId === currentEpisode.id ? (
                      <EpisodeAssetPanel key={`${currentEpisode.id}-${activeTab}`} episodeId={currentEpisode.id}
                        kind={activeTab === 'characters' ? 'character' : 'prop'}
                        onBeforeExtract={async () => !isDirty || await saveDraft()} />
                    ) : (
                      <div className="p-3">
                        <button type="button" className="ui-btn ui-btn--sm ui-btn--primary"
                          onClick={() => requestEpisodeSwitch(currentEpisode.id)}>{t('切换到本集管理资产')}</button>
                      </div>
                    )
                  ) : null}
                  {activeTab === 'outline' ? (
                    <textarea
                      value={draft.outline}
                      readOnly={editorWriteLocked}
                      onChange={(event) => setTextDraft('outline', event.target.value)}
                      spellCheck={false}
                      placeholder={t('写下本集任务、核心冲突、主要情节点和结尾卡点…')}
                      className="h-full min-h-80 w-full resize-none bg-transparent p-4 text-[13px] leading-7
                                 text-canvas-text outline-none placeholder:text-canvas-text-muted"
                    />
                  ) : null}
                  {activeTab === 'script' ? (
                    <textarea
                      value={draft.script}
                      readOnly={editorWriteLocked}
                      onChange={(event) => setTextDraft('script', event.target.value)}
                      spellCheck={false}
                      placeholder={t('按场号、场景、人物、动作和对白写本集完整正文…')}
                      className="h-full min-h-80 w-full resize-none bg-transparent p-4 font-mono text-[13px]
                                 leading-7 text-canvas-text outline-none placeholder:text-canvas-text-muted"
                    />
                  ) : null}
                  {activeTab === 'creative' ? (
                    <div className="grid gap-4 p-4 md:grid-cols-2">
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
                        value={draft.creative.targetDurationSec}
                        placeholder="90"
                        onChange={(value) => setCreative('targetDurationSec', value)}
                      />
                    </div>
                  ) : null}
                </div>

                <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-border-subtle px-3">
                  <span className={`text-[11px] ${isDirty ? 'text-amber-300' : 'text-canvas-text-muted'}`}>
                    {editorWriteLocked ? t('团队成果保存中…') : isDirty ? t('有未保存修改') : t('已保存')}
                  </span>
                  <span className="hidden text-[10px] text-canvas-text-muted sm:inline">Ctrl+S</span>
                  <button
                    type="button"
                    disabled={!draft.script.trim() || isSaving || projectLoadStatus !== 'ready'}
                    onClick={() => { void openEpisodeShotlist(); }}
                    className="ui-btn ui-btn--sm ml-auto"
                    title={t('用已保存的本集剧本创建分镜表，并选择模型生成')}
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
                </footer>
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
            <div className="flex items-center gap-2">
              <Icon icon="lucide:scan-search" className="h-4 w-4 text-indigo-400" />
              <h3 className="text-[11px] font-semibold text-canvas-text-secondary">{t('创作诊断')}</h3>
              <span className="ml-auto text-[9px] text-canvas-text-muted">{t('仅提示，不阻断')}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <MetricCard label={t('正文')} value={t('{count} 字', { count: analysis.metrics.characterCount })} />
              <MetricCard label={t('场景')} value={String(analysis.metrics.sceneCount)} />
              <MetricCard
                label={t('对白占比')}
                value={analysis.metrics.dialogueRatio === null
                  ? '—'
                  : `${Math.round(analysis.metrics.dialogueRatio * 100)}%`}
              />
              <MetricCard
                label={t('预计时长')}
                value={analysis.metrics.estimatedDurationSec === null
                  ? '—'
                  : t('约 {count} 秒', { count: analysis.metrics.estimatedDurationSec })}
              />
            </div>
            <div className="mt-2 grid gap-1.5">
              {analysis.diagnostics.slice(0, 4).map((item) => (
                <div key={item.id} className="rounded-lg border border-canvas-border bg-canvas-card p-2.5">
                  <p className="text-[11px] font-medium text-canvas-text-secondary">{t(item.title)}</p>
                  <p className="mt-1 text-[10px] leading-4 text-canvas-text-muted">{t(item.detail)}</p>
                </div>
              ))}
              {analysis.diagnostics.length === 0 ? (
                <p className="rounded-lg border border-canvas-border bg-canvas-card p-2.5 text-[10px] text-canvas-text-muted">
                  {t('暂未发现明显的静态格式问题；人物动机、冲突强度等仍需创作判断。')}
                </p>
              ) : null}
            </div>

            <section className="mt-4 rounded-xl border border-canvas-border bg-canvas-card p-2.5">
              <div className="flex items-center gap-1.5">
                <Icon icon="lucide:scan-text" className="h-3.5 w-3.5 text-indigo-400" />
                <h3 className="text-[10px] font-semibold text-canvas-text-secondary">{t('全剧资产提取')}</h3>
                <span className="ml-auto rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[9px] text-indigo-300">
                  {t('完整剧本')}
                </span>
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-canvas-text-muted">
                {series?.series?.script?.trim()
                  ? t('读取全剧剧本，提取结果先预览，仅将所选条目加入本剧资产库。')
                  : t('请先填写全剧剧本。')}
              </p>
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {SERIES_ASSET_EXTRACTION_ACTIONS.map((action) => {
                  const running = extractingAssetKind === action.kind;
                  const label = t(action.label);
                  return (
                    <button
                      key={action.kind}
                      type="button"
                      aria-busy={running}
                      disabled={!series?.series?.script?.trim()
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
            </section>

            <div ref={teamControlsRef} className="mt-3 space-y-2 rounded-lg border border-canvas-border bg-canvas-card p-2">
              <p className="text-[11px] font-semibold text-canvas-text-secondary">{t('创作执行方式')}</p>
              {unsettledEditor && <div className="space-y-1 text-[11px] text-canvas-text-secondary" role="status">
                <p>{t('上次编辑未确认结束，请核对当前已保存稿件后再应用团队成果。')}</p>
                <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={isDirty || isSaving || editorWriteLocked}
                  onClick={() => { if (currentEpisode) settleEpisodeEditorSessions(currentEpisode.id); }}>{t('已核对当前稿件')}</button>
              </div>}
              <TeamExecutionPicker value={executionSelection} onChange={setExecutionSelection}
                profile={teamProfile} onProfileChange={async (profile) => {
                  updateConfig({ agentTeamProfile: profile });
                  await useAppStore.getState().saveConfig({ silent: true, throwOnError: true });
                }}
                modelGroups={modelCatalog.assistantModelGroups} generalModels={config.generalModels}
                theme={config.theme} disabled={isSaving || isStartingTeam || editorWriteLocked} compact defaultTemplateId="outline" />
              {executionSelection.kind === 'team' && <>
                <label className="flex items-center justify-between gap-2 text-[11px] text-canvas-text-secondary">
                  <span>{t('任务权限')}</span>
                  <select value={teamMode} onChange={(event) => setTeamMode(event.target.value as AgentMode)}
                    disabled={isStartingTeam} className="ui-select__control min-w-0">
                    <option value="plan">{t('规划')}</option>
                    <option value="collaborative">{t('协作')}</option>
                    <option value="autonomous">{t('自主')}</option>
                  </select>
                </label>
                <p className="text-[10px] leading-4 text-canvas-text-muted">{t('先保存当前改稿，再由团队生成候选；点击下方动作开始，不会自动覆盖正文。')}</p>
              </>}
            </div>

            {episodeTeamTasks.map((task) => <TeamRunCard key={task.id} task={task} compact
              onPause={(id) => { cancelScheduledAgentExecution(id); pauseAgentTask(id); }}
              onStop={(id) => { cancelScheduledAgentExecution(id); stopAgentTask(id); }}
              onResume={(id) => {
                const result = resumeAgentTaskExecution(id);
                if (!result.ok) showToast(result.message ?? t('任务当前不能继续'), 'error');
              }}
              onView={(id) => { void viewTeamTask(id).catch((error) => showToast(error instanceof Error ? error.message : t('打开团队任务失败'), 'error')); }}
              onReadArtifact={(id, artifact) => readTeamTaskArtifact(id, artifact.id)}
              onApply={(id) => mutateTeamResult(id, false)} onRestore={(id) => mutateTeamResult(id, true)}
              onReconcile={async (id) => { showToast(await reconcileTeamResult(id)); }}
              onAmend={async (id, instruction) => {
                try { await appendTeamInstruction(id, instruction); }
                catch (error) { showToast(error instanceof Error ? error.message : t('追加团队要求失败'), 'error'); throw error; }
              }} />)}

            <div className="mt-4 grid gap-3">
              {CREATIVE_ACTION_GROUPS.map((group) => (
                <section key={group.label}>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-canvas-text-secondary">
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
                        className="rounded-lg border border-canvas-border bg-canvas-card px-2.5 py-1.5
                                   text-[10px] text-canvas-text-secondary transition-colors hover:border-indigo-400/40
                                   hover:bg-indigo-500/10 hover:text-indigo-200 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {executionSelection.kind === 'team' && action.id === 'diagnose' ? t('联合审稿') : t(action.label)}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </aside>
        </main>
      </div>
      {isOpen && renamingEpisodeId && (
        <EpisodeNameDialog episodeId={renamingEpisodeId} onClose={() => setRenamingEpisodeId(null)} />
      )}
      {isOpen && seriesAssetPreview && currentProjectId === seriesAssetPreview.projectId && (
        <AssetExtractionPreviewDialog title={t('全剧资产提取预览')} items={seriesAssetPreview.assets}
          existingItems={(() => {
            return seriesAssetPreview.kind === 'character' ? dramaAssets.characters
              : seriesAssetPreview.kind === 'scene' ? dramaAssets.scenes : dramaAssets.props;
          })()}
          confirmLabel={t('将所选条目加入本剧资产库')}
          onClose={() => setSeriesAssetPreview(null)}
          onConfirm={async (selectedIds) => {
            const count = await commitSeriesAssetCandidates(seriesAssetPreview, selectedIds);
            setSeriesAssetPreview(null);
            showToast(t('已将 {count} 项资产加入本剧资产库', { count }));
          }} />
      )}
      {sourceOpen && <SeriesSourceBrowser initialPart={splitSource} onClose={() => setSourceOpen(false)}
        beforeAssistant={async () => {
          if (isDirty && !await saveDraft()) return false;
          onClose();
          return true;
        }} />}
    </ModalOverlay>
  );
}
