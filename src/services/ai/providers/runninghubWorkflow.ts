import { isRemoteMediaUrl } from '../../../utils/mediaUrl';
import { useAppStore } from '../../../store/useAppStore';
import type { RunningHubConnection, RunningHubMediaKind, RunningHubOutput, RunningHubWorkflowManifest } from '../../../types/runninghub';
import { runningHubFieldValue, runningHubParameterKey, validateRunningHubManifest, isRecord } from '../../runninghubWorkflowService';
import { runningHubConnection, isRunningHubWorkflow, saveCloudWorkflowOutputs, getCloudWorkflowPersistedOutput } from '../../workflowExecutionService';
import { runningHubRequest, uploadRunningHubMedia, RunningHubRequestError } from './runninghubClient';
import { pollTask } from '../../pollTask';
import { cancelNodePolling, cleanupNodePolling, getPendingTasksForProject, registerNodePolling, removePendingTask, savePendingTask, updatePendingTask } from '../../pollManager';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../canvasDerivationGuard';

export class RunningHubTaskFailed extends Error {}
export type RunningHubReferences = Partial<Record<RunningHubMediaKind, string[]>>;

/** 云适配器已保存全部产物，调用方直接使用保存结果，避免再次下载 asset URL。 */
export function getRunningHubPersistedOutput(outputs: RunningHubOutput[] | undefined, url: string) {
  return getCloudWorkflowPersistedOutput(outputs, url);
}

export async function saveRunningHubOutputs(outputs: RunningHubOutput[], projectId: string | null, label: string, isCurrent: () => boolean): Promise<RunningHubOutput[]> {
  return saveCloudWorkflowOutputs(outputs, projectId, label, isCurrent, 'RunningHub');
}

export async function buildRunningHubInputs(
  connection: RunningHubConnection,
  manifest: RunningHubWorkflowManifest,
  prompt: string,
  inputs: Record<string, string> = {},
  references: RunningHubReferences = {},
  signal?: AbortSignal,
) {
  validateRunningHubManifest(manifest);
  const mapped = new Set(manifest.parameters.map(runningHubParameterKey));
  if (Object.keys(inputs).some((key) => !mapped.has(key))) throw new Error('工作流参数已变化，请重新选择工作流并检查参数');
  // 所有纯参数先校验，避免在可发现的字段错误之前上传素材。
  const values = manifest.parameters.map((field) => ({ field, value: field.source === 'value'
    ? runningHubFieldValue(field, inputs[runningHubParameterKey(field)]) : field.defaultValue }));
  const uploaded = new Map<string, Awaited<ReturnType<typeof uploadRunningHubMedia>>>();
  const result = [];
  for (const { field, value } of values) {
    signal?.throwIfAborted();
    let fieldValue = value;
    if (field.source === 'prompt') fieldValue = prompt;
    else if (field.source !== 'value') {
      const source = inputs[runningHubParameterKey(field)] || references[field.source]?.[field.referenceIndex ?? 0];
      if (source) {
        if (field.mediaFormat === 'url' && isRemoteMediaUrl(source)) fieldValue = source;
        else {
          const cacheKey = `${field.source}:${source}`;
          let upload = uploaded.get(cacheKey);
          if (!upload) { upload = await uploadRunningHubMedia(connection, source, field.source, signal); uploaded.set(cacheKey, upload); }
          fieldValue = field.mediaFormat === 'url' ? upload.url : upload.filename;
        }
      } else if (!value || field.required) throw new Error(`请提供${field.label}对应的参考素材`);
    }
    if (field.required && fieldValue === '') throw new Error(`请填写${field.label}`);
    result.push({ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue });
  }
  return result;
}

export function parseRunningHubOutputs(payload: unknown, kind: RunningHubMediaKind, outputNodeIds: string[] = []): RunningHubOutput[] {
  if (!Array.isArray(payload)) throw new Error('RunningHub 任务结果格式无效');
  const result: RunningHubOutput[] = [];
  for (const item of payload) {
    if (!isRecord(item) || typeof item.fileUrl !== 'string' || typeof item.fileType !== 'string') continue;
    let url: URL;
    try { url = new URL(item.fileUrl); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    const type = item.fileType.toLowerCase().replace(/^\./, '');
    const mediaKind = /^(?:image|png|jpg|jpeg|webp|gif|avif|bmp)$/.test(type) ? 'image'
      : /^(?:video|mp4|webm|mov|mkv)$/.test(type) ? 'video'
        : /^(?:audio|wav|mp3|ogg|flac|m4a|aac)$/.test(type) ? 'audio' : undefined;
    const nodeId = typeof item.nodeId === 'string' ? item.nodeId : typeof item.nodeId === 'number' && Number.isSafeInteger(item.nodeId) ? String(item.nodeId) : undefined;
    if (mediaKind !== kind || (outputNodeIds.length && (!nodeId || !outputNodeIds.includes(nodeId)))) continue;
    result.push({ url: url.toString(), kind, nodeId });
  }
  if (!result.length) throw new Error('RunningHub 已完成，但未找到所选类型/输出节点的产物，请检查工作流输出设置');
  return result;
}

export async function queryRunningHubWorkflow(
  connection: RunningHubConnection,
  taskId: string,
  kind: RunningHubMediaKind,
  outputNodeIds: string[] = [],
  signal?: AbortSignal,
  onStatus?: (status: string) => void,
): Promise<RunningHubOutput[]> {
  return pollTask({
    signal, interval: 3000, maxDuration: 2 * 60 * 60 * 1000,
    timeoutMsg: 'RunningHub 查询超时，任务已保留，可继续查询',
    fetchState: async () => {
      const result = await runningHubRequest(connection, '/task/openapi/status', { taskId }, signal);
      const status = typeof result.data === 'string' ? result.data.toUpperCase() : '';
      if (['FAILED', 'CANCELED', 'CANCELLED'].includes(status)) throw new RunningHubTaskFailed(`RunningHub 任务${status === 'FAILED' ? '执行失败' : '已取消'}`);
      if (['QUEUED', 'RUNNING'].includes(status)) { onStatus?.(status === 'QUEUED' ? '排队中' : '生成中'); return null; }
      if (status !== 'SUCCESS') throw new Error('RunningHub 返回未知任务状态，任务已保留');
      onStatus?.('读取产物');
      const output = await runningHubRequest(connection, '/task/openapi/outputs', { taskId }, signal);
      return parseRunningHubOutputs(output.data, kind, outputNodeIds);
    },
    isComplete: (outputs) => outputs,
  });
}

export async function executeRunningHubWorkflow(params: {
  workflowId: string; prompt: string; kind: RunningHubMediaKind; nodeId?: string;
  workflowInputs?: Record<string, string>; references?: RunningHubReferences;
  runninghubTaskContext?: import('../../../types/runninghub').RunningHubTaskContext;
}, externalSignal?: AbortSignal): Promise<RunningHubOutput[]> {
  const store = useAppStore.getState();
  const workflow = store.workflows.find((item) => item.id === params.workflowId);
  if (!isRunningHubWorkflow(workflow) || !workflow?.runninghub) throw new Error('未找到 RunningHub 工作流，请重新导入');
  const manifest = workflow.runninghub;
  validateRunningHubManifest(manifest);
  if (workflow.category !== `ai-${params.kind}`) throw new Error('工作流输出类型与生成节点不一致');
  const connection = runningHubConnection(store.config.providers, manifest.connectionId);
  const context = params.runninghubTaskContext;
  const projectId = context?.projectId ?? store.currentProjectId;
  const nodeId = params.nodeId;
  const trackingId = nodeId ?? (context ? `runninghub-message-${context.messageId}` : undefined);
  if (trackingId && projectId && getPendingTasksForProject(projectId).some((task) => task.nodeId === trackingId && task.taskType === 'runninghub-workflow')) throw new Error('已有 RunningHub 任务，请先继续查询或确认远端任务结束');
  const nodeSignal = trackingId ? registerNodePolling(trackingId) : undefined;
  const signal = nodeSignal && externalSignal ? AbortSignal.any([nodeSignal, externalSignal]) : nodeSignal ?? externalSignal;
  const guard = nodeId ? registerCanvasDerivation(store, nodeId) : null;
  const fresh = () => !signal?.aborted && (!nodeId || (!!guard && isCanvasDerivationFresh(guard, useAppStore.getState())))
    && (!context || (useAppStore.getState().currentProjectId === context.projectId && useAppStore.getState().messages.some((message) => message.id === context.messageId && message.conversationId === context.conversationId)));
  const stage = (runninghubStage: string) => { if (nodeId && fresh()) useAppStore.getState().updateNodeDataTransient(nodeId, { runninghubStage }); };
  let taskId = '';
  let submitting = false;
  try {
    stage('上传素材');
    if (!fresh()) throw new Error('当前项目或对话已变化，未提交任务');
    const nodeInfoList = await buildRunningHubInputs(connection, manifest, params.prompt, params.workflowInputs, params.references, signal);
    if (!fresh()) throw new Error('画布已变化，请重新生成');
    stage('提交任务');
    if (trackingId && projectId) savePendingTask({ nodeId: trackingId, projectId, nodeType: workflow.category, provider: 'runninghubwf', providerConfigId: manifest.connectionId, taskType: 'runninghub-workflow', taskId: '', submitted: false, runninghubRecoveryState: 'submit_unknown', runninghubOutputNodeIds: manifest.outputNodeIds, runninghubWorkflowId: workflow.id, runninghubMessage: context });
    submitting = true;
    const response = await runningHubRequest(connection, manifest.kind === 'app' ? '/task/openapi/ai-app/run' : '/task/openapi/create', {
      [manifest.kind === 'app' ? 'webappId' : 'workflowId']: manifest.remoteId,
      nodeInfoList,
      ...(manifest.instanceType && manifest.instanceType !== 'default' ? { instanceType: manifest.instanceType } : {}),
      ...(manifest.kind === 'workflow' ? { addMetadata: false, usePersonalQueue: manifest.usePersonalQueue ?? false } : {}),
    }, signal);
    const data = isRecord(response.data) ? response.data : {};
    if (typeof data.taskId !== 'string' || !/^\d{1,30}$/.test(data.taskId)) throw new Error('RunningHub 未返回有效任务 ID，请到平台确认提交状态');
    taskId = data.taskId;
    if (trackingId) updatePendingTask(trackingId, { taskId, submitted: true, runninghubRecoveryState: 'disconnected' }, '');
    const outputs = await queryRunningHubWorkflow(connection, taskId, params.kind, manifest.outputNodeIds, signal, stage);
    if (!fresh()) throw new Error('画布已变化，RunningHub 产物已保留，请继续查询');
    if (trackingId) updatePendingTask(trackingId, { runninghubRecoveryState: 'save_pending' }, taskId);
    stage('保存产物');
    const saved = await saveRunningHubOutputs(outputs, projectId, workflow.name, fresh);
    if (nodeId) {
      useAppStore.getState().updateNodeDataTransient(nodeId, { runninghubOutputs: saved, runninghubStage: '保存产物' });
    }
    return saved;
  } catch (error) {
    if (trackingId && (error instanceof RunningHubTaskFailed || (submitting && !taskId && error instanceof RunningHubRequestError && error.httpStatus < 500 && ![408, 429].includes(error.httpStatus)))) removePendingTask(trackingId, taskId);
    if (nodeId && fresh()) stage(taskId ? '任务已保留，可继续查询' : submitting ? '提交状态待确认' : '未提交');
    else if (nodeId && useAppStore.getState().currentProjectId === projectId && useAppStore.getState().nodes.some((item) => item.id === nodeId) && getPendingTasksForProject(projectId ?? '').some((item) => item.nodeId === nodeId && item.taskId === taskId)) {
      useAppStore.getState().updateNodeDataTransient(nodeId, { status: 'error', error: '查询已停止，任务已保留，可继续查询' });
    }
    if (!nodeId && context && taskId && !(error instanceof RunningHubTaskFailed)) throw new Error(`RunningHub 任务 ${taskId} 已保留，重新打开项目时继续查询。`, { cause: error });
    throw error;
  } finally {
    if (guard) completeCanvasDerivation(guard);
    if (trackingId) cleanupNodePolling(trackingId, nodeSignal);
  }
}

export async function cancelRunningHubNodeTask(nodeId: string): Promise<'cancelled' | 'local-stopped'> {
  const store = useAppStore.getState();
  const task = store.currentProjectId ? getPendingTasksForProject(store.currentProjectId).find((item) => item.nodeId === nodeId && ['runninghub-workflow', 'runninghub-model'].includes(item.taskType)) : undefined;
  cancelNodePolling(nodeId, true);
  if (!task || task.taskType === 'runninghub-model') return 'local-stopped';
  if (!task.taskId) throw new Error('提交状态未知，请先到 RunningHub 平台确认任务');
  updatePendingTask(nodeId, { runninghubRecoveryState: 'cancel_pending' }, task.taskId);
  const connection = runningHubConnection(store.config.providers, task.providerConfigId === 'runninghub-model' ? 'runninghub-model' : 'runninghub');
  await runningHubRequest(connection, '/task/openapi/cancel', { taskId: task.taskId });
  const status = await runningHubRequest(connection, '/task/openapi/status', { taskId: task.taskId });
  if (['FAILED', 'CANCELED', 'CANCELLED'].includes(String(status.data).toUpperCase())) {
    removePendingTask(nodeId, task.taskId); return 'cancelled';
  }
  if (status.data === 'SUCCESS') {
    updatePendingTask(nodeId, { runninghubRecoveryState: 'save_pending' }, task.taskId);
    throw new Error('任务已完成，请继续查询并保存产物');
  }
  throw new Error('RunningHub 已接受取消请求，但尚未确认任务结束，请继续查询或稍后再次终止');
}

/** 仅在调用方已完成保存与回填后结束恢复记录；失败时保留任务供保存重试。 */
export function completeRunningHubNodeTask(nodeId: string): void {
  const store = useAppStore.getState();
  const task = store.currentProjectId ? getPendingTasksForProject(store.currentProjectId).find((item) => item.nodeId === nodeId && ['runninghub-workflow', 'runninghub-model'].includes(item.taskType)) : undefined;
  if (task?.runninghubRecoveryState === 'save_pending' && !task.runninghubSubmissionUncertain) {
    removePendingTask(nodeId, task.taskId);
    store.updateNodeDataTransient(nodeId, { runninghubStage: '已完成' });
  }
}
