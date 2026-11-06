/**
 * 汇总当前项目的 Agent 任务，按会话和状态筛选并复用时间线提供任务控制入口。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AgentTask, AgentTaskFocusRequest } from '../../types/agent';
import type { ChatConversation } from '../../types/chat';
import AgentTaskTimeline, { type AgentTaskControls } from './AgentTaskTimeline';
import { AGENT_EXPERT_ROLE_LABELS } from '../../services/chat/expertTaskService';
import { useT } from '../../i18n';

interface AgentTaskCenterProps extends AgentTaskControls {
  tasks: AgentTask[];
  conversations: ChatConversation[];
  onClose: () => void;
  focusRequest?: AgentTaskFocusRequest | null;
}

const TERMINAL = new Set(['completed', 'failed', 'stopped']);

export default function AgentTaskCenter({
  tasks,
  conversations,
  onClose,
  focusRequest,
  ...controls
}: AgentTaskCenterProps) {
  const t = useT();
  const [viewSelection, setViewSelection] = useState<{ view: 'active' | 'all'; focusRevision?: number }>({ view: 'active' });
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const focusedTaskId = focusRequest?.taskId;
  const focusRevision = focusRequest?.revision;
  const hasFocusedTask = !!focusedTaskId && tasks.some((task) => task.id === focusedTaskId);
  const view = hasFocusedTask && focusRevision !== viewSelection.focusRevision ? 'all' : viewSelection.view;
  useEffect(() => {
    if (!focusedTaskId || focusRevision === undefined || !hasFocusedTask) return;
    rowRefs.current.get(focusedTaskId)?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  }, [focusRevision, focusedTaskId, hasFocusedTask]);
  const conversationNames = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation.title])),
    [conversations],
  );
  const visible = useMemo(() => tasks
    .filter((task) => view === 'all' || !TERMINAL.has(task.status))
    .sort((left, right) => right.updatedAt - left.updatedAt), [tasks, view]);
  const activeCount = tasks.filter((task) => !TERMINAL.has(task.status)).length;
  const taskNames = useMemo(
    () => new Map(tasks.map((task) => [task.id, task.goal])),
    [tasks],
  );
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (task.parentTaskId) {
        counts.set(task.parentTaskId, (counts.get(task.parentTaskId) ?? 0) + 1);
      }
    }
    return counts;
  }, [tasks]);

  return (
    <section className="agent-task-center flex min-h-0 flex-1 flex-col" aria-label={t('Agent 任务中心')}>
      <header className="agent-task-center__header flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('返回对话')}
          title={t('返回对话')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-canvas-text-muted
                     transition-colors hover:bg-canvas-hover hover:text-canvas-text
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
        >
          <Icon icon="mdi:arrow-left" width="18" />
        </button>
        <Icon icon="mdi:progress-wrench" width="17" className="text-[var(--brand)]" />
        <h2 className="text-sm font-semibold text-canvas-text">{t('任务中心')}</h2>
        <span className="text-[11px] tabular-nums text-canvas-text-muted">{t('{count} 运行中', { count: activeCount })}</span>
        <div className="agent-task-center__tabs ml-auto flex items-center rounded-md border p-0.5" role="tablist">
          {(['active', 'all'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={view === item}
              onClick={() => setViewSelection({ view: item, focusRevision })}
              className={`agent-task-center__tab min-h-7 rounded px-2 text-[11px] transition-colors ${
                view === item ? 'is-active text-canvas-text' : 'text-canvas-text-muted hover:text-canvas-text'
              }`}
            >
              {item === 'active' ? t('进行中') : t('全部')}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-canvas-text-muted">
            <Icon icon="mdi:progress-check" width="28" />
            <p className="text-xs">{view === 'active' ? t('暂无进行中的任务') : t('暂无任务')}</p>
          </div>
        ) : visible.map((task) => (
          <section
            key={task.id}
            ref={(element) => { if (element) rowRefs.current.set(task.id, element); else rowRefs.current.delete(task.id); }}
            className={`agent-task-center__item border-b px-3 py-3 ${
              task.parentTaskId ? 'agent-task-center__item--child ml-4 border-l' : ''
            }`}
          >
            <div className="flex items-start gap-2">
              {task.parentTaskId && (
                <Icon
                  icon={task.expertRole ? 'mdi:account-search-outline' : 'mdi:account-multiple-outline'}
                  width="15"
                  className="mt-0.5 shrink-0 text-[var(--success)]"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-canvas-text">
                  {task.expertRole && AGENT_EXPERT_ROLE_LABELS[task.expertRole]
                    ? t(AGENT_EXPERT_ROLE_LABELS[task.expertRole])
                    : task.goal}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-canvas-text-muted">
                  {task.parentTaskId
                    ? t('上级任务：{name}', { name: taskNames.get(task.parentTaskId) ?? t('已删除任务') })
                    : conversationNames.get(task.conversationId) ?? t('已删除会话')}
                </p>
                {!task.parentTaskId && (childCounts.get(task.id) ?? 0) > 0 && (
                  <p className="mt-0.5 text-[10px] text-[var(--success)]">
                    {t('{count} 个只读子任务', { count: childCounts.get(task.id) ?? 0 })}
                  </p>
                )}
              </div>
              <time className="shrink-0 text-[10px] tabular-nums text-canvas-text-muted">
                {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            </div>
            <AgentTaskTimeline task={task} {...controls} />
          </section>
        ))}
      </div>
    </section>
  );
}
