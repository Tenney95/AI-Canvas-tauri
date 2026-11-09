/**
 * testConnection 连接测试服务 — 只调用无生成副作用的目录、鉴权或账户端点。
 */
import { APIMART_BASE_URL, VOLCENGINE_BASE_URL } from '../constants/api';
import type { ChatApiProtocol, WebSearchProviderId } from '../types';
import { corsSafeFetch } from './ai/httpTransport';
import { getProviderDefinition } from './ai/providerCatalogService';
import { baseUrlCandidates, normalizeBaseUrl } from './ai/providerBaseUrl';
import { getChatApiHeaders, resolveChatApiProtocol } from './ai/chatApiProtocol';
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './fs/core';
import { pollTask, PollTimeoutError } from './pollTask';
import { assertMinimaxResponse, resolveMinimaxBaseUrl } from './ai/providers/minimaxModelManifest';

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

/** 仅供设置面板展示，不进入连接配置、用量账本或导出。 */
export interface ProviderBalance {
  amount: string;
  unit: 'GP' | '积分' | '算力' | 'USD' | '';
  scope: 'account' | 'key';
}

function balanceAmount(value: unknown): string | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) return undefined;
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(amount) : undefined;
}

function readBalance(value: unknown, unit: ProviderBalance['unit'], scope: ProviderBalance['scope']): ProviderBalance | undefined {
  const amount = balanceAmount(value);
  return amount === undefined ? undefined : { amount, unit, scope };
}

interface BalanceEndpoint {
  path: string;
  bodyKey?: 'apiKey' | 'apikey';
  /** 根接口只移除已知 API 后缀，保留用户代理地址中的路径前缀。 */
  root?: boolean;
  read: (payload: Record<string, unknown>) => ProviderBalance | undefined;
}

function readUserCredits(payload: Record<string, unknown>): ProviderBalance | undefined {
  if (payload.success !== true) return undefined;
  return payload.unlimited_quota === true ? { amount: '∞', unit: '', scope: 'account' }
    : readBalance(payload.remain_credits, '积分', 'account');
}

// 新厂商先核实文档的鉴权、字段、单位和账户/Key 口径，再登记；不探测相似站点的路径。
const BALANCE_ENDPOINTS: Readonly<Record<string, BalanceEndpoint>> = {
  sora2u: { path: '/api/v1/credits', root: true,
    read: (payload) => payload.success === true && payload.currency === 'GP' ? readBalance(payload.balance, 'GP', 'account') : undefined },
  apimart: { path: '/user/balance', read: readUserCredits },
  toapis: { path: '/user/balance', read: readUserCredits },
  libapi: { path: '/skills/balance', read: (payload) => {
    const credits = payload.credits as Record<string, unknown> | undefined;
    const available = credits?.unit === 'CREDIT' ? readBalance(credits.available, '算力', 'account') : undefined;
    if (available) return available;
    // 美元字段带 $，不能把原始美元数字标为站内算力，也不能用总额冒充可用余额。
    return typeof payload.available_balance === 'string' && /^\$-?\d+(?:\.\d+)?$/.test(payload.available_balance)
      ? readBalance(payload.available_balance.slice(1), 'USD', 'account') : undefined;
  } },
  'aigc-si': { path: '/user/balance', read: (payload) => payload.object === 'user.balance'
    ? readBalance(payload.balance, '积分', 'account') : undefined },
  grsai: { path: '/client/openapi/getAPIKeyCredits', root: true, bodyKey: 'apiKey', read: (payload) => payload.code === 0
    ? readBalance((payload.data as Record<string, unknown> | undefined)?.credits, '积分', 'key') : undefined },
  'runninghub-model': { path: '/uc/openapi/accountStatus', root: true, bodyKey: 'apikey', read: (payload) => payload.code === 0
    ? readBalance((payload.data as Record<string, unknown> | undefined)?.remainCoins, '积分', 'account') : undefined },
};
// 工作流和模型密钥分别查询，保持当前站点和凭据身份，不互相回退或相加。
const RUNNINGHUB_BALANCE_ENDPOINT = BALANCE_ENDPOINTS['runninghub-model'];

function balanceEndpoint(provider: string): BalanceEndpoint | undefined {
  return provider === 'runninghub' ? RUNNINGHUB_BALANCE_ENDPOINT
    : Object.hasOwn(BALANCE_ENDPOINTS, provider) ? BALANCE_ENDPOINTS[provider] : undefined;
}

export function supportsProviderBalance(provider: string): boolean {
  return !!balanceEndpoint(provider);
}

/** 独立无计费查询；失败不影响连接状态，不调用模型、不获取网页账户令牌。 */
export async function queryProviderBalance(
  provider: string, apiKey: string, baseUrl?: string, signal?: AbortSignal,
): Promise<ProviderBalance | undefined> {
  const endpoint = balanceEndpoint(provider);
  if (!endpoint || !apiKey.trim() || signal?.aborted) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 12_000);
  try {
    const definition = getProviderDefinition(provider === 'runninghub' ? 'runninghub-model' : provider);
    const base = normalizeBaseUrl(baseUrl || definition?.defaultBaseUrl);
    if (!base) return undefined;
    const root = base.replace(/\/(?:v1|openapi\/v2)$/i, '');
    const apiBase = /\/v\d[^/]*$/i.test(base) ? base : `${base}/v1`;
    const url = new URL(`${endpoint.root ? root : apiBase}${endpoint.path}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    if (provider === 'sora2u') {
      for (const [name, value] of Object.entries(definition?.requestQuery ?? {})) url.searchParams.set(name, value);
    }
    const response = await corsSafeFetch(url.toString(), {
      method: endpoint.bodyKey ? 'POST' : 'GET',
      headers: endpoint.bodyKey ? { 'Content-Type': 'application/json' } : { Authorization: `Bearer ${apiKey.trim()}` },
      ...(endpoint.bodyKey ? { body: JSON.stringify({ [endpoint.bodyKey]: apiKey.trim() }) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (controller.signal.aborted || !payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const record = payload as Record<string, unknown>;
    if (record.success === false || record.error) return undefined;
    return endpoint.read(record);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
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

/** APIMart — 验证目录后附带用户账户积分，不把令牌额度当作账户余额。 */
async function testApimart(apiKey: string, baseUrl = APIMART_BASE_URL): Promise<TestResult> {
  const result = await testModelCatalog(apiKey, baseUrl || APIMART_BASE_URL);
  if (!result.success || !result.baseUrl) return result;

  // 跟随用户配置并已验证的地址，兼容代理域名；余额失败不改变连接验证结果。
  try {
    const response = await corsSafeFetch(`${result.baseUrl}/user/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return result;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') return result;
    const record = payload as Record<string, unknown>;
    // remain_balance 的单位依赖服务端配置，使用文档明确标为积分的字段。
    if (record.success === true
      && typeof record.remain_credits === 'number'
      && Number.isFinite(record.remain_credits)) {
      return { ...result, balance: `${record.remain_credits} 积分` };
    }
  } catch {
    // 自定义地址可能未开放账户接口，也可能暂时无法查询。
  }
  return result;
}

/** RunningHUB — 模型 API 密钥，有余额 */
async function testRunninghubModel(apiKey: string, baseUrl?: string): Promise<TestResult> {
  const root = (baseUrl || 'https://www.runninghub.cn').replace(/\/openapi\/v2\/?$/, '').replace(/\/+$/, '');
  const url = `${root}/uc/openapi/accountStatus`;
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

/** GRSAI 模型协议仍作本地核对；余额由设置列表独立查询，不以余额代替生成验证。 */
async function testGRSAI(): Promise<TestResult> {
  return {
    success: false,
    unsupported: true,
    error: 'GRSAI 模型连接仅作本地配置核对，余额在 API Key 列表独立查询；本次未发送模型请求',
  };
}

/** 官方系统音色目录只验证当前 Key，不生成媒体、不声称覆盖所有模型权限。 */
async function testMinimax(apiKey: string, baseUrl?: string): Promise<TestResult> {
  const origin = resolveMinimaxBaseUrl(baseUrl);
  if (!apiKey.trim()) return { success: false, error: '请先填写 API 密钥' };
  let response: Response;
  try {
    response = await corsSafeFetch(`${origin}/v1/get_voice`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_type: 'system' }),
    });
  } catch { return { success: false, error: 'MiniMax 音色目录网络请求失败，请检查当前官方站点与网络' }; }
  if (!response.ok) return { success: false, error: `MiniMax 音色目录验证失败（HTTP ${response.status}）` };
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { success: false, error: 'MiniMax 音色目录响应格式无效' };
  const record = payload as Record<string, unknown>;
  try { assertMinimaxResponse(payload); }
  catch (error) { return { success: false, error: error instanceof Error ? error.message : 'MiniMax 音色目录验证失败' }; }
  const business = record.base_resp as Record<string, unknown> | undefined;
  if (business?.status_code !== 0 || !Array.isArray(record.system_voice)) {
    return { success: false, error: 'MiniMax 音色目录缺少成功状态或系统音色列表' };
  }
  return { success: true, baseUrl: origin };
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
  | 'runninghub'
  | 'grsai'
  | 'minimax'
  | WebSearchProviderId;

const testFns: Record<ProviderTestKey, (apiKey: string, baseUrl?: string) => Promise<TestResult>> = {
  apimart: testApimart,
  volcengine: (apiKey, baseUrl) => testModelCatalog(apiKey, baseUrl || VOLCENGINE_BASE_URL),
  'runninghub-model': testRunninghubModel,
  runninghub: testRunninghubModel,
  grsai: testGRSAI,
  minimax: testMinimax,
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
  if (provider === 'muse') {
    if (!isTauriEnv()) return { success: false, unsupported: true, error: 'Muse 登录仅在桌面应用中可用' };
    try {
      type Status = { loggedIn: boolean; checking?: boolean; sessionState?: string; credentialStored?: boolean };
      const initial = await invoke<Status>('muse_auth_status', { verify: true });
      const status = initial.checking ? await pollTask<Status, Status>({
        fetchState: () => invoke<Status>('muse_auth_status'),
        isComplete: (current) => current.checking ? null : current,
        interval: 500, maxDuration: 60_000,
        timeoutMsg: 'Muse 会话仍在验证，请稍后在连接设置中刷新；已保存 Cookie 不会删除',
      }) : initial;
      if (status.loggedIn && status.sessionState === 'verified') return { success: true };
      return { success: false, error: status.sessionState === 'invalid'
        ? 'Muse 已明确拒绝此会话，请重新登录或更新 Cookie'
        : status.credentialStored ? 'Muse 会话已保存，但尚未在线验证，请在连接设置中重试'
          : '请先在 Muse 官网窗口登录或手动填写 Cookie' };
    } catch (error) {
      if (error instanceof PollTimeoutError) return { success: false, error: 'Muse 会话仍在验证，请稍后在连接设置中刷新；已保存 Cookie 不会删除' };
      return { success: false, error: '无法读取 Muse 登录状态，请重试' };
    }
  }
  if (!apiKey && getProviderDefinition(provider)?.kind !== 'workflow-api') return { success: false, error: '请先填写 API 密钥' };
  const fn = testFns[provider as ProviderTestKey];
  try {
    if (fn) return await fn(apiKey, baseUrl);
    const definition = getProviderDefinition(provider);
    if (definition?.authType === 'oauth') {
      return { success: false, unsupported: true, error: `${definition.name} 使用 OAuth 登录，无需验证密钥` };
    }
    if (definition?.kind === 'workflow-api') {
      const { normalizeWorkflowApiBaseUrl } = await import('./workflowApi/autodlWorkflowManifest');
      if (!baseUrl?.trim()) throw new Error('请填写工作流 API 连接地址');
      normalizeWorkflowApiBaseUrl(baseUrl, true);
      return { success: false, unsupported: true, error: '配置格式有效；Token 权限需在实际生成时验证。未提交任务。' };
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
