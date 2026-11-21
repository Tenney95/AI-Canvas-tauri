import { t } from '../../i18n';
import type { CanvasProject } from '../../types';
import { resolveOpenTargetId, seriesOwnerId } from '../store.utils';
import * as fileService from '../../services/fileService';
import { getPendingTasksForProject } from '../../services/pollManager';
import {
  cancelProjectCanvasDerivations, hasPendingCanvasMediaImport,
} from '../../services/canvasDerivationGuard';
import {
  duplicateProjectArchive, exportProjectArchive, importProjectArchive,
} from '../../services/projectTransferService';
import {
  prepareProjectImport, previewProjectImport, applyProjectImport, nativeImportPreview,
  withPreparedProjectImportRead, restoreProjectImportRecovery,
} from '../../services/projectImportService';
import {
  abortNativeSharedAssetSync, finalizeNativeSharedAssetSync, readNativeSharedAssetSync,
} from '../../services/indexedDb/nativeSharedAssetSyncRepository';
import { ProjectImportCommittedError } from '../../services/projectImportOutcome';
import { projectNativeCatalogEntry } from '../nativeProjectView';
import {
  duplicateNativeProjectArchive, exportNativeProjectArchive,
} from '../../services/nativeProjectArchiveService';
import {
  importNativeProjectArchive, importNativeProjectArchiveFromSession,
} from '../../services/nativeProjectImportService';
import type { ProjectSlice, ProjectSliceGet, ProjectSliceSet, ProjectTransferContext } from '../store.projects';

export function createProjectTransferActions(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  context: ProjectTransferContext,
): Pick<ProjectSlice,
  | 'exportProject'
  | 'duplicateProject'
  | 'prepareProjectImport'
  | 'previewProjectImport'
  | 'importProject'
  | 'settleProjectTransfer'
  | 'restoreProjectImport'
> {
  const {
    NATIVE_PROJECT_PENDING_EDITS, nativeLibraryContentChanged, hasNativeProjectDrafts, nativeKnownIds,
    nativeRuntime, nativeBinding, loadProjectCatalog, activateNativeProject, runNativeImportMutation,
    projectAssetSyncBarriers, projectImportsApplying, invalidateSeriesLibrarySave, importPreviewGuards,
    waitForProjectSaveQueue, getProjectSwitchSequence,
  } = context;
  return {
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
        await (await import('../../services/nativeProjectUpdateService')).previewNativeProjectUpdate(session.nativeSource!, native.projectId, session.directory)))
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
          async (assertCurrent) => { guard(); await (await import('../../services/nativeProjectUpdateService')).applyNativeProjectUpdate(preview.nativeUpdate!, choices, assertCurrent, options); }));
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

    settleProjectTransfer: async (ownerId, operationId, action) => {
      const binding = nativeBinding(get().projects.find((item) => item.id === ownerId || nativeBinding(item)?.projectId === ownerId));
      if (!binding) throw new Error('无法确认原操作所属项目');
      const projectId = binding.projectId;
      const repository = await import('../../services/indexedDb/nativeProjectRepository');
      const pending = await repository.listNativeProjectPendingTransfers(projectId);
      const before = get(), block = before.nativeProjectWriteBlock;
      const pendingOperation = pending.find((item) => item.operationId === operationId);
      // 已结算但前次重读失败时，只允许当前只读画布重试原操作的投影。
      const operation = pendingOperation
        ?? (block?.kind === 'shared-sync' && block.projectId === projectId && block.operationId === operationId ? block : undefined);
      if (!operation) throw new Error('原操作已结束或不属于当前项目，请刷新');
      if (projectImportsApplying.has(projectId) || projectAssetSyncBarriers.has(projectId)) throw new Error('该项目正在处理其它操作');
      if (operation.kind === 'export') {
        await (await import('../../services/nativeProjectArchiveService')).settleNativeProjectArchiveExport(projectId, operationId, action);
        return;
      }
      if (action === 'abandon' || operation.kind === 'shared-sync') {
        const runtime = nativeRuntime.get(get), sequence = getProjectSwitchSequence();
        const activeId = before.currentProjectId;
        const sharedOnReadyCanvas = operation.kind === 'shared-sync' && before.projectLoadStatus === 'ready'
          && nativeBinding(before.projects.find((item) => item.id === activeId))?.projectId === projectId;
        if (sharedOnReadyCanvas && (before.switchingProjectName !== null || before.isCreatingProject || before.isReturningToStartPage
          || hasPendingCanvasMediaImport(before))) {
          throw new Error('当前项目正在切换或导入素材，请稍后处理原操作');
        }
        const active = sharedOnReadyCanvas || before.nativeProjectWriteBlock?.projectId === projectId && before.projectLoadStatus === 'readonly';
        projectImportsApplying.add(projectId);
        try {
          if (sharedOnReadyCanvas) {
            set({ projectLoadStatus: 'readonly', projectExecutionContext: null, nativeProjectWriteBlock: { projectId, ...operation } });
          }
          if (operation.kind === 'shared-sync') {
            if (active && runtime) await runtime.tail;
            const journal = await readNativeSharedAssetSync(operationId);
            if (journal?.projectId !== projectId) throw new Error('原共享同步已结束或不属于当前项目，请刷新');
            if (journal.phase === 'prepared') {
              if (!pendingOperation) throw new Error('原共享同步仍在待处理，请刷新后核对');
              if (action === 'continue') {
                const latest = get();
                if (active && latest.currentProjectId === activeId && nativeRuntime.get(get) === runtime
                  && journal.hasLibraryUpdate && runtime && nativeLibraryContentChanged(runtime.library, latest.dramaAssets)) {
                  throw new Error('当前有未保存的素材库编辑，已保留原同步操作和编辑');
                }
                await finalizeNativeSharedAssetSync(journal);
              } else await abortNativeSharedAssetSync(operationId);
            }
          } else await repository.abortNativeProjectUpdate(operationId);
          if (active && activeId && get().currentProjectId === activeId && getProjectSwitchSequence() === sequence) {
            if (!runtime) throw new Error('原操作已处理，请从项目库重新打开');
            const assertCurrent = () => {
              const latest = get();
              if (latest.currentProjectId !== activeId || getProjectSwitchSequence() !== sequence || nativeRuntime.get(get) !== runtime) {
                throw new Error('原操作已处理，当前项目已切换');
              }
            };
            const catalog = await loadProjectCatalog(), entry = catalog.native.find((item) => item.project.id === projectId);
            assertCurrent();
            if (!entry) throw new Error('原操作已处理，但项目目录无法重新读取');
            await activateNativeProject(set, get, entry, activeId, assertCurrent, true, runtime);
          }
        } finally { projectImportsApplying.delete(projectId); }
        return;
      }
      if (nativeBinding(before.projects.find((item) => item.id === before.currentProjectId))?.projectId === projectId
        && hasNativeProjectDrafts(before, nativeRuntime.get(get), projectId)) {
        throw new Error(NATIVE_PROJECT_PENDING_EDITS);
      }
      await runNativeImportMutation(set, get, projectId, operationId,
        async (assertCurrent) => (await import('../../services/nativeProjectUpdateService')).resumeNativeProjectUpdate(operationId, assertCurrent));
    },

    restoreProjectImport: async (ownerId, recoveryId) => {
      const binding = nativeBinding(get().projects.find((item) => item.id === ownerId || nativeBinding(item)?.projectId === ownerId));
      if (nativeKnownIds.has(ownerId) && !binding) throw new Error('新项目身份不可用，请重新打开');
      if (binding) {
        const operationId = crypto.randomUUID();
        const activeId = get().currentProjectId;
        if (nativeBinding(get().projects.find((item) => item.id === activeId))?.projectId === binding.projectId
          && await get().saveCurrentProjectSilent() !== activeId) throw new Error('当前画布保存失败');
        await runNativeImportMutation(set, get, binding.projectId, operationId,
          async (assertCurrent) => (await import('../../services/nativeProjectUpdateService')).restoreNativeContentRecovery(binding.projectId, recoveryId, operationId, assertCurrent));
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
  };
}
