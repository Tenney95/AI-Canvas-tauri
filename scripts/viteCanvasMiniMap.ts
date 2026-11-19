/** Keep the locked React Flow MiniMap's viewport and gesture handling. */
export function adaptCanvasMiniMap(source: string, getViewportRevision: string): string {
  const selector = `const filterHidden = (node) => !node.hidden;
const selector$1 = (s) => {`;
  const bounds = 'getBoundsOfRects(getInternalNodesBounds(s.nodeLookup, { filter: filterHidden }), viewBB)';
  const nodeClassProp = "function MiniMapComponent({ style, className, nodeStrokeColor, nodeColor, nodeClassName = '', nodeBorderRadius = 5";
  const component = 'nodeComponent, bgColor, maskColor, maskStrokeColor, maskStrokeWidth, position =';
  const nodeClickProp = 'onClick, onNodeClick, pannable = false';
  const nativeNodeClick = `    const onSvgNodeClick = onNodeClick
        ? useCallback((event, nodeId) => {
            const node = store.getState().nodeLookup.get(nodeId).internals.userNode;
            onNodeClick(event, node);
        }, [])
        : undefined;
`;
  const svg = 'className: "react-flow__minimap-svg", role: "img"';
  const clickPointer = 'minimapInstance.current?.pointer(event) || [0, 0]';
  const nativeNodes = 'jsx(MiniMapNodes$1, { onClick: onSvgNodeClick, nodeColor: nodeColor, nodeStrokeColor: nodeStrokeColor, nodeBorderRadius: nodeBorderRadius, nodeClassName: nodeClassName, nodeStrokeWidth: nodeStrokeWidth, nodeComponent: nodeComponent })';
  for (const anchor of [selector, bounds, nodeClassProp, component, nodeClickProp, nativeNodeClick, svg, clickPointer, nativeNodes]) {
    const index = source.indexOf(anchor);
    if (index < 0 || source.indexOf(anchor, index + anchor.length) >= 0) {
      throw new Error('[ai-canvas-minimap] React Flow 小地图结构已变化，请重新审查适配点。');
    }
  }

  return source.replace(selector, `const filterHidden = (node) => !node.hidden;
const aiCanvasMiniMapBounds = new WeakMap();
function getAiCanvasMiniMapNodeBounds(state) {
    const revision = ${getViewportRevision}(state);
    let bounds = aiCanvasMiniMapBounds.get(revision);
    if (!bounds) {
        bounds = getInternalNodesBounds(state.nodeLookup, { filter: filterHidden });
        aiCanvasMiniMapBounds.set(revision, bounds);
    }
    return bounds;
}
const aiCanvasMiniMapGeometry = Object.freeze({ getNodeDimensions, nodeHasDimensions, getViewportRevision: ${getViewportRevision} });
const selector$1 = (s) => {`)
    .replace(bounds, 'getBoundsOfRects(getAiCanvasMiniMapNodeBounds(s), viewBB)')
    .replace(nodeClassProp, nodeClassProp.replace("nodeClassName = '', ", ''))
    .replace(component, component.replace('nodeComponent', 'canvasNodeLayer: CanvasNodeLayer'))
    .replace(nodeClickProp, 'onClick, pannable = false')
    .replace(nativeNodeClick, '')
    .replace(svg, 'className: "react-flow__minimap-svg", "data-minimap-renderer": "canvas2d", role: "img"')
    // D3 unwraps React's event, whose native currentTarget is the React root.
    .replace(clickPointer, 'minimapInstance.current?.pointer(event, svg.current) || [0, 0]')
    .replace(nativeNodes, 'CanvasNodeLayer ? jsx(CanvasNodeLayer, { geometry: aiCanvasMiniMapGeometry, width: elementWidth, height: elementHeight, nodeColor, nodeStrokeColor, nodeStrokeWidth, nodeBorderRadius }) : null');
}
