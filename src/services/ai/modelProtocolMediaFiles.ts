import type { MediaReferenceKind, ModelExecutionProtocol, ProtocolJsonValue } from '../../types/aiTypes';
import { isRemoteMediaUrl } from '../../utils/mediaUrl';
import {
  createMediaDataUrlBudget, readFileToDataUrl, type MediaDataUrlBudget,
  assertMediaDataUrlWithinLimitAsync, consumeMediaDataUrlBudgetBytes,
} from '../fileService';
import { MEDIA_DATA_URL_BYTE_LIMITS } from '../mediaDataUrl';
import { corsSafeFetch } from './httpTransport';
import { IMAGE_GENERATION_DATA_URL_BUDGET, resolveImageDataUrlArray } from './imageUtils';
import { readBinaryModelProtocolResult } from './modelProtocolHttp';
import { readModelProtocolPathValues } from './modelProtocolResponse';
import {
  collectModelProtocolTemplatePaths, FULL_TEMPLATE_RE, isRecord, WHEN_PRESENT_KEY, CONDITIONAL_VALUE_KEY, visitTemplateStrings,
} from './modelProtocolShared';
import { PREPARED_MULTIPART_FILES } from './modelProtocolTemplate';
import type { ModelProtocolVariables } from './modelProtocolTypes';
import { REFERENCE_PROTOCOL_VARIABLES } from './modelProtocolVariables';

const fileKinds: Readonly<Record<string, MediaReferenceKind>> = {
  imageUrls: 'image', referenceImageUrls: 'image', firstImage: 'image', lastImage: 'image',
  videoUrls: 'video', referenceVideoUrls: 'video', referenceVideoUrl: 'video',
  audioUrls: 'audio', referenceAudioUrls: 'audio', audioUrl: 'audio',
};

function inspectFileFields(protocol: ModelExecutionProtocol, variables?: ModelProtocolVariables) {
  const bindings: Array<[string, MediaReferenceKind]> = [];
  const ordinaryPaths = new Set<string>();
  const { body, bodyEncoding, headers, query, path } = protocol.submit;
  const ordinary = (value: unknown) => {
    if (variables) visitTemplateStrings(value, (template) => {
      for (const path of collectModelProtocolTemplatePaths(template)) {
        if (REFERENCE_PROTOCOL_VARIABLES.includes(path.split('.')[0])) ordinaryPaths.add(path);
      }
    });
  };
  const inspect = (part: ProtocolJsonValue) => {
    if (!isRecord(part)) return ordinary(part);
    if (Object.hasOwn(part, WHEN_PRESENT_KEY)) {
      const condition = part[WHEN_PRESENT_KEY];
      const path = typeof condition === 'string' && FULL_TEMPLATE_RE.exec(condition)?.[1];
      if (variables && path) {
        const [value] = readModelProtocolPathValues(variables, path);
        if (value == null || typeof value === 'string' && !value.trim() || Array.isArray(value) && !value.length) return;
      }
      inspect(part[CONDITIONAL_VALUE_KEY]);
      return;
    }
    const path = typeof part.$file === 'string' && FULL_TEMPLATE_RE.exec(part.$file)?.[1];
    if (path) {
      const [root, index, extra] = path.split('.');
      if (Object.hasOwn(fileKinds, root) && extra === undefined && (index === undefined || /^\d+$/.test(index))) {
        bindings.push([path, fileKinds[root]]);
        for (const [key, value] of Object.entries(part)) if (key !== '$file') ordinary(value);
        return;
      }
    }
    ordinary(part);
  };
  if (bodyEncoding === 'multipart' && isRecord(body)) {
    ordinary([headers, query, path]);
    for (const part of Object.values(body)) {
      if (Array.isArray(part)) part.forEach(inspect);
      else inspect(part);
    }
  }
  return { bindings, ordinaryPaths };
}

export function hasProtocolMediaFileFields(protocol: ModelExecutionProtocol): boolean {
  return inspectFileFields(protocol).bindings.length > 0;
}

/** 同一份素材也可以同时给文件字段和普通 URL 字段使用。 */
function collectSourceStrings(values: unknown[], sources: Set<string>) {
  for (const value of values) {
    if (typeof value === 'string') sources.add(value);
    else if (Array.isArray(value)) collectSourceStrings(value, sources);
    else if (isRecord(value)) collectSourceStrings(Object.values(value), sources);
  }
}

async function readAudioVideoFile(url: string, kind: 'video' | 'audio', budget: MediaDataUrlBudget, signal?: AbortSignal) {
  if (!isRemoteMediaUrl(url)) return readFileToDataUrl(url, { kind, signal, dataUrlBudget: budget });
  // CDN 素材也由桌面传输读取，不附带模型 Key；响应按剩余预算分段读取。
  const response = await corsSafeFetch(url, { signal, credentials: 'omit' }, { sensitive: true });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`读取参考文件失败 (HTTP ${response.status})`);
  }
  const remaining = Math.min(MEDIA_DATA_URL_BYTE_LIMITS[kind], budget.maxBytes - budget.usedBytes);
  const readBudget = { usedBytes: 0, maxBytes: remaining };
  const data = await readBinaryModelProtocolResult(response, undefined, signal, readBudget);
  consumeMediaDataUrlBudgetBytes(budget, readBudget.usedBytes);
  return data;
}

/** 只读取文件字段明确引用的媒体变量；文档里写死的路径或普通字符串不会触发读取。 */
export async function prepareProtocolMediaFileRequest<P extends ModelExecutionProtocol>(
  protocol: P,
  variables: ModelProtocolVariables,
  { signal, trial, budget = createMediaDataUrlBudget('本次请求的参考文件') }: {
    signal?: AbortSignal; trial?: boolean; budget?: MediaDataUrlBudget;
  } = {},
) {
  const boundSources = new Map<string, string | string[]>();
  const sources = new Map<string, MediaReferenceKind>();
  const { bindings, ordinaryPaths } = inspectFileFields(protocol, variables);
  for (const [path, kind] of bindings) {
    const [value] = readModelProtocolPathValues(variables, path);
    if (value == null || value === '' || Array.isArray(value) && !value.length) continue;
    if (typeof value !== 'string' && !(Array.isArray(value) && value.every((item): item is string => typeof item === 'string'))) {
      throw new Error(`文件变量 ${path} 需要一份素材或有序的素材列表`);
    }
    boundSources.set(path, value);
    for (const url of typeof value === 'string' ? [value] : value) {
      if (!url.trim() || sources.has(url) && sources.get(url) !== kind) throw new Error(`文件变量 ${path} 的素材类型或地址无效`);
      if (trial && !url.slice(0, 12).toLowerCase().startsWith(`data:${kind}/`)) {
        const remote = isRemoteMediaUrl(url) ? new URL(url) : undefined;
        if (!remote || remote.username || remote.password || /(^|\.)localhost\.?$/i.test(remote.hostname)) {
          throw new Error('试跑文件仅支持 HTTP(S) 素材地址或对应媒体类型的 data URL');
        }
      }
      sources.set(url, kind);
    }
  }

  const filesBySource = new Map<string, string>();
  const sizes = new Map<string, number>();
  const ordinarySources = new Set<string>();
  for (const path of ordinaryPaths) collectSourceStrings(readModelProtocolPathValues(variables, path), ordinarySources);
  for (const name of ['imageUrls', 'videoUrls', 'audioUrls']) {
    const selected = variables[name];
    if (Array.isArray(selected) && selected.some((url) => typeof url === 'string' && !sources.has(url) && !ordinarySources.has(url))) {
      throw new Error(`调用协议没有完整接收参考素材，请检查 ${name} 对应的文件或 URL 字段`);
    }
  }
  // 查询若也需要同一素材的 URL，仍按普通字段准备；只在查询里出现不能算提交已接收素材。
  if (protocol.poll) visitTemplateStrings(protocol.poll, (template) => {
    for (const path of collectModelProtocolTemplatePaths(template)) {
      if (REFERENCE_PROTOCOL_VARIABLES.includes(path.split('.')[0])) {
        collectSourceStrings(readModelProtocolPathValues(variables, path), ordinarySources);
      }
    }
  });
  const fileOnlySources = new Set([...sources.keys()].filter((url) => !ordinarySources.has(url)));
  const prepared = { ...variables };
  delete prepared[PREPARED_MULTIPART_FILES];
  const imageUrls = [...sources].filter(([, kind]) => kind === 'image').map(([url]) => url);
  if (imageUrls.length) {
    const images = await resolveImageDataUrlArray(imageUrls, signal, IMAGE_GENERATION_DATA_URL_BUDGET);
    imageUrls.forEach((url, index) => filesBySource.set(url, images[index]));
  }
  for (const [url, kind] of sources) {
    signal?.throwIfAborted();
    const data = kind === 'image' ? filesBySource.get(url) : await readAudioVideoFile(url, kind, budget, signal);
    if (!data || !data.slice(0, 12).toLowerCase().startsWith(`data:${kind}/`) || !/;base64,/i.test(data.slice(0, 256)) || data.endsWith(',')) {
      throw new Error(`无法读取${{ image: '图片', video: '视频', audio: '音频' }[kind]}参考文件，请检查素材后重试`);
    }
    const size = await assertMediaDataUrlWithinLimitAsync(data, kind, undefined, signal);
    if (!size) throw new Error('参考文件内容为空');
    if (kind === 'image') consumeMediaDataUrlBudgetBytes(budget, size);
    sizes.set(url, size);
    filesBySource.set(url, data);
  }
  const values: Record<string, ProtocolJsonValue> = {};
  // 同一文件可能用于两个表单字段。只读取一次，实际提交的每一份都计入预算。
  const counted = new Set<string>();
  const filePart = (url: string) => {
    if (counted.has(url)) consumeMediaDataUrlBudgetBytes(budget, sizes.get(url)!);
    counted.add(url);
    return filesBySource.get(url)!;
  };
  for (const [path] of bindings) {
    const urls = boundSources.get(path);
    if (urls !== undefined) values[path] = typeof urls === 'string' ? filePart(urls) : urls.map(filePart);
  }
  if (boundSources.size) prepared[PREPARED_MULTIPART_FILES] = values;
  signal?.throwIfAborted();
  return { protocol, variables: prepared, fileOnlySources, filesBySource };
}
