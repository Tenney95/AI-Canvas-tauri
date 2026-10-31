/**
 * VideoParamSelector 视频参数选择器
 * - Seedance 模型 → Seedance 参数（分辨率、宽高比、时长、有声视频）
 * - 其他 provider → 通用视频参数（像素分辨率、帧率、时长）
 */
import Select from '../../shared/Select';
import { Icon } from '@iconify/react';
import ComfyH3MemorySelector from './ComfyH3MemorySelector';
import ViewportImage from '../../shared/ViewportImage';
import VideoCharacterPicker from './VideoCharacterPicker';
import type { MentionPickerItem } from '../../shared/MentionPicker';
import { useT } from '../../../i18n';
import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import AnimatedButton from '../../shared/AnimatedButton';
import type { BaseNodeData, GeneralModelConfig } from '../../../types';
import type {
  VideoGenerationInputMode,
  VideoGenerationOperation,
  VideoModelCapability,
  VideoReferenceItem,
} from '../../../types/aiTypes';
import type { DramaCharacter } from '../../../types/dramaAssets';
import { resolveDramaAssetImageRef, resolveDramaVoiceRef } from '../../../services/dramaAssetPrompt';
import { getApimartSeedanceCapability } from '../../../services/ai/apimartVideoModels';
import { getVolcengineSeedanceCapability } from '../../../services/ai/volcengineVideoModels';
import { getDreaminaVideoCapability } from '../../../services/ai/dreaminaModels';
import { getGrsaiVideoCapability } from '../../../services/ai/grsaiModels';
import { AUTODL_H3_WORKFLOW } from '../../../services/workflowApi/autodlWorkflowManifest';
import { getModelProtocolPresetVideoCapability } from '../../../services/ai/modelProtocol';
import { getProviderDefinition } from '../../../services/ai/providerCatalogService';
import {
  resolveVideoDurationSeconds,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATION_MAX_SECONDS,
  VIDEO_DURATION_MIN_SECONDS,
} from '../../../services/aiDimensions';
import { useAppStore, type AppState } from '../../../store/useAppStore';
import { createCanvasNodeDataSelector, type CanvasNodeDataView } from '../../../utils/canvasNodeDataSelector';
import { getCanvasConnectedSourceNodes } from '../../../utils/canvasConnectionIndex';

interface VideoParamSelectorProps {
  provider?: string;
  selectedModel?: string;
  nodeId?: string;
  videoReferences?: VideoReferenceItem[];
  onChangeVideoReferences?: (value: VideoReferenceItem[]) => void;
  // ── ComfyUI / RunningHub ──
  videoResolution?: number;
  videoFps?: number;
  videoFrames?: number;
  onChangeResolution?: (value: number) => void;
  onChangeFps?: (value: number | undefined) => void;
  // ── Seedance ──
  seedanceResolution?: string;
  seedanceRatio?: string;
  seedanceDuration?: number;
  generateAudio?: boolean;
  onChangeSeedanceResolution?: (value: string | undefined) => void;
  onChangeSeedanceRatio?: (value: string | undefined) => void;
  onChangeSeedanceDuration?: (value: number | undefined) => void;
  onChangeGenerateAudio?: (value: boolean | undefined) => void;
  showSeedanceRatio?: boolean;
  showGenerateAudio?: boolean;
  onContinuousEditEnd?: () => void;
  /** 旧版云工作流的种子等额外字段，与视频参数共用浮层。 */
  extraParameters?: ReactNode;
  disabled?: boolean;
}

const SEEDANCE_RESOLUTIONS = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '4k', label: '4K' },
];

const SEEDANCE_RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
  { value: 'adaptive', label: '自适应' },
];

type ImageReferenceRole = 'first_frame' | 'last_frame' | 'reference';

interface CharacterVideoReferenceOption {
  id: string;
  label: string;
  url: string;
  character?: DramaCharacter;
}

// eslint-disable-next-line react-refresh/only-export-components
export function resolveCharacterVideoReferenceOptions(
  characters: readonly DramaCharacter[],
  canvasNodes: CanvasNodeDataView[],
  scope: 'project' | 'global',
): CharacterVideoReferenceOption[] {
  return characters.flatMap((character) => {
    // 全局角色不从当前项目的同 ID 节点补图；两种范围也不互相覆盖。
    const resolved = resolveDramaAssetImageRef(character, scope === 'project' ? canvasNodes : []);
    return resolved ? [{
      id: `character:${scope === 'global' ? 'global/' : ''}${character.id}`,
      label: character.name, url: resolved.imageUrl, character,
    }] : [];
  });
}

/** 角色主图和明确指定的主音色作为同一次选择的参考素材保存。 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildCharacterVideoReferences(
  option: CharacterVideoReferenceOption,
  provider?: string,
): VideoReferenceItem[] {
  const binding = provider === 'volcengine' ? option.character?.volcengineBinding : undefined;
  const asset = binding?.imageAssetId
    ? { assetId: binding.imageAssetId, name: binding.imageAssetName }
    : binding?.imageAssets?.[0];
  const image: VideoReferenceItem = asset
    ? {
      id: `${option.id}:volcengine:${asset.assetId}`, kind: 'character', role: 'reference',
      url: `asset://${asset.assetId}`, previewUrl: option.url,
      label: asset.name || option.label, provider: 'volcengine', assetId: asset.assetId,
      projectName: binding?.projectName || 'default',
    }
    : {
      id: option.id, kind: 'character', role: 'reference', url: option.url, label: option.label,
      sourceNodeId: option.id.startsWith('character:') ? undefined : option.id,
    };
  const voice = option.character?.primaryVoiceClipId
    ? resolveDramaVoiceRef(option.character, option.character.primaryVoiceClipId) : null;
  if (!voice) return [image];
  return [image, {
    id: `${image.id}:voice`, kind: 'character', mediaKind: 'audio', role: 'reference_audio',
    url: voice.url,
    label: `${option.label} · ${voice.label || '主音色'}`,
  }];
}

const FRAME_ROLE_OPTIONS: Array<{ value: ImageReferenceRole; label: string }> = [
  { value: 'first_frame', label: '首帧' },
  { value: 'reference', label: '中间帧' },
  { value: 'last_frame', label: '尾帧' },
];

// 本地出草稿常用 480/640；更高或更特殊的长边走下面的自定义输入
const COMBO_RESOLUTIONS = [480, 640, 832, 1280];
const MIN_CUSTOM_RESOLUTION = 128;
const MAX_CUSTOM_RESOLUTION = 4096;
const COMBO_FPS_OPTIONS = [
  { value: 16, label: '16帧' },
  { value: 24, label: '24帧' },
  { value: 30, label: '30帧' },
];

/**
 * 兼容新旧节点中的模型引用：优先内部 general ID，其次 Provider 作用域下的真实模型 ID，
 * 最后才接受全局唯一的真实模型 ID，避免同名模型错误串用能力配置。
 */
// 供模型引用兼容测试复用；组件仍是本文件默认导出。
// eslint-disable-next-line react-refresh/only-export-components
export function resolveGeneralVideoModel(
  generalModels: GeneralModelConfig[] | undefined,
  selectedModel: string | undefined,
  provider: string | undefined,
): GeneralModelConfig | undefined {
  if (!generalModels?.length || !selectedModel) return undefined;
  const directId = selectedModel.replace(/^general\//, '');
  const directMatch = generalModels.find((model) => model.id === directId);
  if (directMatch) return directMatch;

  const modelIds = new Set([selectedModel]);
  if (provider && selectedModel.startsWith(`${provider}/`)) {
    modelIds.add(selectedModel.slice(provider.length + 1));
  }
  const scopedMatch = generalModels.find((model) => (
    model.providerConfigId === provider && modelIds.has(model.modelId)
  ));
  if (scopedMatch) return scopedMatch;

  const matches = generalModels.filter((model) => modelIds.has(model.modelId));
  return matches.length === 1 ? matches[0] : undefined;
}

export interface GeneralVideoControlSupport {
  resolution: boolean;
  ratio: boolean;
  duration: boolean;
  frameRate: boolean;
  audio: boolean;
}

/** 通用视频模型的参数面板只读取 capability，不再扫描传输协议 JSON 猜模型能力。 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveGeneralVideoControlSupport(
  capability: VideoModelCapability | undefined,
): GeneralVideoControlSupport {
  return {
    resolution: Boolean(capability?.resolutions?.length || capability?.defaultResolution),
    ratio: Boolean(capability?.ratios?.length || capability?.defaultRatio),
    duration: Boolean(
      capability?.durations?.length
      || capability?.minDuration !== undefined
      || capability?.maxDuration !== undefined
      || capability?.defaultDuration !== undefined
      || capability?.automaticDurationValue !== undefined
    ),
    frameRate: Boolean(capability?.frameRates?.length || capability?.defaultFrameRate !== undefined),
    audio: capability?.supportsAudio === true,
  };
}

export interface GeneralVideoParameterDisplayState {
  resolution?: string;
  ratio?: string;
  duration?: number;
  frameRate?: number;
  generateAudio?: boolean;
}

/** 允许值不等于默认值；只有节点显式值或 capability 明确 default 才能显示为已选择。 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveGeneralVideoParameterDisplayState(
  capability: VideoModelCapability | undefined,
  current: GeneralVideoParameterDisplayState,
): GeneralVideoParameterDisplayState {
  return {
    resolution: current.resolution ?? capability?.defaultResolution,
    ratio: current.ratio ?? capability?.defaultRatio,
    duration: current.duration
      ?? capability?.defaultDuration
      ?? capability?.automaticDurationValue,
    frameRate: current.frameRate ?? capability?.defaultFrameRate,
    generateAudio: current.generateAudio,
  };
}

/** 把输入形态和操作级覆盖折叠成参数面板实际应展示的能力。 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveEffectiveVideoParameterCapability(
  capability: VideoModelCapability | undefined,
  inputMode: VideoGenerationInputMode,
  operation: VideoGenerationOperation,
): VideoModelCapability | undefined {
  if (!capability) return undefined;
  const inputOverride = capability.inputModeCapabilities?.[inputMode];
  const operationOverride = capability.operationCapabilities?.[operation];
  const automaticDurationOnly = inputOverride?.automaticDurationOnly === true
    || operationOverride?.automaticDurationOnly === true;
  return {
    ...capability,
    ratios: inputOverride?.ratios ?? operationOverride?.ratios ?? capability.ratios,
    defaultRatio: inputOverride?.defaultRatio
      ?? operationOverride?.defaultRatio
      ?? capability.defaultRatio,
    ...(automaticDurationOnly ? { defaultDuration: undefined } : {}),
  };
}

/** 只有用户显式指定首/尾帧才进入 keyframe；普通连线图片只是参考图。 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveVideoParameterInputMode(
  frameReferences: readonly (Pick<VideoReferenceItem, 'role'> & Partial<Pick<VideoReferenceItem, 'url'>>)[],
  characterReferenceCount: number,
  connectedCounts: { image: number; video: number; audio: number; imageUrls?: readonly string[] },
): VideoGenerationInputMode {
  const hasKeyframe = frameReferences.some((item) => (
    item.role === 'first_frame' || item.role === 'last_frame'
  ));
  // 生成入口按 URL 合并手动角色和连线图片；界面也应排除已被指定角色的同一张图。
  const assignedUrls = new Set(frameReferences.flatMap((item) => item.url ? [item.url.trim()] : []));
  const hasConnectedReference = connectedCounts.imageUrls
    ? connectedCounts.imageUrls.some((url) => !assignedUrls.has(url.trim()))
    : connectedCounts.image > 0;
  const hasReference = characterReferenceCount > 0
    || frameReferences.some((item) => item.role === 'reference')
    || hasConnectedReference
    || connectedCounts.video > 0
    || connectedCounts.audio > 0;
  if (hasKeyframe && hasReference) return 'mixed';
  if (hasKeyframe) return 'keyframe';
  return hasReference ? 'reference' : 'text';
}

/** 来源按画布顺序返回；展示订阅另按必要媒体字段比较。 */
// eslint-disable-next-line react-refresh/only-export-components
export function selectConnectedVideoSourceNodes(
  state: Pick<AppState, 'nodes' | 'edges'>,
  nodeId: string | undefined,
): AppState['nodes'] {
  return getCanvasConnectedSourceNodes(state.nodes, state.edges, nodeId);
}

export default function VideoParamSelector({
  provider, selectedModel,
  nodeId, videoReferences, onChangeVideoReferences,
  videoResolution, videoFps, videoFrames,
  onChangeResolution, onChangeFps,
  seedanceResolution, seedanceRatio,
  seedanceDuration, generateAudio,
  onChangeSeedanceResolution, onChangeSeedanceRatio,
  onChangeSeedanceDuration, onChangeGenerateAudio,
  showSeedanceRatio = true, showGenerateAudio = true, onContinuousEditEnd, extraParameters, disabled,
}: VideoParamSelectorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // 正在展开的来源选择器：frame = 加参考帧，character = 加参考角色
  const [pickerFor, setPickerFor] = useState<'frame' | 'character' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const characterTriggerRef = useRef<HTMLButtonElement>(null);
  const generalModels = useAppStore((state) => state.config.generalModels);
  const projectCharacters = useAppStore((state) => state.dramaAssets.characters);
  const globalCharacters = useAppStore((state) => state.globalCharacters);
  const loadGlobalCharacters = useAppStore((state) => state.loadGlobalCharacters);
  const globalCharactersLoading = useAppStore((state) => state.globalCharactersLoading);
  // 连线摘要影响模型能力与默认参数，关闭弹层时也必须保持实时。
  const selectConnectedData = useMemo(() => createCanvasNodeDataSelector(
    ['imageUrl', 'videoUrl', 'audioUrl', 'thumbnailUrl', 'filePath'],
  ), []);
  const connectedSourceNodes = useAppStore((state) => selectConnectedData(selectConnectedVideoSourceNodes(state, nodeId)));
  const connectedImageNodes = connectedSourceNodes.filter((node) => (
    Boolean((node.data as BaseNodeData).imageUrl)
  ));
  const connectedVideoCount = connectedSourceNodes.filter((node) => (
    Boolean((node.data as BaseNodeData).videoUrl)
  )).length;
  const connectedAudioCount = connectedSourceNodes.filter((node) => (
    Boolean((node.data as BaseNodeData).audioUrl)
  )).length;
  const selectCharacterNodes = useMemo(() => createCanvasNodeDataSelector(
    ['imageUrl', 'thumbnailUrl'], [...new Set(projectCharacters.flatMap((character) => [
      character.imageNodeId, ...(character.referenceImages ?? []).map((reference) => reference.sourceNodeId),
    ].filter((id): id is string => !!id)))],
  ), [projectCharacters]);
  const canvasNodes = useAppStore((state) => selectCharacterNodes(open ? state.nodes : undefined));
  const workflowApiManifest = useAppStore((state) => state.workflows.find((workflow) =>
    workflow.id === selectedModel?.replace(/^workflow-api\//, ''))?.workflowApi);

  const references = videoReferences ?? [];
  const frameReferences = references.filter((item) => item.kind === 'frame');
  const characterReferences = references.filter((item) => item.kind === 'character' && item.mediaKind !== 'audio');

  const projectCharacterOptions = useMemo(() => (
    open ? resolveCharacterVideoReferenceOptions(projectCharacters, canvasNodes, 'project') : []
  ), [open, canvasNodes, projectCharacters]);
  const globalCharacterOptions = useMemo(() => (
    open ? resolveCharacterVideoReferenceOptions(globalCharacters, [], 'global') : []
  ), [open, globalCharacters]);
  const characterOptions = [...projectCharacterOptions, ...globalCharacterOptions];

  const addReference = (kind: 'frame' | 'character', option: CharacterVideoReferenceOption) => {
    if (disabled) return;
    if (kind === 'frame') setPickerFor(null);
    if (kind === 'character') {
      const characterItems = buildCharacterVideoReferences(option, provider);
      if (references.some((item) => item.id === characterItems[0].id)) return;
      onChangeVideoReferences?.([...references, ...characterItems]);
      return;
    }
    if (references.some((item) => item.id === option.id && item.kind === kind)) return;
    const role: VideoReferenceItem['role'] = frameReferences.some((item) => item.role === 'first_frame')
      ? 'last_frame' : 'first_frame';
    onChangeVideoReferences?.([...references, {
      id: option.id, kind, role, url: option.url, label: option.label,
      sourceNodeId: option.id.startsWith('character:') ? undefined : option.id,
    }]);
  };

  const characterPickerItems = (options: CharacterVideoReferenceOption[]): MentionPickerItem[] => options.map((option) => ({
    key: option.id, label: option.label, thumbnailUrl: option.url, icon: 'lucide:user-round',
    title: [option.label, option.character?.identity, option.character?.summary, option.character?.visualNotes,
      ...(option.character?.aliases ?? [])].filter(Boolean).join(' · '),
    disabled: references.some((item) => item.id === buildCharacterVideoReferences(option, provider)[0].id),
    onSelect: () => addReference('character', option),
  }));
  const closeCharacterPicker = useCallback(() => setPickerFor(null), []);

  const setFrameRole = (itemId: string, role: ImageReferenceRole) => {
    onChangeVideoReferences?.(references.map((item) => {
      if (item.id === itemId) return { ...item, role };
      // 首帧、尾帧各自唯一
      if ((item.mediaKind ?? 'image') === 'image' && role !== 'reference' && item.role === role) {
        return { ...item, role: 'reference' as const };
      }
      return item;
    }));
  };

  const getReferencePreviewUrl = (item: VideoReferenceItem) => {
    if (item.previewUrl || !item.url.startsWith('asset://')) return item.previewUrl || item.url;
    const characterOptionId = item.id.split(':volcengine:')[0];
    return characterOptions.find((option) => option.id === characterOptionId)?.url || item.url;
  };


  // 关弹窗时一并收起来源选择器，下次打开从干净状态开始
  const closePopup = useCallback(() => {
    setOpen(false);
    setPickerFor(null);
    onContinuousEditEnd?.();
  }, [onContinuousEditEnd, setOpen, setPickerFor]);

  const removeReference = (itemId: string) => {
    onChangeVideoReferences?.(references.filter((item) => item.id !== itemId && item.id !== `${itemId}:voice`));
  };

  const generalModel = useMemo(() => {
    return resolveGeneralVideoModel(generalModels, selectedModel, provider);
  }, [generalModels, provider, selectedModel]);
  const settingsConnectionId = provider === 'general' ? generalModel?.providerConfigId : provider;
  const settingsConnection = useAppStore((state) => (
    settingsConnectionId ? state.config.providers[settingsConnectionId] : undefined
  ));
  const settingsModelId = generalModel?.providerConfigId === settingsConnectionId
    ? generalModel?.modelId
    : settingsConnectionId && selectedModel?.startsWith(`${settingsConnectionId}/`)
      ? selectedModel.slice(settingsConnectionId.length + 1) : selectedModel;
  const settingsModel = settingsConnectionId && settingsConnection
    && getProviderDefinition(settingsConnectionId, settingsConnection)?.id === 'custom-openai'
    ? settingsConnection.selectedModels?.find((model) => model.id === settingsModelId && model.category === 'video')
    : undefined;

  const apimartCapability = provider === 'apimart'
    ? getApimartSeedanceCapability(selectedModel)
    : undefined;
  const volcengineCapability = provider === 'volcengine'
    ? getVolcengineSeedanceCapability(selectedModel)
    : undefined;
  const dreaminaCapability = provider === 'dreamina'
    ? getDreaminaVideoCapability(selectedModel)
    : undefined;
  const grsaiCapability = provider === 'grsai'
    ? getGrsaiVideoCapability(selectedModel, seedanceResolution) : undefined;
  const generalCapability = generalModel
    ? generalModel.videoCapability
      ?? getModelProtocolPresetVideoCapability(generalModel.executionProfile)
    : undefined;
  // 原生模型和通用模型共享参数面板，但通用模型不再经过会补齐 Seedance 默认值的能力视图。
  // 这样 capability 未声明的字段会保持未指定，不会被 UI 悄悄写成 720p / 16:9 / 24fps。
  const workflowApiCapability: VideoModelCapability | undefined = provider === 'workflow-api' && workflowApiManifest?.version === 1
    ? AUTODL_H3_WORKFLOW.capability : undefined;
  const nativeCapability = apimartCapability ?? volcengineCapability ?? dreaminaCapability;
  const nativeParameterCapability: VideoModelCapability | undefined = nativeCapability
    ? {
      ...nativeCapability,
      operations: [...nativeCapability.operations],
      resolutions: [...nativeCapability.resolutions],
      ratios: [...nativeCapability.ratios],
      supportsAudio: Boolean(nativeCapability.audioField),
      ...('allowsAudioOnly' in nativeCapability
        ? { supportsStandaloneAudio: nativeCapability.allowsAudioOnly }
        : {}),
    }
    : undefined;
  const baseParameterCapability = nativeParameterCapability
    ?? grsaiCapability
    ?? workflowApiCapability
    ?? generalCapability;
  const selectedInputMode = resolveVideoParameterInputMode(
    frameReferences,
    characterReferences.length,
    {
      image: connectedImageNodes.length,
      imageUrls: connectedImageNodes.map((node) => (node.data as BaseNodeData).imageUrl!),
      video: connectedVideoCount,
      audio: connectedAudioCount,
    },
  );
  const selectedOperation: VideoGenerationOperation = connectedVideoCount > 0
    ? 'video-to-video'
    : references.length > 0 || connectedImageNodes.length > 0
      ? 'image-to-video'
      : 'text-to-video';
  const parameterCapability = resolveEffectiveVideoParameterCapability(
    baseParameterCapability,
    selectedInputMode,
    selectedOperation,
  );
  const inputModeCapability = baseParameterCapability?.inputModeCapabilities?.[selectedInputMode];
  const operationCapability = baseParameterCapability?.operationCapabilities?.[selectedOperation];
  const automaticDurationOnly = inputModeCapability?.automaticDurationOnly === true
    || operationCapability?.automaticDurationOnly === true;
  const generalDisplayState = resolveGeneralVideoParameterDisplayState(parameterCapability, {
    resolution: seedanceResolution,
    ratio: seedanceRatio,
    duration: seedanceDuration,
    frameRate: videoFps,
    generateAudio,
  });
  const isNativeSeedance = provider === 'volcengine' || provider === 'dreamina' || Boolean(apimartCapability || grsaiCapability || workflowApiCapability);
  const generalControlSupport = resolveGeneralVideoControlSupport(generalCapability);
  const hasParameterOverrides = [
    ...Object.values(generalCapability?.inputModeCapabilities ?? {}),
    ...Object.values(generalCapability?.operationCapabilities ?? {}),
  ].some((capability) => capability?.ratios?.length || capability?.defaultRatio || capability?.automaticDurationOnly);
  const needsParameterSettings = Boolean(settingsModel)
    && !Object.values(generalControlSupport).some(Boolean) && !hasParameterOverrides;
  // 本地工作流（ComfyUI / RunningHub）才按像素分辨率 + 帧率走；
  // 其余接口模型使用按秒表达的 API 布局；具体控件仍只由 capability 决定。
  const isWorkflowProvider = provider === 'comfyui' || provider === 'runninghub' || !provider;
  const usesDurationControls = isNativeSeedance || !isWorkflowProvider;
  const legacyVideoResolution = videoResolution ?? 832;
  const legacyVideoFps = videoFps ?? 24;
  const legacySeedanceRatio = seedanceRatio ?? '16:9';
  // 非 Seedance（ComfyUI / RunningHub / 自建模型）：比例换算成 width/height 后注入请求
  const genericRatios = VIDEO_ASPECT_RATIOS.map((value) => ({ value, label: value }));
  const showGenericRatio = showSeedanceRatio;
  const genericRatio = legacySeedanceRatio;
  const declaredResolutions = parameterCapability?.resolutions?.length
    ? parameterCapability.resolutions
    : parameterCapability?.defaultResolution
      ? [parameterCapability.defaultResolution]
      : undefined;
  const declaredRatios = parameterCapability?.ratios?.length
    ? parameterCapability.ratios
    : parameterCapability?.defaultRatio
      ? [parameterCapability.defaultRatio]
      : undefined;
  const seedanceResolutions = declaredResolutions
    ? declaredResolutions.map((value) => ({ value, label: value === '4k' ? '4K' : value }))
    : generalModel ? [] : SEEDANCE_RESOLUTIONS;
  const seedanceRatios = declaredRatios
    ? declaredRatios.map((value) => ({ value, label: value }))
    : isNativeSeedance || !isWorkflowProvider
      ? generalModel ? [] : SEEDANCE_RATIOS
      : genericRatios;
  // 参考素材上限只能读模型真正声明的值，不能用 UI 兼容默认值充当模型约束。
  const referenceLimits = apimartCapability
    ?? grsaiCapability
    ?? volcengineCapability
    ?? dreaminaCapability
    ?? workflowApiCapability
    ?? generalCapability;
  const describeLimit = (max: number | undefined, kind: 'image' | 'video' | 'audio') => {
    if (max === undefined) return '';
    const labels = {
      image: ['不支持参考图', '最多 {count} 张参考图'],
      video: ['不支持参考视频', '最多 {count} 个参考视频'],
      audio: ['不支持参考音频', '最多 {count} 个参考音频'],
    };
    return t(labels[kind][max === 0 ? 0 : 1], { count: max });
  };
  const referenceLimitTip = referenceLimits
    ? [
      describeLimit(referenceLimits.maxImageReferences, 'image'),
      describeLimit(referenceLimits.maxVideoReferences, 'video'),
      describeLimit(referenceLimits.maxAudioReferences, 'audio'),
    ].filter(Boolean).join('、')
    : '';
  const durationCandidates = [
    ...(parameterCapability?.durations ?? []),
    ...(parameterCapability?.defaultDuration === undefined ? [] : [parameterCapability.defaultDuration]),
  ].filter((value) => value >= 0);
  const minDuration = parameterCapability?.minDuration
    ?? (durationCandidates.length ? Math.min(...durationCandidates) : VIDEO_DURATION_MIN_SECONDS);
  const maxDuration = parameterCapability?.maxDuration
    ?? (durationCandidates.length ? Math.max(...durationCandidates) : VIDEO_DURATION_MAX_SECONDS);
  // 文档写「仅支持 10 或 15 秒」这类离散取值时，只给这几档，不能用连续滑杆
  const allowedDurations = parameterCapability?.durations?.length
    ? [...parameterCapability.durations].sort((left, right) => left - right)
    : undefined;
  const automaticDurationValue = parameterCapability?.automaticDurationValue;
  const capabilityDurationDefault = automaticDurationOnly
    ? automaticDurationValue
    : parameterCapability?.defaultDuration ?? automaticDurationValue;
  const useUnboundedDurationInput = Boolean(
    generalModel
    && !allowedDurations
    && (generalCapability?.minDuration === undefined || generalCapability?.maxDuration === undefined),
  );
  const durationTooltip = apimartCapability?.durationMode === 'without-video'
    ? t('仅支持 4 / 6 / 8 / 10 秒。使用参考视频时，此时长设置不生效，由模型决定输出时长。')
    : allowedDurations
    ? t('该模型仅支持 {durations} 秒。', { durations: allowedDurations.join(' / ') })
    : useUnboundedDurationInput
      ? generalCapability?.minDuration !== undefined
        ? t('该模型仅声明最短 {duration} 秒；未声明最长时长。', { duration: generalCapability.minDuration })
        : generalCapability?.maxDuration !== undefined
          ? t('该模型仅声明最长 {duration} 秒；未声明最短时长。', { duration: generalCapability.maxDuration })
          : t('该模型未声明固定时长范围；输入值会在提交前由 capability 和接口校验。')
      : automaticDurationOnly
        ? t('当前参考素材形态只允许模型自动决定时长。')
        : automaticDurationValue !== undefined
          ? t('可选“自动”，或显式指定 {min}-{max} 秒。', { min: minDuration, max: maxDuration })
          : t('整数秒，范围 {min}-{max}。值越大视频越长、耗时越高。', { min: minDuration, max: maxDuration });
  const requestedDuration = automaticDurationOnly
    ? automaticDurationValue
    : seedanceDuration
      ?? (generalModel ? generalDisplayState.duration : capabilityDurationDefault)
      ?? (generalModel
        ? undefined
        // 缺少帧数时与提交层共用默认秒数，不能用临时的 77 帧显示成 3 秒。
        : resolveVideoDurationSeconds(undefined, videoFrames, legacyVideoFps, maxDuration));
  const displayedDuration = generalModel
    || requestedDuration === undefined
    || requestedDuration === automaticDurationValue
    ? requestedDuration
    : allowedDurations
      ? allowedDurations.reduce((best, value) => (
        Math.abs(value - requestedDuration) < Math.abs(best - requestedDuration) ? value : best
      ), allowedDurations[0])
      : Math.min(maxDuration, Math.max(minDuration, requestedDuration));
  const durationControlValue = displayedDuration === undefined || displayedDuration < 0
    ? allowedDurations?.[0] ?? minDuration
    : Math.min(maxDuration, Math.max(minDuration, displayedDuration));
  const displayedResolution = generalModel
    ? generalDisplayState.resolution
    : seedanceResolution && seedanceResolutions.some((item) => item.value === seedanceResolution)
      ? seedanceResolution
      : parameterCapability?.defaultResolution ?? seedanceResolutions[0]?.value ?? '720p';
  // 比例属于用户选择；新模型不支持时保留原值，由提交前校验提示，不能悄悄换成模型默认。
  const displayedRatio = seedanceRatio ?? (generalModel
    ? generalDisplayState.ratio
    : parameterCapability?.defaultRatio ?? seedanceRatios[0]?.value ?? '16:9');
  const configuredFrameRates = generalCapability?.frameRates?.length
    ? [...generalCapability.frameRates].sort((left, right) => left - right)
    : generalCapability?.defaultFrameRate === undefined
      ? undefined
      : [generalCapability.defaultFrameRate];
  const displayedFrameRate = generalDisplayState.frameRate;
  // 标签按跨度等距抽样，保证数字之间有足够间距不重叠：
  // 跨度 ≤8（如 4~12）每秒都标；≤16（如 4~15/4~20）每 2s 标一个；
  // 更大（如 2.5 的 4~30）每 4s 标一个。端点 min/max 始终标。
  const durationSpan = Math.max(1, maxDuration - minDuration);
  const labelStep = durationSpan <= 8 ? 1 : durationSpan <= 16 ? 2 : 4;
  const durationLabelValues = new Set<number>();
  for (let v = minDuration; v <= maxDuration; v += labelStep) {
    durationLabelValues.add(v);
  }
  durationLabelValues.add(maxDuration);
  // 每一秒都保留一个等宽刻度槽，只隐藏中间文字；位置因此和原生 range 的步进严格一致。
  const durationTicks = Array.from(
    { length: Math.max(1, maxDuration - minDuration + 1) },
    (_, index) => minDuration + index,
  );
  const showResolutionControl = isNativeSeedance || generalControlSupport.resolution;
  const showRatioControl = showSeedanceRatio && (isNativeSeedance || generalControlSupport.ratio);
  // 自定义 API 只有 capability 声明了时长语义才显示；内置 API 保留原有时长控件。
  const showDurationControl = apimartCapability?.durationMode === 'automatic'
    ? false
    : generalModel ? generalControlSupport.duration : true;
  const showFrameRateControl = Boolean(generalModel && generalControlSupport.frameRate);
  const supportsAudio = isNativeSeedance
    ? Boolean(nativeCapability?.audioField)
    : generalControlSupport.audio;
  // 音频能力必须由模型 capability 明确声明，未知能力保持关闭。
  const displayedGenerateAudio = generateAudio
    ?? nativeCapability?.defaultAudio
    ?? false;
  // 原生合同缺少 audioField 只表示没有开关，不能据此断言模型不能生成音轨。
  const explicitlyUnsupportedAudio = (generalCapability ?? grsaiCapability ?? workflowApiCapability)?.supportsAudio === false;

  useEffect(() => {
    if (!parameterCapability) return;
    if (displayedResolution !== undefined
      && (isNativeSeedance || generalCapability?.defaultResolution !== undefined)
      && displayedResolution !== seedanceResolution) {
      onChangeSeedanceResolution?.(displayedResolution);
    }
    if (displayedDuration !== undefined
      && (isNativeSeedance
        || generalCapability?.defaultDuration !== undefined
        || generalCapability?.automaticDurationValue !== undefined)
      && displayedDuration !== seedanceDuration) {
      onChangeSeedanceDuration?.(displayedDuration);
    }
    if (generateAudio === true && explicitlyUnsupportedAudio) {
      onChangeGenerateAudio?.(undefined);
    }
    if (displayedFrameRate !== undefined
      && showFrameRateControl
      && generalCapability?.defaultFrameRate !== undefined
      && displayedFrameRate !== videoFps) {
      onChangeFps?.(displayedFrameRate);
    }
  }, [
    parameterCapability,
    displayedDuration,
    displayedResolution,
    displayedFrameRate,
    generalCapability?.defaultDuration,
    generalCapability?.automaticDurationValue,
    generalCapability?.defaultFrameRate,
    generalCapability?.defaultResolution,
    explicitlyUnsupportedAudio,
    generateAudio,
    isNativeSeedance,
    onChangeSeedanceDuration,
    onChangeGenerateAudio,
    onChangeSeedanceResolution,
    onChangeFps,
    seedanceDuration,
    seedanceResolution,
    showFrameRateControl,
    videoFps,
  ]);

  // 角色库是懒加载的，打开来源选择器时补一次全局角色
  useEffect(() => {
    if (pickerFor === 'character' && globalCharacters.length === 0) void loadGlobalCharacters();
  }, [globalCharacters.length, loadGlobalCharacters, pickerFor]);

  // Close popup on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-ui-select-portal]')) return;
      if (ref.current && !ref.current.contains(e.target as Node)) closePopup();
    };
    if (open) document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open, closePopup]);

  // Close popup on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopup();
    };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, closePopup]);

  // ── 触发按钮文案 ──
  const durationLabelParts = [
    showResolutionControl ? displayedResolution ?? t('分辨率模型默认') : '',
    showDurationControl
      ? displayedDuration === undefined
        ? t('时长模型默认')
        : displayedDuration === automaticDurationValue ? t('时长自动') : t('时长{duration}s', { duration: displayedDuration ?? '' })
      : '',
    showRatioControl ? displayedRatio ?? t('比例模型默认') : '',
    showFrameRateControl ? displayedFrameRate === undefined ? t('帧率模型默认') : t('{count}帧', { count: displayedFrameRate }) : '',
    supportsAudio && generalModel
      ? generateAudio === undefined ? t('音频模型默认') : generateAudio ? t('有声视频') : t('无声视频')
      : '',
  ].filter(Boolean);
  const durationTriggerLabel = durationLabelParts.length > 0
    ? durationLabelParts.join(' · ')
    : supportsAudio
      ? generalModel && generateAudio === undefined
        ? t('音频模型默认')
        : displayedGenerateAudio ? t('有声视频') : t('无声视频')
      : t('模型默认参数');
  const triggerLabel = needsParameterSettings
    ? t('参数')
    : usesDurationControls
      ? durationTriggerLabel
      : showGenericRatio
        ? t('{ratio} · {resolution} · 时长{duration}s', { ratio: genericRatio, resolution: legacyVideoResolution, duration: displayedDuration ?? '' })
        : t('时长{duration}s · 帧率{fps} · 分辨率{resolution}', { duration: displayedDuration ?? '', fps: legacyVideoFps, resolution: legacyVideoResolution });

  return (<>
    <div className="ui-schema-renderer" data-ui-schema-placement="videoParams" ref={ref}>
      <div className="ui-schema-quality-ratio-pill">
        <AnimatedButton
          type="button"
          className="img-pill-btn ui-schema-menu-trigger"
          title={triggerLabel}
          aria-label={needsParameterSettings && settingsModel ? t('{name} · 参数', { name: settingsModel.name }) : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (needsParameterSettings && settingsConnectionId && settingsModel) {
              closePopup();
              useAppStore.getState().openApiKeySettings(settingsConnectionId, settingsModel.id);
              return;
            }
            if (open) closePopup(); else setOpen(true);
          }}
        >
          <Icon icon="lucide:film" width={12} height={12} aria-hidden="true" />
          <span className="ui-schema-pill-label ui-schema-quality-ratio-label">{triggerLabel}</span>
        </AnimatedButton>

        {open && !needsParameterSettings && (
          <div className="img-ratio-popup ui-schema-popup ui-schema-video-params-popup" style={{ display: 'block' }}
            data-cloud-workflow-parameters={extraParameters ? '' : undefined}>
            <fieldset className="m-0 min-w-0 border-0 p-0" disabled={disabled}
              onClickCapture={disabled ? (event) => { event.preventDefault(); event.stopPropagation(); } : undefined}>
            {onChangeVideoReferences && provider !== 'workflow-api' && (
              <div className="img-rp-quality-area mb-2">
                <div className="img-rp-section-label rh-video-ref-head">
                  <span>
                    {t('参考帧')}
                    <span className="rh-tip" data-tooltip={`${t('可选：指定某张图作为视频的首帧或尾帧，其余作为中间参考帧。不添加时按连线顺序交给模型。')}${referenceLimitTip ? `
${t('该模型：{limits}（连线带入的素材一并计数）。', { limits: referenceLimitTip })}` : ''}`}>!</span>
                  </span>
                  <button type="button" className="rh-video-ref-add" onClick={() => setPickerFor(pickerFor === 'frame' ? null : 'frame')}>
                    {t(pickerFor === 'frame' ? '取消' : '＋ 添加')}
                  </button>
                </div>
                {frameReferences.length > 0 && (
                  <div className="rh-video-frame-list">
                    {frameReferences.map((item) => (
                      <div key={item.id} className="rh-video-frame-row">
                        <ViewportImage className="rh-video-frame-thumb" src={getReferencePreviewUrl(item)} alt={item.label || t('参考帧')} title={item.label} loading="lazy" />
                        <div className="img-rp-quality-segmented rh-video-frame-seg">
                          {FRAME_ROLE_OPTIONS.map((option) => (
                            <AnimatedButton
                              key={option.value}
                              type="button"
                              className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${item.role === option.value ? 'active' : ''}`}
                              onClick={() => setFrameRole(item.id, option.value)}
                            >
                              {t(option.label)}
                            </AnimatedButton>
                          ))}
                        </div>
                        <button type="button" className="rh-video-ref-remove" aria-label={t('移除 {name}', { name: item.label || t('参考帧') })} onClick={() => removeReference(item.id)}>✕</button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="img-rp-section-label rh-video-ref-head mt-2">
                  <span>
                    {t('参考角色')}
                    <span className="rh-tip" data-tooltip={t('可选：从本项目角色或全局角色中挑选角色形象，作为参考图提交。若角色设置了可用的主音色，也会携带音频作为参考；当前模型不支持参考音频时，生成前会提示。提示词中提到角色名字时，会说明它对应的参考图。')}>!</span>
                  </span>
                  <button ref={characterTriggerRef} type="button" className="rh-video-ref-add"
                    aria-haspopup="dialog" aria-expanded={pickerFor === 'character'}
                    onClick={() => setPickerFor(pickerFor === 'character' ? null : 'character')}>
                    {t(pickerFor === 'character' ? '取消' : '＋ 添加')}
                  </button>
                </div>
                {characterReferences.length > 0 && (
                  <div className="rh-video-frame-list">
                    {characterReferences.map((item) => (
                      <div key={item.id} className="rh-video-frame-row">
                        <ViewportImage className="rh-video-frame-thumb" src={getReferencePreviewUrl(item)} alt={item.label || t('参考角色')} title={item.label} loading="lazy" />
                        <span className="rh-video-ref-name">{item.label || t('参考角色')}</span>
                        {references.some((reference) => reference.id === `${item.id}:voice` && reference.mediaKind === 'audio') && (
                          <span className="shrink-0 text-[10px] text-canvas-text-muted">{t('含主音色')}</span>
                        )}
                        <button type="button" className="rh-video-ref-remove" aria-label={t('移除 {name}', { name: item.label || t('参考角色') })} onClick={() => removeReference(item.id)}>✕</button>
                      </div>
                    ))}
                  </div>
                )}

                {pickerFor === 'character' && !disabled && <VideoCharacterPicker anchorRef={characterTriggerRef}
                  projectItems={characterPickerItems(projectCharacterOptions)} globalItems={characterPickerItems(globalCharacterOptions)}
                  globalLoading={globalCharactersLoading} onReloadGlobal={() => { void loadGlobalCharacters(); }}
                  onClose={closeCharacterPicker} />}
                {pickerFor === 'frame' && (
                  <div className="rh-video-ref-picker">
                    {connectedImageNodes.length > 0 && <div className="rh-video-ref-picker-label">{t('连线节点')}</div>}
                    {connectedImageNodes.map((node) => {
                      const data = node.data as BaseNodeData;
                      return (
                        <button
                          key={node.id}
                          type="button"
                          className="rh-video-ref-option"
                          onClick={() => addReference('frame', { id: node.id, label: data.label || t('参考图'), url: data.imageUrl as string })}
                        >
                          <ViewportImage className="rh-video-frame-thumb" src={data.imageUrl} alt="" loading="lazy" />
                          <span className="rh-video-ref-name">{data.label || t('参考图')}</span>
                        </button>
                      );
                    })}
                    {connectedImageNodes.length === 0 && (
                      <div className="rh-video-ref-empty">
                        {t('还没有可选的图片：先给视频节点连一个图片节点')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {usesDurationControls ? (
              <>
                {/* Seedance 分辨率 */}
                {showResolutionControl && <div className="img-rp-quality-area mb-2">
                  <div className="img-rp-section-label">
                    {t('分辨率')}
                    <span className="rh-tip" data-tooltip={t('只展示模型 capability 声明支持的分辨率档位；更高分辨率通常耗时更长。')}>!</span>
                  </div>
                  <div className="img-rp-quality-segmented rh-video-resolution-seg">
                    {generalModel && generalCapability?.defaultResolution === undefined && (
                      <AnimatedButton
                        type="button"
                        className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${displayedResolution === undefined ? 'active' : ''}`}
                        onClick={() => onChangeSeedanceResolution?.(undefined)}
                      >
                        {t('模型默认')}
                      </AnimatedButton>
                    )}
                    {seedanceResolutions.map((opt) => (
                      <AnimatedButton
                        key={opt.value}
                        type="button"
                        className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${displayedResolution === opt.value ? 'active' : ''}`}
                        onClick={() => onChangeSeedanceResolution?.(opt.value)}
                      >
                        {opt.label}
                      </AnimatedButton>
                    ))}
                  </div>
                </div>}

                {showRatioControl && (
                  <div className="img-rp-quality-area mb-2">
                    <div className="img-rp-section-label">
                      {t('宽高比')}
                      <span className="rh-tip" data-tooltip={t('决定输出视频的画面形状：16:9 横屏、9:16 竖屏，自适应 = 由模型智能决定。')}>!</span>
                    </div>
                    <div className="img-rp-quality-segmented rh-video-resolution-seg">
                      {generalModel && generalCapability?.defaultRatio === undefined && (
                        <AnimatedButton
                          type="button"
                          className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${displayedRatio === undefined ? 'active' : ''}`}
                          onClick={() => onChangeSeedanceRatio?.(undefined)}
                        >
                          {t('模型默认')}
                        </AnimatedButton>
                      )}
                      {seedanceRatios.map((opt) => (
                        <AnimatedButton
                          key={opt.value}
                          type="button"
                          className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${displayedRatio === opt.value ? 'active' : ''}`}
                          onClick={() => onChangeSeedanceRatio?.(opt.value)}
                        >
                          {opt.value === 'adaptive' ? t('自适应') : opt.label}
                        </AnimatedButton>
                      ))}
                    </div>
                  </div>
                )}

                {showFrameRateControl && (
                  <div className="img-rp-quality-area mb-2">
                    <div className="img-rp-section-label">
                      {t('帧率')}
                      <span className="rh-tip" data-tooltip={t('仅展示该模型配置中声明支持的帧率；帧率越高运动越顺滑，但生成成本通常也更高。')}>!</span>
                    </div>
                    <div className="img-rp-quality-segmented rh-video-resolution-seg">
                      {generalCapability?.defaultFrameRate === undefined && (
                        <AnimatedButton
                          type="button"
                          className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${displayedFrameRate === undefined ? 'active' : ''}`}
                          onClick={() => onChangeFps?.(undefined)}
                        >
                          {t('模型默认')}
                        </AnimatedButton>
                      )}
                      {configuredFrameRates?.map((value) => (
                        <AnimatedButton
                          key={value}
                          type="button"
                          className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${displayedFrameRate === value ? 'active' : ''}`}
                          onClick={() => onChangeFps?.(value)}
                        >
                          {t('{count}帧', { count: value })}
                        </AnimatedButton>
                      ))}
                    </div>
                  </div>
                )}

                {/* Seedance 时长 */}
                {apimartCapability?.durationMode === 'automatic' && (
                  <div className="text-xs text-canvas-text-secondary">{t('时长由模型自动决定，可在提示词中描述节奏。')}</div>
                )}
                {(showDurationControl || (showGenerateAudio && supportsAudio)) && (
                <div className="rh-v5-meta-panel">
                  {showDurationControl && <div className="rh-vram-adv-row">
                    <div className="rh-vram-adv-label">
                      <span>{t('生成时长（秒）')}</span>
                      <span className="rh-tip" data-tooltip={durationTooltip}>!</span>
                    </div>
                    {((generalModel && generalCapability?.defaultDuration === undefined
                      && generalCapability?.automaticDurationValue === undefined) || automaticDurationValue !== undefined
                      || (!automaticDurationOnly && allowedDurations)) && (
                    <div className="ui-segmented ui-segmented--brand" role="group" aria-label={t('生成时长（秒）')}>
                      {generalModel && generalCapability?.defaultDuration === undefined
                        && generalCapability?.automaticDurationValue === undefined && (
                      <button
                        type="button"
                        aria-pressed={displayedDuration === undefined}
                        onClick={() => onChangeSeedanceDuration?.(undefined)}
                        className={`ui-segmented__item${displayedDuration === undefined ? ' is-active' : ''}`}
                      >
                        {t('模型默认')}
                      </button>
                    )}
                    {automaticDurationValue !== undefined && (
                      <button
                        type="button"
                        aria-pressed={displayedDuration === automaticDurationValue}
                        onClick={() => onChangeSeedanceDuration?.(automaticDurationValue)}
                        className={`ui-segmented__item${displayedDuration === automaticDurationValue ? ' is-active' : ''}`}
                      >
                        {t('自动')}
                      </button>
                    )}
                    {!automaticDurationOnly && allowedDurations?.map((value) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={displayedDuration === value}
                            onClick={() => onChangeSeedanceDuration?.(value)}
                            className={`ui-segmented__item${displayedDuration === value ? ' is-active' : ''}`}
                          >
                            {value}s
                          </button>
                        ))}
                    </div>
                    )}
                    {generalModel && displayedDuration === undefined && (
                      <div className="mb-2 text-[10px] text-canvas-text-muted">
                        {t('当前未指定时长；选择或输入数值后才会显式提交。')}
                      </div>
                    )}
                    {!automaticDurationOnly && !allowedDurations && (useUnboundedDurationInput ? (
                      <input
                        type="number"
                        className="h-8 w-full rounded-md border border-canvas-border bg-canvas-card px-2 text-[11px] text-canvas-text outline-none focus:border-blue-400/60"
                        aria-label={t('生成时长（秒）')}
                        min={generalCapability?.minDuration}
                        max={generalCapability?.maxDuration}
                        step={1}
                        value={displayedDuration ?? ''}
                        placeholder={t('模型默认')}
                        onChange={(event) => onChangeSeedanceDuration?.(
                          event.target.value ? Number(event.target.value) : undefined,
                        )}
                        onBlur={onContinuousEditEnd}
                      />
                    ) : (
                    <div className="rh-duration-slider">
                      <div className="rh-duration-track">
                         <div
                           className="rh-duration-fill"
                           style={{ width: displayedDuration === undefined
                             ? '0%'
                             : `${((durationControlValue - minDuration) / Math.max(1, maxDuration - minDuration)) * 100}%` }}
                         />
                        <input
                          type="range"
                          className="rh-duration-input"
                          min={minDuration}
                          max={maxDuration}
                          step={1}
                          value={durationControlValue}
                          onChange={(e) => onChangeSeedanceDuration?.(Number(e.target.value))}
                          onBlur={onContinuousEditEnd}
                        />
                      </div>
                      <div className="rh-duration-labels">
                        {durationTicks.map((v) => (
                          <span key={v} className={`rh-duration-tick ${displayedDuration !== undefined && displayedDuration >= v ? 'active' : ''}`} onClick={() => onChangeSeedanceDuration?.(v)}>
                            {durationLabelValues.has(v) ? `${v}s` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                    ))}
                  </div>}


                  {/* 原生模型保留开关；通用模型使用三态，区分接口默认 / 显式有声 / 显式无声。 */}
                  {showGenerateAudio && supportsAudio && (
                  <div className="rh-vram-adv-row">
                    <div className="rh-vram-adv-label" style={{ justifyContent: 'space-between', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{t('生成有声视频')}</span>
                        <span className="rh-tip" data-tooltip={generalModel
                          ? t('模型默认表示不发送音频开关；也可以显式要求生成音频或不生成音频。')
                          : t('开启后由当前原生视频模型同时生成音频。')}>!</span>
                      </div>
                      {generalModel ? (
                        <Select fixedMenu disabled={disabled}
                          className="min-w-0" size="sm"
                          aria-label={t('视频音频策略')}
                          value={generateAudio === undefined ? 'default' : generateAudio ? 'on' : 'off'}
                          onChange={(selectedOptionValue) => onChangeGenerateAudio?.(
                            selectedOptionValue === 'default' ? undefined : selectedOptionValue === 'on',
                          )}
                        >
                          <option value="default">{t('模型默认')}</option>
                          <option value="on">{t('生成音频')}</option>
                          <option value="off">{t('不生成音频')}</option>
                        </Select>
                      ) : (
                        <label className="rh-toggle-switch">
                          <input
                            type="checkbox"
                            checked={displayedGenerateAudio}
                            onChange={(e) => onChangeGenerateAudio?.(e.target.checked)}
                          />
                          <span className="rh-toggle-track">
                            <span className="rh-toggle-knob" />
                          </span>
                        </label>
                      )}
                    </div>
                  </div>
                  )}
                </div>
                )}
              </>
            ) : (
              <>
                {showGenericRatio && (
                  <div className="img-rp-quality-area mb-2">
                    <div className="img-rp-section-label">
                      {t('画面比例')}
                      <span className="rh-tip" data-tooltip={t('决定输出视频的画面形状：16:9 横屏、9:16 竖屏。分辨率为长边，短边按比例换算后注入工作流的 width/height。')}>!</span>
                    </div>
                    <div className="img-rp-quality-segmented rh-video-resolution-seg">
                      {genericRatios.map((opt) => (
                        <AnimatedButton
                          key={opt.value}
                          type="button"
                          className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${genericRatio === opt.value ? 'active' : ''}`}
                          onClick={() => onChangeSeedanceRatio?.(opt.value)}
                        >
                          {opt.label}
                        </AnimatedButton>
                      ))}
                    </div>
                  </div>
                )}

                {/* ComfyUI / RunningHub 分辨率 */}
                <div className="img-rp-quality-area mb-2" data-ui-schema-field="rhVideoResolution" data-ui-schema-type="segmented" data-ui-schema-value-type="number" data-ui-schema-default="832">
                  <div className="img-rp-section-label">
                    {t('分辨率（长边）')}
                    <span className="rh-tip" data-tooltip={t('画面长边像素，短边由上方比例换算。分辨率越高细节越清晰、边缘更稳定，显存占用与生成耗时也明显增加。最后一格可以填预设以外的值，例如 384。')}>!</span>
                  </div>
                  <div className="img-rp-quality-segmented rh-video-resolution-seg rh-res-seg-with-custom">
                    {COMBO_RESOLUTIONS.map((res) => (
                      <AnimatedButton
                        key={res}
                        type="button"
                        className={`img-rp-quality-item rh-v5-res-btn ui-schema-option ${legacyVideoResolution === res ? 'active' : ''}`}
                        data-value={res}
                        data-ui-schema-value={res}
                        onClick={() => onChangeResolution?.(res)}
                      >
                        {res}
                      </AnimatedButton>
                    ))}
                    <input
                      type="number"
                      className="rh-res-custom-input"
                      aria-label={t('自定义长边像素')}
                      placeholder={t('自定义')}
                      min={MIN_CUSTOM_RESOLUTION}
                      max={MAX_CUSTOM_RESOLUTION}
                      step={8}
                      // 选中预设时留空只显示占位符，填了值才算自定义
                      value={COMBO_RESOLUTIONS.includes(legacyVideoResolution) ? '' : legacyVideoResolution}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value) && value > 0) onChangeResolution?.(value);
                      }}
                      onBlur={(event) => {
                        const value = Number(event.target.value);
                        if (event.target.value.trim() && Number.isFinite(value)) {
                          onChangeResolution?.(Math.min(
                            MAX_CUSTOM_RESOLUTION,
                            Math.max(MIN_CUSTOM_RESOLUTION, value),
                          ));
                        }
                        onContinuousEditEnd?.();
                      }}
                    />
                  </div>
                </div>

                {/* 帧率 & 时长 */}
                <div className="rh-v5-meta-panel">
                  <div className="rh-vram-adv-row">
                    <div className="rh-vram-adv-label">
                      <span>{t('帧率')}</span>
                      <span className="rh-tip" data-tooltip={t('帧率越高运动更顺滑、动作更连贯。但生成更慢、成本更高。常用 24 帧。')}>!</span>
                    </div>
                    <div className="img-rp-quality-segmented rh-adv-seg rh-v5-fps-seg">
                      {COMBO_FPS_OPTIONS.map((opt) => (
                        <AnimatedButton
                          key={opt.value}
                          type="button"
                          className={`img-rp-quality-item rh-v5-fps-btn ui-schema-option ${legacyVideoFps === opt.value ? 'active' : ''}`}
                          data-value={opt.value}
                          data-ui-schema-value={opt.value}
                          onClick={() => {
                            // 旧节点只有帧数时，先固定反算出的秒数，避免切换 FPS 改变用户看到的时长。
                            if (!Number.isFinite(seedanceDuration)) {
                              onChangeSeedanceDuration?.(durationControlValue);
                            }
                            onChangeFps?.(opt.value);
                          }}
                        >
                          {t('{count}帧', { count: opt.value })}
                        </AnimatedButton>
                      ))}
                    </div>
                  </div>

                  <div className="rh-vram-adv-row" data-ui-schema-field="videoDuration" data-ui-schema-type="slider">
                    <div className="rh-vram-adv-label">
                      <span>{t('生成时长（秒）')}</span>
                      <span className="rh-tip" data-tooltip={t('整数秒，范围 {min}-{max}。提交时会根据帧率自动换算为模型需要的总帧数。', { min: minDuration, max: maxDuration })}>!</span>
                    </div>
                    <div className="rh-duration-slider">
                      <div className="rh-duration-track">
                        <div
                          className="rh-duration-fill"
                          style={{ width: `${((durationControlValue - minDuration) / Math.max(1, maxDuration - minDuration)) * 100}%` }}
                        />
                        <input
                          type="range"
                          className="rh-duration-input"
                          min={minDuration}
                          max={maxDuration}
                          step={1}
                          value={durationControlValue}
                          onChange={(e) => onChangeSeedanceDuration?.(Number(e.target.value))}
                          onBlur={onContinuousEditEnd}
                        />
                      </div>
                      <div className="rh-duration-labels">
                        {durationTicks.map((value) => (
                          <span
                            key={value}
                            className={`rh-duration-tick ${durationControlValue >= value ? 'active' : ''}`}
                            onClick={() => onChangeSeedanceDuration?.(value)}
                          >
                            {durationLabelValues.has(value) ? `${value}s` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
            <ComfyH3MemorySelector nodeId={nodeId} disabled={disabled} />
            {extraParameters}
            </fieldset>
          </div>
        )}
      </div>
    </div>
  </>);
}
