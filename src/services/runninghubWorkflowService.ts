/**
 * runninghubWorkflowService — 解析并校验 RunningHub 工作流定义与参数。
 */
import type { RunningHubParameter, RunningHubValue, RunningHubWorkflowManifest, RunningHubConnection } from '../types/runninghub';
import { runningHubRequest } from './ai/providers/runninghubClient';
import type { WorkflowDefinition, WorkflowIONode } from '../types';

const ID = /^\d{1,30}$/;
const SENSITIVE = /(?:api.?key|authorization|token|secret|password|cookie)/i;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_IMPORT = 1_500_000;
export const runningHubParameterKey = (field: Pick<RunningHubParameter, 'nodeId' | 'fieldName'>): string =>
  `${encodeURIComponent(field.nodeId)}::${encodeURIComponent(field.fieldName)}`;

/** 只投影明确声明的动态输入，不把模型名等普通字符串参数当成素材槽。 */
export function runningHubInputNodes(manifest: RunningHubWorkflowManifest): WorkflowIONode[] {
  return resolveRunningHubParameters(manifest.parameters).flatMap((field) => {
    const type = field.source === 'value' ? (!field.sourceExplicit ? field.inputType : undefined) : field.source;
    return type ? [{ nodeId: runningHubParameterKey(field), title: `${field.label} · #${field.nodeId} / ${field.fieldName}`.replace(/[|}\r\n]/g, ' '), type }] : [];
  });
}

export function workflowInputNodes(workflow?: WorkflowDefinition): WorkflowIONode[] {
  if (workflow?.adapterType === 'runninghub') return workflow.runninghub ? runningHubInputNodes(workflow.runninghub) : [];
  return workflow?.ioNodes ?? [];
}

export function validRunningHubDefaults(manifest: RunningHubWorkflowManifest, defaults: WorkflowDefinition['defaultNodes']) {
  const nodes = runningHubInputNodes(manifest);
  return Object.fromEntries(Object.entries(defaults ?? {}).filter(([type, id]) => nodes.some((node) => node.type === type && node.nodeId === id))) as NonNullable<WorkflowDefinition['defaultNodes']>;
}

/** 旧导入器把主提示词保存成固定值；仅修正唯一且明确的主提示词，保留手工映射。 */
export function resolveRunningHubParameters(parameters: readonly RunningHubParameter[]): RunningHubParameter[] {
  if (parameters.some((field) => field.source === 'prompt')) return [...parameters];
  const primaryNames = new Set(['prompt', 'positiveprompt', '提示词', '主提示词', '正面提示词', '正向提示词']);
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const candidates = parameters.filter((field) => {
    if (field.source !== 'value' || field.sourceExplicit || field.type !== 'string' || field.options?.length) return false;
    if (/negative|(?:^|[\s_-])neg(?:[\s_-]|prompt)|uncond|system|style|optimiz|enhanc|负面|负向|反向|系统|风格|优化|增强|扩写/i.test(`${field.fieldName} ${field.label}`)) return false;
    return primaryNames.has(normalize(field.fieldName))
      || field.label.split(/[·|]/).some((part) => {
        // 展示名称可附带“（可选，默认不用填）”；辅助提示词仍按上方完整标签排除。
        const name = part.trim().replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '');
        return primaryNames.has(normalize(name));
      });
  });
  if (candidates.length !== 1) return [...parameters];
  return parameters.map((field) => field === candidates[0] ? { ...field, source: 'prompt' } : field);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function parseRunningHubJson(text: string): unknown {
  if (text.length > MAX_IMPORT) throw new Error('RunningHub 定义超过 1.5 MB 限制');
  // 官方示例部分 ID 使用 JSON number；解析前转为字符串，避免 JS 大整数损失。
  const safeText = text.replace(/("(?:workflowId|webappId|taskId)"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"');
  try { return JSON.parse(safeText); } catch { throw new Error('RunningHub JSON 格式无效'); }
}
export function parseRunningHubId(input: string, kind: 'workflow' | 'app'): string {
  const value = input.trim();
  if (ID.test(value)) return value;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !/^(?:www\.)?runninghub\.(?:cn|ai)$/.test(url.hostname)) throw new Error();
    // 官网分享链接可带 /zh-cn/、/en/ 等语言前缀；仍只提取资源类型和字符串 ID。
    const match = /^\/(?:[a-zA-Z]{2}(?:-[a-zA-Z]{2})?\/)?(workflow|ai-detail|webapp)\/(\d{1,30})\/?$/.exec(url.pathname);
    if (!match || (kind === 'workflow' ? match[1] !== 'workflow' : match[1] === 'workflow')) throw new Error();
    return match[2];
  } catch { throw new Error(`请输入正确的 RunningHub ${kind === 'workflow' ? '工作流' : 'AI 应用'}链接或 ID`); }
}
const primitive = (value: unknown): value is RunningHubValue =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/** 只读取 curl 的 JSON 请求体，不执行命令、不接受其 URL 或鉴权配置。 */
function readImport(input: string): Record<string, unknown> {
  let text = input.trim();
  if (/^curl\s/i.test(text)) {
    const match = /(?:--data-raw|--data-binary|--data|-d)\s+'([\s\S]*?)'(?:\s|$)/.exec(text);
    if (!match) throw new Error('无法读取调用示例，请粘贴 JSON 请求体');
    text = match[1];
  }
  const parsed = parseRunningHubJson(text);
  if (!isRecord(parsed)) throw new Error('工作流定义必须是 JSON 对象');
  return isRecord(parsed.data) ? parsed.data : parsed;
}

function parameter(nodeId: string, fieldName: string, value: RunningHubValue, label: string): RunningHubParameter {
  return { nodeId, fieldName, label: label.slice(0, 160), type: typeof value as RunningHubParameter['type'], defaultValue: value, source: 'value' };
}

export function importRunningHubDefinition(
  input: string,
  options: Pick<RunningHubWorkflowManifest, 'kind' | 'remoteId' | 'connectionId'>,
): RunningHubWorkflowManifest {
  const record = readImport(input);
  const remoteId = options.remoteId ? parseRunningHubId(options.remoteId, options.kind)
    : parseRunningHubId(String(record[options.kind === 'app' ? 'webappId' : 'workflowId'] ?? ''), options.kind);
  const fields: RunningHubParameter[] = [];
  if (Array.isArray(record.nodeInfoList)) {
    for (const item of record.nodeInfoList) {
      if (!isRecord(item) || typeof item.nodeId !== 'string' || typeof item.fieldName !== 'string') throw new Error('nodeInfoList 缺少节点 ID 或字段名称');
      if (SENSITIVE.test(item.fieldName)) continue;
      let value: unknown = item.fieldValue ?? '';
      let options: RunningHubValue[] | undefined;
      let fieldData: unknown = item.fieldData;
      if (typeof fieldData === 'string' && fieldData) fieldData = parseRunningHubJson(fieldData);
      // 部分字段保留 ComfyUI INPUT_TYPES tuple；未知对象不作为参数约束读取。
      const tuple = Array.isArray(fieldData) && fieldData.length === 2
        && typeof fieldData[0] === 'string' && ['INT', 'FLOAT', 'STRING'].includes(fieldData[0]) && isRecord(fieldData[1])
        ? { type: fieldData[0].toLowerCase(), metadata: fieldData[1] } : undefined;
      const combo = Array.isArray(fieldData) && fieldData.length === 2
        && Array.isArray(fieldData[0]) && fieldData[0].every(primitive) && isRecord(fieldData[1])
        ? { options: fieldData[0] as RunningHubValue[], metadata: fieldData[1] } : undefined;
      const scalarOptions = combo?.options ?? (Array.isArray(fieldData) && fieldData.every(primitive) ? fieldData as RunningHubValue[] : undefined);
      const fieldType = String(item.fieldType || tuple?.type || '').toLowerCase();
      const tupleMatches = tuple && (fieldType === tuple.type
        || (fieldType === 'number' && ['int', 'float'].includes(tuple.type)));
      if (Array.isArray(fieldData)) {
        options = fieldData.flatMap((entry) => isRecord(entry) && primitive(entry.index) ? [entry.index] : []);
        const defaults = combo?.metadata ?? fieldData.find((entry) => isRecord(entry) && primitive(entry.default));
        if (item.fieldValue === undefined && isRecord(defaults) && primitive(defaults.default) && (!tuple || tupleMatches)) value = defaults.default;
      }
      if (!primitive(value)) throw new Error('暂不支持此字段的复合值，请选择标量参数');
      const field = parameter(item.nodeId, item.fieldName, value, String(item.description || item.fieldName));
      if (fieldType === 'int' || fieldType === 'float' || fieldType === 'number') {
        field.type = 'number'; field.defaultValue = Number(value);
      } else if (fieldType === 'boolean') {
        field.type = 'boolean'; field.defaultValue = value === true || value === 'true';
      }
      if (['image', 'video', 'audio'].includes(fieldType)) {
        field.source = fieldType as 'image' | 'video' | 'audio';
        field.referenceIndex = fields.filter((entry) => entry.source === field.source).length;
        field.mediaFormat = 'filename';
      }
      if (tuple && tupleMatches && field.source === 'value') {
        if (field.type === 'number' && ['int', 'float'].includes(tuple.type)) {
          for (const key of ['min', 'max', 'step'] as const) {
            const declared = tuple.metadata[key];
            if (typeof declared === 'number' && Number.isFinite(declared) && (key !== 'step' || declared > 0)) field[key] = declared;
          }
          if (tuple.type === 'int' && tuple.metadata.step === undefined) field.step = 1;
        } else if (field.type === 'string' && tuple.type === 'string' && typeof tuple.metadata.multiline === 'boolean') {
          field.multiline = tuple.metadata.multiline;
        }
      }
      if (scalarOptions?.length && scalarOptions.every((option) => typeof option === field.type)) options = scalarOptions;
      // 媒体 fieldData 中的文件候选来自服务端目录，不限制本轮上传的文件名。
      if (field.source === 'value' && options?.length) field.options = options;
      fields.push(field);
    }
  } else if (options.kind === 'app' && typeof record.curl === 'string') {
    return importRunningHubDefinition(record.curl, { ...options, remoteId });
  } else {
    if (options.kind === 'app') throw new Error('AI 应用定义缺少 nodeInfoList，请从官方 API 调用示例导入');
    const graph = typeof record.prompt === 'string' ? parseRunningHubJson(record.prompt) : record;
    if (!isRecord(graph) || Array.isArray(graph.nodes)) throw new Error('请使用 ComfyUI「导出工作流 API」格式');
    for (const [nodeId, node] of Object.entries(graph)) {
      if (!isRecord(node) || !isRecord(node.inputs) || typeof node.class_type !== 'string') continue;
      const title = isRecord(node._meta) && typeof node._meta.title === 'string' ? node._meta.title : node.class_type;
      for (const [fieldName, value] of Object.entries(node.inputs)) {
        if (!primitive(value) || SENSITIVE.test(fieldName)) continue;
        const field = parameter(nodeId, fieldName, value, `${title} · ${fieldName}`);
        if (node.class_type === 'CLIPTextEncode' && fieldName === 'text' && typeof value === 'string') field.inputType = 'prompt';
        const media = ({ LoadImage: ['image', 'image'], H3OptionalPicture3: ['image', 'image'], LoadAudio: ['audio', 'audio'], VHS_LoadVideo: ['video', 'video'], LoadImageFromUrl: ['image', 'image'] } as Record<string, string[]>)[node.class_type];
        if (media && fieldName === media[1]) {
          field.source = media[0] as 'image' | 'video' | 'audio';
          field.referenceIndex = fields.filter((entry) => entry.source === field.source).length;
          field.mediaFormat = node.class_type === 'LoadImageFromUrl' ? 'url' : 'filename';
        }
        fields.push(field);
      }
    }
  }
  const manifest: RunningHubWorkflowManifest = { version: 1, ...options, remoteId, parameters: resolveRunningHubParameters(fields) };
  validateRunningHubManifest(manifest);
  return manifest;
}

export function validateRunningHubManifest(value: RunningHubWorkflowManifest): void {
  const allowed = new Set(['version', 'kind', 'remoteId', 'connectionId', 'parameters', 'inputBindingMode', 'outputNodeIds', 'instanceType', 'usePersonalQueue']);
  const fieldKeys = new Set(['nodeId', 'fieldName', 'label', 'type', 'defaultValue', 'required', 'options', 'min', 'max', 'step', 'multiline', 'source', 'sourceExplicit', 'inputType', 'referenceIndex', 'mediaFormat']);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) throw new Error('RunningHub 工作流包含不支持的配置字段');
  if (!value || value.version !== 1 || !['workflow', 'app'].includes(value.kind) || !ID.test(value.remoteId)
    || !['runninghub', 'runninghub-model'].includes(value.connectionId) || !Array.isArray(value.parameters)
    || value.parameters.length > 200) throw new Error('RunningHub 工作流定义无效');
  const keys = new Set<string>();
  if (value.inputBindingMode !== undefined && value.inputBindingMode !== 'nodes') throw new Error('RunningHub 输入绑定模式无效');
  for (const field of value.parameters) {
    if (!isRecord(field) || Object.keys(field).some((key) => !fieldKeys.has(key))
      || (field.required !== undefined && typeof field.required !== 'boolean')
      || (field.sourceExplicit !== undefined && typeof field.sourceExplicit !== 'boolean')
      || (field.inputType !== undefined && (field.inputType !== 'prompt' || field.type !== 'string'))
      || (typeof field.defaultValue === 'string' && /^(?:[a-z]:[\\/]|\\\\|file:)/i.test(field.defaultValue))) throw new Error('RunningHub 参数不能包含额外配置或本地文件路径');
    if (!field || typeof field.nodeId !== 'string' || !/^[\w:-]{1,120}$/.test(field.nodeId)
      || typeof field.fieldName !== 'string' || !field.fieldName || field.fieldName.length > 160 || UNSAFE_KEYS.has(field.fieldName) || SENSITIVE.test(field.fieldName)
      || typeof field.label !== 'string' || field.label.length > 160
      || !['string', 'number', 'boolean'].includes(field.type) || !primitive(field.defaultValue)
      || typeof field.defaultValue !== field.type || (typeof field.defaultValue === 'string' && field.defaultValue.length > 100_000)
      || !['value', 'prompt', 'image', 'video', 'audio'].includes(field.source)
      || (field.source !== 'value' && field.type !== 'string')
      || (field.referenceIndex !== undefined && (!Number.isInteger(field.referenceIndex) || field.referenceIndex < 0 || field.referenceIndex > 31))
      || (field.mediaFormat !== undefined && !['filename', 'url'].includes(field.mediaFormat))
      || (field.options !== undefined && (!Array.isArray(field.options) || field.options.length > 200 || field.options.some((option) => !primitive(option) || typeof option !== field.type)))) {
      throw new Error('RunningHub 参数定义无效，请检查类型与素材映射');
    }
    const hasNumericMetadata = field.min !== undefined || field.max !== undefined || field.step !== undefined;
    if ((hasNumericMetadata && field.type !== 'number')
      || (field.min !== undefined && (typeof field.min !== 'number' || !Number.isFinite(field.min)))
      || (field.max !== undefined && (typeof field.max !== 'number' || !Number.isFinite(field.max)))
      || (field.step !== undefined && (typeof field.step !== 'number' || !Number.isFinite(field.step) || field.step <= 0))
      || (field.min !== undefined && field.max !== undefined && field.min > field.max)
      || (typeof field.defaultValue === 'number' && ((field.min !== undefined && field.defaultValue < field.min) || (field.max !== undefined && field.defaultValue > field.max)))
      || (field.multiline !== undefined && (typeof field.multiline !== 'boolean' || field.type !== 'string'))) {
      throw new Error('RunningHub 参数范围或展示定义无效');
    }
    const key = runningHubParameterKey(field);
    if (keys.has(key)) throw new Error('RunningHub 参数包含重复的节点/字段');
    keys.add(key);
  }
  if (value.instanceType !== undefined && !['default', 'plus'].includes(value.instanceType)) throw new Error('无效的 RunningHub 实例类型');
  if (value.usePersonalQueue !== undefined && typeof value.usePersonalQueue !== 'boolean') throw new Error('无效的队列选项');
  if (value.outputNodeIds !== undefined && (!Array.isArray(value.outputNodeIds) || value.outputNodeIds.length > 32 || value.outputNodeIds.some((id) => typeof id !== 'string' || !/^[\w:-]{1,120}$/.test(id)))) throw new Error('无效的输出节点 ID');
}

export function runningHubFieldValue(field: RunningHubParameter, input?: string): RunningHubValue {
  let value: RunningHubValue = input ?? field.defaultValue;
  if (input !== undefined && field.type === 'number') {
    if (!input.trim() || !Number.isFinite(Number(input))) throw new Error(`${field.label} 必须是数字`);
    value = Number(input);
  } else if (input !== undefined && field.type === 'boolean') {
    if (!['true', 'false'].includes(input)) throw new Error(`${field.label} 必须是布尔值`);
    value = input === 'true';
  }
  if (field.required && value === '') throw new Error(`请填写${field.label}`);
  if (typeof value === 'number' && ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) throw new Error(`${field.label} 超出允许范围`);
  if (field.source === 'value' && field.options?.length && !field.options.includes(value)) throw new Error(`${field.label} 不在允许的选项中`);
  return value;
}

export async function fetchRunningHubDefinition(
  connection: RunningHubConnection,
  options: Pick<RunningHubWorkflowManifest, 'kind' | 'remoteId' | 'connectionId'>,
  signal?: AbortSignal,
): Promise<RunningHubWorkflowManifest> {
  const remoteId = parseRunningHubId(options.remoteId, options.kind);
  const response = options.kind === 'app'
    ? await runningHubRequest(connection, '/api/webapp/apiCallDemo', { webappId: remoteId }, signal, 'GET')
    : await runningHubRequest(connection, '/api/openapi/getJsonApiFormat', { workflowId: remoteId }, signal);
  return importRunningHubDefinition(JSON.stringify(response), { ...options, remoteId });
}
