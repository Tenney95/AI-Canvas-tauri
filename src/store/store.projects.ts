/**
 * store.projects — 管理项目保存、切换、恢复与项目域数据装配。
 */
import { t } from '../i18n';
/**
 * Project slice — multi-project management, save/load/init via IndexedDB
 */
import type { Node, Edge } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../services/chat/assistantScope';
import type {
  BaseNodeData,
  CanvasProject,
  EpisodeCreativeInfo,
  NodeGroup,
  ProjectOriginalWork,
  ProjectSeriesInfo,
  ProjectSettings,
} from '../types';
import type { ProjectSaveData } from '../services/fileService';
import {
  generateProjectId,
  listEpisodes,
  listTopLevelProjects,
  projectMemoryOwnerId,
  resolveOpenTargetId,
  seriesOwnerId,
} from './store.utils';
import * as fileService from '../services/fileService';
import { resumePendingTasks, stopPollingForDeletedProjects, getPendingTasksForProject } from '../services/pollManager';
import { normalizeProjectSettings } from '../services/projectSettingsService';
import { normalizeCreationProfileSelection } from '../services/creationProfiles/creationProfileManifest';
import { normalizeTeamProfile } from '../services/chat/teams/teamProfileService';
import { captureCurrentCanvasSnapshot } from '../services/projectSnapshotService';
import { stopProjectAgentTasks } from '../services/chat/agentTaskControl';
import { cancelProjectCanvasDerivations, completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasImport } from '../services/canvasDerivationGuard';
import { clearConversationFileGrants } from '../services/chat/fileGrantService';
import { reassignProjectMemories } from '../services/chat/projectMemoryService';
import { duplicateProjectArchive, exportProjectArchive, importProjectArchive } from '../services/projectTransferService';
import {
  getLastActiveProjectId,
  getProjectById,
  setLastActiveProjectId,
  updateProjectSnapshot,
  updateProjectStoryGraphCAS,
} from '../services/indexedDbService';
import { normalizeProjectMediaNodes, serializeProjectRecord, type ProjectSummaryData } from '../services/storageService';
import { toProjectSummaryRecord } from '../services/indexedDb/projectSummary';
import {
  applySharedAssetSyncCommit,
  type SharedAssetSyncCommitInput,
  type SharedAssetSyncCommitResult,
} from '../services/indexedDb/sharedAssetSyncRepository';
import { describeStorageError, type StorageFailureKind } from '../services/storageQuota';
import { relocateMediaReferences } from '../services/indexedDb/mediaRelocations';
import { applyAssetRepairs, cleanupUnavailableAssets, type AssetRepairPreview } from '../services/fs/assetRepair';
import type { DramaAssetLibrary, DramaAssetWriteOptions } from '../types/dramaAssets';
import { assertDramaAssetWriteCurrent } from '../types/dramaAssets';
import { isWebviewRecovery } from '../services/webviewRecoveryService';
import { normalizeEpisodeAssetRoster, type EpisodeAssetRoster } from '../types/episodeAssets';
import { prepareProjectImport, previewProjectImport, applyProjectImport, nativeImportPreview, withPreparedProjectImportRead, type PreparedProjectImport,
  restoreProjectImportRecovery, type ProjectImportPreview, type ProjectImportOptions } from '../services/projectImportService';
import type { ProjectMergeSide } from '../services/projectMergeService';
import type { TeamEpisodeTarget } from '../types/agentTeam';
import { sha256BytesHex } from '../services/mediaDataUrl';
import { projectModelSourceToken } from '../services/projectModelComparisonMaterial';
import { finalizeNativeSharedAssetSync, prepareNativeSharedAssetSync } from '../services/indexedDb/nativeSharedAssetSyncRepository';
import { episodeTeamSourceSnapshot } from '../services/seriesCreativeService';
import { readEpisodeWorkspaceScope } from '../services/episodeWorkspaceScope';
import type { StoryGraph, StoryGraphPatch } from '../types/storyGraph';
import { applyStoryGraphPatch, normalizeStoryGraph } from '../services/storyGraphService';
import { prepareEpisodeScriptFileWrite, type EpisodeScriptFileReceipt } from '../services/episodeScriptFileService';
import { normalizeProjectTextFileReference } from '../utils/manuscriptFileReference';
import { deleteLegacyProjectContent, swapLegacyEpisodeOrder } from '../services/indexedDb/legacyProjectLifecycleRepository';
import { ProjectImportCommittedError } from '../services/projectImportOutcome';
import type { ProjectExpectedContext, EpisodeContent, EpisodeSettingsPolicy } from '../types/project';
import type { NativeMediaTaskRecord } from '../services/indexedDb/nativeMediaTaskRepository';
import type { NativeMediaSubmissionPreparation } from '../types/media';
import { isProjectExpectedContextCurrent } from '../services/projectExecutionContext';
import { videoInputFingerprintMaterial } from '../services/videoBatchPlanning';
import { nativeMediaInputMaterial } from '../services/nativeMediaInput';
import { createNativeProject, saveNativeProjectView, saveNativeProjectContent, convertNativeProjectToSeries,
  createNativeEpisode, saveNativeEpisodeContent, readNativeProjectCapture, reorderNativeEpisodes,
  deleteNativeEpisode, deleteNativeProject, updateNativeProjectMetadata, updateNativeEpisodeMetadata,
  updateNativeEpisodeComposite, readNativeEpisodeContent, readNativeProjectContent } from '../services/indexedDb/nativeProjectRepository';
import { listProjectCatalog, resolveProjectModel, type ProjectCatalogEntry } from '../services/projectModelRouter';
import { readNativeProjectView } from '../services/nativeProjectNavigation';
import { hydrateNativeProjectView, nativeEpisodeDisplayNumbers, projectNativeCatalogEntry, type NativeProjectViewItem } from './nativeProjectView';
import { restoreProjectRecord } from '../services/storageService';
import { waitForPendingNodeFileDeletions } from '../services/fs/trash';
import { resolveProjectModelSettings } from '../services/projectModelSettings';
import { configValuesEqual } from '../services/configPatch';
import { remapStoryGraphBindings } from '../services/projectExchangeDomain';
import { duplicateNativeProjectArchive, exportNativeProjectArchive } from '../services/nativeProjectArchiveService';
import { importNativeProjectArchive, importNativeProjectArchiveFromSession } from '../services/nativeProjectImportService';
import type { CharacterVisualReferencePlan } from '../services/characterVisualReferencePlan';

type ProjectLoadStatus = 'loading' | 'ready' | 'error';
type NativeCatalog = Extract<ProjectCatalogEntry, { dataModel: 'native' }>;
type NativeLoaded = NonNullable<Awaited<ReturnType<typeof readNativeProjectView>>>;
interface NativeRuntime {
  loaded: NativeLoaded;
  activeId: string;
  library: AppState['dramaAssets'];
  tail: Promise<void>;
  /** 排队的保存需重取事务投影后的视图，不能用旧快照覆盖已交付产物或引用。 */
  mediaGeneration?: number;
}
const nativeKnownIds: Set<string> = import.meta.hot?.data.nativeKnownIds ?? new Set();
const nativeRuntime: WeakMap<() => AppState, NativeRuntime> = import.meta.hot?.data.nativeRuntime ?? new WeakMap();
if (import.meta.hot) { import.meta.hot.data.nativeKnownIds = nativeKnownIds; import.meta.hot.data.nativeRuntime = nativeRuntime; }
const catalogRequests: { latest: number } = import.meta.hot?.data.nativeCatalogRequests ?? { latest: 0 };
if (import.meta.hot) import.meta.hot.data.nativeCatalogRequests = catalogRequests;

function nativeBinding(project: CanvasProject | undefined): NativeProjectViewItem['nativeView'] | undefined {
  return (project as NativeProjectViewItem | undefined)?.nativeView;
}

async function loadProjectCatalog(): Promise<{ projects: CanvasProject[]; native: NativeCatalog[] }> {
  const sequence = ++catalogRequests.latest;
  let catalog: ProjectCatalogEntry[];
  try { catalog = await listProjectCatalog(); }
  catch (error) {
    if (sequence === catalogRequests.latest) await fileService.syncNativeAssetSearchRoots([]).catch(() => undefined);
    throw error;
  }
  const native = catalog.filter((item): item is NativeCatalog => item.dataModel === 'native');
  let projects: CanvasProject[];
  try {
    const legacy = catalog.filter((item) => item.dataModel === 'legacy').map((item) => toCanvasProjectSummary(item.project));
    projects = withInheritedDataFolders(legacy);
    fileService.registerProjectFolders(projects);
    for (const entry of native) {
      const ids = [entry.project.id, ...entry.episodeIds, ...entry.canvasIds];
      ids.forEach((id) => nativeKnownIds.add(id));
      fileService.registerNativeProjectFolders(ids.map((id) => ({ id, projectId: entry.project.id })));
      projects.push(...projectNativeCatalogEntry(entry));
    }
  } catch (error) {
    if (sequence === catalogRequests.latest) await fileService.syncNativeAssetSearchRoots([]).catch(() => undefined);
    throw error;
  }
  try { if (sequence === catalogRequests.latest) await fileService.syncNativeAssetSearchRoots(native.map((entry) => entry.project.id)); }
  catch { console.warn('[项目资产] 新项目搜索目录同步失败，搜索不可用'); }
  return { projects: projects.sort((a, b) => b.updatedAt - a.updatedAt), native };
}

async function activateNativeProject(set: ProjectSliceSet, get: ProjectSliceGet, entry: NativeCatalog,
  targetId: string, assertCurrent: () => void, preserveHistory = false): Promise<string> {
  const binding = projectNativeCatalogEntry(entry).find((item) => item.id === targetId)?.nativeView;
  if (!binding) throw new Error('新项目导航身份已变化');
  await waitForPendingNodeFileDeletions();
  assertCurrent();
  const loaded = await readNativeProjectView(entry.project.id, binding.canvasId ?? undefined);
  assertCurrent();
  if (!loaded || (loaded.selection.canvas?.id ?? null) !== binding.canvasId) throw new Error('项目画布身份已变化');
  const canvas = loaded.selection.canvas;
  const activeId = canvas?.id ?? entry.project.id;
  // 现有工作台可同时查看各集稿件；只读各集正文，不加载其他画布，并核对同一项目提交版本。
  const episodeBodies = await Promise.all(entry.episodes.map((episode) => readNativeEpisodeContent(entry.project.id, episode.id)));
  assertCurrent();
  if (episodeBodies.some((body, index) => !body || body.changeRevision !== loaded.selection.changeRevision
    || !configValuesEqual(body.project, loaded.selection.project) || !configValuesEqual(body.episode, entry.episodes[index]))) {
    throw new Error('项目在打开期间发生变化，请重新打开');
  }
  const projected = hydrateNativeProjectView(entry, loaded, episodeBodies.map((body) => body!.content));
  const selected = projected.find((item) => item.id === activeId);
  if (!selected) throw new Error('新项目画布身份已变化');
  const data = await restoreProjectRecord({ ...selected, nodes: canvas?.nodes ?? [], edges: canvas?.edges ?? [], groups: canvas?.groups ?? [],
    dramaAssets: loaded.content.dramaAssets }, { recoverUndoTrash: true, assertCurrent });
  assertCurrent();
  const ids = [entry.project.id, ...entry.episodeIds, ...entry.canvasIds];
  fileService.registerNativeProjectFolders(ids.map((id) => ({ id, projectId: entry.project.id })));
  const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
  assertCurrent();
  const library = data.dramaAssets ?? emptyDramaAssetLibrary();
  nativeRuntime.set(get, { loaded, activeId, library, tail: Promise.resolve() });
  const projectContext = { schemaVersion: 2 as const, modelGeneration: 1, runtimeEpoch: crypto.randomUUID(),
    projectId: entry.project.id, projectEpoch: entry.project.epoch };
  const context: ProjectExpectedContext = canvas ? { kind: 'canvas', ...projectContext,
    episodeId: canvas.episodeId, canvasId: canvas.id, canvasEpoch: canvas.epoch,
    canvasRevision: canvas.revisionScope === 'global' ? get().globalCanvasRevision : get().canvasRevision }
    : { kind: 'project', ...projectContext };
  set((state) => ({
    projects: [...state.projects.filter((item) => nativeBinding(item)?.projectId !== entry.project.id),
      ...projected.map((item) => item.id === activeId ? { ...item, settings: data.settings,
        ...(canvas ? { revisionScope: canvas.revisionScope } : {}) } : item)],
    currentProjectId: activeId, projectName: selected.name, projectLoadStatus: 'ready', projectExecutionContext: context,
    nodes: data.nodes as Node<BaseNodeData>[], edges: data.edges as Edge[], groups: getProjectGroups(data),
    ...(preserveHistory ? {} : { history: [], historyIndex: -1 }), dramaAssets: library,
  }));
  if (canvas) void resumePendingTasks(activeId).catch(() => { /* 原缓存保留，下次原画布就绪再交付。 */ });
  return activeId;
}

async function saveNativeCurrentProject(get: ProjectSliceGet, state: AppState, record: ProjectSaveData, guard?: () => void,
  reservation?: NativeRuntime, projection?: { signal: AbortSignal; commit: () => void }): Promise<string> {
  const runtime = nativeRuntime.get(get);
  const binding = nativeBinding(state.projects.find((item) => item.id === record.id));
  if (!runtime || !binding || runtime.activeId !== record.id || (binding.canvasId ?? binding.projectId) !== record.id) throw new Error('新项目画布上下文不可用');
  const reserved = reservation === runtime;
  const prior = reserved ? Promise.resolve() : runtime.tail;
  const mediaGeneration = runtime.mediaGeneration ?? 0;
  let release = () => {};
  if (!reserved) runtime.tail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await prior;
    guard?.();
    if (nativeRuntime.get(get) !== runtime || get().currentProjectId !== record.id) throw new Error('项目已切换，取消保存');
    if ((runtime.mediaGeneration ?? 0) !== mediaGeneration) {
      const latest = get(), fresh = createCurrentProjectSaveRecord(latest);
      if (!fresh || fresh.id !== record.id) throw new Error('媒体交付后的保存上下文已变化');
      state = latest; record = fresh;
    }
    const serialized = await serializeProjectRecord({ ...record, dramaAssets: state.dramaAssets });
    guard?.();
    if (nativeRuntime.get(get) !== runtime || get().currentProjectId !== record.id) throw new Error('项目已切换，取消保存');
    const { selection, content } = runtime.loaded;
    const canvas = selection.canvas;
    if (!Array.isArray(serialized.nodes) || !Array.isArray(serialized.edges) || !Array.isArray(serialized.groups)) throw new Error('画布内容无效');
    const updateLibrary = runtime.library !== state.dramaAssets;
    if (!canvas) {
      if (serialized.nodes.length || serialized.edges.length || serialized.groups.length) throw new Error('当前剧集没有画布，请先创建分集');
      if (updateLibrary) {
        const saved = await saveNativeProjectContent({ projectId: binding.projectId, expectedProjectEpoch: selection.project.epoch,
          expectedRevisions: { assets: content.revisions.assets }, patch: { dramaAssets: serialized.dramaAssets } });
        runtime.loaded = { ...runtime.loaded, selection: { ...selection, changeRevision: saved.changeRevision }, content: saved.content };
        runtime.library = state.dramaAssets;
      }
      return record.id;
    }
    const saveOptions: [options?: { signal: AbortSignal }] = projection ? [{ signal: projection.signal }] : [];
    const saved = await saveNativeProjectView({ projectId: binding.projectId, expectedProjectEpoch: selection.project.epoch,
      canvasId: canvas.id, episodeId: binding.episodeId, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: serialized.nodes, edges: serialized.edges, groups: serialized.groups },
      ...(updateLibrary ? { shared: { expectedRevisions: { assets: content.revisions.assets }, patch: { dramaAssets: serialized.dramaAssets } } } : {}) },
    ...saveOptions);
    runtime.loaded = { ...runtime.loaded, selection: { ...selection, canvas: saved.canvas, changeRevision: saved.changeRevision,
      context: { ...selection.context, canvasRevision: saved.canvas.revision } }, content: saved.content ?? content };
    if (updateLibrary) runtime.library = state.dramaAssets;
    if (projection) {
      runtime.mediaGeneration = (runtime.mediaGeneration ?? 0) + 1;
      projection.commit();
    }
    return record.id;
  } finally { release(); }
}

/** complete事件前已经发生的编辑按字段保留；媒体只补原节点的未被改写结果及稳定候选。 */
function rebaseCommittedMediaNodes(before: Node<BaseNodeData>[], current: Node<BaseNodeData>[], delivered: Node<BaseNodeData>[], nodeId: string): Node<BaseNodeData>[] {
  const previous = before.find((node) => node.id === nodeId), next = delivered.find((node) => node.id === nodeId), target = current.find((node) => node.id === nodeId);
  if (!previous || !next || !target || target.data.type !== previous.data.type) return current;
  const original = previous.data as unknown as Record<string, unknown>, result = next.data as unknown as Record<string, unknown>, live = target.data as unknown as Record<string, unknown>;
  if (['imageUrl', 'audioUrl', 'videoUrl', 'relativePath', 'filePath', 'assetId', 'sourceUrl', 'output', 'storageRootRef', 'artifactId', 'animationSheet', 'animationEdits']
    .some((field) => !configValuesEqual(live[field], original[field]))) return current;
  const data = { ...live };
  for (const field of new Set([...Object.keys(original), ...Object.keys(result)])) {
    if (configValuesEqual(original[field], result[field]) || !configValuesEqual(live[field], original[field])) continue;
    if (Object.hasOwn(result, field)) data[field] = result[field]; else delete data[field];
  }
  const changed = current.map((node) => node.id === nodeId ? { ...node, data: data as unknown as BaseNodeData } : node);
  const existingIds = new Set([...before, ...current].map((node) => node.id));
  return [...changed, ...delivered.filter((node) => !existingIds.has(node.id))];
}

const NORMALIZED_MEDIA_FIELDS = [
  'assetId', 'relativePath', 'filePath', 'storageRootRef',
  'imageUrl', 'videoUrl', 'audioUrl', 'thumbnailUrl', 'sourceUrl', 'output', 'mattingMask', 'annotation',
  'storyboardOverrides', 'shotlistRows', 'videoReferences', 'runninghubOutputs', 'workflowApiOutputs',
  'directorCaptureUrls', 'directorCaptureFilePaths', 'directorCaptureRelativePaths', '__nativeUnavailableMediaFields',
] as const satisfies readonly (keyof BaseNodeData)[];

/** 把完整设置转换为相对项目默认值的字段覆盖，避免新分集退化为旧式固定快照。 */
function nativeEpisodeSettings(settings: ProjectSettings, defaults?: ProjectSettings): EpisodeSettingsPolicy {
  const base = resolveProjectModelSettings(defaults), target = resolveProjectModelSettings(settings);
  const override = (value: unknown, previous: unknown) => configValuesEqual(value, previous) ? undefined
    : value === undefined ? { op: 'clear' as const } : { op: 'set' as const, value };
  const patch: Record<string, unknown> = {};
  for (const section of ['visualStyle', 'defaultModels', 'promptSuffixes', 'generation'] as const) {
    const left = (base[section] ?? {}) as Record<string, unknown>, right = (target[section] ?? {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const next = override(right[key], left[key]); if (next) fields[key] = next;
    }
    if (Object.keys(fields).length) patch[section] = fields;
  }
  for (const key of ['visionModelId', 'modelAutoRouting'] as const) {
    const next = override(target[key], base[key]); if (next) patch[key] = next;
  }
  return { mode: 'inherit', overrides: patch } as EpisodeSettingsPolicy;
}

async function mutateNativeMetadata(set: ProjectSliceSet, get: ProjectSliceGet, binding: NativeProjectViewItem['nativeView'],
  mutate: (capture: NonNullable<Awaited<ReturnType<typeof readNativeProjectCapture>>>) => Promise<unknown>, freeze = true): Promise<boolean> {
  const initial = get(), activeId = initial.currentProjectId;
  const active = nativeBinding(initial.projects.find((item) => item.id === activeId))?.projectId === binding.projectId;
  if (active && activeId && await get().saveCurrentProjectSilent() !== activeId) return false;
  if (projectImportsApplying.has(binding.projectId)) return false;
  const before = get(), sequence = projectSwitchSequence;
  const previousContext = before.projectExecutionContext;
  const assertCurrent = () => {
    const latest = get();
    if (latest.currentProjectId !== activeId || projectSwitchSequence !== sequence
      || active && (latest.nodes !== before.nodes || latest.edges !== before.edges || latest.groups !== before.groups || latest.dramaAssets !== before.dramaAssets)) {
      throw new Error('项目在操作期间发生变化，请重试');
    }
  };
  projectImportsApplying.add(binding.projectId);
  if (active && freeze) set({ switchingProjectName: '正在保存项目', projectExecutionContext: null });
  let previousRevision: number | undefined;
  let writeStarted = false;
  try {
    const capture = await readNativeProjectCapture(binding.projectId);
    if (!capture) throw new Error('项目不存在');
    previousRevision = capture.changeRevision;
    assertCurrent();
    writeStarted = true;
    await mutate(capture);
    const catalog = await loadProjectCatalog();
    const entry = catalog.native.find((item) => item.project.id === binding.projectId);
    if (!entry) throw new Error('项目目录不可用');
    assertCurrent();
    if (active && activeId) await activateNativeProject(set, get, entry, activeId, assertCurrent, true);
    else set((state) => ({ projects: [...state.projects.filter((item) => nativeBinding(item)?.projectId !== binding.projectId), ...projectNativeCatalogEntry(entry)] }));
    return true;
  } catch (error) {
    if (active && get().currentProjectId === activeId && sequence === projectSwitchSequence) {
      let unchanged = !writeStarted;
      if (previousRevision !== undefined) {
        try { unchanged = (await readNativeProjectCapture(binding.projectId))?.changeRevision === previousRevision; } catch { /* 无法确认结果，阻止继续保存 */ }
      }
      if (get().currentProjectId === activeId && sequence === projectSwitchSequence) set(unchanged
        ? { projectLoadStatus: 'ready', projectExecutionContext: previousContext }
        : { projectLoadStatus: 'error', projectExecutionContext: null });
    }
    get().showToast(error instanceof Error ? error.message : '项目保存失败', 'error');
    return false;
  } finally {
    projectImportsApplying.delete(binding.projectId);
    if (active && freeze) set({ switchingProjectName: null });
  }
}
/** 导入和恢复冻结活动画布，提交不确定时禁止继续保存旧投影。 */
async function runNativeImportMutation(set: ProjectSliceSet, get: ProjectSliceGet, projectId: string,
  operationId: string, work: (assertCurrent: () => void) => Promise<void>): Promise<void> {
  const before = get(), activeId = before.currentProjectId, sequence = projectSwitchSequence;
  const affected = before.projects.filter((item) => nativeBinding(item)?.projectId === projectId).map((item) => item.id);
  const active = !!activeId && affected.includes(activeId);
  if (!affected.length || [projectId, ...affected].some((id) => projectAssetSyncBarriers.has(id) || projectImportsApplying.has(id))
    || [projectId, ...affected].some((id) => getPendingTasksForProject(id).length > 0)
    || before.agentTasks.some((task) => [projectId, ...affected].includes(task.projectId) && !['completed', 'failed', 'stopped', 'paused'].includes(task.status))
    || before.videoBatchBusy || active && before.nodes.some((node) => node.data.status === 'loading')) throw new Error('项目正在执行任务、同步或更新，请先停止后重试');
  const assertCurrent = () => {
    const latest = get();
    if (latest.currentProjectId !== activeId || projectSwitchSequence !== sequence || latest.projects !== before.projects
      || active && (latest.nodes !== before.nodes || latest.edges !== before.edges || latest.groups !== before.groups || latest.dramaAssets !== before.dramaAssets)) {
      throw new Error('项目在操作期间发生变化，请重新对比');
    }
  };
  [projectId, ...affected].forEach((id) => projectImportsApplying.add(id));
  affected.forEach(cancelProjectCanvasDerivations);
  const previousContext = before.projectExecutionContext;
  if (active) set({ projectLoadStatus: 'loading', projectExecutionContext: null, switchingProjectName: '正在更新项目' });
  let revision: number | undefined, started = false, completed = false;
  try {
    await Promise.all(affected.map(waitForProjectSaveQueue)); assertCurrent();
    const capture = await readNativeProjectCapture(projectId); if (!capture) throw new Error('项目不存在');
    revision = capture.changeRevision; assertCurrent(); started = true;
    await work(assertCurrent); completed = true;
    const catalog = await loadProjectCatalog(), entry = catalog.native.find((item) => item.project.id === projectId);
    if (!entry) throw new Error('项目已更新，但项目目录刷新失败，请重启后打开');
    assertCurrent();
    if (active && activeId) {
      const target = entry.canvasIds.includes(activeId) ? activeId
        : entry.episodes[0]?.canvasId ?? entry.canvasIds[0] ?? entry.project.id;
      await activateNativeProject(set, get, entry, target, assertCurrent, false);
    } else set((state) => ({ projects: [...state.projects.filter((item) => nativeBinding(item)?.projectId !== projectId), ...projectNativeCatalogEntry(entry)] }));
  } catch (error) {
    let unchanged = !started;
    if (revision !== undefined) try { unchanged = (await readNativeProjectCapture(projectId))?.changeRevision === revision; } catch { unchanged = false; }
    if (active && get().currentProjectId === activeId && sequence === projectSwitchSequence) {
      set(unchanged ? { projectLoadStatus: 'ready', projectExecutionContext: previousContext }
        : { projectLoadStatus: 'error', projectExecutionContext: null });
    }
    if (completed) throw new Error('项目已更新，但重新加载失败，请从项目库重新打开', { cause: error });
    if (!unchanged) throw new Error(`项目更新结果无法确认，原操作 ${operationId}；请重新打开项目并检查恢复点，勿直接重试`, { cause: error });
    throw error;
  } finally {
    [projectId, ...affected].forEach((id) => projectImportsApplying.delete(id));
    if (active) set({ switchingProjectName: null });
  }
}
let activeProjectMetadataWrite: Promise<void> = Promise.resolve();
const EMPTY_SERIES_CANVAS: readonly never[] = [];
const projectInitializations: WeakMap<() => AppState, Promise<void>> = import.meta.hot?.data.projectInitializations ?? new WeakMap();
if (import.meta.hot) import.meta.hot.data.projectInitializations = projectInitializations;
const pendingProjectSaves: Map<string, Set<Promise<string | undefined>>> = import.meta.hot?.data.pendingProjectSaves ?? new Map();
if (import.meta.hot) import.meta.hot.data.pendingProjectSaves = pendingProjectSaves;
const episodeCreativeWrites: Map<string, Promise<unknown>> = import.meta.hot?.data.episodeCreativeWrites ?? new Map();
if (import.meta.hot) import.meta.hot.data.episodeCreativeWrites = episodeCreativeWrites;

export interface EpisodeCreativeWriteOptions {
  expected?: TeamEpisodeTarget;
  /** 仅可信工作台宿主可在已加载的同一剧集中保存明确目标，不代表画布写权限。 */
  allowSameSeries?: boolean;
  /** 仅供宿主编辑会话使用；不得进入持久化。 */
  assertCurrent?: () => void;
  /** 乐观更新后、磁盘读取及实际入队提交时的范围守卫，不重复检查提交前的脏稿。 */
  assertCommitCurrent?: () => void;
}

export type EpisodeAssetRosterWriteOptions = Pick<EpisodeCreativeWriteOptions, 'allowSameSeries' | 'assertCurrent' | 'assertCommitCurrent'>;

export interface SeriesInfoWriteOptions {
  expectedSeriesId?: string;
  expectedExchangeEpoch?: number;
  /** null 表示首次绑定前不能已有原著；省略时兼容普通元数据更新。 */
  expectedOriginalWork?: ProjectOriginalWork | null;
  /** 主窗口编辑会话的运行时守卫，不持久化。 */
  assertCurrent?: () => void;
}

export interface StoryGraphWriteOptions {
  expectedExchangeEpoch?: number;
  signal?: AbortSignal;
  /** 只由主窗口宿主验证编辑会话，不进入持久化或跨窗消息。 */
  assertCurrent?: () => void;
}

async function serializeEpisodeCreativeWrite<T>(episodeId: string, write: () => Promise<T>): Promise<T> {
  const previous = episodeCreativeWrites.get(episodeId) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(write);
  episodeCreativeWrites.set(episodeId, pending);
  try {
    return await pending;
  } finally {
    if (episodeCreativeWrites.get(episodeId) === pending) episodeCreativeWrites.delete(episodeId);
  }
}

function trackProjectSave(projectId: string | null, save: (projectId: string | null) => Promise<string | undefined>): Promise<string | undefined> {
  const operation = save(projectId);
  if (!projectId) return operation;
  const pending = pendingProjectSaves.get(projectId) ?? new Set<Promise<string | undefined>>();
  pending.add(operation);
  pendingProjectSaves.set(projectId, pending);
  const cleanup = () => {
    pending.delete(operation);
    if (pending.size === 0 && pendingProjectSaves.get(projectId) === pending) pendingProjectSaves.delete(projectId);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

/** 等待已发出的完整保存，包括入队前等待和失败分类；这里不发起新保存。 */
export async function waitForPendingProjectSaves(projectId: string): Promise<boolean> {
  while (true) {
    const pending = [...(pendingProjectSaves.get(projectId) ?? [])];
    if (pending.length === 0) return true;
    const results = await Promise.allSettled(pending);
    if (results.some((result) => result.status === 'rejected' || result.value !== projectId)) return false;
  }
}

function getProjectGroups(data: { groups?: unknown } | null | undefined): NodeGroup[] {
  return Array.isArray(data?.groups) ? (data.groups as NodeGroup[]) : [];
}

/**
 * 分集记录不持有角色库：整部剧共用一份，只写在剧集项目上，
 * 否则每集保存都会各存一份副本，改一集的角色其他集看不到。
 */
function ownedDramaAssets(
  project: CanvasProject,
  library: AppState['dramaAssets'],
): AppState['dramaAssets'] | undefined {
  return project.parentId ? undefined : library;
}

/**
 * 分集不单独持有素材目录，内存里把剧集项目的文件夹名补给分集后再注册，
 * 这样剧集改名只需要改剧集记录一处，分集记录里的旧值不会造成影响。
 */
function withInheritedDataFolders(projects: CanvasProject[]): CanvasProject[] {
  const folderById = new Map(projects.map((item) => [item.id, item.dataFolder]));
  return projects.map((item) => {
    const inherited = item.parentId ? folderById.get(item.parentId) : undefined;
    return inherited ? { ...item, dataFolder: inherited } : item;
  });
}

/** 摘要与完整记录共用白名单，保存代际不能在启动投影时丢失。 */
function toCanvasProjectSummary(record: ProjectSummaryData): CanvasProject {
  const summary = toProjectSummaryRecord(record);
  if (!summary) throw new Error('项目摘要无效，无法加载项目');
  return { ...summary, settings: record.settings };
}

/** 只接纳已实际读取的记录，并让版本、元数据与画布/角色库来自同一份内容。 */
function withLoadedProjectSummaries(projects: CanvasProject[], ...records: (ProjectSaveData | null | undefined)[]): CanvasProject[] {
  const loaded = new Map(records.filter((record): record is ProjectSaveData => !!record).map((record) => [record.id, record]));
  return withInheritedDataFolders(projects.map((project) => {
    const record = loaded.get(project.id);
    return record ? { ...toCanvasProjectSummary(record), revisionScope: project.revisionScope ?? record.revisionScope } : project;
  }));
}

function hasProjectCanvasData(data: ProjectSaveData | null): data is ProjectSaveData {
  return Boolean(data && Array.isArray(data.nodes) && Array.isArray(data.edges));
}

function rememberActiveProject(projectId: string): void {
  activeProjectMetadataWrite = activeProjectMetadataWrite
    .then(() => setLastActiveProjectId(projectId))
    .catch(() => {
      console.warn('[项目] 最近打开项目记录失败', { projectId });
    });
}

function replacePathPrefix(path: string | undefined, oldDir: string, newDir: string): string | undefined {
  if (!path) return path;
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedOldDir = oldDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedNewDir = newDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedPath.startsWith(`${normalizedOldDir}/`)) return path;
  return `${normalizedNewDir}${normalizedPath.slice(normalizedOldDir.length)}`;
}

async function remapProjectNodePaths(
  nodes: Node<BaseNodeData>[],
  oldDir: string,
  newDir: string,
): Promise<Node<BaseNodeData>[]> {
  return Promise.all(nodes.map(async (node) => {
    const data = node.data as BaseNodeData;
    const nextFilePath = replacePathPrefix(data.filePath, oldDir, newDir);
    let changed = nextFilePath !== data.filePath;
    let nextData: BaseNodeData = changed ? { ...data, filePath: nextFilePath } : data;

    if (changed && nextFilePath) {
      const assetUrl = await fileService.getAssetUrlFromPath(nextFilePath);
      if (nextData.imageUrl) nextData.imageUrl = assetUrl;
      if (nextData.videoUrl) nextData.videoUrl = assetUrl;
      if (nextData.audioUrl) nextData.audioUrl = assetUrl;
    }

    if (Array.isArray(data.storyboardOverrides)) {
      const nextOverrides = await Promise.all(data.storyboardOverrides.map(async (override) => {
        if (!override) return override;
        const nextOverridePath = replacePathPrefix(override.filePath, oldDir, newDir);
        if (nextOverridePath === override.filePath) return override;
        changed = true;
        return {
          ...override,
          filePath: nextOverridePath,
          url: nextOverridePath ? await fileService.getAssetUrlFromPath(nextOverridePath) : override.url,
        };
      }));
      if (nextOverrides !== data.storyboardOverrides && nextOverrides.some((override, index) => override !== data.storyboardOverrides?.[index])) {
        nextData = nextData === data ? { ...data } : nextData;
        nextData.storyboardOverrides = nextOverrides;
      }
    }

    return changed ? { ...node, data: nextData } : node;
  }));
}

interface ProjectSaveWaiter {
  resolve: (projectId: string) => void;
  reject: (error: unknown) => void;
}

interface PendingProjectSave {
  record: ProjectSaveData;
  waiters: ProjectSaveWaiter[];
  guard?: () => void;
  projection?: { signal: AbortSignal; commit: (queue: ProjectSaveQueue) => void };
}

interface ProjectSaveQueue {
  running: boolean;
  active: PendingProjectSave | null;
  pending: PendingProjectSave | null;
  /** 条件元数据写独立保序，不能被后来的普通自动保存合并成另一份成功记录。 */
  pendingBatches?: PendingProjectSave[];
  pendingSnapshot: { snapshot: string | undefined; waiters: ProjectSaveWaiter[] } | null;
  idleWaiters: Array<() => void>;
}

const projectSaveQueues: Map<string, ProjectSaveQueue> = import.meta.hot?.data.projectSaveQueues ?? new Map();
if (import.meta.hot) import.meta.hot.data.projectSaveQueues = projectSaveQueues;
interface ProjectAssetSyncBarrier {
  done: Promise<void>;
  library: AppState['dramaAssets'];
}
const projectAssetSyncBarriers = new Map<string, ProjectAssetSyncBarrier>();
const projectImportsApplying = new Set<string>();
// 只保留最近一个共享库的成功记录；不缓存普通画布或跨重载/同步沿用基线。
const seriesLibraryOwners = new WeakMap<ProjectSaveData, CanvasProject>();
let confirmedSeriesLibrary: { record: ProjectSaveData; owner: CanvasProject } | undefined;
let seriesLibrarySaveEpoch = 0;
function invalidateSeriesLibrarySave() {
  confirmedSeriesLibrary = undefined;
  seriesLibrarySaveEpoch += 1;
}
const importPreviewGuards = new WeakMap<ProjectImportPreview, () => void>();

function waitForProjectSaveQueue(projectId: string): Promise<void> {
  const queue = projectSaveQueues.get(projectId);
  return queue?.running ? new Promise((resolve) => queue.idleWaiters.push(resolve)) : Promise.resolve();
}

function waitForProjectAssetSync(get: () => AppState): Promise<void> | undefined {
  const state = get();
  if (!state.currentProjectId) return;
  const ownerId = projectMemoryOwnerId(state.projects, state.currentProjectId);
  return projectAssetSyncBarriers.get(ownerId)?.done;
}
let projectSwitchSequence = 0;

interface CapturedCanvasState {
  projectId: string;
  nodes: AppState['nodes'];
  edges: AppState['edges'];
  groups: AppState['groups'];
  viewportKey: string;
}

interface CaptureProjectSnapshotOptions {
  allowProjectChange?: boolean;
  persistSnapshot?: boolean;
}

let lastCapturedCanvasState: CapturedCanvasState | null = null;
const latestSnapshotCaptures = new Map<string, number>();
let nextSnapshotCaptureId = 1;
if (import.meta.hot) import.meta.hot.dispose(() => {
  // 热更新前启动的截图不能再回写到新版本的 Store。
  latestSnapshotCaptures.clear();
  lastCapturedCanvasState = null;
});

function getCanvasViewportKey(): string {
  if (typeof document === 'undefined') return '';
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  const bounds = document.querySelector<HTMLElement>('.react-flow')?.getBoundingClientRect();
  return `${viewport?.style.transform ?? ''}|${bounds?.width ?? 0},${bounds?.height ?? 0}`;
}

function waitForLoadingPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      resolve();
    };
    // 后台/最小化窗口的 rAF 可能被暂停，不能让返回或项目创建一直等首帧。
    const timer = setTimeout(finish, 100);
    const frame = requestAnimationFrame(() => setTimeout(finish, 0));
  });
}

function isCanvasSnapshotFresh(state: AppState, projectId: string): boolean {
  return lastCapturedCanvasState?.projectId === projectId
    && lastCapturedCanvasState.nodes === state.nodes
    && lastCapturedCanvasState.edges === state.edges
    && lastCapturedCanvasState.groups === state.groups
    && lastCapturedCanvasState.viewportKey === getCanvasViewportKey();
}

async function drainProjectSaveQueue(projectId: string, queue: ProjectSaveQueue): Promise<void> {
  if (queue.running) return;
  queue.running = true;

  try {
    while (queue.pending || queue.pendingBatches?.length || queue.pendingSnapshot) {
      if (!queue.pending && queue.pendingBatches?.length) queue.pending = queue.pendingBatches.shift()!;
      if (!queue.pending) {
        const patch = queue.pendingSnapshot!;
        queue.pendingSnapshot = null;
        try {
          if (confirmedSeriesLibrary?.record.id === projectId) confirmedSeriesLibrary = undefined;
          await updateProjectSnapshot(projectId, patch.snapshot);
          patch.waiters.forEach((waiter) => waiter.resolve(projectId));
        } catch (error) {
          patch.waiters.forEach((waiter) => waiter.reject(error));
        }
        continue;
      }
      const batch = queue.pending;
      queue.pending = queue.pendingBatches?.shift() ?? null;
      queue.active = batch;

      const epoch = seriesLibrarySaveEpoch;
      if (confirmedSeriesLibrary?.record.id === projectId) confirmedSeriesLibrary = undefined;
      try {
        batch.guard?.();
        const saveOptions: [signal?: AbortSignal] = batch.projection ? [batch.projection.signal] : [];
        const savedProjectId = await fileService.saveProject(batch.record, ...saveOptions);
        const owner = seriesLibraryOwners.get(batch.record);
        // 记录队列实际写入的版本，不能把被后续 pending 覆盖的请求误认为已落库。
        if (owner && epoch === seriesLibrarySaveEpoch && savedProjectId === projectId) {
          confirmedSeriesLibrary = { record: batch.record, owner };
        }
        if (savedProjectId === projectId) batch.projection?.commit(queue);
        batch.waiters.forEach((waiter) => waiter.resolve(savedProjectId));
      } catch (error) {
        batch.waiters.forEach((waiter) => waiter.reject(error));
      } finally {
        queue.active = null;
      }
    }
  } finally {
    queue.running = false;
    if (queue.pending || queue.pendingBatches?.length || queue.pendingSnapshot) {
      void drainProjectSaveQueue(projectId, queue);
    } else if (projectSaveQueues.get(projectId) === queue) {
      projectSaveQueues.delete(projectId);
      queue.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }
}

function getProjectSaveQueue(projectId: string): ProjectSaveQueue {
  let queue = projectSaveQueues.get(projectId);
  if (!queue) {
    queue = { running: false, active: null, pending: null, pendingSnapshot: null, idleWaiters: [] };
    projectSaveQueues.set(projectId, queue);
  }
  return queue;
}

function hasSameProjectSaveContent(left: ProjectSaveData, right: ProjectSaveData): boolean {
  const keys = Object.keys(left) as Array<keyof ProjectSaveData>;
  return keys.length === Object.keys(right).length
    && keys.every((key) => key === 'updatedAt' || left[key] === right[key]);
}

function enqueueProjectSnapshot(projectId: string, snapshot: string | undefined): Promise<string> {
  if (nativeKnownIds.has(projectId)) return Promise.resolve(projectId);
  const queue = getProjectSaveQueue(projectId);
  return new Promise((resolve, reject) => {
    if (queue.pendingSnapshot) {
      queue.pendingSnapshot.snapshot = snapshot;
      queue.pendingSnapshot.waiters.push({ resolve, reject });
    } else {
      queue.pendingSnapshot = { snapshot, waiters: [{ resolve, reject }] };
    }
    void drainProjectSaveQueue(projectId, queue);
  });
}

function enqueueProjectSave(record: ProjectSaveData, guard?: () => void, projection?: PendingProjectSave['projection']): Promise<string> {
  if (nativeKnownIds.has(record.id)) return Promise.reject(new Error('新项目不能写入旧项目仓储'));
  guard?.();
  if (projectImportsApplying.has(record.id)) return Promise.reject(new Error('正在应用项目更新，请稍后保存'));
  const barrier = projectAssetSyncBarriers.get(record.id);
  if (barrier) {
    // 屏障前已捕获的节点和项目元数据仍可保存；所属库必须改用屏障释放时的版本。
    return barrier.done.then(() => enqueueProjectSave({ ...record,
      ...(record.dramaAssets ? { dramaAssets: barrier.library } : {}),
    }, guard, projection));
  }
  const queue = getProjectSaveQueue(record.id);

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    const tail = queue.pendingBatches?.at(-1) ?? queue.pending;
    if (tail && !guard && !tail.guard) {
      tail.record = record;
      tail.waiters.push(waiter);
    } else if (tail) {
      (queue.pendingBatches ??= []).push({ record, waiters: [waiter], guard, projection });
    } else if (queue.active && !guard && !queue.active.guard && hasSameProjectSaveContent(queue.active.record, record)) {
      // 同一不可变画布的自动保存与返回保存共用在途写入；新版本仍排队。
      queue.active.waiters.push(waiter);
    } else {
      queue.pending = { record, waiters: [waiter], guard, projection };
    }
    void drainProjectSaveQueue(record.id, queue);
  });
}

function createCurrentProjectSaveRecord(state: AppState): ProjectSaveData | null {
  const projectId = state.currentProjectId;
  const project = state.projects.find((item) => item.id === projectId);
  if (!projectId || !project || state.projectLoadStatus !== 'ready') return null;

  return {
    id: projectId,
    exchangeEpoch: project.exchangeEpoch,
    name: state.projectName,
    createdAt: project.createdAt,
    updatedAt: Date.now(),
    snapshot: project.snapshot,
    dataFolder: project.dataFolder,
    settings: project.settings,
    parentId: project.parentId,
    episodeNo: project.episodeNo,
    episodeOutline: project.episodeOutline,
    episodeScript: project.episodeScript,
    episodeScriptFile: project.episodeScriptFile,
    episodeCreative: project.episodeCreative,
    episodeAssetRoster: project.episodeAssetRoster,
    creationProfile: project.creationProfile,
    teamProfileOverride: project.teamProfileOverride,
    revisionScope: project.revisionScope,
    series: project.series,
    nodes: state.nodes,
    edges: state.edges,
    groups: state.groups,
    dramaAssets: ownedDramaAssets(project, state.dramaAssets),
  };
}

/**
 * 当前画布是一集时，把内存里的角色库回写到剧集项目记录。
 * 剧集项目自身没有画布（switchProject 会重定向到分集），所以整条记录可以
 * 直接用内存中的项目元数据重建，不必先读盘。
 */
function createSeriesLibraryRecord(state: AppState): ProjectSaveData | null {
  const project = state.projects.find((item) => item.id === state.currentProjectId);
  const series = project?.parentId
    ? state.projects.find((item) => item.id === project.parentId)
    : undefined;
  if (!series) return null;

  const record: ProjectSaveData = {
    id: series.id,
    exchangeEpoch: series.exchangeEpoch,
    name: series.name,
    createdAt: series.createdAt,
    updatedAt: Date.now(),
    snapshot: series.snapshot,
    dataFolder: series.dataFolder,
    settings: series.settings,
    creationProfile: series.creationProfile,
    teamProfileOverride: series.teamProfileOverride,
    revisionScope: series.revisionScope,
    series: series.series,
    nodes: EMPTY_SERIES_CANVAS,
    edges: EMPTY_SERIES_CANVAS,
    groups: EMPTY_SERIES_CANVAS,
    dramaAssets: state.dramaAssets,
  };
  seriesLibraryOwners.set(record, series);
  return record;
}

/** 跳过已确认的共享库重复写入；排队/屏障期间仍走原串行保存流程。 */
function enqueueSeriesLibrarySave(record: ProjectSaveData, guard?: () => void): Promise<string> {
  guard?.();
  const confirmed = confirmedSeriesLibrary;
  if (confirmed && confirmed.owner === seriesLibraryOwners.get(record)
    && hasSameProjectSaveContent(confirmed.record, record)
    && !projectSaveQueues.has(record.id) && !projectAssetSyncBarriers.has(record.id)
    && !projectImportsApplying.has(record.id)) return Promise.resolve(record.id);
  return enqueueProjectSave(record, guard);
}

/** 保存当前画布，同时把共享角色库写回它所属的剧集项目。 */
async function saveCurrentProjectRecord(state: AppState, record: ProjectSaveData, guard?: () => void): Promise<string> {
  const libraryRecord = createSeriesLibraryRecord(state);
  const [savedProjectId] = await Promise.all([
    enqueueProjectSave(record, guard),
    libraryRecord ? enqueueSeriesLibrarySave(libraryRecord, guard) : Promise.resolve(undefined),
  ]);
  return savedProjectId;
}

export interface AutoSaveFailureState {
  /** 失败归因：配额用尽 / 磁盘写满 / 项目未加载成功 / 其它 */
  kind: StorageFailureKind | 'load-error';
  reason: string;
  /** 连续失败次数，成功保存后清零 */
  count: number;
  firstAt: number;
  lastAt: number;
  lastNotifiedAt: number;
}

/** 持续失败时的重复提醒间隔：既不刷屏，也不会失败一次之后全程静默 */
const AUTO_SAVE_RENOTIFY_MS = 60_000;

/**
 * 记录一次保存失败。第一次、原因变化、或距上次提醒超过 1 分钟才会再弹 toast，
 * 避免 2 秒一次的自动保存刷屏，同时保证磁盘满/配额满这类持续故障不会被静音。
 */
function noteSaveFailure(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  params: { kind: AutoSaveFailureState['kind']; reason: string; notify: boolean },
): AutoSaveFailureState {
  const now = Date.now();
  const prev = get().autoSaveFailure;
  const count = (prev?.count ?? 0) + 1;
  const shouldNotify = params.notify
    && (!prev || prev.reason !== params.reason || now - prev.lastNotifiedAt >= AUTO_SAVE_RENOTIFY_MS);
  const next: AutoSaveFailureState = {
    kind: params.kind,
    reason: params.reason,
    count,
    firstAt: prev?.firstAt ?? now,
    lastAt: now,
    lastNotifiedAt: shouldNotify ? now : (prev?.lastNotifiedAt ?? now),
  };
  set({ autoSaveFailure: next });
  if (shouldNotify) {
    const prefix = count > 1 ? t('自动保存已连续失败 {count} 次', { count }) : t('自动保存失败');
    get().showToast(t('{prefix}：{reason}。请手动保存 (Ctrl+S) 或导出项目备份', { prefix, reason: params.reason }), 'error');
  }
  return next;
}

function clearSaveFailure(set: ProjectSliceSet, get: ProjectSliceGet) {
  if (get().autoSaveFailure) set({ autoSaveFailure: null });
}

/** 保存异常 → 结构化失败状态（含配额/磁盘归因） */
async function noteSaveError(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  error: unknown,
  notify: boolean,
): Promise<AutoSaveFailureState> {
  const { kind, reason } = await describeStorageError(error);
  return noteSaveFailure(set, get, { kind, reason, notify });
}

export interface SharedProjectAssetSyncApplyInput {
  ownerId: string;
  originProjectId: string;
  expectedLibrary: DramaAssetLibrary;
  nextLibrary?: DramaAssetLibrary;
  commit: Omit<SharedAssetSyncCommitInput, 'project' | 'expectedProjectLibrary' | 'onCommitted'>;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}

export interface ProjectSlice {
  projects: CanvasProject[];
  currentProjectId: string | null;
  projectExecutionContext?: ProjectExpectedContext | null;
  projectName: string;
  projectLoadStatus: ProjectLoadStatus;
  /** 当前 Store 已完成启动加载；重挂载和热更新不能重读磁盘覆盖当前画布。 */
  projectInitialized: boolean;
  isCreatingProject: boolean;
  isReturningToStartPage: boolean;
  /** 正在切换到的画布名；非 null 时显示切换遮罩 */
  switchingProjectName: string | null;
  /** 自动保存持续失败时的诊断状态；成功保存后清空 */
  autoSaveFailure: AutoSaveFailureState | null;
  setProjectName: (name: string) => void;
  renameProject: (id: string, name: string) => Promise<boolean>;
  updateProjectSettings: (settings: ProjectSettings) => Promise<boolean>;
  captureCurrentProjectSnapshot: (
    options?: CaptureProjectSnapshotOptions,
  ) => Promise<string | undefined>;
  createProject: (name?: string, options?: { signal?: AbortSignal }) => Promise<string | undefined>;
  /** 在当前项目所属剧集下批量新增分集（不切画布）；当前项目还不是剧集时先转成剧集。 */
  addEpisodes: (entries: Array<{ name?: string; outline?: string }>) => Promise<string[]>;
  /** 新增一集并切过去。 */
  addEpisode: (name?: string) => Promise<string | undefined>;
  /** 写入当前剧集的原著与剧本；当前项目还不是剧集时先转成剧集。 */
  updateSeriesInfo: (info: Omit<ProjectSeriesInfo, 'storyGraph'>, options?: SeriesInfoWriteOptions) => Promise<boolean>;
  updateStoryGraph: (seriesId: string, patch: StoryGraphPatch, expectedRevision: number,
    guards?: StoryGraphWriteOptions) => Promise<StoryGraph>;
  /** 写入某一集的大纲。兼容既有 Agent 工具。 */
  updateEpisodeOutline: (episodeId: string, outline: string) => Promise<boolean>;
  /** 原子更新某一集的大纲、正文和创作要点。 */
  updateEpisodeCreative: (
    episodeId: string,
    updates: { outline?: string; script?: string; creative?: EpisodeCreativeInfo;
      creationProfile?: import('../types/creationProfile').CreationProfileSelection | null; teamProfileOverride?: import('../types/agentTeam').AgentTeamProfile | null },
    options?: EpisodeCreativeWriteOptions,
  ) => Promise<boolean>;
  /** 只更新当前准确分集的提取清单；expectedRevision 防止覆盖较新的编辑。 */
  updateEpisodeAssetRoster: (episodeId: string, roster: EpisodeAssetRoster, expectedRevision?: number,
    options?: EpisodeAssetRosterWriteOptions) => Promise<boolean>;
  /** 与相邻的一集交换集号；direction 为 -1 上移、1 下移。 */
  moveEpisode: (episodeId: string, direction: -1 | 1) => Promise<boolean>;
  exportProject: (id: string) => Promise<boolean>;
  prepareProjectImport: () => Promise<PreparedProjectImport | null>;
  previewProjectImport: (session: PreparedProjectImport, targetId: string, confirmedBase?: PreparedProjectImport) => Promise<ProjectImportPreview>;
  importProject: (session?: PreparedProjectImport, preview?: ProjectImportPreview | null,
    choices?: Readonly<Record<string, ProjectMergeSide>>, options?: ProjectImportOptions) => Promise<string | undefined>;
  restoreProjectImport: (ownerId: string, recoveryId: string) => Promise<void>;
  /** 事务提交原媒体结果，保存并重载当前画布；原租约失效时不覆盖其他作品。 */
  commitNativeMediaResult: (record: NativeMediaTaskRecord, relativePath: string, expected: ProjectExpectedContext, signal?: AbortSignal) => Promise<void>;
  /** 在冻结本轮生成输入前补齐当前节点和引用素材的落盘身份，不创建历史或提交付费请求。 */
  normalizeNativeMediaGenerationInputs: (nodeId: string, input?: BaseNodeData) => Promise<{
    targetPatch: Partial<BaseNodeData>; nodePatches: Map<string, Partial<BaseNodeData>>;
  }>;
  beginNativeMediaSubmissionPreparation: (expected: import('../types/project').CanvasContext) => Promise<NativeMediaSubmissionPreparation>;
  /** 复制项目（含分集、对话与素材），复制完不切画布。 */
  duplicateProject: (id: string) => Promise<string | undefined>;
  deleteProject: (id: string) => Promise<void>;
  /** 成功返回实际打开的项目 ID；captureSnapshot 仅项目库使用，signal 只在本次加载内存中保留。 */
  switchProject: (id: string, options?: { captureSnapshot?: boolean; signal?: AbortSignal }) => Promise<string | undefined>;
  /** 保存当前画布后返回启动页；保存失败不卸载当前画布。 */
  returnToStartPage: () => Promise<boolean>;
  saveCurrentProject: () => Promise<string | undefined>;
  saveCurrentProjectSilent: (assertCurrent?: () => void) => Promise<string | undefined>;
  applyCharacterVisualReferencePlan: (plan: CharacterVisualReferencePlan, nodeIds: readonly string[], assertCurrent?: () => void) => Promise<number>;
  commitSharedAssetSyncDownload: (input: SharedProjectAssetSyncApplyInput) => Promise<SharedAssetSyncCommitResult>;
  /** 仅刷新项目目录，保留当前画布与已加载正文。 */
  refreshProjectCatalog: () => Promise<void>;
  loadProject: () => Promise<void>;
  initFromDb: () => Promise<void>;
  moveGlobalAssetToFolder: (file: fileService.AssetFileEntry, selection: fileService.AssetFolderSelection,
    options?: fileService.FileTransferOptions) => Promise<{ path: string; moved: boolean }>;
  renameAssetFile: (file: fileService.AssetFileEntry, name: string, projectId?: string) => Promise<fileService.AssetFileRenameResult>;
  repairAssetLocations: (preview: AssetRepairPreview, assetIds: readonly string[], options?: DramaAssetWriteOptions) => Promise<number>;
  cleanupMissingAssets: (preview: AssetRepairPreview, assetIds: readonly string[], options?: DramaAssetWriteOptions) => Promise<number>;
}

type ProjectSliceSet = Parameters<StateCreator<AppState, [], [], ProjectSlice>>[0];
type ProjectSliceGet = Parameters<StateCreator<AppState, [], [], ProjectSlice>>[1];

/**
 * 重命名事务的补偿动作：把物理目录、文件夹名映射、内存中的项目名与素材路径一并
 * 恢复到重命名前的状态。缺少它时，目录已改名而记录未落盘，重启后会按旧 dataFolder
 * 去找已经改名的目录，导致素材全部丢失。
 */
async function rollbackProjectRename(params: {
  set: ProjectSliceSet;
  get: ProjectSliceGet;
  id: string;
  previousProject: CanvasProject;
  previousDataFolder: string | undefined;
  renamed: fileService.ProjectDataDirRenameResult | null;
}): Promise<void> {
  const { set, get, id, previousProject, previousDataFolder, renamed } = params;
  try {
    await fileService.revertProjectDataDirRename(id, renamed, previousDataFolder);

    const current = get();
    const restoredNodes = renamed && current.currentProjectId === id
      ? await remapProjectNodePaths(current.nodes, renamed.newDir, renamed.oldDir)
      : null;

    set((state) => ({
      ...(state.currentProjectId === id
        ? { projectName: previousProject.name, ...(restoredNodes ? { nodes: restoredNodes } : {}) }
        : {}),
      projects: state.projects.map((item) => (
        item.id === id
          ? {
            ...item,
            name: previousProject.name,
            updatedAt: previousProject.updatedAt,
            dataFolder: previousDataFolder,
          }
          : item
      )),
    }));
  } catch (error) {
    console.error('[项目重命名] 回滚失败:', error);
  }
}

/**
 * 把普通项目转成剧集：新建一个只存原著/剧本与共享角色库的剧集项目，
 * 原项目原地变成第 1 集。画布、对话、输出历史都留在原记录上不动，
 * 只有角色库和项目记忆改挂到剧集项目，素材目录两者共用同一个。
 */
async function promoteProjectToSeries(params: {
  set: ProjectSliceSet;
  get: ProjectSliceGet;
  project: CanvasProject;
}): Promise<string | undefined> {
  const { set, get, project } = params;
  const seriesId = generateProjectId();
  const now = Date.now();
  // 旧项目可能没有 dataFolder（按 id 回退定位目录），此时用 id 当文件夹名指向同一个目录。
  const dataFolder = project.dataFolder ?? project.id;

  try {
    await enqueueProjectSave({
      id: seriesId,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: now,
      dataFolder,
      settings: project.settings,
      nodes: [],
      edges: [],
      groups: [],
      dramaAssets: get().dramaAssets,
    });
  } catch (error) {
    console.warn('[转为剧集] 剧集项目保存失败:', error);
    return undefined;
  }

  fileService.registerProjectFolder(seriesId, dataFolder);
  await reassignProjectMemories(project.id, seriesId)
    .catch((error) => console.warn('[转为剧集] 项目记忆改挂失败:', error));

  // 原来的项目名留给剧集，画布本身改叫第 1 集，免得剧集和第一集重名。
  const firstEpisodeName = '第 1 集';
  set((state) => ({
    ...(state.currentProjectId === project.id ? { projectName: firstEpisodeName } : {}),
    projects: [
      ...state.projects.map((item) => (
        item.id === project.id
          ? {
            ...item,
            name: firstEpisodeName,
            parentId: seriesId,
            episodeNo: item.episodeNo ?? 1,
            dataFolder,
          }
          : item
      )),
      {
        id: seriesId,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: now,
        dataFolder,
        settings: project.settings,
      },
    ],
    projectMemories: state.projectMemories.map((memory) => (
      memory.projectId === project.id ? { ...memory, projectId: seriesId } : memory
    )),
  }));
  // 立刻把 parentId 落盘：否则中途退出会留下一个空剧集，原项目还当自己是顶层项目。
  if (get().currentProjectId === project.id) await get().saveCurrentProjectSilent();
  return seriesId;
}

/** 取当前项目所属的剧集 id；还是普通项目时先转成剧集。 */
async function ensureCurrentSeriesId(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
): Promise<string | undefined> {
  const state = get();
  const current = state.projects.find((item) => item.id === state.currentProjectId);
  if (!current) return undefined;
  return current.parentId ?? await promoteProjectToSeries({ set, get, project: current });
}

/**
 * 改某个项目的元数据并落盘。当前画布用内存里的实时状态保存，其他项目读盘后打补丁再存，
 * 免得把还没保存的画布覆盖成磁盘上的旧版本。
 */
async function patchProjectRecord(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  projectId: string,
  patch: Partial<CanvasProject>,
  rollbackRosterOnly = false,
  assertCurrent?: () => void,
): Promise<boolean> {
  assertCurrent?.();
  const previous = get().projects.find((item) => item.id === projectId);
  if (!previous) return false;
  const updatedAt = Date.now();
  let navigationCanceled = false;
  const originProjectId = get().currentProjectId;
  // 这里只复用项目离开时的取消生命周期，不以画布 revision 拒绝无关拖动。
  const navigationGuard = originProjectId !== projectId
    ? registerCanvasImport({ currentProjectId: originProjectId, nodes: [], getCurrentRevision: () => 0 },
      () => { navigationCanceled = true; }) : null;

  set((state) => ({
    projects: state.projects.map((item) => (
      item.id === projectId ? { ...item, ...patch, updatedAt } : item
    )),
  }));

  try {
    const assertPatchCurrent = () => {
      if (navigationCanceled) throw new Error('画布曾切换，未提交旧分集的磁盘快照');
      assertCurrent?.();
      const current = get().projects.find((item) => item.id === projectId);
      if (!current || (Object.keys(patch) as Array<keyof CanvasProject>).some((field) => current[field] !== patch[field])) {
        throw new Error('目标字段已变化，未确认旧稿保存');
      }
    };
    if (get().currentProjectId === projectId) {
      if (await get().saveCurrentProjectSilent(assertPatchCurrent) !== projectId) throw new Error('当前画布保存失败');
    } else {
      // 刚离开的分集可能仍有完整画布自动保存在途，必须先读到它真正落盘后的节点。
      await waitForProjectSaveQueue(projectId);
      assertPatchCurrent();
      const record = await fileService.loadProjectData(projectId);
      if (!record) throw new Error('无法读取项目数据');
      assertPatchCurrent();
      const latest = get();
      if (latest.projectLoadStatus !== 'ready' || latest.switchingProjectName !== null
        || latest.isCreatingProject || latest.isReturningToStartPage) throw new Error('项目导航中，已保留稿件修改');
      // 读取磁盘期间目标可能已被外部分集列表激活；此时只能保存实时画布，不能回写旧 nodes。
      if (latest.currentProjectId === projectId) {
        if (await latest.saveCurrentProjectSilent(assertPatchCurrent) !== projectId) throw new Error('当前画布保存失败');
      } else {
        await enqueueProjectSave({ ...record, ...patch, updatedAt }, () => {
          assertPatchCurrent();
          if (get().currentProjectId === projectId || get().projectLoadStatus !== 'ready'
            || get().switchingProjectName !== null || get().isCreatingProject || get().isReturningToStartPage) {
            throw new Error('画布已切换，未提交磁盘中的旧画布快照');
          }
        });
      }
    }
    assertPatchCurrent();
    return true;
  } catch (error) {
    console.warn('[项目元数据] 保存失败:', error);
    set((state) => ({
      projects: state.projects.map((item) => {
        if (item.id !== projectId) return item;
        if (rollbackRosterOnly) {
          // 旧保存失败只能撤回仍是本次值的清单，不能恢复整个旧项目覆盖后来的编辑。
          return item.episodeAssetRoster === patch.episodeAssetRoster ? {
            ...item, episodeAssetRoster: previous.episodeAssetRoster,
            updatedAt: item.updatedAt === updatedAt ? previous.updatedAt : item.updatedAt,
          } : item;
        }
        // 失败只撤回仍属于本次补丁的字段，不能用整份旧元数据覆盖后来的修改。
        const restored = { ...item };
        for (const field of Object.keys(patch) as Array<keyof CanvasProject>) {
          if (item[field] === patch[field]) Object.assign(restored, { [field]: previous[field] });
        }
        if (item.updatedAt === updatedAt) restored.updatedAt = previous.updatedAt;
        return restored;
      }),
    }));
    get().showToast('保存失败，改动已回滚', 'error');
    return false;
  } finally {
    if (navigationGuard) completeCanvasDerivation(navigationGuard);
  }
}

export const createProjectSlice: StateCreator<AppState, [], [], ProjectSlice> = (set, get, api) => {
  const live: AppState | undefined = get();
  // 首次应用这次热更新时，旧 Store 还没有标记；已就绪的画布要沿用内存。
  const initialized = live?.projectInitialized
    ?? (live?.projectLoadStatus === 'ready' && typeof live?.initFromDb === 'function');
  return {
  projects: [
    { id: 'default', name: '默认画布', createdAt: Date.now(), updatedAt: Date.now() },
  ],
  currentProjectId: 'default',
  projectExecutionContext: undefined,
  projectName: '新项目',
  projectLoadStatus: 'loading',
  projectInitialized: initialized,
  isCreatingProject: false,
  isReturningToStartPage: false,
  switchingProjectName: null,
  autoSaveFailure: null,

  normalizeNativeMediaGenerationInputs: async (nodeId, input) => {
    const before = get(), context = before.projectExecutionContext;
    if (context?.modelGeneration !== 1) return { targetPatch: {}, nodePatches: new Map() };
    const runtime = nativeRuntime.get(get), target = before.nodes.find((node) => node.id === nodeId);
    if (context.kind !== 'canvas' || !runtime || runtime.activeId !== context.canvasId || !target) {
      throw new Error('原画布或生成节点已变化，未准备参考素材');
    }
    const revision = before.getCurrentRevision();
    const material = nativeMediaInputMaterial(target, before, 'media-input-v3');
    const references = new Set([nodeId, ...before.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source)]);
    const parameters = input ?? target.data;
    const mentionText = JSON.stringify([parameters.prompt, parameters.workflowInputs, parameters.videoReferences,
      parameters.comfyRefmods, parameters.cameraSettings]);
    const byId = new Map(before.nodes.map((node) => [node.id, node]));
    for (const match of mentionText.matchAll(/@\{([^}:]+)(?::[^}]*)?\}/g)) {
      references.add(byId.has(match[1]) ? match[1] : match[1].split(/\/(?:cell|shot)\//)[0]);
    }
    const originals = before.nodes.filter((node) => references.has(node.id));
    const assertCurrent = () => {
      const current = get(), live = current.nodes.find((node) => node.id === nodeId);
      if (nativeRuntime.get(get) !== runtime || projectImportsApplying.has(context.projectId)
        || projectAssetSyncBarriers.has(context.projectId) || current.getCurrentRevision() !== revision
        || !isProjectExpectedContextCurrent(context, current, { checkCanvasRevision: false }) || !live
        || nativeMediaInputMaterial(live, current, 'media-input-v3') !== material) {
        throw new Error('生成输入或参考素材已变化，未提交请求');
      }
      const liveById = new Map(current.nodes.map((node) => [node.id, node]));
      for (const original of originals) {
        const node = liveById.get(original.id);
        if (!node || node.type !== original.type || NORMALIZED_MEDIA_FIELDS.some((field) => (
          !configValuesEqual(node.data[field], original.data[field])
        ))) throw new Error('节点媒体已变化，未覆盖新内容');
      }
    };
    assertCurrent();
    let normalized: Node<BaseNodeData>[];
    try { normalized = await normalizeProjectMediaNodes(context.canvasId, originals); }
    catch {
      assertCurrent();
      throw new Error('参考素材身份准备失败，请检查文件后重试');
    }
    assertCurrent();
    const normalizedById = new Map(normalized.map((node) => [node.id, node]));
    const originalById = new Map(originals.map((node) => [node.id, node]));
    const targetPatch: Partial<BaseNodeData> = {};
    const nodePatches = new Map<string, Partial<BaseNodeData>>();
    set((state) => {
      let changed = false;
      const nodes = state.nodes.map((node) => {
        const original = originalById.get(node.id), resolved = normalizedById.get(node.id);
        if (!original || !resolved) return node;
        let data: BaseNodeData | undefined;
        const patch: Partial<BaseNodeData> = {};
        for (const field of NORMALIZED_MEDIA_FIELDS) {
          if (configValuesEqual(original.data[field], resolved.data[field])) continue;
          data ??= { ...node.data };
          if (Object.hasOwn(resolved.data, field)) data[field] = resolved.data[field] as never;
          else delete data[field];
          patch[field] = resolved.data[field] as never;
          if (node.id === nodeId) targetPatch[field] = resolved.data[field] as never;
        }
        if (!data) return node;
        nodePatches.set(node.id, patch);
        changed = true;
        return { ...node, data };
      });
      return changed ? { nodes } : state;
    });
    return { targetPatch, nodePatches };
  },

  beginNativeMediaSubmissionPreparation: async (expected) => {
    const context = structuredClone(expected), runtime = nativeRuntime.get(get);
    const assertContext = () => {
      const state = get();
      if (context.modelGeneration !== 1 || !context.runtimeEpoch || !runtime || nativeRuntime.get(get) !== runtime
        || runtime.activeId !== context.canvasId || projectImportsApplying.has(context.projectId)
        || projectAssetSyncBarriers.has(context.projectId)
        || !isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false })) throw new Error('原画布准备上下文已变化，未提交生成');
    };
    assertContext();
    if (!runtime) throw new Error('原画布保存基线不可用');
    const prior = runtime.tail;
    let unlock!: () => void, released = false, ready = false;
    runtime.tail = new Promise<void>((resolve) => { unlock = resolve; });
    const release = () => { if (!released) { released = true; unlock(); } };
    try {
      // 先占原队列位置，再读取fresh状态强制保存；不能在自己的slot内重排saveSilent。
      await prior; assertContext();
      const state = get(), record = createCurrentProjectSaveRecord(state);
      if (!record || record.id !== context.canvasId) throw new Error('原画布准备保存上下文不可用');
      await saveNativeCurrentProject(get, state, record, assertContext, runtime);
      assertContext();
      const canvas = runtime.loaded.selection.canvas;
      if (!canvas || canvas.id !== context.canvasId) throw new Error('原画布准备基线不可用');
      ready = true;
      return Object.freeze({ context: Object.freeze(context), canvasRevision: canvas.revision,
        assertCurrent: () => { if (released || !ready) throw new Error('媒体提交准备租约已释放'); assertContext(); }, release });
    } catch (error) { release(); throw error; }
  },

  commitNativeMediaResult: async (record, relativePath, expected, signal) => {
    signal?.throwIfAborted();
    const { safeExchangePath } = await import('../services/projectExchangeDomain');
    if (record.category !== 'video' && !['media-input-v2', 'media-input-v3'].includes(record.fingerprintScheme ?? '') || safeExchangePath(relativePath) !== relativePath
      || expected.kind !== 'canvas' || expected.canvasId !== record.canvasId || expected.projectId !== record.ownerProjectId
      || !isProjectExpectedContextCurrent(expected, get(), { checkCanvasRevision: false })) throw new Error('原画布已切换，媒体结果已保留');
    const assertSource = async () => {
      signal?.throwIfAborted();
      const state = get(), node = state.nodes.find((item) => item.id === record.nodeId);
      if (!node) throw new Error('原视频节点或参考素材已变化，结果已保留');
      const inputMaterial = ['media-input-v2', 'media-input-v3'].includes(record.fingerprintScheme ?? '')
        ? (target: Node<BaseNodeData>, current: AppState) => nativeMediaInputMaterial(target, current, record.fingerprintScheme === 'media-input-v3' ? 'media-input-v3' : 'media-input-v2') : videoInputFingerprintMaterial;
      const material = inputMaterial(node, state);
      if (material.includes('@drama{') && !record.recovery) throw new Error('原视频引用了尚不可安全验证的全局素材，结果已保留');
      const digest = await sha256BytesHex(new TextEncoder().encode(material));
      const latest = get(), latestNode = latest.nodes.find((item) => item.id === record.nodeId);
      if (digest !== record.inputFingerprint || !latestNode || material !== inputMaterial(latestNode, latest)
        || !isProjectExpectedContextCurrent(expected, latest, { checkCanvasRevision: false })) throw new Error('原视频节点或参考素材已变化，结果已保留');
      return material;
    };
    await assertSource();
    if (await get().saveCurrentProjectSilent() !== record.canvasId
      || !isProjectExpectedContextCurrent(expected, get(), { checkCanvasRevision: false })) throw new Error('原画布保存失败或已切换，媒体结果已保留');
    const runtime = nativeRuntime.get(get);
    if (!runtime || runtime.activeId !== record.canvasId || (runtime.mediaGeneration ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error('原画布保存基线不可用，媒体结果已保留');
    const prior = runtime.tail;
    let release!: () => void;
    runtime.tail = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    let unsubscribe = () => {};
    try {
      await prior;
      const material = await assertSource();
      if (nativeRuntime.get(get) !== runtime) throw new Error('原画布已重新加载，媒体结果保留');
      const expectedCanvasRevision = runtime.loaded.selection.canvas?.revision;
      const expectedAssetsRevision = runtime.loaded.content.revisions.assets;
      const before = get();
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        const current = get(), node = current.nodes.find((item) => item.id === record.nodeId);
        const inputMaterial = ['media-input-v2', 'media-input-v3'].includes(record.fingerprintScheme ?? '')
          ? (target: Node<BaseNodeData>, state: AppState) => nativeMediaInputMaterial(target, state, record.fingerprintScheme === 'media-input-v3' ? 'media-input-v3' : 'media-input-v2') : videoInputFingerprintMaterial;
        if (nativeRuntime.get(get) !== runtime || !node || current.nodes !== before.nodes || current.edges !== before.edges
          || current.groups !== before.groups || current.dramaAssets !== before.dramaAssets
          || inputMaterial(node, current) !== material
          || !isProjectExpectedContextCurrent(expected, current, { checkCanvasRevision: false })) throw new Error('原画布在媒体交付期间变化，产物已保留');
      };
      unsubscribe = api.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
      assertCurrent();
      if (record.imageReference) {
        const { readNativeVideoImageReference } = await import('../services/nativeVideoImageReference');
        await readNativeVideoImageReference(record.ownerProjectId, record.imageReference);
        assertCurrent();
      }
      const snapshot = await readNativeProjectCapture(record.ownerProjectId);
      const canvas = snapshot?.aggregate.canvases.find((item) => item.id === record.canvasId);
      if (!snapshot || !canvas || canvas.epoch !== record.canvasEpoch || canvas.episodeId !== record.episodeId
        || canvas.revision !== expectedCanvasRevision || snapshot?.aggregate.content.revisions.assets !== expectedAssetsRevision
        || nativeRuntime.get(get) !== runtime) throw new Error('原画布或共享素材已变化，媒体结果已保留');
      const resultRootRef = snapshot.aggregate.project.storageRootRef;
      let nodes = canvas.nodes.map((value) => {
        if (!value || typeof value !== 'object' || (value as { id?: unknown }).id !== record.nodeId) return value;
        const node = structuredClone(value) as { data?: Record<string, unknown> };
        if (!node.data || node.data.type !== (record.targetNodeType ?? `ai-${record.category}`)) throw new Error('原媒体节点已变化，媒体结果已保留');
        const mediaKey = record.category === 'video' ? 'videoUrl' : record.category === 'image' ? 'imageUrl' : 'audioUrl';
        const data: Record<string, unknown> = { ...node.data, [mediaKey]: relativePath, output: relativePath, sourceUrl: relativePath,
          ...(record.category !== 'audio' ? { thumbnailUrl: relativePath } : {}), relativePath, storageRootRef: resultRootRef, status: 'success', error: undefined,
          artifactId: `native-media-${record.operationId}`, videoTaskState: undefined, mediaTaskState: undefined, mediaTaskStage: undefined };
        delete data.filePath; delete data.assetId;
        return { ...node, data };
      });
      if ('apimartImageBatch' in record && record.apimartImageBatch) {
        const { buildNativeImageBatchCanvas } = await import('../services/nativeImageBatchCanvas');
        nodes = buildNativeImageBatchCanvas(canvas, record, resultRootRef).nodes;
      } else if (record.localResults) {
        const { buildNativeMediaCollectionCanvas } = await import('../services/nativeMediaCollectionCanvas');
        nodes = buildNativeMediaCollectionCanvas(canvas, record, resultRootRef).nodes;
      }
      const selected = before.projects.find((item) => item.id === record.canvasId);
      if (!selected) throw new Error('原画布目录不可用，产物已保留');
      const restored = await restoreProjectRecord({ ...selected, nodes, edges: canvas.edges, groups: canvas.groups,
        dramaAssets: runtime.loaded.content.dramaAssets });
      assertCurrent();
      const { createNativeMediaDisplayResolver, nativeMediaContentDigest } = await import('../services/nativeMediaDisplay');
      const { nativeMediaLocalOutputs } = await import('../services/nativeMediaCollection');
      const { nativeMediaOutputNodeId } = await import('../services/nativeMediaCollectionCanvas');
      const files = nativeMediaLocalOutputs(record);
      // 老异步回执没有集合字段时也只接受明确摘要路径，不按普通文件名猜配已付费结果。
      const digest = nativeMediaContentDigest(relativePath);
      const displayFiles = files.length ? files : digest ? [{ relativePath, sha256: digest, category: record.category }] : [];
      const displays = createNativeMediaDisplayResolver(snapshot.aggregate.project);
      const displayPatches = new Map<string, Record<string, unknown>>();
      for (const [ordinal, file] of displayFiles.entries()) {
        assertCurrent();
        const id = ordinal ? nativeMediaOutputNodeId(record, ordinal) : record.nodeId;
        const projected = (restored.nodes as Node<BaseNodeData>[]).find((node) => node.id === id);
        if (!projected || projected.data.relativePath !== file.relativePath || projected.data.storageRootRef !== resultRootRef) throw new Error('原媒体候选展示身份已变化，产物已保留');
        const display = await displays(resultRootRef, file);
        assertCurrent();
        const mediaKey = file.category === 'image' ? 'imageUrl' : file.category === 'video' ? 'videoUrl' : 'audioUrl';
        displayPatches.set(id, { [mediaKey]: display.url, output: display.url, sourceUrl: display.url,
          ...(file.category !== 'audio' ? { thumbnailUrl: display.url } : {}), filePath: display.filePath });
      }
      const projectedNodes = (restored.nodes as Node<BaseNodeData>[]).map((node) => {
        const patch = displayPatches.get(node.id);
        if (!patch) return node;
        const data = { ...node.data, ...patch } as BaseNodeData;
        delete data.__nativeUnavailableMediaFields;
        return { ...node, data };
      });
      const primary = projectedNodes.find((node) => node.id === record.nodeId);
      const primaryMedia = primary?.data[record.category === 'image' ? 'imageUrl' : record.category === 'video' ? 'videoUrl' : 'audioUrl'];
      if (typeof primaryMedia !== 'string' || !primaryMedia || primaryMedia === relativePath) throw new Error('原媒体展示地址尚不可用，产物已保留');
      assertCurrent();
      const { commitNativeMediaDelivery } = await import('../services/nativeMediaDelivery');
      assertCurrent();
      await commitNativeMediaDelivery({ record, expectedCanvasRevision: canvas.revision, expectedAssetsRevision,
        document: { nodes, edges: canvas.edges, groups: canvas.groups } }, { signal: controller.signal, onCommitted: (committed) => {
          unsubscribe(); unsubscribe = () => {};
          // 幂等回执不能把前置保存已推进的版本倒退，也不重复投影或记历史。
          if (committed.alreadyCommitted) return;
          // 在complete事件中先推进保存基线；Promise后续continuation不得再写Store。
          runtime.loaded = { ...runtime.loaded, selection: { ...runtime.loaded.selection,
            canvas: { ...canvas, nodes, revision: committed.canvasRevision }, changeRevision: committed.changeRevision,
            context: { ...runtime.loaded.selection.context, canvasRevision: committed.canvasRevision } } };
          runtime.mediaGeneration = (runtime.mediaGeneration ?? 0) + 1;
          const current = get();
          if (nativeRuntime.get(get) !== runtime || current.currentProjectId !== record.canvasId) return;
          const rebased = rebaseCommittedMediaNodes(before.nodes, current.nodes, projectedNodes, record.nodeId);
          if (rebased === current.nodes) return;
          let historyFailure: unknown;
          try { get().commitToHistory(); } catch (error) { historyFailure = error; }
          try { set({ nodes: rebased }); } finally { get().incrementRevision(); }
          if (get().historyPanelOpen) void get().loadHistoryFromDb();
          if (historyFailure) throw historyFailure;
        } });
    } finally { unsubscribe(); signal?.removeEventListener('abort', cancel); release(); }
  },

  moveGlobalAssetToFolder: async (file, selection, options) => fileService.moveAssetFile(
    file, selection, get().config.assetFolders ?? [], (move) => {
      // 按最新状态迁移精确路径，不把异步操作开始时的旧画布覆盖回来。
      const state = get();
      if (relocateMediaReferences(state.nodes, [move]) !== state.nodes) state.commitToHistory();
      set((current) => ({ ...relocateMediaReferences(current, [move]), recentAssetsRevision: current.recentAssetsRevision + 1 }));
    }, options),

  renameAssetFile: async (file, name, projectId) => fileService.renameAssetFile(
    file, name, projectId, get().config.assetFolders ?? [], (move) => {
      const state = get();
      if (relocateMediaReferences(state.nodes, [move]) !== state.nodes) state.commitToHistory();
      set((current) => ({ ...relocateMediaReferences(current, [move]), recentAssetsRevision: current.recentAssetsRevision + 1 }));
    }),

  repairAssetLocations: async (preview, assetIds, options = {}) => {
    const initialRoot = get().config.baseDataDir;
    const assertCurrent = () => {
      assertDramaAssetWriteCurrent(options);
      if (get().config.baseDataDir !== initialRoot) throw new Error(t('素材根目录已变化，请重新预览'));
      if (preview.target.kind === 'folder' && !(get().config.assetFolders ?? []).includes(preview.target.path)) {
        throw new Error(t('原目录引用已移除，请重新选择'));
      }
    };
    assertCurrent();
    return applyAssetRepairs(preview, assetIds, get().config.assetFolders ?? [], (moves) => {
      const state = get();
      if (relocateMediaReferences(state.nodes, moves) !== state.nodes) state.commitToHistory();
      set((current) => ({ ...relocateMediaReferences(current, moves), recentAssetsRevision: current.recentAssetsRevision + 1 }));
      if (preview.target.kind === 'folder' && preview.selectedRoot) {
        const oldRoot = preview.target.path;
        const selectedRoot = preview.selectedRoot;
        const current = get().config.assetFolders ?? [];
        const allRepaired = !preview.truncated && preview.candidates.length > 0 && preview.candidates.every((candidate) => assetIds.includes(candidate.index.assetId));
        const assetFolders = allRepaired ? current.map((root) => root === oldRoot ? selectedRoot : root)
          : [...current, selectedRoot];
        get().updateConfig({ assetFolders: [...new Set(assetFolders)] });
      }
    }, { ...options, assertCurrent });
  },

  cleanupMissingAssets: async (preview, assetIds, options = {}) => {
    const initialRoot = get().config.baseDataDir;
    const assertCurrent = () => {
      assertDramaAssetWriteCurrent(options);
      if (get().config.baseDataDir !== initialRoot) throw new Error(t('素材根目录已变化，请重新预览'));
      if (preview.target.kind === 'folder' && !(get().config.assetFolders ?? []).includes(preview.target.path)) {
        throw new Error(t('原目录引用已移除，请重新选择'));
      }
    };
    assertCurrent();
    return cleanupUnavailableAssets(preview, assetIds, ({ historyIds, deletedHistoryCounts }) => {
      const removed = new Set(historyIds);
      set((state) => {
        const records = state.outputHistoryRecords.filter((record) => !removed.has(record.id));
        const totalCount = Math.max(0, state.historyTotalCount - (state.historyProjectId ? deletedHistoryCounts[state.historyProjectId] ?? 0 : 0));
        return { outputHistoryRecords: records, historyTotalCount: totalCount,
          historyHasMore: state.historyHasMore && totalCount > records.length, recentAssetsRevision: state.recentAssetsRevision + 1 };
      });
      void get().refreshHistoryAfterAssetCleanup();
    }, { ...options, assertCurrent });
  },

  setProjectName: (name) => {
    const state = get();
    const currentProjectId = state.currentProjectId;
    if (!currentProjectId) {
      set({ projectName: name });
      return;
    }
    if (state.projects.find((project) => project.id === currentProjectId)?.name === name.trim()) return;
    void get().renameProject(currentProjectId, name);
  },

  renameProject: async (id, name) => serializeEpisodeCreativeWrite(id, async () => {
    const nextName = name.trim();
    if (!nextName) return false;

    const native = nativeBinding(get().projects.find((item) => item.id === id));
    if (native) return mutateNativeMetadata(set, get, native, async ({ aggregate }) => {
      if (native.episodeId) {
        const episode = aggregate.episodes.find((item) => item.id === native.episodeId);
        if (!episode) throw new Error('分集不存在');
        await updateNativeEpisodeMetadata({ projectId: native.projectId, expectedProjectEpoch: aggregate.project.epoch,
          episodeId: episode.id, expectedEpisodeRevision: episode.revision, name: nextName });
      } else await updateNativeProjectMetadata({ projectId: native.projectId, expectedProjectEpoch: aggregate.project.epoch, name: nextName });
    });

    if (get().currentProjectId !== id) await waitForProjectSaveQueue(id);
    const initialState = get();
    const project = initialState.projects.find((item) => item.id === id);
    if (!project) return false;
    if (initialState.currentProjectId === id && initialState.projectLoadStatus !== 'ready') {
      get().showToast('项目尚未成功加载，已阻止重命名保存', 'error');
      return false;
    }

    const persistedProject = initialState.currentProjectId === id
      ? null
      : await fileService.loadProjectData(id);
    if (initialState.currentProjectId !== id && !persistedProject) {
      get().showToast('无法读取项目，重命名失败', 'error');
      return false;
    }

    const updatedAt = Date.now();
    // 分集与剧集共用一个素材目录，改分集名不能动目录，否则整部剧的素材路径都会失效。
    const nextDataFolder = project.parentId
      ? project.dataFolder
      : fileService.buildProjectFolderName(nextName, id);
    const oldDataFolder = project.dataFolder;
    const dataFolderChanged = Boolean(nextDataFolder) && oldDataFolder !== nextDataFolder;

    set((state) => ({
      ...(state.currentProjectId === id ? { projectName: nextName } : {}),
      projects: state.projects.map((item) =>
        item.id === id ? { ...item, name: nextName, updatedAt } : item
      ),
    }));

    let renamed: fileService.ProjectDataDirRenameResult | null = null;
    try {
      renamed = dataFolderChanged && nextDataFolder
        ? await fileService.renameProjectDataDir(id, oldDataFolder, nextDataFolder)
        : null;
      const latest = get();
      if (!latest.projects.some((item) => item.id === id)) return false;

      let nextNodes: Node<BaseNodeData>[];
      let record: ProjectSaveData;
      if (latest.currentProjectId === id) {
        nextNodes = renamed
          ? await remapProjectNodePaths(latest.nodes, renamed.oldDir, renamed.newDir)
          : latest.nodes;
        const latestProject = latest.projects.find((item) => item.id === id)!;
        record = {
          id,
          exchangeEpoch: latestProject.exchangeEpoch,
          name: nextName,
          createdAt: latestProject.createdAt,
          updatedAt,
          snapshot: latestProject.snapshot,
          dataFolder: renamed?.dataFolder ?? latestProject.dataFolder,
          settings: latestProject.settings,
          parentId: latestProject.parentId,
          episodeNo: latestProject.episodeNo,
          episodeOutline: latestProject.episodeOutline,
          episodeScript: latestProject.episodeScript,
          episodeScriptFile: latestProject.episodeScriptFile,
          episodeCreative: latestProject.episodeCreative,
          episodeAssetRoster: latestProject.episodeAssetRoster,
          series: latestProject.series,
          nodes: nextNodes,
          edges: latest.edges,
          groups: latest.groups,
          dramaAssets: ownedDramaAssets(latestProject, latest.dramaAssets),
        };
      } else {
        const source = persistedProject ?? await fileService.loadProjectData(id);
        if (!source) throw new Error('无法读取项目数据');
        nextNodes = renamed
          ? await remapProjectNodePaths(source.nodes as Node<BaseNodeData>[], renamed.oldDir, renamed.newDir)
          : source.nodes as Node<BaseNodeData>[];
        record = {
          ...source,
          name: nextName,
          updatedAt,
          dataFolder: renamed?.dataFolder ?? source.dataFolder,
          nodes: nextNodes,
        };
      }

      set((state) => ({
        ...(state.currentProjectId === id ? { projectName: nextName, nodes: nextNodes } : {}),
        projects: state.projects.map((item) => (
          item.id === id
            ? { ...item, name: nextName, updatedAt, dataFolder: record.dataFolder }
            : item
        )),
      }));
      await enqueueProjectSave(record);
      return true;
    } catch (error) {
      console.warn('[项目重命名] 保存失败，开始回滚:', error);
      await rollbackProjectRename({
        get,
        set,
        id,
        previousProject: project,
        previousDataFolder: oldDataFolder,
        renamed,
      });
      get().showToast('项目重命名失败，已恢复原名称', 'error');
      return false;
    }
  }),

  updateProjectSettings: async (settings) => {
    const state = get();
    const projectId = state.currentProjectId;
    const previousProject = state.projects.find((project) => project.id === projectId);
    if (!projectId || !previousProject) return false;
    if (state.projectLoadStatus !== 'ready') {
      get().showToast('项目尚未成功加载，已阻止设置保存', 'error');
      return false;
    }

    const native = nativeBinding(previousProject);
    if (native) return mutateNativeMetadata(set, get, native, async ({ aggregate }) => {
      const record = createCurrentProjectSaveRecord(get());
      if (!record || record.id !== projectId) throw new Error('当前项目已切换');
      const serialized = await serializeProjectRecord({ ...record, settings: normalizeProjectSettings(settings) });
      if (!serialized.settings) throw new Error('项目设置无法保存');
      if (native.episodeId) {
        const episode = aggregate.episodes.find((item) => item.id === native.episodeId);
        if (!episode) throw new Error('分集不存在');
        await updateNativeEpisodeMetadata({ projectId: native.projectId, expectedProjectEpoch: aggregate.project.epoch,
          episodeId: episode.id, expectedEpisodeRevision: episode.revision,
          settingsPolicy: nativeEpisodeSettings(serialized.settings, aggregate.project.defaultSettings) });
      } else await updateNativeProjectMetadata({ projectId: native.projectId, expectedProjectEpoch: aggregate.project.epoch,
        defaultSettings: serialized.settings });
    });

    const nextProject: CanvasProject = {
      ...previousProject,
      settings: normalizeProjectSettings(settings),
      updatedAt: Date.now(),
    };
    set((current) => ({
      projects: current.projects.map((project) => (
        project.id === projectId ? nextProject : project
      )),
    }));

    try {
      const record = createCurrentProjectSaveRecord(get());
      if (!record || record.id !== projectId) throw new Error('当前项目已切换，无法保存项目设置');
      await enqueueProjectSave({ ...record, updatedAt: nextProject.updatedAt });
      get().showToast('项目设置已保存');
      return true;
    } catch (error) {
      console.error('Save project settings failed:', error);
      set((current) => ({
        projects: current.projects.map((project) => (
          project.id === projectId ? previousProject : project
        )),
      }));
      get().showToast('项目设置保存失败', 'error');
      return false;
    }
  },

  captureCurrentProjectSnapshot: async (options = {}) => {
    const state = get();
    const projectId = state.currentProjectId;
    const project = state.projects.find((item) => item.id === projectId);
    if (!projectId || !project || state.projectLoadStatus !== 'ready') return undefined;

    const captureId = nextSnapshotCaptureId++;
    latestSnapshotCaptures.set(projectId, captureId);
    if (state.nodes.length === 0) {
      latestSnapshotCaptures.delete(projectId);
      lastCapturedCanvasState = null;
      if (project.snapshot) {
        set((current) => ({
          projects: current.projects.map((item) => (
            item.id === projectId ? { ...item, snapshot: undefined } : item
          )),
        }));
      }
      if (options.persistSnapshot) {
        try {
          await enqueueProjectSnapshot(projectId, undefined);
        } catch (error) {
          console.warn('[项目快照] 清理预览失败:', error);
        }
      }
      return projectId;
    }

    // 离开项目时重新取图，图片解码或视频首帧就绪并不一定会更新 Store。
    if (!options.allowProjectChange && project.snapshot && isCanvasSnapshotFresh(state, projectId)) {
      latestSnapshotCaptures.delete(projectId);
      if (options.persistSnapshot) {
        try {
          await enqueueProjectSnapshot(projectId, project.snapshot);
        } catch (error) {
          console.warn('[项目快照] 持久化失败:', error);
        }
      }
      return projectId;
    }

    const viewportKey = getCanvasViewportKey();
    const snapshot = await captureCurrentCanvasSnapshot(
      projectId,
      { nodes: state.nodes, edges: state.edges },
      { fresh: options.allowProjectChange },
    );
    if (latestSnapshotCaptures.get(projectId) !== captureId) return undefined;
    latestSnapshotCaptures.delete(projectId);
    const latest = get();
    const projectStillExists = latest.projects.some((item) => item.id === projectId);
    if (!projectStillExists) return undefined;

    const isStillCurrent = latest.currentProjectId === projectId;
    const currentCanvasChanged = isStillCurrent && (
      latest.nodes !== state.nodes
      || latest.edges !== state.edges
      || latest.groups !== state.groups
      || getCanvasViewportKey() !== viewportKey
    );
    if (currentCanvasChanged || (!isStillCurrent && !options.allowProjectChange)) return undefined;

    if (snapshot) {
      if (isStillCurrent) {
        lastCapturedCanvasState = {
          projectId,
          nodes: state.nodes,
          edges: state.edges,
          groups: state.groups,
          viewportKey,
        };
      } else if (lastCapturedCanvasState?.projectId === projectId) {
        lastCapturedCanvasState = null;
      }
      set((current) => ({
        projects: current.projects.map((item) => (
          item.id === projectId ? { ...item, snapshot } : item
        )),
      }));

      if (options.persistSnapshot) {
        try {
          // 只在最新记录上补缩略图，不能用捕获前的正文覆盖后续自动保存。
          await enqueueProjectSnapshot(projectId, snapshot);
        } catch (error) {
          console.warn('[项目快照] 持久化失败:', error);
        }
      }
    }
    return projectId;
  },

  createProject: async (name, options) => {
    if (options?.signal?.aborted || get().isCreatingProject || get().isReturningToStartPage) return undefined;
    set({ isCreatingProject: true });
    try {
      const createSequence = ++projectSwitchSequence;
      const isLatestCreate = () => !options?.signal?.aborted && createSequence === projectSwitchSequence;
      await waitForLoadingPaint();
      if (!isLatestCreate()) return undefined;
      const previousProjectId = get().currentProjectId;

      if (previousProjectId) {
        void get().captureCurrentProjectSnapshot({
          allowProjectChange: true,
          persistSnapshot: true,
        });
        const savedProjectId = await get().saveCurrentProject();
        if (!isLatestCreate()) return undefined;
        if (savedProjectId !== previousProjectId) {
          get().showToast('当前项目保存失败，已取消新建项目', 'error');
          return undefined;
        }
      }

      let defaultName: string;
      if (name) {
        defaultName = name;
      } else {
        const existing = get().projects
          .filter((p) => p.id !== 'default')
          .map((p) => {
            const m = p.name.match(/^项目\s+(\d+)$/);
            return m ? parseInt(m[1], 10) : 0;
          });
        const nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 1;
        defaultName = `项目 ${nextNum}`;
      }
      const projectId = `p2-${crypto.randomUUID()}`, canvasId = `c2-${crypto.randomUUID()}`;
      try {
        const [owner, canvas] = await Promise.all([resolveProjectModel(projectId), resolveProjectModel(canvasId)]);
        if (owner.dataModel !== 'missing' || canvas.dataModel !== 'missing') throw new Error('项目身份已被占用');
        await fileService.claimNativeProjectDataDir(projectId, defaultName);
        await createNativeProject({ projectId, canvasId, name: defaultName });
        nativeKnownIds.add(projectId); nativeKnownIds.add(canvasId);
        fileService.registerNativeProjectFolders([{ id: projectId, projectId }, { id: canvasId, projectId }]);
        const catalog = await loadProjectCatalog();
        const entry = catalog.native.find((item) => item.project.id === projectId);
        if (!entry) throw new Error('已创建的项目无法重新读取');
        set({ projects: catalog.projects });
        if (!isLatestCreate()) return options?.signal?.aborted ? undefined : canvasId;
        await activateNativeProject(set, get, entry, canvasId, () => { if (!isLatestCreate()) throw new Error('项目创建已取消'); });
        // 启动初始化已被本次创建取代，不能在下次挂载时重新载入旧目录覆盖新画布。
        if (projectInitializations.has(get)) set({ projectInitialized: true });
        rememberActiveProject(canvasId);
        get().loadConversationsForProject(canvasId).catch((e) => console.warn('[创建项目] 加载会话失败:', e));
        setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
        return canvasId;
      } catch (error) {
        console.warn('[创建项目] 保存失败:', error);
        if (isLatestCreate()) {
          get().showToast('新项目创建或打开失败，已保留已有数据', 'error');
        }
        return undefined;
      }
    } finally {
      set({ isCreatingProject: false });
    }
  },

  addEpisodes: async (entries) => {
    const state = get();
    const currentId = state.currentProjectId;
    if (!currentId || entries.length === 0) return [];
    if (projectImportsApplying.has(currentId) || projectImportsApplying.has(seriesOwnerId(state.projects, currentId))) {
      get().showToast('项目正在更新分集结构，请稍后重试', 'error'); return [];
    }
    if (state.projectLoadStatus !== 'ready') {
      get().showToast('项目尚未成功加载，已阻止新增分集', 'error');
      return [];
    }
    // 当前画布必须先落盘：转成剧集和切集都会动到它，未保存的改动会丢。
    if (await get().saveCurrentProjectSilent() !== currentId) {
      get().showToast('当前画布保存失败，已取消新增分集', 'error');
      return [];
    }

    const native = nativeBinding(get().projects.find((item) => item.id === currentId));
    if (native) {
      const runtime = nativeRuntime.get(get);
      if (!runtime || runtime.activeId !== currentId) return [];
      const sequence = projectSwitchSequence;
      const assertCurrent = () => {
        if (get().currentProjectId !== currentId || projectSwitchSequence !== sequence) throw new Error('项目已切换，停止新增分集');
      };
      const restoreView = async () => {
        try {
          assertCurrent();
          const catalog = await loadProjectCatalog();
          const entry = catalog.native.find((item) => item.project.id === native.projectId);
          if (!entry) throw new Error('项目目录不可用');
          const target = currentId === native.projectId && entry.canvasIds.length ? entry.canvasIds[0] : currentId;
          await activateNativeProject(set, get, entry, target, assertCurrent, target === currentId);
          if (target !== currentId) {
            rememberActiveProject(target);
            get().loadConversationsForProject(target).catch((e) => console.warn('[新增分集] 加载会话失败:', e));
            get().loadAgentTasksForProject(target).catch((e) => console.warn('[新增分集] 加载任务失败:', e));
          }
        } catch (error) {
          set({ projectLoadStatus: 'error', projectExecutionContext: null });
          get().showToast(error instanceof Error ? error.message : '项目恢复失败，请重新打开', 'error');
        }
      };
      const created: string[] = [];
      projectImportsApplying.add(native.projectId);
      set({ switchingProjectName: '正在更新分集', projectExecutionContext: null });
      try {
        let selection = runtime.loaded.selection;
        if (selection.project.kind === 'standalone') {
          const canvas = selection.canvas;
          if (!canvas) throw new Error('原画布不可用');
          const episodeId = `e2-${crypto.randomUUID()}`;
          if ((await resolveProjectModel(episodeId)).dataModel !== 'missing') throw new Error('分集身份已被占用');
          assertCurrent();
          await convertNativeProjectToSeries({ projectId: native.projectId, expectedProjectEpoch: selection.project.epoch,
            expectedCanvasId: canvas.id, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
            expectedStandaloneRevision: runtime.loaded.content.standaloneCreative?.revision ?? 0, episodeId, name: selection.project.name });
          const updated = await readNativeProjectView(native.projectId, currentId);
          if (!updated) throw new Error('转换后的项目无法读取');
          selection = updated.selection;
        }
        let nextNo = nativeEpisodeDisplayNumbers(selection.episodes).reduce((max, number) => Math.max(max, number), 0);
        for (const input of entries) {
          const episodeId = `e2-${crypto.randomUUID()}`, canvasId = `c2-${crypto.randomUUID()}`;
          const [episodeIdentity, canvasIdentity] = await Promise.all([resolveProjectModel(episodeId), resolveProjectModel(canvasId)]);
          if (episodeIdentity.dataModel !== 'missing' || canvasIdentity.dataModel !== 'missing') throw new Error('分集身份已被占用');
          assertCurrent();
          nextNo += 1;
          const aggregate = await createNativeEpisode({ projectId: native.projectId, expectedProjectEpoch: selection.project.epoch,
            episodeId, canvasId, displayNo: nextNo, name: input.name?.trim() || `第 ${nextNo} 集` });
          created.push(canvasId);
          if (input.outline?.trim()) {
            const episode = aggregate.episodes.find((item) => item.id === episodeId);
            const body = aggregate.episodeContents.find((item) => item.episodeId === episodeId);
            if (!episode || !body) throw new Error('新分集正文无法读取');
            await saveNativeEpisodeContent({ projectId: native.projectId, expectedProjectEpoch: aggregate.project.epoch,
              episodeId, expectedCanvasId: canvasId, expectedEpisodeRevision: episode.revision,
              expectedContentRevision: body.revision, patch: { outline: input.outline.trim() } });
          }
          selection = { ...selection, project: aggregate.project, episodes: aggregate.episodes };
        }
      } catch (error) {
        get().showToast(error instanceof Error ? error.message : '新增分集失败', 'error');
      } finally {
        try { await restoreView(); }
        finally {
          projectImportsApplying.delete(native.projectId);
          set({ switchingProjectName: null });
        }
      }
      return created;
    }

    const seriesId = await ensureCurrentSeriesId(set, get);
    if (!seriesId) {
      get().showToast('剧集创建失败，已取消新增分集', 'error');
      return [];
    }

    const latest = get();
    const series = latest.projects.find((item) => item.id === seriesId);
    if (!series) return [];
    if (projectImportsApplying.has(seriesId)) {
      get().showToast('项目正在更新分集结构，请稍后重试', 'error'); return [];
    }
    let nextNo = listEpisodes(latest.projects, seriesId)
      .reduce((max, item) => Math.max(max, item.episodeNo ?? 0), 0);

    const created: CanvasProject[] = [];
    for (const entry of entries) {
      if (projectImportsApplying.has(seriesId) || !get().projects.some((item) => item.id === seriesId)) {
        get().showToast('剧集结构已变化，已停止新增分集', 'error'); break;
      }
      nextNo += 1;
      const now = Date.now();
      const episode: CanvasProject = {
        id: generateProjectId(),
        name: entry.name?.trim() || `第 ${nextNo} 集`,
        createdAt: now,
        updatedAt: now,
        dataFolder: series.dataFolder,
        parentId: seriesId,
        episodeNo: nextNo,
        episodeOutline: entry.outline?.trim() || undefined,
        // ponytail: 新集复制剧集当前的创作基线后各自独立；要全剧联动改画风再把 settings 也上提到剧集。
        settings: series.settings,
      };
      try {
        await enqueueProjectSave({ ...episode, nodes: [], edges: [], groups: [] });
      } catch (error) {
        console.warn('[新增分集] 保存失败:', error);
        get().showToast(
          created.length > 0 ? `只成功新增了 ${created.length} 集` : '新增分集失败，已保留当前画布',
          'error',
        );
        break;
      }
      fileService.registerProjectFolder(episode.id, series.dataFolder ?? seriesId);
      created.push(episode);
    }

    if (created.length > 0) {
      set((current) => ({ projects: [...current.projects, ...created] }));
    }
    return created.map((episode) => episode.id);
  },

  addEpisode: async (name) => {
    const [id] = await get().addEpisodes([{ name }]);
    if (id) await get().switchProject(id);
    return id;
  },

  updateSeriesInfo: async (info, options) => {
    if ('storyGraph' in info) throw new Error('故事关系图必须通过条件保存更新');
    const state = get();
    if (state.projectLoadStatus !== 'ready' || state.switchingProjectName !== null
      || state.isCreatingProject || state.isReturningToStartPage) {
      get().showToast('项目尚未成功加载，已阻止保存', 'error');
      return false;
    }
    const canvasProjectId = state.currentProjectId;
    if (!canvasProjectId) return false;
    const native = nativeBinding(state.projects.find((item) => item.id === canvasProjectId));
    if (native) return mutateNativeMetadata(set, get, native, async ({ aggregate }) => {
      options?.assertCurrent?.();
      if (options?.expectedSeriesId !== undefined && options.expectedSeriesId !== native.projectId
        && !(aggregate.project.kind === 'standalone' && options.expectedSeriesId === canvasProjectId)) throw new Error('原著所属项目已变化');
      if (options?.expectedExchangeEpoch !== undefined && options.expectedExchangeEpoch !== aggregate.project.epoch) throw new Error('原著所属项目版本已变化');
      if (options?.expectedOriginalWork !== undefined
        && !configValuesEqual(options.expectedOriginalWork ?? undefined, aggregate.content.originalWork)) throw new Error('原著引用已变化，请重新载入');
      let current = aggregate;
      if (current.project.kind === 'standalone') {
        const canvas = current.canvas;
        if (!canvas) throw new Error('原画布不存在');
        const episodeId = `e2-${crypto.randomUUID()}`;
        if ((await resolveProjectModel(episodeId)).dataModel !== 'missing') throw new Error('分集身份已被占用');
        options?.assertCurrent?.();
        current = await convertNativeProjectToSeries({ projectId: native.projectId, expectedProjectEpoch: current.project.epoch,
          expectedCanvasId: canvas.id, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
          expectedStandaloneRevision: current.content.standaloneCreative?.revision ?? 0, episodeId, name: '第 1 集' });
      }
      const patch: Parameters<typeof saveNativeProjectContent>[0]['patch'] = {};
      const expectedRevisions: Parameters<typeof saveNativeProjectContent>[0]['expectedRevisions'] = {};
      if ('originalWork' in info) { patch.originalWork = info.originalWork; expectedRevisions.source = current.content.revisions.source; }
      if ('script' in info) { patch.script = info.script; expectedRevisions.script = current.content.revisions.script; }
      if (Object.keys(patch).length) {
        options?.assertCurrent?.();
        await saveNativeProjectContent({ projectId: native.projectId, expectedProjectEpoch: current.project.epoch, expectedRevisions, patch });
      }
    }, false);
    const navigationSequence = projectSwitchSequence;
    const requestedSeriesId = options?.expectedSeriesId;
    const expectedEpoch = options?.expectedExchangeEpoch;
    const expectedOriginal = options?.expectedOriginalWork === undefined ? undefined
      : options.expectedOriginalWork === null ? null : { ...options.expectedOriginalWork };
    const changes = { ...info, ...(info.originalWork ? { originalWork: { ...info.originalWork } } : {}) };
    const assertSessionCurrent = options?.assertCurrent;
    const sameOriginal = (left: ProjectOriginalWork | undefined | null, right: ProjectOriginalWork | undefined | null) => (
      !left || !right ? !left && !right
        : left.fileName === right.fileName && left.relativePath === right.relativePath && left.addedAt === right.addedAt
    );
    const assertNavigationCurrent = () => {
      assertSessionCurrent?.();
      const latest = get();
      if (latest.currentProjectId !== canvasProjectId || projectSwitchSequence !== navigationSequence
        || latest.projectLoadStatus !== 'ready' || latest.switchingProjectName !== null
        || latest.isCreatingProject || latest.isReturningToStartPage) {
        throw new Error('原著所属剧集或编辑会话已变化，请重新打开');
      }
    };
    assertNavigationCurrent();
    // 明确指定目标的首次保存不能把导航后的其他普通项目转换成剧集。
    if (requestedSeriesId !== undefined) {
      const owner = state.projects.find((project) => project.id === requestedSeriesId);
      if (!owner || owner.parentId || seriesOwnerId(state.projects, canvasProjectId) !== requestedSeriesId) {
        throw new Error('原著所属剧集或编辑会话已变化，请重新打开');
      }
    }
    const seriesId = requestedSeriesId ?? await ensureCurrentSeriesId(set, get);
    assertNavigationCurrent();
    if (!seriesId) return false;
    const initialSeries = get().projects.find((project) => project.id === seriesId);
    const epoch = expectedEpoch ?? initialSeries?.exchangeEpoch ?? 0;
    const assertSeriesCurrent = (allowOwnOriginal = false) => {
      assertNavigationCurrent();
      const latest = get();
      const owner = latest.projects.find((project) => project.id === seriesId);
      if (!owner || owner.parentId || seriesOwnerId(latest.projects, canvasProjectId) !== seriesId
        || (owner.exchangeEpoch ?? 0) !== epoch) {
        throw new Error('原著所属剧集或编辑会话已变化，请重新打开');
      }
      if (expectedOriginal !== undefined && !sameOriginal(owner.series?.originalWork, expectedOriginal)
        && !(allowOwnOriginal && 'originalWork' in changes && sameOriginal(owner.series?.originalWork, changes.originalWork))) {
        throw new Error('原著引用已变化，请保留草稿并重新载入');
      }
    };
    assertSeriesCurrent();
    return serializeEpisodeCreativeWrite(seriesId, () => {
      assertSeriesCurrent();
      const series = get().projects.find((item) => item.id === seriesId);
      return patchProjectRecord(set, get, seriesId, { series: { ...series?.series, ...changes } }, false,
        () => assertSeriesCurrent(true));
    });
  },

  updateStoryGraph: async (seriesId, patch, expectedRevision, guards) => serializeEpisodeCreativeWrite(seriesId, async () => {
    const native = nativeBinding(get().projects.find((item) => item.id === seriesId));
    if (native) {
      let result: StoryGraph | undefined;
      const saved = await mutateNativeMetadata(set, get, native, async ({ aggregate }) => {
        guards?.signal?.throwIfAborted(); guards?.assertCurrent?.();
        if (guards?.expectedExchangeEpoch !== undefined && guards.expectedExchangeEpoch !== aggregate.project.epoch) throw new Error('故事图所属项目版本已变化');
        const byEpisode = new Map(aggregate.episodes.map((item) => [item.id, item.canvasId]));
        const byCanvas = new Map(aggregate.episodes.map((item) => [item.canvasId, item.id]));
        const previous = aggregate.content.storyGraph ? remapStoryGraphBindings(aggregate.content.storyGraph,
          (id) => byEpisode.get(id) ?? id, (asset) => asset.id) : undefined;
        const graph = applyStoryGraphPatch(previous, patch, expectedRevision);
        const oldIds = new Set((previous ? [...previous.nodes, ...previous.edges] : []).flatMap((item) => [
          ...item.episodeIds, ...item.evidence.map((entry) => entry.episodeId),
          ...('fromEpisodeId' in item && item.fromEpisodeId ? [item.fromEpisodeId] : []),
          ...('toEpisodeId' in item && item.toEpisodeId ? [item.toEpisodeId] : []),
        ]));
        for (const item of [...graph.nodes, ...graph.edges]) {
          const ids = [...item.episodeIds, ...item.evidence.map((entry) => entry.episodeId),
            ...('fromEpisodeId' in item && item.fromEpisodeId ? [item.fromEpisodeId] : []),
            ...('toEpisodeId' in item && item.toEpisodeId ? [item.toEpisodeId] : [])];
          if (ids.some((id) => !byCanvas.has(id) && !oldIds.has(id))) throw new Error('故事图只能引用本剧分集');
        }
        const library = aggregate.content.dramaAssets;
        for (const node of graph.nodes) if (node.asset) {
          const assets = node.asset.kind === 'character' ? library?.characters : node.asset.kind === 'scene' ? library?.scenes : library?.props;
          if (!assets?.some((asset) => asset.id === node.asset!.id)
            && !previous?.nodes.some((item) => item.asset?.kind === node.asset!.kind && item.asset.id === node.asset!.id)) throw new Error('故事图资产不属于本项目');
        }
        const persisted = remapStoryGraphBindings(graph, (id) => byCanvas.get(id) ?? id, (asset) => asset.id);
        guards?.signal?.throwIfAborted(); guards?.assertCurrent?.();
        await saveNativeProjectContent({ projectId: native.projectId, expectedProjectEpoch: aggregate.project.epoch,
          expectedRevisions: { storyGraph: aggregate.content.revisions.storyGraph }, patch: { storyGraph: persisted } });
        result = graph;
      }, false);
      if (!saved || !result) throw new Error('故事关系图保存失败，请重新打开');
      return result;
    }
    const initial = get();
    const canvasProjectId = initial.currentProjectId;
    const owner = initial.projects.find((item) => item.id === seriesId);
    const epoch = guards?.expectedExchangeEpoch ?? owner?.exchangeEpoch ?? 0;
    const oldGraph = owner?.series?.storyGraph ? normalizeStoryGraph(owner.series.storyGraph) : undefined;
    const assertCurrent = (next?: StoryGraph) => {
      guards?.signal?.throwIfAborted(); guards?.assertCurrent?.();
      const state = get(), latest = state.projects.find((item) => item.id === seriesId);
      if (!latest || latest.parentId || state.projectLoadStatus !== 'ready'
        || state.currentProjectId !== canvasProjectId || !canvasProjectId
        || seriesOwnerId(state.projects, canvasProjectId) !== seriesId
        || state.switchingProjectName !== null || state.isCreatingProject || state.isReturningToStartPage
        || (latest.exchangeEpoch ?? 0) !== epoch) throw new Error('故事图所属剧集或编辑会话已变化，请重新打开');
      if (!next) return;
      const episodeIds = new Set(state.projects.filter((item) => item.parentId === seriesId).map((item) => item.id));
      const previousReferences = new Set((oldGraph ? [...oldGraph.nodes, ...oldGraph.edges] : [])
        .flatMap((item) => [...item.episodeIds, ...item.evidence.map((evidence) => evidence.episodeId),
          ...('fromEpisodeId' in item && typeof item.fromEpisodeId === 'string' ? [item.fromEpisodeId] : []),
          ...('toEpisodeId' in item && typeof item.toEpisodeId === 'string' ? [item.toEpisodeId] : [])]));
      for (const item of [...next.nodes, ...next.edges]) {
        const references = [...item.episodeIds, ...item.evidence.map((evidence) => evidence.episodeId),
          ...('fromEpisodeId' in item && typeof item.fromEpisodeId === 'string' ? [item.fromEpisodeId] : []),
          ...('toEpisodeId' in item && typeof item.toEpisodeId === 'string' ? [item.toEpisodeId] : [])];
        if (references.some((id) => !episodeIds.has(id) && !previousReferences.has(id))) throw new Error('故事图只能引用本剧分集');
      }
      for (const node of next.nodes) if (node.asset) {
        const assets = node.asset.kind === 'character' ? state.dramaAssets.characters
          : node.asset.kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props;
        if (!assets.some((item) => item.id === node.asset!.id)
          && !oldGraph?.nodes.some((item) => item.asset?.kind === node.asset!.kind && item.asset.id === node.asset!.id)) {
          throw new Error('故事图绑定的正式资产不属于本剧');
        }
      }
    };
    assertCurrent();
    await waitForProjectSaveQueue(seriesId);
    assertCurrent();
    const graph = await updateProjectStoryGraphCAS(seriesId, patch, expectedRevision, epoch, assertCurrent);
    // 数据库提交已成功；仅合并仍属当前归档代际的元数据，不覆盖较新的原稿。
    set((state) => ({ projects: state.projects.map((item) => item.id === seriesId && (item.exchangeEpoch ?? 0) === epoch
      ? { ...item, updatedAt: Date.now(), series: { ...item.series, storyGraph: graph } } : item) }));
    return graph;
  }),

  updateEpisodeOutline: async (episodeId, outline) => get().updateEpisodeCreative(episodeId, { outline }),

  updateEpisodeCreative: async (episodeId, updates, options) => serializeEpisodeCreativeWrite(episodeId, async () => {
    const native = nativeBinding(get().projects.find((item) => item.id === episodeId));
    if (native) {
      if (!native.episodeId || !native.canvasId) return false;
      const state = get(), runtime = nativeRuntime.get(get), activeId = state.currentProjectId;
      if (!runtime || !activeId || nativeBinding(state.projects.find((item) => item.id === activeId))?.projectId !== native.projectId
        || activeId !== episodeId && !options?.allowSameSeries) return false;
      const sequence = projectSwitchSequence;
      const assertCurrent = () => {
        options?.assertCurrent?.(); options?.assertCommitCurrent?.();
        const latest = get();
        if (latest.currentProjectId !== activeId || projectSwitchSequence !== sequence || latest.projectLoadStatus !== 'ready'
          || latest.switchingProjectName !== null || nativeRuntime.get(get) !== runtime) throw new Error('分集已切换，草稿已保留');
      };
      const previous = runtime.tail;
      let release!: () => void;
      runtime.tail = new Promise<void>((resolve) => { release = resolve; });
      let receipt: EpisodeScriptFileReceipt | undefined;
      let committed = false;
      try {
        await previous;
        assertCurrent();
        const loaded = await readNativeProjectView(native.projectId, native.canvasId);
        assertCurrent();
        const episode = loaded?.selection.episode, body = loaded?.episodeContent;
        if (!loaded || !episode || !body || episode.id !== native.episodeId) throw new Error('分集正文已变化');
        const expected = options?.expected;
        if (expected) {
          if (expected.kind !== 'episode' || expected.episodeId !== episodeId || expected.seriesId !== native.projectId
            || expected.field !== 'outline' && expected.field !== 'script') throw new Error('团队成果不属于当前分集');
          const value = expected.field === 'outline' ? body.outline ?? '' : body.script ?? '';
          if (await sha256BytesHex(new TextEncoder().encode(value)) !== expected.expectedHash) throw new Error('目标内容已变化，未覆盖草稿');
          if (expected.sourceHash) {
            const snapshot = episodeTeamSourceSnapshot({ episodeOutline: body.outline, episodeScript: body.script, episodeCreative: body.creative }, expected.field);
            if (await sha256BytesHex(new TextEncoder().encode(snapshot)) !== expected.sourceHash) throw new Error('分集素材已变化，未覆盖草稿');
          }
          if ('creationProfile' in updates || 'teamProfileOverride' in updates
            || (expected.field === 'outline' ? !('outline' in updates) || 'script' in updates || 'creative' in updates
            : !('script' in updates) || 'outline' in updates || 'creative' in updates)) throw new Error('团队成果只能更新绑定字段');
        }
        const patch: Partial<Pick<EpisodeContent, 'outline' | 'script' | 'scriptFile' | 'creative'>> = {};
        const metadata: Partial<Pick<Parameters<typeof updateNativeEpisodeComposite>[0], 'creationProfile' | 'teamProfileOverride'>> = {};
        if ('outline' in updates) patch.outline = updates.outline;
        if ('script' in updates) patch.script = updates.script;
        if ('creative' in updates) patch.creative = updates.creative;
        if ('creationProfile' in updates) {
          const profile = normalizeCreationProfileSelection(updates.creationProfile);
          if (updates.creationProfile !== undefined && updates.creationProfile !== null && !profile) throw new Error('分集组合包选择无效');
          metadata.creationProfile = profile ?? null;
          if (!('teamProfileOverride' in updates)) metadata.teamProfileOverride = null;
        }
        if ('teamProfileOverride' in updates) metadata.teamProfileOverride = updates.teamProfileOverride ? normalizeTeamProfile(updates.teamProfileOverride) : null;
        if (!Object.keys(patch).length && !Object.keys(metadata).length) return true;
        if ('script' in updates) {
          receipt = await prepareEpisodeScriptFileWrite({ episodeId, projectId: native.projectId,
            exchangeEpoch: loaded.selection.project.epoch, episodeExchangeEpoch: episode.epoch, name: episode.name,
            previousText: body.script ?? '', text: updates.script ?? '', reference: body.scriptFile,
            assertCurrent, subscribe: api.subscribe, onPrepared: (prepared) => { receipt = prepared; } });
          if (receipt) patch.scriptFile = receipt.reference;
        }
        assertCurrent();
        const saved = await updateNativeEpisodeComposite({ projectId: native.projectId, expectedProjectEpoch: loaded.selection.project.epoch,
          episodeId: episode.id, expectedCanvasId: native.canvasId, expectedEpisodeRevision: episode.revision,
          expectedContentRevision: body.revision, ...(Object.keys(patch).length ? { contentPatch: patch } : {}), ...metadata });
        committed = true;
        receipt?.confirm();
        if (get().currentProjectId !== activeId || projectSwitchSequence !== sequence || nativeRuntime.get(get) !== runtime) return true;
        if (activeId === episodeId) runtime.loaded = { ...runtime.loaded, episodeContent: saved.content,
          selection: { ...runtime.loaded.selection, episode: saved.episode,
            episodes: runtime.loaded.selection.episodes.map((item) => item.id === saved.episode.id ? saved.episode : item) } };
        set((current) => ({ projects: current.projects.map((item) => item.id === episodeId
          ? { ...item, ...(patch.outline !== undefined ? { episodeOutline: patch.outline } : {}),
            ...(patch.script !== undefined ? { episodeScript: patch.script } : {}),
            ...(patch.scriptFile ? { episodeScriptFile: patch.scriptFile } : {}),
            ...(patch.creative ? { episodeCreative: patch.creative } : {}),
            ...('creationProfile' in metadata ? { creationProfile: metadata.creationProfile ?? undefined } : {}),
            ...('teamProfileOverride' in metadata ? { teamProfileOverride: metadata.teamProfileOverride ?? undefined } : {}) } : item) }));
        return true;
      } catch (error) {
        if (receipt && !committed) await receipt.rollback(assertCurrent).catch(() => false);
        get().showToast(error instanceof Error ? error.message : '分集正文保存失败，草稿已保留', 'error');
        return false;
      } finally { release(); }
    }
    const expected = options?.expected;
    const canvasProjectId = get().currentProjectId;
    const assertCommitScope = () => {
      options?.assertCommitCurrent?.();
      if (!expected) return;
      const current = get();
      const episode = current.projects.find((item) => item.id === episodeId);
      const workspace = options?.allowSameSeries ? readEpisodeWorkspaceScope(current, episodeId) : null;
      if (current.currentProjectId !== canvasProjectId || current.projectLoadStatus !== 'ready'
        || current.switchingProjectName !== null || current.isCreatingProject || current.isReturningToStartPage
        || episode?.parentId !== expected.seriesId || (current.currentProjectId !== episodeId && !workspace)) {
        throw new Error('分集或所属剧集已变化，请重新核对团队成果');
      }
    };
    if (expected) {
      const state = get();
      const episode = state.projects.find((item) => item.id === episodeId);
      const workspace = options?.allowSameSeries ? readEpisodeWorkspaceScope(state, episodeId) : null;
      if (expected.kind !== 'episode' || !['outline', 'script'].includes(expected.field)
        || state.projectLoadStatus !== 'ready' || (state.currentProjectId !== episodeId && !workspace)
        || state.isCreatingProject || state.isReturningToStartPage || state.switchingProjectName !== null
        || expected.episodeId !== episodeId || episode?.parentId !== expected.seriesId) {
        throw new Error('分集或所属剧集已变化，请先回到原分集再应用成果');
      }
      const fieldValue = expected.field === 'outline' ? episode.episodeOutline ?? '' : episode.episodeScript ?? '';
      const sourceSnapshot = episodeTeamSourceSnapshot(episode, expected.field);
      const [hash, sourceHash] = await Promise.all([
        sha256BytesHex(new TextEncoder().encode(fieldValue)),
        expected.sourceHash ? sha256BytesHex(new TextEncoder().encode(sourceSnapshot)) : Promise.resolve(undefined),
      ]);
      const current = get();
      const latestEpisode = current.projects.find((item) => item.id === episodeId);
      const latestValue = expected.field === 'outline' ? latestEpisode?.episodeOutline ?? '' : latestEpisode?.episodeScript ?? '';
      const latestWorkspace = options?.allowSameSeries ? readEpisodeWorkspaceScope(current, episodeId) : null;
      if (hash !== expected.expectedHash || latestValue !== fieldValue
        || (expected.sourceHash && (sourceHash !== expected.sourceHash || !latestEpisode
          || episodeTeamSourceSnapshot(latestEpisode, expected.field) !== sourceSnapshot))
        || latestEpisode?.parentId !== expected.seriesId || (current.currentProjectId !== episodeId && !latestWorkspace)
        || current.currentProjectId !== state.currentProjectId || current.projectLoadStatus !== 'ready'
        || current.switchingProjectName !== null || current.isCreatingProject || current.isReturningToStartPage) {
        throw new Error('目标内容已被修改，团队候选已保留；请比较当前稿件，不要覆盖新内容');
      }
      if ('creationProfile' in updates || 'teamProfileOverride' in updates
        || (expected.field === 'outline' && (!('outline' in updates) || 'script' in updates || 'creative' in updates))
        || (expected.field === 'script' && (!('script' in updates) || 'outline' in updates || 'creative' in updates))) {
        throw new Error('团队成果只允许更新任务绑定的一个目标字段');
      }
    }
    options?.assertCurrent?.();
    assertCommitScope();
    const patch: Partial<CanvasProject> = {};
    if ('outline' in updates) patch.episodeOutline = updates.outline;
    if ('script' in updates) patch.episodeScript = updates.script;
    if ('creative' in updates) patch.episodeCreative = updates.creative;
    if ('creationProfile' in updates) {
      const selection = normalizeCreationProfileSelection(updates.creationProfile);
      if (updates.creationProfile !== undefined && updates.creationProfile !== null && !selection) throw new Error('分集组合包选择无效');
      patch.creationProfile = selection;
      if (!('teamProfileOverride' in updates)) patch.teamProfileOverride = undefined;
    }
    if ('teamProfileOverride' in updates) patch.teamProfileOverride = updates.teamProfileOverride ? normalizeTeamProfile(updates.teamProfileOverride) : undefined;
    if (Object.keys(patch).length === 0) return true;
    if (!('script' in updates)) return patchProjectRecord(set, get, episodeId, patch, false, assertCommitScope);
    const initial = get();
    const episode = initial.projects.find((project) => project.id === episodeId);
    if (!episode) return false;
    const projectId = episode.parentId ?? episode.id;
    const initialOwner = initial.projects.find((project) => project.id === projectId);
    const ownerEpoch = initialOwner?.exchangeEpoch ?? 0;
    const baseDataDir = initial.config.baseDataDir;
    const episodeEpoch = episode.exchangeEpoch ?? 0;
    const navigationSequence = projectSwitchSequence;
    const previousReference = normalizeProjectTextFileReference(episode.episodeScriptFile);
    const referenceKey = (value: unknown) => JSON.stringify(normalizeProjectTextFileReference(value) ?? null);
    const oldReference = referenceKey(previousReference);
    let receipt: EpisodeScriptFileReceipt | undefined;
    let committing = false;
    const assertFileSource = () => {
      assertCommitScope();
      const latest = get();
      const target = latest.projects.find((project) => project.id === episodeId);
      const owner = latest.projects.find((project) => project.id === projectId);
      if (!target || !owner || owner.parentId || target.parentId !== episode.parentId || target.name !== episode.name
        || owner.name !== initialOwner?.name || owner.dataFolder !== initialOwner?.dataFolder
        || target.dataFolder !== episode.dataFolder || latest.config.baseDataDir !== baseDataDir
        || (owner.exchangeEpoch ?? 0) !== ownerEpoch || (target.exchangeEpoch ?? 0) !== episodeEpoch
        || latest.currentProjectId !== canvasProjectId || !canvasProjectId || projectSwitchSequence !== navigationSequence
        || latest.projectLoadStatus !== 'ready' || latest.switchingProjectName !== null || latest.isCreatingProject || latest.isReturningToStartPage
        || seriesOwnerId(latest.projects, canvasProjectId) !== projectId) throw new Error('剧本所属分集或项目已变化，草稿已保留');
      const original = target.episodeScript === episode.episodeScript && referenceKey(target.episodeScriptFile) === oldReference;
      const ownPatch = committing && !!receipt && target.episodeScript === updates.script
        && referenceKey(target.episodeScriptFile) === referenceKey(receipt.reference);
      if (!original && !ownPatch) throw new Error('本集剧本或 TXT 引用已变化，未覆盖较新的稿件');
    };
    const rollbackFile = async () => {
      if (!receipt) return;
      try {
        const persisted = await fileService.loadProjectData(episodeId);
        if (!persisted || persisted.episodeScript !== episode.episodeScript || referenceKey(persisted.episodeScriptFile) !== oldReference) {
          throw new Error('项目保存结果尚未确认');
        }
        const rolledBack = await receipt.rollback(() => {
          const latest = get();
          const target = latest.projects.find((project) => project.id === episodeId);
          const owner = latest.projects.find((project) => project.id === projectId);
          if (!target || !owner || target.parentId !== episode.parentId || owner.name !== initialOwner?.name || owner.dataFolder !== initialOwner?.dataFolder
            || target.dataFolder !== episode.dataFolder || latest.config.baseDataDir !== baseDataDir
            || (owner.exchangeEpoch ?? 0) !== ownerEpoch || (target.exchangeEpoch ?? 0) !== episodeEpoch
            || target.episodeScript !== episode.episodeScript || referenceKey(target.episodeScriptFile) !== oldReference) {
            throw new Error('项目内容已变化，保留 TXT 待核对');
          }
        });
        if (!rolledBack) throw new Error('保留可恢复的 TXT 副本');
      } catch {
        get().showToast('剧本 TXT 与项目保存未同时确认，草稿已保留；请检查文件后重试', 'error');
      }
    };
    try {
      receipt = await prepareEpisodeScriptFileWrite({ episodeId, projectId, exchangeEpoch: ownerEpoch, episodeExchangeEpoch: episodeEpoch,
        name: episode.name, previousText: episode.episodeScript ?? '', text: updates.script ?? '', reference: previousReference,
        assertCurrent: assertFileSource, subscribe: api.subscribe, onPrepared: (prepared) => { receipt = prepared; } });
      if (receipt) { patch.episodeScriptFile = receipt.reference; assertFileSource(); }
      committing = true;
      const saved = await patchProjectRecord(set, get, episodeId, patch, false, () => {
        assertCommitScope(); if (receipt) assertFileSource();
      });
      if (saved) receipt?.confirm();
      else await rollbackFile();
      return saved;
    } catch (reason) {
      await rollbackFile();
      throw reason;
    }
  }),

  updateEpisodeAssetRoster: async (episodeId, roster, expectedRevision, options) => serializeEpisodeCreativeWrite(episodeId, async () => {
    const native = nativeBinding(get().projects.find((item) => item.id === episodeId));
    if (native) {
      if (!native.episodeId || !native.canvasId) return false;
      const current = get();
      if (current.currentProjectId !== episodeId && !options?.allowSameSeries) return false;
      let nextRoster: EpisodeAssetRoster | undefined;
      const saved = await mutateNativeMetadata(set, get, native, async ({ aggregate }) => {
        options?.assertCurrent?.(); options?.assertCommitCurrent?.();
        const episode = aggregate.episodes.find((item) => item.id === native.episodeId);
        const body = aggregate.episodeContents.find((item) => item.episodeId === native.episodeId);
        if (!episode || !body) throw new Error('分集正文不存在');
        const previous = normalizeEpisodeAssetRoster(body.assetRoster);
        if ((expectedRevision ?? roster.revision) !== previous.revision || previous.revision >= Number.MAX_SAFE_INTEGER) throw new Error('分集素材清单已变化');
        nextRoster = { ...normalizeEpisodeAssetRoster(roster), revision: previous.revision + 1 };
        await saveNativeEpisodeContent({ projectId: native.projectId, expectedProjectEpoch: aggregate.project.epoch,
          episodeId: episode.id, expectedCanvasId: native.canvasId!, expectedEpisodeRevision: episode.revision,
          expectedContentRevision: body.revision, patch: { assetRoster: nextRoster } });
      }, false);
      if (saved && nextRoster) set((latest) => ({ projects: latest.projects.map((item) => item.id === episodeId
        ? { ...item, episodeAssetRoster: nextRoster } : item) }));
      return saved;
    }
    const state = get();
    const canvasProjectId = state.currentProjectId;
    const episode = state.projects.find((project) => project.id === episodeId);
    const owner = episode?.parentId ? state.projects.find((project) => project.id === episode.parentId) : undefined;
    const workspace = options?.allowSameSeries ? readEpisodeWorkspaceScope(state, episodeId) : null;
    if (state.projectLoadStatus !== 'ready' || (state.currentProjectId !== episodeId && !workspace)
      || state.isCreatingProject || state.isReturningToStartPage || state.switchingProjectName !== null
      || !episode?.parentId || !owner || owner.parentId) return false;
    const current = normalizeEpisodeAssetRoster(episode.episodeAssetRoster);
    if ((expectedRevision ?? roster.revision) !== current.revision) return false;
    if (current.revision >= Number.MAX_SAFE_INTEGER) return false;
    const assertCommitScope = () => {
      options?.assertCommitCurrent?.();
      const latest = get();
      if (latest.currentProjectId !== canvasProjectId || !readEpisodeWorkspaceScope(latest, episodeId)
        || (!options?.allowSameSeries && latest.currentProjectId !== episodeId)) {
        throw new Error('项目已切换，未保存旧分集清单');
      }
    };
    options?.assertCurrent?.();
    assertCommitScope();
    const next = { ...normalizeEpisodeAssetRoster(roster), revision: current.revision + 1 };
    return patchProjectRecord(set, get, episodeId, { episodeAssetRoster: next }, true, assertCommitScope);
  }),

  moveEpisode: async (episodeId, direction) => {
    const state = get();
    const episode = state.projects.find((item) => item.id === episodeId);
    if (!episode?.parentId || state.projectLoadStatus !== 'ready' || state.switchingProjectName !== null
      || state.isCreatingProject || state.isReturningToStartPage || ![-1, 1].includes(direction)) return false;
    const episodes = listEpisodes(state.projects, episode.parentId);
    const index = episodes.findIndex((item) => item.id === episodeId);
    const neighbour = episodes[index + direction];
    if (!neighbour) return false;

    const native = nativeBinding(episode);
    if (native) {
      const activeId = state.currentProjectId;
      const activeNative = nativeBinding(state.projects.find((item) => item.id === activeId));
      const isActive = activeNative?.projectId === native.projectId;
      if (isActive && activeId && await get().saveCurrentProjectSilent() !== activeId) return false;
      if (projectImportsApplying.has(native.projectId)) return false;
      const sequence = projectSwitchSequence;
      const assertCurrent = () => { if (sequence !== projectSwitchSequence || get().currentProjectId !== activeId) throw new Error('项目已切换，排序已停止'); };
      const previousContext = get().projectExecutionContext;
      let previousRevision: number | undefined, writeStarted = false;
      projectImportsApplying.add(native.projectId);
      if (isActive) set({ switchingProjectName: '正在调整分集', projectExecutionContext: null });
      try {
        const capture = await readNativeProjectCapture(native.projectId);
        if (!capture) throw new Error('项目不存在');
        previousRevision = capture.changeRevision;
        const ordered = capture.aggregate.episodes.map((item) => item.id);
        const current = ordered.indexOf(native.episodeId ?? '');
        const other = current + direction;
        if (current < 0 || other < 0 || other >= ordered.length) throw new Error('分集顺序已变化');
        [ordered[current], ordered[other]] = [ordered[other], ordered[current]];
        assertCurrent();
        writeStarted = true;
        await reorderNativeEpisodes({ projectId: native.projectId, expectedProjectEpoch: capture.aggregate.project.epoch,
          expectedEpisodes: capture.aggregate.episodes.map((item) => ({ id: item.id, revision: item.revision })), orderedEpisodeIds: ordered });
        const catalog = await loadProjectCatalog();
        const entry = catalog.native.find((item) => item.project.id === native.projectId);
        if (!entry) throw new Error('项目目录不可用');
        assertCurrent();
        if (isActive && activeId) await activateNativeProject(set, get, entry, activeId, assertCurrent, true);
        else set((currentState) => ({ projects: [...currentState.projects.filter((item) => nativeBinding(item)?.projectId !== native.projectId), ...projectNativeCatalogEntry(entry)] }));
        return true;
      } catch (error) {
        if (isActive && get().currentProjectId === activeId && sequence === projectSwitchSequence) {
          let unchanged = !writeStarted;
          if (writeStarted && previousRevision !== undefined) try {
            unchanged = (await readNativeProjectCapture(native.projectId))?.changeRevision === previousRevision;
          } catch { /* 无法核实提交结果 */ }
          if (get().currentProjectId === activeId && sequence === projectSwitchSequence) set(unchanged
            ? { projectLoadStatus: 'ready', projectExecutionContext: previousContext }
            : { projectLoadStatus: 'error', projectExecutionContext: null });
        }
        get().showToast(error instanceof Error ? error.message : '分集排序失败', 'error');
        return false;
      } finally {
        projectImportsApplying.delete(native.projectId);
        if (isActive) set({ switchingProjectName: null });
      }
    }

    const ownerId = episode.parentId;
    const ids = [ownerId, ...episodes.map((item) => item.id)];
    if (ids.some((id) => projectImportsApplying.has(id) || projectAssetSyncBarriers.has(id))) return false;
    const sequence = projectSwitchSequence;
    // 旧格式只有集号一条排序轴。缺号/重号保持原值，不能借排序重新编号覆盖用户语义。
    const numbers = episodes.map((item) => item.episodeNo);
    if (numbers.some((value) => !Number.isSafeInteger(value) || value! < 1) || new Set(numbers).size !== numbers.length) {
      get().showToast('旧集号重复或缺失，已保留原顺序', 'error'); return false;
    }
    ids.forEach((id) => projectImportsApplying.add(id));
    try {
      // 屏障阻断新的整条旧记录保存，先排空已接受的保存/稿件，再原子打排序补丁。
      await Promise.all(ids.map((id) => waitForProjectSaveQueue(id)));
      await Promise.all(ids.map((id) => episodeCreativeWrites.get(id)?.catch(() => undefined)));
      const assertCurrent = () => {
        const current = get();
        if (projectSwitchSequence !== sequence || current.projectLoadStatus !== 'ready'
          || current.switchingProjectName !== null || current.isCreatingProject || current.isReturningToStartPage
          || listEpisodes(current.projects, ownerId).length !== episodes.length
          || episodes.some((before) => {
            const after = current.projects.find((item) => item.id === before.id);
            return !after || after.parentId !== ownerId || after.episodeNo !== before.episodeNo
              || (after.exchangeEpoch ?? 0) !== (before.exchangeEpoch ?? 0);
          })) throw new Error('分集列表已变化，已取消旧排序');
      };
      assertCurrent();
      const patches = await swapLegacyEpisodeOrder({ ownerId,
        expectedOwnerEpoch: state.projects.find((item) => item.id === ownerId)?.exchangeEpoch,
        expectedEpisodes: episodes, episodeId, direction, assertCurrent });
      // 已提交的补丁仅投影到仍有相同旧排序的目录，不覆盖导航或后来的元数据。
      set((current) => ({ projects: current.projects.map((item) => {
        const before = episodes.find((entry) => entry.id === item.id);
        const patch = patches.find((entry) => entry.id === item.id);
        return before && patch && item.parentId === ownerId && item.episodeNo === before.episodeNo
          && (item.exchangeEpoch ?? 0) === (before.exchangeEpoch ?? 0) ? { ...item, ...patch } : item;
      }) }));
      return true;
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '分集排序失败，原顺序已保留', 'error');
      return false;
    } finally { ids.forEach((id) => projectImportsApplying.delete(id)); }
  },

  exportProject: async (id) => {
    const state = get();
    const ownerId = seriesOwnerId(state.projects, id);
    const project = state.projects.find((item) => item.id === ownerId);
    if (!project) return false;
    const native = nativeBinding(project);

    // 导出整部剧前，先保存当前分集画布与共享角色库。
    const activeId = state.currentProjectId;
    if (activeId && (native ? nativeBinding(state.projects.find((item) => item.id === activeId))?.projectId === native.projectId
      : seriesOwnerId(state.projects, activeId) === ownerId)) {
      if (state.projectLoadStatus !== 'ready') {
        state.showToast('项目尚未成功加载，已阻止导出', 'error');
        return false;
      }
      void get().captureCurrentProjectSnapshot();
      if (await get().saveCurrentProjectSilent() !== activeId || get().currentProjectId !== activeId) {
        get().showToast('项目保存失败，已取消导出', 'error');
        return false;
      }
    }

    try {
      const result = native ? await exportNativeProjectArchive(native.projectId) : await exportProjectArchive(ownerId);
      if (!result) return false;
      const episodes = result.episodeCount > 0 ? t('{count} 个分集、', { count: result.episodeCount }) : '';
      get().showToast(t('已导出「{name}」，含 {episodes}{count} 个素材', { name: project.name, episodes, count: result.assetCount }));
      return true;
    } catch (error) {
      console.error('[项目导出] 失败:', error);
      get().showToast(error instanceof Error ? t('项目导出失败：{reason}', { reason: error.message }) : '项目导出失败', 'error');
      return false;
    }
  },

  duplicateProject: async (id) => {
    const state = get();
    const native = nativeBinding(state.projects.find((item) => item.id === id));
    if (native) {
      const project = state.projects.find((item) => nativeBinding(item)?.projectId === native.projectId && !item.parentId);
      if (!project) return undefined;
      const activeId = state.currentProjectId;
      if (activeId && nativeBinding(state.projects.find((item) => item.id === activeId))?.projectId === native.projectId
        && (await get().saveCurrentProjectSilent() !== activeId || get().currentProjectId !== activeId)) {
        get().showToast('项目保存失败，已取消复制', 'error'); return undefined;
      }
      let imported: Awaited<ReturnType<typeof duplicateNativeProjectArchive>> | undefined;
      try {
        imported = await duplicateNativeProjectArchive(native.projectId, `${project.name} 副本`);
        const catalog = await loadProjectCatalog();
        const entry = catalog.native.find((item) => item.project.id === imported!.projectId);
        if (!entry) throw new Error('复制已完成，但项目目录无法刷新');
        const views = projectNativeCatalogEntry(entry);
        const top = views.find((item) => !item.parentId);
        if (!top) throw new Error('复制已完成，但新项目身份无法读取');
        set((current) => ({ projects: [...current.projects.filter((item) => nativeBinding(item)?.projectId !== entry.project.id), ...views] }));
        get().showToast(`已复制为「${imported.projectName}」`);
        return top.id;
      } catch (error) {
        if (imported) {
          get().showToast('项目已复制，但目录刷新失败，请重启后打开', 'info');
          return imported.projectId;
        }
        get().showToast(error instanceof Error ? `项目复制失败：${error.message}` : '项目复制失败', 'error');
        return undefined;
      }
    }
    const ownerId = seriesOwnerId(state.projects, id);
    const project = state.projects.find((item) => item.id === ownerId);
    if (!project) return undefined;

    // 复制读的是 IndexedDB 里已落盘的记录，当前项目必须先把内存改动写回去。
    const activeId = state.currentProjectId;
    if (activeId && seriesOwnerId(state.projects, activeId) === ownerId) {
      if (state.projectLoadStatus !== 'ready') {
        state.showToast('项目尚未成功加载，已阻止复制', 'error');
        return undefined;
      }
      if (await get().saveCurrentProjectSilent() !== activeId || get().currentProjectId !== activeId) {
        get().showToast('项目保存失败，已取消复制', 'error');
        return undefined;
      }
    }

    try {
      const result = await duplicateProjectArchive(
        ownerId,
        `${project.name} 副本`,
      );
      const copy: CanvasProject = {
        id: result.projectId,
        name: result.projectName,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        dataFolder: result.dataFolder,
        settings: result.settings,
        snapshot: result.snapshot,
        series: result.series,
      };
      fileService.registerProjectFolders([copy, ...result.episodes]);
      set((current) => ({ projects: [...current.projects, copy, ...result.episodes] }));
      const episodes = result.episodes.length > 0 ? t('，含 {count} 个分集', { count: result.episodes.length }) : '';
      get().showToast(t('已复制为「{name}」{episodes}', { name: result.projectName, episodes }));
      return result.projectId;
    } catch (error) {
      console.error('[项目复制] 失败:', error);
      get().showToast(error instanceof Error ? t('项目复制失败：{reason}', { reason: error.message }) : '项目复制失败', 'error');
      return undefined;
    }
  },

  prepareProjectImport: () => prepareProjectImport(),
  previewProjectImport: async (session, targetId, confirmedBase) => {
    const state = get();
    const native = nativeBinding(state.projects.find((item) => item.id === targetId));
    if (nativeKnownIds.has(targetId) && !native) throw new Error('新项目身份不可用，请重新打开');
    if (native && (!session.nativeSource || confirmedBase)) throw new Error('新项目更新需要可验证共同版本的项目包');
    if (native && nativeBinding(state.projects.find((item) => item.id === state.currentProjectId))?.projectId === native.projectId) {
      if (await state.saveCurrentProjectSilent() !== state.currentProjectId) throw new Error('当前画布保存失败，无法对比');
    }
    if (!native && state.currentProjectId && seriesOwnerId(state.projects, state.currentProjectId) === targetId) {
      if (await state.saveCurrentProjectSilent() !== state.currentProjectId) throw new Error('当前画布保存失败，无法对比');
    }
    const ids = get().projects.filter((item) => item.id === targetId || item.parentId === targetId).map((item) => item.id);
    await Promise.all(ids.map(waitForProjectSaveQueue));
    const before = get();
    const assertCurrent = () => {
      const latest = get();
      if (latest.currentProjectId !== before.currentProjectId || latest.nodes !== before.nodes || latest.edges !== before.edges
        || latest.groups !== before.groups || latest.dramaAssets !== before.dramaAssets || latest.projects !== before.projects) {
        throw new Error('预览后项目内容已变化，请重新对比');
      }
    };
    const preview = native ? await withPreparedProjectImportRead(session, async () => nativeImportPreview(session.id, targetId,
      await (await import('../services/nativeProjectUpdateService')).previewNativeProjectUpdate(session.nativeSource!, native.projectId, session.directory)))
      : await previewProjectImport(session, targetId, confirmedBase);
    assertCurrent(); importPreviewGuards.set(preview, assertCurrent); return preview;
  },
  importProject: async (session, preview, choices = {}, options = { appendChat: false, appendMemories: false }) => {
    invalidateSeriesLibrarySave();
    if (preview?.nativeUpdate) {
      if (!session || preview.sessionId !== session.id || options.appendChat || options.appendMemories) throw new Error('新项目更新暂不支持追加聊天或记忆，请重新选择');
      const binding = nativeBinding(get().projects.find((item) => item.id === preview.targetId));
      if (!binding || binding.projectId !== preview.nativeUpdate.expected.aggregate.project.id) throw new Error('项目身份已变化，请重新对比');
      const guard = importPreviewGuards.get(preview); if (!guard) throw new Error('预览状态已失效，请重新对比'); guard();
      await withPreparedProjectImportRead(session, () => runNativeImportMutation(set, get, binding.projectId, preview.nativeUpdate!.operationId,
        async (assertCurrent) => { guard(); await (await import('../services/nativeProjectUpdateService')).applyNativeProjectUpdate(preview.nativeUpdate!, choices, assertCurrent); }));
      return binding.projectId;
    }
    if (preview && (nativeKnownIds.has(preview.targetId) || nativeBinding(get().projects.find((item) => item.id === preview.targetId)))) throw new Error('新项目更新预览已失效，请重新对比');
    if (!session || !preview) {
      let imported: Awaited<ReturnType<typeof importNativeProjectArchive>> = null;
      try {
        const result = session ? await importNativeProjectArchiveFromSession(session, options) : await importNativeProjectArchive();
        if (!result) return undefined;
        imported = result;
        const catalog = await loadProjectCatalog();
        const entry = catalog.native.find((item) => item.project.id === result.projectId);
        if (!entry) throw new Error('项目已导入，但项目目录刷新失败，请重启后打开');
        const views = projectNativeCatalogEntry(entry);
        const targetId = entry.episodes[0]?.canvasId ?? entry.canvasIds[0] ?? entry.project.id;
        set((state) => ({ projects: [...state.projects.filter((item) => nativeBinding(item)?.projectId !== entry.project.id), ...views] }));
        const opened = await get().switchProject(targetId) === targetId;
        get().showToast(opened ? `已导入「${result.projectName}」` : `已导入「${result.projectName}」，请从项目库打开`, opened ? undefined : 'info');
        return result.projectId;
      } catch (error) {
        if (imported) {
          get().showToast('项目已导入，但未能自动打开，请从项目库重新打开', 'info');
          return imported.projectId;
        }
        if (session) throw error;
        get().showToast(error instanceof Error ? `项目导入失败：${error.message}` : '项目导入失败', 'error');
        return undefined;
      }
    }
    let result: Awaited<ReturnType<typeof importProjectArchive>>;
    let committed = false, lockedCanvas = false, commitUncertain = false;
    const affected = preview ? get().projects.filter((item) => item.id === preview.targetId || item.parentId === preview.targetId).map((item) => item.id) : [];
    try {
      if (preview) {
        const guard = importPreviewGuards.get(preview); if (!guard) throw new Error('预览状态已失效，请重新对比'); guard();
        if (projectAssetSyncBarriers.has(preview.targetId) || affected.some((id) => projectImportsApplying.has(id))) throw new Error('项目正在同步或应用更新，请稍后重试');
        if (affected.some((id) => getPendingTasksForProject(id).length > 0)
          || get().agentTasks.some((task) => affected.includes(task.projectId) && !['completed', 'failed', 'stopped', 'paused'].includes(task.status))
          || get().videoBatchBusy || get().nodes.some((node) => affected.includes(get().currentProjectId ?? '') && node.data.status === 'loading')) {
          throw new Error('目标项目仍有生成或助手任务，请先停止任务再应用更新');
        }
        affected.forEach((id) => projectImportsApplying.add(id));
        await Promise.all(affected.map(waitForProjectSaveQueue)); guard();
        affected.forEach(cancelProjectCanvasDerivations);
        if (affected.includes(get().currentProjectId ?? '')) { lockedCanvas = true; set({ projectLoadStatus: 'loading' }); }
      }
      result = session ? await applyProjectImport(session, preview ?? null, choices, options, preview ? importPreviewGuards.get(preview) : undefined) : await importProjectArchive();
      committed = !!result;
    } catch (error) {
      if (error instanceof ProjectImportCommittedError) {
        commitUncertain = true;
        if (lockedCanvas) set({ projectLoadStatus: 'error' });
      }
      console.error('[项目导入] 失败:', error);
      get().showToast(error instanceof Error ? t('项目导入失败：{reason}', { reason: error.message }) : '项目导入失败', 'error');
      if (session) throw error;
      return undefined;
    } finally {
      invalidateSeriesLibrarySave();
      affected.forEach((id) => projectImportsApplying.delete(id));
      if (lockedCanvas && !committed) set({ projectLoadStatus: commitUncertain ? 'error' : 'ready' });
    }
    if (!result) return undefined;

    const project: CanvasProject = {
      id: result.projectId,
      name: result.projectName,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      dataFolder: result.dataFolder,
      settings: result.settings,
      snapshot: result.snapshot,
      series: result.series,
    };
    fileService.registerProjectFolders([project, ...result.episodes]);
    let projects: CanvasProject[];
    try {
      const refreshed = await loadProjectCatalog();
      const previous = get().projects;
      projects = refreshed.projects.map((item) => nativeBinding(item) ? previous.find((old) => old.id === item.id) ?? item : item);
    }
    catch { if (lockedCanvas) set({ projectLoadStatus: 'error' }); get().showToast('项目已写入，但项目列表刷新失败，请重启后打开', 'error'); return result.projectId; }
    if (!projects.some((item) => item.id === result.projectId)) {
      if (lockedCanvas) set({ projectLoadStatus: 'error' });
      get().showToast('项目已写入，但项目列表刷新失败，请重启后打开', 'error'); return result.projectId;
    }
    const replacingCurrent = preview && affected.includes(get().currentProjectId ?? '');
    if (replacingCurrent) {
      set({ currentProjectId: null, projectLoadStatus: 'ready', projectName: '', nodes: [], edges: [], groups: [],
        history: [], historyIndex: -1, selectedNodeIds: [], activeNodeId: null, projects });
    } else set({ projects });
    let opened = false;
    try {
      // 项目列表已有全部分集，既有切换流程会打开第一集并加载共享资产。
      const targetId = resolveOpenTargetId(get().projects, result.projectId);
      opened = await get().switchProject(result.projectId) === targetId;
    } catch {
      // 导入已经落盘，打开失败不能把它误报成导入失败。
    }
    const episodes = result.episodes.length > 0 ? t('{count} 个分集、', { count: result.episodes.length }) : '';
    const notices = [
      t('已导入「{name}」，含 {episodes}{count} 个素材', { name: result.projectName, episodes, count: result.assetCount }),
      ...(result.missingAssetCount > 0 ? [t('{count} 个素材未找到', { count: result.missingAssetCount })] : []),
      ...result.warnings.map((warning) => t(warning)),
      ...(!opened ? [t('自动打开失败，请从项目库重新打开')] : []),
    ];
    // 旧包缺失分集与素材的提示保留在同一条反馈，避免成功提示覆盖原因。
    get().showToast(notices.join('；'), notices.length > 1 ? 'info' : undefined);
    return result.projectId;
  },

  restoreProjectImport: async (ownerId, recoveryId) => {
    const binding = nativeBinding(get().projects.find((item) => item.id === ownerId));
    if (nativeKnownIds.has(ownerId) && !binding) throw new Error('新项目身份不可用，请重新打开');
    if (binding) {
      const operationId = crypto.randomUUID();
      const activeId = get().currentProjectId;
      if (nativeBinding(get().projects.find((item) => item.id === activeId))?.projectId === binding.projectId
        && await get().saveCurrentProjectSilent() !== activeId) throw new Error('当前画布保存失败');
      await runNativeImportMutation(set, get, binding.projectId, operationId,
        async (assertCurrent) => (await import('../services/nativeProjectUpdateService')).restoreNativeContentRecovery(binding.projectId, recoveryId, operationId, assertCurrent));
      get().showToast('已恢复项目，恢复前的状态也已保存为恢复点'); return;
    }
    invalidateSeriesLibrarySave();
    if (projectAssetSyncBarriers.has(ownerId)) throw new Error('项目正在同步，请稍后恢复');
    const affected = get().projects.filter((item) => item.id === ownerId || item.parentId === ownerId).map((item) => item.id);
    if (!affected.length || affected.some((id) => projectImportsApplying.has(id) || getPendingTasksForProject(id).length)
      || get().agentTasks.some((task) => affected.includes(task.projectId) && !['completed', 'failed', 'stopped', 'paused'].includes(task.status))
      || get().videoBatchBusy) throw new Error('项目正在执行任务或更新，请先停止后再恢复');
    if (affected.includes(get().currentProjectId ?? '')) {
      const id = get().currentProjectId; if (await get().saveCurrentProjectSilent() !== id) throw new Error('当前画布保存失败');
    }
    affected.forEach((id) => projectImportsApplying.add(id));
    let lockedCanvas = false, committed = false, projected = false, commitUncertain = false;
    try {
      await Promise.all(affected.map(waitForProjectSaveQueue));
      const before = get();
      const assertCurrent = () => { const current = get();
        if (current.nodes !== before.nodes || current.edges !== before.edges || current.groups !== before.groups
          || current.projects !== before.projects || current.dramaAssets !== before.dramaAssets) throw new Error('恢复期间项目发生变化，请重试'); };
      affected.forEach(cancelProjectCanvasDerivations);
      if (affected.includes(get().currentProjectId ?? '')) { lockedCanvas = true; set({ projectLoadStatus: 'loading' }); }
      await restoreProjectImportRecovery(ownerId, recoveryId, assertCurrent);
      committed = true;
      const refreshed = await loadProjectCatalog();
      const previous = get().projects;
      const projects = refreshed.projects.map((item) => nativeBinding(item) ? previous.find((old) => old.id === item.id) ?? item : item);
      if (!projects.some((item) => item.id === ownerId)) throw new Error('恢复已提交，项目列表刷新失败，请重启后打开');
      if (affected.includes(get().currentProjectId ?? '')) set({ currentProjectId: null, projectLoadStatus: 'ready', projectName: '',
        nodes: [], edges: [], groups: [], history: [], historyIndex: -1, selectedNodeIds: [], activeNodeId: null, projects });
      else set({ projects });
      projected = true;
      // 在后续切换加载之前释放屏障；空画布不会把旧内容重新保存。
      invalidateSeriesLibrarySave();
      affected.forEach((id) => projectImportsApplying.delete(id));
      await get().switchProject(ownerId); get().showToast('已恢复项目，恢复前的状态也已保存为恢复点');
    } catch (error) {
      if (error instanceof ProjectImportCommittedError) commitUncertain = true;
      throw error;
    } finally {
      invalidateSeriesLibrarySave();
      affected.forEach((id) => projectImportsApplying.delete(id));
      if (lockedCanvas && !projected) set({ projectLoadStatus: committed || commitUncertain ? 'error' : 'ready' });
    }
  },

  deleteProject: async (id) => {
    const state = get();
    const target = state.projects.find((project) => project.id === id);
    if (!target) return;
    if (state.projectLoadStatus !== 'ready' || state.switchingProjectName !== null
      || state.isCreatingProject || state.isReturningToStartPage) {
      get().showToast('项目导航中，已取消删除', 'error'); return;
    }
    const native = nativeBinding(target);
    if (native) {
      const activeId = state.currentProjectId;
      const activeBinding = nativeBinding(state.projects.find((item) => item.id === activeId));
      const activeOwner = activeBinding?.projectId === native.projectId;
      if (activeOwner && activeId && await get().saveCurrentProjectSilent() !== activeId) return;
      if (projectImportsApplying.has(native.projectId)) return;
      const sequence = ++projectSwitchSequence;
      const assertCurrent = () => { if (sequence !== projectSwitchSequence || get().currentProjectId !== activeId) throw new Error('项目已切换，删除已停止'); };
      const previousContext = get().projectExecutionContext;
      let previousRevision: number | undefined, writeStarted = false;
      projectImportsApplying.add(native.projectId);
      if (activeOwner) set({ switchingProjectName: '正在删除项目', projectExecutionContext: null });
      try {
        const capture = await readNativeProjectCapture(native.projectId);
        if (!capture) throw new Error('项目不存在');
        previousRevision = capture.changeRevision;
        assertCurrent();
        if (native.episodeId) {
          const episode = capture.aggregate.episodes.find((item) => item.id === native.episodeId);
          const body = capture.aggregate.episodeContents.find((item) => item.episodeId === native.episodeId);
          const canvas = capture.aggregate.canvases.find((item) => item.id === native.canvasId);
          if (!episode || !body || !canvas) throw new Error('分集身份已变化');
          cancelProjectCanvasDerivations(canvas.id); stopProjectAgentTasks(canvas.id);
          writeStarted = true;
          await deleteNativeEpisode({ projectId: native.projectId, expectedProjectEpoch: capture.aggregate.project.epoch,
            episodeId: episode.id, expectedCanvasId: canvas.id, expectedEpisodeRevision: episode.revision,
            expectedContentRevision: body.revision, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision });
        } else {
          const ids = capture.aggregate.canvases.map((canvas) => canvas.id);
          ids.forEach((canvasId) => { cancelProjectCanvasDerivations(canvasId); stopProjectAgentTasks(canvasId); });
          writeStarted = true;
          await deleteNativeProject({ projectId: native.projectId, expectedProjectEpoch: capture.aggregate.project.epoch,
            expectedChangeRevision: capture.changeRevision });
          stopPollingForDeletedProjects(ids);
        }
        const catalog = await loadProjectCatalog();
        assertCurrent();
        const entry = catalog.native.find((item) => item.project.id === native.projectId);
        if (entry) {
          if (activeOwner && activeId) {
            const nextId = activeId === id ? (entry.episodes[0]?.canvasId ?? entry.project.id) : activeId;
            await activateNativeProject(set, get, entry, nextId, assertCurrent, nextId === activeId);
            if (nextId !== activeId) {
              rememberActiveProject(nextId);
              get().loadConversationsForProject(nextId).catch((e) => console.warn('[删除分集] 加载会话失败:', e));
              get().repairInterruptedForProject(nextId).catch((e) => console.warn('[删除分集] 修复中断消息失败:', e));
              get().loadAgentTasksForProject(nextId).catch((e) => console.warn('[删除分集] 加载任务失败:', e));
              get().loadProjectMemoriesForProject(native.projectId).catch((e) => console.warn('[删除分集] 加载项目记忆失败:', e));
            }
          } else set((current) => ({ projects: [...current.projects.filter((item) => nativeBinding(item)?.projectId !== native.projectId), ...projectNativeCatalogEntry(entry)] }));
        } else {
          set((current) => ({ projects: current.projects.filter((item) => nativeBinding(item)?.projectId !== native.projectId),
            ...(activeOwner ? { currentProjectId: null, projectExecutionContext: undefined, projectName: '', nodes: [], edges: [], groups: [],
              history: [], historyIndex: -1, selectedNodeIds: [], activeConversationId: null, projectLoadStatus: 'ready' as const } : {}) }));
        }
      } catch (error) {
        if (activeOwner && get().currentProjectId === activeId && sequence === projectSwitchSequence) {
          let unchanged = !writeStarted;
          if (writeStarted && previousRevision !== undefined) try {
            unchanged = (await readNativeProjectCapture(native.projectId))?.changeRevision === previousRevision;
          } catch { /* 无法核实提交结果 */ }
          if (get().currentProjectId === activeId && sequence === projectSwitchSequence) set(unchanged
            ? { projectLoadStatus: 'ready', projectExecutionContext: previousContext }
            : { projectLoadStatus: 'error', projectExecutionContext: null });
        }
        get().showToast(error instanceof Error ? error.message : '删除失败，原数据已保留', 'error');
      } finally {
        projectImportsApplying.delete(native.projectId);
        if (activeOwner) set({ switchingProjectName: null });
      }
      return;
    }
    const siblings = target.parentId ? listEpisodes(state.projects, target.parentId) : [];
    // v3 不能无损表示零集剧集。新模型启用前拒绝该操作，绝不能顺带删除整部剧。
    if (target.parentId && siblings.length <= 1) {
      get().showToast('当前旧项目格式暂不支持删除最后一集，已保留整部剧', 'error'); return;
    }
    const removedIds = [
      id,
      ...listEpisodes(state.projects, id).map((episode) => episode.id),
    ];
    const removedIdSet = new Set(removedIds);
    const lockedIds = target.parentId ? [...removedIds, target.parentId] : removedIds;
    if (lockedIds.some((projectId) => projectImportsApplying.has(projectId) || projectAssetSyncBarriers.has(projectId))) {
      get().showToast('项目正在更新，已取消删除', 'error'); return;
    }
    invalidateSeriesLibrarySave();
    const deletionSequence = ++projectSwitchSequence;
    lockedIds.forEach((projectId) => projectImportsApplying.add(projectId));
    removedIds.forEach((removedId) => {
      cancelProjectCanvasDerivations(removedId);
      stopProjectAgentTasks(removedId);
    });
    try {
      await Promise.all(lockedIds.map((projectId) => waitForProjectSaveQueue(projectId)));
      await Promise.all(lockedIds.map((projectId) => episodeCreativeWrites.get(projectId)?.catch(() => undefined)));
      await deleteLegacyProjectContent({ targetId: id,
        expectedProjects: state.projects.filter((project) => removedIdSet.has(project.id)),
        assertCurrent: () => {
          if (projectSwitchSequence !== deletionSequence || get().currentProjectId !== state.currentProjectId
            || get().switchingProjectName !== null || get().isCreatingProject || get().isReturningToStartPage) {
            throw new Error('项目已切换，已取消旧删除请求');
          }
        } });
    } catch (error) {
      console.warn('[删除项目] 逻辑删除失败:', error);
      get().showToast('项目未删除；已停止的任务不会自动重启', 'error');
      return;
    } finally { lockedIds.forEach((projectId) => projectImportsApplying.delete(projectId)); }
    // 永久停写只在业务删除真正提交后登记；失败项目仍可正常继续查询原回执。
    stopPollingForDeletedProjects(removedIds);
    const viewState = get();
    const filtered = viewState.projects.filter((project) => !removedIdSet.has(project.id));
    const isCurrent = Boolean(viewState.currentProjectId && removedIdSet.has(viewState.currentProjectId));
    const deletedConversationIds = new Set([
      ...viewState.conversations
        .filter((conversation) => removedIdSet.has(conversation.projectId))
        .map((conversation) => conversation.id),
      ...viewState.agentTasks
        .filter((task) => removedIdSet.has(task.projectId))
        .map((task) => task.conversationId),
    ]);
    for (const conversationId of deletedConversationIds) {
      clearConversationFileGrants(conversationId);
    }
    const retainedChatState = {
      conversations: viewState.conversations.filter((conversation) => !removedIdSet.has(conversation.projectId)),
      messages: viewState.messages.filter((message) => !deletedConversationIds.has(message.conversationId)),
      activeConversationId: viewState.activeConversationId
        && deletedConversationIds.has(viewState.activeConversationId)
        ? null
        : viewState.activeConversationId,
    };

    if (isCurrent && filtered.length === 1 && filtered[0]?.id === 'default') {
      set({
        projects: [], currentProjectId: null, projectExecutionContext: undefined, projectName: '',
        projectLoadStatus: 'ready',
        nodes: [],
        edges: [],
        groups: [],
        history: [],
        historyIndex: -1,
        dramaAssets: { version: 2 as const, characters: [], scenes: [], props: [] },
        operationLogs: [],
        ...retainedChatState,
      });
      await get().createProject('默认画布');
    } else {
      // 替补项目可能是个剧集，剧集自己没有画布，要落到它的第一集上。
      const fallbackId = listTopLevelProjects(filtered)[0]?.id;
      const nextId = isCurrent
        ? (fallbackId ? resolveOpenTargetId(filtered, fallbackId) : null)
        : viewState.currentProjectId;
      const nextName = isCurrent
        ? filtered.find((project) => project.id === nextId)?.name ?? ''
        : viewState.projectName;

      set({
        projects: filtered,
        currentProjectId: nextId,
        ...(isCurrent ? { projectLoadStatus: nextId ? 'loading' as const : 'ready' as const } : {}),
        ...retainedChatState,
        ...(isCurrent
          ? {
              projectExecutionContext: undefined,
              projectName: nextName,
              nodes: [],
              edges: [],
              groups: [],
              history: [],
              historyIndex: -1,
              dramaAssets: { version: 2 as const, characters: [], scenes: [], props: [] },
              operationLogs: [],
            }
          : {}),
      });

      if (isCurrent && nextId) {
        const nextBinding = nativeBinding(filtered.find((project) => project.id === nextId));
        if (nextBinding) {
          try {
            const catalog = await loadProjectCatalog();
            const entry = catalog.native.find((item) => item.project.id === nextBinding.projectId);
            if (!entry) throw new Error('替代项目已不存在');
            const assertCurrent = () => { if (projectSwitchSequence !== deletionSequence || get().currentProjectId !== nextId) throw new Error('项目已切换'); };
            await activateNativeProject(set, get, entry, nextId, assertCurrent);
            rememberActiveProject(nextId);
          } catch (error) {
            set({ projectLoadStatus: 'error', projectExecutionContext: null });
            get().showToast(error instanceof Error ? error.message : '替代项目加载失败', 'error');
          }
          return;
        }
        const isCurrentReplacement = () => projectSwitchSequence === deletionSequence
          && get().currentProjectId === nextId && get().projects.some((project) => project.id === nextId);
        const loadOptions = { recoverUndoTrash: true, assertCurrent: () => {
          if (!isCurrentReplacement()) throw new Error('项目已切换');
        } };
        const data = await fileService.loadProjectData(nextId, loadOptions);
        if (!isCurrentReplacement()) return;
        const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
        if (!isCurrentReplacement()) return;
        if (hasProjectCanvasData(data)) {
          const ownerId = data.parentId ?? nextId;
          const ownerData = ownerId === nextId ? data : await fileService.loadProjectData(ownerId, loadOptions);
          if (!isCurrentReplacement()) return;
          if (!hasProjectCanvasData(ownerData) || ownerData.parentId || ownerData.id !== ownerId
            || (ownerData.exchangeEpoch ?? 0) < (get().projects.find((item) => item.id === ownerId)?.exchangeEpoch ?? 0)) {
            set({ projectLoadStatus: 'error' });
            get().showToast('替代项目的所属剧集加载失败，已阻止空共享资料覆盖原数据', 'error');
            return;
          }
          set({
            projects: withLoadedProjectSummaries(get().projects, data, ownerData),
            projectName: data.name,
            nodes: data.nodes as Node<BaseNodeData>[],
            edges: data.edges as Edge[],
            groups: getProjectGroups(data),
            dramaAssets: ownerData?.dramaAssets ?? emptyDramaAssetLibrary(),
            projectLoadStatus: 'ready',
          });
          rememberActiveProject(nextId);
          setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
          get().loadConversationsForProject(nextId).catch((e) => console.warn('[删除项目] 加载会话失败:', e));
          get().repairInterruptedForProject(nextId).catch((e) => console.warn('[删除项目] 修复中断消息失败:', e));
          get().loadAgentTasksForProject(nextId).catch((e) => console.warn('[删除项目] 加载 Agent 任务失败:', e));
          get().loadProjectMemoriesForProject(ownerId).catch((e) => console.warn('[删除项目] 加载项目记忆失败:', e));
        } else {
          set({ projectLoadStatus: 'error', dramaAssets: emptyDramaAssetLibrary() });
          get().showToast('替代项目加载失败，已阻止空画布覆盖原数据', 'error');
        }
      }
    }

    // 目录和审计材料不与业务删除级联。历史费用/回执可能仍引用它们，后续显式恢复/清理处理。
  },

  switchProject: async (requestedId, options) => {
    invalidateSeriesLibrarySave();
    if (options?.signal?.aborted || get().isReturningToStartPage || get().isCreatingProject
      || get().projectLoadStatus === 'loading') return;
    if (!get().projects.some((project) => project.id === requestedId)) return;
    if (projectImportsApplying.has(requestedId)
      || projectImportsApplying.has(seriesOwnerId(get().projects, requestedId))) return;
    // 剧集项目自身没有画布，点它等于打开它的分集。
    // ponytail: 固定开第一集；要「回到上次打开的那集」再往剧集记录里存一个 lastEpisodeId。
    const id = resolveOpenTargetId(get().projects, requestedId);
    const switchSequence = ++projectSwitchSequence;
    const isLatestSwitch = () => switchSequence === projectSwitchSequence && !options?.signal?.aborted
      && !projectImportsApplying.has(id) && !projectImportsApplying.has(seriesOwnerId(get().projects, id));
    const currentProjectId = get().currentProjectId;
    const previousOwnerId = currentProjectId
      ? seriesOwnerId(get().projects, currentProjectId)
      : null;
    if (currentProjectId && currentProjectId !== id) {
      cancelProjectCanvasDerivations(currentProjectId);
    }
    // 遮罩由 switchingProjectName 驱动；后来的切换会接管它，所以只有最新一次负责收尾。
    set({ switchingProjectName: get().projects.find((p) => p.id === id)?.name ?? '' });
    try {
      if (get().projectLoadStatus === 'ready') {
        if (options?.captureSnapshot) {
          void get().captureCurrentProjectSnapshot({
            allowProjectChange: true,
            persistSnapshot: true,
          });
        }
        const savedId = await get().saveCurrentProject();
        if (!isLatestSwitch()) return;
        if (currentProjectId && savedId !== currentProjectId) {
          get().showToast('当前项目保存失败，已取消项目切换', 'error');
          return;
        }
      }
      if (!isLatestSwitch()) return;

      const project = get().projects.find((p) => p.id === id);
      if (!project) return;

      const native = nativeBinding(project);
      if (native) {
        const catalog = await loadProjectCatalog();
        if (!isLatestSwitch()) return;
        const entry = catalog.native.find((item) => item.project.id === native.projectId);
        if (!entry) throw new Error('新项目已不存在');
        const openedId = await activateNativeProject(set, get, entry, id, () => { if (!isLatestSwitch()) throw new Error('项目切换已取消'); });
        rememberActiveProject(openedId);
        get().loadConversationsForProject(openedId).catch((e) => console.warn('[切换项目] 加载会话失败:', e));
        get().repairInterruptedForProject(openedId).catch((e) => console.warn('[切换项目] 修复中断消息失败:', e));
        get().loadAgentTasksForProject(openedId).catch((e) => console.warn('[切换项目] 加载 Agent 任务失败:', e));
        get().loadProjectMemoriesForProject(native.projectId).catch((e) => console.warn('[切换项目] 加载项目记忆失败:', e));
        setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
        return openedId;
      }

      fileService.ensureProjectDataDir(id).catch((e) => console.warn('[切换项目] 数据目录初始化失败:', e));

      const loadOptions = { recoverUndoTrash: true, assertCurrent: () => {
        if (!isLatestSwitch()) throw new Error('项目切换已取消');
      } };
      const data = await fileService.loadProjectData(id, loadOptions);
      if (!isLatestSwitch()) return;
      const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
      if (!isLatestSwitch()) return;
      if (!hasProjectCanvasData(data) || data.id !== id
        || (data.exchangeEpoch ?? 0) < (get().projects.find((item) => item.id === id)?.exchangeEpoch ?? 0)) {
        get().showToast('项目加载失败，已保留当前画布并阻止覆盖保存', 'error');
        return;
      }

      // 角色库归剧集项目所有；同一部剧内换集时内存里的那份就是对的，不用再读盘。
      const ownerId = data.parentId ?? id;
      let dramaAssets = get().dramaAssets;
      let ownerData: ProjectSaveData | null = null;
      if (ownerId === id || ownerId !== previousOwnerId) {
        ownerData = ownerId === id ? data : await fileService.loadProjectData(ownerId, loadOptions);
        if (!isLatestSwitch()) return;
        if (!hasProjectCanvasData(ownerData) || ownerData.parentId || ownerData.id !== ownerId
          || (ownerData.exchangeEpoch ?? 0) < (get().projects.find((item) => item.id === ownerId)?.exchangeEpoch ?? 0)) {
          get().showToast('所属项目加载失败，已保留当前画布与共享资料', 'error');
          return;
        }
        dramaAssets = ownerData.dramaAssets ?? emptyDramaAssetLibrary();
      }

      set({
        projects: withLoadedProjectSummaries(get().projects, data, ownerData),
        currentProjectId: id,
        projectExecutionContext: undefined,
        projectName: data.name,
        projectLoadStatus: 'ready',
        nodes: data.nodes as Node<BaseNodeData>[],
        edges: data.edges as Edge[],
        groups: getProjectGroups(data),
        history: [],
        historyIndex: -1,
        dramaAssets,
      });
      rememberActiveProject(id);
      // 恢复当前项目的待续轮询任务
      // finally清除切换标记后才能取得本次恢复租约，不能在loading边界重绑。
      queueMicrotask(() => {
        if (switchSequence !== projectSwitchSequence || get().currentProjectId !== id || get().switchingProjectName !== null) return;
        resumePendingTasks(id).catch((e) => console.warn('[切换项目] 恢复待续任务失败:', e));
      });
      // 加载聊天会话
      get().loadConversationsForProject(id).catch((e) => console.warn('[切换项目] 加载会话失败:', e));
      get().repairInterruptedForProject(id).catch((e) => console.warn('[切换项目] 修复中断消息失败:', e));
      // 项目切换只加载任务，不把应用运行期间的后台任务误判为中断。
      get().loadAgentTasksForProject(id).catch((e) => console.warn('[切换项目] 加载 Agent 任务失败:', e));
      // 项目记忆整部剧共用，按剧集项目加载。
      get().loadProjectMemoriesForProject(ownerId).catch((e) => console.warn('[切换项目] 加载项目记忆失败:', e));

      setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
      return id;
    } catch (error) {
      if (isLatestSwitch()) get().showToast(error instanceof Error ? error.message : '项目切换失败，已保留当前画布', 'error');
      return undefined;
    } finally {
      if (switchSequence === projectSwitchSequence) set({ switchingProjectName: null });
    }
  },

  returnToStartPage: async () => {
    const state = get();
    if (!state.currentProjectId) return true;
    if (state.isReturningToStartPage || state.isCreatingProject || state.switchingProjectName !== null) return false;
    if (state.projectLoadStatus !== 'ready') {
      state.showToast('项目尚未成功加载，暂时无法返回启动页', 'error');
      return false;
    }
    const projectId = state.currentProjectId;
    const sequence = projectSwitchSequence;
    set({ isReturningToStartPage: true });
    try {
      // 先绘制返回状态。缩略图是派生预览，不能阻塞必要保存和导航。
      await waitForLoadingPaint();
      if (get().currentProjectId !== projectId || projectSwitchSequence !== sequence) return false;
      const savingState = get();
      // 正文先入队，空图清理或缓存预览的补丁随后排队，不能抢占必要保存。
      const saving = savingState.saveCurrentProjectSilent();
      void get().captureCurrentProjectSnapshot({ allowProjectChange: true, persistSnapshot: true })
        .catch(() => undefined);
      const savedId = await saving;
      if (savedId !== projectId || get().currentProjectId !== projectId || projectSwitchSequence !== sequence) return false;
      const latest = get();
      // 保存期间 MCP 或生成任务仍可回填；卸载前必须确认没有落在这次快照之后的新内容。
      if (latest.nodes !== savingState.nodes || latest.edges !== savingState.edges
        || latest.groups !== savingState.groups || latest.dramaAssets !== savingState.dramaAssets) {
        latest.showToast('保存期间画布有新变化，已保留当前项目，请稍后再返回启动页', 'error');
        return false;
      }
      cancelProjectCanvasDerivations(projectId);
      if (lastCapturedCanvasState?.projectId === projectId) lastCapturedCanvasState = null;
      set({
        currentProjectId: null,
        projectExecutionContext: undefined,
        projectName: '',
        projectLoadStatus: 'ready',
        nodes: [], edges: [], groups: [],
        history: [], historyIndex: -1, selectedNodeIds: [],
        activeNodeId: null, dialogPosition: null, pendingPresetAction: null,
        nodeMenuVisible: false, nodePickerOpen: false, projectLibraryOpen: false,
        assetsPanelOpen: false, characterLibraryOpen: false, characterActionLibraryOpen: false,
        historyPanelOpen: false, dramaAssetsPanelOpen: false, workflowPanelOpen: false,
        chatOpen: false, activeConversationId: null, chatComposerLiveDraft: '', reversePromptRequest: null,
      });
      return true;
    } catch {
      get().showToast('返回启动页失败，已保留当前画布，请重试', 'error');
      return false;
    } finally {
      set({ isReturningToStartPage: false });
    }
  },

  saveCurrentProject: () => trackProjectSave(get().currentProjectId, async (projectId) => {
    const syncPending = waitForProjectAssetSync(get);
    if (syncPending) await syncPending;
    const state = get();
    if (state.currentProjectId !== projectId) return undefined;
    if (state.currentProjectId && state.projectLoadStatus !== 'ready') {
      // 加载中只是还没就绪，不算故障；加载失败才记进退出拦截状态
      if (state.projectLoadStatus === 'error') {
        noteSaveFailure(set, get, {
          kind: 'load-error',
          reason: '项目加载失败，已阻止空画布覆盖原数据',
          notify: false,
        });
      }
      state.showToast('项目尚未成功加载，已阻止覆盖保存', 'error');
      return undefined;
    }
    const record = createCurrentProjectSaveRecord(state);
    if (!record) return undefined;
    try {
      if (nativeBinding(state.projects.find((item) => item.id === record.id))) await saveNativeCurrentProject(get, state, record);
      else await saveCurrentProjectRecord(state, record);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === record.id ? { ...p, updatedAt: record.updatedAt, name: record.name } : p
        ),
      }));
      clearSaveFailure(set, get);
      get().showToast('项目已保存');
      return record.id;
    } catch (error) {
      console.error('Save failed:', error);
      // 手动保存本来就每次都给反馈，交给 toast 自己说，不走去重逻辑
      const failure = await noteSaveError(set, get, error, false);
      get().showToast(t('保存失败：{reason}', { reason: failure.reason }), 'error');
      return undefined;
    }
  }),

  /** 静默保存（不弹 toast），用于自动保存 */
  saveCurrentProjectSilent: (assertCurrent) => trackProjectSave(get().currentProjectId, async (projectId) => {
    assertCurrent?.();
    const syncPending = waitForProjectAssetSync(get);
    if (syncPending) await syncPending;
    assertCurrent?.();
    const state = get();
    if (state.currentProjectId !== projectId) return undefined;
    if (state.currentProjectId && state.projectLoadStatus !== 'ready') {
      if (state.projectLoadStatus === 'error') {
        noteSaveFailure(set, get, {
          kind: 'load-error',
          reason: '项目加载失败，已阻止空画布覆盖原数据',
          notify: true,
        });
      }
      return undefined;
    }
    const record = createCurrentProjectSaveRecord(state);
    if (!record) return undefined;
    try {
      if (nativeBinding(state.projects.find((item) => item.id === record.id))) await saveNativeCurrentProject(get, state, record, assertCurrent);
      else await saveCurrentProjectRecord(state, record, assertCurrent);
      assertCurrent?.();
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === record.id ? { ...p, updatedAt: record.updatedAt, name: record.name } : p
        ),
      }));
      clearSaveFailure(set, get);
      return record.id;
    } catch (error) {
      console.warn('[自动保存] 保存失败:', error);
      await noteSaveError(set, get, error, true);
      return undefined;
    }
  }),

  applyCharacterVisualReferencePlan: async (plan, nodeIds, assertEditorCurrent) => {
    const before = get();
    const { context, characterId, referenceId } = plan;
    const stale = () => new Error(t('角色引用或画布已变化，请重新预览'));
    assertEditorCurrent?.();
    if (!isProjectExpectedContextCurrent(context, before)) throw stale();
    const { planCharacterVisualReferences } = await import('../services/characterVisualReferencePlan');
    const current = get();
    const character = current.dramaAssets.characters.find((item) => item.id === characterId);
    if (!character || !isProjectExpectedContextCurrent(context, current)) throw stale();
    const fresh = planCharacterVisualReferences(context, current.nodes, character, referenceId,
      new Set(getPendingTasksForProject(context.canvasId).map((task) => task.nodeId)));
    const selected = new Set(nodeIds);
    const requested = plan.changes.filter((entry) => selected.has(entry.nodeId));
    const changes = new Map(fresh.changes.filter((entry) => selected.has(entry.nodeId)).map((entry) => [entry.nodeId, entry]));
    if (!selected.size || requested.length !== selected.size || changes.size !== selected.size
      || plan.referenceUrl !== fresh.referenceUrl
      || requested.some((entry) => !configValuesEqual(entry, changes.get(entry.nodeId)))) throw stale();

    const patchNodes = (nodes: AppState['nodes']) => nodes.map((node) => {
      const change = changes.get(node.id);
      if (!change) return node;
      const promptChanged = !!change.promptMatches && node.data.prompt === change.originalPrompt;
      const videoChanged = !!change.videoMatches && configValuesEqual(node.data.videoReferences, change.originalVideoReferences);
      if (!promptChanged && !videoChanged) return node;
      return { ...node, data: { ...node.data, ...(promptChanged ? { prompt: change.nextPrompt } : {}),
        ...(videoChanged ? { videoReferences: change.nextVideoReferences } : {}) } };
    });
    const nodes = patchNodes(current.nodes);
    const record = createCurrentProjectSaveRecord({ ...current, nodes });
    const runtime = nativeRuntime.get(get);
    const mediaGeneration = runtime?.mediaGeneration;
    if (!record) throw stale();
    const controller = new AbortController();
    const guard = registerCanvasImport(current, () => controller.abort(stale()));
    if (!guard) throw stale();
    const assertSaveCurrent = () => {
      controller.signal.throwIfAborted();
      assertEditorCurrent?.();
      const live = get();
      if (!isCanvasDerivationFresh(guard, live) || !isProjectExpectedContextCurrent(context, live)
        || live.nodes !== current.nodes || live.edges !== current.edges || live.groups !== current.groups
        || live.dramaAssets !== current.dramaAssets || projectAssetSyncBarriers.has(context.projectId)
        || getPendingTasksForProject(context.canvasId).some((task) => selected.has(task.nodeId))
        || projectImportsApplying.has(context.projectId) || (context.modelGeneration === 1
          && (nativeRuntime.get(get) !== runtime || runtime?.mediaGeneration !== mediaGeneration))) throw stale();
    };

    const unsubscribe = api.subscribe(() => { try { assertSaveCurrent(); } catch { controller.abort(stale()); } });
    const projectCommitted = (queue?: ProjectSaveQueue) => {
      unsubscribe();
      const live = get();
      if (!isProjectExpectedContextCurrent(context, live, { checkCanvasRevision: false })) return;
      if (queue) {
        const queued = [queue.pending, ...(queue.pendingBatches ?? [])];
        for (const item of queued) {
          if (item && !item.guard && Array.isArray(item.record.nodes)) {
            item.record = { ...item.record, nodes: patchNodes(item.record.nodes as AppState['nodes']) };
          }
        }
      }
      const projected = patchNodes(live.nodes);
      if (projected.some((node, index) => node !== live.nodes[index])) {
        live.commitCharacterVisualHistory([...changes.values()]);
        set({ nodes: projected });
        get().incrementRevision();
      }
    };

    try {
      const saved = await trackProjectSave(context.canvasId, async () => {
        assertSaveCurrent();
        const projection = { signal: controller.signal, commit: projectCommitted };
        return context.modelGeneration === 1 ? saveNativeCurrentProject(get, current, record, assertSaveCurrent, undefined, projection)
          : enqueueProjectSave(record, assertSaveCurrent, projection);
      });
      if (saved !== context.canvasId) throw new Error(t('角色引用保存失败，请重新预览'));
      return selected.size;
    } finally {
      unsubscribe();
      completeCanvasDerivation(guard);
    }
  },

  commitSharedAssetSyncDownload: async (input) => {
    const originProject = get().projects.find((project) => project.id === input.originProjectId);
    const native = nativeBinding(originProject);
    if ((nativeKnownIds.has(input.ownerId) || nativeKnownIds.has(input.originProjectId)) && !native) {
      throw new Error('新项目身份不可用，请重新打开');
    }
    if (input.commit.ownerId !== input.ownerId || projectAssetSyncBarriers.has(input.ownerId) || projectImportsApplying.has(input.ownerId)) {
      throw new Error('该项目正在应用共享资产，请稍后重试');
    }
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason ?? input.commit.signal?.reason);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      input.signal?.throwIfAborted();
      input.commit.signal?.throwIfAborted();
      input.assertCurrent?.();
      input.commit.assertCurrent?.();
      const current = get();
      if (current.projectLoadStatus !== 'ready' || current.currentProjectId !== input.originProjectId
        || (native ? nativeBinding(current.projects.find((project) => project.id === input.originProjectId))?.projectId !== input.ownerId
          : !current.projects.some((project) => project.id === input.ownerId)
            || seriesOwnerId(current.projects, input.originProjectId) !== input.ownerId)
        || current.dramaAssets !== input.expectedLibrary) {
        throw new Error('项目或资产内容已变化，请重新预览');
      }
    };
    assertCurrent();
    input.signal?.addEventListener('abort', abort, { once: true });
    input.commit.signal?.addEventListener('abort', abort, { once: true });
    let release!: () => void;
    const barrier: ProjectAssetSyncBarrier = {
      done: new Promise<void>((resolve) => { release = resolve; }), library: input.expectedLibrary,
    };
    invalidateSeriesLibrarySave();
    const precedingNativeSaves = native ? [...(pendingProjectSaves.get(input.originProjectId) ?? [])] : [];
    projectAssetSyncBarriers.set(input.ownerId, barrier);
    let unsubscribe = api.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
    try {
      // 屏障先登记，再等旧 active/pending 写完；后来的自动保存不能挤到下载提交后面写旧库。
      if (native) {
        const results = await Promise.allSettled(precedingNativeSaves);
        if (results.some((result) => result.status === 'rejected' || result.value !== input.originProjectId)) throw new Error('当前画布保存失败');
      } else await waitForProjectSaveQueue(input.ownerId);
      assertCurrent();
      if (native) {
        const runtime = nativeRuntime.get(get);
        if (!runtime || runtime.activeId !== input.originProjectId || native.projectId !== input.ownerId) throw new Error('新项目上下文不可用');
        const source = await readNativeProjectContent(native.projectId);
        assertCurrent();
        if (!source || source.project.epoch !== runtime.loaded.selection.project.epoch
          || !configValuesEqual(source.content, runtime.loaded.content)) throw new Error('共享资料已变化，请重新预览');
        let nextLibrary: DramaAssetLibrary | undefined;
        if (input.nextLibrary) {
          const record = createCurrentProjectSaveRecord({ ...get(), dramaAssets: input.nextLibrary });
          if (!record) throw new Error('所属项目已变化，请重新预览');
          nextLibrary = (await serializeProjectRecord({ ...record, dramaAssets: input.nextLibrary })).dramaAssets;
          if (!nextLibrary) throw new Error('共享资料无法序列化');
          assertCurrent();
        }
        const { signal: _signal, assertCurrent: _assertCurrent, nativeAuthority: _authority,
          ...commitRecords } = input.commit;
        const receiptDigest = await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken({
          projectId: native.projectId, projectEpoch: source.project.epoch, expectedContent: source.content,
          nextLibrary, commit: commitRecords,
        })));
        assertCurrent();
        const { captureNativeSharedAssetSources } = await import('../services/indexedDb/nativeSharedAssetSources');
        const nativeAssets = await captureNativeSharedAssetSources(input.commit);
        let journalPrepared = false;
        try {
          const journal = await prepareNativeSharedAssetSync({ projectId: native.projectId, operationId: input.commit.operationId,
            expectedProjectEpoch: source.project.epoch, expectedAssetsRevision: source.content.revisions.assets,
            expectedLibrary: source.content.dramaAssets, ...(nextLibrary ? { nextLibrary } : {}), receiptDigest, ...(nativeAssets.length ? { nativeAssets } : {}) },
          { signal: controller.signal });
          journalPrepared = true;
          assertCurrent();
          const result = await applySharedAssetSyncCommit({ ...input.commit, signal: controller.signal, assertCurrent, onCommitted: undefined,
            nativeAuthority: { projectId: native.projectId, memberIds: journal.memberIds, receiptDigest } });
          // 旧库事务已提交后即使取消也必须完成原 journal，不能把已应用的索引当作失败撤销。
          await finalizeNativeSharedAssetSync(journal);
          const latest = await readNativeProjectContent(native.projectId);
          if (!latest) throw new Error('共享资料已提交，但项目读取失败');
          runtime.loaded = { ...runtime.loaded, selection: { ...runtime.loaded.selection, project: latest.project,
            changeRevision: latest.changeRevision, context: { ...runtime.loaded.selection.context, projectEpoch: latest.project.epoch } },
            content: latest.content };
          if (input.nextLibrary) { runtime.library = input.nextLibrary; barrier.library = input.nextLibrary; }
          const current = get();
          if (current.currentProjectId === input.originProjectId && current.projectLoadStatus === 'ready'
            && current.dramaAssets === input.expectedLibrary && projectMemoryOwnerId(current.projects, input.originProjectId) === input.ownerId) {
            unsubscribe(); unsubscribe = () => undefined;
            if (input.nextLibrary) set({ dramaAssets: input.nextLibrary });
          }
          return result;
        } catch (error) {
          if (journalPrepared) {
            if (get().currentProjectId === input.originProjectId && nativeRuntime.get(get) === runtime) {
              set({ projectLoadStatus: 'error', projectExecutionContext: null });
            }
            get().showToast(`共享同步状态未完成，原操作 ${input.commit.operationId} 已保留；请在存储健康中恢复后重新打开项目`, 'error');
          }
          throw error;
        }
      }
      let project: ProjectSaveData | undefined;
      let expectedProjectLibrary: unknown;
      if (input.nextLibrary) {
        const previous = await getProjectById(input.ownerId);
        assertCurrent();
        if (!previous) throw new Error('所属项目已不存在，已停止共享资产应用');
        expectedProjectLibrary = previous.dramaAssets;
        const state = { ...get(), dramaAssets: input.nextLibrary };
        const captured = input.ownerId === input.originProjectId
          ? createCurrentProjectSaveRecord(state) : createSeriesLibraryRecord(state);
        if (!captured) throw new Error('所属项目已变化，请重新预览');
        project = await serializeProjectRecord(captured);
        assertCurrent();
      }
      return await applySharedAssetSyncCommit({
        ...input.commit, project, expectedProjectLibrary, signal: controller.signal, assertCurrent,
        onCommitted: (result) => {
          if (result.alreadyApplied) return;
          if (input.nextLibrary) barrier.library = input.nextLibrary;
          const current = get();
          // 提交后的取消不能撤回已持久化数据；只给仍持有原库的原项目投影，不覆盖新编辑。
          if (current.currentProjectId !== input.originProjectId || current.projectLoadStatus !== 'ready'
            || current.dramaAssets !== input.expectedLibrary
            || seriesOwnerId(current.projects, input.originProjectId) !== input.ownerId) return;
          unsubscribe(); unsubscribe = () => undefined;
          // IDB 已提交；同一回调里同步投影，校验与 set 之间没有 await。
          set((state) => ({
            ...(input.nextLibrary ? { dramaAssets: input.nextLibrary } : {}),
            projects: project ? state.projects.map((item) => item.id === input.ownerId
              ? { ...item, updatedAt: project!.updatedAt } : item) : state.projects,
          }));
        },
      });
    } finally {
      unsubscribe();
      input.signal?.removeEventListener('abort', abort);
      input.commit.signal?.removeEventListener('abort', abort);
      const current = get();
      if (current.currentProjectId && projectMemoryOwnerId(current.projects, current.currentProjectId) === input.ownerId) {
        if (current.dramaAssets !== input.expectedLibrary) barrier.library = current.dramaAssets;
      }
      invalidateSeriesLibrarySave();
      projectAssetSyncBarriers.delete(input.ownerId);
      release();
    }
  },

  refreshProjectCatalog: async () => {
    const catalog = await loadProjectCatalog();
    set((state) => {
      const currentId = state.currentProjectId;
      const current = state.projects.find((item) => item.id === currentId);
      const ownerId = current?.parentId ?? currentId;
      const activeNativeOwner = nativeBinding(current)?.projectId;
      return { projects: catalog.projects.map((item) => {
        const old = state.projects.find((entry) => entry.id === item.id);
        if (!old) return item;
        const binding = nativeBinding(item);
        if (item.id === currentId || item.id === ownerId || binding && binding.projectId === activeNativeOwner && item.id === activeNativeOwner) return old;
        return item;
      }) };
    });
  },

  loadProject: async () => {
    invalidateSeriesLibrarySave();
    const sequence = ++projectSwitchSequence;
    const assertCurrent = () => { if (sequence !== projectSwitchSequence) throw new Error('项目加载已被新的导航取代'); };
    try {
      const catalog = await loadProjectCatalog();
      assertCurrent();
      if (catalog.projects.length > 0) {
        const mapped = catalog.projects;
        const current = get().currentProjectId;
        const exists = mapped.find((p) => p.id === current);
        const targetId = resolveOpenTargetId(mapped, exists ? current! : mapped[0].id);
        set({ projects: mapped, projectLoadStatus: 'loading' });

        const native = nativeBinding(mapped.find((project) => project.id === targetId));
        if (native) {
          const entry = catalog.native.find((item) => item.project.id === native.projectId);
          if (!entry) throw new Error('新项目目录已变化');
          const openedId = await activateNativeProject(set, get, entry, targetId, assertCurrent);
          rememberActiveProject(openedId);
          return;
        }

        const loadOptions = { recoverUndoTrash: true, assertCurrent };
        const data = await fileService.loadProjectData(targetId, loadOptions);
        assertCurrent();
        if (hasProjectCanvasData(data)) {
          const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
          const ownerId = data.parentId ?? targetId;
          const ownerData = ownerId === targetId ? data : await fileService.loadProjectData(ownerId, loadOptions);
          assertCurrent();
          set({
            projects: withLoadedProjectSummaries(mapped, data, ownerData),
            currentProjectId: targetId,
            projectExecutionContext: undefined,
            projectName: data.name || '已加载项目',
            nodes: data.nodes as Node<BaseNodeData>[],
            edges: data.edges as Edge[],
            groups: getProjectGroups(data),
            history: [],
            historyIndex: -1,
            dramaAssets: ownerData?.dramaAssets ?? emptyDramaAssetLibrary(),
            projectLoadStatus: 'ready',
          });
          rememberActiveProject(targetId);
        } else {
          set({ currentProjectId: null, projectLoadStatus: 'error' });
          get().showToast('项目加载失败，已阻止空画布覆盖原数据', 'error');
          return;
        }
        // 恢复待续轮询任务
        resumePendingTasks(targetId!).catch((e) => console.warn('[加载项目] 恢复待续任务失败:', e));
      }
    } catch (error) {
      if (sequence !== projectSwitchSequence) return;
      console.error('Load failed:', error);
      set({ currentProjectId: null, projectExecutionContext: undefined, projectLoadStatus: 'error' });
      get().showToast('项目列表读取失败，未创建空项目', 'error');
    }
  },

  initFromDb: () => {
    invalidateSeriesLibrarySave();
    if (get().projectInitialized) return Promise.resolve();
    const pending = projectInitializations.get(get);
    if (pending) return pending;
    const initializationSequence = ++projectSwitchSequence;
    const assertInitialization = () => { if (initializationSequence !== projectSwitchSequence) throw new Error('项目初始化已被新的导航取代'); };
    // get 与 API.getState 是同一稳定引用，首次创建和 HMR 的绑定 Store 都能共用。
    const initialization: Promise<void> = Promise.resolve().then(async () => {
      set({ currentProjectId: null, projectExecutionContext: undefined, projectLoadStatus: 'loading' });
      try {
        await Promise.all([get().loadConfig(), get().loadWorkflows(), get().loadPresets(), get().loadSkills(), get().loadSubAgentProfiles(), get().loadCustomStyles(), get().loadToolbarLayouts(), get().loadPlugins()]);
        await get().loadAppearanceThemes();
        assertInitialization();

        const catalog = await loadProjectCatalog();
        assertInitialization();
        let activeProjectId: string | null = null;
        const mapped = catalog.projects.filter((project) => project.id !== 'default');
        const recoveringWebview = await isWebviewRecovery();
        assertInitialization();
        if (get().config.startupView === 'project-library' || recoveringWebview) {
          // 启动页只读摘要；选定项目后才通过既有切换流程加载画布及项目域数据。
          set({
            projects: mapped,
            currentProjectId: null,
            projectExecutionContext: undefined,
            projectName: '',
            nodes: [],
            edges: [],
            groups: [],
            history: [],
            historyIndex: -1,
            selectedNodeIds: [],
            projectLoadStatus: 'ready',
          });
        } else if (mapped.length > 0) {
          const rememberedProjectId = await getLastActiveProjectId().catch(() => null);
          assertInitialization();
          const targetId = resolveOpenTargetId(mapped, rememberedProjectId
            && mapped.some((project) => project.id === rememberedProjectId)
            ? rememberedProjectId
            : mapped[0].id);

          const target = mapped.find((project) => project.id === targetId);
          const binding = nativeBinding(target);
          if (binding) {
            const entry = catalog.native.find((item) => item.project.id === binding.projectId);
            if (!entry) throw new Error('新项目目录已变化');
            set({ projects: mapped });
            activeProjectId = await activateNativeProject(set, get, entry, targetId, assertInitialization);
            rememberActiveProject(activeProjectId);
          } else {
          const loadOptions = { recoverUndoTrash: true, assertCurrent: assertInitialization };
          const data = await fileService.loadProjectData(targetId, loadOptions);
          const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
          assertInitialization();
          if (hasProjectCanvasData(data)) {
            activeProjectId = targetId;
            const ownerId = data.parentId ?? targetId;
            const ownerData = ownerId === targetId ? data : await fileService.loadProjectData(ownerId, loadOptions);
            assertInitialization();
            set({
              projects: withLoadedProjectSummaries(mapped, data, ownerData),
              currentProjectId: targetId,
              projectExecutionContext: undefined,
              projectName: data.name || '新项目',
              nodes: data.nodes as Node<BaseNodeData>[],
              edges: data.edges as Edge[],
              groups: getProjectGroups(data),
              dramaAssets: ownerData?.dramaAssets ?? emptyDramaAssetLibrary(),
              projectLoadStatus: 'ready',
            });
            rememberActiveProject(targetId);
          } else {
            set({
              projects: mapped,
              currentProjectId: null,
              projectName: '',
              nodes: [],
              edges: [],
              groups: [],
              dramaAssets: emptyDramaAssetLibrary(),
              projectLoadStatus: 'error',
            });
            get().showToast('项目加载失败，已阻止空画布覆盖原数据', 'error');
          }
          fileService.ensureProjectDataDir(targetId).catch((e) => console.warn('[初始化] 数据目录初始化失败:', e));
          }
        } else {
          const projectId = `p2-${crypto.randomUUID()}`, canvasId = `c2-${crypto.randomUUID()}`;
          const [owner, canvas] = await Promise.all([resolveProjectModel(projectId), resolveProjectModel(canvasId)]);
          assertInitialization();
          if (owner.dataModel !== 'missing' || canvas.dataModel !== 'missing') throw new Error('项目身份已被占用');
          await fileService.claimNativeProjectDataDir(projectId, '默认画布');
          assertInitialization();
          await createNativeProject({ projectId, canvasId, name: '默认画布' });
          assertInitialization();
          nativeKnownIds.add(projectId); nativeKnownIds.add(canvasId);
          fileService.registerNativeProjectFolders([{ id: projectId, projectId }, { id: canvasId, projectId }]);
          const refreshed = await loadProjectCatalog();
          assertInitialization();
          const entry = refreshed.native.find((item) => item.project.id === projectId);
          if (!entry) throw new Error('默认项目创建后无法读取');
          set({ projects: refreshed.projects.filter((project) => project.id !== 'default') });
          activeProjectId = await activateNativeProject(set, get, entry, canvasId, assertInitialization);
          rememberActiveProject(activeProjectId);
        }
        // 恢复当前项目的待续轮询任务
        if (activeProjectId) {
          if (get().projectExecutionContext?.modelGeneration !== 1) resumePendingTasks(activeProjectId).catch((e) => console.warn('[初始化] 恢复待续任务失败:', e));
          // 加载聊天会话
          get().loadConversationsForProject(activeProjectId).catch((e) => console.warn('[初始化] 加载会话失败:', e));
          get().repairInterruptedForProject(activeProjectId).catch((e) => console.warn('[初始化] 修复中断消息失败:', e));
          get().loadProjectMemoriesForProject(nativeBinding(get().projects.find((item) => item.id === activeProjectId))?.projectId
            ?? seriesOwnerId(get().projects, activeProjectId))
            .catch((e) => console.warn('[初始化] 加载项目记忆失败:', e));
        }
        // 即使停留在启动页，也修复所有项目的遗留 Agent 任务，禁止打开项目时自动续跑。
        await Promise.all([
          ...get().projects.map((project) => get().repairInterruptedAgentTasksForProject(project.id)),
          get().repairInterruptedAgentTasksForProject(GENERAL_ASSISTANT_SCOPE_ID),
          get().repairInterruptedForProject(GENERAL_ASSISTANT_SCOPE_ID),
        ]);
        assertInitialization();
        if (get().projectLoadStatus === 'ready') set({ projectInitialized: true });
      } catch (error) {
        if (initializationSequence !== projectSwitchSequence) return;
        console.error('Init from IndexedDB failed:', error);
        set({ currentProjectId: null, projectExecutionContext: undefined, projectLoadStatus: 'error' });
        get().showToast('项目数据读取失败，未创建空项目', 'error');
      }
    }).finally(() => {
      if (projectInitializations.get(get) === initialization) projectInitializations.delete(get);
    });
    projectInitializations.set(get, initialization);
    return initialization;
  },
  };
};
