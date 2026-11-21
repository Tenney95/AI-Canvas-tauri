import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { OnMove, useReactFlow, useStoreApi } from '@xyflow/react';
import type { useCanvasViewportPreferences } from '../../hooks/useCanvasViewportPreferences';
import { useCanvasWheelZoom } from '../../hooks/useCanvasWheelZoom';
import type { createCanvasNodeLodRuntime } from '../../services/canvasNodeLodRuntime';
import { registerCanvasViewportController, type CanvasPanByDetail } from '../../services/canvasViewportService';
import { useAppStore } from '../../store/useAppStore';
import { getCanvasLockedZoom, normalizeCanvasZoom } from '../../utils/canvasViewportPreferences';

const CANVAS_INTERACTING_CLASS = 'canvas-interacting';
type CanvasInteractionKind = 'node' | 'viewport' | 'wheel';
const NODE_TOOLBAR_MIN_SCREEN_SCALE = 0.8;
const NODE_TOOLBAR_MAX_SCREEN_SCALE = 1.25;
const NODE_TOOLBAR_SCALE_EPSILON = 0.0005;
const VISIBLE_NODE_TOOLBARS = '.node-toolbar-shell.is-visible .node-floating-toolbar, .node:hover .node-floating-toolbar, .node.selected .node-floating-toolbar';
const VISIBLE_GOOEY_BUTTONS = '.react-flow__node:hover .gooey-btn-wrapper, .react-flow__node.selected .gooey-btn-wrapper, .node-handle:hover .gooey-btn-wrapper';
const ZOOM_TARGET_STRUCTURE = '.react-flow__node, .node, .node-toolbar-shell, .node-floating-toolbar, .node-handle, .gooey-btn-wrapper';
const ZOOM_POINTER_CONTEXT = '.node-toolbar-shell, .node-handle, .node, .react-flow__node';

interface CanvasViewportInteractionOptions {
  reactFlowInstance: ReturnType<typeof useReactFlow>;
  flowStore: ReturnType<typeof useStoreApi>;
  viewportPreferences: ReturnType<typeof useCanvasViewportPreferences>;
  nodeLodRuntime: ReturnType<typeof createCanvasNodeLodRuntime>;
  canvasRootRef: RefObject<HTMLDivElement | null>;
  wheelZoomCancelRef: RefObject<(() => void) | null>;
  interactionMode: 'default' | 'classic';
  isMacDesktop: boolean;
  currentProjectId: string | null;
}

export function useCanvasViewportInteraction({
  reactFlowInstance, flowStore, viewportPreferences, nodeLodRuntime, canvasRootRef,
  wheelZoomCancelRef, interactionMode, isMacDesktop, currentProjectId,
}: CanvasViewportInteractionOptions) {
  const { fitView: fitCanvasView, beginUserMove, endUserMove, recordViewport, rememberViewport } = viewportPreferences;
  useEffect(() => {
    nodeLodRuntime.activate();
    const { x, y, zoom } = reactFlowInstance.getViewport();
    const { width, height } = flowStore.getState();
    nodeLodRuntime.viewport(zoom, (width / 2 - x) / zoom, (height / 2 - y) / zoom);
    nodeLodRuntime.interaction(activeInteractionsRef.current.size > 0);
    return () => nodeLodRuntime.deactivate();
  }, [nodeLodRuntime, reactFlowInstance, flowStore]);
  const activeCanvasPanRef = useRef<{
    startX: number;
    startY: number;
    detail: CanvasPanByDetail;
  } | null>(null);

  useEffect(() => registerCanvasViewportController({
    rememberViewport,
    getSnapshot: () => {
      const viewport = reactFlowInstance.getViewport();
      const topLeft = reactFlowInstance.screenToFlowPosition({ x: 0, y: 0 });
      const bottomRight = reactFlowInstance.screenToFlowPosition({
        x: window.innerWidth,
        y: window.innerHeight,
      });
      return {
        ...viewport,
        visibleBounds: {
          x: topLeft.x,
          y: topLeft.y,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y,
        },
      };
    },
    setViewport: async (viewport, duration = 0) => {
      wheelZoomCancelRef.current?.();
      const config = useAppStore.getState().config;
      const zoom = getCanvasLockedZoom(config) ?? normalizeCanvasZoom(viewport.zoom, config);
      await reactFlowInstance.setViewport({ ...viewport, zoom }, { duration, interpolate: 'linear' });
    },
    fitView: async (options = {}) => {
      wheelZoomCancelRef.current?.();
      const ids = options.nodeIds ? new Set(options.nodeIds) : null;
      const nodes = ids
        ? reactFlowInstance.getNodes().filter((node) => ids.has(node.id))
        : undefined;
      await fitCanvasView({
        nodes,
        padding: options.padding ?? 0.25,
        duration: options.duration ?? 0,
      });
    },
  }), [reactFlowInstance, fitCanvasView, rememberViewport, wheelZoomCancelRef]);
  const activeInteractionsRef = useRef(new Set<CanvasInteractionKind>());
  const interactionReleaseFramesRef = useRef<Record<CanvasInteractionKind, number>>({
    node: 0,
    viewport: 0,
    wheel: 0,
  });

  const nodeToolbarScaleRef = useRef(Number.NaN);
  const gooeyScaleRef = useRef(Number.NaN);
  const latestCanvasZoomRef = useRef(Number.NaN);
  const localToolbarsRef = useRef(new Set<HTMLElement>());
  const localGooeyButtonsRef = useRef(new Set<HTMLElement>());
  const cachedZoomTargetsRef = useRef(new WeakSet<Set<HTMLElement>>());
  const zoomTargetsObserverRef = useRef<MutationObserver | null>(null);
  const zoomTargetsRefreshFrameRef = useRef(0);

  const clearLocalZoomCompensation = useCallback(() => {
    localToolbarsRef.current.forEach((element) => element.style.removeProperty('--toolbar-zoom-compensation'));
    localGooeyButtonsRef.current.forEach((element) => element.style.removeProperty('--gooey-inv-zoom'));
    localToolbarsRef.current.clear();
    localGooeyButtonsRef.current.clear();
    cachedZoomTargetsRef.current.delete(localToolbarsRef.current);
    cachedZoomTargetsRef.current.delete(localGooeyButtonsRef.current);
  }, []);

  const updateNodeZoomCompensation = useCallback((zoom: number, refreshTargets = false) => {
    const canvasRoot = canvasRootRef.current;
    if (!canvasRoot || !Number.isFinite(zoom) || zoom <= 0) return;
    const previousZoom = latestCanvasZoomRef.current;
    latestCanvasZoomRef.current = zoom;
    const gooeyCompensation = Math.min(1, 1 / zoom);
    const clampedScreenScale = Math.min(
      NODE_TOOLBAR_MAX_SCREEN_SCALE,
      Math.max(NODE_TOOLBAR_MIN_SCREEN_SCALE, zoom),
    );
    const compensation = clampedScreenScale / zoom;

    if (activeInteractionsRef.current.size > 0) {
      // 普通平移无需查找控件；缩放只改控件自身，避免根变量让整个媒体子树重算样式。
      if (!refreshTargets && zoom === previousZoom) return;
      const updateLocal = (selector: string, elements: Set<HTMLElement>, property: string, value: number) => {
        // 所有模式只在首次使用、挂载/可见状态变化时搜索；空结果也缓存。
        // 交互中继续更新已淡出的控件，避免退场期间缩放补偿跳变。
        if (refreshTargets || !cachedZoomTargetsRef.current.has(elements)) {
          canvasRoot.querySelectorAll<HTMLElement>(selector).forEach((element) => elements.add(element));
          cachedZoomTargetsRef.current.add(elements);
        }
        const text = String(value);
        elements.forEach((element) => {
          if (!canvasRoot.contains(element)) {
            element.style.removeProperty(property);
            elements.delete(element);
          } else if (element.style.getPropertyValue(property) !== text) {
            element.style.setProperty(property, text);
          }
        });
      };
      if (localToolbarsRef.current.size > 0
        || !(Math.abs(compensation - nodeToolbarScaleRef.current) < NODE_TOOLBAR_SCALE_EPSILON)) {
        updateLocal(VISIBLE_NODE_TOOLBARS, localToolbarsRef.current, '--toolbar-zoom-compensation', compensation);
      }
      if (localGooeyButtonsRef.current.size > 0 || gooeyCompensation !== gooeyScaleRef.current) {
        updateLocal(VISIBLE_GOOEY_BUTTONS, localGooeyButtonsRef.current, '--gooey-inv-zoom', gooeyCompensation);
      }
      return;
    }

    // 根引用只记录已发布的值；整段交互结束时先同步，再移除局部覆盖。
    if (gooeyCompensation !== gooeyScaleRef.current) {
      gooeyScaleRef.current = gooeyCompensation;
      canvasRoot.style.setProperty('--gooey-inv-zoom', String(gooeyCompensation));
    }
    if (!(Math.abs(compensation - nodeToolbarScaleRef.current) < NODE_TOOLBAR_SCALE_EPSILON)) {
      nodeToolbarScaleRef.current = compensation;
      canvasRoot.style.setProperty('--node-toolbar-zoom-compensation', String(compensation));
    }
    clearLocalZoomCompensation();
  }, [canvasRootRef, clearLocalZoomCompensation]);

  const refreshLocalZoomTargets = useCallback(() => {
    if (activeInteractionsRef.current.size === 0) return;
    if (zoomTargetsRefreshFrameRef.current) return;
    // 同帧的节点挂载、选中变化与指针穿越共用一次查询，不在每个子元素事件中扫描。
    zoomTargetsRefreshFrameRef.current = requestAnimationFrame(() => {
      zoomTargetsRefreshFrameRef.current = 0;
      if (activeInteractionsRef.current.size > 0) updateNodeZoomCompensation(latestCanvasZoomRef.current, true);
    });
  }, [updateNodeZoomCompensation]);

  const handleZoomTargetPointer = useCallback((event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target.closest(ZOOM_POINTER_CONTEXT) : null;
    const previous = event.relatedTarget instanceof Element ? event.relatedTarget.closest(ZOOM_POINTER_CONTEXT) : null;
    if (target === previous) return;
    refreshLocalZoomTargets();
  }, [refreshLocalZoomTargets]);

  const startObservingZoomTargets = useCallback(() => {
    const canvasRoot = canvasRootRef.current;
    if (!canvasRoot || zoomTargetsObserverRef.current) return;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => {
        if (record.type === 'attributes') {
          return record.target instanceof Element && record.target.matches('.react-flow__node, .node, .node-toolbar-shell');
        }
        // 图片加载、文本/图标更新不影响可见工具栏目标；只处理相关结构的新增与移除。
        const affectsTargets = (node: Node) => node instanceof Element
          && (node.matches(ZOOM_TARGET_STRUCTURE) || node.querySelector(ZOOM_TARGET_STRUCTURE) !== null);
        return Array.from(record.addedNodes).some(affectsTargets) || Array.from(record.removedNodes).some(affectsTargets);
      })) {
        refreshLocalZoomTargets();
      }
    });
    zoomTargetsObserverRef.current = observer;
    observer.observe(canvasRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    canvasRoot.addEventListener('pointerover', handleZoomTargetPointer, { passive: true });
    canvasRoot.addEventListener('pointerout', handleZoomTargetPointer, { passive: true });
  }, [canvasRootRef, handleZoomTargetPointer, refreshLocalZoomTargets]);

  const stopObservingZoomTargets = useCallback(() => {
    if (zoomTargetsRefreshFrameRef.current) cancelAnimationFrame(zoomTargetsRefreshFrameRef.current);
    zoomTargetsRefreshFrameRef.current = 0;
    zoomTargetsObserverRef.current?.disconnect();
    zoomTargetsObserverRef.current = null;
    canvasRootRef.current?.removeEventListener('pointerover', handleZoomTargetPointer);
    canvasRootRef.current?.removeEventListener('pointerout', handleZoomTargetPointer);
  }, [canvasRootRef, handleZoomTargetPointer]);

  useEffect(() => {
    updateNodeZoomCompensation(reactFlowInstance.getViewport().zoom);
  }, [reactFlowInstance, updateNodeZoomCompensation]);

  const setCanvasInteraction = useCallback((kind: CanvasInteractionKind, active: boolean) => {
    const wasInteracting = activeInteractionsRef.current.size > 0;
    if (active) activeInteractionsRef.current.add(kind);
    else activeInteractionsRef.current.delete(kind);
    const interacting = activeInteractionsRef.current.size > 0;
    if (wasInteracting === interacting) return;
    nodeLodRuntime.interaction(interacting);
    if (!interacting) {
      stopObservingZoomTargets();
      updateNodeZoomCompensation(reactFlowInstance.getViewport().zoom);
    }
    document.documentElement.classList.toggle(CANVAS_INTERACTING_CLASS, interacting);
  }, [nodeLodRuntime, reactFlowInstance, stopObservingZoomTargets, updateNodeZoomCompensation]);

  const beginCanvasInteraction = useCallback((kind: CanvasInteractionKind) => {
    const pendingFrame = interactionReleaseFramesRef.current[kind];
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    interactionReleaseFramesRef.current[kind] = 0;
    setCanvasInteraction(kind, true);
  }, [setCanvasInteraction]);

  const endCanvasInteraction = useCallback((kind: CanvasInteractionKind) => {
    const state = useAppStore.getState();
    if (!state.activeNodeId || document.querySelector('.ai-dialog-float.is-expanded')) {
      setCanvasInteraction(kind, false);
      return;
    }

    const pendingFrame = interactionReleaseFramesRef.current[kind];
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    interactionReleaseFramesRef.current[kind] = requestAnimationFrame(() => {
      const latestState = useAppStore.getState();
      const activeNodeId = latestState.activeNodeId;
      if (activeNodeId) {
        const nodeElement = document.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${activeNodeId}"]`,
        );
        const nodeRect = nodeElement?.getBoundingClientRect();
        if (nodeRect) {
          latestState.openNodeDialog(activeNodeId, {
            x: nodeRect.left + nodeRect.width / 2,
            y: nodeRect.bottom,
          });
        }
      }

      interactionReleaseFramesRef.current[kind] = requestAnimationFrame(() => {
        interactionReleaseFramesRef.current[kind] = 0;
        setCanvasInteraction(kind, false);
      });
    });
  }, [setCanvasInteraction]);

  useEffect(() => () => {
    Object.values(interactionReleaseFramesRef.current).forEach((frameId) => {
      if (frameId) cancelAnimationFrame(frameId);
    });
    activeInteractionsRef.current.clear();
    stopObservingZoomTargets();
    clearLocalZoomCompensation();
    document.documentElement.classList.remove(CANVAS_INTERACTING_CLASS);
  }, [clearLocalZoomCompensation, stopObservingZoomTargets]);

  const handleCanvasViewportMoveStart = useCallback<OnMove>((event) => {
    if (event) beginUserMove();
    beginCanvasInteraction('viewport');
  }, [beginCanvasInteraction, beginUserMove]);

  const handleCanvasViewportMoveEnd = useCallback<OnMove>(() => {
    if (activeInteractionsRef.current.has('wheel')) {
      setCanvasInteraction('viewport', false);
      return;
    }
    endUserMove();
    rememberViewport();
    endCanvasInteraction('viewport');
  }, [endCanvasInteraction, endUserMove, rememberViewport, setCanvasInteraction]);

  const handleCanvasViewportMove = useCallback<OnMove>((_, viewport) => {
    const { width, height } = flowStore.getState();
    const config = useAppStore.getState().config;
    const zoom = getCanvasLockedZoom(config) ?? normalizeCanvasZoom(viewport.zoom, config);
    if (zoom !== viewport.zoom) {
      // 配置可能在旧镜头动画或手势进行中变化；以画布中心纠正迟到的越界视口。
      const ratio = zoom / viewport.zoom;
      void reactFlowInstance.setViewport({
        x: width / 2 + (viewport.x - width / 2) * ratio,
        y: height / 2 + (viewport.y - height / 2) * ratio,
        zoom,
      });
      return;
    }
    recordViewport(viewport, { width, height });
    nodeLodRuntime.viewport(viewport.zoom, (width / 2 - viewport.x) / viewport.zoom, (height / 2 - viewport.y) / viewport.zoom);
    // 平移中新节点会挂载，只有倍率发生变化时才需要跟踪工具栏和端口的局部缩放补偿。
    if (activeInteractionsRef.current.size > 0 && viewport.zoom !== latestCanvasZoomRef.current) {
      startObservingZoomTargets();
    }
    updateNodeZoomCompensation(viewport.zoom);
    const activePan = activeCanvasPanRef.current;
    if (!activePan) return;
    activePan.detail.onProgress?.({
      deltaX: viewport.x - activePan.startX,
      deltaY: viewport.y - activePan.startY,
    });
  }, [flowStore, nodeLodRuntime, reactFlowInstance, recordViewport, startObservingZoomTargets, updateNodeZoomCompensation]);

  const handleWheelZoomStart = useCallback(() => {
    beginUserMove();
    beginCanvasInteraction('wheel');
  }, [beginCanvasInteraction, beginUserMove]);
  const handleWheelZoomEnd = useCallback((interrupted: boolean) => {
    endUserMove();
    rememberViewport();
    if (interrupted) setCanvasInteraction('wheel', false);
    else endCanvasInteraction('wheel');
  }, [endCanvasInteraction, endUserMove, rememberViewport, setCanvasInteraction]);
  useCanvasWheelZoom({
    rootRef: canvasRootRef,
    cancelRef: wheelZoomCancelRef,
    enabled: interactionMode === 'default' && !viewportPreferences.locked,
    nativeMouseWheel: isMacDesktop,
    projectId: currentProjectId,
    getViewport: reactFlowInstance.getViewport,
    setViewport: reactFlowInstance.setViewport,
    onStart: handleWheelZoomStart,
    onEnd: handleWheelZoomEnd,
    minZoom: viewportPreferences.minZoom,
    maxZoom: viewportPreferences.maxZoom,
  });

  return {
    activeCanvasPanRef, beginCanvasInteraction, endCanvasInteraction,
    handleCanvasViewportMove, handleCanvasViewportMoveStart, handleCanvasViewportMoveEnd,
  };
}
