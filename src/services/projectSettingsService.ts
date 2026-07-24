/**
 * projectSettingsService — 项目创作基线的纯解析规则。
 * 不读取 Store，便于节点创建、生成执行和设置 UI 复用同一优先级。
 */
import type {
  BaseNodeData,
  CustomStyle,
  NodeType,
  ProjectModelKind,
  ProjectSettings,
} from '../types';

export interface ProjectStyleOption {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export const PROJECT_STYLE_OPTIONS: ProjectStyleOption[] = [
  { id: 'realistic', name: '写实摄影', description: '真实质感，光影自然', prompt: '写实摄影风格，真实材质，自然光影，细节清晰' },
  { id: 'anime', name: '动漫风格', description: '日系二次元绘画', prompt: '日系动漫风格，干净线稿，统一角色设计，细腻上色' },
  { id: 'watercolor', name: '水彩画', description: '柔和通透的晕染', prompt: '水彩画风格，柔和通透的晕染，自然纸张纹理' },
  { id: 'oil-painting', name: '油画', description: '厚重肌理与笔触', prompt: '油画风格，厚重颜料肌理，清晰笔触，层次丰富' },
  { id: 'sketch', name: '素描', description: '黑白线条速写', prompt: '素描风格，黑白线条，细腻排线，结构准确' },
  { id: 'cyberpunk', name: '赛博朋克', description: '霓虹都市科技感', prompt: '赛博朋克风格，霓虹光影，未来都市，高对比氛围' },
  { id: 'ink-wash', name: '水墨画', description: '水墨留白与写意笔触', prompt: '中国水墨画风格，墨色层次，留白构图，写意笔触' },
  { id: 'pixel-art', name: '像素艺术', description: '统一色板与像素质感', prompt: '像素艺术风格，清晰像素边缘，统一色板，复古游戏质感' },
  { id: '3d-render', name: '3D 渲染', description: '立体材质与精细灯光', prompt: '高品质 3D 渲染风格，立体材质，精细灯光，空间层次清晰' },
  { id: 'flat-illustration', name: '扁平插画', description: '简洁干净的矢量风', prompt: '扁平插画风格，简洁几何造型，统一配色，干净轮廓' },
  { id: 'cinematic', name: '电影质感', description: '电影级调色与光影', prompt: '电影级画面风格，叙事构图，电影调色，富有层次的光影' },
  { id: 'vintage', name: '复古胶片', description: '胶片颗粒与怀旧影调', prompt: '复古胶片风格，自然颗粒，柔和色偏，怀旧影调' },
];

export const PROJECT_IMAGE_ASPECT_RATIOS = [
  '自适应', '1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5',
  '21:9', '1:4', '4:1', '1:6', '6:1', '1:8', '8:1',
] as const;
export const PROJECT_IMAGE_SIZES = ['720p', '1K', '2K', '4K'] as const;
export const PROJECT_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const;

const NODE_MODEL_KIND: Partial<Record<NodeType, ProjectModelKind>> = {
  'ai-text': 'text',
  'ai-image': 'image',
  'ai-animation': 'image',
  'ai-panorama': 'image',
  'ai-video': 'video',
  'ai-audio': 'audio',
};

export function getProjectModelKind(nodeType: string | undefined): ProjectModelKind | null {
  if (!nodeType) return null;
  return NODE_MODEL_KIND[nodeType as NodeType] ?? null;
}

export function parseProjectModelRef(modelRef: string | undefined): {
  model: string;
  provider: string;
} | null {
  if (!modelRef) return null;
  const slashIndex = modelRef.indexOf('/');
  if (slashIndex <= 0) return null;
  return { model: modelRef, provider: modelRef.slice(0, slashIndex) };
}

function clean(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next || undefined;
}

export function normalizeProjectSettings(settings: ProjectSettings): ProjectSettings {
  const styleId = clean(settings.visualStyle?.styleId);
  const rawRef = settings.visualStyle?.styleReference;
  const refUrl = clean(rawRef?.imageUrl);
  const refPath = clean(rawRef?.filePath);
  const styleReference = (refUrl || refPath)
    ? {
        imageUrl: refUrl,
        filePath: refPath,
        fileName: clean(rawRef?.fileName),
        // 有图时默认启用；显式 false 才关闭
        enabled: rawRef?.enabled !== false,
      }
    : undefined;
  const visualStyle = (styleId || styleReference)
    ? {
        ...(styleId
          ? {
              styleId,
              styleName: clean(settings.visualStyle?.styleName),
              prompt: clean(settings.visualStyle?.prompt),
              locked: settings.visualStyle?.locked === true,
            }
          : {
              locked: settings.visualStyle?.locked === true,
            }),
        ...(styleReference ? { styleReference } : {}),
      }
    : undefined;

  const defaultModels = Object.fromEntries(
    Object.entries(settings.defaultModels ?? {})
      .map(([kind, model]) => [kind, clean(model)])
      .filter((entry): entry is [string, string] => !!entry[1]),
  ) as ProjectSettings['defaultModels'];
  const hasTypedPromptSuffixes = settings.promptSuffixes !== undefined;
  const promptSuffixes = Object.fromEntries(
    Object.entries(settings.promptSuffixes ?? {})
      .map(([kind, suffix]) => [kind, clean(suffix)])
      .filter((entry): entry is [string, string] => !!entry[1]),
  ) as ProjectSettings['promptSuffixes'];

  const generation = settings.generation;
  const imageAspectRatio = PROJECT_IMAGE_ASPECT_RATIOS.includes(
    generation?.imageAspectRatio as (typeof PROJECT_IMAGE_ASPECT_RATIOS)[number],
  ) ? generation?.imageAspectRatio : undefined;
  const imageSize = PROJECT_IMAGE_SIZES.includes(
    generation?.imageSize as (typeof PROJECT_IMAGE_SIZES)[number],
  ) ? generation?.imageSize : undefined;
  const videoResolution = PROJECT_VIDEO_RESOLUTIONS.includes(
    generation?.videoResolution as (typeof PROJECT_VIDEO_RESOLUTIONS)[number],
  ) ? generation?.videoResolution : undefined;
  const videoDuration = Number.isInteger(generation?.videoDuration)
    && (generation?.videoDuration ?? 0) >= 2
    && (generation?.videoDuration ?? 0) <= 15
    ? generation?.videoDuration
    : undefined;

  return {
    ...(visualStyle ? { visualStyle } : {}),
    ...(hasTypedPromptSuffixes && promptSuffixes && Object.keys(promptSuffixes).length > 0
      ? { promptSuffixes }
      : {}),
    ...(!hasTypedPromptSuffixes && clean(settings.promptSuffix)
      ? { promptSuffix: clean(settings.promptSuffix) }
      : {}),
    ...(defaultModels && Object.keys(defaultModels).length > 0 ? { defaultModels } : {}),
    ...(imageAspectRatio || imageSize || videoResolution || videoDuration
      ? { generation: { imageAspectRatio, imageSize, videoResolution, videoDuration } }
      : {}),
  };
}

export function resolveStylePrompt(
  styleId: string | undefined,
  customStyles: CustomStyle[] = [],
): string | undefined {
  if (!styleId) return undefined;
  const custom = customStyles.find((style) => style.id === styleId);
  if (custom?.prompt.trim()) return custom.prompt.trim();
  return PROJECT_STYLE_OPTIONS.find((style) => style.id === styleId)?.prompt;
}

export function getImageNodeDimensionsForAspectRatio(
  aspectRatio: string,
): { nodeWidth: number; nodeHeight: number } | null {
  const maxDimension = 280;
  if (aspectRatio === '自适应') {
    return { nodeWidth: maxDimension, nodeHeight: maxDimension };
  }

  const parts = aspectRatio.split(':');
  if (parts.length !== 2) return null;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return width >= height
    ? { nodeWidth: maxDimension, nodeHeight: Math.round(maxDimension * (height / width)) }
    : { nodeWidth: Math.round(maxDimension * (width / height)), nodeHeight: maxDimension };
}

export function applyProjectDefaultsToNodeData(
  data: BaseNodeData,
  settings: ProjectSettings | undefined,
): BaseNodeData {
  if (!settings || data.role === 'source' || data.displayId !== undefined) return data;

  const kind = getProjectModelKind(data.type);
  if (!kind) return data;

  const next: BaseNodeData = { ...data };
  const projectModel = parseProjectModelRef(settings.defaultModels?.[kind]);
  const hasPrompt = !!data.prompt?.trim();
  const hasPromptedModel = !!data.model && hasPrompt;
  if (projectModel && !hasPromptedModel) {
    next.model = projectModel.model;
    next.provider = projectModel.provider;
  }

  const projectStyle = settings.visualStyle;
  if (
    (data.type === 'ai-image' || data.type === 'ai-panorama' || data.type === 'ai-video')
    && projectStyle?.styleId
    && (projectStyle.locked || !data.style)
  ) {
    next.style = projectStyle.styleId;
  }

  if (data.type === 'ai-image') {
    if (settings.generation?.imageAspectRatio && (!hasPrompt || !data.aspectRatio)) {
      next.aspectRatio = settings.generation.imageAspectRatio;
      const dimensions = getImageNodeDimensionsForAspectRatio(next.aspectRatio);
      if (dimensions) Object.assign(next, dimensions);
    }
    if (settings.generation?.imageSize && (!hasPrompt || !data.imageSize)) {
      next.imageSize = settings.generation.imageSize;
    }
  }
  if (data.type === 'ai-video') {
    if (settings.generation?.videoResolution && (!hasPrompt || !data.seedanceResolution)) {
      next.seedanceResolution = settings.generation.videoResolution;
    }
    if (settings.generation?.videoDuration && (!hasPrompt || !data.seedanceDuration)) {
      next.seedanceDuration = settings.generation.videoDuration;
    }
  }

  return next;
}

export function resolveProjectGenerationPrompt({
  prompt,
  data,
  settings,
  customStyles,
}: {
  prompt: string;
  data: BaseNodeData;
  settings?: ProjectSettings;
  customStyles?: CustomStyle[];
}): string {
  const parts = [prompt.trim()];
  const projectStyle = settings?.visualStyle;
  const supportsVisualStyle = data.type === 'ai-image'
    || data.type === 'ai-panorama'
    || data.type === 'ai-video';
  const styleId = supportsVisualStyle
    ? projectStyle?.locked
      ? projectStyle.styleId
      : data.style || projectStyle?.styleId
    : undefined;
  const stylePrompt = styleId
    ? projectStyle?.locked
      ? projectStyle.prompt || resolveStylePrompt(styleId, customStyles)
      : resolveStylePrompt(styleId, customStyles) || projectStyle?.prompt
    : undefined;

  if (stylePrompt?.trim()) parts.push(stylePrompt.trim());
  const promptKind = getProjectModelKind(data.type);
  const promptSuffix = settings?.promptSuffixes !== undefined
    ? promptKind ? settings.promptSuffixes[promptKind] : undefined
    : settings?.promptSuffix;
  if (promptSuffix?.trim()) parts.push(promptSuffix.trim());
  return [...new Set(parts.filter(Boolean))].join('\n\n');
}

/**
 * 读取当前项目启用的风格母图 URL（无则 null）。
 * 仅返回可用于 image 输入的 URL，不负责上传。
 */
export function getEnabledProjectStyleReferenceUrl(
  settings: ProjectSettings | undefined,
): string | null {
  const ref = settings?.visualStyle?.styleReference;
  if (!ref || ref.enabled === false) return null;
  const url = clean(ref.imageUrl);
  return url || null;
}

/** 风格母图注入时的固定说明（只迁风格，不抄母图主体） */
export const PROJECT_STYLE_REFERENCE_HINT = [
  '【项目风格母图】图片1 为当前项目统一风格参考。',
  '请严格遵循其画风、色彩、材质、光影与整体气质；',
  '不要复制母图中的具体人物、场景内容或构图，只迁移视觉风格。',
  '后续图片序号为内容参考（角色/场景等）时，以内容参考为准保持主体一致，风格仍服从母图。',
].join('');
