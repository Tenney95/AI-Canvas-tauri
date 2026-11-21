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
import type {
  NativeProjectWriteBlock, AutoSaveFailureState, ProjectSlice, ProjectSliceSet, ProjectSliceGet,
} from './projects/projectSliceTypes';
import { renameLegacyProject } from './projects/renameLegacyProject';
import { createNativeMediaActions } from './projects/nativeMediaActions';
import { createAssetFileActions } from './projects/assetFileActions';
import { createProjectTransferActions } from './projects/projectTransferActions';
import { createSeriesStructureActions } from './projects/seriesStructureActions';
import { createProjectNavigationActions } from './projects/projectNavigationActions';
import { createSharedProjectAssetActions } from './projects/sharedProjectAssetActions';
import { createEpisodeCreativeActions } from './projects/episodeCreativeActions';
import type { BaseNodeData, CanvasProject, NodeGroup, ProjectSettings } from '../types';
import type { ProjectSaveData } from '../services/fileService';
import { projectMemoryOwnerId } from './store.utils';
import * as fileService from '../services/fileService';
import { resumePendingTasks, getPendingTasksForProject } from '../services/pollManager';
import { normalizeProjectSettings } from '../services/projectSettingsService';
import { captureCurrentCanvasSnapshot } from '../services/projectSnapshotService';
import {
  cancelProjectCanvasDerivations, completeCanvasDerivation, hasPendingCanvasMediaImport,
  registerCanvasImport,
} from '../services/canvasDerivationGuard';
import { setLastActiveProjectId, updateProjectSnapshot } from '../services/indexedDbService';
import { serializeProjectRecord, type ProjectSummaryData } from '../services/storageService';
import { toProjectSummaryRecord } from '../services/indexedDb/projectSummary';
import { describeStorageError } from '../services/storageQuota';
import type { DramaAssetLibrary } from '../types/dramaAssets';
import type { ProjectImportPreview } from '../services/projectImportService';
import { assertEpisodeEditorReady } from '../services/episodeEditorSessionService';
import type { ProjectExpectedContext, EpisodeSettingsPolicy } from '../types/project';
import {
  saveNativeProjectView, saveNativeProjectContent, readNativeProjectCapture, updateNativeProjectMetadata,
  updateNativeEpisodeMetadata, saveNativeCanvasPreview, saveNativeProjectTextModel,
  listNativeProjectPendingTransfers,
} from '../services/indexedDb/nativeProjectRepository';
import { listProjectCatalog, type ProjectCatalogEntry } from '../services/projectModelRouter';
import { readNativeProjectView } from '../services/nativeProjectNavigation';
import {
  hydrateNativeProjectView, projectNativeCatalogEntry, type NativeProjectViewItem,
} from './nativeProjectView';
import { restoreProjectRecord } from '../services/storageService';
import { waitForPendingNodeFileDeletions } from '../services/fs/trash';
import { resolveProjectModelSettings, withProjectTextModel } from '../services/projectModelSettings';
import { configValuesEqual } from '../services/configPatch';

export type {
  EpisodeCreativeWriteOptions, EpisodeAssetRosterWriteOptions, SeriesInfoWriteOptions,
  StoryGraphWriteOptions, AutoSaveFailureState, SharedProjectAssetSyncApplyInput, ProjectSlice,
  ProjectSliceSet, ProjectSliceGet,
} from './projects/projectSliceTypes';

const NATIVE_PROJECT_READONLY = '项目有待处理的操作，当前画布为只读';
const NATIVE_PROJECT_PENDING_EDITS = '当前项目有未保存的编辑，请先处理原操作，编辑仍保留';
type NativeCatalog = Extract<ProjectCatalogEntry, { dataModel: 'native' }>;
type NativeLoaded = NonNullable<Awaited<ReturnType<typeof readNativeProjectView>>>;
interface NativeRuntime {
  loaded: NativeLoaded;
  activeId: string;
  library: AppState['dramaAssets'];
  tail: Promise<void>;
  savedView: Pick<AppState, 'nodes' | 'edges' | 'groups'>;
  episodeReads: Map<string, Promise<CanvasProject>>;
  /** 排队的保存需重取事务投影后的视图，不能用旧快照覆盖已交付产物或引用。 */
  mediaGeneration?: number;
}

function nativeCanvasDocumentChanged(saved: NativeRuntime['savedView'], state: AppState): boolean {
  // 流程图的选中和测量变化不会改变用户编辑的内容。
  const nodeContent = (node: Node<BaseNodeData>) => ({ ...node, selected: undefined, measured: undefined, dragging: undefined, resizing: undefined });
  const edgeContent = (edge: Edge) => ({ ...edge, selected: undefined });
  return !configValuesEqual(saved.groups, state.groups)
    || saved.nodes !== state.nodes && !configValuesEqual(saved.nodes.map(nodeContent), state.nodes.map(nodeContent))
    || saved.edges !== state.edges && !configValuesEqual(saved.edges.map(edgeContent), state.edges.map(edgeContent));
}

function nativeCanvasHasUnsavedEdits(runtime: NativeRuntime | undefined, state: AppState): boolean {
  return !runtime || runtime.library !== state.dramaAssets || nativeCanvasDocumentChanged(runtime.savedView, state);
}

function nativeLibraryContentChanged(saved: DramaAssetLibrary, current: DramaAssetLibrary): boolean {
  return saved !== current && !configValuesEqual({ ...saved, lastViewedAt: undefined }, { ...current, lastViewedAt: undefined });
}

async function readNativeProjectWriteBlock(projectId: string): Promise<NativeProjectWriteBlock | null> {
  const transfer = (await listNativeProjectPendingTransfers(projectId)).find((item) => item.kind !== 'export');
  return transfer ? { projectId, ...transfer } : null;
}

function hasMediaImportBlockingNavigation(state: AppState): boolean {
  if (!hasPendingCanvasMediaImport(state)) return false;
  state.showToast(t('素材正在导入，请等导入完成后再离开当前画布'), 'info');
  return true;
}

function hasNativeProjectDrafts(state: AppState, runtime: NativeRuntime | undefined, projectId: string): boolean {
  if (nativeCanvasHasUnsavedEdits(runtime, state)) return true;
  try {
    assertEpisodeEditorReady(projectId);
    for (const item of state.projects) if (item.id !== projectId && nativeBinding(item)?.projectId === projectId) assertEpisodeEditorReady(item.id);
    return false;
  } catch { return true; }
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
  try { catalog = await listProjectCatalog({ isolateInvalidNativeProjects: true }); }
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
  targetId: string, assertCurrent: () => void, preserveHistory = false, previousView?: NativeRuntime): Promise<string> {
  const binding = projectNativeCatalogEntry(entry).find((item) => item.id === targetId)?.nativeView;
  if (!binding) throw new Error('新项目导航身份已变化');
  await waitForPendingNodeFileDeletions();
  assertCurrent();
  const [loaded, nativeProjectWriteBlock] = await Promise.all([
    readNativeProjectView(entry.project.id, binding.canvasId ?? undefined), readNativeProjectWriteBlock(entry.project.id),
  ]);
  assertCurrent();
  if (!loaded || (loaded.selection.canvas?.id ?? null) !== binding.canvasId) throw new Error('项目画布身份已变化');
  const canvas = loaded.selection.canvas;
  const activeId = canvas?.id ?? entry.project.id;
  const projected = hydrateNativeProjectView(entry, loaded);
  const selected = projected.find((item) => item.id === activeId);
  if (!selected) throw new Error('新项目画布身份已变化');
  const data = await restoreProjectRecord({ ...selected, nodes: canvas?.nodes ?? [], edges: canvas?.edges ?? [], groups: canvas?.groups ?? [],
    dramaAssets: loaded.content.dramaAssets }, { recoverUndoTrash: !nativeProjectWriteBlock, assertCurrent });
  assertCurrent();
  const ids = [entry.project.id, ...entry.episodeIds, ...entry.canvasIds];
  fileService.registerNativeProjectFolders(ids.map((id) => ({ id, projectId: entry.project.id })));
  if (!nativeProjectWriteBlock) await get().repairNativeWorkConversationsOnFirstOpen(entry.project.id);
  assertCurrent();
  const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
  assertCurrent();
  const current = get();
  const loadedView = { nodes: data.nodes as Node<BaseNodeData>[], edges: data.edges as Edge[], groups: getProjectGroups(data) };
  const loadedLibrary = data.dramaAssets ?? emptyDramaAssetLibrary();
  let savedView = loadedView, library = loadedLibrary;
  let view: NativeRuntime['savedView'] = loadedView, dramaAssets = loadedLibrary;
  if (previousView) {
    // 分集结构事务只更新元数据。匹配实际落盘版本后，沿用这些版本上的实时编辑和保存基线。
    if (nativeCanvasDocumentChanged(previousView.savedView, current)) {
      const before = previousView.loaded.selection.canvas;
      if (before?.id !== canvas?.id || before?.revision !== canvas?.revision || before?.storageRootRef !== canvas?.storageRootRef) {
        throw new Error('画布已变化，当前编辑已保留');
      }
      savedView = previousView.savedView;
      view = { nodes: current.nodes, edges: current.edges, groups: current.groups };
    }
    if (previousView.library !== current.dramaAssets) {
      if (previousView.loaded.content.revisions.assets !== loaded.content.revisions.assets) {
        if (nativeLibraryContentChanged(previousView.library, current.dramaAssets)) throw new Error('共享素材已变化，当前编辑已保留');
        const lastViewedAt = current.dramaAssets.lastViewedAt ?? 0;
        if (lastViewedAt > (loadedLibrary.lastViewedAt ?? 0)) dramaAssets = { ...loadedLibrary, lastViewedAt };
      } else {
        library = previousView.library;
        dramaAssets = current.dramaAssets;
      }
    }
  }
  nativeRuntime.set(get, { loaded, activeId, library, savedView, tail: Promise.resolve(), episodeReads: new Map() });
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
    currentProjectId: activeId, projectName: selected.name, nativeProjectWriteBlock,
    projectLoadStatus: nativeProjectWriteBlock ? 'readonly' : 'ready', projectExecutionContext: nativeProjectWriteBlock ? null : context,
    ...view,
    ...(preserveHistory ? {} : { history: [], historyIndex: -1 }), dramaAssets,
  }));
  if (canvas && !nativeProjectWriteBlock) void resumePendingTasks(activeId).catch(() => { /* 原缓存保留，下次原画布就绪再交付。 */ });
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
      runtime.savedView = { nodes: state.nodes, edges: state.edges, groups: state.groups };
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
    runtime.savedView = { nodes: state.nodes, edges: state.edges, groups: state.groups };
    if (projection) {
      runtime.mediaGeneration = (runtime.mediaGeneration ?? 0) + 1;
      projection.commit();
    }
    return record.id;
  } finally { release(); }
}

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
  const initial = get(), activeId = initial.currentProjectId, sequence = projectSwitchSequence;
  const active = nativeBinding(initial.projects.find((item) => item.id === activeId))?.projectId === binding.projectId;
  const runtime = active ? nativeRuntime.get(get) : undefined;
  const isCurrent = () => {
    const state = get();
    return state.currentProjectId === activeId && projectSwitchSequence === sequence
      && state.projectLoadStatus === 'ready' && (!active || nativeRuntime.get(get) === runtime);
  };
  const canStart = () => {
    const state = get();
    return isCurrent() && !projectImportsApplying.has(binding.projectId) && state.switchingProjectName === null
      && !state.isCreatingProject && !state.isReturningToStartPage;
  };
  if (!canStart()) return false;
  if (active && (!runtime || runtime.activeId !== activeId || await get().saveCurrentProjectSilent() !== activeId)) return false;
  if (!canStart()) return false;
  const previousContext = get().projectExecutionContext;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('项目在操作期间发生变化，请重试');
  };
  projectImportsApplying.add(binding.projectId);
  if (active && freeze) set({ switchingProjectName: '正在保存项目', projectExecutionContext: null });
  let previousRevision: number | undefined;
  let writeStarted = false;
  try {
    if (runtime) await runtime.tail;
    assertCurrent();
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
    if (active && activeId) await activateNativeProject(set, get, entry, activeId, assertCurrent, true, runtime);
    else set((state) => ({ projects: [...state.projects.filter((item) => nativeBinding(item)?.projectId !== binding.projectId), ...projectNativeCatalogEntry(entry)] }));
    return true;
  } catch (error) {
    if (active && isCurrent()) {
      let unchanged = !writeStarted;
      if (writeStarted && previousRevision !== undefined) {
        try { unchanged = (await readNativeProjectCapture(binding.projectId))?.changeRevision === previousRevision; } catch { /* 无法确认结果，阻止继续保存 */ }
      }
      if (isCurrent()) set(unchanged
        ? { projectLoadStatus: 'ready', projectExecutionContext: previousContext }
        : { projectLoadStatus: 'error', projectExecutionContext: null });
    }
    get().showToast(error instanceof Error ? error.message : '项目保存失败', 'error');
    return false;
  } finally {
    projectImportsApplying.delete(binding.projectId);
    if (active && freeze && sequence === projectSwitchSequence) set({ switchingProjectName: null });
  }
}

/** 正文和文本模型偏好独立保存，使用当前画布写队列且保持媒体任务的运行租约。 */
async function writeNativeProjectText(get: ProjectSliceGet, projectId: string,
  write: (runtime: NativeRuntime, isCurrent: () => boolean) => Promise<void>): Promise<boolean> {
  const runtime = nativeRuntime.get(get), activeId = get().currentProjectId, sequence = projectSwitchSequence;
  const isCurrent = () => {
    const state = get();
    return state.currentProjectId === activeId && state.projectLoadStatus === 'ready' && state.switchingProjectName === null
      && !state.isCreatingProject && !state.isReturningToStartPage && sequence === projectSwitchSequence
      && nativeRuntime.get(get) === runtime && !projectImportsApplying.has(projectId) && !projectAssetSyncBarriers.has(projectId);
  };
  if (!runtime || runtime.activeId !== activeId || runtime.loaded.selection.project.id !== projectId || !isCurrent()) {
    get().showToast('项目已切换或正在更新，请稍后保存', 'error');
    return false;
  }
  const previous = runtime.tail;
  let release!: () => void;
  runtime.tail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await previous;
    if (!isCurrent()) throw new Error('项目已切换或正在更新，请稍后保存');
    await write(runtime, isCurrent);
    return true;
  } catch (error) {
    get().showToast(error instanceof Error ? error.message : '项目保存失败', 'error');
    return false;
  } finally { release(); }
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
  if (active && hasNativeProjectDrafts(before, nativeRuntime.get(get), projectId)) throw new Error('请先保存当前编辑，再处理项目更新或恢复');
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
      get().loadConversationsForProject(target).catch((e) => console.warn('[项目更新] 加载会话失败:', e));
      if (target !== activeId) {
        rememberActiveProject(target);
        get().repairInterruptedForProject(target).catch((e) => console.warn('[项目更新] 修复中断消息失败:', e));
        get().loadAgentTasksForProject(target).catch((e) => console.warn('[项目更新] 加载任务失败:', e));
      }
    } else set((state) => ({ projects: [...state.projects.filter((item) => nativeBinding(item)?.projectId !== projectId), ...projectNativeCatalogEntry(entry)] }));
  } catch (error) {
    let unchanged = !started;
    if (revision !== undefined) try { unchanged = (await readNativeProjectCapture(projectId))?.changeRevision === revision; } catch { unchanged = false; }
    let block = before.nativeProjectWriteBlock?.projectId === projectId ? before.nativeProjectWriteBlock : null;
    let checkedBlock = !started;
    if (started && active) {
      try { block = await readNativeProjectWriteBlock(projectId); checkedBlock = true; } catch { /* 查询失败时禁止恢复写入上下文。 */ }
    }
    if (active && get().currentProjectId === activeId && sequence === projectSwitchSequence) {
      if (block) set({ projectLoadStatus: 'readonly', projectExecutionContext: null, nativeProjectWriteBlock: block });
      else set(unchanged && checkedBlock ? { projectLoadStatus: 'ready', projectExecutionContext: previousContext, nativeProjectWriteBlock: null }
        : { projectLoadStatus: 'error', projectExecutionContext: null, nativeProjectWriteBlock: null });
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
interface ProjectSaveOutcomeRuntime {
  session: object;
  sequence: number;
  acceptedSequence: number;
}
interface ProjectSaveAttempt {
  projectId: string | null;
  session: object;
  sequence: number;
}
const projectSaveOutcomes: WeakMap<ProjectSliceGet, ProjectSaveOutcomeRuntime> = import.meta.hot?.data.projectSaveOutcomes ?? new WeakMap();
if (import.meta.hot) import.meta.hot.data.projectSaveOutcomes = projectSaveOutcomes;

function beginProjectSaveAttempt(get: ProjectSliceGet, projectId: string | null): ProjectSaveAttempt {
  const runtime = projectSaveOutcomes.get(get)!;
  return { projectId, session: runtime.session, sequence: ++runtime.sequence };
}

function isProjectSaveAttemptCurrent(get: ProjectSliceGet, attempt: ProjectSaveAttempt): boolean {
  return get().currentProjectId === attempt.projectId && projectSaveOutcomes.get(get)?.session === attempt.session;
}

function acceptProjectSaveOutcome(get: ProjectSliceGet, attempt: ProjectSaveAttempt): boolean {
  const runtime = projectSaveOutcomes.get(get);
  if (!runtime || !isProjectSaveAttemptCurrent(get, attempt) || attempt.sequence < runtime.acceptedSequence) return false;
  runtime.acceptedSequence = attempt.sequence;
  return true;
}
const manualSaveSuccessListeners: Set<(projectId: string) => void> = import.meta.hot?.data.manualSaveSuccessListeners ?? new Set();
if (import.meta.hot) import.meta.hot.data.manualSaveSuccessListeners = manualSaveSuccessListeners;

/** 自动保存暂停只由明确成功的手动保存解除，不把旧自动请求的成功当作用户重试。 */
export function subscribeManualProjectSaveSuccess(listener: (projectId: string) => void): () => void {
  manualSaveSuccessListeners.add(listener);
  return () => { manualSaveSuccessListeners.delete(listener); };
}
const episodeCreativeWrites: Map<string, Promise<unknown>> = import.meta.hot?.data.episodeCreativeWrites ?? new Map();
if (import.meta.hot) import.meta.hot.data.episodeCreativeWrites = episodeCreativeWrites;

/** 旧项目的内存补丁可能先于落盘。对端只能读取已结清的创作内容。 */
export function pendingProjectCreativeWrite(projectId: string): Promise<unknown> | undefined {
  return episodeCreativeWrites.get(projectId);
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

type NativePreviewTarget = Omit<Parameters<typeof saveNativeCanvasPreview>[0], 'snapshot'>;

export interface ProjectSaveQueue {
  running: boolean;
  active: PendingProjectSave | null;
  pending: PendingProjectSave | null;
  /** 条件元数据写独立保序，不能被后来的普通自动保存合并成另一份成功记录。 */
  pendingBatches?: PendingProjectSave[];
  pendingSnapshot: { snapshot: string | undefined; nativeTarget?: NativePreviewTarget; waiters: ProjectSaveWaiter[] } | null;
  idleWaiters: Array<() => void>;
}

const projectSaveQueues: Map<string, ProjectSaveQueue> = import.meta.hot?.data.projectSaveQueues ?? new Map();
if (import.meta.hot) import.meta.hot.data.projectSaveQueues = projectSaveQueues;
export interface ProjectAssetSyncBarrier {
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

function getProjectSwitchSequence(): number {
  return projectSwitchSequence;
}

interface CapturedCanvasState {
  projectId: string;
  nodes: AppState['nodes'];
  edges: AppState['edges'];
  groups: AppState['groups'];
  viewportKey: string;
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
          if (patch.nativeTarget) await saveNativeCanvasPreview({ ...patch.nativeTarget, snapshot: patch.snapshot });
          else await updateProjectSnapshot(projectId, patch.snapshot);
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

function enqueueProjectSnapshot(projectId: string, snapshot: string | undefined, nativeTarget?: NativePreviewTarget): Promise<string> {
  if (nativeKnownIds.has(projectId) && !nativeTarget) return Promise.reject(new Error('新项目画布预览身份不可用'));
  const queue = getProjectSaveQueue(projectId);
  return new Promise((resolve, reject) => {
    if (queue.pendingSnapshot) {
      queue.pendingSnapshot.snapshot = snapshot;
      queue.pendingSnapshot.nativeTarget = nativeTarget;
      queue.pendingSnapshot.waiters.push({ resolve, reject });
    } else {
      queue.pendingSnapshot = { snapshot, nativeTarget, waiters: [{ resolve, reject }] };
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
  attempt: ProjectSaveAttempt,
): AutoSaveFailureState | undefined {
  if (!acceptProjectSaveOutcome(get, attempt)) return undefined;
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

function applyProjectSaveSuccess(set: ProjectSliceSet, get: ProjectSliceGet, attempt: ProjectSaveAttempt, record: ProjectSaveData): boolean {
  if (!acceptProjectSaveOutcome(get, attempt)) return false;
  set((state) => ({
    // A completed old snapshot must not roll back a newer displayed name or timestamp.
    projects: state.projects.map((project) => project.id === record.id
      ? { ...project, updatedAt: Math.max(project.updatedAt, record.updatedAt), name: state.projectName } : project),
    autoSaveFailure: null,
  }));
  return isProjectSaveAttemptCurrent(get, attempt)
    && projectSaveOutcomes.get(get)?.acceptedSequence === attempt.sequence;
}

/** 保存异常 → 结构化失败状态（含配额/磁盘归因） */
async function noteSaveError(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  error: unknown,
  notify: boolean,
  attempt: ProjectSaveAttempt,
): Promise<AutoSaveFailureState | undefined> {
  const { kind, reason } = await describeStorageError(error);
  return noteSaveFailure(set, get, { kind, reason, notify }, attempt);
}

/** 画布打开后也可能登记待处理操作；首次写入拒绝时对齐真实状态。 */
async function recognizeNativeProjectWriteBlock(set: ProjectSliceSet, get: ProjectSliceGet, projectId: string | undefined,
  error: unknown, attempt: ProjectSaveAttempt): Promise<boolean> {
  if (!projectId || !(error instanceof Error)
    || !(error.message.endsWith('project-update-pending') || error.message.endsWith('project-shared-sync-pending'))) return false;
  const block = await readNativeProjectWriteBlock(projectId).catch(() => null);
  if (!block || !isProjectSaveAttemptCurrent(get, attempt)) return false;
  set({ projectLoadStatus: 'readonly', projectExecutionContext: null, nativeProjectWriteBlock: block });
  return true;
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

function episodeCreativeContext(get: ProjectSliceGet) {
  return {
    getNativeRuntime: () => nativeRuntime.get(get),
    getProjectSwitchSequence,
    isProjectMutationPending: (id: string) => projectImportsApplying.has(id) || projectAssetSyncBarriers.has(id),
    nativeBinding, mutateNativeMetadata, patchProjectRecord, serializeEpisodeCreativeWrite,
  };
}

export type EpisodeCreativeContext = ReturnType<typeof episodeCreativeContext>;

const nativeMediaContext = {
  nativeRuntime, saveNativeCurrentProject, projectAssetSyncBarriers, projectImportsApplying,
  createCurrentProjectSaveRecord,
};
export type NativeMediaContext = typeof nativeMediaContext;

const projectTransferContext = {
  NATIVE_PROJECT_PENDING_EDITS, nativeLibraryContentChanged, hasNativeProjectDrafts, nativeKnownIds,
  nativeRuntime, nativeBinding, loadProjectCatalog, activateNativeProject, runNativeImportMutation,
  projectAssetSyncBarriers, projectImportsApplying, invalidateSeriesLibrarySave, importPreviewGuards,
  waitForProjectSaveQueue,
  getProjectSwitchSequence,
};
export type ProjectTransferContext = typeof projectTransferContext;

const seriesStructureContext = {
  nativeRuntime, nativeBinding, loadProjectCatalog, activateNativeProject, mutateNativeMetadata,
  writeNativeProjectText, episodeCreativeWrites, serializeEpisodeCreativeWrite, rememberActiveProject,
  projectAssetSyncBarriers, projectImportsApplying, waitForProjectSaveQueue, enqueueProjectSave,
  patchProjectRecord,
  getProjectSwitchSequence,
};
export type SeriesStructureContext = typeof seriesStructureContext;

const projectNavigationContext = {
  NATIVE_PROJECT_PENDING_EDITS, nativeCanvasHasUnsavedEdits, hasMediaImportBlockingNavigation,
  nativeKnownIds, nativeRuntime, nativeBinding, loadProjectCatalog, activateNativeProject,
  projectInitializations, episodeCreativeWrites, getProjectGroups, withLoadedProjectSummaries,
  hasProjectCanvasData, rememberActiveProject, projectAssetSyncBarriers, projectImportsApplying,
  invalidateSeriesLibrarySave, waitForProjectSaveQueue, waitForLoadingPaint,
  getProjectSwitchSequence,
  beginProjectSwitch: () => ++projectSwitchSequence,
  clearProjectSnapshot: (projectId: string) => {
    if (lastCapturedCanvasState?.projectId === projectId) lastCapturedCanvasState = null;
  },
};
export type ProjectNavigationContext = typeof projectNavigationContext;

const sharedProjectAssetContext = {
  readNativeProjectWriteBlock, nativeKnownIds, nativeRuntime, nativeBinding, saveNativeCurrentProject,
  pendingProjectSaves, trackProjectSave, projectAssetSyncBarriers, projectImportsApplying,
  invalidateSeriesLibrarySave, waitForProjectSaveQueue, enqueueProjectSave,
  createCurrentProjectSaveRecord, createSeriesLibraryRecord,
};
export type SharedProjectAssetContext = typeof sharedProjectAssetContext;

export const createProjectSlice: StateCreator<AppState, [], [], ProjectSlice> = (set, get, api) => {
  const live: AppState | undefined = get();
  // 首次应用这次热更新时，旧 Store 还没有标记；已就绪的画布要沿用内存。
  const initialized = live?.projectInitialized
    ?? (live?.projectLoadStatus === 'ready' && typeof live?.initFromDb === 'function');
  if (!projectSaveOutcomes.has(get)) {
    const runtime: ProjectSaveOutcomeRuntime = { session: {}, sequence: 0, acceptedSequence: 0 };
    projectSaveOutcomes.set(get, runtime);
    // One subscription per Store survives action rebinding without duplicating observers.
    api.subscribe((state, previous) => {
      if (state.currentProjectId !== previous.currentProjectId
        || state.projectLoadStatus === 'loading' && previous.projectLoadStatus !== 'loading'
        || state.projectExecutionContext?.runtimeEpoch !== previous.projectExecutionContext?.runtimeEpoch) {
        runtime.session = {};
        runtime.acceptedSequence = 0;
      }
    });
  }
  const seriesStructureActions = createSeriesStructureActions(set, get, seriesStructureContext);
  const projectNavigationActions = createProjectNavigationActions(set, get, api, projectNavigationContext);
  return {
  projects: [
    { id: 'default', name: '默认画布', createdAt: Date.now(), updatedAt: Date.now() },
  ],
  currentProjectId: 'default',
  projectExecutionContext: undefined,
  getProjectSessionToken: () => projectSaveOutcomes.get(get)!.session,
  projectName: '新项目',
  projectLoadStatus: 'loading',
  nativeProjectWriteBlock: live?.nativeProjectWriteBlock ?? null,
  hasUnsavedNativeProjectWriteBlock: () => {
    const state = get(), block = state.nativeProjectWriteBlock;
    return !!block && nativeBinding(state.projects.find((item) => item.id === state.currentProjectId))?.projectId === block.projectId
      && hasNativeProjectDrafts(state, nativeRuntime.get(get), block.projectId);
  },
  projectInitialized: initialized,
  isCreatingProject: false,
  isReturningToStartPage: false,
  switchingProjectName: null,
  autoSaveFailure: null,

  ...createNativeMediaActions(set, get, api, nativeMediaContext),

  ...createAssetFileActions(set, get),

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
    return renameLegacyProject(set, get, id, nextName, enqueueProjectSave, ownedDramaAssets);
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
    if (native && !native.episodeId) {
      const before = normalizeProjectSettings(previousProject.settings ?? {}), next = normalizeProjectSettings(settings);
      const modelId = next.defaultModels?.text;
      if (configValuesEqual(withProjectTextModel(before, undefined), withProjectTextModel(next, undefined))) {
        if (before.defaultModels?.text === modelId) return true;
        return writeNativeProjectText(get, native.projectId, async (runtime, isCurrent) => {
          const { selection } = runtime.loaded;
          const saved = await saveNativeProjectTextModel({ projectId: native.projectId, expectedProjectEpoch: selection.project.epoch,
            expectedModelId: selection.project.defaultSettings?.defaultModels?.text, modelId });
          runtime.loaded = { ...runtime.loaded, selection: { ...selection, project: saved.project, changeRevision: saved.changeRevision } };
          if (isCurrent()) set((current) => ({ projects: current.projects.map((item) => item.id === projectId
            ? { ...item, settings: withProjectTextModel(item.settings, modelId), updatedAt: saved.project.updatedAt } : item) }));
        });
      }
    }
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
    const binding = nativeBinding(project);
    const runtime = nativeRuntime.get(get);
    const canvas = runtime?.loaded.selection.canvas;
    if (binding && (!canvas || runtime?.activeId !== projectId || binding.canvasId !== canvas.id
      || canvas.id !== projectId || canvas.projectId !== binding.projectId)) return undefined;
    const nativeTarget = binding && canvas ? { projectId: binding.projectId, canvasId: canvas.id, expectedCanvasEpoch: canvas.epoch } : undefined;
    const captureId = nextSnapshotCaptureId++;
    latestSnapshotCaptures.set(projectId, captureId);
    const isLatestCapture = () => latestSnapshotCaptures.get(projectId) === captureId;
    const persist = async (snapshot: string | undefined) => {
      try { await enqueueProjectSnapshot(projectId, snapshot, nativeTarget); return true; }
      catch (error) { console.warn('[项目快照] 持久化失败:', error); return false; }
    };
    try {
      if (state.nodes.length === 0) {
        if (nativeTarget && !await persist(undefined)) return undefined;
        if (!isLatestCapture()) return undefined;
        lastCapturedCanvasState = null;
        if (project.snapshot || nativeTarget) {
          set((current) => ({
            projects: current.projects.map((item) => (
              item.id === projectId ? { ...item, snapshot: undefined } : item
            )),
          }));
        }
        if (!nativeTarget && options.persistSnapshot) await persist(undefined);
        return projectId;
      }

      // 离开项目时重新取图，图片解码或视频首帧就绪并不一定会更新 Store。
      if (!options.allowProjectChange && project.snapshot && isCanvasSnapshotFresh(state, projectId)) {
        if (!nativeTarget && options.persistSnapshot) await persist(project.snapshot);
        return projectId;
      }

      const viewportKey = getCanvasViewportKey();
      const snapshot = await captureCurrentCanvasSnapshot(
        projectId,
        { nodes: state.nodes, edges: state.edges },
        { fresh: options.allowProjectChange },
      );
      if (!isLatestCapture()) return undefined;
      const latest = get();
      if (!latest.projects.some((item) => item.id === projectId)) return undefined;
      const isStillCurrent = latest.currentProjectId === projectId;
      const currentCanvasChanged = isStillCurrent && (
        latest.nodes !== state.nodes || latest.edges !== state.edges || latest.groups !== state.groups
        || getCanvasViewportKey() !== viewportKey || nativeTarget && nativeRuntime.get(get) !== runtime
      );
      if (currentCanvasChanged || (!isStillCurrent && !options.allowProjectChange)) return undefined;
      if (!snapshot) return projectId;

      // 只有落盘成功的原生预览才进入项目库。慢截图不能覆盖同一画布的后续预览。
      if (nativeTarget && !await persist(snapshot)) return undefined;
      if (!isLatestCapture()) return undefined;
      const afterSave = get();
      if (afterSave.currentProjectId === projectId && afterSave.nodes === state.nodes
        && afterSave.edges === state.edges && afterSave.groups === state.groups && getCanvasViewportKey() === viewportKey) {
        lastCapturedCanvasState = { projectId, nodes: state.nodes, edges: state.edges, groups: state.groups, viewportKey };
      } else if (lastCapturedCanvasState?.projectId === projectId) {
        lastCapturedCanvasState = null;
      }
      set((current) => ({
        projects: current.projects.map((item) => (
          item.id === projectId ? { ...item, snapshot } : item
        )),
      }));
      // 旧项目的预览补丁也不能用捕获前的正文覆盖后续自动保存。
      if (!nativeTarget && options.persistSnapshot) await persist(snapshot);
      return projectId;
    } finally {
      if (isLatestCapture()) latestSnapshotCaptures.delete(projectId);
    }
  },

  createProject: projectNavigationActions.createProject,
  addEpisodes: seriesStructureActions.addEpisodes,
  addEpisode: seriesStructureActions.addEpisode,
  updateSeriesInfo: seriesStructureActions.updateSeriesInfo,
  updateStoryGraph: seriesStructureActions.updateStoryGraph,

  ...createEpisodeCreativeActions(set, get, api, episodeCreativeContext(get)),

  moveEpisode: seriesStructureActions.moveEpisode,

  ...createProjectTransferActions(set, get, projectTransferContext),

  deleteProject: projectNavigationActions.deleteProject,
  switchProject: projectNavigationActions.switchProject,
  returnToStartPage: projectNavigationActions.returnToStartPage,

  saveCurrentProject: () => trackProjectSave(get().currentProjectId, async (projectId) => {
    const attempt = beginProjectSaveAttempt(get, projectId);
    const syncPending = waitForProjectAssetSync(get);
    if (syncPending) await syncPending;
    const state = get();
    if (!isProjectSaveAttemptCurrent(get, attempt)) return undefined;
    if (state.currentProjectId && state.projectLoadStatus !== 'ready') {
      if (state.projectLoadStatus === 'readonly') {
        state.showToast(NATIVE_PROJECT_READONLY, 'info');
        return undefined;
      }
      // 加载中只是还没就绪，不算故障；加载失败才记进退出拦截状态
      if (state.projectLoadStatus === 'error') {
        noteSaveFailure(set, get, {
          kind: 'load-error',
          reason: '项目加载失败，已阻止空画布覆盖原数据',
          notify: false,
        }, attempt);
      }
      state.showToast('项目尚未成功加载，已阻止覆盖保存', 'error');
      return undefined;
    }
    const record = createCurrentProjectSaveRecord(state);
    if (!record) return undefined;
    const native = nativeBinding(state.projects.find((item) => item.id === record.id));
    if (native && projectImportsApplying.has(native.projectId)) return undefined;
    try {
      if (native) await saveNativeCurrentProject(get, state, record);
      else await saveCurrentProjectRecord(state, record);
      if (applyProjectSaveSuccess(set, get, attempt, record)) {
        for (const listener of [...manualSaveSuccessListeners]) {
          try { listener(record.id); } catch { console.warn('[自动保存] 手动保存完成通知未能处理'); }
        }
        get().showToast('项目已保存');
      }
      return record.id;
    } catch (error) {
      if (await recognizeNativeProjectWriteBlock(set, get, native?.projectId, error, attempt)) return undefined;
      console.error('Save failed:', error);
      // 手动保存本来就每次都给反馈，交给 toast 自己说，不走去重逻辑
      const failure = await noteSaveError(set, get, error, false, attempt);
      if (failure) get().showToast(t('保存失败：{reason}', { reason: failure.reason }), 'error');
      return undefined;
    }
  }),

  /** 静默保存（不弹 toast），用于自动保存 */
  saveCurrentProjectSilent: (assertCurrent) => trackProjectSave(get().currentProjectId, async (projectId) => {
    const attempt = beginProjectSaveAttempt(get, projectId);
    assertCurrent?.();
    const syncPending = waitForProjectAssetSync(get);
    if (syncPending) await syncPending;
    assertCurrent?.();
    const state = get();
    if (!isProjectSaveAttemptCurrent(get, attempt)) return undefined;
    if (state.currentProjectId && state.projectLoadStatus !== 'ready') {
      if (state.projectLoadStatus === 'error') {
        noteSaveFailure(set, get, {
          kind: 'load-error',
          reason: '项目加载失败，已阻止空画布覆盖原数据',
          notify: true,
        }, attempt);
      }
      return undefined;
    }
    const record = createCurrentProjectSaveRecord(state);
    if (!record) return undefined;
    const native = nativeBinding(state.projects.find((item) => item.id === record.id));
    if (native && projectImportsApplying.has(native.projectId)) return undefined;
    try {
      if (native) await saveNativeCurrentProject(get, state, record, assertCurrent);
      else await saveCurrentProjectRecord(state, record, assertCurrent);
      assertCurrent?.();
      applyProjectSaveSuccess(set, get, attempt, record);
      return record.id;
    } catch (error) {
      if (await recognizeNativeProjectWriteBlock(set, get, native?.projectId, error, attempt)) return undefined;
      console.warn('[自动保存] 保存失败:', error);
      await noteSaveError(set, get, error, true, attempt);
      return undefined;
    }
  }),

  ...createSharedProjectAssetActions(set, get, api, sharedProjectAssetContext),

  refreshProjectCatalog: projectNavigationActions.refreshProjectCatalog,
  loadProject: projectNavigationActions.loadProject,
  initFromDb: projectNavigationActions.initFromDb,
  };
};
