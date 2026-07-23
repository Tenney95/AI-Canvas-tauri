/**
 * MessageBubble — 单条聊天消息气泡
 *
 * 渲染用户 / 助手 / 系统消息，含头像、状态指示器、生成图片 / 视频。
 */
import { memo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ChatMessage } from '../../types/chat';
import type { AgentTask } from '../../types/agent';
import MascotAvatar from './MascotAvatar';
import AgentTaskTimeline, { type AgentTaskControls } from './AgentTaskTimeline';
import ChatReferenceText, { type ChatReferenceHandlers } from './ChatReferenceText';
import ChatMarkdown from './ChatMarkdown';
import SourceList from './SourceList';

interface MessageBubbleProps extends ChatReferenceHandlers {
  message: ChatMessage;
  agentTask?: AgentTask;
  onAddToCanvas?: (messageId: string) => void;
  onEditMessage?: (content: string) => void;
  regeneratePrompt?: string;
  onRegenerate?: (content: string) => void;
  agentControls?: AgentTaskControls;
}

function formatMessageTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MessageBubble({
  message,
  agentTask,
  onAddToCanvas,
  onEditMessage,
  regeneratePrompt,
  onRegenerate,
  onNodeActivate,
  onNodeHover,
  onModelActivate,
  agentControls,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
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
  const isGenerating = message.mediaStatus === 'queued' || message.mediaStatus === 'generating';
  const showTimeline = !!agentTask
    && !!agentControls
    && (agentTask.steps.length > 0 || agentTask.status !== 'completed');
  // 助手正在响应但任务时间线尚未建立时，先给出明确的活动状态。
  const isThinking = !isUser
    && !message.content
    && !showTimeline
    && !isGenerating
    && ['queued', 'parsing', 'streaming'].includes(message.status);
  const canRegenerate = !isUser
    && !!message.content
    && !!regeneratePrompt
    && !!onRegenerate
    && ['done', 'partial', 'interrupted', 'error', 'canceled'].includes(message.status);

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
    <div className={`chat-message-bubble group flex items-end gap-1.5 ${isUser ? 'justify-end chat-message-user' : 'justify-start chat-message-assistant'}`}>
      {/* Assistant avatar */}
      {!isUser && (
        <MascotAvatar size={20} className="chat-message-avatar chat-message-avatar-assistant shrink-0 mb-0.5" />
      )}

      {/* 悬停时间戳（用户消息在左侧） */}
      {isUser && (
        <span className="chat-message-time shrink-0 self-end mb-1 text-[11px] tabular-nums text-canvas-text-muted opacity-60 transition-opacity group-hover:opacity-100">
          {formatMessageTime(message.timestamp)}
        </span>
      )}

      <div
        className={`chat-message-content max-w-[88%] text-[13px] leading-relaxed
                    ${isUser
                      ? 'rounded-2xl rounded-br-sm bg-indigo-500/15 px-3.5 py-2 text-canvas-text'
                      : 'min-w-0 px-1 py-1 text-canvas-text'
                    }`}
      >
        {isThinking && (
          <div
            className="flex min-h-8 w-fit items-center gap-2 px-1 py-1.5 text-[12px] text-canvas-text-secondary"
            role="status"
            aria-live="polite"
          >
            <Icon
              icon="mdi:loading"
              width="15"
              className="shrink-0 animate-spin text-canvas-text-muted motion-reduce:animate-none"
            />
            <span>正在分析请求</span>
          </div>
        )}
        {message.content && (isUser ? (
          <div className="whitespace-pre-wrap break-words">
            <ChatReferenceText
              value={message.content}
              compact
              onNodeActivate={onNodeActivate}
              onNodeHover={onNodeHover}
              onModelActivate={onModelActivate}
            />
          </div>
        ) : (
          <div className="rounded-2xl rounded-bl-sm border border-canvas-border/80 bg-canvas-card/80 px-3.5 py-2.5 text-canvas-text shadow-sm shadow-black/10 backdrop-blur-sm">
            <ChatMarkdown
              value={message.content}
              onNodeActivate={onNodeActivate}
              onNodeHover={onNodeHover}
              onModelActivate={onModelActivate}
            />
          </div>
        ))}

        {showTimeline && agentTask && agentControls && (
          <AgentTaskTimeline task={agentTask} {...agentControls} />
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
          <div className="chat-message-image mt-1 pt-2 rounded-lg overflow-hidden border border-canvas-border">
            <img
              src={mediaResult.url}
              alt={mediaResult.prompt || '生成的图片'}
              className="w-full h-auto max-h-[280px] object-contain bg-canvas-bg rounded-lg"
              loading="lazy"
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
            <video
              src={mediaResult.url}
              controls
              className="w-full max-h-[280px] bg-canvas-bg"
              preload="metadata"
            >
              您的浏览器不支持视频播放
            </video>
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
              {mediaResult.audioPurpose === 'music' ? '生成的音乐' : '生成的语音'}
            </div>
            <audio src={mediaResult.url} controls className="h-9 w-full" preload="metadata">
              您的浏览器不支持音频播放
            </audio>
            {mediaResult.prompt && (
              <p className="mt-1.5 text-[11px] leading-[17px] text-canvas-text-muted">
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
            添加到画布
          </button>
        )}

        {/* Status indicator */}
        {message.status === 'streaming' && !!message.content && (
          <span className="chat-message-status chat-message-status-streaming inline-block w-1.5 h-3.5 bg-indigo-400/80 animate-pulse ml-1 align-text-bottom rounded-full" />
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

        {!!message.content && (
          <div className={`mt-1 flex h-7 items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${isUser ? 'justify-end' : 'justify-start'}`}>
            <button
              type="button"
              onClick={() => void copyMessage()}
              aria-label={copied ? '消息已复制' : '复制消息'}
              data-tooltip={copied ? '已复制' : '复制'}
              className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
            >
              <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width="14" />
            </button>
            {isUser && onEditMessage && (
              <button
                type="button"
                onClick={() => onEditMessage(message.content)}
                aria-label="编辑并再次发送"
                data-tooltip="编辑并再次发送"
                className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
              >
                <Icon icon="mdi:pencil-outline" width="14" />
              </button>
            )}
            {canRegenerate && (
              <button
                type="button"
                onClick={() => onRegenerate?.(regeneratePrompt || '')}
                aria-label="再次生成回答"
                data-tooltip="再次生成"
                className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
              >
                <Icon icon="mdi:refresh" width="15" />
              </button>
            )}
          </div>
        )}
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
