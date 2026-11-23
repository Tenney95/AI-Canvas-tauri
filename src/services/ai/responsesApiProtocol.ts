/** OpenAI Responses 原生适配；应用内部继续使用统一的消息与工具模型。 */
import type { AssistantStreamEvent } from '../../types/chat';
import type { BuildChatApiRequestOptions, ChatApiContent, ParsedChatApiResponse } from './chatApiProtocol';

/** 仅在当前任务的消息对象上传递，JSON 序列化不会写入聊天记录、日志或其他协议。 */
export const RESPONSES_OUTPUT = Symbol('responsesOutput');

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function contentParts(content: ChatApiContent): RecordValue[] {
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return parts.map((part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return { type: 'input_text', text: part.text };
    }
    if (part.type === 'image_url' && part.image_url?.url) {
      return { type: 'input_image', image_url: part.image_url.url, detail: 'auto' };
    }
    throw new Error('Responses 消息包含不支持的内容类型，未发送请求');
  });
}

export function buildResponsesBody(options: BuildChatApiRequestOptions): RecordValue {
  const input: RecordValue[] = [];
  for (const message of options.messages) {
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Responses 工具结果缺少 tool_call_id');
      input.push({
        type: 'function_call_output', call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : contentParts(message.content),
      });
      continue;
    }
    if (message.role === 'assistant' && message[RESPONSES_OUTPUT]?.length) {
      input.push(...message[RESPONSES_OUTPUT]);
      continue;
    }
    if (typeof message.content !== 'string' || message.content) {
      input.push({ role: message.role, content: contentParts(message.content) });
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  const body: RecordValue = {
    model: options.model, input, stream: options.stream,
    store: false, include: ['reasoning.encrypted_content'],
  };
  if (options.maxOutputTokens !== undefined) body.max_output_tokens = options.maxOutputTokens;
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function', name: tool.function.name, description: tool.function.description,
      parameters: tool.function.parameters,
      // 保持现有 Registry 的可选参数语义，不让 Responses 自动规范成严格 Schema。
      strict: false,
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

/** 保留原始顺序、call_id、推理密文和 assistant phase，仅供当前运行内继续工具轮次。 */
export function readResponsesContext(payload: unknown): RecordValue[] {
  const output = record(payload).output;
  if (!Array.isArray(output)) return [];
  return output.map(record).filter((item) =>
    item.type === 'function_call'
    || item.type === 'reasoning'
    || item.type === 'message' && item.role === 'assistant');
}

export function parseResponsesResponse(payload: unknown): ParsedChatApiResponse {
  const response = record(payload);
  const error = record(response.error);
  if (response.error || response.status === 'failed' || response.status === 'cancelled') {
    throw new Error(typeof error.message === 'string' ? error.message : 'Responses 请求失败或已取消');
  }
  const truncated = response.status === 'incomplete'
    && record(response.incomplete_details).reason === 'max_output_tokens';
  if (response.status !== 'completed' && !truncated) {
    throw new Error('Responses 响应尚未完成或已被中止');
  }
  const output = Array.isArray(response.output) ? response.output : [];
  let text = '';
  let reasoning = '';
  const toolCalls: ParsedChatApiResponse['toolCalls'] = [];
  for (const value of output) {
    const item = record(value);
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const value of item.content) {
        const part = record(value);
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
        if (part.type === 'refusal' && typeof part.refusal === 'string') text += part.refusal;
      }
    } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const value of item.summary) {
        const part = record(value);
        if (part.type === 'summary_text' && typeof part.text === 'string') reasoning += part.text;
      }
    } else if (item.type === 'function_call' && !truncated) {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string'
        || !item.name || typeof item.arguments !== 'string' || (item.status && item.status !== 'completed')) {
        throw new Error('Responses 工具调用缺少完整标识或参数');
      }
      let args: unknown;
      try { args = JSON.parse(item.arguments) as unknown; }
      catch { throw new Error('Responses 工具调用参数不是完整 JSON，未执行工具'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Responses 工具调用参数必须是 JSON 对象');
      }
      if (toolCalls.some((call) => call.callId === item.call_id)) throw new Error('Responses 工具调用 ID 重复');
      toolCalls.push({ callId: item.call_id, toolId: item.name, input: args });
    }
  }
  const usage = record(response.usage);
  return {
    text, reasoning: reasoning || undefined, toolCalls,
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
    finishReason: truncated ? 'length' : 'stop',
  };
}

interface ResponsesStreamOptions {
  onEvent: (event: AssistantStreamEvent) => void;
  signal?: AbortSignal;
}

/** 工具提案仅在收到成功终态后发布；EOF、取消、失败都不能提交缓冲的工具。 */
export async function parseResponsesStream(response: Response, options: ResponsesStreamOptions): Promise<string> {
  const { onEvent, signal } = options;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Responses 响应体为空');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let finished = false;
  const partText = new Map<string, string>();
  const callIds = new Map<string, string>();
  const pendingArguments = new Map<string, string[]>();
  const emitPart = (key: string, value: string, cumulative = false) => {
    const previous = partText.get(key) ?? '';
    if (cumulative && !value.startsWith(previous)) throw new Error('Responses 正文终态与流式增量不一致');
    const delta = cumulative ? value.slice(previous.length) : value;
    partText.set(key, cumulative ? value : previous + delta);
    if (delta) { text += delta; onEvent({ type: 'text.delta', delta }); }
  };
  const consume = (frame: string) => {
    if (signal?.aborted) return;
    const data = frame.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    const event = record(JSON.parse(data));
    if (event.type === 'error' || event.type === 'response.failed') {
      const error = record(record(event.response).error);
      throw new Error(typeof event.message === 'string' ? event.message
        : typeof error.message === 'string' ? error.message : 'Responses 流式请求失败');
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta === 'string') emitPart(`${event.output_index}:${event.content_index}`, event.delta);
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta === 'string') {
        reasoning += event.delta;
        onEvent({ type: 'reasoning.delta', delta: event.delta, source: 'openai-responses' });
      }
    } else if (event.type === 'response.output_item.added') {
      const item = record(event.item);
      if (item.type === 'function_call' && typeof item.id === 'string' && typeof item.call_id === 'string') {
        callIds.set(item.id, item.call_id);
        for (const delta of pendingArguments.get(item.id) ?? []) {
          onEvent({ type: 'tool.call.delta', callId: item.call_id, delta });
        }
        pendingArguments.delete(item.id);
      }
    } else if (event.type === 'response.function_call_arguments.delta') {
      if (typeof event.item_id === 'string' && typeof event.delta === 'string') {
        const callId = callIds.get(event.item_id);
        if (callId) onEvent({ type: 'tool.call.delta', callId, delta: event.delta });
        else pendingArguments.set(event.item_id, [...(pendingArguments.get(event.item_id) ?? []), event.delta]);
      }
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const result = record(event.response);
      // 必须验证终态正文；不能仅凭事件名放行未完成的响应。
      if (result.status !== (event.type === 'response.completed' ? 'completed' : 'incomplete')) {
        throw new Error('Responses 终态事件与响应状态不一致');
      }
      const parsed = parseResponsesResponse(result);
      const output = Array.isArray(result.output) ? result.output : [];
      output.forEach((value, outputIndex) => {
        const item = record(value);
        if (item.type !== 'message' || !Array.isArray(item.content)) return;
        item.content.forEach((value, contentIndex) => {
          const part = record(value);
          const content = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
          if (typeof content === 'string') emitPart(`${outputIndex}:${contentIndex}`, content, true);
        });
      });
      if (text !== parsed.text) throw new Error('Responses 终态缺少已输出的正文，未执行工具');
      if (parsed.reasoning?.startsWith(reasoning)) {
        const delta = parsed.reasoning.slice(reasoning.length);
        if (delta) onEvent({ type: 'reasoning.delta', delta, source: 'openai-responses' });
      }
      if (parsed.finishReason !== 'length' && !text.trim() && !parsed.toolCalls.length) {
        throw new Error('模型未返回回复正文或有效工具调用，请检查 Responses 协议配置');
      }
      if (signal?.aborted) return;
      if (parsed.finishReason === 'stop') {
        onEvent({ type: 'responses.context', output: readResponsesContext(result) });
        for (const call of parsed.toolCalls) {
          if (signal?.aborted) return;
          onEvent({ type: 'tool.call.final', call });
        }
      }
      if (parsed.inputTokens !== undefined || parsed.outputTokens !== undefined) {
        onEvent({ type: 'usage', inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens });
      }
      finished = true;
      onEvent({ type: 'done', finishReason: parsed.finishReason });
    }
  };
  const abortReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abortReader, { once: true });
  try {
    while (!finished) {
      if (signal?.aborted) { onEvent({ type: 'done', finishReason: 'canceled' }); return text; }
      const { done, value } = await reader.read();
      if (signal?.aborted) { onEvent({ type: 'done', finishReason: 'canceled' }); return text; }
      buffer += decoder.decode(value, { stream: !done });
      // 只规范化完整行，保留跨 chunk 的 CR/LF 边界。
      let boundary: RegExpExecArray | null;
      while (!finished && (boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index).replace(/\r\n/g, '\n');
        buffer = buffer.slice(boundary.index + boundary[0].length);
        consume(frame);
      }
      if (done && !finished) throw new Error('Responses 流在完成事件前中断，未执行工具');
    }
    return text;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
