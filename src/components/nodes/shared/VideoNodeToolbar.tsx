/**
 * VideoNodeToolbar 视频节点浮动工具栏 + 编辑态支持
 */
import { memo } from 'react';
import { Icon } from '@iconify/react';
import AnimatedButton from '../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../hooks/useToolbarEdit';
import ToolbarEditor from './toolbar/ToolbarEditor';
import { getButtonRegistry } from './toolbar/toolbarRegistry';

interface VideoNodeToolbarProps {
  onCaptureFrame: () => void;
  onFullscreen: () => void;
}

function VideoNodeToolbar({ onCaptureFrame, onFullscreen }: VideoNodeToolbarProps) {
  const nodeType = 'ai-video';
  const registry = getButtonRegistry(nodeType);
  const edit = useToolbarEdit({ nodeType });

  const actionMap: Record<string, () => void> = {
    captureFrame: onCaptureFrame,
    fullscreen: onFullscreen,
  };

  // ── 编辑态 ──
  if (edit.isEditing) {
    return <ToolbarEditor edit={edit} nodeType={nodeType} />;
  }

  // ── 正常态：按布局渲染 ──
  return (
    <div
      className="node-floating-toolbar text-toolbar nodrag"
      {...edit.longPressHandlers}
    >
      {edit.layout.zones.map((zone, zi) => (
        <div key={zone.id} className="img-toolbar-zone nodrag">
          {zone.buttonKeys.map((key) => {
            const def = registry.find((d) => d.key === key);
            if (!def || !actionMap[key]) return null;
            return (
              <AnimatedButton
                key={key}
                className={`ftb-btn icon-only act-${key} rounded-[6px]`}
                data-tooltip={def.label}
                aria-label={def.label}
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); actionMap[key]?.(); }}
              >
                <Icon icon={def.icon} width={14} height={14} />
              </AnimatedButton>
            );
          })}
          {zi < edit.layout.zones.length - 1 && (
            <div className="ftb-divider img-toolbar-main-divider" />
          )}
        </div>
      ))}
    </div>
  );
}

export default memo(VideoNodeToolbar);
