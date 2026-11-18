import { describe, expect, it, vi } from 'vitest';
import { buildChatApiRequest, parseChatApiResponse, type ChatApiMessage } from '../../src/services/ai/chatApiProtocol';
import { RESPONSES_OUTPUT } from '../../src/services/ai/responsesApiProtocol';
import { parseNonStream, parseStream } from '../../src/services/ai/streamParsers';

const tool = { type: 'function' as const, function: {
  name: 'canvas_query', description: '查询画布', parameters: {
    type: 'object', properties: { detail: { type: 'boolean' } },
  },
} };
const call = (id = 'one', args = '{"detail":true}') => ({
  type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`,
  name: 'canvas_query', arguments: args, status: 'completed',
});
const message = (text = '收到五张图') => ({
  type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', phase: 'final_answer',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: '核对图片' }] };
const completed = (output: unknown[] = [message()]) => ({
  status: 'completed', output, usage: { input_tokens: 123, output_tokens: 45 },
});
const request = (messages: ChatApiMessage[], tools = [tool]) => buildChatApiRequest({
  protocol: 'openai-responses', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1/',
  model: 'configured-model', stream: true, messages, tools,
});
const frame = (event: object) => `event: ${(event as { type?: string }).type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
const terminal = (output?: unknown[]) => ({ type: 'response.completed', response: completed(output) });
const options = () => ({ protocol: 'openai-responses' as const, requestId: 'r', modelId: 'm', onEvent: vi.fn() });

function sse(events: object[], chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(events.map(frame).join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Responses native request and non-stream response', () => {
  it('preserves system, history, five images and tool result linkage without prompt flattening', () => {
    const images = Array.from({ length: 5 }, (_, index) => `data:image/png;base64,${index}AAA`);
    const built = request([
      { role: 'system', content: '系统规则' },
      { role: 'assistant', content: '上轮回复' },
      { role: 'user', content: [{ type: 'text', text: '比较五图' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_one', type: 'function', function: { name: 'canvas_query', arguments: '{"detail":true}' } }] },
      { role: 'tool', tool_call_id: 'call_one', content: '{"nodes":5}' },
    ]);
    expect(built.url).toBe('https://gateway.example/v1/responses');
    expect(built.init.headers).toMatchObject({ Authorization: 'Bearer fixture' });
    const body = JSON.parse(String(built.init.body));
    expect(body).toMatchObject({ model: 'configured-model', stream: true, store: false, include: ['reasoning.encrypted_content'] });
    expect(body).not.toHaveProperty('messages');
    expect(body.input[0]).toEqual({ role: 'system', content: [{ type: 'input_text', text: '系统规则' }] });
    expect(body.input[1]).toEqual({ role: 'assistant', content: [{ type: 'input_text', text: '上轮回复' }] });
    expect(body.input[2].content.slice(1)).toEqual(images.map((url) => ({ type: 'input_image', image_url: url, detail: 'auto' })));
    expect(body.input[3]).toEqual({ type: 'function_call', call_id: 'call_one', name: 'canvas_query', arguments: '{"detail":true}' });
    expect(body.input[4]).toEqual({ type: 'function_call_output', call_id: 'call_one', output: '{"nodes":5}' });
    expect(body.tools).toEqual([{ type: 'function', ...tool.function, strict: false }]);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools for a no-tool request and fails on unsupported content or missing result IDs', () => {
    expect(JSON.parse(String(request([{ role: 'user', content: 'hello' }], []).init.body))).not.toHaveProperty('tools');
    expect(() => request([{ role: 'tool', content: 'result' }])).toThrow('tool_call_id');
    expect(() => request([{ role: 'user', content: [{ type: 'input_audio' }] }])).toThrow('不支持');
  });

  it('extracts all text, refusal, summary and functions even when output starts with reasoning', () => {
    const parsed = parseChatApiResponse(completed([
      reasoning, call(), message('第一段'), { type: 'message', content: [{ type: 'refusal', refusal: '拒绝说明' }] }, message('第二段'), call('two'),
    ]), 'openai-responses');
    expect(parsed).toEqual({
      text: '第一段拒绝说明第二段', reasoning: '核对图片', finishReason: 'stop', inputTokens: 123, outputTokens: 45,
      toolCalls: ['one', 'two'].map((id) => ({ callId: `call_${id}`, toolId: 'canvas_query', input: { detail: true } })),
    });
  });

  it.each(['{', 'null', '[]', '1'])('rejects malformed tool arguments %s without an empty-object fallback', (args) => {
    expect(() => parseChatApiResponse(completed([call('one', args)]), 'openai-responses')).toThrow('参数');
  });

  it.each(['failed', 'cancelled', 'in_progress', 'queued', undefined])('rejects unfinished status %s', (status) => {
    expect(() => parseChatApiResponse({ status, output: [message()] }, 'openai-responses')).toThrow();
  });

  it('keeps truncation separate from successful tools and rejects filtering failures', () => {
    expect(parseChatApiResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [call('one', '{')] }, 'openai-responses'))
      .toMatchObject({ finishReason: 'length', toolCalls: [] });
    expect(() => parseChatApiResponse({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [call()] }, 'openai-responses')).toThrow();
  });

  it.each([false, true])('emits JSON text and preserves ordered opaque continuation without serialization (stream fallback %s)', async (streamFallback) => {
    const config = options();
    const output = [reasoning, { ...message('先查画布'), phase: 'commentary' }, call()];
    const response = new Response(JSON.stringify(completed(output)), { headers: { 'Content-Type': 'application/json' } });
    await expect(streamFallback ? parseStream(response, config) : parseNonStream(response, config)).resolves.toBe('先查画布');
    const contextEvent = config.onEvent.mock.calls.map(([event]) => event).find((event) => event.type === 'responses.context');
    expect(contextEvent).toEqual({ type: 'responses.context', output });
    const history: ChatApiMessage = { role: 'assistant', content: '先查画布', [RESPONSES_OUTPUT]: output,
      tool_calls: [{ id: 'call_one', type: 'function', function: { name: 'canvas_query', arguments: '{"detail":true}' } }] };
    expect(JSON.stringify(history)).not.toContain('opaque');
    const followup = request([{ ...history }, { role: 'tool', tool_call_id: 'call_one', content: 'result' }]);
    expect(JSON.parse(String(followup.init.body)).input).toEqual([...output, { type: 'function_call_output', call_id: 'call_one', output: 'result' }]);
  });
});

describe('Responses SSE', () => {
  it.each([1, 7, 16384])('handles UTF-8 and CRLF split into %s byte chunks, terminal text and usage exactly once', async (chunkSize) => {
    const config = options();
    const response = sse([
      { type: 'response.created', response: { status: 'in_progress' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '收到' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '五张图' },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '收到五张图' }, terminal(),
    ], chunkSize);
    await expect(parseStream(response, config)).resolves.toBe('收到五张图');
    const events = config.onEvent.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.type === 'text.delta')).toEqual([{ type: 'text.delta', delta: '收到' }, { type: 'text.delta', delta: '五张图' }]);
    expect(events.filter((event) => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 123, outputTokens: 45 }]);
    expect(events.filter((event) => event.type === 'done')).toEqual([{ type: 'done', finishReason: 'stop' }]);
  });

  it('links interleaved item IDs to call IDs and only finalizes from successful terminal output', async () => {
    const config = options();
    await parseStream(sse([
      { type: 'response.output_item.added', item: { ...call('one'), arguments: '' } },
      { type: 'response.output_item.added', item: { ...call('two'), arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_two', delta: '{"detail":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_one', delta: '{"detail":true}' },
      { type: 'response.output_item.done', item: call('one') },
      { type: 'response.function_call_arguments.done', item_id: 'fc_one', arguments: '{"detail":true}' },
      terminal([reasoning, call('one'), call('two')]),
    ]), config);
    const events = config.onEvent.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.type === 'tool.call.delta')).toEqual([
      { type: 'tool.call.delta', callId: 'call_two', delta: '{"detail":' },
      { type: 'tool.call.delta', callId: 'call_one', delta: '{"detail":true}' },
    ]);
    expect(events.filter((event) => event.type === 'tool.call.final')).toHaveLength(2);
  });

  it('does not execute calls on premature EOF, even after output_item.done', async () => {
    const config = options();
    await expect(parseStream(sse([{ type: 'response.output_item.done', item: call() }]), config)).rejects.toThrow('中断');
    expect(config.onEvent.mock.calls.some(([event]) => event.type === 'tool.call.final' || event.type === 'done')).toBe(false);
  });

  it.each([
    { type: 'error', message: 'quota exceeded' },
    { type: 'response.failed', response: { error: { message: 'quota exceeded' } } },
    { type: 'response.completed', response: { status: 'in_progress', output: [call()] } },
    terminal([call('one', '{')]),
  ])('does not finalize a tool on a failed or invalid terminal event ($type)', async (event) => {
    const config = options();
    await expect(parseStream(sse([{ type: 'response.output_item.done', item: call() }, event]), config)).rejects.toThrow();
    expect(config.onEvent.mock.calls.some(([event]) => event.type === 'tool.call.final')).toBe(false);
  });

  it('marks an empty token-limited response as length and never finalizes partial functions', async () => {
    const config = options();
    await expect(parseStream(sse([{ type: 'response.incomplete', response: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [call()],
    } }]), config)).resolves.toBe('');
    expect(config.onEvent).toHaveBeenCalledWith({ type: 'done', finishReason: 'length' });
    expect(config.onEvent.mock.calls.some(([event]) => event.type === 'tool.call.final')).toBe(false);
  });

  it('supports refusal text and a terminal-only provider without duplicate summary', async () => {
    const config = options();
    const output = [reasoning, { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: '不能协助' }] }];
    await expect(parseStream(sse([
      { type: 'response.reasoning_summary_text.delta', delta: '核对' },
      { type: 'response.refusal.delta', output_index: 1, content_index: 0, delta: '不能' }, terminal(output),
    ]), config)).resolves.toBe('不能协助');
    expect(config.onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === 'reasoning.delta')).toEqual([
      { type: 'reasoning.delta', delta: '核对', source: 'openai-responses' },
      { type: 'reasoning.delta', delta: '图片', source: 'openai-responses' },
    ]);
  });

  it('cancels a stalled stream promptly without releasing any tool proposals', async () => {
    const config = options();
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'text/event-stream' } });
    const pending = parseStream(response, { ...config, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBe('');
    expect(cancel).toHaveBeenCalled();
    expect(config.onEvent).toHaveBeenCalledWith({ type: 'done', finishReason: 'canceled' });
    expect(config.onEvent.mock.calls.some(([event]) => event.type === 'tool.call.final')).toBe(false);
  });

  it.each([false, true])('honors cancellation while emitting text even with the terminal in the same chunk (terminal text %s)', async (terminalText) => {
    const config = options();
    const controller = new AbortController();
    config.onEvent.mockImplementation((event) => { if (event.type === 'text.delta') controller.abort(); });
    const events = [
      ...(!terminalText ? [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '回复' }] : []),
      terminal([message('回复'), call()]),
    ];
    await expect(parseStream(sse(events, 16384), { ...config, signal: controller.signal })).resolves.toBe('回复');
    expect(config.onEvent).toHaveBeenCalledWith({ type: 'done', finishReason: 'canceled' });
    expect(config.onEvent.mock.calls.some(([event]) => event.type === 'tool.call.final')).toBe(false);
    expect(config.onEvent).not.toHaveBeenCalledWith({ type: 'done', finishReason: 'stop' });
  });
});
