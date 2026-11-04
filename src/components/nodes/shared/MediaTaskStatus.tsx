/**
 * MediaTaskStatus — 提供媒体任务状态界面与交互。
 */
import { memo, useState, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { discardMediaTask, getPendingTasksForProject, resumeMediaNodeTask } from '../../../services/pollManager';
import { COMFY_OUTPUT_UNAVAILABLE_MESSAGE, getComfyQueryAuthorizationMessage } from '../../../services/comfyPolling';
import { useT } from '../../../i18n';
import { GenerationWaitTime } from './NodeGenerationProgress';

/** 节点和提示词窗口共用；继续查询只读取原任务，不重新提交生成。 */
function MediaTaskStatus({ nodeId, overlay = false, children }: { nodeId: string; overlay?: boolean; children?: ReactNode }) {
  const t = useT();
  const projectId = useAppStore((state) => state.currentProjectId);
  const taskState = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.mediaTaskState);
  const videoPaused = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.videoTaskState === 'paused');
  const loading = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.status === 'loading');
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const [confirmedIdentity, setConfirmedIdentity] = useState<string>();
  const task = projectId && (taskState || videoPaused) ? getPendingTasksForProject(projectId).find((item) => item.nodeId === nodeId
    || item.mediaContext?.canvasNodeId === nodeId) : undefined;
  if (!task || loading || (!taskState && !videoPaused)) return null;

  const canQuery = task.submitted && !!task.taskId && !task.mediaSubmissionUncertain && task.mediaRecoveryState !== 'submit_unknown';
  const deliveryPending = taskState === 'delivery_pending' || task.mediaRecoveryState === 'delivery_pending';
  const authorizationMessage = getComfyQueryAuthorizationMessage(task.comfyQueryHttpStatus);
  const message = !canQuery
    ? t('提交状态未知，请到对应平台核对；应用不会自动重新生成。')
    : task.taskType === 'comfyui' && task.comfyRecoveryState === 'output_unavailable'
      ? t(COMFY_OUTPUT_UNAVAILABLE_MESSAGE)
      : (authorizationMessage ? t(authorizationMessage) : task.videoRecoveryMessage) || (deliveryPending
        ? t('媒体已生成，保存或回填尚未完成；可继续取回原结果。')
        : t('查询已暂停，任务已保留'));
  const diagnostic = task.mediaFailureDiagnostic;
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
    : diagnostic?.kind === 'canvas_changed' || task.mediaRecoveryReason === 'canvas_changed'
      ? t('画布已变化，结果未回填；请在原节点继续取回')
    : httpStatus !== undefined
    ? t(httpStatus === 504 || httpStatus === 408 ? '等待服务商响应超时（HTTP {status}）'
      : httpStatus === 429 ? '接口限频或容量不足（HTTP {status}）'
        : httpStatus >= 500 ? '服务商或网关返回异常（HTTP {status}）' : '接口请求被拒绝（HTTP {status}）', { status: httpStatus })
    : diagnostic?.kind === 'timeout' ? t('等待服务商响应超时，尚未确认最终结果')
      : diagnostic?.kind === 'network' ? t('网络连接中断，未收到完整结果') : undefined;
  const kind = task.nodeType === 'ai-audio' ? 'audio' : task.nodeType === 'ai-video' ? 'video' : 'image';
  const identity = JSON.stringify([task.projectId, task.nodeId, task.taskId, task.attemptId]);
  return <div className={overlay ? 'generation-progress-overlay generation-progress-overlay--interactive nodrag nopan text-center'
    : 'ui-card nodrag nopan flex flex-wrap items-center gap-2 p-2'} role="status"
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}>
    <div className={`flex min-w-0 flex-col gap-1${overlay ? ' max-w-full items-center' : ' flex-1'}`}>
      <span className={`break-words text-canvas-text-secondary${overlay ? ' line-clamp-3 text-[11px]' : ' text-xs'}`} title={message}>{message}</span>
      {diagnosticMessage && <span className={`break-words text-canvas-text-secondary${overlay ? ' text-[11px]' : ' text-xs'}`} title={diagnosticMessage}>{diagnosticMessage}</span>}
      <GenerationWaitTime nodeId={nodeId} />
      {!canQuery && !overlay && <details className="text-xs text-canvas-text-secondary">
        <summary className="cursor-pointer">{t('在平台确认任务结束后解除限制')}</summary>
        <p className="my-2">{t('解除本地记录不会取消平台任务。')}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmedIdentity === identity}
          onChange={(event) => setConfirmedIdentity(event.target.checked ? identity : undefined)} />
          {t('我已在平台确认任务未提交或已经结束')}</label>
        <button type="button" className="ui-btn ui-btn--sm mt-2" disabled={confirmedIdentity !== identity || busy}
          onClick={() => discardMediaTask({ projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId })}>
          {t('清除本地恢复记录')}
        </button>
      </details>}
    </div>
    {!canQuery && overlay && <button type="button" className={`ui-btn ui-btn--sm ui-btn--node-${kind} shrink-0`}
      onClick={() => useAppStore.getState().openNodeDialog(nodeId)}>{t('查看任务详情')}</button>}
    {canQuery && <button type="button" className={`ui-btn ui-btn--sm ui-btn--node-${kind} shrink-0`} disabled={busy}
      aria-label={t('继续查询 / 保存')}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void resumeMediaNodeTask(task.nodeId).catch(() => {
          showToast(t('暂时无法继续查询，请检查连接配置'), 'error');
        }).finally(() => setBusy(false));
      }}>
      <RotateCw size={14} aria-hidden="true" />{t('继续查询 / 保存')}
    </button>}
    {children}
  </div>;
}

export default memo(MediaTaskStatus);
