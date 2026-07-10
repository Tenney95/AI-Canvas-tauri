/**
 * ai/generateImage — 图片生成入口
 *
 * 按 provider 分流到对应 adapter：
 *   dreamina   → dreaminaService（CLI 本地化图片，不走图床上传）
 *   apimart    → apimartGen（异步任务轮询）
 *   general    → providers/standardImage（通用模型，OpenAI 兼容）
 *   volcengine → providers/volcengineImage（Seedream 专属请求格式）
 *   localllm   → 已废弃，引导迁移到通用模型
 *   其他       → providers/standardImage（标准 OpenAI 兼容）
 *
 * 公共前置处理（prompt 解析、图床上传、空值校验）统一在此完成。
 */
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import { mapImageDimensions } from '../aiDimensions';
import { generateDreaminaImage } from '../dreaminaService';
import { executeComfyUIGenerate } from '../comfyWorkflowService';
import type { AIImageGenParams } from '../../types/aiTypes';
import { extractModelName, resolveGeneralModel } from './helpers';
import { resolvePromptWithImageRefs } from './promptResolver';
import { resolveImageUrlArray } from './imageUtils';
import { generateApimartImage } from './apimartGen';
import { generateImageStandard } from './providers/standardImage';
import { generateVolcengineImage } from './providers/volcengineImage';

export async function generateImage(
  params: AIImageGenParams,
): Promise<{ url: string; width: number; height: number }> {
  const { prompt: rawPrompt, model, provider, imageSize = '2K', aspectRatio = '1:1' } = params;

  // 解析 @{nodeId:label} 引用：图片 URL 提取到 image_urls，文本内联替换到 prompt
  const { prompt, imageUrls } = await resolvePromptWithImageRefs(rawPrompt);

  // 合并调用方传入的 image_urls 与从 prompt 中解析出的 imageUrls
  let allImageUrls = [...(params.image_urls || []), ...imageUrls];

  // Dreamina：CLI 端本地化图片，不走图床上传
  if (provider === 'dreamina') {
    if (!prompt.trim()) throw new Error('提示词不能为空');
    return generateDreaminaImage({ prompt, model, imageSize, aspectRatio, imageUrls: allImageUrls, nodeId: params.nodeId });
  }

  // 将本地图片 URL 上传到远端图床，转为公网 URL
  allImageUrls = await resolveImageUrlArray(allImageUrls);

  // ComfyUI 工作流执行路径
  if (params.workflowId) {
    return executeComfyUIGenerate({ ...params, prompt });
  }

  if (!prompt.trim()) throw new Error('提示词不能为空');

  const config = useAppStore.getState().config;

  // ── 按 provider 分流 ──
  switch (provider) {
    case 'apimart': {
      const pc = config.providers.apimart;
      const apiKey = pc?.apiKey || '';
      if (!apiKey) throw new Error('未配置 apimart 的 API Key\n请在「设置 → API Key」中配置');
      const baseUrl = (pc?.baseUrl || DEFAULT_BASE_URLS.apimart || '').replace(/\/+$/, '');
      if (!baseUrl) throw new Error('未配置 apimart 的服务地址\n请在「设置 → API Key」中添加');
      const modelName = extractModelName(model, provider);
      const dimensions = mapImageDimensions(imageSize, aspectRatio);
      return generateApimartImage(apiKey, baseUrl, modelName, prompt, imageSize, aspectRatio, dimensions, allImageUrls, params.nodeId);
    }

    case 'general': {
      const gm = resolveGeneralModel(model);
      if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
      if (!gm.openaiUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
      const dimensions = mapImageDimensions(imageSize, aspectRatio);
      return generateImageStandard({
        apiKey: gm.apiKey || '',
        baseUrl: gm.openaiUrl,
        modelName: gm.modelId,
        prompt,
        dimensions,
        imageUrls: allImageUrls,
      });
    }

    case 'volcengine': {
      const pc = config.providers.volcengine;
      const apiKey = pc?.apiKey || '';
      if (!apiKey) throw new Error('未配置 火山方舟 的 API Key\n请在「设置 → API Key」中配置');
      const baseUrl = (pc?.baseUrl || DEFAULT_BASE_URLS.volcengine || '').replace(/\/+$/, '');
      if (!baseUrl) throw new Error('未配置 火山方舟 的服务地址\n请在「设置 → API Key」中添加');
      return generateVolcengineImage({
        apiKey,
        baseUrl,
        model,
        provider,
        prompt,
        imageSize,
        aspectRatio,
        imageUrls: allImageUrls,
      });
    }

    case 'localllm':
      // 已合并到通用模型，保留兼容旧数据
      throw new Error('本地大模型已迁移到「通用模型」，请重新选择模型\n请在「设置 → API Key」中添加通用模型');

    default: {
      // 标准 OpenAI 兼容 provider（ppio / siliconflow / openai 等）
      const pc = config.providers[provider];
      const apiKey = pc?.apiKey || '';
      if (!apiKey) throw new Error(`未配置 ${provider} 的 API Key\n请在「设置 → API Key」中配置`);
      const baseUrl = (pc?.baseUrl || DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, '');
      if (!baseUrl) throw new Error(`未配置 ${provider} 的服务地址\n请在「设置 → API Key」中添加`);
      const modelName = extractModelName(model, provider);
      const dimensions = mapImageDimensions(imageSize, aspectRatio);
      return generateImageStandard({
        apiKey,
        baseUrl,
        modelName,
        prompt,
        dimensions,
        imageUrls: allImageUrls,
      });
    }
  }
}
