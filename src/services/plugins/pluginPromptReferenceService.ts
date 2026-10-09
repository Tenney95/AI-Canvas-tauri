/** 插件提示词引用：只向插件提供调用级句柄，正文、文件路径和媒体地址留在宿主。 */
import { lstat, open } from '@tauri-apps/plugin-fs';
import type { DramaAsset, DramaAssetLibrary } from '../../types/dramaAssets';
import { buildDramaMentionId, parseDramaMentionId } from '../../types/dramaAssets';
import type { PluginInvocationResources, PluginPromptMentionItem, PluginPromptMentionPage, PluginPromptMentionSource } from '../../types/plugin';
import { resolveDramaAssetImageRef } from '../dramaAssetPrompt';
import { decodeDataUrlBytesAsync, sha256BytesHex } from '../mediaDataUrl';
import { parseRasterImageDimensions, type RasterImageDimensions } from '../rasterImageDimensions';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import type { PluginResourceReadContext } from './pluginResourceService';

const PAGE_SIZE = 20;
const MAX_HANDLES = 256;
const MAX_ACTIVE_INVOCATIONS = 16;
const MAX_TEXT_LENGTH = 256_000;
const MAX_PREVIEW_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 16 * 1024 * 1024;
const MAX_THUMBNAIL_CHARS = 8 * 1024;
const MAX_PAGE_THUMBNAIL_CHARS = 160 * 1024;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const REF_PATTERN = /@(?:asset|drama)?\{[^}]*\}/gu;
const REF_OPEN_PATTERN = /@(?:asset|drama)?\{/u;
interface ReferenceOptions { context: PluginResourceReadContext; resources: PluginInvocationResources; signal?: AbortSignal }
interface Presentation { source?: string; crop?: PluginPromptMentionItem['thumbnailCrop']; badge?: string }
interface Candidate {
  source: PluginPromptMentionSource;
  sourceKey: string;
  label: string;
  kind: PluginPromptMentionItem['kind'];
  canonicalToken: string;
  identity: unknown;
  presentation?: Presentation;
}
interface Binding extends Candidate { item: PluginPromptMentionItem; fingerprint: string }
interface ReferenceBag { identity: string; pluginId: string; bindings: Map<string, Binding>; latest: Map<string, Binding>; globalLoaded: boolean }
const bags = new WeakMap<PluginInvocationResources, ReferenceBag>();
const invocationResources = new Map<string, Set<PluginInvocationResources>>();
let useAppStore: typeof import('../../store/useAppStore').useAppStore | undefined;

async function ensureStore(): Promise<void> {
  useAppStore ??= (await import('../../store/useAppStore')).useAppStore;
}

/** 与资源租约一起同步撤销；运行时句柄不得随窗口或 revision 继续存活。 */
export function clearPluginPromptReferences(invocationId: string): void {
  const resources = invocationResources.get(invocationId);
  if (!resources) return;
  for (const entry of resources) bags.delete(entry);
  invocationResources.delete(invocationId);
}
export function clearPluginPromptReferencesForPlugin(pluginId?: string): void {
  for (const [invocationId, resources] of invocationResources) {
    for (const entry of resources) {
      if (!pluginId || bags.get(entry)?.pluginId === pluginId) {
        bags.delete(entry);
        resources.delete(entry);
      }
    }
    if (!resources.size) invocationResources.delete(invocationId);
  }
}

function safeLabel(value: string): string {
  return value.replace(/[:{}"\\\p{Cc}]/gu, ' ').trim().slice(0, 120) || '引用';
}
function isCanonicalIdentity(value: string): boolean {
  return !!value && !/[:{}\p{Cc}]/u.test(value);
}
function isDramaAssetIdentity(value: string): boolean {
  return isCanonicalIdentity(value) && !value.includes('#');
}
function assertContext(context: PluginResourceReadContext): void {
  const state = useAppStore!.getState();
  const plugin = state.installedPlugins.find((entry) => entry.id === context.pluginId);
  if (!context.permissions.includes('prompt.references.read') || !plugin?.enabled
    || !plugin.manifest.permissions.includes('prompt.references.read') || plugin.manifest.apiVersion !== 2
    || !plugin.manifest.requiredCapabilities?.includes('prompt.mentions')
    || plugin.sourceDigest !== context.sourceDigest || plugin.revisionDigest !== context.revisionDigest) {
    throw new Error('插件提示词引用权限或 revision 已失效');
  }
  if (state.currentProjectId !== context.projectId || state.getCurrentRevision() !== context.baseRevision
    || !state.nodes.some((node) => node.id === context.nodeId)
    || context.state.currentProjectId !== context.projectId || context.state.getCurrentRevision() !== context.baseRevision) {
    throw new Error('画布已变化，插件提示词引用已撤销');
  }
}
function bagFor(options: ReferenceOptions, create: boolean): ReferenceBag | undefined {
  assertContext(options.context);
  const c = options.context;
  const identity = JSON.stringify([c.pluginId, c.sourceDigest, c.revisionDigest, c.invocationId, c.projectId, c.nodeId, c.baseRevision]);
  let bag = bags.get(options.resources);
  if (bag && bag.identity !== identity) throw new Error('提示词引用不属于当前调用');
  if (!bag && create) {
    if (!invocationResources.has(c.invocationId) && invocationResources.size >= MAX_ACTIVE_INVOCATIONS) throw new Error('同时授权提示词引用的调用不能超过 16 个');
    const resources = invocationResources.get(c.invocationId) ?? new Set<PluginInvocationResources>();
    resources.add(options.resources);
    invocationResources.set(c.invocationId, resources);
    bag = { identity, pluginId: c.pluginId, bindings: new Map(), latest: new Map(), globalLoaded: false };
    bags.set(options.resources, bag);
  }
  return bag;
}
function assertLiveBag(options: ReferenceOptions, bag: ReferenceBag): void {
  throwIfAborted(options.signal);
  assertContext(options.context);
  if (bags.get(options.resources) !== bag) throw new Error('插件提示词引用租约已撤销');
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('提示词预览已取消', 'AbortError');
}
function assertReferenceLive(options: ReferenceOptions, bag?: ReferenceBag): void {
  if (bag) assertLiveBag(options, bag);
  else { throwIfAborted(options.signal); assertContext(options.context); }
}
function safeCrop(value: PluginPromptMentionItem['thumbnailCrop']): PluginPromptMentionItem['thumbnailCrop'] {
  if (!value || ![value.x, value.y, value.width, value.height].every((number) => typeof number === 'number' && Number.isFinite(number))
    || value.x < 0 || value.y < 0 || value.width < 0.001 || value.height < 0.001
    || value.x + value.width > 1 || value.y + value.height > 1) return undefined;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
async function fingerprint(identity: unknown): Promise<string> {
  return sha256BytesHex(new TextEncoder().encode(JSON.stringify(identity)));
}
async function collectCandidates(source: PluginPromptMentionSource, options: ReferenceOptions, bag?: ReferenceBag): Promise<Candidate[]> {
  assertReferenceLive(options, bag);
  let state = useAppStore!.getState();
  if (source === 'nodes') {
    const { resolveCanvasMentionNodes } = await import('../../components/nodes/shared/mentionEditorSources');
    assertReferenceLive(options, bag);
    state = useAppStore!.getState();
    return resolveCanvasMentionNodes(options.context.nodeId, state.nodes, state.edges).flatMap((item): Candidate[] => {
      // 视频批次物料预检只识别真实节点；虚拟宫格引用暂不授权。
      if (!isCanonicalIdentity(item.id) || item.id.includes('/cell/')) return [];
      const node = state.nodes.find((entry) => entry.id === item.id);
      if (!node) return [];
      const label = safeLabel(item.label);
      return [{ source, sourceKey: item.id, label, kind: item.outputType,
        canonicalToken: `@{${item.id}:${label}}`, identity: JSON.stringify(node.data),
        presentation: { source: item.thumbnailUrl, badge: item.isSelf ? '自身'
          : Number.isSafeInteger(item.displayId) ? `#${item.displayId}` : undefined } }];
    });
  }
  if (source === 'characters') {
    const { resolveDramaMentionItems } = await import('../../components/nodes/shared/mentionEditorSources');
    assertReferenceLive(options, bag);
    state = useAppStore!.getState();
    if (bag && !bag.globalLoaded) {
      await state.loadGlobalCharacters().catch(() => { throw new Error('全局角色目录读取失败'); });
      assertReferenceLive(options, bag);
      bag.globalLoaded = true;
      state = useAppStore!.getState();
    }
    const projectIdentity = (asset: DramaAsset) => isDramaAssetIdentity(asset.id) && !asset.id.startsWith('global/');
    const all: DramaAsset[] = [...state.dramaAssets.characters.filter(projectIdentity),
      ...state.globalCharacters.filter((character) => isDramaAssetIdentity(character.id)).map((character) => ({ ...character, id: `global/${character.id}` })),
      ...state.dramaAssets.scenes.filter(projectIdentity), ...state.dramaAssets.props.filter(projectIdentity)];
    const candidates: Candidate[] = [];
    // 既有解析器每次最多 20 项，分块复用以提供完整分页而非截断到首屏。
    for (let offset = 0; offset < all.length; offset += PAGE_SIZE) {
      const chunk = all.slice(offset, offset + PAGE_SIZE);
      const library: DramaAssetLibrary = { version: 2, characters: chunk.filter((item) => item.kind === 'character'),
        scenes: chunk.filter((item) => item.kind === 'scene'), props: chunk.filter((item) => item.kind === 'prop') };
      for (const item of resolveDramaMentionItems(library, '', 'ai-video')) {
        const asset = chunk.find((entry) => entry.id === item.id)!;
        const label = safeLabel(`${item.name}${item.id.startsWith('global/') ? '（全局）' : ''}`);
        const identity = JSON.stringify([asset, state.nodes.filter((node) => node.id === asset.imageNodeId
          || (asset.kind === 'character' && asset.referenceImages?.some((reference) => reference.sourceNodeId === node.id))).map((node) => node.data)]);
        const avatarId = asset.kind === 'character' ? asset.avatarReferenceImageId : undefined;
        const avatar = asset.kind === 'character' && avatarId ? asset.referenceImages?.find((reference) => reference.id === avatarId) : undefined;
        const avatarSource = avatar?.sourceNodeId ? state.nodes.find((node) => node.id === avatar.sourceNodeId) : undefined;
        const avatarUrl = avatarSource?.data.imageUrl || avatarSource?.data.thumbnailUrl || avatar?.imageUrl;
        // 头像裁剪只应用于实际选中的头像参考图，失效时沿用默认图。
        const image = typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl : resolveDramaAssetImageRef(asset, state.nodes)?.imageUrl;
        const avatarDrawable = !!(typeof avatarUrl === 'string' && avatarUrl.trim());
        candidates.push({ source, sourceKey: item.id, label, kind: asset.kind,
          canonicalToken: `@drama{${item.id}:${safeLabel(item.name)}}`, identity,
          presentation: { source: image, crop: asset.kind === 'character' && avatarDrawable ? safeCrop(asset.avatarCrop) : undefined,
            badge: asset.kind === 'character' && (asset.referenceImages?.length ?? 0) > 1 ? `${asset.referenceImages!.length} 图`
              : !image ? '简介' : item.id.startsWith('global/') ? '全局' : undefined } });
        for (const [index, reference] of (item.referenceImages ?? []).entries()) {
          const sourceNode = state.nodes.find((node) => node.id === reference.sourceNodeId);
          const referenceUrl = sourceNode?.data.imageUrl || sourceNode?.data.thumbnailUrl || reference.imageUrl;
          if (typeof referenceUrl !== 'string' || !referenceUrl.trim() || !resolveDramaAssetImageRef(asset, state.nodes, reference.id)) continue;
          const id = buildDramaMentionId(item.id, reference.id);
          if (!isCanonicalIdentity(id) || parseDramaMentionId(id).referenceImageId !== reference.id) continue;
          candidates.push({ source, sourceKey: id, label: safeLabel(`${label} · 参考图 ${index + 1}`), kind: 'image',
            canonicalToken: `@drama{${id}:${safeLabel(item.name)}}`, identity,
            presentation: { source: referenceUrl, badge: `参考图 ${index + 1}` } });
        }
      }
    }
    return candidates;
  }
  const { listExternalFolderFiles, listGlobalFiles } = await import('../fileService');
  assertReferenceLive(options, bag);
  state = useAppStore!.getState();
  const [globalFiles, folderFiles] = await Promise.all([listGlobalFiles(), listExternalFolderFiles(state.config.assetFolders ?? [])])
    .catch(() => { throw new Error('提示词素材目录读取失败'); });
  assertReferenceLive(options, bag);
  const unique = new Map([...globalFiles, ...folderFiles].filter((entry) => entry.category === 'image' && entry.availability !== 'offline')
    .map((entry) => [entry.path, entry]));
  return [...unique.values()].map((entry) => ({ source, sourceKey: entry.path, label: safeLabel(entry.name), kind: 'image',
    canonicalToken: `@asset{${encodeURIComponent(entry.path)}}`, identity: { path: entry.path, source: entry.source, folderRoot: entry.folderRoot, size: entry.size },
    presentation: { source: entry.path } }));
}
async function candidateFingerprint(candidate: Candidate): Promise<string> {
  if (candidate.source === 'assets') {
    const info = await lstat(candidate.sourceKey).catch(() => { throw new Error('提示词参考图已离线或无法读取'); });
    if (!info.isFile || info.isSymlink || info.size <= 0 || info.size > MAX_PREVIEW_SOURCE_BYTES) throw new Error('提示词参考图不是可用的普通文件或超过 16 MiB');
    return fingerprint([candidate.identity, candidate.label, info.size, info.mtime?.getTime() ?? 0]);
  }
  return fingerprint(candidate.identity);
}

interface LocalPreviewSnapshot { size: number; mtime: number | null }
interface PreviewOptions extends ReferenceOptions { bag: ReferenceBag; deadline: number; localFiles: Map<string, LocalPreviewSnapshot> }
/** 等待可以取消；迟到的原生句柄或位图由 onLate 回收，不进入返回值。 */
function previewStep<T>(start: () => Promise<T>, options: PreviewOptions, onLate?: (value: T) => void): Promise<T> {
  assertLiveBag(options, options.bag);
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('提示词预览等待超时'));
  return new Promise<T>((resolve, reject) => {
    let active = true;
    const finish = () => { active = false; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(new DOMException('提示词预览已取消', 'AbortError')); };
    const timer = setTimeout(() => { finish(); reject(new Error('提示词预览等待超时')); }, remaining);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    let pending: Promise<T>;
    try { pending = start(); } catch (error) { finish(); reject(error); return; }
    void pending.then((value) => {
      if (!active) { onLate?.(value); return; }
      try { assertLiveBag(options, options.bag); } catch (error) { finish(); onLate?.(value); reject(error); return; }
      finish(); resolve(value);
    }, (error: unknown) => { if (active) { finish(); reject(error); } });
  });
}

function assertPreviewDimensions(value: RasterImageDimensions | null): asserts value is RasterImageDimensions {
  if (!value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || value.width < 1 || value.height < 1 || value.width * value.height > MAX_PREVIEW_PIXELS) throw new Error('提示词预览尺寸无效');
}
const imageAscii = (bytes: Uint8Array, offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
/** 复用宿主尺寸解析器，额外拒绝动画及可掩盖超大帧尺寸的多帧头。 */
function previewImageHeader(bytes: Uint8Array): RasterImageDimensions & { mediaType: string } {
  if (!bytes.length || bytes.length > MAX_PREVIEW_SOURCE_BYTES) throw new Error('提示词预览图片大小无效');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mediaType: string;
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    && imageAscii(bytes, 12) === 'IHDR' && view.getUint32(8) === 13) {
    mediaType = 'image/png';
    let offset = 8;
    let headers = 0;
    let ended = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw new Error('PNG 图片头不完整');
      const length = view.getUint32(offset);
      const kind = imageAscii(bytes, offset + 4);
      if (offset + length + 12 > bytes.length || ['acTL', 'fcTL', 'fdAT'].includes(kind)) throw new Error('不支持动画或损坏的 PNG');
      if (kind === 'IHDR' && ++headers > 1) throw new Error('不支持多个 PNG 尺寸头');
      offset += length + 12;
      if (kind === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!ended) throw new Error('PNG 图片容器不完整');
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mediaType = 'image/jpeg';
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let frames = 0;
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('JPEG 图片头损坏');
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (offset + 2 > bytes.length) throw new Error('JPEG 图片头不完整');
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length || (sof.has(marker) && ++frames > 1)) throw new Error('JPEG 图片帧头无效');
      offset += length;
    }
    if (frames !== 1) throw new Error('JPEG 图片缺少尺寸头');
  } else if (bytes.length >= 30 && imageAscii(bytes, 0) === 'RIFF' && imageAscii(bytes, 8) === 'WEBP') {
    mediaType = 'image/webp';
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error('WebP 容器大小无效');
    let declared: RasterImageDimensions | null = null;
    let encoded: RasterImageDimensions | null = null;
    let offset = 12;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error('WebP 图片头不完整');
      const kind = imageAscii(bytes, offset);
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + length;
      if (end + length % 2 > bytes.length || kind === 'ANIM' || kind === 'ANMF') throw new Error('不支持动画或损坏的 WebP');
      if (kind === 'VP8X') {
        if (offset !== 12 || length !== 10 || (bytes[start] & 2)) throw new Error('WebP 扩展帧头无效');
        declared = parseRasterImageDimensions(bytes);
        assertPreviewDimensions(declared);
      } else if (kind === 'VP8 ' || kind === 'VP8L') {
        if (encoded || length < (kind === 'VP8 ' ? 10 : 5)) throw new Error('WebP 图像帧头无效');
        const frame = new Uint8Array(30);
        frame.set(bytes.subarray(0, 12));
        frame.set(bytes.subarray(offset, Math.min(end, offset + 18)), 12);
        encoded = parseRasterImageDimensions(frame);
        assertPreviewDimensions(encoded);
      }
      offset = end + length % 2;
    }
    if (!encoded || (declared && (declared.width !== encoded.width || declared.height !== encoded.height))) throw new Error('WebP 图像尺寸不一致');
  } else throw new Error('提示词预览仅支持静态 JPEG、PNG、WebP');
  const dimensions = parseRasterImageDimensions(bytes);
  assertPreviewDimensions(dimensions);
  return { ...dimensions, mediaType };
}

async function previewSourceBytes(source: string, options: PreviewOptions): Promise<Uint8Array | undefined> {
  assertLiveBag(options, options.bag);
  if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(source)) {
    return previewStep(() => decodeDataUrlBytesAsync(source, { maxBytes: MAX_PREVIEW_SOURCE_BYTES, signal: options.signal }), options);
  }
  const path = localMediaUrlToPath(source) ?? (/^(?:[a-z]:[/\\]|[/\\])/iu.test(source) ? source : undefined);
  if (path) {
    const info = await previewStep(() => lstat(path), options);
    if (!info.isFile || info.isSymlink || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_PREVIEW_SOURCE_BYTES) throw new Error('提示词预览不是有界普通文件');
    const file = await previewStep(() => open(path, { read: true }), options, (late) => { void late.close().catch(() => undefined); });
    try {
      const bytes = new Uint8Array(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const target = bytes.subarray(offset, Math.min(bytes.length, offset + 256 * 1024));
        const count = await previewStep(() => file.read(target), options);
        if (!count || !Number.isSafeInteger(count) || count > target.length || count < 0) throw new Error('提示词预览文件读取不完整');
        offset += count;
      }
      const extra = await previewStep(() => file.read(new Uint8Array(1)), options);
      const after = await previewStep(() => lstat(path), options);
      if (extra || !after.isFile || after.isSymlink || after.size !== info.size || after.mtime?.getTime() !== info.mtime?.getTime()) throw new Error('提示词预览文件已变更');
      const captured = options.localFiles.get(path);
      if (captured && (captured.size !== info.size || captured.mtime !== (info.mtime?.getTime() ?? null))) throw new Error('提示词预览文件已变更');
      options.localFiles.set(path, { size: info.size, mtime: info.mtime?.getTime() ?? null });
      return bytes;
    } finally { void file.close().catch(() => undefined); }
  }
  if (!source.startsWith('blob:')) return undefined; // 远端图像不进入无界下载路径。
  const response = await previewStep(() => fetch(source, { signal: options.signal, credentials: 'omit' }), options);
  const reader = response.ok ? response.body?.getReader() : undefined;
  if (!reader) throw new Error('提示词预览缺少有界读取能力');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await previewStep(() => reader.read(), options);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PREVIEW_SOURCE_BYTES) throw new Error('提示词预览超过 16 MiB');
      parts.push(new Uint8Array(value));
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

async function createMentionThumbnail(candidate: Candidate, options: PreviewOptions): Promise<string | undefined> {
  if (!candidate.presentation?.source || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return undefined;
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    const input = await previewSourceBytes(candidate.presentation.source, options);
    assertLiveBag(options, options.bag);
    if (!input) return undefined;
    const bytes = new Uint8Array(input); // 校验和解码使用同一份自有快照。
    const header = previewImageHeader(bytes);
    bitmap = await previewStep(() => createImageBitmap(new Blob([bytes], { type: header.mediaType }), { imageOrientation: 'from-image' }), options, (late) => late.close());
    assertPreviewDimensions(bitmap);
    const matching = bitmap.width === header.width && bitmap.height === header.height;
    const jpegOrientation = header.mediaType === 'image/jpeg' && bitmap.width === header.height && bitmap.height === header.width;
    if (!matching && !jpegOrientation) throw new Error('提示词预览解码尺寸不一致');
    canvas = document.createElement('canvas');
    for (const edge of [160, 120, 80, 40]) {
      assertLiveBag(options, options.bag);
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('提示词预览绘制不可用');
      drawing.fillStyle = '#fff';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const target = canvas;
      const encoded = await previewStep(() => new Promise<Blob | null>((resolve) => target.toBlob(resolve, 'image/jpeg', 0.72)), options);
      if (!encoded || encoded.type !== 'image/jpeg' || encoded.size < 1) throw new Error('提示词预览编码失败');
      if (JPEG_PREFIX.length + 4 * Math.ceil(encoded.size / 3) > MAX_THUMBNAIL_CHARS) continue;
      const output = new Uint8Array(await previewStep(() => encoded.arrayBuffer(), options));
      const outputHeader = previewImageHeader(output);
      if (outputHeader.mediaType !== 'image/jpeg' || outputHeader.width !== canvas.width || outputHeader.height !== canvas.height) throw new Error('提示词预览编码格式无效');
      return JPEG_PREFIX + btoa(String.fromCharCode(...output));
    }
    return undefined;
  } catch {
    // 普通离线、格式或超时错误降级图标；租约失效和取消必须拒绝整页。
    assertLiveBag(options, options.bag);
    return undefined;
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

export async function queryPluginPromptMentions(options: ReferenceOptions & {
  source: PluginPromptMentionSource; query?: string; offset?: number; preview?: boolean;
}): Promise<PluginPromptMentionPage> {
  if (!['nodes', 'characters', 'assets'].includes(options.source) || (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 120))
    || (options.preview !== undefined && typeof options.preview !== 'boolean')
    || !Number.isSafeInteger(options.offset ?? 0) || (options.offset ?? 0) < 0 || (options.offset ?? 0) > 10_000) throw new Error('提示词候选查询无效');
  throwIfAborted(options.signal);
  await ensureStore();
  throwIfAborted(options.signal);
  const bag = bagFor(options, true)!;
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const candidates = (await collectCandidates(options.source, options, bag)).filter((item) => !query || item.label.toLocaleLowerCase().includes(query));
  assertLiveBag(options, bag);
  const offset = options.offset ?? 0;
  const items: PluginPromptMentionItem[] = [];
  const selected: Binding[] = [];
  const localFiles = new Map<string, LocalPreviewSnapshot>();
  const previewDeadline = Date.now() + 12_000;
  let thumbnailChars = 0;
  for (const candidate of candidates.slice(offset, offset + PAGE_SIZE)) {
    assertLiveBag(options, bag);
    const digest = await candidateFingerprint(candidate);
    assertLiveBag(options, bag);
    const key = `${candidate.source}:${candidate.sourceKey}`;
    let binding = bag.latest.get(key);
    if (!binding || binding.fingerprint !== digest) {
      if (bag.bindings.size >= MAX_HANDLES) throw new Error('单次插件调用最多授权 256 个提示词引用');
      const id = `plugin-ref-${crypto.randomUUID()}`;
      const item = { id, label: candidate.label, kind: candidate.kind, token: `@{${id}:${candidate.label}}` };
      binding = { ...candidate, item, fingerprint: digest };
      bag.bindings.set(id, binding);
      bag.latest.set(key, binding);
    }
    selected.push(binding);
    if (!options.preview) { items.push(binding.item); continue; }
    const item = { ...binding.item };
    if (candidate.presentation?.badge) item.badge = candidate.presentation.badge;
    const thumbnail = await createMentionThumbnail(candidate, { ...options, bag, localFiles, deadline: Math.min(previewDeadline, Date.now() + 3_000) });
    assertLiveBag(options, bag);
    if (thumbnail && thumbnailChars + thumbnail.length <= MAX_PAGE_THUMBNAIL_CHARS) {
      item.thumbnailDataUrl = thumbnail;
      thumbnailChars += thumbnail.length;
      if (candidate.presentation?.crop) item.thumbnailCrop = { ...candidate.presentation.crop };
    }
    items.push(item);
  }
  if (options.preview) {
    // 图片不写入 bag.item。整页返回前再次核对来源，包括没有触发画布 revision 的素材目录更新。
    const current = await collectCandidates(options.source, options, bag);
    assertLiveBag(options, bag);
    for (const binding of selected) {
      const candidate = current.find((entry) => entry.sourceKey === binding.sourceKey);
      if (!candidate || await candidateFingerprint(candidate) !== binding.fingerprint) throw new Error('提示词预览来源已变更，请重新选择');
      assertLiveBag(options, bag);
    }
    for (const [path, captured] of localFiles) {
      assertLiveBag(options, bag);
      const info = await lstat(path).catch(() => { throw new Error('提示词预览来源已离线'); });
      assertLiveBag(options, bag);
      if (!info.isFile || info.isSymlink || info.size !== captured.size || (info.mtime?.getTime() ?? null) !== captured.mtime) throw new Error('提示词预览文件已变更');
    }
  }
  assertLiveBag(options, bag);
  const hasMore = offset + PAGE_SIZE < candidates.length;
  return { items, hasMore, ...(hasMore ? { nextOffset: offset + PAGE_SIZE } : {}) };
}

async function checkedBindings(text: string, options: ReferenceOptions): Promise<Map<string, Binding>> {
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw new Error('插件提示词无效或过长');
  if (!REF_OPEN_PATTERN.test(text)) return new Map();
  await ensureStore();
  const bag = bagFor(options, false);
  const selected = new Map<string, Binding>();
  let remainder = text;
  for (const match of text.matchAll(REF_PATTERN)) {
    const parsed = /^@\{(plugin-ref-[0-9a-f-]{36}):[^}]+\}$/u.exec(match[0]);
    const binding = parsed && bag?.bindings.get(parsed[1]);
    if (!binding || binding.item.token !== match[0]) throw new Error('提示词只能使用本次宿主授权的引用 token');
    selected.set(match[0], binding);
    remainder = remainder.replace(match[0], '');
  }
  if (REF_OPEN_PATTERN.test(remainder)) throw new Error('提示词引用格式无效');
  const current = new Map<PluginPromptMentionSource, Candidate[]>();
  for (const binding of selected.values()) {
    if (!current.has(binding.source)) current.set(binding.source, await collectCandidates(binding.source, options, bag));
    const candidate = current.get(binding.source)!.find((item) => item.sourceKey === binding.sourceKey);
    if (!candidate || await candidateFingerprint(candidate) !== binding.fingerprint) throw new Error('提示词引用已删除、变更或撤销，请重新选择');
    assertLiveBag(options, bag!);
  }
  return selected;
}

export async function rewritePluginPromptReferences(text: string, options: ReferenceOptions): Promise<string> {
  const bindings = await checkedBindings(text, options);
  const rewritten = text.replace(REF_PATTERN, (token) => bindings.get(token)!.canonicalToken);
  if (rewritten.length > MAX_TEXT_LENGTH) throw new Error('重写后的插件提示词不能超过 256000 字符');
  return rewritten;
}

export async function resolvePluginPromptReferencesForModel(text: string, options: ReferenceOptions): Promise<{ prompt: string; imageUrls: string[] }> {
  const bindings = await checkedBindings(text, options);
  if (!bindings.size) return { prompt: text, imageUrls: [] };
  const canonical = text.replace(REF_PATTERN, (token) => {
    const binding = bindings.get(token)!;
    return binding.kind === 'video' || binding.kind === 'audio' ? `[${binding.label}]` : binding.canonicalToken;
  });
  const { resolvePromptToChatContent } = await import('../ai/promptResolver');
  await checkedBindings(text, options);
  const result = await resolvePromptToChatContent(canonical).catch(() => { throw new Error('提示词参考内容解析失败'); });
  await checkedBindings(text, options);
  const imageUrls = typeof result.content === 'string' ? [] : result.content.flatMap((entry) => entry.image_url?.url ? [entry.image_url.url] : []);
  if (!imageUrls.length && [...bindings.values()].some((binding) => binding.kind === 'image')) throw new Error('提示词参考图无法解析');
  // generateText 还会经过同一解析器；展开正文中的嵌套引用不得授予第二次读取权限。
  const prompt = result.textContent.replace(REF_PATTERN, (token) => token.startsWith('@asset{') ? '[资源引用]' : `[${token.slice(token.indexOf(':') + 1, -1)}]`)
    .replace(/@(?:asset|drama)?\{/gu, '［引用 ');
  return { prompt, imageUrls: [...new Set(imageUrls)] };
}
