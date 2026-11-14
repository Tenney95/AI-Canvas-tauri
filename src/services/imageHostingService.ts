import type { ImageHostingConfig, ImageHostingMediaKind } from '../types/imageHosting';
import type { ApiProviderConfig } from '../types';
import { deleteAppSecret, readAppSecret, writeAppSecret } from './providerSecretService';
import { corsSafeFetch } from './ai/httpTransport';
import { readModelProtocolFirstScalar } from './ai/modelProtocolResponse';
import { validatePathExpression } from './ai/modelProtocolShared';
import { isRemoteMediaUrl } from '../utils/mediaUrl';

const CREDENTIAL_REF = /^secret:image-host\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const FIELD_NAME = /^[\w.[\]-]{1,128}$/;
type HostingConnection = Pick<ApiProviderConfig, 'apiKey' | 'baseUrl'>;

function uploadEndpoint(config: ImageHostingConfig, baseUrl?: string): URL {
  const raw = config.uploadUrl.trim();
  const url = raw.startsWith('{{baseUrl}}/')
    ? `${(baseUrl ?? '').trim().replace(/\/+$/, '')}${raw.slice('{{baseUrl}}'.length)}` : raw;
  if (url.includes('{{') || url.includes('}}')) throw new Error('请先填写图床上传地址中的配置项');
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new Error('请填写有效的图床上传地址；使用 {{baseUrl}} 时需先填写连接接口地址'); }
  if (url.length > 2048 || !['http:', 'https:'].includes(endpoint.protocol) || !isRemoteMediaUrl(endpoint.href)
    || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error('图床上传地址须为不含账号、查询参数或片段的 HTTP(S) 地址，密钥请单独填写');
  }
  return endpoint;
}

function validateResponsePath(path: string): void {
  const errors: string[] = [];
  const normalized = path.trim().replace(/\[(\d+|\*)\]/g, '.$1');
  validatePathExpression(normalized, '图床响应路径', errors);
  if (normalized.length > 512 || !/^(?:[\w$-]+|\*)(?:\.(?:[\w$-]+|\*))*$/.test(normalized) || errors.length) {
    throw new Error('请填写有效的返回链接路径，例如 data.url 或 files[0].url');
  }
}

export function validateImageHosting(config: ImageHostingConfig, hasNewKey = false, connection?: HostingConnection): void {
  if (!config.enabled) return;
  const endpoint = uploadEndpoint(config, connection?.baseUrl);
  if (!FIELD_NAME.test(config.fileField.trim())) throw new Error('请填写有效的图床文件字段名');
  if (config.responseFormat !== undefined && !['json', 'text'].includes(config.responseFormat)) throw new Error('图床响应格式无效');
  if (config.responseFormat !== 'text') {
    validateResponsePath(config.responseUrlPath);
    if (config.successPath?.trim()) validateResponsePath(config.successPath);
  } else if (config.successPath?.trim()) throw new Error('纯文本图床不能配置 JSON 成功标记');
  if (!['none', 'bearer', 'header', 'form', 'basic'].includes(config.auth)) throw new Error('图床鉴权方式无效');
  if (config.credentialSource !== undefined && !['separate', 'connection'].includes(config.credentialSource)) throw new Error('图床密钥来源无效');
  if (config.auth === 'header') {
    const name = config.authField?.trim() ?? '';
    if (name.length > 128 || !/^[!#$%&'*+.^_`|~\w-]+$/.test(name)
      || /^(?:content-type|content-length|host|cookie|origin|referer|connection|transfer-encoding)$/i.test(name)) {
      throw new Error('请填写有效的图床鉴权请求头名称');
    }
  }
  if (config.auth === 'form' && (!FIELD_NAME.test(config.authField?.trim() ?? '')
    || config.authField?.trim() === config.fileField.trim())) throw new Error('图床密钥字段须有效且不能与文件字段相同');
  if (config.auth !== 'none') {
    if (config.credentialSource === 'connection') {
      let origin: URL;
      try { origin = new URL(connection?.baseUrl ?? ''); } catch { throw new Error('沿用连接 Key 时需填写当前连接的接口地址'); }
      if (origin.username || origin.password || origin.origin !== endpoint.origin) throw new Error('沿用连接 Key 只允许上传到当前连接的同源地址');
      if (!connection?.apiKey.trim()) throw new Error('请先填写当前连接的 API Key');
    } else if (!hasNewKey && !CREDENTIAL_REF.test(config.credentialRef ?? '')) throw new Error('请填写图床密钥');
  }
  const names = new Set([config.fileField.trim(), ...(config.auth === 'form' ? [config.authField!.trim()] : [])]);
  if (config.fileNameField !== undefined) {
    const name = config.fileNameField.trim();
    if (!FIELD_NAME.test(name) || names.has(name) || /(?:authorization|api[-_]?key|token|secret|password|credential|^key$)/i.test(name)) {
      throw new Error('图床文件名字段无效或与其他字段冲突');
    }
    names.add(name);
  }
  if ((config.formFields?.length ?? 0) > 20) throw new Error('图床附加表单参数不能超过 20 项');
  for (const field of config.formFields ?? []) {
    const name = field.name.trim();
    if (!FIELD_NAME.test(name) || names.has(name) || field.value.length > 2048) throw new Error('图床附加表单参数无效、重复或过长');
    if (/(?:authorization|api[-_]?key|token|secret|password|credential|^key$)/i.test(name)) throw new Error('图床密钥请在鉴权配置中填写，不放入普通表单参数');
    names.add(name);
  }
  if (config.maxFileBytes !== undefined && (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes <= 0)) throw new Error('图床文件大小上限无效');
  if (config.maxFileBytesByKind !== undefined && (!config.maxFileBytesByKind || typeof config.maxFileBytesByKind !== 'object'
    || Array.isArray(config.maxFileBytesByKind) || Object.entries(config.maxFileBytesByKind).some(([kind, limit]) =>
      !['image', 'video', 'audio'].includes(kind) || !Number.isSafeInteger(limit) || limit <= 0))) {
    throw new Error('图床素材类型或文件大小上限无效');
  }
  if (config.allowedExtensions !== undefined && (!config.allowedExtensions.length || config.allowedExtensions.length > 20
    || config.allowedExtensions.some((extension) => !/^[a-z0-9]{1,10}$/.test(extension)))) {
    throw new Error('图床文件格式限制无效');
  }
}

/** 每次换 Key 都生成新引用，保存失败时不会覆盖旧配置正在使用的凭据。 */
export async function persistImageHosting(config: ImageHostingConfig | undefined, newKey: string, connection?: HostingConnection): Promise<ImageHostingConfig | undefined> {
  if (!config) return undefined;
  validateImageHosting(config, !!newKey.trim(), connection);
  const next = { ...config, uploadUrl: config.uploadUrl.trim(), fileField: config.fileField.trim(),
    responseUrlPath: config.responseUrlPath.trim(), authField: config.authField?.trim(),
    ...(config.formFields ? { formFields: config.formFields.map((field) => ({ ...field, name: field.name.trim() })) } : {}),
  };
  if (newKey.trim() && config.auth !== 'none' && config.credentialSource !== 'connection') {
    const key = `image-host/${crypto.randomUUID()}`;
    if (!await writeAppSecret(key, newKey.trim(), { value: null })) throw new Error('图床密钥保存失败，请在桌面端确认凭据存储可用后重试');
    next.credentialRef = `secret:${key}`;
  }
  return next;
}

export async function deleteImageHostingCredential(ref: string | undefined): Promise<void> {
  if (ref && CREDENTIAL_REF.test(ref)) await deleteAppSecret(ref.slice('secret:'.length));
}

/** 上传仍由 uploadService 排队、限时和缓存；这里只处理图床自身的合同。 */
export async function uploadCustomImage(blob: Blob, filename: string, config: ImageHostingConfig, signal?: AbortSignal, options?: {
  connection?: HostingConnection;
  beforeUpload?: () => void;
  kind?: ImageHostingMediaKind;
}): Promise<string> {
  validateImageHosting(config, false, options?.connection);
  signal?.throwIfAborted();
  const kind = options?.kind ?? 'image';
  if (!['image', 'video', 'audio'].includes(kind)) throw new Error('参考素材类型无效');
  const limit = config.maxFileBytesByKind && Object.hasOwn(config.maxFileBytesByKind, kind)
    ? config.maxFileBytesByKind[kind] : config.maxFileBytes;
  if (!blob.size || limit !== undefined && blob.size > limit) throw new Error('参考素材为空或超过当前图床的单文件上传上限');
  const extension = filename.split('.').pop()?.toLowerCase();
  const filenameExt = extension === 'jpeg' ? 'jpg' : extension;
  if (config.allowedExtensions && (!filenameExt || !config.allowedExtensions.includes(filenameExt))) throw new Error('参考素材格式不符合当前图床限制');
  const headers = new Headers({ Accept: config.responseFormat === 'text' ? 'text/plain' : 'application/json' });
  const form = new FormData();
  const uploadFilename = extension === 'jpeg' ? filename.replace(/\.jpeg$/i, '.jpg') : filename;
  form.append(config.fileField.trim(), blob, uploadFilename);
  if (config.fileNameField) form.append(config.fileNameField.trim(), uploadFilename);
  for (const field of config.formFields ?? []) form.append(field.name.trim(), field.value);
  if (config.auth !== 'none') {
    let key: string | null;
    try { key = config.credentialSource === 'connection' ? options!.connection!.apiKey.trim() : await readAppSecret(config.credentialRef!.slice('secret:'.length)); }
    catch { throw new Error('无法读取图床密钥，请在连接设置中重新保存'); }
    signal?.throwIfAborted();
    if (!key) throw new Error('图床密钥不存在，请在连接设置中重新填写');
    if (config.auth === 'form') form.append(config.authField!.trim(), key);
    else {
      try {
        if (config.auth === 'basic' && /[:\r\n]/.test(key)) throw new Error('无效 Basic 用户名');
        const value = config.auth === 'bearer' ? `Bearer ${key}` : config.auth === 'basic' ? `Basic ${btoa(`${key}:`)}` : key;
        headers.set(config.auth === 'header' ? config.authField!.trim() : 'Authorization', value);
      }
      catch { throw new Error('图床密钥不能用作请求头，请检查格式'); }
    }
  }
  options?.beforeUpload?.();
  let response: Response;
  try {
    response = await corsSafeFetch(uploadEndpoint(config, options?.connection?.baseUrl).href, { method: 'POST', body: form, headers, signal,
      credentials: 'omit', redirect: 'error' }, { sensitive: true });
  } catch {
    signal?.throwIfAborted();
    throw new Error('自定义图床上传失败，请检查地址、网络及鉴权配置');
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`自定义图床上传失败（HTTP ${response.status}），请检查密钥权限与文件限制`);
  }
  // 图床只应返回一个小响应，不能把失控的响应整份读进内存。
  const reader = response.body?.getReader();
  if (!reader) throw new Error('自定义图床返回了空响应');
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  let text = '';
  try {
    const decoder = new TextDecoder();
    let bytes = 0;
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('图床响应过大');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    let url: unknown;
    if (config.responseFormat === 'text') {
      url = text.trim();
      if (typeof url !== 'string' || !/^\S+$/.test(url)) throw new Error('纯文本响应不是单个链接');
    }
    else {
      const payload: unknown = JSON.parse(text);
      if (payload && typeof payload === 'object' && 'success' in payload && payload.success === false) throw new Error('图床拒绝上传');
      if (config.successPath?.trim()) {
        const success = readModelProtocolFirstScalar(payload, config.successPath.trim());
        if (success === undefined || String(success) !== (config.successValue ?? 'true')) throw new Error('图床成功标记不匹配');
      }
      url = readModelProtocolFirstScalar(payload, config.responseUrlPath.trim());
    }
    if (typeof url !== 'string' || !isRemoteMediaUrl(url)) throw new Error('缺少链接');
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error('链接含账号');
    return parsed.href;
  } catch {
    await reader.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    throw new Error('自定义图床未返回有效的 HTTP(S) 素材链接，请检查返回链接路径与响应（上限 1 MiB）');
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
