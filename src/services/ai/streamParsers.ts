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

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let errorMsg = `请求失败 (${response.status})`;
    try {
      const err = JSON.parse(errorBody);
      errorMsg = err.error?.message || errorMsg;
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

  const sendDoneIfNeeded = () => {
    if (!doneSent) {
      finalizeToolCalls();
      doneSent = true;
      onEvent({ type: 'done', finishReason: 'stop' });
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
                const json = JSON.parse(event.data) as OpenAiChunk;
                consumeToolCallDeltas(json);
                const events = parseOpenAiChunk(json, options.requestId, options.modelId);
                for (const ev of events) {
                  if (ev.type === 'done') {
                    finalizeToolCalls();
                    doneSent = true;
                  }
                  if (ev.type === 'text.delta') {
                    fullContent += ev.delta;
                  }
                  onEvent(ev);
                }
              } catch {
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
  options: Pick<StreamParserOptions, 'onEvent' | 'signal'>,
): Promise<string> {
  const { onEvent } = options;

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let errorMsg = `请求失败 (${response.status})`;
    try {
      const err = JSON.parse(errorBody);
      errorMsg = err.error?.message || errorMsg;
    } catch { /* ignore */ }
    onEvent({ type: 'error', code: 'HTTP_ERROR', message: errorMsg, retryable: response.status >= 500 });
    onEvent({ type: 'done', finishReason: 'error' });
    throw new Error(errorMsg);
  }

  const json = await response.json() as Record<string, unknown>;
  const choices = json.choices as Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }> | undefined;
  const content = choices?.[0]?.message?.content || '';

  for (const [index, call] of (choices?.[0]?.message?.tool_calls ?? []).entries()) {
    const toolId = call.function?.name;
    const argumentsJson = call.function?.arguments;
    if (!toolId || !argumentsJson) continue;
    try {
      onEvent({
        type: 'tool.call.final',
        call: {
          callId: call.id || `tool-non-stream-${index}`,
          toolId,
          input: JSON.parse(argumentsJson) as unknown,
        },
      });
    } catch {
      // 非法参数不会触发工具。
    }
  }

  // usage
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (usage) {
    onEvent({ type: 'usage', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
  }

  onEvent({ type: 'done', finishReason: 'stop' });
  return typeof content === 'string' ? content : '';
}
