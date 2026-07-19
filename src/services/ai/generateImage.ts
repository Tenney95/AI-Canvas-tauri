/**
 * ai/generateImage — 图片生成入口
 *
 * 按 provider 分流到对应 adapter：
 *   dreamina   → dreaminaService（CLI 本地化图片，不走图床上传）
 *   apimart    → apimartGen（异步任务轮询）
 *   general    → providers/standardImage（通用模型，OpenAI 兼容）
 *   volcengine → providers/volcengineImage（Seedream 专属请求格式）
 *   runninghub → providers/runninghubImage（标准模型异步任务协议）
 *   localllm   → 已废弃，引导迁移到通用模型
 *   其他       → providers/standardImage（标准 OpenAI 兼容）
 *
 * 公共前置处理（prompt 解析、图床上传、空值校验）统一在此完成。
 */
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_BASE_URLS, RUNNINGHUB_MODEL_BASE_URL } from '../../constants/api';
import { mapImageDimensions } from '../aiDimensions';
import { generateDreaminaImage } from '../dreaminaService';
import { executeComfyUIGenerate } from '../comfyWorkflowService';
import type { AIImageGenParams, BatchImageResult, ImageGenerationResult } from '../../types/aiTypes';
import { MAX_IMAGE_BATCH_COUNT } from '../../types/aiTypes';
import { extractModelName, resolveGeneralModel } from './helpers';
import { resolvePromptWithImageRefs } from './promptResolver';
import { resolveImageUrlArray } from './imageUtils';
import { generateApimartImagesBatch } from './apimartGen';
import { generateImageStandardBatch } from './providers/standardImage';
import { generateVolcengineImagesBatch } from './providers/volcengineImage';
import { generateRunningHubImagesBatch } from './providers/runninghubImage';
import { runConfiguredModelProtocol } from './modelProtocolRuntime';

export async function generateImage(
  params: AIImageGenParams,
): Promise<ImageGenerationResult> {
  const batch = await generateImagesBatch(params, 1);
  const result = batch.results[0];
  if (!result) throw new Error('图片生成返回结果为空');
  return result;
}

function singleResult(result: ImageGenerationResult): BatchImageResult {
  return { requestedCount: 1, results: [result], failedCount: 0 };
}

export async function generateImagesBatch(
  params: AIImageGenParams,
  count: number,
): Promise<BatchImageResult> {
  const requestedCount = Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(count)));
  const { prompt: rawPrompt, model, provider, imageSize = '2K', aspectRatio = '1:1' } = params;

  // 解析 @{nodeId:label} 引用：图片 URL 提取到 image_urls，文本内联替换到 prompt
  const { prompt, imageUrls } = await resolvePromptWithImageRefs(rawPrompt);

  // 合并调用方传入的 image_urls 与从 prompt 中解析出的 imageUrls
  let allImageUrls = [...(params.image_urls || []), ...imageUrls];

  // Dreamina：CLI 端本地化图片，不走图床上传
  if (provider === 'dreamina') {
    if (!prompt.trim()) throw new Error('提示词不能为空');
    if (requestedCount > 1) throw new Error('即梦暂不支持批量生成，请将数量设为 1');
    return singleResult(await generateDreaminaImage({ prompt, model, imageSize, aspectRatio, imageUrls: allImageUrls, nodeId: params.nodeId }));
  }

  // 将本地图片 URL 上传到远端图床，转为公网 URL（apimart 走 apimart 图床，其他走 uguu.se）
  allImageUrls = await resolveImageUrlArray(allImageUrls, provider);

  // ComfyUI 工作流执行路径
  if (params.workflowId) {
    if (requestedCount > 1) throw new Error('工作流暂不支持批量生成，请将数量设为 1');
    return singleResult(await executeComfyUIGenerate({ ...params, prompt }));
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
      return generateApimartImagesBatch(
        apiKey, baseUrl, modelName, prompt, imageSize, aspectRatio,
        dimensions, allImageUrls, requestedCount, params.nodeId,
      );
    }

    case 'general': {
      const gm = resolveGeneralModel(model);
      if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
      if (!gm.openaiUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
      const dimensions = mapImageDimensions(imageSize, aspectRatio);
      if (gm.executionProfile) {
        const urls = await runConfiguredModelProtocol({
          model: gm,
          category: 'image',
          nodeId: params.nodeId,
          variables: {
            model: gm.modelId,
            prompt,
            imageSize,
            aspectRatio,
            size: `${dimensions.width}x${dimensions.height}`,
            width: dimensions.width,
            height: dimensions.height,
            n: requestedCount,
            batchCount: requestedCount,
            imageUrls: allImageUrls,
          },
        });
        const results = urls.slice(0, requestedCount).map((url) => ({ url, ...dimensions }));
        if (results.length === 0) throw new Error('图片生成返回结果为空');
        return {
          requestedCount,
          results,
          failedCount: Math.max(0, requestedCount - results.length),
        };
      }
      return generateImageStandardBatch({
        apiKey: gm.apiKey || '',
        baseUrl: gm.openaiUrl,
        modelName: gm.modelId,
        prompt,
        dimensions,
        imageUrls: allImageUrls,
      }, requestedCount);
    }

    case 'volcengine': {
      const pc = config.providers.volcengine;
      const apiKey = pc?.apiKey || '';
      if (!apiKey) throw new Error('未配置 火山方舟 的 API Key\n请在「设置 → API Key」中配置');
      const baseUrl = (pc?.baseUrl || DEFAULT_BASE_URLS.volcengine || '').replace(/\/+$/, '');
      if (!baseUrl) throw new Error('未配置 火山方舟 的服务地址\n请在「设置 → API Key」中添加');
      return generateVolcengineImagesBatch({
        apiKey,
        baseUrl,
        model,
        provider,
        prompt,
        imageSize,
        aspectRatio,
        imageUrls: allImageUrls,
      }, requestedCount);
    }

    case 'runninghub': {
      const pc = config.providers['runninghub-model'];
      const apiKey = pc?.apiKey || '';
      if (!apiKey) {
        throw new Error('未配置 RunningHub 模型 API Key\n请在「设置 → API Key」中配置企业级-共享密钥');
      }
      const baseUrl = (pc?.baseUrl || RUNNINGHUB_MODEL_BASE_URL).replace(/\/+$/, '');
      if (!baseUrl) throw new Error('未配置 RunningHub 模型 API 服务地址');
      const dimensions = mapImageDimensions(imageSize, aspectRatio);
      return generateRunningHubImagesBatch({
        apiKey,
        baseUrl,
        model,
        prompt,
        imageSize,
        aspectRatio,
        dimensions,
        imageUrls: allImageUrls,
        nodeId: params.nodeId,
      }, requestedCount);
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
      return generateImageStandardBatch({
        apiKey,
        baseUrl,
        modelName,
        prompt,
        dimensions,
        imageUrls: allImageUrls,
      }, requestedCount);
    }
  }
}
