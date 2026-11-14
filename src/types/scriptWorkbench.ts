/** 独立剧本工作台只接收创作视图快照；保存、模型与资产操作仍由主窗口执行。 */
import type { CanvasProject, AppearanceUiSnapshot, AppConfig, ModelGroup } from './index';
import type { AgentMode, AgentTask } from './agent';
import type { AgentTeamProfile, AssistantExecutionSelection, TeamGraphDefinition } from './agentTeam';
import type { CreationProfileOption, CreationProfileSelection } from './creationProfile';
import type { ExternalAgentDescriptor } from './externalAgent';
import type { DramaAsset, DramaAssetKind } from './dramaAssets';
import type { CreativeAnalysis, CreativeFieldId, EpisodeCreativeAction } from '../services/seriesCreativeService';
import type { EpisodeAssetKind, EpisodeAssetPanelAction, EpisodeAssetPanelSnapshot } from './episodeAssets';
import type { SeriesSourcePart, SeriesSourceReference } from './seriesSource';
import type { OriginalWritingAction, OriginalWritingHandoff, OriginalWritingSummary } from './originalWriting';
import type { StoryGraphAssetOption, StoryGraphCandidateSelection, StoryGraphEvidence, StoryGraphEvidenceQuery,
  StoryGraphExtractionState, StoryGraphExtractRequest, StoryGraphFilter, StoryGraphPatch, StoryGraphSelection, StoryGraphView } from './storyGraph';
import type { ProjectWindowContext } from './projectWindow';
import type { SeriesSplitSkillOption } from '../services/seriesSplitSkillService';

export type WorkbenchEditorTab = 'outline' | 'original' | 'script' | 'creative' | 'characters' | 'scenes' | 'props' | 'story-graph';
export type WorkbenchPendingAction = { type: 'close' } | { type: 'switch'; episodeId: string };
export interface WorkbenchCreativeDraft {
  task: string; coreConflict: string; openingHook: string; reversal: string; endingHook: string;
  beats: string; targetDurationSec: string; sourceRange: string;
}
export interface WorkbenchDraft { outline: string; script: string; creative: WorkbenchCreativeDraft }
export type WorkbenchEpisode = Pick<CanvasProject, 'id' | 'parentId' | 'name' | 'episodeOutline' | 'episodeScript' | 'episodeScriptFile' | 'episodeCreative' | 'episodeAssetRoster' | 'creationProfile' | 'teamProfileOverride'>;
export interface WorkbenchDraftHandoff { episodeId: string; sequence: number; draft: WorkbenchDraft; windowContext?: ProjectWindowContext | null }

export interface WorkbenchSplitRequest {
  part: SeriesSourcePart;
  version: string;
  chapterIds?: string[];
  episodeDurationSec: number;
  sizing: { kind: 'fixed'; count: number } | { kind: 'auto'; charactersPerMinute: number; totalDurationSec?: number };
  skillId?: string;
  notes: string;
}

export interface ScriptWorkbenchSnapshot {
  schemaVersion?: 2;
  /** 真实 WebView 实例的会话；业务 sessionId 在收回/重开间保持不变。 */
  windowSessionId?: string;
  acceptedRequestSequence?: number;
  windowContext?: ProjectWindowContext | null;
  sessionId: string; revision: number; acceptedEditSequence: number; draftVersion: number;
  series: { id: string; name: string; hasScript: boolean; hasOriginal: boolean; originalAddedAt?: number; updatedAt?: number; exchangeEpoch?: number } | null;
  episodes: Array<{ id: string; name: string; scriptLength: number; hasOutline: boolean }>;
  currentEpisode: WorkbenchEpisode | null;
  canvasProjectId: string | null;
  activeTab: WorkbenchEditorTab; draft: WorkbenchDraft; analysis: CreativeAnalysis;
  isDirty: boolean; isSaving: boolean; isStartingTeam: boolean; contextReady: boolean;
  editorWriteLocked: boolean; unsettledEditor: boolean;
  pendingAction: WorkbenchPendingAction | null;
  splitOpen: boolean; splitSource: SeriesSourcePart; splitSkills?: SeriesSplitSkillOption[];
  sourceOpen: boolean; renamingEpisodeId: string | null;
  originalWriting?: OriginalWritingSummary;
  extractingAssetKind: DramaAssetKind | null;
  seriesAssetPreview: { kind: DramaAssetKind; assets: DramaAsset[] } | null;
  existingAssets: Array<Pick<DramaAsset, 'name' | 'summary'>>;
  assetPanel?: EpisodeAssetPanelSnapshot;
  executionSelection: AssistantExecutionSelection; teamMode: AgentMode; teamProfile: AgentTeamProfile;
  modelGroups: ModelGroup[]; episodeTeamTasks: AgentTask[];
  episodeAgentTasks?: Array<Pick<AgentTask, 'id' | 'status'> & { title: string; activity: string }>;
  creationProfiles?: CreationProfileOption[];
  externalAgents?: ExternalAgentDescriptor[];
  hasSavedStoryGraph?: boolean;
  storyGraphView?: StoryGraphView;
  storyGraphFilter?: StoryGraphFilter;
  storyGraphAssets?: StoryGraphAssetOption[];
  storyGraphExtraction?: StoryGraphExtractionState;
  storyGraphEditorOpen?: boolean;
  sourceLocation?: StoryGraphEvidence & { sequence: number };
  theme?: 'dark' | 'light'; language?: AppConfig['language']; appearance: AppearanceUiSnapshot;
  detached: boolean; openingWindow: boolean;
}

export type ScriptWorkbenchAction =
  | OriginalWritingAction
  | { type: 'flush_draft' }
  | { type: 'edit_text'; field: 'outline' | 'script'; value: string }
  | { type: 'edit_creative'; field: keyof WorkbenchCreativeDraft; value: string }
  | { type: 'select_episode'; episodeId: string }
  | { type: 'set_tab'; tab: WorkbenchEditorTab }
  | { type: 'save' } | { type: 'close' } | { type: 'dock' } | { type: 'detach' }
  | { type: 'cancel_pending' } | { type: 'discard_pending' } | { type: 'save_pending' }
  | { type: 'open_split' } | { type: 'close_split' }
  | { type: 'read_split_material'; part: SeriesSourcePart }
  | { type: 'split_skill_import' }
  | { type: 'open_source' } | { type: 'close_source' }
  | { type: 'read_source'; part: SeriesSourcePart } | { type: 'prepare_chapter'; reference: SeriesSourceReference }
  | { type: 'open_rename'; episodeId: string } | { type: 'close_rename' } | { type: 'rename'; name: string }
  | { type: 'creative'; action: EpisodeCreativeAction }
  | { type: 'polish'; field: CreativeFieldId; label: string; hasValue: boolean }
  | { type: 'shotlist' } | { type: 'split_draft'; settings: WorkbenchSplitRequest }
  | { type: 'extract_series'; kind: DramaAssetKind; label: string }
  | { type: 'close_asset_preview' } | { type: 'commit_asset_preview'; selectedIds: string[] }
  | { type: 'asset'; episodeId: string; kind: EpisodeAssetKind; action: EpisodeAssetPanelAction }
  | { type: 'settle_editor' }
  | { type: 'set_execution'; value: AssistantExecutionSelection }
  | { type: 'set_team_mode'; value: AgentMode } | { type: 'save_team_profile'; profile: AgentTeamProfile }
  | { type: 'preview_creation_profile'; profile: CreationProfileOption }
  | { type: 'apply_creation_profile'; selection: CreationProfileSelection | null }
  | { type: 'refresh_external_agents' }
  | { type: 'story_graph_filter'; filter: StoryGraphFilter }
  | { type: 'story_graph_detail'; selection: StoryGraphSelection }
  | { type: 'story_graph_patch'; patch: StoryGraphPatch; expectedRevision: number }
  | { type: 'story_graph_resolve_evidence'; query: StoryGraphEvidenceQuery }
  | { type: 'story_graph_locate'; evidence: StoryGraphEvidence }
  | { type: 'story_graph_extract'; request: StoryGraphExtractRequest }
  | { type: 'story_graph_cancel'; runId?: string } | { type: 'story_graph_discard'; candidateId?: string }
  | { type: 'story_graph_adopt'; candidateId: string; selection: StoryGraphCandidateSelection }
  | { type: 'story_graph_editor'; open: boolean; graphId: string; expectedRevision: number; epoch: number }
  | { type: 'edit_team_graph'; taskId: string; graph: TeamGraphDefinition; expected: { revision: number; boardRevision: number } }
  | { type: 'resolve_dispatch'; taskId: string; dispatchId: string; decision: 'verified_completed' | 'abandoned' }
  | { type: 'team_control'; taskId: string; action: 'pause' | 'stop' | 'resume' | 'view' | 'apply' | 'restore' | 'reconcile' }
  | { type: 'team_artifact'; taskId: string; artifactId: string }
  | { type: 'view_agent_task'; taskId: string }
  | { type: 'team_amend'; taskId: string; instruction: string };

export type ScriptWorkbenchDispatch = (action: ScriptWorkbenchAction) => Promise<unknown>;
export interface ScriptWorkbenchRequest {
  schemaVersion?: 2;
  windowSessionId?: string;
  sequence?: number;
  windowContext?: ProjectWindowContext | null;
  sessionId: string; requestId: string; revision: number; episodeId: string | null;
  action: ScriptWorkbenchAction; handoff?: WorkbenchDraftHandoff;
  originalHandoff?: OriginalWritingHandoff;
}
export interface ScriptWorkbenchResponse { sessionId: string; windowSessionId?: string; requestId: string; sequence?: number; value?: unknown; error?: string }
