/**
 * ChatHeader — 对话面板 Header
 *
 * 品牌区（logo + 标题 + Beta 标签）+ 操作按钮（返回列表 / 独立窗口 / 关闭）
 */
import { type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import MascotAvatar from './MascotAvatar';
import AgentModeSelector from './AgentModeSelector';
import ContextUsageIndicator from './ContextUsageIndicator';
import type { AgentMode } from '../../types/agent';
import type { ContextUsageStat } from '../../services/chat/contextManager';

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
  /** 当前会话上下文占用（估算）；无会话时为 null */
  contextUsage?: ContextUsageStat | null;
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
  contextUsage,
  onOpenMemory,
  detachedHeaderActions,
}: ChatHeaderProps) {
  return (
    <div
      data-tauri-drag-region={detached ? true : undefined}
      className="chat-panel-header flex items-center justify-between px-4 py-3 border-b border-canvas-border flex-shrink-0 select-none"
    >
      <div className="chat-panel-header-brand flex items-center gap-2">
        {showBackButton && (
          <button
            type="button"
            className="chat-panel-back-btn flex items-center justify-center w-6 h-6 rounded-md text-canvas-text-muted
                       hover:text-canvas-text hover:bg-canvas-hover transition-colors"
            onClick={onBack}
          >
            <Icon icon="mdi:menu" width="16" height="16" />
          </button>
        )}
        <div className="flex items-center gap-2">
          <MascotAvatar size={28} className="shrink-0" />
          <span className="chat-panel-title text-sm font-medium text-canvas-text">
            AI 助手
          </span>
          {detached && projectName && (
            <span className="text-[11px] text-canvas-text-muted truncate max-w-[120px]">
              — {projectName}
            </span>
          )}
          <span className="chat-panel-beta-badge text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 font-medium uppercase">
            Beta
          </span>
        </div>
      </div>

      <div className="chat-panel-header-actions flex items-center gap-1">
        <ContextUsageIndicator usage={contextUsage ?? null} />
        <AgentModeSelector
          mode={agentMode}
          onChange={onAgentModeChange}
          disabled={agentModeDisabled}
        />

        {onOpenMemory && (
          <button
            type="button"
            className="chat-panel-memory-btn flex items-center justify-center w-7 h-7 rounded-md text-canvas-text-muted
                       hover:text-canvas-text hover:bg-canvas-hover transition-colors"
            onClick={onOpenMemory}
            data-tooltip="项目记忆"
          >
            <Icon icon="mdi:brain" width="16" height="16" />
          </button>
        )}

        {detached ? detachedHeaderActions : (
          <>
          {/* 独立窗口按钮 */}
          <button
            type="button"
            className="chat-panel-detach-btn flex items-center justify-center w-7 h-7 rounded-md text-canvas-text-muted
                       hover:text-canvas-text hover:bg-canvas-hover transition-colors"
            onClick={onDetachToggle}
            data-tooltip={chatPanelDetached ? '收回内嵌' : '独立窗口'}
          >
            <Icon icon={chatPanelDetached ? 'mdi:dock-left' : 'mdi:dock-window'} width="16" height="16" />
          </button>

          {/* 关闭按钮 */}
          <button
            type="button"
            className="chat-panel-close-btn flex items-center justify-center w-7 h-7 rounded-md text-canvas-text-muted
                       hover:text-canvas-text hover:bg-canvas-hover transition-colors"
            onClick={onClose}
          >
            <Icon icon="mdi:close" width="16" height="16" />
          </button>
          </>
        )}
      </div>
    </div>
  );
}
