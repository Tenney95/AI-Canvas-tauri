import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

const INITIAL_VISIBILITY_MS = 2000;
const ACTIVE_VISIBILITY_MS = 1000;
const EDGE_INSET = 3;
const TRACK_INSET = 4;
const HIT_SIZE = 8;
const MIN_THUMB_SIZE = 36;
const SCROLL_INTENT_WINDOW_MS = 300;
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

interface ViewportBounds {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

const NO_AXES: ScrollAxes = { vertical: false, horizontal: false };

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

function getVisibleViewportBounds(target: HTMLElement): ViewportBounds {
  const rect = target.getBoundingClientRect();
  const scaleX = target.offsetWidth > 0 ? rect.width / target.offsetWidth : 1;
  const scaleY = target.offsetHeight > 0 ? rect.height / target.offsetHeight : 1;
  const rawLeft = rect.left + target.clientLeft * scaleX;
  const rawTop = rect.top + target.clientTop * scaleY;
  const rawRight = rawLeft + target.clientWidth * scaleX;
  const rawBottom = rawTop + target.clientHeight * scaleY;
  const left = Math.max(0, rawLeft);
  const top = Math.max(0, rawTop);
  const right = Math.min(window.innerWidth, rawRight);
  const bottom = Math.min(window.innerHeight, rawBottom);

  return {
    bottom,
    height: Math.max(0, bottom - top),
    left,
    right,
    top,
    width: Math.max(0, right - left),
  };
}

function ScrollbarOverlay({ target }: ScrollbarOverlayProps) {
  const targetRef = useRef(target);
  const verticalThumbRef = useRef<HTMLDivElement>(null);
  const horizontalThumbRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const hasShownInitialRef = useRef(false);
  const initialVisibilityUntilRef = useRef(0);
  const lastScrollIntentAtRef = useRef(0);
  const lastScrollPositionRef = useRef({ left: target.scrollLeft, top: target.scrollTop });
  const [axes, setAxes] = useState<ScrollAxes>(NO_AXES);
  const [isVisible, setIsVisible] = useState(false);

  const clearHideTimer = useCallback(() => {
    if (!hideTimerRef.current) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const reveal = useCallback((duration: number) => {
    clearHideTimer();
    setIsVisible(true);
    if (dragRef.current) return;
    hideTimerRef.current = setTimeout(() => setIsVisible(false), duration);
  }, [clearHideTimer]);

  const applyGeometry = useCallback((): ScrollAxes => {
    const nextAxes = getScrollAxes(target);
    setAxes((current) => (isSameAxes(current, nextAxes) ? current : nextAxes));

    if (!hasScrollableAxis(nextAxes)) {
      clearHideTimer();
      hasShownInitialRef.current = false;
      initialVisibilityUntilRef.current = 0;
      setIsVisible(false);
      return nextAxes;
    }

    const viewport = getVisibleViewportBounds(target);
    const crossAxisGap = nextAxes.vertical && nextAxes.horizontal ? HIT_SIZE : 0;

    if (nextAxes.vertical && verticalThumbRef.current) {
      const trackHeight = Math.max(0, viewport.height - TRACK_INSET * 2 - crossAxisGap);
      const thumbHeight = Math.min(
        trackHeight,
        Math.max(MIN_THUMB_SIZE, trackHeight * (target.clientHeight / target.scrollHeight)),
      );
      const maxScrollTop = Math.max(1, target.scrollHeight - target.clientHeight);
      const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
      const thumbTop = maxThumbTop * (target.scrollTop / maxScrollTop);
      const thumb = verticalThumbRef.current;
      thumb.style.setProperty('--overlay-scrollbar-x', `${viewport.right - EDGE_INSET - HIT_SIZE}px`);
      thumb.style.setProperty('--overlay-scrollbar-y', `${viewport.top + TRACK_INSET + thumbTop}px`);
      thumb.style.setProperty('--overlay-scrollbar-size', `${thumbHeight}px`);
    }

    if (nextAxes.horizontal && horizontalThumbRef.current) {
      const trackWidth = Math.max(0, viewport.width - TRACK_INSET * 2 - crossAxisGap);
      const thumbWidth = Math.min(
        trackWidth,
        Math.max(MIN_THUMB_SIZE, trackWidth * (target.clientWidth / target.scrollWidth)),
      );
      const maxScrollLeft = Math.max(1, target.scrollWidth - target.clientWidth);
      const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
      const thumbLeft = maxThumbLeft * (target.scrollLeft / maxScrollLeft);
      const thumb = horizontalThumbRef.current;
      thumb.style.setProperty('--overlay-scrollbar-x', `${viewport.left + TRACK_INSET + thumbLeft}px`);
      thumb.style.setProperty('--overlay-scrollbar-y', `${viewport.bottom - EDGE_INSET - HIT_SIZE}px`);
      thumb.style.setProperty('--overlay-scrollbar-size', `${thumbWidth}px`);
    }

    if (!hasShownInitialRef.current) {
      hasShownInitialRef.current = true;
      initialVisibilityUntilRef.current = performance.now() + INITIAL_VISIBILITY_MS;
      reveal(INITIAL_VISIBILITY_MS);
    }

    return nextAxes;
  }, [clearHideTimer, reveal, target]);

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
      const wasInitialReveal = !hasShownInitialRef.current;
      applyGeometry();
      const now = performance.now();
      const isInitializing = now < initialVisibilityUntilRef.current;
      const hasRecentScrollIntent = now - lastScrollIntentAtRef.current <= SCROLL_INTENT_WINDOW_MS;
      if (didScroll && !wasInitialReveal && !isInitializing && hasRecentScrollIntent) {
        reveal(ACTIVE_VISIBILITY_MS);
      }
    };
    const resizeObserver = new ResizeObserver(scheduleGeometry);
    const contentObserver = new MutationObserver(scheduleGeometry);
    const positionObserver = new MutationObserver(scheduleGeometry);

    target.addEventListener('scroll', handleScroll, { passive: true });
    target.addEventListener('wheel', markScrollIntent, { passive: true });
    target.addEventListener('touchmove', markScrollIntent, { passive: true });
    target.addEventListener('keydown', handleScrollKey);
    window.addEventListener('resize', scheduleGeometry, { passive: true });
    resizeObserver.observe(target);
    contentObserver.observe(target, { childList: true, characterData: true, subtree: true });
    let positionAncestor: HTMLElement | null = target;
    while (positionAncestor && positionAncestor !== document.body) {
      positionObserver.observe(positionAncestor, {
        attributeFilter: ['class', 'style'],
        attributes: true,
      });
      positionAncestor = positionAncestor.parentElement;
    }

    return () => {
      target.removeEventListener('scroll', handleScroll);
      target.removeEventListener('wheel', markScrollIntent);
      target.removeEventListener('touchmove', markScrollIntent);
      target.removeEventListener('keydown', handleScrollKey);
      window.removeEventListener('resize', scheduleGeometry);
      resizeObserver.disconnect();
      contentObserver.disconnect();
      positionObserver.disconnect();
      if (geometryFrame) cancelAnimationFrame(geometryFrame);
      clearHideTimer();
    };
  }, [applyGeometry, clearHideTimer, reveal, target]);

  const startDrag = useCallback((axis: ScrollAxis, event: ReactPointerEvent<HTMLDivElement>) => {
    const thumb = event.currentTarget;
    const nextAxes = applyGeometry();
    if ((axis === 'vertical' && !nextAxes.vertical) || (axis === 'horizontal' && !nextAxes.horizontal)) return;

    event.preventDefault();
    event.stopPropagation();
    thumb.setPointerCapture(event.pointerId);

    const viewport = getVisibleViewportBounds(target);
    const trackLength = axis === 'vertical'
      ? viewport.height - TRACK_INSET * 2 - (nextAxes.horizontal ? HIT_SIZE : 0)
      : viewport.width - TRACK_INSET * 2 - (nextAxes.vertical ? HIT_SIZE : 0);
    const thumbLength = axis === 'vertical' ? thumb.offsetHeight : thumb.offsetWidth;
    dragRef.current = {
      axis,
      pointerId: event.pointerId,
      startPointer: axis === 'vertical' ? event.clientY : event.clientX,
      startScroll: axis === 'vertical' ? target.scrollTop : target.scrollLeft,
      maxScroll: axis === 'vertical'
        ? target.scrollHeight - target.clientHeight
        : target.scrollWidth - target.clientWidth,
      maxTravel: Math.max(0, trackLength - thumbLength),
    };
    clearHideTimer();
    setIsVisible(true);
  }, [applyGeometry, clearHideTimer, target]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.maxTravel <= 0) return;

    const pointer = drag.axis === 'vertical' ? event.clientY : event.clientX;
    const nextScroll = drag.startScroll + ((pointer - drag.startPointer) / drag.maxTravel) * drag.maxScroll;
    const scrollTarget = targetRef.current;
    if (drag.axis === 'vertical') scrollTarget.scrollTop = nextScroll;
    else scrollTarget.scrollLeft = nextScroll;
  }, []);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    reveal(ACTIVE_VISIBILITY_MS);
  }, [reveal]);

  return (
    <>
      <div
        ref={verticalThumbRef}
        className={`overlay-scrollbar-thumb overlay-scrollbar-thumb--vertical${axes.vertical && isVisible ? ' is-visible' : ''}`}
        onPointerDown={(event) => startDrag('vertical', event)}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      />
      <div
        ref={horizontalThumbRef}
        className={`overlay-scrollbar-thumb overlay-scrollbar-thumb--horizontal${axes.horizontal && isVisible ? ' is-visible' : ''}`}
        onPointerDown={(event) => startDrag('horizontal', event)}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      />
    </>
  );
}

export default function OverlayScrollbarLayer() {
  const knownTargetsRef = useRef(new Map<HTMLElement, number>());
  const nextTargetIdRef = useRef(1);
  const [targets, setTargets] = useState<ScrollTargetEntry[]>([]);

  useEffect(() => {
    const knownTargets = knownTargetsRef.current;
    const pendingRoots = new Set<Node>();
    let scanFrame = 0;

    const getTargetEntries = () => Array.from(
      knownTargets,
      ([target, id]) => ({ id, target }),
    );

    const publishTargets = () => {
      let changed = false;
      for (const target of knownTargets.keys()) {
        if (target.isConnected) continue;
        target.removeAttribute('data-overlay-scrollbar');
        knownTargets.delete(target);
        changed = true;
      }
      if (changed) setTargets(getTargetEntries());
    };

    const registerTarget = (element: HTMLElement) => {
      if (element.closest('[data-overlay-scrollbar="off"]')) return;
      if (!hasScrollableAxis(getPotentialScrollAxes(element)) || knownTargets.has(element)) return;

      knownTargets.set(element, nextTargetIdRef.current++);
      element.setAttribute('data-overlay-scrollbar', 'managed');
      setTargets(getTargetEntries());
    };

    const scanNode = (node: Node) => {
      const candidates = new Set<HTMLElement>();
      const rootElement = node instanceof HTMLElement ? node : node.parentElement;
      if (rootElement) {
        candidates.add(rootElement);
        rootElement.querySelectorAll<HTMLElement>('*').forEach((element) => candidates.add(element));
        let ancestor = rootElement.parentElement;
        while (ancestor) {
          candidates.add(ancestor);
          ancestor = ancestor.parentElement;
        }
      }
      candidates.forEach(registerTarget);
    };

    const flushScans = () => {
      scanFrame = 0;
      pendingRoots.forEach(scanNode);
      pendingRoots.clear();
      publishTargets();
    };

    const scheduleScan = (node: Node) => {
      pendingRoots.add(node);
      if (!scanFrame) scanFrame = requestAnimationFrame(flushScans);
    };

    const handlePotentialScrollArea = (event: Event) => {
      if (event.target instanceof Node) scheduleScan(event.target);
    };
    const handleWindowResize = () => scheduleScan(document.documentElement);
    const handleScrollCapture = (event: Event) => {
      const target = event.target instanceof Document ? document.scrollingElement : event.target;
      if (target instanceof HTMLElement) registerTarget(target);
    };
    const mutationObserver = new MutationObserver((records) => {
      records.forEach((record) => scheduleScan(record.target));
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    document.addEventListener('scroll', handleScrollCapture, true);
    document.addEventListener('pointerover', handlePotentialScrollArea, true);
    document.addEventListener('focusin', handlePotentialScrollArea, true);
    document.addEventListener('input', handlePotentialScrollArea, true);
    document.addEventListener('load', handlePotentialScrollArea, true);
    document.addEventListener('transitionend', handlePotentialScrollArea, true);
    window.addEventListener('resize', handleWindowResize, { passive: true });
    scheduleScan(document.documentElement);

    return () => {
      mutationObserver.disconnect();
      document.removeEventListener('scroll', handleScrollCapture, true);
      document.removeEventListener('pointerover', handlePotentialScrollArea, true);
      document.removeEventListener('focusin', handlePotentialScrollArea, true);
      document.removeEventListener('input', handlePotentialScrollArea, true);
      document.removeEventListener('load', handlePotentialScrollArea, true);
      document.removeEventListener('transitionend', handlePotentialScrollArea, true);
      window.removeEventListener('resize', handleWindowResize);
      if (scanFrame) cancelAnimationFrame(scanFrame);
      knownTargets.forEach((_, target) => target.removeAttribute('data-overlay-scrollbar'));
      knownTargets.clear();
    };
  }, []);

  return createPortal(
    <div className="overlay-scrollbar-layer" aria-hidden="true">
      {targets.map(({ id, target }) => (
        <ScrollbarOverlay
          key={id}
          target={target}
        />
      ))}
    </div>,
    document.body,
  );
}
