import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { isTauri } from '@tauri-apps/api/core';
import { useStore, useStoreApi, type Node, type ReactFlowState, type Rect } from '@xyflow/react';
import { CanvasNodeLodContext } from '../../hooks/useCanvasNodeLod';
import { useReferencedImageRevisions, withPreviewRevision } from '../../hooks/useReferencedImageWatcher';
import type { CanvasNodeLodRuntime } from '../../services/canvasNodeLodRuntime';
import {
  CANVAS_FAR_NODE_MODE_EVENT, CANVAS_FAR_NODE_MODE_KEY, canvasFarNodeRequiresNativeTouch,
  isCanvasFarNodeMouseOnly, setCanvasFarNodeMouseOnly,
} from '../../services/canvasFarNodeTestSession';
import { useAppStore } from '../../store/useAppStore';
import { isAssetNodeConnectionDragging, subscribeAssetNodeConnectionDrag } from '../../utils/assetNodeConnection';
import { needsNativeCanvasEdge } from '../../utils/canvasEdgeModels';
import { CANVAS_NODE_Z_INDEX } from '../../utils/canvasElementLayering';
import CanvasFarNodeBitmap, { type CanvasFarNodeCard } from './CanvasFarNodeBitmap';

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
type PrototypeMode = 'dom' | 'touch' | 'unlinked' | 'canvas' | 'webgpu';
type HitCard = CanvasFarNodeCard & { handles: readonly Rect[] };

function readPrototypeMode(): PrototypeMode {
  if (!import.meta.env.DEV || !isTauri()) return 'dom';
  if (canvasFarNodeRequiresNativeTouch()) return 'touch';
  try {
    const mode = sessionStorage.getItem(CANVAS_FAR_NODE_MODE_KEY);
    if (mode === 'dom' || mode === 'unlinked' || mode === 'webgpu') return mode;
  } catch { /* The development prototype still works without session storage. */ }
  return 'canvas';
}

function subscribePrototypeMode(listener: () => void) {
  window.addEventListener(CANVAS_FAR_NODE_MODE_EVENT, listener);
  return () => window.removeEventListener(CANVAS_FAR_NODE_MODE_EVENT, listener);
}

function previewKey(source: string, image: boolean) {
  return `${image ? 'image' : 'video'}:${source}`;
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Resolve the same wrapper or port the pointer would have reached in the DOM. */
function findTarget(cards: readonly HitCard[], surface: HTMLElement, viewport: HTMLElement, event: MouseEvent) {
  const target = event.target;
  if (!cards.length || !(target instanceof Element) || !surface.contains(target)
    || !target.closest('.react-flow__pane') || target.closest('.react-flow__node, .react-flow__panel')) return;
  // Hit-test against the same committed transform used by the bitmap.
  const { a: zoom, e: tx, f: ty } = new DOMMatrixReadOnly(viewport.style.transform || undefined);
  const bounds = surface.getBoundingClientRect();
  const x = (event.clientX - bounds.left - tx) / zoom;
  const y = (event.clientY - bounds.top - ty) / zoom;
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    const dx = x - card.x;
    const dy = y - card.y;
    const inside = dx >= 0 && dx <= card.width && dy >= 0 && dy <= card.height;
    const atHandle = card.handles.some((handle) => dx >= handle.x && dy >= handle.y
      && dx <= handle.x + handle.width && dy <= handle.y + handle.height);
    if (inside || atHandle) return card;
  }
}

function CanvasFarNodeContent({ nodeIds, renderNode, geometry, runtime }: Props & { runtime: CanvasNodeLodRuntime }) {
  const store = useStoreApi();
  const surface = useStore((state) => state.domNode);
  const connectionInProgress = useStore((state) => state.connection.inProgress);
  const clickConnectionSource = useStore((state) => state.connectionClickStartHandle?.nodeId);
  const assetConnectionInProgress = useSyncExternalStore(
    subscribeAssetNodeConnectionDrag, isAssetNodeConnectionDragging, () => false,
  );
  const flowRevision = useStore(geometry.getViewportRevision);
  const lodRevision = useSyncExternalStore(runtime.subscribeRepresentation, runtime.getRepresentationRevision);
  const mode = useSyncExternalStore(subscribePrototypeMode, readPrototypeMode, (): PrototypeMode => 'dom');
  const enabled = mode !== 'dom' && mode !== 'touch';
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
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const onUnavailable = useCallback(() => setNativeOnly(true), []);
  const onPreviewError = useCallback((source: string, image: boolean) => {
    const key = previewKey(source, image);
    setFailed((set) => set.has(key) ? set : new Set([...set, key]));
  }, []);
  const resolveRevision = useReferencedImageRevisions(useMemo(() => nodes.map((node) => node.data.filePath), [nodes]));
  const { models, fallbackReason } = useMemo((): { models: HitCard[]; fallbackReason: string | null } => {
    if (mode === 'touch') return { models: [], fallbackReason: 'touch' };
    if (mode === 'dom') return { models: [], fallbackReason: 'requested-dom' };
    if (!surface || !projectId) return { models: [], fallbackReason: 'canvas-not-ready' };
    if (nativeOnly) return { models: [], fallbackReason: 'bitmap-unavailable' };
    if (!runtime.isFar()) return { models: [], fallbackReason: 'near-zoom' };
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
    // In click-to-connect, keep the source port live and restore a target on mouse hit.
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
      const rect = { x, y, width, height };
      const data = node?.data;
      const bounds = internal.internals.handleBounds;
      if (!node || !data || !MEDIA_TYPES.has(node.type ?? '') || node.parentId || state.parentLookup.has(id)
        || internal.internals.z !== CANVAS_NODE_Z_INDEX || node.dragHandle || node.className || node.domAttributes || node.style
        || selectedIds.has(id) || activeId === id || node.selected || internal.selected || internal.dragging || runtime.isPinned(id)
        || nativeEndpoints.has(id) || !bounds || !geometry.nodeHasDimensions(internal)
        || data.nodeWidth !== width || data.nodeHeight !== height || data.mattingMask || data.annotation || data.annotationLayer
        || data.status === 'loading' || data.status === 'error' || data.error) {
        if (internal.internals.z === CANVAS_NODE_Z_INDEX) native.push(rect);
        continue;
      }
      const video = node.type?.endsWith('video');
      const imageSource = video
        ? (data.thumbnailUrl !== data.videoUrl && data.thumbnailUrl !== data.sourceUrl ? data.thumbnailUrl : undefined)
        : data.imageUrl || data.thumbnailUrl;
      const source = imageSource ? withPreviewRevision(imageSource, resolveRevision(data.filePath)) : video ? data.videoUrl : undefined;
      if (!source || failed.has(previewKey(source, !!imageSource))) {
        native.push(rect);
        continue;
      }
      cards.push({ id, ...rect, source, image: !!imageSource, handles: [...(bounds.source ?? []), ...(bounds.target ?? [])] });
    }
    // A shared layer is below native nodes at equal z. Keep ambiguous overlaps native.
    const models = cards.filter((card) => !native.some((rect) => intersects(card, rect)));
    return { models, fallbackReason: models.length ? null : 'no-eligible-cards' };
  }, [activeId, assetConnectionInProgress, clickConnectionSource, connectionInProgress, edges, failed, flowRevision,
    geometry, keyboard, lodRevision, mode, nativeOnly, nodeGesturesEnabled, nodes, projectId, resolveRevision,
    runtime, selected, store, surface]);

  const input = useRef({ models, hoverId, keyboard });
  useLayoutEffect(() => { input.current = { models, hoverId, keyboard }; }, [models, hoverId, keyboard]);
  useLayoutEffect(() => {
    const view = surface?.ownerDocument.defaultView;
    if (!surface || !view) return;
    const onPointerDown = (event: PointerEvent) => {
      // Disarm the override even if the renderer is already using DOM.
      if (isCanvasFarNodeMouseOnly() && event.pointerType && event.pointerType !== 'mouse'
        && event.target instanceof Element && surface.contains(event.target)) {
        flushSync(() => setCanvasFarNodeMouseOnly(false));
      }
    };
    view.addEventListener('pointerdown', onPointerDown, true);
    return () => view.removeEventListener('pointerdown', onPointerDown, true);
  }, [surface]);
  useLayoutEffect(() => {
    if (!surface || !projectId || !enabled || nativeOnly) return;
    const view = surface.ownerDocument.defaultView;
    const viewport = surface.querySelector<HTMLElement>('.react-flow__viewport');
    if (!view || !viewport) return;
    const captured = new WeakSet<Event>();
    let focusFrame: number | undefined;
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
      if (event instanceof PointerEvent && event.pointerType && event.pointerType !== 'mouse') return;
      if (event instanceof PointerEvent && event.type === 'pointerdown' && event.isTrusted && event.pointerType === 'mouse'
        && event.target instanceof Element && surface.contains(event.target) && leaveKeyboardMode(event)) return;
      const hit = findTarget(input.current.models, surface, viewport, event);
      if (!hit) return;
      if (input.current.hoverId !== hit.id) flushSync(() => setHoverId(hit.id));
      const target = view.document.elementFromPoint(event.clientX, event.clientY);
      if (target?.closest('.react-flow__node')?.getAttribute('data-id') !== hit.id) return;
      // Route the first press to the restored wrapper before the pane can begin a selection.
      const replay = event instanceof PointerEvent ? new PointerEvent(event.type, event) : new MouseEvent(event.type, event);
      captured.add(replay);
      event.stopImmediatePropagation();
      target.dispatchEvent(replay);
      if (replay.defaultPrevented) event.preventDefault();
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
    // Capture above the React root so the original pointerdown cannot start a pane selection.
    for (const type of events) view.addEventListener(type, restoreTarget, true);
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
      for (const type of events) view.removeEventListener(type, restoreTarget, true);
      surface.removeEventListener('pointermove', hover, true);
      surface.removeEventListener('dragover', hover, true);
      surface.removeEventListener('pointerleave', leave);
      surface.removeEventListener('wheel', onWheel, true);
      surface.removeEventListener('focusin', onFocusIn);
      surface.removeEventListener('focusout', onFocusOut);
      view.removeEventListener('keydown', onKey, true);
    };
  }, [enabled, nativeOnly, projectId, surface]);

  // Mouse zoom can resume the bitmap while a node still holds keyboard focus.
  const staticCards = useMemo(() => models.filter((card) => card.id !== hoverId && card.id !== focusedId),
    [models, hoverId, focusedId]);
  const hasStaticCards = staticCards.length > 0;
  useLayoutEffect(() => {
    if (!surface || hasStaticCards) return;
    surface.dataset.canvasFarFallbackReason = fallbackReason ?? 'interactive-card';
    return () => { delete surface.dataset.canvasFarFallbackReason; };
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
      runtime={runtime} webGpuRequested={mode === 'webgpu'} onUnavailable={onUnavailable} onPreviewError={onPreviewError} />}
    {nodeIds.map((id) => staticIds.has(id) ? null : renderNode(id))}
  </>;
}

export default function CanvasFarNodeLayer(props: Props) {
  const runtime = useContext(CanvasNodeLodContext);
  return runtime ? <CanvasFarNodeContent {...props} runtime={runtime} /> : props.nodeIds.map(props.renderNode);
}
