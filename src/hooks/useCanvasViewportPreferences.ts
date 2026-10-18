import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useReactFlow, type FitViewOptions, type Viewport } from '@xyflow/react';
import { useAppStore } from '../store/useAppStore';
import type { CanvasViewportMode } from '../types';
import { readCanvasViewport, restoreCanvasViewport, saveCanvasViewport, type SavedCanvasViewport } from '../services/canvasViewportPersistence';
import {
  getCanvasFitViewOptions,
  getCanvasZoomPresets,
  getCanvasZoomRange,
  normalizeCanvasViewportMode,
  normalizeCanvasZoom,
} from '../utils/canvasViewportPreferences';

/** 只管理视口与显示偏好，不修改节点、项目或画布历史。 */
export function useCanvasViewportPreferences(
  rootRef: RefObject<HTMLDivElement | null>,
  cancelWheelRef: RefObject<(() => void) | null>,
) {
  const flow = useReactFlow();
  const projectId = useAppStore((state) => state.currentProjectId);
  const hydrated = useAppStore((state) => state.configHydrated);
  const mode = useAppStore((state) => normalizeCanvasViewportMode(state.config.canvasViewportMode));
  const preferredZoom = useAppStore((state) => normalizeCanvasZoom(state.config.canvasViewportZoom, state.config));
  const rangeMinZoom = useAppStore((state) => getCanvasZoomRange(state.config).minZoom);
  const rangeMaxZoom = useAppStore((state) => getCanvasZoomRange(state.config).maxZoom);
  // App 按项目 ID 重建 Canvas，每个实例只持有自己的初始记录与离开快照。
  const [savedViewport] = useState(() => readCanvasViewport(projectId));
  const initialViewPromiseRef = useRef<Promise<boolean> | null>(null);
  const viewportReadyRef = useRef(false);
  const lastViewportRef = useRef<SavedCanvasViewport | null>(null);
  const userMovingRef = useRef(false);
  const isCurrent = useCallback(() => useAppStore.getState().currentProjectId === projectId, [projectId]);

  const savePreference = useCallback((nextMode: CanvasViewportMode, zoom: number) => {
    const state = useAppStore.getState();
    if (!state.configHydrated || !isCurrent()) return;
    state.updateConfig({ canvasViewportMode: nextMode, canvasViewportZoom: normalizeCanvasZoom(zoom, state.config) });
    // 保存失败由既有配置状态展示，保留待保存修改。
    void state.saveConfig({ silent: true }).catch(() => {});
  }, [isCurrent]);

  const fitView = useCallback((options: FitViewOptions = {}, restorePreference = false) => {
    if (!isCurrent() || !flow.viewportInitialized) return Promise.resolve(false);
    cancelWheelRef.current?.();
    if (!flow.getNodes().some((node) => !node.hidden)) return Promise.resolve(false);
    return flow.fitView(getCanvasFitViewOptions(useAppStore.getState().config, options, restorePreference));
  }, [cancelWheelRef, flow, isCurrent]);

  const restoreInitialView = useCallback(() => {
    if (!hydrated || !flow.viewportInitialized || !isCurrent()) return Promise.resolve(false);
    if (initialViewPromiseRef.current) return initialViewPromiseRef.current;
    cancelWheelRef.current?.();
    const root = rootRef.current;
    initialViewPromiseRef.current = savedViewport
      ? flow.setViewport(restoreCanvasViewport(savedViewport, {
        width: root?.clientWidth ?? 0, height: root?.clientHeight ?? 0,
      }, useAppStore.getState().config))
      : fitView({ padding: 0.2 }, true);
    return initialViewPromiseRef.current;
  }, [cancelWheelRef, fitView, flow, hydrated, isCurrent, rootRef, savedViewport]);

  const recordViewport = useCallback((viewport: Viewport, size: { width: number; height: number }) => {
    if (!viewportReadyRef.current || size.width <= 0 || size.height <= 0) return;
    // 帧内只更新小快照，手势结束或离开时才写本机偏好。
    lastViewportRef.current = { x: viewport.x, y: viewport.y, zoom: viewport.zoom,
      width: size.width, height: size.height };
  }, []);
  const rememberViewport = useCallback(() => {
    if (projectId && lastViewportRef.current) saveCanvasViewport(projectId, lastViewportRef.current);
  }, [projectId]);
  const markViewportReady = useCallback(() => {
    if (!isCurrent()) return;
    viewportReadyRef.current = true;
    const root = rootRef.current;
    recordViewport(flow.getViewport(), { width: root?.clientWidth ?? 0, height: root?.clientHeight ?? 0 });
    rememberViewport();
  }, [flow, isCurrent, recordViewport, rememberViewport, rootRef]);

  const setZoom = useCallback((zoom: number) => {
    const state = useAppStore.getState();
    if (!state.configHydrated || !isCurrent()
      || normalizeCanvasViewportMode(state.config.canvasViewportMode) === 'locked') return;
    cancelWheelRef.current?.();
    savePreference('manual', zoom);
    // 节点定位可能临时改过比例；重复选择已保存的同一预设也必须立即生效。
    void flow.zoomTo(normalizeCanvasZoom(zoom, state.config));
  }, [cancelWheelRef, flow, isCurrent, savePreference]);

  const stepZoom = useCallback((direction: number) => {
    const percent = flow.getZoom() * 100;
    const allowedPresets = getCanvasZoomPresets(useAppStore.getState().config);
    const presets = direction > 0 ? allowedPresets : allowedPresets.reverse();
    const next = presets.find((value) => direction > 0 ? value > percent + 0.001 : value < percent - 0.001);
    if (next !== undefined) setZoom(next / 100);
  }, [flow, setZoom]);

  const toggleLock = useCallback(() => {
    cancelWheelRef.current?.();
    const locked = normalizeCanvasViewportMode(useAppStore.getState().config.canvasViewportMode) === 'locked';
    savePreference(locked ? 'manual' : 'locked', flow.getZoom());
  }, [cancelWheelRef, flow, savePreference]);

  const autoFit = useCallback(() => {
    cancelWheelRef.current?.();
    if (normalizeCanvasViewportMode(useAppStore.getState().config.canvasViewportMode) === 'locked') {
      // 锁定时 F 只重新居中，不能改变用户选定的比例。
      void fitView({ padding: 0.2 });
    } else {
      savePreference('auto', flow.getZoom());
      void fitView({ padding: 0.2 });
    }
  }, [cancelWheelRef, fitView, flow, savePreference]);

  const beginUserMove = useCallback(() => {
    const state = useAppStore.getState();
    if (!state.configHydrated || !isCurrent()
      || normalizeCanvasViewportMode(state.config.canvasViewportMode) === 'locked') return;
    userMovingRef.current = true;
    // 不在每帧保存；用户平移或缩放后由手动模式接管，避免 resize 拉回视图。
    if (normalizeCanvasViewportMode(state.config.canvasViewportMode) === 'auto') {
      state.updateConfig({ canvasViewportMode: 'manual', canvasViewportZoom: flow.getZoom() });
    }
  }, [flow, isCurrent]);

  const endUserMove = useCallback(() => {
    if (!userMovingRef.current) return;
    userMovingRef.current = false;
    if (normalizeCanvasViewportMode(useAppStore.getState().config.canvasViewportMode) !== 'locked') {
      savePreference('manual', flow.getZoom());
    }
  }, [flow, savePreference]);

  useEffect(() => {
    if (!hydrated || !flow.viewportInitialized || !isCurrent() || userMovingRef.current) return;
    if (!viewportReadyRef.current) {
      void restoreInitialView();
      return;
    }
    cancelWheelRef.current?.();
    if (mode === 'auto') {
      void fitView({ padding: 0.2 });
    } else {
      void flow.zoomTo(preferredZoom);
    }
  }, [cancelWheelRef, fitView, flow, hydrated, isCurrent, mode, preferredZoom, rangeMinZoom, rangeMaxZoom, restoreInitialView]);

  useEffect(() => {
    window.addEventListener('pagehide', rememberViewport);
    window.addEventListener('beforeunload', rememberViewport);
    return () => {
      // 缓存属于旧实例，切项目后也不会读取新画布的坐标。
      rememberViewport();
      window.removeEventListener('pagehide', rememberViewport);
      window.removeEventListener('beforeunload', rememberViewport);
    };
  }, [rememberViewport]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || !hydrated || !flow.viewportInitialized) return;
    let size = { width: element.clientWidth, height: element.clientHeight };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isCurrent()) return;
        const next = { width: element.clientWidth, height: element.clientHeight };
        if (next.width <= 0 || next.height <= 0) return;
        if (next.width === size.width && next.height === size.height) return;
        const previous = size;
        size = next;
        cancelWheelRef.current?.();
        if (normalizeCanvasViewportMode(useAppStore.getState().config.canvasViewportMode) === 'auto') {
          void fitView({ padding: 0.2 });
        } else if (previous.width > 0 && previous.height > 0) {
          const viewport = flow.getViewport();
          // 改变窗口或助手面板宽度时保持画布中心与缩放比例。
          void flow.setViewport({
            x: viewport.x + (next.width - previous.width) / 2,
            y: viewport.y + (next.height - previous.height) / 2,
            zoom: normalizeCanvasZoom(viewport.zoom, useAppStore.getState().config),
          });
        }
      }, 160);
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [cancelWheelRef, fitView, flow, hydrated, isCurrent, rootRef]);

  useEffect(() => {
    const onStep = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      if (direction === 1 || direction === -1) stepZoom(direction);
    };
    window.addEventListener('canvas-zoom-step', onStep);
    window.addEventListener('canvas-toggle-zoom-lock', toggleLock);
    return () => {
      window.removeEventListener('canvas-zoom-step', onStep);
      window.removeEventListener('canvas-toggle-zoom-lock', toggleLock);
    };
  }, [stepZoom, toggleLock]);

  const locked = mode === 'locked';
  const initialFitOptions = useMemo(() => getCanvasFitViewOptions({
    canvasViewportMode: mode, canvasViewportZoom: preferredZoom,
    canvasViewportMinZoom: rangeMinZoom, canvasViewportMaxZoom: rangeMaxZoom,
  }, { padding: 0.2 }, true), [mode, preferredZoom, rangeMinZoom, rangeMaxZoom]);
  const defaultViewport = useMemo(() => savedViewport ? restoreCanvasViewport(savedViewport, savedViewport, {
    canvasViewportMode: mode, canvasViewportZoom: preferredZoom,
    canvasViewportMinZoom: rangeMinZoom, canvasViewportMaxZoom: rangeMaxZoom,
  }) : undefined, [savedViewport, mode, preferredZoom, rangeMinZoom, rangeMaxZoom]);

  return {
    mode, locked, hydrated, preferredZoom, initialFitOptions, defaultViewport,
    initialFit: !savedViewport, restoreInitialView, markViewportReady, recordViewport, rememberViewport,
    minZoom: locked ? preferredZoom : rangeMinZoom,
    maxZoom: locked ? preferredZoom : rangeMaxZoom,
    fitView, setZoom, stepZoom, toggleLock, autoFit, beginUserMove, endUserMove,
  };
}
