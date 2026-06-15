/**
 * testConnection 连接测试服务 — 按厂商调用对应 API 端点验证密钥有效性和余额（APIMart/GRSAI/OpenAI/火山方舟/RunningHUB
 */

export interface TestResult {
  success: boolean;
  /** 余额文本，如 "1100 积分" */
  balance?: string;
  /** 失败原因 */
  error?: string;
}

/** APIMart — OpenAI 兼容接口，ping 测试，无余额 */
async function testAPIMart(apiKey: string, baseUrl?: string): Promise<TestResult> {
  const url = `${baseUrl || 'https://api.apib.ai/v1'}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'kimi-k2-instruct',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    return { success: false, error: data.error.message || JSON.stringify(data.error) };
  }
  if (data.choices) {
    return { success: true };
  }
  return { success: false, error: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
}

/** 火山方舟 — 简单 ping */
async function testVolcengine(_apiKey: string): Promise<TestResult> {
  try {
    const res = await fetch('https://ark.cn-beijing.volces.com/ping');
    const data = await res.json().catch(() => ({}));
    if (data.message === 'pong') {
      return { success: true };
    }
    return { success: false, error: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** RunningHUB — 模型 API 密钥，有余额 */
async function testRunninghubModel(apiKey: string): Promise<TestResult> {
  const url = 'https://www.runninghub.cn/uc/openapi/accountStatus';
  const res = await fetch(url, {
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

/** GRSAI — OpenAI 兼容接口，ping 测试，无余额 */
async function testGRSAI(apiKey: string, baseUrl?: string): Promise<TestResult> {
  const url = `${baseUrl || 'https://grsai.dakka.com.cn/v1'}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gemini-3.1-pro',
      messages: [{ role: 'user', content: '你好' }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    return { success: false, error: data.error.message || JSON.stringify(data.error) };
  }
  if (data.choices) {
    return { success: true };
  }
  return { success: false, error: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
}

export type ProviderTestKey = 'apimart' | 'volcengine' | 'runninghub-model' | 'grsai';

const testFns: Record<ProviderTestKey, (apiKey: string, baseUrl?: string) => Promise<TestResult>> = {
  apimart: testAPIMart,
  volcengine: testVolcengine,
  'runninghub-model': testRunninghubModel,
  grsai: testGRSAI,
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
