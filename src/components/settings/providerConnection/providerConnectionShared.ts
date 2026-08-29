/**
 * settings/providerConnection/providerConnectionShared — 厂商连接弹窗的常量、类型与共用助手。
 * 分类顺序、能力预设、厂商控制台链接、导入快照结构集中在这里，供弹窗与各子区块共用。
 */
import type {
  ApiProviderConfig,
  GeneralModelCategory,
  ProviderModelSelection,
} from '../../../types';

export const CATEGORY_ORDER: GeneralModelCategory[] = ['text', 'image', 'video', 'audio'];
export const VIDEO_RATIO_PRESETS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
export const VIDEO_RESOLUTION_PRESETS = ['480p', '540p', '720p', '1080p', '2K', '4K', '480', '640', '832', '1280'];
export const VIDEO_FRAME_RATE_PRESETS = [16, 24, 25, 30, 48, 60];
export const VIDEO_DURATION_PRESETS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
export const VIDEO_DURATION_RANGE_MIN = 1;
export const VIDEO_DURATION_RANGE_MAX = 3600;
export const PROVIDER_LINKS: Record<string, string> = {
  apimart: 'https://apimart.ai/register?aff=ZnmCKm',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  'runninghub-model': 'https://www.runninghub.cn?inviteCode=iadc40jt',
  grsai: 'https://grsai.com/zh/dashboard/api-keys',
  dreamina: 'https://www.dreamina.com',
  tavily: 'https://app.tavily.com',
  bocha: 'https://open.bochaai.com/dashboard',
  'zhipu-search': 'https://open.bigmodel.cn/usercenter/apikeys',
  exa: 'https://dashboard.exa.ai/api-keys',
};

export function buildRelayAssistantPrompt(connectionName: string, baseUrl: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
  // new-api / one-api 的文档页就在 {地址}/docs，从接口地址直接推导，省去用户手动粘贴文档链接。
  const docsLink = trimmedBase
    ? `${trimmedBase}/docs`
    : '【请在这里粘贴该中转站的文档或模型列表页面 HTTPS 链接（若上面的接口地址已填，这里可留空，我会自动尝试 /docs）】';
  return [
    '请帮我把这个「中转站 / 聚合 API」里的模型添加为自定义接口配置。',
    '',
    `目标连接名称：${connectionName || '（未填，可自定义）'}`,
    trimmedBase
      ? `接口地址（Base URL）：${trimmedBase} —— 所有模型都用这个真实接口地址，不要拿文档站域名当 Base URL。`
      : '接口地址（Base URL）：未填。请从文档 / 中转站地址确定真实 API 接口地址（不是文档站域名）；new-api / one-api 中转站的文档域名通常就是 API 域名。',
    '',
    '请这样操作：',
    '1. 用 provider_docs_read 阅读该中转站的文档首页，拿到模型清单以及每个模型的接口页链接。',
    '2. 调用 provider_models_select，把清单里的全部模型作为候选传进去，我会在勾选卡片里选。不要在正文里罗列清单让我打字回复，也不要自作主张全部添加。',
    '3. 我勾选之后，对选中的每个模型用 provider_docs_read 打开它自己的接口页（形如 /docs/videos/{模型ID}），只读这些。只有那里才有该模型真实的参数表、固定能力和请求示例。',
    '4. 逐个核对模型 ID、显示名称、类型。请求路径和请求体字段一律以该模型自己的文档为准：文档有「请求示例」JSON 就原样用，只有参数表就只写表里的字段。只有文档明确声明 OpenAI 兼容时才能采用对应标准端点；文档没有端点或字段时必须报告资料不足，禁止猜测 /v1/videos、/videos/generations 等路径。多写一个该模型不认识的字段，接口就会返回 400 unsupported field，所以宁可暂停配置也不要凭印象补字段。',
    '4.1 文档写明的固定能力（固定时长、宽高比枚举、参考图上限等）用 videoCapability 声明出来，画布上的参数面板会据此约束用户，避免发出该模型不支持的取值。',
    '5. 读完所选模型的接口页后必须立即调用 provider_config_preview 生成草稿，再调用 provider_config_apply 保存；不要只报告一遍字段就结束任务（同一 Base URL，单次最多 16 个，超出就分多次保存）。',
    '6. 不要写入 API Key，把其余内容都填好即可；保存后我会自己补填 API Key。',
    '',
    '中转站文档 / 模型列表链接：',
    docsLink,
  ].join('\n');
}

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'warning' | 'error';

export interface ProtocolImportSnapshot {
  baseUrl: string;
  models: ProviderModelSelection[];
  selectedIds: Set<string>;
  visibleModelCategories: Set<GeneralModelCategory>;
  category: GeneralModelCategory | 'all';
  protocolModelId: string | null;
  protocolValid: boolean;
  catalogStatus: CatalogStatus;
  catalogMessage: string;
}

export interface ProviderConnectionDialogProps {
  isOpen: boolean;
  connectionId?: string;
  initialConfig?: ApiProviderConfig;
  providerConfigs: Record<string, ApiProviderConfig>;
  connectedProviderIds: string[];
  fallbackModels: Record<string, ProviderModelSelection[]>;
  dreaminaLoggedIn: boolean;
  dreaminaLoading: boolean;
  runninghubWorkflowApiKey?: string;
  onDreaminaLogin: () => void;
  onClose: () => void;
  onSave: (
    connectionId: string,
    config: ApiProviderConfig,
    related?: { runninghubWorkflowApiKey?: string },
  ) => Promise<void>;
}

export async function openExternal(url: string): Promise<void> {
  try {
    await import('@tauri-apps/plugin-shell').then(({ open }) => open(url));
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
