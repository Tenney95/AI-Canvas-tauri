/**
 * VideoNodeToolbar 视频节点浮动工具栏 + 编辑态支持
 */
import { memo, useCallback } from 'react';
import { Icon } from '@iconify/react';
import type { NodeType, BaseNodeData } from '../../../types';
import AnimatedButton from '../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../hooks/useToolbarEdit';
import ToolbarEditor from './toolbar/ToolbarEditor';
import { getButtonRegistry } from './toolbar/toolbarRegistry';
import { resolvePresetAction, resolvePresetDef, createPresetNode } from './toolbar/presetAction';
import { executeGeneration } from '../../../services/generationService';
import { requestPresetSequence } from '../../../services/presetSequenceService';
import { useAppStore } from '../../../store/useAppStore';
import type { Node } from '@xyflow/react';

interface VideoNodeToolbarProps {
  nodeId: string;
  onCaptureFrame: () => void;
  onFullscreen: () => void;
  onCopyFile: () => void;
}

function VideoNodeToolbar({ nodeId, onCaptureFrame, onFullscreen, onCopyFile }: VideoNodeToolbarProps) {
  const nodeType = 'ai-video';
  const registry = getButtonRegistry(nodeType);
  const edit = useToolbarEdit({ nodeType });
  const userPresets = useAppStore((s) => s.userPresets);
  const addNodeWithEdge = useAppStore((s) => s.addNodeWithEdge);

  const handlePresetClick = useCallback(
    (key: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      // 实时从 store 读取，避免闭包过期导致对话框内容/ @引用丢失
      const liveNode = useAppStore.getState().nodes.find((n) => n.id === nodeId) as Node<BaseNodeData> | undefined;
      if (!liveNode) return;
      const livePrompt = (liveNode.data?.prompt as string) ?? '';
      const livePresets = useAppStore.getState().userPresets;
      if (requestPresetSequence(key, nodeType as NodeType, nodeId, livePresets)) return;
      const resolved = resolvePresetAction(key, nodeType as NodeType, livePrompt, livePresets);
      if (!resolved) return;
      const { node: newNode, edge } = createPresetNode(liveNode, resolved);
      addNodeWithEdge(newNode, edge);
      executeGeneration(newNode.id, newNode.data.prompt, resolved.postProcess, newNode.data);
    },
    [nodeId, addNodeWithEdge],
  );

  const actionMap: Record<string, (e: React.MouseEvent) => void> = {
    copyFile: (e) => { e.stopPropagation(); onCopyFile(); },
    captureFrame: (e) => { e.stopPropagation(); onCaptureFrame(); },
    fullscreen: (e) => { e.stopPropagation(); onFullscreen(); },
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

            return (
              <AnimatedButton
                key={key}
                className={`ftb-btn icon-only${isPreset ? ' act-preset' : ''} rounded-[6px]`}
                data-tooltip={resolvedDef.label}
                aria-label={resolvedDef.label}
                onClick={clickHandler}
              >
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

export default memo(VideoNodeToolbar);
