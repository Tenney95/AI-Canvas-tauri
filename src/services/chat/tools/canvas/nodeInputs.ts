import type { Node } from '@xyflow/react';
import { useAppStore } from '../../../../store/useAppStore';
import { assertImageOutputInput, pickImageOutputParameters, resolveConfiguredImageOutput } from '../../../ai/imageOutputParameters';
import type { BaseNodeData, NodeType } from '../../../../types';
import { resolveShotVideoDuration } from '../../../../types/shotlist';
import type { AudioOutputFormat, AudioSpeechSettings, AudioTtsVoice, ImageOutputParameters } from '../../../../types/aiTypes';
import type { AudioGenerationPurpose } from '../../../../types/media';
import type { AgentToolDisplayChange, AgentToolDisplaySnapshot, AgentToolDisplayValue } from '../../../../types/agent';
import { MAX_IMAGE_BATCH_COUNT } from '../../../../types/aiTypes';
import { parseProjectModelRef, PROJECT_IMAGE_ASPECT_RATIOS, PROJECT_IMAGE_SIZES, PROJECT_VIDEO_ASPECT_RATIOS } from '../../../projectSettingsService';
import { type AgentToolSchema } from '../../agentToolSchemas';
import { resolveVideoModelCapability } from '../../../ai/videoModelCapabilityResolver';
import { resolveImageParameterCapability } from '../../../ai/mediaModelCapabilities';
import { isSafeMediaParameterText, resolveConfiguredImageBackground, resolveConfiguredImageQuality } from '../../../ai/modelCapabilityValidation';

const NODE_TYPES: NodeType[] = [
  'ai-text',
  'ai-image',
  'ai-video',
  'ai-audio',
  'ai-animation',
  'ai-panorama',
  'ai-markdown',
  'ai-storyboard',
  'ai-shotlist',
  'ai-director',
  'source-image',
  'source-video',
  'source-audio',
  'source-text',
  'comment',
];

/** 宫格分镜只能由已有图片裁切产生，通用 Agent 创建入口不得伪造空宫格。 */
export const AGENT_CREATABLE_NODE_TYPES = NODE_TYPES.filter((type) => type !== 'ai-storyboard');

const NODE_STATUSES = ['idle', 'loading', 'success', 'error'] as const;

/** 画面比例对这些节点才有意义；动画/分镜/镜头表的节点框由各自组件按格数算，不在这里改。 */
export const VISUAL_NODE_TYPES = new Set<NodeType>([
  'ai-image',
  'ai-video',
  'ai-panorama',
]);

/** source-* 与批注节点的正文直接落进 output，建好就能被下游引用。 */
export function isSourceNodeType(type: NodeType): boolean {
  return type.startsWith('source-') || type === 'comment';
}

/**
 * 节点正文：content 是已经写好的定稿，直接进 output，节点建出来就能看、能被 @ 引用。
 * source-* / comment 没有 content 时沿用旧行为，把 prompt 当正文。
 * 生成型节点的 prompt 不是正文——它要等模型跑完才有 output，不能塞进这里。
 */
export function resolveNodeBody(input: CreateNodeInput): string | undefined {
  return input.content?.trim() || (isSourceNodeType(input.type) ? input.prompt?.trim() : undefined);
}

/** 画面比例取图片与视频两套项目常量的并集，具体是否支持由生成运行时判断。 */
export const ASPECT_RATIOS = [...new Set<string>([
  ...PROJECT_IMAGE_ASPECT_RATIOS,
  ...PROJECT_VIDEO_ASPECT_RATIOS,
])];
/** 只有这些节点的 output 是纯文本，其余节点的 output 可能是本地路径或 URL，不能回传。 */
export const TEXT_OUTPUT_NODE_TYPES = new Set<NodeType>([
  'ai-text',
  'ai-markdown',
  'source-text',
  'comment',
]);
export const TEXT_FILE_NODE_TYPES = new Set<NodeType>(['ai-text', 'ai-markdown', 'source-text']);
const AUDIO_VOICES: AudioTtsVoice[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const AUDIO_FORMATS: AudioOutputFormat[] = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'];
const SPEECH_STYLES: NonNullable<AudioSpeechSettings['voiceStyle']>[] = [
  'male', 'female', 'shota', 'loli', 'girl', 'boy',
];

/** 数字是本地工作流长边像素；480p/720p 等是接口画质档位。 */
export function videoResolutionPatch(input: { videoResolution?: string; videoLongSide?: number }): Partial<BaseNodeData> {
  if (input.videoLongSide !== undefined) return { videoResolution: input.videoLongSide };
  const resolution = input.videoResolution?.trim();
  if (!resolution) return {};
  return /^\d+$/.test(resolution)
    ? { videoResolution: Number(resolution) }
    : { seedanceResolution: resolution };
}

export function visibleVideoResolution(data: BaseNodeData): string | undefined {
  return data.videoResolution !== undefined
    ? String(data.videoResolution)
    : data.seedanceResolution;
}

export function imageOutputNodePatch(input: ImageOutputParameters): ImageOutputParameters {
  return { ...(input.imageOutputFormat !== undefined && input.imageOutputFormat !== 'gif'
    ? { imageFrameCount: undefined, imageFrameDurationMs: undefined, imageTransparent: undefined } : {}),
    ...pickImageOutputParameters(input) };
}

export function audioNodePatch(input: AudioNodeInput): AudioNodeInput {
  return {
    ...(input.audioPurpose !== undefined ? { audioPurpose: input.audioPurpose } : {}),
    ...(input.audioVoice !== undefined ? { audioVoice: input.audioVoice } : {}),
    ...(input.audioFormat !== undefined ? { audioFormat: input.audioFormat } : {}),
    ...(input.audioSpeed !== undefined ? { audioSpeed: input.audioSpeed } : {}),
    ...(input.audioSpeechSettings !== undefined ? { audioSpeechSettings: input.audioSpeechSettings } : {}),
    ...(input.musicDuration !== undefined ? { musicDuration: input.musicDuration } : {}),
    ...(input.musicBpm !== undefined ? { musicBpm: input.musicBpm } : {}),
    ...(input.musicTitle !== undefined ? { musicTitle: input.musicTitle } : {}),
    ...(input.musicLyrics !== undefined ? { musicLyrics: input.musicLyrics } : {}),
    ...(input.autoGenerateLyrics !== undefined ? { autoGenerateLyrics: input.autoGenerateLyrics } : {}),
  };
}

/** 创建和更新共用校验；错误必须在任何 Store 写入前返回，避免半批节点。 */
export function mediaSettingsIssue(type: NodeType, input: CreateNodeInput | UpdateNodesInput, currentData?: BaseNodeData): string | undefined {
  const store = useAppStore.getState();
  const kind = type === 'ai-image' ? 'image' : type === 'ai-video' ? 'video' : undefined;
  const projectDefault = kind && store.projects.find((project) => project.id === store.currentProjectId)?.settings?.defaultModels?.[kind];
  const originalModelRef = input.model ?? (currentData?.model || projectDefault);
  const modelProvider = parseProjectModelRef(originalModelRef)?.provider ?? currentData?.provider;
  const modelRef = originalModelRef && modelProvider && !originalModelRef.includes('/')
    ? `${modelProvider}/${originalModelRef}` : originalModelRef;
  const existingWorkflowId = input.model === undefined ? currentData?.workflowId : undefined;
  const currentModelRef = currentData?.model && currentData.provider && !currentData.model.includes('/')
    ? `${currentData.provider}/${currentData.model}` : currentData?.model;
  const modelChanged = input.model !== undefined && (modelRef !== currentModelRef || modelProvider !== currentData?.provider);
  const checkImageOutput = Object.keys(pickImageOutputParameters(input)).length > 0
    || input.aspectRatio !== undefined && Object.keys(pickImageOutputParameters(currentData ?? {})).length > 0;
  if (input.aspectRatio !== undefined && !VISUAL_NODE_TYPES.has(type)) return 'aspectRatio 只能用于图片或视频节点';
  if (input.imageSize !== undefined || input.batchCount !== undefined
    || input.imageQuality !== undefined || input.imageBackground !== undefined || checkImageOutput) {
    if (type !== 'ai-image') return '图片参数只能用于生图节点';
    if (input.imageSize !== undefined && !PROJECT_IMAGE_SIZES.includes(input.imageSize as typeof PROJECT_IMAGE_SIZES[number]))
      return 'imageSize 不在支持的图片尺寸档位中';
    if (input.batchCount !== undefined && (!Number.isInteger(input.batchCount)
      || input.batchCount < 1 || input.batchCount > MAX_IMAGE_BATCH_COUNT)) return 'batchCount 超出图片批量范围';
    if (input.imageQuality !== undefined && !isSafeMediaParameterText(input.imageQuality, 'imageQuality'))
      return 'imageQuality 格式无效，请使用模型声明的质量选项';
    if (input.imageBackground !== undefined && !isSafeMediaParameterText(input.imageBackground, 'imageBackground'))
      return 'imageBackground 格式无效，请使用模型声明的背景选项或接口默认';
    if (input.imageQuality !== undefined || input.imageBackground !== undefined || checkImageOutput) {
      if (!modelRef || !modelProvider) return '设置图片质量或背景前请先选择模型';
      if (existingWorkflowId || ['comfyui', 'runninghub', 'runninghubwf', 'workflow-api'].includes(modelProvider))
        return '工作流与 RunningHub 请使用专属参数设置质量和背景';
      const capability = resolveImageParameterCapability(modelRef, modelProvider, store.config);
      if (input.imageQuality !== undefined && !capability?.qualities?.length) return '所选模型未声明图片质量参数';
      if (input.imageBackground !== undefined && input.imageBackground !== '' && !capability?.backgrounds?.length)
        return '所选模型未声明图片背景参数';
      if (input.imageBackground === '' && capability?.backgroundIsFixed) return '所选模型的背景由协议固定，不能选择接口默认';
      try {
        resolveConfiguredImageQuality(capability, input.imageQuality);
        resolveConfiguredImageBackground(capability, input.imageBackground);
        const output = { ...(modelChanged || input.imageOutputFormat !== undefined && input.imageOutputFormat !== currentData?.imageOutputFormat
          ? {} : pickImageOutputParameters(currentData ?? {})), ...pickImageOutputParameters(input) };
        resolveConfiguredImageOutput(capability, output);
        assertImageOutputInput(capability, output, { aspectRatio: input.aspectRatio ?? currentData?.aspectRatio
          ?? store.projects.find((project) => project.id === store.currentProjectId)?.settings?.generation?.imageAspectRatio });
      } catch (error) { return error instanceof Error ? error.message : '图片参数无效'; }
    }
  }
  if (input.videoResolution !== undefined || input.videoLongSide !== undefined || input.videoDuration !== undefined
    || input.videoFps !== undefined || input.generateAudio !== undefined) {
    if (type !== 'ai-video') return '视频参数只能用于视频节点';
    if (input.videoResolution !== undefined && !isSafeMediaParameterText(input.videoResolution, 'resolution'))
      return 'videoResolution 格式无效，请使用模型声明的分辨率';
    if (input.videoResolution !== undefined && /^\d+$/.test(input.videoResolution.trim())
      && (Number(input.videoResolution) < 128 || Number(input.videoResolution) > 4096))
      return '视频长边必须在 128–4096 像素之间';
    if (input.videoLongSide !== undefined && (!Number.isInteger(input.videoLongSide)
      || input.videoLongSide < 128 || input.videoLongSide > 4096))
      return 'videoLongSide 必须是 128–4096 的整数像素';
    if (input.videoLongSide !== undefined && input.videoResolution !== undefined)
      return 'videoLongSide 与 videoResolution 只能传一个';
    if (input.videoFps !== undefined && (!Number.isFinite(input.videoFps) || input.videoFps < 1 || input.videoFps > 240))
      return 'videoFps 必须在 1–240 之间';
    if (input.videoFps !== undefined || input.generateAudio !== undefined) {
      if (!modelRef || !modelProvider) return '设置视频帧率或音轨前请先选择模型';
      const isLocalWorkflow = modelProvider === 'comfyui';
      if (['runninghub', 'runninghubwf', 'workflow-api'].includes(modelProvider)
        || (existingWorkflowId && !isLocalWorkflow)) return 'RunningHub 和云工作流请使用专属参数';
      if (isLocalWorkflow && input.generateAudio !== undefined) return '本地工作流请使用工作流音轨参数';
      if (!isLocalWorkflow) {
        const capability = resolveVideoModelCapability(modelRef, store.config, input.videoResolution ?? currentData?.seedanceResolution);
        if (input.videoFps !== undefined && !capability?.frameRates?.includes(input.videoFps))
          return '所选模型未声明或不支持该视频帧率';
        if (input.generateAudio !== undefined && capability?.supportsAudio !== true)
          return '所选模型未声明可调生成音轨开关';
      }
    }
    if (input.videoDuration !== undefined) {
      if (input.videoDuration < 0) {
        const capability = modelRef ? resolveVideoModelCapability(modelRef, store.config, input.videoResolution ?? currentData?.seedanceResolution) : undefined;
        if (capability?.automaticDurationValue !== input.videoDuration)
          return 'videoDuration 的自动时长值必须由所选模型明确支持';
      } else if (resolveShotVideoDuration(input.videoDuration) === undefined) {
        return 'videoDuration 必须是大于 0 且不超过 3600 的秒数，或所选模型支持的自动时长值';
      }
    }
  }
  const audioInput = input.audioPurpose !== undefined || input.audioVoice !== undefined
    || input.audioFormat !== undefined || input.audioSpeed !== undefined
    || input.audioSpeechSettings !== undefined || input.musicDuration !== undefined
    || input.musicBpm !== undefined || input.musicTitle !== undefined
    || input.musicLyrics !== undefined || input.autoGenerateLyrics !== undefined;
  if (audioInput && type !== 'ai-audio') return '音频生成参数只能用于音频节点';
  if (input.audioPurpose !== undefined && !['music', 'speech'].includes(input.audioPurpose)) return 'audioPurpose 必须是 music 或 speech';
  if (input.audioVoice !== undefined) {
    if (typeof input.audioVoice !== 'string' || !input.audioVoice.trim() || input.audioVoice !== input.audioVoice.trim()
      || input.audioVoice.length > 256 || Array.from(input.audioVoice).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      })) {
      return 'audioVoice 必须是 1–256 字符且不含控制字符的音色 ID';
    }
    const modelRef = input.model ?? currentData?.model;
    const provider = parseProjectModelRef(modelRef)?.provider ?? currentData?.provider;
    const config = useAppStore.getState().config;
    const general = provider === 'general' && config.generalModels?.find((model) => model.id === modelRef?.replace(/^general\//, ''));
    // 通用协议可使用厂商公布的音色 ID；具体型号仍在生成前校验，其他入口保留六音色限制。
    if (!(general && config.providers[general.providerConfigId]) && !AUDIO_VOICES.includes(input.audioVoice)) {
      return 'audioVoice 不在当前模型支持的音色中';
    }
  }
  if (input.audioFormat !== undefined && !AUDIO_FORMATS.includes(input.audioFormat)) return 'audioFormat 不在支持的格式中';
  if (input.audioSpeed !== undefined && (!Number.isFinite(input.audioSpeed)
    || input.audioSpeed < 0.25 || input.audioSpeed > 4)) return 'audioSpeed 必须在 0.25–4 之间';
  if (input.musicDuration !== undefined && (!Number.isInteger(input.musicDuration)
    || input.musicDuration < 1 || input.musicDuration > 240)) return 'musicDuration 必须是 1–240 秒的整数';
  if (input.musicBpm !== undefined && (!Number.isInteger(input.musicBpm) || input.musicBpm < 1))
    return 'musicBpm 必须是正整数';
  const speech = input.audioSpeechSettings;
  if (speech && (typeof speech !== 'object' || Array.isArray(speech)
    || Object.keys(speech).some((key) => !['voiceStyle', 'pace', 'duration'].includes(key))
    || (speech.voiceStyle !== undefined && !SPEECH_STYLES.includes(speech.voiceStyle))
    || (speech.pace !== undefined && (!Number.isInteger(speech.pace) || speech.pace < 0 || speech.pace > 4))
    || (speech.duration !== undefined && (!Number.isInteger(speech.duration)
      || speech.duration < 1 || speech.duration > 3600)))) return 'audioSpeechSettings 的音色、语速或时长无效';
  return undefined;
}
export const DETAIL_TEXT_LIMIT = 400;
export const DETAIL_NODE_LIMIT = 50;
export const TEXT_READ_LIMIT = 4000;
export const TEXT_READ_CONTENT_LIMIT = 18_000;
export const MAX_RUN_NODES = 5;
const MIN_NODE_SIZE = 120;
const MAX_NODE_SIZE = 4000;
const DISPLAY_PREVIEW_LIMIT = 1_000;

export interface NodeTargetInput {
  nodeIds?: string[];
  displayIds?: number[];
  nodeType?: NodeType;
  status?: typeof NODE_STATUSES[number];
  selected?: boolean;
}

interface AudioNodeInput {
  audioPurpose?: AudioGenerationPurpose;
  audioVoice?: AudioTtsVoice;
  audioFormat?: AudioOutputFormat;
  audioSpeed?: number;
  audioSpeechSettings?: AudioSpeechSettings;
  musicDuration?: number;
  musicBpm?: number;
  musicTitle?: string;
  musicLyrics?: string;
  autoGenerateLyrics?: boolean;
}

export interface CreateNodesInput {
  nodes: Array<AudioNodeInput & {
    type: NodeType;
    label: string;
    prompt?: string;
    content?: string;
    model?: string;
    dramaAssetId?: string;
    aspectRatio?: string;
    imageSize?: string;
    imageQuality?: string;
    imageBackground?: string;
    imageOutputFormat?: ImageOutputParameters['imageOutputFormat'];
    imageFrameCount?: number;
    imageFrameDurationMs?: number;
    imageTransparent?: boolean;
    batchCount?: number;
    videoResolution?: string;
    videoLongSide?: number;
    videoDuration?: number;
    videoFps?: number;
    generateAudio?: boolean;
    x?: number;
    y?: number;
  }>;
}

export type CreateNodeInput = CreateNodesInput['nodes'][number];

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasRect extends CanvasPoint {
  width: number;
  height: number;
}

export const DEFAULT_NODE_WIDTH = 280;
export const DEFAULT_NODE_HEIGHT = 160;
export const COMMENT_NODE_HEIGHT = 120;
export const MAX_LOCAL_LAYOUT_CANDIDATES = 32;
export const NODE_REFERENCE_PATTERN = /@\{([^:}\r\n]+):[^}\r\n]*\}/g;

export interface QueryNodesInput extends NodeTargetInput {
  detail?: boolean;
  limit?: number;
  offset?: number;
  name?: string;
  nameMatch?: 'contains' | 'exact';
  textField?: 'prompt' | 'output';
  textOffset?: number;
  textLimit?: number;
}

export interface NodeUpdatePatch extends AudioNodeInput {
  expectedNodeHash?: string;
  label?: string;
  prompt?: string;
  promptEdit?: { oldText: string; newText: string };
  content?: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  width?: number;
  height?: number;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  imageQuality?: string;
  imageBackground?: string;
  imageOutputFormat?: ImageOutputParameters['imageOutputFormat'];
  imageFrameCount?: number;
  imageFrameDurationMs?: number;
  imageTransparent?: boolean;
  batchCount?: number;
  /** 统一视频参数名；节点内部继续兼容 seedanceResolution。 */
  videoResolution?: string;
  videoLongSide?: number;
  /** 统一视频参数名；节点内部继续兼容 seedanceDuration。 */
  videoDuration?: number;
  videoFps?: number;
  generateAudio?: boolean;
}

export interface UpdateNodesInput extends NodeTargetInput, NodeUpdatePatch {
  repairMissingCloudOutputs?: boolean;
  removeMissingDramaMentionIds?: string[];
  updates?: Array<{ nodeId: string; patch: NodeUpdatePatch }>;
}

export interface ConnectNodesInput {
  sourceId?: string;
  sourceIds?: string[];
  targetId: string;
}

export interface DisconnectNodesInput {
  sourceId?: string;
  targetId?: string;
}

export interface NodeAuditSnapshot {
  label: string;
  prompt?: string;
  content?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  imageQuality?: string;
  imageBackground?: string;
  imageOutputFormat?: ImageOutputParameters['imageOutputFormat'];
  imageFrameCount?: number;
  imageFrameDurationMs?: number;
  imageTransparent?: boolean;
  batchCount?: number;
  videoResolution?: string;
  videoDuration?: number;
  videoFps?: number;
  generateAudio?: boolean;
  audioPurpose?: AudioGenerationPurpose;
  audioVoice?: AudioTtsVoice;
  audioFormat?: AudioOutputFormat;
  audioSpeed?: number;
  speechVoiceStyle?: AudioSpeechSettings['voiceStyle'];
  speechPace?: number;
  speechDuration?: number;
  musicDuration?: number;
  musicBpm?: number;
  musicTitle?: string;
  autoGenerateLyrics?: boolean;
}

export function displayPreview(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.slice(0, DISPLAY_PREVIEW_LIMIT);
}

export function createNodesInputDisplay(input: CreateNodesInput): AgentToolDisplaySnapshot {
  return {
    entities: input.nodes.map((nodeInput) => ({
      title: nodeInput.label.trim(),
      fields: [
        { label: '类型', value: nodeInput.type },
        ...(nodeInput.videoDuration !== undefined
          ? [{ label: '生成时长（秒）', value: nodeInput.videoDuration < 0 ? '自动' : Math.ceil(nodeInput.videoDuration) }] : []),
        ...(nodeInput.imageQuality !== undefined ? [{ label: '生成质量', value: nodeInput.imageQuality }] : []),
        ...(nodeInput.imageBackground !== undefined ? [{ label: '生成背景', value: nodeInput.imageBackground || '接口默认' }] : []),
        ...(nodeInput.imageOutputFormat !== undefined ? [{ label: '输出格式', value: nodeInput.imageOutputFormat.toUpperCase() }] : []),
        ...(nodeInput.imageFrameCount !== undefined ? [{ label: 'GIF 帧数', value: String(nodeInput.imageFrameCount) }] : []),
        ...(nodeInput.imageFrameDurationMs !== undefined ? [{ label: '每帧时长（毫秒）', value: String(nodeInput.imageFrameDurationMs) }] : []),
        ...(nodeInput.imageTransparent !== undefined ? [{ label: 'GIF 透明背景', value: nodeInput.imageTransparent ? '开启' : '关闭' }] : []),
        ...(nodeInput.videoFps !== undefined ? [{ label: '视频帧率', value: nodeInput.videoFps }] : []),
        ...(nodeInput.generateAudio !== undefined ? [{ label: '生成音轨', value: nodeInput.generateAudio }] : []),
        ...(nodeInput.aspectRatio
          ? [{ label: '比例', value: nodeInput.aspectRatio }]
          : []),
        {
          label: '位置',
          value: nodeInput.x !== undefined && nodeInput.y !== undefined
            ? `(${Math.round(nodeInput.x)}, ${Math.round(nodeInput.y)})`
            : '自动排列',
          source: nodeInput.x !== undefined && nodeInput.y !== undefined
            ? 'user'
            : 'resolved',
        },
      ],
      preview: displayPreview(nodeInput.content ?? nodeInput.prompt),
    })),
  };
}

export function captureNodeAudit(node: Node<BaseNodeData>): NodeAuditSnapshot {
  const data = node.data;
  const aspectRatio = data.type === 'ai-video' ? data.seedanceRatio : data.aspectRatio;
  return {
    label: data.label,
    prompt: displayPreview(data.prompt),
    content: TEXT_OUTPUT_NODE_TYPES.has(data.type) ? displayPreview(data.output) : undefined,
    x: Math.round(node.position.x),
    y: Math.round(node.position.y),
    width: Math.round(Number(data.nodeWidth) || node.measured?.width || DEFAULT_NODE_WIDTH),
    height: Math.round(Number(data.nodeHeight) || node.measured?.height || DEFAULT_NODE_HEIGHT),
    model: typeof data.model === 'string' ? data.model : undefined,
    aspectRatio: typeof aspectRatio === 'string' ? aspectRatio : undefined,
    imageSize: typeof data.imageSize === 'string' ? data.imageSize : undefined,
    imageQuality: data.imageQuality,
    imageBackground: data.imageBackground,
    ...pickImageOutputParameters(data),
    batchCount: typeof data.batchCount === 'number' ? data.batchCount : undefined,
    videoResolution: visibleVideoResolution(data),
    videoDuration: typeof data.seedanceDuration === 'number' ? data.seedanceDuration : undefined,
    videoFps: data.videoFps,
    generateAudio: data.generateAudio,
    audioPurpose: data.audioPurpose,
    audioVoice: data.audioVoice,
    audioFormat: data.audioFormat,
    audioSpeed: data.audioSpeed,
    speechVoiceStyle: data.audioSpeechSettings?.voiceStyle,
    speechPace: data.audioSpeechSettings?.pace,
    speechDuration: data.audioSpeechSettings?.duration,
    musicDuration: data.musicDuration,
    musicBpm: data.musicBpm,
    musicTitle: data.musicTitle,
    autoGenerateLyrics: data.autoGenerateLyrics,
  };
}

const UPDATE_DISPLAY_FIELDS: Array<{
  inputKey: keyof UpdateNodesInput;
  auditKey: keyof NodeAuditSnapshot;
  label: string;
}> = [
  { inputKey: 'label', auditKey: 'label', label: '名称' },
  { inputKey: 'prompt', auditKey: 'prompt', label: '提示词' },
  { inputKey: 'promptEdit', auditKey: 'prompt', label: '提示词' },
  { inputKey: 'content', auditKey: 'content', label: '正文' },
  { inputKey: 'x', auditKey: 'x', label: '位置 X' },
  { inputKey: 'y', auditKey: 'y', label: '位置 Y' },
  { inputKey: 'dx', auditKey: 'x', label: '位置 X' },
  { inputKey: 'dy', auditKey: 'y', label: '位置 Y' },
  { inputKey: 'width', auditKey: 'width', label: '宽度' },
  { inputKey: 'height', auditKey: 'height', label: '高度' },
  { inputKey: 'model', auditKey: 'model', label: '模型' },
  { inputKey: 'aspectRatio', auditKey: 'aspectRatio', label: '画面比例' },
  { inputKey: 'imageSize', auditKey: 'imageSize', label: '图片尺寸' },
  { inputKey: 'imageQuality', auditKey: 'imageQuality', label: '生成质量' },
  { inputKey: 'imageBackground', auditKey: 'imageBackground', label: '生成背景' },
  { inputKey: 'imageOutputFormat', auditKey: 'imageOutputFormat', label: '输出格式' },
  { inputKey: 'imageFrameCount', auditKey: 'imageFrameCount', label: 'GIF 帧数' },
  { inputKey: 'imageFrameDurationMs', auditKey: 'imageFrameDurationMs', label: '每帧时长（毫秒）' },
  { inputKey: 'imageTransparent', auditKey: 'imageTransparent', label: 'GIF 透明背景' },
  { inputKey: 'batchCount', auditKey: 'batchCount', label: '批量数量' },
  { inputKey: 'videoResolution', auditKey: 'videoResolution', label: '视频分辨率' },
  { inputKey: 'videoDuration', auditKey: 'videoDuration', label: '视频时长' },
  { inputKey: 'videoFps', auditKey: 'videoFps', label: '视频帧率' },
  { inputKey: 'generateAudio', auditKey: 'generateAudio', label: '生成音轨' },
  { inputKey: 'audioPurpose', auditKey: 'audioPurpose', label: '音频用途' },
  { inputKey: 'audioVoice', auditKey: 'audioVoice', label: '音色' },
  { inputKey: 'audioFormat', auditKey: 'audioFormat', label: '音频格式' },
  { inputKey: 'audioSpeed', auditKey: 'audioSpeed', label: '语速倍率' },
  { inputKey: 'musicDuration', auditKey: 'musicDuration', label: '音乐时长' },
  { inputKey: 'musicBpm', auditKey: 'musicBpm', label: '音乐 BPM' },
  { inputKey: 'musicTitle', auditKey: 'musicTitle', label: '音乐标题' },
  { inputKey: 'autoGenerateLyrics', auditKey: 'autoGenerateLyrics', label: '自动生成歌词' },
];

export function buildUpdateChanges(
  input: UpdateNodesInput,
  targets: Node<BaseNodeData>[],
  before: Map<string, NodeAuditSnapshot>,
): AgentToolDisplayChange[] {
  const afterById = new Map(targets.map((target) => [target.id, captureNodeAudit(target)]));
  const changes: AgentToolDisplayChange[] = [];
  for (const target of targets) {
    const previous = before.get(target.id);
    const next = afterById.get(target.id);
    if (!previous || !next) continue;
    const seen = new Set<keyof NodeAuditSnapshot>();
    for (const field of UPDATE_DISPLAY_FIELDS) {
      if (input[field.inputKey] === undefined || seen.has(field.auditKey)) continue;
      seen.add(field.auditKey);
      const beforeValue = previous[field.auditKey] as AgentToolDisplayValue | undefined;
      const afterValue = next[field.auditKey] as AgentToolDisplayValue | undefined;
      if (beforeValue === afterValue) continue;
      changes.push({
        targetId: target.id,
        targetLabel: next.label,
        field: field.label,
        before: beforeValue,
        after: afterValue,
      });
    }
  }
  return changes;
}

export const targetProperties = {
  nodeIds: {
    type: 'array' as const,
    items: { type: 'string' as const, minLength: 1, maxLength: 120 },
    maxItems: 50,
  },
  displayIds: {
    type: 'array' as const,
    items: { type: 'integer' as const, minimum: 1 },
    maxItems: 50,
  },
  nodeType: { type: 'string' as const, enum: NODE_TYPES },
  status: { type: 'string' as const, enum: [...NODE_STATUSES] },
  selected: { type: 'boolean' as const },
};

export function createAudioNodeProperties(): Record<string, AgentToolSchema> {
  return {
    audioPurpose: { type: 'string', enum: ['music', 'speech'] },
    audioVoice: { type: 'string', minLength: 1, maxLength: 256, description: '当前模型公布的音色 ID，不含控制字符。' },
    audioFormat: { type: 'string', enum: AUDIO_FORMATS },
    audioSpeed: { type: 'number', minimum: 0.25, maximum: 4 },
    audioSpeechSettings: { type: 'object', additionalProperties: false, properties: {
      voiceStyle: { type: 'string', enum: SPEECH_STYLES },
      pace: { type: 'integer', minimum: 0, maximum: 4 },
      duration: { type: 'integer', minimum: 1, maximum: 3600 },
    } },
    musicDuration: { type: 'integer', minimum: 1, maximum: 240 },
    musicBpm: { type: 'integer', minimum: 1 },
    musicTitle: { type: 'string', maxLength: 120 },
    musicLyrics: { type: 'string', maxLength: 8000 },
    autoGenerateLyrics: { type: 'boolean' },
  };
}

export const nodeUpdateProperties: Record<string, AgentToolSchema> = {
  expectedNodeHash: { type: 'string', minLength: 64, maxLength: 64, description: '上次 canvas_query detail/textField 返回的 nodeHash。只用于恰好一个目标；内容、名称、位置或项目设置变化时整批拒绝。' },
  label: { type: 'string', minLength: 1, maxLength: 120 },
  prompt: { type: 'string', maxLength: 8000 },
  promptEdit: { type: 'object', required: ['oldText', 'newText'], additionalProperties: false, properties: {
    oldText: { type: 'string', minLength: 1, maxLength: 8000 },
    newText: { type: 'string', maxLength: 8000 },
  } },
  content: { type: 'string', maxLength: 40000 },
  x: { type: 'number', minimum: -100000, maximum: 100000 },
  y: { type: 'number', minimum: -100000, maximum: 100000 },
  dx: { type: 'number', minimum: -100000, maximum: 100000 },
  dy: { type: 'number', minimum: -100000, maximum: 100000 },
  width: { type: 'number', minimum: MIN_NODE_SIZE, maximum: MAX_NODE_SIZE },
  height: { type: 'number', minimum: MIN_NODE_SIZE, maximum: MAX_NODE_SIZE },
  model: { type: 'string', minLength: 1, maxLength: 240 },
  aspectRatio: { type: 'string', enum: ASPECT_RATIOS },
  imageSize: { type: 'string', enum: [...PROJECT_IMAGE_SIZES] },
  imageQuality: { type: 'string', minLength: 1, maxLength: 40 },
  imageBackground: { type: 'string', maxLength: 40, description: '空字符串表示接口默认。' },
  imageOutputFormat: { type: 'string', enum: ['png', 'gif', 'svg'], description: '仅所选图片模型声明的格式；GIF/SVG须符合其方图和文生限制。' },
  imageFrameCount: { type: 'integer', minimum: 1 },
  imageFrameDurationMs: { type: 'integer', minimum: 1 },
  imageTransparent: { type: 'boolean' },
  batchCount: { type: 'integer', minimum: 1, maximum: MAX_IMAGE_BATCH_COUNT },
  videoResolution: { type: 'string', minLength: 1, maxLength: 40 },
  videoLongSide: { type: 'integer', minimum: 128, maximum: 4096 },
  videoDuration: { type: 'number', maximum: 3600,
    description: '负数仅允许所选模型声明的自动时长值。' },
  videoFps: { type: 'number', minimum: 1, maximum: 240 },
  generateAudio: { type: 'boolean' },
  ...createAudioNodeProperties(),
};
export const nodeUpdatePatchSchema: AgentToolSchema = { type: 'object', properties: nodeUpdateProperties, additionalProperties: false };

/** 素材节点（source-* / comment）只产出内容，没有输入端，不能作为连线终点。 */
export function isSourceOnlyNode(node: Node<BaseNodeData>): boolean {
  const role = node.data.role;
  if (role) return role === 'source';
  const type = node.type ?? node.data.type;
  return type === 'comment' || (typeof type === 'string' && type.startsWith('source-'));
}
