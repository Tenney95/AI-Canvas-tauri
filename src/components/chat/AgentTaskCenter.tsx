import { useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AgentTask } from '../../types/agent';
import type { ChatConversation } from '../../types/chat';
import AgentTaskTimeline, { type AgentTaskControls } from './AgentTaskTimeline';
import { AGENT_EXPERT_ROLE_LABELS } from '../../services/chat/expertTaskService';

interface AgentTaskCenterProps extends AgentTaskControls {
  tasks: AgentTask[];
  conversations: ChatConversation[];
  onClose: () => void;
}

const TERMINAL = new Set(['completed', 'failed', 'stopped']);

export default function AgentTaskCenter({
  tasks,
  conversations,
  onClose,
  ...controls
}: AgentTaskCenterProps) {
  const [view, setView] = useState<'active' | 'all'>('active');
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
    <section className="flex min-h-0 flex-1 flex-col bg-canvas-bg/30" aria-label="Agent 任务中心">
      <header className="flex min-h-12 items-center gap-2 border-b border-canvas-border px-3">
        <Icon icon="mdi:progress-wrench" width="17" className="text-indigo-300" />
        <h2 className="text-sm font-semibold text-canvas-text">任务中心</h2>
        <span className="text-[11px] tabular-nums text-canvas-text-muted">{activeCount} 运行中</span>
        <div className="ml-auto flex items-center rounded-md border border-canvas-border bg-canvas-surface p-0.5" role="tablist">
          {(['active', 'all'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={view === item}
              onClick={() => setView(item)}
              className={`min-h-7 rounded px-2 text-[11px] transition-colors ${
                view === item ? 'bg-canvas-hover text-canvas-text' : 'text-canvas-text-muted hover:text-canvas-text'
              }`}
            >
              {item === 'active' ? '进行中' : '全部'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭任务中心"
          title="关闭任务中心"
          className="flex h-8 w-8 items-center justify-center rounded-md text-canvas-text-muted
                     hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
        >
          <Icon icon="mdi:close" width="17" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-canvas-text-muted">
            <Icon icon="mdi:progress-check" width="28" />
            <p className="text-xs">暂无{view === 'active' ? '进行中的' : ''}任务</p>
          </div>
        ) : visible.map((task) => (
          <section
            key={task.id}
            className={`border-b border-canvas-border/70 px-3 py-3 ${
              task.parentTaskId ? 'ml-4 border-l border-l-emerald-400/30 bg-canvas-surface/20' : ''
            }`}
          >
            <div className="flex items-start gap-2">
              {task.expertRole && (
                <Icon icon="mdi:account-search-outline" width="15" className="mt-0.5 shrink-0 text-emerald-300" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-canvas-text">
                  {task.expertRole
                    ? AGENT_EXPERT_ROLE_LABELS[task.expertRole] ?? task.goal
                    : task.goal}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-canvas-text-muted">
                  {task.parentTaskId
                    ? `上级任务：${taskNames.get(task.parentTaskId) ?? '已删除任务'}`
                    : conversationNames.get(task.conversationId) ?? '已删除会话'}
                </p>
                {!task.parentTaskId && (childCounts.get(task.id) ?? 0) > 0 && (
                  <p className="mt-0.5 text-[10px] text-emerald-300/80">
                    {childCounts.get(task.id)} 个只读专家任务
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
