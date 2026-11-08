/** ComfyUI 恢复只读取原服务端的原 prompt_id，不重新提交或取消其他任务。 */
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { claimNativeMediaRecovery, failNativeMediaTask, isNativeMediaLeaseCurrent, listNativeMediaTasks,
  normalizeNativeMediaProviderBase } from './indexedDb/nativeMediaTaskRepository';
import { comfyBaseUrlFor } from './comfyServers';
import { pollComfyHistory } from './comfyPolling';
import { resolveComfyOutputUrl } from './comfyOutputs';
import { getProjectDataDir, getRelativeAssetPath, persistMediaUrlToProjectData } from './fileService';
import { sha256BytesHex } from './mediaDataUrl';
import { videoInputData } from './videoBatchPlanning';
import { PollTaskFailedError } from './pollTask';
import { findMediaModelOption } from '../components/nodes/shared/defaultModels';

export const NATIVE_COMFY_VIDEO_PROTOCOL_DIGEST = (workflowId: string) => {
  const workflow = useAppStore.getState().workflows.find((item) => item.id === workflowId);
  if (!workflow || workflow.adapterType && workflow.adapterType !== 'comfyui') throw new Error('原 ComfyUI 工作流不存在');
  return sha256BytesHex(new TextEncoder().encode(JSON.stringify(['comfyui-original-prompt-video-history-v1', workflow.id, workflow.fileContent, workflow.serverId])));
};

export async function resumeNativeComfyTask(operationId: string, externalSignal?: AbortSignal): Promise<void> {
  const state = useAppStore.getState(), context = captureLegacyCanvasContext(state);
  if (!context || context.modelGeneration !== 1) throw new Error('请返回原新项目画布');
  const found = (await listNativeMediaTasks(context.projectId)).find((row) => row.operationId === operationId);
  if (!found || found.canvasId !== context.canvasId || found.providerConfigId !== 'comfyui' || found.category !== 'video') throw new Error('原画布没有该 ComfyUI 视频任务');
  if (found.status === 'delivered') return;
  const record = await claimNativeMediaRecovery(operationId, context);
  if (!record.remoteTaskId || !/^[A-Za-z0-9_-]{1,160}$/.test(record.remoteTaskId)) throw new Error('原 ComfyUI prompt_id 无法安全查询');
  const latest = useAppStore.getState(), node = latest.nodes.find((item) => item.id === record.nodeId);
  const workflowId = node ? videoInputData(node, latest).workflowId : record.origin?.modelId
    ? findMediaModelOption(record.origin.modelId, latest.config.generalModels ?? [], latest.config, latest.workflows)?.workflowId : undefined;
  if (!workflowId || record.protocolDigest !== await NATIVE_COMFY_VIDEO_PROTOCOL_DIGEST(workflowId)) throw new Error('原 ComfyUI 查询协议或工作流已变化，请核对原任务');
  if (normalizeNativeMediaProviderBase(comfyBaseUrlFor(workflowId)) !== record.providerBase) throw new Error('原 ComfyUI 服务配置已变化，请恢复原地址后续查');
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原画布已切换，原 ComfyUI 任务保留');
  };
  const unsubscribe = useAppStore.subscribe(() => { if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) controller.abort(); });
  try {
    assertCurrent();
    const result = await pollComfyHistory(record.providerBase, record.remoteTaskId, '原 ComfyUI 视频尚未取回，任务保留',
      (outputs) => resolveComfyOutputUrl(record.providerBase, outputs, ['video']), signal);
    assertCurrent();
    if (!await isNativeMediaLeaseCurrent(record)) throw new Error('原媒体租约已变化');
    const saved = await persistMediaUrlToProjectData(result.url, record.canvasId, 'ai-video', 'ComfyUI 视频', { signal, assertCurrent });
    assertCurrent();
    const root = await getProjectDataDir(record.canvasId), path = root && saved.filePath && getRelativeAssetPath(saved.filePath, root);
    if (!path || !await isNativeMediaLeaseCurrent(record)) throw new Error('原 ComfyUI 视频未保存或投递租约已变化');
    if (record.origin?.deliveryMode === 'chat') {
      const { commitNativeMediaMessageDelivery } = await import('./nativeMediaDelivery');
      await commitNativeMediaMessageDelivery(record, path, { signal });
    } else await useAppStore.getState().commitNativeMediaResult(record, path, context, signal);
    const { projectNativeMediaMessages } = await import('./nativeMediaMessages');
    await projectNativeMediaMessages().catch(() => {});
  } catch (error) {
    if (error instanceof PollTaskFailedError) await failNativeMediaTask(record).catch(() => {});
    throw error;
  } finally { unsubscribe(); controller.abort(); }
}
