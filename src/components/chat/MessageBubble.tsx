/**
 * MessageBubble — 单条聊天消息气泡
 *
 * 渲染用户 / 助手 / 系统消息，含头像、状态指示器、生成图片 / 视频。
 */
import { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from '@iconify/react';
import type { ChatMessage } from '../../types/chat';
import type { AgentTask } from '../../types/agent';
import MascotAvatar from './MascotAvatar';
import AgentTaskTimeline, { type AgentTaskControls } from './AgentTaskTimeline';
import ChatReferenceText, { type ChatReferenceHandlers } from './ChatReferenceText';
import ChatMarkdown from './ChatMarkdown';
import SourceList from './SourceList';
import ReasoningPanel from './ReasoningPanel';
import AssistantActivity from './AssistantActivity';
import { useT } from '../../i18n';
import ViewportImage from '../shared/ViewportImage';
import ViewportVideo from '../shared/ViewportVideo';
import ViewportAudio from '../shared/ViewportAudio';
import ChatImageAttachments from './ChatImageAttachments';
import { parseChatImageReferences, stripChatImageReferences } from '../../services/chat/chatImageReferenceService';
import { getRecoverableMessageTaskSnapshot } from '../../services/ai/generationRuntime';
import { hasPendingMessageMediaTask, initializeMediaTaskSnapshot, subscribeMediaTasks, type MediaTaskSnapshot } from '../../services/pollManager';
import { useAppStore } from '../../store/useAppStore';

interface MessageBubbleProps extends ChatReferenceHandlers {
  message: ChatMessage;
  imagePreviewUrls?: Record<string, string>;
  agentTask?: AgentTask;
  onAddToCanvas?: (messageId: string) => void;
  /** 产物落盘失败时重试保存；未传入则不展示重试入口。 */
  onRetryMediaSave?: (messageId: string) => Promise<void>;
  onEditMessage?: (content: string) => void;
  regeneratePrompt?: string;
  onRegenerate?: (content: string) => void;
  onBranch?: (messageId: string) => Promise<void>;
  agentControls?: AgentTaskControls;
}

function formatMessageTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MessageBubble(props: MessageBubbleProps) {
  return props.message.role === 'assistant' ? <AssistantMessageBubble {...props} /> : <MessageBubbleContent {...props} />;
}

function AssistantMessageBubble(props: MessageBubbleProps) {
  const { message } = props;
  const projectId = useAppStore((state) => state.currentProjectId);
  const hasMedia = !!message.mediaStatus || !!message.mediaResult;
  const identity = JSON.stringify([projectId, message.conversationId, message.id]);
  const [legacyMediaIdentity, setLegacyMediaIdentity] = useState<string | null>(null);
  useEffect(() => {
    if (hasMedia || !projectId) return;
    let active = true;
    // 旧消息可能只有账本 mediaContext；同批挂载共享一次初始化，不长期订阅普通文本。
    void initializeMediaTaskSnapshot().then(() => {
      if (active) setLegacyMediaIdentity(hasPendingMessageMediaTask(projectId, message.conversationId, message.id) ? identity : null);
    });
    return () => { active = false; };
  }, [hasMedia, identity, projectId, message.conversationId, message.id]);
  return hasMedia || legacyMediaIdentity === identity
    ? <MediaMessageBubble {...props} projectId={projectId} /> : <MessageBubbleContent {...props} />;
}

function MediaMessageBubble({ projectId, ...props }: MessageBubbleProps & { projectId: string | null }) {
  const recoveryTask = useSyncExternalStore(subscribeMediaTasks,
    () => getRecoverableMessageTaskSnapshot(props.message, projectId), () => undefined);
  return <MessageBubbleContent {...props} recoveryTask={recoveryTask} />;
}

function MessageBubbleContent({
  message,
  imagePreviewUrls,
  agentTask,
  onAddToCanvas,
  onRetryMediaSave,
  onEditMessage,
  regeneratePrompt,
  onRegenerate,
  onBranch,
  onNodeActivate,
  onNodeHover,
  onModelActivate,
  agentControls,
  recoveryTask,
}: MessageBubbleProps & { recoveryTask?: MediaTaskSnapshot }) {
  const t = useT();
  const [branching, setBranching] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [copied, setCopied] = useState(false);
  const [savingMedia, setSavingMedia] = useState(false);
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="chat-message-bubble chat-message-system flex justify-center">
        <span className="text-[11px] text-canvas-text-muted bg-canvas-hover px-2.5 py-0.5 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  const mediaResult = message.mediaResult;
  const showMediaInChat = mediaResult?.deliveryMode !== 'canvas';
  const hasImage = showMediaInChat && mediaResult?.kind === 'image';
  const hasVideo = showMediaInChat && mediaResult?.kind === 'video';
  const hasAudio = showMediaInChat && mediaResult?.kind === 'audio';
  const isGenerating = (message.mediaStatus === 'queued' || message.mediaStatus === 'generating')
    && !recoveryTask?.mediaRecoveryState;
  const taskUnknown = message.mediaStatus === 'submit_unknown'
    || !!recoveryTask && (!recoveryTask.taskId || !recoveryTask.submitted || !!recoveryTask.mediaSubmissionUncertain || recoveryTask.mediaRecoveryState === 'submit_unknown')
    || !!onRetryMediaSave && message.mediaStatus === 'paused' && !recoveryTask && !mediaResult;
  const mediaRecoverable = !isGenerating && (!!recoveryTask || !onRetryMediaSave && message.mediaStatus === 'paused'
    || taskUnknown || !!mediaResult?.taskReceipt && mediaResult.persistence === 'failed');
  // 生成成功 ≠ 已保存到项目：落盘失败时 url 只是临时地址，重启后会失效
  const mediaUnsaved = !isGenerating && mediaResult?.persistence === 'failed';
  const showTimeline = !!agentTask
    && !!agentControls
    && (agentTask.steps.length > 0 || agentTask.status !== 'completed');
  const taskCanWork = !agentTask || ['queued', 'planning', 'running', 'waiting_tool'].includes(agentTask.status);
  const isActive = taskCanWork && ['queued', 'parsing', 'streaming'].includes(message.status);
  const isReasoningActive = isActive && !!message.reasoning && message.status === 'streaming' && message.activity === 'planning';
  const isCompressing = !isUser && isActive && message.activity === 'compressing';
  // 助手正在响应但任务时间线尚未建立时，先给出明确的活动状态。
  const isThinking = !isUser
    && !message.content
    && !showTimeline
    && !isGenerating
    && !isReasoningActive
    && !isCompressing
    && isActive;
  const canRegenerate = !isUser
    && !!message.content
    && !!regeneratePrompt
    && !!onRegenerate
    && ['done', 'partial', 'interrupted', 'error', 'canceled'].includes(message.status);

  const retryMediaSave = async () => {
    if (!onRetryMediaSave || savingMedia) return;
    setSavingMedia(true);
    try {
      await onRetryMediaSave(message.id);
    } finally {
      setSavingMedia(false);
    }
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={`chat-message-bubble group flex items-start gap-2 ${isUser ? 'justify-end chat-message-user' : 'justify-start chat-message-assistant'}`}>
      {/* Assistant avatar */}
      {!isUser && (
        <MascotAvatar size={20} className="chat-message-avatar chat-message-avatar-assistant mt-1.5 shrink-0" />
      )}

      {/* 悬停时间戳（用户消息在左侧） */}
      {isUser && (
        <span className="chat-message-time shrink-0 self-end mb-1 text-[11px] tabular-nums text-canvas-text-muted opacity-60 transition-opacity group-hover:opacity-100">
          {formatMessageTime(message.timestamp)}
        </span>
      )}

      <div
        className={`chat-message-content min-w-0 text-[13px] leading-relaxed
                    ${isUser
                      ? 'max-w-[88%] rounded-2xl rounded-br-sm bg-canvas-hover/60 px-3 py-2 text-canvas-text'
                      : 'flex-1 py-1 text-canvas-text'
                    }`}
      >
        {isThinking && (
          <AssistantActivity label={t(message.activity === 'connecting' ? '正在连接模型' : '正在分析请求')} />
        )}
        {!isUser && message.reasoning && <ReasoningPanel content={message.reasoning} truncated={message.reasoningTruncated}
          active={isReasoningActive} />}
        {isCompressing && !showTimeline && <AssistantActivity label={t('正在压缩上下文')} />}
        {!isUser && message.responseError && <div role="alert" className="ui-alert ui-alert--danger mb-2 break-words">{message.responseError}</div>}
        {isUser && <ChatImageAttachments images={parseChatImageReferences(message.content)} previews={imagePreviewUrls} />}
        {message.content && (isUser ? (
          <div className="whitespace-pre-wrap break-words">
            <ChatReferenceText
              value={stripChatImageReferences(message.content)}
              compact
              onNodeActivate={onNodeActivate}
              onNodeHover={onNodeHover}
              onModelActivate={onModelActivate}
            />
          </div>
        ) : (
          <div className="chat-message-answer min-w-0 text-canvas-text">
            <ChatMarkdown
              value={message.content}
              onNodeActivate={onNodeActivate}
              onNodeHover={onNodeHover}
              onModelActivate={onModelActivate}
            />
            {isActive && message.status === 'streaming' && (!message.activity || message.activity === 'responding') && (
              <span className="chat-message-status chat-message-status-streaming ml-1 inline-block h-3.5 w-1.5 animate-pulse rounded-full bg-canvas-text-secondary align-text-bottom motion-reduce:animate-none" aria-hidden="true" data-performance-motion="essential" />
            )}
          </div>
        ))}

        {showTimeline && agentTask && agentControls && (
          <AgentTaskTimeline task={agentTask} {...agentControls} activity={message.activity} activityStartedAt={message.activityStartedAt} animateActivity={!isReasoningActive} />
        )}

        {/* ── 生成中状态 ── */}
        {isGenerating && (
          <AssistantActivity className="chat-message-media-generating mt-2" label={t('正在生成媒体内容...')} active={taskCanWork && !showTimeline} />
        )}

        {/* ── 图片结果 ── */}
        {hasImage && !isGenerating && (
          <div className="chat-message-image mt-1 pt-2 rounded-lg overflow-hidden border border-canvas-border">
            <ViewportImage
              src={mediaResult.url}
              alt={mediaResult.prompt || t('生成的图片')}
              className="w-full h-auto max-h-[280px] object-contain bg-canvas-bg rounded-lg"
            />
            {mediaResult.prompt && (
              <p className="bg-canvas-bg/60 px-2 py-1.5 text-[11px] leading-[17px] text-canvas-text-muted">
                {mediaResult.prompt}
              </p>
            )}
          </div>
        )}

        {/* ── 视频结果 ── */}
        {hasVideo && !isGenerating && (
          <div className="chat-message-video mt-2 rounded-lg overflow-hidden border border-canvas-border">
            <ViewportVideo
              src={mediaResult.url}
              controls
              className="w-full max-h-[280px] bg-canvas-bg"
              preload="metadata"
            >
              {t('您的浏览器不支持视频播放')}
            </ViewportVideo>
            {mediaResult.prompt && (
              <p className="bg-canvas-bg/60 px-2 py-1.5 text-[11px] leading-[17px] text-canvas-text-muted">
                {mediaResult.prompt}
              </p>
            )}
          </div>
        )}
        {hasAudio && !isGenerating && (
          <div className="chat-message-audio mt-2 rounded-lg border border-canvas-border bg-canvas-bg/60 p-2">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] text-canvas-text-secondary">
              <Icon
                icon={mediaResult.audioPurpose === 'music' ? 'mdi:music-note' : 'mdi:account-voice'}
                width="14"
              />
              {mediaResult.audioPurpose === 'music' ? t('生成的音乐') : t('生成的语音')}
            </div>
            <ViewportAudio src={mediaResult.url} controls className="h-9 w-full" preload="metadata">
              {t('您的浏览器不支持音频播放')}
            </ViewportAudio>
            {mediaResult.prompt && (
              <p className="mt-1.5 text-[11px] leading-[17px] text-canvas-text-muted">
                {mediaResult.prompt}
              </p>
            )}
          </div>
        )}
        {mediaRecoverable && (
          <div className="ui-card mt-2 flex flex-wrap items-center gap-2 p-2 text-xs" role="status">
            <span className="min-w-0 flex-1 text-canvas-text-secondary">
              {taskUnknown ? t('提交状态未知，请到对应平台核对，避免重复生成。') : t('任务已保留，可继续查询或保存原结果。')}
            </span>
            {onRetryMediaSave && !taskUnknown ? (
              <button type="button" className="ui-btn ui-btn--sm" disabled={savingMedia}
                onClick={() => void retryMediaSave()}>{savingMedia ? t('处理中') : t('继续查询 / 保存')}</button>
            ) : !onRetryMediaSave && <span className="text-canvas-text-muted">{t('请回主窗口继续处理此任务')}</span>}
          </div>
        )}
        {mediaUnsaved && !mediaRecoverable && (
          <div className="chat-message-media-unsaved mt-2 flex flex-wrap items-start gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-[11px] text-amber-300">
            <Icon icon="mdi:content-save-alert-outline" width="13" height="13" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t('已生成但未保存到项目：{error}', { error: mediaResult?.persistError || t('写入项目目录失败') })}
            </span>
            {onRetryMediaSave && (
              <button
                type="button"
                onClick={() => void retryMediaSave()}
                disabled={savingMedia}
                className="flex min-h-6 shrink-0 items-center gap-1 rounded border border-amber-400/40 px-1.5 text-[11px] text-amber-200
                           hover:bg-amber-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50 disabled:opacity-60"
              >
                <Icon
                  icon={savingMedia ? 'mdi:loading' : 'mdi:download-outline'}
                  width="12"
                  className={savingMedia ? 'animate-spin motion-reduce:animate-none' : undefined}
                />
                {savingMedia ? t('保存中') : t('重试保存')}
              </button>
            )}
          </div>
        )}
        {message.mediaStatus === 'failed' && !mediaRecoverable && (
          <div className="chat-message-media-error flex items-start gap-1 mt-2 text-[11px] text-red-400">
            <Icon icon="mdi:alert-circle-outline" width="13" height="13" className="mt-0.5 shrink-0" />
            <span>{t('媒体生成失败：{error}', { error: message.mediaError || t('未知错误') })}</span>
          </div>
        )}
        {message.canvasStatus === 'pending' && (
          <div className="mt-2 flex items-center gap-1 text-[11px] text-blue-400">
            <Icon icon="mdi:vector-square" width="13" />
            {t('正在创建画布节点...')}
          </div>
        )}
        {message.canvasStatus === 'created' && message.canvasNodeId && (
          <div className="mt-2 flex items-center gap-1 text-[11px] text-green-400">
            <Icon icon="mdi:check-circle-outline" width="13" />
            {t('已添加到画布')}
          </div>
        )}
        {message.canvasStatus === 'failed' && !mediaRecoverable && (
          <div className="mt-2 flex items-start gap-1 text-[11px] text-red-400">
            <Icon icon="mdi:vector-square-remove" width="13" className="mt-0.5 shrink-0" />
            <span>{t('节点创建失败：{error}', { error: message.canvasError || t('未知错误') })}</span>
          </div>
        )}
        {!isUser && message.sources && message.sources.length > 0 && (
          <SourceList sources={message.sources} />
        )}
        {mediaResult && mediaResult.deliveryMode === 'chat' && message.canvasStatus !== 'created' && onAddToCanvas && (
          <button
            type="button"
            onClick={() => onAddToCanvas(message.id)}
            className="mt-2 flex min-h-8 items-center gap-1.5 rounded-md border border-canvas-border px-2.5 py-1 text-xs text-canvas-text-secondary
                       hover:bg-canvas-card hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
          >
            <Icon icon="mdi:plus-box-outline" width="14" />
            {t('添加到画布')}
          </button>
        )}

        {/* Status indicator */}
        {message.status === 'error' && (
          <div className="chat-message-status chat-message-status-error flex items-center gap-1 mt-1 text-[11px] text-red-400">
            <Icon icon="mdi:alert-circle" width="12" height="12" />
            {t('响应失败')}
          </div>
        )}
        {message.status === 'interrupted' && (
          <div className="chat-message-status chat-message-status-interrupted flex items-center gap-1 mt-1 text-[11px] text-amber-400">
            <Icon icon="mdi:alert-outline" width="12" height="12" />
            {t('响应中断')}
          </div>
        )}

        {!!message.content && (
          <div className={`mt-1 flex h-7 items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${isUser ? 'justify-end' : 'justify-start'}`}>
            <button
              type="button"
              onClick={() => void copyMessage()}
              aria-label={copied ? t('消息已复制') : t('复制消息')}
              data-tooltip={copied ? t('已复制') : t('复制')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
            >
              <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width="14" />
            </button>
            {isUser && onEditMessage && (
              <button
                type="button"
                onClick={() => onEditMessage(message.content)}
                aria-label={t('编辑并再次发送')}
                data-tooltip={t('编辑并再次发送')}
                className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
              >
                <Icon icon="mdi:pencil-outline" width="14" />
              </button>
            )}
            {canRegenerate && (
              <button
                type="button"
                onClick={() => onRegenerate?.(regeneratePrompt || '')}
                aria-label={t('再次生成回答')}
                data-tooltip={t('再次生成')}
                className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
              >
                <Icon icon="mdi:refresh" width="15" />
              </button>
            )}
            {message.role === 'assistant' && message.status === 'done' && onBranch && (
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={branching}
                aria-label={t('从这里分支继续')} onClick={() => {
                  setBranching(true); setBranchError('');
                  void onBranch(message.id).catch((error: unknown) => setBranchError(error instanceof Error ? error.message : t('创建分支失败')))
                    .finally(() => setBranching(false));
                }}><Icon icon="lucide:git-branch" width={14} />{t('从这里分支')}</button>
            )}
          </div>
        )}
        {branchError && <p role="alert" className="text-xs text-danger-light">{branchError}</p>}
      </div>

      {/* 悬停时间戳（助手消息在右侧） */}
      {!isUser && (
        <span className="chat-message-time shrink-0 self-end mb-1 text-[11px] tabular-nums text-canvas-text-muted opacity-60 transition-opacity group-hover:opacity-100">
          {formatMessageTime(message.timestamp)}
        </span>
      )}
    </div>
  );
}

export default memo(MessageBubble);
