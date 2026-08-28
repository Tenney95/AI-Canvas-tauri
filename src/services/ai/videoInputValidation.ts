import type {
  NumericInputConstraint,
  VideoGenerationReferenceInput,
  VideoInputConstraints,
  VideoModelCapability,
} from '../../types/aiTypes';

export interface ReferenceMediaMetadata {
  durationSeconds?: number;
  width?: number;
}

export type ReferenceMediaMetadataProbe = (
  kind: 'video' | 'audio',
  url: string,
  signal?: AbortSignal,
) => Promise<ReferenceMediaMetadata>;

interface VideoInputValidationOptions {
  probeMediaMetadata?: ReferenceMediaMetadataProbe;
  signal?: AbortSignal;
}

const MEDIA_METADATA_TIMEOUT_MS = 12_000;

function countCharacters(value: string): number {
  return Array.from(value.trim()).length;
}

/** 返回 Base64 data URL 解码后的字节数；非 Base64 data URL 返回 undefined。 */
export function base64DataUrlDecodedBytes(value: string): number | undefined {
  const match = /^data:[^,]*;base64,([\s\S]*)$/i.exec(value);
  if (!match) return undefined;
  const payload = match[1].replace(/\s/g, '');
  if (!payload || payload.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error('参考素材中包含无效的 Base64 data URL');
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(2))} MiB`;
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(2))} KiB`;
  return `${bytes} B`;
}

function describeRangeFailure(
  value: number,
  range: NumericInputConstraint,
  unit: string,
): string | undefined {
  if (range.min !== undefined) {
    const invalid = range.minExclusive ? value <= range.min : value < range.min;
    if (invalid) return range.minExclusive ? `必须大于 ${range.min}${unit}` : `至少为 ${range.min}${unit}`;
  }
  if (range.max !== undefined) {
    const invalid = range.maxExclusive ? value >= range.max : value > range.max;
    if (invalid) return range.maxExclusive ? `必须小于 ${range.max}${unit}` : `不能超过 ${range.max}${unit}`;
  }
  return undefined;
}

function hasRangeBound(range: NumericInputConstraint | undefined): range is NumericInputConstraint {
  return range?.min !== undefined || range?.max !== undefined;
}

function needsMetadata(constraints: VideoInputConstraints | undefined, kind: 'video' | 'audio'): boolean {
  return kind === 'video'
    ? hasRangeBound(constraints?.referenceVideo?.width)
      || hasRangeBound(constraints?.referenceVideo?.durationSeconds)
      || hasRangeBound(constraints?.referenceVideo?.totalDurationSeconds)
    : hasRangeBound(constraints?.referenceAudio?.durationSeconds)
      || hasRangeBound(constraints?.referenceAudio?.totalDurationSeconds);
}

export const probeReferenceMediaMetadata: ReferenceMediaMetadataProbe = async (
  kind,
  url,
  signal,
) => {
  signal?.throwIfAborted();
  if (typeof document === 'undefined') throw new Error('当前环境无法读取媒体信息');

  return new Promise<ReferenceMediaMetadata>((resolve, reject) => {
    const media = document.createElement(kind);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute('src');
      media.load();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new DOMException('已取消', 'AbortError')));
    const timeoutId = setTimeout(
      () => finish(() => reject(new Error('读取媒体信息超时'))),
      MEDIA_METADATA_TIMEOUT_MS,
    );

    signal?.addEventListener('abort', onAbort, { once: true });
    media.preload = 'metadata';
    media.onloadedmetadata = () => finish(() => resolve({
      durationSeconds: Number.isFinite(media.duration) ? media.duration : undefined,
      width: kind === 'video' && media instanceof HTMLVideoElement && media.videoWidth > 0
        ? media.videoWidth
        : undefined,
    }));
    media.onerror = () => finish(() => reject(new Error('媒体无法加载')));
    media.src = url;
    media.load();
  });
};

async function validateMediaReferences(
  kind: 'video' | 'audio',
  urls: readonly string[],
  constraints: VideoInputConstraints,
  modelName: string,
  probe: ReferenceMediaMetadataProbe,
  signal?: AbortSignal,
): Promise<void> {
  if (!needsMetadata(constraints, kind) || urls.length === 0) return;
  const label = kind === 'video' ? '参考视频' : '参考音频';
  const metadataItems = await Promise.all(urls.map(async (url, index) => {
    try {
      return await probe(kind, url, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const detail = error instanceof Error && error.message ? `：${error.message}` : '';
      throw new Error(
        `模型 "${modelName}" 无法读取第 ${index + 1} 个${label}的信息${detail}，请更换可访问的素材`,
        { cause: error },
      );
    }
  }));

  for (const [index, metadata] of metadataItems.entries()) {
    if (kind === 'video') {
      const widthRange = constraints.referenceVideo?.width;
      if (hasRangeBound(widthRange)) {
        if (metadata.width === undefined) {
          throw new Error(`模型 "${modelName}" 无法确认第 ${index + 1} 个参考视频的宽度，请更换可读取的素材`);
        }
        const failure = describeRangeFailure(metadata.width, widthRange, ' px');
        if (failure) throw new Error(`第 ${index + 1} 个参考视频宽度为 ${metadata.width} px，${failure}`);
      }
    }

    const durationRange = kind === 'video'
      ? constraints.referenceVideo?.durationSeconds
      : constraints.referenceAudio?.durationSeconds;
    if (!hasRangeBound(durationRange)) continue;
    if (metadata.durationSeconds === undefined) {
      throw new Error(`模型 "${modelName}" 无法确认第 ${index + 1} 个${label}的时长，请更换可读取的素材`);
    }
    const failure = describeRangeFailure(metadata.durationSeconds, durationRange, ' 秒');
    if (failure) {
      throw new Error(`第 ${index + 1} 个${label}时长为 ${Number(metadata.durationSeconds.toFixed(2))} 秒，${failure}`);
    }
  }

  const totalDurationRange = kind === 'video'
    ? constraints.referenceVideo?.totalDurationSeconds
    : constraints.referenceAudio?.totalDurationSeconds;
  if (hasRangeBound(totalDurationRange)) {
    const durations: number[] = [];
    for (const metadata of metadataItems) {
      if (metadata.durationSeconds === undefined) {
        throw new Error(`模型 "${modelName}" 无法确认全部${label}的合计时长，请更换可读取的素材`);
      }
      durations.push(metadata.durationSeconds);
    }
    const totalDuration = durations.reduce((total, duration) => total + duration, 0);
    const failure = describeRangeFailure(totalDuration, totalDurationRange, ' 秒');
    if (failure) {
      throw new Error(
        `${label}合计时长为 ${Number(totalDuration.toFixed(2))} 秒，${failure}`,
      );
    }
  }
}

/** 根据模型声明，在创建远端付费任务前统一校验提示词、Base64 和参考媒体元数据。 */
export async function assertVideoInputConstraints(
  referenceInput: VideoGenerationReferenceInput,
  capability: VideoModelCapability | undefined,
  modelName: string,
  options: VideoInputValidationOptions = {},
): Promise<void> {
  const constraints = capability?.inputConstraints;
  if (!constraints) return;
  options.signal?.throwIfAborted();

  const promptMinimum = constraints.promptMinCharacters;
  if (promptMinimum !== undefined && countCharacters(referenceInput.prompt) < promptMinimum) {
    throw new Error(`模型 "${modelName}" 的提示词至少需要 ${promptMinimum} 个字符`);
  }

  const maxBase64Bytes = constraints.maxBase64DecodedBytes;
  if (maxBase64Bytes !== undefined) {
    const totalBytes = [
      ...referenceInput.imageUrls,
      ...referenceInput.videoUrls,
      ...referenceInput.audioUrls,
    ].reduce((total, url) => total + (base64DataUrlDecodedBytes(url) ?? 0), 0);
    if (totalBytes > maxBase64Bytes) {
      throw new Error(
        `模型 "${modelName}" 的 Base64 参考素材解码后合计 ${formatBytes(totalBytes)}，不能超过 ${formatBytes(maxBase64Bytes)}`,
      );
    }
  }

  const probe = options.probeMediaMetadata ?? probeReferenceMediaMetadata;
  await validateMediaReferences(
    'video',
    referenceInput.videoUrls,
    constraints,
    modelName,
    probe,
    options.signal,
  );
  await validateMediaReferences(
    'audio',
    referenceInput.audioUrls,
    constraints,
    modelName,
    probe,
    options.signal,
  );
}
