/**
 * ChatWindow — 独立对话窗口（Tauri WebviewWindow）
 *
 * 不依赖主窗口 zustand store，通过 Tauri 事件与主窗口通信：
 * - 接收 `chat:sync-state` 更新本地状态
 * - 发送 `chat:action` 给主窗口执行操作
 * - 关闭前发送 `chat:close-request`
 *
 * 启动时从 IndexedDB 加载历史数据作为初始渲染。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import {
  initChatWindowListener,
  emitAction,
  emitCloseRequest,
  type ChatStateSnapshot,
} from '../../services/chat/chatWindowService';
import type { ChatConversation, ChatMessage } from '../../types/chat';
import ConversationList from './ConversationList';
import AnimatedButton from '../shared/AnimatedButton';

export default function ChatWindow() {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [inputValue, setInputValue] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'chat'>('chat');
  const [initialized, setInitialized] = useState(false);
  const initializedRef = useRef(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ── 窗口位置锁定 ──
  const [isLocked, setIsLocked] = useState(false);
  const isLockedRef = useRef(false);
  const lockOffsetRef = useRef({ x: 0, y: 0 });
  const lockIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleToggleLock = useCallback(async () => {
    const next = !isLockedRef.current;
    isLockedRef.current = next;
    setIsLocked(next);

    if (next) {
      // 锁定：计算与主窗口的偏移
      const mainWin = await Window.getByLabel('main');
      const chatWin = getCurrentWindow();
      if (mainWin) {
        const [mainPos, chatPos] = await Promise.all([
          mainWin.outerPosition().catch(() => null),
          chatWin.outerPosition().catch(() => null),
        ]);
        if (mainPos && chatPos) {
          lockOffsetRef.current = {
            x: chatPos.x - mainPos.x,
            y: chatPos.y - mainPos.y,
          };
        }
      }
      lockIntervalRef.current = setInterval(async () => {
        if (!isLockedRef.current) return;
        const mw = await Window.getByLabel('main');
        if (!mw) return;
        const mainP = await mw.outerPosition().catch(() => null);
        if (!mainP) return;
        const cw = getCurrentWindow();
        const targetPos = new PhysicalPosition(
          mainP.x + lockOffsetRef.current.x,
          mainP.y + lockOffsetRef.current.y,
        );
        cw.setPosition(targetPos).catch(() => {});
      }, 50);
    } else {
      if (lockIntervalRef.current) {
        clearInterval(lockIntervalRef.current);
        lockIntervalRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      if (lockIntervalRef.current) clearInterval(lockIntervalRef.current);
    };
  }, []);

  // ── 初始化：请求主窗口同步数据 ──
  useEffect(() => {
    // 数据完全依赖主窗口的 `chat:sync-state` 事件下发
    const timer = setTimeout(() => {
      setInitialized(true); // 超时兜底：即使未收到同步也显示 UI
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // ── 监听主窗口状态同步 ──
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    (async () => {
      cleanup = await initChatWindowListener(
        (snapshot: ChatStateSnapshot) => {
          setConversations(snapshot.conversations);
          setActiveConversationId(snapshot.activeConversationId);
          // 首次同步时全量覆盖，后续增量追加（避免闪烁）
          setMessages((prev) => {
            if (prev.length === 0) return snapshot.messages;
            const existingIds = new Set(prev.map((m) => m.id));
            const newMsgs = snapshot.messages.filter((m) => !existingIds.has(m.id));
            if (newMsgs.length === 0) return prev;
            return [...prev, ...newMsgs];
          });
          if (snapshot.projectId) setProjectId(snapshot.projectId);
          if (snapshot.projectName) setProjectName(snapshot.projectName);
          if (!initializedRef.current) {
            initializedRef.current = true;
            setInitialized(true);
          }
        },
        async () => {
          // 主窗口要求关闭
          await emitCloseRequest();
          try { await invoke('close_chat_window'); } catch { /* ignore */ }
        },
      );

      // 请求主窗口同步最新状态
      emitAction({ type: 'request_sync' });
    })();

    return () => { cleanup?.(); };
  }, []);

  // ── 窗口关闭时通知主窗口 ──
  useEffect(() => {
    const handleBeforeUnload = () => {
      emitCloseRequest().catch(() => {});
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, [messages]);

  // ===== Actions =====

  const conversationMessages = messages; // 独立窗口消息已按会话过滤

  const handleNewConversation = useCallback(() => {
    if (!projectId) return;
    emitAction({ type: 'create_conversation', projectId });
    setViewMode('chat');
  }, [projectId]);

  const handleSelectConversation = useCallback((id: string) => {
    emitAction({ type: 'switch_conversation', conversationId: id });
    setViewMode('chat');
  }, []);

  const handleRenameConversation = useCallback((convId: string, title: string) => {
    emitAction({ type: 'rename_conversation', conversationId: convId, title });
  }, []);

  const handleTogglePin = useCallback((convId: string) => {
    emitAction({ type: 'toggle_pin', conversationId: convId });
  }, []);

  const handleArchiveConversation = useCallback((convId: string) => {
    emitAction({ type: 'archive_conversation', conversationId: convId });
  }, []);

  const handleDeleteConversation = useCallback((convId: string) => {
    emitAction({ type: 'delete_conversation', conversationId: convId });
  }, []);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || !activeConversationId) return;

    // 本地乐观添加用户消息
    const userMsg: ChatMessage = {
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      status: 'done',
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputValue('');

    // 发送到主窗口处理
    emitAction({
      type: 'send_message',
      content: text,
      conversationId: activeConversationId,
    });
  }, [inputValue, activeConversationId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const showEmptyState = !activeConversationId && viewMode === 'chat';

  return (
    <div className="h-screen flex flex-col bg-canvas-bg text-canvas-text font-sans rounded-[16px] overflow-hidden">
      {/* Merged header — 可拖拽 + 导航 + 窗口操作 */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between px-4 py-3 flex-shrink-0 select-none"
      >
        {/* 左侧：导航 + 品牌 */}
        <div className="flex items-center gap-2">
          {viewMode === 'chat' && activeConversationId && (
            <button
              type="button"
              className="pointer-events-auto flex items-center justify-center w-6 h-6 rounded-md text-canvas-text-muted
                         hover:text-canvas-text hover:bg-canvas-hover transition-colors"
              onClick={() => setViewMode('list')}
            >
              <Icon icon="mdi:menu" width="16" height="16" />
            </button>
          )}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center">
              <Icon icon="mdi:robot-outline" width="16" height="16" className="text-indigo-400" />
            </div>
            <span className="text-sm font-medium">AI 助手</span>
            {projectName && (
              <span className="text-[11px] text-canvas-text-muted truncate max-w-[120px]">
                — {projectName}
              </span>
            )}
          </div>
        </div>

        {/* 右侧：窗口操作 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="pointer-events-auto flex items-center justify-center w-6 h-6 rounded-md
                       text-canvas-text-muted hover:text-indigo-400 hover:bg-indigo-500/15 transition-colors"
            data-tooltip="收回内嵌"
            onClick={() => {
              emitCloseRequest().catch(() => {});
              invoke('close_chat_window').catch(() => {});
            }}
          >
            <Icon icon="mdi:dock-left" width="14" height="14" />
          </button>
          <button
            type="button"
            className={`pointer-events-auto flex items-center justify-center w-6 h-6 rounded-md transition-colors
                        ${isLocked
                          ? 'text-amber-400 bg-amber-400/15'
                          : 'text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover'
                        }`}
            data-tooltip={isLocked ? '已锁定相对位置' : '锁定相对位置'}
            onClick={handleToggleLock}
          >
            <Icon icon={isLocked ? 'mdi:lock' : 'mdi:lock-open-outline'} width="14" height="14" />
          </button>
          <button
            type="button"
            className="pointer-events-auto flex items-center justify-center w-6 h-6 rounded-md
                       text-canvas-text-muted hover:text-canvas-text hover:bg-red-500/20 transition-colors"
            onClick={() => {
              emitCloseRequest().catch(() => {});
              invoke('close_chat_window').catch(() => {});
            }}
          >
            <Icon icon="mdi:close" width="14" height="14" />
          </button>
        </div>
      </div>

      {/* Body: dual-pane */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {viewMode === 'list' && (
          <motion.div
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="flex-shrink-0 w-full overflow-hidden"
          >
            <ConversationList
              conversations={conversations}
              activeConversationId={activeConversationId}
              projectId={projectId ?? undefined}
              onSelect={handleSelectConversation}
              onNew={handleNewConversation}
              onRenameConversation={handleRenameConversation}
              onTogglePin={handleTogglePin}
              onArchiveConversation={handleArchiveConversation}
              onDeleteConversation={handleDeleteConversation}
            />
          </motion.div>
        )}

        {viewMode === 'chat' && (
          <motion.div
            initial={{ x: 20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="flex-1 flex flex-col min-h-0 min-w-0"
          >
            {/* Messages */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4">
              {showEmptyState && initialized && (
                <EmptyChatState onNew={handleNewConversation} onList={() => setViewMode('list')} />
              )}

              {!showEmptyState && conversationMessages.length === 0 && initialized && (
                <div className="flex flex-col items-center justify-center h-full text-center px-4">
                  <div className="w-16 h-16 rounded-2xl bg-indigo-500/15 flex items-center justify-center mb-4">
                    <Icon icon="mdi:chat-processing-outline" width="28" height="28" className="text-indigo-400" />
                  </div>
                  <p className="text-sm text-canvas-text-secondary mb-1">开始对话</p>
                  <p className="text-xs text-canvas-text-muted">
                    用自然语言操作画布，AI 助手帮你完成
                  </p>
                </div>
              )}

              {conversationMessages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}

              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            {!showEmptyState && (
              <div className="flex-shrink-0 px-4 py-3 border-t border-canvas-border">
                <div className="flex items-end gap-2 bg-canvas-surface border border-canvas-border rounded-xl
                                focus-within:border-canvas-text-secondary transition-colors px-3 py-2">
                  <textarea
                    ref={inputRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
                    rows={1}
                    className="flex-1 resize-none bg-transparent text-sm text-canvas-text
                               placeholder:text-canvas-text-muted outline-none
                               min-h-[24px] max-h-[120px] py-1"
                  />
                  <AnimatedButton
                    scale={1.05}
                    disabled={!inputValue.trim()}
                    className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors
                                ${inputValue.trim()
                                  ? 'bg-indigo-500 text-white hover:bg-indigo-400'
                                  : 'bg-canvas-hover text-canvas-text-muted cursor-not-allowed'
                                }`}
                    onClick={handleSend}
                  >
                    <Icon icon="mdi:send" width="16" height="16" />
                  </AnimatedButton>
                </div>
                <p className="text-[10px] text-canvas-text-muted mt-2 text-center">
                  AI 助手仅理解画布操作指令，不会执行未授权的修改。
                </p>
              </div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}

/* ============================================
   Message bubble (local copy for detached window)
   ============================================ */
function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="text-[11px] text-canvas-text-muted bg-canvas-hover px-3 py-1 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center mr-2 mt-0.5">
          <Icon icon="mdi:robot-outline" width="14" height="14" className="text-indigo-400" />
        </div>
      )}

      <div
        className={`max-w-[80%] px-3.5 py-2.5 rounded-xl text-sm leading-relaxed
                    ${isUser
                      ? 'bg-indigo-500/20 text-canvas-text rounded-br-md'
                      : 'bg-canvas-hover text-canvas-text rounded-bl-md'
                    }`}
      >
        <div className="whitespace-pre-wrap break-words">{message.content}</div>

        {message.status === 'streaming' && (
          <span className="inline-block w-2 h-3 bg-indigo-400 animate-pulse ml-1 align-middle rounded-sm" />
        )}
        {message.status === 'error' && (
          <div className="flex items-center gap-1 mt-1 text-[11px] text-red-400">
            <Icon icon="mdi:alert-circle" width="12" height="12" />
            响应失败
          </div>
        )}
        {message.status === 'interrupted' && (
          <div className="flex items-center gap-1 mt-1 text-[11px] text-amber-400">
            <Icon icon="mdi:alert-outline" width="12" height="12" />
            响应中断
          </div>
        )}
      </div>

      {isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-canvas-hover flex items-center justify-center ml-2 mt-0.5">
          <Icon icon="mdi:account" width="14" height="14" className="text-canvas-text-secondary" />
        </div>
      )}
    </div>
  );
}

/* ============================================
   Empty chat state
   ============================================ */
function EmptyChatState({
  onNew,
  onList,
}: {
  onNew: () => void;
  onList: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-20 h-20 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-5">
        <Icon icon="mdi:robot-happy-outline" width="36" height="36" className="text-indigo-400" />
      </div>
      <h3 className="text-base font-semibold text-canvas-text mb-2">画布 AI 助手</h3>
      <p className="text-sm text-canvas-text-secondary mb-6 max-w-[260px]">
        用自然语言读取和操作画布。查询状态、定位节点、批量管理，一个对话框完成。
      </p>
      <div className="flex flex-col gap-2 w-48">
        <AnimatedButton
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                     bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-400 transition-colors"
          onClick={onNew}
        >
          <Icon icon="mdi:plus" width="16" height="16" />
          新建对话
        </AnimatedButton>
        <AnimatedButton
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                     bg-canvas-hover text-canvas-text-secondary text-sm hover:text-canvas-text
                     hover:bg-canvas-border transition-colors"
          onClick={onList}
        >
          <Icon icon="mdi:history" width="16" height="16" />
          历史记录
        </AnimatedButton>
      </div>

      <div className="mt-8 space-y-2 w-56">
        <p className="text-[11px] text-canvas-text-muted mb-2">试试这些：</p>
        {['现在有几个失败节点？', '选中 3 号节点', '删除失败节点'].map((example) => (
          <div
            key={example}
            className="px-3 py-2 text-xs text-canvas-text-secondary bg-canvas-bg border border-canvas-border
                       rounded-lg hover:border-canvas-text-secondary hover:text-canvas-text
                       transition-colors cursor-pointer"
          >
            {example}
          </div>
        ))}
      </div>
    </div>
  );
}
