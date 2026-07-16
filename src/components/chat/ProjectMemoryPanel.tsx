/**
 * ProjectMemoryPanel — 项目记忆管理面板（P3-D2）。
 *
 * 展示当前项目已确认的记忆，支持查看来源、编辑、启用/禁用和删除。
 * 禁用或删除后的记忆不再注入模型上下文。
 */
import { useState } from 'react';
import { Icon } from '@iconify/react';
import {
  PROJECT_MEMORY_CONTENT_LIMIT,
  PROJECT_MEMORY_KIND_LABELS,
  type ProjectMemory,
  type ProjectMemoryKind,
} from '../../types/memory';

interface ProjectMemoryPanelProps {
  memories: ProjectMemory[];
  onUpdate: (id: string, partial: Partial<Pick<ProjectMemory, 'content' | 'enabled'>>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const KIND_BADGE_CLASS: Record<ProjectMemoryKind, string> = {
  constraint: 'bg-red-400/15 text-red-300',
  decision: 'bg-indigo-400/15 text-indigo-300',
  preference: 'bg-emerald-400/15 text-emerald-300',
  fact: 'bg-sky-400/15 text-sky-300',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MemoryRow({
  memory,
  onUpdate,
  onDelete,
}: {
  memory: ProjectMemory;
  onUpdate: ProjectMemoryPanelProps['onUpdate'];
  onDelete: ProjectMemoryPanelProps['onDelete'];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);

  const save = () => {
    const next = draft.trim();
    if (next && next !== memory.content) onUpdate(memory.id, { content: next });
    setEditing(false);
  };

  return (
    <div className={`rounded-lg border border-canvas-border p-2.5 ${memory.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${KIND_BADGE_CLASS[memory.kind]}`}>
          {PROJECT_MEMORY_KIND_LABELS[memory.kind]}
        </span>
        <span className="text-[10px] text-canvas-text-muted ml-auto">{formatTime(memory.updatedAt)}</span>
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={PROJECT_MEMORY_CONTENT_LIMIT}
            rows={3}
            className="w-full resize-none rounded-md bg-canvas-bg border border-canvas-border px-2 py-1.5 text-xs text-canvas-text focus:outline-none focus:border-indigo-400"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setDraft(memory.content); setEditing(false); }}
              className="rounded-md px-2 py-1 text-[11px] text-canvas-text-secondary hover:bg-canvas-hover"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-indigo-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-400"
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-canvas-text">
          {memory.content}
        </p>
      )}

      <div className="mt-2 flex items-center gap-3 text-[10px] text-canvas-text-muted">
        <span className="flex items-center gap-1">
          <Icon icon={memory.source.unavailable ? 'mdi:link-variant-off' : 'mdi:message-text-outline'} width="12" />
          {memory.source.unavailable ? '来源对话已删除' : '来自对话'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => onUpdate(memory.id, { enabled: !memory.enabled })}
            className="rounded px-1.5 py-0.5 hover:bg-canvas-hover hover:text-canvas-text"
            title={memory.enabled ? '禁用（不再发送给模型）' : '启用'}
          >
            <Icon icon={memory.enabled ? 'mdi:eye-outline' : 'mdi:eye-off-outline'} width="14" />
          </button>
          {!editing && (
            <button
              type="button"
              onClick={() => { setDraft(memory.content); setEditing(true); }}
              className="rounded px-1.5 py-0.5 hover:bg-canvas-hover hover:text-canvas-text"
              title="编辑"
            >
              <Icon icon="mdi:pencil-outline" width="14" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(memory.id)}
            className="rounded px-1.5 py-0.5 hover:bg-red-400/10 hover:text-red-400"
            title="删除"
          >
            <Icon icon="mdi:trash-can-outline" width="14" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectMemoryPanel({
  memories,
  onUpdate,
  onDelete,
  onClose,
}: ProjectMemoryPanelProps) {
  const sorted = [...memories].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-canvas-bg">
      <div className="flex items-center justify-between border-b border-canvas-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon icon="mdi:brain" width="16" className="text-indigo-400" />
          <span className="text-sm font-medium text-canvas-text">项目记忆</span>
          <span className="text-[11px] text-canvas-text-muted">{sorted.length} 条</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-muted hover:bg-canvas-hover hover:text-canvas-text"
          title="关闭"
        >
          <Icon icon="mdi:close" width="16" />
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-canvas-text-muted">
            <Icon icon="mdi:brain" width="32" className="opacity-40" />
            <p className="text-xs">还没有项目记忆</p>
            <p className="text-[11px] leading-4">
              对话中助手会在你确认后保存偏好、事实、约束和决定，<br />之后的对话会自动参考这些记忆。
            </p>
          </div>
        ) : (
          sorted.map((memory) => (
            <MemoryRow key={memory.id} memory={memory} onUpdate={onUpdate} onDelete={onDelete} />
          ))
        )}
      </div>
    </div>
  );
}
