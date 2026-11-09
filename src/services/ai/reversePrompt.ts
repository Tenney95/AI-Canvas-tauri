/**
 * ai/reversePrompt — 反推提示词：把已有图片/视频喂给文本模型，倒推出能复现它的生成提示词。
 * 视频没有通用的多模态入口，改喂按时间顺序抽的关键帧。
 * 反推与落节点分开：弹窗里先出结果，用户确认后才写进画布。
 */
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import { generateId, useAppStore } from '../../store/useAppStore';
import { derivedNodePlacement } from '../../store/store.utils';
import { textNodeHeight } from '../../utils/num';
import { resolveEffectiveModel } from '../../components/nodes/shared/toolbar/presetAction';
import {
  getConfiguredModelGroups,
  hasVisionInputCapability,
} from '../../components/nodes/shared/defaultModels';
import { generateText } from './generateText';

export type ReversePromptKind = 'image' | 'video';

const SHARED_RULES = [
  '只写画面里真实可见的内容，不要臆测背景故事，不要评价好坏。',
  '直接输出提示词正文，一整段，不要标题、不要分点、不要任何前后缀说明。',
];

const INSTRUCTIONS: Record<ReversePromptKind, string> = {
  image: [
    '你是 AI 绘画提示词专家。仔细观察这张图，反推出一段能重新生成它的提示词。',
    '需要覆盖：主体与外观、姿态与构图、镜头与视角、光线与氛围、色彩与材质、画风与媒介（写实摄影／2D 插画／3D 渲染／像素等）。',
    ...SHARED_RULES,
  ].join('\n'),
  video: [
    '你是 AI 视频提示词专家。下面几张图是同一段视频按时间顺序抽的关键帧（首帧、中间帧、尾帧）。反推出一段能重新生成这段视频的提示词。',
    '先写画面：主体与外观、场景、光线、色彩、画风；再写运动：主体动作如何变化、镜头如何运动（推拉摇移／跟随／固定）、节奏快慢。',
    '运动只写帧与帧之间能看出来的变化，不要编造没有依据的情节。',
    ...SHARED_RULES,
  ].join('\n'),
};

export const REVERSE_PROMPT_SOURCE_LABELS: Record<ReversePromptKind, string> = {
  image: '图片',
  video: '视频',
};

/**
 * 反推要读图，文本节点选的模型未必能读。
 * 顺序：节点偏好模型（能读图就直接用）→ 已配置的内置模型 → 通用模型 → 退回偏好模型。
 */
export function resolveVisionTextModel(): { model: string; provider: string } | null {
  const config = useAppStore.getState().config;
  const configured = getConfiguredModelGroups(config, 'ai-text').flatMap((group) => group.models);
  const preferred = resolveEffectiveModel('ai-text');
  const preferredOption = configured.find((model) => model.value === preferred?.model);
  const preferredGeneral = preferred?.provider === 'general'
    ? config.generalModels?.find((model) => `general/${model.id}` === preferred.model) : undefined;
  if (preferred && hasVisionInputCapability(preferredGeneral ?? {
    modelId: preferred.model, inputModalities: preferredOption?.inputModalities,
  })) return preferred;

  const builtin = configured.find((model) => hasVisionInputCapability({ modelId: model.value, inputModalities: model.inputModalities }));
  if (builtin) return { model: builtin.value, provider: builtin.provider };

  const general = (config?.generalModels || []).find((model) => (
    model.category === 'text' && hasVisionInputCapability(model)
  ));
  if (general) return { model: `general/${general.id}`, provider: 'general' };

  return preferred;
}

/** 接口把图片部分整个拒了，多半是模型不认多模态输入 */
export function isImageInputRejected(message: string): boolean {
  return /image_url|unknown variant|multimodal|vision|image input/i.test(message);
}

export interface ReversePromptOptions {
  kind: ReversePromptKind;
  imageUrls: string[];
  model: string;
  provider: string;
  /** 用户在弹窗里补充的额外要求 */
  extraPrompt?: string;
  signal?: AbortSignal;
  outputFormat?: 'text' | 'prompt-tags';
}

/** 跑一次反推，只返回文本；出错抛给调用方在弹窗里显示 */
export async function reversePrompt(options: ReversePromptOptions): Promise<string> {
  if (options.imageUrls.length === 0) {
    throw new Error(`没有可反推的${REVERSE_PROMPT_SOURCE_LABELS[options.kind]}`);
  }
  const extra = options.extraPrompt?.trim();
  const instruction = options.outputFormat === 'prompt-tags'
    ? [
      '你是图片提示词专家。观察图片，生成可用于复现画面的中文提示词，并提取用于资产分类的中文标签。',
      '提示词覆盖主体、外观、姿态、构图、场景、视角、光线、色彩、材质和画风，不超过 30000 字符。',
      SHARED_RULES[0],
      '只输出 JSON 对象：{"prompt":"提示词正文","tags":["标签"]}，不要 Markdown 或说明。',
      'tags 为 5–10 个简短标签，最多 16 个，每个不超过 40 字符，涵盖主体、风格和场景，不加 #。',
    ].join('\n')
    : INSTRUCTIONS[options.kind];
  const prompt = extra
    ? `${instruction}\n【额外要求】${extra}`
    : instruction;

  try {
    const result = await generateText({
      prompt,
      model: options.model,
      provider: options.provider,
      imageUrls: options.imageUrls,
      signal: options.signal,
    });
    return result.trim();
  } catch (error) {
    options.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : '提示词反推失败';
    throw new Error(
      isImageInputRejected(message)
        ? `模型 ${options.model} 不接受图片输入，请换一个能读图的文本模型（如 GPT-4o / Claude / Gemini / Qwen-VL）。原始报错：${message}`
        : message,
      { cause: error },
    );
  }
}

/** 资产预览只取得草稿数据，不写入画布、标签或图片记录。 */
export async function reversePromptAndTags(options: Omit<ReversePromptOptions, 'kind' | 'outputFormat'>): Promise<{ prompt: string; tags: string[] }> {
  const text = await reversePrompt({ ...options, kind: 'image', outputFormat: 'prompt-tags' });
  options.signal?.throwIfAborted();
  let result: unknown;
  try { result = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
  catch { throw new Error('模型未返回有效的提示词与标签，请重新反推或更换模型'); }
  if (!result || typeof result !== 'object' || !('prompt' in result) || !('tags' in result)
    || typeof result.prompt !== 'string' || !result.prompt.trim() || result.prompt.length > 30_000
    || !Array.isArray(result.tags) || result.tags.length > 16
    || result.tags.some((tag: unknown) => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) {
    throw new Error('模型返回的提示词或标签格式不符合要求，请重试');
  }
  return { prompt: result.prompt.trim(), tags: [...new Set((result.tags as string[]).map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean))] };
}

/** 把反推结果挂成源节点右侧的文本节点，返回新节点 id */
export function addReversePromptTextNode(
  sourceNodeId: string,
  kind: ReversePromptKind,
  text: string,
): string | null {
  const store = useAppStore.getState();
  const sourceNode = store.nodes.find((node) => node.id === sourceNodeId) as Node<BaseNodeData> | undefined;
  if (!sourceNode) {
    store.showToast('源节点已不存在', 'error');
    return null;
  }

  const estimatedLines = text.split(/\r?\n/).reduce(
    (count, line) => count + Math.max(1, Math.ceil(line.length / 36)),
    0,
  );
  const sourceLabel = sourceNode.data.label?.trim()
    || sourceNode.data.fileName?.trim()
    || REVERSE_PROMPT_SOURCE_LABELS[kind];
  const newNodeId = `node-${generateId()}`;
  const promptNode: Node<BaseNodeData> = {
    id: newNodeId,
    type: 'ai-text',
    ...derivedNodePlacement(sourceNode),
    data: {
      label: `${sourceLabel} 反推提示词`,
      type: 'ai-text',
      role: 'source',
      output: text,
      status: 'success',
      nodeWidth: 280,
      nodeHeight: textNodeHeight(estimatedLines),
    },
  };
  const edge: Edge = {
    id: generateId(),
    source: sourceNodeId,
    target: newNodeId,
    sourceHandle: 'right',
    targetHandle: 'left',
  };

  store.addNodeWithEdge(promptNode, edge);
  store.showToast('已添加为文本节点');
  return newNodeId;
}
