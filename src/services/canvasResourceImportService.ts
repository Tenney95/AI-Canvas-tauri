/** 外部资源先准备、再一次提交画布；路径与剪贴板正文不进入工具结果。 */
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { useAppStore } from '../store/useAppStore';
import { collectKeepPaths } from '../store/store.nodes';
import { blobToDataUrl, computeImageNodeDimensions, generateId } from '../store/store.utils';
import { getNodeBounds } from '../utils/nodeBounds';
import { isChatImageFileName } from '../utils/chatImageReference';
import { getCanvasPointerPosition } from './canvasPointerService';
import { copyFileToProjectData, moveToUndoTrash, saveDataUrlToProjectData } from './fileService';
import { getNativeProjectOwner, sanitizeFileName } from './fs/core';
import { ProjectFileStaging } from './fs/projectFileStaging';
import { usesTrashPath } from './fs/undoTrashJournal';
import { isNodeMediaCopySource } from './nodeMediaCopy';
import { readNativeClipboard } from './clipboardService';
import { MediaUploadError, reserveUploadedMedia, settleUploadedMedia } from './mediaUploadService';
import type { MediaResourceInput } from '../types/mediaUpload';
import {
  isWsagentSharedImagesNode, WSAGENT_IMAGE_EXTENSIONS, WSAGENT_MAX_IMAGE_BYTES, type WsagentSharedImage,
  type WsagentProjectMediaTarget,
} from '../types/wsagentShared';
import {
  completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasImport,
} from './canvasDerivationGuard';

export interface ResourceImportContext {
  projectId: string;
  conversationId?: string;
  baseRevision?: number;
  signal: AbortSignal;
}

export interface ResourcePosition { x?: number; y?: number }
export interface LocalResourceInput extends ResourcePosition { path: string; label?: string }
type MediaKind = 'image' | 'video' | 'audio';
interface SavedMedia {
  filePath: string;
  assetUrl: string;
  fileName?: string;
  relativePath?: string;
  assetId?: string;
}
interface WsagentMediaImportLink {
  sourceNodeId: string;
  kind: MediaKind;
  target?: WsagentProjectMediaTarget;
  assertCurrent?: () => void;
}
type Resource = ResourcePosition & { label: string } & (
  | { kind: MediaKind; path: string }
  | { kind: MediaKind; blob: Blob; extension: string }
  | { kind: 'image'; dataUrl: string; fileName: string }
  | { kind: MediaKind; saved: SavedMedia }
  | { kind: 'text'; text: string }
);

const EXTENSIONS: Record<MediaKind, readonly string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
};
const CLIPBOARD_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif',
};
const MAX_ITEMS = 20;
const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024;

export class ResourceImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function reject(code: string, message: string): never {
  throw new ResourceImportError(code, message);
}

/** 校验整批输入后才开始复制，不把路径当 URL、目录授权或可执行内容。 */
function localResources(files: LocalResourceInput[]): Resource[] {
  if (!files.length || files.length > MAX_ITEMS) reject('IMPORT_LIMIT', '每次导入 1 至 20 个媒体文件');
  return files.map((file, index) => {
    if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(file.path) || /[\0\r\n]/.test(file.path)) {
      reject('IMPORT_PATH_INVALID', `第 ${index + 1} 项需要本地绝对文件路径`);
    }
    const fileName = file.path.split(/[\\/]/).pop() || '';
    const extension = fileName.split('.').pop()?.toLowerCase() || '';
    const kind = (Object.keys(EXTENSIONS) as MediaKind[]).find((key) => EXTENSIONS[key].includes(extension));
    if (!kind) reject('IMPORT_TYPE_UNSUPPORTED', `第 ${index + 1} 项不是支持的图片、视频或音频文件`);
    return { ...file, kind, label: file.label?.trim() || fileName };
  });
}

/** 只读取显式图片/纯文本格式；不跟随 HTML 图片、URL 或剪贴板里的路径。 */
async function clipboardResources(): Promise<Resource[]> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    && /win/i.test(navigator.platform)) {
    let content: Awaited<ReturnType<typeof readNativeClipboard>>;
    try { content = await readNativeClipboard(); } catch {
      reject('CLIPBOARD_NATIVE_READ_FAILED', '系统剪贴板读取失败，请确认桌面端已更新且剪贴板包含图片或纯文本');
    }
    if (content.kind === 'text') {
      if (!content.text.trim()) reject('CLIPBOARD_EMPTY', '系统剪贴板没有可粘贴的内容');
      return [{ kind: 'text', text: content.text, label: '粘贴文本' }];
    }
    // 原生端已限定 PNG、尺寸、体积；只在内存转换，正文不返回 MCP。
    const blob = await (await fetch(content.dataUrl)).blob();
    return [{ kind: 'image', blob, extension: 'png', label: '粘贴图像' }];
  }
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
    reject('CLIPBOARD_UNAVAILABLE', '当前环境不支持读取系统剪贴板');
  }
  let items: ClipboardItems;
  try { items = await navigator.clipboard.read(); } catch {
    reject('CLIPBOARD_READ_DENIED', '无法读取系统剪贴板，请确认应用获得焦点且剪贴板读取已获授权');
  }
  if (!items.length) reject('CLIPBOARD_EMPTY', '系统剪贴板为空');
  if (items.length > MAX_ITEMS) reject('IMPORT_LIMIT', '剪贴板项目超过 20 个，请分批粘贴');
  const resources: Resource[] = [];
  let totalBytes = 0;
  for (const item of items) {
    const imageType = item.types.find((type) => CLIPBOARD_IMAGE_TYPES[type]);
    const type = imageType || (item.types.includes('text/plain') ? 'text/plain' : undefined);
    if (!type) reject('CLIPBOARD_TYPE_UNSUPPORTED', '剪贴板包含不支持的格式；请复制图片或纯文本，文件请使用批量导入');
    const blob = await item.getType(type);
    totalBytes += blob.size;
    if (totalBytes > MAX_CLIPBOARD_BYTES) reject('IMPORT_LIMIT', '剪贴板内容超过 32 MiB，请改用本地媒体导入');
    if (imageType) {
      resources.push({ kind: 'image', blob, extension: CLIPBOARD_IMAGE_TYPES[imageType], label: '粘贴图像' });
    } else {
      const text = await blob.text();
      if (text.length > 100_000) reject('IMPORT_LIMIT', '剪贴板文本超过 100000 字，请分批粘贴');
      if (text.trim()) resources.push({ kind: 'text', text, label: '粘贴文本' });
    }
  }
  if (!resources.length) reject('CLIPBOARD_EMPTY', '系统剪贴板没有可粘贴的内容');
  return resources;
}

/** 取消读取等待；底层无法中断的浏览器读取完成后也不能继续写盘或回填。 */
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, rejectPromise) => {
    const abort = () => rejectPromise(new ResourceImportError('IMPORT_CANCELLED', '资源导入已取消'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, rejectPromise).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function stageImportFiles(projectId: string): ProjectFileStaging {
  const owner = getNativeProjectOwner(projectId);
  let guard: ReturnType<typeof import('./fs/nativeNodeTrash').createNativeNodeTrashGuard> | undefined;
  return new ProjectFileStaging(async (path) => {
    if (getNativeProjectOwner(projectId) !== owner) return;
    // 聊天附件名也可由其他会话或未持久化的草稿持有，留给存储体检。
    if (isChatImageFileName(path.split(/[\\/]/).at(-1) ?? '')) return;
    if (owner) guard ??= import('./fs/nativeNodeTrash').then((fs) => fs.createNativeNodeTrashGuard(projectId, []));
    const references = await guard;
    if (references && usesTrashPath(path, references.references)) return;
    await moveToUndoTrash(path, projectId, async () => {
      if (getNativeProjectOwner(projectId) !== owner || references && !await references.isCurrent()) return false;
      const live = useAppStore.getState();
      return !isNodeMediaCopySource(path) && !usesTrashPath(path, collectKeepPaths(live.nodes, new Set(), live.messages));
    });
  });
}

async function importResources(
  context: ResourceImportContext,
  load: (signal: AbortSignal) => Promise<Resource[]>,
  position: ResourcePosition,
  link?: WsagentMediaImportLink,
) {
  const initial = useAppStore.getState();
  if (context.signal.aborted) reject('IMPORT_CANCELLED', '资源导入已取消');
  if (initial.currentProjectId !== context.projectId
    || (context.baseRevision !== undefined && initial.getCurrentRevision() !== context.baseRevision)) {
    reject('IMPORT_STALE', '项目或画布已变更，请重新读取画布后导入');
  }
  const linkedPosition = link ? wsagentLinkedMediaPosition(initial.nodes, initial.edges, link) : undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener('abort', abort, { once: true });
  const guard = registerCanvasImport(initial, abort);
  if (!guard) {
    context.signal.removeEventListener('abort', abort);
    reject('IMPORT_PROJECT_REQUIRED', '需要已加载的项目才能导入资源');
  }
  const check = () => {
    if (controller.signal.aborted) reject('IMPORT_CANCELLED', '资源导入已取消');
    const current = useAppStore.getState();
    // 原生拖拽/撤销等交互不一定递增 Agent revision，同样不能在其后提交旧批次。
    if (!isCanvasDerivationFresh(guard, current)
      || current.nodes !== initial.nodes || current.edges !== initial.edges || current.groups !== initial.groups) {
      reject('IMPORT_STALE', '导入期间项目或画布已变更，未添加节点；请重新读取画布');
    }
    link?.assertCurrent?.();
  };
  const origin = getCanvasPointerPosition();
  const x = position.x ?? linkedPosition?.x ?? origin.x;
  const y = position.y ?? linkedPosition?.y ?? origin.y;
  const nodes: Node<BaseNodeData>[] = [];
  const staging = stageImportFiles(context.projectId);
  try {
    check();
    const resources = await cancellable(load(controller.signal), controller.signal);
    check();
    for (const [index, resource] of resources.entries()) {
      check();
      const type = `source-${resource.kind}` as BaseNodeData['type'];
      const data: BaseNodeData = {
        type, role: 'source', label: resource.label, status: 'success', nodeWidth: 280, nodeHeight: 160,
      };
      if (resource.kind === 'text') {
        data.output = resource.text;
      } else {
        let saved: SavedMedia | null;
        if ('saved' in resource) {
          saved = resource.saved;
        } else if ('dataUrl' in resource) {
          saved = await cancellable(saveDataUrlToProjectData(resource.dataUrl, context.projectId, resource.fileName,
            { deduplicateByContent: true, throwOnError: true, assertCurrent: check, staging }), controller.signal);
        } else if ('path' in resource) {
          saved = await cancellable(copyFileToProjectData(resource.path, context.projectId, {
            signal: controller.signal, redactErrors: true, reuseExistingProjectFile: true, staging,
          }), controller.signal);
        } else {
          const dataUrl = await cancellable(blobToDataUrl(resource.blob), controller.signal);
          check();
          saved = await cancellable(saveDataUrlToProjectData(dataUrl, context.projectId,
            `clipboard-${generateId()}.${resource.extension}`, { assertCurrent: check, throwOnError: true, staging }), controller.signal);
        }
        check();
        if (!saved?.assetUrl) reject('IMPORT_COPY_FAILED', `第 ${index + 1} 项导入失败，请检查文件及目录授权；本批未添加节点`);
        data.filePath = saved.filePath;
        data.fileName = saved.fileName || saved.filePath.split(/[\\/]/).pop();
        if (saved.relativePath) data.relativePath = saved.relativePath;
        if (saved.assetId) data.assetId = saved.assetId;
        if (resource.kind === 'image') {
          data.imageUrl = saved.assetUrl;
          Object.assign(data, await cancellable(computeImageNodeDimensions(saved.assetUrl), controller.signal));
        } else if (resource.kind === 'video') data.videoUrl = saved.assetUrl;
        else data.audioUrl = saved.assetUrl;
      }
      check();
      nodes.push({ id: `node-import-${generateId()}`, type, data, position: {
        x: resource.x ?? x + (index % 4) * 340,
        y: resource.y ?? y + Math.floor(index / 4) * 260,
      } });
    }
    check();
    const edges: Edge[] = [];
    if (link) {
      const mediaNodeId = nodes[0].id;
      edges.push({ id: `edge-${generateId()}`, source: link.sourceNodeId,
        sourceHandle: `plugin-out-${link.kind}`, target: mediaNodeId, targetHandle: 'left' });
      if (link.target) {
        edges.push({ id: `edge-${generateId()}`, source: mediaNodeId, sourceHandle: 'right',
          target: link.target.nodeId, targetHandle: link.target.targetHandle });
      }
    }
    useAppStore.getState().addNodesWithEdges(nodes, edges);
    staging.commit();
    useAppStore.getState().incrementRevision();
    return {
      nodes: nodes.map((node) => ({ nodeId: node.id, type: node.type, position: node.position })),
      revision: useAppStore.getState().getCurrentRevision(),
    };
  } catch (error) {
    await staging.discard();
    if (error instanceof ResourceImportError) throw error;
    if (error instanceof MediaUploadError) throw new ResourceImportError(error.code, error.message);
    reject('IMPORT_FAILED', '资源导入失败，本批未添加节点；请检查素材与存储授权');
  } finally {
    context.signal.removeEventListener('abort', abort);
    completeCanvasDerivation(guard);
  }
}

function wsagentLinkedMediaPosition(nodes: Node<BaseNodeData>[], edges: Edge[], link: WsagentMediaImportLink) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const source = byId.get(link.sourceNodeId);
  if (!source || !isWsagentSharedImagesNode(source.data)) reject('IMPORT_STALE', 'WSAGENT 互联节点已变更');
  if (link.target && (link.target.nodeId === link.sourceNodeId || !byId.has(link.target.nodeId))) {
    reject('IMPORT_STALE', '目标节点已变更，请重新拖线');
  }
  const linked = new Set(edges.filter((edge) => edge.source === link.sourceNodeId).map((edge) => edge.target));
  if (link.target) linked.add(link.target.nodeId);
  const sourceBounds = getNodeBounds(source, byId);
  const x = sourceBounds.right + 40;
  let y = sourceBounds.top;
  for (const id of linked) {
    const node = byId.get(id);
    if (!node) continue;
    const bounds = getNodeBounds(node, byId);
    if (bounds.right > x && bounds.left < x + 280) y = Math.max(y, bounds.bottom + 24);
  }
  return { x, y };
}

export async function importLocalResources(context: ResourceImportContext, files: MediaResourceInput[], position: ResourcePosition = {}) {
  let reserved: string[] = [];
  let committed = false;
  try {
    const result = await importResources(context, async (signal) => {
      if (!files.length || files.length > MAX_ITEMS) reject('IMPORT_LIMIT', '每次导入 1 至 20 个媒体文件');
      for (const file of files) {
        if ((typeof file.path === 'string') === (typeof file.uploadId === 'string')
          || (typeof file.uploadId === 'string' && !file.uploadId.trim())) {
          reject('IMPORT_SOURCE_INVALID', '每项必须提供 path 或 uploadId 其中一个');
        }
      }
      // 整批路径先校验，不能先领取上传再发现后续路径参数无效。
      const paths = files.filter((file): file is LocalResourceInput => typeof file.path === 'string');
      const pathResources = paths.length ? localResources(paths) : [];
      const ids = files.flatMap((file) => file.uploadId ? [file.uploadId] : []);
      if (ids.length && !context.conversationId) reject('IMPORT_CONTEXT_REQUIRED', '上传导入需要当前对话身份');
      const uploaded = await reserveUploadedMedia({ ...context, signal, conversationId: context.conversationId ?? '' }, ids);
      if (signal.aborted) {
        settleUploadedMedia(ids, false);
        reject('IMPORT_CANCELLED', '资源导入已取消');
      }
      reserved = ids;
      let pathIndex = 0;
      let uploadIndex = 0;
      return files.map((file): Resource => {
        if (file.path !== undefined) return pathResources[pathIndex++];
        const saved = uploaded[uploadIndex++];
        return { kind: 'image', saved, label: file.label?.trim() || saved.label, x: file.x, y: file.y };
      });
    }, position);
    committed = true;
    return result;
  } finally { settleUploadedMedia(reserved, committed); }
}

export function pasteClipboardResources(context: ResourceImportContext, position: ResourcePosition = {}) {
  return importResources(context, clipboardResources, position);
}

/** 宿主截图直接入画布，不经剪贴板、本地文件选择或 MCP 的 Base64 参数。 */
export function importCapturedImage(
  context: ResourceImportContext,
  capture: () => Promise<{ data: string; mimeType: string }>,
  position: ResourcePosition = {},
  label = '应用界面截图',
) {
  return importResources(context, async () => {
    const result = await capture();
    if (context.signal.aborted) reject('IMPORT_CANCELLED', '截图导入已取消');
    if (result.mimeType !== 'image/jpeg' || result.data.length > 2_600_000) reject('IMPORT_LIMIT', '截图格式或大小无效');
    const blob = await (await fetch(`data:image/jpeg;base64,${result.data}`)).blob();
    return [{ kind: 'image', blob, extension: 'jpg', label }];
  }, position);
}

/** 互联库的原件先落为本项目受管文件；旧节点继续指向插入时的文件。 */
export function importSharedProjectImage(
  context: ResourceImportContext,
  read: () => Promise<{ asset: WsagentSharedImage; base64: string }>,
) {
  return importResources(context, async () => {
    const { asset, base64 } = await read();
    const extension = WSAGENT_IMAGE_EXTENSIONS[asset.mime];
    if (!extension || !/^[a-f0-9]{64}$/u.test(asset.sha256) || asset.bytes <= 0 || asset.bytes > WSAGENT_MAX_IMAGE_BYTES
      || base64.length !== 4 * Math.ceil(asset.bytes / 3)) reject('IMPORT_LIMIT', '共享图片格式或大小无效');
    const stem = Array.from(asset.name.replace(/\.(?:png|jpe?g|webp)$/iu, '')).slice(0, 56).join('').trim() || '共享图片';
    return [{ kind: 'image', dataUrl: `data:${asset.mime};base64,${base64}`, label: asset.name,
      fileName: sanitizeFileName(`${stem}.${extension}`) }];
  }, {});
}

/** 从已配对作品取回受管原件，同一次历史写入创建素材节点及其连线。 */
export function importWsagentProjectMedia(
  context: ResourceImportContext,
  read: (signal: AbortSignal) => Promise<SavedMedia & { label: string; relativePath: string }>,
  sourceNodeId: string,
  kind: MediaKind,
  target?: WsagentProjectMediaTarget,
  assertCurrent?: () => void,
  position: ResourcePosition = {},
) {
  return importResources(context, async (signal) => {
    const { label, ...saved } = await read(signal);
    return [{ kind, saved, label }];
  }, position, { sourceNodeId, kind, target, assertCurrent });
}
