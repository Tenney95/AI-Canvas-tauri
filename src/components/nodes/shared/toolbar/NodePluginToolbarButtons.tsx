import { Icon } from '@iconify/react';
import { useCallback, useMemo, useState } from 'react';
import { getAvailableNodePluginTools } from '../../../../services/plugins/pluginRuntime';
import type { AvailableNodePluginTool } from '../../../../types/plugin';
import { useAppStore } from '../../../../store/useAppStore';
import AnimatedButton from '../../../shared/AnimatedButton';
import NodePluginToolDialog from './NodePluginToolDialog';
import { getPluginToolbarButtonKey } from './toolbarRegistry';

interface UseNodePluginToolbarOptions {
  nodeId: string;
  iconSize?: number;
  rounded?: boolean;
}

export function useNodePluginToolbar({
  nodeId,
  iconSize = 14,
  rounded = false,
}: UseNodePluginToolbarOptions) {
  const plugins = useAppStore((state) => state.installedPlugins);
  const nodeType = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.type);
  const [activeTool, setActiveTool] = useState<AvailableNodePluginTool | null>(null);
  const toolsByKey = useMemo(() => new Map(
    getAvailableNodePluginTools(plugins, nodeType, 'node-toolbar')
      .map((pluginTool) => [getPluginToolbarButtonKey(pluginTool), pluginTool]),
  ), [nodeType, plugins]);

  const renderButton = useCallback((buttonKey: string) => {
    const pluginTool = toolsByKey.get(buttonKey);
    if (!pluginTool) return null;
    const label = `${pluginTool.tool.title} · ${pluginTool.pluginName}`;

    return (
      <AnimatedButton
        key={buttonKey}
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
  }, [iconSize, rounded, toolsByKey]);

  const dialog = activeTool ? (
    <NodePluginToolDialog
      key={getPluginToolbarButtonKey(activeTool)}
      pluginTool={activeTool}
      nodeId={nodeId}
      onClose={() => setActiveTool(null)}
    />
  ) : null;

  return { renderButton, dialog };
}
