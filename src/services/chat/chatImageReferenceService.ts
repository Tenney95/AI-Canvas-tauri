/** 助手参考图：项目文件持久化，消息只保存不含路径的引用；预览 URL 仅驻留内存。 */
import {
  getAssetUrlFromPath, getProjectDataDir, joinPath, readAgentSelectedImage,
  readFileToDataUrl, saveBinaryToProjectData, selectAgentTextFiles,
} from '../fileService';
import { useAppStore } from '../../store/useAppStore';
import { isConversationInProjectScope } from './conversationProjectScope';
import { GENERAL_ASSISTANT_SCOPE_ID } from './assistantScope';
import { authorizeConversationFiles } from './fileGrantService';
import { getNativeProjectOwner } from '../fs/core';
import { isChatImageFileName } from '../../utils/chatImageReference';

export { formatChatImageReference, parseChatImageReferences, stripChatImageReferences } from '../../utils/chatImageReference';

export const MAX_CHAT_IMAGES = 6;
const previews = new Map<string, string>();
const previewListeners = new Set<() => void>();
const attachmentUploads = new Set<string>();
let previewVersion = 0;
export const getChatImagePreviewVersion = () => previewVersion;
export function subscribeChatImagePreviews(listener: () => void) {
  previewListeners.add(listener);
  return () => { previewListeners.delete(listener); };
}

async function resolveImagePaths(projectId: string, signal?: AbortSignal): Promise<(fileName: string) => string> {
  const root = await getProjectDataDir(projectId);
  if (!root) throw new Error('参考图项目目录不可用');
  const owner = getNativeProjectOwner(projectId);
  const bindings = owner ? await (await import('../indexedDb/nativeProjectRepository')).readNativeProjectChatImagePaths(owner, { signal }) : undefined;
  return (fileName) => joinPath(root, bindings?.get(fileName) ?? fileName);
}

export async function readChatImageReference(projectId: string, fileName: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('参考图读取已取消', 'AbortError');
  if (!projectId || !isChatImageFileName(fileName)) throw new Error('参考图所属项目或引用无效');
  const pathFor = await resolveImagePaths(projectId, signal);
  const data = await readFileToDataUrl(pathFor(fileName), { kind: 'image', signal, label: '助手参考图' });
  if (signal?.aborted) throw new DOMException('参考图读取已取消', 'AbortError');
  if (!data) throw new Error('参考图已不可用，请重新上传');
  return data;
}

export function getChatImagePreviews(projectId: string | null, fileNames?: string[]): Record<string, string> {
  if (!projectId) return {};
  const prefix = `${projectId}/`;
  return Object.fromEntries([...previews].filter(([key]) => key.startsWith(prefix)
    && (!fileNames || fileNames.includes(key.slice(prefix.length)))).map(([key, url]) => [key.slice(prefix.length), url]));
}

export async function prepareChatImagePreviews(projectId: string | null, fileNames: string[]): Promise<void> {
  if (!projectId) return;
  const missing = [...new Set(fileNames)].slice(-200)
    .filter((name) => isChatImageFileName(name) && !previews.has(`${projectId}/${name}`));
  if (!missing.length) return;
  const pathFor = await resolveImagePaths(projectId).catch(() => undefined);
  if (!pathFor) return;
  let changed = false;
  for (const fileName of missing) {
    const key = `${projectId}/${fileName}`;
    if (previews.has(key)) continue;
    try {
      const url = await getAssetUrlFromPath(pathFor(fileName));
      if (!url) continue;
      previews.set(key, url);
      changed = true;
      if (previews.size > 400) previews.delete(previews.keys().next().value!);
    } catch { /* 缺失文件由预览占位和发送时的明确错误处理 */ }
  }
  if (changed) {
    previewVersion += 1;
    previewListeners.forEach((listener) => listener());
  }
}

/** 两种窗口都由主窗口执行选择、校验与落盘，不修改画布或工具 Policy。 */
export async function attachConversationFiles(conversationId: string): Promise<{ images: number; texts: number; failed: number }> {
  if (attachmentUploads.has(conversationId)) throw new Error('正在添加附件，请稍候');
  attachmentUploads.add(conversationId);
  try { return await attachSelectedConversationFiles(conversationId); }
  finally { attachmentUploads.delete(conversationId); }
}

async function attachSelectedConversationFiles(conversationId: string): Promise<{ images: number; texts: number; failed: number }> {
  const initial = useAppStore.getState();
  const projectId = initial.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID;
  const conversation = initial.conversations.find((item) => item.id === conversationId && !item.deletedAt);
  if (!projectId || initial.projectLoadStatus !== 'ready' || !conversation
    || !isConversationInProjectScope(initial.projects, projectId, conversation.projectId)) throw new Error('请先选择当前范围的普通对话');
  const valid = () => {
    const state = useAppStore.getState();
    return (state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID) === projectId && state.activeConversationId === conversationId
      && state.conversations.some((item) => item.id === conversationId && !item.deletedAt);
  };
  const selected = await selectAgentTextFiles('添加参考图或授权读取文本文件', true);
  if (!valid()) throw new Error('会话或项目已切换，请在当前对话重新添加附件');
  const textFiles = selected.filter((file) => !/^(png|jpe?g|webp)$/.test(file.extension));
  let texts = 0;
  let images = 0;
  let failed = 0;
  if (textFiles.length) {
    try { texts = (await authorizeConversationFiles(conversationId, textFiles)).length; }
    catch { failed += textFiles.length; }
  }
  for (const file of selected.filter((item) => /^(png|jpe?g|webp)$/.test(item.extension))) {
    if (!valid()) break;
    try {
      const pending = useAppStore.getState().chatImageDrafts[conversationId] ?? [];
      if (pending.length >= MAX_CHAT_IMAGES) throw new Error('参考图数量已达上限');
      if (file.size + pending.reduce((total, item) => total + item.size, 0) > 24 * 1024 * 1024) throw new Error('参考图总大小超过 24 MB');
      const { bytes, extension } = await readAgentSelectedImage(file.path);
      if (bytes.length + pending.reduce((total, item) => total + item.size, 0) > 24 * 1024 * 1024) throw new Error('参考图总大小超过 24 MB');
      if (!valid()) break;
      const fileName = `chat-ref-${crypto.randomUUID()}.${extension}`;
      const saved = await saveBinaryToProjectData(bytes, projectId, fileName, { throwOnError: true });
      if (!saved) throw new Error('参考图保存失败');
      if (!valid()) break;
      useAppStore.getState().addChatImageDraft(conversationId, { fileName, label: Array.from(file.fileName).slice(0, 120).join(''), size: bytes.length });
      images += 1;
    } catch { failed += 1; }
  }
  return { images, texts, failed };
}
