/**
 * comfyServers — ComfyUI 服务端地址解析。
 *
 * 图片与视频分开部署时，工作流各自绑定一台服务端（WorkflowDefinition.serverId），
 * 没绑定、或绑定的服务端已被删掉时一律回落到默认地址 config.comfyUIUrl。
 */
import { useAppStore } from '../store/useAppStore';

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';

function normalize(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '');
}

/** 工作流实际要提交到的服务端地址；都没配时返回空串，由调用方决定报错还是回落。 */
export function comfyBaseUrlFor(workflowId?: string): string {
  const { config, workflows } = useAppStore.getState();
  const serverId = workflowId
    ? workflows.find((workflow) => workflow.id === workflowId)?.serverId
    : undefined;
  const bound = serverId
    ? config.comfyServers?.find((server) => server.id === serverId)?.url
    : undefined;
  return normalize(bound) || normalize(config.comfyUIUrl);
}

/** 服务端在设置里的显示名；找不到（已删除）时返回 undefined，界面按「默认」处理。 */
export function comfyServerName(serverId: string | undefined): string | undefined {
  if (!serverId) return undefined;
  return useAppStore.getState().config.comfyServers?.find((server) => server.id === serverId)?.name;
}
