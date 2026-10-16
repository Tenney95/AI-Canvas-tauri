import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useStoreApi } from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';
import { createCanvasEdgeModelSelector, createCanvasEdgeSnapshotReader } from '../../utils/canvasEdgeModels';
import type { CanvasEdgeLayerProps, CanvasSharedEdgeModel } from '../../types/canvasEdges';
import { CanvasEdgeVisual } from './SelectedNodeFlowEdge';
import { canUseCanvasEdgeStroke } from '../../utils/canvasEdgePath';
import CanvasEdgeStrokeLayer from './CanvasEdgeStrokeLayer';

type FlowStore = ReturnType<typeof useStoreApi>;
type EdgeCallbacks = Pick<CanvasEdgeLayerProps,
  'onEdgeClick' | 'onEdgeDoubleClick' | 'onEdgeContextMenu'
  | 'onEdgeMouseEnter' | 'onEdgeMouseMove' | 'onEdgeMouseLeave'>;

const EMPTY_NODE_IDS: ReadonlySet<string> = new Set();
// Bound viewport bitmap memory even when custom/SVG edges alternate frequently.
const MAX_CANVAS_STROKE_LAYERS = 2;

/** One observer per flow, limited to direct node-wrapper mounts/unmounts. */
function useMountedNodeIds(store: FlowStore) {
  const [ids, setIds] = useState(EMPTY_NODE_IDS);
  useLayoutEffect(() => {
    let container: Element | null = null;
    let root: Element | null = null;
    let frame: number | null = null;
    const refresh = () => {
      frame = null;
      const next = new Set<string>();
      for (const child of container?.children ?? []) {
        const id = child.getAttribute('data-id');
        if (id && child.classList.contains('react-flow__node')) next.add(id);
      }
      setIds((previous) => previous.size === next.size && [...next].every((id) => previous.has(id))
        ? previous : next);
    };
    const observer = new MutationObserver(() => {
      if (frame === null) frame = requestAnimationFrame(refresh);
    });
    const attach = () => {
      const nextRoot = store.getState().domNode;
      if (root === nextRoot && container) return;
      root = nextRoot;
      const next = root?.querySelector('.react-flow__nodes') ?? null;
      if (next === container) return;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      container = next;
      if (container) observer.observe(container, { childList: true });
      refresh();
    };
    const unsubscribe = store.subscribe(attach);
    attach();
    return () => {
      unsubscribe();
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [store]);
  return ids;
}

function deleteCanvasEdge(id: string) {
  useAppStore.getState().onEdgesChange([{ type: 'remove', id }]);
}

const SharedEdge = memo(function SharedEdge({
  model,
  store,
  rfId,
  noPanClassName,
  disableKeyboardA11y,
  performanceMode,
  callbacks,
  baseStroke = true,
}: {
  model: CanvasSharedEdgeModel;
  store: FlowStore;
  rfId: string;
  noPanClassName: string;
  disableKeyboardA11y?: boolean;
  performanceMode: boolean;
  callbacks: EdgeCallbacks;
  baseStroke?: boolean;
}) {
  const groupRef = useRef<SVGGElement>(null);
  const previouslySelected = useRef(model.edge.selected);
  const { edge, selectable, focusable } = model;
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (previouslySelected.current && !edge.selected && group && group.ownerDocument.activeElement === group) group.blur();
    previouslySelected.current = edge.selected;
  }, [edge.selected]);

  const handleClick = (event: MouseEvent<SVGGElement>) => {
    const state = store.getState();
    // Always read the live edge: selection can change between rendering and input.
    const liveEdge = state.edgeLookup.get(edge.id);
    if (!liveEdge) return;
    if (selectable) {
      store.setState({ nodesSelectionActive: false });
      if (liveEdge.selected && state.multiSelectionActive) {
        state.unselectNodesAndEdges({ nodes: [], edges: [liveEdge] });
        groupRef.current?.blur();
      } else state.addSelectedEdges([edge.id]);
    }
    callbacks.onEdgeClick?.(event, edge);
  };
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (disableKeyboardA11y || !selectable || !['Enter', ' ', 'Escape'].includes(event.key)) return;
    const state = store.getState();
    const liveEdge = state.edgeLookup.get(edge.id);
    if (!liveEdge) return;
    if (event.key === 'Escape') {
      groupRef.current?.blur();
      state.unselectNodesAndEdges({ edges: [liveEdge] });
    } else state.addSelectedEdges([edge.id]);
  };

  return (
    <g
      ref={groupRef}
      className={[
        'react-flow__edge', `react-flow__edge-${edge.type || 'default'}`, edge.className,
        noPanClassName, edge.selected && 'selected', edge.animated && 'animated',
        selectable && 'selectable', !selectable && !callbacks.onEdgeClick && 'inactive',
      ].filter(Boolean).join(' ')}
      data-id={edge.id}
      data-testid={`rf__edge-${edge.id}`}
      data-canvas-central-edge-id={edge.id}
      role={edge.ariaRole ?? (focusable ? 'group' : 'img')}
      aria-roledescription="edge"
      aria-label={edge.ariaLabel === null ? undefined : edge.ariaLabel || `Edge from ${edge.source} to ${edge.target}`}
      aria-describedby={focusable ? `react-flow__edge-desc-${rfId}` : undefined}
      tabIndex={focusable ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={focusable ? handleKeyDown : undefined}
      onDoubleClick={callbacks.onEdgeDoubleClick ? (event) => callbacks.onEdgeDoubleClick?.(event, { ...edge }) : undefined}
      onContextMenu={callbacks.onEdgeContextMenu ? (event) => callbacks.onEdgeContextMenu?.(event, { ...edge }) : undefined}
      onMouseEnter={callbacks.onEdgeMouseEnter ? (event) => callbacks.onEdgeMouseEnter?.(event, { ...edge }) : undefined}
      onMouseMove={callbacks.onEdgeMouseMove ? (event) => callbacks.onEdgeMouseMove?.(event, { ...edge }) : undefined}
      onMouseLeave={callbacks.onEdgeMouseLeave ? (event) => callbacks.onEdgeMouseLeave?.(event, { ...edge }) : undefined}
    >
      <CanvasEdgeVisual {...model.props} path={model.path} baseStroke={baseStroke}
        interactive={model.interactive} performanceMode={performanceMode} onDelete={deleteCanvasEdge} />
    </g>
  );
});

/** Ordinary edges have one Flow subscription instead of one wrapper per edge. */
export default function CanvasEdgeLayer({
  edgeIds, geometry, rfId, renderEdge, noPanClassName, disableKeyboardA11y,
  onEdgeClick, onEdgeDoubleClick, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave,
}: CanvasEdgeLayerProps) {
  const store = useStoreApi();
  const [canvasStroke, setCanvasStroke] = useState(() => {
    if (typeof Path2D === 'undefined' || typeof DOMMatrixReadOnly === 'undefined') return false;
    // Session-independent diagnostic fallback; does not change graph data or line type.
    try { return localStorage.getItem('canvas-edgeStrokeRenderer') !== 'svg'; } catch { return true; }
  });
  const handleCanvasUnavailable = useCallback(() => setCanvasStroke(false), []);
  const performanceMode = useAppStore((state) => state.config.performanceMode === true);
  const mountedNodeIds = useMountedNodeIds(store);
  const selectModels = useMemo(() => createCanvasEdgeModelSelector(), []);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = useMemo(() => createCanvasEdgeSnapshotReader(
    store.getState, selectModels, edgeIds, geometry, rfId, mountedNodeIds,
  ), [store, selectModels, edgeIds, geometry, rfId, mountedNodeIds]);
  const models = useSyncExternalStore(subscribe, snapshot, snapshot);
  const callbacks = useMemo(() => ({
    onEdgeClick, onEdgeDoubleClick, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave,
  }), [onEdgeClick, onEdgeDoubleClick, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave]);

  // Consecutive runs preserve paint order across native fallbacks and z-layers.
  const layers: ReactNode[] = [];
  let run: ReactNode[] = [];
  let runModels: CanvasSharedEdgeModel[] = [];
  let runCanvas = false;
  let runZ: number | undefined;
  let runKey = '';
  let canvasRuns = 0;
  const flush = () => {
    if (!run.length) return;
    const svg = (
      <svg key={runKey} className="canvas-shared-edge-layer" data-canvas-shared-edge-layer="central"
        data-canvas-edge-stroke-renderer={runCanvas ? 'canvas' : 'svg'} data-canvas-edge-count={run.length}
        style={{ zIndex: runZ }}>
        {run}
      </svg>
    );
    layers.push(runCanvas ? <Fragment key={runKey}>
      <CanvasEdgeStrokeLayer models={runModels} store={store} zIndex={runZ ?? 0} onUnavailable={handleCanvasUnavailable} />
      {svg}
    </Fragment> : svg);
    run = [];
    runModels = [];
  };
  for (const model of models) {
    if (model.kind === 'native') {
      flush();
      layers.push(<Fragment key={`native-${model.id}`}>{renderEdge(model.id)}</Fragment>);
      continue;
    }
    const useCanvas: boolean = canvasStroke && canUseCanvasEdgeStroke(model)
      && (canvasRuns < MAX_CANVAS_STROKE_LAYERS || (run.length > 0 && runCanvas && runZ === model.zIndex));
    if (run.length && (runZ !== model.zIndex || runCanvas !== useCanvas)) flush();
    // Keep the SVG identity when its first visible edge leaves the viewport.
    if (!run.length) {
      runZ = model.zIndex; runCanvas = useCanvas; runKey = `shared-${model.zIndex}-${layers.length}`;
      if (useCanvas) canvasRuns++;
    }
    runModels.push(model);
    run.push(<SharedEdge key={model.edge.id} model={model} store={store} rfId={rfId}
      noPanClassName={noPanClassName} disableKeyboardA11y={disableKeyboardA11y}
      performanceMode={performanceMode} callbacks={callbacks} baseStroke={!useCanvas} />);
  }
  flush();
  return <>{layers}</>;
}
