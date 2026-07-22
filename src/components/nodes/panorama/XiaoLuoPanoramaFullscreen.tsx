import { memo } from 'react';
import {
  PanoramaViewer,
  type PanoramaCaptureResult,
} from 'xiaoluo-vr-panorama';
import 'xiaoluo-vr-panorama/dist/style.css';

interface XiaoLuoPanoramaFullscreenProps {
  imageUrl: string;
  theme: 'light' | 'dark';
  onClose: () => void;
  onCapture: (capture: PanoramaCaptureResult) => void | Promise<void>;
}

function XiaoLuoPanoramaFullscreen({
  imageUrl,
  theme,
  onClose,
  onCapture,
}: XiaoLuoPanoramaFullscreenProps) {
  return (
    <PanoramaViewer
      imageUrl={imageUrl}
      imageLoadStrategy="direct"
      theme={theme}
      cornerRadius="10px"
      closeText="退出"
      onClose={onClose}
      onCapture={onCapture}
      className="nodrag nowheel"
    />
  );
}

export default memo(XiaoLuoPanoramaFullscreen);
