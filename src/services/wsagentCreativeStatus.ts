import type { WsagentCreativeSyncState, WsagentScriptSyncState } from '../types/wsagentShared';

const listeners = new Set<() => void>();
let status: { owner: string; phase: WsagentCreativeSyncState } | undefined;
let scriptStatus: { owner: string; phase: WsagentScriptSyncState } | undefined;

export const getWsagentCreativeSyncState = (owner: string): WsagentCreativeSyncState =>
  status?.owner === owner ? status.phase : 'idle';

export const getWsagentScriptSyncState = (owner: string): WsagentScriptSyncState =>
  scriptStatus?.owner === owner ? scriptStatus.phase : 'idle';

export function subscribeWsagentCreativeSync(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function reportWsagentCreativeSync(owner: string, phase: WsagentCreativeSyncState) {
  if (status?.owner === owner && status.phase === phase) return;
  status = { owner, phase };
  for (const listener of listeners) listener();
}

export function reportWsagentScriptSync(owner: string, phase: WsagentScriptSyncState) {
  if (scriptStatus?.owner === owner && scriptStatus.phase === phase) return;
  scriptStatus = { owner, phase };
  for (const listener of listeners) listener();
}
