/**
 * ProviderConnectionDialog — add/edit one provider connection and choose its enabled models.
 */
import { Icon } from '@iconify/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ApiProviderConfig,
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
} from '../../types';
import { GENERAL_MODEL_CATEGORY_LABELS } from '../../types';
import {
  createConnectionId,
  fetchProviderModelCatalog,
  getProviderDefinition,
  getProviderDefinitions,
  getWebSearchProviderDefinitions,
  type ProviderDefinition,
} from '../../services/ai/providerCatalogService';
import { normalizeBaseUrl } from '../../services/ai/providerBaseUrl';
import type { ModelProtocolImportResult } from '../../services/ai/modelProtocolImport';
import type { VideoModelCapability } from '../../types/aiTypes';
import { emitCloseChatWindow } from '../../services/chat/chatWindowService';
import { testProviderConnection } from '../../services/testConnection';
import { useAppStore } from '../../store/useAppStore';
import AnimatedButton from '../shared/AnimatedButton';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import ModelProtocolEditor from './ModelProtocolEditor';
import ProtocolImportPanel from './ProtocolImportPanel';
import { useT } from '../../i18n';

const CATEGORY_ORDER: GeneralModelCategory[] = ['text', 'image', 'video', 'audio'];
const VIDEO_RATIO_PRESETS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
const DEFAULT_VIDEO_RATIOS = VIDEO_RATIO_PRESETS.slice(0, 6);
const VIDEO_RESOLUTION_PRESETS = ['480p', '540p', '720p', '1080p', '2K', '4K', '480', '640', '832', '1280'];
const DEFAULT_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'];
const VIDEO_FRAME_RATE_PRESETS = [16, 24, 25, 30, 48, 60];
const DEFAULT_VIDEO_FRAME_RATES = [16, 24, 30];
const VIDEO_DURATION_PRESETS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
const VIDEO_DURATION_RANGE_MIN = 2;
const VIDEO_DURATION_RANGE_MAX = 30;
const PROVIDER_LINKS: Record<string, string> = {
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

function buildRelayAssistantPrompt(connectionName: string, baseUrl: string): string {
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
    '4. 逐个核对模型 ID、显示名称、类型。请求体字段一律以该模型自己的文档为准：文档有「请求示例」JSON 就原样用，只有参数表就只写表里的字段，两者都没有才退回 OpenAI 标准端点（chat/completions、images/generations、/v1/videos、audio/speech）。多写一个该模型不认识的字段，接口就会返回 400 unsupported field，所以宁可少写也不要凭印象补字段。',
    '4.1 文档写明的固定能力（固定时长、宽高比枚举、参考图上限等）用 videoCapability 声明出来，画布上的参数面板会据此约束用户，避免发出该模型不支持的取值。',
    '5. 读完所选模型的接口页后必须立即调用 provider_config_preview 生成草稿，再调用 provider_config_apply 保存；不要只报告一遍字段就结束任务（同一 Base URL，单次最多 16 个，超出就分多次保存）。',
    '6. 不要写入 API Key，把其余内容都填好即可；保存后我会自己补填 API Key。',
    '',
    '中转站文档 / 模型列表链接：',
    docsLink,
  ].join('\n');
}

type CatalogStatus = 'idle' | 'loading' | 'ready' | 'warning' | 'error';

interface ProtocolImportSnapshot {
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

interface ProviderConnectionDialogProps {
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

interface VideoCapabilityEditorProps {
  model: ProviderModelSelection;
  onChange: (capability: VideoModelCapability | undefined) => void;
  onClose: () => void;
}

function createEditableVideoCapability(
  capability?: VideoModelCapability,
): VideoModelCapability {
  const ratios = capability?.ratios?.length ? capability.ratios : DEFAULT_VIDEO_RATIOS;
  const resolutions = capability?.resolutions?.length
    ? capability.resolutions
    : DEFAULT_VIDEO_RESOLUTIONS;
  const frameRates = capability?.frameRates?.length
    ? capability.frameRates
    : DEFAULT_VIDEO_FRAME_RATES;
  const minDuration = Math.min(
    VIDEO_DURATION_RANGE_MAX,
    Math.max(
      VIDEO_DURATION_RANGE_MIN,
      capability?.minDuration ?? Math.min(...(capability?.durations ?? [VIDEO_DURATION_RANGE_MIN])),
    ),
  );
  const maxDuration = Math.max(
    minDuration,
    Math.min(
      VIDEO_DURATION_RANGE_MAX,
      capability?.maxDuration ?? Math.max(...(capability?.durations ?? [15])),
    ),
  );
  return {
    ...capability,
    ratios: [...ratios],
    defaultRatio: ratios.includes(capability?.defaultRatio ?? '')
      ? capability?.defaultRatio
      : ratios[0],
    resolutions: [...resolutions],
    defaultResolution: resolutions.includes(capability?.defaultResolution ?? '')
      ? capability?.defaultResolution
      : resolutions[0],
    frameRates: [...frameRates],
    defaultFrameRate: frameRates.includes(capability?.defaultFrameRate ?? Number.NaN)
      ? capability?.defaultFrameRate
      : frameRates[0],
    minDuration,
    maxDuration,
    defaultDuration: Math.min(
      maxDuration,
      Math.max(minDuration, capability?.defaultDuration ?? capability?.durations?.[0] ?? 5),
    ),
  };
}

function VideoCapabilityEditor({ model, onChange, onClose }: VideoCapabilityEditorProps) {
  const [customRatio, setCustomRatio] = useState('');
  const [customResolution, setCustomResolution] = useState('');
  const [customFrameRate, setCustomFrameRate] = useState('');
  const [customDuration, setCustomDuration] = useState('');
  const capability = createEditableVideoCapability(model.videoCapability);
  const discreteDurations = capability.durations?.length
    ? [...capability.durations].sort((left, right) => left - right)
    : undefined;
  const ratioOptions = [...new Set([...VIDEO_RATIO_PRESETS, ...(capability.ratios ?? [])])];
  const resolutionOptions = [...new Set([
    ...VIDEO_RESOLUTION_PRESETS,
    ...(capability.resolutions ?? []),
  ])];
  const frameRateOptions = [...new Set([
    ...VIDEO_FRAME_RATE_PRESETS,
    ...(capability.frameRates ?? []),
  ])].sort((left, right) => left - right);
  const durationOptions = [...new Set([
    ...VIDEO_DURATION_PRESETS,
    ...(discreteDurations ?? []),
  ])].sort((left, right) => left - right);

  const commit = (next: VideoModelCapability) => onChange(createEditableVideoCapability(next));
  const toggleStringOption = (
    field: 'ratios' | 'resolutions',
    defaultField: 'defaultRatio' | 'defaultResolution',
    value: string,
  ) => {
    const current = capability[field] ?? [];
    if (current.includes(value) && current.length === 1) return;
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    commit({
      ...capability,
      [field]: next,
      [defaultField]: next.includes(String(capability[defaultField] ?? ''))
        ? capability[defaultField]
        : next[0],
    });
  };
  const addStringOption = (
    field: 'ratios' | 'resolutions',
    defaultField: 'defaultRatio' | 'defaultResolution',
    rawValue: string,
    clear: () => void,
  ) => {
    const value = rawValue.trim();
    if (!value) return;
    const current = capability[field] ?? [];
    commit({
      ...capability,
      [field]: current.includes(value) ? current : [...current, value],
      [defaultField]: capability[defaultField] ?? value,
    });
    clear();
  };
  const toggleFrameRate = (value: number) => {
    const current = capability.frameRates ?? [];
    if (current.includes(value) && current.length === 1) return;
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value].sort((left, right) => left - right);
    commit({
      ...capability,
      frameRates: next,
      defaultFrameRate: next.includes(capability.defaultFrameRate ?? Number.NaN)
        ? capability.defaultFrameRate
        : next[0],
    });
  };
  const toggleDuration = (value: number) => {
    const current = discreteDurations ?? [];
    if (current.includes(value) && current.length === 1) return;
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value].sort((left, right) => left - right);
    commit({
      ...capability,
      durations: next,
      minDuration: Math.min(...next),
      maxDuration: Math.max(...next),
      defaultDuration: next.includes(capability.defaultDuration ?? Number.NaN)
        ? capability.defaultDuration
        : next[0],
    });
  };
  const optionClass = (active: boolean) => `min-h-7 rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
    active
      ? 'border-indigo-400/70 bg-indigo-500/20 text-indigo-100'
      : 'border-canvas-border bg-black/10 text-canvas-text-secondary hover:border-indigo-400/40 hover:text-canvas-text'
  }`;

  return (
    <div className="mt-3 rounded-xl border border-canvas-border bg-canvas-surface/80 p-4 shadow-xl shadow-black/10">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-canvas-text">
            <Icon icon="lucide:video" width="17" className="text-indigo-300" />
            视频参数能力
          </div>
          <p className="mt-1 text-[11px] leading-5 text-canvas-text-secondary">
            {model.name} · 勾选模型实际支持的值，视频节点只会展示这些选项。
          </p>
        </div>
        <PopupCloseButton aria-label="关闭视频参数能力" onClick={onClose} />
      </div>

      <div className="space-y-4">
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">画面比例（可多选）</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              默认
              <select
                className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text"
                value={capability.defaultRatio}
                onChange={(event) => commit({ ...capability, defaultRatio: event.target.value })}
              >
                {capability.ratios?.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ratioOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.ratios?.includes(value)} className={optionClass(capability.ratios?.includes(value) ?? false)} onClick={() => toggleStringOption('ratios', 'defaultRatio', value)}>
                {value === 'adaptive' ? '自适应' : value}
              </button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customRatio} placeholder="自定义" onChange={(event) => setCustomRatio(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addStringOption('ratios', 'defaultRatio', customRatio, () => setCustomRatio('')); }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label="添加自定义比例" onClick={() => addStringOption('ratios', 'defaultRatio', customRatio, () => setCustomRatio(''))}>+</button>
            </span>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">分辨率（可多选）</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              默认
              <select className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text" value={capability.defaultResolution} onChange={(event) => commit({ ...capability, defaultResolution: event.target.value })}>
                {capability.resolutions?.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {resolutionOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.resolutions?.includes(value)} className={optionClass(capability.resolutions?.includes(value) ?? false)} onClick={() => toggleStringOption('resolutions', 'defaultResolution', value)}>{value}</button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customResolution} placeholder="自定义" onChange={(event) => setCustomResolution(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addStringOption('resolutions', 'defaultResolution', customResolution, () => setCustomResolution('')); }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label="添加自定义分辨率" onClick={() => addStringOption('resolutions', 'defaultResolution', customResolution, () => setCustomResolution(''))}>+</button>
            </span>
          </div>
          <p className="mt-1.5 text-[10px] text-canvas-text-muted">同时提供 480p/1080p 等接口档位和 480/832 等长边像素；请按厂商文档勾选。</p>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">帧率（可多选）</span>
            <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
              默认
              <select className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text" value={capability.defaultFrameRate} onChange={(event) => commit({ ...capability, defaultFrameRate: Number(event.target.value) })}>
                {capability.frameRates?.map((value) => <option key={value} value={value}>{value} FPS</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {frameRateOptions.map((value) => (
              <button key={value} type="button" aria-pressed={capability.frameRates?.includes(value)} className={optionClass(capability.frameRates?.includes(value) ?? false)} onClick={() => toggleFrameRate(value)}>{value} FPS</button>
            ))}
            <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
              <input type="number" min="1" max="240" className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customFrameRate} placeholder="自定义" onChange={(event) => setCustomFrameRate(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { const value = Number(customFrameRate); if (Number.isInteger(value) && value > 0 && value <= 240) { if (!capability.frameRates?.includes(value)) toggleFrameRate(value); setCustomFrameRate(''); } } }} />
              <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label="添加自定义帧率" onClick={() => { const value = Number(customFrameRate); if (Number.isInteger(value) && value > 0 && value <= 240) { if (!capability.frameRates?.includes(value)) toggleFrameRate(value); setCustomFrameRate(''); } }}>+</button>
            </span>
          </div>
        </section>

        <section className="rounded-lg border border-canvas-border bg-black/10 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text">生成时长</span>
            <div className="flex rounded-md border border-canvas-border bg-canvas-card p-0.5" role="group" aria-label="时长模式">
              <button type="button" className={`rounded px-2.5 py-1 text-[10px] ${!discreteDurations ? 'bg-indigo-500/25 text-indigo-100' : 'text-canvas-text-secondary'}`} onClick={() => commit({ ...capability, durations: undefined, minDuration: capability.minDuration ?? VIDEO_DURATION_RANGE_MIN, maxDuration: capability.maxDuration ?? 15 })}>连续范围</button>
              <button type="button" className={`rounded px-2.5 py-1 text-[10px] ${discreteDurations ? 'bg-indigo-500/25 text-indigo-100' : 'text-canvas-text-secondary'}`} onClick={() => commit({ ...capability, durations: [capability.defaultDuration ?? 5] })}>固定档位</button>
            </div>
          </div>
          {discreteDurations ? (
            <div className="flex flex-wrap gap-1.5">
              {durationOptions.map((value) => (
                <button key={value} type="button" aria-pressed={discreteDurations.includes(value)} className={optionClass(discreteDurations.includes(value))} onClick={() => toggleDuration(value)}>{value}s</button>
              ))}
              <span className="flex min-h-7 overflow-hidden rounded-md border border-dashed border-canvas-border focus-within:border-indigo-400/60">
                <input type="number" min={VIDEO_DURATION_RANGE_MIN} max={VIDEO_DURATION_RANGE_MAX} className="w-20 bg-transparent px-2 text-[11px] text-canvas-text outline-none" value={customDuration} placeholder="自定义秒" onChange={(event) => setCustomDuration(event.target.value)} />
                <button type="button" className="border-l border-canvas-border px-2 text-indigo-300" aria-label="添加自定义时长" onClick={() => { const value = Number(customDuration); if (Number.isInteger(value) && value >= VIDEO_DURATION_RANGE_MIN && value <= VIDEO_DURATION_RANGE_MAX) { if (!discreteDurations.includes(value)) toggleDuration(value); setCustomDuration(''); } }}>+</button>
              </span>
              <label className="ml-auto flex items-center gap-2 text-[10px] text-canvas-text-secondary">
                默认
                <select className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text" value={capability.defaultDuration} onChange={(event) => commit({ ...capability, defaultDuration: Number(event.target.value) })}>
                  {discreteDurations.map((value) => <option key={value} value={value}>{value}s</option>)}
                </select>
              </label>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-canvas-text">
                <span>最短 {capability.minDuration}s</span>
                <span>最长 {capability.maxDuration}s</span>
              </div>
              <div className="relative h-8">
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-canvas-card" />
                <div
                  className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.35)]"
                  style={{
                    left: `${(((capability.minDuration ?? VIDEO_DURATION_RANGE_MIN) - VIDEO_DURATION_RANGE_MIN) / (VIDEO_DURATION_RANGE_MAX - VIDEO_DURATION_RANGE_MIN)) * 100}%`,
                    width: `${(((capability.maxDuration ?? VIDEO_DURATION_RANGE_MAX) - (capability.minDuration ?? VIDEO_DURATION_RANGE_MIN)) / (VIDEO_DURATION_RANGE_MAX - VIDEO_DURATION_RANGE_MIN)) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  min={VIDEO_DURATION_RANGE_MIN}
                  max={VIDEO_DURATION_RANGE_MAX}
                  step="1"
                  value={capability.minDuration}
                  aria-label="最短生成时长"
                  className="rh-duration-input pointer-events-none absolute inset-0 z-20 [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto"
                  style={{ position: 'absolute', top: 4, left: 0, right: 0, zIndex: 20 }}
                  onChange={(event) => {
                    const minDuration = Math.min(Number(event.target.value), capability.maxDuration ?? VIDEO_DURATION_RANGE_MAX);
                    commit({
                      ...capability,
                      minDuration,
                      defaultDuration: Math.max(minDuration, capability.defaultDuration ?? minDuration),
                    });
                  }}
                />
                <input
                  type="range"
                  min={VIDEO_DURATION_RANGE_MIN}
                  max={VIDEO_DURATION_RANGE_MAX}
                  step="1"
                  value={capability.maxDuration}
                  aria-label="最长生成时长"
                  className="rh-duration-input pointer-events-none absolute inset-0 z-10 [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto"
                  style={{ position: 'absolute', top: 4, left: 0, right: 0, zIndex: 10 }}
                  onChange={(event) => {
                    const maxDuration = Math.max(Number(event.target.value), capability.minDuration ?? VIDEO_DURATION_RANGE_MIN);
                    commit({
                      ...capability,
                      maxDuration,
                      defaultDuration: Math.min(maxDuration, capability.defaultDuration ?? maxDuration),
                    });
                  }}
                />
              </div>
              <div className="flex justify-between text-[9px] text-canvas-text-muted" aria-hidden="true">
                {[2, 6, 10, 14, 18, 22, 26, 30].map((value) => <span key={value}>{value}s</span>)}
              </div>
              <label className="mt-3 flex items-center justify-end gap-2 text-[10px] text-canvas-text-secondary">
                默认时长
                <select
                  className="h-7 rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text"
                  value={capability.defaultDuration}
                  onChange={(event) => commit({ ...capability, defaultDuration: Number(event.target.value) })}
                >
                  {Array.from(
                    { length: (capability.maxDuration ?? 15) - (capability.minDuration ?? VIDEO_DURATION_RANGE_MIN) + 1 },
                    (_, index) => (capability.minDuration ?? VIDEO_DURATION_RANGE_MIN) + index,
                  ).map((value) => <option key={value} value={value}>{value}s</option>)}
                </select>
              </label>
            </div>
          )}
        </section>
      </div>

      <div className="mt-4 flex justify-end">
        <button type="button" className="text-[11px] text-canvas-text-secondary hover:text-canvas-text" onClick={() => onChange(undefined)}>清除自定义限制，恢复通用默认</button>
      </div>
    </div>
  );
}

function mergeModels(
  current: ProviderModelSelection[],
  incoming: ProviderModelSelection[],
): ProviderModelSelection[] {
  const models = new Map(current.map((model) => [model.id, model]));
  for (const model of incoming) {
    const existing = models.get(model.id);
    const incomingHasOnlyRawName = model.name.trim().toLowerCase() === model.id.trim().toLowerCase();
    const existingHasFriendlyName = existing
      && existing.name.trim().toLowerCase() !== existing.id.trim().toLowerCase();
    const preserveExistingMetadata = incomingHasOnlyRawName && existingHasFriendlyName;
    // 用户手动指定过分类时，重新拉取目录或合并模型不再覆盖该分类。
    const preserveExistingCategory = Boolean(existing?.categoryManual) || preserveExistingMetadata;
    models.set(model.id, {
      ...existing,
      ...model,
      name: preserveExistingMetadata ? existing.name : model.name,
      category: preserveExistingCategory && existing ? existing.category : model.category,
      description: existing?.descriptionManual
        ? existing.description
        : model.description || existing?.description,
      descriptionManual: existing?.descriptionManual ?? model.descriptionManual,
      inputModalities: existing?.inputModalitiesManual
        ? existing.inputModalities
        : model.inputModalities ?? existing?.inputModalities,
      inputModalitiesManual: existing?.inputModalitiesManual ?? model.inputModalitiesManual,
      categoryManual: existing?.categoryManual ?? model.categoryManual,
    });
  }
  return [...models.values()];
}

async function openExternal(url: string): Promise<void> {
  try {
    await import('@tauri-apps/plugin-shell').then(({ open }) => open(url));
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export default function ProviderConnectionDialog({
  isOpen,
  connectionId,
  initialConfig,
  providerConfigs,
  connectedProviderIds,
  fallbackModels,
  dreaminaLoggedIn,
  dreaminaLoading,
  runninghubWorkflowApiKey = '',
  onDreaminaLogin,
  onClose,
  onSave,
}: ProviderConnectionDialogProps) {
  const t = useT();
  const editing = !!connectionId && !!initialConfig;
  const initialDefinitionId = initialConfig?.catalogId || connectionId || '';
  const initialDefinition = getProviderDefinition(initialDefinitionId, initialConfig);
  const initialSelectedModels = initialConfig?.selectedModels || [];
  const initialCatalogModels = initialConfig?.catalogModels || [];
  const initialLocalModels = initialDefinition ? (fallbackModels[initialDefinition.id] || []) : [];
  const [definitionId, setDefinitionId] = useState(initialDefinitionId);
  const [connectionName, setConnectionName] = useState(initialConfig?.name || initialDefinition?.name || '');
  const [apiKey, setApiKey] = useState(initialConfig?.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl || initialDefinition?.defaultBaseUrl || '');
  const [anthropicUrl, setAnthropicUrl] = useState(initialConfig?.anthropicUrl || '');
  const [workflowApiKey, setWorkflowApiKey] = useState(runninghubWorkflowApiKey);
  const [models, setModels] = useState<ProviderModelSelection[]>(
    mergeModels(mergeModels(initialLocalModels, initialCatalogModels), initialSelectedModels),
  );
  const [selectedIds, setSelectedIds] = useState(() =>
    new Set(initialSelectedModels.map((model) => model.id)),
  );
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>(
    initialSelectedModels.length > 0 || initialLocalModels.length > 0 ? 'ready' : 'idle',
  );
  const [catalogMessage, setCatalogMessage] = useState(
    initialCatalogModels.length > 0 ? t('已加载本地缓存 {count} 个模型', { count: initialCatalogModels.length }) : '',
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GeneralModelCategory | 'all'>('all');
  const [visibleModelCategories, setVisibleModelCategories] = useState(
    () => new Set(initialConfig?.visibleModelCategories ?? CATEGORY_ORDER),
  );
  const [manualModelId, setManualModelId] = useState('');
  const [manualModelName, setManualModelName] = useState('');
  const [manualCategory, setManualCategory] = useState<GeneralModelCategory>('text');
  const [videoCapabilityModelId, setVideoCapabilityModelId] = useState<string | null>(null);
  const [protocolModelId, setProtocolModelId] = useState<string | null>(null);
  const [protocolValid, setProtocolValid] = useState(true);
  const [protocolImportOpen, setProtocolImportOpen] = useState(false);
  const [protocolImportSnapshot, setProtocolImportSnapshot] = useState<ProtocolImportSnapshot | null>(null);
  const [categoryEditModelId, setCategoryEditModelId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const definition = getProviderDefinition(definitionId);
  const definitions = getProviderDefinitions();
  const webSearchDefinitions = getWebSearchProviderDefinitions();
  const isWebSearchProvider = definition?.kind === 'web-search';
  const hasWebSearchConnection = webSearchDefinitions.some((item) =>
    Boolean(providerConfigs[item.id]?.apiKey?.trim()),
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  const availableDefinitions = definitions.filter((item) => {
    if (item.kind === 'web-search') {
      return item.id === 'tavily' && (!hasWebSearchConnection || isWebSearchProvider);
    }
    return item.id === 'custom-openai'
      || item.id === initialDefinitionId
      || !connectedProviderIds.includes(item.id);
  });

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return models.filter((model) =>
      (category === 'all' || model.category === category)
      && (!normalizedQuery
        || model.name.toLowerCase().includes(normalizedQuery)
        || model.id.toLowerCase().includes(normalizedQuery)),
    );
  }, [category, models, query]);

  const selectedModels = useMemo(
    () => models.filter((model) => selectedIds.has(model.id)),
    [models, selectedIds],
  );

  const protocolModel = useMemo(
    () => models.find((model) => model.id === protocolModelId),
    [models, protocolModelId],
  );
  const videoCapabilityModel = useMemo(
    () => models.find((model) => model.id === videoCapabilityModelId),
    [models, videoCapabilityModelId],
  );

  const missingCredentials = useMemo(() => {
    if (!definition) return true;
    if (definition.authType === 'oauth') return !dreaminaLoggedIn;
    if (!apiKey.trim()) return true;
    return definition.credentials.some((field) =>
      field.required
      && field.key !== 'apiKey'
      && !(field.key === 'baseUrl' ? baseUrl : anthropicUrl).trim(),
    );
  }, [anthropicUrl, apiKey, baseUrl, definition, dreaminaLoggedIn]);

  const chooseDefinition = (nextDefinition: ProviderDefinition) => {
    const savedConfig = nextDefinition.kind === 'web-search'
      ? providerConfigs[nextDefinition.id]
      : undefined;
    setDefinitionId(nextDefinition.id);
    setConnectionName(savedConfig?.name || nextDefinition.name);
    setApiKey(savedConfig?.apiKey || '');
    setBaseUrl(savedConfig?.baseUrl || nextDefinition.defaultBaseUrl || '');
    setAnthropicUrl(savedConfig?.anthropicUrl || '');
    setWorkflowApiKey('');
    const localModels = fallbackModels[nextDefinition.id] || [];
    setModels(localModels);
    setSelectedIds(new Set());
    setCatalogStatus(localModels.length > 0 ? 'ready' : 'idle');
    setCatalogMessage('');
    setQuery('');
    setCategory('all');
    setVisibleModelCategories(new Set(CATEGORY_ORDER));
    setManualModelId('');
    setManualModelName('');
    setManualCategory('text');
    setVideoCapabilityModelId(null);
    setProtocolModelId(null);
    setProtocolValid(true);
    setProtocolImportOpen(false);
    setProtocolImportSnapshot(null);
    setCategoryEditModelId(null);
  };

  const handleFetchModels = async () => {
    if (!definition || missingCredentials) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCatalogStatus('loading');
    setCatalogMessage('');
    try {
      if (definition.id === 'runninghub-model') {
        const result = await testProviderConnection('runninghub-model', apiKey.trim());
        if (!result.success) throw new Error(result.error || t('RunningHub API Key 验证失败'));
      }
      const result = await fetchProviderModelCatalog({
        providerId: definition.id,
        config: {
          name: connectionName.trim() || definition.name,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          anthropicUrl: anthropicUrl.trim() || undefined,
          catalogId: definition.id,
        },
        fallbackModels: fallbackModels[definition.id] || [],
        signal: controller.signal,
      });
      setModels((current) => mergeModels(current, result.models));
      setCatalogStatus(result.warning ? 'warning' : 'ready');
      const corrected = adoptResolvedBaseUrl(result.resolvedBaseUrl);
      setCatalogMessage(
        result.warning
        || (corrected
          ? t('已获取 {count} 个模型，接口地址已更正为 {url}', {
            count: result.models.length,
            url: corrected,
          })
          : t('已获取 {count} 个模型', { count: result.models.length })),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : t('模型列表拉取失败'));
    }
  };

  const handleAssistantAdd = async () => {
    const store = useAppStore.getState();
    if (store.chatPanelDetached) await emitCloseChatWindow();
    store.openChatWithDraft(
      buildRelayAssistantPrompt(connectionName.trim(), normalizeBaseUrl(baseUrl)),
    );
  };

  /**
   * 探测补出的接口地址与用户填的不一致时回写输入框，返回更正后的地址。
   * 输入框为空说明走的是厂商默认地址，没什么可更正的，也不该把默认值钉进配置。
   */
  const adoptResolvedBaseUrl = (resolved: string | undefined): string | undefined => {
    const current = normalizeBaseUrl(baseUrl);
    if (!resolved || !current || resolved === current) return undefined;
    setBaseUrl(resolved);
    return resolved;
  };

  const handleTestConnection = async () => {
    if (!definition || missingCredentials) return;
    setCatalogStatus('loading');
    setCatalogMessage(t('正在验证 {name} 连接...', { name: definition.name }));
    const result = await testProviderConnection(
      definition.id,
      apiKey.trim(),
      baseUrl.trim() || undefined,
    );
    if (result.success) {
      const corrected = adoptResolvedBaseUrl(result.baseUrl);
      setCatalogStatus('ready');
      setCatalogMessage([
        t('{name} 连接验证成功', { name: definition.name }),
        result.balance,
        corrected && t('接口地址已更正为 {url}', { url: corrected }),
      ].filter(Boolean).join('，'));
      return;
    }
    setCatalogStatus(result.unsupported ? 'warning' : 'error');
    setCatalogMessage(result.error || t('{name} 连接验证失败', { name: definition.name }));
  };

  const toggleModel = (modelId: string) => {
    if (selectedIds.has(modelId) && protocolModelId === modelId) closeProtocolEditor();
    if (selectedIds.has(modelId) && videoCapabilityModelId === modelId) {
      setVideoCapabilityModelId(null);
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const toggleVisibleModels = () => {
    const allVisibleSelected = filteredModels.length > 0
      && filteredModels.every((model) => selectedIds.has(model.id));
    if (
      allVisibleSelected
      && protocolModelId
      && filteredModels.some((model) => model.id === protocolModelId)
    ) {
      closeProtocolEditor();
    }
    if (
      allVisibleSelected
      && videoCapabilityModelId
      && filteredModels.some((model) => model.id === videoCapabilityModelId)
    ) {
      setVideoCapabilityModelId(null);
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const model of filteredModels) {
        if (allVisibleSelected) next.delete(model.id);
        else next.add(model.id);
      }
      return next;
    });
  };

  const toggleVisibleCategory = (nextCategory: GeneralModelCategory) => {
    setVisibleModelCategories((current) => {
      const next = new Set(current);
      if (next.has(nextCategory)) next.delete(nextCategory);
      else next.add(nextCategory);
      return next;
    });
  };

  const toggleAllVisibleCategories = () => {
    setVisibleModelCategories((current) =>
      current.size === CATEGORY_ORDER.length ? new Set() : new Set(CATEGORY_ORDER),
    );
  };

  const addManualModel = () => {
    const id = manualModelId.trim();
    if (!id || !definition) return;
    const model: ProviderModelSelection = {
      id,
      name: manualModelName.trim() || id,
      category: manualCategory,
      provider: connectionId || definition.id,
      categoryManual: true,
    };
    setModels((current) => mergeModels(current, [model]));
    setSelectedIds((current) => new Set(current).add(id));
    setManualModelId('');
    setManualModelName('');
  };

  const updateModelCategory = (modelId: string, nextCategory: GeneralModelCategory) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? {
        ...model,
        category: nextCategory,
        categoryManual: true,
        ...(nextCategory === 'video' ? {} : { videoCapability: undefined }),
      } : model,
    ));
    if (nextCategory !== 'video' && videoCapabilityModelId === modelId) {
      setVideoCapabilityModelId(null);
    }
    setVisibleModelCategories((current) => new Set(current).add(nextCategory));
    setCategoryEditModelId(null);
  };

  const updateModelDescription = (modelId: string, description: string) => {
    setModels((current) => current.map((model) => (
      model.id === modelId
        ? { ...model, description: description.slice(0, 500), descriptionManual: true }
        : model
    )));
  };

  const updateModelVisionCapability = (modelId: string, enabled: boolean) => {
    setModels((current) => current.map((model) => model.id === modelId
      ? {
          ...model,
          inputModalities: enabled ? ['text', 'image'] : ['text'],
          inputModalitiesManual: true,
        }
      : model));
  };

  const updateModelProtocol = (
    modelId: string,
    executionProfile: ProviderModelSelection['executionProfile'],
  ) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? { ...model, executionProfile } : model,
    ));
  };

  const updateVideoCapability = (
    modelId: string,
    videoCapability: VideoModelCapability | undefined,
  ) => {
    setModels((current) => current.map((model) => (
      model.id === modelId ? { ...model, videoCapability } : model
    )));
  };

  const updateImageReferenceRequestMode = (
    modelId: string,
    imageReferenceRequestMode: ImageReferenceRequestMode,
  ) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? { ...model, imageReferenceRequestMode } : model,
    ));
  };

  const closeProtocolEditor = () => {
    setProtocolModelId(null);
    setProtocolValid(true);
  };

  const applyProtocolImport = (result: ModelProtocolImportResult) => {
    if (
      definition?.id !== 'custom-openai'
      || !result.baseUrl
      || !result.modelId
      || !result.category
      || !result.protocol
    ) return;
    setProtocolImportSnapshot({
      baseUrl,
      models: structuredClone(models),
      selectedIds: new Set(selectedIds),
      visibleModelCategories: new Set(visibleModelCategories),
      category,
      protocolModelId,
      protocolValid,
      catalogStatus,
      catalogMessage,
    });
    const modelId = result.modelId;
    const importedModel: ProviderModelSelection = {
      id: modelId,
      name: models.find((model) => model.id === modelId)?.name || modelId,
      category: result.category,
      provider: connectionId || definition.id,
      executionProfile: { preset: 'custom', protocol: result.protocol },
      categoryManual: true,
    };
    setBaseUrl(result.baseUrl);
    setModels((current) => {
      const existing = current.find((model) => model.id === modelId);
      if (!existing) return [...current, importedModel];
      return current.map((model) => model.id === modelId
        ? { ...model, category: importedModel.category, executionProfile: importedModel.executionProfile, categoryManual: true }
        : model);
    });
    setSelectedIds((current) => new Set(current).add(modelId));
    setVisibleModelCategories((current) => new Set(current).add(importedModel.category));
    setCategory('all');
    setProtocolModelId(modelId);
    setProtocolValid(true);
    setCatalogStatus('ready');
    setCatalogMessage(t('已从接口文档导入模型 {id}，保存前可继续检查调用协议', { id: modelId }));
    setProtocolImportOpen(false);
  };

  const undoProtocolImport = () => {
    if (!protocolImportSnapshot) return;
    setBaseUrl(protocolImportSnapshot.baseUrl);
    setModels(protocolImportSnapshot.models);
    setSelectedIds(protocolImportSnapshot.selectedIds);
    setVisibleModelCategories(protocolImportSnapshot.visibleModelCategories);
    setCategory(protocolImportSnapshot.category);
    setProtocolModelId(protocolImportSnapshot.protocolModelId);
    setProtocolValid(protocolImportSnapshot.protocolValid);
    setCatalogStatus(protocolImportSnapshot.catalogStatus);
    setCatalogMessage(protocolImportSnapshot.catalogMessage);
    setProtocolImportSnapshot(null);
    setProtocolImportOpen(false);
  };

  const closeDialog = () => {
    setProtocolImportOpen(false);
    setProtocolImportSnapshot(null);
    onClose();
  };

  const returnToDefinitionPicker = () => {
    setProtocolImportOpen(false);
    setProtocolImportSnapshot(null);
    setDefinitionId('');
  };

  const handleSave = async () => {
    if (
      !definition
      || missingCredentials
      || (!isWebSearchProvider && selectedModels.length === 0)
      || !protocolValid
    ) return;
    const nextConnectionId = isWebSearchProvider
      ? definition.id
      : connectionId || createConnectionId(definition.id);
    const modelConfig = isWebSearchProvider
      ? {}
      : {
          selectedModels: selectedModels.map((model) => ({ ...model, provider: nextConnectionId })),
          catalogModels: models.map((model) => ({ ...model, provider: nextConnectionId })),
          visibleModelCategories: CATEGORY_ORDER.filter((item) => visibleModelCategories.has(item)),
          catalogUpdatedAt: Date.now(),
        };
    await onSave(
      nextConnectionId,
      {
        name: connectionName.trim() || definition.name,
        apiKey: definition.authType === 'oauth' ? '' : apiKey.trim(),
        baseUrl: normalizeBaseUrl(baseUrl) || undefined,
        anthropicUrl: normalizeBaseUrl(anthropicUrl) || undefined,
        catalogId: definition.id,
        ...modelConfig,
      },
      definition.id === 'runninghub-model'
        ? { runninghubWorkflowApiKey: workflowApiKey.trim() }
        : undefined,
    );
  };

  return createPortal(
    <ModalOverlay
      isOpen={isOpen}
      onClose={closeDialog}
      ariaLabel={editing ? t('编辑 API 厂商') : t('添加 API 厂商')}
      className="provider-dialog"
      closeOnBackdrop={false}
    >
      <header className="provider-dialog-header">
        <div>
          <span className="provider-dialog-kicker">{editing ? t('编辑连接') : t('新建连接')}</span>
          <h3>{isWebSearchProvider ? t('联网搜索') : definition ? definition.name : t('选择 API 厂商')}</h3>
        </div>
        <div className="flex items-center gap-2">
          {definition?.id === 'custom-openai' && (
            <AnimatedButton
              type="button"
              className="provider-secondary-btn h-7"
              onClick={() => void handleAssistantAdd()}
            >
              <Icon icon="mdi:message-processing-outline" width="14" />
              {t('调用助手添加')}
            </AnimatedButton>
          )}
          <PopupCloseButton onClick={closeDialog} />
        </div>
      </header>

      {!definition ? (
        <div className="provider-dialog-body provider-picker-body">
          <div className="provider-picker-grid">
            {availableDefinitions.map((item) => (
              <button
                key={item.id}
                type="button"
                className="provider-picker-item"
                onClick={() => chooseDefinition(item)}
              >
                <span className={`provider-badge provider-badge--${item.id}`}>{item.badgeText}</span>
                <span className="provider-picker-copy">
                  <strong>{item.kind === 'web-search' ? t('联网搜索') : item.name}</strong>
                  <small>{item.kind === 'web-search' ? t('Tavily、博查、智谱与 Exa') : item.description}</small>
                </span>
                <Icon icon="mdi:chevron-right" width="18" />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="provider-dialog-body">
            <section className="provider-config-section">
              <div className="provider-section-heading">
                <div>
                  <h4>{t('连接信息')}</h4>
                  <p>{definition.description}</p>
                </div>
                {!editing && !isWebSearchProvider && (
                  <AnimatedButton
                    type="button"
                    className="provider-text-btn"
                    onClick={returnToDefinitionPicker}
                  >
                    {t('更换厂商')}
                  </AnimatedButton>
                )}
              </div>

              {definition.id === 'custom-openai' && (
                <div className="provider-catalog-message is-warning provider-custom-openai-warning">
                  <Icon icon="mdi:alert-circle-outline" width="16" />
                  <span>
                    {t('提示：每个中转站提供的模型和参数规则都不一样，从接口拉取下来的模型，不一定能直接拿来用。不同中转站对同一个模型的名字、传入图片、尺寸等参数往往不同，直接使用可能会报错。请先查看你所用中转站的官方文档，把对应的参数改成文档里的值。如果你不会改，可以这样做：直接把中转站的文档发给对话助手，或者开启智能体并接入 MCP，让助手照着文档帮你添加和配置。')}
                  </span>
                </div>
              )}

              {definition.id === 'custom-openai' && (
                <label className="provider-field">
                  <span>{t('连接名称')}</span>
                  <input
                    type="text"
                    value={connectionName}
                    placeholder={t('例如：团队模型网关')}
                    onChange={(event) => setConnectionName(event.target.value)}
                  />
                </label>
              )}

              {definition.authType === 'oauth' ? (
                <div className="provider-oauth-row">
                  <span className={`provider-connection-dot${dreaminaLoggedIn ? ' is-online' : ''}`} />
                  <div>
                    <strong>{dreaminaLoggedIn ? t('即梦账号已登录') : t('即梦账号未登录')}</strong>
                    <small>{t('模型调用使用桌面端 OAuth 登录态')}</small>
                  </div>
                  <AnimatedButton
                    type="button"
                    className="provider-secondary-btn"
                    disabled={dreaminaLoading}
                    onClick={onDreaminaLogin}
                  >
                    {dreaminaLoading ? t('处理中...') : dreaminaLoggedIn ? t('重新登录') : t('OAuth 登录')}
                  </AnimatedButton>
                </div>
              ) : (
                <div className="provider-fields-grid">
                  {definition.credentials.map((field) => {
                    const value = field.key === 'apiKey'
                      ? apiKey
                      : field.key === 'baseUrl'
                        ? baseUrl
                        : anthropicUrl;
                    const baseUrlLocked = field.key === 'baseUrl'
                      && definition.allowCustomBaseUrl === false;
                    return (
                      <label key={field.key} className="provider-field">
                        <span>{field.label}{field.required ? ' *' : ''}</span>
                        <input
                          type={field.secret ? 'password' : 'text'}
                          value={value}
                          placeholder={field.placeholder}
                          readOnly={baseUrlLocked}
                          disabled={baseUrlLocked}
                          onChange={(event) => {
                            if (field.key === 'apiKey') setApiKey(event.target.value);
                            else if (field.key === 'baseUrl') setBaseUrl(event.target.value);
                            else setAnthropicUrl(event.target.value);
                          }}
                          onBlur={(event) => {
                            // 补协议、去尾斜杠、剥掉误贴的 /chat/completions，
                            // 让用户在保存前就看见真正会被请求的地址
                            if (field.key === 'apiKey') return;
                            const normalized = normalizeBaseUrl(event.target.value);
                            if (field.key === 'baseUrl') setBaseUrl(normalized);
                            else setAnthropicUrl(normalized);
                          }}
                        />
                      </label>
                    );
                  })}
                  {definition.id === 'runninghub-model' && (
                    <label className="provider-field">
                      <span>{t('消费级-会员 API Key')}</span>
                      <input
                        type="password"
                        value={workflowApiKey}
                        placeholder={t('用于 RunningHub 工作流执行（可选）')}
                        onChange={(event) => setWorkflowApiKey(event.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}

              {PROVIDER_LINKS[definition.id] && (
                <button
                  type="button"
                  className="provider-external-link"
                  onClick={() => void openExternal(PROVIDER_LINKS[definition.id])}
                >
                  <Icon icon="mdi:open-in-new" width="13" />
                  {definition.id === 'grsai' ? t('前往 API Key 页面') : t('前往厂商控制台')}
                </button>
              )}

              {definition.authType !== 'oauth' && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <AnimatedButton
                    type="button"
                    className="provider-secondary-btn"
                    disabled={missingCredentials || catalogStatus === 'loading'}
                    onClick={() => void handleTestConnection()}
                  >
                    <Icon
                      icon={catalogStatus === 'loading' ? 'mdi:loading' : 'mdi:connection'}
                      className={catalogStatus === 'loading' ? 'settings-spin' : undefined}
                      width="15"
                    />
                    {catalogStatus === 'loading' ? t('验证中') : t('验证连接')}
                  </AnimatedButton>
                  {isWebSearchProvider && catalogMessage && (
                    <div className={`provider-catalog-message is-${catalogStatus} m-0 flex-1`}>
                      <Icon
                        icon={catalogStatus === 'error' ? 'mdi:alert-circle-outline' : 'mdi:information-outline'}
                        width="14"
                      />
                      <span>{catalogMessage}</span>
                    </div>
                  )}
                </div>
              )}
            </section>

            {isWebSearchProvider && (
              <section className="provider-model-section">
                <div className="provider-section-heading">
                  <div>
                    <h4>{t('搜索厂商')}</h4>
                    <p>{t('选择当前使用的服务，其他厂商密钥会保留在本地')}</p>
                  </div>
                </div>
                <div className="provider-picker-grid">
                  {webSearchDefinitions.map((item) => {
                    const selected = item.id === definition.id;
                    const configured = Boolean(providerConfigs[item.id]?.apiKey?.trim());
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={selected}
                        className={`provider-picker-item ${selected ? 'ring-1 ring-indigo-400/60 bg-indigo-500/10' : ''}`}
                        onClick={() => chooseDefinition(item)}
                      >
                        <span className={`provider-badge provider-badge--${item.id}`}>{item.badgeText}</span>
                        <span className="provider-picker-copy">
                          <strong>{item.name}</strong>
                          <small>{configured ? t('API Key 已配置') : item.description}</small>
                        </span>
                        <Icon icon={selected ? 'mdi:check-circle' : 'mdi:chevron-right'} width="18" />
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {!isWebSearchProvider && <section className="provider-model-section">
              <div className="provider-section-heading provider-model-heading">
                <div>
                  <h4>{t('启用模型')}</h4>
                  <p>{t('仅勾选会在应用中使用的模型')}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {definition.id === 'custom-openai' ? (
                    <>
                      {protocolImportSnapshot ? (
                        <AnimatedButton
                          type="button"
                          className="provider-text-btn h-7"
                          onClick={undoProtocolImport}
                        >
                          <Icon icon="mdi:undo-variant" width="14" />
                          {t('撤销导入')}
                        </AnimatedButton>
                      ) : null}
                      <AnimatedButton
                        type="button"
                        className="provider-secondary-btn h-7"
                        aria-expanded={protocolImportOpen}
                        onClick={() => setProtocolImportOpen((open) => !open)}
                      >
                        <Icon icon="mdi:file-import-outline" width="14" />
                        {t('导入文档')}
                      </AnimatedButton>
                    </>
                  ) : null}
                  <AnimatedButton
                    type="button"
                    className="provider-fetch-btn"
                    disabled={missingCredentials || catalogStatus === 'loading'}
                    onClick={() => void handleFetchModels()}
                  >
                    <Icon
                      icon={catalogStatus === 'loading' ? 'mdi:loading' : 'mdi:cloud-download-outline'}
                      className={catalogStatus === 'loading' ? 'settings-spin' : undefined}
                      width="15"
                    />
                    {catalogStatus === 'loading' ? t('拉取中') : t('拉取模型')}
                  </AnimatedButton>
                </div>
              </div>

              {definition.id === 'custom-openai' && protocolImportOpen ? (
                <ProtocolImportPanel
                  onApply={applyProtocolImport}
                  onClose={() => setProtocolImportOpen(false)}
                />
              ) : null}

              <div className="mb-3 flex min-h-8 items-center justify-between gap-3 rounded-md border border-canvas-border bg-white/[0.03] px-2.5 py-1.5">
                <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-canvas-text-secondary">
                  <Icon icon="mdi:eye-outline" width="14" />
                  {t('是否在对应类型节点中显示')}
                </span>
                <div className="flex min-w-0 flex-wrap justify-end gap-1" role="group" aria-label={t('节点列表显示分类')}>
                  <button
                    type="button"
                    aria-pressed={visibleModelCategories.size === CATEGORY_ORDER.length}
                    className={`provider-category-choice is-all h-6 rounded px-2 text-[9px] ${
                      visibleModelCategories.size === CATEGORY_ORDER.length ? 'is-active' : ''
                    }`}
                    onClick={toggleAllVisibleCategories}
                  >
                    {t('全部')}
                  </button>
                  {CATEGORY_ORDER.map((item) => (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={visibleModelCategories.has(item)}
                      className={`provider-category-choice is-${item} h-6 rounded px-2 text-[9px] ${
                        visibleModelCategories.has(item) ? 'is-active' : ''
                      }`}
                      onClick={() => toggleVisibleCategory(item)}
                    >
                      {GENERAL_MODEL_CATEGORY_LABELS[item]}
                    </button>
                  ))}
                </div>
              </div>

              {catalogMessage && (
                <div className={`provider-catalog-message is-${catalogStatus}`}>
                  <Icon
                    icon={catalogStatus === 'error' ? 'mdi:alert-circle-outline' : 'mdi:information-outline'}
                    width="14"
                  />
                  <span>{catalogMessage}</span>
                </div>
              )}

              {models.length > 0 && (
                <>
                  <div className="provider-model-toolbar">
                    <label className="provider-search">
                      <Icon icon="mdi:magnify" width="15" />
                      <input
                        type="search"
                        value={query}
                        placeholder={t('搜索模型 ID 或名称')}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                    <div className="provider-category-tabs" aria-label={t('模型类别')}>
                      <button
                        type="button"
                        aria-pressed={category === 'all'}
                        className={`provider-category-choice is-all ${category === 'all' ? 'is-active' : ''}`}
                        onClick={() => setCategory('all')}
                      >
                        {t('全部')}
                      </button>
                      {CATEGORY_ORDER.map((item) => (
                        <button
                          key={item}
                          type="button"
                          aria-pressed={category === item}
                          className={`provider-category-choice is-${item} ${category === item ? 'is-active' : ''}`}
                          onClick={() => setCategory(item)}
                        >
                          {GENERAL_MODEL_CATEGORY_LABELS[item]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="provider-model-list-head">
                    <label>
                      <input
                        type="checkbox"
                        checked={filteredModels.length > 0 && filteredModels.every((model) => selectedIds.has(model.id))}
                        onChange={toggleVisibleModels}
                      />
                      <span>{t('选择当前结果')}</span>
                    </label>
                    <span>{selectedModels.length} 个已选</span>
                  </div>

                  <div className="provider-model-list">
                    {filteredModels.length > 0 ? filteredModels.map((model) => (
                      <div
                        key={model.id}
                        className={`provider-model-row ${categoryEditModelId === model.id ? 'provider-model-row--editing' : ''}`}
                      >
                        <button
                          type="button"
                          className={`provider-model-kind is-${model.category}`}
                          aria-label={`修改 ${model.name} 的模型分类，当前为${GENERAL_MODEL_CATEGORY_LABELS[model.category]}`}
                          title="点击修改模型分类"
                          aria-expanded={categoryEditModelId === model.id}
                          onClick={() => setCategoryEditModelId((current) => current === model.id ? null : model.id)}
                        >
                          {GENERAL_MODEL_CATEGORY_LABELS[model.category]}
                        </button>
                        <label className="provider-model-select">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(model.id)}
                            onChange={() => toggleModel(model.id)}
                          />
                          <span className="provider-model-copy">
                            <strong>{model.name}</strong>
                            <small>{model.id}</small>
                          </span>
                        </label>
                        {definition.id === 'custom-openai' && selectedIds.has(model.id) ? (
                          <>
                            {model.category === 'video' ? (
                              <AnimatedButton
                                type="button"
                                className={`provider-model-protocol-btn ${model.videoCapability ? 'is-configured' : ''}`}
                                aria-label={`配置 ${model.name} 视频参数能力`}
                                title="视频参数能力"
                                onClick={() => {
                                  setVideoCapabilityModelId(model.id);
                                  setProtocolModelId(null);
                                  setProtocolValid(true);
                                }}
                              >
                                <Icon icon="lucide:video" width="16" />
                              </AnimatedButton>
                            ) : null}
                            <AnimatedButton
                              type="button"
                              className={`provider-model-protocol-btn ${model.executionProfile ? 'is-configured' : ''}`}
                              aria-label={`配置 ${model.name} 调用协议`}
                              title="调用协议"
                              onClick={() => {
                                setProtocolModelId(model.id);
                                setVideoCapabilityModelId(null);
                                setProtocolValid(true);
                              }}
                            >
                              <Icon icon="mdi:tune-variant" width="15" />
                            </AnimatedButton>
                          </>
                          ) : null}
                        {categoryEditModelId === model.id ? (
                          <div
                            className="provider-model-category-editor"
                            role="group"
                            aria-label={`选择 ${model.name} 的模型分类`}
                          >
                            <span className="provider-model-category-editor-title">分类</span>
                            {CATEGORY_ORDER.map((item) => (
                              <button
                                key={item}
                                type="button"
                                aria-pressed={model.category === item}
                                className={`provider-category-choice is-${item} ${model.category === item ? 'is-active' : ''}`}
                                onClick={() => {
                                  if (model.category === item) setCategoryEditModelId(null);
                                  else updateModelCategory(model.id, item);
                                }}
                              >
                                {GENERAL_MODEL_CATEGORY_LABELS[item]}
                              </button>
                            ))}
                            {model.category === 'text' ? (
                              <label className="provider-model-capability-toggle">
                                <input
                                  type="checkbox"
                                  checked={model.inputModalities?.includes('image') ?? false}
                                  onChange={(event) => updateModelVisionCapability(
                                    model.id,
                                    event.target.checked,
                                  )}
                                />
                                <span>支持图片输入</span>
                              </label>
                            ) : null}
                            <label className="provider-model-description-editor">
                              <span>Agent 选型说明</span>
                              <textarea
                                value={model.description ?? ''}
                                maxLength={500}
                                rows={2}
                                placeholder="例如：适合中文 OCR、角色图分析，速度快、成本低"
                                onChange={(event) => updateModelDescription(model.id, event.target.value)}
                              />
                            </label>
                          </div>
                        ) : null}
                      </div>
                    )) : (
                      <div className="provider-model-empty">没有匹配的模型</div>
                    )}
                  </div>

                  {definition.id === 'custom-openai'
                    && videoCapabilityModel
                    && videoCapabilityModel.category === 'video'
                    && selectedIds.has(videoCapabilityModel.id) ? (
                      <VideoCapabilityEditor
                        key={videoCapabilityModel.id}
                        model={videoCapabilityModel}
                        onChange={(capability) => updateVideoCapability(
                          videoCapabilityModel.id,
                          capability,
                        )}
                        onClose={() => setVideoCapabilityModelId(null)}
                      />
                    ) : null}

                  {definition.id === 'custom-openai'
                    && protocolModel
                    && selectedIds.has(protocolModel.id) ? (
                      <ModelProtocolEditor
                        key={protocolModel.id}
                        model={protocolModel}
                        onChange={(profile) => updateModelProtocol(protocolModel.id, profile)}
                        onImageReferenceRequestModeChange={(mode) => (
                          updateImageReferenceRequestMode(protocolModel.id, mode)
                        )}
                        onValidityChange={setProtocolValid}
                        onClose={closeProtocolEditor}
                      />
                    ) : null}
                </>
              )}

              {definition.id === 'custom-openai' && (
                <div className="provider-manual-model">
                  <div className="provider-manual-fields">
                    <input
                      type="text"
                      value={manualModelId}
                      placeholder="手动输入模型 ID"
                      onChange={(event) => setManualModelId(event.target.value)}
                    />
                    <input
                      type="text"
                      value={manualModelName}
                      placeholder="显示名称（可选）"
                      onChange={(event) => setManualModelName(event.target.value)}
                    />
                    <select
                      value={manualCategory}
                      onChange={(event) => setManualCategory(event.target.value as GeneralModelCategory)}
                    >
                      {CATEGORY_ORDER.map((item) => (
                        <option key={item} value={item}>{GENERAL_MODEL_CATEGORY_LABELS[item]}</option>
                      ))}
                    </select>
                    <AnimatedButton
                      type="button"
                      className="provider-icon-btn"
                      aria-label="添加手动模型"
                      disabled={!manualModelId.trim()}
                      onClick={addManualModel}
                    >
                      <Icon icon="mdi:plus" width="17" />
                    </AnimatedButton>
                  </div>
                </div>
              )}
            </section>}
          </div>

          <footer className="provider-dialog-footer">
            <span>
              {isWebSearchProvider
                ? `当前使用 ${definition.name}`
                : selectedModels.length > 0
                  ? t('将启用 {count} 个模型', { count: selectedModels.length })
                  : t('至少选择一个模型')}
            </span>
            <div>
              <AnimatedButton type="button" className="provider-secondary-btn" onClick={closeDialog}>
                {t('取消')}
              </AnimatedButton>
              <AnimatedButton
                type="button"
                className="provider-primary-btn"
                disabled={
                  missingCredentials
                  || (!isWebSearchProvider && selectedModels.length === 0)
                  || !protocolValid
                }
                onClick={() => void handleSave()}
              >
                {editing ? t('保存更改') : t('添加厂商')}
              </AnimatedButton>
            </div>
          </footer>
        </>
      )}
    </ModalOverlay>,
    document.body,
  );
}
