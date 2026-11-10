/**
 * CanvasPreviewImage — 提供画布节点图片显示界面与交互。
 */
import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { useStoreApi } from '@xyflow/react';
import { useAppStore } from '../../../../store/useAppStore';
import { CanvasNodeLodContext } from '../../../../hooks/useCanvasNodeLod';
import { createCanvasDisplayScheduler } from '../../../../services/canvasDisplayScheduler';
import { createCanvasImageDisplay, type DisplayImageLease } from './canvasImageDisplay';

interface CanvasPreviewImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  nodeWidth: number;
  nodeHeight: number;
  nodeId?: string;
  projectId?: string | null;
}

/** 稳定的 img 承载全部清晰度档；资源就绪且显示队列允许时才更换 src。 */
function CanvasPreviewImage({ src, nodeWidth, nodeHeight, nodeId, projectId, className, onLoad, onError, ...imageProps }: CanvasPreviewImageProps) {
  const runtime = useContext(CanvasNodeLodContext);
  const flow = useStoreApi();
  const controller = useRef<ReturnType<typeof createCanvasImageDisplay> | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const geometry = useRef({ width: nodeWidth, height: nodeHeight });
  const [preview, setPreview] = useState<{ source: string; projectId?: string | null; lease: DisplayImageLease }>();
  const resolved = preview && preview.source === src && preview.projectId === projectId ? preview.lease.src : undefined;
  const [loading, setLoading] = useState({ source: src, projectId, resolved, ready: false });
  // 相同 URL 的新租约不一定再次触发 load；真实换源时仍需新请求身份，包含 A → B → A。
  const matching = loading.source === src && loading.projectId === projectId && loading.resolved === resolved;
  if (!matching) setLoading({ source: src, projectId, resolved, ready: false });
  const currentPreview = useRef<typeof loading | undefined>(undefined);

  useLayoutEffect(() => {
    geometry.current = { width: nodeWidth, height: nodeHeight };
    controller.current?.viewport(flow.getState().transform[2], nodeWidth, nodeHeight, window.devicePixelRatio || 1, useAppStore.getState().config.performanceMode === true);
  }, [flow, nodeWidth, nodeHeight]);

  useEffect(() => {
    if (!src) return;
    const fallback = runtime ? null : createCanvasDisplayScheduler();
    const display = createCanvasImageDisplay({
      source: src, projectId,
      queue: {
        enqueue: (key, commit, delay) => runtime
          ? runtime.enqueueDisplay(key, commit, nodeId, delay) : fallback!.enqueue(key, commit, undefined, delay),
        prepare: (key, work, delay) => runtime
          ? runtime.prepareDisplay(key, work, nodeId, delay) : fallback!.prepare(key, work, undefined, delay),
      },
      publish: (lease) => setPreview({ source: src, projectId, lease }),
      onError: () => imageRef.current?.dispatchEvent(new Event('error')),
    });
    controller.current = display;
    let lastZoom: number | undefined;
    let lastRatio: number | undefined;
    let lastPerformanceMode: boolean | undefined;
    const refresh = () => {
      const zoom = flow.getState().transform[2];
      const ratio = window.devicePixelRatio || 1;
      const performanceMode = useAppStore.getState().config.performanceMode === true;
      if (lastZoom === zoom && lastRatio === ratio && lastPerformanceMode === performanceMode) return;
      lastZoom = zoom;
      lastRatio = ratio;
      lastPerformanceMode = performanceMode;
      display.viewport(zoom, geometry.current.width, geometry.current.height, ratio, performanceMode);
    };
    refresh();
    const unsubscribe = flow.subscribe(refresh);
    // 更新现有控制器，保留当前图片和租约，避免开关引发整批图片重新挂载。
    const unsubscribeConfig = useAppStore.subscribe((state, previous) => {
      if (state.config.performanceMode !== previous.config.performanceMode) refresh();
    });
    window.addEventListener('resize', refresh);
    return () => {
      unsubscribe();
      unsubscribeConfig();
      window.removeEventListener('resize', refresh);
      display.dispose();
      fallback?.deactivate();
      if (controller.current === display) controller.current = null;
    };
  }, [src, projectId, nodeId, flow, runtime]);

  useLayoutEffect(() => {
    const current = preview?.source === src && preview?.projectId === projectId ? preview : undefined;
    currentPreview.current = current && matching ? loading : undefined;
    if (current) controller.current?.committed(current.lease);
    return () => { currentPreview.current = undefined; };
  }, [preview, src, projectId, loading, matching]);

  const visible = !!resolved && matching && loading.ready;
  return <img
    {...imageProps}
    ref={imageRef}
    src={resolved}
    className={`${className ?? ''}${visible ? '' : ' invisible'}`.trim()}
    decoding="async"
    onLoad={(event) => {
      const image = event.currentTarget;
      const request = currentPreview.current;
      if (!request?.resolved || image.getAttribute('src') !== request.resolved) return;
      // 保持上游同步 load 回调；只有当前元素解码完成才揭开空白，不重播入场动画。
      onLoad?.(event);
      const isCurrent = () => currentPreview.current === request && imageRef.current === image
        && image.getAttribute('src') === request.resolved;
      const reveal = () => {
        if (isCurrent()) setLoading((current) => current === request ? { ...current, ready: true } : current);
      };
      if (typeof image.decode === 'function') {
        void image.decode().then(reveal, () => {
          if (isCurrent()) image.dispatchEvent(new Event('error'));
        });
      } else reveal();
    }}
    onError={(event) => {
      setLoading((current) => ({ ...current, ready: false }));
      onError?.(event);
    }}
  />;
}

export default memo(CanvasPreviewImage);
