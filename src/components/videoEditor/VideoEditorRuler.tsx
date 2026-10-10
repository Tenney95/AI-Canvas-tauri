/** 编辑器适配层：共用刻度尺，擦洗仍沿用多轨吸附语义。 */
import { memo } from 'react';
import { TimelineRuler } from '../shared/Timeline';
import { useT } from '../../i18n';

interface VideoEditorRulerProps {
  duration: number;
  playhead: number;
  pixelsPerSecond: number;
  onScrub: (event: React.PointerEvent<HTMLDivElement>) => void;
  onSeek: (time: number) => void;
}
function VideoEditorRuler(props: VideoEditorRulerProps) {
  const t = useT();
  return <TimelineRuler {...props} label={t('播放头')} />;
}
export default memo(VideoEditorRuler);
