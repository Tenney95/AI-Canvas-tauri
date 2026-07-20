import type { GeneralModelCategory } from '../../types';
import type {
  ModelProtocolAuthConfig,
  ModelProtocolBodyEncoding,
  ModelProtocolHttpMethod,
  NormalizedModelExecutionProtocol,
  ProtocolJsonValue,
} from '../../types/aiTypes';
import { validateModelExecutionProtocol } from './modelProtocol';

export type ModelProtocolImportFormat = 'fetch' | 'axios' | 'curl' | 'python' | 'raw-http' | 'openapi' | 'json';
export type ModelProtocolImportConfidence = 'high' | 'medium' | 'low';

export interface ModelProtocolImportField {
  id: string;
  label: string;
  value: string;
  confidence: ModelProtocolImportConfidence;
}

export interface ModelProtocolImportResult {
  baseUrl?: string;
  modelId?: string;
  category?: GeneralModelCategory;
  protocol?: NormalizedModelExecutionProtocol;
  confidence: ModelProtocolImportConfidence;
  formats: ModelProtocolImportFormat[];
  fields: ModelProtocolImportField[];
  warnings: string[];
}

export interface ModelProtocolImportOptions {
  category?: GeneralModelCategory;
}

export interface ModelProtocolExamples {
  submitRequest: string;
  submitResponse: string;
  pollRequest?: string;
  pollResponse?: string;
}

interface SourceRange {
  start: number;
  end: number;
}

interface ParsedRequest {
  start: number;
  url: string;
  method: ModelProtocolHttpMethod;
  headers: Record<string, string>;
  query: Record<string, ProtocolJsonValue>;
  body?: ProtocolJsonValue;
  bodyEncoding?: ModelProtocolBodyEncoding;
  response?: ProtocolJsonValue;
  format: Exclude<ModelProtocolImportFormat, 'json'>;
}

interface RequestAnchor {
  start: number;
  url: string;
  format: 'fetch' | 'axios' | 'python';
}

interface PathLeaf {
  path: string;
  key: string;
  value: unknown;
}

interface BaseUrlResolution {
  baseUrl: string;
  prefix: string;
}

const REQUEST_URL_ASSIGNMENT_RE = /(?:\b(?:const|let|var)\s+)?\b(?:url|endpoint|api_url|apiUrl)\b\s*=\s*(["'`])(https?:\/\/[^"'`]+)\1/g;
const DIRECT_FETCH_RE = /\bfetch\s*\(\s*(["'`])(https?:\/\/[^"'`]+)\1/g;
const DIRECT_CLIENT_RE = /\b(?:axios|requests|httpx)\.(get|post)\s*\(\s*(["'`])(https?:\/\/[^"'`]+)\2/gi;
const HTTP_METHOD_RE = /\bmethod\s*:\s*(["'])(GET|POST)\1/i;
const CALLBACK_KEY_RE = /(?:callback|webhook|notify|notification)[_-]?(?:url|uri)|(?:callback|webhook)/i;
const AUTH_VALUE_RE = /(?:bearer\s+)?(?:<[^>]+>|\{\{[^}]+}}|\$\{[^}]+}|YOUR_[A-Z_]+|sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{20,})/i;
const API_PREFIX_SEGMENT_RE = /^(?:api|openai|anthropic|v\d+(?:\.\d+)?)$/i;
const TASK_CONTAINER_RE = /^(?:tasks?|jobs?|predictions?|requests?|operations?)$/i;
const URL_VALUE_RE = /^(?:https?:\/\/|data:[^;,]+;base64,)/i;

class LooseLiteralParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): ProtocolJsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    return value;
  }

  private parseValue(): ProtocolJsonValue {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"' || char === '\'' || char === '`') return this.parseString();
    if (char === '-' || /\d/.test(char || '')) return this.parseNumber();
    return this.parseIdentifierValue();
  }

  private parseObject(): ProtocolJsonValue {
    const result: Record<string, ProtocolJsonValue> = {};
    this.index += 1;
    this.skipWhitespace();
    while (this.index < this.source.length && this.source[this.index] !== '}') {
      const key = this.parseKey();
      this.skipWhitespace();
      if (this.source[this.index] !== ':') throw new Error('对象字段缺少冒号');
      this.index += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      if (this.source[this.index] === ',') {
        this.index += 1;
        this.skipWhitespace();
      } else if (this.source[this.index] !== '}') {
        throw new Error('对象字段之间缺少逗号');
      }
    }
    if (this.source[this.index] !== '}') throw new Error('对象没有结束');
    this.index += 1;
    return result;
  }

  private parseArray(): ProtocolJsonValue {
    const result: ProtocolJsonValue[] = [];
    this.index += 1;
    this.skipWhitespace();
    while (this.index < this.source.length && this.source[this.index] !== ']') {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.source[this.index] === ',') {
        this.index += 1;
        this.skipWhitespace();
      } else if (this.source[this.index] !== ']') {
        throw new Error('数组元素之间缺少逗号');
      }
    }
    if (this.source[this.index] !== ']') throw new Error('数组没有结束');
    this.index += 1;
    return result;
  }

  private parseKey(): string {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === '"' || char === '\'' || char === '`') return this.parseString();
    const match = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(this.source.slice(this.index));
    if (!match) throw new Error('对象字段名无效');
    this.index += match[0].length;
    return match[0];
  }

  private parseString(): string {
    const quote = this.source[this.index];
    this.index += 1;
    let result = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      this.index += 1;
      if (char === quote) return result;
      if (char === '$' && quote === '`' && this.source[this.index] === '{') {
        throw new Error('不支持模板字符串表达式');
      }
      if (char !== '\\') {
        result += char;
        continue;
      }
      const escaped = this.source[this.index];
      this.index += 1;
      const escapes: Record<string, string> = {
        n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
      };
      result += escapes[escaped] ?? escaped;
    }
    throw new Error('字符串没有结束');
  }

  private parseNumber(): number {
    const match = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(this.source.slice(this.index));
    if (!match) throw new Error('数字无效');
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseIdentifierValue(): ProtocolJsonValue {
    const match = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(this.source.slice(this.index));
    if (!match) throw new Error('值无效');
    this.index += match[0].length;
    if (match[0] === 'true' || match[0] === 'True') return true;
    if (match[0] === 'false' || match[0] === 'False') return false;
    if (match[0] === 'null' || match[0] === 'None' || match[0] === 'undefined') return null;
    return match[0];
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index])) {
        this.index += 1;
        continue;
      }
      if (this.source.startsWith('//', this.index)) {
        const end = this.source.indexOf('\n', this.index + 2);
        this.index = end < 0 ? this.source.length : end + 1;
        continue;
      }
      if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index + 2);
        this.index = end < 0 ? this.source.length : end + 2;
        continue;
      }
      break;
    }
  }
}

function isRecord(value: unknown): value is Record<string, ProtocolJsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function extractBalanced(source: string, start: number): SourceRange | undefined {
  const opening = source[start];
  const closing = opening === '{' ? '}' : opening === '[' ? ']' : undefined;
  if (!closing) return undefined;
  const stack = [closing];
  let quote = '';
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return { start, end: index + 1 };
    }
  }
  return undefined;
}

function parseLooseLiteral(raw: string): ProtocolJsonValue | undefined {
  try {
    return new LooseLiteralParser(raw).parse();
  } catch {
    return undefined;
  }
}

function findAssignedLiteral(
  source: string,
  names: string[],
): { value?: ProtocolJsonValue; range?: SourceRange } {
  const namePattern = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const assignment = new RegExp(`(?:\\b(?:const|let|var)\\s+)?\\b(?:${namePattern})\\b\\s*=\\s*`, 'i').exec(source);
  if (!assignment) return {};
  let start = assignment.index + assignment[0].length;
  while (/\s/.test(source[start] || '')) start += 1;
  if (source[start] !== '{' && source[start] !== '[') return {};
  const range = extractBalanced(source, start);
  if (!range) return {};
  return { value: parseLooseLiteral(source.slice(range.start, range.end)), range };
}

function isExcluded(index: number, ranges: SourceRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function findStrictJsonValues(source: string, excluded: SourceRange[] = []): Array<{ value: ProtocolJsonValue; range: SourceRange }> {
  const values: Array<{ value: ProtocolJsonValue; range: SourceRange }> = [];
  for (let index = 0; index < source.length; index += 1) {
    if ((source[index] !== '{' && source[index] !== '[') || isExcluded(index, excluded)) continue;
    const range = extractBalanced(source, index);
    if (!range) continue;
    try {
      const value = JSON.parse(source.slice(range.start, range.end)) as ProtocolJsonValue;
      values.push({ value, range });
    } catch {
      // Request examples are often JavaScript/Python literals rather than strict JSON.
    }
    index = range.end - 1;
  }
  return values;
}

function parseHeaderLines(source: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*([^:\s][^:]*):\s*(.+?)\s*$/.exec(line);
    if (!match || /^(?:https?|const|let|var)$/i.test(match[1])) continue;
    headers[match[1].trim()] = match[2].trim();
  }
  return headers;
}

function parseHeaderObject(value: ProtocolJsonValue | undefined): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function inferBodyEncoding(headers: Record<string, string>, body: ProtocolJsonValue | undefined): ModelProtocolBodyEncoding | undefined {
  if (body === undefined) return undefined;
  const contentType = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.toLowerCase() ?? '';
  if (contentType.includes('multipart/form-data')) return 'multipart';
  if (contentType.includes('application/x-www-form-urlencoded')) return 'form-urlencoded';
  return 'json';
}

function requestFormatNear(source: string, offset: number): RequestAnchor['format'] {
  const nearby = source.slice(offset, offset + 2000);
  if (/\b(?:requests|httpx)\.(?:get|post)\s*\(/i.test(nearby)) return 'python';
  if (/\baxios\.(?:get|post)\s*\(/i.test(nearby)) return 'axios';
  return 'fetch';
}

function collectCodeRequestAnchors(source: string): RequestAnchor[] {
  const anchors: RequestAnchor[] = [];
  for (const match of source.matchAll(REQUEST_URL_ASSIGNMENT_RE)) {
    anchors.push({
      start: match.index,
      url: match[2],
      format: requestFormatNear(source, match.index),
    });
  }
  for (const match of source.matchAll(DIRECT_FETCH_RE)) {
    anchors.push({ start: match.index, url: match[2], format: 'fetch' });
  }
  for (const match of source.matchAll(DIRECT_CLIENT_RE)) {
    anchors.push({
      start: match.index,
      url: match[3],
      format: /^axios/i.test(match[0]) ? 'axios' : 'python',
    });
  }
  return anchors
    .sort((left, right) => left.start - right.start)
    .filter((anchor, index, items) => index === 0 || anchor.start !== items[index - 1].start);
}

function parseCodeRequests(source: string): ParsedRequest[] {
  const anchors = collectCodeRequestAnchors(source);
  return anchors.map((anchor, index) => {
    const segment = source.slice(anchor.start, anchors[index + 1]?.start ?? source.length);
    const bodyLiteral = findAssignedLiteral(segment, ['payload', 'body', 'data', 'json']);
    const headerLiteral = findAssignedLiteral(segment, ['headers', 'header']);
    const methodMatch = HTTP_METHOD_RE.exec(segment)
      ?? /\b(?:axios|requests|httpx)\.(get|post)\s*\(/i.exec(segment);
    const methodText = methodMatch?.[2] ?? methodMatch?.[1];
    const method = String(methodText || (bodyLiteral.value === undefined ? 'GET' : 'POST')).toUpperCase() as ModelProtocolHttpMethod;
    const headers = parseHeaderObject(headerLiteral.value);
    const excluded = [bodyLiteral.range, headerLiteral.range].filter((range): range is SourceRange => !!range);
    const responses = findStrictJsonValues(segment, excluded);
    return {
      start: anchor.start,
      url: anchor.url,
      method,
      headers,
      query: {},
      body: bodyLiteral.value,
      bodyEncoding: inferBodyEncoding(headers, bodyLiteral.value),
      response: responses[0]?.value,
      format: anchor.format,
    };
  });
}

function collectCurlStarts(source: string): number[] {
  return [...source.matchAll(/(?:^|\n)\s*curl\b/g)].map((match) => match.index + match[0].indexOf('curl'));
}

function parseCurlRequests(source: string): ParsedRequest[] {
  const starts = collectCurlStarts(source);
  return starts.flatMap((start, index) => {
    const segment = source.slice(start, starts[index + 1] ?? source.length);
    const urlMatch = /https?:\/\/[^\s'"\\]+/.exec(segment);
    if (!urlMatch) return [];
    const bodyMatch = /(?:^|\s)(?:-d|--data(?:-raw)?|--data-binary)\s+(["'])([\s\S]*?)\1/.exec(segment);
    const body = bodyMatch ? parseLooseLiteral(bodyMatch[2]) : undefined;
    const bodyRange = bodyMatch && bodyMatch.index >= 0
      ? { start: bodyMatch.index + bodyMatch[0].indexOf(bodyMatch[2]), end: bodyMatch.index + bodyMatch[0].indexOf(bodyMatch[2]) + bodyMatch[2].length }
      : undefined;
    const headers: Record<string, string> = {};
    for (const match of segment.matchAll(/(?:-H|--header)\s+(["'])([\s\S]*?)\1/g)) {
      const separator = match[2].indexOf(':');
      if (separator > 0) headers[match[2].slice(0, separator).trim()] = match[2].slice(separator + 1).trim();
    }
    const explicitMethod = /(?:-X|--request)\s+(GET|POST)/i.exec(segment)?.[1];
    const method = String(explicitMethod || (body === undefined ? 'GET' : 'POST')).toUpperCase() as ModelProtocolHttpMethod;
    const responses = findStrictJsonValues(segment, bodyRange ? [bodyRange] : []);
    return [{
      start,
      url: urlMatch[0],
      method,
      headers,
      query: {},
      body,
      bodyEncoding: inferBodyEncoding(headers, body),
      response: responses[0]?.value,
      format: 'curl' as const,
    }];
  });
}

function parseRawHttpRequests(source: string): ParsedRequest[] {
  const requestMatches = [...source.matchAll(/^(GET|POST)\s+(\S+)\s+HTTP\/\d(?:\.\d)?\s*$/gim)];
  return requestMatches.flatMap((match, index) => {
    const segment = source.slice(match.index, requestMatches[index + 1]?.index ?? source.length);
    const responseIndex = segment.search(/^HTTP\/\d(?:\.\d)?\s+\d+/im);
    const requestPart = responseIndex >= 0 ? segment.slice(0, responseIndex) : segment;
    const responsePart = responseIndex >= 0 ? segment.slice(responseIndex) : '';
    const separator = requestPart.search(/\r?\n\s*\r?\n/);
    const headerPart = separator >= 0 ? requestPart.slice(0, separator) : requestPart;
    const bodyPart = separator >= 0 ? requestPart.slice(separator).replace(/^\s+/, '') : '';
    const headers = parseHeaderLines(headerPart);
    const host = Object.entries(headers).find(([name]) => name.toLowerCase() === 'host')?.[1];
    if (!host) return [];
    const bodyValues = findStrictJsonValues(bodyPart);
    const responseSeparator = responsePart.search(/\r?\n\s*\r?\n/);
    const responseBody = responseSeparator >= 0 ? responsePart.slice(responseSeparator).replace(/^\s+/, '') : responsePart;
    const responseValues = findStrictJsonValues(responseBody);
    return [{
      start: match.index,
      url: `https://${host}${match[2]}`,
      method: match[1].toUpperCase() as ModelProtocolHttpMethod,
      headers,
      query: {},
      body: bodyValues[0]?.value,
      bodyEncoding: inferBodyEncoding(headers, bodyValues[0]?.value),
      response: responseValues[0]?.value,
      format: 'raw-http' as const,
    }];
  });
}

function firstContentExample(value: unknown): ProtocolJsonValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const contentValue of Object.values(value)) {
    if (!contentValue || typeof contentValue !== 'object' || Array.isArray(contentValue)) continue;
    const content = contentValue as Record<string, unknown>;
    if (content.example !== undefined) return content.example as ProtocolJsonValue;
    if (content.examples && typeof content.examples === 'object' && !Array.isArray(content.examples)) {
      const firstExample = Object.values(content.examples)[0];
      if (firstExample && typeof firstExample === 'object' && !Array.isArray(firstExample)) {
        const exampleValue = (firstExample as Record<string, unknown>).value;
        if (exampleValue !== undefined) return exampleValue as ProtocolJsonValue;
      }
    }
  }
  return undefined;
}

function parseOpenApiRequests(source: string): ParsedRequest[] {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    return [];
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return [];
  const root = document as Record<string, unknown>;
  if (typeof root.openapi !== 'string' || !root.paths || typeof root.paths !== 'object' || Array.isArray(root.paths)) return [];
  const serverEntry = Array.isArray(root.servers) ? root.servers[0] : undefined;
  const serverUrl = serverEntry && typeof serverEntry === 'object' && !Array.isArray(serverEntry)
    ? (serverEntry as Record<string, unknown>).url
    : undefined;
  if (typeof serverUrl !== 'string') return [];
  const securitySchemes = root.components && typeof root.components === 'object' && !Array.isArray(root.components)
    ? (root.components as Record<string, unknown>).securitySchemes
    : undefined;
  const hasBearerAuth = securitySchemes && typeof securitySchemes === 'object' && !Array.isArray(securitySchemes)
    && Object.values(securitySchemes).some((scheme) => {
      if (!scheme || typeof scheme !== 'object' || Array.isArray(scheme)) return false;
      const record = scheme as Record<string, unknown>;
      return record.type === 'http' && String(record.scheme).toLowerCase() === 'bearer';
    });
  for (const [path, pathValue] of Object.entries(root.paths as Record<string, unknown>)) {
    if (!pathValue || typeof pathValue !== 'object' || Array.isArray(pathValue)) continue;
    for (const method of ['post', 'get'] as const) {
      const operation = (pathValue as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
      const operationRecord = operation as Record<string, unknown>;
      const requestBody = operationRecord.requestBody && typeof operationRecord.requestBody === 'object' && !Array.isArray(operationRecord.requestBody)
        ? operationRecord.requestBody as Record<string, unknown>
        : undefined;
      const body = firstContentExample(requestBody?.content);
      const responses = operationRecord.responses && typeof operationRecord.responses === 'object' && !Array.isArray(operationRecord.responses)
        ? operationRecord.responses as Record<string, unknown>
        : {};
      const successResponse = Object.entries(responses)
        .find(([status]) => /^2\d\d$/.test(status))?.[1];
      const responseRecord = successResponse && typeof successResponse === 'object' && !Array.isArray(successResponse)
        ? successResponse as Record<string, unknown>
        : undefined;
      return [{
        start: 0,
        url: `${serverUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`,
        method: method.toUpperCase() as ModelProtocolHttpMethod,
        headers: hasBearerAuth
          ? { Authorization: 'Bearer <token>', 'Content-Type': 'application/json' }
          : { 'Content-Type': 'application/json' },
        query: {},
        body,
        bodyEncoding: body === undefined ? undefined : 'json',
        response: firstContentExample(responseRecord?.content),
        format: 'openapi',
      }];
    }
  }
  return [];
}

function extractRequests(source: string): ParsedRequest[] {
  const openApiRequests = parseOpenApiRequests(source);
  if (openApiRequests.length > 0) return openApiRequests;
  const rawRequests = parseRawHttpRequests(source);
  if (rawRequests.length > 0) return rawRequests;
  const curlRequests = parseCurlRequests(source);
  if (curlRequests.length > 0) return curlRequests;
  return parseCodeRequests(source);
}

function parseUrl(request: ParsedRequest): URL {
  const url = new URL(request.url);
  for (const [key, value] of url.searchParams.entries()) request.query[key] = value;
  url.search = '';
  return url;
}

function inferBaseUrl(urls: URL[]): BaseUrlResolution | undefined {
  if (urls.length === 0 || urls.some((url) => url.origin !== urls[0].origin)) return undefined;
  const pathSegments = urls.map((url) => url.pathname.split('/').filter(Boolean));
  let common: string[] = [];
  if (pathSegments.length > 1) {
    const limit = Math.min(...pathSegments.map((segments) => segments.length));
    for (let index = 0; index < limit; index += 1) {
      if (pathSegments.every((segments) => segments[index] === pathSegments[0][index])) common.push(pathSegments[0][index]);
      else break;
    }
  } else {
    common = pathSegments[0].filter((segment, index) =>
      index === 0 ? API_PREFIX_SEGMENT_RE.test(segment) : API_PREFIX_SEGMENT_RE.test(segment));
  }
  const lastVersionIndex = common.findLastIndex((segment) => API_PREFIX_SEGMENT_RE.test(segment));
  common = lastVersionIndex >= 0 ? common.slice(0, lastVersionIndex + 1) : [];
  const prefix = common.length > 0 ? `/${common.join('/')}` : '';
  return { baseUrl: `${urls[0].origin}${prefix}`, prefix };
}

function relativeRequestPath(url: URL, prefix: string): string {
  return relativePathname(url.pathname, prefix);
}

function relativePathname(pathname: string, prefix: string): string {
  if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    const relative = pathname.slice(prefix.length);
    return relative || '/';
  }
  return pathname || '/';
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapBodyValue(
  key: string,
  value: ProtocolJsonValue,
  category: GeneralModelCategory,
): ProtocolJsonValue {
  const normalized = normalizedKey(key);
  if (['model', 'modelid', 'modelname'].includes(normalized)) return '{{model}}';
  if (['prompt', 'inputprompt', 'textprompt', 'description'].includes(normalized)) return '{{prompt}}';
  if (normalized === 'messages') return '{{messages}}';
  if (normalized === 'stream') return '{{stream}}';
  if (normalized === 'tools') return '{{tools}}';
  if (normalized === 'toolchoice') return '{{toolChoice}}';
  if (normalized === 'size') {
    if (typeof value === 'string' && /^\d+\s*:\s*\d+$/.test(value)) return '{{aspectRatio}}';
    return '{{size}}';
  }
  if (['aspectratio', 'ratio'].includes(normalized)) return '{{aspectRatio}}';
  if (normalized === 'resolution') return category === 'image' ? '{{imageSize}}' : '{{seedanceResolution}}';
  if (['imagesize', 'quality'].includes(normalized)) return '{{imageSize}}';
  if (normalized === 'width') return '{{width}}';
  if (normalized === 'height') return '{{height}}';
  if (['n', 'count', 'numimages', 'batchcount'].includes(normalized)) return '{{n}}';
  if (['numframes', 'frames', 'framecount'].includes(normalized)) return '{{frames8n1}}';
  if (['framerate', 'fps'].includes(normalized)) return '{{fps}}';
  if (['duration', 'seconds', 'videoduration'].includes(normalized)) return '{{duration}}';
  if (normalized === 'generateaudio') return '{{generateAudio}}';
  if (['voice', 'audiovoice'].includes(normalized)) return '{{audioVoice}}';
  if (['format', 'audioformat', 'responseformat'].includes(normalized) && category === 'audio') return '{{audioFormat}}';
  if (['speed', 'audiospeed'].includes(normalized) && category === 'audio') return '{{audioSpeed}}';
  if (['imageurls', 'images', 'referenceimages'].includes(normalized)) return '{{imageUrls}}';
  if (['image', 'inputimage', 'referenceimage', 'firstframeimage'].includes(normalized)) return '{{imageUrls.0}}';
  if (Array.isArray(value)) return value.map((item) => mapNestedBody(item, category));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value)
    .map(([nestedKey, nestedValue]) => [nestedKey, mapBodyValue(nestedKey, nestedValue, category)]));
  return value;
}

function mapNestedBody(value: ProtocolJsonValue, category: GeneralModelCategory): ProtocolJsonValue {
  if (Array.isArray(value)) return value.map((item) => mapNestedBody(item, category));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, mapBodyValue(key, item, category)]));
  return value;
}

function mapRequestBody(body: ProtocolJsonValue | undefined, category: GeneralModelCategory): ProtocolJsonValue | undefined {
  if (!isRecord(body)) return body;
  return Object.fromEntries(Object.entries(body)
    .filter(([key]) => !isCredentialKey(key))
    .map(([key, value]) => [key, mapBodyValue(key, value, category)]));
}

function isCredentialKey(key: string): boolean {
  return ['apikey', 'accesstoken', 'authorization', 'secret', 'token'].includes(normalizedKey(key));
}

function containsBodyCredential(value: ProtocolJsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.some(containsBodyCredential);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => isCredentialKey(key) || containsBodyCredential(item));
}

function findModelId(body: ProtocolJsonValue | undefined): string | undefined {
  if (!isRecord(body)) return undefined;
  const entry = Object.entries(body).find(([key, value]) =>
    ['model', 'modelid', 'modelname'].includes(normalizedKey(key)) && typeof value === 'string');
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function enumerateLeaves(value: unknown, path = ''): PathLeaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => enumerateLeaves(item, path ? `${path}.${index}` : String(index)));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      enumerateLeaves(item, path ? `${path}.${key}` : key));
  }
  const segments = path.split('.');
  return path ? [{ path, key: segments[segments.length - 1], value }] : [];
}

function wildcardArrayPath(path: string): string {
  return path.split('.').map((segment) => /^\d+$/.test(segment) ? '*' : segment).join('.');
}

function selectLeaf(
  leaves: PathLeaf[],
  score: (leaf: PathLeaf) => number,
): PathLeaf | undefined {
  return leaves
    .map((leaf) => ({ leaf, score: score(leaf) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.leaf;
}

function inferCategory(request: ParsedRequest, response: ProtocolJsonValue | undefined): GeneralModelCategory {
  const path = new URL(request.url).pathname.toLowerCase();
  const bodyKeys = isRecord(request.body) ? Object.keys(request.body).map(normalizedKey) : [];
  const responseUrls = enumerateLeaves(response).filter((leaf) => typeof leaf.value === 'string' && URL_VALUE_RE.test(leaf.value));
  if (/\b(?:videos?|video-generation)\b/.test(path) || bodyKeys.some((key) => ['numframes', 'framerate', 'videoduration'].includes(key))) return 'video';
  if (/\b(?:audio|speech|music|transcriptions?)\b/.test(path) || bodyKeys.some((key) => ['voice', 'audiovoice', 'audioformat'].includes(key))) return 'audio';
  if (/\b(?:images?|image-generation)\b/.test(path) || responseUrls.some((leaf) => /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(String(leaf.value)))) return 'image';
  return 'text';
}

function inferAuthentication(requests: ParsedRequest[]): ModelProtocolAuthConfig {
  for (const request of requests) {
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() === 'authorization') {
        const prefix = value.match(/^([^<{]*?)(?:<|\{\{|\$\{|YOUR_|sk-)/i)?.[1];
        return { type: 'bearer', ...(prefix && prefix !== 'Bearer ' ? { prefix } : {}) };
      }
      if (/(?:api[-_]?key|token|authorization)/i.test(name) || AUTH_VALUE_RE.test(value)) {
        return { type: 'header', name };
      }
    }
    const authQuery = Object.keys(request.query).find((key) => /(?:api[-_]?key|access[-_]?token|token)/i.test(key));
    if (authQuery) return { type: 'query', name: authQuery };
  }
  return { type: 'none' };
}

function safeHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(headers).filter(([name, value]) => {
    const normalized = name.toLowerCase();
    if (['authorization', 'content-type', 'host', 'content-length'].includes(normalized)) return false;
    if (/(?:api[-_]?key|token)/i.test(name) || AUTH_VALUE_RE.test(value)) return false;
    return true;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function inferPreferredTaskKey(pollRequest: ParsedRequest | undefined): string | undefined {
  if (!pollRequest) return undefined;
  const queryKey = Object.keys(pollRequest.query).find((key) => /(?:task|job|video|request|prediction).*id|^id$/i.test(key));
  if (queryKey) return normalizedKey(queryKey);
  const segments = new URL(pollRequest.url).pathname.split('/').filter(Boolean);
  const containerIndex = segments.findIndex((segment) => TASK_CONTAINER_RE.test(segment));
  return containerIndex >= 0 ? 'taskid' : undefined;
}

function inferTaskIdPath(response: ProtocolJsonValue | undefined, preferredKey?: string): string | undefined {
  const leaves = enumerateLeaves(response);
  return selectLeaf(leaves, (leaf) => {
    if (typeof leaf.value !== 'string') return 0;
    const key = normalizedKey(leaf.key);
    let score = 0;
    if (preferredKey && key === preferredKey) score += 120;
    if (['taskid', 'videoid', 'jobid', 'predictionid', 'requestid'].includes(key)) score += 100;
    else if (key === 'id') score += 45;
    if (/task|video|job|prediction|request/i.test(String(leaf.value))) score += 20;
    return score;
  })?.path;
}

function inferStatusPath(response: ProtocolJsonValue | undefined): string | undefined {
  return selectLeaf(enumerateLeaves(response), (leaf) => {
    if (typeof leaf.value !== 'string') return 0;
    const key = normalizedKey(leaf.key);
    if (key === 'status') return 100;
    if (['state', 'phase'].includes(key)) return 75;
    return 0;
  })?.path;
}

function inferProgressPath(response: ProtocolJsonValue | undefined): string | undefined {
  return selectLeaf(enumerateLeaves(response), (leaf) =>
    ['progress', 'percentage', 'percent'].includes(normalizedKey(leaf.key)) && typeof leaf.value === 'number' ? 100 : 0)?.path;
}

function inferErrorPath(response: ProtocolJsonValue | undefined): string | undefined {
  return selectLeaf(enumerateLeaves(response), (leaf) => {
    const key = normalizedKey(leaf.key);
    if (key === 'error') return 100;
    if (key === 'message' && /error|fail/i.test(leaf.path)) return 90;
    if (['errormessage', 'detail'].includes(key)) return 75;
    return 0;
  })?.path;
}

function inferUrlPath(response: ProtocolJsonValue | undefined): string | undefined {
  const leaf = selectLeaf(enumerateLeaves(response), (candidate) => {
    if (typeof candidate.value !== 'string' || !URL_VALUE_RE.test(candidate.value)) return 0;
    let score = normalizedKey(candidate.key) === 'url' ? 100 : 45;
    if (/result|output|data/i.test(candidate.path)) score += 25;
    if (/\.(?:png|jpe?g|webp|mp4|webm|mov|mp3|wav|flac)(?:\?|$)/i.test(candidate.value)) score += 20;
    return score;
  });
  return leaf ? wildcardArrayPath(leaf.path) : undefined;
}

function inferTextPath(response: ProtocolJsonValue | undefined): string | undefined {
  const leaf = selectLeaf(enumerateLeaves(response), (candidate) => {
    if (typeof candidate.value !== 'string' || URL_VALUE_RE.test(candidate.value)) return 0;
    const key = normalizedKey(candidate.key);
    let score = ['content', 'text', 'output', 'answer'].includes(key) ? 80 : 0;
    if (/choices|message|result/i.test(candidate.path)) score += 30;
    if (/status|error|id/i.test(candidate.path)) score -= 50;
    return score;
  });
  return leaf ? wildcardArrayPath(leaf.path) : undefined;
}

function inferBase64Path(response: ProtocolJsonValue | undefined): string | undefined {
  const leaf = selectLeaf(enumerateLeaves(response), (candidate) =>
    ['b64json', 'base64', 'base64data'].includes(normalizedKey(candidate.key)) && typeof candidate.value === 'string' ? 100 : 0);
  return leaf ? wildcardArrayPath(leaf.path) : undefined;
}

function withTaskPlaceholder(
  pollUrl: URL,
  query: Record<string, ProtocolJsonValue>,
  warnings: string[],
): { path: string; query: Record<string, ProtocolJsonValue>; preferredKey?: string } {
  const nextQuery = { ...query };
  const queryKey = Object.keys(nextQuery).find((key) => /(?:task|job|video|request|prediction).*id|^id$/i.test(key));
  if (queryKey) {
    nextQuery[queryKey] = '{{submit.task_id}}';
    return { path: pollUrl.pathname, query: nextQuery, preferredKey: normalizedKey(queryKey) };
  }
  const segments = pollUrl.pathname.split('/').filter(Boolean);
  const containerIndex = segments.findIndex((segment) => TASK_CONTAINER_RE.test(segment));
  if (containerIndex >= 0 && segments[containerIndex + 1]) {
    segments[containerIndex + 1] = '{{submit.task_id}}';
    return { path: `/${segments.join('/')}`, query: nextQuery, preferredKey: 'taskid' };
  }
  warnings.push('未能确定轮询请求中的任务 ID 位置，请手动检查轮询 path 或 query。');
  return { path: pollUrl.pathname, query: nextQuery };
}

function omitEmptyRecord(value: Record<string, ProtocolJsonValue>): Record<string, ProtocolJsonValue> | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function buildFields(result: Omit<ModelProtocolImportResult, 'fields'>): ModelProtocolImportField[] {
  const fields: ModelProtocolImportField[] = [];
  const add = (id: string, label: string, value: string | undefined, confidence = result.confidence) => {
    if (value) fields.push({ id, label, value, confidence });
  };
  add('base-url', '连接地址', result.baseUrl);
  add('model', '模型 ID', result.modelId);
  add('category', '模型分类', result.category);
  add('submit', '提交请求', result.protocol ? `${result.protocol.submit.method} ${result.protocol.submit.path}` : undefined);
  add('task-id', '任务 ID 路径', result.protocol?.response.taskIdPath);
  add('poll', '查询请求', result.protocol?.poll ? `${result.protocol.poll.method} ${result.protocol.poll.path}` : undefined);
  add('status', '状态路径', result.protocol?.poll?.response.statusPath);
  add('result', '结果路径', result.protocol?.mode === 'async'
    ? result.protocol.poll?.response.result.urlPath ?? result.protocol.poll?.response.result.textPath
    : result.protocol?.response.result?.urlPath ?? result.protocol?.response.result?.textPath);
  return fields;
}

function confidenceLabel(score: number): ModelProtocolImportConfidence {
  if (score >= 0.82) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

export function analyzeModelProtocolExamples(
  examples: ModelProtocolExamples,
  options: ModelProtocolImportOptions = {},
): ModelProtocolImportResult {
  const submitRequest = examples.submitRequest.trim();
  const submitResponse = examples.submitResponse.trim();
  const pollRequest = examples.pollRequest?.trim() ?? '';
  const pollResponse = examples.pollResponse?.trim() ?? '';
  if (!submitRequest) throw new Error('请填写提交请求示例');
  if (!submitResponse) throw new Error('请填写提交响应示例');
  if (!!pollRequest !== !!pollResponse) throw new Error('轮询请求示例和轮询响应示例必须同时填写');
  return analyzeModelProtocolDocument([
    submitRequest,
    submitResponse,
    ...(pollRequest ? [pollRequest, pollResponse] : []),
  ].join('\n\n'), options);
}

export function analyzeModelProtocolDocument(
  source: string,
  options: ModelProtocolImportOptions = {},
): ModelProtocolImportResult {
  const normalizedSource = source.replace(/\r\n/g, '\n').trim();
  if (!normalizedSource) throw new Error('请先粘贴接口文档或请求示例');
  const requests = extractRequests(normalizedSource).sort((left, right) => left.start - right.start);
  if (requests.length === 0) {
    if (/^\s*(?:openapi|swagger)\s*:/im.test(normalizedSource)) {
      throw new Error('检测到 OpenAPI YAML；当前版本请粘贴 JSON 格式规范或文档中的请求/响应代码块');
    }
    throw new Error('没有识别到请求示例，请粘贴 Fetch、Axios、cURL、Python requests、Raw HTTP 或 OpenAPI JSON');
  }

  const warnings: string[] = [];
  const formats = unique<ModelProtocolImportFormat>([
    ...requests.map((request) => request.format),
    ...(requests.some((request) => request.response !== undefined) ? ['json' as const] : []),
  ]);
  const urls = requests.map(parseUrl);
  const baseResolution = inferBaseUrl(urls);
  if (!baseResolution) warnings.push('检测到多个不同域名，请确认提交和查询接口是否属于同一连接。');

  const submitRequest = requests[0];
  const pollRequest = requests[1];
  const submitResponse = submitRequest.response;
  const pollResponse = pollRequest?.response;
  const category = options.category ?? inferCategory(submitRequest, pollResponse ?? submitResponse);
  const modelId = findModelId(submitRequest.body);
  if (!modelId) warnings.push('未从请求体识别到模型 ID，需要手动填写模型。');
  if (!submitResponse) warnings.push('未识别到提交响应示例，无法可靠推断返回值路径。');
  if (isRecord(submitRequest.body) && Object.keys(submitRequest.body).some((key) => CALLBACK_KEY_RE.test(key))) {
    warnings.push('检测到 Webhook/回调地址；当前声明式协议不支持等待外部回调，请改用可轮询的查询接口。');
  }
  const usesBodyCredential = containsBodyCredential(submitRequest.body)
    || requests.slice(1).some((request) => containsBodyCredential(request.body));
  if (usesBodyCredential) {
    warnings.push('检测到请求体鉴权字段；当前协议只支持 Header、Bearer 或 Query 鉴权，已移除密钥且禁止直接应用。');
  }

  const auth = inferAuthentication(requests);
  const prefix = baseResolution?.prefix ?? '';
  const submitUrl = urls[0];
  const submitQuery = { ...submitRequest.query };
  if (auth.type === 'query' && auth.name) delete submitQuery[auth.name];
  const submit = {
    method: submitRequest.method,
    path: relativeRequestPath(submitUrl, prefix),
    ...(safeHeaders(submitRequest.headers) ? { headers: safeHeaders(submitRequest.headers) } : {}),
    ...(omitEmptyRecord(submitQuery) ? { query: omitEmptyRecord(submitQuery) } : {}),
    ...(submitRequest.bodyEncoding ? { bodyEncoding: submitRequest.bodyEncoding } : {}),
    ...(submitRequest.body !== undefined ? { body: mapRequestBody(submitRequest.body, category) } : {}),
  };

  const preferredTaskKey = inferPreferredTaskKey(pollRequest);
  const taskIdPath = inferTaskIdPath(submitResponse, preferredTaskKey);
  const asynchronous = !!pollRequest && !!pollResponse && !!taskIdPath;
  let protocol: NormalizedModelExecutionProtocol | undefined;

  if (asynchronous && baseResolution) {
    const pollUrl = urls[1];
    const pollQuery = { ...pollRequest.query };
    if (auth.type === 'query' && auth.name) delete pollQuery[auth.name];
    const templated = withTaskPlaceholder(pollUrl, pollQuery, warnings);
    const statusPath = inferStatusPath(pollResponse);
    const urlPath = inferUrlPath(pollResponse);
    const textPath = category === 'text' ? inferTextPath(pollResponse) : undefined;
    const base64Path = inferBase64Path(pollResponse);
    if (!statusPath) warnings.push('未从查询响应识别到任务状态路径。');
    if (!urlPath && !textPath && !base64Path) warnings.push('未从查询响应识别到结果 URL、文本或 Base64 路径。');
    if (statusPath && (urlPath || textPath || base64Path)) {
      protocol = {
        version: 2,
        mode: 'async',
        auth,
        submit,
        response: {
          type: 'json',
          taskIdPath,
          ...(inferErrorPath(submitResponse) ? { errorPath: inferErrorPath(submitResponse) } : {}),
        },
        poll: {
          method: pollRequest.method,
          path: relativePathname(templated.path, prefix),
          ...(safeHeaders(pollRequest.headers) ? { headers: safeHeaders(pollRequest.headers) } : {}),
          ...(omitEmptyRecord(templated.query) ? { query: omitEmptyRecord(templated.query) } : {}),
          ...(pollRequest.bodyEncoding ? { bodyEncoding: pollRequest.bodyEncoding === 'multipart' ? 'json' : pollRequest.bodyEncoding } : {}),
          ...(pollRequest.body !== undefined ? { body: mapRequestBody(pollRequest.body, category) } : {}),
          response: {
            statusPath,
            successValues: ['completed', 'succeeded', 'success', 'done'],
            failureValues: ['failed', 'error', 'canceled', 'cancelled'],
            result: {
              ...(urlPath ? { urlPath } : {}),
              ...(textPath ? { textPath } : {}),
              ...(base64Path ? { base64Path, mimeType: category === 'image' ? 'image/png' : 'application/octet-stream' } : {}),
            },
            ...(inferErrorPath(pollResponse) ? { errorPath: inferErrorPath(pollResponse) } : {}),
            ...(inferProgressPath(pollResponse) ? { progressPath: inferProgressPath(pollResponse) } : {}),
          },
          intervalMs: 3000,
        },
      };
    }
  } else if (submitResponse && baseResolution) {
    if (taskIdPath) {
      warnings.push('提交响应包含任务 ID，但未识别到完整的查询请求和查询响应，暂不能生成异步协议。');
    } else {
      const urlPath = inferUrlPath(submitResponse);
      const textPath = category === 'text' ? inferTextPath(submitResponse) : undefined;
      const base64Path = inferBase64Path(submitResponse);
      if (!urlPath && !textPath && !base64Path) warnings.push('未从同步响应识别到结果 URL、文本或 Base64 路径。');
      if (urlPath || textPath || base64Path) {
        protocol = {
          version: 2,
          mode: 'sync',
          auth,
          submit,
          response: {
            type: 'json',
            result: {
              ...(urlPath ? { urlPath } : {}),
              ...(textPath ? { textPath } : {}),
              ...(base64Path ? { base64Path, mimeType: category === 'image' ? 'image/png' : 'application/octet-stream' } : {}),
            },
            ...(inferErrorPath(submitResponse) ? { errorPath: inferErrorPath(submitResponse) } : {}),
          },
        };
      }
    }
  }

  if (warnings.some((warning) => warning.includes('Webhook/回调'))) protocol = undefined;
  if (usesBodyCredential) protocol = undefined;
  if (protocol) {
    const protocolErrors = validateModelExecutionProtocol(protocol);
    if (protocolErrors.length > 0) {
      warnings.push(`生成的协议未通过校验：${protocolErrors[0]}`);
      protocol = undefined;
    }
  }

  let score = 1;
  if (!baseResolution) score -= 0.35;
  if (!modelId) score -= 0.2;
  if (!protocol) score -= 0.35;
  score -= Math.min(0.24, warnings.length * 0.06);
  if (formats.includes('raw-http')) score -= 0.05;
  const confidence = confidenceLabel(score);
  const resultWithoutFields = {
    baseUrl: baseResolution?.baseUrl,
    modelId,
    category,
    protocol,
    confidence,
    formats,
    warnings,
  };
  return { ...resultWithoutFields, fields: buildFields(resultWithoutFields) };
}
