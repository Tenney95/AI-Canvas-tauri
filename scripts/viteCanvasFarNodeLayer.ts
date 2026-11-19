/** Keep React Flow in charge of native nodes while the canvas draws distant previews. */
export function adaptCanvasFarNodeLayer(source: string, getViewportRevision: string): string {
  const signature = 'function NodeRendererComponent(props) {';
  const endMarker = "\nNodeRendererComponent.displayName = 'NodeRenderer';";
  const returnPrefix = '    return (jsx("div", { className: "react-flow__nodes", style: containerStyle, children: nodeIds.map(';
  const returnSuffix = ') }));\n}';
  const marker = '/* ai-canvas-far-node-layer */';
  const geometry = '__aiCanvasFarNodeGeometry';
  const layer = '__aiCanvasFarNodeLayer';
  const error = () => new Error('[ai-canvas-far-node-layer] React Flow 节点渲染结构已变化，请重新审查适配点。');

  if ([marker, geometry, layer].some((name) => source.includes(name))) throw error();
  const start = source.indexOf(signature);
  const end = source.indexOf(endMarker);
  if (start < 0 || end <= start || source.indexOf(signature, start + signature.length) >= 0
    || source.indexOf(endMarker, end + endMarker.length) >= 0) throw error();
  const body = source.slice(start, end);
  const returnStart = body.indexOf(returnPrefix);
  if (returnStart < 0 || body.indexOf(returnPrefix, returnStart + returnPrefix.length) >= 0
    || !body.endsWith(returnSuffix)
    || !body.includes('    const nodeIds = useVisibleNodeIds(props.onlyRenderVisibleElements);\n')) throw error();

  const renderNode = body.slice(returnStart + returnPrefix.length, -returnSuffix.length);
  if (!renderNode.startsWith('(nodeId) => {\n')
    || !/\n\s+jsx\(NodeWrapper\$1, \{ id: nodeId, [^\n]+\}, nodeId\)\);\n\s+\}$/.test(renderNode)) throw error();

  const replacement = `${marker}
const ${geometry} = Object.freeze({ getViewportRevision: (state) => ${getViewportRevision}(state), getNodeDimensions, nodeHasDimensions });
${body.slice(0, returnStart)}    const renderNode = ${renderNode};
    const ${layer} = props.nodeTypes?.['source-image']?.renderFarLayer;
    return jsx("div", { className: "react-flow__nodes", style: containerStyle, children: ${layer}
        ? jsx(${layer}, { nodeIds, renderNode, noPanClassName: props.noPanClassName, geometry: ${geometry} })
        : nodeIds.map(renderNode) });
}`;
  return source.slice(0, start) + replacement + source.slice(end);
}
