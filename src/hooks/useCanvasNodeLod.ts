import { createContext, useContext, useLayoutEffect } from 'react';
import type { CanvasNodeLodRuntime } from '../services/canvasNodeLodRuntime';

export const CanvasNodeLodContext = createContext<CanvasNodeLodRuntime | null>(null);
export const CanvasNodeLodPreviewRevisionContext = createContext<number | undefined>(undefined);

/** 图片版本由不随 LOD 卸载的边界持有，避免切回旧的内存缩略图。 */
export function useCanvasNodeLodPreviewRevision() {
  return useContext(CanvasNodeLodPreviewRevisionContext);
}

/** 编辑器、播放及节点内异步操作保活；离开当前画布挂载范围时释放。 */
export function useCanvasNodeLodProtection(nodeId: string, protectedState: boolean) {
  const runtime = useContext(CanvasNodeLodContext);
  useLayoutEffect(() => {
    if (protectedState) return runtime?.pin(nodeId);
  }, [nodeId, protectedState, runtime]);
}
