/**
 * 画布节点内的轻量全景查看器，封装核心实例、截图命令和主题同步。
 */
import { Icon } from '@iconify/react';
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { PanoramaCore } from './internal/PanoramaCore';
import type { PanoramaCoreHandle } from '../../../types/panorama';
import { useT } from '../../../i18n';

export interface XiaoLuoPanoramaViewerHandle {
  captureScreenshot: (aspect?: number | null) => Promise<string | null>;
}

interface XiaoLuoPanoramaViewerProps {
  imageUrl: string;
  /** 视角模式：为 false 时盖上遮罩，把拖拽/滚轮让回画布（节点可拖动、可缩放） */
  interactive?: boolean;
  /** 遮罩被单击（非拖拽）时请求进入视角模式 */
  onActivate?: () => void;
}

/** 按下与抬起的位移超过该像素数即视为拖动节点，不触发激活 */
const ACTIVATE_DRAG_TOLERANCE = 4;

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

const XiaoLuoPanoramaViewer = forwardRef<
  XiaoLuoPanoramaViewerHandle,
  XiaoLuoPanoramaViewerProps
>(function XiaoLuoPanoramaViewer({ imageUrl, interactive = false, onActivate }, forwardedRef) {
  const t = useT();
  const coreRef = useRef<PanoramaCoreHandle>(null);
  const veilDownRef = useRef<{ x: number; y: number } | null>(null);
  const [viewerKey, setViewerKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
  }, [imageUrl]);

  useImperativeHandle(forwardedRef, () => ({
    async captureScreenshot(aspect?: number | null) {
      const dataUrl = coreRef.current?.captureScreenshot();
      if (!dataUrl) return null;
      return cropScreenshot(dataUrl, aspect);
    },
  }), []);

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
      <PanoramaCore
        key={viewerKey}
        ref={coreRef}
        imageUrl={imageUrl}
        initialPitch={0}
        initialYaw={180}
        initialHfov={95}
        onLoad={() => {
          setLoading(false);
          setError(null);
        }}
        onError={(message) => {
          setLoading(false);
          setError(message || t('无法加载全景图'));
        }}
      />

      {loading ? (
        <div className="xiaoluo-pano-status" role="status">
          <span className="spinner" />
          <span>{t('载入中...')}</span>
        </div>
      ) : null}

      {interactive ? (
        <div className="xiaoluo-pano-active-badge">{t('视角模式 · Esc 退出')}</div>
      ) : !loading && !error ? (
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

export default memo(XiaoLuoPanoramaViewer);
