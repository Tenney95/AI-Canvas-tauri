/**
 * ai/modelProtocolShared — 声明式模型协议的共享常量与基础校验。
 *
 * 模板语法、变量白名单、Header / 路径黑名单、鉴权默认值集中在这里，
 * 让「协议校验」「模板渲染」「请求构建」三处不会各自漂移。
 */
import { PROTOCOL_VARIABLE_NAMES } from './modelProtocolVariables';
import type { ModelProtocolAuthConfig } from '../../types/aiTypes';

export const TEMPLATE_RE = /{{\s*([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)*)\s*}}/g;
export const FULL_TEMPLATE_RE = /^{{\s*([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)*)\s*}}$/;
export const WHEN_PRESENT_KEY = '$whenPresent';
export const FOR_EACH_KEY = '$forEach';
export const CONDITIONAL_VALUE_KEY = '$value';
/**
 * Stage 1 only permits array expansion for the canonical typed reference URL lists.
 * Keeping this list narrow prevents arbitrary protocol values (messages, tools, submit
 * payloads, etc.) from becoming an implicit expression language.
 */
export const FOR_EACH_VARIABLE_ROOTS = new Set([
  'referenceImageUrls',
  'referenceVideoUrls',
  'referenceAudioUrls',
]);
export const MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS = 64;
export const MAX_MODEL_PROTOCOL_BODY_BYTES = 512 * 1024 * 1024;
/** 变量白名单由 modelProtocolVariables 总表派生，避免与字段映射表各自漂移。 */
export const ALLOWED_VARIABLE_ROOTS = PROTOCOL_VARIABLE_NAMES;
export const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
export const BLOCKED_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'host',
  'origin',
  'referer',
  'cookie',
  'set-cookie',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
]);
export const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const OMIT_TEMPLATE_VALUE = Symbol('omit-template-value');
export const DEFAULT_RETRY_HTTP_STATUSES = [408, 429, 500, 502, 503, 504];
export const DEFAULT_MAX_QUERY_RETRIES = 3;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60000;
export const MIME_TYPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateRelativePath(path: unknown, label: string, errors: string[]): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    errors.push(`${label}必须是以 / 开头的同源相对路径`);
  }
}

export function validatePathExpression(path: unknown, label: string, errors: string[]): void {
  if (typeof path !== 'string' || !path.trim()) {
    errors.push(`${label}不能为空`);
    return;
  }
  if (path.split('.').some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    errors.push(`${label}包含不允许的路径片段`);
  }
}

export function validateHeaderName(name: string, label: string, errors: string[]): void {
  if (!HEADER_NAME_RE.test(name)) {
    errors.push(`${label}“${name}”不是有效的 Header 名称`);
    return;
  }
  if (BLOCKED_HEADER_NAMES.has(name.toLowerCase())) {
    errors.push(`${label}不允许设置 ${name}`);
  }
}

export function visitTemplateStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => visitTemplateStrings(item, visit));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => visitTemplateStrings(item, visit));
  }
}

export function resolveAuthentication(auth: ModelProtocolAuthConfig | undefined): ModelProtocolAuthConfig {
  return auth ?? { type: 'bearer' };
}
