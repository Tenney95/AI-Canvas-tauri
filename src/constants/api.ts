/**
 * API 常量 — 各供应商的默认 base URL
 * 集中管理，避免在多个文件中硬编码相同 URL
 */

/** APIMart 供应商 */
export const APIMART_BASE_URL = 'https://api.apib.ai/v1';

/** ToAPIs 两站共用账号与 Key；仅按用户选择的站点发送请求。 */
export const TOAPIS_BASE_URL = 'https://toapis.cn/v1';
export const TOAPIS_API_SITES = [
  { id: 'cn', label: '国内站（toapis.cn）', baseUrl: TOAPIS_BASE_URL, consoleUrl: 'https://toapis.cn/login?aff=SnMr' },
  { id: 'com', label: '国际站（toapis.com）', baseUrl: 'https://toapis.com/v1', consoleUrl: 'https://toapis.com/login?aff=SnMr' },
] as const;

/** CCC API 中转站（OpenAI 兼容协议） */
export const CCCAPI_BASE_URL = 'https://cccapi.cn/v1';

/** 火山方舟 */
export const VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/** GRSAI */
export const GRSAI_LEGACY_BASE_URL = 'https://api.grsai.com';
export const GRSAI_GLOBAL_BASE_URL = 'https://grsaiapi.com/v1';
export const GRSAI_BASE_URL = 'https://grsai.dakka.com.cn/v1';

/** 即梦 Dreamina */
export const DREAMINA_BASE_URL = 'https://api.dreamina.com';

/** RunningHUB */
export const RUNNINGHUB_BASE_URL = 'https://api.runninghub.cn';

/** RunningHUB 标准模型 API（异步任务协议） */
export const RUNNINGHUB_MODEL_BASE_URL = 'https://www.runninghub.cn/openapi/v2';

/** 用户显式选择 API 站点；不根据应用链接自动改道或跨站重试。 */
export const RUNNINGHUB_API_SITES = [
  { id: 'cn', label: '国内站（runninghub.cn）', baseUrl: RUNNINGHUB_MODEL_BASE_URL, consoleUrl: 'https://www.runninghub.cn?inviteCode=iadc40jt' },
  { id: 'ai', label: '国际站（runninghub.ai）', baseUrl: 'https://www.runninghub.ai/openapi/v2', consoleUrl: 'https://www.runninghub.ai?inviteCode=17k4ifbi' },
] as const;

/** Tavily 联网搜索 */
export const TAVILY_BASE_URL = 'https://api.tavily.com';

/** 博查 Web Search */
export const BOCHA_SEARCH_BASE_URL = 'https://api.bocha.cn';

/** 智谱 Web Search */
export const ZHIPU_SEARCH_BASE_URL = 'https://open.bigmodel.cn/api';

/** Exa Search */
export const EXA_SEARCH_BASE_URL = 'https://api.exa.ai';

/** 默认供应商 base URL 映射（用于 aiService 的 fallback） */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  apimart: APIMART_BASE_URL,
  toapis: TOAPIS_BASE_URL,
  cccapi: CCCAPI_BASE_URL,
  volcengine: VOLCENGINE_BASE_URL,
  grsai: GRSAI_BASE_URL,
  dreamina: DREAMINA_BASE_URL,
  runninghub: RUNNINGHUB_BASE_URL,
};
