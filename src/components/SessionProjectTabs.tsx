/**
 * SessionProjectTabs 会话项目切换栏 — 记录本次应用运行期间访问过的项目，
 * 在窗口顶部中央提供不持久化的快捷切换入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { motion, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import ProjectSettingsPopover from './ProjectSettingsPopover';

const MAX_SESSION_PROJECTS = 5;
const SESSION_PROJECT_IDS_KEY = 'canvas-session-project-ids';

function loadSessionProjectIds(currentProjectId: string | null): string[] {
  let storedIds: string[] = [];
  try {
    const stored = sessionStorage.getItem(SESSION_PROJECT_IDS_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) {
      storedIds = parsed.filter((id): id is string => typeof id === 'string');
    }
  } catch { /* Use the current project only. */ }

  return currentProjectId
    ? [currentProjectId, ...storedIds.filter((id) => id !== currentProjectId)].slice(0, MAX_SESSION_PROJECTS)
    : storedIds.slice(0, MAX_SESSION_PROJECTS);
}

function saveSessionProjectIds(ids: string[]): void {
  try {
    sessionStorage.setItem(SESSION_PROJECT_IDS_KEY, JSON.stringify(ids));
  } catch { /* Session history is best-effort UI state. */ }
}

export default function SessionProjectTabs() {
  const { projects, currentProjectId, switchProject } = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      currentProjectId: state.currentProjectId,
      switchProject: state.switchProject,
    })),
  );
  const [openedProjectIds, setOpenedProjectIds] = useState<string[]>(
    () => loadSessionProjectIds(currentProjectId),
  );
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(null);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const layoutTransition = prefersReducedMotion
    ? { duration: 0 }
    : { type: 'spring' as const, bounce: 0, duration: 0.35 };

  useEffect(() => useAppStore.subscribe((state, previousState) => {
    const nextProjectId = state.currentProjectId;
    if (!nextProjectId || nextProjectId === previousState.currentProjectId) return;
    setOpenedProjectIds((ids) => {
      const nextIds = [
        nextProjectId,
        ...ids.filter((id) => id !== nextProjectId),
      ].slice(0, MAX_SESSION_PROJECTS);
      saveSessionProjectIds(nextIds);
      return nextIds;
    });
  }), []);

  const openedProjects = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const orderedIds = currentProjectId
      ? [currentProjectId, ...openedProjectIds.filter((id) => id !== currentProjectId)]
      : openedProjectIds;
    return orderedIds.slice(0, MAX_SESSION_PROJECTS).flatMap((id) => {
      const project = projectById.get(id);
      return project ? [project] : [];
    });
  }, [currentProjectId, openedProjectIds, projects]);
  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;
  const settingsOpen = !!currentProjectId && settingsProjectId === currentProjectId;
  const closeSettings = useCallback(() => setSettingsProjectId(null), []);

  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [currentProjectId]);

  const handleSwitch = async (projectId: string) => {
    if (projectId === currentProjectId || switchingProjectId) return;
    closeSettings();
    setSwitchingProjectId(projectId);
    try {
      await switchProject(projectId);
    } finally {
      setSwitchingProjectId(null);
    }
  };

  if (openedProjects.length === 0) return null;

  return (
    <div
      className="group/session fixed left-1/2 top-0 z-[150] max-w-[min(72vw,640px)]
                 -translate-x-1/2 select-none sm:max-w-[min(52vw,640px)]"
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 top-1 h-0.5 w-8 -translate-x-1/2
                    rounded-full bg-canvas-text-muted/35 transition-opacity duration-150 ${
                      settingsOpen
                        ? 'opacity-0'
                        : 'group-hover/session:opacity-0 group-focus-within/session:opacity-0'
                    }`}
      />
      <nav
        aria-label="最近打开的项目"
        className={`max-w-full rounded-lg border border-white/[0.08] bg-canvas-surface/75 p-1
                    shadow-xl shadow-black/30 backdrop-blur-2xl backdrop-saturate-150
                    transition-[transform,opacity] duration-200 ease-out will-change-transform
                    motion-reduce:transition-opacity ${
                      settingsOpen
                        ? 'translate-y-0 opacity-100 pointer-events-auto'
                        : '-translate-y-[calc(100%+0.5rem)] opacity-0 pointer-events-none group-hover/session:translate-y-0 group-hover/session:opacity-100 group-hover/session:pointer-events-auto group-focus-within/session:translate-y-0 group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto'
                    }`}
      >
        <div
          ref={tabListRef}
          role="tablist"
          className="flex max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain
                     [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {openedProjects.map((project) => {
            const isActive = project.id === currentProjectId;
            const isSwitching = project.id === switchingProjectId;

            return (
              <motion.div
                key={project.id}
                layout="position"
                role="presentation"
                transition={{ layout: layoutTransition }}
                className="relative flex min-w-0 shrink-0 items-center overflow-hidden rounded-md"
              >
                {isActive ? (
                  <motion.span
                    layoutId="session-project-active-tab"
                    aria-hidden="true"
                    transition={layoutTransition}
                    className="absolute inset-0 rounded-md bg-white/[0.07] shadow-sm shadow-black/20
                               ring-1 ring-inset ring-white/[0.06]"
                  />
                ) : null}
                <motion.button
                  whileTap={switchingProjectId === null ? { scale: 0.97 } : undefined}
                  transition={{ scale: { duration: 0.1, ease: 'easeOut' } }}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-busy={isSwitching}
                  aria-label={`切换到项目：${project.name}`}
                  data-tooltip={project.name}
                  disabled={switchingProjectId !== null}
                  onClick={() => { void handleSwitch(project.id); }}
                  className={`group relative z-10 flex h-8 min-w-0 max-w-40 shrink-0 items-center gap-2
                              rounded-md px-3 text-xs font-medium leading-none
                              transition-[color,background-color,opacity] duration-150 disabled:cursor-wait ${
                                isActive
                                  ? 'text-canvas-text'
                                  : 'text-canvas-text-muted hover:bg-white/[0.04] hover:text-canvas-text-secondary'
                              }`}
                >
                  <span className="relative z-10 grid h-2.5 w-2.5 shrink-0 place-items-center">
                    {isSwitching ? (
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 animate-spin rounded-full border border-canvas-text-muted/30
                                   border-t-indigo-400 motion-reduce:animate-none"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 rounded-full transition-[background-color,box-shadow] duration-150 ${
                          isActive
                            ? 'bg-indigo-400 shadow-sm shadow-indigo-500/50'
                            : 'bg-canvas-text-muted/30 group-hover:bg-canvas-text-muted/60'
                        }`}
                      />
                    )}
                  </span>
                  <span className="relative z-10 truncate">{project.name}</span>
                </motion.button>
                {isActive ? (
                  <motion.button
                    ref={settingsButtonRef}
                    type="button"
                    aria-label="打开当前项目设置"
                    aria-expanded={settingsOpen}
                    aria-controls="project-settings-popover"
                    data-tooltip="项目设置"
                    disabled={switchingProjectId !== null}
                    initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    whileTap={{ scale: 0.94 }}
                    transition={layoutTransition}
                    onClick={() => setSettingsProjectId((openProjectId) => (
                      openProjectId === currentProjectId ? null : currentProjectId
                    ))}
                    className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center border-l
                                border-white/[0.06] transition-colors disabled:cursor-wait ${
                                  settingsOpen
                                    ? 'bg-indigo-500/15 text-indigo-400'
                                    : 'text-canvas-text-muted hover:bg-white/[0.05] hover:text-canvas-text-secondary'
                                }`}
                  >
                    <Icon icon="lucide:settings-2" className="h-3.5 w-3.5" />
                  </motion.button>
                ) : null}
              </motion.div>
            );
          })}
        </div>
      </nav>
      <ProjectSettingsPopover
        key={settingsOpen ? currentProjectId ?? 'open' : 'closed'}
        isOpen={settingsOpen}
        project={currentProject}
        anchorRef={settingsButtonRef}
        onClose={closeSettings}
      />
    </div>
  );
}
