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
import { getEnabledProjectStyleReferenceUrl } from '../projectSettingsService';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import { mapImageDimensions } from '../aiDimensions';
import { generateDreaminaImage } from '../dreaminaService';
import { executeComfyUIGenerate } from '../comfyWorkflowService';
import { isRunningHubWorkflow } from '../workflowExecutionService';
import { executeRunningHubWorkflow } from './providers/runninghubWorkflow';
import { splitRunningHubPrompt } from './providers/runninghubWorkflowInputs';
import { executeWorkflowApiMedia } from '../workflowApi/workflowApiAdapter';
import { parseWorkflowApiFields } from '../workflowApi/workflowApiConfig';
import { collectConnectedReferenceMedia, getMediaReferenceUrls, mergeMediaReferences } from './connectedReferenceMedia';
import type { AIImageGenParams, BatchImageResult, ImageGenerationResult, MediaReference } from '../../types/aiTypes';
import type { AppConfig, GeneralModelConfig, ImageReferenceRequestMode } from '../../types';
import { MAX_IMAGE_BATCH_COUNT } from '../../types/aiTypes';
import { extractModelName, resolveGeneralModel, resolveGeneralModelConnection } from './helpers';
import { collectPromptNodeMediaUrls, resolvePromptWithImageRefs, resolvePromptWithMediaRefs } from './promptResolver';
import { warnIfTooManyReferences } from './connectedReferenceMedia';
import { IMAGE_GENERATION_DATA_URL_BUDGET, resolveImageDataUrlArray, resolveImageUrlArray } from './imageUtils';
import { generateImageStandardBatch } from './providers/standardImage';
import { generateVolcengineImagesBatch } from './providers/volcengineImage';
import { retainCompletedMediaResults, runConfiguredModelProtocol } from './modelProtocolRuntime';
import { createMediaDownloadAccess } from './mediaDownloadAccess';
import { mediaProviderRegistry } from './mediaProviderRegistry';
import { executeModelProtocol, modelProtocolUsesVariable, resolveModelExecutionProfile } from './modelProtocol';
import { assertConfiguredImageReferences, assertModelCapabilityProtocol, resolveConfiguredImageParameters, resolveConfiguredImageBackground, resolveConfiguredImageQuality } from './modelCapabilityValidation';
import { getProviderDefinition, resolveCccGeminiImageExecutionProfile } from './providerCatalogService';
import { resolveBuiltInImageRequestContract, validateBuiltInImageResponse } from './imageRequestContracts';
import { buildGoogleImageParts, resolveImageTemplateDimensions } from './imageModelTemplates';
import { assertToapisImageInput, resolveToapisImageModelContract, toapisImageReferences } from './providers/toapisModelManifest';
import { assertLibapiImageInput, libapiImageExecutionProfile, libapiImageVariables, usesLibapiModelProtocol } from './providers/libapiModelManifest';
import { relayonImageVariables, resolveRelayonImageExecutionProfile, resolveRelayonImageModelContract, usesRelayonModelProtocol } from './providers/relayonModelManifest';
import { aigcsiImageExecutionProfile, usesAigcsiModelProtocol } from './providers/aigcsiModelManifest';
import { resolveImageOutputsPerJob, resolveImageExecutionCapability } from './mediaModelCapabilities';
import { DREAMINA_IMAGE_RATIOS } from './dreaminaModels';
import { compileVideoReferencePrompt } from './referencePrompt';
import { isNativeVideoSubmissionGuard } from '../nativeVideoSubmission';
import { isNativeCharacterImageSubmissionGuard, runNativeCharacterImageTask } from '../nativeCharacterImageTask';
import { isOpenAIPaintMaskContract } from './characterImageMask';

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
  beforeSubmit?: () => void | Promise<void>,
): Promise<ImageGenerationResult> {
  if (useAppStore.getState().projectExecutionContext?.modelGeneration !== 1 && !params.collectCandidates && !params.workflowId
    && resolveImageOutputsPerJob(params.model, params.provider, useAppStore.getState().config) > 1) {
    throw new Error('所选模型一次返回多张候选图，请在图片节点或对话中生成');
  }
  const batch = await generateImagesBatch(params, 1, signal, beforeSubmit);
  const result = batch.results[0];
  if (!result) throw new Error('图片生成返回结果为空');
  return { ...result,
    ...(batch.taskReceipt ? { taskReceipt: batch.taskReceipt } : {}),
    ...((batch.expectedOutputCount ?? 1) > 1 ? {
      expectedOutputCount: batch.expectedOutputCount,
      ...(batch.results.length > 1 ? { additionalResults: batch.results.slice(1) } : {}),
    } : {}),
  };
}

function singleResult(result: ImageGenerationResult): BatchImageResult {
  return { requestedCount: 1, results: [result], failedCount: 0,
    ...(result.mediaDownloadAccess ? { mediaDownloadAccess: result.mediaDownloadAccess } : {}) };
}

function retainStandardImageDelivery(batch: BatchImageResult, connectionId: string, baseUrl: string, nodeId: string | undefined, projectId: string | null): BatchImageResult {
  // 仅用于下方实际采用 Bearer 的标准图片执行器，不推断其他厂商鉴权。
  const access = createMediaDownloadAccess(connectionId, baseUrl, { type: 'bearer' });
  const urls = retainCompletedMediaResults(batch.results.map((result) => result.url), access, nodeId, 'image', batch.requestedCount, batch.taskReceipt, projectId);
  return { ...batch, mediaDownloadAccess: access,
    ...(urls.taskReceipt ? { taskReceipt: urls.taskReceipt, allTasksSettled: batch.allTasksSettled ?? true } : {}),
    results: batch.results.map((result) => ({ ...result, mediaDownloadAccess: access,
      ...(urls.taskReceipt ? { taskReceipt: urls.taskReceipt } : {}) })) };
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
  return getEnabledProjectStyleReferenceUrl(project?.settings);
}

function characterImageConnection(model: string, provider: string, config: AppConfig) {
  const general = provider === 'general'
    ? config.generalModels?.find((item) => item.id === model.replace(/^general\//, '') && item.category === 'image') : undefined;
  if (provider === 'general' && !general) return;
  const connectionId = general?.providerConfigId ?? provider;
  const connection = config.providers[connectionId];
  const definition = getProviderDefinition(connectionId, connection);
  const modelName = general?.modelId ?? extractModelName(model, provider);
  const baseUrl = connection?.baseUrl?.trim() || definition?.defaultBaseUrl || DEFAULT_BASE_URLS[provider];
  if (!connection?.apiKey?.trim() || !baseUrl) return;
  const selected = connection.selectedModels?.find((item) => item.id === modelName && item.category === 'image');
  const catalog = definition?.models?.find((item) => item.id === modelName && item.category === 'image');
  const legacyCustomConnection = general && definition?.id === 'custom-openai' ? connection : undefined;
  const profile = general?.executionProfile
    ?? (legacyCustomConnection ? selected?.executionProfile ?? legacyCustomConnection.imageProtocolDefault : undefined);
  const referenceMode = general?.imageReferenceRequestMode ?? selected?.imageReferenceRequestMode
    ?? legacyCustomConnection?.imageReferenceRequestModeDefault ?? catalog?.imageReferenceRequestMode;
  return { general, definition, modelName, baseUrl, profile, referenceMode };
}

function characterImageReferenceMode(route: NonNullable<ReturnType<typeof characterImageConnection>>): ImageReferenceRequestMode | undefined {
  if (route.referenceMode) return route.referenceMode;
  if (!route.general || route.definition?.id !== 'custom-openai') return undefined;
  // 旧的同名 GPT Image 2 自定义连接可在工作台尝试标准图片编辑合同。
  if (route.modelName === 'gpt-image-2' || route.modelName === 'gpt-image-2-2026-04-21'
    || isOpenAIPaintMaskContract(route.baseUrl, route.modelName)) return 'edits-multipart';
  return undefined;
}

export function characterImageChannel(model: string, provider: string, config: AppConfig): 'standard' | 'midjourney' {
  const route = characterImageConnection(model, provider, config);
  if (route?.definition?.id === 'relayonapi' && resolveImageOutputsPerJob(model, provider, config) === 4) return 'midjourney';
  return 'standard';
}

export function supportsCharacterPaintMask(model: string, provider: string, config: AppConfig): boolean {
  const route = characterImageConnection(model, provider, config);
  if (!route?.general || route.definition?.id !== 'custom-openai' || !isOpenAIPaintMaskContract(route.baseUrl, route.modelName)) return false;
  return (!route.profile || route.profile.preset === 'openai-image' || route.profile.preset === 'openai-gpt-image')
    && characterImageReferenceMode(route) === 'edits-multipart';
}

/** 角色工作台只开放已经接入角色回执的同步接口。 */
export function supportsCharacterImageModel(
  model: string, provider: string, config: AppConfig = useAppStore.getState().config, referenceCount = 0,
): boolean {
  const route = characterImageConnection(model, provider, config);
  if (!route) return false;
  const capability = referenceCount > 0 ? resolveImageExecutionCapability(model, provider, config) : undefined;
  if (capability?.supportsImageReference === false
    || (capability?.maxImageReferences !== undefined && referenceCount > capability.maxImageReferences)) return false;
  const { definition, modelName, profile } = route;
  if (characterImageChannel(model, provider, config) === 'midjourney') return referenceCount <= 1;
  if (definition?.id === 'grsai') {
    const parameters = capability ?? resolveImageExecutionCapability(model, provider, config);
    try {
      return resolveBuiltInImageRequestContract(definition, modelName,
        parameters?.defaultResolution ?? '1K', parameters?.defaultRatio ?? '1:1')?.kind === 'protocol';
    } catch { return false; }
  }
  if (['cccapi', 'toapis', 'libapi', 'relayonapi', 'aigc-si'].includes(definition?.id ?? '')
    || ['dreamina', 'volcengine', 'localllm', 'comfyui', 'runninghubwf', 'workflow-api'].includes(provider)
    || mediaProviderRegistry.getImageAdapter(provider)) return false;
  if (profile && profile.preset !== 'openai-image' && profile.preset !== 'openai-gpt-image') return false;
  const mode = characterImageReferenceMode(route);
  return !referenceCount || mode === 'edits-multipart'
    || (mode === 'generation-json-image-data-urls' && capability?.supportsDataUrlReference !== false);
}

export async function generateImagesBatch(
  params: AIImageGenParams,
  count: number,
  signal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>,
): Promise<BatchImageResult> {
  const requestedCount = Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(count)));
  const { model, provider } = params;
  const characterWorkbench = params.characterWorkbench;
  const characterGuard = isNativeCharacterImageSubmissionGuard(beforeSubmit) ? beforeSubmit : undefined;
  if (characterWorkbench && (!beforeSubmit || params.workflowId
    || !supportsCharacterImageModel(model, provider, useAppStore.getState().config, params.image_urls?.length)
    || characterWorkbench === 'global' && characterGuard)) {
    throw new Error('此模型尚未接入角色工作台的图片交付');
  }
  if (useAppStore.getState().projectExecutionContext?.modelGeneration === 1 && characterWorkbench !== 'global') {
    if (!isNativeVideoSubmissionGuard(beforeSubmit) && !(characterWorkbench === 'project' && characterGuard)) {
      throw new Error('此原生图片模型或批量合同没有可耐久续查的完整回执，未提交请求');
    }
  }
  let rawPrompt = params.prompt;
  const rawWorkflowPrompt = rawPrompt;
  let imageSize = params.imageSize ?? '2K';
  let aspectRatio = params.aspectRatio ?? '1:1';

  const generalModel = provider === 'general' ? resolveGeneralModel(model) : undefined;
  if (provider === 'general' && !generalModel) {
    throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
  }
  const state = useAppStore.getState();
  const config = state.config;
  const characterRoute = characterWorkbench ? characterImageConnection(model, provider, config) : undefined;
  const characterMidjourney = !!characterWorkbench && characterImageChannel(model, provider, config) === 'midjourney';
  if (params.characterPaintMask && (!characterRoute || !supportsCharacterPaintMask(model, provider, config)
    || params.image_urls?.length !== 1 || params.workflowId)) {
    throw new Error('所选连接不支持画笔蒙版，或未选择一张有效底图');
  }
  if (characterMidjourney && requestedCount !== 1) throw new Error('角色工作台每次提交一个 Midjourney 作业');
  const submissionProjectId = state.currentProjectId;
  const connectionId = generalModel?.providerConfigId ?? provider;
  const providerConfig = config.providers[connectionId];
  const modelName = generalModel?.modelId ?? extractModelName(model, provider);
  const providerDefinition = getProviderDefinition(connectionId, providerConfig);
  const isLibapi = !params.workflowId && providerDefinition?.id === 'libapi';
  if (providerDefinition?.id === 'cccapi' && !providerConfig?.apiKey?.trim()) {
    const group = providerConfig?.cccGroup ? `「${providerConfig.cccGroup}」分组` : '连接';
    throw new Error(`未配置 CCC API ${group}的 API Key\n请在「设置 → API Key」中配置对应连接`);
  }
  const catalogModel = providerDefinition?.models?.find((item) => item.id === modelName);
  const selectedModel = providerConfig?.selectedModels?.find((item) => item.id === modelName);
  const toapisContract = providerDefinition?.id === 'toapis' && !params.workflowId
    ? resolveToapisImageModelContract(modelName, generalModel?.executionProfile, generalModel?.imageCapability)
    : undefined;
  const relayonContract = providerDefinition?.id === 'relayonapi' && !params.workflowId
    ? resolveRelayonImageModelContract(modelName, generalModel?.executionProfile ?? selectedModel?.executionProfile,
      generalModel?.imageCapability ?? selectedModel?.imageCapability)
    : undefined;
  const isCccImage = !params.workflowId && providerDefinition?.id === 'cccapi';
  const cccExecutionProfile = isCccImage ? resolveCccGeminiImageExecutionProfile(
    modelName, generalModel?.executionProfile ?? selectedModel?.executionProfile,
  ) : undefined;
  const effectiveProfile = cccExecutionProfile ?? toapisContract?.executionProfile
    ?? relayonContract?.executionProfile ?? characterRoute?.profile ?? generalModel?.executionProfile;
  if (isCccImage && /^(?:gemini-.*image|nano-banana)/i.test(modelName)
    && (!effectiveProfile || effectiveProfile.preset === 'openai-image' || effectiveProfile.preset === 'openai-gpt-image')) {
    throw new Error('此 CCC Gemini／香蕉图片型号尚未适配原生调用协议，请配置该模型的调用协议后再试');
  }
  // 直连节点仍绑定原连接；只为已配置协议构造本轮执行描述，不写入或迁移用户配置。
  const declarativeModel: GeneralModelConfig | undefined = generalModel ?? (isCccImage
    || !params.workflowId && providerDefinition?.id === 'relayonapi' && effectiveProfile ? {
    id: modelName, modelId: modelName, name: selectedModel?.name ?? catalogModel?.name ?? modelName,
    category: 'image', providerConfigId: connectionId,
  } : undefined);
  const parameterCapability = params.workflowId ? undefined : resolveImageExecutionCapability(model, provider, config);
  const imageQuality = resolveConfiguredImageQuality(parameterCapability, params.imageQuality);
  const imageBackground = resolveConfiguredImageBackground(parameterCapability, params.imageBackground);
  if (!params.workflowId && provider === 'dreamina' && params.aspectRatio !== undefined
    && !DREAMINA_IMAGE_RATIOS.some((ratio) => ratio === params.aspectRatio)) {
    throw new Error(`即梦图片模型不支持比例 ${params.aspectRatio}，可选：${DREAMINA_IMAGE_RATIOS.join('、')}`);
  }
  // 已确认的内置合同优先，未知模型、自定义连接与工作流保持自己的协议。
  const builtInContract = params.workflowId ? undefined
    : resolveBuiltInImageRequestContract(providerDefinition, modelName, imageSize, aspectRatio, imageQuality, imageBackground);
  const declaredCapability = !params.workflowId && !builtInContract
    ? toapisContract?.imageCapability ?? relayonContract?.imageCapability ?? generalModel?.imageCapability
      ?? (isCccImage ? selectedModel?.imageCapability : undefined) : undefined;
  const configuredCapability = !params.workflowId && !builtInContract ? parameterCapability ?? declaredCapability : undefined;
  if (!builtInContract && generalModel) {
    // 显式声明仍接受完整协议校验；目录派生的布局/选项不冒充用户对全部协议字段的承诺。
    assertModelCapabilityProtocol({ id: generalModel.modelId, name: generalModel.name, category: 'image',
      provider: connectionId, executionProfile: effectiveProfile,
      imageReferenceRequestMode: generalModel.imageReferenceRequestMode, imageCapability: declaredCapability });
  }
  if (configuredCapability && generalModel) {
    ({ imageSize, aspectRatio } = resolveConfiguredImageParameters(configuredCapability,
      { imageSize: params.imageSize, aspectRatio: params.aspectRatio, imageQuality, imageBackground, count: requestedCount }));
  }
  const executionProfile = builtInContract ? undefined : effectiveProfile;
  const usesLibapiProtocol = isLibapi && usesLibapiModelProtocol(modelName, executionProfile);
  const usesRelayonProtocol = providerDefinition?.id === 'relayonapi'
    && usesRelayonModelProtocol(modelName, executionProfile);
  const outputsPerJob = !params.workflowId && usesRelayonProtocol
    ? resolveImageOutputsPerJob(model, provider, config) : 1;
  const usesAigcsiProtocol = providerDefinition?.id === 'aigc-si'
    && usesAigcsiModelProtocol(modelName, executionProfile);
  const usesStandardImageRequest = !executionProfile
    || executionProfile.preset === 'openai-image'
    || executionProfile.preset === 'openai-gpt-image';
  const imageReferenceRequestMode = builtInContract?.kind === 'standard' ? builtInContract.imageReferenceRequestMode
    : builtInContract ? undefined
    : characterRoute && usesStandardImageRequest ? characterImageReferenceMode(characterRoute)
    : generalModel?.imageReferenceRequestMode
      ?? (executionProfile?.preset === 'custom' && !usesRelayonProtocol ? undefined
        : selectedModel?.imageReferenceRequestMode
          ?? catalogModel?.imageReferenceRequestMode);
  const customProtocol = executionProfile?.preset === 'custom'
    ? resolveModelExecutionProfile(executionProfile)
    : undefined;
  const usesGoogleImageParts = !!customProtocol && modelProtocolUsesVariable(JSON.stringify(customProtocol.submit), 'googleImageParts');
  const usesImageDataUrls = !params.workflowId
    && (provider === 'muse' || characterMidjourney || usesGoogleImageParts || usesAigcsiProtocol || builtInContract?.kind === 'protocol' && builtInContract.referenceInput === 'data-url'
      || imageReferenceRequestMode === 'generation-json-image-data-urls');
  const usesImageMultipart = !params.workflowId
    && usesStandardImageRequest
    && imageReferenceRequestMode === 'edits-multipart';
  const usesCustomImageFiles = customProtocol?.submit.bodyEncoding === 'multipart'
    && hasReferenceImageFile(customProtocol.submit.body);
  if (characterWorkbench && params.image_urls?.length && !usesImageMultipart && !usesImageDataUrls) {
    throw new Error('此模型无法直接接收角色参考图');
  }


  const selectedWorkflow = params.workflowId ? useAppStore.getState().workflows.find((item) => item.id === params.workflowId) : undefined;
  const isComfyWorkflow = Boolean(params.workflowId && (!selectedWorkflow?.adapterType || selectedWorkflow.adapterType === 'comfyui'));
  const isRunningHub = params.workflowId ? isRunningHubWorkflow(selectedWorkflow) : provider === 'runninghub';
  if (isRunningHubWorkflow(selectedWorkflow)) rawPrompt = splitRunningHubPrompt(rawWorkflowPrompt).prompt;
  const cameraSettings = useAppStore.getState().nodes.find((node) => node.id === params.nodeId)?.data.cameraSettings;
  const comfyMedia = isComfyWorkflow ? await resolvePromptWithMediaRefs(rawPrompt, { cameraSettings }) : undefined;
  const runninghubMedia = isRunningHub ? await resolvePromptWithMediaRefs(rawPrompt, { preserveBindings: true, cameraSettings }) : undefined;
  const localMedia = runninghubMedia ?? comfyMedia;
  const { prompt: resolvedPrompt, imageUrls } = characterWorkbench
    ? { prompt: rawPrompt, imageUrls: [] }
    : localMedia
    ? { prompt: localMedia.prompt, imageUrls: getMediaReferenceUrls(localMedia.references, 'image', 'local') }
    : await resolvePromptWithImageRefs(rawPrompt, { preferLocalImages: usesImageMultipart || usesCustomImageFiles || usesImageDataUrls || providerDefinition?.id === 'toapis' || isLibapi || !!providerConfig?.imageHosting?.enabled, cameraSettings });
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  // 仅归一同一节点的来源别名；裸 URL 或其他节点仍可能明确需要未标注的原图。
  const canonicalImageReference = (reference: MediaReference): MediaReference => {
    if (reference.kind !== 'image' || !reference.sourceNodeId) return reference;
    const local = runninghubMedia?.references.find((candidate) => candidate.kind === 'image'
      && candidate.sourceNodeId === reference.sourceNodeId
      && (candidate.sourceUrl === reference.url
        || useAppStore.getState().nodes.find((node) => node.id === candidate.sourceNodeId)?.data.imageUrl === reference.url));
    return local ? { ...reference, url: local.url } : reference;
  };
  // 合并调用方传入的 image_urls 与从 prompt 中解析出的 imageUrls
  let contentImageUrls = isComfyWorkflow
    ? mergeImageUrls(imageUrls, params.image_urls ?? [])
    : mergeImageUrls(params.image_urls ?? [], imageUrls);

  // 项目风格母图：自动插到最前，无需用户每次 @
  const styleMasterUrl = characterWorkbench ? null : getProjectStyleMasterUrl();
  let allImageUrls = contentImageUrls;
  let styleAsFirst = false;
  if (styleMasterUrl && !isComfyWorkflow) {
    contentImageUrls = contentImageUrls.filter((u) => u !== styleMasterUrl);
    allImageUrls = mergeImageUrls([styleMasterUrl], contentImageUrls);
    styleAsFirst = true;
  }

  const referenceMedia = runninghubMedia ? mergeMediaReferences(
    allImageUrls.map((url): MediaReference => ({ kind: 'image', url, origin: 'connection', role: 'reference' })),
    mergeMediaReferences(runninghubMedia.references, collectConnectedReferenceMedia(params.nodeId).references.map(canonicalImageReference)),
  ) : undefined;
  if (referenceMedia) allImageUrls = getMediaReferenceUrls(referenceMedia, 'image', 'local');
  const prompt = characterWorkbench ? resolvedPrompt : enrichPromptWithReferenceHints(
    runninghubMedia && referenceMedia ? compileVideoReferencePrompt(runninghubMedia, referenceMedia, { target: 'local' }) : resolvedPrompt,
    allImageUrls.length,
    styleAsFirst,
    aspectRatio,
  );
  // 原生图片按显式模型能力校验，不用通用“多数模型前 10 项”的提示猜测其上限。
  if (!usesGoogleImageParts) warnIfTooManyReferences({ image: allImageUrls.length });

  // Dreamina：CLI 端本地化图片，不走图床上传
  if (provider === 'dreamina') {
    if (!prompt.trim()) throw new Error('提示词不能为空');
    if (requestedCount > 1) throw new Error('即梦暂不支持批量生成，请将数量设为 1');
    return singleResult(await generateDreaminaImage({ prompt, model, imageSize, aspectRatio, imageUrls: allImageUrls, nodeId: params.nodeId, beforeSubmit }, signal));
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
        }, beforeSubmit }, signal);
      return singleResult({ ...result, ...mapImageDimensions(imageSize, aspectRatio) });
    }
    if (isRunningHubWorkflow(workflow)) {
      const refs = referenceMedia ?? [];
      const outputs = await executeRunningHubWorkflow({ ...params, workflowId: params.workflowId, rawWorkflowPrompt, prompt, kind: 'image', references: {
        image: allImageUrls,
        video: getMediaReferenceUrls(refs, 'video', 'local'), audio: getMediaReferenceUrls(refs, 'audio', 'local'),
      } }, signal, beforeSubmit);
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
    }, beforeSubmit));
  }
  if (provider === 'runninghubwf') throw new Error('请先在工作流管理中导入并配置该 RunningHub 工作流');
  if (provider === 'workflow-api') throw new Error('请先配置并选择工作流 API');

  // comfyui 从不注册在 providers 里，落到下面的 default 分支只会误报「未配置 API Key」
  if (provider === 'comfyui') {
    throw new Error('未选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
  }


  // 参考图传输格式由模型显式配置或已确认的厂商目录决定。
  if (configuredCapability) assertConfiguredImageReferences(configuredCapability, allImageUrls.length);
  if (providerDefinition?.id === 'toapis') assertToapisImageInput(modelName, allImageUrls.length, requestedCount);
  if (usesLibapiProtocol) assertLibapiImageInput(modelName, allImageUrls.length, requestedCount);
  const libapiExecutionProfile = usesLibapiProtocol ? libapiImageExecutionProfile(modelName, allImageUrls.length) : undefined;
  const relayonExecutionProfile = usesRelayonProtocol
    ? resolveRelayonImageExecutionProfile(modelName, executionProfile, allImageUrls.length, imageBackground) : undefined;
  const aigcsiExecutionProfile = usesAigcsiProtocol ? aigcsiImageExecutionProfile(allImageUrls.length) : undefined;
  // multipart 直接读取原始参考图，避免本地图片先上传图床再下载回来的额外网络依赖。
  allImageUrls = provider === 'runninghub' || usesImageMultipart ? allImageUrls : usesImageDataUrls || usesCustomImageFiles
    ? await resolveImageDataUrlArray(allImageUrls, signal, usesGoogleImageParts || characterWorkbench ? IMAGE_GENERATION_DATA_URL_BUDGET : undefined)
    : await resolveImageUrlArray(allImageUrls, providerDefinition?.id === 'toapis' || isLibapi || providerDefinition?.id === 'custom-openai' ? connectionId : provider, signal);
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  if (!prompt.trim() && provider !== 'runninghub') throw new Error('提示词不能为空');

  if (characterMidjourney) {
    const protocol = resolveModelExecutionProfile(relayonExecutionProfile);
    const baseUrl = providerConfig?.baseUrl?.trim() || providerDefinition?.defaultBaseUrl || '';
    const apiKey = providerConfig?.apiKey;
    if (!protocol || protocol.mode !== 'sync' || outputsPerJob !== 4 || !baseUrl || !apiKey) {
      throw new Error('原 Midjourney 通道未配置完整的同步图片协议');
    }
    const dimensions = resolveImageTemplateDimensions(parameterCapability ?? configuredCapability, imageSize, aspectRatio);
    const variables = relayonImageVariables(modelName, { model: modelName, prompt, imageSize, aspectRatio,
      n: 1, batchCount: 1, imageUrls: allImageUrls, size: `${dimensions.width}x${dimensions.height}` });
    const mediaDownloadAccess = createMediaDownloadAccess(connectionId, baseUrl, protocol.auth);
    const execute = async (markSubmitted?: () => void | Promise<void>) => (await executeModelProtocol({
      apiKey, baseUrl, protocol, variables, signal, beforeSubmit: markSubmitted, sensitive: true,
    })).urls ?? [];
    if (characterGuard) {
      const batch = await runNativeCharacterImageTask({ guard: characterGuard, modelRef: model, connectionId,
        requestMaterial: [protocol, variables], dimensions, expectedCount: outputsPerJob, signal, mediaDownloadAccess, execute });
      return { ...batch, requestedCount, expectedOutputCount: outputsPerJob };
    }
    const urls = await execute(beforeSubmit);
    if (!urls.length) throw new Error('Midjourney 未返回可保存的候选图片');
    return { requestedCount, expectedOutputCount: outputsPerJob, mediaDownloadAccess, allTasksSettled: true,
      results: urls.map((url) => ({ url, ...dimensions })), failedCount: Math.max(0, outputsPerJob - urls.length) };
  }

  if (builtInContract?.kind === 'protocol') {
    const apiKey = providerConfig?.apiKey || '';
    const baseUrl = providerConfig?.baseUrl?.trim() || providerDefinition?.defaultBaseUrl || '';
    if (!apiKey) throw new Error(`未配置 ${providerDefinition?.name} 的 API Key\n请在「设置 → API Key」中配置`);
    if (characterGuard) {
      return await runNativeCharacterImageTask({ guard: characterGuard, modelRef: model, connectionId,
        requestMaterial: [builtInContract.protocol, modelName, prompt, imageQuality, imageBackground, allImageUrls],
        dimensions: builtInContract.dimensions, expectedCount: requestedCount, signal,
        mediaDownloadAccess: createMediaDownloadAccess(connectionId, baseUrl, builtInContract.protocol.auth),
        execute: async (beforePost) => {
          const result = await executeModelProtocol({ apiKey, baseUrl, protocol: builtInContract.protocol,
            variables: { model: modelName, prompt, imageQuality, imageBackground, imageUrls: allImageUrls },
            validateResponse: validateBuiltInImageResponse, signal, beforeSubmit: beforePost, sensitive: true });
          return result.urls ?? [];
        } });
    }
    if (state.projectExecutionContext?.modelGeneration === 1 && !characterWorkbench) {
      const { runNativeBuiltinImageTask } = await import('../nativeBuiltinImageTask');
      return await runNativeBuiltinImageTask({ nodeId: params.nodeId, mode: 'protocol', modelId: modelName, connectionId, baseUrl,
        secrets: [apiKey],
        expectedCount: requestedCount, modelRef: generalModel ? `general/${generalModel.id}` : `${connectionId}/${modelName}`,
        requestMaterial: [builtInContract.protocol, modelName, prompt, imageQuality, imageBackground, allImageUrls], signal, beforeSubmit,
        mediaDownloadAccess: createMediaDownloadAccess(connectionId, baseUrl, builtInContract.protocol.auth),
        execute: async (beforePost) => {
          await beforePost();
          const result = await executeModelProtocol({ apiKey, baseUrl, protocol: builtInContract.protocol,
            variables: { model: modelName, prompt, imageQuality, imageBackground, imageUrls: allImageUrls }, validateResponse: validateBuiltInImageResponse, signal });
          return { urls: result.urls };
        } });
    }
    const results: ImageGenerationResult[] = [];
    // 此合同一次只生成一张；顺序执行用户请求的数量，失败即停止，禁止重放提交。
    for (let index = 0; index < requestedCount; index += 1) {
      signal?.throwIfAborted();
      try {
        const result = await executeModelProtocol({
          apiKey, baseUrl, protocol: builtInContract.protocol,
          variables: { model: modelName, prompt, imageQuality, imageBackground, imageUrls: allImageUrls },
          validateResponse: validateBuiltInImageResponse,
          signal,
          ...(characterWorkbench ? { beforeSubmit, sensitive: true } : {}),
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
    return { requestedCount, results, failedCount: requestedCount - results.length,
      ...(characterWorkbench ? { mediaDownloadAccess: createMediaDownloadAccess(connectionId, baseUrl, builtInContract.protocol.auth) } : {}) };
  }

  const registeredAdapter = mediaProviderRegistry.getImageAdapter(provider);
  if (registeredAdapter) {
    return registeredAdapter.generateImage({
      params: { ...params, imageSize, aspectRatio, imageQuality, imageBackground },
      prompt,
      imageUrls: allImageUrls,
      referenceMedia,
      requestedCount,
      signal,
      beforeSubmit,
    });
  }

  // 通用模型与已适配直连节点共用声明式执行，不能因 provider 形态丢失协议或额外候选。
  if (declarativeModel && executionProfile) {
    const gm = declarativeModel;
    const dimensions = resolveImageTemplateDimensions(parameterCapability ?? configuredCapability, imageSize, aspectRatio);
    const hasExplicitStandardRequestMode = allImageUrls.length > 0
      && imageReferenceRequestMode !== undefined
      && usesStandardImageRequest;
    if (!hasExplicitStandardRequestMode && !characterWorkbench) {
      const variables = {
        model: gm.modelId,
        prompt,
        imageSize,
        imageQuality,
        imageBackground,
        aspectRatio,
        size: `${dimensions.width}x${dimensions.height}`,
        width: dimensions.width,
        height: dimensions.height,
        n: requestedCount,
        batchCount: requestedCount,
        imageUrls: providerDefinition?.id === 'toapis' ? toapisImageReferences(modelName, allImageUrls) : allImageUrls,
        ...(usesGoogleImageParts
          ? { googleImageParts: buildGoogleImageParts(prompt, allImageUrls) } : {}),
      };
      const urls = await runConfiguredModelProtocol({
        model: { ...gm,
          executionProfile: libapiExecutionProfile ?? relayonExecutionProfile ?? aigcsiExecutionProfile ?? executionProfile,
          imageCapability: configuredCapability },
        category: 'image',
        nodeId: params.nodeId,
        signal,
        beforeSubmit,
        ...(outputsPerJob > 1 ? { expectedImageOutputs: outputsPerJob } : {}),
        variables: usesLibapiProtocol ? libapiImageVariables(modelName, variables)
          : usesRelayonProtocol ? relayonImageVariables(modelName, variables) : variables,
      });
      const results = (outputsPerJob > 1 ? urls : urls.slice(0, requestedCount)).map((url) => ({ url, ...dimensions,
        ...(urls.taskReceipt ? { taskReceipt: urls.taskReceipt } : {}),
        ...(urls.mediaDownloadAccess ? { mediaDownloadAccess: urls.mediaDownloadAccess } : {}) }));
      if (results.length === 0) throw new Error('图片生成返回结果为空');
      return {
        requestedCount,
        ...(outputsPerJob > 1 ? { expectedOutputCount: outputsPerJob } : {}),
        results,
        failedCount: Math.max(0, requestedCount * outputsPerJob - results.length),
        ...(urls.mediaDownloadAccess ? { mediaDownloadAccess: urls.mediaDownloadAccess } : {}),
        ...(urls.taskReceipt ? { taskReceipt: urls.taskReceipt, allTasksSettled: true } : {}),
      };
    }
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
      const dimensions = resolveImageTemplateDimensions(parameterCapability ?? configuredCapability, imageSize, aspectRatio);
      const batch = await generateImageStandardBatch({
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl,
        modelName: gm.modelId,
        prompt,
        dimensions,
        imageQuality,
        imageBackground,
        imageUrls: allImageUrls,
        imageReferenceRequestMode,
        ...(params.characterPaintMask ? { characterPaintMask: params.characterPaintMask } : {}),
        providerConfigId: connection.providerConfigId, nodeId: params.nodeId, modelRef: `general/${gm.id}`, beforeSubmit,
        ...(characterWorkbench && !characterGuard ? { characterStandalone: true } : {}),
        ...(providerDefinition?.id === 'cccapi' ? { asyncTaskProvider: 'cccapi' as const,
          providerConfigId: connection.providerConfigId, nodeId: params.nodeId } : {}),
      }, requestedCount, signal);
      return characterWorkbench ? batch : retainStandardImageDelivery(batch, connection.providerConfigId, connection.baseUrl, params.nodeId, submissionProjectId);
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
        beforeSubmit,
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
      const batch = await generateImageStandardBatch({
        apiKey,
        baseUrl,
        modelName,
        prompt,
        dimensions,
        imageQuality,
        imageBackground,
        imageUrls: allImageUrls,
        imageReferenceRequestMode,
        providerConfigId: provider, nodeId: params.nodeId, modelRef: `${provider}/${modelName}`, beforeSubmit,
        ...(characterWorkbench && !characterGuard ? { characterStandalone: true } : {}),
        ...(providerDefinition?.id === 'cccapi' ? { asyncTaskProvider: 'cccapi' as const,
          providerConfigId: provider, nodeId: params.nodeId } : {}),
      }, requestedCount, signal);
      return characterWorkbench ? batch : retainStandardImageDelivery(batch, provider, baseUrl, params.nodeId, submissionProjectId);
    }
  }
}
