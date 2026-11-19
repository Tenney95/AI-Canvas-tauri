import { invoke } from '@tauri-apps/api/core';
import type { WsagentScript, WsagentScriptMetadata, WsagentScriptSyncState } from '../types/wsagentShared';
import { sha256BytesHex } from './mediaDataUrl';
import { readWsagentScriptSlots, type WsagentScriptSlot } from './wsagentScriptSlots';

const encoder = new TextEncoder();
const digest = (content: string) => sha256BytesHex(encoder.encode(content));
const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface WsagentScriptSyncScope {
  owner: string;
  project: string;
  peer: string;
  assertCurrent: () => void;
}

interface ScriptLink {
  remoteId: string;
  localDigest?: string;
  remoteDigest?: string;
}

function scriptLinks(scope: WsagentScriptSyncScope) {
  const key = `wsagent-script-links-v1:${JSON.stringify([scope.owner, scope.peer])}`;
  const stored = localStorage.getItem(key);
  const links = new Map<string, ScriptLink>(stored ? JSON.parse(stored) as Array<[string, ScriptLink]> : []);
  return {
    links,
    save(id: string, link: ScriptLink) {
      const previous = links.get(id);
      if (previous?.remoteId === link.remoteId && previous.localDigest === link.localDigest
        && previous.remoteDigest === link.remoteDigest) return;
      links.set(id, link);
      localStorage.setItem(key, JSON.stringify([...links]));
    },
  };
}

const slotKey = (slot: WsagentScriptSlot) => JSON.stringify([slot.kind, slot.id]);
const nativeDocumentId = async (owner: string, slot: WsagentScriptSlot) =>
  `screenplay_canvas_${await digest(JSON.stringify([owner, slot.kind, slot.id]))}`;

function direction(local: string, remote: string, link?: ScriptLink): 'push' | 'pull' | 'keep' | 'conflict' {
  if (local === remote) return 'keep';
  if (link?.localDigest === undefined || link.remoteDigest === undefined) {
    if (local === EMPTY_DIGEST) return 'pull';
    if (remote === EMPTY_DIGEST) return 'push';
    return 'conflict';
  }
  const localChanged = local !== link.localDigest;
  const remoteChanged = remote !== link.remoteDigest;
  if (localChanged && remoteChanged) return 'conflict';
  return localChanged ? 'push' : remoteChanged ? 'pull' : 'keep';
}

async function syncScriptSlot(scope: WsagentScriptSyncScope, slot: WsagentScriptSlot, id: string,
  localDigest: string, remote: WsagentScriptMetadata | undefined, link: ScriptLink | undefined,
  save: (link: ScriptLink) => void,
): Promise<WsagentScriptSyncState> {
  const remoteDigest = remote?.contentDigest ?? EMPTY_DIGEST;
  if (!remote && (link?.remoteDigest !== undefined || id.startsWith('screenplay_canvas_') === false)) {
    return 'conflict';
  }
  if (!remote && !slot.content.trim()) return 'ready';
  const action = direction(localDigest, remoteDigest, link);
  if (action === 'conflict') return 'conflict';
  if (action === 'push') {
    scope.assertCurrent();
    slot.assertCurrent();
    const { script } = await invoke<{ script: WsagentScriptMetadata }>('wsagent_shared_scripts_apply', { ownerId: scope.owner,
      script: { id, title: slot.title, content: slot.content, expectedRevision: remote?.revision ?? null },
    });
    scope.assertCurrent();
    // 记录本次发送的已保存版本。稍后保存的新稿会在下一轮作为独立修改同步。
    save({ remoteId: id, localDigest, remoteDigest: script.contentDigest });
    return 'ready';
  }
  if (action === 'pull' && remote) {
    scope.assertCurrent();
    const { script } = await invoke<{ script: WsagentScript }>('wsagent_shared_scripts_read', {
      ownerId: scope.owner, id, expectedRevision: remote.revision,
    });
    scope.assertCurrent();
    if (script.contentDigest !== await digest(script.content) || script.contentDigest !== remoteDigest) {
      throw new Error('WSAGENT 返回的剧本版本与目录不一致');
    }
    scope.assertCurrent();
    const applied = await slot.apply(script.content, scope.assertCurrent);
    scope.assertCurrent();
    if (applied === 'deferred') return 'deferred';
    save({ remoteId: id, localDigest: script.contentDigest, remoteDigest: script.contentDigest });
    return 'ready';
  }
  if (remote) save({ remoteId: id, localDigest, remoteDigest });
  return 'ready';
}

/** 只读对端目录及摘要；正文只在实际有变化的单份剧本上取用。 */
export async function syncWsagentScripts(scope: WsagentScriptSyncScope): Promise<WsagentScriptSyncState> {
  const [{ scripts }, slots] = await Promise.all([
    invoke<{ scripts: WsagentScriptMetadata[] }>('wsagent_shared_scripts_list', { ownerId: scope.owner }),
    readWsagentScriptSlots(scope.owner, scope.project, scope.assertCurrent),
  ]);
  scope.assertCurrent();
  if (!slots.length) return 'idle';
  const storage = scriptLinks(scope);
  const remote = new Map(scripts.map((script) => [script.id, script]));
  const linked = new Set([...storage.links.values()].map((link) => link.remoteId));
  const existing = scripts.filter((script) => !linked.has(script.id) && !script.id.startsWith('screenplay_canvas_'));
  const phases = new Set<WsagentScriptSyncState>();

  for (const slot of slots) {
    const key = slotKey(slot);
    const localDigest = await digest(slot.content);
    const defaultId = await nativeDocumentId(scope.owner, slot);
    const save = (link: ScriptLink) => { scope.assertCurrent(); storage.save(key, link); };
    let link = storage.links.get(key);
    if (!link && slot.kind === 'project' && !remote.has(defaultId)) {
      const sameText = existing.filter((item) => item.contentDigest === localDigest && localDigest !== EMPTY_DIGEST);
      const match = sameText.length === 1 ? sameText[0] : existing.length === 1 ? existing[0] : undefined;
      if (match) {
        link = { remoteId: match.id };
        save(link);
        linked.add(match.id);
      }
    }
    const id = link?.remoteId ?? defaultId;
    try {
      phases.add(await syncScriptSlot(scope, slot, id, localDigest, remote.get(id), link, save));
    } catch (cause: unknown) {
      scope.assertCurrent();
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
      if (code === 'pairing') throw cause;
      phases.add(code === 'conflict' ? 'conflict' : 'offline');
    }
  }
  if (existing.some((item) => !linked.has(item.id))) phases.add('ambiguous');
  return (['conflict', 'offline', 'ambiguous', 'deferred'] as const).find((phase) => phases.has(phase)) ?? 'ready';
}
