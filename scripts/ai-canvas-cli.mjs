#!/usr/bin/env node
/** AI Canvas 本机控制 CLI；传输、鉴权与取消均复用 MCP loopback client。 */
import { createReadStream } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { LoopbackClient } from './ai-canvas-mcp.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const HELP = `AI Canvas CLI（只连接 127.0.0.1，令牌从 AI_CANVAS_MCP_TOKEN 读取）
  node scripts/ai-canvas-cli.mjs --port <端口> status
  node scripts/ai-canvas-cli.mjs --port <端口> tools search [查询词] [--category <ID>] [--offset <数值>] [--limit <数值>] [--detail summary|schema]
  node scripts/ai-canvas-cli.mjs --port <端口> tools describe <工具名> [工具名...最多3个]
  node scripts/ai-canvas-cli.mjs --port <端口> call [--file <UTF-8 JSON文件>]
  node scripts/ai-canvas-cli.mjs --port <端口> operation get <原operationKey> --project-id <项目ID>
call 默认读取 stdin，完整信封：{name,arguments,expectedProjectId?,expectedRevision?,operationKey?}
端口也可由 AI_CANVAS_MCP_PORT 提供；--timeout-ms 范围 100–600000，默认 600000。
超时/中断可能已经产生副作用；查询原回执，不要自动换 key 重投。`;

function integer(value, name, min, max) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${name} 必须是有效整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} 超出允许范围`);
  return number;
}

/** 只解析命令行形状；业务 schema 始终以运行中宿主发现结果为准。 */
export function parseCli(args, env = process.env) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const positional = [];
  const flags = {};
  const allowed = new Set(['--port', '--timeout-ms', '--file', '--category', '--offset', '--limit', '--detail', '--project-id']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (!allowed.has(arg) || flags[arg] !== undefined || args[index + 1] === undefined || args[index + 1].startsWith('--')) {
      throw new Error('未知、重复或缺少值的选项；使用 --help 查看用法');
    }
    flags[arg] = args[index += 1];
  }
  const port = integer(flags['--port'] ?? env.AI_CANVAS_MCP_PORT, '端口', 1, 65535);
  const token = env.AI_CANVAS_MCP_TOKEN;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) throw new Error('请通过 AI_CANVAS_MCP_TOKEN 注入有效的 256 位会话令牌');
  const timeoutMs = integer(flags['--timeout-ms'] ?? '600000', '超时', 100, 600000);
  const [command, subcommand, ...rest] = positional;
  const checkFlags = (specific) => {
    for (const key of Object.keys(flags)) {
      if (!['--port', '--timeout-ms', ...specific].includes(key)) throw new Error('此命令不接受该选项；使用 --help 查看用法');
    }
  };
  let request;
  let file;
  if (command === 'status' && positional.length === 1) {
    checkFlags([]);
    request = { method: 'tools/list', params: {} };
  } else if (command === 'tools' && subcommand === 'search' && rest.length <= 1) {
    checkFlags(['--category', '--offset', '--limit', '--detail']);
    const input = {};
    if (rest.length) input.query = rest[0];
    if (flags['--category']) input.category = flags['--category'];
    if (flags['--offset']) input.offset = integer(flags['--offset'], '偏移', 0, Number.MAX_SAFE_INTEGER);
    if (flags['--limit']) input.limit = integer(flags['--limit'], '数量', 1, 8);
    if (flags['--detail']) {
      if (!['summary', 'schema'].includes(flags['--detail'])) throw new Error('detail 只能为 summary 或 schema');
      input.detail = flags['--detail'];
    }
    request = { method: 'tools/call', params: { name: 'tools_search', arguments: input } };
  } else if (command === 'tools' && subcommand === 'describe' && rest.length >= 1 && rest.length <= 3) {
    checkFlags([]);
    request = { method: 'tools/call', params: { name: 'tools_describe', arguments: { names: rest } } };
  } else if (command === 'call' && positional.length === 1) {
    checkFlags(['--file']);
    file = flags['--file'];
  } else if (command === 'operation' && subcommand === 'get' && rest.length === 1 && flags['--project-id']) {
    checkFlags(['--project-id']);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rest[0])) throw new Error('operationKey 格式不合法');
    request = { method: 'tools/call', params: { name: 'tools_call', arguments: {
      name: 'mcp_operation_get', arguments: { operationKey: rest[0] }, expectedProjectId: flags['--project-id'],
    } } };
  } else {
    throw new Error('命令格式不正确；使用 --help 查看用法');
  }
  return { help: false, command, port, token: token.toLowerCase(), timeoutMs, request, file };
}

export function parseEnvelope(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('JSON 输入超过 1 MiB');
  let input;
  try { input = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (cause) { throw new Error('输入必须为有效 UTF-8 JSON 信封', { cause }); }
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fields = ['name', 'arguments', 'expectedProjectId', 'expectedRevision', 'operationKey'];
  if (!isObject(input) || Object.keys(input).some((key) => !fields.includes(key))
    || typeof input.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.name) || !isObject(input.arguments)) {
    throw new Error('call 需要且仅接受完整 tools_call 信封，参数放在 arguments 中');
  }
  if (['tools_call', 'tools_search', 'tools_describe'].includes(input.name)) throw new Error('发现入口请使用 tools search/describe，不递归调用');
  if (input.expectedProjectId !== undefined && (typeof input.expectedProjectId !== 'string' || !input.expectedProjectId || input.expectedProjectId.length > 180)) throw new Error('expectedProjectId 格式不合法');
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !input.expectedProjectId)) throw new Error('expectedRevision 需要有效项目ID及非负整数');
  if (input.operationKey !== undefined && (typeof input.operationKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationKey))) throw new Error('operationKey 格式不合法');
  return input;
}

/** 流式限制在分配完整输入前生效；不把读文件错误中的绝对路径输出到诊断。 */
export async function readEnvelope(stream, signal) {
  const chunks = [];
  let bytes = 0;
  const abort = () => stream.destroy(new DOMException('Aborted', 'AbortError'));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_INPUT_BYTES) throw new Error('JSON 输入超过 1 MiB');
      chunks.push(buffer);
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch (cause) { throw new Error('输入必须使用 UTF-8 编码', { cause }); }
    return parseEnvelope(text);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export async function executeCli(options, client, envelope, signal) {
  const request = options.request ?? { method: 'tools/call', params: { name: 'tools_call', arguments: envelope } };
  const result = await client.request(request.method, request.params, { signal });
  if (options.command === 'status') return { available: true, toolCount: Array.isArray(result?.tools) ? result.tools.length : 0 };
  return result;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${HELP}\n`); return; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const client = new LoopbackClient(options);
  try {
    let envelope;
    if (options.command === 'call') {
      if (!options.file && process.stdin.isTTY) throw new Error('请从 stdin 或 --file 提供完整 JSON 信封');
      const stream = options.file ? createReadStream(options.file) : process.stdin;
      try { envelope = await readEnvelope(stream, controller.signal); }
      catch (cause) {
        if (cause?.name === 'AbortError') throw cause;
        if (cause?.code) throw new Error('无法读取 JSON 输入文件', { cause });
        throw cause;
      } finally { if (options.file) stream.destroy(); }
    }
    const result = await executeCli(options, client, envelope, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result?.isError) process.exitCode = 2;
  } finally {
    client.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const aborted = error?.name === 'AbortError';
    // 远端异常可能带工具输入；诊断不转发正文/路径/令牌。详细结果只走 stdout。
    const message = aborted ? '已请求取消；操作结果可能未知，请查询原 operationKey'
      : '命令未完成；请核对用法、UTF-8 输入和本机控制服务。写入/生成失败后先查询原回执，不自动重投。';
    process.stderr.write(`${JSON.stringify({ error: aborted ? 'CANCELLED' : 'CLI_FAILED', message })}\n`);
    process.exitCode = aborted ? 130 : 1;
  });
}
