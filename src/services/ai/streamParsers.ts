/**
 * streamParsers — SSE / NDJSON / UTF-8 分片解析器
 *
 * 将 ReadableStream<Uint8Array> 的 fetch body 转换为
 * AsyncGenerator<AssistantStreamEvent>，供 ChatPanel 逐 token 消费。
 *
 * 支持：
 * - 标准 SSE (data: ...\n\n)
 * - OpenAI 兼容的 SSE 事件类型
 * - UTF-8 多字节字符的跨 chunk 拼接
 */
import type { AssistantStreamEvent, FinishReason } from '../../types/chat';
import type { ChatApiProtocol } from '../../types';
import {
  parseChatApiResponse,
  readChatApiErrorMessage,
  resolveChatApiProtocol,
} from './chatApiProtocol';

// ============================================
// SSE line decoder
// ============================================

/**
 * 处理跨 chunk 的 UTF-8 多字节边界。
 * 返回 { lines, remainder }：remainder 会被拼接到下一批 bytes 前方。
 */
function decodeUtf8Lines(
  bytes: Uint8Array,
  prevRemainder: string,
  decoder: TextDecoder,
): { lines: string[]; remainder: string } {
  const text = prevRemainder + decoder.decode(bytes, { stream: true });

  // 按 \n 分割，最后一行可能不完整
  const raw = text.split('\n');
  if (text.endsWith('\n')) {
    // split 会在末尾多生成一个空字符串；移除它，但必须保留前一个空行，
    // 因为该空行是 SSE 的事件边界（data: ...\n\n）。
    raw.pop();
    return { lines: raw, remainder: '' };
  }

  // 移除最后一行作为 remainder
  const remainder = raw.pop() ?? '';
  return { lines: raw, remainder };
}

// ============================================
// SSE event parser
// ============================================

interface SseEvent {
  event?: string;
  data: string;
}

function parseSseEvent(lines: string[]): SseEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventName = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6));
    } else if (line === 'data:[DONE]' || line === 'data: [DONE]') {
      return { event: 'done', data: '[DONE]' };
    }
  }

  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join('\n') };
}

// ============================================
// OpenAI SSE chunk → AssistantStreamEvent
// ============================================

interface OpenAiChunk {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: OpenAiToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface BufferedToolCall {
  callId: string;
  toolId: string;
  argumentsJson: string;
}

interface AnthropicToolCallBuffer extends BufferedToolCall {
  initialInput?: unknown;
  finalized?: boolean;
}

class ProviderStreamPayloadError extends Error {}

function parseOpenAiChunk(json: OpenAiChunk, requestId: string, modelId: string): AssistantStreamEvent[] {
  const events: AssistantStreamEvent[] = [];

  // first chunk → start event
  if (json.object === 'chat.completion.chunk' && json.choices?.[0]?.delta?.role) {
    events.push({ type: 'start', requestId, modelId });
  }

  // text delta
  const content = json.choices?.[0]?.delta?.content;
  if (content) {
    events.push({ type: 'text.delta', delta: content });
  }

  // finish reason
  const finishReason = json.choices?.[0]?.finish_reason;
  if (finishReason) {
    events.push({
      type: 'done',
      finishReason: mapFinishReason(finishReason),
    });
  }

  // usage
  if (json.usage) {
    events.push({
      type: 'usage',
      inputTokens: json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
    });
  }

  return events;
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool_calls': return 'stop';
    default: return 'stop';
  }
}

// ============================================
// Public API
// ============================================

export interface StreamParserOptions {
  requestId: string;
  modelId: string;
  onEvent: (event: AssistantStreamEvent) => void;
  signal?: AbortSignal;
  /** 缺省保持 OpenAI SSE 兼容。 */
  protocol?: ChatApiProtocol;
}

/**
 * 将 fetch Response.body 管道化为 AssistantStreamEvent 回调。
 *
 * @returns 完整文本内容（所有 delta 拼接结果）
 */
export async function parseStream(
  response: Response,
  options: StreamParserOptions,
): Promise<string> {
  const { onEvent, signal } = options;
  const protocol = resolveChatApiProtocol(options.protocol);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let errorMsg = `请求失败 (${response.status})`;
    try {
      errorMsg = readChatApiErrorMessage(JSON.parse(errorBody)) || errorMsg;
    } catch { /* ignore */ }
    onEvent({ type: 'error', code: 'HTTP_ERROR', message: errorMsg, retryable: response.status >= 500 });
    onEvent({ type: 'done', finishReason: 'error' });
    throw new Error(errorMsg);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    onEvent({ type: 'error', code: 'NO_BODY', message: '响应体为空', retryable: false });
    onEvent({ type: 'done', finishReason: 'error' });
    throw new Error('响应体为空');
  }

  let fullContent = '';
  let doneSent = false;
  let toolCallsFinalized = false;
  const toolCallBuffer = new Map<number, BufferedToolCall>();
  const anthropicToolCallBuffer = new Map<number, AnthropicToolCallBuffer>();
  const geminiToolCalls = new Set<string>();
  let nativeInputTokens: number | undefined;
  let nativeOutputTokens: number | undefined;
  let nativeUsageSent = false;
  let nativeFinishReason: FinishReason = 'stop';

  // SSE buffer
  let sseLines: string[] = [];
  let remainder = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });

  const consumeToolCallDeltas = (json: OpenAiChunk) => {
    for (const delta of json.choices?.[0]?.delta?.tool_calls ?? []) {
      const index = delta.index ?? 0;
      const current = toolCallBuffer.get(index) ?? {
        callId: delta.id || `tool-${options.requestId}-${index}`,
        toolId: delta.function?.name || '',
        argumentsJson: '',
      };
      if (delta.id) current.callId = delta.id;
      if (delta.function?.name) current.toolId = delta.function.name;
      if (delta.function?.arguments) {
        current.argumentsJson += delta.function.arguments;
        onEvent({
          type: 'tool.call.delta',
          callId: current.callId,
          delta: delta.function.arguments,
        });
      }
      toolCallBuffer.set(index, current);
    }
  };

  const finalizeToolCalls = () => {
    if (toolCallsFinalized) return;
    toolCallsFinalized = true;
    for (const call of toolCallBuffer.values()) {
      if (!call.toolId || !call.argumentsJson) continue;
      try {
        const input = JSON.parse(call.argumentsJson) as unknown;
        onEvent({
          type: 'tool.call.final',
          call: { callId: call.callId, toolId: call.toolId, input },
        });
      } catch {
        // 不完整或非法 JSON 不能进入工具执行层。
      }
    }
  };

  const emitText = (delta: string) => {
    if (!delta) return;
    fullContent += delta;
    onEvent({ type: 'text.delta', delta });
  };

  const emitNativeUsage = () => {
    if (nativeUsageSent || (nativeInputTokens === undefined && nativeOutputTokens === undefined)) return;
    nativeUsageSent = true;
    onEvent({ type: 'usage', inputTokens: nativeInputTokens, outputTokens: nativeOutputTokens });
  };

  const finalizeAnthropicToolCall = (index: number) => {
    const call = anthropicToolCallBuffer.get(index);
    if (!call || call.finalized || !call.toolId) return;
    let input: unknown = call.initialInput ?? {};
    if (call.argumentsJson) {
      try {
        input = JSON.parse(call.argumentsJson) as unknown;
      } catch {
        return;
      }
    }
    call.finalized = true;
    onEvent({
      type: 'tool.call.final',
      call: { callId: call.callId, toolId: call.toolId, input },
    });
  };

  const finalizeAnthropicToolCalls = () => {
    for (const index of anthropicToolCallBuffer.keys()) finalizeAnthropicToolCall(index);
  };

  const processAnthropicEvent = (payload: Record<string, unknown>) => {
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type === 'error') {
      throw new ProviderStreamPayloadError(
        readChatApiErrorMessage(payload) || 'Anthropic 流式请求失败',
      );
    }
    if (type === 'message_start') {
      const message = payload.message && typeof payload.message === 'object'
        ? payload.message as Record<string, unknown>
        : {};
      const usage = message.usage && typeof message.usage === 'object'
        ? message.usage as Record<string, unknown>
        : {};
      if (typeof usage.input_tokens === 'number') nativeInputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === 'number') nativeOutputTokens = usage.output_tokens;
      return;
    }
    if (type === 'content_block_start') {
      const index = typeof payload.index === 'number' ? payload.index : 0;
      const block = payload.content_block && typeof payload.content_block === 'object'
        ? payload.content_block as Record<string, unknown>
        : {};
      if (block.type === 'text' && typeof block.text === 'string') emitText(block.text);
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        anthropicToolCallBuffer.set(index, {
          callId: typeof block.id === 'string' ? block.id : `tool-${options.requestId}-${index}`,
          toolId: block.name,
          argumentsJson: '',
          initialInput: block.input,
        });
      }
      return;
    }
    if (type === 'content_block_delta') {
      const index = typeof payload.index === 'number' ? payload.index : 0;
      const delta = payload.delta && typeof payload.delta === 'object'
        ? payload.delta as Record<string, unknown>
        : {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') emitText(delta.text);
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const current = anthropicToolCallBuffer.get(index) ?? {
          callId: `tool-${options.requestId}-${index}`,
          toolId: '',
          argumentsJson: '',
        };
        current.argumentsJson += delta.partial_json;
        anthropicToolCallBuffer.set(index, current);
        onEvent({ type: 'tool.call.delta', callId: current.callId, delta: delta.partial_json });
      }
      return;
    }
    if (type === 'content_block_stop') {
      finalizeAnthropicToolCall(typeof payload.index === 'number' ? payload.index : 0);
      return;
    }
    if (type === 'message_delta') {
      const usage = payload.usage && typeof payload.usage === 'object'
        ? payload.usage as Record<string, unknown>
        : {};
      if (typeof usage.output_tokens === 'number') nativeOutputTokens = usage.output_tokens;
      const delta = payload.delta && typeof payload.delta === 'object'
        ? payload.delta as Record<string, unknown>
        : {};
      if (delta.stop_reason === 'max_tokens') nativeFinishReason = 'length';
      return;
    }
    if (type === 'message_stop') {
      finalizeAnthropicToolCalls();
      emitNativeUsage();
    }
  };

  const processGeminiEvent = (payload: Record<string, unknown>) => {
    if (payload.error) {
      throw new ProviderStreamPayloadError(
        readChatApiErrorMessage(payload) || 'Gemini 流式请求失败',
      );
    }
    const usage = payload.usageMetadata && typeof payload.usageMetadata === 'object'
      ? payload.usageMetadata as Record<string, unknown>
      : {};
    if (typeof usage.promptTokenCount === 'number') nativeInputTokens = usage.promptTokenCount;
    if (typeof usage.candidatesTokenCount === 'number') nativeOutputTokens = usage.candidatesTokenCount;
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const first = candidates[0] && typeof candidates[0] === 'object'
      ? candidates[0] as Record<string, unknown>
      : {};
    const content = first.content && typeof first.content === 'object'
      ? first.content as Record<string, unknown>
      : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const [index, item] of parts.entries()) {
      if (!item || typeof item !== 'object') continue;
      const part = item as Record<string, unknown>;
      if (typeof part.text === 'string') emitText(part.text);
      const call = part.functionCall && typeof part.functionCall === 'object'
        ? part.functionCall as Record<string, unknown>
        : undefined;
      if (!call || typeof call.name !== 'string') continue;
      const callId = typeof call.id === 'string'
        ? call.id
        : `tool-${options.requestId}-${index}-${call.name}`;
      const signature = `${callId}:${JSON.stringify(call.args ?? {})}`;
      if (geminiToolCalls.has(signature)) continue;
      geminiToolCalls.add(signature);
      const argumentsJson = JSON.stringify(call.args ?? {});
      onEvent({ type: 'tool.call.delta', callId, delta: argumentsJson });
      onEvent({
        type: 'tool.call.final',
        call: { callId, toolId: call.name, input: call.args ?? {} },
      });
    }
    if (first.finishReason === 'MAX_TOKENS') nativeFinishReason = 'length';
    if (typeof first.finishReason === 'string') emitNativeUsage();
  };

  const sendDoneIfNeeded = () => {
    if (!doneSent) {
      if (protocol === 'openai-compatible') finalizeToolCalls();
      else {
        if (protocol === 'anthropic-compatible') finalizeAnthropicToolCalls();
        emitNativeUsage();
      }
      doneSent = true;
      onEvent({ type: 'done', finishReason: nativeFinishReason });
    }
  };

  try {
    while (true) {
      // Check abort signal
      if (signal?.aborted) {
        onEvent({ type: 'done', finishReason: 'canceled' });
        doneSent = true;
        break;
      }

      const { done, value } = await reader.read();
      if (done) {
        sendDoneIfNeeded();
        break;
      }

      if (!value) continue;

      const { lines, remainder: newRemainder } = decodeUtf8Lines(value, remainder, decoder);
      remainder = newRemainder;

      for (const line of lines) {
        // Trim \r
        const trimmed = line.trimEnd();
        if (trimmed === '') {
          // Empty line = SSE event boundary for standard SSE
          if (sseLines.length > 0) {
            const event = parseSseEvent(sseLines);
            sseLines = [];
            if (event) {
              if (event.data === '[DONE]') {
                sendDoneIfNeeded();
                break;
              }
              try {
                if (protocol === 'anthropic-compatible') {
                  const json = JSON.parse(event.data) as Record<string, unknown>;
                  processAnthropicEvent(json);
                  if (json.type === 'message_stop') sendDoneIfNeeded();
                } else if (protocol === 'gemini-native') {
                  const json = JSON.parse(event.data) as Record<string, unknown>;
                  processGeminiEvent(json);
                  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
                  const first = candidates[0] && typeof candidates[0] === 'object'
                    ? candidates[0] as Record<string, unknown>
                    : {};
                  if (typeof first.finishReason === 'string') sendDoneIfNeeded();
                } else {
                  const json = JSON.parse(event.data) as OpenAiChunk;
                  consumeToolCallDeltas(json);
                  const events = parseOpenAiChunk(json, options.requestId, options.modelId);
                  for (const ev of events) {
                    if (ev.type === 'done') {
                      finalizeToolCalls();
                      doneSent = true;
                    }
                    if (ev.type === 'text.delta') fullContent += ev.delta;
                    onEvent(ev);
                  }
                }
              } catch (error) {
                if (error instanceof ProviderStreamPayloadError) throw error;
                // JSON parse error on non-JSON SSE line → skip silently
              }
            }
          }
          continue;
        }

        sseLines.push(trimmed);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullContent;
}

/**
 * 简单的非流式文本提取（fallback：当模型不支持 stream 时使用）。
 */
export async function parseNonStream(
  response: Response,
  options: Pick<StreamParserOptions, 'onEvent' | 'signal' | 'protocol'>,
): Promise<string> {
  const { onEvent } = options;

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let errorMsg = `请求失败 (${response.status})`;
    try {
      errorMsg = readChatApiErrorMessage(JSON.parse(errorBody)) || errorMsg;
    } catch { /* ignore */ }
    onEvent({ type: 'error', code: 'HTTP_ERROR', message: errorMsg, retryable: response.status >= 500 });
    onEvent({ type: 'done', finishReason: 'error' });
    throw new Error(errorMsg);
  }

  const parsed = parseChatApiResponse(await response.json(), options.protocol);
  for (const call of parsed.toolCalls) onEvent({ type: 'tool.call.final', call });
  if (parsed.inputTokens !== undefined || parsed.outputTokens !== undefined) {
    onEvent({
      type: 'usage',
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    });
  }
  onEvent({ type: 'done', finishReason: parsed.finishReason });
  return parsed.text;
}
