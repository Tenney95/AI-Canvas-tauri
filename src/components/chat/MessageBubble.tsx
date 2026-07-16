/**
 * MessageBubble — 单条聊天消息气泡
 *
 * 渲染用户 / 助手 / 系统消息，含头像、状态指示器、生成图片 / 视频。
 */
import { Icon } from '@iconify/react';
import type { ChatMessage } from '../../types/chat';
import type { AgentTask } from '../../types/agent';
import MascotAvatar from './MascotAvatar';
import SourceList from './SourceList';

interface MessageBubbleProps {
  message: ChatMessage;
  agentTask?: AgentTask;
  onAddToCanvas?: (messageId: string) => void;
  onResolveApproval?: (approvalId: string, approved: boolean) => void;
}

export default function MessageBubble({
  message,
  agentTask,
  onAddToCanvas,
  onResolveApproval,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="chat-message-bubble chat-message-system flex justify-center">
        <span className="text-[11px] text-canvas-text-muted bg-canvas-hover px-3 py-1 rounded-full">
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
  const isGenerating = message.mediaStatus === 'queued' || message.mediaStatus === 'generating';
  const pendingApprovalStep = agentTask?.steps.find(
    (step) => step.approval?.status === 'pending',
  );

  return (
    <div className={`chat-message-bubble flex ${isUser ? 'justify-end chat-message-user' : 'justify-start chat-message-assistant'}`}>
      {/* Assistant avatar */}
      {!isUser && (
        <MascotAvatar size={28} className="chat-message-avatar chat-message-avatar-assistant shrink-0 mr-2 mt-0.5" />
      )}

      <div
        className={`chat-message-content max-w-[80%] px-3.5 py-2.5 rounded-xl text-sm leading-relaxed
                    ${isUser
                      ? 'bg-indigo-500/20 text-canvas-text rounded-br-md'
                      : 'bg-canvas-hover text-canvas-text rounded-bl-md'
                    }`}
      >
        {message.content && (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        )}

        {pendingApprovalStep?.approval && onResolveApproval && (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
            <div className="flex items-start gap-2">
              <Icon icon="mdi:shield-check-outline" width="16" className="mt-0.5 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-amber-300">
                  {pendingApprovalStep.title}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-canvas-text-secondary">
                  {pendingApprovalStep.toolCall?.inputSummary || pendingApprovalStep.approval.summary}
                </p>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => onResolveApproval(pendingApprovalStep.approval!.id, false)}
                className="rounded-md px-2.5 py-1 text-[11px] text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text"
              >
                拒绝
              </button>
              <button
                type="button"
                onClick={() => onResolveApproval(pendingApprovalStep.approval!.id, true)}
                className="rounded-md bg-amber-400 px-2.5 py-1 text-[11px] font-medium text-black hover:bg-amber-300"
              >
                确认执行
              </button>
            </div>
          </div>
        )}

        {/* ── 生成中状态 ── */}
        {isGenerating && (
          <div className="chat-message-media-generating flex items-center gap-2 mt-2 text-[11px] text-canvas-text-muted">
            <span className="inline-block w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            正在生成媒体内容...
          </div>
        )}

        {/* ── 图片结果 ── */}
        {hasImage && !isGenerating && (
          <div className="chat-message-image mt-2 rounded-lg overflow-hidden border border-canvas-border">
            <img
              src={mediaResult.url}
              alt={mediaResult.prompt || '生成的图片'}
              className="w-full h-auto max-h-[280px] object-contain bg-canvas-bg"
              loading="lazy"
            />
            {mediaResult.prompt && (
              <p className="text-[10px] text-canvas-text-muted px-2 py-1.5 bg-canvas-bg/60">
                {mediaResult.prompt}
              </p>
            )}
          </div>
        )}

        {/* ── 视频结果 ── */}
        {hasVideo && !isGenerating && (
          <div className="chat-message-video mt-2 rounded-lg overflow-hidden border border-canvas-border">
            <video
              src={mediaResult.url}
              controls
              className="w-full max-h-[280px] bg-canvas-bg"
              preload="metadata"
            >
              您的浏览器不支持视频播放
            </video>
            {mediaResult.prompt && (
              <p className="text-[10px] text-canvas-text-muted px-2 py-1.5 bg-canvas-bg/60">
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
              {mediaResult.audioPurpose === 'music' ? '生成的音乐' : '生成的语音'}
            </div>
            <audio src={mediaResult.url} controls className="h-9 w-full" preload="metadata">
              您的浏览器不支持音频播放
            </audio>
            {mediaResult.prompt && (
              <p className="mt-1.5 text-[10px] text-canvas-text-muted">
                {mediaResult.prompt}
              </p>
            )}
          </div>
        )}
        {message.mediaStatus === 'failed' && (
          <div className="chat-message-media-error flex items-start gap-1 mt-2 text-[11px] text-red-400">
            <Icon icon="mdi:alert-circle-outline" width="13" height="13" className="mt-0.5 shrink-0" />
            <span>媒体生成失败：{message.mediaError || '未知错误'}</span>
          </div>
        )}
        {message.canvasStatus === 'pending' && (
          <div className="mt-2 flex items-center gap-1 text-[11px] text-blue-400">
            <Icon icon="mdi:vector-square" width="13" />
            正在创建画布节点...
          </div>
        )}
        {message.canvasStatus === 'created' && message.canvasNodeId && (
          <div className="mt-2 flex items-center gap-1 text-[11px] text-green-400">
            <Icon icon="mdi:check-circle-outline" width="13" />
            已添加到画布
          </div>
        )}
        {message.canvasStatus === 'failed' && (
          <div className="mt-2 flex items-start gap-1 text-[11px] text-red-400">
            <Icon icon="mdi:vector-square-remove" width="13" className="mt-0.5 shrink-0" />
            <span>节点创建失败：{message.canvasError || '未知错误'}</span>
          </div>
        )}
        {mediaResult && mediaResult.deliveryMode === 'chat' && message.canvasStatus !== 'created' && onAddToCanvas && (
          <button
            type="button"
            onClick={() => onAddToCanvas(message.id)}
            className="mt-2 flex items-center gap-1 rounded-md border border-canvas-border px-2 py-1 text-[11px] text-canvas-text-secondary hover:bg-canvas-card hover:text-canvas-text"
          >
            <Icon icon="mdi:plus-box-outline" width="14" />
            添加到画布
          </button>
        )}

        {/* Status indicator */}
        {message.status === 'streaming' && (
          <span className="chat-message-status chat-message-status-streaming inline-block w-2 h-3 bg-indigo-400 animate-pulse ml-1 align-middle rounded-sm" />
        )}
        {message.status === 'error' && (
          <div className="chat-message-status chat-message-status-error flex items-center gap-1 mt-1 text-[11px] text-red-400">
            <Icon icon="mdi:alert-circle" width="12" height="12" />
            响应失败
          </div>
        )}
        {message.status === 'interrupted' && (
          <div className="chat-message-status chat-message-status-interrupted flex items-center gap-1 mt-1 text-[11px] text-amber-400">
            <Icon icon="mdi:alert-outline" width="12" height="12" />
            响应中断
          </div>
        )}
        {!isUser && message.sources && message.sources.length > 0 && (
          <SourceList sources={message.sources} />
        )}
      </div>

      {/* User avatar */}
      {isUser && (
        <div className="chat-message-avatar chat-message-avatar-user flex-shrink-0 w-7 h-7 rounded-lg bg-canvas-hover flex items-center justify-center ml-2 mt-0.5">
          <Icon icon="mdi:account" width="14" height="14" className="text-canvas-text-secondary" />
        </div>
      )}
    </div>
  );
}
