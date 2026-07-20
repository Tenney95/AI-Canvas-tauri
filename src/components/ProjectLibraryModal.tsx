import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Icon } from '@iconify/react';
import { motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import type { CanvasProject } from '../types';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';

type ProjectSort = 'updated' | 'created' | 'name';
type ProjectView = 'grid' | 'list';

interface ProjectLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const projectNameCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

const previewAccents = [
  'bg-indigo-500/15 text-indigo-400',
  'bg-emerald-500/15 text-emerald-400',
  'bg-sky-500/15 text-sky-400',
  'bg-orange-500/15 text-orange-400',
] as const;

function getProjectVariant(id: string): number {
  let hash = 0;
  for (const character of id) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % previewAccents.length;
}

function formatProjectTimestamp(timestamp: number): string {
  const value = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfValue = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDifference = Math.round((startOfToday - startOfValue) / 86_400_000);
  const time = value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  if (dayDifference === 0) return `今天 ${time}`;
  if (dayDifference === 1) return `昨天 ${time}`;
  if (value.getFullYear() === now.getFullYear()) {
    return `${value.getMonth() + 1}月${value.getDate()}日 ${time}`;
  }
  return `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日`;
}

function ProjectCanvasPreview({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const variant = getProjectVariant(projectId);
  const leadAccent = previewAccents[variant];
  const verticalOffset = variant % 2 === 0 ? 'top-[24%]' : 'top-[48%]';

  return (
    <div
      aria-hidden="true"
      className={`relative overflow-hidden bg-canvas-bg/60 ${compact ? 'h-14 w-20 shrink-0 rounded-md' : 'aspect-[16/9] w-full'}`}
    >
      <div className="absolute inset-x-3 top-2 flex items-center gap-1 opacity-60">
        <span className="h-1 w-1 rounded-full bg-canvas-text-muted/60" />
        <span className="h-1 w-1 rounded-full bg-canvas-text-muted/40" />
        <span className="h-px flex-1 bg-canvas-border" />
      </div>
      <span className={`absolute left-[12%] ${verticalOffset} h-px w-[28%] rotate-6 bg-canvas-text-muted/30`} />
      <span className="absolute left-[43%] top-[48%] h-px w-[28%] -rotate-6 bg-canvas-text-muted/30" />
      <div className={`absolute left-[8%] top-[35%] flex items-center justify-center rounded-md border border-canvas-border bg-canvas-card ${compact ? 'h-5 w-6' : 'h-9 w-12'}`}>
        <Icon icon="mdi:format-text" width={compact ? 11 : 16} height={compact ? 11 : 16} className="text-indigo-400" />
      </div>
      <div className={`absolute left-[42%] top-[27%] flex items-center justify-center rounded-md border border-canvas-border ${leadAccent} ${compact ? 'h-6 w-7' : 'h-11 w-14'}`}>
        <Icon icon="mdi:image-outline" width={compact ? 12 : 18} height={compact ? 12 : 18} />
      </div>
      <div className={`absolute right-[8%] top-[48%] flex items-center justify-center rounded-md border border-canvas-border bg-canvas-card ${compact ? 'h-5 w-6' : 'h-9 w-12'}`}>
        <Icon icon="mdi:movie-open-outline" width={compact ? 11 : 16} height={compact ? 11 : 16} className="text-sky-400" />
      </div>
    </div>
  );
}

export default function ProjectLibraryModal({ isOpen, onClose }: ProjectLibraryModalProps) {
  const { projects, currentProjectId, createProject, switchProject, deleteProject } = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      currentProjectId: state.currentProjectId,
      createProject: state.createProject,
      switchProject: state.switchProject,
      deleteProject: state.deleteProject,
    })),
  );
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('updated');
  const [view, setView] = useState<ProjectView>('grid');
  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CanvasProject | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  const nonDefaultProjectCount = useMemo(
    () => projects.filter((project) => project.id !== 'default').length,
    [projects],
  );

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return projects
      .filter((project) => project.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
      .sort((left, right) => {
        if (left.id === currentProjectId) return -1;
        if (right.id === currentProjectId) return 1;
        if (sort === 'name') return projectNameCollator.compare(left.name, right.name);
        if (sort === 'created') return right.createdAt - left.createdAt;
        return right.updatedAt - left.updatedAt;
      });
  }, [currentProjectId, projects, query, sort]);

  useEffect(() => {
    if (!isOpen) return;
    const focusFrame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(focusFrame);
  }, [isOpen]);

  useEffect(() => {
    if (!isCreating) return;
    const focusFrame = requestAnimationFrame(() => createInputRef.current?.focus());
    return () => cancelAnimationFrame(focusFrame);
  }, [isCreating]);

  const closeLibrary = () => {
    setQuery('');
    setIsCreating(false);
    setNewProjectName('');
    setDeleteTarget(null);
    setIsDeleting(false);
    onClose();
  };

  const requestClose = () => {
    if (deleteTarget) {
      setDeleteTarget(null);
      return;
    }
    closeLibrary();
  };

  const openProject = (projectId: string) => {
    if (projectId !== currentProjectId) switchProject(projectId);
    closeLibrary();
  };

  const submitNewProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    createProject(name);
    closeLibrary();
  };

  const confirmDeleteProject = async () => {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteProject(deleteTarget.id);
      setDeleteTarget(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const focusFirstProject = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      document.querySelector<HTMLElement>('[data-project-library-card]')?.focus();
    } else if (event.key === 'Enter' && visibleProjects.length === 1) {
      event.preventDefault();
      openProject(visibleProjects[0].id);
    }
  };

  const renderDeleteButton = (project: CanvasProject, placement: 'card' | 'row') => {
    if (project.id === 'default' || nonDefaultProjectCount <= 1) return null;
    return (
      <button
        type="button"
        aria-label={`删除项目 ${project.name}`}
        data-tooltip="删除项目"
        onClick={() => setDeleteTarget(project)}
        className={placement === 'card'
          ? 'absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-md border border-canvas-border bg-canvas-card/95 text-canvas-text-muted opacity-100 shadow-sm transition-colors hover:border-red-400/30 hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100'
          : 'mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50'}
      >
        <Icon icon="mdi:trash-can-outline" width="17" height="17" aria-hidden="true" />
      </button>
    );
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={requestClose}
      ariaLabel="项目库"
      className="h-[min(680px,calc(100vh-24px))] w-[min(980px,calc(100vw-24px))]"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header
          inert={deleteTarget ? true : undefined}
          aria-hidden={deleteTarget ? true : undefined}
          className="shrink-0 border-b border-canvas-border px-4 py-4 sm:px-6"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-canvas-text">项目</h2>
              <p className="mt-0.5 text-xs text-canvas-text-muted">{projects.length} 个项目</p>
            </div>
            <PopupCloseButton ariaLabel="关闭项目库" onClick={requestClose} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="relative min-w-[190px] flex-1">
              <span className="sr-only">搜索项目</span>
              <Icon
                icon="mdi:magnify"
                width="18"
                height="18"
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-canvas-text-muted"
              />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={focusFirstProject}
                placeholder="搜索项目"
                className="h-9 w-full rounded-lg border border-canvas-border bg-canvas-card pl-10 pr-3 text-xs text-canvas-text outline-none transition-colors placeholder:text-canvas-text-muted hover:border-border-secondary focus:border-indigo-400/70 focus:ring-2 focus:ring-indigo-500/15"
              />
            </label>

            <label className="relative">
              <span className="sr-only">项目排序</span>
              <Icon
                icon="mdi:sort-variant"
                width="16"
                height="16"
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-canvas-text-muted"
              />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as ProjectSort)}
                className="h-9 appearance-none rounded-lg border border-canvas-border bg-canvas-card pl-9 pr-8 text-xs text-canvas-text outline-none transition-colors hover:border-border-secondary focus:border-indigo-400/70 focus:ring-2 focus:ring-indigo-500/15"
              >
                <option value="updated">最近更新</option>
                <option value="created">创建时间</option>
                <option value="name">项目名称</option>
              </select>
              <Icon
                icon="mdi:chevron-down"
                width="16"
                height="16"
                aria-hidden="true"
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-canvas-text-muted"
              />
            </label>

            <div className="flex h-9 items-center rounded-lg border border-canvas-border bg-canvas-card p-0.5" role="group" aria-label="项目视图">
              {(['grid', 'list'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-label={mode === 'grid' ? '网格视图' : '列表视图'}
                  aria-pressed={view === mode}
                  data-tooltip={mode === 'grid' ? '网格视图' : '列表视图'}
                  onClick={() => setView(mode)}
                  className={`flex h-7 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 ${
                    view === mode
                      ? 'bg-indigo-500/15 text-indigo-400'
                      : 'text-canvas-text-muted hover:bg-canvas-hover hover:text-canvas-text'
                  }`}
                >
                  <Icon icon={mode === 'grid' ? 'mdi:view-grid-outline' : 'mdi:view-list-outline'} width="17" height="17" aria-hidden="true" />
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setIsCreating(true)}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-indigo-500 px-3.5 text-xs font-medium text-white transition-colors hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-surface disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isCreating}
            >
              <Icon icon="mdi:plus" width="17" height="17" aria-hidden="true" />
              新建项目
            </button>
          </div>
        </header>

        <main
          inert={deleteTarget ? true : undefined}
          aria-hidden={deleteTarget ? true : undefined}
          className="min-h-0 flex-1 overflow-y-auto bg-canvas-bg/60 px-4 py-4 sm:px-6 sm:py-5"
        >
          <div className={view === 'grid' ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-2'}>
            {isCreating ? (
              <form
                onSubmit={submitNewProject}
                className={view === 'grid'
                  ? 'flex min-h-[206px] flex-col justify-between rounded-lg border border-indigo-400/40 bg-canvas-surface p-4 shadow-sm ring-2 ring-indigo-500/10'
                  : 'flex min-h-16 items-center gap-3 rounded-lg border border-indigo-400/40 bg-canvas-surface p-3 shadow-sm ring-2 ring-indigo-500/10'}
              >
                <div className={view === 'grid' ? 'flex flex-1 flex-col items-center justify-center gap-3' : 'flex min-w-0 flex-1 items-center gap-3'}>
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
                    <Icon icon="mdi:folder-plus-outline" width="21" height="21" aria-hidden="true" />
                  </div>
                  <label className={view === 'grid' ? 'w-full' : 'min-w-0 flex-1'}>
                    <span className="sr-only">新项目名称</span>
                    <input
                      ref={createInputRef}
                      value={newProjectName}
                      onChange={(event) => setNewProjectName(event.target.value)}
                      placeholder="输入项目名称"
                      className="h-9 w-full rounded-md border border-canvas-border bg-canvas-card px-3 text-center text-sm text-canvas-text outline-none placeholder:text-canvas-text-muted focus:border-indigo-400/70 focus:ring-2 focus:ring-indigo-500/15"
                    />
                  </label>
                </div>
                <div className={`flex items-center justify-end gap-2 ${view === 'grid' ? 'mt-4' : ''}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreating(false);
                      setNewProjectName('');
                    }}
                    className="h-8 rounded-md px-3 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={!newProjectName.trim()}
                    className="h-8 rounded-md bg-indigo-500 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    创建
                  </button>
                </div>
              </form>
            ) : null}

            {visibleProjects.map((project) => {
              const isCurrent = project.id === currentProjectId;
              if (view === 'list') {
                return (
                  <div
                    key={project.id}
                    className={`group flex min-h-[74px] items-center overflow-hidden rounded-lg border bg-canvas-surface transition-colors ${
                      isCurrent
                        ? 'border-indigo-400/50 ring-1 ring-indigo-500/15'
                        : 'border-canvas-border hover:border-border-secondary hover:bg-canvas-card'
                    }`}
                  >
                    <button
                      type="button"
                      data-project-library-card
                      aria-current={isCurrent ? 'page' : undefined}
                      onClick={() => openProject(project.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
                    >
                      <ProjectCanvasPreview projectId={project.id} compact />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-canvas-text">{project.name}</span>
                          {isCurrent ? <span className="shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400">当前</span> : null}
                        </span>
                        <span className="mt-1 block text-[11px] text-canvas-text-muted">更新于 {formatProjectTimestamp(project.updatedAt)}</span>
                      </span>
                      <Icon icon="mdi:arrow-right" width="17" height="17" aria-hidden="true" className="shrink-0 text-canvas-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                    {renderDeleteButton(project, 'row')}
                  </div>
                );
              }

              return (
                <div
                  key={project.id}
                  className={`group relative overflow-hidden rounded-lg border bg-canvas-surface shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-lg motion-reduce:transform-none ${
                    isCurrent
                      ? 'border-indigo-400/50 ring-1 ring-indigo-500/15'
                      : 'border-canvas-border hover:border-border-secondary'
                  }`}
                >
                  <button
                    type="button"
                    data-project-library-card
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={() => openProject(project.id)}
                    className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
                  >
                    <ProjectCanvasPreview projectId={project.id} />
                    <span className="flex min-h-[70px] items-center gap-3 border-t border-canvas-border px-3.5 py-3">
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-canvas-text">{project.name}</span>
                          {isCurrent ? <span className="shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400">当前</span> : null}
                        </span>
                        <span className="mt-1 block text-[11px] text-canvas-text-muted">更新于 {formatProjectTimestamp(project.updatedAt)}</span>
                      </span>
                      <Icon icon="mdi:arrow-right" width="17" height="17" aria-hidden="true" className="shrink-0 text-canvas-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                    </span>
                  </button>
                  {renderDeleteButton(project, 'card')}
                </div>
              );
            })}

            {!isCreating && view === 'grid' && !query.trim() ? (
              <button
                type="button"
                onClick={() => setIsCreating(true)}
                className="group flex min-h-[206px] flex-col items-center justify-center rounded-lg border border-dashed border-canvas-border bg-canvas-surface/60 text-canvas-text-muted transition-[border-color,background-color,color,transform] duration-200 hover:-translate-y-0.5 hover:border-indigo-400/40 hover:bg-canvas-surface hover:text-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 motion-reduce:transform-none"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-canvas-border bg-canvas-card transition-colors group-hover:border-indigo-400/30 group-hover:bg-indigo-500/10">
                  <Icon icon="mdi:plus" width="22" height="22" aria-hidden="true" />
                </span>
                <span className="mt-3 text-sm font-medium text-canvas-text-secondary group-hover:text-indigo-400">新建项目</span>
              </button>
            ) : null}
          </div>

          {visibleProjects.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-canvas-hover text-canvas-text-muted">
                <Icon icon="mdi:folder-search-outline" width="24" height="24" aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-sm font-medium text-canvas-text">没有找到项目</h3>
              <p className="mt-1 text-xs text-canvas-text-muted">换一个项目名称试试</p>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-4 h-8 rounded-md border border-canvas-border bg-canvas-card px-3 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border"
              >
                清除搜索
              </button>
            </div>
          ) : null}
        </main>

        {deleteTarget ? (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !isDeleting) setDeleteTarget(null);
            }}
          >
            <motion.div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-project-title"
              aria-describedby="delete-project-description"
              initial={{ opacity: 0, scale: 0.96, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="w-full max-w-sm rounded-lg border border-canvas-border bg-canvas-surface p-5 shadow-2xl"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
                  <Icon icon="mdi:alert-outline" width="21" height="21" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h3 id="delete-project-title" className="text-sm font-semibold text-canvas-text">删除“{deleteTarget.name}”？</h3>
                  <p id="delete-project-description" className="mt-1.5 text-xs leading-5 text-canvas-text-secondary">
                    项目画布及本地项目数据将被删除，此操作不可撤销。
                  </p>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  autoFocus
                  disabled={isDeleting}
                  onClick={() => setDeleteTarget(null)}
                  className="h-9 rounded-md px-3.5 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => void confirmDeleteProject()}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-red-500 px-3.5 text-xs font-medium text-white transition-colors hover:bg-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isDeleting ? <Icon icon="mdi:loading" width="16" height="16" className="animate-spin" aria-hidden="true" /> : null}
                  {isDeleting ? '正在删除' : '确认删除'}
                </button>
              </div>
            </motion.div>
          </div>
        ) : null}
      </div>
    </ModalOverlay>
  );
}
