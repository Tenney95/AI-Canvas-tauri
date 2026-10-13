import { invoke } from '@tauri-apps/api/core';
import { mkdir } from '@tauri-apps/plugin-fs';
import { getBaseDir, isTauriEnv, joinPath } from '../fs/core';
import { useAppStore } from '../../store/useAppStore';
import type { AppConfig } from '../../types';
import type { PriceQuote } from './volcenginePricing';

export type BillingStatus = 'submitting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface BillingRun {
  id: string;
  appProjectId: string;
  appProjectName: string;
  connectionId: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  modelType: 'image' | 'video';
  modelId: string;
  status: BillingStatus;
  submittedAt: number;
  finishedAt: number | null;
  taskId: string | null;
  requestId: string | null;
  prompt: string;
  inputJson: string;
  priceJson: string;
  estimatedMicros: number | null;
  calculatedMicros: number | null;
  amountConfidence: 'estimated' | 'calculated' | 'usage' | 'unknown';
  errorMessage: string | null;
}

export interface BillingFilter {
  appProjectId?: string;
  modelType?: 'image' | 'video';
  modelId?: string;
  status?: BillingStatus;
  from?: number;
  to?: number;
}

export interface BillingPage { items: BillingRun[]; total: number; estimatedMicros: number; calculatedMicros: number }

export const BILLING_STORAGE_CHANGED_EVENT = 'billing-storage-changed';
let synchronizedDirectory: string | null = null;

export async function setBillingStoragePath(path: string): Promise<string> {
  if (!isTauriEnv() || !path.trim()) return '';
  try {
    const directory = path.trim();
    const result = await invoke<string>('billing_set_storage_path', { path: directory });
    synchronizedDirectory = directory;
    window.dispatchEvent(new Event(BILLING_STORAGE_CHANGED_EVENT));
    return result;
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : '账本目录切换失败，原账本已保留', { cause: error });
  }
}

/** 配置与目录授权完成后同步；未单独设置账本目录时，跟随文件保存根目录。 */
export async function syncBillingStoragePath(config: Pick<AppConfig, 'volcengineBillingPath'>): Promise<void> {
  if (!isTauriEnv()) return;
  const customDirectory = config.volcengineBillingPath?.trim();
  const root = customDirectory ? null : await getBaseDir();
  const directory = customDirectory || (root ? joinPath(root, 'billing') : null);
  if (!directory) throw new Error('无法确定账本的文件保存根目录');
  if (synchronizedDirectory === directory) return;
  if (!customDirectory) await mkdir(directory, { recursive: true });
  await setBillingStoragePath(directory);
}

export const getBillingStoragePath = () =>
  invoke<string>('billing_get_storage_path');

export async function createBillingRun(input: {
  nodeId?: string;
  modelType: 'image' | 'video';
  modelId: string;
  prompt: string;
  details: Record<string, unknown>;
  quote: PriceQuote;
}): Promise<BillingRun | null> {
  if (!isTauriEnv() || !input.nodeId) return null;
  const nodeId = input.nodeId;
  const state = useAppStore.getState();
  const project = state.projects.find((item) => item.id === state.currentProjectId);
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!project || !node) return null;
  const run: BillingRun = {
    id: crypto.randomUUID(), appProjectId: project.id, appProjectName: project.name,
    connectionId: 'volcengine',
    nodeId, nodeType: node.type || input.modelType, nodeLabel: String(node.data.label || ''),
    modelType: input.modelType, modelId: input.modelId, status: 'submitting',
    submittedAt: Date.now(), finishedAt: null, taskId: null, requestId: null,
    prompt: input.prompt, inputJson: JSON.stringify(input.details), priceJson: JSON.stringify(input.quote),
    estimatedMicros: input.quote.amountMicros, calculatedMicros: null,
    amountConfidence: 'estimated', errorMessage: null,
  };
  await invoke('billing_upsert', { run });
  return run;
}

export async function updateBillingRun(run: BillingRun | null, patch: Partial<BillingRun>): Promise<BillingRun | null> {
  if (!run) return null;
  const next = { ...run, ...patch, errorMessage: patch.errorMessage ? sanitizeBillingError(patch.errorMessage) : patch.errorMessage === null ? null : run.errorMessage };
  try { await invoke('billing_upsert', { run: next }); }
  catch { useAppStore.getState().showToast('火山方舟调用已执行，但费用记录更新失败', 'error'); }
  return next;
}

export function sanitizeBillingError(message: string): string {
  const status = message.match(/\bHTTP\s*(\d{3})\b/i)?.[1];
  if (status) return `HTTP ${status}`;
  if (/取消|abort/i.test(message)) return '请求或任务已取消';
  if (/超时|timeout/i.test(message)) return '请求或轮询超时';
  if (/任务失败|failed/i.test(message)) return '方舟任务失败';
  return '请求或结果处理失败（详细错误未保存）';
}

export const queryBillingRuns = (filter: BillingFilter, page = 1, pageSize = 30) =>
  invoke<BillingPage>('billing_query', { filter, page, pageSize });
export const findBillingRunByTask = (taskId: string, appProjectId: string) =>
  invoke<BillingRun | null>('billing_get_by_task', { taskId, appProjectId });
export const previewBillingClear = (filter: BillingFilter) =>
  invoke<BillingPage>('billing_clear_preview', { filter });
export const clearBillingRuns = (filter: BillingFilter, expectedCount: number) =>
  invoke<number>('billing_clear', { filter, expectedCount });
export const exportBillingRuns = (filter: BillingFilter, includePrompts: boolean) =>
  invoke<number[]>('billing_export', { filter, includePrompts });
