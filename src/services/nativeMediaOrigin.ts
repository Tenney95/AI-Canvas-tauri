/** 仅在一次受信生成调用期间传递原对话身份；账本只复制这些非敏感 ID。 */
import type { NativeMediaOrigin } from '../types/media';
export type { NativeMediaOrigin } from '../types/media';
const origins = new Map<string, { origin: NativeMediaOrigin; token: symbol; messageInput?: { material: string; assertCurrent: () => void } }>();
export function bindNativeMediaOrigin(canvasId: string, nodeId: string, origin: NativeMediaOrigin,
  messageInput?: { material: string; assertCurrent: () => void }): () => void {
  const key = JSON.stringify([canvasId, nodeId]);
  if (origins.has(key)) throw new Error('此媒体节点已有活动调用，未重新提交');
  const token = Symbol(); origins.set(key, { origin: structuredClone(origin), token, messageInput });
  return () => { if (origins.get(key)?.token === token) origins.delete(key); };
}
export function readNativeMediaMessageInput(canvasId: string, nodeId: string) {
  return origins.get(JSON.stringify([canvasId, nodeId]))?.messageInput;
}
export function readNativeMediaOrigin(canvasId: string, nodeId: string): NativeMediaOrigin | undefined {
  const origin = origins.get(JSON.stringify([canvasId, nodeId]))?.origin;
  return origin && structuredClone(origin);
}
