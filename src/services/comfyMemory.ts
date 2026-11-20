/**
 * ComfyUI resource inspection and release operations.
 *
 * `/system_stats` reports device memory. `/free` is a server-global operation,
 * so automatic release is deliberately restricted to loopback services.
 */
import type { ComfyMemoryPolicy } from '../types';
import { comfyFetch } from './comfyPolling';
import { assertComfyResponse, withComfyQueryTimeout } from './comfyQuery';

export type ComfyMemoryReleaseMode = Exclude<ComfyMemoryPolicy, 'smart'>;

export interface ComfyMemoryDeviceStats {
  name: string;
  type: string;
  index?: number;
  vramTotal: number;
  vramFree: number;
  torchVramTotal?: number;
  torchVramFree?: number;
}

export interface ComfyMemoryStats {
  devices: ComfyMemoryDeviceStats[];
}

export type ComfyAutoReleaseResult =
  | 'disabled'
  | 'skipped-remote'
  | 'skipped-busy'
  | 'released';

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseDevice(value: unknown): ComfyMemoryDeviceStats | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const vramTotal = finiteNumber(raw.vram_total);
  const vramFree = finiteNumber(raw.vram_free);
  if (vramTotal === undefined || vramFree === undefined) return null;
  const index = finiteNumber(raw.index);
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'GPU',
    type: typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : 'unknown',
    ...(index !== undefined ? { index } : {}),
    vramTotal,
    vramFree,
    ...(finiteNumber(raw.torch_vram_total) !== undefined
      ? { torchVramTotal: finiteNumber(raw.torch_vram_total) }
      : {}),
    ...(finiteNumber(raw.torch_vram_free) !== undefined
      ? { torchVramFree: finiteNumber(raw.torch_vram_free) }
      : {}),
  };
}

export function isLoopbackComfyUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (hostname === '127.0.0.1'
        || hostname === 'localhost'
        || hostname === '::1'
        || hostname === '[::1]');
  } catch {
    return false;
  }
}

export async function fetchComfyMemoryStats(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ComfyMemoryStats> {
  const payload = await withComfyQueryTimeout(async (querySignal) => {
    const response = await comfyFetch(`${trimBaseUrl(baseUrl)}/system_stats`, { signal: querySignal });
    await assertComfyResponse(response, '读取 ComfyUI 显存状态');
    return await response.json() as Record<string, unknown>;
  }, signal);
  const system = payload.system && typeof payload.system === 'object' && !Array.isArray(payload.system)
    ? payload.system as Record<string, unknown>
    : undefined;
  const rawDevices = Array.isArray(payload.devices)
    ? payload.devices
    : Array.isArray(system?.devices) ? system.devices : [];
  const devices = rawDevices.map(parseDevice).filter((device): device is ComfyMemoryDeviceStats => !!device);
  if (devices.length === 0) throw new Error('ComfyUI 未返回可识别的 GPU 显存信息');
  return { devices };
}

export async function releaseComfyMemory(
  baseUrl: string,
  mode: ComfyMemoryReleaseMode,
  signal?: AbortSignal,
): Promise<void> {
  const response = await comfyFetch(`${trimBaseUrl(baseUrl)}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      unload_models: true,
      free_memory: mode === 'free-memory',
    }),
    signal,
  });
  await assertComfyResponse(response, '释放 ComfyUI 资源');
}

function isEmptyQueue(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/**
 * Apply an opt-in policy after a terminal task. Remote/shared servers are never
 * changed automatically, and a busy local queue is left untouched.
 */
export async function maybeAutoReleaseComfyMemory(
  baseUrl: string,
  policy: ComfyMemoryPolicy | undefined,
  signal?: AbortSignal,
): Promise<ComfyAutoReleaseResult> {
  if (!policy || policy === 'smart') return 'disabled';
  if (!isLoopbackComfyUrl(baseUrl)) return 'skipped-remote';

  const queue = await withComfyQueryTimeout(async (querySignal) => {
    const response = await comfyFetch(`${trimBaseUrl(baseUrl)}/queue`, { signal: querySignal });
    await assertComfyResponse(response, '读取 ComfyUI 队列');
    return await response.json() as Record<string, unknown>;
  }, signal);
  if (!isEmptyQueue(queue?.queue_running) || !isEmptyQueue(queue?.queue_pending)) {
    return 'skipped-busy';
  }

  await releaseComfyMemory(baseUrl, policy, signal);
  return 'released';
}
