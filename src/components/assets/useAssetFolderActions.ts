import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';
import { t as translate } from '../../i18n';
import { useAppStore, type AppState } from '../../store/useAppStore';
import {
  addAssetFilesToGlobal, copyAssetFolder, createAssetSubfolder, importAssetFilesToFolder, isTauriEnv, openDirectoryInFileManager,
  pickAssetFolder, resolveAssetFolderDirectory, saveAssetToPermanent,
  type AssetFileEntry, type AssetFolderEntry, type AssetFolderSelection,
} from '../../services/fileService';
import { copyFile, readClipboardFolders } from '../../services/clipboardService';
import { startAssetDrag } from '../../utils/assetDrag';
import { isExternalDropCaptured, setExternalDropCaptured } from '../../utils/dropCapture';
import { nativeDropClientPosition } from '../../utils/nativeDropPosition';
import { shortFolderName } from '../../utils/assetFormat';
import type { DramaAssetCategory } from '../../types/dramaAssets';
import type { FileTabKey, TabKey } from './useAssetFileInventory';

/** 仅磁盘真实文件可拖拽（排除节点引用的 node:// / virtual:// 虚拟路径）*/
export function isDraggableEntry(file: AssetFileEntry): boolean {
  return !!file.path && !file.path.startsWith('node://') && !file.path.startsWith('virtual://');
}

export function isLocalAssetFile(file: AssetFileEntry): boolean {
  return isDraggableEntry(file) && file.availability !== 'offline'
    && (!/^[a-z][\w+.-]*:/i.test(file.path) || /^[a-z]:[\\/]/i.test(file.path));
}

export function useAssetFolderActions({
  assetsPanelOpen, assetsPanelMode, setAssetsPanelOpen, currentProjectId, updateConfig, saveConfig,
  activeTab, globalCreativeKind, visibleTab, isDrawer, isPage, externalFolders, globalRootPath,
  folderSelection, folderOperationRef, dismissHover, setBusy, setAddMenuOpen, folders, toast, loadFiles,
  loadTags, handleSelectFolder,
}: Pick<AppState, 'assetsPanelOpen' | 'assetsPanelMode' | 'setAssetsPanelOpen' | 'currentProjectId' | 'updateConfig' | 'saveConfig'> & {
  activeTab: FileTabKey;
  visibleTab: TabKey;
  globalCreativeKind: DramaAssetCategory | null;
  isDrawer: boolean;
  isPage: boolean;
  externalFolders: AssetFolderEntry[];
  globalRootPath: string | null;
  folderSelection: AssetFolderSelection;
  folderOperationRef: RefObject<AbortController | null>;
  dismissHover: () => void;
  setBusy: (value: boolean) => void;
  setAddMenuOpen: (value: boolean) => void;
  folders: string[];
  toast: (message: string) => void;
  loadFiles: () => Promise<void>;
  loadTags: () => Promise<void>;
  handleSelectFolder: (selection: AssetFolderSelection) => void;
}) {
  const [folderProgress, setFolderProgress] = useState<string | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<AssetFolderSelection | null>(null);
  const internalFolderDragRef = useRef<AssetFileEntry | null>(null);
  const dragEndTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleCreateSubfolder = async (selection: AssetFolderSelection, name: string) => {
    if (folderOperationRef.current) throw new Error('请等待当前目录操作完成');
    const controller = new AbortController();
    folderOperationRef.current = controller; setBusy(true);
    try {
      await createAssetSubfolder(selection, useAppStore.getState().config.assetFolders ?? [], name);
      if (!controller.signal.aborted) { await loadFiles(); toast('文件夹已创建'); }
    } finally {
      if (folderOperationRef.current === controller) { folderOperationRef.current = null; setBusy(false); }
    }
  };

  const handleOpenFolder = async (selection: AssetFolderSelection) => {
    try {
      const directory = await resolveAssetFolderDirectory(selection, useAppStore.getState().config.assetFolders ?? []);
      await openDirectoryInFileManager(directory);
    } catch {
      toast('打开目录失败，请检查文件夹位置和权限');
    }
  };

  const handleFolderClipboard = async (selection: AssetFolderSelection, operation: 'copy' | 'paste') => {
    if (folderOperationRef.current) return;
    const controller = new AbortController();
    folderOperationRef.current = controller; setBusy(true);
    try {
      const directory = await resolveAssetFolderDirectory(selection, useAppStore.getState().config.assetFolders ?? []);
      if (controller.signal.aborted) return;
      if (operation === 'copy') {
        if (!(await copyFile(directory))) throw new Error('复制失败，请检查目录权限和系统剪贴板');
        if (!controller.signal.aborted) toast('文件夹已复制，可在这里或系统中粘贴');
      } else {
        const sources = await readClipboardFolders();
        for (const [index, source] of sources.entries()) {
          if (controller.signal.aborted) throw new Error('复制已取消；已复制内容保留在目标目录');
          setFolderProgress(translate('正在粘贴文件夹 {index}/{total}…', { index: index + 1, total: sources.length }));
          await copyAssetFolder(source, directory, { signal: controller.signal, onProgress: ({ transferredBytes, totalBytes }) => {
            if (!controller.signal.aborted) setFolderProgress(translate('正在粘贴文件夹 {index}/{total} · {progress}%', { index: index + 1, total: sources.length, progress: totalBytes ? Math.min(100, Math.round(transferredBytes / totalBytes * 100)) : 100 }));
          } });
        }
        if (!controller.signal.aborted) toast(translate('已粘贴 {count} 个文件夹', { count: sources.length }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '目录操作失败，请检查权限';
      if (useAppStore.getState().assetsPanelOpen) toast(controller.signal.aborted ? '复制已取消；已复制内容保留在目标目录' : message);
    } finally {
      if (folderOperationRef.current === controller) {
        folderOperationRef.current = null; setBusy(false); setFolderProgress(null);
      }
      if (operation === 'paste' && useAppStore.getState().assetsPanelOpen && useAppStore.getState().currentProjectId === currentProjectId) await loadFiles();
    }
  };

  const dragMonitorRef = useRef<(() => void) | null>(null);
  const pointerDragStopRef = useRef<(() => void) | null>(null);
  const suppressDragClickRef = useRef(0);
  const releaseDropCaptureRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    dragMonitorRef.current?.();
    pointerDragStopRef.current?.();
    if (isDrawer) releaseDropCaptureRef.current?.();
    internalFolderDragRef.current = null;
    clearTimeout(dragEndTimerRef.current);
  }, [assetsPanelOpen, assetsPanelMode, currentProjectId, isDrawer]);
  useEffect(() => {
    if (!assetsPanelOpen || isDrawer) return;
    // 整页或弹窗覆盖画布时，不允许窗口级 drop 在背后创建节点。
    // 尊重先前已存在的独占状态；拖出弹窗时提前释放，露出的画布可接收落点。
    const previouslyCaptured = isExternalDropCaptured();
    setExternalDropCaptured(true);
    const release = () => {
      if (releaseDropCaptureRef.current !== release) return;
      releaseDropCaptureRef.current = null;
      setExternalDropCaptured(previouslyCaptured);
    };
    releaseDropCaptureRef.current = release;
    return release;
  }, [assetsPanelOpen, isDrawer]);

  const folderTargetAt = useCallback((x: number, y: number): AssetFolderSelection | null => {
    if (!assetsPanelOpen || activeTab !== 'permanent' || visibleTab !== 'permanent' || globalCreativeKind || folderOperationRef.current) return null;
    const encoded = document.elementFromPoint?.(x, y)?.closest('[data-asset-folder-target]')?.getAttribute('data-asset-folder-target');
    if (!encoded) return null;
    try {
      const target: AssetFolderSelection = JSON.parse(encoded);
      if (target.kind === 'global') return globalRootPath ? target : null;
      if (target.kind === 'folder' && externalFolders.some((folder) => folder.availability === 'online'
        && folder.rootPath === target.rootPath && folder.relativePath === target.relativePath)) return target;
    } catch { /* 非目录落点不接收文件。 */ }
    return null;
  }, [assetsPanelOpen, activeTab, visibleTab, globalCreativeKind, globalRootPath, externalFolders, folderOperationRef]);

  const highlightFolder = useCallback((target: AssetFolderSelection | null) => {
    setFolderDropTarget((previous) => JSON.stringify(previous) === JSON.stringify(target) ? previous : target);
  }, []);

  const receiveFolderDrop = useCallback(async (selection: AssetFolderSelection, paths: string[], internal: AssetFileEntry | null) => {
    if (folderOperationRef.current) return;
    dismissHover(); highlightFolder(null);
    const controller = new AbortController();
    folderOperationRef.current = controller; setBusy(true);
    const moving = internal?.category === 'image' && (internal.source === 'global' || internal.source === 'folder');
    setFolderProgress(moving ? '正在移动图片…' : translate('正在导入 {count} 个文件…', { count: paths.length }));
    try {
      const options = { signal: controller.signal, onProgress: ({ transferredBytes, totalBytes }: { transferredBytes: number; totalBytes: number | null }) => {
        if (!controller.signal.aborted) setFolderProgress(translate('{action} · {progress}%', { action: moving ? translate('正在移动') : translate('正在导入'), progress: totalBytes ? Math.min(100, Math.round(transferredBytes / totalBytes * 100)) : 100 }));
      } };
      if (moving) {
        const result = await useAppStore.getState().moveGlobalAssetToFolder(internal, selection, options);
        toast(result.moved ? '图片已移动到文件夹' : '图片已在此文件夹内');
      } else {
        const count = await importAssetFilesToFolder(paths, selection, useAppStore.getState().config.assetFolders ?? [], options);
        toast(translate('已导入 {count} 个文件，外部原文件保留', { count }));
      }
    } catch {
      if (useAppStore.getState().assetsPanelOpen) toast(controller.signal.aborted
        ? '操作已取消，原文件和已完成的副本均保留' : '操作未完成，原文件已保留；请检查目录权限或文件是否已变化');
    } finally {
      if (folderOperationRef.current === controller) { folderOperationRef.current = null; setBusy(false); setFolderProgress(null); }
      if (useAppStore.getState().assetsPanelOpen && useAppStore.getState().currentProjectId === currentProjectId) await loadFiles().then(loadTags);
    }
  }, [dismissHover, highlightFolder, currentProjectId, folderOperationRef, loadFiles, loadTags, setBusy, toast]);

  // 原生插件拖拽与系统外部拖入使用不同事件通道；同时监听并去重。
  const nativeFolderHandlersRef = useRef({ folderTargetAt, highlightFolder, receiveFolderDrop });
  useEffect(() => { nativeFolderHandlersRef.current = { folderTargetAt, highlightFolder, receiveFolderDrop }; }, [folderTargetAt, highlightFolder, receiveFolderDrop]);
  useEffect(() => {
    if (!assetsPanelOpen || activeTab !== 'permanent' || visibleTab !== 'permanent' || !isTauriEnv()) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    let lastDrop = { signature: '', time: 0 };
    let drawerCapture: boolean | null = null;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseDrawer = () => {
      if (drawerCapture !== null) { setExternalDropCaptured(drawerCapture); drawerCapture = null; }
    };
    const handle = (payload: { type: string; paths?: string[]; position?: { x: number; y: number } }) => {
      if (disposed) return;
      const handlers = nativeFolderHandlersRef.current;
      if (payload.type === 'leave') { handlers.highlightFolder(null); releaseDrawer(); return; }
      const point = payload.position ? nativeDropClientPosition(payload.position) : null;
      const target = point ? handlers.folderTargetAt(point.x, point.y) : null;
      handlers.highlightFolder(target);
      if (isDrawer && target && drawerCapture === null) {
        drawerCapture = isExternalDropCaptured(); setExternalDropCaptured(true);
      }
      if (payload.type !== 'drop') { if (!target) releaseDrawer(); return; }
      // 留到本次事件分发结束，避免背后的画布也消费此落点。
      clearTimeout(releaseTimer); releaseTimer = setTimeout(releaseDrawer, 0);
      if (!target || !payload.paths?.length) return;
      const signature = JSON.stringify([target, payload.paths]);
      if (lastDrop.signature === signature && Date.now() - lastDrop.time < 400) return;
      lastDrop = { signature, time: Date.now() };
      const internal = internalFolderDragRef.current;
      const same = (path: string) => {
        const normalized = path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
        return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
      };
      const movingFile = internal && payload.paths.length === 1 && same(internal.path) === same(payload.paths[0]) ? internal : null;
      internalFolderDragRef.current = null;
      void handlers.receiveFolderDrop(target, payload.paths, movingFile);
    };
    void (async () => {
      try {
        const [{ getCurrentWebview }, { listen }] = await Promise.all([import('@tauri-apps/api/webview'), import('@tauri-apps/api/event')]);
        if (disposed) return;
        const first = await getCurrentWebview().onDragDropEvent(({ payload }) => handle(payload));
        if (disposed) { first(); return; } unlisten.push(first);
        // 同进程插件也可能只投递到窗口通道；悬停和离开必须与 drop 一起补齐。
        for (const type of ['enter', 'over', 'drop', 'leave'] as const) {
          const stop = await listen<{ paths?: string[]; position?: { x: number; y: number } }>(`tauri://drag-${type}`, ({ payload }) => handle({ ...payload, type }));
          if (disposed) { stop(); return; } unlisten.push(stop);
        }
      } catch { /* 浏览器预览不具备系统拖放能力。 */ }
    })();
    return () => { disposed = true; unlisten.forEach((stop) => stop()); clearTimeout(releaseTimer); releaseDrawer(); nativeFolderHandlersRef.current.highlightFolder(null); };
  }, [assetsPanelOpen, activeTab, visibleTab, isDrawer]);

  // 原生拖拽不会持续发送 DOM dragover；所有展示模式用系统坐标检测目录，弹窗额外检测越界。
  // startAssetDrag 仍在 dragstart 中同步调用，避免丢失鼠标手势。
  const handleCardDragStart = useCallback((file: AssetFileEntry, e: DragEvent) => {
    dismissHover();
    if (!isDraggableEntry(file)) return;
    e.preventDefault();
    dragMonitorRef.current?.();
    clearTimeout(dragEndTimerRef.current);
    if (isDrawer) releaseDropCaptureRef.current?.();
    const folderDrag = activeTab === 'permanent' && isLocalAssetFile(file);
    internalFolderDragRef.current = folderDrag ? file : null;
    if (folderDrag && isDrawer) {
      // 同进程原生拖拽可能没有 over 事件；从开始就阻止画布抢先消费目录落点。
      const previouslyCaptured = isExternalDropCaptured();
      setExternalDropCaptured(true);
      const release = () => {
        if (releaseDropCaptureRef.current !== release) return;
        releaseDropCaptureRef.current = null; setExternalDropCaptured(previouslyCaptured);
      };
      releaseDropCaptureRef.current = release;
    }
    if (!folderDrag && (isPage || isDrawer || !currentProjectId)) {
      startAssetDrag(file, undefined, e.currentTarget as Element);
      if (isDrawer) setAssetsPanelOpen(false);
      return;
    }
    // 整页布局没有 .assets-panel 类，沿用三种布局共有的容器标记。
    const bounds = e.currentTarget?.closest('[data-resource-video-boundary]')?.getBoundingClientRect();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (dragMonitorRef.current === stop) dragMonitorRef.current = null;
      highlightFolder(null);
    };
    dragMonitorRef.current = stop;
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      void (async () => {
        try {
          const nativeWindow = getCurrentWindow();
          const [origin, scale] = await Promise.all([nativeWindow.innerPosition(), nativeWindow.scaleFactor()]);
          if (!Number.isFinite(scale) || scale <= 0) { stop(); return; }
          const checkPosition = async () => {
            if (stopped) return;
            try {
              const point = await cursorPosition();
              if (stopped) return;
              const state = useAppStore.getState();
              if (!state.assetsPanelOpen || state.assetsPanelMode !== assetsPanelMode || state.currentProjectId !== currentProjectId) { stop(); return; }
              const x = (point.x - origin.x) / scale;
              const y = (point.y - origin.y) / scale;
              if (!Number.isFinite(x) || !Number.isFinite(y)) { stop(); return; }
              highlightFolder(nativeFolderHandlersRef.current.folderTargetAt(x, y));
              if (!isPage && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)) {
                stop(); releaseDropCaptureRef.current?.(); setAssetsPanelOpen(false); return;
              }
              timer = setTimeout(() => { void checkPosition(); }, 50);
            } catch { stop(); }
          };
          await checkPosition();
        } catch { stop(); }
      })();
    }
    startAssetDrag(file, () => {
      stop();
      // 同一进程的 drop 可能晚于原生结束回调；短暂保留来源以区分移动与复制。
      dragEndTimerRef.current = setTimeout(() => {
        internalFolderDragRef.current = null;
        if (isDrawer) releaseDropCaptureRef.current?.();
      }, 400);
    }, e.currentTarget as Element);
  }, [currentProjectId, isDrawer, isPage, assetsPanelMode, activeTab, highlightFolder, setAssetsPanelOpen, dismissHover]);

  // Windows 原生 DoDragDrop 会占用窗口事件循环，库内反馈不能依赖拖拽期间的 IPC。
  // 保持 Pointer Events 到目录落点；越过面板边界时才同步交给系统文件拖拽。
  const handleCardPointerDown = useCallback((file: AssetFileEntry, event: ReactPointerEvent<HTMLDivElement>) => {
    if (activeTab !== 'permanent' || file.category !== 'image' || !isLocalAssetFile(file)
      || folderOperationRef.current || event.button !== 0 || event.pointerType !== 'mouse') return;
    const control = (event.target as HTMLElement).closest('button, input, textarea, select, a');
    if (control && !control.classList.contains('asset-image-preview-trigger')) return;
    const card = event.currentTarget;
    const bounds = card.closest('[data-resource-video-boundary]')?.getBoundingClientRect();
    if (!bounds || !card.setPointerCapture) return;
    pointerDragStopRef.current?.();
    event.preventDefault();
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let stopped = false;
    let ghost: HTMLImageElement | null = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', stop);
      window.removeEventListener('keydown', key, true);
      card.removeEventListener('lostpointercapture', stop);
      if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId);
      ghost?.remove();
      highlightFolder(null);
      if (pointerDragStopRef.current === stop) pointerDragStopRef.current = null;
    };
    const move = (e: PointerEvent) => {
      if (stopped || e.pointerId !== pointerId) return;
      if (!(e.buttons & 1)) { stop(); return; }
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      if (!dragging) {
        dragging = true; card.setPointerCapture(pointerId); dismissHover();
        if (file.assetUrl) {
          ghost = document.createElement('img');
          ghost.src = file.assetUrl; ghost.alt = '';
          ghost.setAttribute('aria-hidden', 'true');
          ghost.className = 'pointer-events-none fixed left-0 top-0 z-[320] h-20 w-20 rounded-lg object-contain opacity-80 shadow-lg';
          document.body.appendChild(ghost);
        }
      }
      e.preventDefault();
      suppressDragClickRef.current = Date.now() + 400;
      if (ghost) ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      highlightFolder(nativeFolderHandlersRef.current.folderTargetAt(e.clientX, e.clientY));
      if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) {
        stop();
        handleCardDragStart(file, { currentTarget: card, preventDefault: () => e.preventDefault() } as DragEvent<HTMLDivElement>);
        if (!isPage) { releaseDropCaptureRef.current?.(); setAssetsPanelOpen(false); }
      }
    };
    const up = (e: PointerEvent) => {
      if (stopped || e.pointerId !== pointerId) return;
      const target = dragging ? nativeFolderHandlersRef.current.folderTargetAt(e.clientX, e.clientY) : null;
      if (dragging) { e.preventDefault(); suppressDragClickRef.current = Date.now() + 400; }
      stop();
      if (target) void nativeFolderHandlersRef.current.receiveFolderDrop(target, [file.path], file);
    };
    const cancel = (e: PointerEvent) => { if (e.pointerId === pointerId) stop(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation(); stop();
    };
    pointerDragStopRef.current = stop;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', stop);
    window.addEventListener('keydown', key, true);
    card.addEventListener('lostpointercapture', stop);
  }, [activeTab, dismissHover, handleCardDragStart, highlightFolder, isPage, setAssetsPanelOpen, folderOperationRef]);

  // ── 添加文件 / 文件夹 ──
  const handleAddFiles = useCallback(async () => {
    setAddMenuOpen(false);
    setBusy(true);
    try {
      const target: AssetFolderSelection = folderSelection.kind === 'all' ? { kind: 'global' } : folderSelection;
      const n = await addAssetFilesToGlobal(target, useAppStore.getState().config.assetFolders ?? []);
      if (n > 0) { toast(translate('已添加 {count} 个文件', { count: n })); if (activeTab === 'permanent') await loadFiles(); }
    } catch { toast('添加失败'); } finally { setBusy(false); }
  }, [activeTab, folderSelection, loadFiles, setAddMenuOpen, setBusy, toast]);

  const handleAddFolder = useCallback(async () => {
    setAddMenuOpen(false);
    setBusy(true);
    try {
      const path = await pickAssetFolder();
      if (path && !folders.includes(path)) {
        updateConfig({ assetFolders: [...folders, path] });
        await saveConfig();
        toast(translate('已添加文件夹：{name}', { name: shortFolderName(path) }));
      }
    } catch { toast('添加失败'); } finally { setBusy(false); }
  }, [folders, updateConfig, saveConfig, setAddMenuOpen, setBusy, toast]);

  const handleRemoveFolder = useCallback(async (path: string) => {
    updateConfig({ assetFolders: folders.filter((f) => f !== path) });
    try { await saveConfig(); } catch { return; }
    if (folderSelection.kind === 'folder' && folderSelection.rootPath === path) handleSelectFolder({ kind: 'all' });
    // config.assetFolders 的变更触发 loadFiles，避免用旧目录清单再次覆盖新结果。
  }, [folders, updateConfig, saveConfig, folderSelection, handleSelectFolder]);

  // ── 全局资产 / 删除 ──
  const handleSavePermanent = useCallback(async (file: AssetFileEntry) => {
    const dest = await saveAssetToPermanent(file);
    toast(dest ? translate('已保存：{name}', { name: file.name }) : '保存失败');
    if (dest && activeTab === 'permanent') await loadFiles();
  }, [activeTab, loadFiles, toast]);

  return {
    folderProgress, folderDropTarget, handleCreateSubfolder, handleOpenFolder, handleFolderClipboard,
    pointerDragStopRef, suppressDragClickRef, handleCardDragStart, handleCardPointerDown, handleAddFiles,
    handleAddFolder, handleRemoveFolder, handleSavePermanent,
  };
}
