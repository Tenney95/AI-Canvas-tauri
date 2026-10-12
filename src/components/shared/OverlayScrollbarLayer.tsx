/**
 * 在 Portal 层绘制跨平台覆盖式滚动条，跟踪目标容器滚动、尺寸和指针拖拽状态。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  getScrollClipBounds,
  getScrollThumbGeometry,
  getScrollViewportBounds,
} from './overlayScrollbarGeometry';

const INITIAL_VISIBILITY_MS = 2000;
const ACTIVE_VISIBILITY_MS = 1000;
const EDGE_INSET = 3;
const HIT_SIZE = 8;
const SCROLL_INTENT_WINDOW_MS = 300;
const DISCOVERY_RECHECK_MS = 500;
const DISCONNECTED_TARGET_SWEEP_MS = 5000;
const DISCOVERY_EXCLUSION_SELECTOR = '[data-overlay-scrollbar="off"], .react-flow__node';
const SCROLL_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
]);

type ScrollAxis = 'vertical' | 'horizontal';

interface ScrollAxes {
  vertical: boolean;
  horizontal: boolean;
}

interface DragState {
  axis: ScrollAxis;
  pointerId: number;
  thumb: HTMLDivElement;
  startPointer: number;
  startScroll: number;
  maxScroll: number;
  maxTravel: number;
}

interface ScrollbarOverlayProps {
  target: HTMLElement;
}

interface ScrollTargetEntry {
  id: number;
  target: HTMLElement;
}

interface OverlayHost {
  element: HTMLElement;
  isRoot: boolean;
}

const NO_AXES: ScrollAxes = { vertical: false, horizontal: false };

function createsOverlayContainingBlock(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
  const isScrollingContainer = /\b(auto|scroll|overlay)\b/.test(overflow);
  if (isScrollingContainer) return false;

  const isPositionedStackingContext = style.position !== 'static' && style.zIndex !== 'auto';
  const hasContainingBlockEffect = style.transform !== 'none'
    || style.perspective !== 'none'
    || style.filter !== 'none'
    || style.backdropFilter !== 'none'
    || /\b(paint|layout|strict|content)\b/.test(style.contain)
    || /\b(transform|perspective|filter)\b/.test(style.willChange);

  return isPositionedStackingContext || hasContainingBlockEffect;
}

function getOverlayHost(target: HTMLElement): OverlayHost {
  let candidate = target.parentElement;
  while (candidate && candidate !== document.body && candidate !== document.documentElement) {
    if (createsOverlayContainingBlock(candidate)) {
      return { element: candidate, isRoot: false };
    }
    candidate = candidate.parentElement;
  }

  return { element: document.body, isRoot: true };
}

function isVisiblyActive(target: HTMLElement): boolean {
  if (!target.isConnected || target.getClientRects().length === 0) return false;

  let current: HTMLElement | null = target;
  while (current) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.contentVisibility === 'hidden'
      || Number(style.opacity) <= 0.01
    ) return false;
    current = current.parentElement;
  }

  return true;
}

function getPotentialScrollAxes(target: HTMLElement): ScrollAxes {
  if (!target.isConnected || target.clientWidth <= 0 || target.clientHeight <= 0) return NO_AXES;

  const style = window.getComputedStyle(target);
  const allowsVerticalScroll = /^(auto|scroll|overlay)$/.test(style.overflowY);
  const allowsHorizontalScroll = /^(auto|scroll|overlay)$/.test(style.overflowX);

  return {
    vertical: allowsVerticalScroll && target.scrollHeight > target.clientHeight + 1,
    horizontal: allowsHorizontalScroll && target.scrollWidth > target.clientWidth + 1,
  };
}

function getScrollAxes(target: HTMLElement): ScrollAxes {
  return isVisiblyActive(target) ? getPotentialScrollAxes(target) : NO_AXES;
}

function hasScrollableAxis(axes: ScrollAxes): boolean {
  return axes.vertical || axes.horizontal;
}

function isSameAxes(left: ScrollAxes, right: ScrollAxes): boolean {
  return left.vertical === right.vertical && left.horizontal === right.horizontal;
}

function ScrollbarOverlay({ target }: ScrollbarOverlayProps) {
  const targetRef = useRef(target);
  const layerRef = useRef<HTMLDivElement>(null);
  const verticalThumbRef = useRef<HTMLDivElement>(null);
  const horizontalThumbRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const hoveredThumbRef = useRef<HTMLDivElement | null>(null);
  const hasShownInitialRef = useRef(false);
  const initialVisibilityUntilRef = useRef(0);
  const lastScrollIntentAtRef = useRef(-Infinity);
  const lastScrollPositionRef = useRef({ left: target.scrollLeft, top: target.scrollTop });
  const [axes, setAxes] = useState<ScrollAxes>(NO_AXES);
  const [isVisible, setIsVisible] = useState(false);
  const [dragAxis, setDragAxis] = useState<ScrollAxis | null>(null);
  const overlayHost = getOverlayHost(target);

  const clearHideTimer = useCallback(() => {
    if (!hideTimerRef.current) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const reveal = useCallback((duration: number) => {
    clearHideTimer();
    setIsVisible(true);
    if (dragRef.current || hoveredThumbRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setIsVisible(false);
    }, duration);
  }, [clearHideTimer]);

  const stopDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragAxis(null);
    if (drag.thumb.hasPointerCapture(drag.pointerId)) {
      drag.thumb.releasePointerCapture(drag.pointerId);
    }
  }, []);

  const applyGeometry = useCallback((): ScrollAxes => {
    const potentialAxes = getScrollAxes(target);
    const viewport = getScrollViewportBounds(target);
    const clip = getScrollClipBounds(target, viewport);
    const nextAxes = clip.width > 0 && clip.height > 0 ? potentialAxes : NO_AXES;
    setAxes((current) => (isSameAxes(current, nextAxes) ? current : nextAxes));

    if (!hasScrollableAxis(nextAxes)) {
      clearHideTimer();
      stopDrag();
      hoveredThumbRef.current = null;
      if (!hasScrollableAxis(potentialAxes)) {
        hasShownInitialRef.current = false;
        initialVisibilityUntilRef.current = 0;
      }
      setIsVisible(false);
      return nextAxes;
    }

    const layer = layerRef.current;
    if (!layer) return nextAxes;
    const layerRect = layer.getBoundingClientRect();
    const layerScaleX = layer.offsetWidth > 0 ? layerRect.width / layer.offsetWidth : 1;
    const layerScaleY = layer.offsetHeight > 0 ? layerRect.height / layer.offsetHeight : 1;
    const toLayerX = (viewportX: number) => (viewportX - layerRect.left) / layerScaleX;
    const toLayerY = (viewportY: number) => (viewportY - layerRect.top) / layerScaleY;
    layer.style.setProperty('--overlay-scrollbar-clip-top', `${Math.max(0, toLayerY(clip.top))}px`);
    layer.style.setProperty('--overlay-scrollbar-clip-right', `${Math.max(0, (layerRect.right - clip.right) / layerScaleX)}px`);
    layer.style.setProperty('--overlay-scrollbar-clip-bottom', `${Math.max(0, (layerRect.bottom - clip.bottom) / layerScaleY)}px`);
    layer.style.setProperty('--overlay-scrollbar-clip-left', `${Math.max(0, toLayerX(clip.left))}px`);
    const crossAxisGap = nextAxes.vertical && nextAxes.horizontal ? HIT_SIZE : 0;

    if (nextAxes.vertical && verticalThumbRef.current) {
      const geometry = getScrollThumbGeometry(
        viewport.height, target.clientHeight, target.scrollHeight, target.scrollTop, crossAxisGap,
      );
      const thumb = verticalThumbRef.current;
      thumb.style.setProperty('--overlay-scrollbar-hit-size', `${HIT_SIZE / layerScaleX}px`);
      thumb.style.setProperty('--overlay-scrollbar-x', `${toLayerX(viewport.right - EDGE_INSET - HIT_SIZE)}px`);
      thumb.style.setProperty('--overlay-scrollbar-y', `${toLayerY(viewport.top + geometry.offset)}px`);
      thumb.style.setProperty('--overlay-scrollbar-size', `${geometry.length / layerScaleY}px`);
    }

    if (nextAxes.horizontal && horizontalThumbRef.current) {
      const geometry = getScrollThumbGeometry(
        viewport.width, target.clientWidth, target.scrollWidth, target.scrollLeft, crossAxisGap,
      );
      const thumb = horizontalThumbRef.current;
      thumb.style.setProperty('--overlay-scrollbar-hit-size', `${HIT_SIZE / layerScaleY}px`);
      thumb.style.setProperty('--overlay-scrollbar-x', `${toLayerX(viewport.left + geometry.offset)}px`);
      thumb.style.setProperty('--overlay-scrollbar-y', `${toLayerY(viewport.bottom - EDGE_INSET - HIT_SIZE)}px`);
      thumb.style.setProperty('--overlay-scrollbar-size', `${geometry.length / layerScaleX}px`);
    }

    const drag = dragRef.current;
    if (drag && !(drag.axis === 'vertical' ? nextAxes.vertical : nextAxes.horizontal)) {
      stopDrag();
      hoveredThumbRef.current = null;
      reveal(ACTIVE_VISIBILITY_MS);
    }

    if (!hasShownInitialRef.current) {
      hasShownInitialRef.current = true;
      initialVisibilityUntilRef.current = performance.now() + INITIAL_VISIBILITY_MS;
      reveal(INITIAL_VISIBILITY_MS);
    }

    return nextAxes;
  }, [clearHideTimer, reveal, stopDrag, target]);

  useLayoutEffect(() => {
    let geometryFrame = requestAnimationFrame(() => {
      geometryFrame = 0;
      applyGeometry();
    });

    const scheduleGeometry = () => {
      if (geometryFrame) return;
      geometryFrame = requestAnimationFrame(() => {
        geometryFrame = 0;
        applyGeometry();
      });
    };

    const markScrollIntent = () => {
      lastScrollIntentAtRef.current = performance.now();
    };
    const handleScrollKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) markScrollIntent();
    };

    const handleScroll = () => {
      const nextScrollPosition = { left: target.scrollLeft, top: target.scrollTop };
      const didScroll = nextScrollPosition.left !== lastScrollPositionRef.current.left
        || nextScrollPosition.top !== lastScrollPositionRef.current.top;
      lastScrollPositionRef.current = nextScrollPosition;
      scheduleGeometry();
      const now = performance.now();
      const isInitializing = now < initialVisibilityUntilRef.current;
      const hasRecentScrollIntent = now - lastScrollIntentAtRef.current <= SCROLL_INTENT_WINDOW_MS;
      if (didScroll && hasShownInitialRef.current && !isInitializing && hasRecentScrollIntent) {
        reveal(ACTIVE_VISIBILITY_MS);
      }
    };
    const handleTargetPointerEnter = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      scheduleGeometry();
      reveal(ACTIVE_VISIBILITY_MS);
    };
    const handleWindowBlur = () => {
      stopDrag();
      hoveredThumbRef.current = null;
      clearHideTimer();
      setIsVisible(false);
    };
    const resizeObserver = new ResizeObserver(scheduleGeometry);
    const observedChildren = new Set<Element>();
    const observeContentChildren = () => {
      for (const child of observedChildren) {
        if (child.parentElement === target) continue;
        resizeObserver.unobserve(child);
        observedChildren.delete(child);
      }
      for (const child of target.children) {
        if (child.matches('.ui-scrollbar') || observedChildren.has(child)) continue;
        resizeObserver.observe(child);
        observedChildren.add(child);
      }
    };
    const geometryObserver = new MutationObserver((records) => {
      // 父滚动区可能包含子滚动条的 Portal；忽略浮层自身的几何写入，防止逐帧反馈。
      const hasContentChange = records.some((record) => {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        return !element?.closest('.ui-scrollbar');
      });
      if (!hasContentChange) return;
      observeContentChildren();
      scheduleGeometry();
    });
    const positionAncestors: HTMLElement[] = [];

    target.addEventListener('scroll', handleScroll, { passive: true });
    target.addEventListener('wheel', markScrollIntent, { passive: true });
    target.addEventListener('touchmove', markScrollIntent, { passive: true });
    target.addEventListener('keydown', handleScrollKey);
    target.addEventListener('pointerenter', handleTargetPointerEnter);
    target.addEventListener('input', scheduleGeometry, true);
    target.addEventListener('load', scheduleGeometry, true);
    window.addEventListener('resize', scheduleGeometry, { passive: true });
    window.addEventListener('scroll', scheduleGeometry, { passive: true });
    window.addEventListener('blur', handleWindowBlur);
    resizeObserver.observe(target);
    observeContentChildren();
    geometryObserver.observe(target, {
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    let positionAncestor: HTMLElement | null = target.parentElement;
    while (positionAncestor) {
      positionAncestors.push(positionAncestor);
      positionAncestor.addEventListener('scroll', scheduleGeometry, { passive: true });
      resizeObserver.observe(positionAncestor);
      geometryObserver.observe(positionAncestor, {
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'],
        attributes: true,
      });
      positionAncestor = positionAncestor.parentElement;
    }

    return () => {
      target.removeEventListener('scroll', handleScroll);
      target.removeEventListener('wheel', markScrollIntent);
      target.removeEventListener('touchmove', markScrollIntent);
      target.removeEventListener('keydown', handleScrollKey);
      target.removeEventListener('pointerenter', handleTargetPointerEnter);
      target.removeEventListener('input', scheduleGeometry, true);
      target.removeEventListener('load', scheduleGeometry, true);
      window.removeEventListener('resize', scheduleGeometry);
      window.removeEventListener('scroll', scheduleGeometry);
      window.removeEventListener('blur', handleWindowBlur);
      positionAncestors.forEach((ancestor) => ancestor.removeEventListener('scroll', scheduleGeometry));
      resizeObserver.disconnect();
      geometryObserver.disconnect();
      if (geometryFrame) cancelAnimationFrame(geometryFrame);
      clearHideTimer();
      stopDrag();
      hoveredThumbRef.current = null;
    };
  }, [applyGeometry, clearHideTimer, overlayHost.element, reveal, stopDrag, target]);

  const startDrag = useCallback((axis: ScrollAxis, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || dragRef.current) return;
    const thumb = event.currentTarget;
    const nextAxes = applyGeometry();
    if ((axis === 'vertical' && !nextAxes.vertical) || (axis === 'horizontal' && !nextAxes.horizontal)) return;

    const viewport = getScrollViewportBounds(target);
    const geometry = getScrollThumbGeometry(
      axis === 'vertical' ? viewport.height : viewport.width,
      axis === 'vertical' ? target.clientHeight : target.clientWidth,
      axis === 'vertical' ? target.scrollHeight : target.scrollWidth,
      axis === 'vertical' ? target.scrollTop : target.scrollLeft,
      nextAxes.vertical && nextAxes.horizontal ? HIT_SIZE : 0,
    );
    if (geometry.maxTravel <= 0 || geometry.maxScroll <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    thumb.setPointerCapture(event.pointerId);
    dragRef.current = {
      axis,
      pointerId: event.pointerId,
      thumb,
      startPointer: axis === 'vertical' ? event.clientY : event.clientX,
      startScroll: axis === 'vertical' ? target.scrollTop : target.scrollLeft,
      maxScroll: geometry.maxScroll,
      maxTravel: geometry.maxTravel,
    };
    setDragAxis(axis);
    clearHideTimer();
    setIsVisible(true);
  }, [applyGeometry, clearHideTimer, target]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.maxTravel <= 0) return;

    const pointer = drag.axis === 'vertical' ? event.clientY : event.clientX;
    const nextScroll = Math.max(0, Math.min(
      drag.maxScroll,
      drag.startScroll + ((pointer - drag.startPointer) / drag.maxTravel) * drag.maxScroll,
    ));
    const scrollTarget = targetRef.current;
    if (drag.axis === 'vertical') scrollTarget.scrollTop = nextScroll;
    else scrollTarget.scrollLeft = nextScroll;
  }, []);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    stopDrag();
    reveal(ACTIVE_VISIBILITY_MS);
  }, [reveal, stopDrag]);

  const handleThumbPointerEnter = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    hoveredThumbRef.current = event.currentTarget;
    clearHideTimer();
    setIsVisible(true);
  }, [clearHideTimer]);

  const handleThumbPointerLeave = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (hoveredThumbRef.current !== event.currentTarget) return;
    hoveredThumbRef.current = null;
    reveal(ACTIVE_VISIBILITY_MS);
  }, [reveal]);

  return createPortal(
    <div
      ref={layerRef}
      className={`ui-scrollbar${overlayHost.isRoot ? ' ui-scrollbar--root' : ''}`}
      data-overlay-scrollbar="off"
      aria-hidden="true"
    >
      <div
        ref={verticalThumbRef}
        className={`ui-scrollbar__thumb ui-scrollbar__thumb--vertical${axes.vertical ? '' : ' is-unavailable'}${axes.vertical && isVisible ? ' is-visible' : ''}${dragAxis === 'vertical' ? ' is-dragging' : ''}`}
        onPointerDown={(event) => startDrag('vertical', event)}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onPointerEnter={handleThumbPointerEnter}
        onPointerLeave={handleThumbPointerLeave}
      />
      <div
        ref={horizontalThumbRef}
        className={`ui-scrollbar__thumb ui-scrollbar__thumb--horizontal${axes.horizontal ? '' : ' is-unavailable'}${axes.horizontal && isVisible ? ' is-visible' : ''}${dragAxis === 'horizontal' ? ' is-dragging' : ''}`}
        onPointerDown={(event) => startDrag('horizontal', event)}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onPointerEnter={handleThumbPointerEnter}
        onPointerLeave={handleThumbPointerLeave}
      />
    </div>,
    overlayHost.element,
  );
}

export default function OverlayScrollbarLayer() {
  const knownTargetsRef = useRef(new Map<HTMLElement, number>());
  const nextTargetIdRef = useRef(1);
  const [targets, setTargets] = useState<ScrollTargetEntry[]>([]);

  useEffect(() => {
    const knownTargets = knownTargetsRef.current;
    const inspectedTargets = new WeakMap<HTMLElement, number>();
    let initialScanFrame = 0;
    let initialScanIdle: number | null = null;

    const getTargetEntries = () => Array.from(
      knownTargets,
      ([target, id]) => ({ id, target }),
    );

    const publishTargets = (targetsChanged = false, sweep = false) => {
      if (!targetsChanged && !sweep) return;
      for (const target of knownTargets.keys()) {
        if (target.isConnected && !target.closest(DISCOVERY_EXCLUSION_SELECTOR)) continue;
        if (target.getAttribute('data-overlay-scrollbar') === 'managed') {
          target.removeAttribute('data-overlay-scrollbar');
        }
        knownTargets.delete(target);
        targetsChanged = true;
      }
      if (targetsChanged) setTargets(getTargetEntries());
    };

    const registerTarget = (element: HTMLElement, forceRecheck = false): boolean => {
      if (knownTargets.has(element)) return false;
      const now = performance.now();
      const inspectedAt = inspectedTargets.get(element);
      if (!forceRecheck && inspectedAt !== undefined && now - inspectedAt < DISCOVERY_RECHECK_MS) return false;
      inspectedTargets.set(element, now);
      if (!hasScrollableAxis(getPotentialScrollAxes(element))) return false;

      knownTargets.set(element, nextTargetIdRef.current++);
      element.setAttribute('data-overlay-scrollbar', 'managed');
      return true;
    };

    const registerTargetAndAncestors = (element: HTMLElement, forceRecheck = false): boolean => {
      if (element.closest(DISCOVERY_EXCLUSION_SELECTOR)) return false;

      let changed = false;
      let candidate: HTMLElement | null = element;
      while (candidate) {
        changed = registerTarget(candidate, forceRecheck) || changed;
        candidate = candidate.parentElement;
      }
      return changed;
    };

    const getClosestHtmlElement = (target: EventTarget | null): HTMLElement | null => {
      let element = target instanceof Element ? target : null;
      while (element && !(element instanceof HTMLElement)) element = element.parentElement;
      return element instanceof HTMLElement ? element : null;
    };

    const discoverInitialTargets = () => {
      initialScanFrame = 0;
      initialScanIdle = null;
      const root = document.body;
      if (!root) return;

      let changed = registerTarget(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) => (
          node instanceof HTMLElement && node.matches(DISCOVERY_EXCLUSION_SELECTOR)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT
        ),
      });
      let candidate = walker.nextNode();
      while (candidate) {
        if (candidate instanceof HTMLElement) changed = registerTarget(candidate) || changed;
        candidate = walker.nextNode();
      }
      publishTargets(changed);
    };

    const handlePotentialScrollArea = (event: Event) => {
      const target = getClosestHtmlElement(event.target);
      publishTargets(target ? registerTargetAndAncestors(target) : false);
    };
    const handleFocusedScrollArea = (event: Event) => {
      const target = getClosestHtmlElement(event.target);
      publishTargets(target ? registerTargetAndAncestors(target, true) : false);
    };
    const handleScrollCapture = (event: Event) => {
      const target = event.target instanceof Document ? document.scrollingElement : event.target;
      const changed = target instanceof HTMLElement
        && !target.closest(DISCOVERY_EXCLUSION_SELECTOR)
        && registerTarget(target, true);
      publishTargets(changed);
    };

    const captureOptions = { capture: true, passive: true } as const;
    document.addEventListener('scroll', handleScrollCapture, captureOptions);
    document.addEventListener('pointerover', handlePotentialScrollArea, true);
    document.addEventListener('focusin', handleFocusedScrollArea, true);
    document.addEventListener('input', handleFocusedScrollArea, true);
    const disconnectedTargetSweep = window.setInterval(
      () => publishTargets(false, true),
      DISCONNECTED_TARGET_SWEEP_MS,
    );
    if (typeof window.requestIdleCallback === 'function') {
      initialScanIdle = window.requestIdleCallback(discoverInitialTargets, { timeout: 500 });
    } else {
      initialScanFrame = requestAnimationFrame(discoverInitialTargets);
    }

    return () => {
      document.removeEventListener('scroll', handleScrollCapture, true);
      document.removeEventListener('pointerover', handlePotentialScrollArea, true);
      document.removeEventListener('focusin', handleFocusedScrollArea, true);
      document.removeEventListener('input', handleFocusedScrollArea, true);
      window.clearInterval(disconnectedTargetSweep);
      if (initialScanIdle !== null) window.cancelIdleCallback(initialScanIdle);
      if (initialScanFrame) cancelAnimationFrame(initialScanFrame);
      knownTargets.forEach((_, target) => {
        if (target.getAttribute('data-overlay-scrollbar') === 'managed') {
          target.removeAttribute('data-overlay-scrollbar');
        }
      });
      knownTargets.clear();
    };
  }, []);

  return (
    <>
      {targets.map(({ id, target }) => (
        <ScrollbarOverlay key={id} target={target} />
      ))}
    </>
  );
}
