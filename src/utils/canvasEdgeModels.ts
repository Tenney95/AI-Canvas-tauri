import type { Edge, EdgeProps, InternalNode, ReactFlowState } from '@xyflow/react';
import type {
  CanvasEdgeGeometry,
  CanvasEdgeModel,
  CanvasEdgePosition,
  CanvasEdgePath,
} from '../types/canvasEdges';
import { getCanvasEdgePath } from './canvasEdgePath';

type Values = readonly unknown[];

interface NodeSnapshot {
  geometry: Values;
  elevation: Values;
}

interface EdgeSnapshot {
  positionInputs?: Values;
  position?: CanvasEdgePosition | null;
  elevationInputs?: Values;
  zIndex?: number;
  pathInputs?: Values;
  path?: CanvasEdgePath;
  modelInputs?: Values;
  model: CanvasEdgeModel | null;
}

function sameValues(previous: Values | undefined, next: Values) {
  return previous !== undefined && previous.length === next.length
    && previous.every((value, index) => Object.is(value, next[index]));
}

/** Copy scalar fields so a later in-place mutation cannot change the snapshot. */
function objectValues(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [value];
  const entries = Object.entries(value);
  return [entries.length, ...entries.flatMap(([key, entry]) => [key, entry])];
}

function handleValues(handles: InternalNode['handles'] | null | undefined): unknown[] {
  const values: unknown[] = [handles?.length ?? handles];
  for (const handle of handles ?? []) {
    values.push(handle.id, handle.type, handle.position, handle.x, handle.y,
      handle.width, handle.height, 'nodeId' in handle ? handle.nodeId : undefined);
  }
  return values;
}

function nodeSnapshot(node: InternalNode, previous?: NodeSnapshot): NodeSnapshot {
  const bounds = node.internals.handleBounds;
  const geometry = [
    node.internals.positionAbsolute.x, node.internals.positionAbsolute.y,
    node.measured.width, node.measured.height, node.width, node.height,
    node.initialWidth, node.initialHeight, node.sourcePosition, node.targetPosition,
    node.hidden, !!bounds,
    ...handleValues(bounds?.source), ...handleValues(bounds?.target),
    ...handleValues(node.handles),
  ];
  const elevation = [node.selected, node.internals.z, node.parentId];
  const sameGeometry = sameValues(previous?.geometry, geometry);
  const sameElevation = sameValues(previous?.elevation, elevation);
  if (sameGeometry && sameElevation) return previous!;
  return {
    geometry: sameGeometry ? previous!.geometry : geometry,
    elevation: sameElevation ? previous!.elevation : elevation,
  };
}

function publicationValues(state: ReactFlowState): Values {
  const values: unknown[] = [];
  const record = state as unknown as Record<string, unknown>;
  for (const key of Object.keys(state)) {
    if (key !== 'transform') values.push(key, record[key]);
  }
  return values;
}

function edgeValues(edge: Edge): Values {
  return [
    ...objectValues(edge),
    ...objectValues(edge.style), ...objectValues(edge.data),
    ...objectValues(edge.markerStart), ...objectValues(edge.markerEnd),
    ...objectValues(edge.labelStyle), ...objectValues(edge.labelBgStyle),
    ...objectValues(edge.labelBgPadding),
    ...objectValues('pathOptions' in edge ? edge.pathOptions : undefined),
  ];
}

function needsNativeEdge(edge: Edge) {
  return (!!edge.type && !['default', 'smoothstep', 'selected-node-flow'].includes(edge.type))
    || (!!edge.domAttributes && Object.keys(edge.domAttributes).length > 0);
}

function positionNode(node: InternalNode): InternalNode {
  // React Flow fills missing fallback handle dimensions in place. Give that
  // helper copies rather than changing Store-owned handle objects.
  return !node.internals.handleBounds && node.handles
    ? { ...node, handles: node.handles.map((handle) => ({ ...handle })) }
    : node;
}

function edgeProps(
  edge: Edge,
  position: CanvasEdgePosition,
  selectable: boolean,
  geometry: CanvasEdgeGeometry,
  rfId: string,
): EdgeProps {
  return {
    ...position,
    id: edge.id, source: edge.source, target: edge.target, type: edge.type,
    selected: edge.selected, animated: edge.animated, data: edge.data, style: edge.style,
    selectable, deletable: edge.deletable ?? true,
    label: edge.label, labelStyle: edge.labelStyle, labelShowBg: edge.labelShowBg,
    labelBgStyle: edge.labelBgStyle, labelBgPadding: edge.labelBgPadding,
    labelBgBorderRadius: edge.labelBgBorderRadius,
    sourceHandleId: edge.sourceHandle, targetHandleId: edge.targetHandle,
    markerStart: edge.markerStart ? `url('#${geometry.getMarkerId(edge.markerStart, rfId)}')` : undefined,
    markerEnd: edge.markerEnd ? `url('#${geometry.getMarkerId(edge.markerEnd, rfId)}')` : undefined,
    pathOptions: 'pathOptions' in edge ? edge.pathOptions : undefined,
    interactionWidth: edge.interactionWidth,
  };
}

/** One cache belongs to one mounted React Flow. It never writes to its input. */
export function createCanvasEdgeModelSelector() {
  let nodes = new Map<string, NodeSnapshot>();
  let edges = new Map<string, EdgeSnapshot>();
  let models: readonly CanvasEdgeModel[] = [];
  let publication: {
    state: ReactFlowState;
    transform: ReactFlowState['transform'];
    fields: Values;
    edgeIds: readonly string[];
    geometry: CanvasEdgeGeometry;
    rfId: string;
    mountedNodeIds: ReadonlySet<string>;
  } | undefined;

  return (
    state: ReactFlowState,
    edgeIds: readonly string[],
    geometry: CanvasEdgeGeometry,
    rfId: string,
    mountedNodeIds: ReadonlySet<string>,
  ): readonly CanvasEdgeModel[] => {
    const nextNodes = new Map<string, NodeSnapshot>();
    let nodesChanged = nodes.size !== state.nodeLookup.size;
    for (const [id, node] of state.nodeLookup) {
      const previous = nodes.get(id);
      const next = nodeSnapshot(node, previous);
      if (next !== previous) nodesChanged = true;
      nextNodes.set(id, next);
    }
    nodes = nextNodes;
    const fields = publicationValues(state);
    const viewportOnly = !nodesChanged && publication !== undefined
      && state !== publication.state && state.transform !== publication.transform
      && edgeIds === publication.edgeIds && geometry === publication.geometry
      && rfId === publication.rfId && mountedNodeIds === publication.mountedNodeIds
      && sameValues(publication.fields, fields);
    const nextPublication = {
      state, transform: state.transform, fields, edgeIds, geometry, rfId, mountedNodeIds,
    };
    // Only immutable RF publications changing transform alone take this path.
    // Direct same-object callers still inspect edge values for in-place changes.
    if (viewportOnly) {
      publication = nextPublication;
      return models;
    }

    // Replacing the map bounds retained edge entries to the current visible IDs.
    const nextEdges = new Map<string, EdgeSnapshot>();
    const nextModels: CanvasEdgeModel[] = [];
    for (const id of edgeIds) {
      const original = state.edgeLookup.get(id);
      if (!original) continue;
      const edge: Edge = { ...state.defaultEdgeOptions, ...original };
      if (edge.hidden) continue;
      const previous = edges.get(id);
      if (needsNativeEdge(edge)) {
        const model = previous?.model?.kind === 'native' ? previous.model : { kind: 'native' as const, id };
        nextEdges.set(id, { model });
        nextModels.push(model);
        continue;
      }
      const sourceNode = state.nodeLookup.get(edge.source);
      const targetNode = state.nodeLookup.get(edge.target);
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      if (!sourceNode || !targetNode || !source || !target) continue;

      const positionInputs = [
        geometry.getEdgePosition, state.connectionMode, state.onError,
        edge.source, edge.target, edge.sourceHandle || null, edge.targetHandle || null,
        source.geometry, target.geometry,
      ];
      const position = sameValues(previous?.positionInputs, positionInputs)
        ? previous!.position!
        : geometry.getEdgePosition({
          id, sourceNode: positionNode(sourceNode), targetNode: positionNode(targetNode),
          sourceHandle: edge.sourceHandle || null, targetHandle: edge.targetHandle || null,
          connectionMode: state.connectionMode, onError: state.onError,
        });
      if (!position || position.sourceX == null || position.sourceY == null
        || position.targetX == null || position.targetY == null) {
        nextEdges.set(id, { positionInputs, position, model: null });
        continue;
      }
      const elevationInputs = [
        geometry.getElevatedEdgeZIndex, source.elevation, target.elevation,
        edge.selected, edge.zIndex, state.elevateEdgesOnSelect, state.zIndexMode,
      ];
      const zIndex = sameValues(previous?.elevationInputs, elevationInputs)
        ? previous!.zIndex!
        : geometry.getElevatedEdgeZIndex({
          sourceNode, targetNode, selected: edge.selected, zIndex: edge.zIndex,
          elevateOnSelect: state.elevateEdgesOnSelect, zIndexMode: state.zIndexMode,
        });
      const selectable = !!(edge.selectable || (state.elementsSelectable && edge.selectable === undefined));
      const focusable = !!(edge.focusable || (state.edgesFocusable && edge.focusable === undefined));
      const interactive = mountedNodeIds.has(edge.source) || mountedNodeIds.has(edge.target);
      const pathInputs = [position, edge.type, edge.data?.selectedNodeFlowBaseType];
      const path = sameValues(previous?.pathInputs, pathInputs)
        ? previous!.path! : getCanvasEdgePath({ ...position, type: edge.type, data: edge.data });
      const modelInputs = [
        ...edgeValues(edge), state.defaultEdgeOptions, position, zIndex,
        selectable, focusable, interactive, geometry.getMarkerId, rfId,
      ];
      const model = sameValues(previous?.modelInputs, modelInputs)
        ? previous!.model!
        : {
          kind: 'shared' as const, edge,
          props: edgeProps(edge, position, selectable, geometry, rfId),
          path, zIndex, selectable, focusable, interactive,
        };
      nextEdges.set(id, { positionInputs, position, elevationInputs, zIndex, pathInputs, path, modelInputs, model });
      nextModels.push(model);
    }
    edges = nextEdges;
    if (!sameValues(models, nextModels)) models = nextModels;
    publication = nextPublication;
    return models;
  };
}

/** Repeated React snapshot reads share one scan until the Store publishes. */
export function createCanvasEdgeSnapshotReader(
  getState: () => ReactFlowState,
  selectModels: ReturnType<typeof createCanvasEdgeModelSelector>,
  edgeIds: readonly string[],
  geometry: CanvasEdgeGeometry,
  rfId: string,
  mountedNodeIds: ReadonlySet<string>,
): () => readonly CanvasEdgeModel[] {
  let previousState: ReactFlowState | undefined;
  let models: readonly CanvasEdgeModel[] = [];
  return () => {
    const state = getState();
    if (state !== previousState) {
      models = selectModels(state, edgeIds, geometry, rfId, mountedNodeIds);
      previousState = state;
    }
    return models;
  };
}
