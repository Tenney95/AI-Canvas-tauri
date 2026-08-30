/**
 * ProjectAssetsOverlay — 剧集项目资产浮层
 * 双击 SeriesRail 竖线打开，按分集分组展示剧集项目的图片与视频资产。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { listEpisodes, seriesOwnerId } from '../store/store.utils';
import type { CanvasProject } from '../types';
import {
  extractFilesFromNodeData,
  getConvertFileSrc,
  CATEGORY_LABELS,
  type AssetFileEntry,
  type FileCategory,
} from '../services/fileService';
import { loadProjectData } from '../services/storageService';
import PopupCloseButton from './shared/PopupCloseButton';
import ViewportImage from './shared/ViewportImage';
import ViewportVideo from './shared/ViewportVideo';
import { formatSize } from '../utils/assetFormat';

const TABS: Array<{ key: FileCategory; label: string }> = [
  { key: 'image', label: CATEGORY_LABELS.image },
  { key: 'video', label: CATEGORY_LABELS.video },
];

/** 资产条目（继承自 AssetFileEntry，附带所属分集 id）*/
type EpisodeFile = AssetFileEntry & { episodeId: string };

function assetKey(file: EpisodeFile): string {
  return `${file.episodeId}::${file.assetId ?? file.path}`;
}

/** 图片卡片：缩略图 + 体积角标 */
function ImageCard({ file }: { file: AssetFileEntry }) {
  return (
    <div className="relative w-full" style={{ aspectRatio: '16 / 9' }}>
      {file.assetUrl ? (
        <ViewportImage
          src={file.assetUrl}
          alt={file.name}
          className="block h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-canvas-bg text-2xl text-canvas-text-muted">
          🖼
        </div>
      )}
      <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1 py-0.5 text-[9px] leading-none text-white/80">
        {formatSize(file.size)}
      </span>
    </div>
  );
}

/** 视频卡片：可播放的 video 元素 */
function VideoCard({ file }: { file: AssetFileEntry }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shouldPlayRef = useRef(false);

  const handlePlay = () => {
    shouldPlayRef.current = true;
    videoRef.current?.play().catch(() => {
      /* 自动播放被拦截，静默忽略 */
    });
  };

  const handlePause = () => {
    shouldPlayRef.current = false;
    videoRef.current?.pause();
  };

  return (
    <div
      className="relative w-full cursor-pointer"
      style={{ aspectRatio: '16 / 9' }}
      onMouseEnter={handlePlay}
      onMouseLeave={handlePause}
    >
      <ViewportVideo
        ref={videoRef}
        src={file.assetUrl}
        className="block h-full w-full rounded-t-lg object-cover"
        muted
        loop
        playsInline
        preload="metadata"
        title={file.name}
        onCanPlay={() => {
          if (shouldPlayRef.current) handlePlay();
        }}
      />
      <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/60 px-1 py-0.5 text-[9px] leading-none text-white/80">
        {formatSize(file.size)}
      </span>
      <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/70 opacity-0 transition-opacity group-hover/card:opacity-100">
        <Icon icon="lucide:play" className="h-6 w-6 drop-shadow-md" />
      </span>
    </div>
  );
}

export default function ProjectAssetsOverlay({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { projects, currentProjectId, nodes } = useAppStore(useShallow((state) => ({
    projects: state.projects,
    currentProjectId: state.currentProjectId,
    nodes: state.nodes,
  })));

  const [files, setFiles] = useState<EpisodeFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<FileCategory>('image');
  const loadRequestRef = useRef(0);
  // 折叠状态：默认全部展开，点击标题切换
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const ownerId = currentProjectId ? seriesOwnerId(projects, currentProjectId) : null;
  const series = projects.find((project) => project.id === ownerId) ?? null;
  const episodes = useMemo(
    () => (ownerId ? listEpisodes(projects, ownerId) : []),
    [projects, ownerId],
  );

  const loadFiles = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    if (!ownerId) {
      setFiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const convertFileSrc = await getConvertFileSrc();

      // 分集数据按顺序读取，避免长剧集同时反序列化多份完整画布。
      const results: EpisodeFile[] = [];
      for (const ep of episodes) {
        if (loadRequestRef.current !== requestId) return;
        let epNodes: Array<{ data: Record<string, unknown> }>;
        if (ep.id === currentProjectId) {
          // 当前激活的分集：直接用内存中的 nodes
          epNodes = nodes as unknown as Array<{ data: Record<string, unknown> }>;
        } else {
          // 其他分集：从 IndexedDB 加载
          const data = await loadProjectData(ep.id);
          if (loadRequestRef.current !== requestId) return;
          epNodes = (data?.nodes as Array<{ data: Record<string, unknown> }> | undefined) ?? [];
        }
        const entries = (
          epNodes
            .map((node) => extractFilesFromNodeData(node.data))
            .flat()
            .filter(Boolean) as AssetFileEntry[]
        ).map((file) => ({
          ...file,
          // 视频文件补 assetUrl
          ...(file.category === 'video' && !file.assetUrl && convertFileSrc
            ? { assetUrl: convertFileSrc(file.path) }
            : {}),
          episodeId: ep.id,
        }));
        results.push(...entries);
      }
      if (loadRequestRef.current === requestId) setFiles(results);
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }, [ownerId, episodes, currentProjectId, nodes]);

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadFiles();
    }
    return () => {
      loadRequestRef.current += 1;
    };
  }, [isOpen, loadFiles]);

  // 按 episodeId 分组：所有文件都归到对应的分集
  const groups = useMemo(() => {
    const ordered: Array<{ project: CanvasProject; files: EpisodeFile[] }> = [];
    for (const ep of episodes) {
      const groupFiles = files.filter(
        (file) => file.category === activeTab && file.episodeId === ep.id,
      );
      if (groupFiles.length > 0) ordered.push({ project: ep, files: groupFiles });
    }
    return ordered;
  }, [files, activeTab, episodes]);

  const totalCount = useMemo(
    () => files.filter((file) => file.category === activeTab).length,
    [files, activeTab],
  );

  if (!isOpen) return null;

  return (
    <div
      className="pointer-events-auto fixed right-2 top-1/2 z-[160] flex -translate-y-1/2 flex-col overflow-hidden
                 rounded-[14px] border border-[var(--glass-ring)] bg-[var(--glass-bg)]
                 text-canvas-text shadow-2xl shadow-black/40 backdrop-blur-2xl"
      style={{ width: 'min(260px, calc(100vw - 32px))', height: 'min(80vh, 640px)' }}
    >
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-indigo-500/15 text-indigo-400">
          <Icon icon="lucide:folder-open" className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold leading-4">
            {series?.name ?? '项目资产'}
          </p>
          <p className="truncate text-[10px] leading-4 text-canvas-text-muted">
            {totalCount > 0 ? `共 ${totalCount} 个文件` : '暂无资产'}
          </p>
        </div>
        <PopupCloseButton ariaLabel="关闭项目资产" onClick={onClose} />
      </header>

      {/* Tabs */}
      <nav className="flex shrink-0 gap-0 border-b border-border-subtle px-3">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`relative px-3 py-2 text-[11px] font-medium transition-colors ${
              activeTab === tab.key
                ? 'text-canvas-text'
                : 'text-canvas-text-muted hover:text-canvas-text-secondary'
            }`}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-indigo-400" />
            )}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 [scrollbar-width:thin]">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[11px] text-canvas-text-muted">
            <Icon icon="lucide:loader-2" className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            加载中…
          </div>
        ) : totalCount === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-canvas-text-muted">
            <Icon icon="lucide:inbox" className="h-8 w-8 opacity-40" />
            <p>暂无{CATEGORY_LABELS[activeTab]}资产</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map(({ project, files: groupFiles }) => {
              const isCollapsed = collapsed.has(project.id);
              return (
                <section key={project.id} className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(project.id)) next.delete(project.id);
                      else next.add(project.id);
                      return next;
                    })}
                    className="flex items-center gap-1.5 px-0.5 text-[11px] font-semibold text-canvas-text-secondary transition-colors hover:text-canvas-text"
                  >
                    <Icon
                      icon={isCollapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'}
                      className="h-3 w-3 shrink-0 transition-transform duration-150"
                    />
                    <Icon icon="lucide:list-video" className="h-3 w-3" />
                    <span className="truncate">{project.name}</span>
                    <span className="ml-auto text-[10px] font-normal text-canvas-text-muted">
                      {groupFiles.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="flex flex-col gap-2">
                      {groupFiles.map((file) => (
                        <div
                          key={assetKey(file)}
                          className="project-asset-card group/card overflow-hidden rounded-lg border border-canvas-border bg-canvas-card transition-colors hover:border-canvas-hover"
                        >
                          {file.category === 'video' && file.assetUrl ? (
                            <VideoCard file={file} />
                          ) : (
                            <ImageCard file={file} />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
