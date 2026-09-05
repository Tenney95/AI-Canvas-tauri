/**
 * testConnection 连接测试服务 — 只调用无生成副作用的目录、鉴权或账户端点。
 */
import { APIMART_BASE_URL, VOLCENGINE_BASE_URL } from '../constants/api';
import type { ChatApiProtocol, WebSearchProviderId } from '../types';
import { corsSafeFetch } from './ai/httpTransport';
import { getProviderDefinition } from './ai/providerCatalogService';
import { baseUrlCandidates } from './ai/providerBaseUrl';
import { getChatApiHeaders, resolveChatApiProtocol } from './ai/chatApiProtocol';
import { invoke } from '@tauri-apps/api/core';

export interface TestResult {
  success: boolean;
  /** 余额文本，如 "1100 积分" */
  balance?: string;
  /** 失败原因 */
  error?: string;
  /** 厂商没有已知的无计费验证端点，本次未发送网络请求。 */
  unsupported?: boolean;
  /** 实际验证通过的接口地址；与用户填的不同（如补了 /v1）时调用方应回写。 */
  baseUrl?: string;
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

/**
 * OpenAI 兼容厂商 — GET /models 只验证目录可达与凭据，不调用任何模型。
 * 地址按 baseUrlCandidates 依次探测，用户漏填 /v1 时自动补上并回报真实地址。
 */
async function testModelCatalog(
  apiKey: string,
  baseUrl: string,
  protocolValue?: ChatApiProtocol,
): Promise<TestResult> {
  const protocol = resolveChatApiProtocol(protocolValue);
  const candidates = baseUrlCandidates(baseUrl, protocol);
  if (candidates.length === 0) return { success: false, error: '请先填写接口地址' };

  let failure: TestResult = { success: false, error: '接口地址不可达' };
  for (const candidate of candidates) {
    const response = await corsSafeFetch(`${candidate}/models`, {
      method: 'GET',
      headers: getChatApiHeaders(protocol, apiKey, false),
    });
    if (response.ok) return { success: true, baseUrl: candidate };

    const payload: unknown = await response.json().catch(() => null);
    const message = readErrorMessage(payload);
    failure = {
      success: false,
      error: message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`,
    };
    // 凭据本身不对时换地址也没用，直接把错误交回去
    if (response.status === 401 || response.status === 403) return failure;
  }
  return failure;
}

async function testReadOnlyEndpoint(
  apiKey: string,
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string>> = {},
): Promise<TestResult> {
  const candidate = baseUrlCandidates(baseUrl)[0];
  if (!candidate) return { success: false, error: '请先填写接口地址' };
  const url = new URL(path, `${candidate}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await corsSafeFetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = readErrorMessage(payload);
    return {
      success: false,
      error: message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`,
    };
  }
  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {};
  const balanceValue = record.balance;
  const currency = typeof record.currency === 'string' ? record.currency.trim() : '';
  const balance = (typeof balanceValue === 'number' || typeof balanceValue === 'string')
    ? `${balanceValue}${currency ? ` ${currency}` : ''}`
    : undefined;
  return { success: true, balance, baseUrl: candidate };
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

/**
 * `provider` 传厂商目录定义 ID。未在 testFns 里登记特例的 api-key 厂商
 * （xai / google / 自定义中转站等）统一按 OpenAI 目录端点验证，
 * 新增内置厂商不必再回来登记一行。
 */
export async function testProviderConnection(
  provider: ProviderTestKey | string,
  apiKey: string,
  baseUrl?: string,
  chatApiProtocol?: ChatApiProtocol,
): Promise<TestResult> {
  if (!apiKey) return { success: false, error: '请先填写 API 密钥' };
  const fn = testFns[provider as ProviderTestKey];
  try {
    if (fn) return await fn(apiKey, baseUrl);
    const definition = getProviderDefinition(provider);
    if (definition?.authType === 'oauth') {
      return { success: false, unsupported: true, error: `${definition.name} 使用 OAuth 登录，无需验证密钥` };
    }
    const target = baseUrl?.trim() || definition?.defaultBaseUrl;
    if (!target) return { success: false, error: `未知厂商: ${provider}` };
    if (definition?.connectionTestPath) {
      return await testReadOnlyEndpoint(
        apiKey,
        target,
        definition.connectionTestPath,
        definition.requestQuery,
      );
    }
    return await testModelCatalog(apiKey, target, chatApiProtocol);
  } catch (e) {
    return { success: false, error: `网络错误: ${e instanceof Error ? e.message : String(e)}` };
  }
}
