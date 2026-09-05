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
