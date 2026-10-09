import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { seriesOwnerId } from '../../store/store.utils';
import { loadRecentAssets, type RecentAssetEntry } from '../../services/fs/recentAssets';
import { shortFolderName } from '../../utils/assetFormat';
import { useResourceVideoPreview } from '../../hooks/useResourceVideoPreview';
import AssetThumb from '../shared/AssetThumb';
import AssetFileContextMenu from './AssetFileContextMenu';
import { copyFile, copyText } from '../../services/clipboardService';
import { deletePermanentFile, isTauriEnv, revealFileInFolder } from '../../services/fileService';
import { loadAssetImageDetails } from '../../services/assetImageDetails';
import { loadAssetVideoHistory } from '../../services/assetVideoDetails';

const AssetTextPreview = lazy(() => import('./AssetTextPreview'));
const AssetImagePreview = lazy(() => import('./AssetImagePreview'));

/** 启动页的轻量资源入口；不扫描整个目录，不挂载画布或生成业务。 */
export default function RecentAssetsSection() {
  const { projects, folderRoots, revision, panelOpen, openLibrary, markUsed } = useAppStore(useShallow((state) => ({
    projects: state.projects, folderRoots: state.config.assetFolders,
    revision: state.recentAssetsRevision, panelOpen: state.assetsPanelOpen,
    openLibrary: state.setAssetsPanelOpen, markUsed: state.markAssetUsed,
  })));
  const scope = useMemo(() => ({ folderRoots: folderRoots ?? [], projectIds: projects.map((project) => project.id) }), [folderRoots, projects]);
  const scopeKey = JSON.stringify(scope);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ scope: string; entries: RecentAssetEntry[]; error: boolean }>();
  const [textId, setTextId] = useState<string | null>(null);
  const [imageId, setImageId] = useState<string | null>(null);
  const [fileMenu, setFileMenu] = useState<{ entry: RecentAssetEntry; scope: string; x: number; y: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const activeScopeRef = useRef<string | null>(scopeKey);
  if (fileMenu && (panelOpen || fileMenu.scope !== scopeKey)) setFileMenu(null);
  const entries = result?.scope === scopeKey ? result.entries : [];
  const text = entries.find((entry) => entry.file.assetId === textId);
  if (textId && !text) setTextId(null);
  const image = entries.find((entry) => entry.file.assetId === imageId);
  if (imageId && !image) setImageId(null);
  const video = useResourceVideoPreview(scopeKey, entries.map((entry) => entry.file.assetId!));
  const showAll = useCallback(() => openLibrary(true, 'page', { tab: 'permanent', folder: { kind: 'all' } }), [openLibrary]);
  const closeFileMenu = useCallback(() => {
    operationRef.current?.abort();
    setFileMenu(null);
  }, []);

  useEffect(() => {
    activeScopeRef.current = panelOpen ? null : scopeKey;
    return () => { activeScopeRef.current = null; operationRef.current?.abort(); };
  }, [scopeKey, panelOpen]);

  const performFileAction = async (action: 'copy' | 'prompt' | 'reveal' | 'delete') => {
    const target = fileMenu;
    if (!target || target.scope !== activeScopeRef.current) return;
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    const { file, projectId } = target.entry;
    const isCurrent = () => !controller.signal.aborted && target.scope === activeScopeRef.current
      && !useAppStore.getState().assetsPanelOpen;
    try {
      if (action === 'prompt') {
        const details = file.category === 'image' ? await loadAssetImageDetails(file, projectId, controller.signal) : null;
        const history = file.category === 'video'
          ? await loadAssetVideoHistory(file.path, file.assetUrl, projectId, controller.signal) : details?.history;
        if (!isCurrent()) return;
        const prompt = details?.record?.prompt ?? history?.prompt ?? '';
        if (!prompt.trim()) { setMessage('此资产暂无提示词'); return; }
        if (!(await copyText(prompt))) throw new Error('clipboard');
        if (isCurrent()) setMessage('提示词已复制');
      } else {
        if (!isTauriEnv() || file.availability === 'offline') throw new Error('unavailable');
        if (action === 'copy') {
          if (!(await copyFile(file.path))) throw new Error('clipboard');
          if (isCurrent()) setMessage('文件已复制，可在系统中粘贴');
        } else if (action === 'reveal') {
          await revealFileInFolder(file.path);
        } else {
          await deletePermanentFile(file.path);
          if (!isCurrent()) return;
          if (video.expandedId === file.assetId) video.setExpanded(null);
          setResult((previous) => previous ? { ...previous, entries: previous.entries.filter((entry) => entry.file.assetId !== file.assetId) } : previous);
          setRefresh((value) => value + 1);
          setMessage('文件已移入系统回收站');
        }
      }
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
    }
  };

  useEffect(() => {
    const request = new AbortController();
    void loadRecentAssets(scope, request.signal).then((items) => {
      if (!request.signal.aborted) setResult({ scope: scopeKey, entries: items, error: false });
    }, () => {
      if (!request.signal.aborted) setResult({ scope: scopeKey, entries: [], error: true });
    });
    return () => request.abort();
  }, [scope, scopeKey, revision, panelOpen, refresh]);
  useEffect(() => {
    const onFocus = () => setRefresh((value) => value + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    <section className="mt-6 border-t border-canvas-border pt-3" aria-label="最近使用资源">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon icon="mdi:folder-multiple-image" width="18" className="text-canvas-text-secondary" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-canvas-text">资源库</h2>
          <span className="text-xs text-canvas-text-muted">最近使用</span>
        </div>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={showAll}>
          进入资源库 <Icon icon="mdi:arrow-right" width="16" aria-hidden="true" />
        </button>
      </div>

      {entries.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {entries.map((entry) => {
            const { file, projectId } = entry;
            return (
            <article key={file.assetId} className="group ui-card ui-card--interactive min-w-0" data-recent-asset={file.assetId}
              tabIndex={0} aria-label={file.name} aria-haspopup="menu"
              onContextMenu={(event) => {
                event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
                operationRef.current?.abort(); setMessage(null);
                setFileMenu({ entry, scope: scopeKey, x: event.clientX, y: event.clientY });
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
                const rect = event.currentTarget.getBoundingClientRect();
                operationRef.current?.abort(); setMessage(null);
                setFileMenu({ entry, scope: scopeKey, x: rect.left + 12, y: rect.top + 12 });
              }}>
              <div className="relative aspect-video overflow-hidden [&_.assets-card-img-wrap]:h-full [&_.assets-card-img]:h-full [&_.assets-card-icon-wrap]:h-full [&_.assets-card-text-wrap]:h-full [&_.resource-video-preview]:h-full">
                <AssetThumb name={file.name} category={file.category} assetUrl={file.assetUrl} filePath={file.path} size={file.size}
                  videoPresentation="fullscreen" videoProjectId={projectId} videoExpanded={video.expandedId === file.assetId}
                  onVideoExpandedChange={(expanded) => {
                    video.setExpanded(expanded ? file.assetId! : null);
                    if (expanded) { setTextId(null); setImageId(null); void markUsed(file); }
                  }}
                  onImagePreview={file.category === 'image' ? () => {
                    video.setExpanded(null); setTextId(null); setImageId(file.assetId!); void markUsed(file);
                  } : undefined}
                  onTextPreview={file.category === 'text' ? () => {
                    video.setExpanded(null); setImageId(null); setTextId(file.assetId!); void markUsed(file);
                  } : undefined} />
                {file.category !== 'image' && file.category !== 'video' && file.category !== 'text' && (
                  <button type="button" className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
                    aria-label={`在资源库查看 ${file.name}`} onClick={() => openLibrary(true, 'page', projectId
                      ? { tab: 'project', projectId } : { tab: 'permanent', folder: file.source === 'folder' && file.folderRoot
                        ? { kind: 'folder', rootPath: file.folderRoot, relativePath: file.relativePath?.split('/').slice(0, -1).join('/') ?? '' } : { kind: 'all' } })} />
                )}
                <span className="assets-card-badge pointer-events-none max-w-[calc(100%-5rem)] truncate opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  {projectId ? projects.find((project) => project.id === seriesOwnerId(projects, projectId))?.name ?? '项目素材'
                    : file.folderRoot ? shortFolderName(file.folderRoot) : '全局资产'}
                </span>
              </div>
            </article>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-28 flex-col justify-center gap-3 rounded-lg bg-canvas-surface p-3">
          <p className="text-xs text-canvas-text-muted" role={result?.error ? 'status' : undefined}>
            {!result || result.scope !== scopeKey ? '正在读取最近使用…' : result.error
              ? '最近使用读取失败，可直接进入资源库。' : '暂无最近使用素材。预览或成功拖入画布后，会显示在这里。'}
          </p>
          <div className="flex flex-wrap gap-2">
            {(folderRoots ?? []).slice(0, 6).map((root) => (
              <button key={root} type="button" className="ui-btn ui-btn--secondary ui-btn--sm max-w-48"
                onClick={() => openLibrary(true, 'page', { tab: 'permanent', folder: { kind: 'folder', rootPath: root, relativePath: '' } })}>
                <Icon icon="mdi:folder-outline" width="16" aria-hidden="true" /><span className="truncate">{shortFolderName(root)}</span>
              </button>
            ))}
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={showAll}>浏览资源库</button>
          </div>
        </div>
      )}
      {message && <div role="status" className="mt-2 flex items-center justify-between gap-2 text-xs text-canvas-text-secondary">
        <span>{message}</span><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setMessage(null)}>关闭</button>
      </div>}
      {!panelOpen && fileMenu?.scope === scopeKey && entries.some((entry) => entry.file.assetId === fileMenu.entry.file.assetId) &&
        <AssetFileContextMenu key={`${fileMenu.entry.file.assetId}:${fileMenu.x}:${fileMenu.y}`} name={fileMenu.entry.file.name}
          x={fileMenu.x} y={fileMenu.y} canFileActions={isTauriEnv() && fileMenu.entry.file.availability !== 'offline'}
          canCopyPrompt={fileMenu.entry.file.category === 'image' || fileMenu.entry.file.category === 'video'}
          onCopy={() => performFileAction('copy')} onCopyPrompt={() => performFileAction('prompt')}
          onReveal={() => performFileAction('reveal')} onDelete={() => performFileAction('delete')} onClose={closeFileMenu} />}
      {!panelOpen && text && <Suspense fallback={<p role="status">正在打开文档…</p>}>
        <AssetTextPreview key={text.file.assetId} file={text.file} projectId={text.projectId} onClose={() => setTextId(null)}
          onSaved={() => setRefresh((value) => value + 1)} />
      </Suspense>}
      {image && <Suspense fallback={<p role="status" className="mt-2 text-xs text-canvas-text-muted">正在打开图片预览…</p>}>
        <AssetImagePreview key={image.file.assetId} files={[image.file]} initialPath={image.file.path}
          projectId={image.projectId} onClose={() => setImageId(null)} />
      </Suspense>}
    </section>
  );
}
