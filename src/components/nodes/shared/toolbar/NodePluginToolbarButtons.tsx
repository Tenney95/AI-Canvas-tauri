import { Icon } from '@iconify/react';
import { useState } from 'react';
import { getAvailableNodePluginTools } from '../../../../services/plugins/pluginRuntime';
import type { AvailableNodePluginTool } from '../../../../types/plugin';
import { useAppStore } from '../../../../store/useAppStore';
import AnimatedButton from '../../../shared/AnimatedButton';
import NodePluginToolDialog from './NodePluginToolDialog';

interface NodePluginToolbarButtonsProps {
  nodeId: string;
  iconSize?: number;
  dividerClassName: string;
  rounded?: boolean;
}

export default function NodePluginToolbarButtons({
  nodeId,
  iconSize = 14,
  dividerClassName,
  rounded = false,
}: NodePluginToolbarButtonsProps) {
  const plugins = useAppStore((state) => state.installedPlugins);
  const nodeType = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.type);
  const [activeTool, setActiveTool] = useState<AvailableNodePluginTool | null>(null);
  const tools = getAvailableNodePluginTools(plugins, nodeType, 'node-toolbar');

  if (tools.length === 0) return null;

  return (
    <>
      <div className={`ftb-divider ${dividerClassName}`} />
      <div className="img-toolbar-zone nodrag" data-toolbar-plugin-zone>
        {tools.map((pluginTool) => {
          const key = `${pluginTool.pluginId}:${pluginTool.tool.id}`;
          const label = `${pluginTool.tool.title} · ${pluginTool.pluginName}`;
          return (
            <AnimatedButton
              key={key}
              type="button"
              className={`ftb-btn icon-only act-plugin${rounded ? ' rounded-[6px]' : ''}`}
              data-tooltip={label}
              aria-label={`${pluginTool.tool.title}（${pluginTool.pluginName}）`}
              onClick={(event) => {
                event.stopPropagation();
                setActiveTool(pluginTool);
              }}
            >
              <Icon
                icon={pluginTool.tool.icon || 'lucide:blocks'}
                width={iconSize}
                height={iconSize}
              />
            </AnimatedButton>
          );
        })}
      </div>
      {activeTool && (
        <NodePluginToolDialog
          key={`${activeTool.pluginId}:${activeTool.tool.id}`}
          pluginTool={activeTool}
          nodeId={nodeId}
          onClose={() => setActiveTool(null)}
        />
      )}
    </>
  );
}
