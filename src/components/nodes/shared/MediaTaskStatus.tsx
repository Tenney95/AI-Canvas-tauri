/**
 * MediaTaskStatus — 提供媒体任务状态界面与交互。
 */
import { memo, useEffect, useState, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { discardMediaTask, getNativeMediaNodeRecovery, getPendingTasksForProject, hasMuseQueryIdentity, listNativeMediaNodeImages,
  resumeMediaNodeTask, resumeNativeMediaFromNode, revealNativeMediaNodeImage, reviewNativeMediaFromNode, type NativeMediaNodeImage } from '../../../services/pollManager';
import { isTauriEnv } from '../../../services/fs/core';
import { COMFY_OUTPUT_UNAVAILABLE_MESSAGE, COMFY_TEXT_OUTPUT_UNAVAILABLE_MESSAGE, getComfyQueryAuthorizationMessage } from '../../../services/comfyPolling';
import { useT } from '../../../i18n';
import { GenerationWaitTime } from './NodeGenerationProgress';
import Select from '../../shared/Select';

/** 节点和提示词窗口共用；继续查询只读取原任务，不重新提交生成。 */
function MediaTaskStatus({ nodeId, overlay = false, children }: { nodeId: string; overlay?: boolean; children?: ReactNode }) {
  const t = useT();
  const projectId = useAppStore((state) => state.currentProjectId);
  const taskState = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.mediaTaskState);
  const videoPaused = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.videoTaskState === 'paused');
  const loading = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.status === 'loading');
  const nodeType = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.type);
  const nativeOperationId = useAppStore((state) => getNativeMediaNodeRecovery(nodeId, state));
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const [confirmedIdentity, setConfirmedIdentity] = useState<string>();
  const [saved, setSaved] = useState<{ key: string; images: NativeMediaNodeImage[]; signal: AbortSignal; ordinal?: number }>();
  const [revealing, setRevealing] = useState<AbortSignal>();
  const imageKey = !busy && !loading && projectId && nativeOperationId && taskState === 'delivery_pending'
    && (nodeType === 'ai-image' || nodeType === 'ai-animation' || nodeType === 'ai-panorama') && isTauriEnv()
    ? JSON.stringify([projectId, nodeId, nativeOperationId]) : undefined;
  useEffect(() => {
    if (!imageKey || !nativeOperationId) return;
    const controller = new AbortController();
    void listNativeMediaNodeImages(nodeId, nativeOperationId, controller.signal).then((images) => {
      if (!controller.signal.aborted) setSaved({ key: imageKey, images, signal: controller.signal });
    }).catch(() => { /* 原图尚不能核实时，仍可继续取回任务。 */ });
    return () => controller.abort();
  }, [imageKey, nativeOperationId, nodeId]);
  const originals = saved && saved.key === imageKey && !saved.signal.aborted ? saved : undefined;
  const selected = originals?.images.find((image) => image.ordinal === originals.ordinal) ?? originals?.images[0];
  const opening = !!originals && revealing === originals.signal;
  const task = !nativeOperationId && projectId && (taskState || videoPaused) ? getPendingTasksForProject(projectId).find((item) => item.nodeId === nodeId
    || item.mediaContext?.canvasNodeId === nodeId) : undefined;
  if (loading || (!taskState && !videoPaused) || (!task && !nativeOperationId)) return null;

  const deliveryPending = taskState === 'delivery_pending' || task?.mediaRecoveryState === 'delivery_pending';
  const resumeLabel = t(selected ? '继续回填' : deliveryPending && (!task || task.taskType === 'comfyui' && task.nodeType === 'ai-video')
    ? '继续保存' : '继续查询 / 保存');
  const imageMessage = t(selected ? '原图已保存到本机，尚未回填到节点。' : '图片尚未回填，可继续取回原结果。');
  const reveal = async () => {
    if (!selected || !originals || !nativeOperationId || originals.signal.aborted || opening) return;
    setRevealing(originals.signal);
    try {
      await revealNativeMediaNodeImage(nodeId, nativeOperationId, selected, originals.signal);
    } catch {
      if (!originals.signal.aborted) showToast(t('无法定位这张原图，请检查本机项目目录。'), 'error');
    } finally {
      if (!originals.signal.aborted) setRevealing(undefined);
    }
  };
  const resume = () => {
    if (busy || opening) return;
    const result = task ? resumeMediaNodeTask(task.nodeId)
      : nativeOperationId ? resumeNativeMediaFromNode(nodeId, nativeOperationId) : undefined;
    if (!result) return;
    setBusy(true);
    void result.catch((error: unknown) => {
      if (imageKey && getNativeMediaNodeRecovery(nodeId) !== nativeOperationId) return;
      if (selected && error instanceof Error && error.name === 'NativeMediaInputChanged') {
        showToast(t('生成时的输入与当前节点不符，可查看已保存原图。'), 'error');
        return;
      }
      showToast(imageKey ? imageMessage : t(deliveryPending ? '媒体已生成，保存或回填尚未完成；可继续取回原结果。'
        : '暂时无法继续查询，请检查连接配置'), 'error');
    }).finally(() => setBusy(false));
  };

  const canQuery = task ? hasMuseQueryIdentity(task)
    || task.submitted && !!task.taskId && !task.mediaSubmissionUncertain && task.mediaRecoveryState !== 'submit_unknown'
    : !!nativeOperationId && taskState !== 'submit_unknown';
  const authorizationMessage = getComfyQueryAuthorizationMessage(task?.comfyQueryHttpStatus);
  const message = !canQuery
    ? t('提交状态未知，请到对应平台核对；应用不会自动重新生成。')
    : task?.taskType === 'comfyui' && task.comfyRecoveryState === 'output_unavailable'
      ? t(task.nodeType === 'ai-text' ? COMFY_TEXT_OUTPUT_UNAVAILABLE_MESSAGE : COMFY_OUTPUT_UNAVAILABLE_MESSAGE)
      : (authorizationMessage ? t(authorizationMessage) : task?.videoRecoveryMessage) || (imageKey ? imageMessage : deliveryPending
        ? task?.nodeType === 'ai-text' ? t('文本已生成，回填或保存尚未完成；可继续取回原结果。')
          : t('媒体已生成，保存或回填尚未完成；可继续取回原结果。')
        : t('查询已暂停，任务已保留'));
  const diagnostic = task?.mediaFailureDiagnostic;
  const httpStatus = (diagnostic?.kind === 'http' || diagnostic?.kind === 'persistence') && typeof diagnostic.httpStatus === 'number'
    && Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 400 && diagnostic.httpStatus <= 599
    ? diagnostic.httpStatus : undefined;
  const persistenceMessages = {
    timeout: t('下载等待超时，原任务已保留，可继续取回'),
    network: t('下载连接中断，原任务已保留，可继续取回'),
    path_access: t('保存目录未获应用授权，请在设置中重新选择目录'),
    permission: t('保存目录无法写入，请检查目录权限'),
    disk_space: t('目标磁盘空间不足，清理后可继续保存'),
    missing_file: t('项目目录或源文件不存在，请检查保存位置'),
    invalid_media: t('下载内容为空、不完整或格式无效，可继续取回原任务'),
    connection_changed: t('原连接或接口地址已变化，请检查原连接配置'),
    missing_key: t('原连接尚未填写 Key，请补填后继续保存'),
    unknown: t('媒体保存失败，请检查保存目录和媒体来源'),
    http: t('媒体下载请求失败，原任务已保留'),
  };
  const diagnosticMessage = diagnostic?.kind === 'persistence'
    ? httpStatus !== undefined
      ? t(httpStatus === 401 || httpStatus === 403 ? '下载鉴权被拒绝（HTTP {status}），请检查原连接的 Key 或权限'
        : httpStatus === 404 || httpStatus === 410 ? '下载地址已失效或资源不存在（HTTP {status}），可继续查询原任务'
          : '媒体下载失败（HTTP {status}），原任务已保留', { status: httpStatus })
      : persistenceMessages[diagnostic.failureKind ?? 'unknown']
    : diagnostic?.kind === 'canvas_changed' || task?.mediaRecoveryReason === 'canvas_changed'
      ? t('画布已变化，结果未回填；请在原节点继续取回')
    : httpStatus !== undefined
    ? t(httpStatus === 504 || httpStatus === 408 ? '等待服务商响应超时（HTTP {status}）'
      : httpStatus === 429 ? '接口限频或容量不足（HTTP {status}）'
        : httpStatus >= 500 ? '服务商或网关返回异常（HTTP {status}）' : '接口请求被拒绝（HTTP {status}）', { status: httpStatus })
    : diagnostic?.kind === 'timeout' ? t('等待服务商响应超时，尚未确认最终结果')
      : diagnostic?.kind === 'network' ? t('网络连接中断，未收到完整结果') : undefined;
  const taskNodeType = task?.nodeType ?? nodeType;
  const kind = taskNodeType === 'ai-video' ? 'video' : taskNodeType === 'ai-text' ? 'text' : taskNodeType === 'ai-audio' ? 'audio' : 'image';
  const identity = nativeOperationId ? JSON.stringify([projectId, nodeId, nativeOperationId])
    : task ? JSON.stringify([task.projectId, task.nodeId, task.taskId, task.attemptId]) : undefined;
  const review = () => {
    if (!identity || confirmedIdentity !== identity || busy || canQuery) return;
    if (task) {
      discardMediaTask({ projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId });
      return;
    }
    if (!nativeOperationId) return;
    setBusy(true);
    void reviewNativeMediaFromNode(nodeId, nativeOperationId).catch(() => {
      setConfirmedIdentity(undefined);
      showToast(t('原媒体任务未能解除占用，请重新核对。'), 'error');
    }).finally(() => setBusy(false));
  };
  return <div className={overlay ? 'generation-progress-overlay generation-progress-overlay--interactive nodrag nopan text-center'
    : 'ui-card nodrag nopan flex flex-wrap items-center gap-2 p-2'}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}>
    <div className={`flex min-w-0 flex-col gap-1${overlay ? ' max-w-full items-center' : ' flex-1'}`}>
      <span role="status" className={`break-words text-canvas-text-secondary${overlay ? ' line-clamp-3 text-[11px]' : ' text-xs'}`} title={message}>{message}</span>
      {diagnosticMessage && <span className={`break-words text-canvas-text-secondary${overlay ? ' text-[11px]' : ' text-xs'}`} title={diagnosticMessage}>{diagnosticMessage}</span>}
      <GenerationWaitTime nodeId={nodeId} />
      {identity && !canQuery && !overlay && <details className="text-xs text-canvas-text-secondary">
        <summary className="cursor-pointer">{t('在平台确认任务结束后解除限制')}</summary>
        <p className="my-2">{t(nativeOperationId ? '原任务回执会保留。再次生成会发起新的请求。' : '解除本地记录不会取消平台任务。')}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmedIdentity === identity}
          onChange={(event) => setConfirmedIdentity(event.target.checked ? identity : undefined)} />
          {t('我已在平台确认任务未提交或已经结束')}</label>
        <button type="button" className="ui-btn ui-btn--sm mt-2" disabled={confirmedIdentity !== identity || busy} onClick={review}>
          {t(nativeOperationId ? '结束跟踪' : '清除本地恢复记录')}
        </button>
      </details>}
    </div>
    {!canQuery && overlay && <button type="button" className={`ui-btn ui-btn--sm ui-btn--node-${kind} shrink-0`}
      onClick={() => useAppStore.getState().openNodeDialog(nodeId)}>{t('查看任务详情')}</button>}
    {originals && selected && <div className="flex flex-wrap items-center justify-center gap-1">
      {originals.images.length > 1 && <Select size="sm" value={selected.ordinal} disabled={opening}
        aria-label={t('选择已保存的原图')}
        options={originals.images.map((image) => ({ value: String(image.ordinal), label: t('原图 {number}', { number: image.ordinal + 1 }) }))}
        onChange={(value) => setSaved({ ...originals, ordinal: Number(value) })} />}
      <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={opening}
        onClick={() => void reveal()}>{t('查看已保存原图')}</button>
    </div>}
    {canQuery && <button type="button" className={`ui-btn ui-btn--sm ui-btn--node-${kind} shrink-0`} disabled={busy || opening}
      aria-label={resumeLabel} onClick={resume}>
      <RotateCw size={14} aria-hidden="true" />{resumeLabel}
    </button>}
    {children}
  </div>;
}

export default memo(MediaTaskStatus);
