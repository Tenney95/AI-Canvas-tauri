import { useAppStore } from '../../../store/useAppStore';
import type { PluginInspectInput } from '../../../types/plugin';
import { inspectPluginContract, PLUGIN_INSPECT_SCHEMA } from '../../plugins/pluginContractCatalog';
import { inspectPluginHealth } from '../../plugins/pluginHealthService';
import { registerAgentTool } from '../toolRegistry';

export function registerPluginInspectionTools(): Array<() => void> {
  return [registerAgentTool<PluginInspectInput>({
    id: 'plugin_host_inspect', title: '读取插件宿主合同', effect: 'read',
    description: '分页读取真实插件 API、能力额度、Manifest、隔离 UI 合同和安装摘要。只读，无任意内部服务、源码或凭据；配置启用不代表原生活动状态。',
    inputSchema: PLUGIN_INSPECT_SCHEMA,
    summarizeInput: () => '读取插件公开合同',
    execute: async (context, input) => {
      if (context.signal.aborted) return { status: 'error', summary: '查询已取消', modelContent: '查询已取消' };
      try {
        const plugins = useAppStore.getState().installedPlugins;
        const result = inspectPluginContract(input, plugins);
        await Promise.all(result.entries.filter((entry) => entry.section === 'plugins').map(async (entry) => {
          const plugin = plugins.find((item) => item.id === entry.id);
          if (!plugin || context.signal.aborted) return;
          const health = await inspectPluginHealth(plugin, plugins);
          entry.contract = { ...entry.contract, nativeHealth: { ...health, reasons: health.reasons.slice(0, 4) } };
        }));
        if (context.signal.aborted) return { status: 'error', summary: '查询已取消', modelContent: '查询已取消' };
        while (result.entries.length && new TextEncoder().encode(JSON.stringify(result)).length > 16 * 1024) result.entries.pop();
        result.nextOffset = (input.offset ?? 0) + result.entries.length;
        result.hasMore = result.nextOffset < result.total;
        return { status: 'success', summary: `返回 ${result.entries.length} 项插件合同`, modelContent: JSON.stringify(result) };
      } catch { return { status: 'error', summary: '插件合同查询参数无效', modelContent: '插件合同查询参数无效' }; }
    },
  })];
}
