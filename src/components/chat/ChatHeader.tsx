/**
 * ChatHeader — 对话面板 Header
 *
 * 品牌区（logo + 标题 + Beta 标签）+ 操作按钮（返回列表 / 独立窗口 / 关闭）
 */
import { type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import MascotAvatar from './MascotAvatar';
import AgentModeSelector from './AgentModeSelector';
import type { AgentMode } from '../../types/agent';

interface ChatHeaderProps {
  detached: boolean;
  /** 是否在分离模式下 */
  chatPanelDetached: boolean;
  /** 项目名（仅分离模式显示） */
  projectName?: string;
  /** 是否显示返回按钮 */
  showBackButton: boolean;
  onBack: () => void;
  onDetachToggle: () => void;
  onClose: () => void;
  agentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  agentModeDisabled?: boolean;
  /** 打开项目记忆管理面板；不提供时不显示入口（如独立窗口） */
  onOpenMemory?: () => void;
  /** 分离模式下由外部传入的 header 操作按钮 */
  detachedHeaderActions?: ReactNode;
}

export default function ChatHeader({
  detached,
  chatPanelDetached,
  projectName,
  showBackButton,
  onBack,
  onDetachToggle,
  onClose,
  agentMode,
  onAgentModeChange,
  agentModeDisabled,
  onOpenMemory,
  detachedHeaderActions,
}: ChatHeaderProps) {
  return (
    <div
      data-tauri-drag-region={detached ? true : undefined}
      className="chat-panel-header flex items-center justify-between gap-2 px-3.5 py-2.5
                 border-b border-canvas-border flex-shrink-0 select-none"
    >
      <div className="chat-panel-header-brand flex items-center gap-1.5 min-w-0">
        {showBackButton && (
          <button
            type="button"
            className="chat-panel-back-btn flex items-center justify-center w-7 h-7 -ml-1 rounded-lg
                       text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover
                       active:scale-95 transition-all"
            onClick={onBack}
            aria-label="返回会话列表"
          >
            <Icon icon="mdi:arrow-left" width="18" height="18" />
          </button>
        )}
        <MascotAvatar size={26} className="shrink-0" />
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="chat-panel-title text-[13px] font-semibold text-canvas-text tracking-tight truncate">
            AI 助手
          </span>
          {detached && projectName && (
            <span className="text-[11px] text-canvas-text-muted truncate max-w-[120px]">
              · {projectName}
            </span>
          )}
          <span className="chat-panel-beta-badge text-[9px] leading-none px-1.5 py-0.5 rounded-full
                           bg-brand/15 text-brand-light font-semibold uppercase tracking-wider">
            Beta
          </span>
        </div>
      </div>

      <div className="chat-panel-header-actions flex items-center gap-1">
        <AgentModeSelector
          mode={agentMode}
          onChange={onAgentModeChange}
          disabled={agentModeDisabled}
        />

        <span className="mx-0.5 h-4 w-px bg-canvas-border" aria-hidden="true" />

        {onOpenMemory && (
          <button
            type="button"
            className="chat-panel-memory-btn flex items-center justify-center w-7 h-7 rounded-lg
                       text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover
                       active:scale-95 transition-all"
            onClick={onOpenMemory}
            data-tooltip="项目记忆"
            aria-label="项目记忆"
          >
            <Icon icon="mdi:brain" width="16" height="16" />
          </button>
        )}

        {detached ? detachedHeaderActions : (
          <>
          {/* 独立窗口按钮 */}
          <button
            type="button"
            className="chat-panel-detach-btn flex items-center justify-center w-7 h-7 rounded-lg
                       text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover
                       active:scale-95 transition-all"
            onClick={onDetachToggle}
            data-tooltip={chatPanelDetached ? '收回内嵌' : '独立窗口'}
            aria-label={chatPanelDetached ? '收回内嵌' : '独立窗口'}
          >
            <Icon icon={chatPanelDetached ? 'mdi:dock-left' : 'mdi:dock-window'} width="16" height="16" />
          </button>

          {/* 关闭按钮 */}
          <button
            type="button"
            className="chat-panel-close-btn flex items-center justify-center w-7 h-7 rounded-lg
                       text-canvas-text-muted hover:text-red-400 hover:bg-red-500/10
                       active:scale-95 transition-all"
            onClick={onClose}
            aria-label="关闭"
          >
            <Icon icon="mdi:close" width="18" height="18" />
          </button>
          </>
        )}
      </div>
    </div>
  );
}
