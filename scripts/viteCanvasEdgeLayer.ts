/**
 * viteCanvasEdgeLayer — 在构建与测试期间适配 React Flow 连线渲染入口。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export const CANVAS_EDGE_LAYER_REACT_FLOW_VERSION = '12.10.2';
export const CANVAS_EDGE_LAYER_ADAPTER_MARKER = '/* ai-canvas-edge-layer:12.10.2 */';

// React Flow is excluded from pre-bundling so the same adapter runs in dev/build.
// Its nested Zustand 4 must keep resolving from React Flow, rather than our Zustand 5.
export const CANVAS_EDGE_LAYER_OPTIMIZE_INCLUDE = [
  '@xyflow/react > zustand/traditional',
  '@xyflow/react > zustand/shallow',
  '@xyflow/react > zustand > use-sync-external-store/shim/with-selector.js',
];

const ENTRY_PATTERN = /(?:^|\/)node_modules\/@xyflow\/react\/dist\/esm\/index\.(?:js|mjs)$/;
const FUNCTION_SIGNATURE = 'function EdgeRendererComponent({ defaultMarkerColor, onlyRenderVisibleElements, rfId, edgeTypes, noPanClassName, onReconnect, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave, onEdgeClick, reconnectRadius, onEdgeDoubleClick, onReconnectStart, onReconnectEnd, disableKeyboardA11y, }) {';
const FUNCTION_END = "\nEdgeRendererComponent.displayName = 'EdgeRenderer';";
const MARKER_ELEMENT = 'jsx(MarkerDefinitions$1, { defaultColor: defaultMarkerColor, rfId: rfId })';
const RETURN_PREFIX = `    return (jsxs("div", { className: "react-flow__edges", children: [${MARKER_ELEMENT}, edgeIds.map(`;
const RETURN_SUFFIX = ')] }));\n}';
const GEOMETRY_NAME = '__aiCanvasEdgeGeometry';
const LAYER_NAME = '__aiCanvasEdgeRenderLayer';
const VIEWPORT_REVISIONS_NAME = '__aiCanvasEdgeViewportRevisions';
const VIEWPORT_REVISION_NAME = '__aiCanvasEdgeViewportRevision';
const VIEWPORT_SET_NAME = '__aiCanvasSetViewport';
const VIEWPORT_SETTERS = [
  ['store.setState({ transform });', `${VIEWPORT_SET_NAME}(store, transform);`],
  ['store.setState({ transform: [viewport.x, viewport.y, viewport.zoom] });', `${VIEWPORT_SET_NAME}(store, [viewport.x, viewport.y, viewport.zoom]);`],
] as const;
const VIEWPORT_ENTRIES = [
  `    const onTransformChange = useCallback((transform) => {
        onViewportChange?.({ x: transform[0], y: transform[1], zoom: transform[2] });
        if (!isControlledViewport) {
            store.setState({ transform });
        }
    }, [onViewportChange, isControlledViewport]);`,
  `function useViewportSync(viewport) {
    const syncViewport = useStore(selector$8);
    const store = useStoreApi();
    useEffect(() => {
        if (viewport) {
            syncViewport?.(viewport);
            store.setState({ transform: [viewport.x, viewport.y, viewport.zoom] });
        }
    }, [viewport, syncViewport]);
    return null;
}`,
] as const;
const GEOMETRY_DECLARATION = `const ${VIEWPORT_REVISIONS_NAME} = new WeakMap();
const ${VIEWPORT_REVISION_NAME} = (state) => ${VIEWPORT_REVISIONS_NAME}.get(state) ?? state;
function ${VIEWPORT_SET_NAME}(store, transform) {
    store.setState((state) => {
        const next = { ...state, transform };
        ${VIEWPORT_REVISIONS_NAME}.set(next, ${VIEWPORT_REVISION_NAME}(state));
        return next;
    }, true);
}
const ${GEOMETRY_NAME} = Object.freeze({ getEdgePosition, getElevatedEdgeZIndex, getMarkerId, getViewportRevision: ${VIEWPORT_REVISION_NAME} });`;

export interface CanvasEdgeLayerTransformResult {
  code: string;
  map: null;
}

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/^\/@fs\//, '');
}

function adapterError(reason: string): Error {
  return new Error(`[ai-canvas-edge-layer] ${reason}；请重新审查 React Flow 连线适配点。`);
}

function uniqueIndex(source: string, needle: string, description: string): number {
  const index = source.indexOf(needle);
  if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
    throw adapterError(`${description}必须恰好出现一次`);
  }
  return index;
}

/** Adapts the two audited ESM entries in memory; never rewrites installed files. */
export function transformCanvasEdgeLayer(
  source: string,
  id: string,
  version: string,
): CanvasEdgeLayerTransformResult | null {
  if (!ENTRY_PATTERN.test(normalizeModuleId(id))) return null;
  if (version !== CANVAS_EDGE_LAYER_REACT_FLOW_VERSION) {
    throw adapterError(`仅支持 @xyflow/react ${CANVAS_EDGE_LAYER_REACT_FLOW_VERSION}，当前为 ${version}`);
  }
  if (source.includes(CANVAS_EDGE_LAYER_ADAPTER_MARKER)) {
    uniqueIndex(source, CANVAS_EDGE_LAYER_ADAPTER_MARKER, '适配标记');
    uniqueIndex(source, GEOMETRY_DECLARATION, '共享几何能力');
    uniqueIndex(source, '"data-canvas-edge-renderer":', '连线渲染诊断属性');
    return null;
  }
  if ([GEOMETRY_NAME, LAYER_NAME, VIEWPORT_REVISIONS_NAME, VIEWPORT_REVISION_NAME, VIEWPORT_SET_NAME]
    .some((name) => source.includes(name))) {
    throw adapterError('适配器局部名称已被占用');
  }

  const systemImports = [...source.matchAll(/^import \{ ([^\n]+) \} from '@xyflow\/system';$/gm)];
  const helpers = systemImports[0]?.[1].split(',').map((name) => name.trim());
  if (systemImports.length !== 1 || !helpers
    || !['getEdgePosition', 'getElevatedEdgeZIndex', 'getMarkerId'].every((name) => helpers.includes(name))) {
    throw adapterError('原生几何函数导入结构已变化');
  }

  // These two audited calls publish transform alone, after user callbacks have
  // finished. All other RF publications get a fresh identity, including set({})
  // after in-place measurements / handle updates. Record before synchronous
  // subscribers run, and replace with the complete state to retain its identity.
  for (const original of VIEWPORT_ENTRIES) uniqueIndex(source, original, '纯视口发布入口');
  for (const [original] of VIEWPORT_SETTERS) uniqueIndex(source, original, '纯视口发布调用');

  const start = uniqueIndex(source, FUNCTION_SIGNATURE, 'EdgeRenderer 签名');
  const end = uniqueIndex(source, FUNCTION_END, 'EdgeRenderer 结束位置');
  if (end <= start) throw adapterError('EdgeRenderer 边界顺序异常');
  const body = source.slice(start, end);
  uniqueIndex(body, '    const edgeIds = useVisibleEdgeIds(onlyRenderVisibleElements);\n', '原生可见性订阅');
  const returnStart = uniqueIndex(body, RETURN_PREFIX, '原生连线容器');
  const returnEnd = uniqueIndex(body, RETURN_SUFFIX, '原生连线映射结束位置');
  if (returnEnd + RETURN_SUFFIX.length !== body.length) {
    throw adapterError('EdgeRenderer 返回结构已变化');
  }

  // Extract the installed callback verbatim: native selection, a11y and reconnect
  // props remain owned by React Flow, including special-edge fallbacks.
  const renderEdge = body.slice(returnStart + RETURN_PREFIX.length, returnEnd);
  if (!/^\(id\) => \{\n\s+return \(jsx\(EdgeWrapper\$1, \{[^\n]+\}, id\)\);\n\s+\}$/.test(renderEdge)) {
    throw adapterError('原生 EdgeWrapper 回调结构已变化');
  }

  const adaptedBody = `${CANVAS_EDGE_LAYER_ADAPTER_MARKER}
${GEOMETRY_DECLARATION}
${body.slice(0, returnStart)}    const renderEdge = ${renderEdge};
    const ${LAYER_NAME} = typeof onReconnect === 'undefined' ? edgeTypes?.default?.renderLayer : undefined;
    return (jsxs("div", { className: "react-flow__edges", "data-canvas-edge-renderer": ${LAYER_NAME} ? "central" : "native", children: [${MARKER_ELEMENT}, ${LAYER_NAME} ? jsx(${LAYER_NAME}, { edgeIds, rfId, noPanClassName, disableKeyboardA11y, onEdgeClick, onEdgeDoubleClick, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave, renderEdge, geometry: ${GEOMETRY_NAME} }) : edgeIds.map(renderEdge)] }));
}`;

  // magic-string is not a direct project dependency. This small guarded adapter
  // intentionally returns no source map; the adapted dependency's debug lines
  // refer to generated code until a directly declared mapping utility is adopted.
  let code = source.slice(0, start) + adaptedBody + source.slice(end);
  for (const [original, replacement] of VIEWPORT_SETTERS) code = code.replace(original, replacement);
  return { code, map: null };
}

export function canvasEdgeLayerPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@xyflow/react/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
  if (manifest.version !== CANVAS_EDGE_LAYER_REACT_FLOW_VERSION) {
    throw adapterError(`仅支持 @xyflow/react ${CANVAS_EDGE_LAYER_REACT_FLOW_VERSION}，请先核对安装版本`);
  }
  const version = manifest.version;
  const entries = new Set(['index.js', 'index.mjs'].map((entry) =>
    normalizeModuleId(join(dirname(manifestPath), 'dist/esm', entry))));

  return {
    name: 'ai-canvas-react-flow-edge-layer',
    enforce: 'pre',
    transform(source, id) {
      if (!entries.has(normalizeModuleId(id))) return null;
      return transformCanvasEdgeLayer(source, id, version);
    },
  };
}
