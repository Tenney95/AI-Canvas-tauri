/** Model-level declarative protocol runtime with resumable async polling. */
import { useAppStore } from '../../store/useAppStore';
import type { GeneralModelCategory, GeneralModelConfig, NodeType } from '../../types';
import type { ProtocolJsonValue, VideoModelCapability } from '../../types/aiTypes';
import {
  cleanupNodePolling,
  captureVideoTaskGeneration,
  pauseVideoNodeTaskOnTimeout,
  VIDEO_POLL_MAX_DURATION_MS,
  registerNodePolling,
  removePendingTask,
  savePendingTask,
} from '../pollManager';
import {
  collectModelProtocolForEachVariables,
  collectModelProtocolTemplatePaths,
  MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS,
  pollResolvedModelProtocol,
  resolveModelExecutionProfile,
  submitModelProtocol,
  type ModelProtocolVariables,
} from './modelProtocol';
import { REFERENCE_PROTOCOL_VARIABLES } from './modelProtocolVariables';
import { readModelProtocolPathValues } from './modelProtocolResponse';
import { readGoogleImagePartsReferenceUrls } from './imageModelTemplates';

interface RunConfiguredModelProtocolOptions {
  model: GeneralModelConfig;
  variables: ModelProtocolVariables;
  nodeId?: string;
  category: Exclude<GeneralModelCategory, 'text'>;
  signal?: AbortSignal;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  // HAYA/Seedance 等接口使用固定的三数组请求体。某些历史协议在规范化后
  // 仍会被通用覆盖检查误判；只要提交 body 明确完整接收这三类数组，直接
  // 以提交字段为准，避免合法配置在发送前被拦截。
  try {
    const parsed = JSON.parse(protocolSource) as unknown;
    const submitBody = isRecord(parsed) && isRecord(parsed.submit) ? parsed.submit.body : undefined;
    const templates = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === 'string') {
        const match = /^{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}$/.exec(value);
        if (match) templates.add(match[1]);
        return;
      }
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (isRecord(value)) Object.values(value).forEach(collect);
    };
    collect(submitBody);
    // 只要求协议接收实际存在的素材类型。某些模型（例如 Mini 480p）
    // 明确不支持参考视频，此时 videoUrls 为空，不能因为缺少 videos
    // 字段而把已经完整接收的图片/音频误判为不完整。
    const deliveredTypes = [
      {
        values: readProtocolReferenceStrings('imageUrls', variables.imageUrls)
          .concat(readProtocolReferenceStrings('referenceImageUrls', variables.referenceImageUrls)),
        delivered: templates.has('imageUrls') || templates.has('referenceImageUrls'),
      },
      {
        values: readProtocolReferenceStrings('videoUrls', variables.videoUrls)
          .concat(readProtocolReferenceStrings('referenceVideoUrls', variables.referenceVideoUrls)),
        delivered: templates.has('videoUrls') || templates.has('referenceVideoUrls'),
      },
      {
        values: readProtocolReferenceStrings('audioUrls', variables.audioUrls)
          .concat(readProtocolReferenceStrings('referenceAudioUrls', variables.referenceAudioUrls)),
        delivered: templates.has('audioUrls') || templates.has('referenceAudioUrls'),
      },
    ];
    if (deliveredTypes.every(({ values, delivered }) => values.length === 0 || delivered)) return;
  } catch {
    // 结构校验会在更早阶段报告 JSON 错误；这里继续使用通用覆盖检查。
  }
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

export async function runConfiguredModelProtocol(
  options: RunConfiguredModelProtocolOptions,
): Promise<string[]> {
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
  assertReferenceMediaDeliverable(options.model.name, JSON.stringify(protocol), options.variables);

  const projectId = useAppStore.getState().currentProjectId;
  const videoGeneration = options.category === 'video' ? captureVideoTaskGeneration(options.nodeId) : undefined;
  let submittedTaskId: string | undefined;
  let keepPending = false;
  const nodeSignal = options.nodeId ? registerNodePolling(options.nodeId) : undefined;
  const signal = nodeSignal && options.signal
    ? AbortSignal.any([nodeSignal, options.signal])
    : nodeSignal ?? options.signal;
  try {
    const submitted = await submitModelProtocol({
      apiKey: provider.apiKey || '',
      baseUrl,
      protocol,
      variables: options.variables,
      signal,
    });
    if (submitted.urls) return submitted.urls;
    if (!submitted.poll || !submitted.taskId) throw new Error('异步调用协议未返回轮询配置');
    submittedTaskId = submitted.taskId;
    const poll = options.category === 'video'
      ? { ...submitted.poll, maxDurationMs: submitted.poll.maxDurationMs ?? VIDEO_POLL_MAX_DURATION_MS } : submitted.poll;
    const canPersist = !!options.nodeId && !!projectId;
    if (canPersist) {
      savePendingTask({
        nodeId: options.nodeId!,
        projectId,
        nodeType: NODE_TYPE_BY_CATEGORY[options.category],
        provider: 'general',
        providerConfigId: options.model.providerConfigId,
        taskId: submitted.taskId,
        taskType: 'custom-protocol',
        protocolPoll: poll,
        videoGeneration,
        batchCount: readBatchCount(options.variables.n),
        submitted: true,
      });
    }

    const result = await pollResolvedModelProtocol(
      poll,
      provider.apiKey || '',
      signal,
      baseUrl,
    );
    if (!result.urls) throw new Error('媒体模型任务完成但未返回结果 URL');
    // 视频交付由节点入口确认，本地保存失败时仍能下载同一个任务。
    keepPending = options.category === 'video';
    return result.urls;
  } catch (error) {
    const paused = options.category === 'video'
      ? pauseVideoNodeTaskOnTimeout(options.nodeId, error, submittedTaskId) : undefined;
    if (paused) { keepPending = true; throw paused; }
    throw error;
  } finally {
    if (options.nodeId && cleanupNodePolling(options.nodeId, nodeSignal) && !keepPending) {
      removePendingTask(options.nodeId, submittedTaskId);
    }
  }
}
