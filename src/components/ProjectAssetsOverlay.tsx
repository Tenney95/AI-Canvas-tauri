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
import ResourceVideoPreview from './shared/ResourceVideoPreview';
import { useResourceVideoPreview } from '../hooks/useResourceVideoPreview';
import { formatSize } from '../utils/assetFormat';
import { createCanvasNodeDataSelector } from '../utils/canvasNodeDataSelector';
import { useT } from '../i18n';

const TABS: Array<{ key: FileCategory; label: string }> = [
  { key: 'image', label: CATEGORY_LABELS.image },
  { key: 'video', label: CATEGORY_LABELS.video },
];

/** 资产条目（继承自 AssetFileEntry，附带所属分集 id）*/
type EpisodeFile = AssetFileEntry & { episodeId: string };

type EpisodeFileSource = Pick<CanvasProject, 'id' | 'updatedAt' | 'exchangeEpoch' | 'dataFolder'>;
type ConvertFileSrc = ReturnType<typeof getConvertFileSrc>;

function filesFromNodes(nodes: ReadonlyArray<{ data: unknown }>, episodeId: string, convertFileSrc: ConvertFileSrc): EpisodeFile[] {
  return nodes.flatMap((node) => {
    const file = extractFilesFromNodeData(node.data as Record<string, unknown>);
    return file ? [{
      ...file,
      ...(file.category === 'video' && !file.assetUrl && convertFileSrc
        ? { assetUrl: convertFileSrc(file.path) }
        : {}),
      episodeId,
    }] : [];
  });
}

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

export default function ProjectAssetsOverlay({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const selectMediaNodes = useMemo(() => createCanvasNodeDataSelector([
    'fileName', 'filePath', 'imageUrl', 'videoUrl', 'audioUrl', 'assetId', 'relativePath',
  ]), []);
  const { projects, currentProjectId, projectLoadStatus, nodes } = useAppStore(useShallow((state) => ({
    projects: state.projects,
    currentProjectId: state.currentProjectId,
    projectLoadStatus: state.projectLoadStatus,
    nodes: selectMediaNodes(isOpen ? state.nodes : undefined),
  })));

  const [loaded, setLoaded] = useState<{
    ownerId: string;
    currentProjectId: string | null;
    files: Map<string, EpisodeFile[]>;
    convertFileSrc: ConvertFileSrc;
  }>();
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

  // 只把其他分集的真实保存版本作为读取依赖；当前分集的自动保存不重读其他集。
  const sourcesKey = JSON.stringify(episodes.filter((ep) => ep.id !== currentProjectId).map((ep) => ({
    id: ep.id, updatedAt: ep.updatedAt, exchangeEpoch: ep.exchangeEpoch, dataFolder: ep.dataFolder,
  } satisfies EpisodeFileSource)));
  const episodeCache = useRef(new Map<string, { version: string; files: EpisodeFile[] }>());
  const cacheScope = useRef<{ ownerId: string | null; projectId: string | null } | undefined>(undefined);

  const loadFiles = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    if (cacheScope.current?.ownerId !== ownerId || cacheScope.current?.projectId !== currentProjectId) {
      episodeCache.current.clear();
      cacheScope.current = { ownerId, projectId: currentProjectId };
    }
    if (!ownerId) {
      setLoaded(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const convertFileSrc = await getConvertFileSrc();
      if (loadRequestRef.current !== requestId) return;
      // sourcesKey 仅来自上方当前项目摘要的固定字段。
      const sources = JSON.parse(sourcesKey) as EpisodeFileSource[];
      const sourceIds = new Set(sources.map((source) => source.id));
      for (const id of episodeCache.current.keys()) if (!sourceIds.has(id)) episodeCache.current.delete(id);
      const results = new Map<string, EpisodeFile[]>();
      // 仍按顺序读取，只缓存本次打开且版本未变的非当前分集。
      for (const source of sources) {
        if (loadRequestRef.current !== requestId) return;
        const version = JSON.stringify(source);
        const cached = episodeCache.current.get(source.id);
        if (cached?.version === version) {
          results.set(source.id, cached.files);
          continue;
        }
        const data = await loadProjectData(source.id);
        if (loadRequestRef.current !== requestId) return;
        const epNodes = (data?.nodes as Array<{ data: unknown }> | undefined) ?? [];
        const entries = filesFromNodes(epNodes, source.id, convertFileSrc);
        // 读取失败不建立缓存基线，下次刷新或重开仍可重试。
        if (data) episodeCache.current.set(source.id, { version, files: entries });
        results.set(source.id, entries);
      }
      if (loadRequestRef.current === requestId) setLoaded({ ownerId, currentProjectId, files: results, convertFileSrc });
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }, [ownerId, sourcesKey, currentProjectId]);

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadFiles();
    } else {
      episodeCache.current.clear();
    }
    return () => {
      loadRequestRef.current += 1;
    };
  }, [isOpen, loadFiles]);

  const currentLoad = loaded && loaded.ownerId === ownerId && loaded.currentProjectId === currentProjectId ? loaded : undefined;
  const currentFiles = useMemo(() => (
    isOpen && currentProjectId && projectLoadStatus === 'ready'
      ? filesFromNodes(nodes, currentProjectId, currentLoad?.convertFileSrc ?? null)
      : []
  ), [isOpen, currentProjectId, projectLoadStatus, nodes, currentLoad?.convertFileSrc]);
  const files = useMemo(() => (
    episodes.flatMap((ep) => ep.id === currentProjectId ? currentFiles : currentLoad?.files.get(ep.id) ?? [])
  ), [episodes, currentProjectId, currentFiles, currentLoad]);

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
  const videoPreview = useResourceVideoPreview(JSON.stringify([isOpen, currentProjectId, activeTab]),
    files.filter((file) => file.category === activeTab && !collapsed.has(file.episodeId)).map(assetKey));

  if (!isOpen) return null;

  return (
    <div
      data-resource-video-boundary
      className="pointer-events-auto fixed right-2 top-1/2 z-[160] flex -translate-y-1/2 flex-col overflow-hidden
                 rounded-2xl border border-[var(--glass-ring)] bg-[var(--glass-bg)]
                 text-canvas-text shadow-2xl shadow-black/40 backdrop-blur-2xl"
      style={{ width: 'min(260px, calc(100vw - 32px))', height: 'min(80vh, 640px)' }}
    >
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-2.5 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-indigo-500/15 text-indigo-400">
          <Icon icon="lucide:folder-open" className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold leading-4">
            {series?.name ?? t('项目资产')}
          </p>
          <p className="truncate text-[10px] leading-4 text-canvas-text-muted">
            {totalCount > 0 ? t('共 {count} 个文件', { count: totalCount }) : t('暂无资产')}
          </p>
        </div>
        <PopupCloseButton ariaLabel={t('关闭项目资产')} onClick={onClose} />
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
            {t(tab.label)}
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
            {t('加载中…')}
          </div>
        ) : totalCount === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-canvas-text-muted">
            <Icon icon="lucide:inbox" className="h-8 w-8 opacity-40" />
            <p>{t('暂无{category}资产', { category: t(CATEGORY_LABELS[activeTab]) })}</p>
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
                          {file.category === 'video' ? (
                            <ResourceVideoPreview src={file.assetUrl} filePath={file.path} name={file.name}
                              projectId={file.episodeId} size={file.size}
                              expanded={videoPreview.expandedId === assetKey(file)}
                              onExpandedChange={(expanded) => videoPreview.setExpanded(expanded ? assetKey(file) : null)} />
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
