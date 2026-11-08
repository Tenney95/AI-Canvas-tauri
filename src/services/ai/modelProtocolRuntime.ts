/** Model-level declarative protocol runtime with resumable async polling. */
import { useAppStore } from '../../store/useAppStore';
import type { GeneralModelCategory, GeneralModelConfig, NodeType } from '../../types';
import type { MediaDownloadAccess, MediaProtocolUrls, MediaTaskReceipt, ProtocolJsonValue, VideoModelCapability } from '../../types/aiTypes';
import {
  cleanupNodePolling,
  captureVideoTaskGeneration,
  pauseMediaTask,
  MEDIA_POLL_MAX_DURATION_MS,
  registerMediaNodeOperation,
  registerNodePolling,
  removeFailedMediaTask,
  savePendingTask,
  updatePendingTask,
} from '../pollManager';
import {
  collectModelProtocolForEachVariables,
  buildModelProtocolRequest,
  collectModelProtocolTemplatePaths,
  MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS,
  pollResolvedModelProtocol,
  resolveModelExecutionProfile,
  submitModelProtocol,
  type ModelProtocolVariables,
} from './modelProtocol';
import { isRecord } from './modelProtocolShared';
import { getHttpResponseError } from './httpUtils';
import { PollTaskFailedError, isPollTimeoutError } from '../pollTask';
import { REFERENCE_PROTOCOL_VARIABLES } from './modelProtocolVariables';
import { readModelProtocolPathValues } from './modelProtocolResponse';
import { readGoogleImagePartsReferenceUrls } from './imageModelTemplates';
import { assertModelProtocolResult } from './modelCapabilityValidation';
import { getProviderPolicy, resolveProviderCatalogId } from './providerPolicies';
import { RELAYON_VIDEO_RESULT_URL_PATHS, usesRelayonModelProtocol } from './providers/relayonModelManifest';
import { createMediaDownloadAccess, sanitizeMediaResultUrls } from './mediaDownloadAccess';
import { assertMinimaxQueryResponse, assertMinimaxResponse, getMinimaxMediaAccessHint, usesMinimaxModelProtocol } from './providers/minimaxModelManifest';
import { ModelProtocolHttpError } from './modelProtocolHttp';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from '../projectExecutionContext';
import { assertNativeVideoSubmissionInput, captureNativeVideoSubmissionBaseline, isNativeVideoSubmissionGuard } from '../nativeVideoSubmission';
import { assertNativeMediaPrepared, assertNativeMediaResultRetention, prepareNativeMediaTask, recordNativeMediaSubmission, retainNativeMediaLocalResult, type NativeMediaTaskRecord } from '../indexedDb/nativeMediaTaskRepository';
import { nativeProtocolTaskDigest, nativeProtocolTaskIdContext } from '../nativeModelProtocolTask';
import { projectModelSourceToken } from '../projectModelComparisonMaterial';
import { sha256BytesHex } from '../mediaDataUrl';
import { persistMediaUrlToProjectData } from '../fileService';
import { captureNativeMediaLocalResult } from '../nativeMediaLocalResult';

interface RunConfiguredModelProtocolOptions {
  model: GeneralModelConfig;
  variables: ModelProtocolVariables;
  nodeId?: string;
  category: Exclude<GeneralModelCategory, 'text'>;
  signal?: AbortSignal;
  /** 图片单作业固定候选数量；只影响交付恢复，不写进请求变量 n。 */
  expectedImageOutputs?: number;
  beforeSubmit?: () => void | Promise<void>;
}

const NODE_TYPE_BY_CATEGORY: Record<Exclude<GeneralModelCategory, 'text'>, NodeType> = {
  image: 'ai-image',
  video: 'ai-video',
  audio: 'ai-audio',
};

const REFERENCE_MEDIA_GROUPS = [
  {
    kind: '参考图',
    example: '"images": "{{imageUrls}}"',
    variables: ['seedanceContent', 'imageWithRoles', 'firstImage', 'lastImage', 'referenceImageUrls', 'imageUrls', 'googleImageParts'],
  },
  {
    kind: '参考视频',
    example: '"video_urls": "{{videoUrls}}"',
    variables: ['seedanceContent', 'videoUrls', 'referenceVideoUrl', 'referenceVideoUrls'],
  },
  {
    kind: '参考音频',
    example: '"audio_urls": "{{audioUrls}}"',
    variables: ['seedanceContent', 'audioUrls', 'audioUrl', 'referenceAudioUrls'],
  },
] as const;

const REFERENCE_DELIVERY_HINTS: Record<string, { kind: string; example: string }> = {
  firstImage: { kind: '首帧', example: '"first_frame": "{{firstImage}}"' },
  lastImage: { kind: '尾帧', example: '"last_frame": "{{lastImage}}"' },
  referenceImageUrls: { kind: '普通参考图', example: '"images": "{{referenceImageUrls}}"' },
  referenceVideoUrls: { kind: '参考视频', example: '"video_urls": "{{referenceVideoUrls}}"' },
  referenceAudioUrls: { kind: '参考音频', example: '"audio_urls": "{{referenceAudioUrls}}"' },
};

const CONTROL_TEMPLATE_KEYS = new Set(['$whenPresent', '$forEach']);
const GENERIC_REFERENCE_ALIAS_ROOTS = new Set([
  'seedanceContent', 'imageWithRoles', 'referenceUrls', 'inlineReferences', 'googleImageParts',
]);

interface ReferenceDeliveryRule {
  name: string;
  roots: readonly string[];
  collectionRoots: readonly string[];
}

const CANONICAL_REFERENCE_DELIVERY_RULES: readonly ReferenceDeliveryRule[] = [
  {
    name: 'firstImage',
    roots: ['firstImage', 'seedanceContent', 'imageWithRoles', 'imageUrls', 'referenceUrls', 'inlineReferences'],
    collectionRoots: ['seedanceContent', 'imageWithRoles', 'imageUrls', 'referenceUrls', 'inlineReferences'],
  },
  {
    name: 'lastImage',
    roots: ['lastImage', 'seedanceContent', 'imageWithRoles', 'imageUrls', 'referenceUrls', 'inlineReferences'],
    collectionRoots: ['seedanceContent', 'imageWithRoles', 'imageUrls', 'referenceUrls', 'inlineReferences'],
  },
  {
    name: 'referenceImageUrls',
    roots: ['referenceImageUrls', 'seedanceContent', 'imageWithRoles', 'imageUrls', 'referenceUrls', 'inlineReferences'],
    collectionRoots: ['referenceImageUrls', 'seedanceContent', 'imageWithRoles', 'imageUrls', 'referenceUrls', 'inlineReferences'],
  },
  {
    name: 'referenceVideoUrls',
    roots: ['referenceVideoUrls', 'referenceVideoUrl', 'seedanceContent', 'videoUrls', 'referenceUrls', 'inlineReferences'],
    collectionRoots: ['referenceVideoUrls', 'seedanceContent', 'videoUrls', 'referenceUrls', 'inlineReferences'],
  },
  {
    name: 'referenceAudioUrls',
    roots: ['referenceAudioUrls', 'audioUrl', 'seedanceContent', 'audioUrls', 'referenceUrls', 'inlineReferences'],
    collectionRoots: ['referenceAudioUrls', 'seedanceContent', 'audioUrls', 'referenceUrls', 'inlineReferences'],
  },
];

interface TemplateTransportUsage {
  root: string;
  full: boolean;
  values: string[];
}

function readBatchCount(value: ProtocolJsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 1;
}

function readReferenceStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(readReferenceStrings);
  if (!isRecord(value)) return [];
  if (typeof value.url === 'string' && value.url.trim()) return [value.url];
  return Object.values(value).flatMap(readReferenceStrings);
}

function referenceTransportValue(name: string, value: unknown): unknown {
  if (name === 'googleImageParts') return readGoogleImagePartsReferenceUrls(value);
  if (name !== 'seedanceContent' || !Array.isArray(value)) return value;
  // 类型、角色和提示词不是素材；保持原下标，让子路径与真实请求使用同一索引。
  return value.map((item) => {
    if (!isRecord(item)) return undefined;
    const field = item.type;
    return field === 'image_url' || field === 'video_url' || field === 'audio_url'
      ? { [field]: item[field] }
      : undefined;
  });
}

function readProtocolReferenceStrings(name: string, value: unknown): string[] {
  return readReferenceStrings(referenceTransportValue(name, value));
}

function containsAllValues(available: readonly string[], expected: readonly string[]): boolean {
  const counts = new Map<string, number>();
  available.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  for (const value of expected) {
    const count = counts.get(value) ?? 0;
    if (count <= 0) return false;
    counts.set(value, count - 1);
  }
  return true;
}

function extractSubmitValue(protocolSource: string): unknown {
  try {
    const parsed = JSON.parse(protocolSource) as unknown;
    if (isRecord(parsed) && Object.hasOwn(parsed, 'submit')) return parsed.submit;
    return parsed;
  } catch {
    return protocolSource;
  }
}

function collectTransportTemplatePaths(value: unknown): string[] {
  if (typeof value === 'string') return collectModelProtocolTemplatePaths(value);
  if (Array.isArray(value)) return value.flatMap(collectTransportTemplatePaths);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => (
    CONTROL_TEMPLATE_KEYS.has(key) ? [] : collectTransportTemplatePaths(item)
  ));
}

function collectTemplateTransportUsages(
  protocolSource: string,
  variables: ModelProtocolVariables,
): TemplateTransportUsage[] {
  return collectTransportTemplatePaths(extractSubmitValue(protocolSource)).flatMap((path) => {
    const root = path.split('.')[0];
    const sourceValue = referenceTransportValue(root, variables[root]);
    if (sourceValue === undefined) return [];
    const resolved = path === root
      ? [sourceValue]
      : readModelProtocolPathValues({ [root]: sourceValue }, path);
    const values = resolved.flatMap(readReferenceStrings);
    return values.length > 0 ? [{ root, full: path === root, values }] : [];
  });
}

function isRuleDelivered(
  rule: ReferenceDeliveryRule,
  expected: readonly string[],
  usages: readonly TemplateTransportUsage[],
): boolean {
  const eligible = usages.filter((usage) => (
    rule.roots.includes(usage.root)
  ));
  return containsAllValues(eligible.flatMap((usage) => usage.values), expected);
}

function fallbackDeliveryRule(name: string): ReferenceDeliveryRule {
  if (name === 'imageUrls') {
    return {
      name,
      roots: ['imageUrls', 'imageWithRoles', 'referenceUrls', 'inlineReferences', 'googleImageParts'],
      collectionRoots: ['imageUrls', 'imageWithRoles', 'referenceUrls', 'inlineReferences', 'googleImageParts'],
    };
  }
  if (name === 'videoUrls' || name === 'referenceVideoUrl') {
    return {
      name,
      roots: ['videoUrls', 'referenceVideoUrl', 'referenceVideoUrls', 'referenceUrls', 'inlineReferences'],
      collectionRoots: ['videoUrls', 'referenceVideoUrls', 'referenceUrls', 'inlineReferences'],
    };
  }
  if (name === 'audioUrls' || name === 'audioUrl') {
    return {
      name,
      roots: ['audioUrls', 'audioUrl', 'referenceAudioUrls', 'referenceUrls', 'inlineReferences'],
      collectionRoots: ['audioUrls', 'referenceAudioUrls', 'referenceUrls', 'inlineReferences'],
    };
  }
  return { name, roots: [name], collectionRoots: [name] };
}

/**
 * 连线带了参考素材、但该模型的调用协议里一个参考字段都没有。
 * 中转站文档常常只给纯文生图 / 文生视频示例，导入后参考素材无处可去。
 */
export function findUnusedReferenceVariables(
  protocolSource: string,
  variables: ModelProtocolVariables,
  options: { frameAliases?: boolean } = {},
): string[] {
  const provided = REFERENCE_PROTOCOL_VARIABLES
    .map((name) => ({ name, values: readProtocolReferenceStrings(name, variables[name]) }))
    .filter((item) => item.values.length > 0);
  if (provided.length === 0) return [];

  const usages = collectTemplateTransportUsages(protocolSource, variables);
  const canonical = CANONICAL_REFERENCE_DELIVERY_RULES
    .filter((rule) => !options.frameAliases || !['firstImage', 'lastImage'].includes(rule.name))
    .map((rule) => options.frameAliases && rule.name === 'referenceImageUrls'
      ? { ...rule, roots: [...rule.roots, 'firstImage', 'lastImage'] } : rule)
    .map((rule) => ({ rule, values: readReferenceStrings(variables[rule.name]) }))
    .filter((item) => item.values.length > 0);
  const canonicalValues = canonical.flatMap((item) => item.values);
  const typedProvidedValues = provided
    .filter((item) => !GENERIC_REFERENCE_ALIAS_ROOTS.has(item.name))
    .flatMap((item) => item.values);
  const unused = canonical
    .filter(({ rule, values }) => !isRuleDelivered(rule, values, usages))
    .map(({ rule }) => rule.name);

  // Runtime 同时提供多组兼容别名。只要别名没有带来 canonical 五类之外的新 URL，
  // 就不重复报错；旧图片/音频入口只提供别名时仍按实际值检查。
  for (const item of provided) {
    if (CANONICAL_REFERENCE_DELIVERY_RULES.some((rule) => rule.name === item.name)) continue;
    if (containsAllValues(canonicalValues, item.values)) continue;
    if (GENERIC_REFERENCE_ALIAS_ROOTS.has(item.name)
      && containsAllValues(typedProvidedValues, item.values)) continue;
    const rule = fallbackDeliveryRule(item.name);
    if (!isRuleDelivered(rule, item.values, usages)) unused.push(item.name);
  }

  return [...new Set(unused)];
}

/**
 * 参考素材接不住就直接失败，不能放行。
 *
 * 放行的后果不是「参考图被忽略」这么轻：提示词里的 `@` 引用已经被替换成
 * 「图片1」这类占位，请求体里却一张图都没有，上游会回一句
 * `prompt declares reference index 1 but request contains 0 images`，
 * 用户完全看不出是本地协议缺字段。
 */
function assertReferenceMediaDeliverable(
  modelName: string,
  protocolSource: string,
  variables: ModelProtocolVariables,
): void {
  const unused = findUnusedReferenceVariables(protocolSource, variables);
  if (unused.length === 0) return;
  const exactHints = unused.flatMap((name) => (
    REFERENCE_DELIVERY_HINTS[name] ? [REFERENCE_DELIVERY_HINTS[name]] : []
  ));
  const hints = exactHints.length > 0
    ? exactHints
    : REFERENCE_MEDIA_GROUPS.filter((group) => (
        group.variables.some((variable) => unused.includes(variable))
      ));
  const effective = hints.length > 0
    ? hints
    : [{ kind: '参考素材', example: '"references": "{{referenceUrls}}"' }];
  throw new Error(
    [
      `模型“${modelName}”的调用协议里没有完整接收${effective.map((hint) => hint.kind).join(' / ')}的字段，`
        + '连线或提示词里引用的素材无法完整发送。',
      `请在该模型的「请求体 JSON」里按接口文档补上对应字段（例如 ${effective.map((hint) => hint.example).join('、')}），`
        + '或断开这些参考素材的连线。',
    ].join('\n'),
  );
}

export function findModelProtocolForEachCapabilityConflicts(
  protocol: unknown,
  capability: VideoModelCapability | undefined,
): string[] {
  if (!capability) return [];
  const expanded = new Set(collectModelProtocolForEachVariables(protocol));
  const limits: Array<{
    variable: string;
    field: keyof Pick<VideoModelCapability,
      'maxImageReferences' | 'maxVideoReferences' | 'maxAudioReferences'>;
  }> = [
    { variable: 'referenceImageUrls', field: 'maxImageReferences' },
    { variable: 'referenceVideoUrls', field: 'maxVideoReferences' },
    { variable: 'referenceAudioUrls', field: 'maxAudioReferences' },
  ];
  return limits.flatMap(({ variable, field }) => {
    const maximum = capability[field];
    if (!expanded.has(variable) || maximum === undefined
      || maximum <= MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS) return [];
    return [
      `模型能力 ${field}=${maximum} 超过调用协议 $forEach 的单数组安全上限 `
        + `${MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS}；请降低能力上限，或改用整数组字段 {{${variable}}}`,
    ];
  });
}

/** 同步返回结果也保留交付身份，已有异步回执仍使用原任务。 */
export function retainCompletedMediaResults(
  urls: string[], access: MediaDownloadAccess, nodeId: string | undefined,
  category: 'image' | 'video' | 'audio', batchCount = 1, existingReceipt?: MediaTaskReceipt,
  projectId?: string | null,
): MediaProtocolUrls {
  let receipt = existingReceipt;
  const store = useAppStore.getState();
  const deliveryProjectId = projectId === undefined ? store.currentProjectId : projectId;
  const resultUrls = sanitizeMediaResultUrls(urls, store.config.providers[access.providerConfigId]?.apiKey);
  if (!receipt && resultUrls && nodeId && deliveryProjectId) {
    receipt = savePendingTask({ nodeId, projectId: deliveryProjectId,
      nodeType: NODE_TYPE_BY_CATEGORY[category], provider: 'general', providerConfigId: access.providerConfigId,
      taskType: 'custom-protocol', taskId: `result-${crypto.randomUUID()}`, submitted: true,
      resultUrls, mediaDownloadAccess: access, mediaRecoveryState: 'delivery_pending', batchCount,
      ...(category === 'video' ? { videoGeneration: captureVideoTaskGeneration(nodeId) } : {}),
    });
  } else if (receipt) {
    updatePendingTask(receipt.nodeId, { mediaDownloadAccess: access }, receipt.taskId, receipt.attemptId);
  }
  return Object.assign(urls, { mediaDownloadAccess: access, ...(receipt ? { taskReceipt: receipt } : {}) });
}

export async function runConfiguredModelProtocol(
  options: RunConfiguredModelProtocolOptions,
): Promise<MediaProtocolUrls> {
  const protocol = resolveModelExecutionProfile(options.model.executionProfile);
  if (!protocol) throw new Error(`模型“${options.model.name}”未配置调用协议`);
  const expansionConflicts = findModelProtocolForEachCapabilityConflicts(
    protocol,
    options.model.videoCapability,
  );
  if (expansionConflicts.length > 0) throw new Error(expansionConflicts[0]);
  const provider = useAppStore.getState().config.providers[options.model.providerConfigId];
  if (!provider) throw new Error(`模型“${options.model.name}”的连接配置不存在`);
  const baseUrl = provider.baseUrl?.trim() || '';
  if (!baseUrl) throw new Error(`模型“${options.model.name}”未配置接口地址`);
  const catalogId = resolveProviderCatalogId(options.model.providerConfigId, provider);
  const usesMinimaxProtocol = catalogId === 'minimax'
    && usesMinimaxModelProtocol(options.model.modelId, options.model.executionProfile);
  // 仅阻断已知会创建远端异步任务的合同；同步生成继续走原有交付路径。
  // 此判断位于任何提交之前，避免新画布付费后只能得到不可续查的旧队列记录。
  const projectContext = useAppStore.getState().projectExecutionContext;
  const nativeContext = captureLegacyCanvasContext(useAppStore.getState());
  const nativeOperation = !!projectContext && projectContext.modelGeneration > 0;
  if (nativeOperation && (!nativeContext || nativeContext.modelGeneration !== 1
    || !options.nodeId || !isNativeVideoSubmissionGuard(options.beforeSubmit))) throw new Error('此原生媒体目的地尚不能安全恢复，未提交请求');
  const validateResponse = usesMinimaxProtocol
    ? (payload: unknown) => assertMinimaxResponse(payload, options.category === 'audio') : undefined;
  const mediaDownloadAccess = createMediaDownloadAccess(options.model.providerConfigId, baseUrl, protocol.auth);
  assertReferenceMediaDeliverable(options.model.name, JSON.stringify(protocol), options.variables);

  const projectId = useAppStore.getState().currentProjectId;
  const expectedOutputCount = options.category === 'image' && options.expectedImageOutputs !== undefined
    ? readBatchCount(options.expectedImageOutputs) : readBatchCount(options.variables.n);
  const fixedImageOutputs = options.category === 'image' && options.expectedImageOutputs !== undefined && expectedOutputCount > 1
    ? { expectedImageOutputs: expectedOutputCount } : {};
  const videoGeneration = options.category === 'video' ? captureVideoTaskGeneration(options.nodeId) : undefined;
  let receipt: MediaTaskReceipt | undefined;
  let nativeTask: NativeMediaTaskRecord | undefined, nativeRemoteId: string | undefined, nativeSent = false;
  const releaseOperation = options.nodeId ? registerMediaNodeOperation(options.nodeId) : undefined;
  const nodeSignal = options.nodeId ? registerNodePolling(options.nodeId) : undefined;
  const signal = nodeSignal && options.signal
    ? AbortSignal.any([nodeSignal, options.signal])
    : nodeSignal ?? options.signal;
  try {
    signal?.throwIfAborted();
    const submitOptions = { apiKey: provider.apiKey || '', baseUrl, protocol, variables: options.variables, signal, validateResponse,
      ...(getProviderPolicy(catalogId).submitIdempotency ? { idempotencyKey: crypto.randomUUID() } : {}),
    };
    // 在记录“提交中”之前完成本地构建校验，避免将输入错误误称为提交状态未知。
    buildModelProtocolRequest(submitOptions);
    if (nativeOperation) {
      const hasReference = REFERENCE_PROTOCOL_VARIABLES.some((name) => {
        const value = options.variables[name];
        if (name === 'seedanceContent' && Array.isArray(value)) return value.some((item) => !isRecord(item) || item.type !== 'text');
        if (name === 'googleImageParts' && Array.isArray(value)) return value.some((item) => !isRecord(item) || Object.keys(item).some((key) => key !== 'text'));
        return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '' && value !== false;
      });
      if (hasReference) throw new Error('新项目声明式媒体素材引用尚未冻结，未提交请求');
      if (options.category === 'image' && expectedOutputCount !== 1) throw new Error('新项目异步图片目前需要单候选合同，未提交请求');
      if (protocol.mode === 'async') nativeProtocolTaskIdContext(protocol, 'validation');
      const scheme = options.category === 'video' && protocol.mode === 'async' ? 'video-input-v1' as const : 'media-input-v2' as const;
      const originNode = useAppStore.getState().nodes.find((node) => node.id === options.nodeId);
      if (scheme === 'media-input-v2' && originNode && originNode.data.type !== `ai-${options.category}`) throw new Error('此派生媒体类型尚未接入可恢复原任务');
      const baseline = await captureNativeVideoSubmissionBaseline(nativeContext!, options.nodeId!, undefined, scheme);
      nativeTask = await prepareNativeMediaTask({ context: nativeContext!, operationId: crypto.randomUUID(), nodeId: options.nodeId!,
        providerConfigId: options.model.providerConfigId, providerBase: baseUrl, modelRef: `general/${options.model.id}`,
        protocolDigest: await nativeProtocolTaskDigest(options.model.modelId, protocol), category: options.category,
        fingerprintScheme: scheme,
        submissionKind: protocol.mode === 'sync' ? 'sync' : 'async',
        ...(scheme === 'media-input-v2' ? { requestFingerprint: await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(options.variables))) } : {}),
        inputFingerprint: baseline.inputFingerprint, sourceCanvasRevision: baseline.canvasRevision });
      await assertNativeMediaPrepared(nativeTask);
      await options.beforeSubmit?.();
      await assertNativeVideoSubmissionInput(nativeTask, nativeContext!);
      const latest = useAppStore.getState().config;
      const currentModel = latest.generalModels?.find((model) => model.id === options.model.id);
      const currentProtocol = currentModel && resolveModelExecutionProfile(currentModel.executionProfile);
      if (latest.providers[options.model.providerConfigId] !== provider || !currentModel || !currentProtocol
        || await nativeProtocolTaskDigest(currentModel.modelId, currentProtocol) !== nativeTask.protocolDigest) throw new Error('原模型连接在提交前已变化');
      await options.beforeSubmit?.();
      await assertNativeVideoSubmissionInput(nativeTask, nativeContext!);
      const finalConfig = useAppStore.getState().config;
      if (finalConfig.providers[options.model.providerConfigId] !== provider || finalConfig.generalModels?.find((model) => model.id === options.model.id) !== currentModel) throw new Error('原模型配置已变化');
      signal?.throwIfAborted(); nativeSent = true;
    } else if ((protocol.mode === 'async' || usesMinimaxProtocol && options.category === 'audio') && options.nodeId && projectId) {
      receipt = savePendingTask({ nodeId: options.nodeId, projectId,
        nodeType: NODE_TYPE_BY_CATEGORY[options.category], provider: 'general', providerConfigId: options.model.providerConfigId,
        taskId: '', taskType: 'custom-protocol', submitted: false, videoGeneration,
        mediaDownloadAccess,
        batchCount: expectedOutputCount, ...fixedImageOutputs });
    }
    const submitted = await submitModelProtocol(submitOptions);
    if (nativeTask) {
      if (nativeTask.submissionKind === 'sync') {
        assertModelProtocolResult(options.category, submitted);
        if (submitted.urls?.length !== 1) throw new Error('同步协议没有返回已冻结的单产物，原操作保留供核对');
        // 已付费返回的产物先保存到原持久根；当前窗口切集或取消不能把它丢弃。
        await assertNativeMediaResultRetention(nativeTask);
        const saved = await persistMediaUrlToProjectData(submitted.urls[0], nativeContext!.canvasId, `ai-${options.category}`, '原同步媒体',
          { mediaDownloadAccess });
        if (!saved.filePath) throw new Error('同步媒体尚未保存到原项目目录');
        const localResult = await captureNativeMediaLocalResult(nativeContext!.canvasId, saved.filePath);
        await assertNativeMediaResultRetention(nativeTask);
        nativeTask = await retainNativeMediaLocalResult(nativeTask, localResult);
        if (signal?.aborted || !isProjectExpectedContextCurrent(nativeContext!, useAppStore.getState(), { checkCanvasRevision: false })) {
          const pending = new Error(`原同步产物已保存（${nativeTask.operationId}），返回原画布后可继续本机交付，不会再次生成。`);
          pending.name = 'NativeMediaTaskPending'; throw pending;
        }
        const { resumeNativeVolcengineTask } = await import('../nativeVolcengineRecovery');
        await resumeNativeVolcengineTask(nativeTask.operationId, signal);
        const delivered = new Error(`原同步媒体已保存并交付（${nativeTask.operationId}）`);
        delivered.name = 'NativeMediaTaskDelivered';
        Object.assign(delivered, { nativeOperationId: nativeTask.operationId }); throw delivered;
      }
      nativeRemoteId = submitted.taskId;
      if (!nativeRemoteId || !submitted.poll) throw new Error('原调用没有返回可确认的远端任务 ID，请到平台核对');
      await recordNativeMediaSubmission(nativeTask.operationId, nativeTask.lease, { taskId: nativeRemoteId });
      const pending = new Error(`原媒体任务已提交（${nativeTask.operationId}），请续查原回执，不要重新生成。`);
      pending.name = 'NativeMediaTaskPending'; throw pending;
    }
    if (submitted.urls) {
      assertModelProtocolResult(options.category, submitted);
      const resultUrls = sanitizeMediaResultUrls(submitted.urls, provider.apiKey);
      // 同步接口已交付结果，不需要也不能重新提交生成来重试本地保存。
      if (resultUrls && options.nodeId && projectId) {
        const taskId = receipt?.taskId || `result-${crypto.randomUUID()}`;
        receipt = receipt ? updatePendingTask(receipt.nodeId, { taskId, submitted: true, resultUrls,
          mediaDownloadAccess, mediaRecoveryState: 'delivery_pending', ...fixedImageOutputs }, receipt.taskId, receipt.attemptId)
          : savePendingTask({ nodeId: options.nodeId, projectId, nodeType: NODE_TYPE_BY_CATEGORY[options.category],
            provider: 'general', providerConfigId: options.model.providerConfigId, taskType: 'custom-protocol',
            taskId, submitted: true, resultUrls, mediaDownloadAccess, videoGeneration,
            mediaRecoveryState: 'delivery_pending', batchCount: expectedOutputCount, ...fixedImageOutputs });
      }
      return Object.assign(submitted.urls, { mediaDownloadAccess, ...(receipt ? { taskReceipt: receipt } : {}) });
    }
    if (!submitted.poll || !submitted.taskId) throw new Error('异步调用协议未返回轮询配置');
    const poll = { ...submitted.poll, maxDurationMs: submitted.poll.maxDurationMs ?? MEDIA_POLL_MAX_DURATION_MS,
      ...(catalogId === 'relayonapi' && options.category === 'video'
        && usesRelayonModelProtocol(options.model.modelId, options.model.executionProfile)
        ? { resultUrlFallbackPaths: [...new Set(RELAYON_VIDEO_RESULT_URL_PATHS)] } : {}),
    };
    if (receipt) receipt = updatePendingTask(receipt.nodeId, { taskId: submitted.taskId, protocolPoll: poll, submitted: true }, receipt.taskId, receipt.attemptId);

    const result = await pollResolvedModelProtocol(
      poll,
      provider.apiKey || '',
      signal,
      baseUrl,
      validateResponse ? assertMinimaxQueryResponse : undefined,
    );
    assertModelProtocolResult(options.category, result);
    if (!result.urls) throw new Error('媒体模型任务完成但未返回结果 URL');
    if (receipt) updatePendingTask(receipt.nodeId, { mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId);
    // 每类媒体都在本地保存和目标回填后确认，数组携带当次身份而非读取最新节点任务。
    return Object.assign(result.urls, { mediaDownloadAccess, ...(receipt ? { taskReceipt: receipt } : {}) });
  } catch (error) {
    if (error instanceof Error && ['NativeMediaTaskPending', 'NativeMediaTaskDelivered'].includes(error.name)) throw error;
    if (nativeTask) {
      await recordNativeMediaSubmission(nativeTask.operationId, nativeTask.lease, nativeRemoteId ? { taskId: nativeRemoteId }
        : !nativeSent || getHttpResponseError(error)?.definitiveFailure ? { notStarted: true } : { unknown: true }).catch(() => undefined);
      throw new Error(`原媒体操作已保留（${nativeTask.operationId}），请核对原任务，不要重新提交。`);
    }
    const httpError = getHttpResponseError(error);
    const hint = usesMinimaxProtocol && httpError ? getMinimaxMediaAccessHint(httpError.message) : undefined;
    const failure = hint && httpError ? new ModelProtocolHttpError(httpError.status, hint,
      httpError instanceof ModelProtocolHttpError ? httpError.retryAfterMs : undefined, httpError.definitiveFailure) : error;
    const rejected = !receipt?.taskId && getHttpResponseError(failure)?.definitiveFailure === true;
    if (receipt && !(failure instanceof PollTaskFailedError) && !rejected) {
      const paused = pauseMediaTask(receipt, failure, !receipt.taskId ? 'submit_unknown'
        : isPollTimeoutError(failure) ? 'query_timeout' : 'query_interrupted');
      if (paused) throw paused;
    }
    if (receipt && (failure instanceof PollTaskFailedError || rejected)) removeFailedMediaTask(receipt);
    throw failure;
  } finally {
    if (options.nodeId) cleanupNodePolling(options.nodeId, nodeSignal);
    releaseOperation?.();
  }
}
