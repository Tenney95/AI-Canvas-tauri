/**
 * MessageBubble — 单条聊天消息气泡
 *
 * 渲染用户 / 助手 / 系统消息，含头像、状态指示器。
 */
import { Icon } from '@iconify/react';
import type { ChatMessage } from '../../types/chat';
import MascotAvatar from './MascotAvatar';

interface MessageBubbleProps {
  message: ChatMessage;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
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
        <div className="whitespace-pre-wrap break-words">{message.content}</div>

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
