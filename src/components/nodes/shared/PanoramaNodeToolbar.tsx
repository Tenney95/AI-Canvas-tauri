/**
 * PanoramaNodeToolbar 全景图节点浮动工具栏 + 编辑态支持
 */
import { memo, useCallback } from 'react';
import { Icon } from '@iconify/react';
import AnimatedButton from '../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../hooks/useToolbarEdit';
import ToolbarEditor from './toolbar/ToolbarEditor';
import { getButtonRegistry } from './toolbar/toolbarRegistry';

interface PanoramaNodeToolbarProps {
  onUpload?: () => void;
  onToggleMode?: () => void;
  previewMode?: 'image' | '360';
  onScreenshot?: () => void;
  onFullscreen?: () => void;
}

function PanoramaNodeToolbar({
  onUpload,
  onToggleMode,
  previewMode,
  onScreenshot,
  onFullscreen,
}: PanoramaNodeToolbarProps) {
  const nodeType = 'ai-panorama';
  const registry = getButtonRegistry(nodeType);
  const edit = useToolbarEdit({ nodeType });

  const actionMap: Record<string, (e: React.MouseEvent) => void> = {
    upload:     (e) => { e.stopPropagation(); onUpload?.(); },
    toggleMode: (e) => { e.stopPropagation(); onToggleMode?.(); },
    screenshot: (e) => { e.stopPropagation(); onScreenshot?.(); },
    fullscreen: (e) => { e.stopPropagation(); onFullscreen?.(); },
  };

  // ── 编辑态 ──
  if (edit.isEditing) {
    return <ToolbarEditor edit={edit} nodeType={nodeType} />;
  }

  // ── 正常态：按布局渲染 ──
  return (
    <div
      className="node-floating-toolbar pano-toolbar nodrag"
      {...edit.longPressHandlers}
    >
      <div className="pano-toolbar-main nodrag">
        {edit.layout.zones.map((zone, zi) => (
          <div key={zone.id} className="img-toolbar-zone nodrag">
            {zone.buttonKeys.map((key) => {
              const def = registry.find((d) => d.key === key);
              if (!def || !actionMap[key]) return null;

              // toggleMode 按钮根据当前模式显示不同图标
              if (key === 'toggleMode') {
                return (
                  <AnimatedButton
                    key={key}
                    className="ftb-btn icon-only act-mode"
                    data-tooltip={previewMode === '360' ? '切换到图片视图' : '切换到360全景'}
                    aria-label="切换视图模式"
                    onClick={actionMap[key]}
                  >
                    {previewMode === '360' ? (
                      <Icon icon="mdi:image-outline" width={14} height={14} />
                    ) : (
                      <Icon icon="mdi:rotate-3d" width={14} height={14} />
                    )}
                  </AnimatedButton>
                );
              }

              return (
                <AnimatedButton
                  key={key}
                  className={`ftb-btn icon-only act-${key}`}
                  data-tooltip={def.label}
                  aria-label={def.label}
                  onClick={actionMap[key]}
                >
                  <Icon icon={def.icon} width={14} height={14} />
                </AnimatedButton>
              );
            })}
            {zi < edit.layout.zones.length - 1 && (
              <div className="ftb-divider pano-toolbar-divider" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(PanoramaNodeToolbar);
