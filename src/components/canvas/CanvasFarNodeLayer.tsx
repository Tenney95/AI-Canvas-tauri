import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useStore, useStoreApi, type Node, type ReactFlowState, type Rect } from '@xyflow/react';
import { CanvasNodeLodContext, CanvasNodeLodInteractiveContext } from '../../hooks/useCanvasNodeLod';
import { useReferencedImageRevisions, withPreviewRevision } from '../../hooks/useReferencedImageWatcher';
import { useT } from '../../i18n';
import type { CanvasNodeLodRuntime } from '../../services/canvasNodeLodRuntime';
import {
  CANVAS_NEAR_MEDIA_MAX_ZOOM, readCanvasFarNodeMode, subscribeCanvasFarNodeMode, type CanvasFarNodeMode,
} from '../../services/canvasFarNodeMode';
import { useAppStore } from '../../store/useAppStore';
import { isAssetNodeConnectionDragging, subscribeAssetNodeConnectionDrag } from '../../utils/assetNodeConnection';
import { needsNativeCanvasEdge } from '../../utils/canvasEdgeModels';
import { CANVAS_NODE_Z_INDEX } from '../../utils/canvasElementLayering';
import CanvasFarNodeBitmap, { type CanvasFarNodeCard } from './CanvasFarNodeBitmap';
import { CANVAS_MEDIA_TITLE_HEIGHT } from './canvasNearMediaStyle';

interface Props {
  nodeIds: string[];
  renderNode(id: string): ReactNode;
  geometry: {
    getViewportRevision(state: ReactFlowState): object;
    getNodeDimensions(node: Node): Pick<Rect, 'width' | 'height'>;
    nodeHasDimensions(node: Node): boolean;
  };
}

const MEDIA_TYPES = new Set(['ai-image', 'source-image', 'ai-video', 'source-video']);
const EMPTY_NODE_IDS: ReadonlySet<string> = new Set();
const CONTACT_CLICK_GRACE_MS = 400;
type HitCard = CanvasFarNodeCard & { handles: readonly Rect[] };
type HitPoint = Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>;

function previewKey(source: string, image: boolean) {
  return `${image ? 'image' : 'video'}:${source}`;
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function isFarPaneTarget(surface: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Element && surface.contains(target) && !!target.closest('.react-flow__pane')
    && !target.closest('.react-flow__node, .react-flow__panel');
}

/** Resolve the same wrapper or port the pointer would have reached in the DOM. */
function findTarget(cards: readonly HitCard[], surface: HTMLElement, viewport: HTMLElement, event: HitPoint) {
  if (!cards.length || !isFarPaneTarget(surface, event.target)) return;
  // Hit-test against the same committed transform used by the bitmap.
  const { a: zoom, e: tx, f: ty } = new DOMMatrixReadOnly(viewport.style.transform || undefined);
  const bounds = surface.getBoundingClientRect();
  const x = (event.clientX - bounds.left - tx) / zoom;
  const y = (event.clientY - bounds.top - ty) / zoom;
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    const dx = x - card.x;
    const dy = y - card.y;
    const top = card.detail?.title ? -CANVAS_MEDIA_TITLE_HEIGHT : 0;
    const inside = dx >= 0 && dx <= card.width && dy >= top && dy <= card.height;
    const atHandle = card.handles.some((handle) => dx >= handle.x && dy >= handle.y
      && dx <= handle.x + handle.width && dy <= handle.y + handle.height);
    if (inside || atHandle) return card;
  }
}

function CanvasFarNodeContent({ nodeIds, renderNode, geometry, runtime }: Props & { runtime: CanvasNodeLodRuntime }) {
  const t = useT();
  const store = useStoreApi();
  const surface = useStore((state) => state.domNode);
  const connectionInProgress = useStore((state) => state.connection.inProgress);
  const clickConnectionSource = useStore((state) => state.connectionClickStartHandle?.nodeId);
  const assetConnectionInProgress = useSyncExternalStore(
    subscribeAssetNodeConnectionDrag, isAssetNodeConnectionDragging, () => false,
  );
  const flowRevision = useStore(geometry.getViewportRevision);
  const lodRevision = useSyncExternalStore(runtime.subscribeRepresentation, runtime.getRepresentationRevision);
  const mode = useSyncExternalStore(subscribeCanvasFarNodeMode, readCanvasFarNodeMode, (): CanvasFarNodeMode => 'dom');
  const enabled = mode !== 'dom';
  const near = mode === 'near';
  const withinNearRange = useStore((state) => near && state.transform[2] <= CANVAS_NEAR_MEDIA_MAX_ZOOM);
  const labelsVisible = useAppStore((state) => near && state.config.nodeLabelVisible !== false);
  const nodes = useAppStore((state) => state.nodes);
  const edges = useAppStore((state) => state.edges);
  const selected = useAppStore((state) => state.selectedNodeIds);
  const activeId = useAppStore((state) => state.activeNodeId);
  const projectId = useAppStore((state) => state.currentProjectId);
  const nodeGesturesEnabled = useStore((state) => state.nodesDraggable && state.elementsSelectable);
  const [nativeOnly, setNativeOnly] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [focusedId, setFocusedId] = useState<string>();
  const [hoverId, setHoverId] = useState<string>();
  const [contactId, setContactId] = useState<string>();
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const onUnavailable = useCallback(() => setNativeOnly(true), []);
  const onPreviewError = useCallback((source: string, image: boolean) => {
    const key = previewKey(source, image);
    setFailed((set) => set.has(key) ? set : new Set([...set, key]));
  }, []);
  const resolveRevision = useReferencedImageRevisions(useMemo(() => nodes.map((node) => node.data.filePath), [nodes]));
  const { models, fallbackReason } = useMemo((): { models: HitCard[]; fallbackReason: string | null } => {
    if (mode === 'dom') return { models: [], fallbackReason: 'requested-dom' };
    if (!surface || !projectId) return { models: [], fallbackReason: 'canvas-not-ready' };
    if (nativeOnly) return { models: [], fallbackReason: 'bitmap-unavailable' };
    const far = runtime.isFar();
    if (!far && !withinNearRange) return { models: [], fallbackReason: 'near-zoom' };
    if (keyboard) return { models: [], fallbackReason: 'keyboard-focus' };
    if (connectionInProgress || assetConnectionInProgress) {
      return { models: [], fallbackReason: 'connection-drag' };
    }
    if (!nodeGesturesEnabled) return { models: [], fallbackReason: 'node-gestures-disabled' };
    // Rebuild on authoritative geometry/pin updates. A pure camera publish reuses both revisions.
    const pinned = runtime.getRepresentationRevision() === lodRevision;
    const state = store.getState();
    if (!pinned || geometry.getViewportRevision(state) !== flowRevision) {
      return { models: [], fallbackReason: 'geometry-sync' };
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const nativeEndpoints = new Set<string>();
    // In click-to-connect, keep the source port live and restore the destination on hit.
    if (clickConnectionSource) nativeEndpoints.add(clickConnectionSource);
    for (const edge of edges) {
      if (mode === 'unlinked' || needsNativeCanvasEdge(edge)) {
        nativeEndpoints.add(edge.source);
        nativeEndpoints.add(edge.target);
      }
    }
    const selectedIds = new Set(selected);
    const cards: HitCard[] = [];
    const native: Rect[] = [];
    for (const [id, internal] of state.nodeLookup) {
      const node = byId.get(id);
      if (internal.hidden) continue;
      const { x, y } = internal.internals.positionAbsolute;
      const { width, height } = geometry.getNodeDimensions(internal);
      if (width <= 0 || height <= 0 || ![x, y, width, height].every(Number.isFinite)) continue;
      const rect = withinNearRange && !far && labelsVisible
        ? { x, y: y - CANVAS_MEDIA_TITLE_HEIGHT, width, height: height + CANVAS_MEDIA_TITLE_HEIGHT }
        : { x, y, width, height };
      const data = node?.data;
      const bounds = internal.internals.handleBounds;
      const video = node?.type?.endsWith('video') === true;
      if (!node || !data || !MEDIA_TYPES.has(node.type ?? '') || node.parentId || state.parentLookup.has(id)
        || internal.internals.z !== CANVAS_NODE_Z_INDEX || node.dragHandle || node.className || node.domAttributes || node.style
        || selectedIds.has(id) || activeId === id || node.selected || internal.selected || internal.dragging || runtime.isPinned(id)
        || nativeEndpoints.has(id) || !bounds || !geometry.nodeHasDimensions(internal)
        || data.nodeWidth !== width || data.nodeHeight !== height || data.mattingMask || data.annotation || data.annotationLayer
        || data.status === 'loading' || data.status === 'error' || data.error
        || (withinNearRange && !far && video && (data.mediaTaskState || data.videoTaskState === 'paused'))) {
        if (internal.internals.z === CANVAS_NODE_Z_INDEX) native.push(rect);
        continue;
      }
      const imageSource = video
        ? (data.thumbnailUrl !== data.videoUrl && data.thumbnailUrl !== data.sourceUrl ? data.thumbnailUrl : undefined)
        : data.imageUrl || data.thumbnailUrl;
      const source = imageSource ? withPreviewRevision(imageSource, resolveRevision(data.filePath)) : video ? data.videoUrl : undefined;
      if (!source || failed.has(previewKey(source, !!imageSource))) {
        native.push(rect);
        continue;
      }
      const detail = withinNearRange && !far ? {
        video,
        title: labelsVisible ? data.displayLabel || data.fileName || data.label || t(video ? '粘贴视频' : '粘贴图像') : '',
        displayId: data.displayId,
      } : undefined;
      cards.push({ id, x, y, width, height, source, image: !!imageSource, detail,
        handles: [...(bounds.source ?? []), ...(bounds.target ?? [])] });
    }
    // A shared layer is below native nodes at equal z. Keep ambiguous overlaps native.
    const models = cards.filter((card) => {
      const rect = card.detail?.title ? {
        ...card, y: card.y - CANVAS_MEDIA_TITLE_HEIGHT, height: card.height + CANVAS_MEDIA_TITLE_HEIGHT,
      } : card;
      return !native.some((other) => intersects(rect, other));
    });
    return { models, fallbackReason: models.length ? null : 'no-eligible-cards' };
  }, [activeId, assetConnectionInProgress, clickConnectionSource, connectionInProgress, edges, failed, flowRevision,
    geometry, keyboard, labelsVisible, lodRevision, mode, nativeOnly, nodeGesturesEnabled, nodes, projectId,
    resolveRevision, runtime, selected, store, surface, t, withinNearRange]);

  const input = useRef({ models, hoverId, contactId, keyboard });
  useLayoutEffect(() => { input.current = { models, hoverId, contactId, keyboard }; }, [models, hoverId, contactId, keyboard]);
  useLayoutEffect(() => {
    if (!surface || !projectId || !enabled || nativeOnly) return;
    const view = surface.ownerDocument.defaultView;
    const viewport = surface.querySelector<HTMLElement>('.react-flow__viewport');
    if (!view || !viewport) return;
    const captured = new WeakSet<Event>();
    let contactPointerId: number | undefined;
    let nearHandleMousePointer: number | undefined;
    let suppressHandleDragClick = false;
    let touchRoute: { touch: Touch; target: Element; wrapper: Element } | undefined;
    let contactTimer: number | undefined;
    let focusFrame: number | undefined;
    const cancelContactTimer = () => {
      if (contactTimer !== undefined) view.clearTimeout(contactTimer);
      contactTimer = undefined;
    };
    const releaseContact = (cancelled: boolean) => {
      cancelContactTimer();
      if (cancelled) setContactId(undefined);
      else {
        // Keep the wrapper until the browser has delivered the compatibility click.
        contactTimer = view.setTimeout(() => {
          contactTimer = undefined;
          setContactId(undefined);
        }, CONTACT_CLICK_GRACE_MS);
      }
    };
    const cancelFocusCheck = () => {
      if (focusFrame !== undefined) view.cancelAnimationFrame(focusFrame);
      focusFrame = undefined;
    };
    const checkKeyboardFocus = () => {
      cancelFocusCheck();
      focusFrame = view.requestAnimationFrame(() => {
        focusFrame = undefined;
        setKeyboard(surface.contains(surface.ownerDocument.activeElement));
      });
    };
    const getMountedNodeId = (target: EventTarget | null) => {
      const node = target instanceof Element ? target.closest('.react-flow__node') : null;
      return node && surface.contains(node) ? node.getAttribute('data-id') ?? undefined : undefined;
    };
    const elementAt = (point: HitPoint) => view.document.elementFromPoint(point.clientX, point.clientY);
    const restoredTarget = (point: HitPoint, id: string | undefined) => {
      if (!id || !isFarPaneTarget(surface, point.target)) return;
      const target = elementAt(point);
      if (getMountedNodeId(target) === id) return target;
    };
    const contactTarget = (point: HitPoint) => restoredTarget(point, input.current.contactId);
    const restoreCard = (point: HitPoint, contact: boolean) => {
      const hit = findTarget(input.current.models, surface, viewport, point);
      if (!hit) return;
      if (contact) {
        cancelContactTimer();
        if (input.current.contactId !== hit.id) flushSync(() => setContactId(hit.id));
      } else if (input.current.hoverId !== hit.id) {
        flushSync(() => setHoverId(hit.id));
      }
      const target = elementAt(point);
      if (getMountedNodeId(target) === hit.id) return target;
    };
    const dispatchReplay = (target: Element, replay: Event) => {
      captured.add(replay);
      target.dispatchEvent(replay);
    };
    const forward = (event: Event, replay: Event, target: Element) => {
      event.stopImmediatePropagation();
      dispatchReplay(target, replay);
      if (replay.defaultPrevented && event.cancelable) event.preventDefault();
    };
    const leaveKeyboardMode = (event: Event) => {
      cancelFocusCheck();
      if (!input.current.keyboard) return false;
      // Keep the existing wrapper under the pointer through the mouse gesture.
      setHoverId(getMountedNodeId(event.target));
      setKeyboard(false);
      return true;
    };
    const hover = (event: PointerEvent | DragEvent) => {
      if ('pointerType' in event && (event.pointerType !== 'mouse' || event.buttons !== 0)) return;
      if (leaveKeyboardMode(event)) return;
      const current = input.current;
      const mountedId = getMountedNodeId(event.target);
      if (mountedId && mountedId === current.hoverId) return;
      const next = findTarget(current.models, surface, viewport, event)?.id;
      if (next !== current.hoverId) setHoverId(next);
    };
    const restoreTarget = (event: MouseEvent) => {
      if (captured.has(event)) return;
      const pointer = event instanceof PointerEvent ? event : undefined;
      const press = pointer?.type === 'pointerdown';
      const direct = pointer?.pointerType === 'touch' || pointer?.pointerType === 'pen';
      if (press && pointer) {
        nearHandleMousePointer = undefined;
        suppressHandleDragClick = false;
        if (direct && !pointer.isPrimary) return;
      }
      if (suppressHandleDragClick && event.type === 'click' && event.isTrusted && event.detail > 0) {
        suppressHandleDragClick = false;
        if (event.target instanceof Element && surface.contains(event.target)) {
          event.stopImmediatePropagation();
          event.preventDefault();
          return;
        }
      }
      const useOriginalTarget = press && pointer.isTrusted && event.target instanceof Element
        && surface.contains(event.target) && leaveKeyboardMode(event);
      const target = useOriginalTarget ? undefined : press
        ? restoreCard(event, direct)
        : contactTarget(event) ?? (direct ? undefined
          : (near ? restoredTarget(event, input.current.hoverId) : undefined) ?? restoreCard(event, false));
      const pressTarget = target ?? event.target;
      if (near && press && pointer?.isTrusted && pointer.pointerType === 'mouse'
        && pressTarget instanceof Element && surface.contains(pressTarget) && pressTarget.closest('.react-flow__handle')) {
        nearHandleMousePointer = pointer.pointerId;
      }
      if (!target) return;
      if (press && direct) contactPointerId = pointer?.pointerId;
      // Route the first press to the restored wrapper before the pane can begin a selection.
      forward(event, pointer ? new PointerEvent(event.type, pointer) : new MouseEvent(event.type, event), target);
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (event.pointerId === nearHandleMousePointer) {
        nearHandleMousePointer = undefined;
        // React Flow still has the drag at pointerup. Its later mouseup completes the connection.
        // The browser's click following release must not start a new connection on the drop handle.
        suppressHandleDragClick = event.type === 'pointerup' && store.getState().connection.inProgress;
      }
      if (event.pointerId !== contactPointerId) return;
      contactPointerId = undefined;
      if (!touchRoute) releaseContact(event.type === 'pointercancel');
    };
    const replayTouch = (event: TouchEvent, changedTouches: Touch[], target: Element, include: (touch: Touch) => boolean) => {
      forward(event, new TouchEvent(event.type, {
        bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed,
        touches: Array.from(event.touches), targetTouches: Array.from(event.targetTouches).filter(include),
        changedTouches, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
        view: event.view, detail: event.detail,
      }), target);
    };
    const routeTouch = (event: TouchEvent) => {
      if (captured.has(event)) return;
      if (event.type === 'touchstart') {
        if (touchRoute || event.touches.length !== 1 || event.changedTouches.length !== 1) return;
        const touch = event.changedTouches[0];
        // WebView2 keeps the TouchEvent target from before the wrapper was mounted.
        const target = restoreCard(touch, true) ?? contactTarget(touch);
        const wrapper = target?.closest('.react-flow__node');
        if (!target || !wrapper) return;
        touchRoute = { touch, target, wrapper };
      }
      if (!touchRoute) return;
      const { touch: start, target, wrapper } = touchRoute;
      const isRouted = (touch: Touch) => touch.identifier === start.identifier;
      const changedTouches = Array.from(event.changedTouches);
      const touch = changedTouches.find(isRouted);
      if (!touch) return;
      const ended = event.type === 'touchend' || event.type === 'touchcancel';
      if (ended) touchRoute = undefined;
      else touchRoute.touch = touch;
      if (wrapper.isConnected) {
        // React Flow uses TouchEvents for connections; d3 listens for move/end on the original node.
        replayTouch(event, [touch], target.isConnected ? target : wrapper, isRouted);
        if (changedTouches.length > 1 && event.target instanceof Element) {
          const isOther = (contact: Touch) => !isRouted(contact);
          replayTouch(event, changedTouches.filter(isOther), event.target, isOther);
        }
      }
      if (ended) releaseContact(event.type === 'touchcancel');
    };
    const onBlur = () => {
      const route = touchRoute;
      contactPointerId = undefined;
      nearHandleMousePointer = undefined;
      suppressHandleDragClick = false;
      touchRoute = undefined;
      if (route?.wrapper.isConnected) {
        dispatchReplay(route.target.isConnected ? route.target : route.wrapper, new TouchEvent('touchcancel', {
          bubbles: true, composed: true, changedTouches: [route.touch],
        }));
      }
      releaseContact(true);
    };
    const leave = (event: PointerEvent) => { if (event.buttons === 0) setHoverId(undefined); };
    const onWheel = (event: WheelEvent) => {
      if (event.isTrusted && event.target instanceof Element && event.target.closest('.react-flow__pane')) {
        leaveKeyboardMode(event);
      }
    };
    const onFocusIn = (event: FocusEvent) => setFocusedId(getMountedNodeId(event.target));
    const onFocusOut = (event: FocusEvent) => {
      setFocusedId(getMountedNodeId(event.relatedTarget));
      if (input.current.keyboard) checkKeyboardFocus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      // Make the nodes tabbable before the browser chooses where to move focus.
      if (input.current.models.length) flushSync(() => setKeyboard(true));
      checkKeyboardFocus();
    };
    const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu'] as const;
    const touchEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
    // Capture above the React root so the original pointerdown cannot start a pane selection.
    for (const type of events) view.addEventListener(type, restoreTarget, true);
    if (typeof TouchEvent === 'function') {
      for (const type of touchEvents) view.addEventListener(type, routeTouch, { capture: true, passive: false });
    }
    view.addEventListener('pointerup', onPointerEnd, true);
    view.addEventListener('pointercancel', onPointerEnd, true);
    view.addEventListener('blur', onBlur);
    surface.addEventListener('pointermove', hover, true);
    surface.addEventListener('dragover', hover, true);
    surface.addEventListener('pointerleave', leave);
    surface.addEventListener('wheel', onWheel, { capture: true, passive: true });
    surface.addEventListener('focusin', onFocusIn);
    surface.addEventListener('focusout', onFocusOut);
    view.addEventListener('keydown', onKey, true);
    setFocusedId(getMountedNodeId(surface.ownerDocument.activeElement));
    if (input.current.keyboard) checkKeyboardFocus();
    return () => {
      cancelFocusCheck();
      cancelContactTimer();
      setContactId(undefined);
      for (const type of events) view.removeEventListener(type, restoreTarget, true);
      for (const type of touchEvents) view.removeEventListener(type, routeTouch, true);
      view.removeEventListener('pointerup', onPointerEnd, true);
      view.removeEventListener('pointercancel', onPointerEnd, true);
      view.removeEventListener('blur', onBlur);
      surface.removeEventListener('pointermove', hover, true);
      surface.removeEventListener('dragover', hover, true);
      surface.removeEventListener('pointerleave', leave);
      surface.removeEventListener('wheel', onWheel, true);
      surface.removeEventListener('focusin', onFocusIn);
      surface.removeEventListener('focusout', onFocusOut);
      view.removeEventListener('keydown', onKey, true);
    };
  }, [enabled, nativeOnly, near, projectId, store, surface]);

  // Mouse zoom can resume the bitmap while a node still holds keyboard focus.
  const staticCards = useMemo(() => models.filter((card) => card.id !== hoverId && card.id !== focusedId && card.id !== contactId),
    [models, hoverId, focusedId, contactId]);
  const hasStaticCards = staticCards.length > 0;
  useLayoutEffect(() => {
    if (!surface || hasStaticCards) return;
    surface.setAttribute('data-canvas-far-fallback-reason', fallbackReason ?? 'interactive-card');
    return () => surface.removeAttribute('data-canvas-far-fallback-reason');
  }, [fallbackReason, hasStaticCards, surface]);
  const staticIds = useMemo(() => new Set(staticCards.map((card) => card.id)), [staticCards]);
  const visibleFarIds = useMemo(() => staticIds.size
    ? new Set(nodeIds.filter((id) => staticIds.has(id))) : EMPTY_NODE_IDS, [nodeIds, staticIds]);
  useLayoutEffect(() => {
    runtime.setVisibleFarNodeIds(visibleFarIds);
  }, [runtime, visibleFarIds]);
  useLayoutEffect(() => () => runtime.setVisibleFarNodeIds(EMPTY_NODE_IDS), [runtime]);
  return <>
    {staticCards.length > 0 && projectId && <CanvasFarNodeBitmap cards={staticCards} store={store} projectId={projectId}
      runtime={runtime} near={near} webGpuRequested={import.meta.env.DEV && mode === 'webgpu'}
      onUnavailable={onUnavailable} onPreviewError={onPreviewError} />}
    {nodeIds.map((id) => staticIds.has(id) ? null : near
      ? <CanvasNodeLodInteractiveContext.Provider key={id} value={id === hoverId || id === contactId || id === focusedId}>
        {renderNode(id)}
      </CanvasNodeLodInteractiveContext.Provider>
      : renderNode(id))}
  </>;
}

export default function CanvasFarNodeLayer(props: Props) {
  const runtime = useContext(CanvasNodeLodContext);
  return runtime ? <CanvasFarNodeContent {...props} runtime={runtime} /> : props.nodeIds.map(props.renderNode);
}
