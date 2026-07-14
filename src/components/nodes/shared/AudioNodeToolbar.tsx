/**
 * AudioNodeToolbar 音频节点浮动工具栏 + 编辑态支持
 */
import { memo } from 'react';
import { Icon } from '@iconify/react';
import AnimatedButton from '../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../hooks/useToolbarEdit';
import ToolbarEditor from './toolbar/ToolbarEditor';
import { getButtonRegistry } from './toolbar/toolbarRegistry';

interface AudioNodeToolbarProps {
  isPlaying?: boolean;
  onTogglePlay: () => void;
  onUpload: () => void;
}

function AudioNodeToolbar({ isPlaying, onTogglePlay, onUpload }: AudioNodeToolbarProps) {
  const nodeType = 'ai-audio';
  const registry = getButtonRegistry(nodeType);
  const edit = useToolbarEdit({ nodeType });

  const actionMap: Record<string, (e: React.MouseEvent) => void> = {
    togglePlay: (e) => { e.stopPropagation(); onTogglePlay(); },
    upload:     (e) => { e.stopPropagation(); onUpload(); },
  };

  // ── 编辑态 ──
  if (edit.isEditing) {
    return <ToolbarEditor edit={edit} nodeType={nodeType} />;
  }

  // ── 正常态 ──
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

            if (key === 'togglePlay') {
              return (
                <AnimatedButton
                  key={key}
                  className="ftb-btn icon-only act-toggle-play rounded-[6px]"
                  data-tooltip={isPlaying ? '暂停' : '播放'}
                  aria-label={isPlaying ? '暂停' : '播放'}
                  onClick={actionMap[key]}
                >
                  <Icon icon={isPlaying ? 'mdi:pause' : 'mdi:play'} width={14} height={14} />
                </AnimatedButton>
              );
            }

            return (
              <AnimatedButton
                key={key}
                className={`ftb-btn icon-only act-${key} rounded-[6px]`}
                data-tooltip={def.label}
                aria-label={def.label}
                onClick={actionMap[key]}
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

export default memo(AudioNodeToolbar);
