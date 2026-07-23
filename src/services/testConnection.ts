/**
 * testConnection 连接测试服务 — 只调用无生成副作用的目录、鉴权或账户端点。
 */
import { APIMART_BASE_URL, VOLCENGINE_BASE_URL } from '../constants/api';
import type { WebSearchProviderId } from '../types';
import { corsSafeFetch } from './ai/httpTransport';

export interface TestResult {
  success: boolean;
  /** 余额文本，如 "1100 积分" */
  balance?: string;
  /** 失败原因 */
  error?: string;
  /** 厂商没有已知的无计费验证端点，本次未发送网络请求。 */
  unsupported?: boolean;
}

function readErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.errorMessage === 'string') return record.errorMessage;
  if (typeof record.error === 'string') return record.error;
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>;
    if (typeof error.message === 'string') return error.message;
  }
  return undefined;
}

/** OpenAI 兼容厂商 — GET /models 只验证目录可达与凭据，不调用任何模型。 */
async function testModelCatalog(
  apiKey: string,
  baseUrl: string,
): Promise<TestResult> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`;
  const response = await corsSafeFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.ok) return { success: true };

  const payload: unknown = await response.json().catch(() => null);
  const message = readErrorMessage(payload);
  return { success: false, error: message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}` };
}

/** RunningHUB — 模型 API 密钥，有余额 */
async function testRunninghubModel(apiKey: string): Promise<TestResult> {
  const url = 'https://www.runninghub.cn/uc/openapi/accountStatus';
  const res = await corsSafeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: apiKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.code === 0 && data.data) {
    const coins = data.data.remainCoins;
    const tasks = data.data.currentTaskCounts;
    const parts: string[] = [];
    if (coins !== undefined && coins !== null) parts.push(`${coins} 积分`);
    if (tasks !== undefined && tasks !== null && tasks !== '0') parts.push(`${tasks} 任务运行中`);
    const balance = parts.join('，') || undefined;
    return { success: true, balance };
  }
  return { success: false, error: data.msg || data.errorMessage || `code=${data.code}` };
}

/** GRSAI 当前仅有本地模型 manifest，不自动发送可能计费的真实生成请求。 */
async function testGRSAI(): Promise<TestResult> {
  return {
    success: false,
    unsupported: true,
    error: 'GRSAI 未提供已确认无计费的目录或鉴权端点，本次未发送网络请求',
  };
}

async function testWebSearch(
  provider: WebSearchProviderId,
  apiKey: string,
): Promise<TestResult> {
  if (typeof window === 'undefined' || !('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) {
    return { success: false, error: '联网搜索连接测试仅在 Tauri 桌面环境可用' };
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('assistant_web_search', {
    request: {
      provider,
      apiKey,
      query: 'AI Canvas connection test',
      maxResults: 1,
      topic: 'general',
    },
  });
  return { success: true };
}

export type ProviderTestKey =
  | 'apimart'
  | 'volcengine'
  | 'runninghub-model'
  | 'grsai'
  | WebSearchProviderId;

const testFns: Record<ProviderTestKey, (apiKey: string, baseUrl?: string) => Promise<TestResult>> = {
  apimart: (apiKey, baseUrl) => testModelCatalog(apiKey, baseUrl || APIMART_BASE_URL),
  volcengine: (apiKey, baseUrl) => testModelCatalog(apiKey, baseUrl || VOLCENGINE_BASE_URL),
  'runninghub-model': testRunninghubModel,
  grsai: testGRSAI,
  tavily: (apiKey) => testWebSearch('tavily', apiKey),
  bocha: (apiKey) => testWebSearch('bocha', apiKey),
  'zhipu-search': (apiKey) => testWebSearch('zhipu-search', apiKey),
  exa: (apiKey) => testWebSearch('exa', apiKey),
};

export async function testProviderConnection(
  provider: ProviderTestKey,
  apiKey: string,
  baseUrl?: string,
): Promise<TestResult> {
  const fn = testFns[provider];
  if (!fn) return { success: false, error: `未知厂商: ${provider}` };
  if (!apiKey) return { success: false, error: '请先填写 API 密钥' };
  try {
    return await fn(apiKey, baseUrl);
  } catch (e) {
    return { success: false, error: `网络错误: ${e instanceof Error ? e.message : String(e)}` };
  }
}
