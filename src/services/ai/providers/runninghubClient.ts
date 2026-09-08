import type { RunningHubConnection, RunningHubMediaKind } from '../../../types/runninghub';
import { corsSafeFetch } from '../httpTransport';
import { assertMediaDataUrlSize } from '../../fileService';

export class RunningHubRequestError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  constructor(code: number, httpStatus: number) {
    const detail: Record<number, string> = { 401: '鉴权失败，请检查所选连接', 402: '余额不足', 403: '无权访问该资源', 429: '请求过于频繁', 805: '任务执行失败', 807: '任务不存在或不属于此密钥', 809: '上传文件过大', 814: '个人队列已满' };
    super(`RunningHub ${detail[code] || detail[httpStatus] || '请求失败'}（${code || httpStatus}）`);
    this.code = code; this.httpStatus = httpStatus;
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(120_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
async function request(url: string, init: RequestInit): Promise<Response> {
  try { return await corsSafeFetch(url, init); }
  catch {
    if (init.signal?.aborted) throw new Error('RunningHub 请求已停止或超时');
    // 原生网络异常可能包含带 apiKey 的查询 URL，不能把原文交给 UI/Agent 持久化。
    throw new Error('RunningHub 连接中断，请检查网络后继续查询；不要重复提交任务');
  }
}
async function parseResponse(response: Response, successCode = 0): Promise<Record<string, unknown>> {
  if (!response.ok) throw new RunningHubRequestError(response.status, response.status);
  const text = await response.text();
  if (text.length > 1_500_000) throw new Error('RunningHub 响应超过允许大小');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/("(?:taskId|workflowId|webappId)"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"'));
  } catch { throw new Error('RunningHub 返回了无效 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('RunningHub 返回格式无效');
  const payload = parsed as Record<string, unknown>;
  if (typeof payload.code !== 'number') throw new Error('RunningHub 响应缺少状态码');
  if (payload.code !== successCode) throw new RunningHubRequestError(payload.code, response.status);
  return payload;
}

export async function runningHubRequest(
  connection: RunningHubConnection,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  method: 'POST' | 'GET' = 'POST',
): Promise<Record<string, unknown>> {
  if (!/^\/(?:api\/openapi\/getJsonApiFormat|api\/webapp\/apiCallDemo|task\/openapi\/(?:create|ai-app\/run|status|outputs|cancel))$/.test(path)) throw new Error('不支持的 RunningHub 工作流接口');
  const url = new URL(`${connection.baseUrl}${path}`);
  if (method === 'GET') {
    for (const [key, value] of Object.entries({ ...body, apiKey: connection.apiKey })) url.searchParams.set(key, String(value));
  }
  const response = await request(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${connection.apiKey}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ ...body, apiKey: connection.apiKey }) } : {}),
    signal: requestSignal(signal),
  });
  return parseResponse(response);
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** 使用应用已有媒体 URL 读取通道；不接收裸文件系统路径，不经第三方图床。 */
export async function uploadRunningHubMedia(
  connection: RunningHubConnection,
  mediaUrl: string,
  kind: RunningHubMediaKind,
  signal?: AbortSignal,
): Promise<{ filename: string; url: string }> {
  const source = new URL(mediaUrl);
  if (!['http:', 'https:', 'asset:', 'blob:', 'data:'].includes(source.protocol) || source.username || source.password) throw new Error('不支持的参考素材地址');
  if (mediaUrl.startsWith('data:') && mediaUrl.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 1024) throw new Error('参考素材超过 100 MB 限制');
  if (/^data:[^,]*;base64,/.test(mediaUrl)) assertMediaDataUrlSize(Math.ceil((mediaUrl.length - mediaUrl.indexOf(',') - 1) * 3 / 4), kind, 'RunningHub 参考素材');
  const local = ['asset:', 'blob:', 'data:'].includes(source.protocol) || source.hostname === 'asset.localhost';
  const activeSignal = requestSignal(signal);
  const response = await (local ? fetch : request)(mediaUrl, { signal: activeSignal });
  if (!response.ok) throw new Error(`读取参考${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}失败`);
  if (Number(response.headers.get('content-length')) > MAX_UPLOAD_BYTES) throw new Error('参考素材超过 100 MB 限制');
  assertMediaDataUrlSize(Number(response.headers.get('content-length')) || 0, kind, 'RunningHub 参考素材');
  const blob = await response.blob();
  assertMediaDataUrlSize(blob.size, kind, 'RunningHub 参考素材');
  if (!blob.size || blob.size > MAX_UPLOAD_BYTES) throw new Error('参考素材为空或超过 100 MB 限制');
  if (blob.type && !blob.type.startsWith(`${kind}/`) && blob.type !== 'application/octet-stream') throw new Error('参考素材类型与参数不匹配');
  const subtype = blob.type.split('/')[1]?.split(';')[0];
  const extension = ({ jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', mp4: 'mp4', webm: 'webm', mpeg: 'mp3', wav: 'wav', 'x-wav': 'wav', ogg: 'ogg', flac: 'flac' } as Record<string, string>)[subtype] || ({ image: 'png', video: 'mp4', audio: 'wav' } as const)[kind];
  const form = new FormData();
  form.append('file', blob, `reference.${extension}`);
  const uploaded = await parseResponse(await request(`${connection.baseUrl}/openapi/v2/media/upload/binary`, {
    method: 'POST', headers: { Authorization: `Bearer ${connection.apiKey}` }, body: form, signal: activeSignal,
  }), 200);
  const data = uploaded.data as Record<string, unknown> | undefined;
  if (!data || typeof data.filename !== 'string' || typeof data.download_url !== 'string' || !/^https?:\/\//.test(data.download_url)) throw new Error('RunningHub 上传未返回有效文件名和地址');
  return { filename: data.filename, url: data.download_url };
}
