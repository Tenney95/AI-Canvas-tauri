/**
 * ConversationList — 会话列表组件
 * 展示当前项目的全部会话，支持新建、切换、搜索、置顶、归档、重命名、删除
 */
import { useState, useCallback } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import type { ChatConversation } from '../../types/chat';
import type { AgentTask, AgentTaskStatus } from '../../types/agent';
import AnimatedButton from '../shared/AnimatedButton';

interface ConversationListProps {
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 外部提供的会话列表（独立窗口模式） */
  conversations?: import('../../types/chat').ChatConversation[];
  /** 外部提供的活动会话 ID（独立窗口模式） */
  activeConversationId?: string | null;
  /** 独立窗口模式下由主窗口同步的 Agent 任务。 */
  agentTasks?: AgentTask[];
  /** 外部提供的项目 ID（独立窗口模式） */
  projectId?: string;
  /** 独立窗口模式下的回调 */
  onRenameConversation?: (id: string, title: string) => void;
  onTogglePin?: (id: string) => void;
  onArchiveConversation?: (id: string) => void;
  onDeleteConversation?: (id: string) => void;
}

export default function ConversationList({
  onSelect,
  onNew,
  conversations: extConversations,
  activeConversationId: extActiveId,
  agentTasks: extAgentTasks,
  onRenameConversation,
  onTogglePin: extTogglePin,
  onArchiveConversation,
  onDeleteConversation,
}: ConversationListProps) {
  const isExternal = !!extConversations; // 独立窗口模式判断
  const reduceMotion = useReducedMotion();

  const store = useAppStore(
    useShallow((s) => ({
      conversations: s.conversations,
      activeConversationId: s.activeConversationId,
      currentProjectId: s.currentProjectId,
      updateConversation: s.updateConversation,
      removeConversation: s.removeConversation,
      agentTasks: s.agentTasks,
    })),
  );

  const conversations = extConversations ?? store.conversations;
  const activeConversationId = extActiveId !== undefined ? extActiveId : store.activeConversationId;
  const agentTasks = extAgentTasks ?? store.agentTasks;

  const latestTaskByConversation = new Map<string, AgentTask>();
  for (const task of agentTasks) {
    if (task.status === 'completed' || task.status === 'stopped') continue;
    const current = latestTaskByConversation.get(task.conversationId);
    if (!current || current.updatedAt < task.updatedAt) {
      latestTaskByConversation.set(task.conversationId, task);
    }
  }

  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // 过滤：搜索 + 非归档 + 非回收站
  const filtered = conversations.filter((c) => {
    if (c.archived || c.deletedAt) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.title.toLowerCase().includes(q) ||
      (c.lastMessagePreview || '').toLowerCase().includes(q)
    );
  });

  const handleRename = useCallback(
    (conv: ChatConversation) => {
      setRenamingId(conv.id);
      setRenameValue(conv.title);
    },
    [],
  );

  const handleRenameConfirm = useCallback(
    (conv: ChatConversation) => {
      const trimmed = renameValue.trim();
      if (trimmed && trimmed !== conv.title) {
        if (isExternal) {
          onRenameConversation?.(conv.id, trimmed);
        } else {
          store.updateConversation(conv.id, {
            title: trimmed,
            titleSource: 'user',
          });
        }
      }
      setRenamingId(null);
    },
    [renameValue, isExternal, onRenameConversation, store],
  );

  const handleTogglePin = useCallback(
    (conv: ChatConversation) => {
      if (isExternal) {
        extTogglePin?.(conv.id);
      } else {
        store.updateConversation(conv.id, { pinned: !conv.pinned });
      }
    },
    [isExternal, extTogglePin, store],
  );

  const handleArchive = useCallback(
    (conv: ChatConversation) => {
      if (isExternal) {
        onArchiveConversation?.(conv.id);
      } else {
        store.updateConversation(conv.id, { archived: true });
      }
    },
    [isExternal, onArchiveConversation, store],
  );

  const handleDelete = useCallback(
    (conv: ChatConversation) => {
      if (isExternal) {
        onDeleteConversation?.(conv.id);
      } else {
        store.updateConversation(conv.id, { deletedAt: Date.now() });
        store.removeConversation(conv.id);
      }
    },
    [isExternal, onDeleteConversation, store],
  );

  // 分组：置顶 / 普通
  const pinned = filtered.filter((c) => c.pinned);
  const normal = filtered.filter((c) => !c.pinned);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-canvas-border">
        <span className="text-xs font-semibold text-canvas-text-muted">
          对话
        </span>
        <AnimatedButton
          scale={1.05}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-canvas-text-secondary transition-colors
                     hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
          onClick={onNew}
          data-tooltip="新对话"
        >
          <Icon icon="mdi:plus" width="16" height="16" />
        </AnimatedButton>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Icon
            icon="mdi:magnify"
            width="14"
            height="14"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-canvas-text-muted"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="搜索对话"
            placeholder="搜索对话…"
            className="w-full h-8 pl-7 pr-3 text-xs bg-canvas-bg border border-canvas-border rounded-lg
                       text-canvas-text placeholder:text-canvas-text-muted
                       focus:outline-none focus:border-canvas-text-secondary transition-colors"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
        <AnimatePresence>
          {filtered.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: reduceMotion ? 0.1 : 0.18 }}
              className="flex flex-col items-center justify-center py-8 text-xs text-canvas-text-muted"
            >
              <Icon icon="mdi:chat-outline" width="28" height="28" className="mb-2 opacity-40" />
              {searchQuery ? '没有匹配的对话' : '还没有对话'}
            </motion.div>
          )}

          {/* Pinned section */}
          {pinned.length > 0 && (
            <>
              <div className="px-2 py-1 text-[11px] font-medium text-canvas-text-muted">
                置顶
              </div>
              {pinned.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
                  agentTaskStatus={latestTaskByConversation.get(conv.id)?.status}
                  reduceMotion={reduceMotion}
                  active={conv.id === activeConversationId}
                  renaming={renamingId === conv.id}
                  renameValue={renameValue}
                  onRenameValueChange={setRenameValue}
                  onRenameConfirm={() => handleRenameConfirm(conv)}
                  onClick={() => onSelect(conv.id)}
                  onRename={() => handleRename(conv)}
                  onTogglePin={() => handleTogglePin(conv)}
                  onArchive={() => handleArchive(conv)}
                  onDelete={() => handleDelete(conv)}
                />
              ))}
            </>
          )}

          {/* Normal section */}
          {normal.length > 0 && (
            <>
              {pinned.length > 0 && (
                <div className="px-2 py-1 text-[11px] font-medium text-canvas-text-muted">
                  最近
                </div>
              )}
              {normal.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
                  agentTaskStatus={latestTaskByConversation.get(conv.id)?.status}
                  reduceMotion={reduceMotion}
                  active={conv.id === activeConversationId}
                  renaming={renamingId === conv.id}
                  renameValue={renameValue}
                  onRenameValueChange={setRenameValue}
                  onRenameConfirm={() => handleRenameConfirm(conv)}
                  onClick={() => onSelect(conv.id)}
                  onRename={() => handleRename(conv)}
                  onTogglePin={() => handleTogglePin(conv)}
                  onArchive={() => handleArchive(conv)}
                  onDelete={() => handleDelete(conv)}
                />
              ))}
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ============================================
   Single conversation item
   ============================================ */
function ConversationItem({
  conv,
  agentTaskStatus,
  reduceMotion,
  active,
  renaming,
  renameValue,
  onRenameValueChange,
  onRenameConfirm,
  onClick,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
}: {
  conv: ChatConversation;
  agentTaskStatus?: AgentTaskStatus;
  reduceMotion: boolean | null;
  active: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onRenameConfirm: () => void;
  onClick: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <motion.div
      layout
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      transition={reduceMotion
        ? { duration: 0.1 }
        : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={`group relative flex items-center gap-2 px-2.5 py-2 rounded-lg
                  transition-colors text-[13px]
                  ${active
                    ? 'bg-brand-alpha-12 text-canvas-text'
                    : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                  }`}
    >
      {renaming ? (
        <>
          <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center bg-canvas-hover">
            <Icon
              icon={active ? 'mdi:chat-processing' : 'mdi:chat-outline'}
              width="15"
              height="15"
              className={active ? 'text-indigo-400' : 'text-canvas-text-muted'}
            />
          </div>
          <input
            type="text"
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onBlur={onRenameConfirm}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameConfirm();
              if (e.key === 'Escape') onRenameConfirm();
            }}
            autoFocus
            className="h-8 w-full rounded border border-canvas-border bg-canvas-bg px-2 text-[13px]
                       text-canvas-text focus:outline-none focus:border-indigo-500"
          />
        </>
      ) : (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
        >
          <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center bg-canvas-hover">
            <Icon
              icon={active ? 'mdi:chat-processing' : 'mdi:chat-outline'}
              width="15"
              height="15"
              className={active ? 'text-indigo-400' : 'text-canvas-text-muted'}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1 truncate leading-tight">{conv.title}</div>
              {agentTaskStatus && <AgentTaskStatusBadge status={agentTaskStatus} />}
            </div>
            {conv.lastMessagePreview && (
              <div className="truncate text-[11px] text-canvas-text-muted mt-0.5">
                {conv.lastMessagePreview}
              </div>
            )}
          </div>
        </button>
      )}

      {/* Menu button */}
      <div className="relative">
        <button
          type="button"
          className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors
                      ${menuOpen ? 'opacity-100 bg-canvas-hover' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100'}
                      text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover`}
          aria-label={`打开“${conv.title}”的操作菜单`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
        >
          <Icon icon="mdi:dots-vertical" width="14" height="14" />
        </button>

        {/* Context menu */}
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
              transition={{ duration: reduceMotion ? 0.1 : 0.12 }}
              className="absolute right-0 top-full mt-1 w-36 bg-canvas-card border border-canvas-border
                         rounded-lg shadow-xl z-50 overflow-hidden"
              role="menu"
              onClick={(e) => e.stopPropagation()}
            >
              <ContextMenuItem
                icon="mdi:pencil-outline"
                label="重命名"
                onClick={() => {
                  onRename();
                  setMenuOpen(false);
                }}
              />
              <ContextMenuItem
                icon={conv.pinned ? 'mdi:pin-off' : 'mdi:pin-outline'}
                label={conv.pinned ? '取消置顶' : '置顶'}
                onClick={() => {
                  onTogglePin();
                  setMenuOpen(false);
                }}
              />
              <ContextMenuItem
                icon="mdi:archive-outline"
                label="归档"
                onClick={() => {
                  onArchive();
                  setMenuOpen(false);
                }}
              />
              <div className="border-t border-canvas-border" />
              <ContextMenuItem
                icon="mdi:delete-outline"
                label="移入回收站"
                danger
                onClick={() => {
                  onDelete();
                  setMenuOpen(false);
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function AgentTaskStatusBadge({ status }: { status: AgentTaskStatus }) {
  const config: Partial<Record<AgentTaskStatus, { label: string; className: string }>> = {
    queued: { label: '排队', className: 'text-slate-400' },
    planning: { label: '规划', className: 'text-violet-400' },
    running: { label: '运行', className: 'text-emerald-400' },
    waiting_tool: { label: '工具', className: 'text-sky-400' },
    waiting_approval: { label: '待确认', className: 'text-amber-400' },
    paused: { label: '暂停', className: 'text-slate-400' },
    failed: { label: '失败', className: 'text-red-400' },
  };
  const item = config[status];
  if (!item) return null;

  return (
    <span className={`shrink-0 text-[11px] font-medium ${item.className}`}>
      {item.label}
    </span>
  );
}

function ContextMenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors
                  ${danger
                    ? 'text-red-400 hover:bg-red-500/10'
                    : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                  }`}
      onClick={onClick}
    >
      <Icon icon={icon} width="14" height="14" />
      {label}
    </button>
  );
}
