import type { StoreApi } from 'zustand';
import { t } from '../../i18n';
import type { Node, Edge } from '@xyflow/react';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../services/chat/assistantScope';
import type { BaseNodeData } from '../../types';
import type { ProjectSaveData } from '../../services/fileService';
import { listEpisodes, listTopLevelProjects, resolveOpenTargetId, seriesOwnerId } from '../store.utils';
import * as fileService from '../../services/fileService';
import { resumePendingTasks, stopPollingForDeletedProjects } from '../../services/pollManager';
import { prepareScriptWorkbenchStartPage } from '../../services/scriptWorkbenchAppClose';
import { stopProjectAgentTasks } from '../../services/chat/agentTaskControl';
import { cancelProjectCanvasDerivations } from '../../services/canvasDerivationGuard';
import { clearConversationFileGrants } from '../../services/chat/fileGrantService';
import { getLastActiveProjectId } from '../../services/indexedDbService';
import { isWebviewRecovery } from '../../services/webviewRecoveryService';
import { deleteLegacyProjectContent } from '../../services/indexedDb/legacyProjectLifecycleRepository';
import {
  createNativeProject, readNativeProjectCapture, deleteNativeEpisode, deleteNativeProject,
} from '../../services/indexedDb/nativeProjectRepository';
import { resolveProjectModel } from '../../services/projectModelRouter';
import { projectNativeCatalogEntry } from '../nativeProjectView';
import { cleanupFinalizedNativeProjectImportSources } from '../../services/nativeProjectImportService';
import type { AppState } from '../useAppStore';
import type {
  ProjectSlice, ProjectSliceGet, ProjectSliceSet, ProjectNavigationContext,
} from '../store.projects';

export function createProjectNavigationActions(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  api: StoreApi<AppState>,
  context: ProjectNavigationContext,
): Pick<ProjectSlice,
  | 'createProject'
  | 'deleteProject'
  | 'switchProject'
  | 'returnToStartPage'
  | 'refreshProjectCatalog'
  | 'loadProject'
  | 'initFromDb'
> {
  const {
    NATIVE_PROJECT_PENDING_EDITS, nativeCanvasHasUnsavedEdits, hasMediaImportBlockingNavigation,
    nativeKnownIds, nativeRuntime, nativeBinding, loadProjectCatalog, activateNativeProject,
    projectInitializations, episodeCreativeWrites, getProjectGroups, withLoadedProjectSummaries,
    hasProjectCanvasData, rememberActiveProject, projectAssetSyncBarriers, projectImportsApplying,
    invalidateSeriesLibrarySave, waitForProjectSaveQueue, waitForLoadingPaint, getProjectSwitchSequence,
    beginProjectSwitch, clearProjectSnapshot,
  } = context;
  return {
    createProject: async (name, options) => {
      const current = get();
      const currentOwner = nativeBinding(current.projects.find((item) => item.id === current.currentProjectId))?.projectId;
      if (options?.signal?.aborted || current.isCreatingProject || current.isReturningToStartPage
        || currentOwner && projectImportsApplying.has(currentOwner)) return undefined;
      if (hasMediaImportBlockingNavigation(current)) return undefined;
      const leavingReadonly = current.projectLoadStatus === 'readonly';
      if (leavingReadonly && current.hasUnsavedNativeProjectWriteBlock()) {
        current.showToast(NATIVE_PROJECT_PENDING_EDITS, 'error');
        return undefined;
      }
      set({ isCreatingProject: true });
      try {
        const createSequence = beginProjectSwitch();
        const isLatestCreate = () => !options?.signal?.aborted && createSequence === getProjectSwitchSequence()
          && (!leavingReadonly || !get().hasUnsavedNativeProjectWriteBlock());
        await waitForLoadingPaint();
        if (!isLatestCreate()) return undefined;
        const previousProjectId = get().currentProjectId;

        if (previousProjectId && !leavingReadonly) {
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
          if (fileService.isTauriEnv()) await fileService.claimNativeProjectDataDir(projectId, defaultName);
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

    deleteProject: async (id, options) => {
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
        if (projectImportsApplying.has(native.projectId)) return;
        const navigationSequence = getProjectSwitchSequence();
        const runtime = activeOwner ? nativeRuntime.get(get) : undefined;
        if (activeOwner && (!runtime || runtime.activeId !== activeId || await get().saveCurrentProjectSilent() !== activeId)) return;
        const latest = get();
        if (getProjectSwitchSequence() !== navigationSequence || latest.currentProjectId !== activeId
          || activeOwner && nativeRuntime.get(get) !== runtime || projectImportsApplying.has(native.projectId)
          || latest.projectLoadStatus !== 'ready' || latest.switchingProjectName !== null
          || latest.isCreatingProject || latest.isReturningToStartPage) return;
        const sequence = beginProjectSwitch();
        const isCurrent = () => {
          const current = get();
          return sequence === getProjectSwitchSequence() && current.currentProjectId === activeId
            && current.projectLoadStatus === 'ready' && (!activeOwner || nativeRuntime.get(get) === runtime);
        };
        const removingCurrent = activeOwner && (!native.episodeId || native.canvasId === activeId);
        const assertCanDelete = () => {
          if (!isCurrent()) throw new Error('项目已切换，删除已停止');
          if (removingCurrent && nativeCanvasHasUnsavedEdits(runtime, get())) {
            throw new Error('保存期间画布有新编辑，已保留当前画布，请保存后再删除');
          }
        };
        const previousContext = latest.projectExecutionContext;
        let previousRevision: number | undefined, writeStarted = false;
        let projectDeleted = false;
        const commitDeletion = async (write: (options: { signal: AbortSignal }) => Promise<unknown>) => {
          assertCanDelete();
          const controller = new AbortController();
          const unsubscribe = api.subscribe(() => {
            try { assertCanDelete(); } catch (error) { controller.abort(error); }
          });
          try {
            writeStarted = true;
            await write({ signal: controller.signal });
          } catch (error) {
            controller.signal.throwIfAborted();
            throw error;
          } finally { unsubscribe(); }
        };
        const recycleRequestId = options?.recycleMedia === true && !native.episodeId && fileService.isTauriEnv()
          ? crypto.randomUUID() : undefined;
        projectImportsApplying.add(native.projectId);
        if (activeOwner) set({ switchingProjectName: '正在删除项目', projectExecutionContext: null });
        try {
          if (runtime) await runtime.tail;
          assertCanDelete();
          const capture = await readNativeProjectCapture(native.projectId);
          if (!capture) throw new Error('项目不存在');
          previousRevision = capture.changeRevision;
          assertCanDelete();
          const recycle = recycleRequestId ? await import('../../services/fs/nativeProjectRecycle') : undefined;
          const recycleRoot = recycle ? await recycle.readNativeProjectRecycleRoot(native.projectId) : undefined;
          assertCanDelete();
          if (native.episodeId) {
            const episode = capture.aggregate.episodes.find((item) => item.id === native.episodeId);
            const body = capture.aggregate.episodeContents.find((item) => item.episodeId === native.episodeId);
            const canvas = capture.aggregate.canvases.find((item) => item.id === native.canvasId);
            if (!episode || !body || !canvas) throw new Error('分集身份已变化');
            cancelProjectCanvasDerivations(canvas.id); stopProjectAgentTasks(canvas.id);
            await commitDeletion((options) => deleteNativeEpisode({ projectId: native.projectId, expectedProjectEpoch: capture.aggregate.project.epoch,
              episodeId: episode.id, expectedCanvasId: canvas.id, expectedEpisodeRevision: episode.revision,
              expectedContentRevision: body.revision, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision }, options));
          } else {
            const ids = capture.aggregate.canvases.map((canvas) => canvas.id);
            ids.forEach((canvasId) => { cancelProjectCanvasDerivations(canvasId); stopProjectAgentTasks(canvasId); });
            await commitDeletion((options) => deleteNativeProject({ projectId: native.projectId, expectedProjectEpoch: capture.aggregate.project.epoch,
              expectedChangeRevision: capture.changeRevision, ...(recycleRequestId ? { recycleRequestId } : {}) }, options));
            projectDeleted = true;
            stopPollingForDeletedProjects(ids);
          }
          const catalog = await loadProjectCatalog();
          assertCanDelete();
          const entry = catalog.native.find((item) => item.project.id === native.projectId);
          if (entry) {
            if (activeOwner && activeId) {
              const nextId = activeId === id ? (entry.episodes[0]?.canvasId ?? entry.project.id) : activeId;
              const keepCanvas = nextId === activeId;
              await activateNativeProject(set, get, entry, nextId, assertCanDelete, keepCanvas, keepCanvas ? runtime : undefined);
              get().loadConversationsForProject(nextId).catch((e) => console.warn('[删除分集] 加载会话失败:', e));
              if (nextId !== activeId) {
                rememberActiveProject(nextId);
                get().repairInterruptedForProject(nextId).catch((e) => console.warn('[删除分集] 修复中断消息失败:', e));
                get().loadAgentTasksForProject(nextId).catch((e) => console.warn('[删除分集] 加载任务失败:', e));
                get().loadProjectMemoriesForProject(native.projectId).catch((e) => console.warn('[删除分集] 加载项目记忆失败:', e));
              }
            } else set((current) => ({ projects: [...current.projects.filter((item) => nativeBinding(item)?.projectId !== native.projectId), ...projectNativeCatalogEntry(entry)] }));
          } else {
            if (!projectDeleted) throw new Error('分集已删除，作品目录无法刷新，已保留当前画布');
            set((current) => ({ projects: current.projects.filter((item) => nativeBinding(item)?.projectId !== native.projectId),
              ...(activeOwner ? { currentProjectId: null, projectExecutionContext: undefined, projectName: '', nodes: [], edges: [], groups: [],
                history: [], historyIndex: -1, selectedNodeIds: [], activeConversationId: null, projectLoadStatus: 'ready' as const } : {}) }));
            if (recycle && recycleRequestId) {
              const result = await recycle.recycleRetiredNativeProjectDirectory(native.projectId, recycleRequestId, recycleRoot, () => {
                if (sequence !== getProjectSwitchSequence() || get().projects.some((item) => nativeBinding(item)?.projectId === native.projectId)) {
                  throw new Error('项目状态已变化，停止素材回收');
                }
              });
              if (result === 'recycled') get().showToast(t('项目已删除，素材已移入系统回收站'));
              else get().showToast(result === 'retained' ? t('项目已删除，素材目录已保留')
                : t('项目已删除，素材回收结果待核对'), 'info');
            }
          }
        } catch (error) {
          if (activeOwner && isCurrent()) {
            let unchanged = !writeStarted;
            if (writeStarted && previousRevision !== undefined) try {
              unchanged = (await readNativeProjectCapture(native.projectId))?.changeRevision === previousRevision;
            } catch { /* 无法核实提交结果 */ }
            if (isCurrent()) set(unchanged
              ? { projectLoadStatus: 'ready', projectExecutionContext: previousContext }
              : { projectLoadStatus: 'error', projectExecutionContext: null });
          }
          get().showToast(recycleRequestId && projectDeleted ? t('项目已删除，素材目录已保留')
            : error instanceof Error ? error.message : '删除失败，原数据已保留', 'error');
        } finally {
          projectImportsApplying.delete(native.projectId);
          if (activeOwner && sequence === getProjectSwitchSequence()) set({ switchingProjectName: null });
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
      const deletionSequence = beginProjectSwitch();
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
            if (getProjectSwitchSequence() !== deletionSequence || get().currentProjectId !== state.currentProjectId
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
              const assertCurrent = () => { if (getProjectSwitchSequence() !== deletionSequence || get().currentProjectId !== nextId) throw new Error('项目已切换'); };
              await activateNativeProject(set, get, entry, nextId, assertCurrent);
              rememberActiveProject(nextId);
            } catch (error) {
              set({ projectLoadStatus: 'error', projectExecutionContext: null });
              get().showToast(error instanceof Error ? error.message : '替代项目加载失败', 'error');
            }
            return;
          }
          const isCurrentReplacement = () => getProjectSwitchSequence() === deletionSequence
            && get().currentProjectId === nextId && get().projects.some((project) => project.id === nextId);
          const loadOptions = { recoverUndoTrash: true, assertCurrent: () => {
            if (!isCurrentReplacement()) throw new Error('项目已切换');
          } };
          const data = await fileService.loadProjectData(nextId, loadOptions);
          if (!isCurrentReplacement()) return;
          const { emptyDramaAssetLibrary } = await import('../../types/dramaAssets');
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
      const source = get(), currentProjectId = source.currentProjectId;
      if (options?.signal?.aborted || source.isReturningToStartPage || source.isCreatingProject
        || source.projectLoadStatus === 'loading') return;
      if (!source.projects.some((project) => project.id === requestedId)) return;
      if (hasMediaImportBlockingNavigation(source)) return;
      if (source.projectLoadStatus === 'readonly' && source.hasUnsavedNativeProjectWriteBlock()) {
        source.showToast(NATIVE_PROJECT_PENDING_EDITS, 'error');
        return;
      }
      const sourceOwner = nativeBinding(source.projects.find((item) => item.id === currentProjectId))?.projectId;
      if (projectImportsApplying.has(requestedId)
        || projectImportsApplying.has(seriesOwnerId(source.projects, requestedId))
        || sourceOwner && projectImportsApplying.has(sourceOwner)) return;
      // 剧集项目自身没有画布，点它等于打开它的分集。
      // ponytail: 固定开第一集；要「回到上次打开的那集」再往剧集记录里存一个 lastEpisodeId。
      const id = resolveOpenTargetId(source.projects, requestedId);
      const switchSequence = beginProjectSwitch();
      const isLatestSwitch = () => switchSequence === getProjectSwitchSequence() && !options?.signal?.aborted
        && !projectImportsApplying.has(id) && !projectImportsApplying.has(seriesOwnerId(get().projects, id))
        && (!sourceOwner || !projectImportsApplying.has(sourceOwner));
      const sourceRuntime = sourceOwner && source.projectLoadStatus === 'ready' ? nativeRuntime.get(get) : undefined;
      const assertCanReplaceSource = () => {
        if (!isLatestSwitch()) throw new Error('项目切换已取消');
        const latest = get();
        if (source.projectLoadStatus === 'readonly' && latest.hasUnsavedNativeProjectWriteBlock()) throw new Error(NATIVE_PROJECT_PENDING_EDITS);
        if (latest.currentProjectId !== currentProjectId || sourceRuntime
          && (nativeRuntime.get(get) !== sourceRuntime || nativeCanvasHasUnsavedEdits(sourceRuntime, latest))) {
          throw new Error('保存期间画布有新变化，已保留当前项目，请稍后再切换');
        }
      };
      const previousOwnerId = currentProjectId
        ? seriesOwnerId(source.projects, currentProjectId)
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
        assertCanReplaceSource();

        const project = get().projects.find((p) => p.id === id);
        if (!project) return;

        const native = nativeBinding(project);
        if (native) {
          const entry = await loadProjectCatalog(native.projectId);
          if (!isLatestSwitch()) return;
          if (!entry) throw new Error('新项目已不存在');
          const openedId = await activateNativeProject(set, get, entry, id, assertCanReplaceSource);
          rememberActiveProject(openedId);
          get().loadConversationsForProject(openedId).catch((e) => console.warn('[切换项目] 加载会话失败:', e));
          get().repairInterruptedForProject(openedId).catch((e) => console.warn('[切换项目] 修复中断消息失败:', e));
          get().loadAgentTasksForProject(openedId).catch((e) => console.warn('[切换项目] 加载 Agent 任务失败:', e));
          get().loadProjectMemoriesForProject(native.projectId).catch((e) => console.warn('[切换项目] 加载项目记忆失败:', e));
          setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
          return openedId;
        }

        fileService.ensureProjectDataDir(id).catch((e) => console.warn('[切换项目] 数据目录初始化失败:', e));

        const loadOptions = { recoverUndoTrash: true, assertCurrent: assertCanReplaceSource };
        const data = await fileService.loadProjectData(id, loadOptions);
        if (!isLatestSwitch()) return;
        const { emptyDramaAssetLibrary } = await import('../../types/dramaAssets');
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

        assertCanReplaceSource();
        set({
          projects: withLoadedProjectSummaries(get().projects, data, ownerData),
          currentProjectId: id,
          projectExecutionContext: undefined,
          projectName: data.name,
          projectLoadStatus: 'ready', nativeProjectWriteBlock: null,
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
          if (switchSequence !== getProjectSwitchSequence() || get().currentProjectId !== id || get().switchingProjectName !== null) return;
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
        if (switchSequence === getProjectSwitchSequence()) set({ switchingProjectName: null });
      }
    },

    returnToStartPage: async () => {
      const source = get(), projectId = source.currentProjectId, sequence = getProjectSwitchSequence();
      if (!projectId) return true;
      if (source.isReturningToStartPage || source.isCreatingProject || source.switchingProjectName !== null) return false;
      if (hasMediaImportBlockingNavigation(source)) return false;
      try {
        // 工作台可能仍在画布背后或独立窗口中。确认草稿时暂不冻结保存上下文。
        const prepareWorkbench = prepareScriptWorkbenchStartPage();
        if (prepareWorkbench && !await prepareWorkbench) return false;
      } catch {
        get().showToast('返回启动页失败，已保留当前画布，请重试', 'error');
        return false;
      }
      const state = get();
      if (state.currentProjectId !== projectId || getProjectSwitchSequence() !== sequence
        || state.isReturningToStartPage || state.isCreatingProject || state.switchingProjectName !== null) return false;
      if (hasMediaImportBlockingNavigation(state)) return false;
      const leavingReadonly = state.projectLoadStatus === 'readonly';
      if (leavingReadonly && state.hasUnsavedNativeProjectWriteBlock()) {
        state.showToast(NATIVE_PROJECT_PENDING_EDITS, 'error');
        return false;
      }
      if (state.projectLoadStatus !== 'ready' && !leavingReadonly) {
        state.showToast('项目尚未成功加载，暂时无法返回启动页', 'error');
        return false;
      }
      set({ isReturningToStartPage: true });
      try {
        // 先绘制返回状态。缩略图是派生预览，不能阻塞必要保存和导航。
        await waitForLoadingPaint();
        if (get().currentProjectId !== projectId || getProjectSwitchSequence() !== sequence) return false;
        const savingState = get();
        let savedId: string | undefined;
        if (leavingReadonly) {
          if (savingState.hasUnsavedNativeProjectWriteBlock()) return false;
          savedId = projectId;
        } else {
          // 正文先入队，空图清理或缓存预览的补丁随后排队，不能抢占必要保存。
          const saving = savingState.saveCurrentProjectSilent();
          void get().captureCurrentProjectSnapshot({ allowProjectChange: true, persistSnapshot: true }).catch(() => undefined);
          savedId = await saving;
        }
        if (savedId !== projectId || get().currentProjectId !== projectId || getProjectSwitchSequence() !== sequence) return false;
        const latest = get();
        // 保存期间 MCP 或生成任务仍可回填；卸载前必须确认没有落在这次快照之后的新内容。
        if (latest.nodes !== savingState.nodes || latest.edges !== savingState.edges
          || latest.groups !== savingState.groups || latest.dramaAssets !== savingState.dramaAssets) {
          latest.showToast('保存期间画布有新变化，已保留当前项目，请稍后再返回启动页', 'error');
          return false;
        }
        cancelProjectCanvasDerivations(projectId);
        clearProjectSnapshot(projectId);
        set({
          currentProjectId: null,
          projectWorkspaceView: 'canvas',
          scriptWorkbenchOpenProjectId: null,
          projectExecutionContext: undefined,
          nativeProjectWriteBlock: null,
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
      const sequence = beginProjectSwitch();
      const assertCurrent = () => { if (sequence !== getProjectSwitchSequence()) throw new Error('项目加载已被新的导航取代'); };
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
            const { emptyDramaAssetLibrary } = await import('../../types/dramaAssets');
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
        if (sequence !== getProjectSwitchSequence()) return;
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
      const initializationSequence = beginProjectSwitch();
      const assertInitialization = () => { if (initializationSequence !== getProjectSwitchSequence()) throw new Error('项目初始化已被新的导航取代'); };
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
          const demoId = 'aicanvas-web-demo';
          const demoProjectId = !recoveringWebview && typeof window !== 'undefined' && window.frameElement
            && !fileService.isTauriEnv() && new URLSearchParams(window.location.search).get('demoProject') === demoId
            && mapped.some((project) => project.id === demoId) ? demoId : null;
          if ((!demoProjectId && get().config.startupView === 'project-library') || recoveringWebview) {
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
            const rememberedProjectId = demoProjectId ?? await getLastActiveProjectId().catch(() => null);
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
            const { emptyDramaAssetLibrary } = await import('../../types/dramaAssets');
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
              if (!demoProjectId) rememberActiveProject(targetId);
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
            if (fileService.isTauriEnv()) await fileService.claimNativeProjectDataDir(projectId, '默认画布');
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
            if (get().projectLoadStatus === 'ready' && get().projectExecutionContext?.modelGeneration !== 1) {
              resumePendingTasks(activeProjectId).catch((e) => console.warn('[初始化] 恢复待续任务失败:', e));
            }
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
          if (get().projectLoadStatus === 'ready' || get().projectLoadStatus === 'readonly') {
            set({ projectInitialized: true });
            void cleanupFinalizedNativeProjectImportSources();
          }
        } catch (error) {
          if (initializationSequence !== getProjectSwitchSequence()) return;
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
}
