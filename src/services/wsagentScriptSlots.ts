import { needsNativeEpisodeContent, type NativeProjectViewItem } from '../store/nativeProjectView';
import { pendingProjectCreativeWrite } from '../store/store.projects';
import { useAppStore } from '../store/useAppStore';
import { listEpisodes, seriesOwnerId } from '../store/store.utils';
import type { CanvasProject } from '../types';
import {
  assertEpisodeEditorReady, EpisodeEditorWriteBlockedError, prepareEpisodeEditorRebase, withEpisodeEditorWrite,
} from './episodeEditorSessionService';
import { readEpisodeWorkspaceScope } from './episodeWorkspaceScope';
import { sha256BytesHex } from './mediaDataUrl';
import { activeWsagentOwner } from './wsagentSharedImages';

type ScriptApplyResult = 'applied' | 'deferred';

export interface WsagentScriptSlot {
  id: string;
  kind: 'project' | 'episode';
  title: string;
  content: string;
  assertCurrent: () => void;
  apply: (content: string, assertCurrent: () => void) => Promise<ScriptApplyResult>;
}

const normalizeLineEndings = (value: string) => value.replace(/\r\n?/g, '\n');
const episodeIdentity = (episode: CanvasProject) => (episode as NativeProjectViewItem).nativeView?.episodeId ?? episode.id;

function assertSavedScript(projectId: string): void {
  if (pendingProjectCreativeWrite(projectId)) throw new EpisodeEditorWriteBlockedError('剧本正在保存，等待保存完成后再同步');
}

async function writeReadyScript(editorId: string, write: () => Promise<boolean>): Promise<ScriptApplyResult> {
  try {
    return await withEpisodeEditorWrite<ScriptApplyResult>(editorId, async () => {
      const rebase = prepareEpisodeEditorRebase(editorId);
      if (!await write()) throw new Error('剧本同步保存尚未确认');
      rebase();
      return 'applied';
    });
  } catch (error) {
    if (error instanceof EpisodeEditorWriteBlockedError) return 'deferred';
    throw error;
  }
}

function projectScriptSlot(ownerId: string, owner: CanvasProject, readOwner: () => CanvasProject): WsagentScriptSlot {
  const before = owner.series?.script ?? '';
  const assertCurrent = () => {
    assertSavedScript(owner.id);
    const latest = readOwner();
    if (latest.name !== owner.name || (latest.series?.script ?? '') !== before) throw new Error('全剧剧本已变化');
  };
  return {
    id: ownerId, kind: 'project', title: owner.name, content: normalizeLineEndings(before), assertCurrent,
    apply: (content, assertPeerCurrent) => writeReadyScript(owner.id, async () => {
      assertCurrent();
      const assertWrite = () => {
        assertPeerCurrent();
        readOwner();
        assertEpisodeEditorReady(owner.id);
      };
      assertWrite();
      return useAppStore.getState().updateSeriesInfo({ script: normalizeLineEndings(content) }, {
        expectedSeriesId: owner.id, expectedExchangeEpoch: owner.exchangeEpoch ?? 0,
        expectedScript: before, assertCurrent: assertWrite,
      });
    }),
  };
}

function episodeScriptSlot(episode: CanvasProject, readOwner: () => CanvasProject): WsagentScriptSlot {
  const id = episodeIdentity(episode);
  const before = episode.episodeScript ?? '';
  const epoch = episode.exchangeEpoch ?? 0;
  const readScope = () => {
    const owner = readOwner();
    const scope = readEpisodeWorkspaceScope(useAppStore.getState(), episode.id);
    if (!scope || scope.owner.id !== owner.id || (scope.episode.exchangeEpoch ?? 0) !== epoch
      || episodeIdentity(scope.episode) !== id || needsNativeEpisodeContent(scope.episode)) throw new Error('剧本所属分集已变化');
    return scope;
  };
  const assertCurrent = () => {
    assertSavedScript(episode.id);
    const latest = readScope().episode;
    if (latest.name !== episode.name || (latest.episodeScript ?? '') !== before) throw new Error('分集剧本已变化');
  };
  return {
    id, kind: 'episode', title: episode.name, content: normalizeLineEndings(before), assertCurrent,
    apply: (content, assertPeerCurrent) => writeReadyScript(episode.id, async () => {
      const hash = await sha256BytesHex(new TextEncoder().encode(before));
      assertCurrent();
      const assertCommitCurrent = () => { assertPeerCurrent(); readScope(); };
      assertCommitCurrent();
      return useAppStore.getState().updateEpisodeCreative(episode.id, { script: normalizeLineEndings(content) }, {
        allowSameSeries: true,
        expected: { kind: 'episode', field: 'script', episodeId: episode.id, seriesId: readOwner().id, expectedHash: hash, label: episode.name },
        assertCurrent: () => { assertCommitCurrent(); assertEpisodeEditorReady(episode.id); },
        assertCommitCurrent,
      });
    }),
  };
}

/** Only saved project and episode scripts are projected. Hydrating native views never switches the active canvas. */
export async function readWsagentScriptSlots(ownerId: string, projectId: string, assertCurrent: () => void): Promise<WsagentScriptSlot[]> {
  const initial = useAppStore.getState();
  const viewId = seriesOwnerId(initial.projects, projectId);
  const owner = initial.projects.find((item) => item.id === viewId);
  if (!owner || owner.parentId) throw new Error('剧本所属作品不可用');
  const epoch = owner.exchangeEpoch ?? 0;
  const runtimeEpoch = initial.projectExecutionContext?.runtimeEpoch;
  const readOwner = () => {
    assertCurrent();
    const state = useAppStore.getState();
    const latest = state.projects.find((item) => item.id === viewId);
    if (state.currentProjectId !== projectId || activeWsagentOwner(state) !== ownerId
      || state.projectExecutionContext?.runtimeEpoch !== runtimeEpoch || seriesOwnerId(state.projects, projectId) !== viewId
      || !latest || latest.parentId || (latest.exchangeEpoch ?? 0) !== epoch) throw new Error('当前剧本作品已切换');
    return latest;
  };
  readOwner();
  const episodes = listEpisodes(initial.projects, viewId);
  await Promise.allSettled([pendingProjectCreativeWrite(viewId), ...episodes.map((episode) => pendingProjectCreativeWrite(episode.id))]);
  readOwner();
  const slots: WsagentScriptSlot[] = [];
  for (let index = 0; index < episodes.length; index += 8) {
    const batch = await Promise.all(episodes.slice(index, index + 8).map((episode) => initial.loadEpisodeCreative(episode.id)));
    readOwner();
    slots.push(...batch.map((episode) => episodeScriptSlot(episode, readOwner)));
  }
  return [projectScriptSlot(ownerId, readOwner(), readOwner), ...slots];
}
