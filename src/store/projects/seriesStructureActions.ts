import type { CanvasProject, ProjectOriginalWork } from '../../types';
import { generateProjectId, listEpisodes, seriesOwnerId } from '../store.utils';
import * as fileService from '../../services/fileService';
import { reassignProjectMemories } from '../../services/chat/projectMemoryService';
import { updateProjectStoryGraphCAS } from '../../services/indexedDbService';
import type { StoryGraph } from '../../types/storyGraph';
import { applyStoryGraphPatch, normalizeStoryGraph } from '../../services/storyGraphService';
import { swapLegacyEpisodeOrder } from '../../services/indexedDb/legacyProjectLifecycleRepository';
import {
  saveNativeProjectContent, convertNativeProjectToSeries, appendNativeEpisodesInOrder,
  readNativeProjectCapture, reorderNativeEpisodes,
} from '../../services/indexedDb/nativeProjectRepository';
import { readOccupiedProjectIds, resolveProjectModel } from '../../services/projectModelRouter';
import { nativeEpisodeDisplayNumbers, projectNativeCatalogEntry } from '../nativeProjectView';
import { configValuesEqual } from '../../services/configPatch';
import { remapStoryGraphBindings } from '../../services/projectExchangeDomain';
import type { ProjectSlice, ProjectSliceGet, ProjectSliceSet, SeriesStructureContext } from '../store.projects';

export function createSeriesStructureActions(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  context: SeriesStructureContext,
): Pick<ProjectSlice,
  | 'addEpisodes'
  | 'addEpisode'
  | 'updateSeriesInfo'
  | 'updateStoryGraph'
  | 'moveEpisode'
> {
  const {
    nativeRuntime, nativeBinding, loadProjectCatalog, activateNativeProject, mutateNativeMetadata,
    writeNativeProjectText, episodeCreativeWrites, serializeEpisodeCreativeWrite, rememberActiveProject,
    projectAssetSyncBarriers, projectImportsApplying, waitForProjectSaveQueue, enqueueProjectSave,
    patchProjectRecord, getProjectSwitchSequence,
  } = context;

  /**
   * 把普通项目转成剧集：新建一个只存原著/剧本与共享角色库的剧集项目，
   * 原项目原地变成第 1 集。画布、对话、输出历史都留在原记录上不动，
   * 只有角色库和项目记忆改挂到剧集项目，素材目录两者共用同一个。
   */
  async function promoteProjectToSeries(project: CanvasProject): Promise<string | undefined> {
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
  async function ensureCurrentSeriesId(): Promise<string | undefined> {
    const state = get();
    const current = state.projects.find((item) => item.id === state.currentProjectId);
    if (!current) return undefined;
    return current.parentId ?? await promoteProjectToSeries(current);
  }

  return {
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
      const native = nativeBinding(state.projects.find((item) => item.id === currentId));
      const runtime = native ? nativeRuntime.get(get) : undefined;
      const sequence = getProjectSwitchSequence();
      const isCurrent = () => get().currentProjectId === currentId && getProjectSwitchSequence() === sequence
        && get().projectLoadStatus === 'ready' && nativeRuntime.get(get) === runtime;
      if (native && (!runtime || runtime.activeId !== currentId || state.switchingProjectName !== null
        || state.isCreatingProject || state.isReturningToStartPage)) return [];
      // 当前画布必须先落盘：转成剧集和切集都会动到它，未保存的改动会丢。
      const saved = await get().saveCurrentProjectSilent();
      if (native && (!isCurrent() || projectImportsApplying.has(native.projectId) || get().switchingProjectName !== null)) return [];
      if (saved !== currentId) {
        get().showToast('当前画布保存失败，已取消新增分集', 'error');
        return [];
      }

      if (native && runtime) {
        const assertCurrent = () => {
          if (!isCurrent()) throw new Error('项目已切换，停止新增分集');
        };
        const restoreView = async () => {
          try {
            assertCurrent();
            const catalog = await loadProjectCatalog();
            const entry = catalog.native.find((item) => item.project.id === native.projectId);
            if (!entry) throw new Error('项目目录不可用');
            const target = currentId === native.projectId && entry.canvasIds.length ? entry.canvasIds[0] : currentId;
            await activateNativeProject(set, get, entry, target, assertCurrent, target === currentId, runtime);
            if (target !== currentId) {
              rememberActiveProject(target);
              get().loadConversationsForProject(target).catch((e) => console.warn('[新增分集] 加载会话失败:', e));
              get().loadAgentTasksForProject(target).catch((e) => console.warn('[新增分集] 加载任务失败:', e));
            }
          } catch (error) {
            if (isCurrent()) {
              set({ projectLoadStatus: 'error', projectExecutionContext: null });
              get().showToast(error instanceof Error ? error.message : '项目恢复失败，请重新打开', 'error');
            }
          }
        };
        const created: string[] = [];
        projectImportsApplying.add(native.projectId);
        set({ switchingProjectName: '正在更新分集', projectExecutionContext: null });
        try {
          await runtime.tail;
          assertCurrent();
          const { selection } = runtime.loaded;
          const { project, canvas } = selection;
          const lastNo = project.kind === 'standalone' ? 1
            : nativeEpisodeDisplayNumbers(selection.episodes).reduce((max, number) => Math.max(max, number), 0);
          const append = entries.map((input, index) => ({ ...input, episodeId: `e2-${crypto.randomUUID()}`,
            canvasId: `c2-${crypto.randomUUID()}`, displayNo: lastNo + index + 1 }));
          if (project.kind === 'standalone' && !canvas) throw new Error('原画布不可用');
          const conversion = project.kind === 'standalone' && canvas ? { expectedCanvasId: canvas.id, expectedCanvasEpoch: canvas.epoch,
            expectedCanvasRevision: canvas.revision, expectedStandaloneRevision: runtime.loaded.content.standaloneCreative?.revision ?? 0,
            episodeId: `e2-${crypto.randomUUID()}`, name: project.name } : undefined;
          const candidates = append.flatMap((input) => [input.episodeId, input.canvasId]);
          if (conversion) candidates.push(conversion.episodeId);
          const occupied = await readOccupiedProjectIds(candidates);
          assertCurrent();
          if (conversion && occupied.has(conversion.episodeId)) throw new Error('分集身份已被占用');
          const conflict = append.findIndex((input) => occupied.has(input.episodeId) || occupied.has(input.canvasId));
          const prefix = conflict < 0 ? append : append.slice(0, conflict);
          for await (const canvasId of appendNativeEpisodesInOrder({ projectId: native.projectId, expectedProjectEpoch: project.epoch,
            episodes: prefix, conversion })) {
            created.push(canvasId);
            assertCurrent();
          }
          if (conflict >= 0) throw new Error('分集身份已被占用');
        } catch (error) {
          if (isCurrent()) {
            const reason = error instanceof Error ? error.message : '新增分集失败';
            get().showToast(created.length ? `只成功新增了 ${created.length} 集，${reason}` : reason, 'error');
          }
        } finally {
          try { await restoreView(); }
          finally {
            projectImportsApplying.delete(native.projectId);
            if (getProjectSwitchSequence() === sequence) set({ switchingProjectName: null });
          }
        }
        return created;
      }

      const seriesId = await ensureCurrentSeriesId();
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
      const sequence = getProjectSwitchSequence();
      const [id] = await get().addEpisodes([{ name }]);
      if (id && getProjectSwitchSequence() === sequence) await get().switchProject(id);
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
      if (native && 'script' in info && !('originalWork' in info)) {
        const script = info.script;
        return writeNativeProjectText(get, native.projectId, async (runtime, isCurrent) => {
          const { selection, content } = runtime.loaded;
          const project = selection.project;
          const ownerId = project.kind === 'standalone' ? canvasProjectId : native.projectId;
          options?.assertCurrent?.();
          if (options?.expectedSeriesId !== undefined && options.expectedSeriesId !== ownerId
            || options?.expectedExchangeEpoch !== undefined && options.expectedExchangeEpoch !== project.epoch) {
            throw new Error('剧本所属项目已变化，已保留草稿');
          }
          if (options?.expectedScript !== undefined && (content.script ?? '') !== options.expectedScript) {
            throw new Error('剧本已变化，已保留草稿');
          }
          if (options?.expectedOriginalWork !== undefined
            && !configValuesEqual(options.expectedOriginalWork ?? undefined, content.originalWork)) throw new Error('原著引用已变化，请重新载入');
          const now = Date.now();
          const saved = await saveNativeProjectContent({ projectId: native.projectId, expectedProjectEpoch: project.epoch,
            expectedRevisions: { script: content.revisions.script }, patch: { script }, now });
          runtime.loaded = { ...runtime.loaded, content: saved.content, selection: { ...selection,
            project: { ...project, updatedAt: now }, changeRevision: saved.changeRevision } };
          if (isCurrent()) set((current) => ({ projects: current.projects.map((item) => item.id === ownerId
            ? { ...item, series: { ...item.series, script: saved.content.script }, updatedAt: now } : item) }));
        });
      }
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
      const navigationSequence = getProjectSwitchSequence();
      const requestedSeriesId = options?.expectedSeriesId;
      const expectedEpoch = options?.expectedExchangeEpoch;
      const expectedScript = options?.expectedScript;
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
        if (latest.currentProjectId !== canvasProjectId || getProjectSwitchSequence() !== navigationSequence
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
      const seriesId = requestedSeriesId ?? await ensureCurrentSeriesId();
      assertNavigationCurrent();
      if (!seriesId) return false;
      const initialSeries = get().projects.find((project) => project.id === seriesId);
      const epoch = expectedEpoch ?? initialSeries?.exchangeEpoch ?? 0;
      const assertSeriesCurrent = (allowOwnPatch = false) => {
        assertNavigationCurrent();
        const latest = get();
        const owner = latest.projects.find((project) => project.id === seriesId);
        if (!owner || owner.parentId || seriesOwnerId(latest.projects, canvasProjectId) !== seriesId
          || (owner.exchangeEpoch ?? 0) !== epoch) {
          throw new Error('原著所属剧集或编辑会话已变化，请重新打开');
        }
        if (expectedOriginal !== undefined && !sameOriginal(owner.series?.originalWork, expectedOriginal)
          && !(allowOwnPatch && 'originalWork' in changes && sameOriginal(owner.series?.originalWork, changes.originalWork))) {
          throw new Error('原著引用已变化，请保留草稿并重新载入');
        }
        if (expectedScript !== undefined && (owner.series?.script ?? '') !== expectedScript
          && !(allowOwnPatch && 'script' in changes && (owner.series?.script ?? '') === (changes.script ?? ''))) {
          throw new Error('剧本已变化，已保留草稿');
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
        const sequence = getProjectSwitchSequence();
        const runtime = isActive ? nativeRuntime.get(get) : undefined;
        const isCurrent = () => sequence === getProjectSwitchSequence() && get().currentProjectId === activeId
          && (!isActive || nativeRuntime.get(get) === runtime);
        const assertCurrent = () => { if (!isCurrent()) throw new Error('项目已切换，排序已停止'); };
        if (projectImportsApplying.has(native.projectId)) return false;
        if (isActive && activeId && (!runtime || await get().saveCurrentProjectSilent() !== activeId)) return false;
        if (!isCurrent() || projectImportsApplying.has(native.projectId) || get().switchingProjectName !== null) return false;
        const previousContext = get().projectExecutionContext;
        let previousRevision: number | undefined, writeStarted = false;
        projectImportsApplying.add(native.projectId);
        if (isActive) set({ switchingProjectName: '正在调整分集', projectExecutionContext: null });
        try {
          if (runtime) await runtime.tail;
          assertCurrent();
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
          if (isActive && activeId) await activateNativeProject(set, get, entry, activeId, assertCurrent, true, runtime);
          else set((currentState) => ({ projects: [...currentState.projects.filter((item) => nativeBinding(item)?.projectId !== native.projectId), ...projectNativeCatalogEntry(entry)] }));
          return true;
        } catch (error) {
          if (isActive && isCurrent()) {
            let unchanged = !writeStarted;
            if (writeStarted && previousRevision !== undefined) try {
              unchanged = (await readNativeProjectCapture(native.projectId))?.changeRevision === previousRevision;
            } catch { /* 无法核实提交结果 */ }
            if (isCurrent()) set(unchanged
              ? { projectLoadStatus: 'ready', projectExecutionContext: previousContext }
              : { projectLoadStatus: 'error', projectExecutionContext: null });
          }
          if (isCurrent()) get().showToast(error instanceof Error ? error.message : '分集排序失败', 'error');
          return false;
        } finally {
          projectImportsApplying.delete(native.projectId);
          if (isActive && sequence === getProjectSwitchSequence()) set({ switchingProjectName: null });
        }
      }

      const ownerId = episode.parentId;
      const ids = [ownerId, ...episodes.map((item) => item.id)];
      if (ids.some((id) => projectImportsApplying.has(id) || projectAssetSyncBarriers.has(id))) return false;
      const sequence = getProjectSwitchSequence();
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
          if (getProjectSwitchSequence() !== sequence || current.projectLoadStatus !== 'ready'
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
  };
}
