import { Icon } from '@iconify/react';
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  PanoramaCore,
  type PanoramaCoreHandle,
} from 'xiaoluo-vr-panorama/core';
import 'xiaoluo-vr-panorama/core.css';

export interface XiaoLuoPanoramaViewerHandle {
  captureScreenshot: (aspect?: number | null) => Promise<string | null>;
}

interface XiaoLuoPanoramaViewerProps {
  imageUrl: string;
}

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
>(function XiaoLuoPanoramaViewer({ imageUrl }, forwardedRef) {
  const coreRef = useRef<PanoramaCoreHandle>(null);
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

  return (
    <div className="xiaoluo-pano-shell is-compact nodrag nowheel" data-ui-stop="1">
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
          setError(message || '无法加载全景图');
        }}
      />

      {loading ? (
        <div className="xiaoluo-pano-status" role="status">
          <span className="spinner" />
          <span>载入中...</span>
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
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
});

export default memo(XiaoLuoPanoramaViewer);
