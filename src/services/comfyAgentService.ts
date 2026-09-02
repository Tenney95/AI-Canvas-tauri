/**
 * 内部助手使用的 ComfyUI 动态工作流边界。
 *
 * 只从 ComfyUI API 发现模型和节点；助手生成的工作流必须先按当前实例的
 * /object_info 完整校验，换取短期、任务绑定的 validationId，才能进入需确认的执行工具。
 */
import { generateId, useAppStore } from '../store/useAppStore';
import type { WorkflowCategory, WorkflowDefinition, WorkflowIONodeType } from '../types';
import type {
  MediaDeliveryMode,
  MediaGenerationResult,
  MediaKind,
} from '../types/media';
import { isTauriEnv, persistMediaUrlToProjectData } from './fileService';
import { comfyFetch, pollComfyHistory } from './comfyPolling';
import { resolveComfyOutputUrl, type ComfyOutputKind } from './comfyOutputs';
import { formatComfyPromptError } from './comfyWorkflowService';
import { extractComfyUIIONodes } from './comfyUIWindowService';

type ComfyWorkflow = Record<string, ComfyWorkflowNode>;

interface ComfyWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: unknown;
}

interface ComfyNodeInfo {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
    hidden?: Record<string, unknown>;
  };
  output?: unknown[];
  output_name?: unknown[];
  output_node?: boolean;
  display_name?: string;
  description?: string;
  category?: string;
  python_module?: string;
}

type ComfyObjectInfo = Record<string, ComfyNodeInfo>;

export interface ComfyDiscoveryOptions {
  resource: 'models' | 'nodes';
  query?: string;
  nodeClasses?: string[];
  limit?: number;
}

export interface ComfyWorkflowValidationSummary {
  validationId: string;
  kind: MediaKind;
  nodeCount: number;
  outputNodeCount: number;
  nodeClasses: string[];
  customNodeClasses: string[];
  modelNames: string[];
  expiresAt: number;
}

interface ValidatedWorkflowEntry extends ComfyWorkflowValidationSummary {
  taskId: string;
  projectId: string;
  baseUrl: string;
  kind: MediaKind;
  workflow: ComfyWorkflow;
}

export interface ComfyWorkflowSaveOfferSummary {
  saveOfferId: string;
  suggestedName: string;
  kind: MediaKind;
  modelNames: string[];
  expiresAt: number;
}

interface ComfyWorkflowSaveOfferEntry extends ComfyWorkflowSaveOfferSummary {
  projectId: string;
  conversationId: string;
  workflow: ComfyWorkflow;
}

export interface ComfyDynamicExecutionResult {
  artifact: MediaGenerationResult;
  saveOffer: ComfyWorkflowSaveOfferSummary;
}

const API_CACHE_TTL = 30_000;
const VALIDATION_TTL = 10 * 60_000;
const SAVE_OFFER_TTL = 60 * 60_000;
const MAX_WORKFLOW_BYTES = 512_000;
const MAX_WORKFLOW_NODES = 400;
const MAX_DISCOVERY_ITEMS = 200;
const MAX_COMBO_PREVIEW = 100;

let objectInfoCache: { baseUrl: string; fetchedAt: number; value: Promise<ComfyObjectInfo> } | null = null;
let modelCatalogCache: {
  baseUrl: string;
  fetchedAt: number;
  value: Promise<Record<string, string[]>>;
} | null = null;
const validatedWorkflows = new Map<string, ValidatedWorkflowEntry>();
const workflowSaveOffers = new Map<string, ComfyWorkflowSaveOfferEntry>();

function getBaseUrl(): string {
  const value = useAppStore.getState().config.comfyUIUrl?.trim();
  if (!value) throw new Error('未配置 ComfyUI 服务地址，请先在设置中配置并启动 ComfyUI');
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response, action: string): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${action}失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }
  return response.json();
}

async function getObjectInfo(baseUrl = getBaseUrl()): Promise<ComfyObjectInfo> {
  if (
    objectInfoCache
    && objectInfoCache.baseUrl === baseUrl
    && Date.now() - objectInfoCache.fetchedAt < API_CACHE_TTL
  ) return objectInfoCache.value;

  const value = (async () => {
    const payload = await readJson(
      await comfyFetch(`${baseUrl}/object_info`),
      '读取 ComfyUI 节点清单',
    );
    if (!isRecord(payload)) throw new Error('ComfyUI 节点清单格式无效');
    return payload as ComfyObjectInfo;
  })();
  objectInfoCache = { baseUrl, fetchedAt: Date.now(), value };
  return value;
}

function inferModelsFromObjectInfo(info: ComfyObjectInfo): Record<string, string[]> {
  const result: Record<string, Set<string>> = {};
  for (const node of Object.values(info)) {
    const groups = [node.input?.required, node.input?.optional];
    for (const group of groups) {
      for (const [inputName, declaration] of Object.entries(group ?? {})) {
        if (!/(model|ckpt|checkpoint|unet|vae|lora|clip|controlnet|upscale)/i.test(inputName)) continue;
        if (!Array.isArray(declaration) || !Array.isArray(declaration[0])) continue;
        const folder = inputName.replace(/_name$/i, '').toLowerCase();
        const target = result[folder] ??= new Set<string>();
        for (const value of declaration[0]) {
          if (typeof value === 'string' && value.trim()) target.add(value);
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(result).map(([folder, values]) => [folder, [...values].sort()]),
  );
}

async function getModelCatalog(baseUrl = getBaseUrl()): Promise<Record<string, string[]>> {
  if (
    modelCatalogCache
    && modelCatalogCache.baseUrl === baseUrl
    && Date.now() - modelCatalogCache.fetchedAt < API_CACHE_TTL
  ) return modelCatalogCache.value;

  const value = (async () => {
    try {
      const foldersPayload = await readJson(
        await comfyFetch(`${baseUrl}/models`),
        '读取 ComfyUI 模型分类',
      );
      if (!Array.isArray(foldersPayload)) throw new Error('模型分类格式无效');
      const folders = foldersPayload.filter((item): item is string => typeof item === 'string').slice(0, 100);
      const entries = await Promise.all(folders.map(async (folder) => {
        try {
          const payload = await readJson(
            await comfyFetch(`${baseUrl}/models/${encodeURIComponent(folder)}`),
            `读取 ${folder} 模型`,
          );
          const models = Array.isArray(payload)
            ? payload.filter((item): item is string => typeof item === 'string')
            : [];
          return [folder, models] as const;
        } catch {
          return [folder, []] as const;
        }
      }));
      const catalog = Object.fromEntries(entries) as Record<string, string[]>;
      if (Object.values(catalog).some((models) => models.length > 0)) return catalog;
    } catch {
      // 旧版没有 /models；下面从 /object_info 的 combo 输入回退发现。
    }
    return inferModelsFromObjectInfo(await getObjectInfo(baseUrl));
  })();
  modelCatalogCache = { baseUrl, fetchedAt: Date.now(), value };
  return value;
}

function previewDeclaration(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const [type, config] = value;
  return [
    Array.isArray(type)
      ? { options: type.slice(0, MAX_COMBO_PREVIEW), total: type.length }
      : type,
    isRecord(config) ? config : undefined,
  ].filter((item) => item !== undefined);
}

function summarizeNodeInfo(classType: string, node: ComfyNodeInfo) {
  const mapGroup = (group: Record<string, unknown> | undefined) => Object.fromEntries(
    Object.entries(group ?? {}).map(([name, declaration]) => [name, previewDeclaration(declaration)]),
  );
  return {
    classType,
    displayName: node.display_name || classType,
    category: node.category,
    description: node.description?.slice(0, 500),
    pythonModule: node.python_module,
    outputNode: node.output_node === true,
    inputs: {
      required: mapGroup(node.input?.required),
      optional: mapGroup(node.input?.optional),
    },
    outputs: node.output ?? [],
    outputNames: node.output_name ?? [],
  };
}

export async function discoverComfyUI(options: ComfyDiscoveryOptions): Promise<Record<string, unknown>> {
  const baseUrl = getBaseUrl();
  const query = options.query?.trim().toLowerCase() || '';
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_DISCOVERY_ITEMS);
  if (options.resource === 'models') {
    const catalog = await getModelCatalog(baseUrl);
    const folders = Object.entries(catalog).map(([folder, models]) => ({
      folder,
      models: models.filter((model) => !query || model.toLowerCase().includes(query)).slice(0, limit),
      total: models.length,
    })).filter((entry) => !query || entry.models.length > 0);
    return { source: 'ComfyUI API', folders, folderCount: folders.length };
  }

  const info = await getObjectInfo(baseUrl);
  const exact = new Set(options.nodeClasses ?? []);
  const nodes = Object.entries(info)
    .filter(([classType, node]) => (
      exact.size > 0
        ? exact.has(classType)
        : !query || [classType, node.display_name, node.category, node.python_module]
          .some((value) => value?.toLowerCase().includes(query))
    ))
    .slice(0, limit)
    .map(([classType, node]) => summarizeNodeInfo(classType, node));
  return {
    source: 'ComfyUI /object_info',
    nodes,
    returned: nodes.length,
    totalRegistered: Object.keys(info).length,
  };
}

function parseWorkflow(value: unknown): ComfyWorkflow {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > MAX_WORKFLOW_BYTES) {
    throw new Error(`工作流 JSON 不能超过 ${Math.round(MAX_WORKFLOW_BYTES / 1024)} KB`);
  }
  if (!isRecord(value)) throw new Error('工作流必须是 ComfyUI API 格式对象');
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error('工作流不能为空');
  if (entries.length > MAX_WORKFLOW_NODES) throw new Error(`工作流最多允许 ${MAX_WORKFLOW_NODES} 个节点`);
  const workflow: ComfyWorkflow = {};
  for (const [nodeId, rawNode] of entries) {
    if (!/^[-\w:.]+$/.test(nodeId) || !isRecord(rawNode)) throw new Error(`节点 #${nodeId} 格式无效`);
    if (typeof rawNode.class_type !== 'string' || !isRecord(rawNode.inputs)) {
      throw new Error(`节点 #${nodeId} 缺少 class_type 或 inputs`);
    }
    workflow[nodeId] = {
      class_type: rawNode.class_type,
      inputs: structuredClone(rawNode.inputs),
      ...(rawNode._meta === undefined ? {} : { _meta: structuredClone(rawNode._meta) }),
    };
  }
  return workflow;
}

function comboOptions(declaration: unknown): unknown[] | null {
  return Array.isArray(declaration) && Array.isArray(declaration[0]) ? declaration[0] : null;
}

function isConnection(value: unknown): value is [string, number] {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && Number.isInteger(value[1]);
}

function isCustomNode(info: ComfyNodeInfo): boolean {
  const moduleName = info.python_module ?? '';
  return !!moduleName && moduleName !== 'nodes' && !moduleName.startsWith('comfy_extras.');
}

function collectModelName(inputName: string, value: unknown, options: unknown[] | null): string | null {
  if (typeof value !== 'string' || !options?.includes(value)) return null;
  return /(model|ckpt|checkpoint|unet|vae|lora|clip|controlnet|upscale)/i.test(inputName)
    ? value
    : null;
}

function cleanupExpiredValidations(): void {
  const now = Date.now();
  for (const [id, entry] of validatedWorkflows) {
    if (entry.expiresAt <= now) validatedWorkflows.delete(id);
  }
  for (const [id, entry] of workflowSaveOffers) {
    if (entry.expiresAt <= now) workflowSaveOffers.delete(id);
  }
}

export async function validateComfyUIWorkflow(args: {
  workflow: unknown;
  kind: MediaKind;
  taskId: string;
  projectId: string;
}): Promise<ComfyWorkflowValidationSummary> {
  cleanupExpiredValidations();
  const baseUrl = getBaseUrl();
  const workflow = parseWorkflow(args.workflow);
  const info = await getObjectInfo(baseUrl);
  const errors: string[] = [];
  const classTypes = new Set<string>();
  const customClasses = new Set<string>();
  const modelNames = new Set<string>();
  let outputNodeCount = 0;

  for (const [nodeId, node] of Object.entries(workflow)) {
    const definition = info[node.class_type];
    if (!definition) {
      errors.push(`节点 #${nodeId} 使用了当前 ComfyUI 未注册的类型 ${node.class_type}`);
      continue;
    }
    classTypes.add(node.class_type);
    if (isCustomNode(definition)) customClasses.add(node.class_type);
    if (definition.output_node === true) outputNodeCount += 1;

    for (const requiredName of Object.keys(definition.input?.required ?? {})) {
      if (!(requiredName in node.inputs)) errors.push(`节点 #${nodeId} 缺少必填输入 ${requiredName}`);
    }
    const declarations = {
      ...(definition.input?.required ?? {}),
      ...(definition.input?.optional ?? {}),
    };
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      if (isConnection(inputValue)) {
        const [sourceId] = inputValue;
        if (!workflow[sourceId]) errors.push(`节点 #${nodeId}.${inputName} 引用了不存在的节点 #${sourceId}`);
        continue;
      }
      const options = comboOptions(declarations[inputName]);
      if (options && !options.some((option) => Object.is(option, inputValue))) {
        errors.push(`节点 #${nodeId}.${inputName} 不是当前 ComfyUI 允许的选项`);
      }
      const modelName = collectModelName(inputName, inputValue, options);
      if (modelName) modelNames.add(modelName);
    }
  }
  if (outputNodeCount === 0) errors.push('工作流没有 ComfyUI 标记的输出节点');
  if (errors.length > 0) throw new Error(errors.slice(0, 12).join('；'));

  const validationId = `comfy-validation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const summary: ComfyWorkflowValidationSummary = {
    validationId,
    kind: args.kind,
    nodeCount: Object.keys(workflow).length,
    outputNodeCount,
    nodeClasses: [...classTypes].sort(),
    customNodeClasses: [...customClasses].sort(),
    modelNames: [...modelNames].sort(),
    expiresAt: Date.now() + VALIDATION_TTL,
  };
  validatedWorkflows.set(validationId, {
    ...summary,
    taskId: args.taskId,
    projectId: args.projectId,
    baseUrl,
    kind: args.kind,
    workflow,
  });
  return summary;
}

export function getValidatedComfyWorkflowSummary(
  validationId: string,
  taskId: string,
  projectId: string,
): ComfyWorkflowValidationSummary | null {
  cleanupExpiredValidations();
  const entry = validatedWorkflows.get(validationId);
  if (!entry || entry.taskId !== taskId || entry.projectId !== projectId) return null;
  const { kind, nodeCount, outputNodeCount, nodeClasses, customNodeClasses, modelNames, expiresAt } = entry;
  return { validationId, kind, nodeCount, outputNodeCount, nodeClasses, customNodeClasses, modelNames, expiresAt };
}

async function cancelPrompt(baseUrl: string, promptId: string): Promise<void> {
  try {
    const direct = await comfyFetch(`${baseUrl}/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: 'POST' });
    if (direct.status !== 404) return;
    await comfyFetch(`${baseUrl}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    await comfyFetch(`${baseUrl}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId }),
    });
  } catch {
    // 本地中止必须立即生效；远端兼容性取消是尽力而为。
  }
}

function outputKinds(kind: MediaKind): ComfyOutputKind[] {
  if (kind === 'video') return ['video', 'image'];
  if (kind === 'audio') return ['audio', 'video', 'image'];
  return ['image'];
}

function inferDimensions(workflow: ComfyWorkflow): { width?: number; height?: number } {
  for (const node of Object.values(workflow)) {
    const { width, height } = node.inputs;
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return {};
}

const WORKFLOW_CATEGORIES: Record<MediaKind, WorkflowCategory> = {
  image: 'ai-image',
  video: 'ai-video',
  audio: 'ai-audio',
};

function workflowNameFrom(entry: ValidatedWorkflowEntry): string {
  const model = entry.modelNames[0]?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '').trim();
  const kind = entry.kind === 'image' ? '图像' : entry.kind === 'video' ? '视频' : '音频';
  return model ? `${model}-${kind}工作流` : `ComfyUI-${kind}工作流`;
}

function sanitizeWorkflowFileName(name: string): string {
  const base = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_') || 'comfyui-workflow';
  return `${base.replace(/\.json$/i, '')}.json`;
}

function createSaveOffer(
  entry: ValidatedWorkflowEntry,
  conversationId: string,
): ComfyWorkflowSaveOfferSummary {
  const saveOfferId = `comfy-save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const summary: ComfyWorkflowSaveOfferSummary = {
    saveOfferId,
    suggestedName: workflowNameFrom(entry),
    kind: entry.kind,
    modelNames: [...entry.modelNames],
    expiresAt: Date.now() + SAVE_OFFER_TTL,
  };
  workflowSaveOffers.set(saveOfferId, {
    ...summary,
    projectId: entry.projectId,
    conversationId,
    workflow: structuredClone(entry.workflow),
  });
  return summary;
}

export function getComfyWorkflowSaveOfferSummary(
  saveOfferId: string,
  conversationId: string,
  projectId: string,
): ComfyWorkflowSaveOfferSummary | null {
  cleanupExpiredValidations();
  const offer = workflowSaveOffers.get(saveOfferId);
  if (!offer || offer.conversationId !== conversationId || offer.projectId !== projectId) return null;
  const { suggestedName, kind, modelNames, expiresAt } = offer;
  return { saveOfferId, suggestedName, kind, modelNames, expiresAt };
}

export async function saveCompletedComfyUIWorkflow(args: {
  saveOfferId: string;
  conversationId: string;
  projectId: string;
  name: string;
}): Promise<Pick<WorkflowDefinition, 'id' | 'name' | 'category'>> {
  cleanupExpiredValidations();
  const offer = workflowSaveOffers.get(args.saveOfferId);
  if (!offer || offer.conversationId !== args.conversationId || offer.projectId !== args.projectId) {
    throw new Error('工作流保存凭证已失效或不属于当前对话，请重新执行工作流');
  }
  const name = args.name.trim();
  if (!name) throw new Error('工作流名称不能为空');
  const fileContent = JSON.stringify(offer.workflow, null, 2);
  const ioNodes = extractComfyUIIONodes(fileContent);
  const defaultNodes: Partial<Record<WorkflowIONodeType, string>> = {};
  for (const ioNode of ioNodes) defaultNodes[ioNode.type] ??= ioNode.nodeId;
  const now = Date.now();
  const workflow: WorkflowDefinition = {
    id: `wf-${generateId()}`,
    name,
    category: WORKFLOW_CATEGORIES[offer.kind],
    fileName: sanitizeWorkflowFileName(name),
    fileContent,
    ioNodes,
    defaultNodes: Object.keys(defaultNodes).length > 0 ? defaultNodes : undefined,
    createdAt: now,
    updatedAt: now,
  };
  await useAppStore.getState().addWorkflow(workflow);
  workflowSaveOffers.delete(args.saveOfferId);
  return { id: workflow.id, name: workflow.name, category: workflow.category };
}

export async function executeValidatedComfyUIWorkflow(args: {
  validationId: string;
  taskId: string;
  projectId: string;
  conversationId: string;
  prompt: string;
  deliveryMode: MediaDeliveryMode;
  signal?: AbortSignal;
}): Promise<ComfyDynamicExecutionResult> {
  cleanupExpiredValidations();
  const entry = validatedWorkflows.get(args.validationId);
  if (!entry || entry.taskId !== args.taskId || entry.projectId !== args.projectId) {
    throw new Error('工作流校验已失效或不属于当前任务，请重新发现并校验');
  }
  if (entry.baseUrl !== getBaseUrl()) throw new Error('ComfyUI 服务地址已变化，请重新校验工作流');
  if (args.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  let promptId = '';
  try {
    const response = await comfyFetch(`${entry.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: entry.workflow }),
      signal: args.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(formatComfyPromptError(response.status, body));
    }
    const submitted = await response.json() as { prompt_id?: unknown; error?: unknown };
    if (typeof submitted.prompt_id !== 'string' || !submitted.prompt_id) {
      throw new Error(typeof submitted.error === 'string' ? submitted.error : 'ComfyUI 未返回 prompt_id');
    }
    promptId = submitted.prompt_id;
    validatedWorkflows.delete(args.validationId);
    const output = await pollComfyHistory(
      entry.baseUrl,
      promptId,
      'ComfyUI 动态工作流执行超时（1 小时）',
      (outputs) => resolveComfyOutputUrl(entry.baseUrl, outputs, outputKinds(entry.kind)),
      args.signal,
    );
    if (args.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

    const id = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let url = output.url;
    let sourceUrl = output.url;
    let filePath: string | undefined;
    let persistence: MediaGenerationResult['persistence'] = 'skipped';
    let persistError: string | undefined;
    if (isTauriEnv()) {
      try {
        const persisted = await persistMediaUrlToProjectData(
          output.url,
          args.projectId,
          entry.kind,
          `助手-ComfyUI-${id}`,
        );
        url = persisted.mediaUrl;
        sourceUrl = persisted.sourceUrl;
        filePath = persisted.filePath;
        persistence = 'saved';
      } catch (error) {
        persistence = 'failed';
        persistError = error instanceof Error ? error.message : 'ComfyUI 已生成内容，但保存失败';
      }
    }
    const artifact: MediaGenerationResult = {
      id,
      kind: entry.kind,
      deliveryMode: args.deliveryMode,
      url,
      sourceUrl,
      filePath,
      persistence,
      persistError,
      prompt: args.prompt,
      modelId: entry.modelNames.join(', ') || 'comfyui/dynamic-workflow',
      provider: 'comfyui',
      ...inferDimensions(entry.workflow),
      createdAt: Date.now(),
    };
    return { artifact, saveOffer: createSaveOffer(entry, args.conversationId) };
  } catch (error) {
    if (promptId && (args.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'))) {
      await cancelPrompt(entry.baseUrl, promptId);
    }
    throw error;
  }
}

export function clearComfyAgentCachesForTests(): void {
  objectInfoCache = null;
  modelCatalogCache = null;
  validatedWorkflows.clear();
  workflowSaveOffers.clear();
}
