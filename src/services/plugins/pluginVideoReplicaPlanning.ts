/** 视频复刻的纯规划：生成区间、合法提交时长与参考媒体工作段。 */
import type { MediaReference, NumericInputConstraint, VideoModelCapability } from '../../types/aiTypes';
import { assertVideoModelCapability, resolveCanonicalVideoRequest } from '../ai/videoRequestResolver';

const MAX_DURATION_SECONDS = 300;
const MAX_SEGMENTS = 64;
const MAX_WORKSPACE_SECONDS = 15;
// 严格时长边界预留一帧，避免编码后的时长舍入撞上服务商的排他上限。
const REFERENCE_FRAME_SECONDS = 1 / 24;
const EPSILON = 1e-8;

export interface PluginVideoReplicaReferencePlan {
  key: string;
  inPoint: number;
  outPoint: number;
  /** 可大于素材区间长度；调用方需补齐末帧或静音后再提交。 */
  referenceDuration: number;
}

export interface PluginVideoReplicaSegmentPlan {
  key: string;
  inPoint: number;
  outPoint: number;
  /** -1 等哨兵值保留模型自动时长语义，最终结果仍需验片并裁到目标区间。 */
  generationDuration: number;
  references: PluginVideoReplicaReferencePlan[];
  audioReferences: PluginVideoReplicaReferencePlan[];
}

export interface PluginVideoReplicaPlan {
  duration: number;
  segments: PluginVideoReplicaSegmentPlan[];
  generationCount: number;
  warnings: string[];
}

export interface PluginVideoReplicaPlanInput {
  duration: number;
  /** 内部切点；0 与 duration 由规划器加入，输入必须严格升序。 */
  cuts?: number[];
  capability: VideoModelCapability;
  resolution?: string;
  maxSegmentSeconds?: number;
  controls?: string[];
  /** 存在原声时尝试规划音频参考；不支持时明确返回警告供宿主展示。 */
  hasAudio?: boolean;
}

function effectiveMinimum(range?: NumericInputConstraint): number {
  return range?.min === undefined ? 0 : range.min + (range.minExclusive ? REFERENCE_FRAME_SECONDS : 0);
}

function effectiveMaximum(range?: NumericInputConstraint): number {
  return range?.max === undefined ? Infinity : range.max - (range.maxExclusive ? REFERENCE_FRAME_SECONDS : 0);
}

function referenceCapacity(
  kind: 'video' | 'audio',
  capability: VideoModelCapability,
  copies: number,
): number {
  const count = kind === 'video' ? capability.maxVideoReferences : capability.maxAudioReferences;
  const constraints = kind === 'video' ? capability.inputConstraints?.referenceVideo : capability.inputConstraints?.referenceAudio;
  if (count === undefined || count < copies) throw new Error(`当前模型没有足够的${kind === 'video' ? '视频' : '音频'}参考能力声明`);
  const perReference = Math.min(MAX_WORKSPACE_SECONDS, effectiveMaximum(constraints?.durationSeconds));
  const total = effectiveMaximum(constraints?.totalDurationSeconds) / copies;
  const capacity = Math.min(perReference * Math.floor(count / copies), total);
  if (perReference <= 0 || effectiveMinimum(constraints?.durationSeconds) > perReference || capacity <= 0) {
    throw new Error('模型的参考媒体时长约束无法用于复刻');
  }
  return capacity;
}

function planReferences(
  kind: 'video' | 'audio',
  inPoint: number,
  outPoint: number,
  capability: VideoModelCapability,
  copies: number,
  segmentKey: string,
  minimumTimelineDuration = 0,
): PluginVideoReplicaReferencePlan[] {
  const constraints = kind === 'video' ? capability.inputConstraints?.referenceVideo : capability.inputConstraints?.referenceAudio;
  const maximum = Math.min(MAX_WORKSPACE_SECONDS, effectiveMaximum(constraints?.durationSeconds));
  const minimum = effectiveMinimum(constraints?.durationSeconds);
  const length = outPoint - inPoint;
  const count = Math.max(1, Math.ceil(Math.max(length, minimumTimelineDuration) / maximum));
  const referenceDuration = Math.max(length / count, minimumTimelineDuration / count, minimum,
    effectiveMinimum(constraints?.totalDurationSeconds) / copies / count);
  const declaredCount = kind === 'video' ? capability.maxVideoReferences : capability.maxAudioReferences;
  if (count * copies > (declaredCount ?? 0) || referenceDuration > maximum + EPSILON
    || referenceDuration * count * copies > effectiveMaximum(constraints?.totalDurationSeconds) + EPSILON) {
    throw new Error('所选切点无法满足模型参考媒体的数量或时长约束，请调整分段或更换模型');
  }
  return Array.from({ length: count }, (_, index) => ({
    key: `${segmentKey}-${kind}-${index + 1}`,
    inPoint: inPoint + length * index / count,
    outPoint: index === count - 1 ? outPoint : inPoint + length * (index + 1) / count,
    referenceDuration,
  }));
}

export function planPluginVideoReplica(input: PluginVideoReplicaPlanInput): PluginVideoReplicaPlan {
  const { duration, capability } = input;
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) {
    throw new Error('视频复刻支持大于 0 且不超过 300 秒的完整视频');
  }
  assertVideoModelCapability(capability);
  const controls = input.controls ?? ['depth'];
  if (controls.length > 3 || new Set(controls).size !== controls.length
    || controls.some((control) => !['depth', 'pose', 'canny'].includes(control))) {
    throw new Error('控制视频类型无效或重复');
  }
  const cuts = input.cuts ?? [];
  if (cuts.length >= MAX_SEGMENTS || cuts.some((cut, index) => (
    !Number.isFinite(cut) || cut <= 0 || cut >= duration || (index > 0 && cut <= cuts[index - 1])
  ))) throw new Error('手动切点必须在视频内部严格升序，不能重复');
  if (input.maxSegmentSeconds !== undefined && (!Number.isFinite(input.maxSegmentSeconds) || input.maxSegmentSeconds <= 0)) {
    throw new Error('每段时长必须是大于 0 的有限数值');
  }
  const hasVideo = controls.length > 0;
  const operation = hasVideo ? 'video-to-video'
    : capability.maxImageReferences === 0 || (capability.operations && !capability.operations.includes('image-to-video'))
      ? 'text-to-video' : 'image-to-video';
  if (capability.operations && !capability.operations.includes(operation)) {
    throw new Error(`当前模型不支持 ${operation}，请选择支持控制视频参考的模型或关闭控制视频`);
  }
  const discreteMaximum = capability.durations?.length ? Math.max(...capability.durations) : undefined;
  const declaredMaximum = capability.maxDuration === undefined ? discreteMaximum
    : Math.min(capability.maxDuration, discreteMaximum ?? Infinity);
  if (declaredMaximum === undefined) throw new Error('模型未声明最大生成时长，请先配置视频能力或工作流分段时长');
  let segmentMaximum = Math.min(declaredMaximum, input.maxSegmentSeconds ?? Infinity);
  if (hasVideo) segmentMaximum = Math.min(segmentMaximum, referenceCapacity('video', capability, controls.length));
  const warnings: string[] = [];
  const hasAudioReference = input.hasAudio === true && (capability.maxAudioReferences ?? 0) > 0;
  if (hasAudioReference) segmentMaximum = Math.min(segmentMaximum, referenceCapacity('audio', capability, 1));
  else if (input.hasAudio) warnings.push('当前模型未声明音频参考能力；对白通过转写文本描述，原声在最终合成时保留。');
  if (segmentMaximum <= 0 || !Number.isFinite(segmentMaximum)) throw new Error('当前模型无法规划有效分段');

  const inputMode = operation !== 'text-to-video' || hasAudioReference ? 'reference' : 'text';
  const automaticOnly = capability.inputModeCapabilities?.[inputMode]?.automaticDurationOnly
    ?? capability.operationCapabilities?.[operation]?.automaticDurationOnly;
  if (automaticOnly && capability.automaticDurationValue === undefined) throw new Error('当前操作只支持自动时长，但模型未声明自动时长值');
  const boundaries = [0, ...cuts, duration];
  const segments: PluginVideoReplicaSegmentPlan[] = [];
  // 这里只验证计划参数；真正提示词及其最少字符数由宿主提交前统一校验。
  const planningCapability: VideoModelCapability = {
    ...capability, inputConstraints: { ...capability.inputConstraints, promptMinCharacters: undefined },
  };
  for (let intervalIndex = 0; intervalIndex < boundaries.length - 1; intervalIndex += 1) {
    let inPoint = boundaries[intervalIndex];
    const boundary = boundaries[intervalIndex + 1];
    while (inPoint < boundary) {
      if (segments.length >= MAX_SEGMENTS) throw new Error('分段超过 64 段，请调整切点或每段时长；未提交任何生成任务');
      const outPoint = Math.min(boundary, inPoint + segmentMaximum);
      const length = outPoint - inPoint;
      const key = `segment-${segments.length + 1}`;
      const requestedDuration = automaticOnly ? capability.automaticDurationValue!
        : capability.durations?.length
          ? [...capability.durations].sort((a, b) => a - b).find((value) => value >= length - EPSILON)
          : Math.max(capability.minDuration ?? 0, Math.ceil(length - EPSILON));
      if (requestedDuration === undefined || (!automaticOnly && requestedDuration > declaredMaximum + EPSILON)) {
        throw new Error('当前分段没有合法的模型提交时长');
      }
      const minimumReferenceTimeline = automaticOnly ? capability.minDuration ?? 0 : 0;
      const references = hasVideo ? planReferences('video', inPoint, outPoint, capability, controls.length, key, minimumReferenceTimeline) : [];
      const audioReferences = hasAudioReference ? planReferences('audio', inPoint, outPoint, capability, 1, key, minimumReferenceTimeline) : [];
      const mockReferences: MediaReference[] = [
        ...references.flatMap((reference) => controls.map((control) => ({
          kind: 'video' as const, url: `planning://${reference.key}/${control}`, origin: 'connection' as const, role: 'reference' as const,
        }))),
        ...audioReferences.map((reference) => ({
          kind: 'audio' as const, url: `planning://${reference.key}`, origin: 'connection' as const, role: 'reference_audio' as const,
        })),
        ...(operation === 'image-to-video' ? [{
          kind: 'image' as const, url: 'planning://frame', origin: 'connection' as const, role: 'reference' as const,
        }] : []),
      ];
      const resolved = resolveCanonicalVideoRequest({
        provider: 'planning', model: 'selected-video-model',
        prompt: '复刻视频规划',
        seedanceResolution: input.resolution, seedanceDuration: requestedDuration,
      }, { capability: planningCapability, references: mockReferences });
      segments.push({ key, inPoint, outPoint, generationDuration: resolved.output.durationSeconds, references, audioReferences });
      inPoint = outPoint;
    }
  }
  return { duration, segments, generationCount: segments.length, warnings };
}
