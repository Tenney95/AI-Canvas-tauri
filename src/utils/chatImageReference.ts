import type { ChatImageReference } from '../types/chat';
import type { ProjectModelTransferExchange } from '../types/projectModelTransfer';

export const isChatImageFileName = (name: string): boolean => /^chat-ref-[a-f0-9-]{36}\.(?:png|jpg|webp)$/.test(name);
const IMAGE_REFERENCE = /@image\{(chat-ref-[a-f0-9-]{36}\.(?:png|jpg|webp))\|([^}\r\n]*)\}/g;
const IMPORTED_CHAT_IMAGE = /^imports\/[A-Za-z0-9-]+-root-\d+\/(chat-ref-[a-f0-9-]{36}\.(?:png|jpg|webp))$/;

export function formatChatImageReference(image: Pick<ChatImageReference, 'fileName' | 'label'>): string {
  if (!isChatImageFileName(image.fileName)) throw new Error('参考图引用无效');
  return `@image{${image.fileName}|${encodeURIComponent(Array.from(image.label).slice(0, 120).join(''))}}`;
}

export function parseChatImageReferences(text: string): Array<ChatImageReference & { raw: string }> {
  return [...text.matchAll(IMAGE_REFERENCE)].map((match) => {
    let label = match[2];
    try { label = decodeURIComponent(label); } catch { /* 保留可显示文本 */ }
    return { fileName: match[1], label: Array.from(label).slice(0, 120).join('') || '参考图', size: 0, raw: match[0] };
  });
}

export function stripChatImageReferences(text: string): string {
  return text.replace(IMAGE_REFERENCE, '').trim();
}

/** 只接受当前作品主根上的同名附件绑定，正文令牌本身不授予路径访问。 */
export function nativeChatImagePaths(primaryRoot: string, exchange: ProjectModelTransferExchange | null): Map<string, string> {
  const result = new Map<string, string>();
  const logicalRoot = exchange?.identities.find((identity) => identity.kind === 'storage-root' && identity.localId === primaryRoot)?.sourceId;
  if (!logicalRoot || !exchange) return result;
  for (const binding of exchange.fileBindings) {
    if (binding.rootRef !== logicalRoot || !isChatImageFileName(binding.relativePath)) continue;
    if (binding.localRelativePath === binding.relativePath || IMPORTED_CHAT_IMAGE.exec(binding.localRelativePath)?.[1] === binding.relativePath) {
      result.set(binding.relativePath, binding.localRelativePath);
    }
  }
  return result;
}
