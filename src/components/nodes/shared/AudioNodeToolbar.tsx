/**
 * AudioNodeToolbar 音频节点浮动工具栏 + 编辑态支持
 */
import { memo, useCallback } from 'react';
import { Icon } from '@iconify/react';
import type { NodeType, BaseNodeData } from '../../../types';
import AnimatedButton from '../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../hooks/useToolbarEdit';
import ToolbarEditor from './toolbar/ToolbarEditor';
import { getButtonRegistry } from './toolbar/toolbarRegistry';
import { resolvePresetAction, resolvePresetDef } from './toolbar/presetAction';
import { useAppStore } from '../../../store/useAppStore';

interface AudioNodeToolbarProps {
  nodeId: string;
  isPlaying?: boolean;
  onTogglePlay: () => void;
  onUpload: () => void;
}

function AudioNodeToolbar({ nodeId, isPlaying, onTogglePlay, onUpload }: AudioNodeToolbarProps) {
  const nodeType = 'ai-audio';
  const registry = getButtonRegistry(nodeType);
  const edit = useToolbarEdit({ nodeType });
  const nodeData = useAppStore((s) => s.nodes.find((n) => n.id === nodeId)?.data as BaseNodeData | undefined);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const userPresets = useAppStore((s) => s.userPresets);

  const handlePresetClick = useCallback(
    (key: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      const resolved = resolvePresetAction(key, nodeType as NodeType, nodeData?.prompt ?? '', userPresets);
      if (resolved) {
        updateNodeData(nodeId, { prompt: resolved.filledPrompt } as Partial<BaseNodeData>);
      }
    },
    [nodeData?.prompt, userPresets, nodeId, updateNodeData],
  );

  const actionMap: Record<string, (e: React.MouseEvent) => void> = {
    togglePlay: (e) => { e.stopPropagation(); onTogglePlay(); },
    upload:     (e) => { e.stopPropagation(); onUpload(); },
  };

  if (edit.isEditing) {
    return <ToolbarEditor edit={edit} nodeType={nodeType} />;
  }

  return (
    <div className="node-floating-toolbar text-toolbar nodrag" {...edit.longPressHandlers}>
      {edit.layout.zones.map((zone, zi) => (
        <div key={zone.id} className="img-toolbar-zone nodrag">
          {zone.buttonKeys.map((key) => {
            const def = registry.find((d) => d.key === key);
            const handler = actionMap[key];
            const isPreset = !def;

            const presetDef = !def ? resolvePresetDef(key, nodeType as NodeType, userPresets) : null;
            if (!def && !presetDef) return null;

            const resolvedDef = def ?? { key, label: presetDef!.label, icon: presetDef!.icon, defaultZone: '' };
            const clickHandler = handler ?? handlePresetClick(key);

            if (key === 'togglePlay') {
              return (
                <AnimatedButton key={key} className="ftb-btn icon-only act-toggle-play rounded-[6px]"
                  data-tooltip={isPlaying ? '暂停' : '播放'} aria-label={isPlaying ? '暂停' : '播放'}
                  onClick={clickHandler}>
                  <Icon icon={isPlaying ? 'mdi:pause' : 'mdi:play'} width={14} height={14} />
                </AnimatedButton>
              );
            }

            return (
              <AnimatedButton key={key} className={`ftb-btn icon-only${isPreset ? ' act-preset' : ''} rounded-[6px]`}
                data-tooltip={resolvedDef.label} aria-label={resolvedDef.label} onClick={clickHandler}>
                <Icon icon={resolvedDef.icon} width={14} height={14} />
              </AnimatedButton>
            );
          })}
          {zi < edit.layout.zones.length - 1 && <div className="ftb-divider img-toolbar-main-divider" />}
        </div>
      ))}
    </div>
  );
}

export default memo(AudioNodeToolbar);
