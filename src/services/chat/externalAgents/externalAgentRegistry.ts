import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from '../../fs/core';
import { CODEX_EXTERNAL_PROVIDER_ID, type ExternalAgentCapabilities, type ExternalAgentDescriptor, type ExternalAgentStatus } from '../../../types/externalAgent';

export const CODEX_EXTERNAL_CAPABILITIES: ExternalAgentCapabilities = Object.freeze({
  oneShot: true, cancel: true, progress: true, text: true, structuredResult: true,
  resume: false, fork: false, inheritsParentContext: false, hostTools: false,
});

export function unavailableExternalAgentStatus(errorCode = 'CODEX_DESKTOP_REQUIRED'): ExternalAgentStatus {
  return { providerId: CODEX_EXTERNAL_PROVIDER_ID, registered: false, enabled: false,
    configured: false, compatible: false, available: false, version: null,
    executionFingerprint: null, activeRuns: 0, capabilities: CODEX_EXTERNAL_CAPABILITIES,
    models: [], errorCode };
}

let publicCatalog: ExternalAgentDescriptor[] = [];

function rememberStatus(status: ExternalAgentStatus): ExternalAgentStatus {
  publicCatalog = [{ id: CODEX_EXTERNAL_PROVIDER_ID, name: 'Codex App Server', available: status.available,
    executionFingerprint: status.executionFingerprint, models: status.models.map(({ id, name }) => ({ id, name })),
    capabilities: { ...CODEX_EXTERNAL_CAPABILITIES }, ...(status.errorCode ? { errorCode: status.errorCode } : {}) }];
  return status;
}

/** 仅主窗口快照装配使用；返回副本，绝不携带凭据、安装路径或运行句柄。 */
export function readExternalAgentCatalog(): ExternalAgentDescriptor[] {
  return structuredClone(publicCatalog);
}

/** 只有主窗口调用原生命令。独立窗口使用主窗口快照中的脱敏目录。 */
export async function getExternalAgentStatus(): Promise<ExternalAgentStatus> {
  if (!isTauriEnv()) return rememberStatus(unavailableExternalAgentStatus());
  try { return rememberStatus(await invoke<ExternalAgentStatus>('codex_runtime_status')); }
  catch (error) { rememberStatus(unavailableExternalAgentStatus('CODEX_STATE_UNAVAILABLE')); throw error; }
}

export async function getExternalAgentCatalog(): Promise<ExternalAgentDescriptor[]> {
  await getExternalAgentStatus();
  return readExternalAgentCatalog();
}

export async function registerCodexRuntime(): Promise<ExternalAgentStatus> {
  return invoke<ExternalAgentStatus>('codex_runtime_register').then(rememberStatus);
}

export async function configureCodexRuntime(enabled: boolean): Promise<ExternalAgentStatus> {
  return invoke<ExternalAgentStatus>('codex_runtime_configure', { enabled }).then(rememberStatus);
}

export async function removeCodexRuntime(): Promise<ExternalAgentStatus> {
  return invoke<ExternalAgentStatus>('codex_runtime_remove').then(rememberStatus);
}
