/**
 * ai/generateText — 文本生成入口
 */
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import type { AIGenerateParams, ProtocolJsonValue } from '../../types/aiTypes';
import {
  extractModelName,
  parseGeneralTextResponse,
  resolveGeneralModel,
  resolveGeneralModelConnection,
} from './helpers';
import { parseResponseError } from './httpUtils';
import { corsSafeFetch } from './httpTransport';
import { resolvePromptToChatContent } from './promptResolver';
import { resolveChatContentImageDataUrls } from './imageUtils';
import { executeModelProtocol, resolveModelExecutionProfile } from './modelProtocol';
import {
  buildChatApiRequest,
  parseChatApiResponse,
  resolveChatApiProtocol,
  type ChatApiMessage,
} from './chatApiProtocol';
import type { ChatApiProtocol } from '../../types';

// aiService 内部仍保留 runninghubwf 的默认 URL
(DEFAULT_BASE_URLS as Record<string, string>).runninghubwf = 'https://api.runninghub.cn';

export async function generateText(params: AIGenerateParams): Promise<string> {
  const { prompt: rawPrompt, model, provider } = params;

  const config = useAppStore.getState().config;

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

  if (generalModel?.executionProfile) {
    const protocol = resolveModelExecutionProfile(generalModel.executionProfile);
    if (!protocol) throw new Error(`通用模型 "${generalModel.name}" 未配置调用协议`);
    const result = await executeModelProtocol({
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
    return result.text;
  }

  // 未配置模型级协议时按连接协议执行；旧连接缺省仍是 OpenAI Chat Completions。
  const request = buildChatApiRequest({
    protocol: chatApiProtocol,
    apiKey,
    baseUrl,
    model: modelName,
    messages,
    stream: false,
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
  return replyText;
}
