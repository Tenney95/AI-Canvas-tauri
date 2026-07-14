/**
 * TextNodeToolbar 文本节点浮动工具栏 + 编辑态支持
 */
import { memo, useState, useCallback } from 'react';
import { Icon } from '@iconify/react';
import type { BaseNodeData, NodeType } from '../../../types';
import AnimatedButton from '../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../hooks/useToolbarEdit';
import ToolbarEditor from './toolbar/ToolbarEditor';
import { getButtonRegistry } from './toolbar/toolbarRegistry';
import { resolvePresetAction, resolvePresetDef, createPresetNode } from './toolbar/presetAction';
import { executeGeneration } from '../../../services/generationService';
import { useAppStore } from '../../../store/useAppStore';
import type { Node } from '@xyflow/react';

interface TextNodeToolbarProps {
  nodeId: string;
  data: BaseNodeData;
  onCopy: (text: string) => void;
  onClearEmptyLines: () => void;
  onShowPrompt: () => void;
  onFullscreen: () => void;
}

function TextNodeToolbar({ nodeId, data, onCopy, onClearEmptyLines, onShowPrompt, onFullscreen }: TextNodeToolbarProps) {
  const nodeType = 'ai-text';
  const registry = getButtonRegistry(nodeType);
  const edit = useToolbarEdit({ nodeType });
  const userPresets = useAppStore((s) => s.userPresets);

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!data.output) return;
      onCopy(data.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [data.output, onCopy],
  );

  const handleClearEmptyLines = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!data.output) return;
      onClearEmptyLines();
    },
    [data.output, onClearEmptyLines],
  );

  const addNodeWithEdge = useAppStore((s) => s.addNodeWithEdge);

  const handlePresetClick = useCallback(
    (key: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      // 实时从 store 读取，避免闭包过期导致对话框内容/ @引用丢失
      const liveNode = useAppStore.getState().nodes.find((n) => n.id === nodeId) as Node<BaseNodeData> | undefined;
      if (!liveNode) return;
      const livePrompt = (liveNode.data?.prompt as string) ?? '';
      const livePresets = useAppStore.getState().userPresets;
      const resolved = resolvePresetAction(key, nodeType as NodeType, livePrompt, livePresets);
      if (!resolved) return;
      const { node: newNode, edge } = createPresetNode(liveNode, resolved);
      addNodeWithEdge(newNode, edge);
      // 强制用带 @ 引用的 prompt（createPresetNode 已拼好）
      executeGeneration(newNode.id, newNode.data.prompt as string, resolved.postProcess, newNode.data);
    },
    [nodeId, addNodeWithEdge],
  );

  const actionMap: Record<string, (e: React.MouseEvent) => void> = {
    copy: handleCopy,
    clearEmptyLines: handleClearEmptyLines,
    showPrompt: (e) => { e.stopPropagation(); onShowPrompt(); },
    fullscreen: (e) => { e.stopPropagation(); onFullscreen(); },
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
            const handler = actionMap[key];
            const isPreset = !def;

            // 查找预设的显示信息
            const presetDef = !def ? resolvePresetDef(key, nodeType as NodeType, userPresets) : null;
            if (!def && !presetDef) return null;

            const resolvedDef = def ?? { key, label: presetDef!.label, icon: presetDef!.icon, defaultZone: '' };
            const clickHandler = handler ?? handlePresetClick(key);

            // copy 按钮有 copied 态
            if (key === 'copy' && copied) {
              return (
                <AnimatedButton
                  key={key}
                  className="ftb-btn icon-only act-copy rounded-[6px]"
                  data-tooltip="已复制"
                  aria-label="复制"
                  onClick={clickHandler}
                >
                  <Icon icon="mdi:check" width={12} height={12} />
                </AnimatedButton>
              );
            }

            return (
              <AnimatedButton
                key={key}
                className={`ftb-btn icon-only${isPreset ? ' act-preset' : ''} rounded-[6px]`}
                data-tooltip={resolvedDef.label}
                aria-label={resolvedDef.label}
                onClick={clickHandler}
              >
                <Icon icon={resolvedDef.icon} width={12} height={12} />
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

export default memo(TextNodeToolbar);
