/**
 * 连接级对话 API 协议适配。
 *
 * 应用内部继续使用 OpenAI 风格的 messages / tools；只有在可信边界处才转换为
 * Anthropic Messages 或 Gemini generateContent，避免 Agent Runtime 和画布业务分叉。
 */
import type { ChatApiProtocol } from '../../types';

export const DEFAULT_CHAT_API_PROTOCOL: ChatApiProtocol = 'openai-compatible';

export const CHAT_API_PROTOCOL_LABELS: Record<ChatApiProtocol, string> = {
  'openai-compatible': 'OpenAI 兼容',
  'anthropic-compatible': 'Anthropic 兼容',
  'gemini-native': 'Gemini 原生',
};

export function isChatApiProtocol(value: unknown): value is ChatApiProtocol {
  return value === 'openai-compatible'
    || value === 'anthropic-compatible'
    || value === 'gemini-native';
}

export function resolveChatApiProtocol(value: unknown): ChatApiProtocol {
  return isChatApiProtocol(value) ? value : DEFAULT_CHAT_API_PROTOCOL;
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
  signal?: AbortSignal;
}

export interface ParsedChatApiToolCall {
  callId: string;
  toolId: string;
  input: unknown;
}

export interface ParsedChatApiResponse {
  text: string;
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
    max_tokens: 4096,
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
  if (protocol === 'anthropic-compatible') {
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
      text: readTextParts(parts),
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
