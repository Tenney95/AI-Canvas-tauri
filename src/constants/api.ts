/**
 * API 常量 — 各供应商的默认 base URL
 * 集中管理，避免在多个文件中硬编码相同 URL
 */

/** APIMart 供应商 */
export const APIMART_BASE_URL = 'https://api.apib.ai/v1';

/** 火山方舟 */
export const VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/** GRSAI */
export const GRSAI_BASE_URL = 'https://api.grsai.com';

/** 即梦 Dreamina */
export const DREAMINA_BASE_URL = 'https://api.dreamina.com';

/** RunningHUB */
export const RUNNINGHUB_BASE_URL = 'https://api.runninghub.cn';

/** RunningHUB 标准模型 API（异步任务协议） */
export const RUNNINGHUB_MODEL_BASE_URL = 'https://www.runninghub.cn/openapi/v2';

/** 默认供应商 base URL 映射（用于 aiService 的 fallback） */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  apimart: APIMART_BASE_URL,
  volcengine: VOLCENGINE_BASE_URL,
  grsai: GRSAI_BASE_URL,
  dreamina: DREAMINA_BASE_URL,
  runninghub: RUNNINGHUB_BASE_URL,
};
