/**
 * comfyServers — ComfyUI 服务端地址解析。
 *
 * 图片与视频分开部署时，工作流各自绑定一台服务端（WorkflowDefinition.serverId），
 * 没绑定、或绑定的服务端已被删掉时一律回落到默认地址 config.comfyUIUrl。
 */
import { useAppStore } from '../store/useAppStore';
import { comfyFetch } from './comfyPolling';

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';
export type ComfyServerAvailability = 'checking' | 'available' | 'unavailable';

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

function normalize(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '');
}

export interface ComfyServerSelection {
  serverId?: string;
  serverName: string;
}

function isComfyApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 供助手选择的已配置目标；不向工具结果暴露地址或凭据。 */
export function listConfiguredComfyServers(): Array<ComfyServerSelection & { isDefault: boolean }> {
  const { config } = useAppStore.getState();
  const servers: Array<ComfyServerSelection & { isDefault: boolean }> = [];
  if (isComfyApiUrl(normalize(config.comfyUIUrl))) {
    servers.push({ serverName: '默认服务器', isDefault: true });
  }
  for (const server of config.comfyServers ?? []) {
    if (server.id && isComfyApiUrl(normalize(server.url))) {
      servers.push({ serverId: server.id, serverName: server.name.trim() || server.id, isDefault: false });
    }
  }
  return servers;
}

/** 显式服务器选择必须存在且地址有效；与普通工作流的兼容回落策略区分。 */
export function resolveComfyServerSelection(serverId?: string): ComfyServerSelection & { baseUrl: string } {
  const { config } = useAppStore.getState();
  const server = serverId === undefined ? undefined : config.comfyServers?.find((item) => item.id === serverId);
  if (serverId !== undefined && !server) {
    throw new Error('指定的 ComfyUI 服务器不存在，请重新读取服务器清单');
  }
  const baseUrl = normalize(server ? server.url : config.comfyUIUrl);
  if (!isComfyApiUrl(baseUrl)) {
    throw new Error(server
      ? '指定的 ComfyUI 服务地址无效，请在设置中检查'
      : '未配置有效的默认 ComfyUI 服务地址，请在设置中配置，或通过 serverId 选择已配置的服务器');
  }
  return { serverId, serverName: server ? server.name.trim() || server.id : '默认服务器', baseUrl };
}

/**
 * 检查指定地址是否确实暴露了 ComfyUI API。
 * 复用生成链的 comfyFetch，确保 Tauri、浏览器开发代理和远程服务的行为一致。
 */
export async function probeComfyServer(
  url: string | undefined,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
  const baseUrl = normalize(url);
  if (!baseUrl) return false;

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  } catch {
    return false;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = globalThis.setTimeout(abort, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

  try {
    const response = await comfyFetch(`${baseUrl}/system_stats`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return typeof payload === 'object' && payload !== null;
  } catch {
    return false;
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** 工作流实际要提交到的服务端地址；都没配时返回空串，由调用方决定报错还是回落。 */
export function comfyBaseUrlFor(workflowId?: string): string {
  const { config, workflows } = useAppStore.getState();
  const serverId = workflowId
    ? workflows.find((workflow) => workflow.id === workflowId)?.serverId
    : undefined;
  const bound = serverId
    ? config.comfyServers?.find((server) => server.id === serverId)?.url
    : undefined;
  return normalize(bound) || normalize(config.comfyUIUrl);
}

/** 服务端在设置里的显示名；找不到（已删除）时返回 undefined，界面按「默认」处理。 */
export function comfyServerName(serverId: string | undefined): string | undefined {
  if (!serverId) return undefined;
  return useAppStore.getState().config.comfyServers?.find((server) => server.id === serverId)?.name;
}
