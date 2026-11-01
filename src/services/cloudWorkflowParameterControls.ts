/**
 * cloudWorkflowParameterControls — 将云工作流参数定义转换为通用控件语义。
 */
export type CloudWorkflowParameterSemantic = 'ratio' | 'resolution' | 'duration' | 'other';
export type CloudWorkflowParameterValue = string | number | boolean;

export interface CloudWorkflowParameterControlSpec {
  name: string;
  label: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  value: string;
  options?: readonly CloudWorkflowParameterValue[];
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
}

export interface CloudWorkflowParameterOption {
  value: string;
  label: string;
}

export interface CloudWorkflowParameterControl {
  kind: 'ratio-options' | 'segments' | 'select' | 'options-slider' | 'number-slider' | 'ratio-input' | 'number' | 'text' | 'textarea';
  semantic: CloudWorkflowParameterSemantic;
  options: CloudWorkflowParameterOption[];
  /** 离散滑块按原始选项索引拖动，不补造中间值。 */
  sliderOptions: CloudWorkflowParameterOption[];
  specialOptions: CloudWorkflowParameterOption[];
  currentOptionIndex: number;
}

/** 语义只决定展示方式；调用方始终使用工作流原有字段名和值。 */
export function getCloudWorkflowParameterSemantic(name: string, label: string): CloudWorkflowParameterSemantic {
  const identify = (text: string): CloudWorkflowParameterSemantic => {
    const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
    if (/宽高比|画面比例|图像比例|画幅比例|宽高比例|(?:^|\s)(?:aspect\s+ratio|ratio)(?:\s|$)/.test(words)) return 'ratio';
    if (/分辨率|解析度|(?:^|\s)(?:resolution|megapixels)(?:\s|$)/.test(words)) return 'resolution';
    if (/时长|持续时间|(?:^|\s)duration(?:\s|$)/.test(words)) return 'duration';
    return 'other';
  };
  // “分辨率选择器 · MULTIPLE”等标题包含节点名，不能据此把每个字段都当作分辨率。
  const semantic = identify(name);
  return semantic === 'other' ? identify(label.split(/[·|]/).at(-1) ?? '') : semantic;
}

/** 仅调整参数浮层的展示顺序；同优先级沿用定义顺序，不修改参数身份或提交值。 */
export function getCloudWorkflowParameterPriority(name: string, label: string): number {
  const semantic = getCloudWorkflowParameterSemantic(name, label);
  const candidates = [name, label.split(/[·|]/).at(-1) ?? ''].map((value) => value
    .replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').toLowerCase().replace(/[\s_-]+/g, ''));
  if (semantic === 'resolution' || candidates.some((value) => /^(?:width|height|imagewidth|imageheight|宽度|高度|图像宽度|图像高度)$/.test(value))) return 0;
  if (semantic === 'ratio') return 1;
  if (semantic === 'duration') return 2;
  const common = [
    /^(?:steps|numsteps|inferencesteps|numinferencesteps|samplingsteps|stepcount|总步数|采样步数|绘制步数|推理步数|迭代步数|步数)(?:steps)?$/,
    /^(?:count|n|batchsize|batchcount|numimages|imagecount|numberofimages|numoutputs|numframes|fps|出几张|出图数量|生成数量|图片数量|张数|帧数|帧率)$/,
    /^(?:cfg|cfgscale|guidance|guidancescale|引导强度|引导系数|提示词引导|提示词相关性)$/,
    /^(?:denoise|denoisestrength|strength|重绘幅度|重绘强度|重绘自由度)(?:denoise)?$/,
    /^(?:seed|noiseseed|randomseed|种子|随机种子)$/,
    /^(?:sampler|samplername|采样器|采样器名称)$/,
    /^(?:scheduler|schedulername|调度器)$/,
  ];
  const index = common.findIndex((pattern) => candidates.some((value) => pattern.test(value)));
  return index < 0 ? 100 : index + 3;
}

// ComfyUI comfy_extras/nodes_resolution.py 的 ResolutionSelector 合同。
// API 图只保存当前值；仅为可识别的原版节点补展示元数据，不改写工作流定义或执行校验。
const RESOLUTION_SELECTOR_RATIOS = [
  '1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '3:4 (Portrait Standard)',
  '4:3 (Standard)', '3:2 (Photo)', '2:3 (Portrait Photo)', '21:9 (Ultrawide)',
];

export function resolveCloudWorkflowParameterSpec(spec: CloudWorkflowParameterControlSpec): CloudWorkflowParameterControlSpec {
  const nodeTitle = spec.label.split(/[·|]/)[0].trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!['resolutionselector', '分辨率选择器'].includes(nodeTitle)) return spec;
  const name = spec.name.toLowerCase().replace(/[\s_-]+/g, '');
  if (name === 'aspectratio' && spec.type === 'string') {
    return { ...spec, options: spec.options?.length ? spec.options : RESOLUTION_SELECTOR_RATIOS };
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    if (name === 'megapixels') return { ...spec, min: spec.min ?? 0.1, max: spec.max ?? 16, step: spec.step ?? 0.1 };
    if (name === 'multiple') return { ...spec, min: spec.min ?? 8, max: spec.max ?? 128, step: spec.step ?? 4 };
  }
  return spec;
}

/** 调度器枚举统一用下拉；不把名称相似的说明字段当成调度器。 */
export function isCloudWorkflowScheduler(name: string, label: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return ['scheduler', 'schedulername'].includes(normalize(name))
    || label.split(/[·|]/).some((part) => ['调度器', 'scheduler', 'schedulername'].includes(normalize(part)));
}

function optionLabel(value: string, semantic: CloudWorkflowParameterSemantic, type: CloudWorkflowParameterControlSpec['type']): string {
  if (value === '') return '空值';
  if (type === 'boolean') {
    if (value === 'true') return '启用';
    if (value === 'false') return '关闭';
  }
  if (semantic === 'ratio') {
    const ratio = value.match(/^\s*(\d+(?:\.\d+)?\s*[:：]\s*\d+(?:\.\d+)?)(?=\s|\(|$)/)?.[1];
    if (ratio) return ratio.replace(/\s/g, '').replace('：', ':');
  }
  return value;
}

function specialSliderValue(value: string): boolean {
  const text = value.trim();
  return text === '' || /^(auto|automatic|adaptive|default|自动|自适应|默认)$/i.test(text)
    || (Number.isFinite(Number(text)) && Number(text) < 0);
}

export function resolveCloudWorkflowParameterControl(spec: CloudWorkflowParameterControlSpec): CloudWorkflowParameterControl {
  spec = resolveCloudWorkflowParameterSpec(spec);
  const semantic = getCloudWorkflowParameterSemantic(spec.name, spec.label);
  const sourceOptions = spec.options?.length ? spec.options : spec.type === 'boolean' ? [true, false] : [];
  const options = [...new Set(sourceOptions.map(String))].map((value) => ({ value, label: optionLabel(value, semantic, spec.type) }));
  const sliderOptions = spec.type !== 'boolean' && (semantic === 'duration' || semantic === 'resolution')
    ? options.filter((option) => !specialSliderValue(option.value)) : [];
  const specialOptions = options.filter((option) => !sliderOptions.includes(option));
  const currentOptionIndex = sliderOptions.findIndex((option) => option.value === spec.value);
  const common = { semantic, options, sliderOptions, specialOptions, currentOptionIndex };

  if (options.length) {
    if (semantic === 'ratio' && spec.type === 'string') return { ...common, kind: 'ratio-options' };
    if (isCloudWorkflowScheduler(spec.name, spec.label)) return { ...common, kind: 'select' };
    if (sliderOptions.length) return { ...common, kind: 'options-slider' };
    const shortOptions = options.length >= 2 && options.length <= 8 && options.every((option) => option.label.length <= 18)
      && options.reduce((total, option) => total + option.label.length, 0) <= 80;
    return { ...common, kind: shortOptions ? 'segments' : 'select' };
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    return { ...common, kind: semantic === 'duration' || semantic === 'resolution' ? 'number-slider' : 'number' };
  }
  if (semantic === 'ratio') return { ...common, kind: 'ratio-input' };
  const multiline = spec.multiline ?? (/[\r\n]/.test(spec.value) || spec.value.length > 100);
  return { ...common, kind: multiline ? 'textarea' : 'text' };
}

export interface CloudWorkflowSliderBounds {
  min: number;
  max: number;
  step: number;
  precision: number;
  declared: boolean;
}

function decimalPlaces(value: number): number {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e');
  return Math.min(12, Math.max(0, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent)));
}

export function formatCloudWorkflowSliderValue(value: number, precision: number): string {
  return String(Number(value.toFixed(Math.min(12, Math.max(0, precision)))));
}

/** 优先使用工作流声明，缺失边界采用用户确认的文档范围，不随当前值改变。 */
export function createCloudWorkflowSliderBounds(spec: CloudWorkflowParameterControlSpec): CloudWorkflowSliderBounds {
  spec = resolveCloudWorkflowParameterSpec(spec);
  const semantic = getCloudWorkflowParameterSemantic(spec.name, spec.label);
  const defaults = semantic === 'resolution' ? { min: 0.2, max: 4, step: 0.1 }
    : { min: 2, max: 30, step: 1 };
  const knownMin = spec.min !== undefined && Number.isFinite(spec.min) ? spec.min : undefined;
  const knownMax = spec.max !== undefined && Number.isFinite(spec.max) ? spec.max : undefined;
  const declared = knownMin !== undefined && knownMax !== undefined;
  const explicitStep = spec.step !== undefined && Number.isFinite(spec.step) && spec.step > 0 ? spec.step : undefined;
  const step = spec.type === 'integer' ? Math.max(1, Math.round(explicitStep ?? 1)) : explicitStep ?? defaults.step;
  let min = knownMin ?? defaults.min;
  let max = knownMax ?? defaults.max;
  if (spec.type === 'integer') min = Math.ceil(min);
  if (spec.type === 'integer') max = Math.floor(max);
  // 单侧声明与默认区间不相交时仍提供真实边界值，不能造出反向区间。
  if (knownMin !== undefined && knownMax === undefined) max = Math.max(min, max);
  if (knownMax !== undefined && knownMin === undefined) min = Math.min(min, max);
  const precision = spec.type === 'integer' ? 0 : Math.max(decimalPlaces(min), decimalPlaces(max), decimalPlaces(step));
  return { min: Number(formatCloudWorkflowSliderValue(min, precision)), max: Number(formatCloudWorkflowSliderValue(max, precision)), step, precision, declared };
}

export function cloudWorkflowSliderTicks(bounds: CloudWorkflowSliderBounds): string[] {
  if (![bounds.min, bounds.max, bounds.step].every(Number.isFinite) || bounds.max < bounds.min || !(bounds.step > 0)) return [];
  if (bounds.max === bounds.min) return [formatCloudWorkflowSliderValue(bounds.min, bounds.precision)];
  const intervals = Math.floor((bounds.max - bounds.min) / bounds.step + 1e-9);
  if (!Number.isFinite(intervals)) return [bounds.min, bounds.max].map((value) => formatCloudWorkflowSliderValue(value, bounds.precision));
  const count = Math.min(7, intervals + 1);
  if (count < 2) return [formatCloudWorkflowSliderValue(bounds.min, bounds.precision)];
  return [...new Set(Array.from({ length: count }, (_, index) => formatCloudWorkflowSliderValue(
    bounds.min + Math.round(index / (count - 1) * intervals) * bounds.step, bounds.precision,
  )))];
}
