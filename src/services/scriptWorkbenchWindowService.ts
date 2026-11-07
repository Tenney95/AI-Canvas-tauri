/** 剧本工作台窗口的固定路由、握手与受限 RPC；本模块不读文件、不执行模型。 */
import type { ScriptWorkbenchRequest, ScriptWorkbenchResponse, ScriptWorkbenchSnapshot } from '../types/scriptWorkbench';
import { sanitizeDomainText } from './chat/subAgentMaterials';
import type { ProjectWindowContext } from '../types/projectWindow';
import { sameProjectWindowContext } from './projectWindowContext';

export const SCRIPT_WORKBENCH_WINDOW_LABEL = 'script-workbench';
const STATE_EVENT = 'script-workbench:state';
const HELLO_EVENT = 'script-workbench:hello';
const READY_EVENT = 'script-workbench:ready';
const EARLY_CLOSE_EVENT = 'script-workbench:early-close';
const REQUEST_EVENT = 'script-workbench:request';
const RESPONSE_EVENT = 'script-workbench:response';
const ACTIONS = new Set(['flush_draft', 'edit_text', 'edit_creative', 'select_episode', 'set_tab', 'save', 'close', 'dock', 'detach',
  'cancel_pending', 'discard_pending', 'save_pending', 'toggle_split', 'set_split_source', 'set_split_count', 'set_split_duration',
  'open_source', 'close_source', 'read_source', 'prepare_chapter', 'open_rename', 'close_rename', 'rename', 'creative', 'polish',
  'original_open', 'original_edit', 'original_save', 'original_reload', 'original_generate', 'original_apply',
  'original_discard_candidate', 'original_cancel',
  'shotlist', 'split_draft', 'extract_series', 'close_asset_preview', 'commit_asset_preview', 'asset', 'settle_editor',
  'set_execution', 'set_team_mode', 'save_team_profile', 'team_control', 'team_artifact', 'team_amend', 'view_agent_task',
  'preview_creation_profile', 'apply_creation_profile', 'refresh_external_agents', 'edit_team_graph', 'resolve_dispatch',
  'story_graph_filter', 'story_graph_detail', 'story_graph_patch', 'story_graph_resolve_evidence', 'story_graph_locate',
  'story_graph_extract', 'story_graph_cancel', 'story_graph_discard', 'story_graph_adopt', 'story_graph_editor']);
const isDesktop = () => typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

/** 重复入口只聚焦固定窗口，不重建编辑会话。 */
export async function focusScriptWorkbenchWindow(): Promise<void> {
  if (!isDesktop()) return;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(SCRIPT_WORKBENCH_WINDOW_LABEL);
  if (existing) { await existing.show(); await existing.unminimize(); await existing.setFocus(); }
}

export async function closeUninitializedScriptWorkbench(sessionId: string): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('main', EARLY_CLOSE_EVENT, { sessionId });
}

export interface ScriptWorkbenchWindowHost {
  open(): Promise<void>;
  publish(): Promise<void>;
  close(): Promise<void>;
  dispose(): void;
}

export function createScriptWorkbenchWindowHost(options: {
  sessionId: string;
  getSnapshot: () => ScriptWorkbenchSnapshot;
  /** 主窗口从实际 Store/工作台选择捕获；不由请求者提供或从当前画布补出分集。 */
  getContext?: () => ProjectWindowContext | null;
  onRequest: (request: ScriptWorkbenchRequest) => Promise<unknown>;
  onDetachedChange: (detached: boolean) => void;
  onReplySent?: () => void;
}): ScriptWorkbenchWindowHost {
  let disposed = false;
  let revision = 0;
  let opening: Promise<void> | undefined;
  let listening: Promise<void> | undefined;
  let visible = false;
  let closeWindow: (() => Promise<void>) | undefined;
  let resolveReady: (() => void) | undefined;
  let cancelOpening: ((error: Error) => void) | undefined;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  const stops: Array<() => void> = [];
  const requests = new Map<string, { signature: string; result: Promise<ScriptWorkbenchResponse> }>();
  let acceptedSequence = 0;
  const bases = new Map<number, { context: ProjectWindowContext | null; episodeId: string | null; canvasId: string | null;
    pending: string; draftVersion: number; rename: string; preview: number; graph: string; graphEpoch: string; graphCandidate: string; graphExtraction: string }>();
  const previews = new WeakMap<object, number>();
  let previewSequence = 0;
  const basis = (snapshot: ScriptWorkbenchSnapshot) => {
    const assets = snapshot.seriesAssetPreview?.assets;
    if (assets && !previews.has(assets)) previews.set(assets, ++previewSequence);
    return { context: options.getContext ? options.getContext() : snapshot.windowContext ?? null,
      episodeId: snapshot.currentEpisode?.id ?? null, canvasId: snapshot.canvasProjectId,
      pending: JSON.stringify(snapshot.pendingAction), draftVersion: snapshot.draftVersion,
      rename: JSON.stringify([snapshot.renamingEpisodeId, snapshot.episodes.find((episode) => episode.id === snapshot.renamingEpisodeId)?.name]),
      preview: assets ? previews.get(assets)! : 0,
      graph: JSON.stringify([snapshot.series?.id, snapshot.series?.exchangeEpoch ?? 0, snapshot.storyGraphView?.id, snapshot.storyGraphView?.revision]),
      graphEpoch: JSON.stringify([snapshot.series?.id, snapshot.series?.exchangeEpoch ?? 0]),
      graphCandidate: snapshot.storyGraphExtraction?.candidate?.id ?? '',
      graphExtraction: JSON.stringify([snapshot.storyGraphExtraction?.runId, snapshot.storyGraphExtraction?.status, snapshot.storyGraphExtraction?.candidate?.id]) };
  };

  const publish = async () => {
    if (disposed || !visible) return;
    const { emitTo } = await import('@tauri-apps/api/event');
    if (disposed || !visible) return;
    const snapshot = options.getSnapshot();
    const nextRevision = ++revision;
    const nextBasis = basis(snapshot);
    bases.set(nextRevision, nextBasis);
    if (bases.size > 40) bases.delete(bases.keys().next().value!);
    await emitTo(SCRIPT_WORKBENCH_WINDOW_LABEL, STATE_EVENT, { ...snapshot, schemaVersion: 2,
      windowContext: nextBasis.context, sessionId: options.sessionId, revision: nextRevision });
  };
  const listen = () => listening ??= (async () => {
    const { listen: subscribe, emitTo } = await import('@tauri-apps/api/event');
    const retain = (stop: () => void) => { if (disposed) stop(); else stops.push(stop); };
    retain(await subscribe<{ sessionId?: string }>(HELLO_EVENT, ({ payload }) => {
      if (!disposed && payload?.sessionId === options.sessionId) void publish().catch(() => {});
    }));
    retain(await subscribe<{ sessionId?: string }>(READY_EVENT, ({ payload }) => {
      if (disposed || !visible || payload?.sessionId !== options.sessionId) return;
      options.onDetachedChange(true);
      resolveReady?.();
    }));
    retain(await subscribe<{ sessionId?: string }>(EARLY_CLOSE_EVENT, ({ payload }) => {
      if (!disposed && payload?.sessionId === options.sessionId) void close().catch(() => {});
    }));
    retain(await subscribe<ScriptWorkbenchRequest>(REQUEST_EVENT, ({ payload }) => {
      void (async () => {
      if (disposed || !visible || payload?.sessionId !== options.sessionId || !payload.action
        || !ACTIONS.has(payload.action.type) || !/^[A-Za-z0-9_-]{8,160}$/.test(payload.requestId)
        || !Number.isSafeInteger(payload.revision) || payload.revision < 1 || payload.revision > revision) return;
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      // UTF-8 原文经 JSON 转义可能放大；原文交接留出有界开销，普通请求维持原上限。
      const maxPayloadBytes = payload.originalHandoff || payload.action.type === 'original_edit'
        ? 16 * 1024 * 1024 : 2 * 1024 * 1024;
      if (encoded.byteLength > maxPayloadBytes) {
        await emitTo(SCRIPT_WORKBENCH_WINDOW_LABEL, RESPONSE_EVENT, { sessionId: options.sessionId, requestId: payload.requestId,
          sequence: payload.sequence,
          error: '本次修改超过窗口传输上限，已保留本地草稿，请分段处理' } satisfies ScriptWorkbenchResponse);
        return;
      }
      // 只保留摘要用于请求身份比较，不让每次键入的完整稿件留在去重目录。
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      const signature = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      if (disposed || !visible) return;
      let accepted = requests.get(payload.requestId);
      if (accepted && accepted.signature !== signature) return;
      if (!accepted) {
        const result = Promise.resolve().then(() => {
          const previous = bases.get(payload.revision);
          const current = basis(options.getSnapshot());
          if (payload.schemaVersion !== 2 || !Number.isSafeInteger(payload.sequence) || payload.sequence! <= acceptedSequence
            || !previous || payload.episodeId !== previous.episodeId || current.episodeId !== previous.episodeId
            || current.canvasId !== previous.canvasId
            || !sameProjectWindowContext(payload.windowContext, previous.context)
            || (payload.handoff && !sameProjectWindowContext(payload.handoff.windowContext, previous.context))
            || !sameProjectWindowContext(previous.context, current.context)) {
            throw new Error('工作台窗口上下文已变化，请刷新核对；修改仍保留在本窗口，未自动重试');
          }
          acceptedSequence = payload.sequence!;
          const graphScoped = payload.action.type.startsWith('story_graph_')
            && !['story_graph_cancel', 'story_graph_discard'].includes(payload.action.type)
            && !(payload.action.type === 'story_graph_editor' && !payload.action.open);
          if ((['discard_pending', 'save_pending'].includes(payload.action.type) && (!previous || previous.pending !== current.pending || previous.draftVersion !== current.draftVersion))
            || (graphScoped && (!previous || previous.graphEpoch !== current.graphEpoch))
            || (payload.action.type === 'rename' && (!previous || previous.rename !== current.rename))
            || (payload.action.type === 'commit_asset_preview' && (!previous || previous.preview !== current.preview))
            || (['story_graph_patch', 'story_graph_extract', 'story_graph_adopt'].includes(payload.action.type)
              && (!previous || previous.graph !== current.graph))
            || (payload.action.type === 'story_graph_adopt' && (!previous || previous.graphCandidate !== current.graphCandidate))
            || (['story_graph_extract', 'story_graph_cancel', 'story_graph_discard'].includes(payload.action.type)
              && (!previous || previous.graphExtraction !== current.graphExtraction))) {
            throw new Error('工作台确认内容已变化，请核对最新内容后重试');
          }
          return options.onRequest(payload);
        }).then(
          (value): ScriptWorkbenchResponse => ({ sessionId: options.sessionId, requestId: payload.requestId, sequence: payload.sequence, value }),
          (error: unknown): ScriptWorkbenchResponse => ({ sessionId: options.sessionId, requestId: payload.requestId, sequence: payload.sequence,
            error: sanitizeDomainText(error instanceof Error ? error.message : '工作台操作未完成').slice(0, 300) }),
        );
        accepted = { signature, result };
        requests.set(payload.requestId, accepted);
      }
      void accepted.result.then(async (response) => {
        if (disposed) return;
        await publish().catch(() => {});
        await emitTo(SCRIPT_WORKBENCH_WINDOW_LABEL, RESPONSE_EVENT, response).catch(() => {});
        // 原文只在本次 RPC 中传输；付费/保存的去重记录只留完成标记，不缓存正文或候选。
        if (payload.action.type.startsWith('original_') && requests.get(payload.requestId) === accepted) {
          if (payload.action.type === 'original_open' || payload.action.type === 'original_edit') requests.delete(payload.requestId);
          else requests.set(payload.requestId, { signature, result: Promise.resolve({ sessionId: options.sessionId,
            requestId: payload.requestId, sequence: payload.sequence, ...(response.error ? { error: response.error } : { value: true }) }) });
        }
        // 读取可重读，编辑已由单调序号防重；付费和写入请求身份保留至本窗口会话结束。
        if (['flush_draft', 'read_source', 'team_artifact', 'preview_creation_profile', 'refresh_external_agents',
          'story_graph_detail', 'story_graph_resolve_evidence', 'story_graph_filter', 'story_graph_locate'].includes(payload.action.type)) requests.delete(payload.requestId);
        options.onReplySent?.();
      }).catch(() => {});
      })().catch(() => {});
    }));
  })().catch((error: unknown) => {
    listening = undefined;
    for (const stop of stops.splice(0)) stop();
    throw error;
  });
  const close = async () => {
    cancelOpening?.(new Error('独立窗口打开已取消，已保留内嵌工作台'));
    visible = false;
    options.onDetachedChange(false);
    await closeWindow?.();
    closeWindow = undefined;
  };
  return {
    publish,
    close,
    open: () => opening ??= (async () => {
      if (!isDesktop()) throw new Error('独立窗口仅在 Tauri 桌面端可用');
      await listen();
      if (disposed) throw new Error('工作台已关闭');
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const existing = await WebviewWindow.getByLabel(SCRIPT_WORKBENCH_WINDOW_LABEL);
      if (existing) {
        if (!visible) throw new Error('已有工作台窗口，请先关闭原窗口再打开');
        await existing.show(); await existing.unminimize(); await existing.setFocus();
        return;
      }
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const failure = new Promise<never>((_resolve, reject) => {
        cancelOpening = reject;
        openingTimer = setTimeout(() => reject(new Error('独立窗口未完成连接，已保留内嵌工作台')), 10000);
      });
      void failure.catch(() => {});
      const win = new WebviewWindow(SCRIPT_WORKBENCH_WINDOW_LABEL, {
        url: `index.html?view=script-workbench&session=${encodeURIComponent(options.sessionId)}`,
        title: '剧本创作工作台', width: 1280, height: 860, minWidth: 760, minHeight: 560,
        center: true, resizable: true, decorations: true, parent: 'main',
      });
      visible = true;
      closeWindow = async () => { await win.destroy(); };
      try {
        await Promise.race([new Promise<void>((resolve, reject) => {
          void win.once('tauri://created', () => resolve()).catch(reject);
          void win.once('tauri://error', () => reject(new Error('无法创建独立工作台窗口'))).catch(reject);
        }), failure]);
        const stop = await win.once('tauri://destroyed', () => {
          visible = false; closeWindow = undefined;
          if (!disposed) options.onDetachedChange(false);
        });
        if (disposed) stop(); else stops.push(stop);
        await publish();
        await Promise.race([ready, failure]);
        if (disposed || !visible) throw new Error('工作台窗口已关闭');
      } catch (error) {
        await close().catch(() => {});
        throw error;
      } finally { if (openingTimer) clearTimeout(openingTimer); openingTimer = undefined; resolveReady = undefined; cancelOpening = undefined; }
    })().finally(() => { opening = undefined; }),
    dispose: () => {
      disposed = true;
      cancelOpening?.(new Error('工作台已关闭'));
      if (openingTimer) clearTimeout(openingTimer);
      for (const stop of stops.splice(0)) stop();
      requests.clear();
      bases.clear();
      void closeWindow?.().catch(() => {});
      closeWindow = undefined;
    },
  };
}

/** 新窗先安装监听，再请求初帧；返回的请求器只能调用本工作台会话的白名单动作。 */
export async function connectScriptWorkbenchWindow(
  sessionId: string,
  onSnapshot: (snapshot: ScriptWorkbenchSnapshot) => void,
): Promise<{
  request: (request: Omit<ScriptWorkbenchRequest, 'sessionId' | 'requestId'>) => Promise<unknown>;
  handoff: (request: Omit<ScriptWorkbenchRequest, 'sessionId' | 'requestId'>) => void;
  dispose: () => void;
}> {
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  let disposed = false;
  let revision = 0;
  let connected = false;
  let sequence = 0;
  const contexts = new Map<number, ProjectWindowContext | null>();
  const buffered: { snapshot?: ScriptWorkbenchSnapshot } = {};
  const pending = new Map<string, { sequence: number; context: ProjectWindowContext | null; allowsContextChange: boolean;
    resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const stopState = await listen<ScriptWorkbenchSnapshot>(STATE_EVENT, ({ payload }) => {
    if (disposed || payload?.sessionId !== sessionId || (payload.schemaVersion !== undefined && payload.schemaVersion !== 2)
      || !Number.isSafeInteger(payload.revision) || payload.revision <= revision) return;
    revision = payload.revision;
    contexts.set(revision, payload.schemaVersion === 2 ? payload.windowContext ?? null : null);
    if (contexts.size > 40) contexts.delete(contexts.keys().next().value!);
    if (!connected) buffered.snapshot = payload;
    else { onSnapshot(payload); void emitTo('main', READY_EVENT, { sessionId }).catch(() => {}); }
  });
  let stopResponse: () => void;
  try {
    stopResponse = await listen<ScriptWorkbenchResponse>(RESPONSE_EVENT, ({ payload }) => {
      if (disposed || payload?.sessionId !== sessionId) return;
      const operation = pending.get(payload.requestId);
      if (!operation || payload.sequence !== operation.sequence) return;
      pending.delete(payload.requestId); clearTimeout(operation.timer);
      if (payload.error) operation.reject(new Error(payload.error));
      else if (!operation.allowsContextChange && !sameProjectWindowContext(operation.context, contexts.get(revision))) operation.reject(new Error('工作台目标已切换，请核对原操作回执；本地修改仍保留'));
      else operation.resolve(payload.value);
    });
  } catch (error) { stopState(); throw error; }
  connected = true;
  if (buffered.snapshot) {
    onSnapshot(buffered.snapshot);
    void emitTo('main', READY_EVENT, { sessionId }).catch(() => {});
    delete buffered.snapshot;
  }
  const hello = () => { void emitTo('main', HELLO_EVENT, { sessionId }).catch(() => {}); };
  const handshake = setInterval(() => { if (!revision) hello(); }, 500);
  hello();
  const envelope = (request: Omit<ScriptWorkbenchRequest, 'sessionId' | 'requestId'>): ScriptWorkbenchRequest => ({
    ...request, schemaVersion: 2, windowContext: contexts.get(request.revision) ?? null,
    sequence: ++sequence, sessionId, requestId: crypto.randomUUID(),
  });
  return {
    request: (request) => new Promise((resolve, reject) => {
      if (disposed || !revision) { reject(new Error('工作台尚未连接主窗口')); return; }
      const value = envelope(request);
      if (!value.windowContext) { reject(new Error('窗口协议需要刷新，修改仍保留在本窗口')); return; }
      const timer = setTimeout(() => { pending.delete(value.requestId); reject(new Error('主窗口未确认完成，请核对当前状态后再操作')); }, 200000);
      pending.set(value.requestId, { sequence: value.sequence!, context: value.windowContext,
        allowsContextChange: ['select_episode', 'story_graph_locate', 'save_pending', 'discard_pending', 'close', 'dock'].includes(value.action.type),
        resolve, reject, timer });
      void emitTo('main', REQUEST_EVENT, value).catch(() => {
        const operation = pending.get(value.requestId);
        if (!operation) return;
        pending.delete(value.requestId); clearTimeout(timer); reject(new Error('无法连接主窗口，修改仍保留在本窗口'));
      });
    }),
    handoff: (request) => { if (!disposed && revision) void emitTo('main', REQUEST_EVENT, envelope(request)).catch(() => {}); },
    dispose: () => {
      disposed = true; clearInterval(handshake); stopState(); stopResponse();
      for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('工作台窗口已关闭')); }
      pending.clear(); contexts.clear();
    },
  };
}
