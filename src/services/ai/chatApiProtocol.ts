/**
 * 连接级对话 API 协议适配。
 *
 * 应用内部继续使用 OpenAI 风格的 messages / tools；只有在可信边界处才转换为
 * Responses、Anthropic Messages 或 Gemini generateContent，避免 Agent Runtime 和画布业务分叉。
 */
import { buildResponsesBody, parseResponsesResponse, RESPONSES_OUTPUT } from './responsesApiProtocol';
import { estimateTokens } from '../chat/tokenEstimate';
import type { TextModelContextSpec } from '../../components/nodes/shared/defaultModels';
import type { ChatApiProtocol } from '../../types';
import type { ModelExecutionProfile, ModelProtocolPresetId } from '../../types/aiTypes';

export const DEFAULT_CHAT_API_PROTOCOL: ChatApiProtocol = 'openai-compatible';

export const CHAT_API_PROTOCOL_LABELS: Record<ChatApiProtocol, string> = {
  'openai-compatible': 'OpenAI 兼容',
  'openai-responses': 'OpenAI Responses',
  'anthropic-compatible': 'Anthropic 兼容',
  'gemini-native': 'Gemini 原生',
};

export function isChatApiProtocol(value: unknown): value is ChatApiProtocol {
  return value === 'openai-compatible'
    || value === 'openai-responses'
    || value === 'anthropic-compatible'
    || value === 'gemini-native';
}

export function resolveChatApiProtocol(value: unknown): ChatApiProtocol {
  return isChatApiProtocol(value) ? value : DEFAULT_CHAT_API_PROTOCOL;
}

/** 模型级原生对话预设沿用已实现的消息、工具与流式适配器。 */
export function isNativeTextProtocolPreset(
  preset: string,
): preset is Extract<ModelProtocolPresetId, 'openai-responses' | 'anthropic-chat' | 'gemini-chat'> {
  return preset === 'openai-responses' || preset === 'anthropic-chat' || preset === 'gemini-chat';
}

export function resolveNativeTextChatProtocol(
  profile: ModelExecutionProfile | undefined,
  catalogId?: string,
): ChatApiProtocol | undefined {
  if (catalogId === 'magpie' && profile?.preset === 'openai-chat') return 'openai-compatible';
  if (profile?.preset === 'openai-responses') return 'openai-responses';
  if (profile?.preset === 'anthropic-chat') return 'anthropic-compatible';
  if (profile?.preset === 'gemini-chat') return 'gemini-native';
  return undefined;
}

export type ChatApiContent = string | Array<{
  type: string;
  text?: string;
  image_url?: { url: string };
}>;

export interface ChatApiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatApiContent;
  tool_call_id?: string;
  tool_calls?: ChatApiToolCall[];
  [RESPONSES_OUTPUT]?: Array<Record<string, unknown>>;
}

export interface ChatApiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface BuildChatApiRequestOptions {
  protocol?: ChatApiProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatApiMessage[];
  tools?: ChatApiToolDefinition[];
  stream: boolean;
  /** 当前调用协议已核实支持的输出限制。 */
  maxOutputTokens?: number;
  /** 仅在有明确本地预算时对装配后的正文做估算预检。 */
  estimatedInputTokenLimit?: number;
  signal?: AbortSignal;
}

export class ChatRequestBudgetError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXHAUSTED';

  constructor(message: string) {
    super(message);
    this.name = 'ChatRequestBudgetError';
  }
}

/** Magpie 的已验证文本端点按同一预算估算输入和限制输出。 */
export function getMagpieChatBudgetOptions(
  protocol: ChatApiProtocol,
  budget: TextModelContextSpec | undefined,
  outputDeclared: boolean,
): Pick<BuildChatApiRequestOptions, 'maxOutputTokens' | 'estimatedInputTokenLimit'> {
  if (!budget || protocol === 'gemini-native') return {};
  if (budget.outputBudget <= 0) throw new ChatRequestBudgetError('本轮上下文预算无法容纳输入和输出，请增大上下文窗口。');
  const requiresOutputLimit = protocol === 'anthropic-compatible';
  const outputReserve = requiresOutputLimit && !outputDeclared ? Math.min(4096, budget.outputBudget) : budget.outputBudget;
  return {
    ...(requiresOutputLimit || outputDeclared ? { maxOutputTokens: outputReserve } : {}),
    estimatedInputTokenLimit: budget.contextWindow - outputReserve,
  };
}

/** 网关转换图片后计量。估算正文时跳过传输用的 Base64/图片 URL。 */
function estimateChatRequestInput(body: Record<string, unknown>): number {
  let images = 0;
  const text = JSON.stringify(body, function (this: Record<string, unknown>, key, value: unknown) {
    if ((key === 'image_url' && (this.type === 'image_url' || this.type === 'input_image'))
      || (key === 'source' && this.type === 'image')
      || (key === 'inlineData' && value && typeof value === 'object'
        && 'mimeType' in value && typeof value.mimeType === 'string' && value.mimeType.startsWith('image/'))) {
      images += 1;
      return undefined;
    }
    return value;
  });
  return estimateTokens(text) + images * 4_096;
}

export interface ParsedChatApiToolCall {
  callId: string;
  toolId: string;
  input: unknown;
}

export interface ParsedChatApiResponse {
  text: string;
  reasoning?: string;
  toolCalls: ParsedChatApiToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  finishReason: 'stop' | 'length';
}

interface DataUrlImage {
  mimeType: string;
  data: string;
}

function parseDataUrlImage(url: string): DataUrlImage | null {
  const match = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)*;base64,([a-z0-9+/=\s]+)$/i.exec(url);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), data: match[2].replace(/\s/g, '') };
}

function contentText(content: ChatApiContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function buildOpenAiBody(options: BuildChatApiRequestOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: options.stream,
  };
  if (options.maxOutputTokens !== undefined) body.max_completion_tokens = options.maxOutputTokens;
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }
  return body;
}

function toAnthropicContent(content: ChatApiContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.flatMap<Record<string, unknown>>((part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return [{ type: 'text', text: part.text }];
    }
    if (part.type === 'image_url' && part.image_url?.url) {
      const image = parseDataUrlImage(part.image_url.url);
      if (!image) throw new Error('Anthropic 原生协议的图片输入必须是 Base64 data URL');
      return [{
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.data },
      }];
    }
    return [];
  });
}

function buildAnthropicBody(options: BuildChatApiRequestOptions): Record<string, unknown> {
  const system = options.messages
    .filter((message) => message.role === 'system')
    .map((message) => contentText(message.content))
    .filter(Boolean)
    .join('\n\n');
  const messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  const append = (role: 'user' | 'assistant', content: Array<Record<string, unknown>>) => {
    if (content.length === 0) return;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };

  for (const message of options.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Anthropic 工具结果缺少 tool_call_id');
      append('user', [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: toAnthropicContent(message.content),
      }]);
      continue;
    }
    const blocks = toAnthropicContent(message.content);
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
    }
    append(message.role, blocks);
  }

  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxOutputTokens ?? 4096,
    messages,
    stream: options.stream,
  };
  if (system) body.system = system;
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    body.tool_choice = { type: 'auto' };
  }
  return body;
}

function toGeminiParts(content: ChatApiContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  return content.flatMap<Record<string, unknown>>((part) => {
    if (part.type === 'text' && typeof part.text === 'string') return [{ text: part.text }];
    if (part.type === 'image_url' && part.image_url?.url) {
      const image = parseDataUrlImage(part.image_url.url);
      if (!image) throw new Error('Gemini 原生协议的图片输入必须是 Base64 data URL');
      return [{ inlineData: { mimeType: image.mimeType, data: image.data } }];
    }
    return [];
  });
}

function parseToolResultContent(content: ChatApiContent): Record<string, unknown> {
  const text = contentText(content);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { result: parsed };
  } catch {
    return { result: text };
  }
}

function buildGeminiBody(options: BuildChatApiRequestOptions): Record<string, unknown> {
  const systemText = options.messages
    .filter((message) => message.role === 'system')
    .map((message) => contentText(message.content))
    .filter(Boolean)
    .join('\n\n');
  const toolNames = new Map<string, string>();
  for (const message of options.messages) {
    for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
  }

  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  for (const message of options.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Gemini 工具结果缺少 tool_call_id');
      const name = toolNames.get(message.tool_call_id);
      if (!name) throw new Error(`Gemini 工具结果找不到对应调用：${message.tool_call_id}`);
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            id: message.tool_call_id,
            name,
            response: parseToolResultContent(message.content),
          },
        }],
      });
      continue;
    }
    const parts = toGeminiParts(message.content);
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        parts.push({
          functionCall: {
            id: call.id,
            name: call.function.name,
            args: parseToolArguments(call.function.arguments),
          },
        });
      }
    }
    if (parts.length > 0) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }

  const body: Record<string, unknown> = { contents };
  if (options.maxOutputTokens !== undefined) body.generationConfig = { maxOutputTokens: options.maxOutputTokens };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  if (options.tools?.length) {
    body.tools = [{
      functionDeclarations: options.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return body;
}

export function getChatApiHeaders(
  protocolValue: ChatApiProtocol | undefined,
  apiKey: string,
  includeContentType = true,
): Record<string, string> {
  const protocol = resolveChatApiProtocol(protocolValue);
  const headers: Record<string, string> = includeContentType ? { 'Content-Type': 'application/json' } : {};
  if (!apiKey) return headers;
  if (protocol === 'anthropic-compatible') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (protocol === 'gemini-native') {
    headers['x-goog-api-key'] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export function normalizeGeminiModelId(model: string): string {
  return model.trim().replace(/^models\//i, '');
}

export function buildChatApiRequest(options: BuildChatApiRequestOptions): { url: string; init: RequestInit } {
  const protocol = resolveChatApiProtocol(options.protocol);
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  let path: string;
  let body: Record<string, unknown>;
  if (protocol === 'openai-responses') {
    path = '/responses';
    body = buildResponsesBody(options);
  } else if (protocol === 'anthropic-compatible') {
    path = '/messages';
    body = buildAnthropicBody(options);
  } else if (protocol === 'gemini-native') {
    const action = options.stream ? 'streamGenerateContent' : 'generateContent';
    path = `/models/${encodeURIComponent(normalizeGeminiModelId(options.model))}:${action}`;
    if (options.stream) path += '?alt=sse';
    body = buildGeminiBody(options);
  } else {
    path = '/chat/completions';
    body = buildOpenAiBody(options);
  }
  if (options.estimatedInputTokenLimit !== undefined) {
    const estimated = estimateChatRequestInput(body);
    if (estimated > options.estimatedInputTokenLimit) {
      throw new ChatRequestBudgetError(`装配后的请求估算为 ${estimated} token，超过本轮输入预算 ${options.estimatedInputTokenLimit}。请减少上下文或附件，或选择更长上下文的模型。`);
    }
  }
  return {
    url: `${baseUrl}${path}`,
    init: {
      method: 'POST',
      headers: getChatApiHeaders(protocol, options.apiKey),
      body: JSON.stringify(body),
      signal: options.signal,
    },
  };
}

function readTextParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const record = part as Record<string, unknown>;
    return typeof record.text === 'string' ? [record.text] : [];
  }).join('');
}

function finishReason(value: unknown): 'stop' | 'length' {
  return value === 'length' || value === 'max_tokens' || value === 'MAX_TOKENS' ? 'length' : 'stop';
}

export function parseChatApiResponse(
  payload: unknown,
  protocolValue?: ChatApiProtocol,
): ParsedChatApiResponse {
  const protocol = resolveChatApiProtocol(protocolValue);
  if (protocol === 'openai-responses') return parseResponsesResponse(payload);
  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {};
  if (protocol === 'anthropic-compatible') {
    const content = Array.isArray(record.content) ? record.content : [];
    const toolCalls: ParsedChatApiToolCall[] = [];
    for (const [index, item] of content.entries()) {
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      toolCalls.push({
        callId: typeof block.id === 'string' ? block.id : `tool-anthropic-${index}`,
        toolId: block.name,
        input: block.input ?? {},
      });
    }
    const usage = record.usage && typeof record.usage === 'object'
      ? record.usage as Record<string, unknown>
      : {};
    return {
      text: content.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const block = item as Record<string, unknown>;
        return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
      }).join(''),
      reasoning: content.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const block = item as Record<string, unknown>;
        return block.type === 'thinking' && typeof block.thinking === 'string' ? [block.thinking] : [];
      }).join('') || undefined,
      toolCalls,
      inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
      finishReason: finishReason(record.stop_reason),
    };
  }

  if (protocol === 'gemini-native') {
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const first = candidates[0] && typeof candidates[0] === 'object'
      ? candidates[0] as Record<string, unknown>
      : {};
    const content = first.content && typeof first.content === 'object'
      ? first.content as Record<string, unknown>
      : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const toolCalls: ParsedChatApiToolCall[] = [];
    for (const [index, item] of parts.entries()) {
      if (!item || typeof item !== 'object') continue;
      const part = item as Record<string, unknown>;
      const call = part.functionCall && typeof part.functionCall === 'object'
        ? part.functionCall as Record<string, unknown>
        : undefined;
      if (!call || typeof call.name !== 'string') continue;
      toolCalls.push({
        callId: typeof call.id === 'string' ? call.id : `tool-gemini-${index}`,
        toolId: call.name,
        input: call.args ?? {},
      });
    }
    const usage = record.usageMetadata && typeof record.usageMetadata === 'object'
      ? record.usageMetadata as Record<string, unknown>
      : {};
    return {
      text: readTextParts(parts.filter((item) => !(item && typeof item === 'object' && (item as Record<string, unknown>).thought === true))),
      reasoning: readTextParts(parts.filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).thought === true)) || undefined,
      toolCalls,
      inputTokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : undefined,
      outputTokens: typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : undefined,
      finishReason: finishReason(first.finishReason),
    };
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] && typeof choices[0] === 'object'
    ? choices[0] as Record<string, unknown>
    : {};
  const message = first.message && typeof first.message === 'object'
    ? first.message as Record<string, unknown>
    : {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: ParsedChatApiToolCall[] = [];
  for (const [index, item] of calls.entries()) {
    if (!item || typeof item !== 'object') continue;
    const call = item as Record<string, unknown>;
    const fn = call.function && typeof call.function === 'object'
      ? call.function as Record<string, unknown>
      : {};
    if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') continue;
    try {
      toolCalls.push({
        callId: typeof call.id === 'string' ? call.id : `tool-openai-${index}`,
        toolId: fn.name,
        input: JSON.parse(fn.arguments) as unknown,
      });
    } catch {
      // 非法工具参数不能进入执行层。
    }
  }
  const usage = record.usage && typeof record.usage === 'object'
    ? record.usage as Record<string, unknown>
    : {};
  return {
    text: readTextParts(message.content),
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : typeof message.reasoning === 'string' ? message.reasoning : undefined,
    toolCalls,
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    finishReason: finishReason(first.finish_reason),
  };
}

export function readChatApiErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.error === 'string') return record.error;
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>;
    if (typeof error.message === 'string') return error.message;
  }
  return undefined;
}
