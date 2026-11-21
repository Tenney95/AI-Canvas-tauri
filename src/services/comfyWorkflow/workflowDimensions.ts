import type { ComfyInputSpec } from '../../types/comfyWorkflow';
import { mapImageDimensions, mapVideoDimensions } from '../aiDimensions';

type ComfyNodeInputSpecs = Record<string, ComfyInputSpec>;

/**
 * ResolutionSelector 这类节点没有 width/height 数字输入，靠「比例 + 总像素」算尺寸。
 * aspect_ratio 是 combo，写不认识的值会被服务端判非法，所以只写查得到的档位。
 */
const RESOLUTION_SELECTOR_RATIOS: Record<string, string> = {
  '1:1': '1:1 (Square)',
  '2:3': '2:3 (Portrait Photo)',
  '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)',
  '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)',
  '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
};

const DIMENSION_KEY_PAIRS = [
  ['width', 'height', 'always'],
  ['image_width', 'image_height', 'semantic'],
  ['target_width', 'target_height', 'semantic'],
  ['output_width', 'output_height', 'semantic'],
  ['latent_width', 'latent_height', 'semantic'],
  ['video_width', 'video_height', 'semantic'],
  ['custom_width', 'custom_height', 'custom'],
] as const;

const IMAGE_RESOLUTION_KEYS = ['resolution', 'image_size', 'size'] as const;
const RATIO_PRESET_KEYS = ['ratio_preset'] as const;
const IMAGE_PARAM_SPEC_KEYS = [
  'aspect_ratio', 'megapixels', ...IMAGE_RESOLUTION_KEYS, ...RATIO_PRESET_KEYS,
  'width', 'height', 'image_width', 'image_height', 'target_width', 'target_height',
  'output_width', 'output_height', 'latent_width', 'latent_height',
  'video_width', 'video_height', 'custom_width', 'custom_height',
] as const;

const DIMENSION_ALIAS_NODE = /(?:empty|latent|resolution|dimension|canvas|generate|generation|conditioning|(?:image|video).?to.?(?:image|video)|(?:text|txt).?to.?(?:image|video)|(?:t2i|i2v|t2v|v2v))/i;
const DIMENSION_PREPROCESS_NODE = /(?:load|loader|resize|rescale|scale|crop|pad|upscale|upscaler|constrain|constraint|preprocess|preview|save|encode|decode)/i;

type ComfyConnection = [string, number];

interface LinkedDimensionAssignment {
  nodeId: string;
  inputs: Record<string, unknown>;
  inputKey: string;
  value: number;
}

function isComfyConnection(value: unknown): value is ComfyConnection {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'string'
    && typeof value[1] === 'number';
}

function normalizeComfyDimension(value: number, spec?: ComfyInputSpec): number {
  const lower = typeof spec?.min === 'number' ? Math.max(64, spec.min) : 64;
  const upper = typeof spec?.max === 'number' ? Math.min(16_384, spec.max) : 16_384;
  const bounded = Math.min(upper, Math.max(lower, value));
  const step = typeof spec?.step === 'number' && Number.isFinite(spec.step) && spec.step > 0
    ? spec.step
    : 8;
  const origin = typeof spec?.min === 'number' ? spec.min : 0;
  let aligned = origin + Math.round((bounded - origin) / step) * step;
  if (aligned < lower) aligned = origin + Math.ceil((lower - origin) / step) * step;
  if (aligned > upper) aligned = origin + Math.floor((upper - origin) / step) * step;
  return Math.round(Math.min(upper, Math.max(lower, aligned)));
}

function canWriteDimensionValue(value: unknown, spec: ComfyInputSpec | undefined): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return typeof value === 'string'
    && /^\d+(?:\.\d+)?$/.test(value.trim())
    && /^(INT|FLOAT|NUMBER)$/i.test(spec?.type ?? '');
}

function dimensionNodeDescriptor(nodeData: Record<string, unknown>): string {
  const title = (nodeData._meta as Record<string, unknown> | undefined)?.title;
  return `${String(nodeData.class_type ?? '')} ${typeof title === 'string' ? title : ''}`;
}

/**
 * target/custom 等别名在预处理节点里也很常见，不能只凭字段名改写。
 * 节点名称明确表达生成尺寸，或同时暴露比例/分辨率选择器时，才认为是输出尺寸节点。
 */
function allowsDimensionAliases(
  nodeData: Record<string, unknown>,
  inputs: Record<string, unknown>,
): boolean {
  const descriptor = dimensionNodeDescriptor(nodeData);
  if (DIMENSION_PREPROCESS_NODE.test(descriptor)) return false;
  return DIMENSION_ALIAS_NODE.test(descriptor)
    || inputs.aspect_ratio !== undefined
    || inputs.resolution !== undefined
    || inputs.megapixels !== undefined;
}

function usesCustomDimensions(inputs: Record<string, unknown>): boolean {
  return [inputs.resolution, inputs.aspect_ratio]
    .some((value) => typeof value === 'string' && /(?:custom|自定义)/i.test(value));
}

/** 只追踪明确的标量 Primitive；Reroute 只负责透明转发，绝不改写连接数组本身。 */
function resolveLinkedDimensionPrimitive(
  workflowObj: Record<string, Record<string, unknown>>,
  connection: ComfyConnection,
  visited = new Set<string>(),
): Omit<LinkedDimensionAssignment, 'value'> | null {
  const sourceId = connection[0];
  if (visited.has(sourceId) || visited.size >= 8) return null;
  visited.add(sourceId);
  const sourceNode = workflowObj[sourceId];
  const sourceInputs = sourceNode?.inputs as Record<string, unknown> | undefined;
  if (!sourceNode || !sourceInputs) return null;
  const classType = String(sourceNode.class_type ?? '');

  if (/^Primitive(?:Int|Float|Number)?$/i.test(classType)) {
    const inputKey = ['value', 'int', 'float', 'number']
      .find((key) => (
        typeof sourceInputs[key] === 'number' && Number.isFinite(sourceInputs[key])
      ) || (
        typeof sourceInputs[key] === 'string' && /^\d+(?:\.\d+)?$/.test(sourceInputs[key].trim())
      ));
    return inputKey ? { nodeId: sourceId, inputs: sourceInputs, inputKey } : null;
  }

  if (/reroute/i.test(classType)) {
    const upstream = Object.values(sourceInputs).filter(isComfyConnection);
    return upstream.length === 1
      ? resolveLinkedDimensionPrimitive(workflowObj, upstream[0], visited)
      : null;
  }
  return null;
}

function planLinkedDimension(
  workflowObj: Record<string, Record<string, unknown>>,
  connection: ComfyConnection,
  value: number,
  assignments: Map<string, LinkedDimensionAssignment>,
  conflicts: Set<string>,
): void {
  const target = resolveLinkedDimensionPrimitive(workflowObj, connection);
  if (!target) return;
  const key = `${target.nodeId}:${target.inputKey}`;
  const previous = assignments.get(key);
  if (previous && previous.value !== value) conflicts.add(key);
  else assignments.set(key, { ...target, value });
}

function applyLinkedDimensionAssignments(
  assignments: Map<string, LinkedDimensionAssignment>,
  conflicts: Set<string>,
): number {
  let applied = 0;
  for (const [key, assignment] of assignments) {
    if (conflicts.has(key)) continue;
    assignment.inputs[assignment.inputKey] = assignment.value;
    applied += 1;
  }
  if (conflicts.size > 0) {
    console.warn('[comfyWorkflowService] 宽高共享同一标量节点且目标值冲突，已保留工作流原值', [...conflicts]);
  }
  return applied;
}

function injectDimensionPairs(
  workflowObj: Record<string, Record<string, unknown>>,
  nodeData: Record<string, unknown>,
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  specs: ComfyNodeInputSpecs | undefined,
  assignments: Map<string, LinkedDimensionAssignment>,
  conflicts: Set<string>,
): number {
  let matched = 0;
  const aliasesAllowed = allowsDimensionAliases(nodeData, inputs);
  for (const [widthKey, heightKey, policy] of DIMENSION_KEY_PAIRS) {
    if (!(widthKey in inputs) || !(heightKey in inputs)) continue;
    if (policy !== 'always' && !aliasesAllowed) continue;
    if (policy === 'custom' && !usesCustomDimensions(inputs)) continue;
    for (const [key, targetValue] of [[widthKey, dims.width], [heightKey, dims.height]] as const) {
      const value = inputs[key];
      const normalized = normalizeComfyDimension(targetValue, specs?.[key]);
      if (canWriteDimensionValue(value, specs?.[key])) {
        inputs[key] = normalized;
        matched += 1;
      } else if (isComfyConnection(value)) {
        planLinkedDimension(workflowObj, value, normalized, assignments, conflicts);
        // 实际写入数由 applyLinkedDimensionAssignments 统一统计；冲突连接不会被误报为已应用。
      }
    }
  }
  return matched;
}

function pickImageResolutionOption(
  options: unknown[],
  imageSize: string,
  dims: { width: number; height: number },
): unknown {
  const normalizedSize = imageSize.trim().toLowerCase();
  const exact = options.find((option): option is string => {
    if (typeof option !== 'string') return false;
    const normalized = option.trim().toLowerCase();
    return normalized === normalizedSize || normalized.startsWith(`${normalizedSize} `);
  });
  if (exact !== undefined) return exact;
  const labeled = pickResolutionOption(options, dims);
  return labeled ?? pickClosestNumericOption(options, Math.min(dims.width, dims.height));
}

interface RatioPresetSelection {
  option: string;
  dimensions?: { width: number; height: number };
}

function parseRatioValue(label: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(label);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : undefined;
}

function parsePresetDimensions(label: string): { width: number; height: number } | undefined {
  const match = /(\d{2,5})\s*[x×]\s*(\d{2,5})/i.exec(label);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width >= 64 && height >= 64 ? { width, height } : undefined;
}

/**
 * CatPixel 这类节点把比例和固定像素合并在一个 combo 里。
 * 只从 object_info 的合法选项中挑精确比例；同一比例有多个档位时再按面积选最近项。
 */
function pickRatioPresetOption(
  options: unknown[],
  aspectRatio: string | undefined,
  dims: { width: number; height: number },
): RatioPresetSelection | undefined {
  if (!aspectRatio) return undefined;
  const targetRatio = parseRatioValue(aspectRatio);
  if (targetRatio === undefined) return undefined;
  const targetArea = dims.width * dims.height;
  let best: RatioPresetSelection | undefined;
  let bestSizeDelta = Infinity;

  for (const option of options) {
    if (typeof option !== 'string') continue;
    const dimensions = parsePresetDimensions(option);
    const candidateRatio = parseRatioValue(option)
      ?? (dimensions ? dimensions.width / dimensions.height : undefined);
    if (candidateRatio === undefined) continue;
    const ratioDelta = Math.abs(candidateRatio - targetRatio) / targetRatio;
    if (ratioDelta > 0.01) continue;
    const sizeDelta = dimensions
      ? Math.abs(Math.log((dimensions.width * dimensions.height) / targetArea))
      : Infinity;
    if (!best || sizeDelta < bestSizeDelta) {
      best = { option, dimensions };
      bestSizeDelta = sizeDelta;
    }
  }
  return best;
}

function writeRatioPresetInput(
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  aspectRatio: string | undefined,
  specs: ComfyNodeInputSpecs | undefined,
): { matched: number; dimensions?: { width: number; height: number } } {
  const current = inputs.ratio_preset;
  const options = specs?.ratio_preset?.options;
  if (typeof current !== 'string' || !options) return { matched: 0 };
  const selected = pickRatioPresetOption(options, aspectRatio, dims);
  if (!selected) return { matched: 0 };
  inputs.ratio_preset = selected.option;
  return { matched: 1, dimensions: selected.dimensions };
}

function writeImageResolutionInputs(
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  imageSize: string,
  specs: ComfyNodeInputSpecs | undefined,
): number {
  let matched = 0;
  for (const key of IMAGE_RESOLUTION_KEYS) {
    const current = inputs[key];
    if (current === undefined || Array.isArray(current)) continue;
    const spec = specs?.[key];
    let next: unknown;
    if (spec?.options) {
      next = pickImageResolutionOption(spec.options, imageSize, dims);
    } else if (typeof current === 'string' && /^(?:720p|[124]k)$/i.test(current.trim())) {
      next = imageSize;
    } else if (typeof current === 'string' && /^\d+\s*[x×]\s*\d+$/i.test(current.trim())) {
      next = `${dims.width}x${dims.height}`;
    } else if (
      key === 'resolution'
      && typeof current === 'number'
      && current >= 64
    ) {
      // 图片尺寸档位以短边定义（1K/2K/4K）；视频的 resolution 才按长边语义处理。
      next = normalizeComfyDimension(Math.min(dims.width, dims.height), spec);
    } else if (
      key === 'resolution'
      && typeof current === 'string'
      && /^\d+(?:\.\d+)?$/.test(current.trim())
      && /^(INT|FLOAT|NUMBER)$/i.test(spec?.type ?? '')
    ) {
      next = normalizeComfyDimension(Math.min(dims.width, dims.height), spec);
    }
    if (next !== undefined) {
      inputs[key] = next;
      matched += 1;
    }
  }
  return matched;
}

function writeResolutionSelector(
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  aspectRatio: string | undefined,
  specs?: ComfyNodeInputSpecs,
): number {
  if (typeof inputs.aspect_ratio !== 'string' || typeof inputs.megapixels !== 'number') return 0;
  // 问得到可选值就按可选值挑（能兼容表里没有的档位写法），问不到再退回内置对照表
  const options = specs?.aspect_ratio?.options;
  const label = options
    ? pickAspectRatioOption(options, aspectRatio)
    : aspectRatio ? RESOLUTION_SELECTOR_RATIOS[aspectRatio] : undefined;
  let matched = 0;
  if (label !== undefined) {
    inputs.aspect_ratio = label;
    matched += 1;
  }
  const megapixels = Math.round((dims.width * dims.height) / 10_000) / 100;
  inputs.megapixels = clampToSpec(megapixels, specs?.megapixels, 0.1, 16);
  return matched + 1;
}

/**
 * 将画布选择的尺寸/比例注入工作流。
 * 注入所有带 width/height 的节点：被 @ 的都是提示词/图片 IO 节点，按它们过滤等于什么都不注入。
 */
export async function injectDimensionsIntoWorkflow(
  baseUrl: string,
  workflowObj: Record<string, Record<string, unknown>>,
  imageSize: string,
  aspectRatio: string,
  resolveParamSpecs: (
    baseUrl: string,
    workflow: Record<string, Record<string, unknown>>,
    inputKeys: readonly string[],
  ) => Promise<Map<string, ComfyNodeInputSpecs>>,
): Promise<{ dimensions: { width: number; height: number }; matchedInputs: number }> {
  const mapped = mapImageDimensions(imageSize, aspectRatio);
  const dims = {
    width: normalizeComfyDimension(mapped.width),
    height: normalizeComfyDimension(mapped.height),
  };
  const specsByClass = await resolveParamSpecs(baseUrl, workflowObj, IMAGE_PARAM_SPEC_KEYS);
  const assignments = new Map<string, LinkedDimensionAssignment>();
  const conflicts = new Set<string>();
  let matchedInputs = 0;
  let nonPresetMatchedInputs = 0;
  let presetDimensions: { width: number; height: number } | undefined;
  let presetDimensionsConflict = false;

  for (const [, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    const classType = String(nodeData.class_type ?? '');
    const specs = specsByClass.get(classType);
    const dimensionPairMatches = injectDimensionPairs(
      workflowObj, nodeData, inputs, dims, specs, assignments, conflicts,
    );
    matchedInputs += dimensionPairMatches;
    nonPresetMatchedInputs += dimensionPairMatches;

    const ratioPresetResult = writeRatioPresetInput(inputs, dims, aspectRatio, specs);
    matchedInputs += ratioPresetResult.matched;
    if (ratioPresetResult.dimensions) {
      if (presetDimensions && (
        presetDimensions.width !== ratioPresetResult.dimensions.width
        || presetDimensions.height !== ratioPresetResult.dimensions.height
      )) {
        presetDimensionsConflict = true;
      } else {
        presetDimensions = ratioPresetResult.dimensions;
      }
    }

    if (typeof inputs.aspect_ratio === 'string' && typeof inputs.megapixels === 'number') {
      const selectorMatches = writeResolutionSelector(inputs, dims, aspectRatio, specs);
      matchedInputs += selectorMatches;
      nonPresetMatchedInputs += selectorMatches;
    } else {
      if (writeAspectRatio(inputs, aspectRatio, specs)) {
        matchedInputs += 1;
        nonPresetMatchedInputs += 1;
      }
    }
    const resolutionMatches = writeImageResolutionInputs(inputs, dims, imageSize, specs);
    matchedInputs += resolutionMatches;
    nonPresetMatchedInputs += resolutionMatches;
  }

  const linkedDimensionMatches = applyLinkedDimensionAssignments(assignments, conflicts);
  matchedInputs += linkedDimensionMatches;
  nonPresetMatchedInputs += linkedDimensionMatches;
  if (matchedInputs === 0) {
    console.warn('[comfyWorkflowService] 工作流未找到可映射的图片宽高或分辨率输入');
  }
  if (presetDimensionsConflict) {
    console.warn('[comfyWorkflowService] 工作流存在多个冲突的比例预设尺寸，结果元数据保留画布目标值');
  }
  const effectiveDimensions = presetDimensions && !presetDimensionsConflict && nonPresetMatchedInputs === 0
    ? presetDimensions
    : dims;
  return { dimensions: effectiveDimensions, matchedInputs };
}

/** 秒数节点：工作流自己按秒算帧数（PrimitiveFloat + 数学表达式），比直接写帧数更可靠 */
function writeDurationSeconds(
  nodeData: Record<string, unknown>,
  inputs: Record<string, unknown>,
  durationSeconds: number,
): boolean {
  if (!/^Primitive(Float|Int)$/i.test(String(nodeData.class_type ?? ''))) return false;
  const title = String((nodeData._meta as Record<string, unknown> | undefined)?.title ?? '');
  if (!/duration|时长|秒/i.test(title) || typeof inputs.value !== 'number') return false;
  inputs.value = durationSeconds;
  return true;
}

/* ──────────────────────────────────────────────────────────────
   视频参数注入
   认哪些输入名是照着 ComfyUI 核心（comfy_extras、comfy_api_nodes）和常用插件的节点定义列的：
   - 帧数：length（Wan / Hunyuan / Mochi / LTXV latent）、num_frames（WanVideoWrapper 全家、
           WanTrackToVideo）、video_frames（SVD_img2vid_Conditioning）、frame_count、frames
   - 帧率：fps（CreateVideo、SaveWEBM、SVD）、frame_rate（LTXVConditioning、VHS_VideoCombine）
   - 时长：duration / duration_seconds（MiniMax、Kling、Vidu、Pixverse、Sora、Veo 等 API 节点，单位秒）
   - 尺寸：width/height；ResolutionSelector 的 aspect_ratio + megapixels；
           API 节点的 aspect_ratio（纯 "16:9"）与 resolution（"720p" 这类档位或 "1920x1080"）
   刻意不碰的：LoadVideo 系列的 custom_width / custom_height / force_rate / frame_load_cap
   （那是给输入素材用的），以及裁剪类节点的 duration（Video Slice 的 duration 是截取长度）。
   ────────────────────────────────────────────────────────────── */

const FRAME_COUNT_KEYS = ['frame_count', 'frames', 'num_frames', 'video_frames'] as const;
const FPS_KEYS = ['fps', 'frame_rate'] as const;
const DURATION_KEYS = ['duration', 'duration_seconds'] as const;
/** 这些输入名要按节点声明的可选值校验才敢写，否则 ComfyUI 会判非法直接拒掉整个任务 */
const COMBO_GUARDED_KEYS = ['aspect_ratio', 'resolution', ...DURATION_KEYS] as const;
export const VIDEO_PARAM_SPEC_KEYS = [
  ...COMBO_GUARDED_KEYS,
  'width', 'height', 'image_width', 'image_height', 'target_width', 'target_height',
  'output_width', 'output_height', 'latent_width', 'latent_height', 'video_width', 'video_height',
  'custom_width', 'custom_height',
] as const;
/** 处理输入素材的节点：同名参数改的是素材本身，不是出片规格 */
const INPUT_MEDIA_CLASS = /load(video|image)|videoload|loadvideo/i;
/** 裁剪类节点：duration 是截取长度而非出片时长 */
const TRIM_CLASS = /slice|trim|cut|crop/i;

/** 档位标签 → 长边像素，用来在 resolution 这类 combo 里挑最接近的一档 */
const RESOLUTION_LABEL_LONG_SIDES: Record<string, number> = {
  '360p': 640, '480p': 854, '540p': 960, '720p': 1280,
  '1080p': 1920, '1440p': 2560, '2160p': 3840,
  '1k': 1024, '2k': 2048, '4k': 3840,
};

/** 从 combo 里挑与目标长边最接近的一档；"1920x1080" 这种写法还要求朝向一致 */
function pickResolutionOption(
  options: unknown[],
  dims: { width: number; height: number },
): string | undefined {
  const targetLongSide = Math.max(dims.width, dims.height);
  const isPortrait = dims.height > dims.width;
  let best: string | undefined;
  let bestDelta = Infinity;
  for (const option of options) {
    if (typeof option !== 'string') continue;
    const explicit = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(option.trim());
    let longSide: number | undefined;
    if (explicit) {
      const width = Number(explicit[1]);
      const height = Number(explicit[2]);
      if (height > width !== isPortrait) continue;
      longSide = Math.max(width, height);
    } else {
      longSide = RESOLUTION_LABEL_LONG_SIDES[option.trim().toLowerCase()];
    }
    if (longSide === undefined) continue;
    const delta = Math.abs(longSide - targetLongSide);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = option;
    }
  }
  return best;
}

/** "16:9" 和 "16:9 (Widescreen)" 都算命中 */
function pickAspectRatioOption(options: unknown[], ratio: string | undefined): string | undefined {
  if (!ratio) return undefined;
  return options.find(
    (option): option is string =>
      typeof option === 'string'
      && (option.trim() === ratio || option.trim().startsWith(`${ratio} `)),
  );
}

/** 时长 combo 只给 5/10 而用户选了 7 时，退到最近的一档，总好过让整个任务被判非法 */
function pickClosestNumericOption(options: unknown[], target: number): unknown {
  let best: unknown;
  let bestDelta = Infinity;
  for (const option of options) {
    const value = typeof option === 'number'
      ? option
      : typeof option === 'string' ? Number(option.trim().replace(/s$/i, '')) : NaN;
    if (!Number.isFinite(value)) continue;
    const delta = Math.abs(value - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = option;
    }
  }
  return best;
}

function clampToSpec(value: number, spec: ComfyInputSpec | undefined, min: number, max: number): number {
  const lower = typeof spec?.min === 'number' ? Math.max(min, spec.min) : min;
  const upper = typeof spec?.max === 'number' ? Math.min(max, spec.max) : max;
  return Math.min(upper, Math.max(lower, value));
}

/** API 节点上的纯比例（"16:9"）；带 megapixels 的 ResolutionSelector 已在别处写过 */
function writeAspectRatio(
  inputs: Record<string, unknown>,
  ratio: string | undefined,
  specs: ComfyNodeInputSpecs | undefined,
): boolean {
  if (typeof inputs.aspect_ratio !== 'string' || typeof inputs.megapixels === 'number') return false;
  const options = specs?.aspect_ratio?.options;
  // 问不到可选值就不写：猜错一个档位写法会让整个任务被拒
  if (!options) return false;
  const picked = pickAspectRatioOption(options, ratio);
  if (picked === undefined) return false;
  inputs.aspect_ratio = picked;
  return true;
}

/** API 节点上的档位式 resolution；数字型的（长边像素）按数字写 */
function writeResolutionInput(
  inputs: Record<string, unknown>,
  dims: { width: number; height: number },
  specs: ComfyNodeInputSpecs | undefined,
): void {
  const current = inputs.resolution;
  if (typeof current === 'number') {
    // 只认已经是像素量级的，避免把倍率、缩放系数之类的同名参数改坏
    if (current >= 64) inputs.resolution = clampToSpec(Math.max(dims.width, dims.height), specs?.resolution, 64, 16_384);
    return;
  }
  if (typeof current !== 'string') return;
  const options = specs?.resolution?.options;
  if (!options) return;
  const picked = pickResolutionOption(options, dims);
  if (picked !== undefined) inputs.resolution = picked;
}

/** 秒数：数字直接写，combo / 字符串保持原来的写法（"5" 还是 "5s"） */
function writeDurationInputs(
  inputs: Record<string, unknown>,
  classType: string,
  durationSeconds: number,
  specs: ComfyNodeInputSpecs | undefined,
): void {
  if (TRIM_CLASS.test(classType)) return;
  for (const key of DURATION_KEYS) {
    const current = inputs[key];
    const spec = specs?.[key];
    if (spec?.options) {
      const picked = pickClosestNumericOption(spec.options, durationSeconds);
      if (picked !== undefined) inputs[key] = picked;
      continue;
    }
    // 字符串型（非 combo）不写：写错格式同样会被判非法
    if (typeof current === 'number') {
      inputs[key] = clampToSpec(durationSeconds, spec, 0, Number.MAX_SAFE_INTEGER);
    }
  }
}

/**
 * 将视频参数注入工作流。
 * 同样不按 @ 过滤：分辨率、帧率、帧数都在 latent / 合成节点上，用户不会去 @ 它们。
 */
export function injectVideoParamsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  videoResolution: number,
  videoRatio: string | undefined,
  videoFps: number,
  videoFrames: number,
  durationSeconds: number,
  specsByClass: Map<string, ComfyNodeInputSpecs> = new Map(),
): void {
  const dims = mapVideoDimensions(videoResolution, videoRatio);
  const assignments = new Map<string, LinkedDimensionAssignment>();
  const conflicts = new Set<string>();

  // 先找秒数节点：工作流自带秒→帧换算时，帧率是它算式里的常量，再去改帧率只会让时长对不上
  let hasDurationNode = false;
  for (const nodeData of Object.values(workflowObj)) {
    const inputs = nodeData?.inputs as Record<string, unknown> | undefined;
    if (inputs && writeDurationSeconds(nodeData, inputs, durationSeconds)) hasDurationNode = true;
  }

  for (const [, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    const classType = String(nodeData.class_type ?? '');
    if (INPUT_MEDIA_CLASS.test(classType)) continue;
    const specs = specsByClass.get(classType);

    // 注入直接宽高、受控别名或其上游 Primitive；连接数组本身始终保留。
    const hasPrimarySizePair = inputs.width !== undefined && inputs.height !== undefined;
    injectDimensionPairs(workflowObj, nodeData, inputs, dims, specs, assignments, conflicts);
    writeResolutionSelector(inputs, dims, videoRatio, specs);
    writeAspectRatio(inputs, videoRatio, specs);
    writeResolutionInput(inputs, dims, specs);

    // 注入帧率到视频相关节点（数字才写：连线过来的值是 ["3", 0] 这种数组，写进去会把连线冲掉）
    if (!hasDurationNode) {
      for (const key of FPS_KEYS) {
        if (typeof inputs[key] === 'number') inputs[key] = clampToSpec(videoFps, specs?.[key], 1, 1000);
      }
    }

    // 注入帧数
    for (const key of FRAME_COUNT_KEYS) {
      if (typeof inputs[key] === 'number') inputs[key] = videoFrames;
    }
    // Wan / Hunyuan / Mochi 的 latent 节点用 length 表示总帧数；
    // 只认带 width/height 的节点，避免误伤其他节点上同名的 length 参数
    if (typeof inputs.length === 'number' && hasPrimarySizePair) {
      inputs.length = videoFrames;
    }

    writeDurationInputs(inputs, classType, durationSeconds, specs);
  }
  applyLinkedDimensionAssignments(assignments, conflicts);
}
