import { memo, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { BaseNodeData } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { CanvasNodeLodContext, CanvasNodeLodPreviewRevisionContext, useCanvasNodeLodProtection } from '../../../hooks/useCanvasNodeLod';
import { useReferencedImageRevisions } from '../../../hooks/useReferencedImageWatcher';
import CanvasNodeLodPreview from './CanvasNodeLodPreview';

interface Props {
  node: NodeProps;
  data: BaseNodeData;
  video: boolean;
  children: ReactNode;
}

// 多选拖动时，每个节点都订阅相同的 ID 数组；只建一次集合，避免每次 Store 更新做 N² 次查找。
const selections = new WeakMap<readonly string[], ReadonlySet<string>>();
function isSelected(ids: readonly string[], id: string) {
  let selected = selections.get(ids);
  if (!selected) { selected = new Set(ids); selections.set(ids, selected); }
  return selected.has(id);
}

function LodBoundary({ node, data, video, children, projectId }: Props & { projectId: string | null }) {
  const runtime = useContext(CanvasNodeLodContext);
  const revisionFor = useReferencedImageRevisions([data.filePath]);
  const selection = useAppStore((state) => (
    (isSelected(state.selectedNodeIds, node.id) ? 1 : 0)
    | (state.activeNodeId === node.id || (state.selectedNodeIds.length === 1 && state.selectedNodeIds[0] === node.id) ? 2 : 0)
  ));
  const position = useRef({ x: 0, y: 0 });
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = runtime?.subscribe(node.id, listener);
    runtime?.position(node.id, position.current.x, position.current.y);
    return unsubscribe ?? (() => {});
  }, [runtime, node.id]);
  const snapshot = useCallback(() => runtime?.getSnapshot(node.id) ?? true, [runtime, node.id]);
  const full = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [keepFull, setKeepFull] = useState(false);
  const [cover, setCover] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const cancelCover = useRef<(() => void) | undefined>(undefined);
  const hasMedia = video ? !!data.videoUrl : !!(data.imageUrl || data.thumbnailUrl);
  const width = data.nodeWidth;
  const height = data.nodeHeight;
  // 编辑叠层与缺失尺寸先保留原实现，不能用未经合成的原图或推测几何替换。
  const eligible = hasMedia && typeof width === 'number' && Number.isFinite(width) && width > 0
    && typeof height === 'number' && Number.isFinite(height) && height > 0
    && !data.mattingMask && !data.annotation && !data.annotationLayer;
  const protectedState = keepFull || selection !== 0 || !!node.selected || !!node.dragging
    || data.status === 'loading' || data.status === 'error' || !!data.error || !eligible;
  useCanvasNodeLodProtection(node.id, protectedState);
  const lite = !full && !protectedState;
  const [previousLite, setPreviousLite] = useState(lite);
  if (previousLite !== lite) { setPreviousLite(lite); setCover(!lite); }
  // 单选会挂载业务工具条，保留其状态；普通多选仅临时保护，取消全选后仍可降级。
  // RF 离屏卸载仍沿用既有生命周期。
  if ((selection & 2) !== 0 && !keepFull) setKeepFull(true);
  const requireFull = useCallback(() => { setKeepFull(true); setCover(false); }, []);
  const dismissCover = useCallback(async (target: EventTarget) => {
    if (!cover || !(target instanceof Element) || target.closest('[data-canvas-node-lod="preview"]')) return;
    const source = target instanceof HTMLImageElement ? target.src : undefined;
    if (target instanceof HTMLImageElement) {
      try { await target.decode(); } catch { /* 原节点接管加载失败提示。 */ }
    }
    if (!root.current?.contains(target)) return;
    cancelCover.current?.();
    const commit = () => {
      if (root.current?.contains(target) && (!(target instanceof HTMLImageElement) || target.src === source)) setCover(false);
    };
    if (runtime) cancelCover.current = runtime.enqueueDisplay(root, commit, node.id);
    else commit();
  }, [cover, node.id, runtime]);

  useLayoutEffect(() => () => cancelCover.current?.(), [runtime, lite]);

  useLayoutEffect(() => {
    position.current = { x: node.positionAbsoluteX + (width ?? 0) / 2, y: node.positionAbsoluteY + (height ?? 0) / 2 };
    runtime?.position(node.id, position.current.x, position.current.y);
  }, [runtime, node.id, node.positionAbsoluteX, node.positionAbsoluteY, width, height]);

  useLayoutEffect(() => {
    if (!cover || lite) return;
    const media = root.current?.querySelector<HTMLImageElement | HTMLVideoElement>(
      '.image-preview-container img, img.video-node-poster, .video-node video',
    );
    if ((media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0)
      || (media instanceof HTMLVideoElement && media.readyState >= 2)) {
      void dismissCover(media);
      return;
    }
    // 图片已挂载但正在显示队列中等待；由 load/error 完成交接，不能定时揭开空图。
    if (media instanceof HTMLImageElement) return;
    // 异常/无媒体分支仍须可见，不能永久遮盖原节点的错误或重试提示。
    const timer = setTimeout(() => setCover(false), 1000);
    return () => clearTimeout(timer);
  }, [cover, lite, dismissCover]);

  return (
    <CanvasNodeLodPreviewRevisionContext.Provider value={revisionFor(data.filePath)}>
    <div
      ref={root}
      className="canvas-node-lod-boundary"
      data-canvas-node-detail={lite ? 'lite' : 'full'}
      onPointerDownCapture={() => { if (!lite) setKeepFull(true); }}
      onFocusCapture={() => { if (!lite) setKeepFull(true); }}
      onLoadCapture={(event) => dismissCover(event.target)}
      onLoadedDataCapture={(event) => dismissCover(event.target)}
      onErrorCapture={(event) => dismissCover(event.target)}
    >
      {!lite && children}
      {eligible && (lite || (cover && !data.error && data.status !== 'error')) && <CanvasNodeLodPreview
        nodeId={node.id}
        data={data}
        video={video}
        projectId={projectId}
        width={width}
        height={height}
        cover={!lite}
        onUnavailable={requireFull}
      />}
    </div>
    </CanvasNodeLodPreviewRevisionContext.Provider>
  );
}

function CanvasNodeLodBoundary(props: Props) {
  const projectId = useAppStore((state) => state.currentProjectId);
  return <LodBoundary key={projectId} {...props} projectId={projectId} />;
}

export default memo(CanvasNodeLodBoundary);
