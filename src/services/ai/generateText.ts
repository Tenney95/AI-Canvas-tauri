/**
 * ai/generateText — 文本生成入口
 */
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import type { AIGenerateParams } from '../aiTypes';
import { extractModelName, resolveGeneralModel, parseGeneralTextResponse } from './helpers';
import { resolvePromptToChatContent } from './promptResolver';
import { resolveContentImageUrls } from './imageUtils';

// aiService 内部仍保留 runninghubwf 的默认 URL
(DEFAULT_BASE_URLS as Record<string, string>).runninghubwf = 'https://api.runninghub.cn';

export async function generateText(params: AIGenerateParams): Promise<string> {
  const { prompt: rawPrompt, model, provider } = params;

  const config = useAppStore.getState().config;

  let baseUrl: string;
  let apiKey: string;
  let modelName = '';

  // ── 通用模型 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    if (!gm.openaiUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    apiKey = gm.apiKey || '';
    baseUrl = gm.openaiUrl;
    modelName = gm.modelId;
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
  }

  if (!baseUrl) {
    throw new Error(`未配置 ${provider === 'general' ? resolveGeneralModel(model)?.name || '通用模型' : provider} 的服务地址\n请在「设置 → API Key」中添加`);
  }

  // 去掉末尾斜杠，拼接 /chat/completions
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  if (provider !== 'general') {
    modelName = extractModelName(model, provider);
  }

  // 解析 @{nodeId:label} 引用：图片节点构建 image_url，其他节点内联文本
  const { content, textContent } = await resolvePromptToChatContent(rawPrompt);
  if (!textContent.trim()) {
    throw new Error('提示词不能为空');
  }

  // 将本地图片 URL 上传到远端图床，转为公网 URL
  const resolvedContent = await resolveContentImageUrls(content);

  const messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [];
  messages.push({ role: 'user', content: resolvedContent });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // 不设超时（仅 ComfyUI 才设超时）
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelName,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let errorMsg = `API 请求失败 (${response.status})`;
    try {
      const err = JSON.parse(errorBody);
      errorMsg = err.error?.message || errorMsg;
    } catch {
      if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
    }
    throw new Error(errorMsg);
  }

  const json = await response.json();
  // 通用模型使用灵活的响应解析
  const replyText = provider === 'general'
    ? parseGeneralTextResponse(json)
    : (json.choices?.[0]?.message?.content);
  if (!replyText) {
    throw new Error('模型返回结果为空');
  }
  return replyText;
}
