/**
 * 画布节点内的轻量全景查看器，封装核心实例、截图命令和主题同步。
 */
import { Icon } from '@iconify/react';
import {
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { PanoramaCore } from './internal/PanoramaCore';
import type { PanoramaCoreHandle, PanoramaViewState } from '../../../types/panorama';
import { useT } from '../../../i18n';
import { CanvasNodeLodContext } from '../../../hooks/useCanvasNodeLod';
import { createCanvasDisplayScheduler } from '../../../services/canvasDisplayScheduler';

export interface XiaoLuoPanoramaViewerHandle {
  captureScreenshot: (aspect?: number | null) => Promise<string | null>;
}

interface XiaoLuoPanoramaViewerProps {
  imageUrl: string;
  nodeId?: string;
  /** 视角模式：为 false 时盖上遮罩，把拖拽/滚轮让回画布（节点可拖动、可缩放） */
  interactive?: boolean;
  /** 遮罩被单击（非拖拽）时请求进入视角模式 */
  onActivate?: () => void;
}

/** 按下与抬起的位移超过该像素数即视为拖动节点，不触发激活 */
const ACTIVATE_DRAG_TOLERANCE = 4;
const SCREENSHOT_READY_TIMEOUT_MS = 15_000;
const fallbackPreviewQueue = createCanvasDisplayScheduler();

function cropScreenshot(dataUrl: string, aspect?: number | null): Promise<string | null> {
  if (!aspect || aspect <= 0) return Promise.resolve(dataUrl);

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const sourceWidth = image.naturalWidth;
      const sourceHeight = image.naturalHeight;
      if (!sourceWidth || !sourceHeight) {
        resolve(null);
        return;
      }

      let cropWidth = sourceWidth;
      let cropHeight = sourceHeight;
      if (sourceWidth / sourceHeight > aspect) {
        cropWidth = Math.round(sourceHeight * aspect);
      } else {
        cropHeight = Math.round(sourceWidth / aspect);
      }

      const canvas = document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(null);
        return;
      }

      context.drawImage(
        image,
        Math.round((sourceWidth - cropWidth) / 2),
        Math.round((sourceHeight - cropHeight) / 2),
        cropWidth,
        cropHeight,
        0,
        0,
        cropWidth,
        cropHeight,
      );
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

const PanoramaViewerSession = forwardRef<
  XiaoLuoPanoramaViewerHandle,
  XiaoLuoPanoramaViewerProps
>(function PanoramaViewerSession({ imageUrl, nodeId, interactive = false, onActivate }, forwardedRef) {
  const t = useT();
  const runtime = useContext(CanvasNodeLodContext);
  const coreRef = useRef<PanoramaCoreHandle>(null);
  const veilDownRef = useRef<{ x: number; y: number } | null>(null);
  const viewRef = useRef<PanoramaViewState>({ pitch: 0, yaw: 180, hfov: 95 });
  const posterRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const interactiveRef = useRef(interactive);
  const finishPreparationRef = useRef<(() => void) | null>(null);
  const cancelPreparationRef = useRef<(() => void) | null>(null);
  const screenshotRequestsRef = useRef(new Set<(dataUrl: string | null) => void>());
  const liveRef = useRef(false);
  const [live, setLive] = useState(false);
  const [poster, setPoster] = useState<string | null>(null);
  const [viewerKey, setViewerKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => { interactiveRef.current = interactive; }, [interactive]);

  const startCore = useCallback(() => {
    cancelPreparationRef.current?.();
    if (liveRef.current) return;
    liveRef.current = true;
    loadedRef.current = false;
    setLoading(true);
    setError(null);
    setLive(true);
  }, []);
  const freezePreview = useCallback((preparedScreenshot?: string | null) => {
    if (!loadedRef.current || interactiveRef.current) return;
    const core = coreRef.current;
    const view = core?.getView();
    const screenshot = preparedScreenshot === undefined ? core?.captureScreenshot() : preparedScreenshot;
    // A failed capture keeps the original renderer and screenshot controls.
    if (!screenshot || !view) return;
    viewRef.current = view;
    posterRef.current = screenshot;
    setPoster(screenshot);
    liveRef.current = false;
    loadedRef.current = false;
    setLive(false);
  }, []);

  useEffect(() => {
    if (interactive) {
      startCore();
      return;
    }
    freezePreview();
    if (posterRef.current || liveRef.current) return;
    const key = {};
    let disposed = false;
    const work = () => new Promise<void>((resolve) => {
      if (disposed || posterRef.current && !liveRef.current) { resolve(); return; }
      finishPreparationRef.current = resolve;
      startCore();
    });
    // Idle compact viewers share the existing display preparation budget;
    // explicit interaction can activate immediately without waiting for it.
    const cancel = runtime ? runtime.prepareDisplay(key, work, nodeId)
      : fallbackPreviewQueue.prepare(key, work);
    cancelPreparationRef.current = cancel;
    return () => {
      disposed = true;
      cancel();
      if (cancelPreparationRef.current === cancel) cancelPreparationRef.current = null;
      finishPreparationRef.current?.();
      finishPreparationRef.current = null;
    };
  }, [interactive, viewerKey, runtime, nodeId, startCore, freezePreview]);

  useEffect(() => {
    if (live) return;
    finishPreparationRef.current?.();
    finishPreparationRef.current = null;
  }, [live]);

  const resolveScreenshots = useCallback((dataUrl: string | null) => {
    for (const resolve of screenshotRequestsRef.current) resolve(dataUrl);
    screenshotRequestsRef.current.clear();
  }, []);
  useEffect(() => () => resolveScreenshots(null), [resolveScreenshots]);

  useImperativeHandle(forwardedRef, () => ({
    async captureScreenshot(aspect?: number | null) {
      if (error) return null;
      // Explicit capture prepares the original renderer at the current node
      // dimensions; a resized static poster must not lower screenshot quality.
      const dataUrl = loadedRef.current ? coreRef.current?.captureScreenshot()
        : await new Promise<string | null>((resolve) => {
          const complete = (result: string | null) => {
            clearTimeout(timeout);
            screenshotRequestsRef.current.delete(complete);
            resolve(result);
          };
          const timeout = setTimeout(() => complete(null), SCREENSHOT_READY_TIMEOUT_MS);
          screenshotRequestsRef.current.add(complete);
          startCore();
        });
      if (!dataUrl) return null;
      return cropScreenshot(dataUrl, aspect);
    },
  }), [error, startCore]);

  // 遮罩上的按下/抬起：位移小于容差才算「单击激活」，拖动节点不会误进视角模式。
  // 事件不阻断冒泡，React Flow 照常接管拖拽。
  const handleVeilPointerDown = (event: React.PointerEvent) => {
    veilDownRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleVeilPointerUp = (event: React.PointerEvent) => {
    const down = veilDownRef.current;
    veilDownRef.current = null;
    if (!down) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved <= ACTIVATE_DRAG_TOLERANCE) onActivate?.();
  };

  return (
    <div
      className={`xiaoluo-pano-shell is-compact${interactive ? ' is-interactive nodrag nowheel' : ''}`}
      data-ui-stop="1"
    >
      {poster ? <img src={poster} alt="" draggable={false} className="absolute inset-0 h-full w-full object-fill" /> : null}
      {live ? <PanoramaCore
        key={viewerKey}
        ref={coreRef}
        imageUrl={imageUrl}
        initialPitch={viewRef.current.pitch}
        initialYaw={viewRef.current.yaw}
        initialHfov={viewRef.current.hfov}
        onLoad={() => {
          loadedRef.current = true;
          setLoading(false);
          setError(null);
          const screenshot = screenshotRequestsRef.current.size > 0 ? coreRef.current?.captureScreenshot() ?? null : undefined;
          if (screenshot !== undefined) resolveScreenshots(screenshot);
          freezePreview(screenshot);
          // Failed screenshot falls back to a live viewer but cannot stall the
          // shared queue. Successful captures release after Core unmounts.
          if (liveRef.current) {
            finishPreparationRef.current?.();
            finishPreparationRef.current = null;
          }
        }}
        onError={(message) => {
          setLoading(false);
          setError(message || t('无法加载全景图'));
          resolveScreenshots(null);
          finishPreparationRef.current?.();
          finishPreparationRef.current = null;
        }}
      /> : null}

      {loading ? (
        <div className={`xiaoluo-pano-status${!live ? ' pointer-events-none' : ''}`} role="status">
          <span className="spinner" />
          <span>{t('载入中...')}</span>
        </div>
      ) : null}

      {interactive ? (
        <div className="xiaoluo-pano-active-badge">{t('视角模式 · Esc 退出')}</div>
      ) : !error ? (
        <div
          className="xiaoluo-pano-veil"
          onPointerDown={handleVeilPointerDown}
          onPointerUp={handleVeilPointerUp}
          onPointerCancel={() => { veilDownRef.current = null; }}
        >
          <span className="xiaoluo-pano-veil-hint">
            <Icon icon="lucide:move-3d" width="12" height="12" />
            {t('点击转动视角')}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="xiaoluo-pano-status is-error" role="alert">
          <Icon icon="mdi:image-broken-variant" width="22" height="22" />
          <span>{error}</span>
          <button
            type="button"
            className="xiaoluo-pano-retry"
            onClick={() => {
              setError(null);
              setLoading(true);
              loadedRef.current = false;
              setViewerKey((key) => key + 1);
            }}
          >
            {t('重试')}
          </button>
        </div>
      ) : null}
    </div>
  );
});

// A source change starts a fresh camera / poster / preparation lifetime. Late
// callbacks from the previous Core cannot supply a preview for the new image.
const XiaoLuoPanoramaViewer = forwardRef<XiaoLuoPanoramaViewerHandle, XiaoLuoPanoramaViewerProps>(
  function XiaoLuoPanoramaViewer(props, ref) {
    return <PanoramaViewerSession key={props.imageUrl} {...props} ref={ref} />;
  },
);

export default memo(XiaoLuoPanoramaViewer);
