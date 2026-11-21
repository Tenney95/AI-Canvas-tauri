import type { StoreApi } from 'zustand';
import type { CanvasProject } from '../../types';
import type { EpisodeContent } from '../../types/project';
import { normalizeEpisodeAssetRoster, type EpisodeAssetRoster } from '../../types/episodeAssets';
import { normalizeCreationProfileSelection } from '../../services/creationProfiles/creationProfileManifest';
import { normalizeTeamProfile } from '../../services/chat/teams/teamProfileService';
import { prepareEpisodeScriptFileWrite, type EpisodeScriptFileReceipt } from '../../services/episodeScriptFileService';
import { readEpisodeWorkspaceScope } from '../../services/episodeWorkspaceScope';
import * as fileService from '../../services/fileService';
import { readNativeEpisodeContent, saveNativeEpisodeContent, updateNativeEpisodeComposite } from '../../services/indexedDb/nativeProjectRepository';
import { sha256BytesHex } from '../../services/mediaDataUrl';
import { readNativeProjectView } from '../../services/nativeProjectNavigation';
import { episodeTeamSourceSnapshot } from '../../services/seriesCreativeService';
import { normalizeProjectTextFileReference } from '../../utils/manuscriptFileReference';
import { applyNativeEpisodeContent, needsNativeEpisodeContent, type NativeProjectViewItem } from '../nativeProjectView';
import type { EpisodeCreativeContext, ProjectSlice, ProjectSliceGet, ProjectSliceSet } from '../store.projects';
import { seriesOwnerId } from '../store.utils';
import type { AppState } from '../useAppStore';

export function createEpisodeCreativeActions(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  api: Pick<StoreApi<AppState>, 'subscribe'>,
  { getNativeRuntime, getProjectSwitchSequence, isProjectMutationPending, nativeBinding, mutateNativeMetadata,
    patchProjectRecord, serializeEpisodeCreativeWrite }: EpisodeCreativeContext,
): Pick<ProjectSlice, 'updateEpisodeOutline' | 'loadEpisodeCreative' | 'updateEpisodeCreative' | 'updateEpisodeAssetRoster'> {
  return {
    updateEpisodeOutline: async (episodeId, outline) => get().updateEpisodeCreative(episodeId, { outline }),

    loadEpisodeCreative: async (episodeId) => {
      const current = readEpisodeWorkspaceScope(get(), episodeId);
      if (!current) throw new Error('分集已切换或不属于当前剧集');
      const initial = current.episode;
      if (!needsNativeEpisodeContent(initial)) return initial;
      const runtime = getNativeRuntime(), binding = nativeBinding(initial);
      const sequence = getProjectSwitchSequence();
      if (!runtime || runtime.activeId !== current.canvasProjectId || !binding?.episodeId
        || binding.canvasId !== episodeId || binding.projectId !== current.owner.id) throw new Error('分集正文上下文不可用');
      const projectId = binding.projectId, nativeEpisodeId = binding.episodeId;
      const reads = runtime.episodeReads ??= new Map();
      const pending = reads.get(episodeId);
      if (pending) return pending;
      const read = (async () => {
        const loaded = await readNativeEpisodeContent(projectId, nativeEpisodeId);
        const scope = readEpisodeWorkspaceScope(get(), episodeId);
        if (!scope || scope.canvasProjectId !== current.canvasProjectId || scope.owner.id !== projectId
          || getNativeRuntime() !== runtime || getProjectSwitchSequence() !== sequence
          || isProjectMutationPending(projectId)) {
          throw new Error('分集已切换，读取已停止');
        }
        const latest = scope.episode as NativeProjectViewItem;
        const target = nativeBinding(latest);
        if (!target || target.projectId !== projectId || target.canvasId !== episodeId || target.episodeId !== nativeEpisodeId
          || (latest.exchangeEpoch ?? 0) !== (initial.exchangeEpoch ?? 0)) throw new Error('分集已变化，请重新读取');
        // 并发保存已经投影新正文时，直接使用它，旧读取不能覆盖本次保存。
        if (!needsNativeEpisodeContent(latest)) return latest;
        if (!loaded || loaded.project.epoch !== (scope.owner.exchangeEpoch ?? 0) || loaded.episode.canvasId !== episodeId
          || loaded.episode.epoch !== (latest.exchangeEpoch ?? 0) || loaded.episode.revision !== target.episodeRevision) {
          throw new Error('分集正文已变化或无法读取，请重新打开');
        }
        const view = applyNativeEpisodeContent(latest, loaded.content);
        set((state) => ({ projects: state.projects.map((item) => item === latest ? view : item) }));
        return view;
      })();
      reads.set(episodeId, read);
      try { return await read; }
      finally { if (reads.get(episodeId) === read) reads.delete(episodeId); }
    },

    updateEpisodeCreative: async (episodeId, updates, options) => serializeEpisodeCreativeWrite(episodeId, async () => {
      const native = nativeBinding(get().projects.find((item) => item.id === episodeId));
      const rebuildScriptFile = options?.rebuildScriptFile === true;
      if (rebuildScriptFile && (!native || options?.expected || Object.keys(updates).length)) return false;
      if (native) {
        if (!native.episodeId || !native.canvasId) return false;
        const state = get(), runtime = getNativeRuntime(), activeId = state.currentProjectId;
        if (!runtime || !activeId || nativeBinding(state.projects.find((item) => item.id === activeId))?.projectId !== native.projectId
          || activeId !== episodeId && !options?.allowSameSeries) return false;
        const sequence = getProjectSwitchSequence();
        const baseDataDir = state.config.baseDataDir;
        const assertCurrent = () => {
          options?.assertCurrent?.(); options?.assertCommitCurrent?.();
          const latest = get();
          if (latest.currentProjectId !== activeId || getProjectSwitchSequence() !== sequence || latest.projectLoadStatus !== 'ready'
            || latest.switchingProjectName !== null || getNativeRuntime() !== runtime
            || latest.config.baseDataDir !== baseDataDir) throw new Error('分集或存储目录已变化，草稿已保留');
        };
        const previous = runtime.tail;
        let release!: () => void;
        runtime.tail = new Promise<void>((resolve) => { release = resolve; });
        try {
          await previous;
          assertCurrent();
          const loaded = await readNativeProjectView(native.projectId, native.canvasId);
          assertCurrent();
          const episode = loaded?.selection.episode, body = loaded?.episodeContent;
          if (!loaded || !episode || !body || episode.id !== native.episodeId) throw new Error('分集正文已变化');
          if (native.episodeContentRevision !== undefined && body.revision !== native.episodeContentRevision
            && ('outline' in updates || 'script' in updates || 'creative' in updates || rebuildScriptFile)) throw new Error('分集正文已变化，草稿已保留');
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
          if (!Object.keys(patch).length && !Object.keys(metadata).length && !rebuildScriptFile) return true;
          if ('script' in updates || rebuildScriptFile) {
            if (rebuildScriptFile && !body.script?.trim()) throw new Error('请先保存本集剧本正文');
            const receipt = await prepareEpisodeScriptFileWrite({ episodeId: episode.id, projectId: native.projectId,
              exchangeEpoch: loaded.selection.project.epoch, episodeExchangeEpoch: episode.epoch, name: episode.name,
              previousText: body.script ?? '', text: (rebuildScriptFile ? body.script : updates.script) ?? '',
              reference: rebuildScriptFile ? undefined : body.scriptFile,
              nativeManuscriptRootRef: body.storageRootRef === loaded.selection.project.storageRootRef ? undefined : body.storageRootRef,
              preserveBoundFile: true, assertCurrent, subscribe: api.subscribe });
            if (rebuildScriptFile && !receipt) throw new Error('请在桌面应用中重建 TXT');
            if (receipt) patch.scriptFile = receipt.reference;
          }
          assertCurrent();
          const saved = await updateNativeEpisodeComposite({ projectId: native.projectId, expectedProjectEpoch: loaded.selection.project.epoch,
            episodeId: episode.id, expectedCanvasId: native.canvasId, expectedEpisodeRevision: episode.revision,
            expectedContentRevision: body.revision, ...(Object.keys(patch).length ? { contentPatch: patch } : {}), ...metadata });
          if (get().currentProjectId !== activeId || getProjectSwitchSequence() !== sequence || getNativeRuntime() !== runtime) return true;
          if (activeId === episodeId) runtime.loaded = { ...runtime.loaded, episodeContent: saved.content,
            selection: { ...runtime.loaded.selection, episode: saved.episode,
              episodes: runtime.loaded.selection.episodes.map((item) => item.id === saved.episode.id ? saved.episode : item) } };
          set((current) => ({ projects: current.projects.map((item) => item.id === episodeId
            ? applyNativeEpisodeContent({ ...item, creationProfile: saved.episode.creationProfile, teamProfileOverride: saved.episode.teamProfileOverride,
              nativeView: { ...native, episodeRevision: saved.episode.revision } }, saved.content) : item) }));
          return true;
        } catch (error) {
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
      const navigationSequence = getProjectSwitchSequence();
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
          || latest.currentProjectId !== canvasProjectId || !canvasProjectId || getProjectSwitchSequence() !== navigationSequence
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
  };
}
