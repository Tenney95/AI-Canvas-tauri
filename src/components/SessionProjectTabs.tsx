/**
 * SessionProjectTabs 会话项目切换栏 — 记录本次应用运行期间访问过的项目，
 * 在窗口顶部中央提供不持久化的快捷切换入口。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
      className="group/session fixed left-1/2 top-0 z-[150] max-w-[min(42vw,640px)]
                 -translate-x-1/2 pt-2 select-none"
    >
      <nav
        aria-label="最近打开的项目"
        className="max-w-full -translate-y-[calc(100%+0.5rem)] rounded-xl border border-canvas-border
                   bg-canvas-surface/65 p-1 opacity-0 shadow-lg shadow-black/25 backdrop-blur-xl
                   transition-[transform,opacity] duration-200 ease-out pointer-events-none
                   will-change-transform group-hover/session:translate-y-0 group-hover/session:opacity-100
                   group-hover/session:pointer-events-auto group-focus-within/session:translate-y-0
                   group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto"
      >
        <div
          ref={tabListRef}
          role="tablist"
          className="flex max-w-full items-center gap-0.5 overflow-x-auto overscroll-x-contain
                     [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {openedProjects.map((project) => {
            const isActive = project.id === currentProjectId;
            const isSwitching = project.id === switchingProjectId;

            return (
              <button
                key={project.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={`切换到项目：${project.name}`}
                data-tooltip={project.name}
                disabled={switchingProjectId !== null}
                onClick={() => { void handleSwitch(project.id); }}
                className={`group relative flex h-7 min-w-0 max-w-[150px] shrink-0 items-center gap-1.5
                            rounded-lg px-2.5 text-[11px] transition-[color,background-color,box-shadow,opacity] duration-150
                            disabled:cursor-wait ${
                              isActive
                                ? 'bg-canvas-hover text-canvas-text shadow-sm shadow-black/20'
                                : 'text-canvas-text-muted hover:bg-white/[0.04] hover:text-canvas-text-secondary'
                            }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
                    isActive ? 'bg-indigo-400' : 'bg-canvas-text-muted/35 group-hover:bg-canvas-text-muted'
                  }`}
                />
                <span className="truncate">{project.name}</span>
                {isSwitching ? (
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-canvas-text-muted/30 border-t-indigo-400"
                  />
                ) : null}
                {isActive ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-2 bottom-0 h-px rounded-full bg-indigo-400/80"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
