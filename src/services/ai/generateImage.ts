/**
 * ai/generateImage — 图片生成入口
 *
 * 按 provider 分流到对应 adapter：
 *   dreamina   → dreaminaService（CLI 本地化图片，不走图床上传）
 *   apimart    → Media Provider Registry → APIMart adapter
 *   general    → providers/standardImage（通用模型，OpenAI 兼容）
 *   volcengine → providers/volcengineImage（Seedream 专属请求格式）
 *   runninghub → Media Provider Registry → RunningHub adapter
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
import { isRunningHubWorkflow } from '../workflowExecutionService';
import { executeRunningHubWorkflow } from './providers/runninghubWorkflow';
import { executeWorkflowApiMedia } from '../workflowApi/workflowApiAdapter';
import { parseWorkflowApiFields } from '../workflowApi/workflowApiConfig';
import { collectConnectedReferenceMedia, getMediaReferenceUrls, mergeMediaReferences } from './connectedReferenceMedia';
import type { AIImageGenParams, BatchImageResult, ImageGenerationResult } from '../../types/aiTypes';
import { MAX_IMAGE_BATCH_COUNT } from '../../types/aiTypes';
import { extractModelName, resolveGeneralModel, resolveGeneralModelConnection } from './helpers';
import { collectPromptNodeMediaUrls, resolvePromptWithImageRefs, resolvePromptWithMediaRefs } from './promptResolver';
import { warnIfTooManyReferences } from './connectedReferenceMedia';
import { resolveImageDataUrlArray, resolveImageUrlArray } from './imageUtils';
import { generateImageStandardBatch } from './providers/standardImage';
import { generateVolcengineImagesBatch } from './providers/volcengineImage';
import { runConfiguredModelProtocol } from './modelProtocolRuntime';
import { mediaProviderRegistry } from './mediaProviderRegistry';
import { executeModelProtocol, modelProtocolUsesVariable, resolveModelExecutionProfile } from './modelProtocol';
import { assertConfiguredImageReferences, assertModelCapabilityProtocol, resolveConfiguredImageParameters } from './modelCapabilityValidation';
import { getProviderDefinition } from './providerCatalogService';
import { resolveBuiltInImageRequestContract, validateBuiltInImageResponse } from './imageRequestContracts';
import { buildGoogleImageParts, resolveImageTemplateDimensions } from './imageModelTemplates';

function hasReferenceImageFile(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if ('$file' in value && modelProtocolUsesVariable(JSON.stringify(value.$file) ?? '', 'imageUrls')) {
    return true;
  }
  return Object.values(value).some(hasReferenceImageFile);
}

export async function generateImage(
  params: AIImageGenParams,
  signal?: AbortSignal,
): Promise<ImageGenerationResult> {
  const batch = await generateImagesBatch(params, 1, signal);
  const result = batch.results[0];
  if (!result) throw new Error('图片生成返回结果为空');
  return result;
}

function singleResult(result: ImageGenerationResult): BatchImageResult {
  return { requestedCount: 1, results: [result], failedCount: 0 };
}

function mergeImageUrls(primary: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...primary, ...extra]) {
    const u = (url || '').trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * 参考图前缀说明。
 * styleAsFirst=true 时图片1 为项目风格母图（只迁风格）；其余为内容参考。
 */
function enrichPromptWithReferenceHints(
  prompt: string,
  totalRefCount: number,
  styleAsFirst: boolean,
  aspectRatio: string,
): string {
  if (totalRefCount <= 0) return prompt;
  const lines: string[] = [];
  if (styleAsFirst) {
    lines.push(
      '【项目风格母图】图片1 为当前项目统一风格参考。',
      '请严格遵循其画风、色彩、材质、光影与整体气质；不要复制母图中的具体人物、场景或构图，只迁移视觉风格。',
    );
    if (totalRefCount > 1) {
      lines.push(
        `【内容参考图】图片2…图片${totalRefCount} 为角色/场景等内容参考，请保持主体与设定一致，风格仍服从母图。`,
      );
    }
  } else {
    lines.push(
      `【参考图输入】本次请求附带 ${totalRefCount} 张参考图（按顺序为 图片1…图片${totalRefCount}）。`,
      '请依据参考图和本轮提示词进行图生/参考编辑，保持需要延续的主体、风格与细节。',
    );
  }
  lines.push('', prompt);
  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio);
  if (ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0) {
    const orientation = Number(ratio[1]) > Number(ratio[2]) ? '横屏'
      : Number(ratio[1]) < Number(ratio[2]) ? '竖屏' : '正方形';
    lines.push('', `【输出画幅】本次界面选择为 ${aspectRatio}（${orientation}，宽:高），以此作为最终输出比例。请按目标画幅重新构图，不继承参考图或旧图的宽高比。`);
  }
  return lines.join('\n');
}

/** 当前项目启用的风格母图 URL */
function getProjectStyleMasterUrl(): string | null {
  const { currentProjectId, projects } = useAppStore.getState();
  const project = projects.find((p) => p.id === currentProjectId);
  const ref = project?.settings?.visualStyle?.styleReference;
  if (!ref || ref.enabled === false) return null;
  const url = (ref.imageUrl || '').trim();
  return url || null;
}

export async function generateImagesBatch(
  params: AIImageGenParams,
  count: number,
  signal?: AbortSignal,
): Promise<BatchImageResult> {
  const requestedCount = Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(count)));
  const { prompt: rawPrompt, model, provider } = params;
  let imageSize = params.imageSize ?? '2K';
  let aspectRatio = params.aspectRatio ?? '1:1';

  const generalModel = provider === 'general' ? resolveGeneralModel(model) : undefined;
  if (provider === 'general' && !generalModel) {
    throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
  }
  const config = useAppStore.getState().config;
  const connectionId = generalModel?.providerConfigId ?? provider;
  const providerConfig = config.providers[connectionId];
  const modelName = generalModel?.modelId ?? extractModelName(model, provider);
  const providerDefinition = getProviderDefinition(connectionId, providerConfig);
  if (providerDefinition?.id === 'cccapi' && !providerConfig?.apiKey?.trim()) {
    const group = providerConfig?.cccGroup ? `「${providerConfig.cccGroup}」分组` : '连接';
    throw new Error(`未配置 CCC API ${group}的 API Key\n请在「设置 → API Key」中配置对应连接`);
  }
  const catalogModel = providerDefinition?.models?.find((item) => item.id === modelName);
  // 已确认的内置合同优先，未知模型、自定义连接与工作流保持自己的协议。
  const builtInContract = params.workflowId ? undefined
    : resolveBuiltInImageRequestContract(providerDefinition, modelName, imageSize, aspectRatio);
  const configuredCapability = !params.workflowId && !builtInContract ? generalModel?.imageCapability : undefined;
  if (configuredCapability && generalModel) {
    assertModelCapabilityProtocol({ id: generalModel.modelId, name: generalModel.name, category: 'image',
      provider: connectionId, executionProfile: generalModel.executionProfile,
      imageReferenceRequestMode: generalModel.imageReferenceRequestMode, imageCapability: configuredCapability });
    ({ imageSize, aspectRatio } = resolveConfiguredImageParameters(configuredCapability,
      { imageSize: params.imageSize, aspectRatio: params.aspectRatio, count: requestedCount }));
  }
  const executionProfile = builtInContract ? undefined : generalModel?.executionProfile;
  const usesStandardImageRequest = !executionProfile
    || executionProfile.preset === 'openai-image'
    || executionProfile.preset === 'openai-gpt-image';
  const imageReferenceRequestMode = builtInContract?.kind === 'standard' ? builtInContract.imageReferenceRequestMode
    : builtInContract ? undefined
    : generalModel?.imageReferenceRequestMode
      ?? (executionProfile?.preset === 'custom' ? undefined
        : providerConfig?.selectedModels?.find((item) => item.id === modelName)?.imageReferenceRequestMode
          ?? catalogModel?.imageReferenceRequestMode);
  const usesImageDataUrls = !params.workflowId
    && (builtInContract?.kind === 'protocol' && builtInContract.referenceInput === 'data-url'
      || imageReferenceRequestMode === 'generation-json-image-data-urls');
  const usesImageMultipart = !params.workflowId
    && usesStandardImageRequest
    && imageReferenceRequestMode === 'edits-multipart';

  const customProtocol = executionProfile?.preset === 'custom'
    ? resolveModelExecutionProfile(executionProfile)
    : undefined;
  const usesCustomImageFiles = customProtocol?.submit.bodyEncoding === 'multipart'
    && hasReferenceImageFile(customProtocol.submit.body);


  const selectedWorkflow = params.workflowId ? useAppStore.getState().workflows.find((item) => item.id === params.workflowId) : undefined;
  const isComfyWorkflow = Boolean(params.workflowId && (!selectedWorkflow?.adapterType || selectedWorkflow.adapterType === 'comfyui'));
  const comfyMedia = isComfyWorkflow ? await resolvePromptWithMediaRefs(rawPrompt) : undefined;
  const { prompt: resolvedPrompt, imageUrls } = comfyMedia
    ? { prompt: comfyMedia.prompt, imageUrls: getMediaReferenceUrls(comfyMedia.references, 'image', 'local') }
    : await resolvePromptWithImageRefs(rawPrompt, { preferLocalImages: usesImageMultipart || usesCustomImageFiles || usesImageDataUrls });
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  // 合并调用方传入的 image_urls 与从 prompt 中解析出的 imageUrls
  let contentImageUrls = isComfyWorkflow
    ? mergeImageUrls(imageUrls, params.image_urls ?? [])
    : mergeImageUrls(params.image_urls ?? [], imageUrls);

  // 项目风格母图：自动插到最前，无需用户每次 @
  const styleMasterUrl = getProjectStyleMasterUrl();
  let allImageUrls = contentImageUrls;
  let styleAsFirst = false;
  if (styleMasterUrl && !isComfyWorkflow) {
    contentImageUrls = contentImageUrls.filter((u) => u !== styleMasterUrl);
    allImageUrls = mergeImageUrls([styleMasterUrl], contentImageUrls);
    styleAsFirst = true;
  }

  const prompt = enrichPromptWithReferenceHints(
    resolvedPrompt,
    allImageUrls.length,
    styleAsFirst,
    aspectRatio,
  );
  warnIfTooManyReferences({ image: allImageUrls.length });

  // Dreamina：CLI 端本地化图片，不走图床上传
  if (provider === 'dreamina') {
    if (!prompt.trim()) throw new Error('提示词不能为空');
    if (requestedCount > 1) throw new Error('即梦暂不支持批量生成，请将数量设为 1');
    return singleResult(await generateDreaminaImage({ prompt, model, imageSize, aspectRatio, imageUrls: allImageUrls, nodeId: params.nodeId }, signal));
  }


  // ComfyUI 工作流执行路径：参考图由 ComfyUI 自己的 /upload 收，不必先过图床
  if (params.workflowId) {
    if (requestedCount > 1) throw new Error('工作流暂不支持批量生成，请将数量设为 1');
    const workflow = useAppStore.getState().workflows.find((item) => item.id === params.workflowId);
    if (provider === 'workflow-api' && workflow?.adapterType !== 'workflow-api') throw new Error('请先配置并选择工作流 API');
    if (workflow?.adapterType === 'workflow-api') {
      const refs = mergeMediaReferences(collectPromptNodeMediaUrls(rawPrompt).references, collectConnectedReferenceMedia(params.nodeId).references);
      const result = await executeWorkflowApiMedia({ workflowId: workflow.id, nodeId: params.nodeId, taskContext: params.workflowApiTaskContext,
        prompt, inputs: parseWorkflowApiFields(params.workflowInputs, workflow.workflowApi), references: {
          image: mergeImageUrls(allImageUrls, getMediaReferenceUrls(refs, 'image', 'local')),
          video: getMediaReferenceUrls(refs, 'video', 'local'), audio: getMediaReferenceUrls(refs, 'audio', 'local'),
        } }, signal);
      return singleResult({ ...result, ...mapImageDimensions(imageSize, aspectRatio) });
    }
    if (isRunningHubWorkflow(workflow)) {
      const refs = mergeMediaReferences(collectPromptNodeMediaUrls(rawPrompt).references, collectConnectedReferenceMedia(params.nodeId).references);
      const outputs = await executeRunningHubWorkflow({ ...params, workflowId: params.workflowId, prompt, kind: 'image', references: {
        image: mergeImageUrls(allImageUrls, getMediaReferenceUrls(refs, 'image', 'local')),
        video: getMediaReferenceUrls(refs, 'video', 'local'), audio: getMediaReferenceUrls(refs, 'audio', 'local'),
      } }, signal);
      return singleResult({ url: outputs[0].url, runninghubOutputs: outputs, ...mapImageDimensions(imageSize, aspectRatio) });
    }
    const connected = collectConnectedReferenceMedia(params.nodeId).references;
    const refs = mergeMediaReferences(comfyMedia?.references ?? [], connected);
    let images = mergeImageUrls(allImageUrls, getMediaReferenceUrls(connected, 'image', 'local'));
    if (styleMasterUrl) images = mergeImageUrls(images, [styleMasterUrl]);
    const styleHint = styleMasterUrl ? `\n【项目风格母图】图片${images.indexOf(styleMasterUrl) + 1} 只用于风格、色彩和光影参考。` : '';
    const comfyPrompt = enrichPromptWithReferenceHints(resolvedPrompt, images.length, false, aspectRatio) + styleHint;
    return singleResult(await executeComfyUIGenerate({ ...params, prompt: comfyPrompt }, signal, images, {
      videoUrls: getMediaReferenceUrls(refs, 'video', 'local'), audioUrls: getMediaReferenceUrls(refs, 'audio', 'local'),
    }));
  }
  if (provider === 'runninghubwf') throw new Error('请先在工作流管理中导入并配置该 RunningHub 工作流');
  if (provider === 'workflow-api') throw new Error('请先配置并选择工作流 API');

  // comfyui 从不注册在 providers 里，落到下面的 default 分支只会误报「未配置 API Key」
  if (provider === 'comfyui') {
    throw new Error('未选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
  }


  // 参考图传输格式由模型显式配置或已确认的厂商目录决定。
  const referenceMedia = provider === 'runninghub' ? mergeMediaReferences(collectPromptNodeMediaUrls(rawPrompt).references, collectConnectedReferenceMedia(params.nodeId).references) : undefined;
  if (referenceMedia) allImageUrls = mergeImageUrls(allImageUrls, getMediaReferenceUrls(referenceMedia, 'image', 'local'));
  if (configuredCapability) assertConfiguredImageReferences(configuredCapability, allImageUrls.length);
  // multipart 直接读取原始参考图，避免本地图片先上传图床再下载回来的额外网络依赖。
  allImageUrls = provider === 'runninghub' || usesImageMultipart ? allImageUrls : usesImageDataUrls || usesCustomImageFiles
    ? await resolveImageDataUrlArray(allImageUrls, signal)
    : await resolveImageUrlArray(allImageUrls, provider, signal);
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  if (!prompt.trim() && provider !== 'runninghub') throw new Error('提示词不能为空');

  if (builtInContract?.kind === 'protocol') {
    const apiKey = providerConfig?.apiKey || '';
    const baseUrl = providerConfig?.baseUrl?.trim() || providerDefinition?.defaultBaseUrl || '';
    if (!apiKey) throw new Error(`未配置 ${providerDefinition?.name} 的 API Key\n请在「设置 → API Key」中配置`);
    const results: ImageGenerationResult[] = [];
    // 此合同一次只生成一张；顺序执行用户请求的数量，失败即停止，禁止重放提交。
    for (let index = 0; index < requestedCount; index += 1) {
      signal?.throwIfAborted();
      try {
        const result = await executeModelProtocol({
          apiKey, baseUrl, protocol: builtInContract.protocol,
          variables: { model: modelName, prompt, imageUrls: allImageUrls },
          validateResponse: validateBuiltInImageResponse,
          signal,
        });
        signal?.throwIfAborted();
        const url = result.urls?.[0];
        if (!url) throw new Error('图片生成返回结果为空');
        results.push({ url, ...builtInContract.dimensions });
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError') || !results.length) throw error;
        break;
      }
    }
    return { requestedCount, results, failedCount: requestedCount - results.length };
  }

  const registeredAdapter = mediaProviderRegistry.getImageAdapter(provider);
  if (registeredAdapter) {
    return registeredAdapter.generateImage({
      params,
      prompt,
      imageUrls: allImageUrls,
      referenceMedia,
      requestedCount,
      signal,
    });
  }

  // 尚未迁移的 Provider 继续走兼容分支。
  switch (provider) {
    case 'general': {
      if (!generalModel) {
        throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
      }
      const gm = generalModel;
      const connection = resolveGeneralModelConnection(model);
      if (!connection) throw new Error(`通用模型 "${gm.name}" 的连接配置不存在`);
      if (!connection.baseUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
      const dimensions = resolveImageTemplateDimensions(configuredCapability, imageSize, aspectRatio);
      const hasExplicitStandardRequestMode = allImageUrls.length > 0
        && imageReferenceRequestMode !== undefined
        && usesStandardImageRequest;
      if (executionProfile && !hasExplicitStandardRequestMode) {
        const urls = await runConfiguredModelProtocol({
          model: gm,
          category: 'image',
          nodeId: params.nodeId,
          signal,
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
            ...(customProtocol && modelProtocolUsesVariable(JSON.stringify(customProtocol.submit), 'googleImageParts')
              ? { googleImageParts: buildGoogleImageParts(prompt, allImageUrls) } : {}),
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
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl,
        modelName: gm.modelId,
        prompt,
        dimensions,
        imageUrls: allImageUrls,
        imageReferenceRequestMode,
      }, requestedCount, signal);
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
        nodeId: params.nodeId,
      }, requestedCount, signal);
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
        imageReferenceRequestMode,
      }, requestedCount, signal);
    }
  }
}
