/** 原生查询回执的纯数据边界；不依赖协议执行器或Store。 */
const blocked = /(?:^key$|api.?key|access.?key|token|authorization|password|secret|credential|cookie|^(?:prompt|lyrics?|messages?|content|base64|text|body)$|file.?path|url)/i;
export const isSafeNativeProtocolPath = (path: string) => path.split('.').every((part) => /^[A-Za-z_][A-Za-z0-9_]*$|^\d{1,3}$/.test(part)
  && !['__proto__', 'constructor', 'prototype'].includes(part) && !blocked.test(part));

/** 仅查询所需的有界身份／状态标量；不接收凭据、完整响应、请求正文或媒体地址。 */
export function validateNativeProtocolContext(value: Record<string, unknown>): void {
  let count = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++count > 256 || depth > 16) throw new Error('原查询上下文超过安全上限');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') {
      if (item.length > 512 || !/^[\p{L}\p{N}_.:@+/-]*$/u.test(item) || /^[/]|^[A-Za-z]:[/]|:\/\//.test(item)
        || item.split('/').some((part) => part === '..') || item.includes('\\')) throw new Error('查询恢复字段包含不可持久化的地址或正文');
      return;
    }
    if (!item || typeof item !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(item))
      || Reflect.ownKeys(item).some((key) => typeof key !== 'string')) throw new Error('原查询上下文字段无效');
    if (Array.isArray(item) && item.length > 128) throw new Error('原查询上下文列表过长');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!isSafeNativeProtocolPath(key) || blocked.test(key) || !('value' in descriptor)) throw new Error('查询恢复字段包含凭据或不受支持的属性');
      walk(descriptor.value, depth + 1);
    }
  };
  if (!value || Array.isArray(value)) throw new Error('原查询上下文必须是对象');
  walk(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16 * 1024) throw new Error('原查询上下文过大');
}
export function isSafeNativeProtocolTaskId(value: unknown, secrets: readonly string[] = []): value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || secrets.some((secret) => [secret, secret.trim()].some((key) => key.length > 0 && value.includes(key)))) return false;
  try { validateNativeProtocolContext({ id: value }); return true; } catch { return false; }
}

