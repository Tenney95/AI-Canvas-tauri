/** 工作台编辑会话只保存在内存；后台成果应用必须与活动草稿握手。 */
interface EpisodeEditorState {
  dirty: boolean;
  saving: boolean;
}

interface EditorSession {
  episodeId: string;
  read: (() => EpisodeEditorState) | null;
  prepareRebase?: () => () => void;
}

const sessions: Map<symbol, EditorSession> = import.meta.hot?.data.episodeEditorSessions ?? new Map();
const writingEpisodes: Set<string> = import.meta.hot?.data.episodeEditorWrites ?? new Set();
const listeners: Set<() => void> = import.meta.hot?.data.episodeEditorListeners ?? new Set();
if (import.meta.hot) {
  import.meta.hot.data.episodeEditorSessions = sessions;
  import.meta.hot.data.episodeEditorWrites = writingEpisodes;
  import.meta.hot.data.episodeEditorListeners = listeners;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeEpisodeEditorWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function isEpisodeEditorWriteLocked(episodeId: string | undefined): boolean {
  return !!episodeId && writingEpisodes.has(episodeId);
}

export function hasUnsettledEpisodeEditorSession(episodeId: string | undefined): boolean {
  return !!episodeId && [...sessions.values()].some((session) => session.episodeId === episodeId && session.read === null);
}

/** 未确认的脏稿卸载后保留阻塞，不能把失联误认为干净。 */
export function registerEpisodeEditorSession(
  episodeId: string,
  read: () => EpisodeEditorState,
  prepareRebase?: () => () => void,
): () => void {
  const id = Symbol(episodeId);
  sessions.set(id, { episodeId, read, prepareRebase });
  return () => {
    const current = sessions.get(id);
    if (!current) return;
    const state = current.read?.();
    if (state?.dirty || state?.saving) { current.read = null; notify(); }
    else sessions.delete(id);
  };
}

/** 捕获干净编辑副本的版本；只在实际字段保存成功后调用返回的同步器。 */
export function prepareEpisodeEditorRebase(episodeId: string): () => void {
  assertEpisodeEditorReady(episodeId);
  const commits = [...sessions.values()].filter((session) => session.episodeId === episodeId && session.read)
    .map((session) => session.prepareRebase?.()).filter((commit): commit is () => void => !!commit);
  return () => { for (const commit of commits) commit(); };
}

/** 只在用户保存成功或明确丢弃时清除失联草稿标记。 */
export function settleEpisodeEditorSessions(episodeId: string): void {
  let changed = false;
  for (const [id, session] of sessions) {
    if (session.episodeId === episodeId && session.read === null) { sessions.delete(id); changed = true; }
  }
  if (changed) notify();
}

export function assertEpisodeEditorReady(episodeId: string): void {
  for (const session of sessions.values()) {
    if (session.episodeId !== episodeId) continue;
    const state = session.read?.();
    if (!state || state.dirty || state.saving) {
      throw new Error('本集工作台还有未保存或尚未确认处理的修改，请先保存或明确丢弃，再应用团队成果');
    }
  }
}

/** 锁定期间编辑器拒绝新输入，避免条件校验后、实际保存前又出现局部脏稿。 */
export async function withEpisodeEditorWrite<T>(episodeId: string, write: () => Promise<T>): Promise<T> {
  if (writingEpisodes.has(episodeId)) throw new Error('本集已有成果正在保存，请等待完成');
  assertEpisodeEditorReady(episodeId);
  writingEpisodes.add(episodeId);
  try {
    notify();
    return await write();
  } finally {
    writingEpisodes.delete(episodeId);
    notify();
  }
}
