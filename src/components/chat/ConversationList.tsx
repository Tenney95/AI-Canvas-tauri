/**
 * ConversationList — 会话列表组件
 * 展示当前项目的全部会话，支持新建、切换、搜索、置顶、归档、重命名、删除
 */
import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import type { ChatConversation } from '../../types/chat';
import AnimatedButton from '../shared/AnimatedButton';

interface ConversationListProps {
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 外部提供的会话列表（独立窗口模式） */
  conversations?: import('../../types/chat').ChatConversation[];
  /** 外部提供的活动会话 ID（独立窗口模式） */
  activeConversationId?: string | null;
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
  projectId: extProjectId,
  onRenameConversation,
  onTogglePin: extTogglePin,
  onArchiveConversation,
  onDeleteConversation,
}: ConversationListProps) {
  const isExternal = !!extConversations; // 独立窗口模式判断

  const store = useAppStore(
    useShallow((s) => ({
      conversations: s.conversations,
      activeConversationId: s.activeConversationId,
      currentProjectId: s.currentProjectId,
      updateConversation: s.updateConversation,
      removeConversation: s.removeConversation,
    })),
  );

  const conversations = extConversations ?? store.conversations;
  const activeConversationId = extActiveId !== undefined ? extActiveId : store.activeConversationId;
  const projectId = extProjectId ?? store.currentProjectId;

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
        <span className="text-xs font-semibold uppercase tracking-wider text-canvas-text-muted">
          对话
        </span>
        <AnimatedButton
          scale={1.05}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover transition-colors"
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
              className="flex flex-col items-center justify-center py-8 text-xs text-canvas-text-muted"
            >
              <Icon icon="mdi:chat-outline" width="28" height="28" className="mb-2 opacity-40" />
              {searchQuery ? '没有匹配的对话' : '还没有对话'}
            </motion.div>
          )}

          {/* Pinned section */}
          {pinned.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-canvas-text-muted">
                置顶
              </div>
              {pinned.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
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
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-canvas-text-muted">
                  最近
                </div>
              )}
              {normal.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
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
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className={`group relative flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer
                  transition-colors text-[13px]
                  ${active
                    ? 'bg-brand-alpha-12 text-canvas-text'
                    : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                  }`}
      onClick={onClick}
    >
      {/* Icon */}
      <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center bg-canvas-hover">
        <Icon
          icon={active ? 'mdi:chat-processing' : 'mdi:chat-outline'}
          width="15"
          height="15"
          className={active ? 'text-indigo-400' : 'text-canvas-text-muted'}
        />
      </div>

      {/* Title */}
      <div className="flex-1 min-w-0">
        {renaming ? (
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
            className="w-full h-6 px-1 text-[13px] bg-canvas-bg border border-canvas-border rounded
                       text-canvas-text focus:outline-none focus:border-indigo-500"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div className="truncate leading-tight">{conv.title}</div>
            {conv.lastMessagePreview && (
              <div className="truncate text-[11px] text-canvas-text-muted mt-0.5">
                {conv.lastMessagePreview}
              </div>
            )}
          </>
        )}
      </div>

      {/* Menu button */}
      <div className="relative">
        <button
          type="button"
          className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors
                      ${menuOpen ? 'opacity-100 bg-canvas-hover' : 'opacity-0 group-hover:opacity-100'}
                      text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover`}
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
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.12 }}
              className="absolute right-0 top-full mt-1 w-36 bg-canvas-card border border-canvas-border
                         rounded-lg shadow-xl z-50 overflow-hidden"
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
