/**
 * 全屏承载小逻全景查看器，并把截图结果和关闭操作回传给全景节点。
 */
import { memo } from 'react';
import { PanoramaViewer } from './internal/PanoramaViewer';
import type { PanoramaCaptureResult } from '../../../types/panorama';
import { useT } from '../../../i18n';

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
  const t = useT();
  return (
    <PanoramaViewer
      key={imageUrl}
      imageUrl={imageUrl}
      captureMode="ratio"
      theme={theme}
      cornerRadius="6px"
      closeText={t('退出')}
      onClose={onClose}
      onCapture={onCapture}
      className="xiaoluo-panorama-compact nodrag nowheel"
    />
  );
}

export default memo(XiaoLuoPanoramaFullscreen);
