/**
 * 项目库弹窗，提供项目搜索、排序、创建、重命名、打开和删除等管理操作。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { listTopLevelProjects, resolveOpenTargetId, seriesOwnerId } from '../store/store.utils';
import type { CanvasProject } from '../types';
import * as fileService from '../services/fileService';
import { calcFixedPosition } from '../utils/popupPosition';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';
import { useT } from '../i18n';

type ProjectSort = 'updated' | 'created' | 'name';

interface ProjectLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const projectNameCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

function formatProjectTimestamp(timestamp: number, t: (text: string, vars?: Record<string, string | number>) => string): string {
  const value = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfValue = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDifference = Math.round((startOfToday - startOfValue) / 86_400_000);
  const time = value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  if (dayDifference === 0) return t('今天 {time}', { time });
  if (dayDifference === 1) return t('昨天 {time}', { time });
  if (value.getFullYear() === now.getFullYear()) {
    return t('{month}月{date}日 {time}', { month: value.getMonth() + 1, date: value.getDate(), time });
  }
  return t('{year}年{month}月{date}日', { year: value.getFullYear(), month: value.getMonth() + 1, date: value.getDate() });
}

/** 右键菜单估算尺寸，仅用于贴边时的翻转计算。 */
const PROJECT_MENU_WIDTH = 160;
const PROJECT_MENU_HEIGHT = 230;

function ProjectMenuItem({ icon, label, danger, disabled, onClick }: {
  icon: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${danger
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
        }`}
    >
      <Icon icon={icon} width="15" height="15" aria-hidden="true" />
      {label}
    </button>
  );
}

function ProjectSnapshotPreview({ snapshot }: { snapshot?: string }) {
  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden bg-canvas-bg/60">
      {snapshot ? (
        <img
          src={snapshot}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-canvas-text-muted">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-canvas-border bg-canvas-card">
            <Icon icon="mdi:vector-square" width="22" height="22" aria-hidden="true" />
          </span>
        </div>
      )}
    </div>
  );
}

export default function ProjectLibraryModal({ isOpen, onClose }: ProjectLibraryModalProps) {
  const t = useT();
  const {
    projects, currentProjectId, createProject, renameProject, switchProject, deleteProject,
    exportProject, importProject, duplicateProject, isCreatingProject,
  } = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      currentProjectId: state.currentProjectId,
      createProject: state.createProject,
      renameProject: state.renameProject,
      switchProject: state.switchProject,
      deleteProject: state.deleteProject,
      exportProject: state.exportProject,
      importProject: state.importProject,
      duplicateProject: state.duplicateProject,
      isCreatingProject: state.isCreatingProject,
    })),
  );
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('updated');
  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameProjectName, setRenameProjectName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CanvasProject | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ project: CanvasProject; x: number; y: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  // 项目库只列顶层项目；分集在画布右侧的分集栏里管理。
  const topLevelProjects = useMemo(() => listTopLevelProjects(projects), [projects]);
  const activeProjectId = currentProjectId ? seriesOwnerId(projects, currentProjectId) : null;

  const deletableProjectCount = useMemo(
    () => topLevelProjects.filter((project) => project.id !== 'default').length,
    [topLevelProjects],
  );

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return topLevelProjects
      .filter((project) => project.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
      .sort((left, right) => {
        if (left.id === activeProjectId) return -1;
        if (right.id === activeProjectId) return 1;
        if (sort === 'name') return projectNameCollator.compare(left.name, right.name);
        if (sort === 'created') return right.createdAt - left.createdAt;
        return right.updatedAt - left.updatedAt;
      });
  }, [activeProjectId, topLevelProjects, query, sort]);

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
    setContextMenu(null);
    setIsCreating(false);
    setNewProjectName('');
    setRenameTargetId(null);
    setRenameProjectName('');
    setIsRenaming(false);
    setDeleteTarget(null);
    setIsDeleting(false);
    onClose();
  };

  const requestClose = () => {
    if (isCreatingProject) return;
    if (contextMenu) {
      setContextMenu(null);
      return;
    }
    if (deleteTarget) {
      setDeleteTarget(null);
      return;
    }
    if (renameTargetId) {
      setRenameTargetId(null);
      setRenameProjectName('');
      return;
    }
    closeLibrary();
  };

  const openProject = (projectId: string) => {
    // 只有从项目库切走才重拍缩略图 —— 这里是唯一会看到缩略图的地方
    if (projectId !== activeProjectId) switchProject(projectId, { captureSnapshot: true });
    closeLibrary();
  };

  const submitNewProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name || isCreatingProject) return;
    const projectId = await createProject(name);
    if (projectId) closeLibrary();
  };

  const beginRenameProject = (project: CanvasProject) => {
    setIsCreating(false);
    setNewProjectName('');
    setRenameTargetId(project.id);
    setRenameProjectName(project.name);
  };

  const cancelRenameProject = () => {
    if (isRenaming) return;
    setRenameTargetId(null);
    setRenameProjectName('');
  };

  const submitRenameProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameTargetId || isRenaming) return;
    const name = renameProjectName.trim();
    if (!name) return;

    setIsRenaming(true);
    try {
      if (await renameProject(renameTargetId, name)) {
        setRenameTargetId(null);
        setRenameProjectName('');
      }
    } finally {
      setIsRenaming(false);
    }
  };

  const runExportProject = async (project: CanvasProject) => {
    if (exportingId || isImporting) return;
    setExportingId(project.id);
    try {
      await exportProject(project.id);
    } finally {
      setExportingId(null);
    }
  };

  const openProjectFolder = async (project: CanvasProject) => {
    try {
      const dir = await fileService.ensureProjectDataDir(project.id);
      if (dir) await fileService.openDirectoryInFileManager(dir);
    } catch (error) {
      console.warn('[项目库] 打开项目文件夹失败:', error);
    }
  };

  const runDuplicateProject = async (project: CanvasProject) => {
    if (duplicatingId) return;
    setDuplicatingId(project.id);
    try {
      await duplicateProject(project.id);
    } finally {
      setDuplicatingId(null);
    }
  };

  const runImportProject = async () => {
    if (isImporting || exportingId) return;
    setIsImporting(true);
    try {
      const projectId = await importProject();
      if (projectId) closeLibrary();
    } finally {
      setIsImporting(false);
    }
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

  const canDeleteProject = (project: CanvasProject) => (
    project.id !== 'default' && deletableProjectCount > 1
  );

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={requestClose}
      ariaLabel={t('项目库')}
      motionPreset="quick"
      backdropBlur={false}
      className="h-[min(560px,calc(100dvh-24px))] w-[min(840px,calc(100vw-24px))]"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header
          inert={deleteTarget ? true : undefined}
          aria-hidden={deleteTarget ? true : undefined}
          className="shrink-0 border-b border-canvas-border px-4 py-3.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <h2 className="text-sm font-semibold text-canvas-text">{t('项目')}</h2>
                <span className="text-[11px] tabular-nums text-canvas-text-muted">{topLevelProjects.length}</span>
              </div>
            </div>
            <PopupCloseButton ariaLabel={t('关闭项目库')} onClick={requestClose} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="relative min-w-[180px] flex-1">
              <span className="sr-only">{t('搜索项目')}</span>
              <Icon
                icon="mdi:magnify"
                width="17"
                height="17"
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-canvas-text-muted"
              />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={focusFirstProject}
                placeholder={t('搜索项目')}
                className="h-9 w-full rounded-lg border border-canvas-border bg-canvas-card pl-9 pr-3 text-xs text-canvas-text outline-none transition-colors placeholder:text-canvas-text-muted hover:border-border-secondary focus:border-indigo-400/70 focus:ring-2 focus:ring-indigo-500/15"
              />
            </label>

            <label className="relative">
              <span className="sr-only">{t('项目排序')}</span>
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
                <option value="updated">{t('最近更新')}</option>
                <option value="created">{t('创建时间')}</option>
                <option value="name">{t('项目名称')}</option>
              </select>
              <Icon
                icon="mdi:chevron-down"
                width="16"
                height="16"
                aria-hidden="true"
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-canvas-text-muted"
              />
            </label>

            <button
              type="button"
              onClick={() => void runImportProject()}
              disabled={isImporting || exportingId !== null}
              data-tooltip={t('从 .aicanvas 项目包导入')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-canvas-border bg-canvas-card px-3 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon
                icon={isImporting ? 'mdi:loading' : 'mdi:tray-arrow-down'}
                width="17"
                height="17"
                aria-hidden="true"
                className={isImporting ? 'animate-spin' : undefined}
              />
              {isImporting ? t('正在导入') : t('导入')}
            </button>

            <button
              type="button"
              onClick={() => setIsCreating(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-indigo-500 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isCreating}
            >
              <Icon icon="mdi:plus" width="17" height="17" aria-hidden="true" />
              {t('新建')}
            </button>
          </div>
        </header>

        <main
          inert={deleteTarget ? true : undefined}
          aria-hidden={deleteTarget ? true : undefined}
          className="min-h-0 flex-1 overflow-y-auto bg-canvas-bg/60 p-3"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            {visibleProjects.map((project) => {
              const isCurrent = project.id === activeProjectId;
              const isEditingName = renameTargetId === project.id;
              return (
                <div
                  key={project.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ project, x: event.clientX, y: event.clientY });
                  }}
                  className={`group overflow-hidden rounded-lg border bg-canvas-surface transition-[border-color,box-shadow] duration-150 ${isCurrent
                      ? 'border-indigo-400/50 ring-1 ring-indigo-500/15'
                      : 'border-canvas-border hover:border-border-secondary hover:shadow-lg'
                    }`}
                >
                  <button
                    type="button"
                    data-project-library-card
                    aria-label={t('打开项目 {name}', { name: project.name })}
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={() => openProject(project.id)}
                    disabled={isEditingName || isRenaming}
                    className="block w-full border-b border-canvas-border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
                  >
                    {/* 剧集自己没有画布，缩略图取点开后会看到的那一集 */}
                    <ProjectSnapshotPreview
                      snapshot={project.snapshot
                        ?? projects.find((item) => item.id === resolveOpenTargetId(projects, project.id))?.snapshot}
                    />
                  </button>

                  {isEditingName ? (
                    <form onSubmit={(event) => void submitRenameProject(event)} className="flex min-h-14 items-center gap-1.5 px-2">
                      <label className="min-w-0 flex-1">
                        <span className="sr-only">{t('项目名称')}</span>
                        <input
                          autoFocus
                          value={renameProjectName}
                          onChange={(event) => setRenameProjectName(event.target.value)}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelRenameProject();
                            }
                          }}
                          disabled={isRenaming}
                          className="h-8 w-full rounded-md border border-indigo-400/60 bg-canvas-card px-2 text-xs text-canvas-text outline-none focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-60"
                        />
                      </label>
                      <button
                        type="submit"
                        aria-label={t('保存项目名称')}
                        data-tooltip={t('保存')}
                        disabled={!renameProjectName.trim() || isRenaming}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-indigo-400 transition-colors hover:bg-indigo-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Icon icon={isRenaming ? 'mdi:loading' : 'mdi:check'} width="17" height="17" className={isRenaming ? 'animate-spin' : undefined} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={t('取消重命名')}
                        data-tooltip={t('取消')}
                        disabled={isRenaming}
                        onClick={cancelRenameProject}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border disabled:opacity-40"
                      >
                        <Icon icon="mdi:close" width="17" height="17" aria-hidden="true" />
                      </button>
                    </form>
                  ) : (
                    <div className="flex min-h-14 items-center">
                      <button
                        type="button"
                        onClick={() => openProject(project.id)}
                        className="min-w-0 flex-1 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-xs font-medium text-canvas-text">{project.name}</span>
                          {isCurrent ? (
                            <span className="shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400">{t('当前')}</span>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-[10px] text-canvas-text-muted">
                          {formatProjectTimestamp(project.updatedAt, t)}
                        </span>
                      </button>

                      <div className="mr-2 flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          aria-label={t('重命名项目 {name}', { name: project.name })}
                          data-tooltip={t('重命名')}
                          onClick={() => beginRenameProject(project)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border"
                        >
                          <Icon icon="mdi:pencil-outline" width="17" height="17" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('导出项目 {name}', { name: project.name })}
                          data-tooltip={t('导出项目包')}
                          disabled={exportingId !== null || isImporting}
                          onClick={() => void runExportProject(project)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Icon
                            icon={exportingId === project.id ? 'mdi:loading' : 'mdi:tray-arrow-up'}
                            width="17"
                            height="17"
                            aria-hidden="true"
                            className={exportingId === project.id ? 'animate-spin' : undefined}
                          />
                        </button>

                        <button
                          type="button"
                          aria-label={t('复制项目 {name}', { name: project.name })}
                          data-tooltip={t('创建副本')}
                          disabled={duplicatingId !== null}
                          onClick={() => void runDuplicateProject(project)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Icon
                            icon={duplicatingId === project.id ? 'mdi:loading' : 'mdi:content-copy'}
                            width="17"
                            height="17"
                            aria-hidden="true"
                            className={duplicatingId === project.id ? 'animate-spin' : undefined}
                          />
                        </button>
                        {canDeleteProject(project) ? (
                          <button
                            type="button"
                            aria-label={t('删除项目 {name}', { name: project.name })}
                            data-tooltip={t('删除项目')}
                            onClick={() => setDeleteTarget(project)}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50"
                          >
                            <Icon icon="mdi:trash-can-outline" width="17" height="17" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {isCreating ? (
              <form
                onSubmit={submitNewProject}
                className="flex min-h-[188px] flex-col justify-between rounded-lg border border-indigo-400/40 bg-canvas-surface p-3 ring-2 ring-indigo-500/10"
              >
                <div className="flex flex-1 flex-col items-center justify-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
                    <Icon icon="mdi:folder-plus-outline" width="21" height="21" aria-hidden="true" />
                  </span>
                  <label className="w-full">
                    <span className="sr-only">{t('新项目名称')}</span>
                    <input
                      ref={createInputRef}
                      value={newProjectName}
                      onChange={(event) => setNewProjectName(event.target.value)}
                      placeholder={t('输入项目名称')}
                      disabled={isCreatingProject}
                      className="h-9 w-full rounded-md border border-canvas-border bg-canvas-card px-3 text-center text-sm text-canvas-text outline-none placeholder:text-canvas-text-muted focus:border-indigo-400/70 focus:ring-2 focus:ring-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreating(false);
                      setNewProjectName('');
                    }}
                    disabled={isCreatingProject}
                    className="h-8 rounded-md px-3 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('取消')}
                  </button>
                  <button
                    type="submit"
                    disabled={!newProjectName.trim() || isCreatingProject}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-indigo-500 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isCreatingProject ? (
                      <Icon icon="mdi:loading" width="15" height="15" className="animate-spin" aria-hidden="true" />
                    ) : null}
                    {isCreatingProject ? t('创建中') : t('创建')}
                  </button>
                </div>
              </form>
            ) : (
              !query.trim() ? (
                <button
                  type="button"
                  onClick={() => setIsCreating(true)}
                  className="group flex min-h-[188px] flex-col items-center justify-center rounded-lg border border-dashed border-canvas-border bg-canvas-surface/60 text-canvas-text-muted transition-[border-color,background-color,color] duration-150 hover:border-indigo-400/40 hover:bg-canvas-surface hover:text-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-canvas-border bg-canvas-card transition-colors group-hover:border-indigo-400/30 group-hover:bg-indigo-500/10">
                    <Icon icon="mdi:plus" width="21" height="21" aria-hidden="true" />
                  </span>
                  <span className="mt-3 text-xs font-medium text-canvas-text-secondary group-hover:text-indigo-400">{t('新建项目')}</span>
                </button>
              ) : null
            )}
          </div>

          {visibleProjects.length === 0 ? (
            <div className="flex min-h-[220px] flex-col items-center justify-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-canvas-hover text-canvas-text-muted">
                <Icon icon="mdi:folder-search-outline" width="22" height="22" aria-hidden="true" />
              </span>
              <h3 className="mt-3 text-sm font-medium text-canvas-text">{t('没有找到项目')}</h3>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-3 h-8 rounded-md border border-canvas-border bg-canvas-card px-3 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border"
              >
                {t('清除搜索')}
              </button>
            </div>
          ) : null}
        </main>

        {contextMenu ? createPortal(
          <div
            className="fixed inset-0 z-[260]"
            onMouseDown={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          >
            <div
              role="menu"
              aria-label={t('项目操作')}
              style={calcFixedPosition(contextMenu.x, contextMenu.y, PROJECT_MENU_WIDTH, PROJECT_MENU_HEIGHT)}
              onMouseDown={(event) => event.stopPropagation()}
              className="fixed w-40 overflow-hidden rounded-lg border border-canvas-border bg-canvas-card py-1 shadow-xl"
            >
              <ProjectMenuItem
                icon="mdi:folder-open-outline"
                label={t('打开项目')}
                onClick={() => openProject(contextMenu.project.id)}
              />
              <ProjectMenuItem
                icon="mdi:folder-search-outline"
                label={t('打开项目文件夹')}
                onClick={() => {
                  void openProjectFolder(contextMenu.project);
                  setContextMenu(null);
                }}
              />
              <div className="my-1 border-t border-canvas-border" />
              <ProjectMenuItem
                icon="mdi:pencil-outline"
                label={t('重命名')}
                onClick={() => {
                  beginRenameProject(contextMenu.project);
                  setContextMenu(null);
                }}
              />
              <ProjectMenuItem
                icon="mdi:content-copy"
                label={t('创建副本')}
                disabled={duplicatingId !== null}
                onClick={() => {
                  void runDuplicateProject(contextMenu.project);
                  setContextMenu(null);
                }}
              />
              <ProjectMenuItem
                icon="mdi:tray-arrow-up"
                label={t('导出项目包')}
                disabled={exportingId !== null || isImporting}
                onClick={() => {
                  void runExportProject(contextMenu.project);
                  setContextMenu(null);
                }}
              />
              {canDeleteProject(contextMenu.project) ? (
                <>
                  <div className="my-1 border-t border-canvas-border" />
                  <ProjectMenuItem
                    icon="mdi:trash-can-outline"
                    label={t('删除项目')}
                    danger
                    onClick={() => {
                      setDeleteTarget(contextMenu.project);
                      setContextMenu(null);
                    }}
                  />
                </>
              ) : null}
            </div>
          </div>,
          document.body,
        ) : null}

        {deleteTarget ? (
          <div
            data-tauri-drag-region
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !isDeleting) setDeleteTarget(null);
            }}
          >
            <motion.div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-project-title"
              aria-describedby="delete-project-description"
              initial={{ opacity: 0, scale: 0.97, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="w-full max-w-sm rounded-lg border border-canvas-border bg-canvas-surface p-5 shadow-2xl"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
                  <Icon icon="mdi:alert-outline" width="21" height="21" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h3 id="delete-project-title" className="text-sm font-semibold text-canvas-text">{t('删除“{name}”？', { name: deleteTarget.name })}</h3>
                  <p id="delete-project-description" className="mt-1.5 text-xs leading-5 text-canvas-text-secondary">
                    {t('项目画布及本地项目数据将被删除，此操作不可撤销。')}
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
                  {t('取消')}
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => void confirmDeleteProject()}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-red-500 px-3.5 text-xs font-medium text-white transition-colors hover:bg-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isDeleting ? <Icon icon="mdi:loading" width="16" height="16" className="animate-spin" aria-hidden="true" /> : null}
                  {isDeleting ? t('正在删除') : t('确认删除')}
                </button>
              </div>
            </motion.div>
          </div>
        ) : null}
      </div>
    </ModalOverlay>
  );
}
