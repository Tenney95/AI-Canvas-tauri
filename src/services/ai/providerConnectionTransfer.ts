/**
 * 连接配置的导出 / 导入。
 *
 * 中转站连接里最花时间的是模型清单和逐个模型的执行协议，导出成一段 JSON 就能分享
 * 或在多台机器间搬运。**导出永远不含 API Key**（凭据在 Rust 侧凭据存储里，配置对象
 * 里的明文只存在于内存），导入端也一律丢弃 payload 里的 apiKey / apiKeyRef，
 * 由用户自己补填。
 *
 * 导入的内容是外部数据：模型协议里的自定义请求会带着用户的 API Key 发出去，
 * 所以这里按白名单挑字段、规范化 Base URL，并用 validateModelExecutionProtocol
 * 拒绝非法协议并返回逐模型诊断；调用方必须在全部校验通过后才保存。
 */
import type {
  ApiProviderConfig,
  ChatApiProtocol,
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
  WorkflowDefinition,
} from '../../types';
import type { WorkflowApiDraft, WorkflowApiManifest } from '../../types/workflowApi';
import { editableWorkflowApiManifest } from '../workflowApi/workflowApiDefinition';
import { createAutodlH3WorkflowManifest, normalizeWorkflowApiBaseUrl, validateWorkflowApiManifest } from '../workflowApi/autodlWorkflowManifest';
import { GENERAL_MODEL_CATEGORY_LABELS } from '../../types';
import { validateModelExecutionProtocol } from './modelProtocol';
import { normalizeBaseUrl } from './providerBaseUrl';
import { isChatApiProtocol, resolveChatApiProtocol } from './chatApiProtocol';
import { assertModelCapabilityProtocol, isModelProtocolPresetId } from './modelCapabilityValidation';
import { parsePluginProtocolReference } from '../plugins/pluginProtocolPresetService';
import { assertVideoModelCapability } from './videoRequestResolver';
import { getProviderDefinition, resolveProviderImageModelForValidation, type ProviderDefinition } from './providerCatalogService';

const SHARE_KIND = 'ai-canvas/provider-connection';
const SHARE_VERSION = 1;

const CATEGORIES = Object.keys(GENERAL_MODEL_CATEGORY_LABELS) as GeneralModelCategory[];
const IMAGE_REFERENCE_MODES: ImageReferenceRequestMode[] = [
  'generation-json-image-urls',
  'generation-json-image-data-urls',
  'edits-multipart',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 序列化一个连接（不含凭据），用于 JSON 文件或剪贴板分享。 */
export function serializeConnection(config: ApiProviderConfig, workflows: WorkflowDefinition[] = []): string {
  const customWorkflow = ['workflow-api', 'autodl-workflow'].includes(config.catalogId ?? '');
  const workflowApis = customWorkflow ? workflows.filter((workflow) => workflow.adapterType === 'workflow-api').map((workflow) => {
    validateWorkflowApiManifest(workflow.workflowApi);
    return { name: workflow.name, manifest: { ...workflow.workflowApi, connectionId: 'shared-connection' } };
  }) : undefined;
  const manifest = config.catalogId === 'autodl-workflow'
    ? workflows.find((workflow) => workflow.adapterType === 'workflow-api')?.workflowApi ?? createAutodlH3WorkflowManifest('shared-connection') : undefined;
  if (manifest) validateWorkflowApiManifest(manifest);
  return JSON.stringify({
    kind: SHARE_KIND,
    version: SHARE_VERSION,
    ...(manifest ? { workflowApi: { ...manifest, connectionId: 'shared-connection' } } : {}),
    ...(workflowApis?.length ? { workflowApis } : {}),
    connection: {
      name: config.name,
      catalogId: config.catalogId,
      ...(config.catalogId === 'cccapi' ? { cccGroup: config.cccGroup } : {}),
      ...(config.catalogId === 'relayonapi' ? { relayonGroup: config.relayonGroup } : {}),
      baseUrl: config.baseUrl,
      chatApiProtocol: resolveChatApiProtocol(config.chatApiProtocol),
      selectedModels: config.selectedModels,
      catalogModels: config.catalogModels,
      visibleModelCategories: config.visibleModelCategories,
    },
  }, null, 2);
}

export interface ConnectionImportDiagnostic {
  modelId?: string;
  modelName?: string;
  /** 仅使用校验器生成的位置，不回显请求体、凭据或任意输入字段。 */
  path: string;
  message: string;
}

function protocolDiagnostic(error: string): { field: string; message: string } {
  const polling = error.startsWith('轮询') || error.startsWith('异步轮询');
  const field = polling ? 'poll' : 'submit';
  if (/使用了不允许的变量|不安全的变量路径/.test(error)) {
    return { field, message: '请求包含不支持或不安全的变量，请使用编辑器列出的可用变量' };
  }
  if (/headers|Header|鉴权字段|鉴权配置|鉴权类型|鉴权前缀/.test(error)) {
    return { field: /鉴权/.test(error) ? 'auth' : `${field}.headers`, message: '鉴权或请求头配置无效，请在调用协议编辑器中检查；密钥由连接注入' };
  }
  if (/taskIdPath|任务 ID 路径/.test(error)) return { field: 'response.taskIdPath', message: '任务 ID 路径无效，请填写提交响应中的任务 ID 字段路径' };
  if (/任务 ID 变量|本次提交响应中的任务 ID/.test(error)) {
    return { field: 'poll', message: '查询请求必须引用提交响应中的任务 ID，不能写死任务编号' };
  }
  if (/pathMode/.test(error)) return { field: `${field}.pathMode`, message: '路径基准只支持 append 或 origin' };
  if (/ path/.test(error)) return { field: `${field}.path`, message: '请求路径无效，请使用非空的同源相对路径' };
  if (/method/.test(error)) return { field: `${field}.method`, message: '请求方法只支持当前协议允许的 GET 或 POST' };
  if (/结果下载/.test(error)) return { field: 'poll.response.result.download', message: '结果下载配置无效，请检查同源 GET 路径、任务 ID 引用和互斥的结果映射' };
  if (/MIME|结果|Base64|文本路径|URL 路径/.test(error)) {
    return { field: polling ? 'poll.response.result' : 'response.result', message: '结果映射无效，请检查结果路径、MIME 类型与返回格式' };
  }
  if (/状态路径|成功状态|失败状态/.test(error)) return { field: 'poll.response', message: '查询状态映射无效，请按接口文档填写状态字段及成功、失败值' };
  if (/version/.test(error)) return { field: 'version', message: '协议版本或响应字段布局无效，当前支持 version 1 与 version 2' };
  if (/mode/.test(error)) return { field: 'mode', message: '执行模式只支持 sync 或 async' };
  if (/请求体|条件项|数组展开项/.test(error)) return { field: `${field}.body`, message: '请求体编码、条件项或数组展开配置无效，请在调用协议编辑器中检查' };
  return { field: polling ? 'poll' : '', message: '调用协议格式无效，请在调用协议编辑器中检查对应字段' };
}

function parseModel(value: unknown, path: string, diagnostics: ConnectionImportDiagnostic[], definition: ProviderDefinition | undefined): ProviderModelSelection | null {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: '模型配置必须是 JSON 对象' });
    return null;
  }
  const id = asString(value.id);
  const identify = { modelId: id?.slice(0, 120), modelName: (asString(value.name) || id)?.slice(0, 120) };
  const diagnose = (field: string, message: string) => diagnostics.push({ ...identify, path: field ? `${path}.${field}` : path, message });
  if (!id) { diagnose('id', '模型 ID 不能为空'); return null; }
  if (value.category !== undefined && !CATEGORIES.includes(value.category as GeneralModelCategory)) {
    diagnose('category', '模型类别只支持 text、image、video 或 audio');
    return null;
  }
  const category = CATEGORIES.includes(value.category as GeneralModelCategory)
    ? value.category as GeneralModelCategory
    : 'text';

  const model: ProviderModelSelection = {
    id,
    name: asString(value.name) || id,
    category,
    // provider 由调用方按新连接 ID 重写，这里先占位
    provider: '',
    categoryManual: value.categoryManual === true,
  };
  const description = asString(value.description);
  if (description) model.description = description.slice(0, 500);
  if (typeof value.contextWindow === 'number' && Number.isFinite(value.contextWindow)) {
    model.contextWindow = Math.max(0, Math.floor(value.contextWindow));
  }
  if (Array.isArray(value.inputModalities)) {
    model.inputModalities = value.inputModalities.filter(
      (item): item is 'text' | 'image' => item === 'text' || item === 'image',
    );
  }
  if (value.videoCapability !== undefined && !isRecord(value.videoCapability)) {
    diagnose('videoCapability', '视频能力必须是 JSON 对象，未确认的可选参数可以不声明');
    return null;
  }
  if (isRecord(value.videoCapability)) {
    model.videoCapability = value.videoCapability as ProviderModelSelection['videoCapability'];
  }
  if (value.imageCapability !== undefined && !isRecord(value.imageCapability)) {
    diagnose('imageCapability', '图片能力必须是 JSON 对象，未确认的可选参数可以不声明');
    return null;
  }
  if (isRecord(value.imageCapability)) {
    model.imageCapability = value.imageCapability as ProviderModelSelection['imageCapability'];
  }
  if (IMAGE_REFERENCE_MODES.includes(value.imageReferenceRequestMode as ImageReferenceRequestMode)) {
    model.imageReferenceRequestMode = value.imageReferenceRequestMode as ImageReferenceRequestMode;
  }

  const profile = value.executionProfile;
  if (profile !== undefined) {
    if (!isRecord(profile) || !isModelProtocolPresetId(profile.preset)) {
      diagnose('executionProfile.preset', '调用协议预设不受当前应用支持，请使用当前版本提供的预设或自定义协议');
      return null;
    }
    if (profile.preset === 'plugin') {
      try {
        if (profile.protocol !== undefined) throw new Error('mixed');
        model.executionProfile = { preset: 'plugin', plugin: parsePluginProtocolReference(profile.plugin) };
      } catch {
        diagnose('executionProfile.plugin', '插件预设引用无效，请保留 pluginId 与 presetId；不能混用自定义协议');
        return null;
      }
    } else if (profile.plugin !== undefined) {
      diagnose('executionProfile.plugin', '仅插件预设可以包含插件引用');
      return null;
    } else if (profile.preset !== 'custom') {
      model.executionProfile = { preset: profile.preset };
    } else {
      const errors = validateModelExecutionProtocol(profile.protocol);
      if (errors.length) {
        for (const error of errors) {
          const issue = protocolDiagnostic(error);
          diagnose(`executionProfile.protocol${issue.field ? `.${issue.field}` : ''}`, issue.message);
        }
        return null;
      }
      model.executionProfile = {
        preset: 'custom',
        protocol: profile.protocol as never,
      };
    }
  }
  try {
    if (model.category === 'video') assertVideoModelCapability(model.videoCapability);
    assertModelCapabilityProtocol(resolveProviderImageModelForValidation(definition, model));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/response\.result/.test(message)) {
      const resultField = message.startsWith('poll.') ? 'poll.response.result' : 'response.result';
      const field = `${resultField}${message.includes('.mimeType') ? '.mimeType' : ''}`;
      diagnose(`executionProfile.protocol.${field}`, '结果类型与模型类别不一致，请为文本配置文本结果，为图片、视频或音频配置对应媒体结果');
    } else if (/executionProfile\.preset/.test(message)) {
      diagnose('executionProfile.preset', '调用协议预设与模型类别不匹配，请选择对应类别的协议');
    } else {
      diagnose(model.category === 'image' ? 'imageCapability' : 'videoCapability', '参数能力无效，或可调参数未在提交协议中映射；未确认的可选参数可以不声明');
    }
    return null;
  }
  return model;
}

function parseModels(value: unknown, path: string, diagnostics: ConnectionImportDiagnostic[], definition: ProviderDefinition | undefined): ProviderModelSelection[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { diagnostics.push({ path, message: '模型列表必须是 JSON 数组' }); return undefined; }
  return value
    .map((model, index) => parseModel(model, `${path}.${index}`, diagnostics, definition))
    .filter((model): model is ProviderModelSelection => model !== null);
}

export interface ParsedConnectionShare {
  /** 目录定义 ID（custom-openai / apimart ...）；缺失时按自定义接口处理。 */
  catalogId: string;
  config: ApiProviderConfig;
  /** 非空时整个导入必须拒绝；config 仅供本地预览，不可部分保存。 */
  diagnostics: ConnectionImportDiagnostic[];
  workflowApi?: WorkflowApiManifest;
  workflowApiDrafts?: WorkflowApiDraft[];
}

/** 解析连接 JSON；格式不符返回 null。 */
export function parseConnectionShare(text: string): ParsedConnectionShare | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.kind !== SHARE_KIND) return null;
  const source = isRecord(payload.connection) ? payload.connection : null;
  if (!source) return null;

  const catalogId = asString(source.catalogId) || 'custom-openai';
  const definition = getProviderDefinition(catalogId);
  let workflowApi: WorkflowApiManifest | undefined;
  let workflowApiDrafts: WorkflowApiDraft[] | undefined;
  const customWorkflow = ['workflow-api', 'autodl-workflow'].includes(catalogId);
  if (customWorkflow || payload.workflowApi !== undefined || payload.workflowApis !== undefined) {
    try {
      if (!customWorkflow || !asString(source.baseUrl)) return null;
      normalizeWorkflowApiBaseUrl(asString(source.baseUrl), true);
      if (payload.workflowApis !== undefined) {
        if (!Array.isArray(payload.workflowApis) || !payload.workflowApis.length || payload.workflowApis.length > 50) return null;
        workflowApiDrafts = payload.workflowApis.map((item) => {
          if (!isRecord(item) || !asString(item.name) || String(item.name).length > 120) throw new Error('工作流名称无效');
          validateWorkflowApiManifest(item.manifest);
          return { id: crypto.randomUUID(), name: String(item.name), manifest: editableWorkflowApiManifest(item.manifest) };
        });
      } else {
        validateWorkflowApiManifest(payload.workflowApi);
        workflowApi = payload.workflowApi;
        workflowApiDrafts = [{ id: crypto.randomUUID(), name: '导入的工作流', manifest: editableWorkflowApiManifest(workflowApi) }];
      }
    } catch { return null; }
  }
  const chatApiProtocol: ChatApiProtocol = isChatApiProtocol(source.chatApiProtocol)
    ? source.chatApiProtocol
    : 'openai-compatible';
  const visible = Array.isArray(source.visibleModelCategories)
    ? CATEGORIES.filter((item) => (source.visibleModelCategories as unknown[]).includes(item))
    : undefined;
  const diagnostics: ConnectionImportDiagnostic[] = [];

  return {
    catalogId,
    diagnostics,
    ...(workflowApi ? { workflowApi } : {}),
    ...(workflowApiDrafts ? { workflowApiDrafts } : {}),
    config: {
      name: asString(source.name) || '导入的连接',
      // 凭据永远不随配置流转，由用户重新填写
      apiKey: '',
      baseUrl: customWorkflow ? normalizeWorkflowApiBaseUrl(asString(source.baseUrl), true) : normalizeBaseUrl(asString(source.baseUrl), chatApiProtocol) || undefined,
      chatApiProtocol,
      catalogId,
      ...(catalogId === 'cccapi' ? { cccGroup: asString(source.cccGroup)?.slice(0, 120) } : {}),
      ...(catalogId === 'relayonapi' ? { relayonGroup: asString(source.relayonGroup)?.slice(0, 120) } : {}),
      selectedModels: customWorkflow ? [] : parseModels(source.selectedModels, 'connection.selectedModels', diagnostics, definition),
      catalogModels: customWorkflow ? [] : parseModels(source.catalogModels, 'connection.catalogModels', diagnostics, definition),
      visibleModelCategories: visible,
    },
  };
}
