/**
 * SessionProjectTabs 会话项目切换栏 — 记录本次应用运行期间访问过的项目，
 * 在窗口顶部中央提供不持久化的快捷切换入口。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';

const MAX_SESSION_PROJECTS = 5;

export default function SessionProjectTabs() {
  const { projects, currentProjectId, switchProject } = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      currentProjectId: state.currentProjectId,
      switchProject: state.switchProject,
    })),
  );
  const [openedProjectIds, setOpenedProjectIds] = useState<string[]>(
    () => currentProjectId ? [currentProjectId] : [],
  );
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const layoutTransition = prefersReducedMotion
    ? { duration: 0 }
    : { type: 'spring' as const, bounce: 0, duration: 0.35 };

  useEffect(() => useAppStore.subscribe((state, previousState) => {
    const nextProjectId = state.currentProjectId;
    if (!nextProjectId || nextProjectId === previousState.currentProjectId) return;
    setOpenedProjectIds((ids) => [
      nextProjectId,
      ...ids.filter((id) => id !== nextProjectId),
    ].slice(0, MAX_SESSION_PROJECTS));
  }), []);

  const openedProjects = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project]));
    return openedProjectIds.flatMap((id) => {
      const project = projectById.get(id);
      return project ? [project] : [];
    });
  }, [openedProjectIds, projects]);

  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [currentProjectId]);

  const handleSwitch = async (projectId: string) => {
    if (projectId === currentProjectId || switchingProjectId) return;
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
        className="pointer-events-none absolute left-1/2 top-1 h-0.5 w-8 -translate-x-1/2
                   rounded-full bg-canvas-text-muted/35 transition-opacity duration-150
                   group-hover/session:opacity-0 group-focus-within/session:opacity-0"
      />
      <nav
        aria-label="最近打开的项目"
        className="max-w-full -translate-y-[calc(100%+0.5rem)] rounded-lg border border-white/[0.08]
                   bg-canvas-surface/75 p-1 opacity-0 shadow-xl shadow-black/30 backdrop-blur-2xl
                   backdrop-saturate-150 transition-[transform,opacity] duration-200 ease-out pointer-events-none
                   will-change-transform group-hover/session:translate-y-0 group-hover/session:opacity-100
                   group-hover/session:pointer-events-auto group-focus-within/session:translate-y-0
                   group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto
                   motion-reduce:transition-opacity"
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
              <motion.button
                key={project.id}
                layout="position"
                whileTap={switchingProjectId === null ? { scale: 0.97 } : undefined}
                transition={{
                  layout: layoutTransition,
                  scale: { duration: 0.1, ease: 'easeOut' },
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-busy={isSwitching}
                aria-label={`切换到项目：${project.name}`}
                data-tooltip={project.name}
                disabled={switchingProjectId !== null}
                onClick={() => { void handleSwitch(project.id); }}
                className={`group relative flex h-8 min-w-0 max-w-40 shrink-0 items-center gap-2
                            overflow-hidden rounded-md px-3 text-xs font-medium leading-none
                            transition-[color,background-color,opacity,transform] duration-150
                            disabled:cursor-wait ${
                              isActive
                                ? 'text-canvas-text'
                                : 'text-canvas-text-muted hover:bg-white/[0.04] hover:text-canvas-text-secondary'
                            }`}
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
            );
          })}
        </div>
      </nav>
    </div>
  );
}
