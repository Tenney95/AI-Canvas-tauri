/**
 * ai/generateText — 文本生成入口
 */
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import type { AIGenerateParams, ProtocolJsonValue, TextGenerationResult } from '../../types/aiTypes';
import {
  extractModelName,
  parseGeneralTextResponse,
  resolveGeneralModel,
  resolveGeneralModelConnection,
} from './helpers';
import { parseResponseError } from './httpUtils';
import { corsSafeFetch } from './httpTransport';
import { resolvePromptToChatContent, resolvePromptWithMediaRefs } from './promptResolver';
import { resolveChatContentImageDataUrls } from './imageUtils';
import { collectConnectedReferenceMedia, getMediaReferenceUrls, mergeMediaReferences } from './connectedReferenceMedia';
import { executeModelProtocol, resolveModelExecutionProfile } from './modelProtocol';
import {
  buildChatApiRequest,
  parseChatApiResponse,
  resolveChatApiProtocol,
  resolveNativeTextChatProtocol,
  type ChatApiMessage,
} from './chatApiProtocol';
import type { ChatApiProtocol } from '../../types';

// aiService 内部仍保留 runninghubwf 的默认 URL
(DEFAULT_BASE_URLS as Record<string, string>).runninghubwf = 'https://api.runninghub.cn';

export async function generateText(params: AIGenerateParams): Promise<string> {
  return (await generateTextResult(params)).text;
}

/** 节点交付入口保留 ComfyUI 回执；普通文本消费者仍使用 generateText。 */
export async function generateTextResult(params: AIGenerateParams): Promise<TextGenerationResult> {
  params.signal?.throwIfAborted();
  const { prompt: rawPrompt, model, provider } = params;
  const config = useAppStore.getState().config;

  if (provider === 'muse') {
    const { MUSE_TEXT_MODEL } = await import('./museModels');
    if (!config.providers.muse || (config.providers.muse.catalogId ?? 'muse') !== 'muse'
      || model.replace(/^muse\//, '') !== MUSE_TEXT_MODEL) throw new Error('请在 API Key 设置中启用 Muse 对话模型');
    if (params.workflowId) throw new Error('Muse 文本模型不能作为本地工作流执行');
    const source = useAppStore.getState(), sourceRevision = source.getCurrentRevision();
    const sourceNode = source.nodes.find((node) => node.id === params.nodeId);
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      if (!params.nodeId) return;
      const current = useAppStore.getState();
      if (current.currentProjectId !== source.currentProjectId || current.getCurrentRevision() !== sourceRevision
        || !sourceNode || !current.nodes.some((node) => node.id === params.nodeId && node.data.type === sourceNode.data.type)) {
        throw new Error('原文本节点或输入已变化，未继续发送 Muse 请求');
      }
    };
    const media = await resolvePromptWithMediaRefs(rawPrompt);
    assertCurrent();
    const references = mergeMediaReferences(media.references, collectConnectedReferenceMedia(params.nodeId).references);
    if (references.some((reference) => reference.kind !== 'image')) throw new Error('Muse 文本问答仅支持文本与图片，不支持视频或音频引用');
    const images = [...new Set([...getMediaReferenceUrls(references, 'image', 'local'), ...(params.imageUrls ?? [])])];
    const { streamMuseText } = await import('./museTextService');
    return { text: await streamMuseText({ messages: [{ role: 'user', content: [
      { type: 'text', text: media.prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ] }], signal: params.signal, assertCurrent }) };
  }

  if (provider === 'comfyui' && (params.workflowId || !config.providers[provider])) {
    const sourceState = useAppStore.getState();
    const sourceRevision = sourceState.getCurrentRevision();
    const workflowId = params.workflowId ?? (model.startsWith('comfyui/') && model !== 'comfyui/workflow'
      ? model.slice('comfyui/'.length) : undefined);
    const workflow = sourceState.workflows.find((item) => item.id === workflowId);
    const assertSourceCurrent = () => {
      params.signal?.throwIfAborted();
      const current = useAppStore.getState();
      if (current.currentProjectId !== sourceState.currentProjectId || current.getCurrentRevision() !== sourceRevision
        || current.workflows.find((item) => item.id === workflowId) !== workflow
        || (params.nodeId && !current.nodes.some((node) => node.id === params.nodeId && node.data.type === 'ai-text'))) {
        throw new Error('画布或文本输入已变化，未提交 ComfyUI 任务');
      }
    };
    if (!workflow || (workflow.adapterType && workflow.adapterType !== 'comfyui') || workflow.category !== 'ai-text') {
      throw new Error('请先导入并选择本地 ComfyUI 文本工作流');
    }
    const media = await resolvePromptWithMediaRefs(rawPrompt);
    assertSourceCurrent();
    const references = mergeMediaReferences(media.references, collectConnectedReferenceMedia(params.nodeId).references);
    const { executeComfyUITextGenerate } = await import('../comfyWorkflowService');
    assertSourceCurrent();
    return executeComfyUITextGenerate({ ...params, workflowId, prompt: media.prompt }, params.signal,
      [...new Set([...getMediaReferenceUrls(references, 'image', 'local'), ...(params.imageUrls ?? [])])], {
        videoUrls: getMediaReferenceUrls(references, 'video', 'local'),
        audioUrls: getMediaReferenceUrls(references, 'audio', 'local'),
      });
  }

  let baseUrl: string;
  let apiKey: string;
  let modelName = '';
  let generalModel: ReturnType<typeof resolveGeneralModel> = undefined;
  let chatApiProtocol: ChatApiProtocol;

  // ── 通用模型 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    const connection = resolveGeneralModelConnection(model);
    if (!connection) throw new Error(`通用模型 "${gm.name}" 的连接配置不存在`);
    if (!connection.baseUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    apiKey = connection.apiKey;
    baseUrl = connection.baseUrl;
    modelName = gm.modelId;
    generalModel = gm;
    chatApiProtocol = resolveChatApiProtocol(connection.provider.chatApiProtocol);
  } else if (provider === 'localllm') {
    // 已合并到通用模型，此处保留兼容旧数据
    throw new Error('本地大模型已迁移到「通用模型」，请重新选择模型\n请在「设置 → API Key」中添加通用模型');
  } else {
    const providerConfig = config.providers[provider];
    apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error(`未配置 ${provider} 的 API Key\n请在「设置 → API Key」中配置`);
    }
    baseUrl = providerConfig?.baseUrl || DEFAULT_BASE_URLS[provider] || '';
    chatApiProtocol = resolveChatApiProtocol(providerConfig?.chatApiProtocol);
  }

  if (!baseUrl) {
    throw new Error(`未配置 ${provider === 'general' ? resolveGeneralModel(model)?.name || '通用模型' : provider} 的服务地址\n请在「设置 → API Key」中添加`);
  }

  if (provider !== 'general') {
    modelName = extractModelName(model, provider);
  }

  // 解析 @{nodeId:label} 引用：图片节点构建 image_url，其他节点内联文本
  const { content, textContent } = await resolvePromptToChatContent(rawPrompt);
  if (!textContent.trim()) {
    throw new Error('提示词不能为空');
  }

  // 调用方直接给的图片（截帧、节点自身产物等）接在 @ 引用之后
  const contentWithImages = params.imageUrls?.length
    ? [
        ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content),
        ...params.imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
    : content;

  // 文本/VLM 请求使用 OpenAI 兼容的 Base64 data URL，不经第三方图床泄露视觉素材。
  const resolvedContent = await resolveChatContentImageDataUrls(contentWithImages);

  const messages: ChatApiMessage[] = [];
  messages.push({ role: 'user', content: resolvedContent });

  const nativeTextProtocol = resolveNativeTextChatProtocol(generalModel?.executionProfile);
  if (nativeTextProtocol) chatApiProtocol = nativeTextProtocol;
  if (generalModel?.executionProfile && !nativeTextProtocol) {
    const protocol = resolveModelExecutionProfile(generalModel.executionProfile);
    if (!protocol) throw new Error(`通用模型 "${generalModel.name}" 未配置调用协议`);
    const result = await executeModelProtocol({
      signal: params.signal,
      apiKey,
      baseUrl,
      protocol,
      variables: {
        model: modelName,
        prompt: textContent,
        messages: messages as unknown as ProtocolJsonValue,
        stream: false,
      },
    });
    if (!result.text) throw new Error('模型返回结果为空');
    return { text: result.text };
  }

  // 未配置模型级协议时按连接协议执行；旧连接缺省仍是 OpenAI Chat Completions。
  const request = buildChatApiRequest({
    protocol: chatApiProtocol,
    apiKey,
    baseUrl,
    model: modelName,
    messages,
    stream: false,
    signal: params.signal,
  });
  // 不设超时（仅 ComfyUI 才设超时）
  const response = await corsSafeFetch(request.url, request.init);

  if (!response.ok) {
    await parseResponseError(response, `API 请求失败 (${response.status})`);
  }

  const json = await response.json();
  const parsed = parseChatApiResponse(json, chatApiProtocol);
  // OpenAI 兼容通用模型保留既有宽松响应提取，原生协议只接受各自规范结构。
  const replyText = parsed.text || (
    provider === 'general' && chatApiProtocol === 'openai-compatible'
      ? parseGeneralTextResponse(json)
      : ''
  );
  if (!replyText) {
    throw new Error('模型返回结果为空');
  }
  return { text: replyText };
}
